// Finds games installed on this computer through Steam, the Epic Games
// Launcher and GOG Galaxy, by reading the files and registry entries those
// launchers keep. Games are started through their own launcher, the same way
// a desktop shortcut would, so updates, cloud saves and DRM keep working.
//
// - Steam: its folder from the registry (HKCU\Software\Valve\Steam), the
//   library folders in steamapps/libraryfolders.vdf, and, for libraries Steam
//   no longer lists, the usual SteamLibrary folders on every drive; then every
//   steamapps/appmanifest_<appid>.acf in them.
// - Epic: the launcher's .item manifests (InstallLocation, LaunchExecutable).
// - GOG: GOG Galaxy's registry entries, and the goggame-<id>.info file each
//   GOG game keeps in its folder (for games installed without Galaxy).
//
// Each game's main program is worked out from its folder when the launcher
// doesn't say (mainExe), for the graphics card option before its first run.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { HELPER } = require('./game-options');

const LAUNCHER_NAMES = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', custom: 'This PC' };

// Steam installs these alongside games; they aren't games.
const STEAM_TOOLS = /^(Steamworks Common|Steam Linux Runtime|Proton\b|SteamVR)/i;
const STEAM_FULLY_INSTALLED = 4;

const quotedPair = /"([^"]+)"\s+"((?:[^"\\]|\\.)*)"/g;
const unescapeVdf = (v) => v.replace(/\\(.)/g, '$1');

/** A Valve KeyValues (.vdf) text as nested objects ({ "key": "value" | { ... } }). */
function parseVdf(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}]/g) || [];
  let i = 0;
  const block = () => {
    const out = {};
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token === '}') break;
      if (token === '{') continue;
      const key = unescapeVdf(token.slice(1, -1));
      const next = tokens[i++];
      out[key] = next === '{' ? block() : unescapeVdf(String(next ?? '').slice(1, -1));
    }
    return out;
  };
  return block();
}

/** Library folders listed in Steam's steamapps/libraryfolders.vdf. */
function parseLibraryFolders(text) {
  return [...text.matchAll(quotedPair)].filter((m) => m[1] === 'path').map((m) => unescapeVdf(m[2]));
}

/**
 * One steamapps/appmanifest_<appid>.acf file, or null when it isn't a ready-to-play game.
 * `dir` is the game's folder, which tells whether it's running (see processes.js).
 */
function parseAppManifest(text, library) {
  const values = {};
  for (const [, key, value] of text.matchAll(quotedPair)) {
    if (!(key in values)) values[key] = unescapeVdf(value);
  }
  const appId = Number(values.appid);
  if (!appId || !values.name || STEAM_TOOLS.test(values.name)) return null;
  if (!(Number(values.StateFlags) & STEAM_FULLY_INSTALLED)) return null;
  return {
    key: `steam:${appId}`,
    launcher: 'steam',
    name: values.name,
    steamAppId: appId,
    url: `steam://rungameid/${appId}`,
    dir: library && values.installdir ? path.join(library, 'steamapps', 'common', values.installdir) : null,
  };
}

/** One Epic Games Launcher manifest (a .item JSON file), or null for add-ons and unfinished installs. */
function parseEpicManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m.AppName || !m.DisplayName || !m.CatalogNamespace || !m.CatalogItemId) return null;
  if (m.bIsIncompleteInstall || (m.MainGameAppName && m.MainGameAppName !== m.AppName)) return null;
  if ((m.AppCategories || []).includes('addons')) return null;
  const id = [m.CatalogNamespace, m.CatalogItemId, m.AppName].map(encodeURIComponent).join('%3A');
  return {
    key: `epic:${m.AppName}`,
    launcher: 'epic',
    name: m.DisplayName,
    url: `com.epicgames.launcher://apps/${id}?action=launch&silent=true`,
    dir: m.InstallLocation || null,
    ...(m.InstallLocation && m.LaunchExecutable ? { mainExe: path.join(m.InstallLocation, m.LaunchExecutable) } : {}),
  };
}

/** `reg query ... /s` output for GOG's Games key: one entry per installed game. */
function parseGogRegistry(text) {
  const games = [];
  for (const block of text.split(/\r?\n(?=HKEY_)/)) {
    const values = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
      if (m) values[m[1].toLowerCase()] = m[2].trim();
    }
    // DLC entries name the game they belong to in dependsOn.
    if (!values.gameid || !values.gamename || !values.exe || values.dependson) continue;
    games.push({
      key: `gog:${values.gameid}`,
      launcher: 'gog',
      name: values.gamename,
      exe: values.exe,
      cwd: values.workingdir || values.path || path.dirname(values.exe),
      dir: values.path || path.dirname(values.exe),
    });
  }
  return games;
}

