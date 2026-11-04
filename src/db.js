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
    // Sign-in and GameShelf Guard (src/guard.js). Accounts made before email was asked for have none.
    email: 'TEXT',
    email_verified: 'INTEGER NOT NULL DEFAULT 0',
    // ISO 3166-1 alpha-2 country code ('' when not given), shown as a flag on profiles.
    nationality: "TEXT NOT NULL DEFAULT ''",
    // '' (off), 'totp' (an authenticator app) or 'email' (a code sent by email).
    twofa_method: "TEXT NOT NULL DEFAULT ''",
    totp_secret: 'TEXT',
    totp_pending: 'TEXT',
    totp_last_step: 'INTEGER NOT NULL DEFAULT 0',
    // GS-XXXX-XXXX, for adding friends (src/friends.js).
    friend_code: 'TEXT',
    // The Steam account proved with Steam's OpenID sign-in (src/steam-openid.js): one GameShelf account each.
    steam_id: 'TEXT',
    steam_name: "TEXT NOT NULL DEFAULT ''",
    steam_linked_at: 'TEXT',
  },
  // Where and when each sign-in was made, for Security settings' Active sessions.
  sessions: {
    created_at: 'INTEGER NOT NULL DEFAULT 0',
    last_seen: 'INTEGER NOT NULL DEFAULT 0',
    user_agent: "TEXT NOT NULL DEFAULT ''",
    ip: "TEXT NOT NULL DEFAULT ''",
    device: "TEXT NOT NULL DEFAULT 'web'",
  },
  // Why a player's PC couldn't make the Arabic itself (encrypted files, say), for admins.
  arabic_requests: {
    reason: "TEXT NOT NULL DEFAULT ''",
    // What's in the game's folder (names, file kinds and sizes; see desktop/localization/dirprint.js), as JSON.
    fingerprint: "TEXT NOT NULL DEFAULT ''",
  },
  // The Arabic font an admin picked for a game's packs ('' for the default, IBM Plex Sans Arabic).
  arabic_games: {
    font_style: "TEXT NOT NULL DEFAULT ''",
  },
  library: {
    game_backdrop: 'TEXT',
    game_genres: "TEXT NOT NULL DEFAULT '[]'",
    playtime_minutes: 'INTEGER',
    game_logo: 'TEXT',
  },
};

