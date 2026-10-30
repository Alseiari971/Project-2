// The switch next to Play: which mode each game gets, turning it on and off,
// getting Arabic ready at Play, and the packs library behind it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { writePack } = require('../desktop/localization/pack');
const { createPackLibrary } = require('../desktop/localization/library');
const { createArabicService } = require('../desktop/localization/service');
const fixture = require('./fixtures/fingerprint-vectors.json');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const STEAM_ID = 4242;

function program() {
  const b = Buffer.alloc(512);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(0x8664, 0x84);
  return b;
}

const temp = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

async function tree(files) {
  const root = await temp('gs-game-');
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}

const unrealGame = (extra = {}) => tree({
  'MyGame.exe': program(),
  'Engine/Binaries/Win64/x.txt': 'x',
  'MyGame/Content/Paks/pakchunk0-Windows.pak': 'game data',
  'MyGame/Binaries/Win64/MyGame-Win64-Shipping.exe': program(),
  ...extra,
});

async function packFolder(engine, files, details = {}) {
  const dir = await temp('gs-pack-');
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  await writePack(dir, {
    id: `${engine}-pack`,
    version: '1.0.0',
    engine,
    game: { steamAppId: STEAM_ID },
    files: Object.keys(files).filter((f) => f.startsWith('payload/')).map((source) => ({ source, target: source.slice('payload/'.length) })),
    privateKey,
    ...details,
  });
  return dir;
}

const nativePack = (details) => packFolder('unreal', { 'payload/pakchunk99-ArabicLocalization_P.pak': 'arabic' }, details);
const overlayPack = (details) => packFolder('overlay', { 'payload/fingerprints.json': JSON.stringify(fixture.table) }, { overlay: { threshold: 0.7 }, ...details });

async function service({ overlayAvailable = true, key = publicKey, packs = [] } = {}) {
  const dataDir = await temp('gs-data-');
  const arabic = createArabicService({ dataDir, publicKey: key, overlayAvailable });
  for (const dir of packs) await arabic.packs.add(await dir);
  return arabic;
}

const gameAt = (dir) => ({ key: 'steam:4242', dir, steamAppId: STEAM_ID, gameId: 'my-game' });

