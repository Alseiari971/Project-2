// Social proof for a game's Arabic: how many lines are in Arabic, how many
// times its pack was downloaded, and its players' star rating. The numbers are
// kept on arabic_games (strings_count, downloads_count, rating_sum,
// rating_count) and worked out again from the source tables whenever they
// change, so they never drift. Only a player who has the game's Arabic (they
// downloaded its pack or set, or made it on their PC) can rate it.
const { GAME_RE } = require('./translation-memory');

class StatsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The packs and Arabic sets that belong to a game ("steam:<id>" or "game:<id>").
const PACKS_OF = `(SELECT p.id FROM localization_packs p WHERE (:kind = 'steam' AND p.steam_app_id = :num) OR (:kind = 'game' AND p.game_id = :id)
  UNION SELECT s.id FROM arabic_sets s WHERE s.game = :game)`;

function createPackStats({ db, translations = null }) {
  const q = {
    ensure: db.prepare("INSERT INTO arabic_games (game) VALUES (?) ON CONFLICT (game) DO NOTHING"),
    row: db.prepare('SELECT * FROM arabic_games WHERE game = ?'),
    downloads: db.prepare(`SELECT COUNT(*) AS n FROM pack_downloads WHERE pack_id IN ${PACKS_OF}`),
    hasArabic: db.prepare(`SELECT EXISTS (SELECT 1 FROM pack_downloads WHERE user_id = :user AND pack_id IN ${PACKS_OF})
      OR EXISTS (SELECT 1 FROM arabic_submissions WHERE game = :game AND submitted_by = :user) AS ok`),
    lastSet: db.prepare("SELECT body FROM arabic_sets WHERE game = ? ORDER BY created_at DESC LIMIT 1"),
    ratings: db.prepare('SELECT COALESCE(SUM(stars), 0) AS sum, COUNT(*) AS n FROM pack_ratings WHERE game = ?'),
    mine: db.prepare('SELECT stars FROM pack_ratings WHERE game = ? AND user_id = ?'),
    rate: db.prepare(`INSERT INTO pack_ratings (game, user_id, stars) VALUES (?, ?, ?)
      ON CONFLICT (game, user_id) DO UPDATE SET stars = excluded.stars, updated_at = datetime('now')`),
    save: db.prepare('UPDATE arabic_games SET strings_count = ?, downloads_count = ?, rating_sum = ?, rating_count = ? WHERE game = ?'),
    // Games with Arabic out: a published pack or an approved set.
    live: db.prepare(`SELECT g.game, g.name, g.strings_count, g.downloads_count, g.rating_sum, g.rating_count FROM arabic_games g
      WHERE EXISTS (SELECT 1 FROM arabic_sets s WHERE s.game = g.game)
        OR EXISTS (SELECT 1 FROM localization_packs p WHERE p.published = 1 AND (('steam:' || p.steam_app_id) = g.game OR ('game:' || p.game_id) = g.game))
      ORDER BY g.downloads_count DESC, g.strings_count DESC, g.updated_at DESC LIMIT ?`),
    packGames: db.prepare(`SELECT DISTINCT CASE WHEN steam_app_id IS NOT NULL THEN 'steam:' || steam_app_id ELSE 'game:' || game_id END AS game
      FROM localization_packs WHERE published = 1 AND (steam_app_id IS NOT NULL OR game_id IS NOT NULL)`),
  };

  const params = (game, extra = {}) => {
    const [kind, id] = String(game).split(':');
    return { kind, id, num: kind === 'steam' ? Number(id) : -1, game: String(game), ...extra };
  };
  const check = (game) => {
    if (!GAME_RE.test(String(game))) throw new StatsError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  };

  /** How many lines of the game have Arabic: its newest approved set, or the shared memory. */
  function strings(game) {
    const set = q.lastSet.get(game);
    if (set) {
      try {
        // A set's lines are [hash, Arabic] pairs.
        const n = (JSON.parse(set.body).lines || []).filter((l) => Array.isArray(l) && l[1]).length;
        if (n) return n;
      } catch {}
    }
    return translations?.stored ? translations.stored(game) : 0;
  }

  /** Works the game's numbers out again from the source tables and keeps them. */
  function refresh(game) {
    check(game);
    q.ensure.run(String(game));
    const r = q.ratings.get(String(game));
    q.save.run(strings(String(game)), q.downloads.get(params(game)).n, r.sum, r.n, String(game));
  }

  const shape = (row, userId = null) => ({
    strings: row?.strings_count || 0,
    downloads: row?.downloads_count || 0,
    rating: row?.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : null,
    ratings: row?.rating_count || 0,
  });

  /** A game's numbers, and for a signed-in player their own stars and whether they can rate. */
  function forGame(game, userId = null) {
    check(game);
    const out = shape(q.row.get(String(game)));
    if (userId) {
      out.mine = q.mine.get(String(game), userId)?.stars ?? null;
      out.canRate = Boolean(q.hasArabic.get(params(game, { user: userId })).ok);
    }
    return out;
  }

  /** A player who has the game's Arabic gives it 1 to 5 stars (again to change them). */
  function rate(user, game, stars) {
    check(game);
    const n = Number(stars);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new StatsError('Give 1 to 5 stars.');
    if (!q.hasArabic.get(params(game, { user: user.id })).ok) throw new StatsError('Only players who have this game\'s Arabic can rate it.', 403);
    q.ensure.run(String(game));
    q.rate.run(String(game), user.id, n);
    refresh(game);
    return forGame(game, user.id);
  }

  /** Games whose Arabic is out, most downloaded first, with their numbers (the showcase). */
  function live(limit = 12) {
    for (const { game } of q.packGames.all()) if (GAME_RE.test(game)) q.ensure.run(game);
    return q.live.all(Math.min(Math.max(Number(limit) || 12, 1), 48)).map((row) => ({ game: row.game, name: row.name, ...shape(row) }));
  }

  return { refresh, forGame, rate, live, strings };
}

module.exports = { createPackStats, StatsError };
