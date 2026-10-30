// One-click Arabic for a game: decides how (or whether) it can be done, then
// adds or removes the pack's files.
//
// Tiers, decided before launch:
// - 'unreal-pak'    Unreal Engine 4/5: a _P patch pak in Content/Paks that the
//                   game loads after its own, with the Arabic text and font.
// - 'unity-bepinex' Unity: BepInEx + XUnity.AutoTranslator reading the compiled
//                   dictionary, with an Arabic TextMeshPro fallback font.
// - 're-patch'      Capcom RE Engine: the pack's .pak as the game's next
//                   numbered patch file (see reengine.js).
// - 'renpy-tl'      Ren'Py: the Arabic lines and font in game/tl/arabic, shown
//                   in the game's own dialogue box (see renpy.js).
// - 'godot-override' Godot 3/4: an Arabic translation and fallback font the
//                   game loads through override.cfg (see godot.js).
// - 'overlay'       Everything else, and every game with anti-cheat: subtitles
//                   drawn in GameShelf's own window, without touching the game.
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanAntiCheat } = require('./anticheat');
const { fingerprint } = require('./engine');
const { readPack } = require('./pack');
const { createStager, StageError } = require('./stager');
const { sha256 } = require('./files');
const { AUTO_TRANSLATOR_CONFIG, GENERATED, autoTranslatorConfig, unityMismatch } = require('./unity');
const renpy = require('./renpy');
const godot = require('./godot');
const reengine = require('./reengine');

// The pack engine each tier takes.
const TIER_ENGINES = { 'unreal-pak': 'unreal', 'unity-bepinex': 'unity', 're-patch': 'reengine', 'renpy-tl': 'renpy', 'godot-override': 'godot' };
const ENGINE_NAMES = { unreal: 'Unreal', unity: 'Unity', reengine: 'RE Engine', renpy: 'Ren\'Py', godot: 'Godot' };
// RE Engine patch numbers have three digits.
const MAX_RE_PATCH = 999;
const native = (tier) => ({ tier, fileChanges: true, reason: null, why: null });

class LocalizationError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

// `reason` is the English sentence; `why` is the same as { text, vars }, for
// the app to translate.
const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const overlay = (text, vars) => ({ tier: 'overlay', fileChanges: false, reason: fill(text, vars), why: { text, vars: vars || {} } });

/**
 * Looks at a game before anything is changed. Returns { root, engine,
 * antiCheat, tier, fileChanges, reason, why }; `reason` says why only the
 * overlay is possible. `ownMods` is true when the BepInEx found is GameShelf's own.
 */
