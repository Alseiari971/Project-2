// GameShelf desktop app (Electron). It serves the website's pages from inside
// the app, on this computer only, and shows them in a launcher-style window: no
// browser bars, and the window buttons sit in GameShelf's top bar. Accounts,
// game data and Arabic packs come from GameShelf's server (config.json's
// "server", see cloud.js); without one, the app runs the whole website itself.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, desktopCapturer, screen, session, safeStorage } = require('electron');
const { SETTINGS_KEYS, readSettings, writeSettings } = require('./settings');
const { LAUNCHER_NAMES, scanInstalledGames, suggestedStatus } = require('./installed');
const { processesOf, listProcesses, stopProcesses } = require('./processes');
const { createCustomGames, suggestName } = require('./custom-games');
const { getGpuPreference, setGpuPreference, pickMainProgram, createProgramStore, gogUninstaller } = require('./game-options');
const { createDiscordPresence } = require('./discord');
const { createArabicService } = require('./localization/service');
const { createOcrHelper, defaultSpawn } = require('./localization/ocr');
const { createOverlayManager } = require('./localization/overlay-manager');
const { createArabicOnline, gameKey } = require('./localization/online');
const { createPackBuilder, findBuilder, localPackKey } = require('./localization/builder');
const { createPassThrough, createCloudClient, createRemoteGames, SESSION_COOKIE } = require('./cloud');
const { createStudio } = require('./localization/studio');
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
    // The window may be closed while Arabic subtitles keep the app running for a game.
    if (!win) {
      if (origin) createWindow('/');
      return;
    }
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
  app.on('will-quit', () => {
    presence?.close();
    overlays?.stopAll();
    packBuilder.stopAll();
    ocrHelper.close();
  });
}

function applySettings(values) {
  for (const key of SETTINGS_KEYS) {
    if (values[key]) process.env[key] = values[key];
    else delete process.env[key];
  }
}

// ---- Server -----------------------------------------------------------------------

// GameShelf's server: config.json's "server". When developing, GAMESHELF_SERVER
// points the app at another one (http://127.0.0.1:3000, say), or "local" runs
// the whole website inside the app, with its own accounts and keys.
const cloudServer = (() => {
  const chosen = !app.isPackaged && process.env.GAMESHELF_SERVER;
  if (chosen === 'local') return null;
  return (chosen || config.server || config.arabicServer || '').replace(/\/+$/, '') || null;
})();

let db;
function buildApp() {
  if (cloudServer) {
    games = createRemoteGames(cloud);
    handler = createPassThrough({ target: cloudServer, publicDir: path.join(__dirname, '..', 'public') });
    matches.clear();
    startPresence();
    return;
  }
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
    // GameShelf's top bar is the title bar. On Windows and Linux the page draws
    // its own minimize, maximize and close buttons, at the end of the top bar:
    // the right in English, the left in Arabic. A Mac keeps its own buttons.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 24 } } : {}),
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
  // The maximize button turns into a restore button and back.
  const sendMaximized = () => win.webContents.send('window:maximized', win.isMaximized());
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);

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
const programOf = (game) => game.exe || programs.get(game.key) || game.mainExe || null;

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

// ---- Arabic subtitles ---------------------------------------------------------------

