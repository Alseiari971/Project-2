// Arabic inside Ren'Py and Godot games: finding them, the packs they take
// (data only), the scripts GameShelf writes, and taking everything out again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { fingerprint } = require('../desktop/localization/engine');
const { readPack, writePack } = require('../desktop/localization/pack');
const { preflight, createLocalization } = require('../desktop/localization');
const renpy = require('../desktop/localization/renpy');
const godot = require('../desktop/localization/godot');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-native-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content ?? 'x');
  }
  return root;
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'));
  }
  return out.sort();
}

// The start of a Godot .pck: "GDPC", the pack format, then the engine version.
function pckHeader(major, minor = 3, patch = 0, format = major >= 4 ? 2 : 1) {
  const b = Buffer.alloc(96);
  b.write('GDPC', 0, 'latin1');
  b.writeUInt32LE(format, 4);
  b.writeUInt32LE(major, 8);
  b.writeUInt32LE(minor, 12);
  b.writeUInt32LE(patch, 16);
  return b;
}

// A Windows program with a .pck added to its end, as Godot's "embed PCK" export does.
function embeddedProgram(major) {
  const exe = Buffer.alloc(512);
  exe.write('MZ', 0, 'latin1');
  const pck = pckHeader(major);
  const tail = Buffer.alloc(12);
  tail.writeBigUInt64LE(BigInt(pck.length), 0);
  tail.write('GDPC', 8, 'latin1');
  return Buffer.concat([exe, pck, tail]);
}

const renpyGame = (extra = {}) => tree({
  'TheQuestion.exe': 'launcher',
  'renpy/vc_version.py': "branch = 'fix'\nversion = '8.3.4.24120703'\nofficial = True\n",
  'lib/py3-windows-x86_64/python.exe': 'python',
  'game/scripts.rpa': 'RPA-3.0 ',
  'game/images.rpa': 'RPA-3.0 ',
  ...extra,
});

const godotGame = (major = 4, extra = {}) => tree({
  'Subtitle Test.exe': 'godot',
  'Subtitle Test.pck': pckHeader(major),
  ...extra,
});

