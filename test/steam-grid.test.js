// A pack's Arabic logo in the player's Steam library: put into every account's
// artwork folder, the player's own artwork kept and put back, and the logo
// carried in the pack as a signed file that isn't put into the game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gridFolders, applyLogo, removeLogo } = require('../desktop/localization/steam-grid');
const { writePack, readPack } = require('../desktop/localization/pack');
const { createPackLibrary } = require('../desktop/localization/library');

const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const temp = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

async function steam() {
  const root = await temp('gs-steam-');
  for (const user of ['1001', '2002', 'anonymous', '0']) await fs.mkdir(path.join(root, 'userdata', user, 'config'), { recursive: true });
  return root;
}

test('the Arabic logo goes into every Steam account\'s artwork, and comes out leaving the player\'s own', async (t) => {
  const root = await steam();
  const work = await temp('gs-logo-');
  t.after(() => Promise.all([root, work].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const logo = path.join(work, 'logo.png');
  await fs.writeFile(logo, PNG('arabic logo'));
  const grids = await gridFolders([root, path.join(root, 'missing')]);
  assert.deepEqual(grids.map((g) => path.basename(path.dirname(path.dirname(g)))).sort(), ['1001', '2002']); // real accounts only

  // One account already has the player's own custom logo.
  const mine = path.join(root, 'userdata', '2002', 'config', 'grid');
  await fs.mkdir(mine, { recursive: true });
  await fs.writeFile(path.join(mine, '4115450_logo.png'), PNG('my own artwork'));

  assert.equal(await applyLogo({ roots: [root], appId: 4115450, png: logo }), 2);
  for (const grid of grids) assert.deepEqual(await fs.readFile(path.join(grid, '4115450_logo.png')), PNG('arabic logo'));
  assert.equal(await applyLogo({ roots: [root], appId: 4115450, png: logo }), 2); // again: nothing changes
  assert.deepEqual(await fs.readFile(path.join(mine, '4115450_logo.png.gameshelf-backup')), PNG('my own artwork'));

  // In the first account the player then picks other artwork: that's theirs, and stays.
  const other = path.join(root, 'userdata', '1001', 'config', 'grid');
  await fs.writeFile(path.join(other, '4115450_logo.png'), PNG('picked later'));
  assert.equal(await removeLogo({ roots: [root], appId: 4115450 }), 1);
  assert.deepEqual(await fs.readFile(path.join(other, '4115450_logo.png')), PNG('picked later'));
  assert.deepEqual(await fs.readFile(path.join(mine, '4115450_logo.png')), PNG('my own artwork')); // put back
  assert.deepEqual((await fs.readdir(mine)).sort(), ['4115450_logo.png']); // nothing of GameShelf's left
  assert.equal(await removeLogo({ roots: [root], appId: 4115450 }), 0);

  await fs.writeFile(logo, 'not a picture');
  await assert.rejects(applyLogo({ roots: [root], appId: 4115450, png: logo }), /PNG/);
  await assert.rejects(applyLogo({ roots: [root], appId: 'x', png: logo }), /number/);
});

test('a pack carries its Steam logo as a signed file that isn\'t put into the game', async (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const dir = await temp('gs-pack-');
  const lib = await temp('gs-lib-');
  t.after(() => Promise.all([dir, lib].map((d) => fs.rm(d, { recursive: true, force: true }))));
  await fs.mkdir(path.join(dir, 'payload'));
  await fs.mkdir(path.join(dir, 'steam'));
  await fs.writeFile(path.join(dir, 'payload', 'pakchunk99-ArabicLocalization_P.pak'), 'pak');
  await fs.writeFile(path.join(dir, 'steam', 'logo.png'), PNG('arabic logo'));
  const manifest = await writePack(dir, {
    id: 'blade-ar', version: '1.0.0', engine: 'unreal', game: { steamAppId: 4115450 }, privateKey, steamLogo: 'steam/logo.png',
    files: [{ source: 'payload/pakchunk99-ArabicLocalization_P.pak', target: 'pakchunk99-ArabicLocalization_P.pak' }],
  });
  assert.equal(manifest.steamLogo.source, 'steam/logo.png');
  assert.equal(manifest.files.length, 1); // the logo isn't one of the game's files
  const pack = await readPack(dir, { publicKey });
  assert.deepEqual(await fs.readFile(pack.steamLogo), PNG('arabic logo'));

  // Added to this PC's packs, the logo comes along, still checked.
  const library = createPackLibrary({ dir: lib, publicKey });
  await library.add(dir);
  assert.deepEqual(await fs.readFile((await library.verify('blade-ar')).steamLogo), PNG('arabic logo'));

  // A swapped logo is a changed pack.
  await fs.writeFile(path.join(dir, 'steam', 'logo.png'), PNG('something else'));
  await assert.rejects(readPack(dir, { publicKey }), /Steam logo doesn't match/);
});
