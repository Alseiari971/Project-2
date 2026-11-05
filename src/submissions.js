// Arabic for games GameShelf had no pack for, made by players and approved by
// admins:
//
// 1. A player asks for Arabic in a game. With their OK, their own copy of the
//    app reads the game's English from their PC, the server translates it
//    (src/translation-memory.js), and the app builds the patch locally, so they
//    can play in Arabic straight away. The app then sends the English lines,
//    the engine and the font names it found here, as a submission.
// 2. An admin, who needn't own the game, reads the English beside the Arabic,
//    fixes lines (kept in the shared memory as 'reviewed'), and approves: their
//    desktop app signs the game's Arabic (an "Arabic set": the Arabic for each
//    line, by a SHA-256 of its English, plus the engine and font names) with
//    GameShelf's pack key, and the signed set goes in the catalog.
// 3. Every player with the game then gets the Arabic switch: their app checks
//    the signature, and builds the patch on their own PC from their own copy of
//    the game and the signed Arabic.
//
// Only Arabic travels to players, never the game's files or its English.
const crypto = require('node:crypto');
const { GAME_RE, sha256, problemWith, matchBreaks } = require('./translation-memory');

const ENGINES = {
  reengine: 're-patch', renpy: 'renpy-tl', godot: 'godot-override', unity: 'unity-bepinex', unreal: 'unreal-pak',
  bethesda: 'bethesda-strings', loose: 'loose-files', custom: 'recipe', runtime: 'native-runtime', overlay: 'overlay',
};
const MAX_LINES = 200000;
const MAX_LINE_CHARS = 2000;
const MAX_FONT_TARGETS = 300;
const FONT_TARGET_RE = /^[\w\-./ ]{1,240}$/;
const SET_KIND = 'gameshelf-arabic-set';

class SubmissionError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    // Extra facts for the page, e.g. which lines were refused and why.
    this.details = details;
  }
}

/** The pack id a game's Arabic goes by (the same as the app gives packs it builds, see desktop/localization/builder.js). */
function setId(game) {
  const [kind, id] = game.split(':');
  return kind === 'steam' ? `gameshelf-steam-${id}-ar` : `gameshelf-${id}-ar`;
}

function cleanFonts(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(String))].filter((t) => FONT_TARGET_RE.test(t) && !t.split('/').includes('..')).slice(0, MAX_FONT_TARGETS).sort();
}

