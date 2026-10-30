// Works out which engine a game is built with, from its folder alone:
//
// - Unreal Engine 4/5: an Engine folder next to a <Project> folder whose
//   Content/Paks holds .pak (or UE5 .utoc) files.
// - Unity: a <Name>_Data folder (resources.assets, globalgamemanagers...) next
//   to UnityPlayer.dll or <Name>.exe; IL2CPP when GameAssembly.dll is there,
//   Mono otherwise. The Unity version is read from the data files' header.
// - Capcom RE Engine: re_chunk_000.pak in the game's folder, with its
//   numbered patch files (re_chunk_000.pak.patch_001.pak...).
// - Ren'Py: a renpy folder next to a game folder of .rpa/.rpyc/.rpy scripts.
// - Godot 3/4: the engine's program with a .pck of the same name next to it,
//   or with the .pck added to the end of the program.
// - Anything else is a custom engine, which only the overlay can serve.
const fs = require('node:fs/promises');
const path = require('node:path');
const { list, findEntry, findPath, programArch } = require('./files');
const reengine = require('./reengine');

async function findUnreal(base) {
  const entries = await list(base);
  if (!entries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'engine')) return null;
  for (const project of entries) {
    if (!project.isDirectory() || project.name.toLowerCase() === 'engine') continue;
    const projectDir = path.join(base, project.name);
    const paksDir = await findPath(projectDir, 'Content', 'Paks');
    if (!paksDir) continue;
    const paks = (await list(paksDir)).filter((e) => e.isFile()).map((e) => e.name.toLowerCase());
    const pakCount = paks.filter((n) => n.endsWith('.pak')).length;
    const ioStore = paks.some((n) => n.endsWith('.utoc'));
    if (!pakCount && !ioStore) continue;

    const binaries = await findPath(projectDir, 'Binaries', 'Win64');
    const exes = binaries ? (await list(binaries)).filter((e) => e.isFile() && /\.exe$/i.test(e.name)).map((e) => e.name) : [];
    const shipping = exes.find((n) => /-shipping\.exe$/i.test(n)) || exes[0];
    const shippingExe = shipping ? path.join(binaries, shipping) : null;
    return {
      engine: 'unreal',
      base,
      unreal: {
        project: project.name,
        paksDir,
        pakCount,
        // UE5 (and late UE4) games pack assets in .utoc/.ucas; a replacement
        // asset then needs all three files, a .locres alone still loads from a .pak.
        ioStore,
        // Signed paks (.sig files) reject any pak the developer didn't sign, and
        // getting around that isn't something GameShelf will do.
        signedPaks: paks.some((n) => n.endsWith('.sig')),
        shippingExe,
        arch: shippingExe ? await programArch(shippingExe) : null,
      },
    };
  }
  return null;
}

// Unity writes its version near the start of its serialized data files, e.g. "2019.4.40f1".
const UNITY_VERSION = /(?:^|[^\d.])((?:[56]|20\d\d|6\d{3})\.\d{1,2}\.\d{1,3}[abfpx]\d{1,3})/;

async function unityVersion(dataDir) {
  for (const name of ['globalgamemanagers', 'data.unity3d', 'mainData', 'level0']) {
    const file = await findEntry(dataDir, name, 'file');
    if (!file) continue;
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const head = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const match = head.toString('latin1', 0, bytesRead).match(UNITY_VERSION);
      if (match) return match[1];
    } catch {
      // Try the next file.
    } finally {
      await handle?.close();
    }
  }
  return null;
}

async function findUnity(base) {
  const entries = await list(base);
  const names = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  for (const entry of entries) {
    const match = entry.isDirectory() && entry.name.match(/^(.+)_Data$/i);
    if (!match) continue;
    const dataDir = path.join(base, entry.name);
    const data = new Set((await list(dataDir)).map((e) => e.name.toLowerCase()));
    if (!['resources.assets', 'globalgamemanagers', 'data.unity3d', 'maindata'].some((n) => data.has(n))) continue;
    const exeEntry = names.get(`${match[1].toLowerCase()}.exe`);
    if (!exeEntry && !names.has('unityplayer.dll')) continue;

    const il2cpp = names.has('gameassembly.dll') || data.has('il2cpp_data');
    const exe = exeEntry ? path.join(base, exeEntry.name) : null;
    const player = names.has('unityplayer.dll') ? path.join(base, names.get('unityplayer.dll').name) : null;
    const bepinexDir = names.get('bepinex');
    const bepinex = Boolean(bepinexDir?.isDirectory() && await findPath(base, bepinexDir.name, 'core'));
    return {
      engine: 'unity',
      base,
      unity: {
        name: match[1],
        exe,
        dataDir,
        backend: il2cpp ? 'il2cpp' : 'mono',
        version: await unityVersion(dataDir),
        arch: (exe && await programArch(exe)) || (player && await programArch(player)) || null,
        // Mods the player installed themselves. GameShelf never changes those.
        bepinex,
        autoTranslator: bepinex && Boolean(await findPath(base, bepinexDir.name, 'plugins', 'XUnity.AutoTranslator')),
      },
    };
  }
  return null;
}

