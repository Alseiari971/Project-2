// The whole crowd-sourced flow, with the real server, the real pack builder and
// a small Ren'Py game: a player asks for Arabic and agrees to the scan; their
// app builds it from their copy of the game (they play in Arabic straight away)
// and submits it; an admin who doesn't have the game fixes a line and approves,
// signing it with GameShelf's key; a second player then turns Arabic on and gets
// it, built on their own PC, with the admin's fix and nothing translated again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory, sha256 } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const { createPackRegistry } = require('../src/pack-registry');
const { createSubmissions } = require('../src/submissions');
const { createCloudClient } = require('../desktop/cloud');
const { createArabicOnline } = require('../desktop/localization/online');
const { createArabicService } = require('../desktop/localization/service');
const { createPackBuilder, findBuilder, localPackKey } = require('../desktop/localization/builder');
const { createArabicRequests } = require('../desktop/localization/requests');
const { createStudio } = require('../desktop/localization/studio');

const REPO = path.join(__dirname, '..');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const cloudAs = (base, value) => createCloudClient({ server: () => base, session: async () => value });

async function readTree(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(await fs.readFile(path.join(entry.parentPath || entry.path, entry.name), 'utf8').catch(() => ''));
  }
  return out.join('\n');
}

test('request, consent, local build, pending review, admin sign & publish, second player', { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-crowd-'));
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(async () => {
    if (saved === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // GameShelf's server, translating with a stand-in for its AI provider that counts what it's asked.
  const db = openDatabase(':memory:');
  let asked = 0;
  const fetch = async (_url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    const lines = JSON.parse(user.slice(user.indexOf('[')));
    asked += lines.length;
    const translations = lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
  };
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch });
  const server = createApp({
    db, games: createLocalProvider(), translations, dataDir: tmp, arabicGames: createArabicGames({ db, translations }),
    packs: createPackRegistry({ db, dir: path.join(tmp, 'catalog'), publicKeys: [PUBLIC] }),
    submissions: createSubmissions({ db, translations, publicKeys: [PUBLIC] }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const signUp = async (username) => {
    const res = await globalThis.fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse' }) });
    return /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  };

  // The game, on the players' PCs (the admin never has it).
  const gameDir = path.join(tmp, 'The Question');
  await fs.mkdir(path.join(gameDir, 'renpy'), { recursive: true });
  await fs.mkdir(path.join(gameDir, 'game'), { recursive: true });
  await fs.writeFile(path.join(gameDir, 'TheQuestion.exe'), 'launcher');
  await fs.writeFile(path.join(gameDir, 'renpy', 'vc_version.py'), "version = '8.3.4.24120703'\n");
  await fs.writeFile(path.join(gameDir, 'game', 'script.rpy'), 'label start:\n    "We must reach the castle before nightfall."\n    s "Hi there! How was class?"\n    "Run!"\n');
  const game = { key: 'steam:1234567', dir: gameDir, steamAppId: 1234567, gameId: null, title: 'The Question' };

  // A player's copy of GameShelf: the same pieces main.js puts together.
  const player = async (name) => {
    const dataDir = path.join(tmp, name);
    const cloud = cloudAs(base, await signUp(name));
    const online = createArabicOnline({ cloud, cacheDir: path.join(dataDir, 'downloads'), publicKeys: [PUBLIC] });
    const local = localPackKey(dataDir);
    const packBuilder = createPackBuilder({
      paths: { ...findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python } }), msgTool: null },
      outDir: path.join(dataDir, 'builds'),
      keyFile: local.keyFile,
      nodePath: process.execPath,
    });
    const arabic = createArabicService({
      dataDir,
      publicKey: [PUBLIC, local.publicKey],
      overlayAvailable: false,
      catalog: online.catalog,
      builder: {
        canBuild: (tier) => packBuilder.canBuild(tier),
        fromSet: async ({ game: g, tier, entry, set, setFile, onProgress }) => (await packBuilder.build(
          { ...g, tier, title: entry.title || set.title }, { set: setFile, fontTargets: set.fontTargets || [], version: entry.version, onProgress })).packDir,
      },
    });
    const requests = createArabicRequests({ arabic, packBuilder, online, server: () => base });
    return { cloud, online, arabic, requests };
  };

  // 4-7. Alice's game has no Arabic; she asks for it. Nothing is read before she agrees.
  const alice = await player('alice');
  const before = await alice.arabic.info(game);
  assert.deepEqual([before.mode, before.missing, before.tier], ['unavailable', true, 'renpy-tl']);
  assert.deepEqual(await alice.requests.run(game, { consent: false }), { done: false, needsConsent: true });
  assert.equal(asked, 0);

  // 8-9. She approves: her PC reads the text, the server translates it, the pack is built and on, and it's submitted.
  const phases = [];
  const made = await alice.requests.run(game, { consent: true, onProgress: (p) => phases.push(p.phase) });
  assert.equal(made.done, true, JSON.stringify(made.error || made));
  assert.deepEqual([made.info.mode, made.info.enabled], ['native', true]);
  assert.equal(asked, 3);
  for (const phase of ['translating', 'submitting']) assert.ok(phases.includes(phase), phases.join());
  assert.deepEqual([made.submitted.total, made.submitted.translated], [3, 3]);

  // 10. The admin sees it waiting, though they don't have the game, fixes a line, and approves.
  const hamad = await player('hamad');
  const { submissions } = await hamad.cloud.json('/api/admin/submissions');
  assert.deepEqual(submissions.map((s) => [s.game, s.status, s.submittedBy, s.engine]), [['steam:1234567', 'pending', 'alice', 'renpy']]);
  const page = await hamad.cloud.json(`/api/admin/submissions/${submissions[0].id}?q=Run`);
  assert.deepEqual(page.lines.map((l) => l.english), ['Run!']);
  await hamad.cloud.json(`/api/admin/submissions/${submissions[0].id}/lines`, { method: 'PATCH', body: { edits: [{ hash: sha256('Run!'), arabic: 'اهرب!' }] } });

  const keyFile = path.join(tmp, 'pack-signing.key');
  await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const studio = createStudio({ paths: {}, dataDir: path.join(tmp, 'hamad'), cloud: hamad.cloud, appKeys: [PUBLIC] });
  studio.saveSettings({ keyFile });
  const published = await studio.approve(submissions[0].id);
  assert.deepEqual([published.id, published.mode, published.tier, published.version], ['gameshelf-steam-1234567-ar', 'build', 'renpy-tl', '1.1.0']);
  // A player can't approve.
  const aliceStudio = createStudio({ paths: {}, dataDir: path.join(tmp, 'alice-studio'), cloud: alice.cloud, appKeys: [PUBLIC] });
  aliceStudio.saveSettings({ keyFile });
  await assert.rejects(aliceStudio.approve(submissions[0].id), /Only admins/);

  // Every player with the game now sees the Arabic switch ready.
  const bob = await player('bob');
  const ready = await bob.arabic.info(game);
  assert.deepEqual([ready.mode, ready.cloud?.mode, ready.enabled], ['native', 'build', false]);
  const steps = [];
  const turnedOn = await bob.arabic.set(game, true, { onProgress: (p) => steps.push(p.phase) });
  assert.equal(turnedOn.error, null);
  assert.deepEqual([turnedOn.info.mode, turnedOn.info.enabled, turnedOn.info.pack.version], ['native', true, '1.1.0']);
  assert.ok(steps.includes('downloading') && steps.includes('checking'));
  assert.equal(asked, 3); // nothing translated again
  // Bob's patch has the admin's fix.
  const [bobPack] = await bob.arabic.packs.list();
  const contents = await readTree(bobPack.dir);
  assert.ok(contents.includes('اهرب!'), 'the admin\'s Arabic is in the patch');

  // Alice's own (unreviewed) build is replaced by the approved one the next time she plays
  // (once her app looks at the catalog again: it keeps it for five minutes).
  alice.online.catalog.forget();
  const update = await alice.arabic.info(game);
  assert.equal(update.update?.version, '1.1.0');
  const launch = await alice.arabic.prepareLaunch(game);
  assert.deepEqual([launch.mode, launch.ok], ['native', true]);
  assert.deepEqual((await alice.arabic.packs.list()).map((p) => p.version), ['1.1.0']);
});

test('a game the player\'s PC can\'t read goes to the admins as a request, with the reason', { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-crowd-'));
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(async () => {
    if (saved === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: {} });
  const server = createApp({ db, games: createLocalProvider(), translations, dataDir: tmp, arabicGames: createArabicGames({ db, translations }),
    submissions: createSubmissions({ db, translations, publicKeys: [PUBLIC] }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const signUp = async (username) => {
    const res = await globalThis.fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse' }) });
    return /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  };
  // A game in an engine GameShelf can't patch.
  const gameDir = path.join(tmp, 'Mystery');
  await fs.mkdir(gameDir);
  await fs.writeFile(path.join(gameDir, 'Mystery.exe'), 'MZ');
  const cloud = cloudAs(base, await signUp('alice'));
  const online = createArabicOnline({ cloud, cacheDir: path.join(tmp, 'dl'), publicKeys: [PUBLIC] });
  const packBuilder = createPackBuilder({ paths: { ...findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python } }), msgTool: null }, outDir: path.join(tmp, 'b'), keyFile: localPackKey(tmp).keyFile });
  const arabic = createArabicService({ dataDir: path.join(tmp, 'd'), publicKey: PUBLIC, overlayAvailable: false, catalog: online.catalog, builder: { canBuild: (tier) => packBuilder.canBuild(tier), fromSet: async () => null } });
  const requests = createArabicRequests({ arabic, packBuilder, online, server: () => base });
  const result = await requests.run({ key: 'steam:999', dir: gameDir, steamAppId: 999, gameId: null, title: 'Mystery' }, { consent: true });
  assert.equal(result.requested, true);
  const admin = cloudAs(base, await signUp('hamad'));
  const [request] = (await admin.json('/api/admin/requests')).requests;
  assert.deepEqual([request.game, request.name, request.requests], ['steam:999', 'Mystery', 1]);
  assert.match(request.reason, /can't/);
});
