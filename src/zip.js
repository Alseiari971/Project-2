// Minimal .zip reading and writing, for Arabic packs travelling between the
// Pack Studio, the server's pack catalog and players' PCs. Handles what Windows
// Explorer, 7-Zip and this file make: stored and deflated files, no encryption,
// no zip64. Entry names are checked, so nothing can land outside its folder.
const zlib = require('node:zlib');

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MAX_ENTRIES = 5000;

class ZipError extends Error {}

/** A safe relative path ("a/b.txt"), or null for folders and names that would leave the folder. */
function cleanName(name) {
  const parts = name.replace(/\\/g, '/').split('/');
  if (name.endsWith('/') || name.endsWith('\\')) return null;
  if (/^[a-z]:/i.test(parts[0]) || parts[0] === '') throw new ZipError(`"${name}" in the zip isn't a relative path.`);
  if (parts.some((p) => p === '..' || p === '.' || p === '' || /[\0<>:"|?*]/.test(p))) throw new ZipError(`"${name}" in the zip isn't allowed.`);
  return parts.join('/');
}

/** [{ name, data }] for every file in the zip. `maxSize` caps the unpacked total. */
function readZip(buffer, { maxSize = 1024 * 1024 * 1024 } = {}) {
  const minEnd = Math.max(0, buffer.length - 0xffff - 22);
  let end = -1;
  for (let i = buffer.length - 22; i >= minEnd; i--) {
    if (buffer.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('That file isn\'t a .zip.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new ZipError('Zip64 files aren\'t supported.');
  if (count > MAX_ENTRIES) throw new ZipError('The zip has too many files.');
  const files = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) throw new ZipError('The zip is damaged.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const packed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    offset += 46 + nameLength + extraLength + commentLength;
    const name = cleanName(rawName);
    if (!name) continue;
    if (flags & 1) throw new ZipError('Encrypted zips aren\'t supported.');
    total += size;
    if (total > maxSize) throw new ZipError('The zip unpacks too big.');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) throw new ZipError('The zip is damaged.');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + packed);
    if (body.length !== packed) throw new ZipError('The zip is cut short.');
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
    else throw new ZipError(`"${name}" uses a compression this zip reader doesn't know.`);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new ZipError(`"${name}" in the zip is damaged.`);
    files.push({ name, data });
  }
  return files;
}

/** A .zip of [{ name, data }], each file deflated unless that doesn't make it smaller. */
function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const clean = cleanName(name);
    if (!clean) continue;
    const nameBytes = Buffer.from(clean, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + body.length;
    if (offset > 0xffffffff) throw new ZipError('The pack is too big for a .zip.');
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * The files of a pack inside a zip, relative to its pack.json: the zip of a pack
 * folder, of the folder itself (Explorer's "Send to, Compressed folder"), or of
 * the pack builder's output (the pack is in its "pack" folder).
 */
function packFiles(files) {
  const manifests = files.filter((f) => f.name === 'pack.json' || f.name.endsWith('/pack.json'));
  if (!manifests.length) throw new ZipError('The zip has no pack.json.');
  const root = manifests.map((f) => f.name.slice(0, -'pack.json'.length)).sort((a, b) => a.length - b.length)[0];
  return files.filter((f) => f.name.startsWith(root)).map((f) => ({ name: f.name.slice(root.length), data: f.data }));
}

module.exports = { readZip, writeZip, packFiles, ZipError };
