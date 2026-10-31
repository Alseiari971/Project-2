// Arabic subtitles in the desktop app, as a signed-in player: catalog packs
// downloaded when the switch goes on, "Request Arabic subtitles" (the real pack
// builder makes the pack on this PC from the game's own text, with the server's
// Arabic), and the app's pass-through to GameShelf's server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const crypto = require('node:crypto');
const { createArabicOnline, gameKey } = require('../desktop/localization/online');
const { createCloudClient, createPassThrough } = require('../desktop/cloud');
const { createArabicService } = require('../desktop/localization/service');
const { createPackRegistry } = require('../src/pack-registry');
const { writeZip } = require('../src/zip');
const { writePack } = require('../desktop/localization/pack');
const { KIND } = require('../desktop/localization/fingerprint');
const { createPackBuilder, findBuilder, localPackKey, readLine } = require('../desktop/localization/builder');
const { createPackLibrary } = require('../desktop/localization/library');

const REPO = path.join(__dirname, '..');

test('the builder\'s output reads as progress', () => {
  const state = { phase: 'starting' };
  for (const line of [
    'Reading the game\'s own paks. Turn Arabic off for this game in GameShelf first, so its Arabic patch isn\'t read as the game\'s English.',
    '6842 English lines; making a reengine pack.',
    'Shared memory had 2100 of 6585 lines.',
    'Shared memory: 300/4485 asked for (10 failed)',
  ]) readLine(line, state);
  assert.deepEqual(state, { phase: 'translating', total: 6842, have: 2100, asking: 4485, asked: 300 });
  readLine('The server\'s translation limit for today (or this month) is reached; the rest stays untranslated for now.', state);
  readLine('4663 lines have no Arabic and are left out of the pack.', state);
  readLine('The shared memory has 2179 of this game\'s 6585 lines in Arabic.', state);
  readLine('Packed 149 files into re_chunk_000.pak.patch_XXX.pak; GameShelf gives it the game\'s next patch number when it adds it.', state);
  assert.equal(state.phase, 'packing');
  readLine('Done: C:\\Users\\Hamad\\AppData\\GameShelf\\builds\\x\\pack (2179 lines). Add it in GameShelf under App settings, Arabic subtitle packs.', state);
  assert.deepEqual([state.phase, state.packDir, state.limited, state.missing, state.translated, state.lines],
    ['done', 'C:\\Users\\Hamad\\AppData\\GameShelf\\builds\\x\\pack', true, 4663, 2179, 6585]);
});

test('the app finds its own Python when installed, and RE Engine needs REMSG_Converter', () => {
  const paths = findBuilder({ packaged: true, resourcesPath: 'R', repoDir: 'X', env: {}, platform: 'win32', exists: () => true });
  assert.equal(paths.python, path.join('R', 'arabic-builder', 'python', 'python.exe'));
  assert.equal(paths.script, path.join('R', 'arabic-builder', 'scripts', 'build-arabic-pack.py'));
  assert.equal(paths.signer, path.join('R', 'app.asar.unpacked', 'scripts', 'localization-pack.js'));
  const bare = findBuilder({ packaged: true, resourcesPath: 'R', repoDir: 'X', env: {}, platform: 'win32', exists: () => false });
  const builder = createPackBuilder({ paths: bare, outDir: 'o', keyFile: 'k' });
  assert.equal(builder.canBuild('renpy-tl'), false); // an installed app without its Python can't build
  const dev = createPackBuilder({ paths: { ...bare, python: 'python' }, outDir: 'o', keyFile: 'k' });
  assert.deepEqual([dev.canBuild('renpy-tl'), dev.canBuild('re-patch'), dev.canBuild('unreal-pak')], [true, false, false]);
  assert.equal(gameKey({ steamAppId: 1173690 }), 'steam:1173690');
  assert.equal(gameKey({ gameId: 'Bad Id!' }), null);
});

const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });

/** A real GameShelf server (with a stand-in for OpenAI that counts the lines it's asked for). */
async function startServer(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-online-'));
  const db = openDatabase(':memory:');
  const asked = { lines: 0 };
  const fetch = async (_url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    const lines = JSON.parse(user.slice(user.indexOf('[')));
    asked.lines += lines.length;
    const translations = lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
  };
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch });
  const packs = createPackRegistry({ db, dir: path.join(dataDir, 'packs'), publicKeys: [PUBLIC] });
  const server = createApp({ db, games: createLocalProvider(), translations, arabicGames: createArabicGames({ db, translations }), dataDir, packs }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { db, packs, asked, base: `http://127.0.0.1:${server.address().port}`, dataDir };
}

