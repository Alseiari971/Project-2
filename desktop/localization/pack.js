// Localization packs: the files GameShelf adds to a game to show it in Arabic.
// A pack is a folder with pack.json (what goes where, with each file's SHA-256),
// pack.json.sig (an Ed25519 signature of pack.json by GameShelf's pack key) and
// the files themselves. Packs can put a DLL into a game's folder, so only
// signed packs are used, and every file must match its hash before it's copied.
//
//   {
//     "format": 1, "id": "some-game-ar", "version": "1.0.0", "language": "ar",
//     "title": "Some Game in Arabic",           (optional, shown in App settings)
//     "engine": "unreal" | "unity" | "overlay",
//     "game": { "steamAppId": 1245620, "gameId": "elden-ring" },   (which game it's for)
//     "overlay": { "region": [0, 0.78, 1, 0.22], "textLuma": 170, "darkText": false, "threshold": 0.72 },
//     "requires": { "arch": "x64", "unityBackend": "mono", "unityVersion": "2019.4" },
//     "fontBundle": "gameshelf_arabic_sdf",      (Unity: TextMeshPro font, in the game folder)
//     "uguiFont": "Arial",                       (Unity: optional font for older UI text)
//     "files": [{ "source": "payload/x.pak", "target": "pakchunk99-ArabicLocalization_P.pak",
//                 "sha256": "...", "size": 123 }]
//   }
//
// Targets are relative to the game's Content/Paks folder (Unreal) or the game's
// folder (Unity), and only these may be added:
// - Unreal: .pak/.utoc/.ucas files whose name ends in _P (patch files, loaded
//   after the game's own, so they win without replacing anything).
// - Unity: BepInEx/ and dotnet/ (the mod loader), doorstop's files and the font
//   bundle. The XUnity.AutoTranslator settings are written by GameShelf itself.
// - Overlay: only fingerprints.json, which never goes into the game's folder.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { isInside, sha256File } = require('./files');

const MANIFEST = 'pack.json';
const SIGNATURE = 'pack.json.sig';
const MAX_FILES = 2000;

const UNITY_ROOT_FILES = new Set(['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']);
const UNITY_DIRS = new Set(['bepinex', 'dotnet']);
const UNITY_RESERVED = 'bepinex/config/autotranslatorconfig.ini';
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

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
  if (!['unreal', 'unity', 'overlay'].includes(manifest.engine)) throw new PackError('The pack is for an engine GameShelf doesn\'t support.');
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
}

/**
 * Reads and checks a pack. Throws PackError unless the signature is valid
 * (or allowUnsigned, for development) and every file is there with the right
 * size and hash. Returns { dir, manifest, files: [{ source, target, sha256, size }] }.
 */
async function readPack(dir, { publicKey, allowUnsigned = false } = {}) {
  const realDir = await fs.realpath(dir);
  const bytes = await fs.readFile(path.join(realDir, MANIFEST)).catch(() => {
    throw new PackError('The pack has no pack.json.');
  });

  if (!allowUnsigned) {
    if (!publicKey) throw new PackError('No pack signing key is set up, so packs can\'t be checked.');
    const signature = await fs.readFile(path.join(realDir, SIGNATURE), 'utf8').catch(() => {
      throw new PackError('The pack isn\'t signed.');
    });
    let valid = false;
    try {
      valid = crypto.verify(null, bytes, publicKey, Buffer.from(signature.trim(), 'base64'));
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
  return { dir: realDir, manifest, files };
}

/**
 * For whoever builds packs: writes pack.json for files already in the pack
 * folder (each { source, target }) and, given the private key, pack.json.sig.
 */
async function writePack(dir, { files, privateKey, ...details }) {
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

module.exports = { readPack, writePack, PackError, MANIFEST, SIGNATURE };
