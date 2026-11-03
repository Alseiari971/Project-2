// One-click Arabic for a game: decides how (or whether) it can be done, then
// adds or removes the pack's files.
//
// Tiers, decided before launch:
// - 'unreal-pak'    Unreal Engine 4/5: a _P patch pak in Content/Paks/~mods that
//                   the game loads after its own, with the Arabic text and font
//                   (UE5 IoStore games: with its own .utoc and .ucas).
// - 'unity-bepinex' Unity: BepInEx + XUnity.AutoTranslator reading the compiled
//                   dictionary, with an Arabic TextMeshPro fallback font.
// - 're-patch'      Capcom RE Engine: the pack's .pak as the game's next
//                   numbered patch file (see reengine.js).
// - 'renpy-tl'      Ren'Py: the Arabic lines and font in game/tl/arabic, shown
//                   in the game's own dialogue box (see renpy.js).
// - 'godot-override' Godot 3/4: an Arabic translation and fallback font the
//                   game loads through override.cfg (see godot.js).
// - 'bethesda-strings' Bethesda Creation Engine (Skyrim Special Edition, Fallout
//                   4, Starfield): Arabic string tables in Data/Strings, which the
//                   game loads over its archives, and an Arabic font library
//                   named in Data/Interface/fontconfig.txt.
// - 'loose-files'   Other engines whose text is in readable files (JSON, CSV,
//                   XML, .po, .txt...): those files, with the Arabic in place of
//                   the English, and the Arabic font in place of the game's loose
//                   fonts. The originals are kept and put back (stager.js).
// - 'recipe'        Other engines whose text is packed in archives (God of War,
//                   REDengine...): built with the game's engine recipe, which an
//                   admin signed (see localization/arabic_compiler/recipes.py);
//                   the repacked files replace the game's, kept and put back too.
// - 'native-runtime' Other single-player 64-bit engines whose archives no tool
//                   can repack: GameShelf's runtime adapter (localization/runtime/)
//                   stands in for a library the game loads from its folder. Games
//                   whose UI text goes through Windows' text functions (GDI,
//                   DirectWrite) get each English string swapped for its Arabic
//                   right before Windows lays it out; games that draw their own
//                   text on Direct3D 11 get the Arabic of the lines they use drawn
//                   onto their own frames (runtimeCheck, modes). Nothing in the
//                   game's files changes; only the library this copy of GameShelf
//                   ships is ever installed.
// - 'overlay'       Every game with anti-cheat (and packs made for the overlay):
//                   subtitles drawn in GameShelf's own window, without touching the game.
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanAntiCheat } = require('./anticheat');
const { fingerprint } = require('./engine');
const { readPack, RUNTIME_PROXIES, RUNTIME_SETTINGS } = require('./pack');
const { createStager, StageError } = require('./stager');
const { sha256, fold, list } = require('./files');
const { AUTO_TRANSLATOR_CONFIG, GENERATED, autoTranslatorConfig, unityMismatch } = require('./unity');
const renpy = require('./renpy');
const godot = require('./godot');
const reengine = require('./reengine');