/** Registers an account and returns its sign-in cookie's value. */
async function signUp(base, username) {
  const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse' }) });
  assert.equal(res.status, 201);
  return /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
}

const cloudAs = (base, value) => createCloudClient({ server: () => base, session: async () => value });

test('Request Arabic subtitles: built on this PC with the server\'s Arabic, then ready for the next player', { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
  const { base, asked, dataDir: tmp } = await startServer(t);

  // A small Ren'Py game.
  const game = path.join(tmp, 'Question');
  await fs.mkdir(path.join(game, 'renpy'), { recursive: true });
  await fs.mkdir(path.join(game, 'game'), { recursive: true });
  await fs.writeFile(path.join(game, 'game', 'script.rpy'), 'label start:\n    "We must reach the castle before nightfall."\n    s "Hi there! How was class?"\n    "Run!"\n');

  const player = async (name) => {
    const dataDir = path.join(tmp, name);
    const key = localPackKey(dataDir);
    const cloud = cloudAs(base, await signUp(base, name));
    const online = createArabicOnline({ cloud, cacheDir: path.join(dataDir, 'downloads') });
    const builder = createPackBuilder({
      paths: { ...findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python } }), msgTool: null },
      outDir: path.join(dataDir, 'builds'),
      keyFile: key.keyFile,
    });
    return { dataDir, key, cloud, online, builder };
  };

  const first = await player('first');
  const steam = { steamAppId: 1234567 };
  assert.equal((await first.online.status(gameKey(steam))).status, 'none');

  const seen = [];
  const result = await first.builder.build({ key: 'steam:1234567', dir: game, tier: 'renpy-tl', title: 'The Question', ...steam },
    { server: base, auth: await first.online.builderEnv(), onProgress: (p) => seen.push(p.phase) });
  assert.equal(result.missing || 0, 0);
  assert.equal(result.translated, 3);
  assert.ok(seen.includes('translating') && seen.includes('done'));
  assert.equal(asked.lines, 3);

  // The pack is signed with this PC's own key, which the app trusts.
  const library = createPackLibrary({ dir: path.join(first.dataDir, 'packs'), publicKey: [null, first.key.publicKey] });
  const added = await library.add(result.packDir);
  assert.deepEqual([added.id, added.engine, added.game.steamAppId], ['gameshelf-steam-1234567-ar', 'renpy', 1234567]);
  // ...and no other copy of the app's key.
  const other = await player('second');
  await assert.rejects(createPackLibrary({ dir: path.join(other.dataDir, 'packs'), publicKey: other.key.publicKey }).add(result.packDir), /signature/);

  // The next player finds it ready, and their build costs nothing.
  const status = await other.online.status(gameKey(steam));
  assert.deepEqual([status.status, status.total, status.translated], ['ready', 3, 3]);
  await other.builder.build({ key: 'steam:1234567', dir: game, tier: 'renpy-tl', title: 'The Question', ...steam },
    { server: base, auth: await other.online.builderEnv() });
  assert.equal(asked.lines, 3);

  // Signed out, the builder can't ask the server.
  await assert.rejects(createArabicOnline({ cloud: cloudAs(base, null), cacheDir: tmp }).builderEnv(), /Log in/);
});

test('asking for a game the app can\'t build counts once per player, and needs a sign-in', async (t) => {
  const { base } = await startServer(t);
  const online = createArabicOnline({ cloud: cloudAs(base, await signUp(base, 'alice')), cacheDir: os.tmpdir() });
  assert.equal((await online.request('steam:952060', 'Resident Evil 3')).requests, 1);
  const again = await online.request('steam:952060', 'Resident Evil 3');
  assert.deepEqual([again.requests, again.asked], [1, true]);
  await assert.rejects(createArabicOnline({ cloud: cloudAs(base, null), cacheDir: os.tmpdir() }).request('steam:952060'), /Log in/);
  await assert.rejects(createArabicOnline({ cloud: cloudAs('http://127.0.0.1:9', 'x'), cacheDir: os.tmpdir() }).status('steam:952060'), /couldn't reach its server/);
});

/** A signed overlay pack for a Steam game, as a .zip. */
async function overlayPack(version, steamAppId = 1173690) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
  await fs.writeFile(path.join(dir, 'fingerprints.json'), JSON.stringify({ kind: KIND, format: 2, normalization: 1, entries: [] }));
  await writePack(dir, { id: 're3-demo-ar', version, engine: 'overlay', title: 'Resident Evil 3 Demo', game: { steamAppId }, files: [{ source: 'fingerprints.json', target: 'fingerprints.json' }], privateKey: keys.privateKey });
  const files = [];
  for (const name of ['pack.json', 'pack.json.sig', 'fingerprints.json']) files.push({ name, data: await fs.readFile(path.join(dir, name)) });
  await fs.rm(dir, { recursive: true, force: true });
  return writeZip(files);
}