function regQuery(args) {
  return new Promise((resolve) => {
    execFile('reg', ['query', ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
  });
}

const readText = (file) => fs.readFile(file, 'utf8').catch(() => '');
const isDir = (dir) => fs.stat(dir).then((s) => s.isDirectory(), () => false);

/** One GOG game's goggame-<id>.info file (JSON), as a game in `folder`, or null for DLC and other files. */
function parseGogInfo(text, folder) {
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    return null;
  }
  const task = (info.playTasks || []).find((t) => t.isPrimary && t.path) || (info.playTasks || []).find((t) => t.type === 'FileTask' && t.path);
  if (!info.gameId || !info.name || !task || (info.rootGameId && info.rootGameId !== info.gameId)) return null;
  const exe = path.join(folder, task.path);
  return {
    key: `gog:${info.gameId}`,
    launcher: 'gog',
    name: info.name,
    exe,
    cwd: task.workingDir ? path.join(folder, task.workingDir) : path.dirname(exe),
    dir: folder,
  };
}

/** Windows drive letters that exist (C: to Z:). */
async function listDrives() {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map((l) => isDir(`${l}:\\`)));
  return letters.filter((_, i) => found[i]).map((l) => `${l}:\\`);
}

/** Where Steam libraries usually are on a drive, and where GOG games are. */
const STEAM_GUESSES = ['SteamLibrary', 'Steam', path.join('Games', 'Steam'), path.join('Games', 'SteamLibrary'), path.join('Program Files (x86)', 'Steam'), path.join('Program Files', 'Steam')];
const GOG_GUESSES = ['GOG Games', path.join('Games', 'GOG Games'), path.join('Program Files (x86)', 'GOG Galaxy', 'Games'), path.join('Program Files', 'GOG Galaxy', 'Games')];

/** The game's own program in its folder: an .exe at the top or a level or two down, not a helper or installer. */
async function guessMainExe(dir, depth = 2) {
  if (!dir) return null;
  const found = [];
  const walk = async (folder, level) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isFile() && /\.exe$/i.test(entry.name) && !HELPER.test(entry.name)) {
        const size = await fs.stat(full).then((s) => s.size, () => 0);
        found.push({ full, level, size, name: entry.name.toLowerCase() });
      } else if (entry.isDirectory() && level < depth && !/^(_commonredist|redist|redistributables?|directx|support|tools|engine|__installer|easyanticheat|battleye)$/i.test(entry.name)) {
        await walk(full, level + 1);
      }
    }
  };
  await walk(dir, 0);
  if (!found.length) return null;
  const folderName = path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (f) => {
    const name = f.name.replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
    const alike = folderName && (name.includes(folderName) || folderName.includes(name)) ? 2 : 0;
    return alike + (f.level === 0 ? 1 : 0);
  };
  found.sort((a, b) => score(b) - score(a) || b.size - a.size);
  return found[0].full;
}

