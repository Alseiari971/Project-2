// Which games have Arabic subtitles ready on this server, and which players
// are asking for.
//
// - A game is "ready" when the shared translation memory (translation-memory.js)
//   holds nearly all its lines. How many lines a game has comes from the pack
//   builds that report it (the desktop app's, or the pack builder's --shared);
//   how many are translated is counted here, from the memory itself.
// - Players ask for a game with "Request Arabic subtitles"; each asker counts once.
// - The font files a game's Arabic patch replaces (RE Engine games keep theirs
//   as .oft files the patch puts the Arabic font in place of) are kept per game,
//   so the desktop app can build the patch without a list of the game's files.
//   Only admins (ARABIC_ADMINS, usernames, comma separated) can set them.
const { GAME_RE } = require('./translation-memory');

const READY = 0.95;
const MAX_FONT_TARGETS = 300;
const FONT_TARGET_RE = /^natives\/[\w\-./]{1,200}\.oft\.\d{1,3}$/i;

function createArabicGames({ db, translations, env = process.env }) {
  const admins = new Set(String(env.ARABIC_ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const getGame = db.prepare('SELECT * FROM arabic_games WHERE game = ?');
  const countRequests = db.prepare('SELECT COUNT(*) AS n FROM arabic_requests WHERE game = ?');
  const askedBy = db.prepare('SELECT 1 FROM arabic_requests WHERE game = ? AND asker = ?');
  const addRequest = db.prepare('INSERT INTO arabic_requests (game, asker, name) VALUES (?, ?, ?) ON CONFLICT (game, asker) DO NOTHING');
  const saveGame = db.prepare(`INSERT INTO arabic_games (game, name, engine, total_lines) VALUES (?, ?, ?, ?)
    ON CONFLICT (game) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
      engine = excluded.engine, total_lines = excluded.total_lines, updated_at = datetime('now')`);
  const saveFonts = db.prepare("UPDATE arabic_games SET font_targets = ?, updated_at = datetime('now') WHERE game = ?");

  function checkGame(game) {
    if (!GAME_RE.test(String(game))) throw new TypeError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  }

  const isAdmin = (user) => Boolean(user && admins.has(String(user.username).toLowerCase()));

  /** { status: 'ready' | 'partial' | 'none', total, translated, requests, asked, fontTargets } for one game. */
  function status(game, asker) {
    checkGame(game);
    const row = getGame.get(game);
    const total = row?.total_lines || 0;
    const translated = Math.min(translations ? translations.stored(game) : 0, total || Infinity);
    const state = total && translated >= total * READY ? 'ready' : translated ? 'partial' : 'none';
    return {
      status: state,
      total,
      translated: Number.isFinite(translated) ? translated : 0,
      requests: countRequests.get(game).n,
      asked: Boolean(asker && askedBy.get(game, asker.key)),
      fontTargets: row ? JSON.parse(row.font_targets) : [],
    };
  }

  /** A player asks for Arabic in a game. Returns the game's status. */
  function request(asker, game, name = '') {
    checkGame(game);
    addRequest.run(game, asker.key, String(name).slice(0, 200));
    return status(game, asker);
  }

  /**
   * A pack build tells how many lines the game has. Font targets are kept only
   * from admins, and only names shaped like RE Engine font files.
   */
  function report(asker, { game, name = '', engine = '', total, fontTargets } = {}, user = null) {
    checkGame(game);
    const lines = Math.trunc(Number(total));
    if (!Number.isFinite(lines) || lines < 1 || lines > 2_000_000) throw new TypeError('total should be how many lines the game has.');
    saveGame.run(game, String(name).slice(0, 200), String(engine).slice(0, 40), lines);
    if (Array.isArray(fontTargets) && fontTargets.length && isAdmin(user)) {
      const targets = [...new Set(fontTargets.map(String))].filter((t) => FONT_TARGET_RE.test(t) && !t.includes('..')).slice(0, MAX_FONT_TARGETS);
      if (targets.length) saveFonts.run(JSON.stringify(targets.sort()), game);
    }
    return status(game, asker);
  }

  /** The most asked-for games, for admins. */
  function requests(limit = 100) {
    return db.prepare(`SELECT r.game, MAX(r.name) AS name, COUNT(*) AS requests, MIN(r.created_at) AS first, MAX(r.created_at) AS last
      FROM arabic_requests r GROUP BY r.game ORDER BY requests DESC, last DESC LIMIT ?`).all(limit)
      .map((r) => ({ ...r, ...status(r.game) }));
  }

  return { status, request, report, requests, isAdmin };
}

module.exports = { createArabicGames, READY };
