const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanInstalledGames, parseLibraryFolders, parseAppManifest, parseEpicManifest, parseGogRegistry } = require('../desktop/installed');

const manifest = (appid, name, flags = 4) => `"AppState"
{
\t"appid"\t\t"${appid}"
\t"universe"\t\t"1"
\t"name"\t\t"${name}"
\t"StateFlags"\t\t"${flags}"
\t"installdir"\t\t"${name}"
}
`;

test('reads Steam library folders, including Windows paths', () => {
  const vdf = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"apps"
\t\t{
\t\t\t"730"\t\t"35000000000"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t}
}`;
  assert.deepStrictEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
});

test('only fully installed Steam games count, not tools or half-downloaded ones', () => {
  assert.deepStrictEqual(parseAppManifest(manifest(730, 'Counter-Strike 2'), '/games'), {
    key: 'steam:730',
    launcher: 'steam',
    name: 'Counter-Strike 2',
    steamAppId: 730,
    url: 'steam://rungameid/730',
    dir: path.join('/games', 'steamapps', 'common', 'Counter-Strike 2'),
  });
  assert.strictEqual(parseAppManifest(manifest(1091500, 'Cyberpunk 2077', 1026 & ~4)), null);
  assert.strictEqual(parseAppManifest(manifest(228980, 'Steamworks Common Redistributables')), null);
});

test('finds Steam games across every library folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'));
  fs.mkdirSync(path.join(root, 'steamapps'));
  fs.mkdirSync(path.join(other, 'steamapps'));
  fs.writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "0" { "path" "${root}" } "1" { "path" "${other}" } }`);
  fs.writeFileSync(path.join(root, 'steamapps', 'appmanifest_730.acf'), manifest(730, 'Counter-Strike 2'));
  fs.writeFileSync(path.join(other, 'steamapps', 'appmanifest_1245620.acf'), manifest(1245620, 'ELDEN RING'));
  fs.writeFileSync(path.join(other, 'steamapps', 'appmanifest_570.acf'), manifest(570, 'Dota 2', 6));

  const games = await scanInstalledGames({ steamRoots: [root, '/no/such/steam'], windows: false });
  assert.deepStrictEqual(games.map((g) => g.name), ['Counter-Strike 2', 'Dota 2', 'ELDEN RING']);
});

test('Epic manifests become launcher links; add-ons and unfinished installs are skipped', () => {
  const base = { CatalogNamespace: 'fn', CatalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5', AppCategories: ['public', 'games', 'applications'] };
  assert.deepStrictEqual(parseEpicManifest(JSON.stringify({ ...base, AppName: 'Fortnite', DisplayName: 'Fortnite', MainGameAppName: 'Fortnite' })), {
    key: 'epic:Fortnite',
    launcher: 'epic',
    name: 'Fortnite',
    url: 'com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true',
    dir: null,
  });
  assert.strictEqual(parseEpicManifest(JSON.stringify({ ...base, AppName: 'Pack', DisplayName: 'Pack', MainGameAppName: 'Fortnite' })), null);
  assert.strictEqual(parseEpicManifest(JSON.stringify({ ...base, AppName: 'X', DisplayName: 'X', bIsIncompleteInstall: true })), null);
  assert.strictEqual(parseEpicManifest('not json'), null);
});

test('GOG registry entries become games; DLC entries are skipped', async () => {
  const out = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207664643',
    '    gameID    REG_SZ    1207664643',
    '    gameName    REG_SZ    The Witcher 3: Wild Hunt',
    '    exe    REG_SZ    C:\\GOG Games\\The Witcher 3\\bin\\x64\\witcher3.exe',
    '    workingDir    REG_SZ    C:\\GOG Games\\The Witcher 3\\bin\\x64',
    '    dependsOn    REG_SZ    ',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1640424747',
    '    gameID    REG_SZ    1640424747',
    '    gameName    REG_SZ    Blood and Wine',
    '    exe    REG_SZ    C:\\GOG Games\\The Witcher 3\\bin\\x64\\witcher3.exe',
    '    dependsOn    REG_SZ    1207664643',
    '',
  ].join('\r\n');
  assert.deepStrictEqual(parseGogRegistry(out), [{
    key: 'gog:1207664643',
    launcher: 'gog',
    name: 'The Witcher 3: Wild Hunt',
    exe: 'C:\\GOG Games\\The Witcher 3\\bin\\x64\\witcher3.exe',
    cwd: 'C:\\GOG Games\\The Witcher 3\\bin\\x64',
    dir: path.dirname('C:\\GOG Games\\The Witcher 3\\bin\\x64\\witcher3.exe'),
  }]);

  const games = await scanInstalledGames({ steamRoots: [], epicManifestDir: '/no/such/dir', query: async () => out, windows: true });
  assert.deepStrictEqual(games.map((g) => g.key), ['gog:1207664643']);
});

