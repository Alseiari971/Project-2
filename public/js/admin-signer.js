// The Admin Panel's in-browser signer (AES Keys & Recipes): GameShelf's pack
// signing key, unlocked in this tab's memory only, signs recipes right here.
// The private key is never sent anywhere, never saved (no storage, no cookies),
// and is forgotten on Lock, on leaving the tab, or when the page closes. The
// server only ever sees the signed recipe and checks it with the public key.
//
// It signs with the browser's own Ed25519 (WebCrypto) where there is one, with
// a non-extractable key, and otherwise with the RFC 8032 code below.
// No imports, so the tests can load it on its own.

const subtle = globalThis.crypto?.subtle;

// ---- Ed25519 (RFC 8032), for browsers without WebCrypto Ed25519 ----------------
// Signing only. Not constant-time: it runs in the admin's own tab on their own
// key, as a fallback; the WebCrypto path is used whenever the browser has it.

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => ((a % m) + m) % m;
function pow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
const BASE = (() => {
  const x = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
  const y = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
  return [x, y, 1n, mod(x * y)];
})();

// Points in extended coordinates (X, Y, Z, T), a = -1 (RFC 8032, 5.1.4).
function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(T1 * D2 * T2);
  const Dd = mod(Z1 * 2n * Z2);
  const E = B - A;
  const F = Dd - C;
  const G = Dd + C;
  const H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function multiply(point, scalar) {
  let result = [0n, 1n, 1n, 0n];
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}
function encodePoint([X, Y, Z]) {
  const zi = inv(Z);
  const x = mod(X * zi);
  const y = mod(Y * zi);
  const out = numberToBytes(y);
  if (x & 1n) out[31] |= 0x80;
  return out;
}
function numberToBytes(n, length = 32) {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
const bytesToNumber = (bytes) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha512 = async (...parts) => new Uint8Array(await subtle.digest('SHA-512', concat(...parts)));

async function expandSeed(seed) {
  const h = await sha512(seed);
  const a = h.slice(0, 32);
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  return { scalar: bytesToNumber(a), prefix: h.slice(32), wipe: () => { h.fill(0); a.fill(0); } };
}

/** The raw 32-byte public key of a 32-byte Ed25519 seed. */
export async function publicKeyOf(seed) {
  const { scalar, wipe } = await expandSeed(seed);
  try {
    return encodePoint(multiply(BASE, scalar));
  } finally {
    wipe();
  }
}

/** A 64-byte Ed25519 signature of `message` (bytes) with a 32-byte seed (RFC 8032, 5.1.6). */
export async function signWithSeed(seed, message) {
  const { scalar, prefix, wipe } = await expandSeed(seed);
  try {
    const A = encodePoint(multiply(BASE, scalar));
    const r = mod(bytesToNumber(await sha512(prefix, message)), L);
    const R = encodePoint(multiply(BASE, r));
    const k = mod(bytesToNumber(await sha512(R, A, message)), L);
    const S = mod(r + k * scalar, L);
    return concat(R, numberToBytes(S));
  } finally {
    wipe();
  }
}

// ---- Reading the key ---------------------------------------------------------

// PKCS#8 for an Ed25519 key: SEQUENCE { 0, { 1.3.101.112 }, OCTET STRING { OCTET STRING <32-byte seed> } }.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const ED25519_OID = [0x06, 0x03, 0x2b, 0x65, 0x70];

export class SignerError extends Error {}

export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
const indexOf = (bytes, pattern, from = 0) => {
  for (let i = from; i <= bytes.length - pattern.length; i += 1) if (pattern.every((b, j) => bytes[i + j] === b)) return i;
  return -1;
};

/** The 32-byte seed in a PKCS#8 DER Ed25519 private key (v1, or v2 with the public key after it). */
function seedFromDer(der) {
  const oid = indexOf(der, ED25519_OID);
  const at = oid < 0 ? -1 : indexOf(der, [0x04, 0x22, 0x04, 0x20], oid);
  if (oid < 0 || at < 0 || der.length < at + 36) throw new SignerError('That isn\'t an Ed25519 private key. GameShelf\'s pack key is pack-signing.key.');
  return der.slice(at + 4, at + 36);
}

/**
 * The 32-byte Ed25519 seed in what an admin pasted or picked: a PEM file
 * ("-----BEGIN PRIVATE KEY-----", PKCS#8), or the raw key as hex or base64
 * (32 bytes, or 64 bytes of seed and public key).
 */
export function readPrivateKey(input) {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input);
    const text = new TextDecoder().decode(bytes);
    if (/-----BEGIN/.test(text)) return readPrivateKey(text);
    if (bytes.length === 32) return bytes.slice();
    return seedFromDer(bytes);
  }
  const text = String(input || '').trim();
  if (!text) throw new SignerError('Paste the key, or pick its file.');
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) throw new SignerError('That\'s an OpenSSH key. GameShelf\'s pack key is a PEM file that starts with -----BEGIN PRIVATE KEY-----.');
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) throw new SignerError('That key is protected with a password. Use the plain pack-signing.key.');
  if (/-----BEGIN PUBLIC KEY-----/.test(text)) throw new SignerError('That\'s the public key. Signing needs the private one, pack-signing.key.');
  const pem = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(text);
  if (pem) return seedFromDer(fromBase64(pem[1].replace(/\s+/g, '')));
  const compact = text.replace(/\s+/g, '').replace(/^0x/i, '');
  if (/^[0-9a-f]{64}$/i.test(compact) || /^[0-9a-f]{128}$/i.test(compact)) return fromHex(compact).slice(0, 32);
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    const bytes = fromBase64(compact);
    if (bytes.length === 32 || bytes.length === 64) return bytes.slice(0, 32);
    if (bytes.length >= 48) return seedFromDer(bytes);
  }
  throw new SignerError('That doesn\'t look like an Ed25519 private key (PEM, or 32 bytes as hex or base64).');
}

