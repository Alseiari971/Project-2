// Time-based one-time passwords (RFC 6238, over RFC 4226's HOTP): what
// authenticator apps (Google Authenticator, Microsoft Authenticator, Authy,
// 1Password...) show. SHA-1, 6 digits, 30-second steps, as every app expects.
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new TypeError('Not a base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommendation), in base32. */
function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code for the step at `ms` (now by default). */
function totp(secret, ms = Date.now()) {
  return hotp(secret, stepAt(ms));
}

/**
 * The step a code matches, one step either side of now (so a phone's clock a
 * little off still works), or null. Steps up to `lastStep` were used already, so
 * a code can't be used twice.
 */
function verifyTotp(secret, code, { ms = Date.now(), lastStep = 0, window = 1 } = {}) {
  const digits = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits) || !secret) return null;
  const now = stepAt(ms);
  for (let step = now - window; step <= now + window; step++) {
    if (step <= lastStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
  }
  return null;
}

/** The otpauth:// link authenticator apps read from the QR code. */
function otpauthUri(secret, account, issuer = 'GameShelf') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${query}`;
}

module.exports = { base32Encode, base32Decode, newSecret, hotp, totp, verifyTotp, otpauthUri, STEP_SECONDS };
