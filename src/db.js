const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

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

    -- A user's game list. Game name/image are snapshotted so profiles render
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
  `);

  return db;
}

module.exports = { openDatabase };
