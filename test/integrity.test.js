// Game updates and Arabic: when the store updates a game, GameShelf notices at
// Play (the game's own files and the files it replaced), takes its old Arabic
// out without ever putting an outdated original back over the update, and
// makes the Arabic again for the new version before the game starts. A new
// font style picked for a game is made the same way.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writePack } = require('../desktop/localization/pack');
const { createLocalization } = require('../desktop/localization/index');
const { createArabicService } = require('../desktop/localization/service');
const { createPackLibrary } = require('../desktop/localization/library');

const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-update-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content ?? 'x');
  }
  return root;
}

async function makePack(engine, files, details = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
  for (const [target, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, 'payload', target)), { recursive: true });
    await fs.writeFile(path.join(dir, 'payload', target), content);
  }
  const list = Object.keys(files).map((target) => ({ source: `payload/${target}`, target }));
  await writePack(dir, { id: `test-${engine}`, version: '1.0.0', engine, files: list, privateKey: keys.privateKey, ...details });
  return dir;
}

// A store update: new contents, and a later time, as Steam writes them.
async function update(file, content) {
  await fs.writeFile(file, content);
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(file, later, later);
}

async function setup(t, files) {
  const game = await tree(files);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  return { game, data, localization: createLocalization({ dataDir: data }) };
}

const unrealGame = { 'Engine/x.txt': 'x', 'Blade/Content/Paks/pakchunk0-Windows.pak': 'english pak', 'Blade/Binaries/Win64/Blade-Win64-Shipping.exe': 'MZ' };
const unrealPack = () => makePack('unreal', { 'pakchunk99-ArabicLocalization_P.pak': 'arabic pak' });

// ---- Telling an update ----------------------------------------------------------------

test('an untouched game reads as it was; an update to its archives or program, or a new archive, reads as an update', async (t) => {
  const { game, localization } = await setup(t, unrealGame);
  assert.equal(await localization.verify(game), null); // nothing in yet
  await localization.enable({ root: game, packDir: await unrealPack(), publicKey: PUBLIC });
  assert.deepEqual(await localization.verify(game), { updated: false, changes: [], backups: [] });

  await update(path.join(game, 'Blade/Content/Paks/pakchunk0-Windows.pak'), 'english pak, patched');
  await fs.writeFile(path.join(game, 'Blade/Content/Paks/pakchunk1-Windows.pak'), 'new content');
  const after = await localization.verify(game);
  assert.equal(after.updated, true);
  assert.deepEqual(after.changes.map((c) => [path.basename(c.path), c.what]).sort(), [['pakchunk0-Windows.pak', 'changed'], ['pakchunk1-Windows.pak', 'added']]);

  // Retiring takes GameShelf's patch out and leaves everything the update wrote.
  const retired = await localization.retire({ root: game });
  assert.deepEqual(retired.kept, []);
  assert.deepEqual((await fs.readdir(path.join(game, 'Blade/Content/Paks'))).sort(), ['pakchunk0-Windows.pak', 'pakchunk1-Windows.pak']);
  assert.equal(await localization.status(game), null);
});

test('a file GameShelf replaced that an update wrote over stays the update\'s, and its outdated original is dropped', async (t) => {
  const { game, data, localization } = await setup(t, { 'Game.exe': 'MZ', 'data/lang/en.json': '{"start":"Start"}' });
  await localization.enable({ root: game, packDir: await makePack('loose', { 'data/lang/en.json': '{"start":"ابدأ"}' }), publicKey: PUBLIC });
  const file = path.join(game, 'data/lang/en.json');
  await update(file, '{"start":"Start","new":"New quest"}');
  assert.deepEqual((await localization.verify(game)).changes.map((c) => c.what), ['overwritten']);

  // Turning off the ordinary way would keep the old original aside, never over the update...
  // ...and after an update GameShelf retires it instead: the update's file stays, the outdated copy goes.
  const retired = await localization.retire({ root: game });
  assert.deepEqual([retired.kept, retired.superseded.map((p) => path.basename(p))], [[], ['en.json']]);
  assert.equal(await fs.readFile(file, 'utf8'), '{"start":"Start","new":"New quest"}');
  const backups = await fs.readdir(path.join(data, 'localization', 'backups'), { recursive: true }).catch(() => []);
  assert.deepEqual(backups.filter((n) => n.endsWith('en.json')), []);
  assert.equal(await localization.status(game), null);
});

