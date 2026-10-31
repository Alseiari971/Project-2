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

function createSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
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
    SELECT u.id, u.username, u.display_name, u.bio, u.created_at, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);
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
    req.user = token ? find.get(hashToken(token), Date.now()) || null : null;
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

// Small in-memory limiter for login/register to slow down password guessing.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || entry.reset < now) {
      hits.set(req.ip, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = {
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
