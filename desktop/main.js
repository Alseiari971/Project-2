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
const { createPresenceLoop } = require('./presence');
const { externalUrl, createPickedPaths, trustedSender, lockContents, permissionPolicy, SAFE_PREFERENCES } = require('./safety');
const { pathToFileURL } = require('node:url');
const { localSteamAccount } = require('./steam-account');
const { FONTS: STUDIO_FONTS, DEFAULTS: STUDIO_DEFAULTS, cleanStudio, isDefault, createStudioStore, effectiveStudio } = require('./subtitle-studio');
const { createArabicService } = require('./localization/service');
const { createOcrHelper, defaultSpawn } = require('./localization/ocr');
const { createOverlayManager } = require('./localization/overlay-manager');
const { createArabicOnline, gameKey } = require('./localization/online');
const { createPackBuilder, findBuilder, localPackKey } = require('./localization/builder');
const { createPassThrough, createCloudClient, createRemoteGames, SESSION_COOKIE } = require('./cloud');
const { createStudio } = require('./localization/studio');
const { createArabicRequests, cantMake, playedAlone, unrealKey, NEEDS_RECIPE } = require('./localization/requests');
const { createRecipes, recipeTemplate } = require('./localization/recipes');
const { directoryFingerprint } = require('./localization/dirprint');
const arabicLines = require('./localization/lines');
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
    friendsPresence.stop();
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

// Only https:// pages and the known launcher links leave the app (see safety.js).
const openExternal = (url) => {
  const safe = externalUrl(url);
  if (safe) return shell.openExternal(safe);
  console.warn('Not opening an address outside the allowed list:', String(url).slice(0, 200));
  return Promise.resolve();
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
    // Windows takes the .ico, with its small sizes drawn for the taskbar.
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: CHROME_COLOR,
    show: false,
    // GameShelf's top bar is the title bar. On Windows and Linux the page draws
    // its own minimize, maximize and close buttons, at the end of the top bar:
    // the right in English, the left in Arabic. A Mac keeps its own buttons.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 24 } } : {}),
    webPreferences: {
      ...SAFE_PREFERENCES,
      preload: path.join(__dirname, 'preload.js'),
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
  // normal web browser; the window only ever shows GameShelf (see lockDownApp).

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
  // The app says what it is, so the server shows friends "in the desktop app" and lists its sessions as such.
  userAgent: `GameShelf-Desktop/${app.getVersion()} Electron/${process.versions.electron}`,
  server: () => cloudServer || origin,
  session: async () => (origin ? (await session.defaultSession.cookies.get({ url: origin, name: SESSION_COOKIE }))[0]?.value || null : null),
});
// Arabic packs from the cloud catalog, and the shared translations (see online.js).
const online = createArabicOnline({ cloud, cacheDir: path.join(dataDir, 'localization', 'downloads'), publicKeys: [packKey].filter(Boolean) });
// Engine recipes for games whose text is packed (signed by an admin with GameShelf's key, see recipes.js).
const recipes = createRecipes({ cloud, cacheDir: path.join(dataDir, 'localization', 'recipes'), publicKeys: [packKey].filter(Boolean) });
// Packs this app builds itself (from GameShelf's server, see below) are signed with a key made on this PC.
const localKey = localPackKey(dataDir);
const builderPaths = findBuilder({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoDir: path.join(__dirname, '..') });
// The runtime adapter this copy of the app ships: only these exact libraries ever go into a game (see localization/index.js).
const runtimeHooks = (() => {
  if (!builderPaths.runtimeHook) return null;
  const hashes = {};
  for (const name of ['version.dll', 'dinput8.dll']) {
    try {
      hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(builderPaths.runtimeHook, name))).digest('hex');
    } catch {}
  }
  return Object.keys(hashes).length ? hashes : null;
})();
// Approved Arabic sets: the patch is built here, from the player's own copy of the game.
async function buildFromSet({ game, tier, entry, set, setFile, fontStyle, onProgress }) {
  // Packed text: the game's signed engine recipe says how to read it and put the Arabic back.
  const recipe = tier === 'recipe' ? await recipes.forGame(gameKey(game)) : null;
  if (tier === 'recipe' && !recipe) throw new Error(NEEDS_RECIPE);
  // The runtime adapter only goes into games played alone.
  if (tier === 'native-runtime') {
    const alone = await playedAlone(online, game);
    if (!alone.ok) throw new Error(alone.why);
  }
  const seen = tier === 'native-runtime' && game.runtime?.newLines > 0 ? game.runtime.dump : null;
  const aesKey = tier === 'unreal-pak' ? await unrealKey(recipes, gameKey(game)) : null;
  return (await packBuilder.build({ ...game, tier, title: entry.title || set.title, recipe: recipe?.file, proxy: game.runtime?.proxy, extraLines: seen, aesKey },
    // The player's font, else the one the admin picked for this game's Arabic.
    { set: setFile, fontTargets: set.fontTargets || [], version: entry.version, fontStyle: fontStyle || set.fontStyle || null, onProgress })).packDir;
}