// The pack engine each tier takes.
const TIER_ENGINES = {
  'unreal-pak': 'unreal', 'unity-bepinex': 'unity', 're-patch': 'reengine', 'renpy-tl': 'renpy', 'godot-override': 'godot',
  'bethesda-strings': 'bethesda', 'loose-files': 'loose', recipe: 'custom', 'native-runtime': 'runtime',
};
const ENGINE_NAMES = {
  unreal: 'Unreal', unity: 'Unity', reengine: 'RE Engine', renpy: 'Ren\'Py', godot: 'Godot',
  bethesda: 'Bethesda Creation Engine', loose: 'loose-file', custom: 'custom-engine', runtime: 'runtime-adapter',
};
// Tiers whose packs replace some of the game's own files (kept aside, and put back when Arabic is turned off).
const REPLACING_TIERS = new Set(['bethesda-strings', 'loose-files', 'recipe']);
const NATIVE_TABLES = /\.(fmg|msgbnd|msgbnd\.dcx|fmg\.dcx|gxt2|gmd)$|(^|\/)(msg|message)\/.*\.arc$/i;
// Where Unreal patches go, inside Content/Paks.
const UNREAL_MODS = '~mods';
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
  if (engine.engine === 'bethesda') return { ...base, ...native('bethesda-strings') };
  // Another engine: its own text files when it has readable ones; for engines
  // known to pack their text, the game's engine recipe; otherwise the runtime
  // adapter, when it can reach the game's text; else an engine recipe.
  const { family, looseText, runtime } = engine.custom || {};
  // Message tables GameShelf reads natively (FromSoftware .fmg/.msgbnd, Rockstar .gxt2, MT Framework .gmd/.arc)
  // go in as loose files even for engines whose archives otherwise need a recipe.
  const nativeTables = (looseText || []).some((rel) => NATIVE_TABLES.test(rel));
  if (looseText?.length && (family?.needs !== 'recipe' || nativeTables)) return { ...base, ...native('loose-files') };
  if (family?.needs === 'recipe') return { ...base, ...native('recipe') };
  const adapter = runtimeCheck(runtime, ownMods);
  if (adapter.ok) return { ...base, ...native('native-runtime'), adapter };
  return { ...base, ...native('recipe'), adapter };
}

/**
 * Whether the runtime adapter can serve a custom-engine game, and how
 * ({ ok, why, mode }; `runtime` from engine.js). Modes:
 * - 'text':   the game draws with Windows' text functions (GDI, DirectWrite),
 *             which lay Arabic out: its strings are swapped for their Arabic;
 * - 'canvas': it draws its own text (font atlases, Scaleform, FreeType) on
 *             Direct3D 11: the Arabic of the lines it uses is drawn onto its
 *             frames by the adapter, inside the game (gs_render.c).
 */
function runtimeCheck(runtime, ownMods = false) {
  if (!runtime) return { ok: false, why: 'GameShelf couldn\'t find the game\'s program.' };
  if (runtime.arch !== 'x64') return { ok: false, why: 'The runtime adapter is for 64-bit games.' };
  const text = runtime.textApis.length > 0;
  const canvas = !text && runtime.d3d11 && (runtime.buffers || []).length > 0;
  if (!text && !canvas) {
    return { ok: false, why: runtime.d3d12 && !runtime.d3d11
      ? 'This game draws its own text with Direct3D 12, which the runtime adapter can\'t draw on yet.'
      : 'This game doesn\'t draw its text with Windows\' text functions (GDI or DirectWrite), or on Direct3D 11.' };
  }
  if (!runtime.proxy) return { ok: false, why: 'This game doesn\'t load a Windows library the runtime adapter can stand in for.' };
  if (runtime.present.includes(runtime.proxy) && !ownMods) {
    return { ok: false, why: `This game already has a ${runtime.proxy} in its folder (another mod's). GameShelf leaves it as it is.` };
  }
  return { ok: true, why: null, mode: text ? 'text' : 'canvas' };
}

/** Where the runtime adapter writes what it saw in a game (outside the game's folder). */
function runtimeFolder(dataDir, root) {
  return path.join(dataDir, 'localization', 'runtime', sha256(fold(path.resolve(root))).slice(0, 16));
}

/**
 * The adapter's settings (gameshelf_arabic/gameshelf_runtime.ini), written by GameShelf when Arabic goes in.
 * `mode` is runtimeCheck's; `region` the subtitle area for the canvas (x, y, width, height, as parts of the frame).
 */
function runtimeSettings({ exe, root, font, folder, mode = 'text', region = null }) {
  const canvas = mode === 'canvas';
  const area = Array.isArray(region) && region.length === 4 && region.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ? region : [0.08, 0.76, 0.84, 0.2];
  return [
    '; GameShelf\'s runtime adapter settings. GameShelf writes this when Arabic is turned on and removes it when it\'s turned off.',
    `exe=${exe}`,
    `root=${root}`,
    'strings=gameshelf_arabic\\gameshelf_strings.bin',
    ...(font ? [`font=${font.replace(/\//g, '\\')}`] : []),
    `dump=${path.join(folder, 'untranslated.txt')}`,
    `status=${path.join(folder, 'status.txt')}`,
    'rtl=1',
    // The strings the game converts, copies and formats: swapped for their Arabic, or (canvas) drawn onto its frames.
    'buffers=1',
    `swap=${canvas ? 0 : 1}`,
    `canvas=${canvas ? 1 : 0}`,
    ...(canvas ? [`canvas_region=${area.map((n) => Number(n.toFixed(3))).join(',')}`] : []),
    '',
  ].join('\r\n');
}

