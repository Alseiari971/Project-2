// Small file helpers shared by the localization modules. Windows paths are
// case-insensitive, so names are matched without regard to case everywhere.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const windows = process.platform === 'win32';
const fold = (p) => (windows ? p.toLowerCase() : p);

/** The entries of a folder, or [] when it can't be read. */
async function list(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The real path of `name` inside `dir`, matched without regard to case, or null. */
async function findEntry(dir, name, kind) {
  const want = name.toLowerCase();
  const entry = (await list(dir)).find((e) => e.name.toLowerCase() === want
    && (!kind || (kind === 'dir' ? e.isDirectory() : e.isFile())));
  return entry ? path.join(dir, entry.name) : null;
}

/** Follows a chain of names down from `dir`, e.g. findPath(root, 'Content', 'Paks'). */
async function findPath(dir, ...names) {
  let current = dir;
  for (const name of names) {
    current = await findEntry(current, name, 'dir');
    if (!current) return null;
  }
  return current;
}

/** True when `child` is `parent` itself or somewhere inside it. */
function isInside(parent, child, { allowSame = false } = {}) {
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  if (rel === '') return allowSame;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// The CPU a Windows program is built for, from its PE header.
const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' };
async function programArch(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null;
    const pe = head.readUInt32LE(0x3c);
    if (pe + 6 > bytesRead || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
    return MACHINES[head.readUInt16LE(pe + 4)] || null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Writes a file so a crash never leaves it half written. */
async function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

module.exports = { windows, fold, list, findEntry, findPath, isInside, sha256File, sha256, exists, programArch, writeAtomic };
