// Finds the Arabic for a line of English read off the screen, in an overlay
// pack's fingerprints.json (built by localization/arabic_compiler/fingerprint.py,
// which explains the format). This must normalize and hash exactly as the
// Python does; test/fixtures/fingerprint-vectors.json checks both.
//
// A lookup: normalize what OCR read; keep the lines within 25% of its length
// (lines with runtime slots get room for the filled-in text); rank those by
// SimHash distance and score the closest 48 by trigram overlap; answer only
// when the best scores at least the threshold (0.72 by default).
const KIND = 'gameshelf-overlay-fingerprints';
const DEFAULTS = { threshold: 0.72, lengthTolerance: 0.25, maxHamming: 24, maxCandidates: 48 };
const SLOT_ROOM = 16;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const APOSTROPHES = /['‘’ʼ`´]/g;
const CONFUSABLES = { 0: 'o', 1: 'l', i: 'l', '|': 'l' };

/** "I'll be RIGHT back!" -> "lll be rlght back" (see fingerprint.py). */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/[01i|]/g, (ch) => CONFUSABLES[ch])
    .replaceAll('rn', 'm')
    .replaceAll('vv', 'w')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fnv1a64(text) {
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(text, 'utf8')) h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  return h;
}

/** { length, hi, lo, simhash (hex), grams (sorted Uint16Array) } for a normalized line. */
function fingerprint(normalized) {
  const squashed = normalized.replaceAll(' ', '');
  if (!squashed) return { length: 0, hi: 0, lo: 0, simhash: '0000000000000000', grams: new Uint16Array(0) };
  const padded = `^${squashed}$`;
  const trigrams = new Set();
  for (let i = 0; i + 3 <= padded.length; i++) trigrams.add(padded.slice(i, i + 3));

  const counts = new Int32Array(64);
  const grams = new Set();
  for (const gram of trigrams) {
    const h = fnv1a64(gram);
    const lo = Number(h & 0xffffffffn);
    const hi = Number(h >> 32n);
    for (let bit = 0; bit < 32; bit++) {
      counts[bit] += (lo >>> bit) & 1 ? 1 : -1;
      counts[bit + 32] += (hi >>> bit) & 1 ? 1 : -1;
    }
    grams.add(lo & 0xffff);
  }
  let lo = 0;
  let hi = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (counts[bit] > 0) lo |= 1 << bit;
    if (counts[bit + 32] > 0) hi |= 1 << bit;
  }
  lo >>>= 0;
  hi >>>= 0;
  return {
    length: squashed.length,
    hi,
    lo,
    simhash: hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'),
    grams: Uint16Array.from([...grams].sort((a, b) => a - b)),
  };
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function shared(a, b) {
  let i = 0;
  let j = 0;
  let count = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      count++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return count;
}

function score(read, entry, slots) {
  const same = shared(read, entry);
  const total = read.length + entry.length - same;
  let value = total ? same / total : 0;
  if (slots && entry.length) value = Math.max(value, same / entry.length);
  return value;
}

// First index whose length is >= x (bisect_left), or > x (bisect_right).
function firstAtLeast(lengths, x, strict = false) {
  let low = 0;
  let high = lengths.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (strict ? lengths[mid] <= x : lengths[mid] < x) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Reads a parsed fingerprints.json. Throws when it isn't one this version understands. */
function loadTable(data) {
  if (data?.kind !== KIND || data.format !== 1 || data.normalization !== 1 || !Array.isArray(data.entries)) {
    throw new Error('Not a subtitle table this version of GameShelf understands.');
  }
  const rows = data.entries
    .map(([simhash, length, grams, arabic, slots = 0]) => {
      const raw = Buffer.from(String(grams), 'base64');
      const codes = new Uint16Array(raw.length >> 1);
      for (let i = 0; i < codes.length; i++) codes[i] = raw.readUInt16LE(i * 2);
      return {
        length: Number(length),
        hi: parseInt(String(simhash).slice(0, 8), 16) >>> 0,
        lo: parseInt(String(simhash).slice(8, 16), 16) >>> 0,
        grams: codes,
        arabic: String(arabic),
        slots: Number(slots) || 0,
      };
    })
    .filter((row) => row.length > 0 && row.arabic);
  // The builder sorts by length (then SimHash); keep that order for ties.
  rows.sort((a, b) => a.length - b.length);
  const lengths = Int32Array.from(rows.map((r) => r.length));
  const withSlots = rows.map((r, i) => (r.slots ? i : -1)).filter((i) => i >= 0);
  return { rows, lengths, withSlots, size: rows.length };
}

/** The Arabic for what OCR read, or null when nothing scores the threshold. */
function lookup(table, text, options = {}) {
  const { threshold, lengthTolerance, maxHamming, maxCandidates } = { ...DEFAULTS, ...options };
  const fp = fingerprint(normalize(text));
  if (!fp.length) return null;

  // Distances run 0 to 64, so candidates are bucketed by distance instead of
  // sorted: one pass, in (distance, position) order like the Python.
  const buckets = Array.from({ length: maxHamming + 1 }, () => []);
  const consider = (i) => {
    const row = table.rows[i];
    const distance = popcount((row.hi ^ fp.hi) >>> 0) + popcount((row.lo ^ fp.lo) >>> 0);
    if (distance <= maxHamming) buckets[distance].push(i);
  };
  const low = firstAtLeast(table.lengths, fp.length * (1 - lengthTolerance));
  const high = firstAtLeast(table.lengths, fp.length * (1 + lengthTolerance), true);
  for (let i = low; i < high; i++) consider(i);
  let extra = false;
  for (const i of table.withSlots) {
    if (i >= low && i < high) continue;
    const { length, slots } = table.rows[i];
    if (length * (1 - lengthTolerance) <= fp.length && fp.length <= length * (1 + lengthTolerance) + SLOT_ROOM * slots) {
      consider(i);
      extra = true;
    }
  }
  const near = [];
  for (const bucket of buckets) {
    if (extra) bucket.sort((x, y) => x - y);
    for (const i of bucket) {
      if (near.length >= maxCandidates) break;
      near.push(i);
    }
    if (near.length >= maxCandidates) break;
  }

  let best = null;
  for (const i of near) {
    const row = table.rows[i];
    const value = score(fp.grams, row.grams, row.slots);
    if (!best || value > best.score) best = { arabic: row.arabic, score: value, index: i };
  }
  return best && best.score >= threshold ? best : null;
}

/** A matcher for one pack, remembering its last answer (OCR often reads the same line twice). */
function createMatcher(data, options = {}) {
  const table = loadTable(data);
  let last = { text: null, result: null };
  return {
    size: table.size,
    match(text) {
      if (text === last.text) return last.result;
      const result = lookup(table, text, options);
      last = { text, result };
      return result;
    },
  };
}

module.exports = { normalize, fingerprint, loadTable, lookup, createMatcher, DEFAULTS, KIND };
