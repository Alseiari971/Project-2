const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

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
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
  `);

  migrate(db);
  return db;
}

module.exports = { openDatabase };
