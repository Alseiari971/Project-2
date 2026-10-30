// Finds games installed on this computer through Steam, the Epic Games
// Launcher and GOG Galaxy, by reading the files and registry entries those
// launchers keep. Games are started through their own launcher, the same way
// a desktop shortcut would, so updates, cloud saves and DRM keep working.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LAUNCHER_NAMES = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG' };

// Steam installs these alongside games; they aren't games.
const STEAM_TOOLS = /^(Steamworks Common|Steam Linux Runtime|Proton\b|SteamVR)/i;
const STEAM_FULLY_INSTALLED = 4;

const quotedPair = /"([^"]+)"\s+"((?:[^"\\]|\\.)*)"/g;
const unescapeVdf = (v) => v.replace(/\\(.)/g, '$1');

/** Library folders listed in Steam's steamapps/libraryfolders.vdf. */
function parseLibraryFolders(text) {
  return [...text.matchAll(quotedPair)].filter((m) => m[1] === 'path').map((m) => unescapeVdf(m[2]));
}

/** One steamapps/appmanifest_<appid>.acf file, or null when it isn't a ready-to-play game. */
function parseAppManifest(text) {
  const values = {};
  for (const [, key, value] of text.matchAll(quotedPair)) {
    if (!(key in values)) values[key] = unescapeVdf(value);
  }
  const appId = Number(values.appid);
  if (!appId || !values.name || STEAM_TOOLS.test(values.name)) return null;
  if (!(Number(values.StateFlags) & STEAM_FULLY_INSTALLED)) return null;
  return { key: `steam:${appId}`, launcher: 'steam', name: values.name, steamAppId: appId, url: `steam://rungameid/${appId}` };
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

async function defaultSteamRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const out = await regQuery(['HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const fromRegistry = /SteamPath\s+REG_SZ\s+(.+)/.exec(out)?.[1].trim();
    return [fromRegistry, 'C:\\Program Files (x86)\\Steam'].filter(Boolean);
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Steam')];
  return [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')];
}

async function scanSteam(roots) {
  const libraries = new Set();
  for (const root of roots) {
    const text = await readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (text) libraries.add(path.resolve(root));
    for (const folder of parseLibraryFolders(text)) libraries.add(path.resolve(folder));
  }
  const games = new Map();
  for (const library of libraries) {
    const dir = path.join(library, 'steamapps');
    const files = await fs.readdir(dir).catch(() => []);
    for (const file of files.filter((f) => /^appmanifest_\d+\.acf$/.test(f))) {
      const game = parseAppManifest(await readText(path.join(dir, file)));
      if (game) games.set(game.key, game);
    }
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

async function scanGog(query) {
  const out = await query(['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']);
  return parseGogRegistry(out);
}

/** Every installed game found, sorted by name. Launchers that aren't installed are skipped. */
async function scanInstalledGames({
  steamRoots,
  epicManifestDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
  query = regQuery,
  windows = process.platform === 'win32',
} = {}) {
  const found = await Promise.all([
    (async () => scanSteam(steamRoots || (await defaultSteamRoots())))(),
    windows ? scanEpic(epicManifestDir) : [],
    windows ? scanGog(query) : [],
  ].map((p) => Promise.resolve(p).catch(() => [])));
  return found.flat().sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { LAUNCHER_NAMES, scanInstalledGames, parseLibraryFolders, parseAppManifest, parseEpicManifest, parseGogRegistry };
