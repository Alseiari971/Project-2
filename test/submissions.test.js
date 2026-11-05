// The queue of Arabic made on players' PCs: a player's app submits a game's
// English lines, an admin reviews and fixes the Arabic without owning the game,
// signs the Arabic set with GameShelf's key, and it goes in the catalog.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory, sha256 } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const { createPackRegistry } = require('../src/pack-registry');
const { createSubmissions } = require('../src/submissions');

const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });

async function start(t) {
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-sub-'));
  const db = openDatabase(':memory:');
  const fetch = async (_url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    const translations = JSON.parse(user.slice(user.indexOf('['))).map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
  };
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'k' }, fetch });
  const server = createApp({
    db, games: createLocalProvider(), translations, dataDir, arabicGames: createArabicGames({ db, translations }),
    packs: createPackRegistry({ db, dir: path.join(dataDir, 'packs'), publicKeys: [PUBLIC] }),
    submissions: createSubmissions({ db, translations, publicKeys: [PUBLIC] }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    if (saved === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = saved;
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}

async function signedUp(base, username) {
  let cookie = '';
  const call = async (route, { method = 'GET', body, raw } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  if (username) await call('/api/auth/register', { method: 'POST', body: { username, password: 'correct horse', email: `${username}@test.example`, nationality: 'AE' } });
  return call;
}

const ENGLISH = ['START GAME', '<COLOR FF0000>Run!</COLOR>', 'Hey Captain.', 'START GAME'];

test('a player\'s submission waits; an admin fixes it, signs it and it goes in the catalog', async (t) => {
  const { base } = await start(t);
  const alice = await signedUp(base, 'alice');
  const hamad = await signedUp(base, 'hamad');
  const anon = await signedUp(base);
  const game = 'steam:1173690';

  // The app translated the lines first (as the player's build does), then submits them.
  const lines = [...new Set(ENGLISH)].map((english) => ({ hash: sha256(english), english }));
  await alice('/api/translations/translate', { method: 'POST', body: { game, lines } });
  assert.equal((await anon('/api/arabic/submissions', { method: 'POST', raw: '{}' })).status, 401);
  const sent = await alice('/api/arabic/submissions', { method: 'POST', raw: JSON.stringify({ game, name: 'RE3 Demo', engine: 'reengine', fontTargets: ['natives/stm/font/a.oft.1', '../evil'], lines: ENGLISH }) });
  assert.deepEqual([sent.status, sent.body.total, sent.body.translated], [200, 3, 3]);
  assert.equal((await alice('/api/admin/submissions')).status, 403);

  const [waiting] = (await hamad('/api/admin/submissions')).body.submissions;
  assert.deepEqual([waiting.game, waiting.status, waiting.submittedBy, waiting.fontTargets, waiting.tier], [game, 'pending', 'alice', ['natives/stm/font/a.oft.1'], 're-patch']);
  const page = (await hamad(`/api/admin/submissions/${waiting.id}?q=run`)).body;
  assert.equal(page.submission.submittedBy, 'alice');
  assert.deepEqual(page.lines.map((l) => [l.english, l.arabic]), [['<COLOR FF0000>Run!</COLOR>', 'عربي <COLOR FF0000>Run!</COLOR>']]);

  // A fix that breaks a tag is refused; a good one is kept for everyone.
  const runHash = sha256('<COLOR FF0000>Run!</COLOR>');
  const bad = await hamad(`/api/admin/submissions/${waiting.id}/lines`, { method: 'PATCH', body: { edits: [{ hash: runHash, arabic: 'اهرب!' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /missing <COLOR FF0000>/);
  // The page is told which line it was, so it can mark it.
  assert.deepEqual(bad.body.problems.map((p) => p.hash), [runHash]);
  // One bad line keeps the good ones in the same save from being saved half-way.
  const mixed = await hamad(`/api/admin/submissions/${waiting.id}/lines`, { method: 'PATCH', body: { edits: [{ hash: sha256('Hey Captain.'), arabic: 'مرحبًا أيها القائد.' }, { hash: runHash, arabic: 'اهرب!' }] } });
  assert.equal(mixed.status, 400);
  assert.notEqual((await hamad(`/api/admin/submissions/${waiting.id}?q=captain`)).body.lines[0].arabic, 'مرحبًا أيها القائد.');
  await hamad(`/api/admin/submissions/${waiting.id}/lines`, { method: 'PATCH', body: { edits: [{ hash: runHash, arabic: '<COLOR FF0000>اهرب!</COLOR>' }] } });

  // Signing: the exact set from the server, signed with GameShelf's key. A stranger's key is refused.
  const { set } = (await hamad(`/api/admin/submissions/${waiting.id}/set`)).body;
  const parsed = JSON.parse(set);
  assert.deepEqual([parsed.id, parsed.version, parsed.engine, parsed.game.steamAppId, parsed.lines.length], ['gameshelf-steam-1173690-ar', '1.1.0', 'reengine', 1173690, 3]);
  assert.ok(parsed.lines.some(([hash, arabic]) => hash === runHash && arabic === '<COLOR FF0000>اهرب!</COLOR>'));
  // No English goes to players: each line is its English's hash and the Arabic.
  assert.ok(!set.includes('"english"') && parsed.lines.every((l) => l.length === 2 && /^[0-9a-f]{64}$/.test(l[0])));
  const stranger = crypto.sign(null, Buffer.from(set), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
  assert.equal((await hamad(`/api/admin/submissions/${waiting.id}/approve`, { method: 'POST', raw: JSON.stringify({ set, signature: stranger }) })).status, 400);
  const signature = crypto.sign(null, Buffer.from(set), keys.privateKey).toString('base64');
  const approved = await hamad(`/api/admin/submissions/${waiting.id}/approve`, { method: 'POST', raw: JSON.stringify({ set, signature }) });
  assert.equal(approved.status, 201);
  assert.deepEqual([approved.body.pack.mode, approved.body.pack.tier, approved.body.pack.version], ['build', 're-patch', '1.1.0']);

  // In the catalog for everyone; the set itself for signed-in players.
  const [entry] = (await anon('/api/localization/packs')).body.packs;
  assert.deepEqual([entry.id, entry.mode, entry.steamAppId], ['gameshelf-steam-1173690-ar', 'build', 1173690]);
  assert.equal((await anon(entry.downloadUrl)).status, 401);
  const got = (await alice(entry.downloadUrl)).body;
  assert.equal(got.set, set);
  assert.ok(crypto.verify(null, Buffer.from(got.set), PUBLIC, Buffer.from(got.signature, 'base64')));
  assert.equal(crypto.createHash('sha256').update(got.set).digest('hex'), entry.sha256);
  assert.equal((await hamad('/api/admin/submissions')).body.submissions[0].status, 'approved');
  assert.equal((await hamad(`/api/admin/submissions/${waiting.id}/set`)).status, 400); // done
});

test('a player\'s PC that can\'t read a game leaves a request with the reason; admins can teach RE Engine fonts from a file list', async (t) => {
  const { base } = await start(t);
  const alice = await signedUp(base, 'alice');
  const hamad = await signedUp(base, 'hamad');
  await alice('/api/arabic/requests', { method: 'POST', body: { game: 'steam:2050650', name: 'Resident Evil 4', reason: 'The game\'s files are encrypted.' } });
  const [request] = (await hamad('/api/admin/requests')).body.requests;
  assert.deepEqual([request.game, request.requests, request.reason], ['steam:2050650', 1, 'The game\'s files are encrypted.']);

  const list = 'natives/stm/streaming/x.tex.10\nnatives/stm/escape/ui/ui0000/font/courbd.oft.1\nnatives/stm/escape/ui/ui0000/font/courbd.oft.1.stm\n';
  assert.equal((await alice('/api/admin/games/steam:1173690/file-list', { method: 'PUT', raw: list })).status, 403);
  const saved = await hamad('/api/admin/games/steam:1173690/file-list', { method: 'PUT', raw: list });
  assert.deepEqual(saved.body.fontTargets, ['natives/stm/escape/ui/ui0000/font/courbd.oft.1', 'natives/stm/escape/ui/ui0000/font/courbd.oft.1.stm']);
  const status = (await alice('/api/arabic/status', { method: 'POST', body: { games: ['steam:1173690'] } })).body.games['steam:1173690'];
  assert.equal(status.fontTargets.length, 2);
  assert.equal((await hamad('/api/admin/games/steam:1173690/file-list', { method: 'PUT', raw: 'nothing useful' })).status, 400);
});

test('a newer submission for a game replaces the one still waiting', () => {
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: {} });
  const submissions = createSubmissions({ db, translations, publicKeys: [PUBLIC] });
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'alice', 'Alice', 'x')").run();
  const first = submissions.submit({ id: 1 }, { game: 'steam:4242', name: 'Lantern', engine: 'runtime', lines: ['Press any key to start'] });
  const second = submissions.submit({ id: 1 }, { game: 'steam:4242', name: 'Lantern', engine: 'runtime', lines: ['Press any key to start', 'The gate opens at dawn'] });
  assert.equal(second.id, first.id);
  assert.equal(second.total, 2);
  const [only] = submissions.list();
  assert.deepEqual([only.id, only.tier, only.total], [first.id, 'native-runtime', 2]);
});

test('once a game\'s Arabic is out: askers hear it in the bell, its numbers count up, and only its players rate it', async (t) => {
  const { db, base } = await start(t);
  const alice = await signedUp(base, 'alice');
  const bob = await signedUp(base, 'bob');
  const carol = await signedUp(base, 'carol');
  const hamad = await signedUp(base, 'hamad');
  const anon = await signedUp(base);
  const game = 'steam:1173690';

  // Before: nothing to show, and Bob asks for it.
  assert.deepEqual((await anon('/api/showcase')).body, { games: [], totals: { games: 0, strings: 0, downloads: 0 } });
  assert.equal((await bob('/api/arabic/requests', { method: 'POST', body: { game, name: 'RE3 Demo', reason: 'Please!' } })).status, 200);

  const lines = [...new Set(ENGLISH)].map((english) => ({ hash: sha256(english), english }));
  await alice('/api/translations/translate', { method: 'POST', body: { game, lines } });
  await alice('/api/arabic/submissions', { method: 'POST', raw: JSON.stringify({ game, name: 'RE3 Demo', engine: 'reengine', lines: ENGLISH }) });
  const [waiting] = (await hamad('/api/admin/submissions')).body.submissions;
  const { set } = (await hamad(`/api/admin/submissions/${waiting.id}/set`)).body;
  const signature = crypto.sign(null, Buffer.from(set), keys.privateKey).toString('base64');
  assert.equal((await hamad(`/api/admin/submissions/${waiting.id}/approve`, { method: 'POST', raw: JSON.stringify({ set, signature }) })).status, 201);

  // Bob asked, so the bell tells him; Carol didn't ask and hears nothing.
  const bell = (await bob('/api/notifications')).body;
  assert.equal(bell.unread, 1);
  assert.deepEqual([bell.items[0].kind, bell.items[0].data, bell.items[0].read], ['arabic-ready', { game: 'RE3 Demo' }, false]);
  assert.match(bell.items[0].link, /^#\/(game\/|arabic)/);
  assert.equal((await carol('/api/notifications')).body.items.length, 0);
  assert.equal((await anon('/api/notifications')).status, 401);
  assert.deepEqual((await bob('/api/notifications/read', { method: 'POST', body: {} })).body, { unread: 0 });
  assert.equal((await bob('/api/notifications')).body.items[0].read, true);

  // Downloads count; strings are the set's lines.
  const [entry] = (await anon('/api/localization/packs')).body.packs;
  await alice(entry.downloadUrl);
  await bob(entry.downloadUrl);
  const row = db.prepare('SELECT strings_count, downloads_count FROM arabic_games WHERE game = ?').get(game);
  assert.deepEqual([row.strings_count, row.downloads_count], [3, 2]);

  // Ratings: 1 to 5 stars, only from a player who has the Arabic; again changes them.
  assert.equal((await carol('/api/arabic/ratings', { method: 'POST', body: { game, stars: 5 } })).status, 403);
  assert.equal((await bob('/api/arabic/ratings', { method: 'POST', body: { game, stars: 6 } })).status, 400);
  assert.equal((await bob('/api/arabic/ratings', { method: 'POST', body: { game: 'nope', stars: 4 } })).status, 400);
  assert.equal((await anon('/api/arabic/ratings', { method: 'POST', body: { game, stars: 4 } })).status, 401);
  await bob('/api/arabic/ratings', { method: 'POST', body: { game, stars: 3 } });
  const rated = (await alice('/api/arabic/ratings', { method: 'POST', body: { game, stars: 4 } })).body.stats;
  assert.deepEqual(rated, { strings: 3, downloads: 2, rating: 3.5, ratings: 2, mine: 4, canRate: true });
  const changed = (await bob('/api/arabic/ratings', { method: 'POST', body: { game, stars: 5 } })).body.stats;
  assert.deepEqual([changed.rating, changed.ratings, changed.mine], [4.5, 2, 5]);

  // The showcase's totals (the catalog's local provider has no Steam page for it, so no card).
  const showcase = (await anon('/api/showcase')).body;
  assert.deepEqual(showcase.totals, { games: 1, strings: 3, downloads: 2 });
});
