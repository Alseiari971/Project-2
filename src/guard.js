// GameShelf Guard: two-step sign-in, Steam Guard style.
//
// A player turns on one method: an authenticator app (TOTP, src/totp.js) or a
// six-digit code sent to their checked email address. Either way they get 8
// one-time recovery codes. When they sign in from a browser or app that isn't
// remembered, the right password alone makes no session: it makes a challenge,
// and the session comes once the code is given (src/account-api.js).
//
// Only hashes are kept of recovery codes, emailed codes, challenges and
// remembered devices. Codes expire, and each challenge or emailed code allows
// five tries.
const crypto = require('node:crypto');
const { verifyTotp } = require('./totp');
const { hashToken, parseCookies } = require('./auth');

const DEVICE_COOKIE = 'gs_device';
const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 30 * 1000;
const MAX_TRIES = 5;
const BACKUP_COUNT = 8;
// No 0/O, 1/I/L: easy to read off paper.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

class GuardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const codeHash = (userId, purpose, code) => hashToken(`${userId}:${purpose}:${code}`);
const normalizeBackup = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function backupCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => BACKUP_ALPHABET[b % BACKUP_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** "h***@gmail.com", for showing where a code went. */
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(6, name.length - 1)))}@${domain}`;
}

function createGuard({ db, mailer, now = () => Date.now() }) {
  const q = {
    deleteBackups: db.prepare('DELETE FROM backup_codes WHERE user_id = ?'),
    addBackup: db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)'),
    useBackup: db.prepare('UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL'),
    backupsLeft: db.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL'),
    putCode: db.prepare(`INSERT INTO email_codes (user_id, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT (user_id, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`),
    getCode: db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?'),
    tryCode: db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?'),
    dropCode: db.prepare('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?'),
    putChallenge: db.prepare('INSERT INTO login_challenges (id_hash, user_id, device, expires_at) VALUES (?, ?, ?, ?)'),
    getChallenge: db.prepare('SELECT * FROM login_challenges WHERE id_hash = ?'),
    tryChallenge: db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE id_hash = ?'),
    dropChallenge: db.prepare('DELETE FROM login_challenges WHERE id_hash = ?'),
    oldChallenges: db.prepare('DELETE FROM login_challenges WHERE expires_at < ?'),
    trust: db.prepare('INSERT INTO trusted_devices (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    trusted: db.prepare('SELECT 1 FROM trusted_devices WHERE token_hash = ? AND user_id = ? AND expires_at > ?'),
    forgetDevices: db.prepare('DELETE FROM trusted_devices WHERE user_id = ?'),
    setLastStep: db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?'),
  };

  // ---- Recovery codes ----

  /** Eight new recovery codes (the old ones stop working), shown to the player once. */
  function newBackupCodes(userId) {
    const codes = Array.from({ length: BACKUP_COUNT }, backupCode);
    q.deleteBackups.run(userId);
    for (const code of codes) q.addBackup.run(userId, codeHash(userId, 'backup', normalizeBackup(code)));
    return codes;
  }

  function useBackupCode(userId, code) {
    const clean = normalizeBackup(code);
    if (clean.length !== 8) return false;
    return q.useBackup.run(now(), userId, codeHash(userId, 'backup', clean)).changes === 1;
  }

  const backupsLeft = (userId) => q.backupsLeft.get(userId).n;

  // ---- Codes by email ----

  const SUBJECTS = {
    verify: 'Check your GameShelf email address',
    login: 'Your GameShelf Guard code',
    enable: 'Turn on GameShelf Guard by email',
  };
  const BODIES = {
    verify: (code) => `Your code to check this email address for GameShelf is:\n\n    ${code}\n\nIt works for 10 minutes. If you didn't make a GameShelf account, you can ignore this email.\n\nرمز التحقق من بريدك في GameShelf: ${code}`,
    login: (code) => `Someone (hopefully you) just signed in to GameShelf with your password. Your GameShelf Guard code is:\n\n    ${code}\n\nIt works for 10 minutes. If this wasn't you, change your password now.\n\nرمز GameShelf Guard لتسجيل الدخول: ${code}`,
    enable: (code) => `Your code to turn on GameShelf Guard by email is:\n\n    ${code}\n\nIt works for 10 minutes.\n\nرمز تفعيل GameShelf Guard عبر البريد: ${code}`,
  };

  /** Sends a six-digit code for `purpose` ('verify', 'login' or 'enable') to `email`. */
  async function sendCode(userId, purpose, email) {
    if (!mailer?.enabled) throw new GuardError('Email isn\'t set up on this server.', 503);
    if (!email) throw new GuardError('Add an email address first.');
    const last = q.getCode.get(userId, purpose);
    if (last && now() - last.sent_at < RESEND_MS) throw new GuardError('A code was just sent. Wait a moment before asking for another.', 429);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    q.putCode.run(userId, purpose, codeHash(userId, purpose, code), now() + CODE_TTL_MS, now());
    try {
      await mailer.send({ to: email, subject: SUBJECTS[purpose], text: BODIES[purpose](code) });
    } catch (err) {
      q.dropCode.run(userId, purpose);
      // The reason goes to the server log (journalctl -u gameshelf), where whoever runs it can fix it.
      console.error(`Email to ${maskEmail(email)} wasn't sent: ${err.message}`);
      throw new GuardError(`The email couldn't be sent: ${err.message}`, 502);
    }
  }

  /** Whether `code` is the one sent for `purpose` (each code works once, five tries). */
  function checkCode(userId, purpose, code) {
    const row = q.getCode.get(userId, purpose);
    const digits = String(code || '').replace(/\s/g, '');
    if (!row || row.expires_at < now() || row.attempts >= MAX_TRIES || !/^\d{6}$/.test(digits)) return false;
    q.tryCode.run(userId, purpose);
    const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(codeHash(userId, purpose, digits)));
    if (ok) q.dropCode.run(userId, purpose);
    return ok;
  }

  // ---- Sign-in challenges ----

  /** A password that was right, waiting for its code: returns the challenge's id (sent to the browser). */
  function startChallenge(userId, device = 'web') {
    q.oldChallenges.run(now());
    const id = crypto.randomBytes(24).toString('base64url');
    q.putChallenge.run(hashToken(id), userId, device, now() + CHALLENGE_TTL_MS);
    return id;
  }

  /** The challenge's row when it's still open (counting this try), or throws. */
  function openChallenge(id) {
    const row = id ? q.getChallenge.get(hashToken(String(id))) : null;
    if (!row || row.expires_at < now()) throw new GuardError('That sign-in expired. Enter your password again.', 410);
    if (row.attempts >= MAX_TRIES) {
      q.dropChallenge.run(row.id_hash);
      throw new GuardError('Too many wrong codes. Enter your password again.', 429);
    }
    q.tryChallenge.run(row.id_hash);
    return row;
  }

  const closeChallenge = (id) => q.dropChallenge.run(hashToken(String(id)));

  /**
   * Checks a Guard code for a user with Guard on: their authenticator's code,
   * the emailed sign-in code, or a recovery code. Returns which it was, or null.
   */
  function verifyCode(user, code) {
    if (user.twofa_method === 'totp') {
      const step = verifyTotp(user.totp_secret, code, { ms: now(), lastStep: user.totp_last_step || 0 });
      if (step !== null && q.setLastStep.run(step, user.id, step).changes === 1) return 'totp';
    }
    if (user.twofa_method === 'email' && checkCode(user.id, 'login', code)) return 'email';
    if (useBackupCode(user.id, code)) return 'backup';
    return null;
  }

  // ---- Remembered devices ----

  function rememberDevice(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.trust.run(hashToken(token), userId, now(), now() + DEVICE_TTL_MS);
    res.cookie(DEVICE_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: DEVICE_TTL_MS, path: '/',
    });
  }

  function isRemembered(req, userId) {
    const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    return Boolean(token && q.trusted.get(hashToken(token), userId, now()));
  }

  const forgetDevices = (userId) => q.forgetDevices.run(userId);

  return {
    newBackupCodes, useBackupCode, backupsLeft, sendCode, checkCode, startChallenge, openChallenge, closeChallenge,
    verifyCode, rememberDevice, isRemembered, forgetDevices, mailEnabled: () => Boolean(mailer?.enabled),
  };
}

module.exports = { createGuard, GuardError, maskEmail, DEVICE_COOKIE };
