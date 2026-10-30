// Arabic in Capcom RE Engine games: the pack's .pak goes in as the game's next
// numbered patch file, and comes out again without ever leaving a gap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { fingerprint } = require('../desktop/localization/engine');
const { readPack, writePack } = require('../desktop/localization/pack');
const { preflight, createLocalization } = require('../desktop/localization');
const { createArabicService } = require('../desktop/localization/service');
const { createPackLibrary } = require('../desktop/localization/library');
const { patchName, patchNumbers, nextPatch } = require('../desktop/localization/reengine');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const ARABIC_PAK = Buffer.concat([Buffer.from('KPKA'), Buffer.from([4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('arabic messages')]);

function program(size = 512) {
  const b = Buffer.alloc(size);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(0x8664, 0x84);
  return b;
}

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-re-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content ?? 'x');
  }
  return root;
}

// An RE Engine game with official patches 001-003 (as most have after updates).
const reGame = (extra = {}, patches = [1, 2, 3]) => tree({
  're2.exe': program(4096),
  'CrashReport.exe': program(),
  're_chunk_000.pak': 'base game data',
  ...Object.fromEntries(patches.map((n) => [patchName(n), `official patch ${n}`])),
  ...extra,
});

async function rePack(content = ARABIC_PAK, list) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-repack-'));
  await fs.mkdir(path.join(dir, 'payload'));
  await fs.writeFile(path.join(dir, 'payload/re_chunk_000.pak.patch_XXX.pak'), content);
  await writePack(dir, {
    id: 'test-re', version: '1.0.0', engine: 'reengine', game: { steamAppId: 883710 }, privateKey,
    files: list || [{ source: 'payload/re_chunk_000.pak.patch_XXX.pak', target: 're_chunk_000.pak.patch_XXX.pak' }],
  });
  return dir;
}

async function listing(dir) {
  const out = {};
  for (const name of (await fs.readdir(dir)).sort()) out[name] = (await fs.readFile(path.join(dir, name))).toString('latin1');
  return out;
}

const localization = () => createLocalization({ dataDir: require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'gs-state-')) });

test('patch numbers: the next one follows the highest, three digits, and gaps are found', () => {
  assert.deepEqual(patchNumbers(['re_chunk_000.pak', 're_chunk_000.pak.patch_002.pak', 'RE_CHUNK_000.PAK.PATCH_001.PAK',
    're_chunk_000.pak.patch_003.pak.bak', 're_chunk_000.pak.sub_000.pak', 'other.pak']), [1, 2]);
  assert.deepEqual(nextPatch([]), { next: 1, gap: null });
  assert.deepEqual(nextPatch([1, 2, 3]), { next: 4, gap: null });
  assert.deepEqual(nextPatch([0, 1, 2]), { next: 3, gap: null });
  assert.deepEqual(nextPatch([1, 2, 4]), { next: 5, gap: 3 });
  assert.deepEqual(nextPatch([1, 3, 4, 6]), { next: 7, gap: 2 });
  assert.equal(patchName(4), 're_chunk_000.pak.patch_004.pak');
  assert.equal(patchName(10), 're_chunk_000.pak.patch_010.pak');
  assert.equal(patchName(100), 're_chunk_000.pak.patch_100.pak');
});

test('finds RE Engine games, their program and their patch files', async () => {
  const found = await fingerprint(await reGame());
  assert.equal(found.engine, 'reengine');
  assert.match(found.reengine.exe, /re2\.exe$/);
  assert.equal(found.reengine.arch, 'x64');
  assert.deepEqual(found.reengine.patches, [1, 2, 3]);
  assert.equal(found.reengine.next, 4);
  assert.equal(found.reengine.gap, null);
  assert.equal((await fingerprint(await tree({ 'game.exe': program(), 'data.pak': 'x' }))).engine, 'custom');
});

test('RE Engine games get the native tier, unless they\'re played online or their patches skip a number', async () => {
  assert.equal((await preflight(await reGame())).tier, 're-patch');

  const sf6 = await preflight(await reGame(), { steamAppId: 1364780 });
  assert.equal(sf6.tier, 'overlay');
  assert.deepEqual(sf6.why.vars, { name: 'Street Fighter 6' });
  const byProgram = await preflight(await reGame({ 'MonsterHunterRise.exe': program(8192) }));
  assert.equal(byProgram.tier, 'overlay');
  assert.match(byProgram.reason, /Monster Hunter Rise is played online/);

  const gap = await preflight(await reGame({}, [1, 2, 4]));
  assert.equal(gap.tier, 'overlay');
  assert.deepEqual(gap.why.vars, { file: 're_chunk_000.pak.patch_003.pak' });

  const guarded = await preflight(await reGame({ 'EasyAntiCheat/EasyAntiCheat_x64.dll': 'eac' }));
  assert.equal(guarded.tier, 'overlay');
});