// Packs are signed with GameShelf's key (see scripts/localization-pack.js);
// its public half goes in config.json. When developing, GAMESHELF_PACK_KEY_FILE
// can point at a test key, and GAMESHELF_OCR_HELPER at a stand-in OCR helper.
// From source, GAMESHELF_PACK_KEY_FILE, or else ../gameshelf-keys/pack-signing.pub
// beside the repository (where scripts/prepare-dist.js keeps the key pair).
const packKey = config.localizationPackKey || (() => {
  if (app.isPackaged) return null;
  const file = process.env.GAMESHELF_PACK_KEY_FILE || path.join(__dirname, '..', '..', 'gameshelf-keys', 'pack-signing.pub');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
})();
const devOcrHelper = !app.isPackaged ? process.env.GAMESHELF_OCR_HELPER : null;
const ocrHelper = createOcrHelper({ spawnHelper: defaultSpawn({ dataDir, devHelper: devOcrHelper }) });
// The app's own requests to GameShelf's server, as the signed-in player (the
// sign-in cookie the window keeps for the app's own address).
const cloud = createCloudClient({
  server: () => cloudServer || origin,
  session: async () => (origin ? (await session.defaultSession.cookies.get({ url: origin, name: SESSION_COOKIE }))[0]?.value || null : null),
});
// Arabic packs from the cloud catalog, and the shared translations (see online.js).
const online = createArabicOnline({ cloud, cacheDir: path.join(dataDir, 'localization', 'downloads') });
// Packs this app builds itself (from GameShelf's server, see below) are signed with a key made on this PC.
const localKey = localPackKey(dataDir);
const arabic = createArabicService({ dataDir, publicKey: [packKey, localKey.publicKey].filter(Boolean), overlayAvailable: process.platform === 'win32' || Boolean(devOcrHelper), catalog: online.catalog });
const builderPaths = findBuilder({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoDir: path.join(__dirname, '..') });
const packBuilder = createPackBuilder({
  paths: builderPaths,
  outDir: path.join(dataDir, 'localization', 'builds'),
  keyFile: localKey.keyFile,
});
// The Admin Panel's Pack Studio: builds, signs and publishes packs (see studio.js).
// API keys are kept encrypted by Windows (safeStorage), or for this session only.
const studio = createStudio({
  paths: builderPaths,
  dataDir,
  cloud,
  appKeys: [packKey].filter(Boolean),
  secure: {
    available: () => app.isReady() && safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  },
});
// Most of a game's lines must have Arabic before its pack goes in.
const ENOUGH_ARABIC = 0.9;
let overlays = null; // created once the app is ready

const arabicGame = (g) => ({ key: g.key, dir: g.dir, steamAppId: g.steamAppId || null, gameId: pageOf(g)?.id || null });

function startOverlay(key, game, ready) {
  overlays.start(key, {
    name: pageOf(game)?.name || game.name,
    matcher: ready.matcher,
    profile: ready.profile,
    getPids: () => running.get(key),
    // Until the game's processes show up, look for them every second instead of every few.
    refresh: () => {
      if (Date.now() - lastCheck > RECHECK_MS) checkRunning();
    },
  });
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
      overlays?.sync(running);
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
    badge: config.discordBadgeImage,
    url,
    getUrl: config.downloadPage,
  });
}

// ---- Arabic at a glance, and My games -----------------------------------------------

// For each installed game: 'on' (Arabic switched on), 'ready' (a pack here or in
// the catalog, or the server's translations are ready), 'request' (GameShelf can
// make it on request) or 'none'.
const badges = new Map();
let badgeJob = null;

function arabicBadges() {
  badgeJob ??= (async () => {
    const send = (key, badge) => {
      badges.set(key, badge);
      if (win && !win.isDestroyed()) win.webContents.send('installed:arabic', { key, badge });
    };
    try {
      const installed = await installedGames();
      const buildable = [];
      for (const game of installed) {
        let badge = 'none';
        try {
          const info = await arabic.info(arabicGame(game));
          if (info.enabled) badge = 'on';
          else if (info.mode === 'native' || info.mode === 'overlay') badge = 'ready';
          else if (info.missing && packBuilder.canBuild(info.tier)) badge = 'request';
        } catch {}
        if (badge === 'request') buildable.push(game);
        send(game.key, badge);
      }
      // The server's shared translations: ready ones turn on in a moment.
      const keys = buildable.map((g) => [g.key, gameKey(arabicGame(g))]).filter(([, k]) => k);
      if (keys.length && (await online.signedIn())) {
        const { games: statuses } = await cloud.json('/api/arabic/status', { method: 'POST', body: { games: keys.map(([, k]) => k) } }).catch(() => ({ games: {} }));
        for (const [key, serverKey] of keys) if (statuses[serverKey]?.status === 'ready') send(key, 'ready');
      }
    } finally {
      badgeJob = null;
    }
  })();
  return badgeJob;
}

