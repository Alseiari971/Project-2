// Localization packs: the files GameShelf adds to a game to show it in Arabic.
// A pack is a folder with pack.json (what goes where, with each file's SHA-256),
// pack.json.sig (an Ed25519 signature of pack.json by GameShelf's pack key) and
// the files themselves. Packs can put a DLL into a game's folder, so only
// signed packs are used, and every file must match its hash before it's copied.
//
//   {
//     "format": 1, "id": "some-game-ar", "version": "1.0.0", "language": "ar",
//     "title": "Some Game in Arabic",           (optional, shown in App settings)
//     "engine": "unreal" | "unity" | "reengine" | "renpy" | "godot" | "bethesda" | "loose" | "custom" | "runtime" | "overlay",
//     "game": { "steamAppId": 1245620, "gameId": "elden-ring" },   (which game it's for)
//     "overlay": { "region": [0, 0.78, 1, 0.22], "textLuma": 170, "darkText": false, "threshold": 0.72 },
//     "requires": { "arch": "x64", "unityBackend": "mono", "unityVersion": "2019.4", "godot": 4 },
//     "fontBundle": "gameshelf_arabic_sdf",      (Unity: TextMeshPro font, in the game folder)
//     "uguiFont": "Arial",                       (Unity: optional font for older UI text)
//     "fontStyle": "plex" | "cairo" | "naskh" | "custom",   (the Arabic font the pack was made with)
//     "files": [{ "source": "payload/x.pak", "target": "pakchunk99-ArabicLocalization_P.pak",
//                 "sha256": "...", "size": 123 }]
//   }
//
// Targets are relative to the game's Content/Paks folder (Unreal), the game's
// folder (Unity, Ren'Py) or the folder of the game's program (Godot), and
// only these may be added:
// - Unreal: .pak/.utoc/.ucas files whose name ends in _P (patch files, loaded
//   after the game's own, so they win without replacing anything). A .utoc
//   (a UE5 IoStore container) comes with its .ucas and a .pak of the same name.
// - Unity: BepInEx/ and dotnet/ (the mod loader), doorstop's files and the font
//   bundle. The XUnity.AutoTranslator settings are written by GameShelf itself.
// - RE Engine: a single .pak, re_chunk_000.pak.patch_XXX.pak; GameShelf puts
//   in the next free number when it adds it (see reengine.js).
// - Ren'Py: strings.json, fonts (.ttf, .otf) and license texts (.txt) in
//   game/tl/arabic/gameshelf; Godot: the same in gameshelf_arabic. Data only:
//   the scripts that read them are GameShelf's own (renpy.js, godot.js).
// - Bethesda (Skyrim Special Edition, Fallout 4, Starfield): string tables in
//   Data/Strings (<plugin>_<language>.strings, .dlstrings, .ilstrings),
//   Data/Interface/fontconfig.txt, Data/Interface/gameshelf_arabic.swf and
//   license texts in Data/Interface/GameShelf.
// - Loose files (games whose text is in plain files): text and data files
//   (.json, .csv, .xml, .po, .txt, .ini...) and fonts, anywhere in the game's
//   folder. These replace the game's own files: GameShelf keeps the originals
//   and puts them back (stager.js, replace mode).
// - Custom engines (built with an admin-signed engine recipe): any file but
//   programs, libraries and scripts, also replacing the game's own.
// - Runtime adapter (custom engines no tool can repack): one library, the
//   adapter standing in for version.dll or dinput8.dll in the game's program
//   folder, and gameshelf_strings.bin, fonts and license texts in
//   gameshelf_arabic/. GameShelf writes the adapter's settings itself, and only
//   installs a library whose SHA-256 is the one this copy of GameShelf ships.
// - Overlay: only fingerprints.json, which never goes into the game's folder.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { isInside, sha256File } = require('./files');
const { PACK_TARGET: RE_TARGET } = require('./reengine');

const MANIFEST = 'pack.json';
const SIGNATURE = 'pack.json.sig';
const MAX_FILES = 2000;

