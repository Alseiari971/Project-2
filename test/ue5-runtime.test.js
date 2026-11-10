// UE5 IoStore packs and the native runtime adapter, in the app: reading what a
// program imports, which tier a game gets, the packs' rules, adding and
// removing a UE5 patch's .pak/.utoc/.ucas together and the runtime adapter
// with its settings, the adapter only ever being the library this copy of
// GameShelf ships, never going into games played with others, and the whole
// flow from "Request Arabic subtitles" to the adapter's table, the lines it
// sees in the game, and "Translate new lines".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writePack } = require('../desktop/localization/pack');
const { peImports } = require('../desktop/localization/pe');
const { fingerprint } = require('../desktop/localization/engine');
const { preflight, createLocalization, runtimeFolder, runtimeSettings } = require('../desktop/localization/index');
const { playedAlone, createArabicRequests } = require('../desktop/localization/requests');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const { createSubmissions } = require('../src/submissions');
const { createCloudClient } = require('../desktop/cloud');
const { createArabicOnline } = require('../desktop/localization/online');
const { createArabicService } = require('../desktop/localization/service');
const { createPackBuilder, findBuilder, localPackKey } = require('../desktop/localization/builder');

const REPO = path.join(__dirname, '..');
const PREBUILT = path.join(REPO, 'localization', 'runtime', 'prebuilt');
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * A small but real PE file: headers, one section holding an import table and a
 * delay-load table ({ library: [function names] }), for 64-bit (PE32+) or 32-bit (PE32).
 */
function fakePe({ machine = 0x8664, imports = {}, delayed = {} } = {}) {
  const plus = machine !== 0x14c;
  const width = plus ? 8 : 4;
  const optionalSize = plus ? 240 : 224;
  const sectionRva = 0x1000;
  const rawStart = 0x200;
  const body = [];
  let size = 0;
  const put = (buffer) => {
    const at = size;
    body.push(buffer);
    size += buffer.length;
    return sectionRva + at;
  };
  const libraries = [...Object.entries(imports).map(([l, f]) => [l, f, false]), ...Object.entries(delayed).map(([l, f]) => [l, f, true])];
  // Names and thunks first, then the descriptor tables that point at them.
  const placed = libraries.map(([library, functions, late]) => {
    const nameRva = put(Buffer.from(`${library}\0`, 'latin1'));
    const hints = functions.map((f) => put(Buffer.concat([Buffer.alloc(2), Buffer.from(`${f}\0`, 'latin1')])));
    const thunks = Buffer.alloc((hints.length + 1) * width);
    hints.forEach((rva, i) => (plus ? thunks.writeBigUInt64LE(BigInt(rva), i * width) : thunks.writeUInt32LE(rva, i * width)));
    const names = put(thunks);
    const table = put(Buffer.from(thunks));
    return { nameRva, names, table, late };
  });
  const normal = placed.filter((p) => !p.late);
  const importTable = Buffer.alloc((normal.length + 1) * 20);
  normal.forEach((p, i) => {
    importTable.writeUInt32LE(p.names, i * 20);
    importTable.writeUInt32LE(p.nameRva, i * 20 + 12);
    importTable.writeUInt32LE(p.table, i * 20 + 16);
  });
  const importRva = put(importTable);
  const late = placed.filter((p) => p.late);
  const delayTable = Buffer.alloc((late.length + 1) * 32);
  late.forEach((p, i) => {
    delayTable.writeUInt32LE(1, i * 32);
    delayTable.writeUInt32LE(p.nameRva, i * 32 + 4);
    delayTable.writeUInt32LE(p.table, i * 32 + 12);
    delayTable.writeUInt32LE(p.names, i * 32 + 16);
  });
  const delayRva = late.length ? put(delayTable) : 0;
  const section = Buffer.concat(body);
  const head = Buffer.alloc(rawStart);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(0x40, 0x3c);
  head.write('PE\0\0', 0x40, 'latin1');
  head.writeUInt16LE(machine, 0x44);
  head.writeUInt16LE(1, 0x46);
  head.writeUInt16LE(optionalSize, 0x40 + 20);
  const optional = 0x58;
  head.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  if (plus) head.writeBigUInt64LE(0x140000000n, optional + 24);
  else head.writeUInt32LE(0x400000, optional + 28);
  const directories = optional + (plus ? 112 : 96);
  head.writeUInt32LE(importRva, directories + 8);
  head.writeUInt32LE(importTable.length, directories + 12);
  if (delayRva) {
    head.writeUInt32LE(delayRva, directories + 13 * 8);
    head.writeUInt32LE(delayTable.length, directories + 13 * 8 + 4);
  }
  const sections = optional + optionalSize;
  head.write('.idata', sections, 'latin1');
  head.writeUInt32LE(section.length, sections + 8);
  head.writeUInt32LE(sectionRva, sections + 12);
  head.writeUInt32LE(section.length, sections + 16);
  head.writeUInt32LE(rawStart, sections + 20);
  return Buffer.concat([head, section]);
}

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-runtime-'));
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

