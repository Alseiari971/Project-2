// The desktop app's security rules, in one place so they can be tested
// without Electron:
//
// - externalUrl: which addresses may leave the app for the web browser or a
//   game launcher. Only https:// pages, and a short list of launcher links
//   built from a numeric Steam app ID or an Epic app name.
// - createPickedPaths: file paths the page may hand back to the app must be
//   ones the player chose in the app's own file dialog, so a page can never
//   make the app read or write a file of its choosing.
// - lockDown: every window and frame stays on GameShelf's own pages, opens
//   no pop-ups, embeds no <webview>, and gets no camera, microphone or
//   location (the subtitle capture window alone may record the screen).
const path = require('node:path');

const STEAM_ACTIONS = ['rungameid', 'gameproperties', 'validate', 'uninstall'];
const EPIC_APP_RE = /^[A-Za-z0-9_.\-:]{1,200}$/;

/** The URL itself when it may be opened outside the app, else null. */
function externalUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2048 || /[\0\r\n\s]/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.username || url.password ? null : url.href;
  if (url.protocol === 'steam:') {
    // steam://rungameid/367520 and friends: an action and a number, nothing else.
    const m = /^steam:\/\/([a-z]+)\/(\d{1,10})$/.exec(text);
    return m && STEAM_ACTIONS.includes(m[1]) ? text : null;
  }
  if (url.protocol === 'com.epicgames.launcher:') {
    const m = /^com\.epicgames\.launcher:\/\/apps\/([^?/#]+)\?action=launch&silent=true$/.exec(text);
    return m && EPIC_APP_RE.test(decodeURIComponent(m[1])) ? text : null;
  }
  if (text === 'ms-settings:display-advancedgraphics') return text;
  return null;
}

/** Epic's launch link for an app name, encoded so it can't carry anything else. */
const epicLaunchUrl = (appName) => `com.epicgames.launcher://apps/${encodeURIComponent(String(appName))}?action=launch&silent=true`;

/**
 * Paths chosen in the app's own file dialogs. `remember` is called with what
 * the dialog returned; `check(value)` returns it (resolved) only if it was
 * chosen, or throws. Values the app saved itself can be trusted with `allow`.
 */
function createPickedPaths() {
  const picked = new Set();
  const norm = (p) => path.resolve(String(p));
  return {
    remember(p) {
      if (p) picked.add(norm(p));
      return p;
    },
    allow(p) {
      if (p) picked.add(norm(p));
    },
    has: (p) => Boolean(p) && picked.has(norm(p)),
    check(p, what = 'That file') {
      if (!p) return p;
      if (!picked.has(norm(p))) throw new Error(`${what} wasn't chosen in GameShelf's file picker.`);
      return norm(p);
    },
  };
}

/** True for a message from the top frame of a page on `origin` (not an iframe, not another site). */
function trustedSender(event, origin) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false;
    return new URL(frame.url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Locks down one webContents: no navigation away from `allowed(url)`, no
 * pop-ups (outside links go to `openOutside`), no <webview>.
 */
function lockContents(contents, { allowed, openOutside }) {
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  const keepIn = (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    openOutside(url);
  };
  contents.on('will-navigate', keepIn);
  contents.on('will-redirect', keepIn);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Permissions for every page: nothing, except copying text in GameShelf's own
 * window, full-screen trailers, and screen capture for the subtitle capture window.
 */
function permissionPolicy({ origin, captureUrl }) {
  return (permission, requestingUrl) => {
    const url = String(requestingUrl || '');
    if (permission === 'media') return Boolean(captureUrl) && url.startsWith(captureUrl);
    if (permission === 'clipboard-sanitized-write') return url.startsWith(`${origin}/`) || url === origin;
    if (permission === 'fullscreen') return true;
    return false;
  };
}

/** The webPreferences every window gets, whatever else it sets. */
const SAFE_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
});

module.exports = { externalUrl, epicLaunchUrl, createPickedPaths, trustedSender, lockContents, permissionPolicy, SAFE_PREFERENCES };
