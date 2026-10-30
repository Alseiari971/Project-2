// One-click Arabic for a game: decides how (or whether) it can be done, then
// adds or removes the pack's files.
//
// Tiers, decided before launch:
// - 'unreal-pak'    Unreal Engine 4/5: a _P patch pak in Content/Paks that the
//                   game loads after its own, with the Arabic text and font.
// - 'unity-bepinex' Unity: BepInEx + XUnity.AutoTranslator reading the compiled
//                   dictionary, with an Arabic TextMeshPro fallback font.
// - 'overlay'       Everything else, and every game with anti-cheat: subtitles
//                   drawn in GameShelf's own window, without touching the game.
const path = require('node:path');
const { scanAntiCheat } = require('./anticheat');
const { fingerprint } = require('./engine');
const { readPack } = require('./pack');
const { createStager, StageError } = require('./stager');
const { sha256 } = require('./files');
const { AUTO_TRANSLATOR_CONFIG, GENERATED, autoTranslatorConfig, unityMismatch } = require('./unity');

class LocalizationError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const overlay = (reason) => ({ tier: 'overlay', fileChanges: false, reason });

/**
 * Looks at a game before anything is changed. Returns { root, engine,
 * antiCheat, tier, fileChanges, reason }; `reason` says why only the overlay
 * is possible. `ownMods` is true when the BepInEx found is GameShelf's own.
 */
async function preflight(root, { steamAppId, ownMods = false, maxEntries } = {}) {
  const engine = await fingerprint(root);
  const antiCheat = await scanAntiCheat(engine.root, { steamAppId, maxEntries });
  const base = { root: engine.root, engine, antiCheat };

  if (antiCheat.found.length) {
    const names = [...new Set(antiCheat.found.map((a) => a.name))].join(', ');
    return { ...base, ...overlay(`This game uses ${names}. To keep your account safe, GameShelf won't change its files.`) };
  }
  if (!antiCheat.complete) {
    return { ...base, ...overlay('GameShelf couldn\'t check all of this game\'s files for anti-cheat software, so it won\'t change them.') };
  }
  if (engine.engine === 'unreal') {
    if (engine.unreal.signedPaks) return { ...base, ...overlay('This game only loads files signed by its developer.') };
    return { ...base, tier: 'unreal-pak', fileChanges: true, reason: null };
  }
  if (engine.engine === 'unity') {
    if (engine.unity.bepinex && !ownMods) return { ...base, ...overlay('This game already has BepInEx mods. GameShelf leaves your mods as they are.') };
    if (engine.unity.arch && engine.unity.arch !== 'x64' && engine.unity.arch !== 'x86') {
      return { ...base, ...overlay(`BepInEx doesn't run on ${engine.unity.arch} builds of Unity games.`) };
    }
    return { ...base, tier: 'unity-bepinex', fileChanges: true, reason: null };
  }
  return { ...base, ...overlay('This game\'s engine can\'t take added text, so the overlay is used.') };
}

/** The files to add for a checked pack, and where. */
function stagePlan(check, pack) {
  const { engine } = check;
  const files = pack.files.map((f) => ({ target: f.target, source: f.source, sha256: f.sha256 }));
  if (check.tier === 'unreal-pak') {
    return { anchor: engine.unreal.paksDir, files, generated: [] };
  }
  const config = autoTranslatorConfig({ fontBundle: pack.manifest.fontBundle, uguiFont: pack.manifest.uguiFont });
  files.push({ target: AUTO_TRANSLATOR_CONFIG, content: config, sha256: sha256(config), mutable: true });
  return { anchor: engine.base, files, generated: GENERATED };
}

/**
 * Turns Arabic on for the game in `root` with the pack in `packDir`.
 * `isRunning` is an async check that the game is closed (its files can't be
 * changed while it runs). Throws LocalizationError with a code:
 * 'running', 'blocked' (only the overlay is possible: see .reason), 'mismatch'
 * (the pack is for another build), or the pack's and stager's own errors.
 */
async function enableArabic({ root, packDir, stager, publicKey, allowUnsigned = false, steamAppId, isRunning }) {
  if (await isRunning?.()) throw new LocalizationError('Close the game first.', 'running');
  const pack = await readPack(packDir, { publicKey, allowUnsigned });
  const ours = await stager.status(root);
  if (ours?.status === 'enabled' && ours.pack.id === pack.manifest.id && ours.pack.version === pack.manifest.version) {
    return { already: true, tier: null };
  }

  const check = await preflight(root, { steamAppId, ownMods: Boolean(ours) });
  if (!check.fileChanges) throw new LocalizationError(check.reason, 'blocked');

  const wanted = check.tier === 'unreal-pak' ? 'unreal' : 'unity';
  if (pack.manifest.engine !== wanted) {
    throw new LocalizationError(`This pack is for ${pack.manifest.engine === 'unreal' ? 'an Unreal' : 'a Unity'} game, and this game uses ${wanted === 'unreal' ? 'Unreal' : 'Unity'}.`, 'mismatch');
  }
  const requires = pack.manifest.requires || {};
  const arch = check.engine.unreal?.arch || check.engine.unity?.arch;
  if (requires.arch && arch && requires.arch !== arch) {
    throw new LocalizationError(`This pack is for ${requires.arch} games, and this game is ${arch}.`, 'mismatch');
  }
  if (check.engine.unity) {
    const problem = unityMismatch(check.engine.unity, requires);
    if (problem) throw new LocalizationError(problem, 'mismatch');
  }

  const result = await stager.enable({ root: check.root, pack: pack.manifest, ...stagePlan(check, pack) });
  return { ...result, tier: check.tier };
}

/** Turns Arabic off: removes what enableArabic added. */
async function disableArabic({ root, stager, isRunning }) {
  if (await isRunning?.()) throw new LocalizationError('Close the game first.', 'running');
  return stager.disable(root);
}

/** The stager for this computer: its records live in the app's data folder. */
function createLocalization({ dataDir }) {
  const stager = createStager({ stateDir: path.join(dataDir, 'localization') });
  return {
    stager,
    preflight,
    recover: () => stager.recover(),
    status: (root) => stager.status(root),
    enable: (options) => enableArabic({ ...options, stager }),
    disable: (options) => disableArabic({ ...options, stager }),
  };
}

module.exports = { preflight, enableArabic, disableArabic, createLocalization, LocalizationError, StageError };
