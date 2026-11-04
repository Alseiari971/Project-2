const crypto = require('node:crypto');

const SESSION_COOKIE = 'gs_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

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
function rateLimit({ windowMs, max }) {
  const counter = createCounter({ windowMs, max });
  return (req, res, next) => {
    if (!counter.hit(req.ip)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = {
  createCounter,
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
