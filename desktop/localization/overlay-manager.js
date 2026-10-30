// The Arabic subtitle overlay for games GameShelf can't change: a see-through,
// click-through band kept over the game's subtitle area (or just above it),
// and a hidden window that watches that area. One of each per running game;
// they close with it.
//
// Every second the game's window is looked up (by its process IDs) so the
// overlay follows it when it moves, hides when it's minimized, and captures
// the right window. Windows captures a single window on its own when it can
// (the overlay is then never in the picture); otherwise the whole screen is
// captured and the game's part of it is used.
const os = require('node:os');
const path = require('node:path');
const { createSubtitleSession } = require('./subtitle-session');

const OVERLAY_HTML = path.join(__dirname, '..', 'overlay', 'overlay.html');
const CAPTURE_HTML = path.join(__dirname, '..', 'overlay', 'capture.html');
const DEFAULT_PROFILE = { region: [0, 0.78, 1, 0.22], textLuma: 170, darkText: false, tickMs: 33 };
const TRACK_MS = 1000;
const START_TIMEOUT_MS = 2 * 60 * 1000;
const HELPER_IDLE_MS = 60 * 1000;

// Windows 10 2004 (build 19041) and later can keep a window out of screen
// captures; earlier versions would capture it as a black box.
function hidesFromCapture(platform = process.platform, release = os.release()) {
  if (platform !== 'win32') return false;
  const build = Number(String(release).split('.')[2]);
  return build >= 19041;
}

