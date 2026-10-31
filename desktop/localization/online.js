// Arabic subtitles from GameShelf's server, for the signed-in player:
// - the cloud catalog of signed packs: which games have one, and getting it
//   onto this PC (downloaded, checked against the catalog's SHA-256, unpacked;
//   the pack library then checks its signature before anything uses it);
// - for games with no pack, whether the server's shared translations are ready
//   (the app then builds the patch here, see builder.js), and requests.
const fs = require('node:fs/promises');
const path = require('node:path');
const { readZip, packFiles } = require('../../src/zip');
const { CloudError } = require('../cloud');

const CATALOG_TTL_MS = 5 * 60 * 1000;
// When the server can't be reached: wait this long for it, then don't ask again for a minute.
const CATALOG_TIMEOUT_MS = 8000;
const CATALOG_RETRY_MS = 60 * 1000;

/** "steam:<app id>" or "game:<GameShelf id>", as the server knows games; null when neither fits. */
function gameKey({ steamAppId, gameId }) {
  if (steamAppId && /^\d{1,10}$/.test(String(steamAppId))) return `steam:${steamAppId}`;
  if (gameId && /^[a-z0-9][a-z0-9-]{0,149}$/.test(String(gameId))) return `game:${gameId}`;
  return null;
}

function createArabicOnline({ cloud, cacheDir }) {
  let catalog = { at: 0, packs: null, loading: null };

  async function packs({ fresh = false } = {}) {
    if (!fresh && catalog.packs && Date.now() - catalog.at < (catalog.failed ? CATALOG_RETRY_MS : CATALOG_TTL_MS)) return catalog.packs;
    catalog.loading ??= cloud.json('/api/localization/packs', { auth: false, timeout: CATALOG_TIMEOUT_MS })
      .then(({ packs: list }) => {
        catalog = { at: Date.now(), packs: Array.isArray(list) ? list : [], loading: null };
        return catalog.packs;
      })
      .catch((err) => {
        // Offline: what was known before still counts; with nothing known, nothing for a minute.
        catalog = { at: Date.now(), packs: catalog.packs || [], loading: null, failed: true };
        if (catalog.packs.length) return catalog.packs;
        throw err;
      });
    return catalog.loading;
  }

  return {
    configured: true,
    signedIn: async () => Boolean(await cloud.session()),
    me: () => cloud.me(),

    /** The pack builder's sign-in (it asks the shared memory as this player). */
    async builderEnv() {
      const session = await cloud.session();
      if (!session) throw new CloudError('Log in to GameShelf first.', 401);
      return { GAMESHELF_SESSION: session };
    },

    /** { status: 'ready' | 'partial' | 'none', total, translated, requests, asked, fontTargets } */
    async status(key) {
      return (await cloud.json('/api/arabic/status', { method: 'POST', body: { games: [key] } })).games?.[key] || null;
    },
    async request(key, name) {
      return cloud.json('/api/arabic/requests', { method: 'POST', body: { game: key, name } });
    },

    catalog: {
      list: packs,
      /** The catalog's pack for a game ({ steamAppId, gameId }), or null (also when the server can't be reached). */
      async forGame(game) {
        let list;
        try {
          list = await packs();
        } catch {
          return null;
        }
        return list.find((p) => (game.steamAppId && p.steamAppId === Number(game.steamAppId)) || (game.gameId && p.gameSlug === game.gameId)) || null;
      },
      /**
       * Downloads a catalog pack and unpacks it; resolves to its folder (for the
       * pack library to check and add, after which `done()` tidies up).
       * onProgress gets { phase: 'downloading', done, total }.
       */
      async fetch(entry, { onProgress = () => {} } = {}) {
        const name = `${entry.id}-${entry.version}`.replace(/[^\w.\-]/g, '_');
        const zip = path.join(cacheDir, `${name}.zip`);
        const dir = path.join(cacheDir, name);
        const tidy = () => Promise.all([fs.rm(zip, { force: true }), fs.rm(dir, { recursive: true, force: true })]);
        await tidy();
        const got = await cloud.download(entry.downloadUrl, zip, { onProgress: (p) => onProgress({ phase: 'downloading', ...p }) });
        try {
          if (got.sha256 !== entry.sha256) throw new CloudError('The Arabic pack didn\'t download correctly. Please try again.');
          for (const { name: file, data } of packFiles(readZip(await fs.readFile(zip)))) {
            const to = path.join(dir, ...file.split('/'));
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.writeFile(to, data);
          }
        } catch (err) {
          await tidy();
          throw err;
        }
        await fs.rm(zip, { force: true });
        return { dir, done: tidy };
      },
      forget: () => { catalog = { at: 0, packs: null, loading: null }; },
    },
  };
}

module.exports = { createArabicOnline, gameKey };