async function preflight(root, { steamAppId, ownMods = false, maxEntries } = {}) {
  const engine = await fingerprint(root);
  const antiCheat = await scanAntiCheat(engine.root, { steamAppId, maxEntries });
  const base = { root: engine.root, engine, antiCheat };

  if (antiCheat.found.length) {
    const names = [...new Set(antiCheat.found.map((a) => a.name))].join(', ');
    return { ...base, ...overlay('This game uses {names}. To keep your account safe, GameShelf won\'t change its files.', { names }) };
  }
  if (!antiCheat.complete) {
    return { ...base, ...overlay('GameShelf couldn\'t check all of this game\'s files for anti-cheat software, so it won\'t change them.') };
  }
  if (engine.engine === 'unreal') {
    if (engine.unreal.signedPaks) return { ...base, ...overlay('This game only loads files signed by its developer.') };
    return { ...base, ...native('unreal-pak') };
  }
  if (engine.engine === 'unity') {
    if (engine.unity.bepinex && !ownMods) return { ...base, ...overlay('This game already has BepInEx mods. GameShelf leaves your mods as they are.') };
    if (engine.unity.arch && engine.unity.arch !== 'x64' && engine.unity.arch !== 'x86') {
      return { ...base, ...overlay('BepInEx doesn\'t run on {arch} builds of Unity games.', { arch: engine.unity.arch }) };
    }
    return { ...base, ...native('unity-bepinex') };
  }
  if (engine.engine === 'reengine') {
    const re = engine.reengine;
    const online = reengine.onlineGame({ steamAppId, programs: re.programs });
    if (online) return { ...base, ...overlay('{name} is played online with others. To keep your account safe, GameShelf won\'t change its files.', { name: online.name }) };
    if (re.gap !== null) {
      return { ...base, ...overlay('This game\'s patch files skip {file}, so the game wouldn\'t load another one.', { file: reengine.patchName(re.gap) }) };
    }
    if (re.next > MAX_RE_PATCH) return { ...base, ...overlay('This game has no patch numbers left for another patch file.') };
    return { ...base, ...native('re-patch') };
  }
  if (engine.engine === 'renpy') return { ...base, ...native('renpy-tl') };
  if (engine.engine === 'godot') {
    if (!godot.hookScript(engine.godot.major)) {
      return { ...base, ...overlay('GameShelf can\'t add Arabic to games made with Godot {version}.', { version: engine.godot.version }) };
    }
    if (engine.godot.overrideCfg && !ownMods) {
      return { ...base, ...overlay('This game already has an override.cfg file. GameShelf leaves it as it is.') };
    }
    return { ...base, ...native('godot-override') };
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
  if (check.tier === 're-patch') {
    // The pack's one .pak, as the next patch number, checked again as it's added.
    const { next } = engine.reengine;
    const [pak] = files;
    return {
      anchor: engine.reengine.dir,
      files: [{ ...pak, target: reengine.patchName(next), chain: { pattern: reengine.PATCH.source, number: next } }],
      generated: [],
    };
  }
  if (check.tier === 'renpy-tl') {
    files.push({ target: renpy.HOOK_SCRIPT, content: renpy.SCRIPT, sha256: sha256(renpy.SCRIPT) });
    return { anchor: engine.base, files, generated: renpy.GENERATED };
  }
  if (check.tier === 'godot-override') {
    // override.cfg names the script by its full path, so the game finds it
    // wherever it's started from.
    const script = godot.hookScript(engine.godot.major);
    const config = godot.overrideCfg(path.join(engine.godot.dir, ...godot.HOOK_SCRIPT.split('/')));
    files.push({ target: godot.HOOK_SCRIPT, content: script, sha256: sha256(script) });
    files.push({ target: godot.OVERRIDE_CFG, content: config, sha256: sha256(config) });
    return { anchor: engine.godot.dir, files, generated: godot.GENERATED };
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
  let ours = await stager.status(root);
  if (ours?.status === 'enabled' && ours.pack.id === pack.manifest.id && ours.pack.version === pack.manifest.version) {
    return { already: true, tier: null };
  }
  if (ours?.status === 'enabled' && ours.pack.id === pack.manifest.id) {
    // Another version of the same pack is in: take it out first. If anything of
    // it has to stay (changed since, or a newer RE Engine patch follows it), say so.
    const old = await stager.disable(root);
    if (old.kept.length) {
      throw new LocalizationError(`GameShelf couldn't take out version ${ours.pack.version} to put in ${pack.manifest.version}. Turn Arabic off for this game, then on again.`, 'busy');
    }
    ours = null;
  }

  const check = await preflight(root, { steamAppId, ownMods: Boolean(ours) });
  if (!check.fileChanges) throw new LocalizationError(check.reason, 'blocked');

  const wanted = TIER_ENGINES[check.tier];
  if (pack.manifest.engine !== wanted) {
    const packEngine = ENGINE_NAMES[pack.manifest.engine] || 'another engine\'s';
    throw new LocalizationError(`This pack is for ${packEngine} games, and this game uses ${ENGINE_NAMES[wanted]}.`, 'mismatch');
  }
  const requires = pack.manifest.requires || {};
  const arch = check.engine.unreal?.arch || check.engine.unity?.arch || check.engine.godot?.arch;
  if (requires.arch && arch && requires.arch !== arch) {
    throw new LocalizationError(`This pack is for ${requires.arch} games, and this game is ${arch}.`, 'mismatch');
  }
  const problem = (check.engine.unity && unityMismatch(check.engine.unity, requires))
    || (check.engine.godot && godot.godotMismatch(check.engine.godot, requires));
  if (problem) throw new LocalizationError(problem, 'mismatch');

  if (wanted === 'reengine') {
    const head = Buffer.alloc(4);
    const handle = await fs.open(pack.files[0].source, 'r');
    try {
      await handle.read(head, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (head.toString('latin1') !== reengine.PAK_MAGIC) throw new LocalizationError('The pack\'s file isn\'t an RE Engine .pak.', 'pack');
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

module.exports = { preflight, enableArabic, disableArabic, createLocalization, LocalizationError, StageError, fill, TIER_ENGINES };
