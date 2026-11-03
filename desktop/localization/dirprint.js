// A game folder's fingerprint, for the admins: what's in it (folder names,
// file names at the top, how many files of each kind and how big), so an admin
// who doesn't own the game can tell which engine it is and write its engine
// recipe. Sent with "Request Arabic subtitles" when this PC can't make the
// Arabic itself. Only names relative to the game's folder go out: no paths of
// this PC, and nothing from inside any file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { list } = require('./files');

const LIMITS = { entries: 30000, depth: 4, folders: 200, top: 80, extensions: 40, name: 120 };

const clip = (name) => String(name).slice(0, LIMITS.name);

/**
 * { folders: ["exec/", "exec/wad/", ...], top: { folders: [...], files: [...] },
 *   extensions: [{ ext, count, bytes }], files, bytes, truncated, engine }.
 * `engine` is the engine (or engine family) GameShelf thinks it is, if any.
 */
async function directoryFingerprint(root, { engine = null } = {}) {
  const extensions = new Map();
  const folders = [];
  let files = 0;
  let bytes = 0;
  let seen = 0;
  let truncated = false;
  const top = { folders: [], files: [] };
  const queue = [[root, '', 0]];
  while (queue.length) {
    const [dir, rel, depth] = queue.shift();
    const entries = (await list(dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > LIMITS.entries) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const name = clip(entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) top.folders.push(name);
        if (folders.length < LIMITS.folders) folders.push(`${rel}${name}/`);
        if (depth + 1 < LIMITS.depth) queue.push([path.join(dir, entry.name), `${rel}${name}/`, depth + 1]);
      } else if (entry.isFile()) {
        const size = (await fs.stat(path.join(dir, entry.name)).catch(() => null))?.size || 0;
        if (depth === 0) top.files.push(name);
        const ext = (path.extname(entry.name) || '(none)').toLowerCase().slice(0, 24);
        const got = extensions.get(ext) || { ext, count: 0, bytes: 0 };
        got.count += 1;
        got.bytes += size;
        extensions.set(ext, got);
        files += 1;
        bytes += size;
      }
    }
    if (truncated) break;
  }
  return {
    folders,
    top: { folders: top.folders.slice(0, LIMITS.top), files: top.files.slice(0, LIMITS.top) },
    extensions: [...extensions.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count).slice(0, LIMITS.extensions),
    files,
    bytes,
    truncated: truncated || queue.length > 0,
    engine,
  };
}

/** What the fingerprint check (engine.js) says about a game, in a few words. */
function engineOf(fingerprint) {
  if (!fingerprint) return null;
  if (fingerprint.engine !== 'custom') return { id: fingerprint.engine, name: fingerprint.engine };
  const family = fingerprint.custom?.family;
  return family ? { id: family.id, name: family.name } : (fingerprint.custom?.looseText?.length ? { id: 'loose', name: 'Readable text files' } : null);
}

module.exports = { directoryFingerprint, engineOf, LIMITS };