const UNITY_ROOT_FILES = new Set(['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']);
const UNITY_DIRS = new Set(['bepinex', 'dotnet']);
const UNITY_RESERVED = 'bepinex/config/autotranslatorconfig.ini';
// Where Ren'Py and Godot packs put their data (lower case, as compared).
const DATA_DIRS = { renpy: ['game', 'tl', 'arabic', 'gameshelf'], godot: ['gameshelf_arabic'] };
const DATA_FILE = /^(strings\.json|[\w.\-]+\.(ttf|otf|txt))$/i;
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
// The Arabic font styles GameShelf ships (localization/assets/fonts), and "custom" for a pack author's own font.
const FONT_STYLES = ['plex', 'cairo', 'naskh', 'custom'];
const ENGINES = ['unreal', 'unity', 'reengine', 'renpy', 'godot', 'bethesda', 'loose', 'custom', 'runtime', 'overlay'];
// The runtime adapter: the Windows libraries it may stand in for, and what goes beside it.
const RUNTIME_PROXIES = ['version.dll', 'dinput8.dll'];
const RUNTIME_DATA = /^(gameshelf_strings\.bin|[\w.\-]+\.(ttf|otf|txt))$/i;
const RUNTIME_SETTINGS = 'gameshelf_arabic/gameshelf_runtime.ini';
// Bethesda string tables: skyrim_english.strings, Fallout4_en.DLSTRINGS, ccbgssse001-fish_english.ilstrings.
const BETHESDA_TABLE = /^[\w .'()&+!\-]+_[a-z]+\.(strings|dlstrings|ilstrings)$/i;
const BETHESDA_FILES = new Set(['data/interface/fontconfig.txt', 'data/interface/gameshelf_arabic.swf']);
// What a loose-file pack may hold: text, data and fonts.
// Text files, the message tables loose.py writes natively (.fmg, .msgbnd, .dcx, .gxt2, .gmd, .arc: data, never code), and fonts.
const LOOSE_FILE = /\.(json|csv|tsv|xml|po|mo|txt|ini|cfg|loc|lang|yaml|yml|strings|fmg|msgbnd|dcx|gxt2|gmd|arc|ttf|otf)$/i;
// What no pack may put into a game: programs, libraries and scripts.
const EXECUTABLE = /\.(exe|dll|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|com|cpl|lnk|url|sys|drv|ocx|so|dylib|jar|py|pyw|sh|reg)$/i;
/** Engines whose packs replace the game's own files (the originals are kept and put back). */
const REPLACING_ENGINES = new Set(['bethesda', 'loose', 'custom']);

class PackError extends Error {
  constructor(message) {
    super(message);
    this.code = 'pack';
  }
}

/** Splits a pack-relative path into its parts, refusing anything that could escape. */
function safeParts(value, what) {
  if (typeof value !== 'string' || !value || value.length > 260) throw new PackError(`${what} is missing or too long.`);
  if (/^[\\/]/.test(value) || /^[a-z]:/i.test(value)) throw new PackError(`${what} "${value}" must be relative.`);
  const parts = value.split(/[\\/]/);
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new PackError(`${what} "${value}" isn't a plain path.`);
    // ":" would reach an NTFS alternate data stream; control characters,
    // reserved device names and trailing dots or spaces confuse Windows.
    if (/[:*?"<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part) || RESERVED_NAMES.test(part)) {
      throw new PackError(`${what} "${value}" has a name Windows can't use safely.`);
    }
  }
  return parts;
}

function checkTarget(manifest, parts, target) {
  const lower = parts.map((p) => p.toLowerCase());
  if (manifest.engine === 'overlay') {
    if (parts.length !== 1 || lower[0] !== 'fingerprints.json') throw new PackError(`"${target}" isn't allowed: overlay packs hold only fingerprints.json.`);
    return;
  }
  const dataDir = DATA_DIRS[manifest.engine];
  if (dataDir) {
    const inside = parts.length === dataDir.length + 1 && dataDir.every((name, i) => lower[i] === name);
    if (!inside || !DATA_FILE.test(parts[parts.length - 1])) {
      throw new PackError(`"${target}" isn't allowed: ${manifest.engine === 'renpy' ? 'Ren\'Py' : 'Godot'} packs may only add strings.json, fonts and license texts in ${dataDir.join('/')}.`);
    }
    return;
  }
  if (manifest.engine === 'bethesda') {
    const joined = lower.join('/');
    const table = parts.length === 3 && lower[0] === 'data' && lower[1] === 'strings' && BETHESDA_TABLE.test(parts[2]);
    const license = parts.length === 4 && joined.startsWith('data/interface/gameshelf/') && /\.txt$/i.test(parts[3]);
    if (!table && !license && !BETHESDA_FILES.has(joined)) {
      throw new PackError(`"${target}" isn't allowed: Bethesda packs may only add string tables in Data/Strings, Data/Interface/fontconfig.txt, Data/Interface/gameshelf_arabic.swf and license texts.`);
    }
    return;
  }
  if (manifest.engine === 'runtime') {
    const proxy = parts.length === 1 && RUNTIME_PROXIES.includes(lower[0]);
    const data = parts.length === 2 && lower[0] === 'gameshelf_arabic' && RUNTIME_DATA.test(parts[1]);
    if (!proxy && !data) {
      throw new PackError(`"${target}" isn't allowed: runtime packs hold the adapter (${RUNTIME_PROXIES.join(' or ')}) and gameshelf_strings.bin, fonts and license texts in gameshelf_arabic.`);
    }
    return;
  }
  if (manifest.engine === 'loose' || manifest.engine === 'custom') {
    const name = parts[parts.length - 1];
    if (EXECUTABLE.test(name)) throw new PackError(`"${target}" isn't allowed: packs can't put programs, libraries or scripts into a game.`);
    if (manifest.engine === 'loose' && !LOOSE_FILE.test(name)) {
      throw new PackError(`"${target}" isn't allowed: loose-file packs may only hold text, data and font files.`);
    }
    return;
  }
  if (manifest.engine === 'reengine') {
    if (parts.length !== 1 || lower[0] !== RE_TARGET.toLowerCase()) {
      throw new PackError(`"${target}" isn't allowed: RE Engine packs hold one file, ${RE_TARGET}.`);
    }
    return;
  }
  if (manifest.engine === 'unreal') {
    if (parts.length !== 1 || !/_p\.(pak|utoc|ucas)$/i.test(parts[0])) {
      throw new PackError(`"${target}" isn't allowed: Unreal packs may only add .pak, .utoc or .ucas files ending in _P.`);
    }
    return;
  }
  const joined = lower.join('/');
  if (joined === UNITY_RESERVED) throw new PackError('Packs may not include AutoTranslatorConfig.ini; GameShelf writes it.');
  const allowed = (parts.length === 1 && (UNITY_ROOT_FILES.has(lower[0]) || lower[0] === String(manifest.fontBundle || '').toLowerCase()))
    || (parts.length > 1 && UNITY_DIRS.has(lower[0]));
  if (!allowed) throw new PackError(`"${target}" isn't allowed: Unity packs may only add BepInEx, dotnet, doorstop's files and the font bundle.`);
}

function checkManifest(manifest) {
  if (!manifest || manifest.format !== 1) throw new PackError('Unknown pack format.');
  for (const key of ['id', 'version']) {
    if (typeof manifest[key] !== 'string' || !/^[\w.\-]{1,80}$/.test(manifest[key])) throw new PackError(`The pack's ${key} is missing or invalid.`);
  }
  if (!ENGINES.includes(manifest.engine)) throw new PackError('The pack is for an engine GameShelf doesn\'t support.');
  if (manifest.title !== undefined && (typeof manifest.title !== 'string' || manifest.title.length > 120)) throw new PackError('The pack\'s title is invalid.');
  const { game, overlay } = manifest;
  if (game !== undefined) {
    const steamOk = game?.steamAppId === undefined || (Number.isInteger(game.steamAppId) && game.steamAppId > 0);
    const idOk = game?.gameId === undefined || (typeof game.gameId === 'string' && /^[\w.\-]{1,120}$/.test(game.gameId));
    if (!game || typeof game !== 'object' || !steamOk || !idOk || (game.steamAppId === undefined && game.gameId === undefined)) {
      throw new PackError('The pack\'s game must have a Steam app ID or a GameShelf game ID.');
    }
  }
  if (overlay !== undefined) {
    const share = (n) => typeof n === 'number' && n >= 0 && n <= 1;
    const region = overlay?.region;
    const regionOk = region === undefined || (Array.isArray(region) && region.length === 4 && region.every(share)
      && region[2] > 0 && region[3] > 0 && region[0] + region[2] <= 1.0001 && region[1] + region[3] <= 1.0001);
    const lumaOk = overlay?.textLuma === undefined || (Number.isInteger(overlay.textLuma) && overlay.textLuma >= 30 && overlay.textLuma <= 250);
    const thresholdOk = overlay?.threshold === undefined || (typeof overlay.threshold === 'number' && overlay.threshold >= 0.5 && overlay.threshold <= 0.99);
    const darkOk = overlay?.darkText === undefined || typeof overlay.darkText === 'boolean';
    if (!overlay || typeof overlay !== 'object' || !regionOk || !lumaOk || !thresholdOk || !darkOk) throw new PackError('The pack\'s overlay settings are invalid.');
  }
  if (manifest.fontBundle !== undefined && !/^[\w.\-]{1,80}$/.test(manifest.fontBundle)) throw new PackError('The pack\'s font bundle name is invalid.');
  if (manifest.uguiFont !== undefined && !/^[\w .\-]{1,80}$/.test(manifest.uguiFont)) throw new PackError('The pack\'s UI font name is invalid.');
  if (manifest.fontStyle !== undefined && !FONT_STYLES.includes(manifest.fontStyle)) throw new PackError('The pack\'s font style is unknown.');
  // The game's Arabic logo for the player's Steam library (see steam-grid.js): a PNG in the pack, not put into the game.
  if (manifest.steamLogo !== undefined) {
    const logo = manifest.steamLogo;
    if (!logo || typeof logo !== 'object' || typeof logo.source !== 'string' || !/\.png$/i.test(logo.source) || !/^[0-9a-f]{64}$/.test(String(logo.sha256))
      || !Number.isInteger(logo.size) || logo.size <= 0 || logo.size > 8 * 1024 * 1024) throw new PackError('The pack\'s Steam logo is invalid.');
  }
  const godot = manifest.requires?.godot;
  if (godot !== undefined && godot !== 3 && godot !== 4) throw new PackError('The pack\'s Godot version must be 3 or 4.');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) {
    throw new PackError('The pack lists no files, or too many.');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    safeParts(file.source, 'A source path');
    const parts = safeParts(file.target, 'A target path');
    checkTarget(manifest, parts, file.target);
    const key = parts.join('/').toLowerCase();
    if (seen.has(key)) throw new PackError(`"${file.target}" is listed twice.`);
    seen.add(key);
    if (!/^[0-9a-f]{64}$/.test(file.sha256 || '')) throw new PackError(`"${file.target}" has no valid SHA-256.`);
    if (!Number.isInteger(file.size) || file.size < 0) throw new PackError(`"${file.target}" has no valid size.`);
  }
  if (manifest.engine === 'reengine' && manifest.files.length !== 1) throw new PackError(`RE Engine packs hold one file, ${RE_TARGET}.`);
  if (manifest.engine === 'runtime') {
    const targets = manifest.files.map((f) => f.target.toLowerCase());
    if (targets.filter((t) => RUNTIME_PROXIES.includes(t)).length !== 1 || !targets.includes('gameshelf_arabic/gameshelf_strings.bin')) {
      throw new PackError('A runtime pack holds one adapter library and gameshelf_strings.bin.');
    }
  }
  if (manifest.engine === 'unreal') {
    // An IoStore container (UE5) only loads as a whole: its .utoc, .ucas and a .pak of the same name.
    const names = new Set(manifest.files.map((f) => f.target.toLowerCase()));
    for (const name of names) {
      const stem = name.replace(/\.(utoc|ucas)$/, '');
      if (stem !== name && !['.utoc', '.ucas', '.pak'].every((ext) => names.has(stem + ext))) {
        throw new PackError(`"${stem}" needs its .utoc, .ucas and .pak together.`);
      }
    }
  }
  if (DATA_DIRS[manifest.engine] && !manifest.files.some((f) => /(^|[\\/])strings\.json$/i.test(f.target))) {
    throw new PackError('The pack has no strings.json.');
  }
}

