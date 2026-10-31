const path = require('node:path');
const fs = require('node:fs');

// SQLite is built into Node.js 22.13 and newer, so nothing has to be compiled
// when installing GameShelf. Some Node versions still label it "experimental"
// in a startup warning; it works fine for us, so that one message is hidden.
function loadSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    if (String(warning?.message ?? warning).includes('SQLite is an experimental feature')) return;
    return emitWarning.call(this, warning, ...args);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    console.error(`GameShelf needs Node.js 22.13 or newer, and this computer has ${process.version}.`);
    console.error('Download the LTS version from https://nodejs.org, install it, then run npm start again.');
    process.exit(1);
  } finally {
    process.emitWarning = emitWarning;
  }
}
const DatabaseSync = loadSqlite();

// Columns added after the first release. Existing databases get them added on
// startup, so nobody loses their account or list when they update.
const ADDED_COLUMNS = {
  users: {
    headline: "TEXT NOT NULL DEFAULT ''",
    country: "TEXT NOT NULL DEFAULT ''",
    avatar: 'BLOB',
    avatar_type: 'TEXT',
    avatar_version: 'INTEGER NOT NULL DEFAULT 0',
    avatar_frame: "TEXT NOT NULL DEFAULT 'none'",
    background: "TEXT NOT NULL DEFAULT 'midnight'",
    accent: "TEXT NOT NULL DEFAULT '#3b82f6'",
    showcases: "TEXT NOT NULL DEFAULT '[]'",
    // 'user' or 'admin' (see ADMIN_USERS in src/roles.js).
    role: "TEXT NOT NULL DEFAULT 'user'",
  },
  // Why a player's PC couldn't make the Arabic itself (encrypted files, say), for admins.
  arabic_requests: {
    reason: "TEXT NOT NULL DEFAULT ''",
  },
  library: {
    game_backdrop: 'TEXT',
    game_genres: "TEXT NOT NULL DEFAULT '[]'",
    playtime_minutes: 'INTEGER',
    game_logo: 'TEXT',
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

function openDatabase(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'gameshelf.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT NOT NULL,
      bio           TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- A user's game list. Game name/images are snapshotted so profiles render
    -- without calling the game database for every entry.
    CREATE TABLE IF NOT EXISTS library (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id    TEXT NOT NULL,
      game_name  TEXT NOT NULL,
      game_image TEXT,
      status     TEXT NOT NULL CHECK (status IN ('playing','completed','played','want','dropped')),
      rating     INTEGER CHECK (rating BETWEEN 1 AND 10),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS library_game ON library(game_id);

    -- Comments left on someone's profile, like a Steam profile comment wall.
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS comments_profile ON comments(profile_id, id);

    -- Shared Arabic translations of game text: one row per game and English
    -- line, found by a SHA-256 of the English (which is never stored), so a line
    -- is translated once for everyone. See src/translation-memory.js.
    CREATE TABLE IF NOT EXISTS translation_memory (
      game       TEXT NOT NULL,
      line_hash  TEXT NOT NULL,
      arabic     TEXT NOT NULL,
      origin     TEXT NOT NULL CHECK (origin IN ('machine', 'reviewed')),
      model      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (game, line_hash)
    );

    -- Lines and characters each user had machine-translated, per day, for the limits.
    CREATE TABLE IF NOT EXISTS translation_usage (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      lines   INTEGER NOT NULL DEFAULT 0,
      chars   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    -- How many lines each game has (as its last pack build counted them), and
    -- the font files its Arabic patch replaces. See src/arabic-games.js.
    CREATE TABLE IF NOT EXISTS arabic_games (
      game         TEXT PRIMARY KEY,
      name         TEXT NOT NULL DEFAULT '',
      engine       TEXT NOT NULL DEFAULT '',
      total_lines  INTEGER NOT NULL DEFAULT 0,
      font_targets TEXT NOT NULL DEFAULT '[]',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Players asking for Arabic in a game: one row per game and asker ("user:1").
    CREATE TABLE IF NOT EXISTS arabic_requests (
      game       TEXT NOT NULL,
      asker      TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (game, asker)
    );

    -- Signed Arabic packs in the cloud catalog (see src/pack-registry.js): one row
    -- per pack version; the newest published version of each pack is the one served.
    CREATE TABLE IF NOT EXISTS localization_packs (
      id           TEXT NOT NULL,
      version      TEXT NOT NULL,
      engine       TEXT NOT NULL,
      mode         TEXT NOT NULL CHECK (mode IN ('native', 'overlay')),
      title        TEXT NOT NULL DEFAULT '',
      steam_app_id INTEGER,
      game_id      TEXT,
      sha256       TEXT NOT NULL,
      size         INTEGER NOT NULL,
      file         TEXT NOT NULL,
      published    INTEGER NOT NULL DEFAULT 1,
      uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, version)
    );
    CREATE TABLE IF NOT EXISTS pack_downloads (
      pack_id    TEXT NOT NULL,
      version    TEXT NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS pack_downloads_pack ON pack_downloads(pack_id, version);

    -- Arabic made on a player's PC for a game GameShelf had no pack for, waiting
    -- for an admin (see src/submissions.js). The English is kept here so admins
    -- can check the Arabic without owning the game; it's never sent to players.
    CREATE TABLE IF NOT EXISTS arabic_submissions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      game         TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      engine       TEXT NOT NULL,
      tier         TEXT NOT NULL,
      font_targets TEXT NOT NULL DEFAULT '[]',
      lines        TEXT NOT NULL,
      total_lines  INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      note         TEXT NOT NULL DEFAULT '',
      submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS arabic_submissions_game ON arabic_submissions(game, status);

    -- Approved Arabic, signed by an admin: each player's app builds the game's
    -- patch from it on their own PC. One row per version.
    CREATE TABLE IF NOT EXISTS arabic_sets (
      id           TEXT NOT NULL,
      version      TEXT NOT NULL,
      game         TEXT NOT NULL,
      engine       TEXT NOT NULL,
      tier         TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL,
      signature    TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      size         INTEGER NOT NULL,
      submission   INTEGER REFERENCES arabic_submissions(id) ON DELETE SET NULL,
      approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, version)
    );

    -- Personal access tokens, for tools such as the pack builder. Only a hash is kept.
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    -- Which Steam app each RAWG game is (NULL = checked, not on Steam). This never
    -- changes, so each game is looked up once, ever, to save the RAWG request quota.
    CREATE TABLE IF NOT EXISTS steam_ids (
      game_id    TEXT PRIMARY KEY,
      app_id     INTEGER,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrate(db);
  return db;
}

/** Key-value store for steam_ids: get() is undefined when never checked, null when not on Steam. */
function steamIdStore(db) {
  const get = db.prepare('SELECT app_id FROM steam_ids WHERE game_id = ?');
  const set = db.prepare('INSERT OR REPLACE INTO steam_ids (game_id, app_id) VALUES (?, ?)');
  return {
    get: (gameId) => {
      const row = get.get(gameId);
      return row ? row.app_id : undefined;
    },
    set: (gameId, appId) => set.run(gameId, appId),
  };
}

/** Runs fn inside a transaction: every change is saved, or none are. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, steamIdStore, transaction };
