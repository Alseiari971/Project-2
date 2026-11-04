// Accounts: sign-up, sign-in with GameShelf Guard (src/guard.js), and Security
// settings (email, Guard, recovery codes, password, active sessions).
const { hashPassword, verifyPassword, createSession, destroySession, requireUser, rateLimit, deviceOf, createCounter } = require('./auth');
const { GuardError, maskEmail } = require('./guard');
const { newSecret, verifyTotp, otpauthUri } = require('./totp');
const { normalizeCountry } = require('./countries');
const { newFriendCode } = require('./friends');

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const MIN_PASSWORD = 8;
// Names nobody gets, so they can't pose as GameShelf.
const RESERVED = new Set(['admin', 'administrator', 'gameshelf', 'support', 'help', 'moderator', 'mod', 'staff', 'system', 'root', 'official', 'null', 'undefined']);
// The handful of passwords tried first by anyone guessing.
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou', 'abc12345', '11111111', '00000000', 'gameshelf', 'letmein1']);

const cleanEmail = (value) => String(value || '').trim().toLowerCase();

function usernameProblem(username) {
  if (!USERNAME_RE.test(username)) return 'Usernames need 3 to 24 lowercase letters, numbers or underscores.';
  if (RESERVED.has(username)) return 'That username is reserved.';
  return null;
}

function passwordProblem(password, username = '') {
  if (password.length < MIN_PASSWORD || password.length > 200) return 'Password must be at least 8 characters.';
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || (username && password.toLowerCase().includes(username))) {
    return 'That password is too easy to guess. Try a longer phrase.';
  }
  return null;
}