async function makePack(engine, files, details = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
  for (const [source, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, source)), { recursive: true });
    await fs.writeFile(path.join(dir, source), content);
  }
  const list = Object.keys(files).map((source) => ({ source, target: source.replace(/^payload\//, '') }));
  await writePack(dir, { id: `test-${engine}`, version: '1.0.0', engine, files: list, privateKey, ...details });
  return dir;
}

const strings = (data) => JSON.stringify(data);
const renpyPack = () => makePack('renpy', {
  'payload/game/tl/arabic/gameshelf/strings.json': strings({ lines: { 'Hi there! How was class?': 'مرحبًا! كيف كان الدرس؟' }, font: 'Arabic.ttf' }),
  'payload/game/tl/arabic/gameshelf/Arabic.ttf': 'font',
  'payload/game/tl/arabic/gameshelf/OFL.txt': 'license',
});
const godotPack = (details) => makePack('godot', {
  'payload/gameshelf_arabic/strings.json': strings({ lines: { INTRO_1: 'لا تدعهم يرونك.' }, fonts: { regular: 'Arabic.ttf' } }),
  'payload/gameshelf_arabic/Arabic.ttf': 'font',
}, details);

test('finds Ren\'Py games and their version', async () => {
  const root = await renpyGame();
  const found = await fingerprint(root);
  assert.equal(found.engine, 'renpy');
  assert.equal(found.renpy.version, '8.3.4');
  assert.equal(found.renpy.python, 3);
  assert.equal(found.renpy.archives, 2);

  // Older Ren'Py: the version as a tuple in renpy/__init__.py, Python 2.
  const old = await tree({
    'renpy/__init__.py': 'version_tuple = (6, 99, 12, vc_version)\n',
    'game/script.rpyc': 'compiled',
  });
  const oldFound = await fingerprint(old);
  assert.equal(oldFound.renpy.version, '6.99.12');
  assert.equal(oldFound.renpy.python, 2);

  // A renpy folder alone, without scripts, isn't a game.
  assert.equal((await fingerprint(await tree({ 'renpy/x.py': '', 'game/readme.txt': '' }))).engine, 'custom');
});

test('finds Godot games from their .pck, or a .pck inside the program', async () => {
  const found = await fingerprint(await godotGame(4));
  assert.equal(found.engine, 'godot');
  assert.equal(found.godot.version, '4.3.0');
  assert.equal(found.godot.major, 4);
  assert.match(found.godot.pck, /Subtitle Test\.pck$/);

  const embedded = await fingerprint(await tree({ 'Game.exe': embeddedProgram(3) }));
  assert.equal(embedded.engine, 'godot');
  assert.equal(embedded.godot.major, 3);
  assert.equal(embedded.godot.pck, null);

  // A .pck that isn't named after a program, or isn't Godot's, isn't enough.
  assert.equal((await fingerprint(await tree({ 'Game.exe': 'x', 'Other.pck': pckHeader(4) }))).engine, 'custom');
  assert.equal((await fingerprint(await tree({ 'Game.exe': 'x', 'Game.pck': 'not a pack' }))).engine, 'custom');
});

test('Ren\'Py and Godot games get the native tier; Godot games with their own override.cfg don\'t', async () => {
  assert.equal((await preflight(await renpyGame())).tier, 'renpy-tl');
  assert.equal((await preflight(await godotGame(4))).tier, 'godot-override');
  assert.equal((await preflight(await godotGame(3))).tier, 'godot-override');

  const withOverride = await preflight(await godotGame(4, { 'override.cfg': '[display]\n' }));
  assert.equal(withOverride.tier, 'overlay');
  assert.match(withOverride.reason, /override\.cfg/);

  const godot2 = await preflight(await godotGame(2));
  assert.equal(godot2.tier, 'overlay');
  assert.deepEqual(godot2.why, { text: 'GameShelf can\'t add Arabic to games made with Godot {version}.', vars: { version: '2.3.0' } });

  // Anti-cheat still wins.
  const guarded = await preflight(await renpyGame({ 'EasyAntiCheat/EasyAntiCheat_x64.dll': 'eac' }));
  assert.equal(guarded.tier, 'overlay');
});

test('Ren\'Py and Godot packs hold data only, in their own folder', async () => {
  await readPack(await renpyPack(), { publicKey });
  await readPack(await godotPack(), { publicKey });

  const refused = async (engine, files, pattern, details) => {
    await assert.rejects(makePack(engine, files, details), pattern);
  };
  const json = strings({ lines: {} });
  // No code: the scripts are GameShelf's.
  await refused('renpy', { 'payload/game/tl/arabic/gameshelf/strings.json': json, 'payload/game/tl/arabic/gameshelf/hook.rpy': 'init python: pass' }, /may only add strings\.json/);
  await refused('renpy', { 'payload/game/tl/arabic/gameshelf/strings.json': json, 'payload/game/tl/arabic/gameshelf/gameshelf.rpyc': 'x' }, /may only add/);
  await refused('godot', { 'payload/gameshelf_arabic/strings.json': json, 'payload/gameshelf_arabic/arabic.gd': 'extends Node' }, /may only add/);
  // Nowhere else in the game.
  await refused('renpy', { 'payload/game/tl/arabic/gameshelf/strings.json': json, 'payload/game/options.rpy': 'x' }, /may only add/);
  await refused('godot', { 'payload/gameshelf_arabic/strings.json': json, 'payload/override.cfg': 'x' }, /may only add/);
  await refused('godot', { 'payload/gameshelf_arabic/strings.json': json, 'payload/gameshelf_arabic/fonts/a.ttf': 'x' }, /may only add/);
  // strings.json is what the pack is for.
  await refused('renpy', { 'payload/game/tl/arabic/gameshelf/Arabic.ttf': 'font' }, /no strings\.json/);
  await refused('godot', { 'payload/gameshelf_arabic/strings.json': json }, /Godot version/, { requires: { godot: 5 } });
});

test('Ren\'Py: adds the lines, the font and GameShelf\'s script, and takes all of it out again', async () => {
  const root = await renpyGame();
  const before = await listFiles(root);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  const l10n = createLocalization({ dataDir: stateDir });
  const result = await l10n.enable({ root, packDir: await renpyPack(), publicKey });
  assert.equal(result.tier, 'renpy-tl');

  const dir = path.join(root, 'game/tl/arabic/gameshelf');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['Arabic.ttf', 'OFL.txt', 'gameshelf.rpy', 'strings.json']);
  const script = await fs.readFile(path.join(dir, 'gameshelf.rpy'), 'utf8');
  assert.equal(script, renpy.SCRIPT);
  assert.match(script, /config\.say_menu_text_filter = arabic/);
  assert.match(script, /config\.rtl = True/);
  assert.match(script, /previous\(what\)/, 'keeps a filter the game already has');

  // Ren'Py compiles the script when the game starts; that goes too.
  await fs.writeFile(path.join(dir, 'gameshelf.rpyc'), 'compiled');
  const off = await l10n.disable({ root });
  assert.deepEqual(off.kept, []);
  assert.deepEqual(await listFiles(root), before);
  await assert.rejects(fs.stat(path.join(root, 'game/tl')), { code: 'ENOENT' });
});

test('Ren\'Py: a game that already has translations keeps them', async () => {
  const root = await renpyGame({ 'game/tl/french/script.rpy': 'translate french start_1:' });
  const l10n = createLocalization({ dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-')) });
  await l10n.enable({ root, packDir: await renpyPack(), publicKey });
  await l10n.disable({ root });
  assert.deepEqual(await fs.readdir(path.join(root, 'game/tl')), ['french']);
});

test('Godot: override.cfg loads GameShelf\'s script by its full path; turning off removes both', async () => {
  const root = await godotGame(4);
  const before = await listFiles(root);
  const l10n = createLocalization({ dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-')) });
  const result = await l10n.enable({ root, packDir: await godotPack(), publicKey });
  assert.equal(result.tier, 'godot-override');

  const real = await fs.realpath(root);
  const cfg = await fs.readFile(path.join(root, 'override.cfg'), 'utf8');
  const scriptPath = path.join(real, 'gameshelf_arabic', 'arabic.gd').replace(/\\/g, '/');
  assert.match(cfg, /^\[autoload\]$/m);
  assert.ok(cfg.includes(`GameShelfArabic="*${scriptPath}"`), cfg);
  assert.equal(await fs.readFile(path.join(root, 'gameshelf_arabic/arabic.gd'), 'utf8'), godot.hookScript(4));

  const off = await l10n.disable({ root });
  assert.deepEqual(off.kept, []);
  assert.deepEqual(await listFiles(root), before);
});

test('Godot: the script matches the game\'s Godot version, and packs say which one they\'re for', async () => {
  assert.match(godot.hookScript(4), /FontFile\.new\(\)/);
  assert.match(godot.hookScript(4), /TranslationServer\.set_locale\(LOCALE\)/);
  assert.match(godot.hookScript(3), /DynamicFontData\.new\(\)/);
  assert.match(godot.hookScript(3), /File\.new\(\)/);
  assert.equal(godot.hookScript(2), null);
  // Windows paths become Godot's forward slashes; quotes can't break out of the value.
  assert.match(godot.overrideCfg('C:\\Games\\My "Game"\\gameshelf_arabic\\arabic.gd'), /="\*C:\/Games\/My Game\/gameshelf_arabic\/arabic\.gd"/);

  const l10n = createLocalization({ dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-')) });
  // A Godot 3 pack (shaped text) for a Godot 4 game, and the other way round.
  await assert.rejects(l10n.enable({ root: await godotGame(4), packDir: await godotPack({ requires: { godot: 3 } }), publicKey }),
    (err) => err.code === 'mismatch' && /Godot 3 games/.test(err.message));
  await assert.rejects(l10n.enable({ root: await godotGame(3), packDir: await godotPack(), publicKey }),
    (err) => err.code === 'mismatch' && /Godot 4 games/.test(err.message));
  const ok = await l10n.enable({ root: await godotGame(3), packDir: await godotPack({ requires: { godot: 3 } }), publicKey });
  assert.equal(ok.tier, 'godot-override');
});

test('a Ren\'Py pack doesn\'t go into a Godot game', async () => {
  const l10n = createLocalization({ dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-')) });
  await assert.rejects(l10n.enable({ root: await godotGame(4), packDir: await renpyPack(), publicKey }),
    (err) => err.code === 'mismatch' && /Ren'Py games, and this game uses Godot/.test(err.message));
});