test('"verify game files" putting the original back reads as an update too', async (t) => {
  const { game, localization } = await setup(t, { 'Game.exe': 'MZ', 'data/lang/en.json': '{"start":"Start"}' });
  await localization.enable({ root: game, packDir: await makePack('loose', { 'data/lang/en.json': '{"start":"ابدأ"}' }), publicKey: PUBLIC });
  await update(path.join(game, 'data/lang/en.json'), '{"start":"Start"}');
  assert.deepEqual((await localization.verify(game)).changes.map((c) => c.what), ['restored']);
  assert.deepEqual((await localization.retire({ root: game })).kept, []);
  assert.equal(await fs.readFile(path.join(game, 'data/lang/en.json'), 'utf8'), '{"start":"Start"}');
});

test('a numbered patch file an update put another after stays in the chain, and the next Arabic goes after both', async (t) => {
  const { game, localization } = await setup(t, { 'game.exe': 'MZ', 're_chunk_000.pak': 'KPKA base', 're_chunk_000.pak.patch_001.pak': 'KPKA one' });
  await localization.enable({ root: game, packDir: await makePack('reengine', { 're_chunk_000.pak.patch_XXX.pak': 'KPKA arabic' }), publicKey: PUBLIC });
  await fs.writeFile(path.join(game, 're_chunk_000.pak.patch_003.pak'), 'KPKA the update');
  assert.deepEqual((await localization.verify(game)).changes.map((c) => [path.basename(c.path), c.what]), [['re_chunk_000.pak.patch_003.pak', 'added']]);
  await assert.rejects(localization.disable({ root: game }), (err) => err.code === 'chain'); // the ordinary way refuses
  const retired = await localization.retire({ root: game });
  assert.deepEqual(retired.left.map((p) => path.basename(p)), ['re_chunk_000.pak.patch_002.pak']);
  assert.equal(await fs.readFile(path.join(game, 're_chunk_000.pak.patch_002.pak'), 'utf8'), 'KPKA arabic');
  assert.equal(await localization.status(game), null);
  // The Arabic goes in again as the next number.
  await localization.enable({ root: game, packDir: await makePack('reengine', { 're_chunk_000.pak.patch_XXX.pak': 'KPKA arabic, again' }), publicKey: PUBLIC });
  assert.equal(await fs.readFile(path.join(game, 're_chunk_000.pak.patch_004.pak'), 'utf8'), 'KPKA arabic, again');
});

test('a missing file of GameShelf\'s, or a damaged backup, is noticed', async (t) => {
  const { game, data, localization } = await setup(t, { 'Game.exe': 'MZ', 'data/lang/en.json': '{"start":"Start"}' });
  await localization.enable({ root: game, packDir: await makePack('loose', { 'data/lang/en.json': '{"start":"ابدأ"}', 'gameshelf_arabic/FONT-LICENSE.txt': 'OFL' }), publicKey: PUBLIC });
  await fs.rm(path.join(game, 'gameshelf_arabic', 'FONT-LICENSE.txt'));
  const [backup] = (await fs.readdir(path.join(data, 'localization', 'backups'), { recursive: true })).filter((n) => n.endsWith('en.json'));
  await fs.writeFile(path.join(data, 'localization', 'backups', backup), 'shorter');
  const verified = await localization.verify(game);
  assert.deepEqual(verified.changes.map((c) => [path.basename(c.path), c.what]), [['FONT-LICENSE.txt', 'missing']]);
  assert.equal(verified.backups.length, 1);
});

// ---- At Play ----------------------------------------------------------------------------

async function serviceFor(t, files, { rebuild }) {
  const { game, data } = await setup(t, files);
  const packs = createPackLibrary({ dir: path.join(data, 'localization', 'packs'), publicKey: PUBLIC });
  const calls = [];
  const arabic = createArabicService({
    dataDir: data, publicKey: PUBLIC, overlayAvailable: false, packs,
    builder: { canBuild: () => true, fromSet: async () => null, rebuild: async (options) => { calls.push(options); return rebuild(options); } },
  });
  const entry = { key: 'steam:7', dir: game, steamAppId: 7, gameId: null };
  return { game, arabic, packs, calls, entry };
}

const looseGame = { 'Game.exe': 'MZ', 'data/lang/en.json': '{"start":"Start"}' };
const loosePack = (arabic, details = {}) => makePack('loose', { 'data/lang/en.json': arabic }, { game: { steamAppId: 7 }, ...details });

