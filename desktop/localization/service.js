// The "Arabic subtitles" switch next to Play: which way a game can get Arabic,
// whether the player turned it on, and getting it ready when they press Play.
//
// Modes:
// - 'native'      the game's engine takes an added patch (Unreal pak, Unity
//                 mod, RE Engine patch file, Ren'Py translation, Godot
//                 override) and there's a signed pack for it;
// - 'overlay'     otherwise, when there's a signed overlay pack (anti-cheat,
//                 signed paks and custom engines all end up here);
// - 'unavailable' no pack for this game, or no way to use it here.
//
// Messages come as { text, vars } so the page can translate them.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createMatcher } = require('./fingerprint');
const { createLocalization, fill, TIER_ENGINES } = require('./index');
const { createPackLibrary } = require('./library');
const { OVERLAY_STYLES, DEFAULT_STYLE } = require('./overlay-manager');

const PREFLIGHT_TTL_MS = 60 * 1000;

const why = (text, vars = {}) => ({ text, vars });

function createArabicService({ dataDir, publicKey, overlayAvailable = process.platform === 'win32', localization, packs }) {
  localization ??= createLocalization({ dataDir });
  packs ??= createPackLibrary({ dir: path.join(dataDir, 'localization', 'packs'), publicKey });
  const prefsFile = path.join(dataDir, 'localization', 'arabic.json');
  const overlayFile = path.join(dataDir, 'localization', 'overlay.json');
  const checks = new Map(); // game folder -> { at, result }

  async function readPrefs() {
    try {
      return JSON.parse(await fs.readFile(prefsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async function savePref(key, on) {
    const prefs = await readPrefs();
    if (on) prefs[key] = true;
    else delete prefs[key];
    await fs.mkdir(path.dirname(prefsFile), { recursive: true });
    await fs.writeFile(prefsFile, JSON.stringify(prefs, null, 1));
  }

  async function check(game, staged) {
    const hit = checks.get(game.dir);
    if (hit && Date.now() - hit.at < PREFLIGHT_TTL_MS && hit.staged === staged) return hit.result;
    const result = await localization.preflight(game.dir, { steamAppId: game.steamAppId, ownMods: staged });
    checks.set(game.dir, { at: Date.now(), staged, result });
    return result;
  }

  /**
   * How this game can get Arabic: { mode, why, detail, enabled, staged, pack }.
   * `game` is { key, dir, steamAppId, gameId }.
   */
  async function info(game) {
    const prefs = await readPrefs();
    const staged = (await localization.status(game.dir).catch(() => null))?.status === 'enabled';
    const base = { mode: 'unavailable', why: null, detail: null, enabled: false, staged, pack: null };
    if (![].concat(publicKey || []).some(Boolean)) return { ...base, why: why('Arabic packs aren\'t set up in this copy of GameShelf.') };
    if (!game.dir) return { ...base, why: why('GameShelf doesn\'t know where this game is installed.') };

    const found = await packs.forGame(game);
    let result;
    try {
      result = await check(game, staged);
    } catch {
      return { ...base, why: why('GameShelf couldn\'t look inside this game\'s folder.') };
    }
    const summary = (p) => ({ id: p.id, version: p.version, engine: p.engine, title: p.title });
    const native = result.fileChanges && found.find((p) => p.engine === TIER_ENGINES[result.tier]);
    const overlayPack = found.find((p) => p.engine === 'overlay');
    let out;
    if (native) {
      out = { ...base, mode: 'native', pack: summary(native) };
    } else if (overlayPack && overlayAvailable) {
      out = { ...base, mode: 'overlay', pack: summary(overlayPack), detail: result.why };
    } else if (overlayPack) {
      out = { ...base, why: why('The subtitle overlay needs Windows 10 or newer.') };
    } else if (found.length) {
      // There's a patch for this game, but it can't go in: say why.
      out = { ...base, why: result.why || why('There\'s no Arabic pack for this version of the game.') };
    } else {
      // Nothing on this PC yet: the app can get it from GameShelf's server (see online.js and builder.js).
      out = { ...base, missing: true, tier: result.fileChanges ? result.tier : null, why: why('There\'s no Arabic pack for this game yet.') };
    }
    return { ...out, enabled: out.mode !== 'unavailable' && prefs[game.key] === true };
  }

  /**
   * Turns the switch on or off. Returns { info, error }: error is { text, vars }
   * when it couldn't be done. Turning off takes the patch back out (the game
   * must be closed); turning on checks the pack straight away.
   */
  async function set(game, on, { isRunning } = {}) {
    const now = await info(game);
    if (on) {
      if (now.mode === 'unavailable') return { info: now, error: now.why };
      try {
        await packs.verify(now.pack.id);
      } catch (err) {
        return { info: now, error: why(err.message) };
      }
      await savePref(game.key, true);
    } else {
      if (now.staged) {
        if (await isRunning?.()) return { info: now, error: why('Close the game first.') };
        try {
          const result = await localization.disable({ root: game.dir });
          checks.delete(game.dir);
          if (result.kept.length) {
            await savePref(game.key, false);
            return { info: await info(game), error: why('Arabic is off. GameShelf left {count} files that were changed or added after it.', { count: result.kept.length }) };
          }
        } catch (err) {
          if (err.code === 'chain') {
            // Arabic stays in (and the switch stays on) until the newer patch file is gone.
            return { info: now, error: why('Arabic can\'t come out yet: {name} was added to the game after it, and the game would stop loading {name} without it. Take {name} out first.', { name: err.details[0].after }) };
          }
          return { info: now, error: why(err.message) };
        }
      }
      await savePref(game.key, false);
    }
    return { info: await info(game), error: null };
  }

  /**
   * Called when Play is pressed, before the game starts. For a native patch,
   * adds the pack's files (if they aren't in yet); for the overlay, checks the
   * pack and loads its table. Returns { mode, ok, error, matcher, profile }.
   */
  async function prepareLaunch(game) {
    const prefs = await readPrefs();
    if (prefs[game.key] !== true) return { mode: 'off', ok: true };
    const now = await info(game);
    try {
      if (now.mode === 'native') {
        const pack = (await packs.list()).find((p) => p.id === now.pack.id);
        await localization.enable({ root: game.dir, packDir: pack.dir, publicKey, steamAppId: game.steamAppId });
        checks.delete(game.dir);
        return { mode: 'native', ok: true };
      }
      if (now.mode === 'overlay') {
        const pack = await packs.verify(now.pack.id);
        const table = pack.files.find((f) => f.target.toLowerCase() === 'fingerprints.json');
        const matcher = createMatcher(JSON.parse(await fs.readFile(table.source, 'utf8')), pack.manifest.overlay?.threshold ? { threshold: pack.manifest.overlay.threshold } : {});
        return { mode: 'overlay', ok: true, matcher, profile: pack.manifest.overlay || {} };
      }
      return { mode: 'unavailable', ok: false, error: now.why };
    } catch (err) {
      return { mode: now.mode, ok: false, error: why(err.message) };
    }
  }

  /** How the overlay looks, for every game: 'floating' (outlined text, no box, the default) or 'box'. */
  async function overlayStyle() {
    try {
      const { style } = JSON.parse(await fs.readFile(overlayFile, 'utf8'));
      return OVERLAY_STYLES.includes(style) ? style : DEFAULT_STYLE;
    } catch {
      return DEFAULT_STYLE;
    }
  }

  async function setOverlayStyle(style) {
    if (!OVERLAY_STYLES.includes(style)) throw new Error(`Unknown overlay style "${style}".`);
    await fs.mkdir(path.dirname(overlayFile), { recursive: true });
    await fs.writeFile(overlayFile, JSON.stringify({ style }));
    return style;
  }

  return { info, set, prepareLaunch, overlayStyle, setOverlayStyle, packs, localization, recover: () => localization.recover(), fill };
}

module.exports = { createArabicService };
