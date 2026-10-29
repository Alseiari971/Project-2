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
