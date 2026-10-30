// The safety check before anything touches a game's files. Games protected by
// anti-cheat software must never have their files changed (it can get players
// banned and breaks the games' terms), so when any is found, or the check
// can't finish, GameShelf offers only the overlay, which never touches the game.
//
// Kernel anti-cheats like Riot Vanguard and Ricochet live outside the game's
// folder, so those games are also recognized by their own program names and
// by their Steam app IDs. Keep this list in step with the server's copy.
const fs = require('node:fs/promises');
const path = require('node:path');

const ANTI_CHEATS = [
  {
    id: 'easyanticheat',
    name: 'Easy Anti-Cheat',
    dirs: ['easyanticheat', 'easyanticheat_eos'],
    files: ['easyanticheat_x64.dll', 'easyanticheat_x86.dll', 'easyanticheat_setup.exe', 'easyanticheat_eos_setup.exe', 'start_protected_game.exe'],
  },
  {
    id: 'battleye',
    name: 'BattlEye',
    dirs: ['battleye'],
    files: ['beservice.exe', 'beservice_x64.exe', 'beclient.dll', 'beclient_x64.dll'],
  },
  {
    id: 'vanguard',
    name: 'Riot Vanguard',
    dirs: ['riot vanguard'],
    files: ['vgk.sys', 'vgc.exe', 'valorant.exe', 'valorant-win64-shipping.exe', 'league of legends.exe', 'riotclientservices.exe'],
  },
  {
    id: 'ricochet',
    name: 'Ricochet (Call of Duty)',
    dirs: [],
    files: ['randgrid.sys', 'cod.exe', 'modernwarfare.exe', 'blackopscoldwar.exe'],
    steamAppIds: [1938090, 1962663], // Call of Duty, Call of Duty: Warzone
  },
  {
    id: 'ea-anticheat',
    name: 'EA Javelin Anticheat',
    dirs: ['eaanticheat'],
    files: ['eaanticheat.gameservicelauncher.exe', 'eaanticheat.installer.exe'],
  },
  { id: 'punkbuster', name: 'PunkBuster', dirs: [], files: ['pbcl.dll', 'pbsv.dll', 'pnkbstra.exe', 'pnkbstrb.exe', 'pbsvc.exe'] },
  { id: 'gameguard', name: 'nProtect GameGuard', dirs: ['gameguard'], files: ['gamemon.des', 'gamemon64.des'] },
  { id: 'xigncode', name: 'XIGNCODE3', dirs: ['xigncode'], files: ['x3.xem', 'xcorona.xem', 'xcorona_x64.xem'] },
  { id: 'ace', name: 'Anti-Cheat Expert', dirs: ['anticheatexpert'], files: ['sguard64.exe'] },
  { id: 'mhyprot', name: 'mhyprot', dirs: [], files: ['mhyprot2.sys', 'mhyprot3.sys', 'mhypbase.dll'] },
  { id: 'blackcipher', name: 'BlackCipher (Nexon)', dirs: ['blackcipher'], files: [] },
  { id: 'hackshield', name: 'AhnLab HackShield', dirs: ['hshield'], files: ['ehsvc.dll'] },
];

// Anti-cheat files sit near the top of a game's folder (Unreal games keep them
// in <Game>/Binaries/Win64/EasyAntiCheat), so the check looks 4 folders deep
// and skips the folders that only hold game data.
const MAX_DEPTH = 4;
const MAX_ENTRIES = 40000;
const SKIP_DIRS = new Set(['content', 'paks', 'movies', 'streamingassets', 'managed', 'il2cpp_data', 'monobleedingedge', 'shadercache', 'localization', '.git']);

const byDir = new Map();
const byFile = new Map();
for (const ac of ANTI_CHEATS) {
  ac.dirs.forEach((d) => byDir.set(d, ac));
  ac.files.forEach((f) => byFile.set(f, ac));
}

/**
 * Looks through a game's folder for anti-cheat software.
 * Returns { found: [{ id, name, path }], complete, problems }. `complete` is
 * false when the folder couldn't be fully checked (too many files, or folders
 * that couldn't be read); callers must then treat the game as protected.
 */
async function scanAntiCheat(root, { steamAppId, maxDepth = MAX_DEPTH, maxEntries = MAX_ENTRIES } = {}) {
  const found = new Map();
  const problems = [];
  const note = (ac, where) => {
    if (!found.has(ac.id)) found.set(ac.id, { id: ac.id, name: ac.name, path: where });
  };

  if (steamAppId) {
    for (const ac of ANTI_CHEATS) if (ac.steamAppIds?.includes(Number(steamAppId))) note(ac, `Steam app ${steamAppId}`);
  }

  let seen = 0;
  let queue = [root];
  for (let depth = 0; depth < maxDepth && queue.length; depth++) {
    const next = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        problems.push(`${dir}: ${err.code || err.message}`);
        continue;
      }
      for (const entry of entries) {
        if (++seen > maxEntries) {
          problems.push(`More than ${maxEntries} files; stopped looking.`);
          return { found: [...found.values()], complete: false, problems };
        }
        const name = entry.name.toLowerCase();
        const where = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (byDir.has(name)) note(byDir.get(name), where);
          if (!SKIP_DIRS.has(name)) next.push(where);
        } else if (entry.isFile() && byFile.has(name)) {
          note(byFile.get(name), where);
        }
        // Links are never followed: they could lead anywhere on the computer.
      }
    }
    queue = next;
  }
  return { found: [...found.values()], complete: problems.length === 0, problems };
}

module.exports = { ANTI_CHEATS, scanAntiCheat };
