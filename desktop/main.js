// GameShelf desktop app (Electron). It runs the same server as the website
// inside the app, on this computer only, and shows it in a launcher-style
// window: no browser bars, and the window buttons sit in GameShelf's top bar.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { SETTINGS_KEYS, readSettings, writeSettings } = require('./settings');
const { LAUNCHER_NAMES, scanInstalledGames } = require('./installed');
const { processesOf, listProcesses, stopProcesses } = require('./processes');
const { createCustomGames, suggestName } = require('./custom-games');
const { getGpuPreference, setGpuPreference, pickMainProgram, createProgramStore, gogUninstaller } = require('./game-options');
const { createDiscordPresence } = require('./discord');
const config = require('./config.json');
const { normalizeTitle } = require('../src/text');

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
  // Closing the connection clears the activity on Discord.
  app.on('will-quit', () => presence?.close());
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
  matches.clear();
  startPresence();
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

// ---- Installed games ----------------------------------------------------------------

const SCAN_TTL_MS = 15 * 1000;
let scan = { at: 0, games: Promise.resolve([]) };
// Each installed game's GameShelf page (or null), looked up once per game database.
const matches = new Map();
const customGames = createCustomGames(path.join(dataDir, 'custom-games.json'));
const programs = createProgramStore(path.join(dataDir, 'game-programs.json'));
// The game's program file: known for GOG games and games added by hand, learned
// for Steam and Epic games the first time they're seen running.
const programOf = (game) => game.exe || programs.get(game.key);

// Rescans at most every few seconds, so games installed while the app is open show up.
function scannedGames() {
  if (Date.now() - scan.at > SCAN_TTL_MS) {
    scan = { at: Date.now(), games: scanInstalledGames().catch(() => []) };
  }
  return scan.games;
}

/** Games found in launchers, then games added by hand. */
async function installedGames() {
  return [...(await scannedGames()), ...customGames.all()];
}

async function installedGame(key) {
  const game = (await installedGames()).find((g) => g.key === key);
  if (!game) throw new Error('That game is no longer installed.');
  return game;
}

async function findGamePages(installed) {
  const unknown = installed.filter((g) => g.launcher !== 'custom' && !matches.has(g.key));
  // Steam games match exactly by their Steam ID, in one go.
  const steam = unknown.filter((g) => g.steamAppId);
  if (steam.length) {
    try {
      const found = await games.matchSteamGames(steam.map((g) => ({ appid: g.steamAppId, name: g.name })));
      steam.forEach((g, i) => matches.set(g.key, found[i]));
    } catch (err) {
      console.error('Could not match Steam games:', err.message);
    }
  }
  // Other launchers: a search for the exact name.
  for (const g of unknown.filter((x) => !x.steamAppId)) {
    try {
      const { results } = await games.search({ query: g.name, pageSize: 5 });
      matches.set(g.key, results.find((r) => normalizeTitle(r.name) === normalizeTitle(g.name)) || null);
    } catch (err) {
      console.error(`Could not match "${g.name}":`, err.message);
    }
  }
}

// Games added by hand carry the GameShelf game picked when adding them.
const pageOf = (g) => (g.launcher === 'custom' ? g.game : matches.get(g.key));
const describe = (g) => ({ key: g.key, launcher: LAUNCHER_NAMES[g.launcher] });

