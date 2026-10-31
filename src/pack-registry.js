// The cloud catalog of signed Arabic packs: admins publish a pack (a .zip of
// its folder, from the Pack Studio or uploaded in the Admin Panel), and the
// desktop app downloads it for a signed-in player the moment they turn Arabic on.
//
// A pack is only taken when its signature checks out against GameShelf's pack
// key (the same key every copy of the app checks with: localizationPackKey in
// desktop/config.json, or PACK_PUBLIC_KEY) and every file it lists is there
// with the right hash. It's kept as a fresh .zip of just those files, under
// <data folder>/packs/, and served with its SHA-256 so the app can check the
// download before it unpacks anything.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readZip, writeZip, packFiles, ZipError } = require('./zip');
const { readPack, PackError, MANIFEST, SIGNATURE } = require('../desktop/localization/pack');

const MAX_PACK_BYTES = 512 * 1024 * 1024;

class RegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** GameShelf's pack public keys: from desktop/config.json and PACK_PUBLIC_KEY (PEM text, or a file holding it). */
function packKeys(env = process.env) {
  const keys = [];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'config.json'), 'utf8'));
    if (config.localizationPackKey) keys.push(config.localizationPackKey);
  } catch {}
  const extra = env.PACK_PUBLIC_KEY;
  if (extra) keys.push(extra.includes('BEGIN PUBLIC KEY') ? extra.replace(/\\n/g, '\n') : fs.readFileSync(extra, 'utf8'));
  return keys;
}