/**
 * A signer for a seed: { publicKey (raw, base64), method ('webcrypto' | 'js'),
 * sign(text) → base64 signature, lock() }. The seed passed in is wiped.
 */
export async function createSigner(seed) {
  if (!subtle) throw new SignerError('This browser can\'t sign here. Open the Admin Panel over HTTPS, or use the GameShelf desktop app.');
  let secret = new Uint8Array(seed);
  seed.fill?.(0);
  const publicKey = toBase64(await publicKeyOf(secret));
  let key = null;
  let method = 'js';
  try {
    const pkcs8 = concat(PKCS8_PREFIX, secret);
    try {
      // Non-extractable: once imported, not even this page can read the key back.
      key = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
      method = 'webcrypto';
    } finally {
      pkcs8.fill(0);
    }
    secret.fill(0);
    secret = null;
  } catch {
    key = null; // this browser has no Ed25519 in WebCrypto: the code above signs
  }
  let locked = false;
  return {
    publicKey,
    method,
    async sign(text) {
      if (locked) throw new SignerError('The signer is locked. Unlock it again to sign.');
      const message = new TextEncoder().encode(String(text));
      const signature = key ? new Uint8Array(await subtle.sign({ name: 'Ed25519' }, key, message)) : await signWithSeed(secret, message);
      return toBase64(signature);
    },
    lock() {
      locked = true;
      key = null;
      secret?.fill(0);
      secret = null;
    },
  };
}

// ---- AES keys and key recipes ---------------------------------------------------

/**
 * An Unreal AES-256 key as "0x" and 64 hex digits, from "0x…" (66 characters),
 * the 64 hex digits alone, or 44-character base64; null when it isn't one.
 */
export function normalizeAesKey(text) {
  const value = String(text || '').trim().replace(/\s+/g, '');
  // Hex stays as the admin typed it (repak and retoc read either case).
  if (/^0x[0-9a-f]{64}$/i.test(value)) return `0x${value.slice(2)}`;
  if (/^[0-9a-f]{64}$/i.test(value)) return `0x${value}`;
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const bytes = fromBase64(value);
    if (bytes.length === 32) return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }
  return null;
}

/** "0x4BC8…E01D". */
export const maskAesKey = (key) => (key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '');

/**
 * The exact text that's signed, kept and sent to players' apps for an Unreal
 * game's key: always the same fields in the same order.
 */
export function keyRecipeText(game, aesKey, note = '') {
  const [kind, id] = String(game).split(':');
  const recipe = {
    format: 1,
    game: kind === 'steam' ? { steamAppId: Number(id) } : { gameId: id },
    engine: 'unreal',
    aesKey,
  };
  const cleanNote = String(note || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500);
  if (cleanNote) recipe.note = cleanNote;
  return JSON.stringify(recipe);
}