test('without the pack key nothing is offered', async () => {
  const arabic = await service({ key: null });
  const info = await arabic.info(gameAt(await unrealGame()));
  assert.equal(info.mode, 'unavailable');
  assert.match(info.why.text, /aren't set up/);
});

test('a game with no pack is unavailable, and can\'t be switched on', async () => {
  const arabic = await service();
  const game = gameAt(await unrealGame());
  assert.equal((await arabic.info(game)).why.text, 'There\'s no Arabic pack for this game yet.');
  const result = await arabic.set(game, true);
  assert.equal(result.info.enabled, false);
  assert.ok(result.error);
});

test('native patch: switched on, added at Play, taken out when switched off', async () => {
  const arabic = await service({ packs: [nativePack()] });
  const root = await unrealGame();
  const game = gameAt(root);
  const paks = path.join(root, 'MyGame/Content/Paks');

  assert.equal((await arabic.info(game)).mode, 'native');
  const on = await arabic.set(game, true);
  assert.equal(on.error, null);
  assert.equal(on.info.enabled, true);
  assert.deepEqual(await fs.readdir(paks), ['pakchunk0-Windows.pak']); // nothing yet: it's added at Play

  assert.deepEqual(await arabic.prepareLaunch(game), { mode: 'native', ok: true });
  assert.deepEqual((await fs.readdir(paks)).sort(), ['pakchunk0-Windows.pak', 'pakchunk99-ArabicLocalization_P.pak']);
  assert.equal((await arabic.info(game)).staged, true);

  const running = await arabic.set(game, false, { isRunning: async () => true });
  assert.equal(running.error.text, 'Close the game first.');
  assert.equal(running.info.enabled, true);

  const off = await arabic.set(game, false, { isRunning: async () => false });
  assert.equal(off.error, null);
  assert.equal(off.info.enabled, false);
  assert.deepEqual(await fs.readdir(paks), ['pakchunk0-Windows.pak']);
  assert.deepEqual(await arabic.prepareLaunch(game), { mode: 'off', ok: true });
});

test('anti-cheat games get the overlay, which never touches the game', async () => {
  const arabic = await service({ packs: [nativePack(), overlayPack()] });
  const root = await unrealGame({ 'MyGame/Binaries/Win64/EasyAntiCheat/x.txt': 'x' });
  const game = gameAt(root);
  const info = await arabic.info(game);
  assert.equal(info.mode, 'overlay');
  assert.deepEqual(info.detail.vars, { names: 'Easy Anti-Cheat' });

  await arabic.set(game, true);
  const ready = await arabic.prepareLaunch(game);
  assert.equal(ready.mode, 'overlay');
  assert.equal(ready.ok, true);
  assert.equal(ready.matcher.match('We rnust reach the castle bef0re nightfall')?.arabic, 'يجب أن نصل إلى القلعة قبل حلول الليل.');
  assert.deepEqual(await fs.readdir(path.join(root, 'MyGame/Content/Paks')), ['pakchunk0-Windows.pak']);
});

test('a patch that can\'t go in says why', async () => {
  const arabic = await service({ packs: [nativePack()] });
  const info = await arabic.info(gameAt(await unrealGame({ 'BattlEye/BEClient_x64.dll': 'x' })));
  assert.equal(info.mode, 'unavailable');
  assert.deepEqual(info.why.vars, { names: 'BattlEye' });
});

test('the overlay needs Windows', async () => {
  const arabic = await service({ overlayAvailable: false, packs: [overlayPack()] });
  const info = await arabic.info(gameAt(await tree({ 'game.exe': program() })));
  assert.equal(info.mode, 'unavailable');
  assert.match(info.why.text, /Windows 10/);
});

test('a pack damaged after it was added is caught at Play', async () => {
  const arabic = await service({ packs: [overlayPack()] });
  const game = gameAt(await tree({ 'game.exe': program() }));
  await arabic.set(game, true);
  const [pack] = await arabic.packs.list();
  await fs.writeFile(path.join(pack.dir, 'payload/fingerprints.json'), '{}');
  const ready = await arabic.prepareLaunch(game);
  assert.equal(ready.ok, false);
  assert.match(ready.error.text, /doesn't match/);
});

// ---- The packs library ---------------------------------------------------------------

test('packs are checked when added, and only their listed files are copied', async () => {
  const library = createPackLibrary({ dir: await temp('gs-lib-'), publicKey });
  const source = await overlayPack({ title: 'My Game in Arabic' });
  await fs.writeFile(path.join(source, 'notes.txt'), 'not listed');
  const added = await library.add(source);
  assert.deepEqual(added, { id: 'overlay-pack', version: '1.0.0', engine: 'overlay', title: 'My Game in Arabic', game: { steamAppId: STEAM_ID } });
  const [pack] = await library.list();
  assert.deepEqual((await fs.readdir(pack.dir)).sort(), ['pack.json', 'pack.json.sig', 'payload']);
  assert.equal((await library.forGame({ steamAppId: STEAM_ID })).length, 1);
  assert.equal((await library.forGame({ gameId: 'other' })).length, 0);

  // A newer version replaces it.
  await library.add(await overlayPack({ version: '1.1.0' }));
  assert.deepEqual((await library.list()).map((p) => p.version), ['1.1.0']);
  await library.remove('overlay-pack');
  assert.deepEqual(await library.list(), []);
});

test('unsigned, changed or unbound packs are refused', async () => {
  const library = createPackLibrary({ dir: await temp('gs-lib-'), publicKey });
  const changed = await overlayPack();
  await fs.writeFile(path.join(changed, 'payload/fingerprints.json'), '{"changed":true}');
  await assert.rejects(library.add(changed), /doesn't match/);
  const unsigned = await overlayPack();
  await fs.rm(path.join(unsigned, 'pack.json.sig'));
  await assert.rejects(library.add(unsigned), /isn't signed/);
  await assert.rejects(library.add(await overlayPack({ game: undefined })), /which game/);
  assert.deepEqual(await library.list(), []);
});

test('overlay packs hold only their table, with sane settings', async () => {
  await assert.rejects(packFolder('overlay', { 'payload/evil.dll': 'x' }), /only fingerprints\.json/);
  await assert.rejects(overlayPack({ overlay: { region: [0, 0.9, 1, 0.5] } }), /overlay settings/);
  await assert.rejects(overlayPack({ overlay: { threshold: 0.2 } }), /overlay settings/);
  await assert.rejects(overlayPack({ game: { steamAppId: 'x' } }), /Steam app ID/);
});