/**
 * Reads and checks a pack. Throws PackError unless the signature is valid
 * (or allowUnsigned, for development) and every file is there with the right
 * size and hash. Returns { dir, manifest, files: [{ source, target, sha256, size }] }.
 */
// `publicKey` is a PEM key, or a list of them (any one may have signed the pack).
async function readPack(dir, { publicKey, allowUnsigned = false } = {}) {
  const realDir = await fs.realpath(dir);
  const bytes = await fs.readFile(path.join(realDir, MANIFEST)).catch(() => {
    throw new PackError('The pack has no pack.json.');
  });

  if (!allowUnsigned) {
    // GameShelf's own key, and the key this PC's copy of the app signs the packs it builds with.
    const keys = [].concat(publicKey || []).filter(Boolean);
    if (!keys.length) throw new PackError('No pack signing key is set up, so packs can\'t be checked.');
    const signature = await fs.readFile(path.join(realDir, SIGNATURE), 'utf8').catch(() => {
      throw new PackError('The pack isn\'t signed.');
    });
    let valid = false;
    try {
      valid = keys.some((key) => crypto.verify(null, bytes, key, Buffer.from(signature.trim(), 'base64')));
    } catch {
      valid = false;
    }
    if (!valid) throw new PackError('The pack\'s signature doesn\'t match. It may have been changed.');
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PackError('pack.json isn\'t valid JSON.');
  }
  checkManifest(manifest);

  const files = [];
  for (const file of manifest.files) {
    const source = path.resolve(realDir, ...safeParts(file.source, 'A source path'));
    if (!isInside(realDir, source)) throw new PackError(`"${file.source}" is outside the pack.`);
    const info = await fs.lstat(source).catch(() => null);
    if (!info?.isFile()) throw new PackError(`"${file.source}" is missing from the pack.`);
    if (info.size !== file.size || (await sha256File(source)) !== file.sha256) {
      throw new PackError(`"${file.source}" doesn't match pack.json. The pack may be damaged.`);
    }
    files.push({ source, target: file.target, sha256: file.sha256, size: file.size });
  }
  let steamLogo = null;
  if (manifest.steamLogo) {
    const source = path.resolve(realDir, ...safeParts(manifest.steamLogo.source, 'A source path'));
    if (!isInside(realDir, source)) throw new PackError(`"${manifest.steamLogo.source}" is outside the pack.`);
    const info = await fs.lstat(source).catch(() => null);
    if (!info?.isFile() || info.size !== manifest.steamLogo.size || (await sha256File(source)) !== manifest.steamLogo.sha256) {
      throw new PackError('The pack\'s Steam logo doesn\'t match pack.json. The pack may be damaged.');
    }
    steamLogo = source;
  }
  return { dir: realDir, manifest, files, steamLogo };
}

/**
 * For whoever builds packs: writes pack.json for files already in the pack
 * folder (each { source, target }) and, given the private key, pack.json.sig.
 */
async function writePack(dir, { files, privateKey, steamLogo, ...details }) {
  if (steamLogo) {
    const file = path.join(dir, ...safeParts(steamLogo.source || steamLogo, 'A source path'));
    details.steamLogo = { source: steamLogo.source || steamLogo, sha256: await sha256File(file), size: (await fs.stat(file)).size };
  }
  const listed = [];
  for (const { source, target } of files) {
    const file = path.join(dir, ...safeParts(source, 'A source path'));
    const info = await fs.stat(file);
    listed.push({ source, target, sha256: await sha256File(file), size: info.size });
  }
  const manifest = { format: 1, language: 'ar', ...details, files: listed };
  checkManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dir, MANIFEST), bytes);
  if (privateKey) await fs.writeFile(path.join(dir, SIGNATURE), crypto.sign(null, bytes, privateKey).toString('base64'));
  return manifest;
}

module.exports = { readPack, writePack, PackError, MANIFEST, SIGNATURE, ENGINES, FONT_STYLES, REPLACING_ENGINES, EXECUTABLE, RUNTIME_PROXIES, RUNTIME_SETTINGS };
