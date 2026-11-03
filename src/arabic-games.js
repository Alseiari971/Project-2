// Which games have Arabic subtitles ready on this server, and which players
// are asking for.
//
// - A game is "ready" when the shared translation memory (translation-memory.js)
//   holds nearly all its lines. How many lines a game has comes from the pack
//   builds that report it (the desktop app's, or the pack builder's --shared);
//   how many are translated is counted here, from the memory itself.
// - Players ask for a game with "Request Arabic subtitles"; each asker counts once.
//   When their PC can't make the Arabic, the request says why, with the game
//   folder's fingerprint (names, file kinds and sizes), so an admin can write
//   the game's engine recipe (src/engine-recipes.js) without owning the game.
// - The font files a game's Arabic patch replaces (RE Engine games keep theirs
//   as .oft files the patch puts the Arabic font in place of) are kept per game,
//   so the desktop app can build the patch without a list of the game's files.
//   Only admins (users.role, see src/roles.js) can set them.
const { GAME_RE } = require('./translation-memory');

const READY = 0.95;
const MAX_FINGERPRINT_CHARS = 64 * 1024;
const MAX_FONT_TARGETS = 300;
// name.oft.1, and the copies games keep beside it (name.oft.1.stm, name.oft.1.x64).
const FONT_TARGET_RE = /^natives\/[\w\-./]{1,200}\.oft(?:\.\d{1,3})?(?:\.(?:stm|x64))?$/i;

function createArabicGames({ db, translations }) {
  const getGame = db.prepare('SELECT * FROM arabic_games WHERE game = ?');
  const countRequests = db.prepare('SELECT COUNT(*) AS n FROM arabic_requests WHERE game = ?');
  const askedBy = db.prepare('SELECT 1 FROM arabic_requests WHERE game = ? AND asker = ?');
  const pendingFor = db.prepare("SELECT 1 FROM arabic_submissions WHERE game = ? AND status = 'pending'");
  const addRequest = db.prepare(`INSERT INTO arabic_requests (game, asker, name, reason, fingerprint) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (game, asker) DO UPDATE SET reason = CASE WHEN excluded.reason <> '' THEN excluded.reason ELSE reason END,
      fingerprint = CASE WHEN excluded.fingerprint <> '' THEN excluded.fingerprint ELSE fingerprint END`);
  const hasRecipe = db.prepare('SELECT 1 FROM engine_recipes WHERE game = ?');
  const saveGame = db.prepare(`INSERT INTO arabic_games (game, name, engine, total_lines) VALUES (?, ?, ?, ?)
    ON CONFLICT (game) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
      engine = excluded.engine, total_lines = excluded.total_lines, updated_at = datetime('now')`);
  const saveFonts = db.prepare("UPDATE arabic_games SET font_targets = ?, updated_at = datetime('now') WHERE game = ?");

  function checkGame(game) {
    if (!GAME_RE.test(String(game))) throw new TypeError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  }

  const isAdmin = (user) => user?.role === 'admin';

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
      // A player's Arabic for it is waiting for an admin.
      pending: Boolean(pendingFor.get(game)),
      // An admin attached an engine recipe: players' apps can read its packed text.
      recipe: Boolean(hasRecipe.get(game)),
      fontTargets: row ? JSON.parse(row.font_targets) : [],
    };
  }

  /**
   * A player asks for Arabic in a game; `reason` says why their PC couldn't make
   * it, and `fingerprint` what's in the game's folder. Returns the game's status.
   */
  function request(asker, game, name = '', reason = '', fingerprint = null) {
    checkGame(game);
    const print = cleanFingerprint(fingerprint);
    addRequest.run(game, asker.key, String(name || '').slice(0, 200), String(reason || '').slice(0, 300), print ? JSON.stringify(print) : '');
    return status(game, asker);
  }

  /** The RE Engine font names in a game's file list, saved for the game (admins). Returns { fontTargets }. */
  function setFontList(game, text) {
    checkGame(game);
    const names = [...new Set((text.match(/^natives\/\S+\.oft(?:\.\d{1,3})?(?:\.(?:stm|x64))?\s*$/gim) || []).map((n) => n.trim()))]
      .filter((t) => FONT_TARGET_RE.test(t) && !t.includes('..')).slice(0, MAX_FONT_TARGETS).sort();
    if (!names.length) throw new TypeError('That file list has no .oft font names.');
    const row = getGame.get(game);
    if (!row) saveGame.run(game, '', 'reengine', 0);
    saveFonts.run(JSON.stringify(names), game);
    return { fontTargets: names };
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
    return db.prepare(`SELECT r.game, MAX(r.name) AS name, COUNT(*) AS requests, MIN(r.created_at) AS first, MAX(r.created_at) AS last,
        MAX(r.reason) AS reason,
        (SELECT f.fingerprint FROM arabic_requests f WHERE f.game = r.game AND f.fingerprint <> '' ORDER BY f.created_at DESC LIMIT 1) AS fingerprint
      FROM arabic_requests r GROUP BY r.game ORDER BY requests DESC, last DESC LIMIT ?`).all(limit)
      .map((r) => ({ ...r, fingerprint: r.fingerprint ? JSON.parse(r.fingerprint) : null, ...status(r.game) }));
  }

  return { status, request, report, requests, setFontList, isAdmin };
}

const text = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Math.trunc(Number(value)), Number.MAX_SAFE_INTEGER) : 0);
const names = (list, most, max = 160) => (Array.isArray(list) ? list.slice(0, most).map((n) => text(n, max)).filter(Boolean) : []);

/**
 * A game folder's fingerprint as players' apps send it (desktop/localization/dirprint.js),
 * kept to its known fields and sizes; null when there's none.
 */
function cleanFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const engine = value.engine && typeof value.engine === 'object' ? { id: text(value.engine.id, 60), name: text(value.engine.name, 120) } : null;
  const print = {
    folders: names(value.folders, 200),
    top: { folders: names(value.top?.folders, 80), files: names(value.top?.files, 80) },
    extensions: (Array.isArray(value.extensions) ? value.extensions.slice(0, 40) : [])
      .map((e) => ({ ext: text(e?.ext, 24), count: count(e?.count), bytes: count(e?.bytes) })).filter((e) => e.ext),
    files: count(value.files),
    bytes: count(value.bytes),
    truncated: Boolean(value.truncated),
    engine: engine?.id ? engine : null,
  };
  return JSON.stringify(print).length <= MAX_FINGERPRINT_CHARS ? print : null;
}

module.exports = { createArabicGames, cleanFingerprint, READY };
