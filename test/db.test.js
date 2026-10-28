const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');

test('upgrades a database from the first version without losing data', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-')), 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE library (user_id INTEGER NOT NULL, game_id TEXT NOT NULL, game_name TEXT NOT NULL, game_image TEXT,
      status TEXT NOT NULL, rating INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, game_id));
    INSERT INTO users (username, display_name, password_hash) VALUES ('hamad', 'Hamad', 'x');
    INSERT INTO library (user_id, game_id, game_name, status) VALUES (1, 'hades', 'Hades', 'playing');
  `);
  old.close();

  const db = openDatabase(file);
  const user = db.prepare('SELECT * FROM users').get();
  assert.equal(user.display_name, 'Hamad');
  assert.equal(user.background, 'midnight');
  assert.equal(user.showcases, '[]');
  assert.equal(db.prepare('SELECT game_genres FROM library').get().game_genres, '[]');
  db.close();
});

test('remembers Steam IDs, including games that are not on Steam', () => {
  const { steamIdStore } = require('../src/db');
  const store = steamIdStore(openDatabase(':memory:'));
  assert.equal(store.get('portal-2'), undefined);
  store.set('portal-2', 620);
  store.set('zelda', null);
  assert.equal(store.get('portal-2'), 620);
  assert.equal(store.get('zelda'), null);
});