async function findReEngine(base) {
  const files = (await list(base)).filter((e) => e.isFile()).map((e) => e.name);
  const basePak = files.find((n) => n.toLowerCase() === reengine.BASE_PAK);
  if (!basePak) return null;
  const patches = reengine.patchNumbers(files);
  const programs = files.filter((n) => /\.exe$/i.test(n));
  // The game's own program: the biggest .exe (crash reporters and installers are small).
  let exe = null;
  let biggest = -1;
  for (const name of programs) {
    const size = (await fs.stat(path.join(base, name)).catch(() => null))?.size ?? -1;
    if (size > biggest) [exe, biggest] = [path.join(base, name), size];
  }
  return {
    engine: 'reengine',
    base,
    reengine: {
      dir: base,
      exe,
      programs,
      arch: exe ? await programArch(exe) : null,
      patches,
      ...reengine.nextPatch(patches),
    },
  };
}

async function readHead(file, length, position = 0) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// Ren'Py writes its version into renpy/vc_version.py (7.4 and later), or
// into renpy/__init__.py as a tuple (older versions).
async function renpyVersion(renpyDir) {
  const versionFile = await findEntry(renpyDir, 'vc_version.py', 'file');
  const text = versionFile && (await readHead(versionFile, 4096))?.toString('utf8');
  const found = text?.match(/^version\s*=\s*u?['"](\d+(?:\.\d+)+)/m);
  if (found) return found[1].split('.').slice(0, 3).join('.');
  const init = await findEntry(renpyDir, '__init__.py', 'file');
  const tuple = init && (await readHead(init, 65536))?.toString('utf8').match(/version_tuple\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return tuple ? tuple.slice(1).join('.') : null;
}

async function findRenpy(base) {
  const renpyDir = await findEntry(base, 'renpy', 'dir');
  const gameDir = renpyDir && await findEntry(base, 'game', 'dir');
  if (!gameDir) return null;
  const game = (await list(gameDir)).filter((e) => e.isFile()).map((e) => e.name.toLowerCase());
  if (!game.some((n) => /\.(rpa|rpyc|rpy)$/.test(n))) return null;
  const version = await renpyVersion(renpyDir);
  return {
    engine: 'renpy',
    base,
    renpy: {
      gameDir,
      version,
      // Scripts come as .rpy (readable) or only compiled .rpyc, often inside .rpa archives.
      archives: game.filter((n) => n.endsWith('.rpa')).length,
      // Ren'Py 8 runs Python 3; older versions Python 2. GameShelf's script works with both.
      python: version && Number(version.split('.')[0]) >= 8 ? 3 : 2,
    },
  };
}

// A Godot game is the engine's own program and its data, either in a .pck
// file named after the program or added to the end of the program itself.
// The .pck header gives the Godot version it was made with.
const GDPC = 0x43504447;
const GODOT_PROGRAMS = /\.(exe|x86_64|x86_32|arm64|arm32)$/i;

async function godotHeader(file, offset = 0) {
  const head = await readHead(file, 20, offset);
  if (!head || head.length < 20 || head.readUInt32LE(0) !== GDPC) return null;
  const [major, minor, patch] = [head.readUInt32LE(8), head.readUInt32LE(12), head.readUInt32LE(16)];
  return major >= 2 && major < 100 ? { version: `${major}.${minor}.${patch}`, major } : null;
}

async function embeddedPck(program) {
  const info = await fs.stat(program).catch(() => null);
  if (!info || info.size < 32) return null;
  const tail = await readHead(program, 12, info.size - 12);
  if (!tail || tail.length < 12 || tail.readUInt32LE(8) !== GDPC) return null;
  const size = Number(tail.readBigUInt64LE(0));
  if (!size || size > info.size - 12) return null;
  return godotHeader(program, info.size - 12 - size);
}

async function findGodot(base) {
  const files = (await list(base)).filter((e) => e.isFile()).map((e) => e.name);
  const programs = files.filter((n) => GODOT_PROGRAMS.test(n) && !/\.console\.exe$/i.test(n));
  for (const name of files.filter((n) => /\.pck$/i.test(n))) {
    const stem = name.slice(0, -4).toLowerCase();
    const program = programs.find((p) => p.toLowerCase().replace(GODOT_PROGRAMS, '') === stem);
    const header = program && await godotHeader(path.join(base, name));
    if (header) return godotFound(base, program, name, header);
  }
  for (const program of programs.filter((n) => /\.exe$/i.test(n))) {
    const header = await embeddedPck(path.join(base, program));
    if (header) return godotFound(base, program, null, header);
  }
  return null;
}

async function godotFound(base, program, pck, header) {
  const exe = path.join(base, program);
  return {
    engine: 'godot',
    base,
    godot: {
      dir: base,
      exe,
      pck: pck ? path.join(base, pck) : null,
      version: header.version,
      major: header.major,
      arch: /\.exe$/i.test(program) ? await programArch(exe) : null,
      // A settings file the game (or the player) already put there.
      overrideCfg: Boolean(await findEntry(base, 'override.cfg', 'file')),
    },
  };
}

/**
 * Which engine the game in `root` uses. Looks in the folder itself, then one
 * folder down (some stores install into a subfolder).
 */
async function fingerprint(root) {
  const realRoot = await fs.realpath(root);
  const bases = [realRoot, ...(await list(realRoot)).filter((e) => e.isDirectory()).map((e) => path.join(realRoot, e.name))];
  for (const base of bases) {
    const found = (await findUnreal(base)) || (await findUnity(base)) || (await findReEngine(base))
      || (await findRenpy(base)) || (await findGodot(base));
    if (found) return { root: realRoot, ...found };
  }
  return { root: realRoot, engine: 'custom', base: realRoot };
}

module.exports = { fingerprint, unityVersion, renpyVersion, UNITY_VERSION };