async function isFile(file) {
  return Boolean((await fs.lstat(file).catch(() => null))?.isFile());
}

// The game's own files a store update changes, per tier: { dirs: [{ path, pattern }], files } (see stager.js, verify).
const MAX_WATCHED = 400;

async function matching(dir, pattern) {
  const re = new RegExp(pattern, 'i');
  return (await list(dir)).filter((e) => e.isFile() && re.test(e.name)).map((e) => path.join(dir, e.name));
}

async function watchList(check) {
  const { engine } = check;
  const dirs = [];
  const files = [];
  const watchDir = async (dir, pattern) => {
    if (!dir) return;
    dirs.push({ path: dir, pattern });
    files.push(...(await matching(dir, pattern)));
  };
  if (check.tier === 'unreal-pak') {
    await watchDir(engine.unreal.paksDir, '\\.(pak|utoc|ucas|sig)$');
    files.push(engine.unreal.shippingExe);
  } else if (check.tier === 're-patch') {
    await watchDir(engine.reengine.dir, '^re_chunk_000\\.pak(\\.patch_\\d+\\.pak)?$');
    files.push(engine.reengine.exe);
  } else if (check.tier === 'unity-bepinex') {
    await watchDir(engine.unity.dataDir, '^(globalgamemanagers|data\\.unity3d|resources\\.assets|level0|sharedassets0\\.assets)$');
    files.push(engine.unity.exe, path.join(engine.base, 'GameAssembly.dll'), path.join(engine.base, 'UnityPlayer.dll'));
  } else if (check.tier === 'renpy-tl') {
    await watchDir(engine.renpy.gameDir, '\\.(rpa|rpyc)$');
  } else if (check.tier === 'godot-override') {
    files.push(engine.godot.exe, engine.godot.pck);
  } else if (check.tier === 'bethesda-strings') {
    await watchDir(engine.bethesda.dataDir, '\\.(esm|esp|esl|bsa|ba2)$');
    files.push(engine.bethesda.exe);
  } else if (check.tier === 'native-runtime') {
    await watchDir(engine.custom.runtime.dir, '\\.(exe|dll)$');
  } else if (engine.custom?.runtime?.exe) {
    // Loose files and recipes: the files they replace are watched by the stager itself; the program tells of an update too.
    files.push(engine.custom.runtime.exe);
  }
  return { dirs, files: files.filter(Boolean).slice(0, MAX_WATCHED) };
}