// After a game update, or for another font: the approved Arabic when there is one, else GameShelf's shared translations.
async function rebuildArabic({ game, tier, fontStyle, onProgress }) {
  const entry = await online.catalog.forGame(game).catch(() => null);
  if (entry?.mode === 'build' && entry.tier === tier) {
    const got = await online.catalog.fetchSet(entry, { onProgress });
    try {
      return await buildFromSet({ game, tier, entry, set: got.set, setFile: got.file, fontStyle, onProgress });
    } finally {
      await got.done();
    }
  }
  if (!packBuilder.canBuild(tier, game.engine) || !(await online.signedIn())) return null;
  const recipe = tier === 'recipe' ? await recipes.forGame(gameKey(game)) : null;
  if (tier === 'recipe' && !recipe) return null;
  const seen = tier === 'native-runtime' && game.runtime?.newLines > 0 ? game.runtime.dump : null;
  const aesKey = tier === 'unreal-pak' ? await unrealKey(recipes, gameKey(game)) : null;
  const built = await packBuilder.build({ ...game, tier, recipe: recipe?.file, proxy: game.runtime?.proxy, extraLines: seen, aesKey },
    { server: cloud.server(), auth: await online.builderEnv(), fontStyle, onProgress });
  return built.packDir;
}

const arabic = createArabicService({
  dataDir,
  runtimeHooks,
  publicKey: [packKey, localKey.publicKey].filter(Boolean),
  overlayAvailable: process.platform === 'win32' || Boolean(devOcrHelper),
  catalog: online.catalog,
  builder: { canBuild: (tier, engine) => packBuilder.canBuild(tier, engine), fromSet: buildFromSet, rebuild: rebuildArabic },
});
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
  // An encrypted Unreal game's key, from its admin-signed key recipe (the same one the Arabic switch uses).
  keyFor: (serverKey) => unrealKey(recipes, serverKey),
  appKeys: [packKey].filter(Boolean),
  secure: {
    available: () => app.isReady() && safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  },
});
// "Request Arabic subtitles", after the player agrees (see requests.js).
const overlayAvailable = process.platform === 'win32' || Boolean(devOcrHelper);
const requests = createArabicRequests({
  arabic, packBuilder, online, recipes, server: () => cloud.server(), overlayAvailable,
  // What's in the game's folder, for the admins (names only, see dirprint.js).
  fingerprint: (game, info) => directoryFingerprint(game.dir, { engine: info?.engineInfo || null }),
});
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
  if (game.url) return openExternal(game.url);
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
      friendsPresence.nudge().catch(() => {});
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

// ---- Subtitle Studio ------------------------------------------------------------

const studioStore = createStudioStore(dataDir);
/** Whether the signed-in player has the Subtitle Studio perk (asked of GameShelf's server). */
async function studioAllowed() {
  try {
    return Boolean((await cloud.json('/api/me/plan', { timeout: 8000 })).perks?.subtitleStudio);
  } catch {
    return false;
  }
}
function applyStudio(saved, allowed) {
  const s = effectiveStudio(saved, allowed);
  overlays?.setStudio({ family: STUDIO_FONTS[s.font].family, size: s.size, color: s.color, background: s.background });
}

// ---- Friends' presence -------------------------------------------------------------

