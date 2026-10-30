// The overlay's matcher: the same fingerprints and answers as the Python
// builder (shared vectors), OCR mistakes tolerated, and fast on big tables.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/fingerprint-vectors.json');
const { normalize, fingerprint, loadTable, lookup, createMatcher } = require('../desktop/localization/fingerprint');

// What the Python english_text() does to these vector texts before normalizing.
const shownEnglish = (text) => text
  .replace(/<\/?[A-Za-z][^>]*>|<\/>/g, '')
  .replace(/\{[A-Za-z0-9_.:,#\- ]{0,40}\}|\[[\x20-\x5A\x5C\x5E-\x7E]{1,40}\]|%s/g, ' ')
  .replace(/\n/g, ' ');

test('fingerprints match the Python builder exactly', () => {
  for (const v of fixture.vectors) {
    const n = normalize(shownEnglish(v.text));
    assert.equal(n, v.normalized, v.text);
    const fp = fingerprint(n);
    assert.deepEqual({ length: fp.length, simhash: fp.simhash, grams: [...fp.grams] }, { length: v.length, simhash: v.simhash, grams: v.grams }, v.text);
  }
});

test('lookups give the same answers and scores as the Python matcher', () => {
  const table = loadTable(fixture.table);
  for (const c of fixture.lookups) {
    const found = lookup(table, c.query);
    assert.equal(found?.arabic ?? null, c.arabic, c.query);
    if (found) assert.ok(Math.abs(found.score - c.score) < 1e-5, c.query);
  }
});

test('misread letters, missing spaces and capitals still find the line', () => {
  const matcher = createMatcher(fixture.table);
  const castle = 'يجب أن نصل إلى القلعة قبل حلول الليل.';
  for (const read of ['We rnust reach the castle bef0re nightfall', 'WE MUST REACH THE CASTLE\nBEFORE NIGHTFALL', 'Wemustreachthecastlebeforenightfall', 'We must reach the casIle before nightfall.']) {
    assert.equal(matcher.match(read)?.arabic, castle, read);
  }
  assert.equal(matcher.match('Hello, Arthur! Welcome to Riverwood.')?.arabic, 'مرحبًا يا …! أهلًا بك في ريفروود.');
  assert.equal(matcher.match('Completely different text here'), null);
  assert.equal(matcher.match(''), null);
});

test('the threshold is a setting', () => {
  const strict = createMatcher(fixture.table, { threshold: 0.99 });
  assert.equal(strict.match('Hello, Arthur! Welcome to Riverwood.'), null);
  assert.ok(strict.match('We must reach the castle before nightfall'));
});

test('a table that isn\'t one is refused', () => {
  assert.throws(() => loadTable({ kind: 'other', entries: [] }), /understands/);
});

test('a 50,000-line table answers noisy lines in a few milliseconds', () => {
  const words = 'the we you must reach find castle river bridge before after night dawn gate open close run hide fight sword shield king queen village forest'.split(' ');
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const lines = [];
  const entries = [];
  for (let i = 0; i < 50000; i++) {
    const line = `${Array.from({ length: 5 + Math.floor(random() * 9) }, () => words[Math.floor(random() * words.length)]).join(' ')} number ${i}`;
    const fp = fingerprint(normalize(line));
    const grams = Buffer.alloc(fp.grams.length * 2);
    fp.grams.forEach((g, k) => grams.writeUInt16LE(g, k * 2));
    lines.push(line);
    entries.push([fp.simhash, fp.length, grams.toString('base64'), `سطر ${i}`, 0]);
  }
  const table = loadTable({ format: 1, kind: 'gameshelf-overlay-fingerprints', normalization: 1, entries });

  const picks = Array.from({ length: 40 }, (_, k) => (k * 1237) % lines.length);
  const started = process.hrtime.bigint();
  const answers = picks.map((i) => lookup(table, lines[i].toUpperCase().replace(/o/gi, '0').replace(/ /, '')));
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / picks.length;
  assert.ok(ms < 10, `took ${ms.toFixed(2)} ms a lookup`);
  picks.forEach((i, k) => assert.equal(answers[k]?.arabic, `سطر ${i}`, lines[i]));
});
