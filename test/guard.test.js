// Accounts and GameShelf Guard: sign-up fields, email checks, an authenticator
// app (TOTP) or email codes at sign-in on unremembered devices, recovery
// codes, remembered devices, and active sessions.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createMemoryMailer } = require('../src/mailer');
const { totp, verifyTotp, hotp, base32Encode, base32Decode, otpauthUri } = require('../src/totp');
const { maskEmail } = require('../src/guard');

let server;
let base;
let db;
const mailer = createMemoryMailer();

// A fresh app per test: sign-in rate limits count per address, and every test comes from 127.0.0.1.
async function startApp() {
  db = openDatabase(':memory:');
  server = createApp({ db, games: createLocalProvider(), mailer }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}
afterEach(() => server?.close());

/** A browser (or the desktop app, with an Electron user agent): its own cookies. */
function browser(userAgent = 'Mozilla/5.0 Test') {
  const jar = new Map();
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'User-Agent': userAgent, ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.jar = jar;
  return call;
}

const lastCode = (to) => /\b(\d{6})\b/.exec([...mailer.sent].reverse().find((m) => m.to === to).text)[1];
const register = (b, username, extra = {}) => b('/api/auth/register', { method: 'POST', body: { username, password: 'a long passphrase', email: `${username}@mail.example`, nationality: 'AE', ...extra } });

test('TOTP matches RFC 6238 and refuses replays', () => {
  // RFC 6238 appendix B: SHA-1 secret "12345678901234567890" at 59 s is 94287082 (8 digits); 6 digits: 287082.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totp(secret, 59 * 1000), '287082');
  assert.equal(hotp(secret, 1), '287082');
  assert.equal(verifyTotp(secret, '287082', { ms: 59 * 1000 }), 1);
  assert.equal(verifyTotp(secret, '287082', { ms: 59 * 1000, lastStep: 1 }), null, 'a used step works once');
  assert.equal(verifyTotp(secret, '000000', { ms: 59 * 1000 }), null);
  assert.match(otpauthUri(secret, 'hamad'), /^otpauth:\/\/totp\/GameShelf%3Ahamad\?secret=[A-Z2-7]+&issuer=GameShelf&algorithm=SHA1&digits=6&period=30$/);
  assert.equal(maskEmail('hamad@gmail.com'), 'h****@gmail.com');
});

test('sign-up: a lowercase handle, a real email, a strong confirmed password and a nationality', async () => {
  await startApp();
  const b = browser();
  const bad = async (extra, pattern) => {
    const r = await register(b, 'nadia', extra);
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.body.error, pattern);
  };
  await bad({ username: 'na' }, /3 to 24/);
  await bad({ username: 'way_too_long_for_a_handle_x' }, /3 to 24/);
  await bad({ username: 'nadia!' }, /3 to 24/);
  await bad({ username: 'admin' }, /reserved/);
  await bad({ email: 'not-an-email' }, /valid email/);
  await bad({ password: 'short' }, /at least 8/);
  await bad({ password: 'password123' }, /too easy/);
  await bad({ password: 'nadia2024!' }, /too easy/);
  await bad({ confirmPassword: 'something else' }, /don't match/);
  await bad({ nationality: '' }, /nationality/);
  await bad({ nationality: 'XX' }, /nationality/);

  assert.deepEqual((await b('/api/auth/username?name=Nadia')).body, { username: 'nadia', available: true, reason: null });
  const made = await register(b, 'Nadia', { confirmPassword: 'a long passphrase', nationality: 'kw' });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.username, 'nadia', 'handles are lowercase');
  assert.equal(made.body.user.nationality, 'KW');
  assert.match(made.body.user.friendCode, /^GS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(made.body.emailSent, true);
  assert.deepEqual((await b('/api/auth/username?name=nadia')).body.available, false);
  assert.equal((await register(browser(), 'NADIA', { email: 'other@mail.example' })).status, 409);
  const sameEmail = await register(browser(), 'nadia_two', { email: 'NADIA@mail.example' });
  assert.equal(sameEmail.status, 409);
  assert.match(sameEmail.body.error, /email/);
  // Profiles show the flag's country.
  assert.equal((await browser()('/api/users/nadia')).body.user.nationality, 'KW');

  // The address is checked with the emailed code.
  assert.equal((await b('/api/me/email/verify', { method: 'POST', body: { code: '000000' } })).status, 400);
  const verified = await b('/api/me/email/verify', { method: 'POST', body: { code: lastCode('nadia@mail.example') } });
  assert.equal(verified.body.emailVerified, true);
  // Signing in works with the email address too.
  const byEmail = await browser()('/api/auth/login', { method: 'POST', body: { username: 'Nadia@Mail.example', password: 'a long passphrase' } });
  assert.equal(byEmail.body.user.username, 'nadia');
});

test('authenticator app Guard: set up with a code, then unremembered devices need one; recovery codes work once', async () => {
  await startApp();
  const phone = browser();
  await register(phone, 'omar');
  assert.equal((await phone('/api/me/2fa/totp/start', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const setup = await phone('/api/me/2fa/totp/start', { method: 'POST', body: { password: 'a long passphrase' } });
  assert.match(setup.body.uri, /^otpauth:\/\/totp\/GameShelf%3Aomar\?secret=/);
  assert.equal((await phone('/api/me/2fa/totp/confirm', { method: 'POST', body: { code: '123456' } })).status, 400);
  const on = await phone('/api/me/2fa/totp/confirm', { method: 'POST', body: { code: totp(setup.body.secret) } });
  assert.equal(on.body.twoFactor.method, 'totp');
  assert.equal(on.body.backupCodes.length, 8);
  assert.equal(new Set(on.body.backupCodes).size, 8);
  assert.match(on.body.backupCodes[0], /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  // A new browser: the password alone makes no session.
  const laptop = browser();
  const first = await laptop('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } });
  assert.equal(first.body.guard.method, 'totp');
  assert.equal(first.body.user, undefined);
  assert.equal((await laptop('/api/me')).body.user, null);
  assert.equal((await laptop('/api/auth/guard', { method: 'POST', body: { challenge: first.body.guard.challenge, code: '000000' } })).status, 401);
  // The next step's code (the one used to set up is spent).
  const next = totp(setup.body.secret, Date.now() + 30 * 1000);
  const passed = await laptop('/api/auth/guard', { method: 'POST', body: { challenge: first.body.guard.challenge, code: next, remember: true } });
  assert.equal(passed.status, 200);
  assert.equal(passed.body.via, 'totp');
  assert.equal((await laptop('/api/me')).body.user.username, 'omar');
  assert.ok(laptop.jar.has('gs_device'), 'the laptop is remembered');
  // The same code can't be used again, and a spent challenge is gone.
  const again = await browser()('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } });
  assert.equal((await browser()('/api/auth/guard', { method: 'POST', body: { challenge: again.body.guard.challenge, code: next } })).status, 401);
  assert.equal((await laptop('/api/auth/guard', { method: 'POST', body: { challenge: first.body.guard.challenge, code: next } })).status, 410);

  // Remembered: the laptop signs in again with the password alone.
  await laptop('/api/auth/logout', { method: 'POST' });
  assert.equal((await laptop('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } })).body.user.username, 'omar');

  // A recovery code instead of the app, once.
  const tablet = browser();
  const challenge = (await tablet('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } })).body.guard.challenge;
  const recovery = await tablet('/api/auth/guard', { method: 'POST', body: { challenge, code: on.body.backupCodes[0].toLowerCase() } });
  assert.equal(recovery.body.via, 'backup');
  assert.equal(recovery.body.backupCodesLeft, 7);
  const other = browser();
  const c2 = (await other('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } })).body.guard.challenge;
  assert.equal((await other('/api/auth/guard', { method: 'POST', body: { challenge: c2, code: on.body.backupCodes[0] } })).status, 401);

  // Five wrong codes end a challenge.
  const guesser = browser();
  const c3 = (await guesser('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } })).body.guard.challenge;
  for (let i = 0; i < 5; i++) await guesser('/api/auth/guard', { method: 'POST', body: { challenge: c3, code: String(100000 + i) } });
  assert.equal((await guesser('/api/auth/guard', { method: 'POST', body: { challenge: c3, code: totp(setup.body.secret, Date.now() + 60 * 1000) } })).status, 429);

  // Turning Guard off needs the password and a code.
  assert.equal((await phone('/api/me/2fa/disable', { method: 'POST', body: { password: 'a long passphrase', code: '000000' } })).status, 401);
  const off = await phone('/api/me/2fa/disable', { method: 'POST', body: { password: 'a long passphrase', code: on.body.backupCodes[1] } });
  assert.equal(off.body.twoFactor.method, null);
  assert.equal((await browser()('/api/auth/login', { method: 'POST', body: { username: 'omar', password: 'a long passphrase' } })).body.user.username, 'omar');
});

test('email Guard: a checked address, a code by email at sign-in, and no resend flood', async () => {
  await startApp();
  const home = browser();
  await register(home, 'layla');
  assert.match((await home('/api/me/2fa/email/start', { method: 'POST', body: { password: 'a long passphrase' } })).body.error, /Check your email address first/);
  await home('/api/me/email/verify', { method: 'POST', body: { code: lastCode('layla@mail.example') } });
  const start = await home('/api/me/2fa/email/start', { method: 'POST', body: { password: 'a long passphrase' } });
  assert.equal(start.body.email, 'l****@mail.example');
  const on = await home('/api/me/2fa/email/confirm', { method: 'POST', body: { code: lastCode('layla@mail.example') } });
  assert.equal(on.body.twoFactor.method, 'email');
  assert.equal(on.body.backupCodes.length, 8);
  // The address can't be swapped while it's the Guard.
  assert.equal((await home('/api/me/email', { method: 'POST', body: { password: 'a long passphrase', email: 'new@mail.example' } })).status, 409);

  const cafe = browser();
  const login = await cafe('/api/auth/login', { method: 'POST', body: { username: 'layla', password: 'a long passphrase' } });
  assert.deepEqual([login.body.guard.method, login.body.guard.email], ['email', 'l****@mail.example']);
  assert.match(mailer.sent.at(-1).subject, /Guard code/);
  // The designed email, with a plain-text copy, both with the code.
  const sent = mailer.sent.at(-1);
  const code = lastCode('layla@mail.example');
  assert.match(sent.html, /^<!doctype html>/);
  assert.ok(sent.html.includes(`>${code[0]}</div>`) && sent.html.includes('dir="rtl"'));
  assert.ok(sent.text.includes(code) && !/</.test(sent.text));
  assert.equal((await cafe('/api/auth/guard/resend', { method: 'POST', body: { challenge: login.body.guard.challenge } })).status, 429);
  const passed = await cafe('/api/auth/guard', { method: 'POST', body: { challenge: login.body.guard.challenge, code: lastCode('layla@mail.example') } });
  assert.deepEqual([passed.status, passed.body.via], [200, 'email']);
  assert.ok(!cafe.jar.has('gs_device'), 'not remembered unless asked');
});

test('active sessions: listed by device, revocable, and a new password signs out everywhere else', async () => {
  await startApp();
  const web = browser();
  await register(web, 'yusuf');
  const app = browser('Mozilla/5.0 gameshelf/0.1.0 Chrome/140 Electron/44.7.2');
  await app('/api/auth/login', { method: 'POST', body: { username: 'yusuf', password: 'a long passphrase' } });
  const listed = (await web('/api/me/sessions')).body.sessions;
  assert.deepEqual(listed.map((s) => [s.device, s.current]).sort(), [['desktop', false], ['web', true]]);
  assert.ok(listed.every((s) => s.createdAt > 0 && s.lastSeen > 0 && s.userAgent));
  const current = listed.find((s) => s.current);
  assert.equal((await web(`/api/me/sessions/${current.id}`, { method: 'DELETE' })).status, 400);
  const desktop = listed.find((s) => s.device === 'desktop');
  assert.equal((await web(`/api/me/sessions/${desktop.id}`, { method: 'DELETE' })).body.sessions.length, 1);
  assert.equal((await app('/api/me')).body.user, null, 'the app was signed out');

  const tablet = browser();
  await tablet('/api/auth/login', { method: 'POST', body: { username: 'yusuf', password: 'a long passphrase' } });
  assert.equal((await web('/api/me/password', { method: 'POST', body: { current: 'wrong', next: 'another long phrase' } })).status, 401);
  assert.equal((await web('/api/me/password', { method: 'POST', body: { current: 'a long passphrase', next: 'another long phrase' } })).body.sessions.length, 1);
  assert.equal((await tablet('/api/me')).body.user, null);
  assert.equal((await web('/api/me')).body.user.username, 'yusuf');
  // Someone else's session ids do nothing.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('yusuf').n, 1);
});