function createOverlayManager({ BrowserWindow, desktopCapturer, screen, ipcMain, helper, log = console.error, platform = process.platform, trackMs = TRACK_MS }) {
  const sessions = new Map();
  let helperTimer = null;

  const byCapture = (event) => [...sessions.values()].find((s) => !s.capture.isDestroyed() && s.capture.webContents.id === event.sender.id);
  ipcMain.on('gs-capture:read', (event, image) => byCapture(event)?.subtitles.read({ bmp: Buffer.from(image.bmp), crop: image.crop }));
  ipcMain.on('gs-capture:clear', (event) => byCapture(event)?.subtitles.clear());
  ipcMain.on('gs-capture:status', (event, status) => {
    const session = byCapture(event);
    if (!session) return;
    session.status = status;
    if (status.error) log(`Subtitle capture for ${session.name}: ${status.error}`);
  });

  // Screen pixels (what Windows reports) to the app's own units.
  function toDip(win) {
    const rect = { x: win.x, y: win.y, width: win.w, height: win.h };
    return platform === 'win32' && screen.screenToDipRect ? screen.screenToDipRect(null, rect) : rect;
  }

  function send(session, channel, payload) {
    if (!session.overlay.isDestroyed()) session.overlay.webContents.send(channel, payload);
  }

  // The overlay is a band the width of the game: over the subtitle area when
  // the capture can't see it, otherwise just above it. `top` and `share` are
  // where the band sits in the window, as shares of its height.
  function bandFor(bounds, region, placement) {
    const [, y, , h] = region;
    const top = placement === 'cover' ? y : Math.max(0, y - h);
    const share = placement === 'cover' ? h : y - top;
    return {
      x: bounds.x,
      y: Math.round(bounds.y + top * bounds.height),
      width: bounds.width,
      height: Math.max(40, Math.round(share * bounds.height)),
      top,
      share: share || 1,
    };
  }

  // OCR's box (shares of the window) as shares of the band.
  function inBand(box, band) {
    return box && { x: box.x, w: box.w, y: (box.y - band.top) / band.share, h: box.h / band.share };
  }

  async function startCapture(session, win, bounds) {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const own = sources.find((s) => s.id.startsWith(`window:${win.hwnd}:`));
    let config;
    if (own) {
      config = { sourceId: own.id, windowRect: null };
    } else {
      const display = screen.getDisplayMatching(bounds);
      const source = sources.find((s) => s.display_id === String(display.id)) || sources.find((s) => s.id.startsWith('screen:'));
      if (!source) throw new Error('There\'s no screen to capture.');
      session.display = display;
      config = { sourceId: source.id, windowRect: windowRect(bounds, display) };
    }
    // Only cover the English when the capture can't see the overlay.
    session.placement = own || hidesFromCapture(platform) ? 'cover' : 'above';
    session.screenCapture = !own;
    session.capture.webContents.send('gs-capture:start', { ...session.profile, ...config });
  }

  const windowRect = (bounds, display) => [
    (bounds.x - display.bounds.x) / display.bounds.width,
    (bounds.y - display.bounds.y) / display.bounds.height,
    bounds.width / display.bounds.width,
    bounds.height / display.bounds.height,
  ];

  async function track(session) {
    if (session.stopped || session.tracking) return;
    session.tracking = true;
    try {
      const pids = session.getPids() || [];
      if (!pids.length) session.refresh?.(); // the game's processes aren't known yet: look now
      const win = pids.length ? await helper.findWindow(pids) : null;
      if (session.stopped) return;
      if (!win || win.minimized || win.w < 64 || win.h < 64) {
        if (session.overlay.isVisible()) session.overlay.hide();
        return;
      }
      const bounds = toDip(win);
      if (win.hwnd !== session.hwnd) {
        session.subtitles.clear();
        await startCapture(session, win, bounds); // throws when it can't: tried again next second
        session.hwnd = win.hwnd;
      } else if (session.screenCapture && session.display) {
        session.capture.webContents.send('gs-capture:window', windowRect(bounds, session.display));
      }
      session.band = bandFor(bounds, session.profile.region, session.placement);
      const { x, y, width, height } = session.band;
      const old = session.overlay.getBounds();
      if (old.x !== x || old.y !== y || old.width !== width || old.height !== height) session.overlay.setBounds({ x, y, width, height });
      if (!session.overlay.isVisible()) session.overlay.showInactive();
      session.lastError = null;
    } catch (err) {
      if (err.message !== session.lastError) log(`Arabic overlay for ${session.name}: ${err.message}`);
      session.lastError = err.message;
    } finally {
      session.tracking = false;
    }
  }

  /**
   * Starts the overlay for a game that's starting. `matcher` comes from the
   * game's overlay pack; `profile` can move the subtitle area or change what
   * counts as text; `getPids` returns the game's running process IDs, and
   * `refresh` asks for them to be looked up again.
   */
  function start(key, { name, matcher, profile = {}, getPids, refresh }) {
    if (sessions.has(key)) return;
    clearTimeout(helperTimer);
    const overlay = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'GameShelf Arabic subtitles',
      webPreferences: { preload: path.join(__dirname, '..', 'overlay', 'overlay-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setContentProtection(true);
    overlay.loadFile(OVERLAY_HTML);

    const capture = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: path.join(__dirname, '..', 'overlay', 'capture-preload.js'),
        partition: 'gameshelf-capture',
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    capture.loadFile(CAPTURE_HTML);

    const session = {
      key,
      name,
      overlay,
      capture,
      profile: { ...DEFAULT_PROFILE, ...profile },
      getPids,
      refresh,
      hwnd: null,
      seen: false,
      startedAt: Date.now(),
      stopped: false,
      placement: 'above',
      status: null,
    };
    session.subtitles = createSubtitleSession({
      recognize: (bmp) => helper.recognize(bmp),
      match: (text) => matcher.match(text),
      show: (subtitle) => send(session, 'gs-overlay:show', { arabic: subtitle.arabic, box: session.band ? inBand(subtitle.box, session.band) : null, placement: session.placement }),
      hide: () => send(session, 'gs-overlay:hide'),
      log: (message) => log(`Arabic overlay for ${name}: ${message}`),
    });
    session.timer = setInterval(() => track(session), trackMs);
    sessions.set(key, session);
    helper.ready().catch((err) => log(`Arabic overlay for ${name}: ${err.message}`));
    capture.webContents.once('did-finish-load', () => track(session));
  }

  function stop(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.stopped = true;
    clearInterval(session.timer);
    session.subtitles.close();
    for (const win of [session.capture, session.overlay]) if (!win.isDestroyed()) win.destroy();
    if (!sessions.size) {
      clearTimeout(helperTimer);
      helperTimer = setTimeout(() => helper.close(), HELPER_IDLE_MS);
      helperTimer.unref?.();
    }
  }

  /** Called with the running games (key -> process IDs): overlays close with their game. */
  function sync(running) {
    for (const session of [...sessions.values()]) {
      if (running.has(session.key)) session.seen = true;
      else if (session.seen || Date.now() - session.startedAt > START_TIMEOUT_MS) stop(session.key);
    }
  }

  return {
    start,
    stop,
    sync,
    stopAll: () => [...sessions.keys()].forEach(stop),
    has: (key) => sessions.has(key),
    status: (key) => {
      const s = sessions.get(key);
      return s && { placement: s.placement, capture: s.status, ...s.subtitles.stats };
    },
  };
}

module.exports = { createOverlayManager, hidesFromCapture, DEFAULT_PROFILE };
