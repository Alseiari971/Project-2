// The Arabic packs on this computer, in <data>/localization/packs/<id>/. A
// pack is checked (signature and every file) when it's added, and again each
// time it's used. Only the files its signed pack.json lists are copied in.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPack, PackError, MANIFEST, SIGNATURE } = require('./pack');

const forGameMatch = (manifest, { steamAppId, gameId }) => Boolean(manifest.game) && (
  (steamAppId && manifest.game.steamAppId === Number(steamAppId)) || (gameId && manifest.game.gameId === gameId));

function createPackLibrary({ dir, publicKey }) {
  async function entries() {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const packDir = path.join(dir, entry.name);
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(packDir, MANIFEST), 'utf8'));
        out.push({ id: manifest.id, version: manifest.version, engine: manifest.engine, title: manifest.title || null, game: manifest.game || null, overlay: manifest.overlay || null, dir: packDir });
      } catch {
        // Not a pack (or a damaged one): ignored.
      }
    }
    return out.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
  }

  return {
    list: entries,

    /** The packs for a game: { steamAppId, gameId }. */
    async forGame(game) {
      return (await entries()).filter((p) => forGameMatch(p, game));
    },

    /** Checks a pack again; returns what readPack does. */
    async verify(id) {
      const pack = (await entries()).find((p) => p.id === id);
      if (!pack) throw new PackError('That Arabic pack is no longer installed.');
      return readPack(pack.dir, { publicKey });
    },

    /** Checks the pack in `sourceDir` and copies it in, replacing an older copy with the same id. */
    async add(sourceDir) {
      const pack = await readPack(sourceDir, { publicKey });
      if (!pack.manifest.game) throw new PackError('This pack doesn\'t say which game it\'s for.');
      const target = path.join(dir, pack.manifest.id);
      const temp = path.join(dir, `.${pack.manifest.id}.${crypto.randomBytes(4).toString('hex')}`);
      await fs.mkdir(temp, { recursive: true });
      try {
        for (const name of [MANIFEST, SIGNATURE]) await fs.copyFile(path.join(pack.dir, name), path.join(temp, name));
        for (const file of pack.manifest.files) {
          const to = path.join(temp, ...file.source.split(/[\\/]/));
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(path.join(pack.dir, ...file.source.split(/[\\/]/)), to);
        }
        await readPack(temp, { publicKey }); // the copy is whole
        await fs.rm(target, { recursive: true, force: true });
        await fs.rename(temp, target);
      } catch (err) {
        await fs.rm(temp, { recursive: true, force: true });
        throw err;
      }
      const { id, version, engine, title, game } = pack.manifest;
      return { id, version, engine, title: title || null, game };
    },

    async remove(id) {
      const pack = (await entries()).find((p) => p.id === id);
      if (pack) await fs.rm(pack.dir, { recursive: true, force: true });
    },
  };
}

module.exports = { createPackLibrary };