test('Steam libraries Steam no longer lists are found on every drive, and each game gets its main program', async () => {
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
  const library = path.join(drive, 'SteamLibrary');
  const gameDir = path.join(library, 'steamapps', 'common', 'RE3DEMO');
  fs.mkdirSync(path.join(gameDir, '_CommonRedist'), { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'Binaries'), { recursive: true });
  fs.writeFileSync(path.join(library, 'steamapps', 'appmanifest_1173690.acf'), manifest(1173690, 'RE3DEMO'));
  fs.writeFileSync(path.join(gameDir, 're3demo.exe'), 'MZ game');
  fs.writeFileSync(path.join(gameDir, 'unins000.exe'), 'MZ uninstaller, much bigger than the game stub');
  fs.writeFileSync(path.join(gameDir, 'CrashReport.exe'), 'MZ');
  fs.writeFileSync(path.join(gameDir, '_CommonRedist', 'vc_redist.x64.exe'), 'MZ');

  // No Steam folder from the registry, but the drive has a SteamLibrary.
  const games = await scanInstalledGames({ steamRoots: [], drives: [drive], windows: false });
  assert.deepStrictEqual(games.map((g) => [g.key, g.dir, g.mainExe]), [['steam:1173690', gameDir, path.join(gameDir, 're3demo.exe')]]);
});

test('Steam\'s folder comes from the registry (yours or the machine\'s)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  fs.mkdirSync(path.join(root, 'steamapps'));
  fs.writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${root}" } }`);
  fs.writeFileSync(path.join(root, 'steamapps', 'appmanifest_730.acf'), manifest(730, 'Counter-Strike 2'));
  const asked = [];
  const query = async (args) => {
    asked.push(args[0]);
    return args[0].startsWith('HKLM\\SOFTWARE\\WOW6432Node\\Valve') ? `\r\n    InstallPath    REG_SZ    ${root}\r\n` : '';
  };
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const games = await scanInstalledGames({ query, drives: [], epicManifestDir: '/no/such/dir', windows: true, mainExes: false });
    assert.deepStrictEqual(games.map((g) => g.key), ['steam:730']);
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
  assert.ok(asked.includes('HKCU\\Software\\Valve\\Steam') && asked.includes('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam'));
});

test('Epic manifests name the game\'s program; GOG games are found from their .info files too', async () => {
  const epicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-'));
  fs.writeFileSync(path.join(epicDir, 'A1.item'), JSON.stringify({
    AppName: 'Daymare', DisplayName: 'Daymare: 1994 Sandcastle', CatalogNamespace: 'ns', CatalogItemId: 'id', AppCategories: ['games'],
    InstallLocation: 'D:\\Epic\\Daymare', LaunchExecutable: 'Daymare.exe',
  }));
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
  const witcher = path.join(drive, 'GOG Games', 'The Witcher');
  fs.mkdirSync(witcher, { recursive: true });
  fs.writeFileSync(path.join(witcher, 'goggame-1207658924.info'), JSON.stringify({
    gameId: '1207658924', name: 'The Witcher: Enhanced Edition', playTasks: [{ isPrimary: true, type: 'FileTask', path: 'System\\witcher.exe', workingDir: 'System' }],
  }));
  fs.writeFileSync(path.join(witcher, 'goggame-1207658925.info'), JSON.stringify({ gameId: '1207658925', rootGameId: '1207658924', name: 'A DLC', playTasks: [{ isPrimary: true, path: 'x.exe' }] }));

  const games = await scanInstalledGames({ steamRoots: [], drives: [drive], epicManifestDir: epicDir, query: async () => '', windows: true, mainExes: false });
  assert.deepStrictEqual(games.map((g) => [g.key, g.mainExe || g.exe]), [
    ['epic:Daymare', path.join('D:\\Epic\\Daymare', 'Daymare.exe')],
    ['gog:1207658924', path.join(witcher, 'System\\witcher.exe')],
  ]);
});

test('Steam playtime on this PC sets the status a game starts with on My games', async () => {
  const { suggestedStatus } = require('../desktop/installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  fs.mkdirSync(path.join(root, 'steamapps'));
  fs.mkdirSync(path.join(root, 'userdata', '12345', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" "${root}" } }`);
  for (const [id, name] of [[730, 'Counter-Strike 2'], [570, 'Dota 2'], [1245620, 'ELDEN RING']]) {
    fs.writeFileSync(path.join(root, 'steamapps', `appmanifest_${id}.acf`), manifest(id, name));
  }
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(root, 'userdata', '12345', 'config', 'localconfig.vdf'), `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" {
    "730" { "LastPlayed" "${now - 3600}" "Playtime" "95" }
    "570" { "LastPlayed" "${now - 90 * 86400}" "Playtime" "4000" }
  } } } } }`);
  const games = await scanInstalledGames({ steamRoots: [root], drives: [], windows: false, mainExes: false });
  assert.deepStrictEqual(games.map((g) => [g.name, suggestedStatus(g)]), [['Counter-Strike 2', 'playing'], ['Dota 2', 'played'], ['ELDEN RING', 'want']]);
});