const modeOf = (engine) => (engine === 'overlay' ? 'overlay' : 'native');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function createPackRegistry({ db, dir, publicKeys = packKeys() }) {
  const q = {
    get: db.prepare('SELECT * FROM localization_packs WHERE id = ? AND version = ?'),
    insert: db.prepare(`INSERT INTO localization_packs (id, version, engine, mode, title, steam_app_id, game_id, sha256, size, file, uploaded_by)
      VALUES (@id, @version, @engine, @mode, @title, @steamAppId, @gameId, @sha256, @size, @file, @uploadedBy)`),
    // The newest published version of each pack.
    latest: db.prepare(`SELECT p.* FROM localization_packs p WHERE p.published = 1 AND p.rowid = (
      SELECT p2.rowid FROM localization_packs p2 WHERE p2.id = p.id AND p2.published = 1 ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1)
      ORDER BY p.title COLLATE NOCASE, p.id`),
    latestOf: db.prepare('SELECT * FROM localization_packs WHERE id = ? AND published = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    all: db.prepare(`SELECT p.*, u.username AS uploader,
      (SELECT COUNT(*) FROM pack_downloads d WHERE d.pack_id = p.id AND d.version = p.version) AS downloads,
      (SELECT COUNT(DISTINCT d.user_id) FROM pack_downloads d WHERE d.pack_id = p.id AND d.version = p.version) AS players
      FROM localization_packs p LEFT JOIN users u ON u.id = p.uploaded_by ORDER BY p.created_at DESC, p.rowid DESC`),
    setPublished: db.prepare('UPDATE localization_packs SET published = ? WHERE id = ? AND version = ?'),
    remove: db.prepare('DELETE FROM localization_packs WHERE id = ? AND version = ?'),
    logDownload: db.prepare('INSERT INTO pack_downloads (pack_id, version, user_id) VALUES (?, ?, ?)'),
    downloads: db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS players FROM pack_downloads'),
  };

  const entry = (row) => ({
    id: row.id,
    version: row.version,
    engine: row.engine,
    mode: row.mode,
    title: row.title || null,
    steamAppId: row.steam_app_id ?? null,
    gameSlug: row.game_id ?? null,
    sha256: row.sha256,
    size: row.size,
    downloadUrl: `/api/localization/packs/${encodeURIComponent(row.id)}/download`,
    updatedAt: row.created_at,
  });

  /**
   * Checks and stores an uploaded pack (the bytes of a .zip). Throws
   * RegistryError with a message for the admin when it isn't a good pack.
   */
  async function publish(zip, { userId = null } = {}) {
    if (!publicKeys.length) throw new RegistryError('No pack signing key is set up on the server (localizationPackKey in desktop/config.json, or PACK_PUBLIC_KEY).', 503);
    if (zip.length > MAX_PACK_BYTES) throw new RegistryError('The pack is too big.', 413);
    let files;
    try {
      files = packFiles(readZip(zip, { maxSize: MAX_PACK_BYTES * 2 }));
    } catch (err) {
      if (err instanceof ZipError) throw new RegistryError(err.message);
      throw new RegistryError('That file isn\'t a .zip of an Arabic pack.');
    }
    // Checked exactly as the app will check it: unpacked to a folder, then readPack.
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gameshelf-pack-'));
    let pack;
    try {
      for (const { name, data } of files) {
        const to = path.join(temp, ...name.split('/'));
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.writeFile(to, data);
      }
      pack = await readPack(temp, { publicKey: publicKeys });
    } catch (err) {
      if (err instanceof PackError) throw new RegistryError(err.message);
      throw err;
    } finally {
      await fsp.rm(temp, { recursive: true, force: true });
    }
    const { manifest } = pack;
    if (!manifest.game) throw new RegistryError('The pack doesn\'t say which game it\'s for.');
    if (q.get.get(manifest.id, manifest.version)) {
      throw new RegistryError(`Version ${manifest.version} of ${manifest.id} is already in the catalog. Build it with a new version number.`, 409);
    }
    // Only the signed files (pack.json, its signature and the files it lists) are kept.
    const wanted = new Set([MANIFEST, SIGNATURE, ...manifest.files.map((f) => f.source.replace(/\\/g, '/'))]);
    const bytes = writeZip(files.filter((f) => wanted.has(f.name)));
    const file = `${manifest.id}-${manifest.version}.zip`.replace(/[^\w.\-]/g, '_');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, file), bytes);
    q.insert.run({
      id: manifest.id,
      version: manifest.version,
      engine: manifest.engine,
      mode: modeOf(manifest.engine),
      title: manifest.title || '',
      steamAppId: manifest.game.steamAppId ?? null,
      gameId: manifest.game.gameId ?? null,
      sha256: sha256(bytes),
      size: bytes.length,
      file,
      uploadedBy: userId,
    });
    return entry(q.get.get(manifest.id, manifest.version));
  }

  return {
    publish,
    /** The catalog players see: the newest published version of each pack. */
    list: () => q.latest.all().map(entry),
    /** Every version, with download counts, for the Admin Panel. */
    all: () => q.all.all().map((row) => ({ ...entry(row), published: Boolean(row.published), uploader: row.uploader || null, downloads: row.downloads, players: row.players })),
    /** { entry, path } of the newest published version, or null. Counts the download. */
    download(id, userId) {
      const row = q.latestOf.get(String(id));
      if (!row) return null;
      q.logDownload.run(row.id, row.version, userId ?? null);
      return { entry: entry(row), path: path.join(dir, row.file) };
    },
    setPublished(id, version, published) {
      return q.setPublished.run(published ? 1 : 0, id, version).changes > 0;
    },
    async remove(id, version) {
      const row = q.get.get(id, version);
      if (!row) return false;
      q.remove.run(id, version);
      await fsp.rm(path.join(dir, row.file), { force: true });
      return true;
    },
    stats: () => ({ packs: q.latest.all().length, ...(({ n, players }) => ({ downloads: n, players }))(q.downloads.get()) }),
    configured: () => publicKeys.length > 0,
  };
}

/** Reads a request body to a Buffer, refusing more than `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RegistryError('The file is too big.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { createPackRegistry, packKeys, readBody, RegistryError, MAX_PACK_BYTES };
