// Steam linking proved with Steam's own sign-in (OpenID 2.0, checked with
// Valve), friends and live presence, and support tickets.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createMemoryMailer } = require('../src/mailer');
const { OP } = require('../src/steam-openid');

let server;
let base;
let db;
let clock;
let valveCalls;
let mailer;

/** Valve's check_authentication: "genuine" only for answers signed "good-sig". */
async function fakeValve(url, init) {
  valveCalls.push({ url, body: String(init?.body || '') });
  const params = new URLSearchParams(String(init?.body || ''));
  const valid = url === OP && params.get('openid.mode') === 'check_authentication' && params.get('openid.sig') === 'good-sig';
  return { ok: true, status: 200, text: async () => `ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n` };
}

async function startApp(env = {}) {
  const saved = { ADMIN_USERS: process.env.ADMIN_USERS, PUBLIC_URL: process.env.PUBLIC_URL };
  Object.assign(process.env, { ADMIN_USERS: '', PUBLIC_URL: '' }, env);
  db = openDatabase(':memory:');
  clock = Date.now();
  valveCalls = [];
  mailer = createMemoryMailer();
  server = createApp({ db, games: createLocalProvider(), mailer, fetchImpl: fakeValve, now: () => clock }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
}
afterEach(() => {
  server?.close();
  server?.restoreEnv();
});

function browser(userAgent = 'Mozilla/5.0 Test') {
  const jar = new Map();
  return async (path, { method = 'GET', body, form } = {}) => {
    const type = form ? 'application/x-www-form-urlencoded' : body ? 'application/json' : null;
    const res = await fetch(path.startsWith('http') ? path : base + path, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': userAgent, ...(type ? { 'Content-Type': type } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: res.status, body: json, text, location: res.headers.get('location') };
  };
}

async function signedUp(username, nationality = 'AE', ua) {
  const b = browser(ua);
  const r = await b('/api/auth/register', { method: 'POST', body: { username, password: 'a long passphrase', email: `${username}@mail.example`, nationality } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return b;
}

/**
 * What Steam sends back after a sign-in: the return address it was given,
 * with Steam's signed fields added. `tweak` forges or breaks parts of it.
 */
function steamAnswer(steamUrl, steamId, tweak = {}) {
  const returnTo = new URL(steamUrl).searchParams.get('openid.return_to');
  const claimed = `https://steamcommunity.com/openid/id/${steamId}`;
  const fields = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': OP,
    'openid.claimed_id': claimed,
    'openid.identity': claimed,
    'openid.return_to': returnTo,
    'openid.response_nonce': `${new Date(clock).toISOString().slice(0, 19)}Z${Math.random().toString(36).slice(2, 8)}`,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'good-sig',
    ...tweak,
  };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  return `${returnTo}&${new URLSearchParams(fields)}`;
}

const STEAM_A = '76561198000000011';
const STEAM_B = '76561198000000022';

test('Steam linking: Steam\'s sign-in page, an answer Valve vouches for, then linked — once', async () => {
  await startApp();
  // Signed out: to the sign-in page first.
  assert.deepEqual([(await browser()('/api/auth/steam/link')).status, (await browser()('/api/auth/steam/link')).location], [302, '/#/login']);

  const me = await signedUp('hamad');
  const go = await me('/api/auth/steam/link');
  assert.equal(go.status, 302);
  const steamUrl = new URL(go.location);
  assert.equal(steamUrl.origin + steamUrl.pathname, OP);
  assert.equal(steamUrl.searchParams.get('openid.mode'), 'checkid_setup');
  assert.equal(steamUrl.searchParams.get('openid.realm'), base);
  assert.equal(steamUrl.searchParams.get('openid.identity'), 'http://specs.openid.net/auth/2.0/identifier_select');
  assert.match(steamUrl.searchParams.get('openid.return_to'), new RegExp(`^${base}/api/auth/steam/return\\?state=[\\w-]{32}$`));

  const answer = steamAnswer(go.location, STEAM_A);
  const back = await me(answer);
  assert.equal(back.location, `${base}/#/settings/security?steam=linked`);
  // GameShelf asked Valve itself, with Steam's fields, in check_authentication mode.
  assert.equal(valveCalls.length, 1);
  const asked = new URLSearchParams(valveCalls[0].body);
  assert.deepEqual([valveCalls[0].url, asked.get('openid.mode'), asked.get('openid.claimed_id')], [OP, 'check_authentication', `https://steamcommunity.com/openid/id/${STEAM_A}`]);

  const status = (await me('/api/me/steam')).body;
  assert.deepEqual([status.linked, status.steamId, status.profileUrl], [true, STEAM_A, `https://steamcommunity.com/profiles/${STEAM_A}`]);
  assert.equal((await me('/api/me')).body.user.steamLinked, true);
  assert.equal((await browser()('/api/users/hamad')).body.user.steamVerified, true);

  // The same answer again: the attempt is spent.
  const replay = await me(answer);
  assert.match(replay.location, /steam=error&reason=.*already%20used|steam=error&reason=.*expired/);
});

test('Steam linking: forged, broken, stale or misdirected answers are refused', async () => {
  await startApp();
  const me = await signedUp('omar');
  const reasonOf = async (tweak, { otherState = false } = {}) => {
    const go = await me('/api/auth/steam/link');
    let url = steamAnswer(go.location, STEAM_A, tweak);
    if (otherState) url = url.replace(/state=[\w-]+&/, `state=${new URL(new URL((await me('/api/auth/steam/link')).location).searchParams.get('openid.return_to')).searchParams.get('state')}&`);
    const back = await me(url);
    assert.match(back.location, /\?steam=error&reason=/, JSON.stringify(tweak));
    return decodeURIComponent(back.location.split('reason=')[1]);
  };
  assert.match(await reasonOf({ 'openid.sig': 'forged' }), /didn't confirm/);
  assert.match(await reasonOf({ 'openid.op_endpoint': 'https://evil.example/openid/login' }), /didn't come from Steam/);
  assert.match(await reasonOf({ 'openid.identity': `https://steamcommunity.com/openid/id/${STEAM_B}` }), /doesn't name a Steam account/);
  assert.match(await reasonOf({ 'openid.claimed_id': 'https://steamcommunity.com/openid/id/123', 'openid.identity': 'https://steamcommunity.com/openid/id/123' }), /doesn't name a Steam account/);
  assert.match(await reasonOf({ 'openid.signed': 'signed,op_endpoint,return_to' }), /isn't signed/);
  assert.match(await reasonOf({ 'openid.response_nonce': '2001-01-01T00:00:00Zabc' }), /too old/);
  assert.match(await reasonOf({ 'openid.mode': 'cancel' }), /cancelled/);
  assert.match(await reasonOf({}, { otherState: true }), /another address/);
  assert.equal((await me('/api/me/steam')).body.linked, false);
  // Expired attempts don't work either.
  const go = await me('/api/auth/steam/link');
  clock += 11 * 60 * 1000;
  assert.match((await me(steamAnswer(go.location, STEAM_A))).location, /expired/);
});

test('Steam linking: one Steam account per GameShelf account, both ways', async () => {
  await startApp();
  const first = await signedUp('first');
  await first(steamAnswer((await first('/api/auth/steam/link')).location, STEAM_A));
  assert.equal((await first('/api/me/steam')).body.steamId, STEAM_A);

  const second = await signedUp('second');
  const taken = await second(steamAnswer((await second('/api/auth/steam/link')).location, STEAM_A));
  assert.match(decodeURIComponent(taken.location), /already linked to another GameShelf account/);
  assert.equal((await second('/api/me/steam')).body.linked, false);
  // And the first can't swap to another Steam account without unlinking.
  const swap = await first(steamAnswer((await first('/api/auth/steam/link')).location, STEAM_B));
  assert.match(decodeURIComponent(swap.location), /Unlink it first/);

  assert.equal((await first('/api/me/steam', { method: 'DELETE' })).body.linked, false);
  await second(steamAnswer((await second('/api/auth/steam/link')).location, STEAM_A));
  assert.equal((await second('/api/me/steam')).body.steamId, STEAM_A);
  // There's no way to type a Steam ID in.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE steam_id IS NOT NULL').get().n, 1);
  assert.equal((await second('/api/me/import/steam/preview', { method: 'POST', body: { profile: STEAM_B } })).status !== 200, true);
});

test('Steam linking from the desktop app: Steam opens in the system browser, which confirms first', async () => {
  await startApp();
  const app = await signedUp('desk', 'SA', 'Mozilla/5.0 gameshelf Electron/44.7.2');
  const { url } = (await app('/api/auth/steam/link', { method: 'POST' })).body;
  assert.ok(url.startsWith(`${OP}?`));

  // The system browser isn't signed in to GameShelf: it asks before linking.
  const systemBrowser = browser();
  const page = await systemBrowser(steamAnswer(url, STEAM_B));
  assert.equal(page.status, 200);
  assert.match(page.text, /Link this Steam account\?/);
  assert.match(page.text, /@desk/);
  assert.match(page.text, /ربط حساب Steam هذا؟/);
  assert.match(page.text, /href="\/css\/standalone.css"/);
  const state = /name="state" value="([^"]+)"/.exec(page.text)[1];
  const token = /name="token" value="([^"]+)"/.exec(page.text)[1];
  assert.equal((await app('/api/me/steam')).body.linked, false, 'nothing linked before the confirm');

  assert.equal((await systemBrowser('/api/auth/steam/confirm', { method: 'POST', form: { state, token: 'wrong' } })).status, 410);
  const done = await systemBrowser('/api/auth/steam/confirm', { method: 'POST', form: { state, token } });
  assert.equal(done.status, 200);
  assert.match(done.text, /Steam account linked/);
  assert.equal((await app('/api/me/steam')).body.steamId, STEAM_B, 'the app sees it on its next check');
  assert.equal((await systemBrowser('/api/auth/steam/confirm', { method: 'POST', form: { state, token } })).status, 410, 'once');
  assert.equal((await fetch(`${base}/css/standalone.css`)).status, 200);
});

test('friends: friend codes and @usernames, requests both ways, blocks, and presence only friends see', async () => {
  await startApp();
  const nadia = await signedUp('nadia', 'KW');
  const omar = await signedUp('omar', 'QA');
  const stranger = await signedUp('stranger');
  const nadiaCode = (await nadia('/api/friends')).body.code;
  assert.match(nadiaCode, /^GS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  // Found by code (any case, with or without dashes) or exact @username.
  assert.equal((await omar(`/api/friends/find?q=${nadiaCode.toLowerCase().replace(/-/g, '')}`)).body.user.username, 'nadia');
  assert.equal((await omar('/api/friends/find?q=@nadia')).body.relation, 'none');
  assert.equal((await omar('/api/friends/find?q=nad')).status, 404, 'no partial matches');

  const sent = await omar('/api/friends/request', { method: 'POST', body: { code: nadiaCode } });
  assert.equal(sent.body.relation, 'outgoing');
  assert.deepEqual(sent.body.outgoing.map((u) => u.username), ['nadia']);
  const inbox = (await nadia('/api/friends')).body;
  assert.deepEqual(inbox.incoming.map((u) => [u.username, u.nationality]), [['omar', 'QA']]);
  assert.equal((await nadia('/api/friends/accept', { method: 'POST', body: { username: 'stranger' } })).status, 404);
  const accepted = await nadia('/api/friends/accept', { method: 'POST', body: { target: '@omar' } });
  assert.equal(accepted.body.relation, 'friends');
  assert.deepEqual(accepted.body.friends.map((f) => [f.username, f.presence.status]), [['omar', 'offline']]);
  assert.equal((await omar('/api/friends/request', { method: 'POST', body: { target: 'omar' } })).status, 400, 'not yourself');

  // Presence: the desktop app's heartbeat, seen by friends only.
  const app = browser('Mozilla/5.0 gameshelf Electron/44.7.2');
  await app('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } });
  assert.equal((await app('/api/presence/heartbeat', { method: 'POST', body: { status: 'in_game' } })).status, 400);
  const beat = await app('/api/presence/heartbeat', { method: 'POST', body: { status: 'in_game', gameId: 'hollow-knight', gameTitle: 'Hollow Knight', arabicEnabled: true } });
  assert.deepEqual([beat.body.presence.status, beat.body.presence.arabic, beat.body.presence.source], ['in_game', true, 'desktop']);
  let seen = (await nadia('/api/friends')).body;
  assert.equal(seen.online, 1);
  assert.deepEqual(seen.friends[0].presence.game, { id: 'hollow-knight', title: 'Hollow Knight', steamAppId: null });
  assert.equal(seen.friends[0].presence.arabic, true);
  assert.equal(JSON.stringify((await stranger('/api/friends/find?q=@omar')).body).includes('Hollow Knight'), false, 'strangers don\'t see it');

  // Two minutes without a heartbeat: offline.
  clock += 2 * 60 * 1000 + 1000;
  seen = (await nadia('/api/friends')).body;
  assert.deepEqual([seen.online, seen.friends[0].presence.status, seen.friends[0].presence.game], [0, 'offline', null]);
  await omar('/api/presence/heartbeat', { method: 'POST', body: { status: 'online' } });
  assert.equal((await nadia('/api/friends')).body.friends[0].presence.status, 'online');
  await omar('/api/presence/heartbeat', { method: 'POST', body: { status: 'offline' } });
  assert.equal((await nadia('/api/friends')).body.friends[0].presence.status, 'offline');

  // Requests both ways become a friendship; removing ends it.
  await stranger('/api/friends/request', { method: 'POST', body: { target: '@nadia' } });
  assert.equal((await nadia('/api/friends/request', { method: 'POST', body: { target: '@stranger' } })).body.relation, 'friends');
  assert.equal((await nadia('/api/friends/remove', { method: 'POST', body: { target: '@stranger' } })).body.friends.length, 1);

  // A block: they can't add you or find you, and it's silent.
  const blocked = await nadia('/api/friends/block', { method: 'POST', body: { target: '@stranger' } });
  assert.deepEqual(blocked.body.blocked.map((u) => u.username), ['stranger']);
  assert.equal((await stranger('/api/friends/request', { method: 'POST', body: { target: '@nadia' } })).status, 403);
  assert.equal((await stranger('/api/friends/find?q=@nadia')).status, 404);
  await nadia('/api/friends/unblock', { method: 'POST', body: { target: '@stranger' } });
  assert.equal((await stranger('/api/friends/find?q=@nadia')).body.relation, 'none');
  // Blocking a friend ends the friendship too.
  await nadia('/api/friends/block', { method: 'POST', body: { target: '@omar' } });
  assert.equal((await omar('/api/friends')).body.friends.length, 0);
  assert.equal((await browser()('/api/friends')).status, 401);
});

test('support: tickets with a thread, the admin queue with who sent them, replies and statuses', async () => {
  await startApp({ ADMIN_USERS: 'hamad' });
  const admin = await signedUp('hamad');
  const layla = await signedUp('layla', 'EG');
  const other = await signedUp('other');
  const bad = async (body, pattern) => {
    const r = await layla('/api/support/tickets', { method: 'POST', body: { category: 'arabic', subject: 'Arabic text is reversed', message: 'The menu letters appear disconnected.', ...body } });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, pattern);
  };
  await bad({ category: 'billing' }, /Pick what/);
  await bad({ subject: 'hi' }, /subject/);
  await bad({ message: 'broken' }, /at least 10/);
  await bad({ gameId: 'not-a-real-game' }, /isn't in the catalog/);

  const made = await layla('/api/support/tickets', { method: 'POST', body: { category: 'arabic', subject: 'Arabic text is reversed', gameId: 'hollow-knight', message: 'The menu letters appear disconnected.' } });
  assert.equal(made.status, 201);
  const id = made.body.ticket.id;
  assert.deepEqual([made.body.ticket.status, made.body.ticket.game], ['open', { id: 'hollow-knight', name: 'Hollow Knight' }]);
  assert.equal(made.body.messages.length, 1);
  assert.equal((await other(`/api/support/tickets/${id}`)).status, 404, 'only the sender sees it');
  assert.equal((await other('/api/admin/support')).status, 403);
  await layla('/api/support/tickets', { method: 'POST', body: { category: 'steam', subject: 'Steam link fails', message: 'It says the account is already linked.' } });

  const queue = (await admin('/api/admin/support?status=open&category=arabic')).body;
  assert.deepEqual(queue.tickets.map((t) => t.id), [id]);
  assert.deepEqual(queue.tickets[0].from, { username: 'layla', displayName: 'layla', nationality: 'EG', steamLinked: false, guard: null, emailVerified: false, supporter: false });
  assert.equal(queue.tickets[0].userTickets, 2);
  assert.equal(queue.counts.open, 2);
  const opened = (await admin(`/api/admin/support/${id}`)).body;
  assert.deepEqual(opened.history.map((h) => h.subject), ['Steam link fails']);

  const answered = await admin(`/api/admin/support/${id}/messages`, { method: 'POST', body: { body: 'Turn the Arabic switch off and on to rebuild it.' } });
  assert.equal(answered.body.ticket.status, 'replied');
  // Layla's address isn't confirmed, so no email; once it is, replies arrive by email too.
  assert.equal(mailer.sent.filter((m) => /Support replied/.test(m.subject)).length, 0);
  db.prepare("UPDATE users SET email_verified = 1 WHERE username = 'layla'").run();
  await admin(`/api/admin/support/${id}/messages`, { method: 'POST', body: { body: 'One more tip: restart the game after.' } });
  await new Promise((r) => setTimeout(r, 50));
  const mail = mailer.sent.find((m) => /Support replied/.test(m.subject));
  assert.equal(mail.to, 'layla@mail.example');
  assert.match(mail.text, /restart the game after/);
  const mine = (await layla(`/api/support/tickets/${id}`)).body;
  assert.deepEqual(mine.messages.map((m) => [m.fromAdmin, m.author]), [[false, 'layla'], [true, 'GameShelf'], [true, 'GameShelf']]);
  assert.equal((await layla('/api/support/tickets')).body.tickets.find((t) => t.id === id).status, 'replied');

  assert.equal((await layla(`/api/support/tickets/${id}/messages`, { method: 'POST', body: { body: 'Still reversed after that.' } })).body.ticket.status, 'open');
  assert.equal((await admin(`/api/admin/support/${id}/messages`, { method: 'POST', body: { body: 'Fixed in the new pack.', status: 'resolved' } })).body.ticket.status, 'resolved');
  assert.equal((await admin(`/api/admin/support/${id}`, { method: 'PATCH', body: { status: 'pending' } })).status, 400);
  assert.equal((await admin(`/api/admin/support/${id}`, { method: 'PATCH', body: { status: 'closed' } })).body.ticket.status, 'closed');
  assert.equal((await layla(`/api/support/tickets/${id}/messages`, { method: 'POST', body: { body: 'One more thing.' } })).status, 409);

  // At most ten waiting at once.
  for (let i = 0; i < 9; i++) await layla('/api/support/tickets', { method: 'POST', body: { category: 'request', subject: `Please add game ${i}`, message: 'It would be great in Arabic.' } });
  assert.equal((await layla('/api/support/tickets', { method: 'POST', body: { category: 'other', subject: 'One too many', message: 'This should be refused.' } })).status, 429);
});

test('the bell: friend requests, accepted requests and support replies; profiles show badges and the Steam avatar', async () => {
  await startApp({ ADMIN_USERS: 'hamad' });
  const admin = await signedUp('hamad');
  const nadia = await signedUp('nadia', 'KW');
  const omar = await signedUp('omar', 'QA');

  await omar('/api/friends/request', { method: 'POST', body: { target: '@nadia' } });
  let bell = (await nadia('/api/notifications')).body;
  assert.deepEqual(bell.items.map((n) => [n.kind, n.data.username, n.link]), [['friend-request', 'omar', '#/u/omar']]);
  assert.equal(bell.unread, 1);
  // Asking again within the hour doesn't ring twice.
  await omar('/api/friends/remove', { method: 'POST', body: { target: '@nadia' } });
  await omar('/api/friends/request', { method: 'POST', body: { target: '@nadia' } });
  assert.equal((await nadia('/api/notifications')).body.items.length, 1);
  await nadia('/api/friends/accept', { method: 'POST', body: { target: '@omar' } });
  bell = (await omar('/api/notifications')).body;
  assert.deepEqual(bell.items.map((n) => [n.kind, n.data.username]), [['friend-accepted', 'nadia']]);
  // Reading one; the other player's can't be touched.
  assert.deepEqual((await nadia('/api/notifications/read', { method: 'POST', body: { id: bell.items[0].id } })).body, { unread: 1 });
  assert.deepEqual((await omar('/api/notifications/read', { method: 'POST', body: { id: bell.items[0].id } })).body, { unread: 0 });

  const ticket = (await nadia('/api/support/tickets', { method: 'POST', body: { category: 'other', subject: 'Where is my badge', message: 'I linked Steam but see nothing.' } })).body.ticket;
  await admin(`/api/admin/support/${ticket.id}/messages`, { method: 'POST', body: { body: 'It shows once Steam confirms.' } });
  const reply = (await nadia('/api/notifications')).body.items[0];
  assert.deepEqual([reply.kind, reply.data.subject, reply.link], ['support-reply', 'Where is my badge', `#/support/${ticket.id}`]);

  // Profiles: badges for the account, Arabic numbers, and the friend code only for its owner.
  const mine = (await nadia('/api/users/nadia')).body.account;
  assert.deepEqual(mine.badges, ['founder']);
  assert.deepEqual(mine.arabic, { games: 0, requests: 0 });
  assert.match(mine.friendCode, /^GS-/);
  assert.equal((await omar('/api/users/nadia')).body.account.friendCode, null);
  db.prepare("UPDATE users SET steam_id = '76561198000000001', steam_avatar = 'https://avatars.steamstatic.com/abc_full.jpg' WHERE username = 'nadia'").run();
  const seen = (await omar('/api/users/nadia')).body;
  assert.deepEqual(seen.account.badges, ['founder', 'steam']);
  assert.equal(seen.user.avatarUrl, 'https://avatars.steamstatic.com/abc_full.jpg');
  assert.equal((await omar('/api/friends')).body.friends[0].avatarUrl, 'https://avatars.steamstatic.com/abc_full.jpg');
});

test('the country lists on the server and in the browser are the same', async () => {
  const server = require('../src/countries');
  // A browser module (ES module syntax in a CommonJS package): loaded from its source.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/countries.js'), 'utf8');
  const web = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.deepEqual(web.COUNTRIES, server.COUNTRIES);
  assert.deepEqual(web.ARAB_COUNTRIES, server.ARAB_COUNTRIES);
  assert.ok(server.ARAB_COUNTRIES.every((c) => server.COUNTRIES.includes(c)));
  assert.equal(server.COUNTRIES.length, new Set(server.COUNTRIES).size);
  assert.equal(server.normalizeCountry('ae'), 'AE');
  assert.equal(server.normalizeCountry('XX'), null);
  assert.equal(web.flagEmoji('AE'), '🇦🇪');
  assert.equal(web.countryName('SA', 'en'), 'Saudi Arabia');
  assert.equal(web.countryName('SA', 'ar'), 'المملكة العربية السعودية');
});
