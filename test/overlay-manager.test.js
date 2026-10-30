// The overlay windows' manager, with stand-ins for Electron: which capture it
// starts, where the band goes, and that it follows and closes with the game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayManager, hidesFromCapture } = require('../desktop/localization/overlay-manager');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeElectron({ sources, failFirst = false, platform = 'linux' } = {}) {
  let ids = 0;
  const windows = [];
  const handlers = {};
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.bounds = { x: 0, y: 0, width: 0, height: 0 };
      this.visible = false;
      this.destroyed = false;
      this.sent = [];
      this.webContents = { id: ++ids, send: (channel, payload) => this.sent.push([channel, payload]), once: (event, callback) => setImmediate(callback) };
      windows.push(this);
    }
    setIgnoreMouseEvents(...args) { this.ignoreMouse = args; }
    setAlwaysOnTop(...args) { this.onTop = args; }
    setContentProtection(on) { this.protected = on; }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
  }
  let calls = 0;
  const electron = {
    BrowserWindow: FakeWindow,
    desktopCapturer: {
      getSources: async () => {
        calls++;
        if (failFirst && calls === 1) return [];
        return sources;
      },
    },
    screen: { getDisplayMatching: () => ({ id: 7, bounds: { x: 0, y: 0, width: 2000, height: 1000 } }) },
    ipcMain: { on: (channel, fn) => { handlers[channel] = fn; } },
  };
  return { electron, windows, handlers, platform, sourceCalls: () => calls };
}

function setup({ win = { hwnd: '42', x: 500, y: 200, w: 1000, h: 500, minimized: false }, style, ...options } = {}) {
  const fake = fakeElectron(options);
  const state = { win, lines: [{ text: 'We must reach the castle', box: { x: 100, y: 10, w: 400, h: 40 } }] };
  const helper = {
    ready: async () => ({ ocr: true }),
    findWindow: async () => state.win,
    recognize: async () => ({ lines: state.lines, ms: 1 }),
    close: () => { helper.closed = true; },
  };
  const manager = createOverlayManager({ ...fake.electron, helper, platform: fake.platform, trackMs: 15, log: () => {}, ...(style ? { style } : {}) });
  const matcher = { match: (text) => (/castle/.test(text) ? { arabic: 'القلعة', score: 0.9 } : null) };
  manager.start('game', { name: 'Game', matcher, getPids: () => [1234] });
  const [overlay, capture] = fake.windows;
  return { fake, state, helper, manager, overlay, capture };
}

test('the overlay is a click-through, always-on-top window kept out of captures', () => {
  const { overlay, capture, manager } = setup();
  assert.equal(overlay.options.transparent, true);
  assert.equal(overlay.options.focusable, false);
  assert.equal(overlay.options.skipTaskbar, true);
  assert.deepEqual(overlay.ignoreMouse, [true, { forward: true }]);
  assert.deepEqual(overlay.onTop, [true, 'screen-saver']);
  assert.equal(overlay.protected, true);
  assert.equal(capture.options.show, false);
  assert.equal(capture.options.webPreferences.backgroundThrottling, false);
  manager.stopAll();
});

test('the game\'s own window is captured when it can be, and the box covers the English', async () => {
  const { overlay, capture, manager } = setup({ style: 'box', sources: [{ id: 'screen:1:0', display_id: '7' }, { id: 'window:42:0' }] });
  await wait(60);
  const [[channel, config]] = capture.sent;
  assert.equal(channel, 'gs-capture:start');
  assert.equal(config.sourceId, 'window:42:0');
  assert.equal(config.windowRect, null);
  assert.deepEqual(config.region, [0, 0.78, 1, 0.22]);
  // The band sits over the subtitle area: the bottom 22% of the window.
  assert.deepEqual(overlay.bounds, { x: 500, y: 590, width: 1000, height: 110 });
  assert.equal(overlay.visible, true);
  assert.equal(manager.status('game').placement, 'cover');
  manager.stopAll();
});

test('otherwise the screen is captured, and the Arabic goes just above the subtitles', async () => {
  const { overlay, capture, manager } = setup({ sources: [{ id: 'screen:1:0', display_id: '7' }] });
  await wait(60);
  const config = capture.sent.find(([c]) => c === 'gs-capture:start')[1];
  assert.equal(config.sourceId, 'screen:1:0');
  assert.deepEqual(config.windowRect, [0.25, 0.2, 0.5, 0.5]);
  assert.deepEqual(overlay.bounds, { x: 500, y: 480, width: 1000, height: 110 });
  assert.equal(manager.status('game').placement, 'above');
  manager.stopAll();
});

