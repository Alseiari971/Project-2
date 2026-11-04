// GameShelf Supporter, done in a way that keeps game publishers' work safe:
// finished Arabic packs are free for everyone, always; plans only change
// cloud AI translation compute, boosts, the desktop Subtitle Studio, cosmetics
// and support priority. Also prepaid codes, payment webhooks (HMAC-signed,
// handled once) and store affiliate links.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createMemoryMailer } = require('../src/mailer');
const { createTranslationMemory, createPriorityGate, sha256 } = require('../src/translation-memory');
const { createPackRegistry } = require('../src/pack-registry');
const { createPlans, normalizeCode } = require('../src/plans');
const { verifyStripe, verifyLemonSqueezy } = require('../src/billing');
const { affiliateLink, withAffiliates } = require('../src/affiliate');
const { writePack } = require('../desktop/localization/pack');
const { writeZip } = require('../src/zip');

const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const STRIPE_SECRET = 'whsec_test_secret';
const LEMON_SECRET = 'lemon_test_secret';

function fakeAi() {
  const asked = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[1].content;
    const lines = JSON.parse(user.slice(user.indexOf('[')));
    asked.push(lines.length);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` })) }) } }] }) };
  };
  return { asked, fetch };
}

async function start(t, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { ADMIN_USERS: 'boss', STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, LEMONSQUEEZY_WEBHOOK_SECRET: LEMON_SECRET, AFFILIATE_GOG_ID: 'gs123', TRANSLATE_DAILY_LINES: '50', ...env });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-plans-'));
  const db = openDatabase(':memory:');
  const ai = fakeAi();
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'k', TRANSLATE_DAILY_LINES: '50' }, fetch: ai.fetch });
  const packs = createPackRegistry({ db, dir: path.join(tmp, 'packs'), publicKeys: [PUBLIC] });
  const server = createApp({ db, games: createLocalProvider(), translations, packs, dataDir: tmp, mailer: createMemoryMailer() }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    server.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (route, { method = 'GET', body, headers = {}, raw } = {}) => {
      const res = await fetch(base + route, {
        method,
        headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
      const set = res.headers.get('set-cookie');
      if (set && /gs_session=/.test(set)) cookie = /gs_session=[^;]+/.exec(set)[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
    };
  };
  const signedUp = async (username) => {
    const c = client();
    const r = await c('/api/auth/register', { method: 'POST', body: { username, password: 'a long passphrase', email: `${username}@mail.example`, nationality: 'AE' } });
    assert.equal(r.status, 201);
    c.id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
    return c;
  };
  return { db, base, client, signedUp, ai, packs };
}

const lines = (n, tag) => Array.from({ length: n }, (_, i) => {
  const english = `${tag} line number ${i} for testing`;
  return { hash: sha256(english), english };
});

async function publishPack(packs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
  await fs.writeFile(path.join(dir, 'fingerprints.json'), JSON.stringify({ kind: 'gameshelf-fingerprints', format: 2, normalization: 1, entries: [] }));
  await writePack(dir, { id: 'demo-ar', version: '1.0.0', engine: 'overlay', title: 'Demo', game: { steamAppId: 1173690 }, files: [{ source: 'fingerprints.json', target: 'fingerprints.json' }], privateKey: keys.privateKey });
  const files = [];
  for (const name of ['pack.json', 'pack.json.sig', 'fingerprints.json']) files.push({ name, data: await fs.readFile(path.join(dir, name)) });
  await fs.rm(dir, { recursive: true, force: true });
  return packs.publish(writeZip(files));
}

test('finished Arabic packs are free for every account, whatever its plan or quota', async (t) => {
  const { signedUp, packs } = await start(t);
  await publishPack(packs);
  const free = await signedUp('free_player');
  // Use up the free plan's AI translation entirely.
  await free('/api/translations/translate', { method: 'POST', body: { game: 'steam:1', lines: lines(60, 'a') } });
  const blocked = await free('/api/translations/translate', { method: 'POST', body: { game: 'steam:2', lines: lines(2, 'b') } });
  assert.equal(blocked.body.limit.code, 'build-limit');
  // The pack still downloads, with no plan or payment asked.
  assert.deepEqual((await free('/api/localization/packs')).body.packs.map((p) => p.id), ['demo-ar']);
  const zip = await free('/api/localization/packs/demo-ar/download');
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.ok(zip.body.length > 100);
  // The pack and set routes never look at plans (by construction, checked here).
  const api = await fs.readFile(path.join(__dirname, '..', 'src/api.js'), 'utf8');
  for (const route of ["'/localization/packs/:id/download'", "'/localization/sets/:id/download'", "'/localization/packs',"]) {
    const start = api.indexOf(route);
    const body = api.slice(start, api.indexOf('\n  });', start));
    assert.ok(!/plans\.|supporter|allowance|quota/i.test(body), `${route} mentions a plan`);
  }
  // Every plan answer says it too.
  assert.equal((await free('/api/me/plan')).body.packsAlwaysFree, true);
  assert.equal((await free('/api/plans')).body.packsAlwaysFree, true);
});

test('cloud AI compute: free gets one new game a day within its daily lines; supporters get more and go first', async (t) => {
  const { signedUp, ai, db } = await start(t);
  const free = await signedUp('free_one');
  const first = await free('/api/translations/translate', { method: 'POST', body: { game: 'steam:10', lines: lines(30, 'x') } });
  assert.equal(Object.keys(first.body.arabic).length, 30);
  // The same game again is fine, up to the daily lines (50 here).
  const more = await free('/api/translations/translate', { method: 'POST', body: { game: 'steam:10', lines: lines(30, 'y') } });
  assert.equal(Object.keys(more.body.arabic).length, 20);
  assert.equal(more.body.limited, true);
  // A second new game the same day: refused, with a reason that says packs stay free.
  const second = await free('/api/translations/translate', { method: 'POST', body: { game: 'steam:11', lines: lines(3, 'z') } });
  assert.equal(Object.keys(second.body.arabic).length, 0);
  assert.equal(second.body.limit.code, 'build-limit');
  assert.match(second.body.limit.reason, /Finished Arabic packs are always free/);
  // Lines already in the shared memory cost nothing, even past the limit.
  const known = await free('/api/translations/translate', { method: 'POST', body: { game: 'steam:10', lines: lines(5, 'x') } });
  assert.equal(Object.keys(known.body.arabic).length, 5);
  assert.equal(db.prepare('SELECT SUM(strings) AS n FROM compute_ledger WHERE user_id = ?').get(free.id).n, 50);

  // A supporter: several new games, a monthly allowance, priority.
  const fan = await signedUp('fan_one');
  createPlans({ db }).grant(fan.id, { days: 30, source: 'admin' });
  for (const game of ['steam:20', 'steam:21', 'steam:22']) {
    assert.equal(Object.keys((await fan('/api/translations/translate', { method: 'POST', body: { game, lines: lines(10, game) } })).body.arabic).length, 10);
  }
  const plan = (await fan('/api/me/plan')).body;
  assert.deepEqual([plan.plan, plan.compute.month.used, plan.compute.month.limit, plan.perks.priorityQueue], ['supporter', 30, 150000, true]);
  assert.ok(ai.asked.length > 0);

  // The monthly allowance is enforced too.
  const tight = createPlans({ db, env: { SUPPORTER_MONTHLY_STRINGS: '35' } });
  assert.deepEqual([tight.allowance({ id: fan.id }, 'steam:23').ok, tight.allowance({ id: fan.id }, 'steam:23').maxLines], [true, 5]);
  db.prepare("INSERT INTO compute_ledger (user_id, kind, game, strings, created_at) VALUES (?, 'translate', 'steam:23', 5, ?)").run(fan.id, Date.now());
  assert.equal(tight.allowance({ id: fan.id }, 'steam:23').code, 'monthly-limit');
});

test('the AI queue serves supporters first', async () => {
  const gate = createPriorityGate(1);
  const order = [];
  let release;
  const blocker = gate.run(0, () => new Promise((r) => { release = r; }));
  const jobs = [gate.run(0, async () => order.push('free-1')), gate.run(0, async () => order.push('free-2')), gate.run(1, async () => order.push('supporter'))];
  await new Promise((r) => setImmediate(r));
  release();
  await blocker;
  await Promise.all(jobs);
  assert.deepEqual(order, ['supporter', 'free-1', 'free-2']);
});

test('boost tokens: supporters only, monthly allowance, requested games only; boosted games lead the admin queue', async (t) => {
  const { signedUp, db, client } = await start(t);
  const free = await signedUp('asker_a');
  const fan = await signedUp('booster_b');
  const boss = await signedUp('boss');
  for (const [who, game] of [[free, 'steam:100'], [free, 'steam:200'], [boss, 'steam:200']]) {
    await who('/api/arabic/requests', { method: 'POST', body: { game, name: game === 'steam:100' ? 'Lantern' : 'Forge' } });
  }
  assert.equal((await free('/api/arabic/boosts', { method: 'POST', body: { game: 'steam:100' } })).status, 402);
  createPlans({ db }).grant(fan.id, { days: 30 });
  assert.equal((await fan('/api/arabic/boosts', { method: 'POST', body: { game: 'steam:999' } })).status, 404, 'not requested');
  assert.equal((await fan('/api/arabic/boosts', { method: 'POST', body: { game: 'not a game' } })).status, 400);
  assert.equal((await fan('/api/arabic/boosts', { method: 'POST', body: { game: 'steam:100', tokens: 0 } })).status, 400);
  const spent = await fan('/api/arabic/boosts', { method: 'POST', body: { game: 'steam:100', tokens: 3 } });
  assert.deepEqual([spent.body.boosts, spent.body.you.left], [3, 2]);
  assert.equal((await fan('/api/arabic/boosts', { method: 'POST', body: { game: 'steam:100', tokens: 3 } })).status, 429);
  // The public board shows boosts (votes still rank it); the admin queue puts boosts first.
  const board = (await client()('/api/arabic/leaderboard')).body.games;
  assert.deepEqual(board.map((g) => [g.game, g.votes, g.boosts]), [['steam:200', 2, 0], ['steam:100', 1, 3]]);
  assert.deepEqual((await boss('/api/admin/requests')).body.requests.map((r) => [r.game, r.boosts]), [['steam:100', 3], ['steam:200', 0]]);
});

test('prepaid codes: made by admins, kept only as hashes, redeemed once, revocable, guessing locked out', async (t) => {
  const { signedUp, db } = await start(t);
  const boss = await signedUp('boss');
  const player = await signedUp('code_user');
  assert.equal((await player('/api/admin/plans/codes', { method: 'POST', body: { count: 1, days: 30 } })).status, 403);
  const made = (await boss('/api/admin/plans/codes', { method: 'POST', body: { count: 3, days: 30, note: 'Ziina launch' } })).body;
  assert.equal(made.codes.length, 3);
  assert.ok(made.codes.every((c) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c)));
  const stored = db.prepare('SELECT code_hash, hint FROM gift_codes').all();
  assert.ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash) && !made.codes.includes(r.code_hash)), 'only hashes are kept');

  const redeemed = await player('/api/me/plan/redeem', { method: 'POST', body: { code: made.codes[0].toLowerCase().replace(/-/g, ' ') } });
  assert.equal(redeemed.status, 200);
  assert.deepEqual([redeemed.body.plan, redeemed.body.days], ['supporter', 30]);
  assert.ok(redeemed.body.until > Date.now() + 29 * 86400000);
  assert.equal((await player('/api/me')).body.user.supporter, true);
  assert.equal((await player('/api/me/plan/redeem', { method: 'POST', body: { code: made.codes[0] } })).status, 409, 'once');
  // A second code adds to the time left.
  const second = await player('/api/me/plan/redeem', { method: 'POST', body: { code: made.codes[1] } });
  assert.ok(second.body.until > redeemed.body.until + 29 * 86400000);
  // Revoked codes stop working.
  await boss(`/api/admin/plans/codes/${made.batch}/revoke`, { method: 'POST' });
  assert.equal((await player('/api/me/plan/redeem', { method: 'POST', body: { code: made.codes[2] } })).status, 404);
  assert.equal((await boss('/api/admin/plans')).body.batches[0].redeemed, 2);
  // Guessing: 8 wrong codes lock the account's redeeming for an hour.
  const guesser = await signedUp('guesser');
  for (let i = 0; i < 8; i++) assert.equal((await guesser('/api/me/plan/redeem', { method: 'POST', body: { code: `AAAA-BBBB-CC${i}C`.replace(/[01]/g, '2') } })).status, 404);
  assert.equal((await guesser('/api/me/plan/redeem', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC' } })).status, 429);
  assert.equal((await guesser('/api/me/plan/redeem', { method: 'POST', body: { code: 'nope' } })).status, 429);
  assert.equal(normalizeCode('abcd efgh jkmn'), 'ABCD-EFGH-JKMN');
  // An admin can also grant time directly.
  assert.equal((await boss('/api/admin/plans/grant', { method: 'POST', body: { username: 'guesser', days: 7 } })).body.plan, 'supporter');
});

function stripeHeader(body, secret = STRIPE_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

test('payment webhooks: only correctly signed, recent events count, and each counts once', async (t) => {
  const { signedUp, client, db } = await start(t);
  const buyer = await signedUp('buyer');
  const hook = (raw, headers) => client()('/api/billing/webhook', { method: 'POST', raw, headers });
  const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: String(buyer.id), payment_status: 'paid', subscription: 'sub_1' } } });

  assert.equal((await hook(event, {})).status, 401, 'unsigned');
  assert.equal((await hook(event, { 'Stripe-Signature': stripeHeader(event, 'wrong-secret') })).status, 401);
  assert.equal((await hook(event, { 'Stripe-Signature': stripeHeader(event, STRIPE_SECRET, Math.floor(Date.now() / 1000) - 3600) })).status, 401, 'too old');
  assert.equal((await hook(event.replace('"paid"', '"paid" '), { 'Stripe-Signature': stripeHeader(event) })).status, 401, 'body changed after signing');
  assert.equal((await buyer('/api/me/plan')).body.plan, 'free');

  const ok = await hook(event, { 'Stripe-Signature': stripeHeader(event) });
  assert.deepEqual([ok.status, ok.body.action], [200, 'granted']);
  assert.equal((await buyer('/api/me/plan')).body.plan, 'supporter');
  const until = (await buyer('/api/me/plan')).body.until;
  assert.equal((await hook(event, { 'Stripe-Signature': stripeHeader(event) })).body.duplicate, true, 'a replay changes nothing');
  assert.equal((await buyer('/api/me/plan')).body.until, until);

  // Renewal sets the period end; cancellation keeps the paid time.
  const periodEnd = Math.floor(Date.now() / 1000) + 40 * 86400;
  const renew = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { subscription: 'sub_1', lines: { data: [{ period: { end: periodEnd } }] } } } });
  assert.equal((await hook(renew, { 'Stripe-Signature': stripeHeader(renew) })).body.action, 'renewed');
  assert.equal((await buyer('/api/me/plan')).body.until, periodEnd * 1000);
  const cancel = JSON.stringify({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { object: 'subscription', id: 'sub_1' } } });
  assert.equal((await hook(cancel, { 'Stripe-Signature': stripeHeader(cancel) })).body.action, 'canceled');
  const after = (await buyer('/api/me/plan')).body;
  assert.deepEqual([after.plan, after.status, after.renews], ['supporter', 'canceled', false]);

  // LemonSqueezy.
  const fan = await signedUp('lemon_fan');
  const lemon = JSON.stringify({ meta: { event_name: 'subscription_created', custom_data: { user_id: String(fan.id) } }, data: { id: '77', attributes: { status: 'active', renews_at: new Date(Date.now() + 30 * 86400000).toISOString() } } });
  const sig = crypto.createHmac('sha256', LEMON_SECRET).update(lemon).digest('hex');
  assert.equal((await hook(lemon, { 'X-Signature': 'ab'.repeat(32) })).status, 401);
  assert.equal((await hook(lemon, { 'X-Signature': sig })).body.action, 'renewed');
  assert.equal((await fan('/api/me/plan')).body.plan, 'supporter');
  const expired = JSON.stringify({ meta: { event_name: 'subscription_expired', custom_data: { user_id: String(fan.id) } }, data: { id: '77', attributes: { status: 'expired' } } });
  await hook(expired, { 'X-Signature': crypto.createHmac('sha256', LEMON_SECRET).update(expired).digest('hex') });
  assert.equal((await fan('/api/me/plan')).body.plan, 'free');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n, 5);

  // The verifiers on their own.
  assert.throws(() => verifyStripe('{}', stripeHeader('{}'), ''), /aren't set up/);
  assert.throws(() => verifyLemonSqueezy('{}', 'zz', LEMON_SECRET), /doesn't match/);
});

test('webhooks are refused when no secret is set', async (t) => {
  const { client } = await start(t, { STRIPE_WEBHOOK_SECRET: '' });
  const body = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
  assert.equal((await client()('/api/billing/webhook', { method: 'POST', raw: body, headers: { 'Stripe-Signature': stripeHeader(body) } })).status, 503);
});

test('store affiliate links: only the configured stores, https only, marked sponsored', async (t) => {
  const env = { AFFILIATE_GOG_ID: 'gs123', AFFILIATE_HUMBLE_ID: 'gameshelf', AFFILIATE_EPIC_CREATOR_CODE: 'GAMESHELF' };
  assert.deepEqual(affiliateLink('https://www.gog.com/en/game/hollow_knight', env), { url: 'https://www.gog.com/en/game/hollow_knight?pp=gs123', sponsored: true });
  assert.deepEqual(affiliateLink('https://www.humblebundle.com/store/hades?x=1', env), { url: 'https://www.humblebundle.com/store/hades?x=1&partner=gameshelf', sponsored: true });
  assert.equal(affiliateLink('https://store.epicgames.com/p/alan-wake-2', env).url, 'https://store.epicgames.com/p/alan-wake-2?epic_creator_id=GAMESHELF');
  for (const untouched of ['https://store.steampowered.com/app/1/', 'http://www.gog.com/game/x', 'https://gog.com.evil.example/game/x', 'https://evilgog.com/x', 'javascript:alert(1)', 'not a url']) {
    assert.deepEqual(affiliateLink(untouched, env), { url: untouched, sponsored: false }, untouched);
  }
  assert.equal(affiliateLink('https://www.gog.com/x', { AFFILIATE_GOG_ID: 'bad id"><script>' }).sponsored, false, 'odd IDs are ignored');
  assert.equal(affiliateLink('https://www.gog.com/x', {}).sponsored, false, 'nothing set, nothing changed');
  assert.deepEqual(withAffiliates({ links: [{ store: 'gog', url: 'https://www.gog.com/x' }] }, env).links[0], { store: 'gog', url: 'https://www.gog.com/x?pp=gs123', sponsored: true });

  const { client } = await start(t);
  const game = (await client()('/api/games/hollow-knight')).body;
  assert.ok(game.buy.links.every((l) => typeof l.sponsored === 'boolean'));
});
