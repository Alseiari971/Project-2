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
const fs = require('node:fs/promises');
const path = require('node:path');
const { gameKey } = require('./online');

// Most of a game's lines must have Arabic before its pack goes in.
const ENOUGH_ARABIC = 0.9;
const NEEDS_RECIPE = 'This game keeps its text packed in its own files, and GameShelf has no engine recipe for it yet.';

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
    if (!before.missing) return { done: true, info: before, submitted: null };
    const askAdmins = async (reason) => {
      if (serverKey) await ask(game, reason, before).catch(() => {});
      return { done: false, requested: true, reason, info: before };
    };
    const cant = cantMake(before, packBuilder, overlayAvailable);
    if (cant) return askAdmins(cant);
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
    let auth;
    try {
      auth = await online.builderEnv();
    } catch (err) {
      return { done: false, info: before, error: { text: err.message, vars: {} } };
    }

    let result;
    try {
      result = await packBuilder.build({ ...game, tier: before.tier, engine: before.engine, recipe: recipe?.file }, { server: server(), auth, onProgress });
    } catch (err) {
      // The game's files couldn't be read here (encrypted, say): the admins hear about it.
      if (/encrypted|couldn't read|can't read|no text|no english|found no|engine recipe|recipe found/i.test(err.message)) return askAdmins(err.message);
      return { done: false, info: before, error: { text: err.message, vars: {} } };
    }
    const have = result.total ? (result.total - result.missing) / result.total : 0;
    if (have < ENOUGH_ARABIC) return { done: false, partial: true, result, info: before };

    // Playable here straight away, with this PC's own signature.
    await arabic.packs.add(result.packDir);
    const { info, error } = await arabic.set(game, true);

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

module.exports = { createArabicRequests, cantMake, ENOUGH_ARABIC, NEEDS_RECIPE };
