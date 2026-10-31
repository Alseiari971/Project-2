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
// When this PC can't read the game (an engine GameShelf can't patch here, or
// encrypted files), the request goes to the admins with the reason instead.
const fs = require('node:fs/promises');
const path = require('node:path');
const { gameKey } = require('./online');

// Most of a game's lines must have Arabic before its pack goes in.
const ENOUGH_ARABIC = 0.9;

/** `server()` is GameShelf's server, where the shared translations are. */
function createArabicRequests({ arabic, packBuilder, online, server }) {
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
      if (serverKey) await online.request(serverKey, game.title, reason).catch(() => {});
      return { done: false, requested: true, reason, info: before };
    };
    if (!packBuilder.canBuild(before.tier)) {
      return askAdmins(before.tier
        ? 'GameShelf can\'t read this kind of game on players\' PCs yet.'
        : 'GameShelf can\'t add Arabic to this game\'s files (its engine, or anti-cheat).');
    }
    let auth;
    try {
      auth = await online.builderEnv();
    } catch (err) {
      return { done: false, info: before, error: { text: err.message, vars: {} } };
    }

    let result;
    try {
      result = await packBuilder.build({ ...game, tier: before.tier }, { server: server(), auth, onProgress });
    } catch (err) {
      // The game's files couldn't be read here (encrypted, say): the admins hear about it.
      if (/encrypted|couldn't read|can't read|no text|no english|found no/i.test(err.message)) return askAdmins(err.message);
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

  return { run };
}

module.exports = { createArabicRequests, ENOUGH_ARABIC };
