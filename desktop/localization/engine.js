// Works out which engine a game is built with, from its folder alone:
//
// - Unreal Engine 4/5: an Engine folder next to a <Project> folder whose
//   Content/Paks holds .pak (or UE5 .utoc) files.
// - Unity: a <Name>_Data folder (resources.assets, globalgamemanagers...) next
//   to UnityPlayer.dll or <Name>.exe; IL2CPP when GameAssembly.dll is there,
//   Mono otherwise. The Unity version is read from the data files' header.
// - Anything else is a custom engine, which only the overlay can serve.
const fs = require('node:fs/promises');
const path = require('node:path');
const { list, findEntry, findPath, programArch } = require('./files');

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

/**
 * Which engine the game in `root` uses. Looks in the folder itself, then one
 * folder down (some stores install into a subfolder).
 */
async function fingerprint(root) {
  const realRoot = await fs.realpath(root);
  const bases = [realRoot, ...(await list(realRoot)).filter((e) => e.isDirectory()).map((e) => path.join(realRoot, e.name))];
  for (const base of bases) {
    const found = (await findUnreal(base)) || (await findUnity(base));
    if (found) return { root: realRoot, ...found };
  }
  return { root: realRoot, engine: 'custom', base: realRoot };
}

module.exports = { fingerprint, unityVersion, UNITY_VERSION };