function launch(game) {
  // Launcher links (steam://, com.epicgames.launcher://) go through the launcher.
  // GOG games and games added by hand start from their own program file.
  if (game.url) return shell.openExternal(game.url);
  const child = spawn(game.exe, [], { cwd: game.cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => console.error(`Could not start ${game.name}:`, err.message));
  child.unref();
}

// ---- Running games ------------------------------------------------------------------

// While a game is starting or running, the process list is checked every few
// seconds; otherwise only when a page asks.
const POLL_MS = 3000;
// A page asking for states within this long of the last check gets that check's answer.
const RECHECK_MS = 1000;
const START_TIMEOUT_MS = 2 * 60 * 1000;
const starting = new Map(); // key -> when Play was pressed
let running = new Map(); // key -> process IDs
const runningSince = new Map(); // key -> when it was first seen running
let checking = null;
let lastCheck = 0;
let pollTimer = null;

function gameStates() {
  const states = {};
  for (const key of starting.keys()) states[key] = 'starting';
  for (const key of running.keys()) states[key] = 'running';
  return states;
}

function sendStates() {
  if (win && !win.isDestroyed()) win.webContents.send('installed:states', gameStates());
}

function checkRunning() {
  checking ??= (async () => {
    try {
      const [installed, processes] = await Promise.all([installedGames(), listProcesses()]);
      const before = JSON.stringify(gameStates());
      const now = new Map();
      for (const game of installed) {
        const own = processesOf(game, processes);
        if (!own.length) continue;
        now.set(game.key, own.map((p) => p.pid));
        if (!game.exe) programs.remember(game.key, pickMainProgram(own.map((p) => p.path)));
      }
      running = now;
      for (const key of now.keys()) if (!runningSince.has(key)) runningSince.set(key, Date.now());
      for (const key of runningSince.keys()) if (!now.has(key)) runningSince.delete(key);
      updatePresence(installed);
      for (const [key, since] of starting) {
        if (running.has(key) || Date.now() - since > START_TIMEOUT_MS) starting.delete(key);
      }
      if (JSON.stringify(gameStates()) !== before) sendStates();
    } finally {
      lastCheck = Date.now();
      checking = null;
      schedulePoll();
    }
  })();
  return checking;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (starting.size || running.size) pollTimer = setTimeout(checkRunning, POLL_MS);
}

// ---- Discord activity ---------------------------------------------------------------

let presence = null;

// GameShelf's own Discord application, the same for everyone (like any app with
// a Discord activity). Its ID isn't a secret: Discord sees it from every copy.
// DISCORD_CLIENT_ID overrides it, for testing with another application.
const discordAppId = () => process.env.DISCORD_CLIENT_ID || config.discordApplicationId;

// Restarted whenever the settings change, since the player may have turned it off.
function startPresence() {
  presence?.close();
  const on = discordAppId() && process.env.DISCORD_ACTIVITY !== 'off';
  presence = on ? createDiscordPresence({ clientId: discordAppId() }) : null;
  if (presence) installedGames().then(updatePresence).catch(() => {});
}

const lookingUp = new Set();

/** Shows the game started most recently, or nothing when no game is running. */
function updatePresence(installed) {
  if (!presence) return;
  const [key] = [...runningSince].sort((a, b) => b[1] - a[1])[0] || [];
  const game = key && installed.find((g) => g.key === key);
  if (!game) {
    presence.set(null);
    return;
  }
  const page = pageOf(game);
  // A game started before its GameShelf page was looked up: look it up, then show its cover.
  if (!page && game.launcher !== 'custom' && !matches.has(game.key) && !lookingUp.has(game.key)) {
    lookingUp.add(game.key);
    findGamePages([game]).finally(() => {
      lookingUp.delete(game.key);
      updatePresence(installed);
    });
  }
  const url = games.name === 'igdb' && page?.id ? `https://www.igdb.com/games/${encodeURIComponent(page.id)}`
    : game.steamAppId ? `https://store.steampowered.com/app/${game.steamAppId}/` : null;
  presence.set({
    name: page?.name || game.name,
    launcher: LAUNCHER_NAMES[game.launcher],
    startedAt: runningSince.get(key),
    image: page?.poster || page?.image || null,
    url,
  });
}

// ---- Bridge for the page (see preload.js) -----------------------------------------

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

// Program files picked in the file dialog, waiting for the page to name them.
// The page only ever holds a token, never a path it could change.
const picked = new Map();

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('Not allowed.');
    return fn(...args);
  });

  handle('settings:get', async () => ({
    values: readSettings(settingsFile),
    source: games.name,
    dataDir: app.isPackaged ? dataDir : null,
    discord: Boolean(discordAppId()),
  }));
  handle('settings:save', async (input) => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    applySettings(writeSettings(settingsFile, input));
    buildApp();
    return { source: games.name, problem: await checkGameData() };
  });

  // Installed games that have a GameShelf page, for the home screen. Games
  // added by hand show even without one.
  handle('installed:list', async () => {
    const installed = await installedGames();
    await findGamePages(installed);
    return installed
      .filter((g) => pageOf(g) || g.launcher === 'custom')
      .map((g) => ({ ...describe(g), game: pageOf(g) || { id: null, name: g.name } }));
  });
  // Whether the game on a game page is installed: a game added by hand for this
  // page, the same Steam ID, or else the exact name.
  handle('installed:find', async ({ id, steamAppId, name } = {}) => {
    const installed = await installedGames();
    const target = normalizeTitle(name || '');
    const game = (id && installed.find((g) => g.launcher === 'custom' && g.game?.id === id)) ||
      (steamAppId && installed.find((g) => g.steamAppId === Number(steamAppId))) ||
      (target && installed.find((g) => normalizeTitle(g.name) === target));
    return game ? describe(game) : null;
  });
  // Only games found by the scan or added by hand can be started; the page passes just the key.
  handle('installed:launch', async (key) => {
    const game = await installedGame(key);
    if (running.has(key)) return;
    await launch(game);
    starting.set(key, Date.now());
    sendStates();
    schedulePoll();
  });
  handle('installed:stop', async (key) => {
    starting.delete(key);
    await checkRunning();
    const pids = running.get(key) || [];
    sendStates();
    await stopProcesses(pids);
    await checkRunning();
  });
  // Current states; checks the process list unless it was checked a moment ago.
  handle('installed:states', async () => {
    if (Date.now() - lastCheck > RECHECK_MS) await checkRunning();
    return gameStates();
  });

  // What the arrow on the Play button offers for this game.
  handle('installed:options', async (key) => {
    const game = await installedGame(key);
    const program = programOf(game);
    return {
      launcher: LAUNCHER_NAMES[game.launcher],
      gpu: process.platform === 'win32' ? { known: Boolean(program), value: program ? await getGpuPreference(program) : 0 } : null,
      folder: Boolean(game.dir && fs.existsSync(game.dir)),
      steam: game.launcher === 'steam',
      uninstall: game.launcher === 'steam' || Boolean(game.launcher === 'gog' && gogUninstaller(game.dir)),
      removable: game.launcher === 'custom',
    };
  });
  // Only these actions exist; the page passes the game's key and the action's name.
  handle('installed:action', async (key, action, value) => {
    const game = await installedGame(key);
    const steamOnly = () => {
      if (game.launcher !== 'steam') throw new Error('This option is for Steam games.');
    };
    switch (action) {
      case 'gpu': {
        const program = programOf(game);
        if (!program) throw new Error('Play the game once first, so GameShelf can find its program.');
        return setGpuPreference(program, Number(value));
      }
      case 'graphics-settings':
        return shell.openExternal('ms-settings:display-advancedgraphics');
      case 'open-folder': {
        const problem = game.dir ? await shell.openPath(game.dir) : 'This game has no folder.';
        if (problem) throw new Error(problem);
        return;
      }
      case 'steam-properties':
        steamOnly();
        return shell.openExternal(`steam://gameproperties/${game.steamAppId}`);
      case 'verify':
        steamOnly();
        return shell.openExternal(`steam://validate/${game.steamAppId}`);
      case 'uninstall': {
        // The launcher's own uninstaller asks for confirmation.
        if (game.launcher === 'steam') return shell.openExternal(`steam://uninstall/${game.steamAppId}`);
        const uninstaller = game.launcher === 'gog' && gogUninstaller(game.dir);
        if (!uninstaller) throw new Error('GameShelf can’t uninstall this game.');
        spawn(uninstaller, [], { cwd: game.dir, detached: true, stdio: 'ignore' }).unref();
        return;
      }
      case 'remove':
        if (game.launcher !== 'custom') throw new Error('Only games you added can be removed here.');
        return customGames.remove(key);
      default:
        throw new Error('Unknown option.');
    }
  });

  handle('custom:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose the game’s program',
      buttonLabel: 'Choose',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    });
    const exe = result.filePaths[0];
    if (result.canceled || !exe) return null;
    const token = crypto.randomUUID();
    picked.set(token, exe);
    return { token, file: path.basename(exe), name: suggestName(exe) };
  });
  handle('custom:add', async ({ token, name, game } = {}) => {
    const exe = picked.get(token);
    if (!exe) throw new Error('Choose the game’s program again.');
    const entry = customGames.add({ exe, name, game });
    picked.delete(token);
    return describe({ ...entry, launcher: 'custom' });
  });
  handle('custom:list', async () => customGames.all().map((g) => ({ key: g.key, name: g.name, file: g.exe })));
  handle('custom:remove', async (key) => {
    customGames.remove(key);
  });

  handle('data-folder:open', async () => {
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
  scannedGames();
  await startServer();
  registerIpc();
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // The first time the installed app opens, it starts on App settings to add the free keys.
  createWindow(firstRun && app.isPackaged ? '/#/app-settings?welcome=1' : '/');
  app.on('activate', () => {
    if (!win) createWindow('/');
  });
}
