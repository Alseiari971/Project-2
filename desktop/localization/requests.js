// "Request Arabic subtitles" for a game GameShelf has no approved Arabic for,
// after the player agrees to it:
//
// 1. Reading the game's text: the pack builder reads the English from the
//    player's own copy of the game (and finds its font files).
// 2. Translating to Arabic: GameShelf's server translates the lines it doesn't
//    have yet, with its own AI provider, so the player needs no key.
// 3. Building the pack and submitting it for review: the patch is built on this
//    PC and switched on, so the player can play in Arabic straight away; then
//    the English lines, the engine and the font names go to GameShelf as a
//    submission, for an admin to check and approve for every player.
//
// When this PC can't read the game (encrypted files, or a game whose text is
// packed in archives and has no engine recipe yet), the request goes to the
// admins with the reason and the game folder's fingerprint (dirprint.js), so an
// admin can write the game's engine recipe without owning the game. Once a
// recipe is signed and attached, the same button makes the Arabic natively.
//
// The runtime adapter ('native-runtime', see index.js) goes into Steam, Epic,
// GOG and other games alike, once the anti-cheat scan (anticheat.js, which runs
// before any tier is picked) found nothing in the game's folder; never into a
// game Steam lists as played only online (no single-player), or as protected by
// Valve Anti-Cheat. A game with no readable English gets the adapter with an
// empty table first: it notes the game's text as it's played, and the next
// press of the button translates what it saw.
//
// Unreal games whose .pak/.utoc files are encrypted are read with the game's
// key only when an admin attached one in a signed key recipe (recipes.js):
// GameShelf never looks for keys. Without one, the request goes to the admins.
const fs = require('node:fs/promises');
const path = require('node:path');
const { gameKey } = require('./online');
const { aesKeyOf } = require('./recipes');

// Most of a game's lines must have Arabic before its pack goes in.
const ENOUGH_ARABIC = 0.9;
const NEEDS_RECIPE = 'This game keeps its text packed in its own files, and GameShelf has no engine recipe for it yet.';
// Steam features of games played online: one with these and no single-player is online-only.
const ONLINE_FEATURES = ['Multi-player', 'Online PvP', 'Online Co-op', 'Cross-Platform Multiplayer', 'MMO'];
const VAC = 'Valve Anti-Cheat enabled';

/**
 * Whether the runtime adapter may go into a game: { ok, why, checked }. The game's
 * folder has already been scanned for anti-cheat (no tier is picked otherwise);
 * Steam's store page, when there is one and it can be had, also rules out games
 * played only online and games with Valve Anti-Cheat. Epic, GOG and other games
 * have no store page to ask, so the folder scan is the check.
 */
async function playedAlone(online, game) {
  if (!game.steamAppId) return { ok: true, why: null, checked: false };
  const features = await online.features?.(game.steamAppId).catch(() => null);
  if (!features) return { ok: true, why: null, checked: false };
  if (features.includes(VAC)) return { ok: false, why: 'This game uses Valve Anti-Cheat, so GameShelf won\'t run its adapter in it.', checked: true };
  if (!features.includes('Single-player') && features.some((f) => ONLINE_FEATURES.includes(f))) {
    return { ok: false, why: 'This game is only played online, so GameShelf won\'t run its adapter in it.', checked: true };
  }
  return { ok: true, why: null, checked: true };
}

/** An encrypted Unreal game's key, from its admin-signed key recipe, or null (none, or it can't be had now). */
async function unrealKey(recipes, serverKey) {
  if (!recipes || !serverKey) return null;
  const found = await recipes.forGame(serverKey).catch(() => null);
  return aesKeyOf(found?.recipe);
}

/**
 * Why this PC can't make Arabic for a game (`info` from the Arabic service), or
 * null when it can. Games whose files can't change get the overlay instead,
 * which needs Windows' text recognition and a way to read the game's text.
 */
function cantMake(info, packBuilder, overlayAvailable) {
  if (info.tier === 'overlay' && !overlayAvailable) return 'The subtitle overlay needs Windows 10 or newer.';
  if (packBuilder.canBuild(info.tier, info.engine)) return null;
  if (!info.engine || info.engine === 'custom') return 'GameShelf can\'t read this game\'s text: it doesn\'t know the game\'s engine.';
  return 'This copy of GameShelf can\'t read this kind of game\'s text yet.';
}

/**
 * `server()` is GameShelf's server, where the shared translations are; `recipes`
 * fetches games' signed engine recipes (recipes.js); `fingerprint(game, info)`
 * describes a game's folder for the admins (dirprint.js).
 */