const librarySyncFile = path.join(dataDir, 'library-sync.json');
/** { auto: true | false | null }: null until the player says whether games on this PC go on My games by themselves. */
function readLibrarySync() {
  try {
    const { auto } = JSON.parse(fs.readFileSync(librarySyncFile, 'utf8'));
    return { auto: typeof auto === 'boolean' ? auto : null };
  } catch {
    return { auto: null };
  }
}

// ---- Bridge for the page (see preload.js) -----------------------------------------

/** Sends a game's Arabic progress (building, downloading a pack) to the page. */
const arabicProgress = (key) => (progress) => {
  if (win && !win.isDestroyed()) win.webContents.send('arabic:progress', { key, ...progress });
};

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
    // Signed in to GameShelf's server: no game-database keys needed here.
    cloud: cloudServer,
    dataDir: app.isPackaged ? dataDir : null,
    discord: Boolean(discordAppId()),
  }));
  handle('settings:save', async (input) => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    applySettings(writeSettings(settingsFile, input));
    buildApp();
    return { source: games.name, problem: await checkGameData() };
  });

  // Installed games for the home screen, with their GameShelf page when there
  // is one. Games without one (demos, games the database doesn't know) show
  // too: they can still be played, and get Arabic packs by their Steam ID.
  const listInstalled = async () => {
    const installed = await installedGames();
    await findGamePages(installed);
    return installed.map((g) => ({ ...describe(g), steamAppId: g.steamAppId || null, game: pageOf(g) || { id: null, name: g.name } }));
  };
  handle('installed:list', listInstalled);
  // "Rescan PC games" (and signing in): looks at Steam, Epic and GOG again right away.
  handle('installed:rescan', async () => {
    scan.at = 0;
    const list = await listInstalled();
    arabicBadges().catch(() => {});
    return list;
  });
  // Each installed game's Arabic at a glance, for the Library: what's known now; the rest comes as 'installed:arabic' events.
  handle('installed:arabic', async () => {
    arabicBadges().catch(() => {});
    return Object.fromEntries(badges);
  });
  // Adding the games on this PC to My games: whether to do it by itself, and doing it.
  handle('library:sync-settings', async () => readLibrarySync());
  handle('library:set-sync', async (auto) => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(librarySyncFile, JSON.stringify({ auto: Boolean(auto) }));
    return readLibrarySync();
  });
  handle('library:sync', async () => {
    const installed = await installedGames();
    const list = installed.map((g) => ({ steamAppId: g.steamAppId || null, name: pageOf(g)?.name || g.name, status: suggestedStatus(g) }));
    let added = 0;
    let matched = 0;
    for (let i = 0; i < list.length; i += 300) {
      const result = await cloud.json('/api/me/library/installed', { method: 'POST', body: { games: list.slice(i, i + 300) }, timeout: 120000 });
      added += result.added;
      matched += result.matched;
    }
    return { added, matched, total: list.length };
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
  // With Arabic on, the patch goes in (or the overlay's table loads) before the
  // game starts; if that fails the game still starts, in English, and the page says why.
  handle('installed:launch', async (key) => {
    const game = await installedGame(key);
    if (running.has(key)) return null;
    const ready = await arabic.prepareLaunch(arabicGame(game), { onProgress: arabicProgress(key) }).catch((err) => ({ mode: 'error', ok: false, error: { text: err.message, vars: {} } }));
    // Start the OCR helper now, so it's warm by the time the game shows anything.
    if (ready.mode === 'overlay' && ready.ok) ocrHelper.ready().catch(() => {});
    await launch(game);
    starting.set(key, Date.now());
    if (ready.mode === 'overlay' && ready.ok) startOverlay(key, game, ready);
    sendStates();
    schedulePoll();
    return { arabic: { mode: ready.mode, ok: ready.ok, error: ready.error || null } };
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

  // The "Arabic subtitles" switch next to Play.
  handle('arabic:info', async (key) => {
    const game = await installedGame(key);
    return { ...(await arabic.info(arabicGame(game))), overlayRunning: Boolean(overlays?.has(key)), overlay: overlays?.status(key) || null };
  });
  handle('arabic:set', async (key, on) => {
    const game = await installedGame(key);
    const isRunning = async () => {
      await checkRunning();
      return running.has(key);
    };
    const result = await arabic.set(arabicGame(game), Boolean(on), { isRunning, onProgress: arabicProgress(key) });
    // The overlay can come and go while the game runs.
    if (!on) overlays?.stop(key);
    else if (result.info.mode === 'overlay' && !result.error && running.has(key) && !overlays.has(key)) {
      const ready = await arabic.prepareLaunch(arabicGame(game));
      if (ready.ok && ready.mode === 'overlay') startOverlay(key, game, ready);
    }
    return { info: { ...result.info, overlayRunning: Boolean(overlays?.has(key)) }, error: result.error };
  });
  // A game with no Arabic pack here: whether GameShelf's server has its Arabic
  // (the switch gets it), or whether it can be asked for.
  handle('arabic:online', async (key) => {
    const game = await installedGame(key);
    const info = await arabic.info(arabicGame(game));
    const serverKey = gameKey(arabicGame(game));
    const signedIn = await online.signedIn();
    const out = { configured: online.configured, signedIn, missing: Boolean(info.missing), canBuild: packBuilder.canBuild(info.tier), building: packBuilder.progress(key), server: null, error: null };
    if (!info.missing || !signedIn || !serverKey) return out;
    try {
      out.server = await online.status(serverKey);
    } catch (err) {
      out.error = { text: err.message, vars: {} };
    }
    return out;
  });
  // Makes the pack on this PC, with the Arabic from the server (which translates
  // what it doesn't have yet, once, for everyone), then turns Arabic on.
  handle('arabic:get', async (key) => {
    const game = await installedGame(key);
    const before = await arabic.info(arabicGame(game));
    if (!before.missing) return { done: true, info: before };
    try {
      const result = await packBuilder.build({ ...arabicGame(game), tier: before.tier, title: pageOf(game)?.name || game.name },
        { server: cloud.server(), auth: await online.builderEnv(), onProgress: arabicProgress(key) });
      const have = result.total ? (result.total - result.missing) / result.total : 0;
      if (have < ENOUGH_ARABIC) return { done: false, result, info: before };
      await arabic.packs.add(result.packDir);
      const { info, error } = await arabic.set(arabicGame(game), true);
      return { done: true, result, info, error };
    } catch (err) {
      return { done: false, info: before, error: { text: err.message, vars: {} } };
    }
  });
  // For games this PC can't make Arabic for: the request is counted on the server.
  handle('arabic:request', async (key) => {
    const game = await installedGame(key);
    const serverKey = gameKey(arabicGame(game));
    if (!serverKey) throw new Error('GameShelf doesn\'t know which game this is, so it can\'t ask for it.');
    return online.request(serverKey, pageOf(game)?.name || game.name);
  });
  // ---- Pack Studio (admins only; the server checks again when a pack is published) ----
  const requireAdmin = async () => {
    if ((await cloud.me())?.role !== 'admin') throw new Error('Only admins can do this.');
  };
  const studioSend = (channel) => (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  // Only folders the Studio built in can be published, added or opened from the page.
  const inStudio = (target) => {
    const resolved = path.resolve(String(target || ''));
    if (!resolved.startsWith(path.resolve(studio.outDir) + path.sep)) throw new Error('Not allowed.');
    return resolved;
  };
  handle('studio:settings', async () => {
    await requireAdmin();
    return studio.settings();
  });
  handle('studio:save-settings', async (input) => {
    await requireAdmin();
    return studio.saveSettings(input || {});
  });
  handle('studio:pick', async (kind) => {
    await requireAdmin();
    const choices = {
      folder: { title: 'Choose the game\'s folder', properties: ['openDirectory'] },
      file: { title: 'Choose a file with the game\'s text', properties: ['openFile'], filters: [{ name: 'Game text', extensions: ['locres', 'assets', 'rpy', 'rpa', 'csv', 'po', 'json', 'txt', 'msg', 'pck'] }, { name: 'All files', extensions: ['*'] }] },
      key: { title: 'Choose pack-signing.key', properties: ['openFile'], filters: [{ name: 'Signing key', extensions: ['key', 'pem'] }] },
      list: { title: 'Choose the game\'s file list', properties: ['openFile'], filters: [{ name: 'File lists', extensions: ['list', 'txt'] }] },
      csv: { title: 'Choose your checked translations.csv', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] },
      'keys-folder': { title: 'Choose a folder for the new signing key (keep it private)', properties: ['openDirectory', 'createDirectory'] },
    }[kind];
    if (!choices) throw new Error('Not allowed.');
    const result = await dialog.showOpenDialog(win, choices);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle('studio:make-keys', async (folder) => {
    await requireAdmin();
    return studio.makeKeys(String(folder));
  });
  handle('studio:build', async (options) => {
    await requireAdmin();
    return studio.build(options || {}, { onLog: studioSend('studio:log'), onProgress: studioSend('studio:progress') });
  });
  handle('studio:cancel', async () => studio.cancel());
  handle('studio:publish', async (packDir) => {
    await requireAdmin();
    return studio.publish(inStudio(packDir));
  });
  handle('studio:add-local', async (packDir) => {
    await requireAdmin();
    return arabic.packs.add(inStudio(packDir));
  });
  handle('studio:open', async (target) => {
    await requireAdmin();
    const error = await shell.openPath(inStudio(target));
    if (error) throw new Error(error);
  });

  handle('arabic:packs', async () => ({ ready: Boolean(packKey), packs: (await arabic.packs.list()).map(({ dir, ...p }) => p) }));
  handle('arabic:add-pack', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Choose an Arabic pack folder', buttonLabel: 'Add pack', properties: ['openDirectory'] });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    return arabic.packs.add(folder);
  });
  handle('arabic:remove-pack', async (id) => arabic.packs.remove(String(id)));
  handle('arabic:overlay-style', async () => arabic.overlayStyle());
  handle('arabic:set-overlay-style', async (style) => {
    const saved = await arabic.setOverlayStyle(String(style));
    overlays?.setStyle(saved); // overlays already showing change at once
    return saved;
  });

  handle('data-folder:open', async () => {
    await shell.openPath(app.isPackaged ? dataDir : path.join(__dirname, '..', 'data'));
  });

  // The page's own window buttons.
  handle('window:minimize', async () => win?.minimize());
  handle('window:toggle-maximize', async () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  handle('window:close', async () => win?.close());
  handle('window:is-maximized', async () => Boolean(win?.isMaximized()));
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
  overlays = createOverlayManager({ BrowserWindow, desktopCapturer, screen, ipcMain, helper: ocrHelper });
  arabic.overlayStyle().then((style) => overlays.setStyle(style)).catch((err) => console.error('Arabic overlay style:', err.message));
  // Takes back any Arabic patch that was cut short by a crash.
  arabic.recover().catch((err) => console.error('Could not tidy up Arabic patches:', err.message));
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // Run without GameShelf's server, the installed app starts on App settings the first time, to add the free keys.
  createWindow(firstRun && app.isPackaged && !cloudServer ? '/#/app-settings?welcome=1' : '/');
  app.on('activate', () => {
    if (!win) createWindow('/');
  });
}