async function defaultSteamRoots(query = regQuery) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const user = await query(['HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const machine = await query(['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', '/v', 'InstallPath']);
    const fromRegistry = [/SteamPath\s+REG_SZ\s+(.+)/.exec(user)?.[1].trim(), /InstallPath\s+REG_SZ\s+(.+)/.exec(machine)?.[1].trim()];
    return [...fromRegistry, 'C:\\Program Files (x86)\\Steam'].filter(Boolean).map((p) => path.normalize(p));
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Steam')];
  return [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')];
}

/**
 * How long each Steam game has been played on this PC, from every Steam
 * account's userdata/<id>/config/localconfig.vdf: { appid: { minutes, lastPlayed } }.
 */
async function steamPlaytimes(roots) {
  const times = {};
  for (const root of roots) {
    for (const user of await fs.readdir(path.join(root, 'userdata')).catch(() => [])) {
      const text = await readText(path.join(root, 'userdata', user, 'config', 'localconfig.vdf'));
      if (!text) continue;
      const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const apps = lower(lower(lower(lower(lower(parseVdf(text)).userlocalconfigstore).software).valve).steam).apps || {};
      for (const [appid, app] of Object.entries(apps)) {
        const fields = lower(app);
        const minutes = Number(fields.playtime) || 0;
        const lastPlayed = Number(fields.lastplayed) || 0;
        const seen = times[appid] || { minutes: 0, lastPlayed: 0 };
        times[appid] = { minutes: Math.max(seen.minutes, minutes), lastPlayed: Math.max(seen.lastPlayed, lastPlayed) };
      }
    }
  }
  return times;
}

async function scanSteam(roots, extraLibraries = []) {
  const libraries = new Set();
  for (const root of roots) {
    const text = await readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (text) libraries.add(path.resolve(root));
    for (const folder of parseLibraryFolders(text)) libraries.add(path.resolve(folder));
  }
  // Libraries on other drives that Steam's list doesn't name (after reinstalling Windows, say).
  for (const folder of extraLibraries) {
    if (await isDir(path.join(folder, 'steamapps'))) libraries.add(path.resolve(folder));
  }
  const games = new Map();
  for (const library of libraries) {
    const dir = path.join(library, 'steamapps');
    const files = await fs.readdir(dir).catch(() => []);
    for (const file of files.filter((f) => /^appmanifest_\d+\.acf$/.test(f))) {
      const game = parseAppManifest(await readText(path.join(dir, file)), library);
      if (game) games.set(game.key, game);
    }
  }
  const times = await steamPlaytimes(roots).catch(() => ({}));
  for (const game of games.values()) {
    const time = times[game.steamAppId];
    if (time) Object.assign(game, { playtime: time.minutes, lastPlayed: time.lastPlayed ? time.lastPlayed * 1000 : null });
  }
  return [...games.values()];
}

async function scanEpic(manifestDir) {
  const files = await fs.readdir(manifestDir).catch(() => []);
  const games = [];
  for (const file of files.filter((f) => f.endsWith('.item'))) {
    const game = parseEpicManifest(await readText(path.join(manifestDir, file)));
    if (game) games.push(game);
  }
  return games;
}

async function scanGog(query, folders = []) {
  const out = await query(['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']);
  const games = new Map(parseGogRegistry(out).map((g) => [g.key, g]));
  // Games in the usual GOG folders, from their goggame-<id>.info files (the registry wins).
  for (const parent of folders) {
    for (const entry of await fs.readdir(parent, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(parent, entry.name);
      const infos = (await fs.readdir(folder).catch(() => [])).filter((f) => /^goggame-\d+\.info$/i.test(f));
      for (const file of infos) {
        const game = parseGogInfo(await readText(path.join(folder, file)), folder);
        if (game && !games.has(game.key)) games.set(game.key, game);
      }
    }
  }
  return [...games.values()];
}

// Each game folder's main program, worked out once per run of the app (scans repeat often).
const mainExeOf = new Map();

/** Fills in mainExe for games whose launcher doesn't name their program, a few at a time. */
async function addMainExes(games, guess = guessMainExe) {
  const todo = games.filter((g) => !g.exe && !g.mainExe && g.dir);
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (g) => {
      if (!mainExeOf.has(g.dir)) mainExeOf.set(g.dir, await guess(g.dir).catch(() => null));
      if (mainExeOf.get(g.dir)) g.mainExe = mainExeOf.get(g.dir);
    }));
  }
  return games;
}

/** Every installed game found, sorted by name. Launchers that aren't installed are skipped. */
async function scanInstalledGames({
  steamRoots,
  epicManifestDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
  query = regQuery,
  windows = process.platform === 'win32',
  drives,
  mainExes = true,
} = {}) {
  const roots = drives || (windows ? await listDrives().catch(() => []) : []);
  const under = (guesses) => roots.flatMap((drive) => guesses.map((g) => path.join(drive, g)));
  const found = await Promise.all([
    (async () => scanSteam(steamRoots || (await defaultSteamRoots(query)), under(STEAM_GUESSES)))(),
    windows ? scanEpic(epicManifestDir) : [],
    windows ? scanGog(query, under(GOG_GUESSES)) : [],
  ].map((p) => Promise.resolve(p).catch(() => [])));
  const games = found.flat().sort((a, b) => a.name.localeCompare(b.name));
  return mainExes ? addMainExes(games) : games;
}

/**
 * The list status a game installed on this PC starts with on My games, the
 * same as a Steam import: played in the last two weeks, played, or not yet.
 */
function suggestedStatus(game, now = Date.now()) {
  if (game.lastPlayed && now - game.lastPlayed < 14 * 24 * 60 * 60 * 1000) return 'playing';
  if (game.playtime > 0) return 'played';
  return 'want';
}

module.exports = { LAUNCHER_NAMES, scanInstalledGames, parseVdf, suggestedStatus, parseLibraryFolders, parseAppManifest, parseEpicManifest, parseGogRegistry, parseGogInfo, guessMainExe };