test('a read subtitle reaches the overlay, placed where the English was', async () => {
  const { overlay, capture, fake, manager } = setup({ style: 'box', sources: [{ id: 'window:42:0' }] });
  await wait(60);
  // The capture window reports a settled subtitle: its crop is the bottom 22% of a 1000x500 frame.
  fake.handlers['gs-capture:read']({ sender: { id: capture.webContents.id } }, {
    bmp: new Uint8Array([66, 77]),
    crop: { x: 0, y: 390, width: 1000, height: 110, scale: 1, frameWidth: 1000, frameHeight: 500, windowRect: null },
  });
  await wait(30);
  const [, shown] = overlay.sent.find(([c]) => c === 'gs-overlay:show');
  assert.equal(shown.arabic, 'القلعة');
  assert.equal(shown.placement, 'cover');
  assert.deepEqual(Object.fromEntries(Object.entries(shown.box).map(([k, v]) => [k, Math.round(v * 100) / 100])), { x: 0.1, w: 0.4, y: 0.09, h: 0.36 });
  // Reads from any other window are ignored.
  fake.handlers['gs-capture:clear']({ sender: { id: 999 } });
  assert.equal(overlay.sent.filter(([c]) => c === 'gs-overlay:hide').length, 0);
  fake.handlers['gs-capture:clear']({ sender: { id: capture.webContents.id } });
  assert.equal(overlay.sent.filter(([c]) => c === 'gs-overlay:hide').length, 1);
  manager.stopAll();
});

test('floating text (the default) never covers the English: it goes just above it', async (t) => {
  const { overlay, manager } = setup({ sources: [{ id: 'window:42:0' }] });
  t.after(() => manager.stopAll());
  await wait(60);
  assert.equal(manager.style(), 'floating');
  // The capture could cover, but there's no box to hide the English with.
  assert.equal(manager.status('game').placement, 'above');
  assert.deepEqual(overlay.bounds, { x: 500, y: 480, width: 1000, height: 110 });
  // The overlay page is told its look when it loads.
  assert.deepEqual(overlay.sent.find(([c]) => c === 'gs-overlay:style'), ['gs-overlay:style', 'floating']);
  manager.stopAll();
});

test('switching the style moves running overlays at once, and new ones start with it', async (t) => {
  const { overlay, manager, fake } = setup({ sources: [{ id: 'window:42:0' }] });
  t.after(() => manager.stopAll());
  await wait(60);
  const before = overlay.sent.length;
  manager.setStyle('box');
  assert.deepEqual(overlay.sent.slice(before), [['gs-overlay:style', 'box']]);
  await wait(30);
  assert.equal(manager.status('game').placement, 'cover');
  assert.equal(manager.status('game').style, 'box');
  assert.deepEqual(overlay.bounds, { x: 500, y: 590, width: 1000, height: 110 });

  manager.setStyle('floating');
  await wait(30);
  assert.equal(manager.status('game').placement, 'above');
  assert.deepEqual(overlay.bounds, { x: 500, y: 480, width: 1000, height: 110 });

  manager.setStyle('box');
  manager.start('other', { name: 'Other', matcher: { match: () => null }, getPids: () => [99] });
  const other = fake.windows.at(-2);
  await wait(10);
  assert.deepEqual(other.sent.find(([c]) => c === 'gs-overlay:style'), ['gs-overlay:style', 'box']);
  assert.throws(() => manager.setStyle('neon'), /Unknown overlay style/);
  assert.equal(manager.style(), 'box');
});

test('with a screen capture, even the box goes above the subtitles (so OCR never reads it)', async () => {
  const { manager } = setup({ style: 'box', sources: [{ id: 'screen:1:0', display_id: '7' }] });
  await wait(60);
  assert.equal(manager.status('game').placement, 'above');
  manager.stopAll();
});

test('a capture that can\'t start is tried again', async () => {
  const { capture, fake, manager } = setup({ sources: [{ id: 'window:42:0' }], failFirst: true });
  await wait(80);
  assert.ok(fake.sourceCalls() >= 2);
  assert.ok(capture.sent.some(([c]) => c === 'gs-capture:start'));
  manager.stopAll();
});

test('the overlay hides while the game is minimized', async () => {
  const { overlay, state, manager } = setup({ sources: [{ id: 'window:42:0' }] });
  await wait(60);
  assert.equal(overlay.visible, true);
  state.win = { ...state.win, minimized: true };
  await wait(60);
  assert.equal(overlay.visible, false);
  manager.stopAll();
});

test('the overlay closes with the game', async () => {
  const { overlay, capture, manager, helper } = setup({ sources: [{ id: 'window:42:0' }] });
  manager.sync(new Map([['game', [1234]]]));
  assert.equal(manager.has('game'), true);
  manager.sync(new Map());
  assert.equal(manager.has('game'), false);
  assert.equal(overlay.destroyed && capture.destroyed, true);
  assert.equal(helper.closed, undefined); // the helper stays a minute, for the next game
});

test('only Windows 10 2004 and later can keep the overlay out of screen captures', () => {
  assert.equal(hidesFromCapture('win32', '10.0.22631'), true);
  assert.equal(hidesFromCapture('win32', '10.0.19041'), true);
  assert.equal(hidesFromCapture('win32', '10.0.18363'), false);
  assert.equal(hidesFromCapture('linux', '6.1.0'), false);
});
