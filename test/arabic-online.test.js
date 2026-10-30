// "Request Arabic subtitles" in the desktop app: the app gets a device token
// from GameShelf's server, the real pack builder makes the pack on this PC from
// the game's own text with the server's Arabic, and the server then counts the
// game as ready for the next player.
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
const { createArabicOnline, gameKey } = require('../desktop/localization/online');
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

test('Request Arabic subtitles: built on this PC with the server\'s Arabic, then ready for the next player', { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-online-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
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
  const server = createApp({ db, games: createLocalProvider(), translations, arabicGames: createArabicGames({ db, translations, env: {} }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // A small Ren'Py game.
  const game = path.join(tmp, 'Question');
  await fs.mkdir(path.join(game, 'renpy'), { recursive: true });
  await fs.mkdir(path.join(game, 'game'), { recursive: true });
  await fs.writeFile(path.join(game, 'game', 'script.rpy'), 'label start:\n    "We must reach the castle before nightfall."\n    s "Hi there! How was class?"\n    "Run!"\n');

  const player = async (name) => {
    const dataDir = path.join(tmp, name);
    const key = localPackKey(dataDir);
    const online = createArabicOnline({ server: base, dataDir });
    const builder = createPackBuilder({
      paths: { ...findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python } }), msgTool: null },
      outDir: path.join(dataDir, 'builds'),
      keyFile: key.keyFile,
    });
    return { dataDir, key, online, builder };
  };

  const first = await player('first');
  const steam = { steamAppId: 1234567 };
  assert.equal((await first.online.status(gameKey(steam))).status, 'none');
  assert.match(await fs.readFile(path.join(first.dataDir, 'localization', 'online.json'), 'utf8'), /"token":"gsd_/);

  const seen = [];
  const result = await first.builder.build({ key: 'steam:1234567', dir: game, tier: 'renpy-tl', title: 'The Question', ...steam },
    { server: first.online.server, token: await first.online.token(), onProgress: (p) => seen.push(p.phase) });
  assert.equal(result.missing || 0, 0);
  assert.equal(result.translated, 3);
  assert.ok(seen.includes('translating') && seen.includes('done'));
  assert.equal(asked, 3);

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
    { server: other.online.server, token: await other.online.token() });
  assert.equal(asked, 3);
});

test('asking for a game the app can\'t build counts once per player', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-online-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: {} });
  const server = createApp({ db, games: createLocalProvider(), translations, arabicGames: createArabicGames({ db, translations, env: {} }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const online = createArabicOnline({ server: `http://127.0.0.1:${server.address().port}`, dataDir: tmp });
  assert.equal((await online.request('steam:952060', 'Resident Evil 3')).requests, 1);
  const again = await online.request('steam:952060', 'Resident Evil 3');
  assert.deepEqual([again.requests, again.asked], [1, true]);
  // A token the server forgot is replaced without the player noticing.
  db.prepare('DELETE FROM devices').run();
  assert.equal((await online.status('steam:952060')).asked, false);

  const offline = createArabicOnline({ server: 'http://127.0.0.1:9', dataDir: tmp, timeoutMs: 2000 });
  await assert.rejects(offline.status('steam:952060'), /couldn't reach its server/);
});
