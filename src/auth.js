const crypto = require('node:crypto');

const SESSION_COOKIE = 'gs_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Passwords: scrypt with a random salt per password. New hashes use N=2^15
// (about 32 MB of memory per guess); older ones (N=2^14, "scrypt$salt$hash")
// still verify and are upgraded at the next sign-in (needsRehash).
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function hashPassword(password, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p, maxmem: SCRYPT.maxmem });
  return `scrypt2$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] === 'scrypt' && parts.length === 3) return { N: 2 ** 14, r: 8, p: 1, salt: parts[1], hash: parts[2] };
  if (parts[0] === 'scrypt2' && parts.length === 6) return { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), salt: parts[4], hash: parts[5] };
  return null;
}

/** Compares in constant time; a malformed stored hash is simply "no". */
function verifyPassword(password, stored) {
  const h = parseHash(stored);
  if (!h || !(h.N >= 2 ** 14 && h.N <= 2 ** 20) || !(h.r >= 1 && h.r <= 32) || !(h.p >= 1 && h.p <= 4)) return false;
  const expected = Buffer.from(h.hash, 'hex');
  if (expected.length < 32) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(h.salt, 'hex'), expected.length, { N: h.N, r: h.r, p: h.p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(actual, expected);
}

/** True when a stored hash is weaker than what hashPassword makes now. */
const needsRehash = (stored) => {
  const h = parseHash(stored);
  return !h || h.N < SCRYPT.N || h.r < SCRYPT.r;
};

// Checked against when a username doesn't exist, so a wrong username takes as
// long as a wrong password and the timing doesn't tell which accounts exist.
let dummyHash = null;
const burnPasswordCheck = (password) => verifyPassword(password, (dummyHash ??= hashPassword('not a real password')));

// Only a hash of the session token is stored, so a leaked database can't be
// used to hijack sessions.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

// The desktop app's window is Electron; everything else is a browser.
const deviceOf = (req) => (/\bElectron\//.test(req?.headers?.['user-agent'] || '') ? 'desktop' : 'web');

/** Signs a user in on this browser or app: a new session, with where and when it was made (Security settings lists them). */
function createSession(db, res, userId, req = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen, user_agent, ip, device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), userId, now + SESSION_TTL_MS, now, now, String(req?.headers?.['user-agent'] || '').slice(0, 300),
      String(req?.ip || '').slice(0, 64), deviceOf(req));
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Personal access tokens (for tools like the pack builder) start with this.
const API_TOKEN_PREFIX = 'gst_';

/** A new personal access token for a user; the token itself is shown once and only its hash kept. */
function createApiToken(db, userId, name) {
  const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const { lastInsertRowid } = db.prepare('INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, ?, ?)')
    .run(userId, name, hashToken(token));
  return { id: Number(lastInsertRowid), name, token };
}

// Express middleware: sets req.user from a valid session cookie, or from a
// personal access token in "Authorization: Bearer gst_...".
function loadUser(db) {
  const find = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.created_at, u.role, s.rowid AS session_id, s.last_seen
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);
  // When each session was last used, a minute at a time at most.
  const touchSession = db.prepare('UPDATE sessions SET last_seen = ? WHERE rowid = ?');
  const findToken = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.created_at, u.role, t.id AS token_id
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `);
  const touchToken = db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?");
  return (req, _res, next) => {
    const bearer = /^Bearer (gst_[\w-]{20,})$/.exec(req.headers.authorization || '')?.[1];
    if (bearer) {
      const row = findToken.get(hashToken(bearer));
      if (row) touchToken.run(row.token_id);
      req.user = row || null;
      req.viaToken = Boolean(row);
      return next();
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const now = Date.now();
    req.user = token ? find.get(hashToken(token), now) || null : null;
    if (req.user && now - req.user.last_seen > 60 * 1000) touchSession.run(now, req.user.session_id);
    next();
  };
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  next();
}

/** Admins only (users.role = 'admin'): 401 when logged out, 403 for everyone else. */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can do this.' });
  next();
}

/**
 * Counts events per key (an address, an account) in a time window, and
 * forgets keys whose window ended, so memory doesn't grow with every new
 * address that ever made a request.
 */
function createCounter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  let nextSweep = now() + windowMs;
  const sweep = () => {
    const t = now();
    if (t < nextSweep && hits.size < 50000) return;
    for (const [key, entry] of hits) if (entry.reset < t) hits.delete(key);
    nextSweep = t + windowMs;
  };
  const live = (key) => {
    const entry = hits.get(key);
    return entry && entry.reset >= now() ? entry : null;
  };
  return {
    /** Counts one; true while under the limit. */
    hit(key) {
      sweep();
      const entry = live(key);
      if (!entry) {
        hits.set(key, { count: 1, reset: now() + windowMs });
        return true;
      }
      return ++entry.count <= max;
    },
    /** Whether the key is over the limit, without counting. */
    blocked: (key) => (live(key)?.count || 0) >= max,
    clear: (key) => hits.delete(key),
    size: () => hits.size,
  };
}

// Small in-memory limiter for login/register to slow down password guessing.
function rateLimit({ windowMs, max, by = 'ip' }) {
  const counter = createCounter({ windowMs, max });
  return (req, res, next) => {
    // by: 'user' counts per signed-in account (whatever address), falling back to the address.
    const key = by === 'user' && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    if (!counter.hit(key)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

/**
 * The message of an error caught around user input, if it's one of ours (a
 * plain sentence); a JavaScript slip ("Cannot read properties of...") or
 * anything with a file path gives a generic message instead.
 */
function clientMessage(err) {
  const text = String(err?.message || '');
  const internal = !text || text.length > 300 || /\b(Cannot read|is not a function|is not defined|undefined|null|ENOENT|EACCES|EPERM|SQLITE)\b|[\/\\][\w.-]+\.(js|py|db)\b|\n\s+at /.test(text);
  if (internal) {
    console.error(err);
    return 'Invalid request.';
  }
  return text;
}

module.exports = {
  clientMessage,
  createCounter,
  needsRehash,
  burnPasswordCheck,
  SESSION_COOKIE,
  hashToken,
  parseCookies,
  deviceOf,
  createApiToken,
  requireAdmin,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireUser,
  rateLimit,
};
