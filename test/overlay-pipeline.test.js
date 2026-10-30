// The overlay's moving parts away from Electron: when a subtitle gets read,
// the picture OCR is given, the OCR helper's protocol, and the session that
// joins OCR, matching and showing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const { createDetector, ocrImage, grayBmp, cropRect, rgbaLuma } = require('../desktop/localization/change-detector');
const { createOcrHelper } = require('../desktop/localization/ocr');
const { createSubtitleSession } = require('../desktop/localization/subtitle-session');

const FAKE_HELPER = path.join(__dirname, '..', 'scripts', 'fake-ocr-helper.js');
const W = 640;
const H = 80;

// A subtitle strip: a dark, busy background (seeded "scenery") with bright text
// blocks standing in for letters. `phase` moves the scenery; `text` picks the words.
function strip({ text = null, phase = 0, brightness = 240, letters = 1 } = {}) {
  const luma = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) luma[y * W + x] = 40 + ((x * 7 + y * 13 + phase * 31) % 90);
  }
  if (text !== null) {
    let seed = text.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    const count = Math.round(40 * letters);
    for (let i = 0; i < count; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const x0 = 40 + (i * 13) % 560;
      const tall = 18 + (seed % 14);
      for (let y = 30; y < 30 + tall; y++) for (let x = x0; x < x0 + 4 + (seed % 5); x++) luma[y * W + x] = brightness;
    }
  }
  return luma;
}

const actions = (detector, frames) => frames.map((f) => detector.push(f, W, H).action);

// ---- Change detection --------------------------------------------------------------

test('a new subtitle is read once it holds still for a tick, and only once', () => {
  const d = createDetector();
  const line = (phase) => strip({ text: 'first line', phase });
  assert.deepEqual(actions(d, [strip(), strip({ phase: 1 }), line(2), line(3), line(4), line(5)]), ['none', 'none', 'none', 'read', 'none', 'none']);
});

test('moving scenery behind the text doesn\'t count as a change', () => {
  const d = createDetector();
  const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((phase) => strip({ text: 'same line', phase }));
  assert.deepEqual(actions(d, frames).filter((a) => a === 'read').length, 1);
});

test('a subtitle typing itself out is read when it stops, not on every letter', () => {
  const d = createDetector();
  const typed = [0.25, 0.5, 0.75, 1, 1, 1].map((letters, phase) => strip({ text: 'typed line', letters, phase }));
  assert.deepEqual(actions(d, typed), ['none', 'none', 'none', 'none', 'read', 'none']);
});

test('the next line is read, and the area clearing hides at once', () => {
  const d = createDetector();
  const result = actions(d, [
    strip({ text: 'one' }), strip({ text: 'one' }),
    strip({ text: 'two' }), strip({ text: 'two' }),
    strip(), strip(),
  ]);
  assert.deepEqual(result, ['none', 'read', 'none', 'read', 'clear', 'none']);
});

test('a bright flash over the whole area is not a subtitle', () => {
  const d = createDetector();
  const flash = new Uint8Array(W * H).fill(250);
  assert.deepEqual(actions(d, [flash, flash, flash]), ['none', 'none', 'none']);
});

test('games with dark text are read too', () => {
  const d = createDetector({ darkText: true, textLuma: 60 });
  const dark = (text) => {
    const luma = strip({ text, brightness: 10 }).map((v) => (v === 10 ? 10 : 230));
    return luma;
  };
  assert.deepEqual(actions(d, [dark('x'), dark('x')]), ['none', 'read']);
});

test('each tick stays well under a millisecond on a full-width 1080p strip', () => {
  const width = 1920;
  const height = 238;
  const d = createDetector();
  const frame = new Uint8Array(width * height).map((_, i) => (i % 97 < 4 ? 240 : 60));
  for (let i = 0; i < 20; i++) d.push(frame, width, height);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) d.push(frame, width, height);
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / 200;
  assert.ok(ms < 0.5, `took ${ms.toFixed(3)} ms a tick`);
});

// ---- The picture OCR gets ----------------------------------------------------------

test('bright text becomes black on white, and wide strips are halved', () => {
  const luma = Uint8Array.from([250, 170, 140, 60]);
  assert.deepEqual([...ocrImage(luma, 4, 1).pixels], [0, 0, 159, 255]);
  const wide = ocrImage(new Uint8Array(3840 * 4), 3840, 4);
  assert.deepEqual([wide.width, wide.height, wide.scale], [1920, 2, 2]);
});

test('the BMP has the header and palette Windows expects', () => {
  const pixels = Uint8Array.from([0, 64, 128, 255, 1, 2, 3, 4, 5, 6]);
  const bmp = Buffer.from(grayBmp(pixels, 5, 2));
  assert.equal(bmp.toString('latin1', 0, 2), 'BM');
  assert.equal(bmp.readUInt32LE(2), bmp.length);
  assert.equal(bmp.readInt32LE(18), 5);
  assert.equal(bmp.readInt32LE(22), -2);
  assert.equal(bmp.readUInt16LE(28), 8);
  const offset = bmp.readUInt32LE(10);
  assert.equal(offset, 14 + 40 + 1024);
  assert.deepEqual([...bmp.subarray(offset, offset + 5)], [0, 64, 128, 255, 1]);
  assert.deepEqual([...bmp.subarray(offset + 8, offset + 13)], [2, 3, 4, 5, 6]); // rows are padded to 4 bytes
  assert.deepEqual([...bmp.subarray(54 + 4 * 200, 54 + 4 * 201)], [200, 200, 200, 0]);
});