test('Play after a game update makes the Arabic again for the new version, then starts', async (t) => {
  const { game, arabic, packs, calls, entry } = await serviceFor(t, looseGame, {
    rebuild: async () => loosePack('{"start":"ابدأ","new":"مهمة جديدة"}', { version: '1.1.0' }),
  });
  await packs.add(await loosePack('{"start":"ابدأ"}'));
  assert.equal((await arabic.set(entry, true)).error, null);
  assert.deepEqual(await arabic.prepareLaunch(entry), { mode: 'native', ok: true });
  assert.equal(calls.length, 0);

  await update(path.join(game, 'data/lang/en.json'), '{"start":"Start","new":"New quest"}');
  const phases = [];
  const launch = await arabic.prepareLaunch(entry, { onProgress: (p) => phases.push(p.phase) });
  assert.deepEqual([launch.mode, launch.ok, launch.updated, launch.remade], ['native', true, true, true]);
  assert.deepEqual(calls.map((c) => [c.tier, c.fontStyle]), [['loose-files', null]]);
  assert.equal(phases[0], 'game-updated');
  assert.equal(await fs.readFile(path.join(game, 'data/lang/en.json'), 'utf8'), '{"start":"ابدأ","new":"مهمة جديدة"}');
  // Arabic off now gives back the updated English, not the English from before the update.
  assert.equal((await arabic.set(entry, false)).error, null);
  assert.equal(await fs.readFile(path.join(game, 'data/lang/en.json'), 'utf8'), '{"start":"Start","new":"New quest"}');
});

test('when the Arabic can\'t be made again after an update, the game starts in English with the update intact', async (t) => {
  const { game, arabic, packs, entry } = await serviceFor(t, looseGame, { rebuild: async () => null });
  await packs.add(await loosePack('{"start":"ابدأ"}'));
  await arabic.set(entry, true);
  await arabic.prepareLaunch(entry);
  await update(path.join(game, 'data/lang/en.json'), '{"start":"Start","new":"New quest"}');
  const launch = await arabic.prepareLaunch(entry);
  assert.deepEqual([launch.ok, launch.updated], [false, true]);
  assert.match(launch.error.text, /The game was updated.*It starts in English this time/);
  assert.equal(await fs.readFile(path.join(game, 'data/lang/en.json'), 'utf8'), '{"start":"Start","new":"New quest"}');
  assert.equal(await arabic.localization.status(game), null);
});

test('a font style picked for a game is made at the next Play', async (t) => {
  const { arabic, packs, calls, entry } = await serviceFor(t, looseGame, {
    rebuild: async ({ fontStyle }) => loosePack('{"start":"ابدأ"}', { version: '1.0.1', fontStyle }),
  });
  await packs.add(await loosePack('{"start":"ابدأ"}', { fontStyle: 'plex' }));
  await arabic.set(entry, true);
  await arabic.prepareLaunch(entry);
  const picked = await arabic.setFont(entry, 'naskh');
  assert.deepEqual(picked.font, { chosen: 'naskh', pack: 'plex', styles: ['plex', 'cairo', 'naskh'] });
  const launch = await arabic.prepareLaunch(entry);
  assert.deepEqual([launch.ok, launch.updated, launch.remade], [true, undefined, true]);
  assert.deepEqual(calls.map((c) => c.fontStyle), ['naskh']);
  assert.equal((await arabic.info(entry)).font.pack, 'naskh');
  // Nothing to make again the time after.
  await arabic.prepareLaunch(entry);
  assert.equal(calls.length, 1);
  await assert.rejects(arabic.setFont(entry, 'comic-sans'), /Unknown font style/);
});

test('Unity games have no font picker: their TextMeshPro font is made with the Unity Editor when the pack is built', async (t) => {
  const exe = Buffer.alloc(0x200);
  exe.write('MZ', 0, 'latin1');
  exe.writeUInt32LE(0x80, 0x3c);
  exe.write('PE\0\0', 0x80, 'latin1');
  exe.writeUInt16LE(0x8664, 0x84);
  const { arabic, entry } = await serviceFor(t, {
    'Game.exe': exe,
    'UnityPlayer.dll': exe,
    'Game_Data/globalgamemanagers': Buffer.concat([Buffer.from([0, 0, 0, 0x16, 0, 0, 0, 0]), Buffer.from('2019.4.40f1\0', 'latin1')]),
    'Game_Data/resources.assets': 'assets',
    'Game_Data/Managed/Assembly-CSharp.dll': 'code',
  }, { rebuild: async () => null });
  const info = await arabic.info(entry);
  assert.equal(info.tier, 'unity-bepinex');
  assert.equal(info.font, undefined);
  // A loose-file game has one.
  const other = await serviceFor(t, looseGame, { rebuild: async () => null });
  assert.deepEqual((await other.arabic.info(other.entry)).font, { chosen: null, pack: null, styles: ['plex', 'cairo', 'naskh'] });
});