/** The files to add for a checked pack, and where. */
async function stagePlan(check, pack, { runtimeDir } = {}) {
  const { engine } = check;
  const files = pack.files.map((f) => ({ target: f.target, source: f.source, sha256: f.sha256 }));
  if (check.tier === 'native-runtime') {
    const { runtime } = engine.custom;
    const font = files.find((f) => /^gameshelf_arabic\/[^/]+\.(ttf|otf)$/i.test(f.target));
    const mode = runtimeCheck(runtime, true).mode || 'text';
    const settings = runtimeSettings({ exe: path.basename(runtime.exe), root: check.root, font: font?.target, folder: runtimeDir, mode, region: pack.manifest.overlay?.region || null });
    files.push({ target: RUNTIME_SETTINGS, content: settings, sha256: sha256(settings), mutable: true });
    return { anchor: runtime.dir, files, generated: [] };
  }
  if (REPLACING_TIERS.has(check.tier)) {
    // Each file the game already has is replaced (the original kept aside); the rest are added.
    for (const file of files) file.replace = await isFile(path.join(engine.base, ...file.target.split(/[\\/]/)));
    return { anchor: engine.base, files, generated: [] };
  }
  if (check.tier === 'unreal-pak') {
    // Content/Paks/~mods: the game mounts every pak under Paks, and ~mods keeps GameShelf's apart from its own.
    return { anchor: engine.unreal.paksDir, files: files.map((f) => ({ ...f, target: `${UNREAL_MODS}/${f.target}` })), generated: [] };
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
    const json = files.find((f) => f.target === `${renpy.HOOK_DIR}/strings.json`);
    for (const script of renpy.scriptsFor(json ? await fs.readFile(json.source, 'utf8') : '{}')) {
      files.push({ ...script, sha256: sha256(script.content) });
    }
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
async function enableArabic({ root, packDir, stager, publicKey, allowUnsigned = false, steamAppId, isRunning, runtimeHooks = null, runtimeDir = null }) {
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
  const arch = check.engine.unreal?.arch || check.engine.unity?.arch || check.engine.godot?.arch || check.engine.bethesda?.arch
    || check.engine.custom?.runtime?.arch;
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

  if (wanted === 'runtime') {
    // The adapter runs inside the game: only the exact library this copy of GameShelf ships goes in.
    const library = pack.files.find((f) => RUNTIME_PROXIES.includes(f.target.toLowerCase()));
    if (!runtimeHooks || runtimeHooks[library.target.toLowerCase()] !== library.sha256) {
      throw new LocalizationError('This pack\'s runtime adapter isn\'t the one this copy of GameShelf ships, so it wasn\'t added.', 'pack');
    }
    if (library.target.toLowerCase() !== check.engine.custom.runtime.proxy) {
      throw new LocalizationError(`This pack stands in for ${library.target}, and this game loads ${check.engine.custom.runtime.proxy}.`, 'mismatch');
    }
    if (!runtimeDir) throw new LocalizationError('GameShelf has nowhere to keep what the runtime adapter sees.', 'pack');
    await fs.mkdir(runtimeDir, { recursive: true });
  }

  const result = await stager.enable({ root: check.root, pack: pack.manifest, ...(await stagePlan(check, pack, { runtimeDir })), watch: await watchList(check) });
  return { ...result, tier: check.tier };
}

/** Turns Arabic off: removes what enableArabic added. */
async function disableArabic({ root, stager, isRunning }) {
  if (await isRunning?.()) throw new LocalizationError('Close the game first.', 'running');
  return stager.disable(root);
}

/**
 * After a game update (stager.verify): takes GameShelf's files out, keeping
 * everything the update wrote and dropping the originals it made obsolete, so
 * the Arabic can be made again for the new version.
 */
async function retireArabic({ root, stager, isRunning }) {
  if (await isRunning?.()) throw new LocalizationError('Close the game first.', 'running');
  return stager.retire(root);
}

/**
 * The stager for this computer: its records live in the app's data folder.
 * `runtimeHooks` is { 'version.dll': SHA-256, 'dinput8.dll': SHA-256 } of the
 * runtime adapter this copy of GameShelf ships (none: no runtime packs go in).
 */
function createLocalization({ dataDir, runtimeHooks = null }) {
  const stager = createStager({ stateDir: path.join(dataDir, 'localization') });
  return {
    stager,
    preflight,
    runtimeFolder: (root) => runtimeFolder(dataDir, root),
    recover: () => stager.recover(),
    status: (root) => stager.status(root),
    verify: (root) => stager.verify(root),
    retire: (options) => retireArabic({ ...options, stager }),
    enable: (options) => enableArabic({ ...options, stager, runtimeHooks, runtimeDir: runtimeFolder(dataDir, options.root) }),
    disable: (options) => disableArabic({ ...options, stager }),
  };
}

module.exports = {
  preflight, enableArabic, disableArabic, retireArabic, watchList, createLocalization, LocalizationError, StageError, fill, TIER_ENGINES, REPLACING_TIERS, ENGINE_NAMES,
  runtimeCheck, runtimeFolder, runtimeSettings, UNREAL_MODS,
};