function createSubmissions({ db, translations, publicKeys = [] }) {
  const q = {
    pendingFor: db.prepare("SELECT id FROM arabic_submissions WHERE game = ? AND status = 'pending'"),
    insert: db.prepare(`INSERT INTO arabic_submissions (game, name, engine, tier, font_targets, lines, total_lines, submitted_by)
      VALUES (@game, @name, @engine, @tier, @fonts, @lines, @total, @user)`),
    replace: db.prepare(`UPDATE arabic_submissions SET name = @name, engine = @engine, tier = @tier, font_targets = @fonts, lines = @lines,
      total_lines = @total, submitted_by = @user, created_at = datetime('now') WHERE id = @id`),
    get: db.prepare(`SELECT s.*, u.username AS submitter, r.username AS reviewer FROM arabic_submissions s
      LEFT JOIN users u ON u.id = s.submitted_by LEFT JOIN users r ON r.id = s.reviewed_by WHERE s.id = ?`),
    list: db.prepare(`SELECT s.id, s.game, s.name, s.engine, s.tier, s.font_targets, s.total_lines, s.status, s.note, s.created_at, s.reviewed_at,
      u.username AS submitter, r.username AS reviewer
      FROM arabic_submissions s LEFT JOIN users u ON u.id = s.submitted_by LEFT JOIN users r ON r.id = s.reviewed_by
      ORDER BY (s.status = 'pending') DESC, s.created_at DESC, s.id DESC LIMIT 200`),
    saveLines: db.prepare('UPDATE arabic_submissions SET lines = ? WHERE id = ?'),
    review: db.prepare("UPDATE arabic_submissions SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"),
    setCount: db.prepare('SELECT COUNT(*) AS n FROM arabic_sets WHERE id = ?'),
    fontStyle: db.prepare('SELECT font_style FROM arabic_games WHERE game = ?'),
    insertSet: db.prepare(`INSERT INTO arabic_sets (id, version, game, engine, tier, title, body, signature, sha256, size, submission, approved_by)
      VALUES (@id, @version, @game, @engine, @tier, @title, @body, @signature, @sha256, @size, @submission, @approvedBy)`),
    latestSets: db.prepare(`SELECT s.* FROM arabic_sets s WHERE s.rowid = (
      SELECT s2.rowid FROM arabic_sets s2 WHERE s2.id = s.id ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1) ORDER BY s.title COLLATE NOCASE`),
    latestSet: db.prepare('SELECT * FROM arabic_sets WHERE id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    setVersion: db.prepare('SELECT 1 FROM arabic_sets WHERE id = ? AND version = ?'),
    lastApproved: db.prepare("SELECT * FROM arabic_submissions WHERE game = ? AND status = 'approved' ORDER BY reviewed_at DESC, id DESC LIMIT 1"),
    logDownload: db.prepare('INSERT INTO pack_downloads (pack_id, version, user_id) VALUES (?, ?, ?)'),
    request: db.prepare('INSERT INTO arabic_requests (game, asker, name) VALUES (?, ?, ?) ON CONFLICT (game, asker) DO NOTHING'),
  };

  // Each line with the Arabic the shared memory has for it now (admins' fixes included).
  function withArabic(game, lines) {
    const found = translations.lookup(game, lines.map((l) => l.hash));
    return lines.map((l) => ({ ...l, arabic: found[l.hash] ?? null }));
  }

  /**
   * A player's app sends what it made: { game, name, engine, fontTargets,
   * lines: [English] }. One submission waits per game; a newer one replaces it.
   */
  function submit(user, body) {
    const game = String(body?.game || '');
    if (!GAME_RE.test(game)) throw new SubmissionError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
    const engine = String(body?.engine || '');
    if (!ENGINES[engine]) throw new SubmissionError('GameShelf doesn\'t know that engine.');
    if (!Array.isArray(body?.lines) || !body.lines.length || body.lines.length > MAX_LINES) throw new SubmissionError(`Send 1 to ${MAX_LINES} lines.`);
    const seen = new Set();
    const lines = [];
    for (const english of body.lines) {
      if (typeof english !== 'string' || !english.trim() || english.length > MAX_LINE_CHARS) continue;
      const hash = sha256(english);
      if (seen.has(hash)) continue;
      seen.add(hash);
      lines.push({ hash, english });
    }
    if (!lines.length) throw new SubmissionError('None of those lines can be used.');
    const row = {
      game,
      name: String(body.name || '').slice(0, 200),
      engine,
      tier: ENGINES[engine],
      fonts: JSON.stringify(cleanFonts(body.fontTargets)),
      lines: JSON.stringify(lines),
      total: lines.length,
      user: user.id,
    };
    const pending = q.pendingFor.get(game);
    let id;
    if (pending) {
      const { game: _game, ...changes } = row; // the pending submission is already this game's
      q.replace.run({ ...changes, id: pending.id });
      id = pending.id;
    } else {
      id = Number(q.insert.run(row).lastInsertRowid);
    }
    q.request.run(game, `user:${user.id}`, row.name);
    const translated = withArabic(game, lines).filter((l) => l.arabic).length;
    return { id, total: lines.length, translated };
  }

  function summary(row) {
    return {
      id: row.id,
      game: row.game,
      name: row.name,
      engine: row.engine,
      tier: row.tier,
      fontTargets: JSON.parse(row.font_targets),
      total: row.total_lines,
      status: row.status,
      note: row.note,
      submittedBy: row.submitter ?? null,
      reviewedBy: row.reviewer ?? null,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    };
  }

  function load(id) {
    const row = q.get.get(Number(id));
    if (!row) throw new SubmissionError('That submission isn\'t there.', 404);
    return row;
  }

  /** One submission with a page of its lines (English and current Arabic); `q` searches both. */
  function get(id, { offset = 0, limit = 100, query = '', missing = false } = {}) {
    const row = load(id);
    let lines = withArabic(row.game, JSON.parse(row.lines));
    const translated = lines.filter((l) => l.arabic).length;
    if (missing) lines = lines.filter((l) => !l.arabic);
    if (query) {
      const needle = query.toLowerCase();
      lines = lines.filter((l) => l.english.toLowerCase().includes(needle) || (l.arabic || '').includes(query));
    }
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(500, Math.max(1, Number(limit) || 100));
    return { submission: { ...summary(row), translated, fontStyle: q.fontStyle.get(row.game)?.font_style || null }, matching: lines.length, lines: lines.slice(start, start + size) };
  }

  /**
   * An admin's fixes: [{ hash, arabic }]. All are checked against their English's tags
   * first; if any can't be used, none are saved and each refused line is named (`problems`).
   */
  function edit(id, edits) {
    const row = load(id);
    const byHash = new Map(JSON.parse(row.lines).map((l) => [l.hash, l]));
    const checked = [];
    const problems = [];
    for (const { hash, arabic } of Array.isArray(edits) ? edits.slice(0, 1000) : []) {
      const line = byHash.get(String(hash));
      if (!line) continue;
      const text = matchBreaks(line.english, String(arabic ?? '').trim());
      const problem = problemWith(line.english, text);
      if (problem) problems.push({ hash: line.hash, english: line.english.slice(0, 80), problem });
      else checked.push([line, text]);
    }
    if (problems.length) {
      const first = problems[0];
      throw new SubmissionError(problems.length === 1
        ? `"${first.english.slice(0, 60)}": That Arabic can't be used: ${first.problem}.`
        : `${problems.length} lines can't be used yet: they're marked in red. The first: "${first.english.slice(0, 60)}": ${first.problem}.`, 400, { problems });
    }
    for (const [line, text] of checked) translations.review(row.game, line.english, text);
    return { saved: checked.length };
  }

  function reject(id, reviewer, note = '') {
    const row = load(id);
    if (row.status !== 'pending') throw new SubmissionError('Only a waiting submission can be turned down.');
    q.review.run('rejected', String(note).slice(0, 500), reviewer.id, row.id);
    return summary(load(id));
  }

  /**
   * The Arabic set an approval signs: exact text, so the signature covers just
   * what players get. Lines without Arabic are left out (the game shows those in English).
   */
  function prepare(id) {
    const row = load(id);
    if (row.status !== 'pending') throw new SubmissionError('This submission isn\'t waiting for approval.');
    return setFor(row);
  }

  /** The Arabic set for a submission's lines, with their Arabic as the shared memory has it now. */
  function setFor(row) {
    const lines = withArabic(row.game, JSON.parse(row.lines)).filter((l) => l.arabic);
    if (!lines.length) throw new SubmissionError('None of its lines have Arabic yet.');
    const [kind, gameId] = row.game.split(':');
    const set = {
      format: 1,
      kind: SET_KIND,
      id: setId(row.game),
      version: `1.${q.setCount.get(setId(row.game)).n + 1}.0`,
      title: row.name,
      game: kind === 'steam' ? { steamAppId: Number(gameId) } : { gameId },
      engine: row.engine,
      tier: row.tier,
      fontTargets: JSON.parse(row.font_targets),
      // The Arabic font an admin picked for the game (players' apps use it unless the player picks another).
      ...(q.fontStyle.get(row.game)?.font_style ? { fontStyle: q.fontStyle.get(row.game).font_style } : {}),
      lines: lines.map((l) => [l.hash, l.arabic]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    };
    return { set: JSON.stringify(set), lines: lines.length };
  }

  /**
   * A new version of a game's approved Arabic, with the fixes approved since
   * (Admin Panel, Translation fixes): the set for its approved submission's
   * lines as the memory has them now, for an admin's app to sign.
   */
  function prepareUpdate(game) {
    const row = q.lastApproved.get(String(game));
    if (!row) throw new SubmissionError('This game has no approved Arabic to update.', 404);
    return setFor(row);
  }

  /** Publishes the signed update from prepareUpdate(): every player's app gets it the next time Arabic goes in. */
  function publishUpdate(game, { set, signature } = {}, reviewer) {
    const row = q.lastApproved.get(String(game));
    if (!row) throw new SubmissionError('This game has no approved Arabic to update.', 404);
    const parsed = verifySet(set, signature);
    if (parsed.kind !== SET_KIND || parsed.id !== setId(row.game) || !Array.isArray(parsed.lines)) throw new SubmissionError('That Arabic set is for another game.');
    if (q.setVersion.get(parsed.id, String(parsed.version))) throw new SubmissionError('That version is already published.', 409);
    insertSet(row, parsed, set, signature, reviewer);
    return catalogEntry(q.latestSet.get(parsed.id));
  }

  function verifySet(set, signature) {
    if (!publicKeys.length) throw new SubmissionError('No pack signing key is set up on the server.', 503);
    const body = Buffer.from(String(set || ''), 'utf8');
    let valid = false;
    try {
      valid = publicKeys.some((key) => crypto.verify(null, body, key, Buffer.from(String(signature || ''), 'base64')));
    } catch {
      valid = false;
    }
    if (!valid) throw new SubmissionError('The signature doesn\'t match GameShelf\'s pack key. Pick GameShelf\'s pack-signing.key in the Pack Studio.');
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw new SubmissionError('That isn\'t an Arabic set.');
    }
  }

  function insertSet(row, parsed, set, signature, reviewer) {
    const body = Buffer.from(String(set), 'utf8');
    q.insertSet.run({
      id: parsed.id,
      version: String(parsed.version),
      game: row.game,
      engine: row.engine,
      tier: row.tier,
      title: row.name,
      body: body.toString('utf8'),
      signature: String(signature),
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      size: body.length,
      submission: row.id,
      approvedBy: reviewer.id,
    });
  }

  /** Publishes a submission's Arabic, signed by an admin's app with GameShelf's pack key. */
  function approve(id, { set, signature } = {}, reviewer) {
    const row = load(id);
    if (row.status !== 'pending') throw new SubmissionError('This submission isn\'t waiting for approval.');
    if (!publicKeys.length) throw new SubmissionError('No pack signing key is set up on the server.', 503);
    const body = Buffer.from(String(set || ''), 'utf8');
    let valid = false;
    try {
      valid = publicKeys.some((key) => crypto.verify(null, body, key, Buffer.from(String(signature || ''), 'base64')));
    } catch {
      valid = false;
    }
    if (!valid) throw new SubmissionError('The signature doesn\'t match GameShelf\'s pack key. Pick GameShelf\'s pack-signing.key in the Pack Studio.');
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new SubmissionError('That isn\'t an Arabic set.');
    }
    if (parsed.kind !== SET_KIND || parsed.id !== setId(row.game) || !Array.isArray(parsed.lines)) throw new SubmissionError('That Arabic set is for another game.');
    q.insertSet.run({
      id: parsed.id,
      version: String(parsed.version),
      game: row.game,
      engine: row.engine,
      tier: row.tier,
      title: row.name,
      body: body.toString('utf8'),
      signature: String(signature),
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      size: body.length,
      submission: row.id,
      approvedBy: reviewer.id,
    });
    q.review.run('approved', '', reviewer.id, row.id);
    return catalogEntry(q.latestSet.get(parsed.id));
  }

  function catalogEntry(row) {
    const [kind, gameId] = row.game.split(':');
    return {
      id: row.id,
      version: row.version,
      engine: row.engine,
      // Built on each player's PC from the signed Arabic.
      mode: 'build',
      tier: row.tier,
      title: row.title || null,
      steamAppId: kind === 'steam' ? Number(gameId) : null,
      gameSlug: kind === 'game' ? gameId : null,
      sha256: row.sha256,
      size: row.size,
      downloadUrl: `/api/localization/sets/${encodeURIComponent(row.id)}/download`,
      updatedAt: row.created_at,
    };
  }

  return {
    submit,
    list: () => q.list.all().map(summary),
    get,
    edit,
    reject,
    prepare,
    approve,
    prepareUpdate,
    publishUpdate,
    /** Whether a game has approved Arabic in the catalog (so fixes to it need a new signed version). */
    published: (game) => Boolean(q.latestSet.get(setId(String(game)))),
    /** The newest approved Arabic set of each game, as catalog entries. */
    catalog: () => q.latestSets.all().map(catalogEntry),
    /** { set, signature, entry } of a game's newest set, counting the download. */
    download(id, userId) {
      const row = q.latestSet.get(String(id));
      if (!row) return null;
      q.logDownload.run(row.id, row.version, userId ?? null);
      return { set: row.body, signature: row.signature, entry: catalogEntry(row) };
    },
  };
}

module.exports = { createSubmissions, setId, cleanFonts, SubmissionError, SET_KIND, ENGINES };