const textGame = (extra = {}) => ({
  'Game.exe': fakePe({ imports: { 'kernel32.dll': ['CreateFileW'], 'version.dll': ['GetFileVersionInfoSizeW'] }, delayed: { 'gdi32.dll': ['ExtTextOutW', 'SelectObject'] } }),
  'engine.dll': fakePe({ imports: { 'dwrite.dll': ['DWriteCreateFactory'], 'user32.dll': ['DrawTextW'] } }),
  'data/ui.dat': 'x',
  ...extra,
});

// ---- Reading imports ---------------------------------------------------------------

test('a program\'s imports and delay-loaded imports are read from its tables', async () => {
  const dir = await tree({ 'a.exe': fakePe({ imports: { 'KERNEL32.dll': ['CreateFileW', 'ReadFile'] }, delayed: { 'dwrite.dll': ['DWriteCreateFactory'] } }),
    'b.exe': fakePe({ machine: 0x14c, imports: { 'gdi32.dll': ['TextOutW'] } }), 'c.txt': 'not a program' });
  assert.deepEqual(await peImports(path.join(dir, 'a.exe')), { arch: 'x64', imports: { 'kernel32.dll': ['CreateFileW', 'ReadFile'] }, delayed: { 'dwrite.dll': ['DWriteCreateFactory'] } });
  assert.deepEqual(await peImports(path.join(dir, 'b.exe')), { arch: 'x86', imports: { 'gdi32.dll': ['TextOutW'] }, delayed: {} });
  assert.equal(await peImports(path.join(dir, 'c.txt')), null);
  // The adapter itself, as the linker made it: it uses only kernel32 and the C runtime.
  const adapter = await peImports(path.join(PREBUILT, 'version.dll'));
  assert.deepEqual(Object.keys(adapter.imports).sort(), ['kernel32.dll', 'msvcrt.dll']);
  assert.ok(adapter.imports['kernel32.dll'].includes('CreateToolhelp32Snapshot'));
});

// ---- Which tier ----------------------------------------------------------------------