/** Puts the account routes on `api`. `selfUser` shapes the signed-in user for the client. */
function mountAccountRoutes(api, { db, guard, selfUser, accentFor, adminNames, steamOpenId = null }) {
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
  const guardLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
  const lookLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
  // Per account, whatever address the attempts come from: wrong passwords,
  // wrong Guard codes, and password-reset emails.
  const LOCK_MS = 15 * 60 * 1000;
  const badPasswords = createCounter({ windowMs: LOCK_MS, max: 10 });
  const badCodes = createCounter({ windowMs: LOCK_MS, max: 10 });
  const resetMails = createCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  const LOCKED = 'Too many wrong tries for this account. Wait 15 minutes, or reset your password.';
  const q = {
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    insert: db.prepare(`INSERT INTO users (username, display_name, password_hash, accent, email, nationality, friend_code)
      VALUES (@username, @username, @hash, @accent, @email, @nationality, @code)`),
    setEmail: db.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?'),
    verifyEmail: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    setPending: db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?'),
    enableTotp: db.prepare("UPDATE users SET twofa_method = 'totp', totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?"),
    enableEmail: db.prepare("UPDATE users SET twofa_method = 'email', totp_secret = NULL, totp_pending = NULL WHERE id = ?"),
    disable: db.prepare("UPDATE users SET twofa_method = '', totp_secret = NULL, totp_pending = NULL, totp_last_step = 0 WHERE id = ?"),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    sessions: db.prepare('SELECT rowid AS id, created_at, last_seen, user_agent, ip, device FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC'),
    dropSession: db.prepare('DELETE FROM sessions WHERE rowid = ? AND user_id = ?'),
    dropOthers: db.prepare('DELETE FROM sessions WHERE user_id = ? AND rowid != ?'),
    makeAdmin: db.prepare("UPDATE users SET role = 'admin' WHERE id = ?"),
  };
  const guardRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch((err) => {
    if (err instanceof GuardError) return res.status(err.status).json({ error: err.message });
    next(err);
  });
  const me = (req) => q.byId.get(req.user.id);
  const checkPassword = (user, password) => {
    if (!verifyPassword(String(password || ''), user.password_hash)) throw new GuardError('That password is not right.', 401);
  };

  // ---- Sign-up ----

  // Live availability while typing a username on the sign-up page.
  api.get('/auth/username', lookLimiter, (req, res) => {
    const username = String(req.query.name || '').trim().toLowerCase();
    const problem = usernameProblem(username);
    if (problem) return res.json({ username, available: false, reason: problem });
    const taken = Boolean(q.byName.get(username));
    res.json({ username, available: !taken, reason: taken ? 'That username is taken.' : null });
  });

  api.post('/auth/register', authLimiter, guardRoute(async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const email = cleanEmail(body.email);
    const password = String(body.password || '');
    const problem = usernameProblem(username);
    if (problem) return res.status(400).json({ error: problem });
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    const weak = passwordProblem(password, username);
    if (weak) return res.status(400).json({ error: weak });
    if (body.confirmPassword !== undefined && String(body.confirmPassword) !== password) {
      return res.status(400).json({ error: 'The two passwords don\'t match.' });
    }
    const nationality = normalizeCountry(body.nationality);
    if (!nationality) return res.status(400).json({ error: 'Pick your nationality.' });
    if (q.byName.get(username)) return res.status(409).json({ error: 'That username is taken.' });
    if (q.byEmail.get(email)) return res.status(409).json({ error: 'An account already uses that email address.' });

    const { lastInsertRowid } = q.insert.run({ username, hash: hashPassword(password), accent: accentFor(), email, nationality, code: newFriendCode(db) });
    if (adminNames().includes(username)) q.makeAdmin.run(lastInsertRowid);
    createSession(db, res, lastInsertRowid, req);
    // The address is checked with a code, when this server can send email.
    let emailSent = false;
    if (guard.mailEnabled()) {
      emailSent = await guard.sendCode(lastInsertRowid, 'verify', email).then(() => true, () => false);
    }
    res.status(201).json({ user: selfUser(q.byId.get(lastInsertRowid)), emailSent });
  }));

  // ---- Sign-in, with Guard ----

  api.post('/auth/login', authLimiter, guardRoute(async (req, res) => {
    const login = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = login.includes('@') ? q.byEmail.get(cleanEmail(login)) : q.byName.get(login.toLowerCase());
    if (user && badPasswords.blocked(user.id)) return res.status(429).json({ error: LOCKED });
    if (!user || !verifyPassword(password, user.password_hash)) {
      if (user) badPasswords.hit(user.id);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    badPasswords.clear(user.id);
    if (!user.twofa_method || guard.isRemembered(req, user.id)) {
      createSession(db, res, user.id, req);
      return res.json({ user: selfUser(user) });
    }
    // A browser or app this account hasn't remembered: the code comes first.
    const challenge = guard.startChallenge(user.id, deviceOf(req));
    if (user.twofa_method === 'email') await guard.sendCode(user.id, 'login', user.email);
    res.json({ guard: { challenge, method: user.twofa_method, email: user.twofa_method === 'email' ? maskEmail(user.email) : null } });
  }));

  api.post('/auth/guard', guardLimiter, guardRoute(async (req, res) => {
    const challenge = guard.openChallenge(req.body?.challenge);
    const user = q.byId.get(challenge.user_id);
    if (!user?.twofa_method) throw new GuardError('That sign-in expired. Enter your password again.', 410);
    if (badCodes.blocked(user.id)) return res.status(429).json({ error: LOCKED });
    const via = guard.verifyCode(user, req.body?.code);
    if (!via) {
      badCodes.hit(user.id);
      return res.status(401).json({ error: 'That code isn\'t right. Check it and try again.' });
    }
    badCodes.clear(user.id);
    guard.closeChallenge(req.body.challenge);
    createSession(db, res, user.id, req);
    if (req.body?.remember) guard.rememberDevice(res, user.id);
    res.json({ user: selfUser(q.byId.get(user.id)), via, backupCodesLeft: guard.backupsLeft(user.id) });
  }));

  // Another emailed code, for a sign-in waiting on one.
  api.post('/auth/guard/resend', guardLimiter, guardRoute(async (req, res) => {
    const challenge = guard.openChallenge(req.body?.challenge);
    const user = q.byId.get(challenge.user_id);
    if (user?.twofa_method !== 'email') throw new GuardError('This sign-in uses an authenticator app.');
    await guard.sendCode(user.id, 'login', user.email);
    res.json({ sent: true, email: maskEmail(user.email) });
  }));

  // ---- Forgot password ----
  //
  // A six-digit code is emailed to the account's address; the code and a new
  // password set it. The answer is the same whether or not an account exists,
  // so the form can't be used to find out who has one. Resetting signs out
  // everywhere and forgets remembered devices. GameShelf Guard stays on: with
  // an authenticator app, signing in afterwards still needs its code.

  const findLogin = (login) => {
    const text = String(login || '').trim();
    if (!text) return null;
    return text.includes('@') ? q.byEmail.get(cleanEmail(text)) : q.byName.get(text.toLowerCase());
  };

  api.post('/auth/forgot', authLimiter, guardRoute(async (req, res) => {
    const login = String(req.body?.username || req.body?.email || '').trim();
    if (!login) return res.status(400).json({ error: 'Enter your username or email address.' });
    if (!guard.mailEnabled()) return res.status(503).json({ error: 'This server can\'t send email, so passwords can\'t be reset by email. Ask GameShelf\'s team through Support.' });
    const user = findLogin(login);
    // Sent in the background, so the answer takes as long whether or not the
    // account exists. A code sent in the last 30 seconds, or a mail error,
    // gets the same answer too (mail errors go to the server log).
    if (user?.email && resetMails.hit(user.id)) guard.sendCode(user.id, 'reset', user.email).catch(() => {});
    res.json({ sent: true });
  }));

  api.post('/auth/reset', authLimiter, guardRoute(async (req, res) => {
    const user = findLogin(req.body?.username || req.body?.email);
    const password = String(req.body?.password || '');
    // The new password is checked first, so a weak one doesn't spend the code.
    const weak = passwordProblem(password, user?.username || '');
    if (weak) return res.status(400).json({ error: weak });
    if (!user || !guard.checkCode(user.id, 'reset', req.body?.code)) {
      return res.status(400).json({ error: 'That code isn\'t right or has expired. Ask for a new one.' });
    }
    q.setPassword.run(hashPassword(password), user.id);
    // The code came to this address, so it's confirmed now.
    if (!user.email_verified) q.verifyEmail.run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    guard.forgetDevices(user.id);
    guard.notify(user.email, 'password', { username: user.username });
    if (user.twofa_method) return res.json({ reset: true, signIn: true });
    createSession(db, res, user.id, req);
    res.json({ reset: true, user: selfUser(q.byId.get(user.id)) });
  }));

  api.post('/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  // ---- Security settings ----

  const sessionList = (req) => q.sessions.all(req.user.id, Date.now()).map((s) => ({
    id: s.id,
    device: s.device,
    userAgent: s.user_agent,
    ip: s.ip,
    createdAt: s.created_at || null,
    lastSeen: s.last_seen || null,
    current: s.id === req.user.session_id,
  }));

  const security = (req) => {
    const user = me(req);
    return {
      email: user.email || null,
      emailVerified: Boolean(user.email_verified),
      mailEnabled: guard.mailEnabled(),
      twoFactor: { method: user.twofa_method || null, backupCodesLeft: user.twofa_method ? guard.backupsLeft(user.id) : 0 },
      steam: steamOpenId ? steamOpenId.status(user) : null,
      sessions: sessionList(req),
    };
  };

  api.get('/me/security', requireUser, (req, res) => res.json(security(req)));

  api.post('/me/email', requireUser, authLimiter, guardRoute(async (req, res) => {
    const user = me(req);
    checkPassword(user, req.body?.password);
    const email = cleanEmail(req.body?.email);
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (user.twofa_method === 'email') return res.status(409).json({ error: 'Turn off Email Guard before changing your email address.' });
    const other = q.byEmail.get(email);
    if (other && other.id !== user.id) return res.status(409).json({ error: 'An account already uses that email address.' });
    q.setEmail.run(email, user.id);
    // The old address hears about it, in case someone else made the change.
    if (user.email && user.email !== email) guard.notify(user.email, 'email-changed', { username: user.username, email });
    let emailSent = false;
    if (guard.mailEnabled()) emailSent = await guard.sendCode(user.id, 'verify', email).then(() => true, () => false);
    res.json({ ...security(req), emailSent });
  }));

  api.post('/me/email/send', requireUser, guardRoute(async (req, res) => {
    const user = me(req);
    if (user.email_verified) return res.json(security(req));
    await guard.sendCode(user.id, 'verify', user.email);
    res.json({ ...security(req), emailSent: true });
  }));

  api.post('/me/email/verify', requireUser, guardLimiter, (req, res) => {
    if (!guard.checkCode(req.user.id, 'verify', req.body?.code)) return res.status(400).json({ error: 'That code isn\'t right. Check it and try again.' });
    q.verifyEmail.run(req.user.id);
    res.json(security(req));
  });

  // Guard with an authenticator app: a new secret, then a code from the app proves it's set up.
  api.post('/me/2fa/totp/start', requireUser, authLimiter, guardRoute(async (req, res) => {
    const user = me(req);
    checkPassword(user, req.body?.password);
    if (user.twofa_method) return res.status(409).json({ error: 'GameShelf Guard is already on. Turn it off first to switch methods.' });
    const secret = newSecret();
    q.setPending.run(secret, user.id);
    res.json({ secret, uri: otpauthUri(secret, user.username) });
  }));

  api.post('/me/2fa/totp/confirm', requireUser, guardLimiter, (req, res) => {
    const user = me(req);
    if (user.twofa_method || !user.totp_pending) return res.status(409).json({ error: 'Start setting up the authenticator app again.' });
    const step = verifyTotp(user.totp_pending, req.body?.code);
    if (step === null) return res.status(400).json({ error: 'That code isn\'t right. Check your phone\'s clock and try again.' });
    q.enableTotp.run(step, user.id);
    res.json({ ...security(req), backupCodes: guard.newBackupCodes(user.id) });
  });

  // Guard by email: the address must be checked, and a code sent to it proves it still works.
  api.post('/me/2fa/email/start', requireUser, authLimiter, guardRoute(async (req, res) => {
    const user = me(req);
    checkPassword(user, req.body?.password);
    if (user.twofa_method) return res.status(409).json({ error: 'GameShelf Guard is already on. Turn it off first to switch methods.' });
    if (!user.email || !user.email_verified) return res.status(400).json({ error: 'Check your email address first.' });
    await guard.sendCode(user.id, 'enable', user.email);
    res.json({ sent: true, email: maskEmail(user.email) });
  }));

  api.post('/me/2fa/email/confirm', requireUser, guardLimiter, (req, res) => {
    const user = me(req);
    if (user.twofa_method) return res.status(409).json({ error: 'GameShelf Guard is already on. Turn it off first to switch methods.' });
    if (!guard.checkCode(user.id, 'enable', req.body?.code)) return res.status(400).json({ error: 'That code isn\'t right. Check it and try again.' });
    q.enableEmail.run(user.id);
    res.json({ ...security(req), backupCodes: guard.newBackupCodes(user.id) });
  });

  // A sign-in code by email, for Email Guard players turning Guard off or making new recovery codes.
  api.post('/me/2fa/code', requireUser, guardRoute(async (req, res) => {
    const user = me(req);
    if (user.twofa_method !== 'email') return res.status(400).json({ error: 'Use the code from your authenticator app.' });
    await guard.sendCode(user.id, 'login', user.email);
    res.json({ sent: true, email: maskEmail(user.email) });
  }));

  const needGuardCode = (user, code) => {
    if (!guard.verifyCode(user, code)) throw new GuardError('That code isn\'t right. Check it and try again.', 401);
  };

  api.post('/me/2fa/disable', requireUser, authLimiter, guardRoute(async (req, res) => {
    const user = me(req);
    if (!user.twofa_method) return res.json(security(req));
    checkPassword(user, req.body?.password);
    needGuardCode(user, req.body?.code);
    q.disable.run(user.id);
    db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(user.id);
    guard.forgetDevices(user.id);
    guard.notify(user.email, 'guard-off', { username: user.username });
    res.json(security(req));
  }));

  api.post('/me/2fa/backup-codes', requireUser, authLimiter, guardRoute(async (req, res) => {
    const user = me(req);
    if (!user.twofa_method) return res.status(400).json({ error: 'Turn on GameShelf Guard first.' });
    checkPassword(user, req.body?.password);
    needGuardCode(user, req.body?.code);
    res.json({ ...security(req), backupCodes: guard.newBackupCodes(user.id) });
  }));

  api.post('/me/password', requireUser, authLimiter, guardRoute(async (req, res) => {
    const user = me(req);
    checkPassword(user, req.body?.current);
    const next = String(req.body?.next || '');
    const weak = passwordProblem(next, user.username.toLowerCase());
    if (weak) return res.status(400).json({ error: weak });
    q.setPassword.run(hashPassword(next), user.id);
    // Everywhere else is signed out; this browser stays signed in.
    q.dropOthers.run(user.id, req.user.session_id || -1);
    guard.forgetDevices(user.id);
    guard.notify(user.email, 'password', { username: user.username });
    res.json(security(req));
  }));

  api.get('/me/sessions', requireUser, (req, res) => res.json({ sessions: sessionList(req) }));

  api.delete('/me/sessions/:id', requireUser, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.session_id) return res.status(400).json({ error: 'Use Log out to end this session.' });
    q.dropSession.run(id, req.user.id);
    res.json({ sessions: sessionList(req) });
  });

  api.post('/me/sessions/revoke-others', requireUser, (req, res) => {
    q.dropOthers.run(req.user.id, req.user.session_id || -1);
    res.json({ sessions: sessionList(req) });
  });

  api.delete('/me/devices', requireUser, (req, res) => {
    guard.forgetDevices(req.user.id);
    res.json({ ok: true });
  });
}

module.exports = { mountAccountRoutes, usernameProblem, passwordProblem, USERNAME_RE, EMAIL_RE };