/** What friends see: the game started most recently (and whether its Arabic is on), or just online. */
async function presenceNow() {
  const [key] = [...runningSince].sort((a, b) => b[1] - a[1])[0] || [];
  if (!key) return { status: 'online' };
  const game = (await installedGames().catch(() => [])).find((g) => g.key === key);
  if (!game) return { status: 'online' };
  const page = pageOf(game);
  let arabicEnabled = badges.get(key) === 'on';
  try {
    arabicEnabled = Boolean((await arabic.info(arabicGame(game))).enabled);
  } catch {}
  return { status: 'in_game', gameId: page?.id || null, gameTitle: page?.name || game.name, steamAppId: game.steamAppId || null, arabicEnabled };
}
const friendsPresence = createPresenceLoop({ cloud, current: presenceNow });

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
  const url = page?.wikidataId ? `https://www.wikidata.org/wiki/${encodeURIComponent(page.wikidataId)}`
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
          else if (info.missing && !cantMake(info, packBuilder, overlayAvailable)) badge = 'request';
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

// IPC is answered only for GameShelf's own pages, from the top frame (never an
// embedded trailer or another site).
const fromApp = (event) => trustedSender(event, origin);

// Every window and frame the app makes: kept on GameShelf's pages (or the
// overlay's own files), no pop-ups, no <webview>, and almost no permissions.
const OVERLAY_DIR_URL = pathToFileURL(path.join(__dirname, 'overlay') + path.sep).href;
function lockDownApp() {
  app.on('web-contents-created', (_event, contents) => {
    lockContents(contents, {
      allowed: (url) => {
        try {
          return new URL(url).origin === origin || String(url).startsWith(OVERLAY_DIR_URL);
        } catch {
          return false;
        }
      },
      openOutside: openExternal,
    });
  });
  const allow = permissionPolicy({ origin, captureUrl: pathToFileURL(path.join(__dirname, 'overlay', 'capture.html')).href });
  // The main window's session, and the subtitle capture window's own.
  for (const ses of [session.defaultSession, session.fromPartition('gameshelf-capture')]) {
    ses.setPermissionRequestHandler((_contents, permission, done, details) => done(allow(permission, details?.requestingUrl)));
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => allow(permission, details?.requestingUrl || requestingOrigin));
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
        return openExternal('ms-settings:display-advancedgraphics');
      case 'open-folder': {
        const problem = game.dir ? await shell.openPath(game.dir) : 'This game has no folder.';
        if (problem) throw new Error(problem);
        return;
      }
      case 'steam-properties':
        steamOnly();
        return openExternal(`steam://gameproperties/${Number(game.steamAppId)}`);
      case 'verify':
        steamOnly();
        return openExternal(`steam://validate/${Number(game.steamAppId)}`);
      case 'uninstall': {
        // The launcher's own uninstaller asks for confirmation.
        if (game.launcher === 'steam') return openExternal(`steam://uninstall/${Number(game.steamAppId)}`);
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
  // Steam: the account signed in on this PC is only shown; linking always goes
  // through Steam's own sign-in, opened in the normal web browser.
  handle('steam:local-account', async () => localSteamAccount().catch(() => null));
  handle('steam:open-link', async () => {
    const { url } = await cloud.json('/api/auth/steam/link', { method: 'POST' });
    if (!String(url).startsWith('https://steamcommunity.com/openid/login?')) throw new Error('GameShelf\'s server sent an unexpected address.');
    await openExternal(url);
    return { opened: true };
  });
  // Signing in or out in the window: tell friends now.
  handle('presence:refresh', async () => {
    await friendsPresence.beat();
    return true;
  });
  handle('arabic:info', async (key) => {
    const game = await installedGame(key);
    return { ...(await arabic.info(arabicGame(game))), overlayRunning: Boolean(overlays?.has(key)), overlay: overlays?.status(key) || null };
  });
  // "Report a translation issue": the game's lines as its last build here wrote them, found by English or Arabic.
  handle('arabic:lines', async (key, query) => {
    const game = await installedGame(key);
    const info = await arabic.info(arabicGame(game));
    const ids = [info.pack?.id, `gameshelf-${game.steamAppId ? `steam-${game.steamAppId}` : arabicGame(game).gameId}-ar`].filter(Boolean);
    for (const id of ids) {
      const lines = await arabicLines.readLines(path.join(dataDir, 'localization', 'builds', id, 'translations.csv'));
      if (lines.length) return arabicLines.search(lines, String(query || ''));
    }
    return [];
  });
  handle('arabic:report', async (key, fix) => {
    const game = await installedGame(key);
    const serverKey = gameKey(arabicGame(game));
    if (!serverKey) throw new Error('GameShelf doesn\'t know which game this is, so it can\'t send the report.');
    if (!(await online.signedIn())) throw new Error('Log in to GameShelf first.');
    const { english, current, suggestion, note } = fix || {};
    return online.reportFix(serverKey, { english, current, suggestion, note });
  });
  // The Arabic font style for a game (null: the pack's own); a new one goes in the next time the game starts.
  handle('arabic:font', async (key, style) => {
    const game = await installedGame(key);
    return arabic.setFont(arabicGame(game), style || null);
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
    const cant = info.missing ? cantMake(info, packBuilder, overlayAvailable) : null;
    const out = {
      configured: online.configured, signedIn, missing: Boolean(info.missing), canBuild: !cant, overlayOnly: Boolean(info.overlayOnly),
      // Why not, for the button (and the admins, with the request).
      cantBuild: cant ? { text: cant, vars: {} } : null, building: packBuilder.progress(key), server: null, error: null,
    };
    if (!info.missing || !signedIn || !serverKey) return out;
    try {
      out.server = await online.status(serverKey);
      // Packed text with no engine recipe yet: the button asks the admins (with the folder's fingerprint) instead.
      if (info.tier === 'recipe' && !out.server?.recipe && out.canBuild) {
        out.canBuild = false;
        out.cantBuild = { text: NEEDS_RECIPE, vars: {} };
      }
    } catch (err) {
      out.error = { text: err.message, vars: {} };
    }
    return out;
  });
  // Makes the pack on this PC, with the Arabic from the server (which translates
  // what it doesn't have yet, once, for everyone), then turns Arabic on.
  // Only after the player agreed in the dialog (consent: true) does GameShelf read the game's files.
  handle('arabic:get', async (key, options = {}) => {
    const game = await installedGame(key);
    return requests.run({ ...arabicGame(game), title: pageOf(game)?.name || game.name }, { consent: options?.consent === true, onProgress: arabicProgress(key) });
  });
  // For games this PC can't make Arabic for: the request is counted on the server.
  handle('arabic:request', async (key) => {
    const game = await installedGame(key);
    const serverKey = gameKey(arabicGame(game));
    if (!serverKey) throw new Error('GameShelf doesn\'t know which game this is, so it can\'t ask for it.');
    // The admins see why this PC couldn't make it, and what's in the game's folder.
    const info = await arabic.info(arabicGame(game));
    const reason = info.missing ? cantMake(info, packBuilder, overlayAvailable) || (info.tier === 'recipe' ? NEEDS_RECIPE : null) : null;
    return requests.ask({ ...arabicGame(game), title: pageOf(game)?.name || game.name }, reason || '', info);
  });
  // Admin Panel: "Approve, Sign & Publish" a player's submission (signed here, with the Pack Studio's key).
  handle('admin:approve', async (submissionId) => {
    await requireAdmin();
    const pack = await studio.approve(submissionId);
    online.catalog.forget();
    return pack;
  });
  // Admin Panel: a game's engine recipe, checked and signed here with the Pack Studio's key, then attached on the server.
  handle('admin:attachRecipe', async (game, text, meta) => {
    await requireAdmin();
    return studio.attachRecipe(String(game), String(text), meta && typeof meta === 'object' ? { title: meta.title, container: meta.container } : {});
  });
  // Admin Panel, Translation fixes: the approved fixes out to every player (a new signed version of the game's Arabic).
  handle('admin:republish', async (game) => {
    await requireAdmin();
    const pack = await studio.republish(String(game));
    online.catalog.forget();
    return pack;
  });
  handle('admin:recipeTemplate', async (game, family) => JSON.stringify(recipeTemplate(String(game), family ? String(family) : null), null, 2));
  // ---- Pack Studio (admins only; the server checks again when a pack is published) ----
  const requireAdmin = async () => {
    if ((await cloud.me())?.role !== 'admin') throw new Error('Only admins can do this.');
  };
  const studioSend = (channel) => (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  // Only folders the Studio built in can be published, added or opened from
  // the page: resolved through any links, inside the Studio's output, and
  // folders only (opening a file could start a program).
  const inStudio = (target) => {
    let real;
    try {
      real = fs.realpathSync(path.resolve(String(target || '')));
    } catch {
      throw new Error('Not allowed.');
    }
    const root = fs.realpathSync(path.resolve(studio.outDir));
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isDirectory()) throw new Error('Not allowed.');
    return real;
  };
  // Files and folders the page names must be ones the admin chose in the app's own dialog.
  const picked = createPickedPaths();
  try {
    picked.allow(studio.settings().keyFile);
  } catch {}
  handle('studio:settings', async () => {
    await requireAdmin();
    return studio.settings();
  });
  handle('studio:save-settings', async (input) => {
    await requireAdmin();
    const values = { ...(input || {}) };
    if (values.keyFile) values.keyFile = picked.check(values.keyFile, 'That signing key');
    return studio.saveSettings(values);
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
      'ui-folder': { title: 'Choose the folder with the game\'s style tables (from retoc to-legacy)', properties: ['openDirectory'] },
      'logo-folder': { title: 'Choose the folder with your cooked Arabic title logo (<Project>/Content/...)', properties: ['openDirectory'] },
    }[kind];
    if (!choices) throw new Error('Not allowed.');
    const result = await dialog.showOpenDialog(win, choices);
    return result.canceled ? null : picked.remember(result.filePaths[0] || null);
  });
  handle('studio:make-keys', async (folder) => {
    await requireAdmin();
    const made = await studio.makeKeys(picked.check(String(folder), 'That folder'));
    picked.allow(made?.keyFile);
    return made;
  });
  handle('studio:build', async (options) => {
    await requireAdmin();
    const o = { ...(options || {}) };
    for (const key of ['source', 'pakList', 'reviewed']) if (o[key]) o[key] = picked.check(o[key]);
    return studio.build(o, { onLog: studioSend('studio:log'), onProgress: studioSend('studio:progress') });
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
  // Subtitle Studio (a GameShelf Supporter perk): font, size, color, box opacity.
  // Whether the perk is on comes from GameShelf's server; without it the
  // overlay uses the defaults (saved choices are kept for when it's back).
  handle('arabic:studio', async () => {
    const allowed = await studioAllowed();
    return { settings: studioStore.read(), allowed, fonts: Object.entries(STUDIO_FONTS).map(([id, f]) => ({ id, name: f.name })), defaults: STUDIO_DEFAULTS };
  });
  handle('arabic:set-studio', async (input) => {
    const settings = cleanStudio(input || {});
    if (!isDefault(settings) && !(await studioAllowed())) throw new Error('Subtitle Studio is a GameShelf Supporter perk. Arabic packs stay free either way.');
    studioStore.save(settings);
    applyStudio(settings, true);
    return { settings, allowed: true };
  });
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
  lockDownApp();
  buildApp();
  scannedGames();
  await startServer();
  registerIpc();
  friendsPresence.start();
  overlays = createOverlayManager({ BrowserWindow, desktopCapturer, screen, ipcMain, helper: ocrHelper });
  arabic.overlayStyle().then((style) => overlays.setStyle(style)).catch((err) => console.error('Arabic overlay style:', err.message));
  studioAllowed().then((allowed) => applyStudio(studioStore.read(), allowed)).catch(() => {});
  // Takes back any Arabic patch that was cut short by a crash.
  arabic.recover().catch((err) => console.error('Could not tidy up Arabic patches:', err.message));
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // Run without GameShelf's server, the installed app starts on App settings the first time, to add the free keys.
  createWindow(firstRun && app.isPackaged && !cloudServer ? '/#/app-settings?welcome=1' : '/');
  app.on('activate', () => {
    if (!win) createWindow('/');
  });
}
