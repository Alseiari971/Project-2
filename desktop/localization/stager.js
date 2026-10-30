// Adds a pack's files to a game, and takes them away again, without ever
// replacing or deleting anything that isn't GameShelf's:
//
// - Nothing is overwritten. If any file a pack adds already exists, nothing
//   is added at all.
// - Before the first file is written, a record of every file and folder about
//   to be added is saved. If GameShelf stops halfway (a crash, a power cut),
//   recover() uses it to take back what was added, on the next start.
// - Each file is written beside its place, checked against its hash, then
//   linked into place in one step, so a game never sees half a file.
// - Turning Arabic off removes a file only if it's still byte-for-byte what
//   was added (or is a settings file the mod rewrites), and a folder only if
//   GameShelf created it. Anything else is left, and listed.
// - Links (and Windows junctions) are never followed.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { fold, isInside, sha256, sha256File, writeAtomic } = require('./files');

class StageError extends Error {
  constructor(message, code = 'stage', details = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** unlink that waits a moment for Windows to let go of a file. */
async function removeFile(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      await sleep(250);
    }
  }
}

function createStager({ stateDir }) {
  const locks = new Map();
  const stateFile = (root) => path.join(stateDir, `${sha256(fold(root)).slice(0, 32)}.json`);

  // One change per game at a time.
  function locked(root, task) {
    const key = fold(root);
    const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(task);
    locks.set(key, run);
    return run.finally(() => {
      if (locks.get(key) === run) locks.delete(key);
    });
  }

  async function readState(root) {
    try {
      return JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
    } catch {
      return null;
    }
  }

  async function saveState(state) {
    await fs.mkdir(stateDir, { recursive: true });
    await writeAtomic(stateFile(state.root), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 1));
  }

  const dropState = (root) => fs.rm(stateFile(root), { force: true });

  /** Every folder from `from` down to `to` must be a real folder, not a link. */
  async function checkNoLinks(from, to) {
    let current = from;
    for (const part of path.relative(from, to).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await fs.lstat(current).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new StageError(`"${current}" is a link or a file, so GameShelf won't write through it.`, 'conflict');
      }
    }
  }

  // Takes back an unfinished or failed add: removes the files it wrote (only
  // where they still match), its half-written files, and the folders it made.
  async function rollback(state) {
    for (const file of [...state.files].reverse()) {
      await removeFile(`${file.path}.${state.op}.partial`).catch(() => {});
      const info = await fs.lstat(file.path).catch(() => null);
      if (info?.isFile() && (await sha256File(file.path).catch(() => null)) === file.sha256) {
        await removeFile(file.path).catch(() => {});
      }
    }
    for (const dir of [...state.dirs].reverse()) await fs.rmdir(dir).catch(() => {});
    await dropState(state.root);
  }

  async function place(file, entry, op) {
    const partial = `${file.path}.${op}.partial`;
    if (entry.source) await fs.copyFile(entry.source, partial, fs.constants.COPYFILE_EXCL);
    else await fs.writeFile(partial, entry.content, { flag: 'wx' });
    if ((await sha256File(partial)) !== file.sha256) {
      throw new StageError(`"${entry.target}" changed while it was being copied.`, 'pack');
    }
    try {
      // A hard link fails if the name was taken meanwhile; rename would replace it.
      await fs.link(partial, file.path);
    } catch (err) {
      if (err.code === 'EEXIST') throw new StageError(`"${file.path}" appeared while GameShelf was adding files.`, 'conflict');
      // Drives without hard links (FAT32, exFAT): check, then rename.
      if (await fs.lstat(file.path).catch(() => null)) throw new StageError(`"${file.path}" already exists.`, 'conflict');
      await fs.rename(partial, file.path);
      return;
    }
    await removeFile(partial);
  }

  /**
   * Adds files to a game. `anchor` is the folder the targets are relative to
   * (inside `root`); each file is { target, source } or { target, content }, with
   * its sha256, and `mutable` for files the mod itself rewrites. `generated`
   * lists paths (relative to the anchor) the mod creates while running, which
   * go with it when GameShelf created their folder.
   */
  async function enable({ root, anchor, pack, files, generated = [] }) {
    const realRoot = await fs.realpath(root);
    return locked(realRoot, async () => {
      const realAnchor = await fs.realpath(anchor);
      if (!isInside(realRoot, realAnchor, { allowSame: true })) throw new StageError('The target folder isn\'t inside the game\'s folder.');

      const existing = await readState(realRoot);
      if (existing?.status === 'staging') await rollback(existing);
      else if (existing?.status === 'enabled' && existing.pack.id === pack.id && existing.pack.version === pack.version) {
        return { already: true, files: existing.files.length };
      } else if (existing && !(existing.status === 'partial' && !existing.files.length)) {
        // (A partial record with no files left only lists folders that hold the
        // player's own files now; those aren't GameShelf's any more.)
        throw new StageError('An earlier version is still in this game. Turn Arabic off first.', 'busy');
      }

      // Plan everything, and check every name is free, before writing anything.
      const op = crypto.randomBytes(6).toString('hex');
      const planned = [];
      const dirs = [];
      const names = new Set();
      const conflicts = [];
      for (const entry of files) {
        const target = path.resolve(realAnchor, ...entry.target.split(/[\\/]/));
        if (!isInside(realAnchor, target)) throw new StageError(`"${entry.target}" points outside the game.`, 'pack');
        if (names.has(fold(target))) throw new StageError(`"${entry.target}" is listed twice.`, 'pack');
        names.add(fold(target));
        await checkNoLinks(realAnchor, path.dirname(target));
        if (await fs.lstat(target).catch(() => null)) conflicts.push(target);
        for (let dir = path.dirname(target); isInside(realAnchor, dir); dir = path.dirname(dir)) {
          if (await fs.lstat(dir).catch(() => null)) break;
          if (!dirs.some((d) => fold(d) === fold(dir))) dirs.push(dir);
        }
        planned.push({ path: target, sha256: entry.sha256, mutable: Boolean(entry.mutable) });
      }
      if (conflicts.length) {
        throw new StageError('The game already has files with these names, so GameShelf won\'t add anything.', 'conflict', conflicts);
      }
      dirs.sort((a, b) => a.length - b.length); // parents first

      const state = {
        format: 1,
        root: realRoot,
        anchor: realAnchor,
        pack: { id: pack.id, version: pack.version },
        status: 'staging',
        op,
        dirs,
        files: planned,
        generated: generated.map((g) => path.resolve(realAnchor, ...g.split(/[\\/]/))).filter((g) => isInside(realAnchor, g)),
      };
      await saveState(state);
      try {
        for (const dir of dirs) await fs.mkdir(dir);
        for (let i = 0; i < files.length; i++) await place(planned[i], files[i], op);
        await saveState({ ...state, status: 'enabled', enabledAt: new Date().toISOString() });
      } catch (err) {
        await rollback(state);
        throw err.code === 'EEXIST' ? new StageError(`"${err.path}" appeared while GameShelf was adding files.`, 'conflict') : err;
      }
      return { already: false, files: planned.length, dirs: dirs.length };
    });
  }

  /** Takes away everything enable() added. Returns { removed, kept: [{ path, why }] }. */
  async function disable(root) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    return locked(realRoot, async () => {
      const state = await readState(realRoot);
      if (!state) return { removed: [], kept: [] };
      if (state.status === 'staging') {
        await rollback(state);
        return { removed: state.files.map((f) => f.path), kept: [] };
      }
      if (!(await fs.lstat(realRoot).catch(() => null))) {
        await dropState(realRoot); // the game itself is gone
        return { removed: [], kept: [] };
      }

      const removed = [];
      const kept = [];
      for (const file of [...state.files].reverse()) {
        const info = await fs.lstat(file.path).catch(() => null);
        if (!info) continue;
        if (!info.isFile()) {
          kept.push({ path: file.path, why: 'replaced by something else' });
        } else if (file.mutable || (await sha256File(file.path)) === file.sha256) {
          try {
            await removeFile(file.path);
            removed.push(file.path);
          } catch (err) {
            kept.push({ path: file.path, why: err.code === 'EBUSY' ? 'in use' : err.code || err.message, file });
          }
        } else {
          kept.push({ path: file.path, why: 'changed since GameShelf added it' });
        }
      }

      // What the mod made while running, inside folders GameShelf created.
      const ours = (p) => state.dirs.some((dir) => isInside(dir, p, { allowSame: true }));
      for (const generated of state.generated || []) {
        if (!ours(generated)) continue;
        const info = await fs.lstat(generated).catch(() => null);
        if (!info) continue;
        try {
          await fs.rm(generated, { recursive: true, force: true });
          removed.push(generated);
        } catch (err) {
          kept.push({ path: generated, why: err.code || err.message });
        }
      }

      const leftDirs = [];
      for (const dir of [...state.dirs].sort((a, b) => b.length - a.length)) {
        try {
          await fs.rmdir(dir);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          leftDirs.push(dir);
          kept.push({ path: dir, why: err.code === 'ENOTEMPTY' ? 'has files GameShelf didn\'t add' : err.code || err.message });
        }
      }

      const retry = kept.filter((k) => k.file).map((k) => k.file);
      if (retry.length || leftDirs.length) {
        // Files that were in use stay on the list, so a later try can finish.
        await saveState({ ...state, status: 'partial', files: retry, generated: [], dirs: leftDirs });
      } else {
        await dropState(realRoot);
      }
      return { removed, kept: kept.map(({ path: p, why }) => ({ path: p, why })) };
    });
  }

  /** What GameShelf has added to this game: null, or { pack, status, files }. */
  async function status(root) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    const state = await readState(realRoot);
    return state && { pack: state.pack, status: state.status, files: state.files.length, enabledAt: state.enabledAt };
  }

  /** On startup: takes back any add that was cut short. Returns how many. */
  async function recover() {
    let count = 0;
    for (const name of await fs.readdir(stateDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const state = JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8'));
        if (state.status === 'staging') {
          await locked(state.root, () => rollback(state));
          count++;
        }
      } catch {
        // A damaged record: leave it for a person to look at.
      }
    }
    return count;
  }

  return { enable, disable, status, recover };
}

module.exports = { createStager, StageError };