test('a catalog pack shows as available, and turning Arabic on downloads, checks and installs it', async (t) => {
  const { base, packs } = await startServer(t);
  await packs.publish(await overlayPack('1.0.0'));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-player-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const gameDir = path.join(tmp, 'RE3DEMO');
  await fs.mkdir(gameDir);
  await fs.writeFile(path.join(gameDir, 're3demo.exe'), 'MZ');
  const game = { key: 'steam:1173690', dir: gameDir, steamAppId: 1173690, gameId: null };

  const player = (session) => {
    const online = createArabicOnline({ cloud: cloudAs(base, session), cacheDir: path.join(tmp, 'downloads') });
    return createArabicService({ dataDir: path.join(tmp, 'data'), publicKey: PUBLIC, overlayAvailable: true, catalog: online.catalog });
  };

  // Signed out: it shows, but the download needs an account.
  const stranger = player(null);
  const shown = await stranger.info(game);
  assert.deepEqual([shown.mode, shown.cloud?.version, shown.enabled], ['overlay', '1.0.0', false]);
  const refused = await stranger.set(game, true);
  assert.match(refused.error.text, /Log in/);
  assert.deepEqual(await stranger.packs.list(), []);

  const arabic = player(await signUp(base, 'alice'));
  const progress = [];
  const { info, error } = await arabic.set(game, true, { onProgress: (p) => progress.push(p.phase) });
  assert.equal(error, null);
  assert.deepEqual([info.mode, info.enabled, info.cloud, info.pack.version], ['overlay', true, undefined, '1.0.0']);
  assert.ok(progress.includes('downloading') && progress.includes('checking'));
  assert.deepEqual((await arabic.packs.list()).map((p) => [p.id, p.version]), [['re3-demo-ar', '1.0.0']]);
  assert.deepEqual(await fs.readdir(path.join(tmp, 'downloads')), []); // nothing left behind

  // A newer version in the catalog comes down when Play is pressed.
  await packs.publish(await overlayPack('1.1.0'));
  const fresh = player(await signUp(base, 'bob'));
  assert.equal((await fresh.info(game)).update?.version, '1.1.0');
  const ready = await fresh.prepareLaunch(game);
  assert.deepEqual([ready.mode, ready.ok, ready.error], ['overlay', true, undefined]);
  assert.deepEqual((await fresh.packs.list()).map((p) => p.version), ['1.1.0']);
});

test('a download that doesn\'t match the catalog\'s SHA-256 is thrown away', async (t) => {
  const { base, packs, db } = await startServer(t);
  await packs.publish(await overlayPack('1.0.0'));
  db.prepare("UPDATE localization_packs SET sha256 = 'not-the-hash'").run();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-player-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const online = createArabicOnline({ cloud: cloudAs(base, await signUp(base, 'alice')), cacheDir: path.join(tmp, 'downloads') });
  const [entry] = await online.catalog.list();
  await assert.rejects(online.catalog.fetch(entry), /didn't download correctly/);
  assert.deepEqual(await fs.readdir(path.join(tmp, 'downloads')), []);
});

test('the app\'s pass-through: its own pages, the server\'s /api, and a sign-in that sticks on plain http', async (t) => {
  const { base } = await startServer(t);
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production'; // the server marks its cookie Secure, as a real one does
  t.after(() => { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; });
  const local = createPassThrough({ target: base, publicDir: path.join(REPO, 'public') }).listen(0, '127.0.0.1');
  await new Promise((resolve) => local.once('listening', resolve));
  t.after(() => local.close());
  const app = `http://127.0.0.1:${local.address().port}`;

  const page = await fetch(`${app}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

  const reg = await fetch(`${app}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app }, body: JSON.stringify({ username: 'alice', password: 'correct horse' }) });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie');
  assert.match(cookie, /gs_session=/);
  assert.doesNotMatch(cookie, /Secure/i);
  const me = await (await fetch(`${app}/api/me`, { headers: { Cookie: cookie.split(';')[0] } })).json();
  assert.deepEqual([me.user.username, me.user.role], ['alice', 'user']);

  const remote = createPassThrough({ target: 'http://127.0.0.1:9', publicDir: path.join(REPO, 'public') }).listen(0, '127.0.0.1');
  await new Promise((resolve) => remote.once('listening', resolve));
  t.after(() => remote.close());
  const down = await fetch(`http://127.0.0.1:${remote.address().port}/api/me`);
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /couldn't reach its server/);
});
