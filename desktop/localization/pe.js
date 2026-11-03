// What a Windows program or library imports: the names of the functions it
// calls in each system library (its import table and delay-load table). Used
// to tell whether a custom-engine game draws its text with Windows' own text
// APIs (GDI, DirectWrite), which the native runtime adapter can reach, and
// which system library it loads from its own folder first (version.dll,
// dinput8.dll), which the adapter can stand in for. Only the headers and
// tables are read, never code.
const fs = require('node:fs/promises');

const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' };
const MAX_SECTION = 64 * 1024 * 1024;
const MAX_DESCRIPTORS = 1024;
const MAX_FUNCTIONS = 8192;

/**
 * { arch, imports: { 'gdi32.dll': ['ExtTextOutW', ...] }, delayed: { 'dwrite.dll': [...] } }
 * for a PE file, or null when it isn't one (or can't be read).
 */
async function peImports(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const read = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const dos = await read(0, 64);
    if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const pe = dos.readUInt32LE(0x3c);
    const head = await read(pe, 24 + 240);
    if (head.length < 24 + 96 || head.toString('latin1', 0, 4) !== 'PE\0\0') return null;
    const machine = head.readUInt16LE(4);
    const sectionCount = head.readUInt16LE(6);
    const optionalSize = head.readUInt16LE(20);
    const magic = head.readUInt16LE(24);
    const plus = magic === 0x20b;
    if (!plus && magic !== 0x10b) return null;
    const imageBase = plus ? Number(head.readBigUInt64LE(24 + 24)) : head.readUInt32LE(24 + 28);
    const directories = 24 + (plus ? 112 : 96);
    const directory = (i) => (directories + i * 8 + 8 <= head.length ? head.readUInt32LE(directories + i * 8) : 0);
    const table = await read(pe + 24 + optionalSize, sectionCount * 40);
    const sections = [];
    for (let i = 0; i < sectionCount && (i + 1) * 40 <= table.length; i++) {
      sections.push({
        va: table.readUInt32LE(i * 40 + 12),
        size: Math.max(table.readUInt32LE(i * 40 + 8), table.readUInt32LE(i * 40 + 16)),
        raw: table.readUInt32LE(i * 40 + 20),
        rawSize: table.readUInt32LE(i * 40 + 16),
        data: null,
      });
    }
    // Each section's bytes are read once, when something in it is needed.
    const at = async (rva, length) => {
      const section = sections.find((s) => rva >= s.va && rva < s.va + s.size);
      if (!section || section.rawSize > MAX_SECTION) return null;
      section.data ??= await read(section.raw, section.rawSize);
      const start = rva - section.va;
      return start < section.data.length ? section.data.subarray(start, Math.min(section.data.length, start + length)) : null;
    };
    const text = async (rva) => {
      const bytes = await at(rva, 512);
      if (!bytes) return null;
      const end = bytes.indexOf(0);
      return bytes.toString('latin1', 0, end < 0 ? bytes.length : end);
    };
    const width = plus ? 8 : 4;
    const names = async (rva) => {
      const out = [];
      for (let i = 0; i < MAX_FUNCTIONS; i++) {
        const entry = await at(rva + i * width, width);
        if (!entry || entry.length < width) break;
        const value = plus ? entry.readBigUInt64LE(0) : BigInt(entry.readUInt32LE(0));
        if (value === 0n) break;
        if (value & (plus ? 0x8000000000000000n : 0x80000000n)) continue; // by ordinal
        const name = await text(Number(value & 0x7fffffffn) + 2);
        if (name) out.push(name);
      }
      return out;
    };
    const imports = {};
    const importRva = directory(1);
    for (let i = 0; importRva && i < MAX_DESCRIPTORS; i++) {
      const d = await at(importRva + i * 20, 20);
      if (!d || d.length < 20 || d.readUInt32LE(12) === 0) break;
      const library = (await text(d.readUInt32LE(12)))?.toLowerCase();
      if (library) imports[library] = [...(imports[library] || []), ...(await names(d.readUInt32LE(0) || d.readUInt32LE(16)))];
    }
    const delayed = {};
    const delayRva = directory(13);
    for (let i = 0; delayRva && i < MAX_DESCRIPTORS; i++) {
      const d = await at(delayRva + i * 32, 32);
      if (!d || d.length < 32 || d.readUInt32LE(4) === 0) break;
      // Old-style descriptors hold addresses rather than offsets.
      const base = d.readUInt32LE(0) & 1 ? 0 : imageBase;
      const library = (await text(d.readUInt32LE(4) - base))?.toLowerCase();
      if (library) delayed[library] = [...(delayed[library] || []), ...(await names(d.readUInt32LE(16) - base))];
    }
    return { arch: MACHINES[machine] || null, imports, delayed };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Every function name a module imports, from any library (normal or delay-loaded). */
function importedFunctions(info) {
  if (!info) return new Set();
  return new Set([...Object.values(info.imports), ...Object.values(info.delayed)].flat());
}

/** Every library a module imports. */
function importedLibraries(info) {
  if (!info) return new Set();
  return new Set([...Object.keys(info.imports), ...Object.keys(info.delayed)]);
}

module.exports = { peImports, importedFunctions, importedLibraries, MACHINES };