// Columns for tables created further down (games), added the same way.
const LATE_COLUMNS = {
  // What the AES Keys & Recipes tab shows about a recipe (not signed; the recipe itself is).
  engine_recipes: {
    title: "TEXT NOT NULL DEFAULT ''",
    // 'iostore' (UE5 .utoc/.ucas) or 'pak' (UE4 .pak), for an Unreal key recipe.
    container: "TEXT NOT NULL DEFAULT ''",
  },
  // A request an admin's recipe or key answered ('key' or 'recipe'), and when.
  arabic_requests: {
    ready_kind: "TEXT NOT NULL DEFAULT ''",
    ready_at: "TEXT NOT NULL DEFAULT ''",
  },
  games: {
    steam_appid: 'INTEGER',
    wikidata_qid: 'TEXT',
    detected_engine: 'TEXT',
    engine_label: 'TEXT',
    title_ar: 'TEXT',
    description_ar: 'TEXT',
    epic_slug: 'TEXT',
    gog_slug: 'TEXT',
    website: 'TEXT',
    description: 'TEXT',
    released: 'TEXT',
    image: 'TEXT',
    header_image: 'TEXT',
    backdrop: 'TEXT',
    poster: 'TEXT',
    genres: "TEXT NOT NULL DEFAULT '[]'",
    developers: "TEXT NOT NULL DEFAULT '[]'",
    publishers: "TEXT NOT NULL DEFAULT '[]'",
    platforms: "TEXT NOT NULL DEFAULT '[]'",
    review_percent: 'INTEGER',
    review_count: 'INTEGER',
    details_at: 'INTEGER',
    wikidata_at: 'INTEGER',
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

    -- Players' better Arabic for a line, waiting for an admin (see src/community.js).
    CREATE TABLE IF NOT EXISTS translation_fixes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game        TEXT NOT NULL,
      line_hash   TEXT NOT NULL,
      english     TEXT NOT NULL,
      current     TEXT NOT NULL DEFAULT '',
      suggestion  TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS translation_fixes_status ON translation_fixes(status, created_at);

    -- A game's glossary (see src/translation-memory.js): the Arabic for its names
    -- and terms, and how it speaks to the player, given to every translation batch.
    -- locked: an admin edited it, so the automatic pass only adds new terms.
    CREATE TABLE IF NOT EXISTS game_glossaries (
      game       TEXT PRIMARY KEY,
      terms      TEXT NOT NULL DEFAULT '{}',
      player     TEXT NOT NULL DEFAULT '{}',
      locked     INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Engine recipes (see src/engine-recipes.js): how players' apps read a game
    -- whose text is packed in archives, signed by an admin with GameShelf's pack key.
    CREATE TABLE IF NOT EXISTS engine_recipes (
      game        TEXT PRIMARY KEY,
      recipe      TEXT NOT NULL,
      signature   TEXT NOT NULL,
      engine      TEXT NOT NULL DEFAULT '',
      tool        TEXT NOT NULL DEFAULT '',
      attached_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code ON users (friend_code) WHERE friend_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_steam_id ON users (steam_id) WHERE steam_id IS NOT NULL;

    -- GameShelf Guard: one-time recovery codes (hashed), each good once.
    CREATE TABLE IF NOT EXISTS backup_codes (
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at   INTEGER,
      PRIMARY KEY (user_id, code_hash)
    );
    -- Six-digit codes sent by email: 'verify' (the address) or 'login' (a Guard sign-in) or 'enable'.
    CREATE TABLE IF NOT EXISTS email_codes (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose    TEXT NOT NULL,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      sent_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, purpose)
    );
    -- A password that was right, waiting for its Guard code before a session is made.
    CREATE TABLE IF NOT EXISTS login_challenges (
      id_hash    TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device     TEXT NOT NULL DEFAULT 'web',
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );
    -- Browsers and apps that passed Guard and were asked to be remembered.
    CREATE TABLE IF NOT EXISTS trusted_devices (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    -- One Steam sign-in attempt each (src/steam-openid.js): single use, ten minutes.
    CREATE TABLE IF NOT EXISTS steam_link_states (
      state_hash   TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   INTEGER NOT NULL,
      steam_id     TEXT,
      confirm_hash TEXT,
      used         INTEGER NOT NULL DEFAULT 0
    );

    -- Friends (src/friends.js): requests, friendships (user_a < user_b) and blocks.
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (from_id, to_id)
    );
    CREATE TABLE IF NOT EXISTS friendships (
      user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      since      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_a, user_b),
      CHECK (user_a < user_b)
    );
    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    -- Live presence from heartbeats; a row older than two minutes reads as offline.
    CREATE TABLE IF NOT EXISTS presence (
      user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status        TEXT NOT NULL CHECK (status IN ('online', 'in_game')),
      game_id       TEXT,
      game_title    TEXT NOT NULL DEFAULT '',
      steam_app_id  INTEGER,
      arabic        INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL DEFAULT 'web',
      started_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- Customer support (src/support.js).
    CREATE TABLE IF NOT EXISTS support_tickets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category   TEXT NOT NULL,
      subject    TEXT NOT NULL,
      game_id    TEXT,
      game_name  TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'resolved', 'closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, updated_at);
    CREATE TABLE IF NOT EXISTS support_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      from_admin INTEGER NOT NULL DEFAULT 0,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    -- Game data from Steam and Wikidata (src/games/steam-wikidata.js). The id is
    -- GameShelf's id for the game, the one lists, Arabic requests and packs use
    -- (ids from before, such as old IGDB slugs, are kept and filled in when seen).
    CREATE TABLE IF NOT EXISTS games (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    -- Old ids (IGDB slugs) that turned out to be a game already saved under another id.
    CREATE TABLE IF NOT EXISTS game_aliases (
      alias   TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE
    );
    -- Every response fetched from Steam or Wikidata, reused until it's older than the TTL.
    CREATE TABLE IF NOT EXISTS metadata_cache (
      key        TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- GameShelf Supporter ("داعم"): who supports, until when, and how they paid
    -- (a gift code, Stripe, LemonSqueezy or an admin). Arabic packs never depend on this.
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'supporter')),
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'expired')),
      source      TEXT NOT NULL DEFAULT '',
      external_id TEXT,
      period_end  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    -- Cloud AI translation used, per player: what the plans' quotas count.
    CREATE TABLE IF NOT EXISTS compute_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('translate', 'grant')),
      game       TEXT NOT NULL DEFAULT '',
      strings    INTEGER NOT NULL DEFAULT 0,
      chars      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS compute_ledger_user ON compute_ledger (user_id, created_at);
    -- Boost tokens supporters spend on requested games ("دعم تعريب اللعبة").
    CREATE TABLE IF NOT EXISTS game_boosts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game       TEXT NOT NULL,
      tokens     INTEGER NOT NULL CHECK (tokens > 0),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS game_boosts_game ON game_boosts (game);
    CREATE INDEX IF NOT EXISTS game_boosts_user ON game_boosts (user_id, created_at);
    -- Prepaid / gift codes (XXXX-XXXX-XXXX): only a hash is kept, like passwords.
    CREATE TABLE IF NOT EXISTS gift_codes (
      code_hash   TEXT PRIMARY KEY,
      hint        TEXT NOT NULL,
      plan        TEXT NOT NULL DEFAULT 'supporter',
      days        INTEGER NOT NULL CHECK (days BETWEEN 1 AND 3660),
      note        TEXT NOT NULL DEFAULT '',
      batch       TEXT NOT NULL DEFAULT '',
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL,
      redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at INTEGER,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
    -- Payment webhooks already handled, so a replayed event does nothing twice.
    CREATE TABLE IF NOT EXISTS billing_events (
      event_id    TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      type        TEXT NOT NULL,
      user_id     INTEGER,
      received_at INTEGER NOT NULL
    );
  `);
  // Columns added to tables made before them (safe to run every start).
  for (const [table, columns] of Object.entries(LATE_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS games_steam ON games (steam_appid) WHERE steam_appid IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS games_wikidata ON games (wikidata_qid) WHERE wikidata_qid IS NOT NULL AND steam_appid IS NULL;
  `);
  // Every account has a friend code (accounts made before friends get theirs here).
  const { assignFriendCodes } = require('./friends');
  assignFriendCodes(db);
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
