// Adds a pack's files to a game, and takes them away again, without ever
// losing anything that isn't GameShelf's:
//
// - Nothing is overwritten by accident. If any file a pack adds already
//   exists, nothing is added at all.
// - The one exception is a file the pack says it replaces (`replace: true`: a
//   game's own localization file, for engines that read only that file). Its
//   original is copied out of the game folder first and checked; turning
//   Arabic off puts the exact original back (checked again), and a crash
//   halfway puts it back on the next start.
// - Before the first file is written, a record of every file and folder about
//   to be added is saved. If GameShelf stops halfway (a crash, a power cut),
//   recover() uses it to take back what was added, on the next start.
// - Each file is written beside its place, checked against its hash, then
//   linked into place in one step, so a game never sees half a file.
// - Turning Arabic off removes a file only if it's still byte-for-byte what
//   was added (or is a settings file the mod rewrites), and a folder only if
//   GameShelf created it. Anything else is left, and listed.
// - Links (and Windows junctions) are never followed.
// - A file in a numbered chain (RE Engine's patch files, which the game loads
//   in order until a number is missing) is only taken out while it's the last
//   one; otherwise nothing is removed and turning off says why.
// - Game updates: the record keeps the size and time of the game's own files
//   the caller names (its archives, its program) and of the folders they're
//   in, and of every file GameShelf put in. verify() tells, cheaply, when a
//   store update changed them (or wrote over a file GameShelf replaced), and
//   retire() takes GameShelf's files out after one without ever putting an
//   outdated original back over the update: backups the update made obsolete
//   are dropped, and what the update wrote stays.
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
// Files bigger than this aren't hashed to tell whether a changed time means changed contents.
const HASH_LIMIT = 256 * 1024 * 1024;

