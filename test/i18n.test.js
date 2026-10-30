// The Arabic version: every English phrase the site shows, and every error the
// server sends, has its Arabic in public/js/lang/ar.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function jsFiles(dir, skip = []) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return skip.includes(e.name) ? [] : jsFiles(p, skip);
    return p.endsWith('.js') ? [p] : [];
  });
}

const unquote = (text) => text.replace(/\\(['"\\])/g, '$1');

// The phrases written straight into t('…'), th('…') and tTitle('…') calls.
function sitePhrases() {
  const phrases = new Set();
  const call = /\b(?:t|th|tTitle)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`)/g;
  for (const file of jsFiles(path.join(root, 'public/js'), ['lang'])) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(call)) phrases.add(unquote(m[1] ?? m[2] ?? m[3]));
  }
  return phrases;
}

// The { error: '…' } messages the server sends, which the site translates.
function serverMessages() {
  const messages = new Set();
  const files = [...jsFiles(path.join(root, 'src')), path.join(root, 'server.js')];
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\berror:\s*'((?:[^'\\]|\\.)*)'/g)) messages.add(unquote(m[1]));
  }
  return messages;
}

const loadArabic = () => {
  const source = fs.readFileSync(path.join(root, 'public/js/lang/ar.js'), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
};

test('every phrase on the site has an Arabic translation', async () => {
  const { AR } = await loadArabic();
  const phrases = sitePhrases();
  assert.ok(phrases.size > 300, `found only ${phrases.size} phrases`);
  assert.deepEqual([...phrases].filter((p) => !(p in AR)), []);
});

test('every server error message has an Arabic translation', async () => {
  const { AR } = await loadArabic();
  assert.deepEqual([...serverMessages()].filter((m) => !(m in AR)), []);
});

test('translations only use placeholders their English has', async () => {
  const { AR } = await loadArabic();
  const names = (text) => text.match(/\{\w+\}/g) || [];
  for (const [english, arabic] of Object.entries(AR)) {
    for (const name of names(arabic)) assert.ok(names(english).includes(name), `${english} → ${arabic}`);
  }
});

test('each counted word has all six Arabic plural forms', async () => {
  const { AR_PLURALS } = await loadArabic();
  for (const [word, forms] of Object.entries(AR_PLURALS)) {
    assert.deepEqual(Object.keys(forms).sort(), ['few', 'many', 'one', 'other', 'two', 'zero'], word);
    for (const form of ['few', 'many', 'other']) assert.match(forms[form], /\{n\}/, `${word}.${form}`);
  }
});
