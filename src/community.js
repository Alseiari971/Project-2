// Players helping GameShelf's Arabic:
//
// - Votes: "Request Arabic subtitles" is a vote for a game (one per player,
//   kept in arabic_requests, see src/arabic-games.js), and can be taken back.
//   The leaderboard is the games still without Arabic, most votes first.
// - Translation fixes: a player who meets a wrong or awkward line reports it
//   with better Arabic; it waits in Admin Panel, Translation fixes. Approving
//   one puts it in the shared translation memory as reviewed Arabic, so every
//   later build has it; a game whose approved Arabic is in the catalog then
//   needs a new signed version (src/submissions.js, prepareUpdate), which the
//   admin's desktop app makes in one click.
const { GAME_RE, problemWith, sha256 } = require('./translation-memory');

const MAX_LINE = 2000;
const MAX_NOTE = 500;

class CommunityError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function createCommunity({ db, translations, arabicGames = null, submissions = null }) {
  const q = {
    board: db.prepare(`SELECT r.game, MAX(r.name) AS name, COUNT(*) AS votes, MIN(r.created_at) AS first, MAX(r.created_at) AS last
      FROM arabic_requests r
      WHERE NOT EXISTS (SELECT 1 FROM arabic_sets s WHERE s.game = r.game)
        AND NOT EXISTS (SELECT 1 FROM localization_packs p WHERE p.published = 1
          AND (r.game = 'steam:' || p.steam_app_id OR r.game = 'game:' || p.game_id))
      -- Ties go to the game asked for first (fair, and the same order every time).
      GROUP BY r.game ORDER BY votes DESC, first ASC, MIN(r.rowid) ASC LIMIT ?`),
    voted: db.prepare('SELECT 1 FROM arabic_requests WHERE game = ? AND asker = ?'),
    unvote: db.prepare('DELETE FROM arabic_requests WHERE game = ? AND asker = ?'),
    pendingFix: db.prepare("SELECT id FROM translation_fixes WHERE game = ? AND line_hash = ? AND reported_by = ? AND status = 'pending'"),
    addFix: db.prepare(`INSERT INTO translation_fixes (game, line_hash, english, current, suggestion, note, reported_by)
      VALUES (@game, @hash, @english, @current, @suggestion, @note, @user)`),
    updateFix: db.prepare("UPDATE translation_fixes SET current = @current, suggestion = @suggestion, note = @note, created_at = datetime('now') WHERE id = @id"),
    fix: db.prepare(`SELECT f.*, u.username AS reporter, r.username AS reviewer FROM translation_fixes f
      LEFT JOIN users u ON u.id = f.reported_by LEFT JOIN users r ON r.id = f.reviewed_by WHERE f.id = ?`),
    fixes: db.prepare(`SELECT f.*, u.username AS reporter, r.username AS reviewer,
        (SELECT COUNT(*) FROM translation_fixes o WHERE o.game = f.game AND o.line_hash = f.line_hash AND o.status = 'pending') AS reports,
        (SELECT MAX(name) FROM arabic_requests a WHERE a.game = f.game) AS request_name,
        (SELECT name FROM arabic_games g WHERE g.game = f.game) AS game_name
      FROM translation_fixes f LEFT JOIN users u ON u.id = f.reported_by LEFT JOIN users r ON r.id = f.reviewed_by
      WHERE f.status = ? ORDER BY f.created_at DESC, f.id DESC LIMIT ?`),
    review: db.prepare("UPDATE translation_fixes SET status = ?, suggestion = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"),
    // Other players' reports of the same line are settled with it.
    settleOthers: db.prepare("UPDATE translation_fixes SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE game = ? AND line_hash = ? AND status = 'pending' AND id <> ?"),
  };

  function checkGame(game) {
    if (!GAME_RE.test(String(game))) throw new CommunityError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  }

  /** The games still without Arabic, most votes first: [{ rank, game, name, votes, voted, steamAppId, status, recipe }]. */
  function leaderboard(asker = null, limit = 50) {
    return q.board.all(Math.min(200, Math.max(1, Number(limit) || 50))).map((row, i) => {
      const [kind, id] = row.game.split(':');
      const status = arabicGames ? arabicGames.status(row.game) : {};
      return {
        rank: i + 1,
        game: row.game,
        name: row.name || row.game,
        votes: row.votes,
        voted: Boolean(asker && q.voted.get(row.game, asker.key)),
        steamAppId: kind === 'steam' ? Number(id) : null,
        // Partly translated already, waiting for an admin, or waiting for an engine recipe.
        progress: status.total ? Math.round((status.translated / status.total) * 100) : 0,
        pending: Boolean(status.pending),
        recipe: Boolean(status.recipe),
        last: row.last,
      };
    });
  }