test('the subtitle area lands on even pixels inside the frame', () => {
  assert.deepEqual(cropRect(1920, 1080, [0, 0.78, 1, 0.22]), { x: 0, y: 842, width: 1920, height: 236 });
  // A window in the middle of a captured screen.
  assert.deepEqual(cropRect(2000, 1000, [0, 0.5, 1, 0.5], [0.25, 0.25, 0.5, 0.5]), { x: 500, y: 500, width: 1000, height: 250 });
  assert.deepEqual([...rgbaLuma(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1)], [255, 0]);
});

// ---- The OCR helper ----------------------------------------------------------------

const helperWith = (env = {}, options = {}) => createOcrHelper({
  spawnHelper: () => spawn(process.execPath, [FAKE_HELPER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }),
  ...options,
});
const bmp = () => grayBmp(new Uint8Array(40 * 10).fill(255), 40, 10);

test('the helper reads images and finds windows over its line protocol', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-ocr-'));
  fs.writeFileSync(path.join(dir, 'text'), 'Line one\nLine two');
  fs.writeFileSync(path.join(dir, 'window'), JSON.stringify({ hwnd: '123', x: 10, y: 20, w: 800, h: 600, minimized: false }));
  const helper = helperWith({ FAKE_OCR_TEXT_FILE: path.join(dir, 'text'), FAKE_WINDOW_FILE: path.join(dir, 'window') });
  try {
    assert.deepEqual(await helper.ready(), { ocr: true, language: 'en-US' });
    const read = await helper.recognize(bmp());
    assert.deepEqual(read.lines.map((l) => l.text), ['Line one', 'Line two']);
    assert.deepEqual(await helper.findWindow([4242]), { hwnd: '123', x: 10, y: 20, w: 800, h: 600, minimized: false });
    assert.equal(await helper.findWindow([]), null);
    await assert.rejects(helper.recognize(Buffer.from('not an image')), /Not a BMP/);
  } finally {
    helper.close();
  }
});

test('a helper that dies is started again on the next request', async () => {
  const helper = helperWith();
  try {
    // The fake helper exits when asked to read a 7-pixel-wide image.
    await assert.rejects(helper.recognize(grayBmp(new Uint8Array(7), 7, 1)), /stopped/);
    assert.equal(helper.running, false);
    assert.equal((await helper.recognize(bmp())).lines.length, 1);
    assert.equal(helper.running, true);
  } finally {
    helper.close();
  }
});

test('a slow answer times out instead of hanging the overlay', async () => {
  const helper = helperWith({ FAKE_OCR_DELAY_MS: '500' }, { timeoutMs: 100 });
  try {
    await assert.rejects(helper.recognize(bmp()), /didn't answer "ocr" in time/);
  } finally {
    helper.close();
  }
});

test('without OCR installed, reading fails with a clear message', async () => {
  const helper = helperWith({ FAKE_OCR_OFF: '1' });
  try {
    await assert.rejects(helper.recognize(bmp()), /no OCR language/);
  } finally {
    helper.close();
  }
  await assert.rejects(createOcrHelper({ spawnHelper: null }).recognize(bmp()), /needs Windows 10/);
});

// ---- The session -------------------------------------------------------------------

function fakeSession({ answers = {}, delays = {} } = {}) {
  const shown = [];
  const session = createSubtitleSession({
    recognize: (image) => new Promise((resolve) => setTimeout(() => resolve({ lines: (answers[image] ?? '').split('\n').filter(Boolean).map((text) => ({ text, box: { x: 100, y: 10, w: 200, h: 20 } })), ms: 5 }), delays[image] ?? 5)),
    match: (text) => (text.startsWith('Known') ? { arabic: `عربي: ${text}`, score: 0.9 } : null),
    show: (s) => shown.push(['show', s.arabic, s.box]),
    hide: () => shown.push(['hide']),
  });
  return { session, shown };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const image = (bmpName, crop) => ({ bmp: bmpName, crop });

test('a matched line is shown where the English was, and a miss hides it', async () => {
  const { session, shown } = fakeSession({ answers: { a: 'Known line', b: 'Unknown words' } });
  session.read(image('a', { x: 0, y: 800, width: 1000, height: 200, scale: 1, frameWidth: 1000, frameHeight: 1000 }));
  await settle();
  session.read(image('b'));
  await settle();
  const round = (box) => Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  assert.deepEqual(shown.map(([what, arabic, box]) => [what, arabic, box && round(box)]), [['show', 'عربي: Known line', { x: 0.1, y: 0.81, w: 0.2, h: 0.02 }], ['hide', undefined, undefined]]);
  assert.deepEqual({ ...session.stats, lastOcrMs: undefined }, { reads: 2, matches: 1, misses: 1, errors: 0, lastOcrMs: undefined });
});

test('clearing while OCR is busy drops its answer', async () => {
  const { session, shown } = fakeSession({ answers: { a: 'Known line' }, delays: { a: 30 } });
  session.read(image('a'));
  session.clear();
  await settle();
  assert.deepEqual(shown, []);
});

test('only the newest of several quick reads is shown', async () => {
  const { session, shown } = fakeSession({ answers: { a: 'Known first', b: 'Known second', c: 'Known third' }, delays: { a: 20, b: 5, c: 5 } });
  session.read(image('a'));
  session.read(image('b'));
  session.read(image('c'));
  await settle();
  assert.deepEqual(shown.map((s) => s[1]), ['عربي: Known third']);
  assert.equal(session.stats.reads, 3);
});

test('OCR errors are counted, not thrown', async () => {
  const shown = [];
  const session = createSubtitleSession({ recognize: async () => { throw new Error('boom'); }, match: () => null, show: () => shown.push('show'), hide: () => {} });
  session.read(image('x'));
  await settle();
  assert.equal(session.stats.errors, 1);
  assert.deepEqual(shown, []);
});