test('RE Engine packs hold exactly one .pak, named for GameShelf to number', async () => {
  await readPack(await rePack(), { publicKey });
  await assert.rejects(rePack(ARABIC_PAK, [{ source: 'payload/re_chunk_000.pak.patch_XXX.pak', target: 're_chunk_000.pak.patch_004.pak' }]), /hold one file, re_chunk_000\.pak\.patch_XXX\.pak/);
  await assert.rejects(rePack(ARABIC_PAK, [{ source: 'payload/re_chunk_000.pak.patch_XXX.pak', target: 'natives/stm/message/x.msg.22' }]), /hold one file/);
  await assert.rejects(rePack(ARABIC_PAK, [
    { source: 'payload/re_chunk_000.pak.patch_XXX.pak', target: 're_chunk_000.pak.patch_XXX.pak' },
    { source: 'payload/re_chunk_000.pak.patch_XXX.pak', target: 'dinput8.dll' },
  ]), /isn't allowed/);
});

test('the pack goes in as the next patch number, and comes out leaving the game as it was', async () => {
  const root = await reGame();
  const before = await listing(root);
  const l10n = localization();
  const result = await l10n.enable({ root, packDir: await rePack(), publicKey });
  assert.equal(result.tier, 're-patch');
  const after = await listing(root);
  assert.deepEqual(Object.keys(after).filter((n) => !(n in before)), ['re_chunk_000.pak.patch_004.pak']);
  assert.equal(after['re_chunk_000.pak.patch_004.pak'], ARABIC_PAK.toString('latin1'));
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], `${name} unchanged`);

  // Turned on again: already in, nothing new.
  assert.equal((await l10n.enable({ root, packDir: await rePack(), publicKey })).already, true);
  assert.deepEqual((await l10n.disable({ root })).kept, []);
  assert.deepEqual(await listing(root), before);
});

test('a game with no patch files yet gets patch_001; one with patches from 000 gets the next', async () => {
  const fresh = await reGame({}, []);
  await localization().enable({ root: fresh, packDir: await rePack(), publicKey });
  assert.ok((await fs.readdir(fresh)).includes('re_chunk_000.pak.patch_001.pak'));
  const fromZero = await reGame({}, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await localization().enable({ root: fromZero, packDir: await rePack(), publicKey });
  assert.ok((await fs.readdir(fromZero)).includes('re_chunk_000.pak.patch_010.pak'));
});

test('Arabic\'s patch stays while a newer one follows it, so the game never loses that one', async () => {
  const root = await reGame();
  const l10n = localization();
  await l10n.enable({ root, packDir: await rePack(), publicKey });
  // A mod manager adds a mod after it.
  await fs.writeFile(path.join(root, 're_chunk_000.pak.patch_005.pak'), 'a mod');
  await assert.rejects(l10n.disable({ root }), (err) => err.code === 'chain' && err.details[0].after === 're_chunk_000.pak.patch_005.pak');
  // Nothing was taken out, and Arabic is still recorded as in.
  assert.ok((await fs.readdir(root)).includes('re_chunk_000.pak.patch_004.pak'));
  assert.equal((await l10n.status(root)).status, 'enabled');
  // Once the mod is gone, Arabic comes out.
  await fs.rm(path.join(root, 're_chunk_000.pak.patch_005.pak'));
  assert.deepEqual((await l10n.disable({ root })).kept, []);
  assert.ok(!(await fs.readdir(root)).includes('re_chunk_000.pak.patch_004.pak'));
});

test('a patch file that isn\'t Arabic\'s any more (a game update replaced it) is left alone', async () => {
  const root = await reGame();
  const l10n = localization();
  await l10n.enable({ root, packDir: await rePack(), publicKey });
  await fs.writeFile(path.join(root, 're_chunk_000.pak.patch_004.pak'), 'official patch 4');
  await fs.writeFile(path.join(root, 're_chunk_000.pak.patch_005.pak'), 'official patch 5');
  const off = await l10n.disable({ root });
  assert.equal(off.kept.length, 1);
  assert.match(off.kept[0].why, /changed since GameShelf added it/);
  assert.equal(await fs.readFile(path.join(root, 're_chunk_000.pak.patch_004.pak'), 'utf8'), 'official patch 4');
});

test('a pack whose file isn\'t an RE Engine .pak is refused before anything is added', async () => {
  const root = await reGame();
  const before = await listing(root);
  await assert.rejects(localization().enable({ root, packDir: await rePack(program()), publicKey }), (err) => err.code === 'pack');
  assert.deepEqual(await listing(root), before);
});

test('turning Arabic off while a newer patch follows it says so, and the switch stays on', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-svc-'));
  const root = await reGame();
  const packs = createPackLibrary({ dir: path.join(dataDir, 'localization', 'packs'), publicKey });
  await packs.add(await rePack());
  const service = createArabicService({ dataDir, publicKey, packs, overlayAvailable: false });
  const game = { key: 'steam:883710', dir: root, steamAppId: 883710 };
  assert.equal((await service.info(game)).mode, 'native');
  assert.equal((await service.set(game, true)).error, null);
  assert.equal((await service.prepareLaunch(game)).ok, true);
  assert.ok((await fs.readdir(root)).includes('re_chunk_000.pak.patch_004.pak'));

  await fs.writeFile(path.join(root, 're_chunk_000.pak.patch_005.pak'), 'a mod');
  const off = await service.set(game, false);
  assert.deepEqual(off.error, {
    text: 'Arabic can\'t come out yet: {name} was added to the game after it, and the game would stop loading {name} without it. Take {name} out first.',
    vars: { name: 're_chunk_000.pak.patch_005.pak' },
  });
  assert.equal((await service.info(game)).enabled, true);
  assert.equal((await service.info(game)).staged, true);
});