  /** A player takes their vote for a game back. Returns the game's status. */
  function unvote(asker, game) {
    checkGame(game);
    q.unvote.run(String(game), asker.key);
    return arabicGames ? arabicGames.status(String(game), asker) : {};
  }

  const text = (value, max) => (typeof value === 'string' ? value.trim() : '').slice(0, max);

  /**
   * A player's better Arabic for a line: { game, english, current, suggestion, note }.
   * One waiting report per player and line (a newer one replaces it). Returns { id }.
   */
  function reportFix(user, body = {}) {
    const game = String(body.game || '');
    checkGame(game);
    const english = text(body.english, MAX_LINE);
    const suggestion = text(body.suggestion, MAX_LINE);
    const current = text(body.current, MAX_LINE);
    if (!english) throw new CommunityError('Say which English line it is.');
    if (!suggestion) throw new CommunityError('Write the Arabic you suggest.');
    if (suggestion === current) throw new CommunityError('The suggestion is the same as the Arabic the game has.');
    const problem = problemWith(english, suggestion);
    if (problem) throw new CommunityError(`That Arabic can't be used: ${problem}.`);
    const row = { game, hash: sha256(english), english, current, suggestion, note: text(body.note, MAX_NOTE), user: user.id };
    const pending = q.pendingFix.get(game, row.hash, user.id);
    if (pending) {
      q.updateFix.run({ current: row.current, suggestion: row.suggestion, note: row.note, id: pending.id });
      return { id: pending.id, updated: true };
    }
    return { id: Number(q.addFix.run(row).lastInsertRowid), updated: false };
  }

  const summary = (row) => ({
    id: row.id,
    game: row.game,
    name: row.game_name || row.request_name || row.game,
    english: row.english,
    current: row.current,
    suggestion: row.suggestion,
    note: row.note,
    status: row.status,
    reporter: row.reporter || null,
    reviewer: row.reviewer || null,
    reports: row.reports ?? 1,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  });

  /** Reports for admins: { fixes, published: { game: true } (games whose approved Arabic would need a new version) }. */
  function fixes({ status = 'pending', limit = 200 } = {}) {
    const list = q.fixes.all(['pending', 'approved', 'rejected'].includes(status) ? status : 'pending', Math.min(500, Number(limit) || 200)).map(summary);
    const published = Object.fromEntries([...new Set(list.map((f) => f.game))].map((g) => [g, Boolean(submissions?.published(g))]));
    return { fixes: list, published };
  }

  function load(id) {
    const row = q.fix.get(Number(id));
    if (!row) throw new CommunityError('That report isn\'t there.', 404);
    if (row.status !== 'pending') throw new CommunityError('That report was already looked at.', 409);
    return row;
  }

  /**
   * Approves a report (with the admin's own wording, if given): the Arabic goes
   * into the shared memory as reviewed. Returns { fix, republish }: republish is
   * true when the game's approved Arabic needs a new signed version to reach players.
   */
  function approveFix(id, reviewer, arabic = null) {
    const row = load(id);
    const final = text(arabic, MAX_LINE) || row.suggestion;
    try {
      translations.review(row.game, row.english, final);
    } catch (err) {
      if (err instanceof TypeError) throw new CommunityError(err.message);
      throw err;
    }
    q.review.run('approved', final, reviewer.id, row.id);
    q.settleOthers.run('approved', reviewer.id, row.game, row.line_hash, row.id);
    return { fix: summary(q.fix.get(row.id)), republish: Boolean(submissions?.published(row.game)) };
  }

  function rejectFix(id, reviewer) {
    const row = load(id);
    q.review.run('rejected', row.suggestion, reviewer.id, row.id);
    return { fix: summary(q.fix.get(row.id)) };
  }

  return { leaderboard, unvote, reportFix, fixes, approveFix, rejectFix };
}

module.exports = { createCommunity, CommunityError };