const stampOf = (info) => ({ size: info.size, mtimeMs: Math.round(info.mtimeMs) });
const sameStamp = (info, stamp) => Boolean(stamp) && info.size === stamp.size && Math.round(info.mtimeMs) === stamp.mtimeMs;

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
      if (file.replace) {
        // Only put back what was copied out; a file never replaced is still the original.
        if (await fs.lstat(file.replace.backup).catch(() => null)) {
          if (await restore(file, state.op).catch(() => false)) await removeFile(file.replace.backup).catch(() => {});
        }
        continue;
      }
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

  // A file the pack replaces: the original goes to the backup first (checked),
  // then the new one takes its place in one step.
  async function replace(file, entry, op) {
    await fs.mkdir(path.dirname(file.replace.backup), { recursive: true });
    await fs.copyFile(file.path, file.replace.backup, fs.constants.COPYFILE_EXCL);
    if ((await sha256File(file.replace.backup)) !== file.replace.sha256) {
      throw new StageError(`"${file.path}" changed while GameShelf was keeping a copy of it.`, 'conflict');
    }
    const partial = `${file.path}.${op}.partial`;
    if (entry.source) await fs.copyFile(entry.source, partial, fs.constants.COPYFILE_EXCL);
    else await fs.writeFile(partial, entry.content, { flag: 'wx' });
    if ((await sha256File(partial)) !== file.sha256) {
      throw new StageError(`"${entry.target}" changed while it was being copied.`, 'pack');
    }
    await fs.rename(partial, file.path);
  }

  /** Puts a replaced file's original back from its backup. True when it's back (or never left). */
  async function restore(file, op) {
    const current = await sha256File(file.path).catch(() => null);
    if (current === file.replace.sha256) return true;
    if (current !== file.sha256 && current !== null) return false; // changed since: left alone
    if ((await sha256File(file.replace.backup).catch(() => null)) !== file.replace.sha256) return false;
    const partial = `${file.path}.${op}.restore`;
    await fs.copyFile(file.replace.backup, partial);
    if ((await sha256File(partial)) !== file.replace.sha256) {
      await removeFile(partial);
      return false;
    }
    await fs.rename(partial, file.path);
    return true;
  }

  /** The size and time of the game's own files, and the names in its folders (matching each folder's pattern), minus GameShelf's. */
  async function watchSnapshot(realRoot, watch, ours) {
    const own = new Set(ours.map((p) => fold(p)));
    const files = [];
    for (const file of watch.files || []) {
      const full = path.resolve(file);
      if (!isInside(realRoot, full) || own.has(fold(full)) || files.some((f) => fold(f.path) === fold(full))) continue;
      const info = await fs.lstat(full).catch(() => null);
      if (info?.isFile()) files.push({ path: full, ...stampOf(info) });
    }
    const dirs = [];
    for (const { path: dir, pattern } of watch.dirs || []) {
      const full = path.resolve(dir);
      if (!isInside(realRoot, full, { allowSame: true })) continue;
      dirs.push({ path: full, pattern, names: await namesIn(full, pattern, own) });
    }
    return { files, dirs };
  }

  async function namesIn(dir, pattern, own = new Set()) {
    const re = new RegExp(pattern, 'i');
    return (await fs.readdir(dir).catch(() => [])).filter((n) => re.test(n) && !own.has(fold(path.join(dir, n)))).sort();
  }

  /**
   * Adds files to a game. `anchor` is the folder the targets are relative to
   * (inside `root`); each file is { target, source } or { target, content }, with
   * its sha256, and `mutable` for files the mod itself rewrites. `generated`
   * lists paths (relative to the anchor) the mod creates while running, which
   * go with it when GameShelf created their folder. `watch` names the game's own
   * files ({ files: [paths], dirs: [{ path, pattern }] }) that a game update changes.
   */
  async function enable({ root, anchor, pack, files, generated = [], watch = {} }) {
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
      for (const [index, entry] of files.entries()) {
        const target = path.resolve(realAnchor, ...entry.target.split(/[\\/]/));
        if (!isInside(realAnchor, target)) throw new StageError(`"${entry.target}" points outside the game.`, 'pack');
        if (names.has(fold(target))) throw new StageError(`"${entry.target}" is listed twice.`, 'pack');
        names.add(fold(target));
        await checkNoLinks(realAnchor, path.dirname(target));
        if (entry.replace) {
          // Replaced: it has to be there, as a plain file; its original is kept outside the game.
          const info = await fs.lstat(target).catch(() => null);
          if (!info?.isFile()) throw new StageError(`"${entry.target}" isn't in the game, so GameShelf can't replace it.`, 'conflict', [target]);
          planned.push({
            path: target,
            sha256: entry.sha256,
            replace: { sha256: await sha256File(target), backup: path.join(stateDir, 'backups', sha256(fold(realRoot)).slice(0, 16), op, `${index}-${path.basename(target)}`) },
          });
          continue;
        }
        if (await fs.lstat(target).catch(() => null)) conflicts.push(target);
        for (let dir = path.dirname(target); isInside(realAnchor, dir); dir = path.dirname(dir)) {
          if (await fs.lstat(dir).catch(() => null)) break;
          if (!dirs.some((d) => fold(d) === fold(dir))) dirs.push(dir);
        }
        planned.push({ path: target, sha256: entry.sha256, mutable: Boolean(entry.mutable), ...(entry.chain ? { chain: entry.chain } : {}) });
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
        for (let i = 0; i < files.length; i++) {
          if (planned[i].replace) await replace(planned[i], files[i], op);
          else await place(planned[i], files[i], op);
        }
        for (const file of planned) {
          const info = await fs.lstat(file.path).catch(() => null);
          if (info) file.stamp = stampOf(info);
          if (file.replace) {
            const backup = await fs.lstat(file.replace.backup).catch(() => null);
            if (backup) file.replace.size = backup.size;
          }
        }
        const watched = await watchSnapshot(realRoot, watch, planned.map((f) => f.path));
        await saveState({ ...state, files: planned, watch: watched, status: 'enabled', enabledAt: new Date().toISOString() });
      } catch (err) {
        await rollback(state);
        throw err.code === 'EEXIST' ? new StageError(`"${err.path}" appeared while GameShelf was adding files.`, 'conflict') : err;
      }
      return { already: false, files: planned.length, dirs: dirs.length };
    });
  }

  // The name of a file in the same chain numbered after `file`, when `file`
  // is still GameShelf's and so would be taken out.
  async function laterInChain(file) {
    const pattern = new RegExp(file.chain.pattern, 'i');
    const info = await fs.lstat(file.path).catch(() => null);
    if (!info?.isFile() || (await sha256File(file.path).catch(() => null)) !== file.sha256) return null;
    const later = (await fs.readdir(path.dirname(file.path)).catch(() => []))
      .map((name) => ({ name, number: Number(name.match(pattern)?.[1]) }))
      .filter((f) => f.number > file.chain.number)
      .sort((a, b) => a.number - b.number);
    return later[0]?.name || null;
  }

  /**
   * Whether the game changed since its files went in (a store update, or a
   * "verify files" that put the game's own files back): null when nothing of
   * GameShelf's is in, else { updated, changes: [{ path, what }], backups: [problems] }.
   * `what`: 'missing', 'overwritten' (a file of GameShelf's has other contents
   * now), 'restored' (a replaced file has its original back), 'changed' or
   * 'removed' (a game file), 'added' or 'gone' (a name in a watched folder).
   */
  async function verify(root) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    const state = await readState(realRoot);
    if (!state || state.status !== 'enabled') return null;
    const changes = [];
    const backups = [];
    for (const file of state.files) {
      if (file.mutable) continue;
      const info = await fs.lstat(file.path).catch(() => null);
      if (!info?.isFile()) {
        changes.push({ path: file.path, what: 'missing' });
        continue;
      }
      if (file.replace) {
        const backup = await fs.lstat(file.replace.backup).catch(() => null);
        if (!backup || (file.replace.size !== undefined && backup.size !== file.replace.size)) backups.push({ path: file.replace.backup, what: 'damaged' });
      }
      // Added under a name of GameShelf's own: store updates don't write there.
      if (!file.replace && !file.chain) continue;
      if (sameStamp(info, file.stamp)) continue;
      if (info.size > HASH_LIMIT) {
        changes.push({ path: file.path, what: 'overwritten' });
        continue;
      }
      const current = await sha256File(file.path).catch(() => null);
      if (current === file.sha256) continue;
      changes.push({ path: file.path, what: file.replace && current === file.replace.sha256 ? 'restored' : 'overwritten' });
    }
    for (const file of state.watch?.files || []) {
      const info = await fs.lstat(file.path).catch(() => null);
      if (!info) changes.push({ path: file.path, what: 'removed' });
      else if (!sameStamp(info, file)) changes.push({ path: file.path, what: 'changed' });
    }
    const own = new Set(state.files.map((f) => fold(f.path)));
    for (const dir of state.watch?.dirs || []) {
      const now = await namesIn(dir.path, dir.pattern, own);
      for (const name of now.filter((n) => !dir.names.includes(n))) changes.push({ path: path.join(dir.path, name), what: 'added' });
      for (const name of dir.names.filter((n) => !now.includes(n))) changes.push({ path: path.join(dir.path, name), what: 'gone' });
    }
    return { updated: changes.length > 0, changes, backups };
  }

  /**
   * Takes away everything enable() added. Returns { removed, kept: [{ path, why }],
   * superseded, left }. Throws StageError 'chain' (and changes nothing) when a
   * file in a numbered chain has another after it; details: [{ path, after }].
   *
   * With `superseded` (after a game update, see verify()), what the update
   * changed is the game's now: a replaced file the update wrote over keeps the
   * update's version and its outdated backup is dropped, a file of GameShelf's
   * the update wrote over is left as the update's, and a numbered patch file
   * with a newer one after it stays where it is (the game needs the chain
   * whole), forgotten: the next Arabic goes in after it. Nothing is kept on the
   * list for later.
   */
  async function disable(root, { superseded: afterUpdate = false } = {}) {
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
      const left = [];
      for (const file of state.files.filter((f) => f.chain)) {
        const after = await laterInChain(file);
        if (after && afterUpdate) {
          left.push(file.path);
        } else if (after) {
          throw new StageError(`${after} was added after ${path.basename(file.path)}, and the game would stop loading it if ${path.basename(file.path)} were taken out. Take ${after} out first.`, 'chain', [{ path: file.path, after }]);
        }
      }

      const removed = [];
      const kept = [];
      const superseded = [];
      for (const file of [...state.files].reverse()) {
        if (left.includes(file.path)) continue;
        if (file.replace) {
          // The game's own file: its original goes back, unless the file changed since (a game update).
          try {
            if (await restore(file, state.op)) {
              await removeFile(file.replace.backup).catch(() => {});
              removed.push(file.path);
            } else if (afterUpdate) {
              // The update's version stays; the original from before it is out of date.
              await removeFile(file.replace.backup).catch(() => {});
              superseded.push(file.path);
            } else {
              kept.push({ path: file.path, why: `changed since GameShelf replaced it; GameShelf's copy of the original is at ${file.replace.backup}` });
            }
          } catch (err) {
            kept.push({ path: file.path, why: err.code === 'EBUSY' ? 'in use' : err.code || err.message, file });
          }
          continue;
        }
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
        } else if (afterUpdate) {
          superseded.push(file.path);
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
          if (afterUpdate && err.code === 'ENOTEMPTY') continue; // holds the update's files now
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
      return { removed, kept: kept.map(({ path: p, why }) => ({ path: p, why })), superseded, left };
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

  return { enable, disable, verify, retire: (root) => disable(root, { superseded: true }), status, recover };
}

module.exports = { createStager, StageError };
