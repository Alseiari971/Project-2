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
  if (username) await call('/api/auth/register', { method: 'POST', body: { username, password: 'correct horse' } });
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
  assert.match(bad.body.error, /COLOR/);
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
