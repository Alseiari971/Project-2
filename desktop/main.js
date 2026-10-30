// GameShelf desktop app (Electron). It runs the same server as the website
// inside the app, on this computer only, and shows it in a launcher-style
// window: no browser bars, and the window buttons sit in GameShelf's top bar.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { SETTINGS_KEYS, readSettings, writeSettings } = require('./settings');

app.setName('GameShelf');
if (process.platform === 'win32') app.setAppUserModelId('app.gameshelf.desktop');

const HOST = '127.0.0.1';
// A fixed port keeps logins and saved preferences between launches, since the
// browser side ties them to the address. The next few are tried if it's taken.
const FIRST_PORT = 41730;
const PORT_TRIES = 10;
const CHROME_COLOR = '#111215'; // --chrome in public/css/styles.css
const TOP_BAR_HEIGHT = 63; // --top-h minus its bottom border

const dataDir = app.getPath('userData');
// Installed: keys and the database live in the user's app data folder.
// From source (npm run app): the project's own .env and database, like npm start.
const settingsFile = app.isPackaged ? path.join(dataDir, 'settings.env') : path.join(__dirname, '..', '.env');
const windowFile = path.join(dataDir, 'window.json');
if (app.isPackaged) process.env.DB_FILE = path.join(dataDir, 'gameshelf.db');

let win = null;
let origin = null;
let games = null;
let handler = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start).catch((err) => {
    console.error(err);
    dialog.showErrorBox('GameShelf could not start', err.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
}

function applySettings(values) {
  for (const key of SETTINGS_KEYS) {
    if (values[key]) process.env[key] = values[key];
    else delete process.env[key];
  }
}

// ---- Server -----------------------------------------------------------------------

let db;
function buildApp() {
  // Required here, after the settings are in process.env.
  const { createApp } = require('../server');
  const { openDatabase } = require('../src/db');
  const { createGameProvider } = require('../src/games');
  db ??= openDatabase();
  games = createGameProvider(process.env, { db });
  handler = createApp({ db, games });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve(port);
    });
  });
}

async function startServer() {
  const server = http.createServer((req, res) => {
    // Only this app's own address is served, which stops other web pages from
    // reaching the server through a look-alike domain (DNS rebinding).
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(421).end();
      return;
    }
    handler(req, res);
  });
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_TRIES; port++) {
    try {
      await listen(server, port);
      origin = `http://${HOST}:${port}`;
      return;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`Ports ${FIRST_PORT} to ${FIRST_PORT + PORT_TRIES - 1} are all in use by other programs.`);
}

// ---- Window -----------------------------------------------------------------------

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(windowFile, JSON.stringify(state));
  } catch {}
}

const openExternal = (url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
};

function createWindow(startPath) {
  const saved = loadWindowState();
  win = new BrowserWindow({
    width: saved.width || 1440,
    height: saved.height || 900,
    x: saved.x,
    y: saved.y,
    minWidth: 960,
    minHeight: 600,
    title: 'GameShelf',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: CHROME_COLOR,
    show: false,
    // GameShelf's top bar is the title bar. Windows and Linux draw the
    // minimize, maximize and close buttons over its right end.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 24 } }
      : { titleBarOverlay: { color: CHROME_COLOR, symbolColor: '#e6e6e6', height: TOP_BAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  const contents = win.webContents;
  // Store pages, trailers on YouTube and every other outside link open in the
  // normal web browser; the window only ever shows GameShelf.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return;
    event.preventDefault();
    openExternal(url);
  });

  // Mouse back/forward buttons, and the usual keyboard shortcuts.
  const nav = contents.navigationHistory;
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward' && nav.canGoBack()) nav.goBack();
    if (command === 'browser-forward' && nav.canGoForward()) nav.goForward();
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key;
    let handled = true;
    if (input.alt && key === 'ArrowLeft') nav.canGoBack() && nav.goBack();
    else if (input.alt && key === 'ArrowRight') nav.canGoForward() && nav.goForward();
    else if (key === 'F5' || (ctrl && key.toLowerCase() === 'r')) contents.reload();
    else if (key === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (ctrl && (key === '=' || key === '+')) contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 3));
    else if (ctrl && key === '-') contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3));
    else if (ctrl && key === '0') contents.setZoomLevel(0);
    else if (!app.isPackaged && key === 'F12') contents.toggleDevTools();
    else handled = false;
    if (handled) event.preventDefault();
  });

  // Right-click: copy, cut and paste in text boxes, copy on selected text.
  contents.on('context-menu', (_e, params) => {
    const items = params.isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : params.selectionText.trim() ? [{ role: 'copy' }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.loadURL(origin + startPath);
}

// ---- Settings bridge (used by the App settings page, see preload.js) ---------------

function fromApp(event) {
  try {
    return new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}

// Asks the game database for one page of games, so a wrong key shows up right away.
async function checkGameData() {
  if (games.name === 'local') return null;
  try {
    await games.search({ sort: 'popular', pageSize: 1 });
    return null;
  } catch (err) {
    return err.message;
  }
}

function registerIpc() {
  ipcMain.handle('settings:get', async (event) => {
    if (!fromApp(event)) throw new Error('Not allowed.');
    return { values: readSettings(settingsFile), source: games.name, dataDir: app.isPackaged ? dataDir : null };
  });
  ipcMain.handle('settings:save', async (event, input) => {
    if (!fromApp(event)) throw new Error('Not allowed.');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    applySettings(writeSettings(settingsFile, input));
    buildApp();
    return { source: games.name, problem: await checkGameData() };
  });
  ipcMain.handle('data-folder:open', async (event) => {
    if (!fromApp(event)) throw new Error('Not allowed.');
    await shell.openPath(app.isPackaged ? dataDir : path.join(__dirname, '..', 'data'));
  });
}

async function start() {
  const firstRun = !fs.existsSync(settingsFile);
  if (firstRun && app.isPackaged) {
    fs.mkdirSync(dataDir, { recursive: true });
    writeSettings(settingsFile, {});
  }
  for (const [key, value] of Object.entries(readSettings(settingsFile))) {
    if (value) process.env[key] = value;
  }
  buildApp();
  await startServer();
  registerIpc();
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // The first time the installed app opens, it starts on App settings to add the free keys.
  createWindow(firstRun && app.isPackaged ? '/#/app-settings?welcome=1' : '/');
  app.on('activate', () => {
    if (!win) createWindow('/');
  });
}