test('custom engines whose text goes through Windows\' text functions get the runtime adapter', async () => {
  const game = await tree(textGame());
  const check = await preflight(game);
  assert.equal(check.tier, 'native-runtime');
  assert.deepEqual(check.engine.custom.runtime.textApis, ['ExtTextOutW', 'DrawTextW', 'DWriteCreateFactory']);
  assert.equal(check.engine.custom.runtime.proxy, 'version.dll');

  const reasons = async (files) => (await preflight(await tree(files))).adapter.why;
  assert.match(await reasons(textGame({ 'Game.exe': fakePe({ machine: 0x14c, imports: { 'version.dll': ['VerQueryValueW'], 'gdi32.dll': ['ExtTextOutW'] } }) })), /64-bit/);
  assert.match(await reasons({ 'Game.exe': fakePe({ imports: { 'version.dll': ['VerQueryValueW'], 'd3d11.dll': ['D3D11CreateDevice'] } }) }), /doesn't draw its text with Windows/);
  assert.match(await reasons({ 'Game.exe': fakePe({ imports: { 'gdi32.dll': ['ExtTextOutW'] } }) }), /doesn't load a Windows library/);
  assert.match(await reasons(textGame({ 'version.dll': 'another mod' })), /already has a version\.dll/);
  // A game that loads dinput8.dll gets the adapter as that, when version.dll isn't loaded.
  const dinput = await preflight(await tree({ 'Game.exe': fakePe({ imports: { 'dinput8.dll': ['DirectInput8Create'], 'user32.dll': ['DrawTextExW'] } }) }));
  assert.deepEqual([dinput.tier, dinput.engine.custom.runtime.proxy], ['native-runtime', 'dinput8.dll']);
  // Readable text files still come first, and anti-cheat still means the overlay.
  assert.equal((await preflight(await tree(textGame({ 'lang/en.json': '{}' })))).tier, 'loose-files');
  assert.equal((await preflight(await tree(textGame({ 'EasyAntiCheat/x.txt': 'x' })))).tier, 'overlay');
});

test('games drawing their own text on Direct3D 11 get the adapter\'s canvas; Direct3D 12 ones are told why not', async () => {
  const gpuGame = (imports) => ({
    'Game.exe': fakePe({ imports: { 'version.dll': ['GetFileVersionInfoSizeW'], 'kernel32.dll': ['MultiByteToWideChar'], ...imports } }),
    'freetype.dll': fakePe({ imports: { 'kernel32.dll': ['CreateFileW'] } }),
  });
  const check = await preflight(await tree(gpuGame({ 'd3d11.dll': ['D3D11CreateDevice'], 'api-ms-win-crt-stdio-l1-1-0.dll': ['__stdio_common_vswprintf'] })));
  assert.equal(check.tier, 'native-runtime');
  assert.equal(check.adapter.mode, 'canvas');
  const runtime = check.engine.custom.runtime;
  assert.deepEqual([runtime.textApis, runtime.buffers, runtime.d3d11, runtime.freetype], [[], ['MultiByteToWideChar', '__stdio_common_vswprintf'], true, true]);
  // Windows' text functions mean the strings themselves are swapped.
  assert.equal((await preflight(await tree(textGame()))).adapter.mode, 'text');
  const dx12 = await preflight(await tree(gpuGame({ 'd3d12.dll': ['D3D12CreateDevice'] })));
  assert.match(dx12.adapter.why, /Direct3D 12/);
});

test('the adapter\'s settings say how it runs: swapping strings, or drawing on the game\'s frames', () => {
  const lines = (text) => Object.fromEntries(text.split('\r\n').filter((l) => l.includes('=') && !l.startsWith(';')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const text = lines(runtimeSettings({ exe: 'Game.exe', root: 'C:\\Games\\Lantern', folder: 'C:\\data' }));
  assert.deepEqual([text.buffers, text.swap, text.canvas, text.canvas_region], ['1', '1', '0', undefined]);
  const canvas = lines(runtimeSettings({ exe: 'Game.exe', root: 'C:\\G', folder: 'C:\\d', mode: 'canvas', region: [0, 0.8, 1, 0.2] }));
  assert.deepEqual([canvas.buffers, canvas.swap, canvas.canvas, canvas.canvas_region], ['1', '0', '1', '0,0.8,1,0.2']);
  // A region that isn't one falls back to the bottom of the frame.
  assert.equal(lines(runtimeSettings({ exe: 'G.exe', root: 'r', folder: 'f', mode: 'canvas', region: [0, 2, 'x'] })).canvas_region, '0.08,0.76,0.84,0.2');
});

test('UE5 containers are checked for encryption from their header', async () => {
  const header = (flags) => {
    const head = Buffer.alloc(144);
    head.write('-==--==--==--==-', 0, 'latin1');
    head[16] = 8;
    head[80] = flags;
    return head;
  };
  const game = await tree({
    'Engine/Binaries/x.txt': 'x',
    'Blade/Content/Paks/pakchunk0-Windows.pak': 'pak', 'Blade/Content/Paks/pakchunk0-Windows.utoc': header(8 | 2), 'Blade/Content/Paks/pakchunk0-Windows.ucas': 'x',
    'Blade/Content/Paks/pakchunk1-Windows.pak': 'pak', 'Blade/Content/Paks/pakchunk1-Windows.utoc': header(8), 'Blade/Content/Paks/pakchunk1-Windows.ucas': 'x',
    'Blade/Content/Paks/global.utoc': header(8),
  });
  const found = await fingerprint(game);
  assert.equal(found.engine, 'unreal');
  assert.deepEqual([found.unreal.ioStore, found.unreal.containers, found.unreal.encryptedContainers], [true, 3, 1]);
});

// ---- Pack rules -------------------------------------------------------------------------

test('runtime packs hold one adapter library and its data; UE5 containers come whole', async () => {
  await makePack('runtime', { 'version.dll': 'lib', 'gameshelf_arabic/gameshelf_strings.bin': 'GSAR', 'gameshelf_arabic/IBMPlexSansArabic-Regular.ttf': 'f' });
  const bad = (engine, files) => makePack(engine, files);
  await assert.rejects(bad('runtime', { 'winhttp.dll': 'lib', 'gameshelf_arabic/gameshelf_strings.bin': 'x' }), /runtime packs hold the adapter/);
  await assert.rejects(bad('runtime', { 'version.dll': 'a', 'dinput8.dll': 'b', 'gameshelf_arabic/gameshelf_strings.bin': 'x' }), /one adapter library/);
  await assert.rejects(bad('runtime', { 'version.dll': 'a' }), /gameshelf_strings\.bin/);
  await assert.rejects(bad('runtime', { 'version.dll': 'a', 'gameshelf_arabic/gameshelf_strings.bin': 'x', 'gameshelf_arabic/gameshelf_runtime.ini': 'x' }), /isn't allowed/);
  await assert.rejects(bad('runtime', { 'version.dll': 'a', 'gameshelf_arabic/gameshelf_strings.bin': 'x', 'gameshelf_arabic/hook.dll': 'x' }), /isn't allowed/);
  await makePack('unreal', { 'pakchunk99-ArabicLocalization_P.pak': 'p', 'pakchunk99-ArabicLocalization_P.utoc': 't', 'pakchunk99-ArabicLocalization_P.ucas': 'c' });
  await assert.rejects(bad('unreal', { 'pakchunk99-ArabicLocalization_P.pak': 'p', 'pakchunk99-ArabicLocalization_P.utoc': 't' }), /needs its \.utoc, \.ucas and \.pak together/);
});

// ---- Adding and removing ------------------------------------------------------------------

test('a UE5 patch\'s .pak, .utoc and .ucas go in together and come out together', async (t) => {
  const game = await tree({ 'Engine/x.txt': 'x', 'Blade/Content/Paks/pakchunk0-Windows.pak': 'pak', 'Blade/Content/Paks/pakchunk0-Windows.utoc': 'toc' });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const pack = await makePack('unreal', { 'pakchunk99-ArabicLocalization_P.pak': 'p', 'pakchunk99-ArabicLocalization_P.utoc': 't', 'pakchunk99-ArabicLocalization_P.ucas': 'c' });
  const localization = createLocalization({ dataDir: data });
  await localization.enable({ root: game, packDir: pack, publicKey: PUBLIC });
  const paks = path.join(game, 'Blade', 'Content', 'Paks');
  // In Content/Paks/~mods, apart from the game's own.
  assert.deepEqual((await fs.readdir(path.join(paks, '~mods'))).sort(),
    ['pakchunk99-ArabicLocalization_P.pak', 'pakchunk99-ArabicLocalization_P.ucas', 'pakchunk99-ArabicLocalization_P.utoc']);
  assert.deepEqual((await localization.disable({ root: game })).kept, []);
  assert.deepEqual((await fs.readdir(paks)).sort(), ['pakchunk0-Windows.pak', 'pakchunk0-Windows.utoc']);

  // A ~mods folder the player already had stays, with their mods in it.
  await fs.mkdir(path.join(paks, '~mods'));
  await fs.writeFile(path.join(paks, '~mods', 'Their_Mod_P.pak'), 'mod');
  await localization.enable({ root: game, packDir: pack, publicKey: PUBLIC });
  await localization.disable({ root: game });
  assert.deepEqual(await fs.readdir(path.join(paks, '~mods')), ['Their_Mod_P.pak']);
});

test('a game\'s Arabic swaps from one pack to another of a different id (the app\'s own build, then Pack Studio\'s)', async (t) => {
  const game = await tree({ 'Engine/x.txt': 'x', 'Blade/Content/Paks/pakchunk0-Windows.pak': 'pak', 'Blade/Content/Paks/pakchunk0-Windows.utoc': 'toc' });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const files = (tag) => ({ 'pakchunk99-ArabicLocalization_P.pak': `pak ${tag}`, 'pakchunk99-ArabicLocalization_P.utoc': `toc ${tag}`, 'pakchunk99-ArabicLocalization_P.ucas': `cas ${tag}` });
  const auto = await makePack('unreal', files('auto'), { id: 'gameshelf-steam-42-ar', version: '1.0.4' });
  const studio = await makePack('unreal', files('studio'), { id: 'blade-ar', version: '1.1.0' });
  const localization = createLocalization({ dataDir: data });
  await localization.enable({ root: game, packDir: auto, publicKey: PUBLIC });
  const mods = path.join(game, 'Blade', 'Content', 'Paks', '~mods');
  assert.equal(await fs.readFile(path.join(mods, 'pakchunk99-ArabicLocalization_P.pak'), 'utf8'), 'pak auto');
  // The other pack takes its place, instead of "An earlier version is still in this game".
  await localization.enable({ root: game, packDir: studio, publicKey: PUBLIC });
  for (const [name, content] of Object.entries(files('studio'))) assert.equal(await fs.readFile(path.join(mods, name), 'utf8'), content);
  assert.equal((await localization.status(game)).pack.id, 'blade-ar');
  assert.deepEqual((await localization.disable({ root: game })).kept, []);
});

test('the runtime adapter goes in with its settings, only as the library GameShelf ships, and comes out cleanly', async (t) => {
  const game = await tree(textGame());
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const library = await fs.readFile(path.join(PREBUILT, 'version.dll'));
  const pack = await makePack('runtime', { 'version.dll': library, 'gameshelf_arabic/gameshelf_strings.bin': 'GSAR', 'gameshelf_arabic/IBMPlexSansArabic-Regular.ttf': 'font' });

  // Without the shipped library's hash, or with another one, nothing goes in.
  await assert.rejects(createLocalization({ dataDir: data }).enable({ root: game, packDir: pack, publicKey: PUBLIC }), /isn't the one this copy of GameShelf ships/);
  await assert.rejects(createLocalization({ dataDir: data, runtimeHooks: { 'version.dll': sha('other') } }).enable({ root: game, packDir: pack, publicKey: PUBLIC }), /isn't the one/);
  assert.equal(await fs.stat(path.join(game, 'version.dll')).catch(() => null), null);

  const localization = createLocalization({ dataDir: data, runtimeHooks: { 'version.dll': sha(library) } });
  assert.equal((await localization.enable({ root: game, packDir: pack, publicKey: PUBLIC })).tier, 'native-runtime');
  assert.deepEqual(await fs.readFile(path.join(game, 'version.dll')), library);
  const settings = await fs.readFile(path.join(game, 'gameshelf_arabic', 'gameshelf_runtime.ini'), 'utf8');
  const folder = runtimeFolder(data, game);
  assert.match(settings, /^exe=Game\.exe\r$/m);
  assert.match(settings, /^strings=gameshelf_arabic\\gameshelf_strings\.bin\r$/m);
  assert.match(settings, /^font=gameshelf_arabic\\IBMPlexSansArabic-Regular\.ttf\r$/m);
  assert.ok(settings.includes(`dump=${path.join(folder, 'untranslated.txt')}\r\n`));
  assert.ok((await fs.stat(folder)).isDirectory(), 'the adapter\'s folder is outside the game, ready before it runs');
  // Arabic on: the version.dll is GameShelf's own, so the game still counts as one for the adapter.
  assert.equal((await preflight(game, { ownMods: true })).tier, 'native-runtime');

  assert.deepEqual((await localization.disable({ root: game })).kept, []);
  assert.equal(await fs.stat(path.join(game, 'version.dll')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(game, 'gameshelf_arabic')).catch(() => null), null);
});

test('a runtime pack for the other library is refused', async (t) => {
  const game = await tree(textGame());
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const library = await fs.readFile(path.join(PREBUILT, 'dinput8.dll'));
  const pack = await makePack('runtime', { 'dinput8.dll': library, 'gameshelf_arabic/gameshelf_strings.bin': 'GSAR' });
  const localization = createLocalization({ dataDir: data, runtimeHooks: { 'dinput8.dll': sha(library) } });
  await assert.rejects(localization.enable({ root: game, packDir: pack, publicKey: PUBLIC }), /stands in for dinput8\.dll, and this game loads version\.dll/);
});

// ---- Played alone --------------------------------------------------------------------------

test('the runtime adapter goes into Steam, Epic, GOG and other games alike, but never online-only or VAC games', async () => {
  const online = (features) => ({ features: async () => features });
  // Played alone, or alone and online: the folder's anti-cheat scan already passed.
  for (const features of [['Single-player', 'Steam Achievements'], ['Single-player', 'Online Co-op'], ['Single-player', 'Shared/Split Screen'], ['Steam Cloud']]) {
    assert.equal((await playedAlone(online(features), { steamAppId: 1 })).ok, true, features.join());
  }
  // Only online.
  for (const features of [['Multi-player'], ['Online PvP', 'MMO'], ['Online Co-op']]) {
    assert.match((await playedAlone(online(features), { steamAppId: 1 })).why, /only played online/, features.join());
  }
  assert.match((await playedAlone(online(['Single-player', 'Valve Anti-Cheat enabled']), { steamAppId: 1 })).why, /Valve Anti-Cheat/);
  // Epic, GOG or a folder: nothing to ask, so the folder scan is the check; a store page that can't be had is the same.
  assert.deepEqual(await playedAlone(online(['Multi-player']), { gameId: 'x' }), { ok: true, why: null, checked: false });
  assert.deepEqual(await playedAlone(online(null), { steamAppId: 1 }), { ok: true, why: null, checked: false });
  // Anti-cheat in the folder still keeps the adapter out (no tier but the overlay is picked).
  assert.equal((await preflight(await tree(textGame({ 'BattlEye/BEClient_x64.dll': 'be' })))).tier, 'overlay');
});

// ---- The whole flow -----------------------------------------------------------------------

test('request, the adapter\'s table from the game\'s own data, lines seen in play, and "Translate new lines"',
  { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-runtime-flow-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const fetchAi = async (_url, init) => {
      const user = JSON.parse(init.body).messages[1].content;
      const translations = JSON.parse(user.slice(user.indexOf('['))).map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
    };
    const features = { 4242: ['Single-player', 'Steam Achievements'], 4343: ['Online PvP', 'Online Co-op'] };
    const steamStore = { details: async (id) => (features[id] ? { features: features[id] } : null) };
    const db = openDatabase(':memory:');
    const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch: fetchAi });
    const server = createApp({ db, games: createLocalProvider(), translations, dataDir: tmp, steamStore, arabicGames: createArabicGames({ db, translations }),
      submissions: createSubmissions({ db, translations, publicKeys: [PUBLIC] }) }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'correct horse', email: 'alice@test.example', nationality: 'AE' }) });
    const cloud = createCloudClient({ server: () => base, session: async () => /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1] });
    assert.deepEqual(await (await fetch(`${base}/api/steam/4242/features`)).json(), { features: ['Single-player', 'Steam Achievements'] });

    const online = createArabicOnline({ cloud, cacheDir: path.join(tmp, 'dl'), publicKeys: [PUBLIC] });
    const localKey = localPackKey(path.join(tmp, 'player'));
    const paths = findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python } });
    assert.equal(paths.runtimeHook, PREBUILT);
    const packBuilder = createPackBuilder({ paths: { ...paths, msgTool: null }, outDir: path.join(tmp, 'builds'), keyFile: localKey.keyFile });
    const runtimeHooks = { 'version.dll': sha(await fs.readFile(path.join(PREBUILT, 'version.dll'))) };
    const arabic = createArabicService({
      dataDir: path.join(tmp, 'player'), publicKey: [PUBLIC, localKey.publicKey], overlayAvailable: false, catalog: online.catalog, runtimeHooks,
      builder: { canBuild: (tier, engine) => packBuilder.canBuild(tier, engine), fromSet: async () => null },
    });
    const requests = createArabicRequests({ arabic, packBuilder, online, server: () => base, overlayAvailable: false });

    // A game made with its own engine: no readable text files, but English in a data file, drawn with DirectWrite.
    const dir = path.join(tmp, 'Lantern');
    await fs.mkdir(path.join(dir, 'data'), { recursive: true });
    for (const [name, content] of Object.entries(textGame())) {
      if (name.includes('/')) continue;
      await fs.writeFile(path.join(dir, name), content);
    }
    await fs.writeFile(path.join(dir, 'data', 'ui.dat'), Buffer.concat([Buffer.from([0x80, 0x81, 0x82, 0]),
      Buffer.from('Press any key to start\0The lantern flickers once more.\0'), Buffer.from('Where are you going, stranger?', 'utf16le'), Buffer.alloc(2)]));
    const game = { key: 'steam:4242', dir, steamAppId: 4242, gameId: null, title: 'Lantern' };

    const first = await requests.run(game, { consent: true });
    assert.equal(first.done, true, JSON.stringify(first.error || first));
    assert.equal(first.submitted?.total, 3);
    const launch = await arabic.prepareLaunch(game);
    assert.deepEqual([launch.mode, launch.ok], ['native', true], JSON.stringify(launch.error));
    assert.deepEqual(await fs.readFile(path.join(dir, 'version.dll')), await fs.readFile(path.join(PREBUILT, 'version.dll')));
    const table = path.join(dir, 'gameshelf_arabic', 'gameshelf_strings.bin');
    const lookup = (text) => spawnSync(python, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from arabic_compiler import runtime; '
      + 'print(runtime.lookup(runtime.read_table(open(sys.argv[2], "rb").read()), sys.argv[3]) or "-")', path.join(REPO, 'localization'), table, text], { encoding: 'utf8' }).stdout.trim();
    assert.equal(lookup('Where are you going, stranger?'), 'عربي Where are you going, stranger?');
    assert.equal(lookup('The lantern flickers once more.'), 'عربي The lantern flickers once more.');

    // The adapter notes what it drew without Arabic (as gs_hook.c writes it) and how the session went.
    const folder = arabic.localization.runtimeFolder(dir);
    await fs.writeFile(path.join(folder, 'untranslated.txt'), 'The gate opens at dawn\nTwo\\nlines here\n');
    await fs.writeFile(path.join(folder, 'status.txt'), 'calls=120\ntranslated=80\nmissed=2\nentries=3\n');
    const playing = await arabic.info(game);
    assert.deepEqual([playing.mode, playing.runtime.newLines, playing.runtime.lastSession.translated], ['native', 2, 80]);

    // "Translate new lines": the same flow, with what the adapter saw.
    const again = await requests.run(game, { consent: true });
    assert.equal(again.done, true, JSON.stringify(again.error || again));
    const relaunch = await arabic.prepareLaunch(game);
    assert.deepEqual([relaunch.mode, relaunch.ok], ['native', true], JSON.stringify(relaunch));
    assert.equal(lookup('The gate opens at dawn'), 'عربي The gate opens at dawn');
    assert.equal(lookup('Two\nlines here'), 'عربي Two\nlines here');
    assert.equal((await arabic.info(game)).runtime.newLines, 0);
    assert.ok(await fs.stat(path.join(folder, 'untranslated.sent.txt')));

    // Turning it off takes the adapter out.
    assert.equal((await arabic.set(game, false)).error, null);
    assert.equal(await fs.stat(path.join(dir, 'version.dll')).catch(() => null), null);

    // A game Steam lists as online-only never gets the adapter: the request goes to the admins instead.
    const coop = path.join(tmp, 'Coop');
    await fs.cp(dir, coop, { recursive: true });
    const blocked = await requests.run({ key: 'steam:4343', dir: coop, steamAppId: 4343, gameId: null, title: 'Coop' }, { consent: true });
    assert.equal(blocked.requested, true);
    assert.match(blocked.reason, /only played online/);
    assert.equal(await fs.stat(path.join(coop, 'version.dll')).catch(() => null), null);

    // A GOG or Epic copy (no Steam app ID) gets it, the anti-cheat scan having found nothing.
    const gog = path.join(tmp, 'LanternGOG');
    await fs.cp(dir, gog, { recursive: true });
    await fs.rm(path.join(gog, 'gameshelf_arabic'), { recursive: true, force: true });
    const fromGog = await requests.run({ key: 'game:lantern', dir: gog, steamAppId: null, gameId: 'lantern', title: 'Lantern' }, { consent: true });
    assert.equal(fromGog.done, true, JSON.stringify(fromGog.error || fromGog));
    const gogGame = { key: 'game:lantern', dir: gog, steamAppId: null, gameId: 'lantern', title: 'Lantern' };
    assert.deepEqual(await arabic.prepareLaunch(gogGame).then((l) => [l.mode, l.ok]), ['native', true]);
    assert.deepEqual(await fs.readFile(path.join(gog, 'version.dll')), await fs.readFile(path.join(PREBUILT, 'version.dll')));
  });