function createArabicRequests({ arabic, packBuilder, online, server, recipes = null, fingerprint = null, overlayAvailable = process.platform === 'win32' }) {
  /** Asks the admins for Arabic in a game, with why this PC can't make it and the folder's fingerprint. Resolves to the game's status. */
  async function ask(game, reason = '', info = null) {
    const serverKey = gameKey(game);
    if (!serverKey) throw new Error('GameShelf doesn\'t know which game this is, so it can\'t ask for it.');
    const print = reason && fingerprint && game.dir ? await fingerprint(game, info).catch(() => null) : null;
    return online.request(serverKey, game.title, reason, print);
  }

  /**
   * `game` is { key, dir, steamAppId, gameId, title }. Resolves to one of:
   * - { done: true, info, submitted }: Arabic is on here, and sent for review (submitted: { id, total } or null);
   * - { done: false, partial: true, result }: not enough lines translated yet (the server's limit, say);
   * - { done: false, requested: true, reason }: this PC can't make it; the admins were asked;
   * - { done: false, error }.
   */
  async function run(game, { consent = false, onProgress = () => {} } = {}) {
    if (!consent) return { done: false, needsConsent: true };
    const serverKey = gameKey(game);
    const before = await arabic.info(game);
    // A game with the runtime adapter in: new lines it saw while the game was played get their Arabic too.
    const refresh = before.tier === 'native-runtime' && before.mode === 'native' && before.runtime?.newLines > 0;
    if (!before.missing && !refresh) return { done: true, info: before, submitted: null };
    const askAdmins = async (reason) => {
      if (serverKey) await ask(game, reason, before).catch(() => {});
      return { done: false, requested: true, reason, info: before };
    };
    const cant = cantMake(before, packBuilder, overlayAvailable);
    if (cant) return askAdmins(cant);
    const runtime = before.tier === 'native-runtime';
    if (runtime) {
      const alone = await playedAlone(online, game);
      if (!alone.ok) return askAdmins(alone.why);
    }
    // Packed text: the game's engine recipe, signed by an admin, says how to read it.
    let recipe = null;
    if (before.tier === 'recipe') {
      if (!recipes || !serverKey) return askAdmins(NEEDS_RECIPE);
      try {
        recipe = await recipes.forGame(serverKey);
      } catch (err) {
        return { done: false, info: before, error: { text: err.message, vars: {} } };
      }
      if (!recipe) return askAdmins(NEEDS_RECIPE);
    }
    const aesKey = before.tier === 'unreal-pak' ? await unrealKey(recipes, serverKey) : null;
    let auth;
    try {
      auth = await online.builderEnv();
    } catch (err) {
      return { done: false, info: before, error: { text: err.message, vars: {} } };
    }

    let result;
    try {
      const seen = runtime && before.runtime?.newLines > 0 ? before.runtime.dump : null;
      result = await packBuilder.build({
        ...game, tier: before.tier, engine: before.engine, recipe: recipe?.file, proxy: before.runtime?.proxy, extraLines: seen, aesKey,
      }, { server: server(), auth, onProgress, fontStyle: (await arabic.fontFor?.(game)) || null });
      // What the adapter saw is in this build now; it starts a new list as the game is played again.
      if (seen) await fs.rename(seen, seen.replace(/\.txt$/, '.sent.txt')).catch(() => {});
    } catch (err) {
      // The game's files couldn't be read here (encrypted, say): the admins hear about it.
      if (/encrypted|couldn't read|can't read|no text|no english|found no|engine recipe|recipe found/i.test(err.message)) return askAdmins(err.message);
      return { done: false, info: before, error: { text: err.message, vars: {} } };
    }
    const have = result.total ? (result.total - result.missing) / result.total : 0;
    // The runtime adapter goes in with what there is (even nothing yet): lines without Arabic stay in English, and
    // it notes them as the game is played.
    const learning = runtime && !result.total;
    if (have < ENOUGH_ARABIC && !runtime) return { done: false, partial: true, result, info: before };

    // Playable here straight away, with this PC's own signature.
    await arabic.packs.add(result.packDir);
    const { info, error } = await arabic.set(game, true);

    if (learning) return { done: true, learning: true, result, info, error, submitted: null };

    // Then off to GameShelf for review.
    onProgress({ ...result, phase: 'submitting' });
    let submitted = null;
    if (!serverKey) return { done: true, result, info, error, submitted };
    try {
      const english = JSON.parse(await fs.readFile(path.join(result.out, 'english.json'), 'utf8'));
      const buildInfo = result.info || {};
      submitted = await online.submit({
        game: serverKey,
        name: game.title,
        engine: buildInfo.engine,
        fontTargets: buildInfo.fontTargets || [],
        lines: english,
      });
    } catch (err) {
      submitted = { error: err.message };
    }
    return { done: true, result, info, error, submitted };
  }

  return { run, ask };
}

module.exports = { createArabicRequests, cantMake, playedAlone, unrealKey, ENOUGH_ARABIC, NEEDS_RECIPE, ONLINE_FEATURES, VAC };
