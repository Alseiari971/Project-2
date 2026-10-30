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

// Desktop app tokens, one per copy of the app, for asking for Arabic subtitles without an account.
const DEVICE_TOKEN_PREFIX = 'gsd_';
const DEVICES_PER_ADDRESS_PER_DAY = 5;

/** A new device token, or null when this address made too many today. The address itself isn't kept. */
function createDevice(db, ip) {
  const ipHash = hashToken(`gameshelf-device:${ip}`);
  const recent = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')").get(ipHash).n;
  if (recent >= DEVICES_PER_ADDRESS_PER_DAY) return null;
  const token = DEVICE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO devices (token_hash, ip_hash) VALUES (?, ?)').run(hashToken(token), ipHash);
  return token;
}

// Express middleware: sets req.user from a valid session cookie, or from a
// personal access token in "Authorization: Bearer gst_...". A desktop app's
// "Bearer gsd_..." sets req.device instead.
function loadUser(db) {
  const find = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);
  const findToken = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.created_at, t.id AS token_id
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `);
  const touchToken = db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?");
  const findDevice = db.prepare('SELECT id FROM devices WHERE token_hash = ?');
  const touchDevice = db.prepare("UPDATE devices SET last_used_at = datetime('now') WHERE id = ?");
  return (req, _res, next) => {
    const device = /^Bearer (gsd_[\w-]{20,})$/.exec(req.headers.authorization || '')?.[1];
    if (device) {
      const row = findDevice.get(hashToken(device));
      if (row) touchDevice.run(row.id);
      req.user = null;
      req.device = row || null;
      return next();
    }
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

/** A signed-in user or a desktop app's device token. Sets req.asker to { kind, id, key }. */
function requireAsker(req, res, next) {
  if (req.user) req.asker = { kind: 'user', id: req.user.id, key: `user:${req.user.id}` };
  else if (req.device) req.asker = { kind: 'device', id: req.device.id, key: `device:${req.device.id}` };
  else return res.status(401).json({ error: 'Please log in first.' });
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
  createDevice,
  requireAsker,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireUser,
  rateLimit,
};
