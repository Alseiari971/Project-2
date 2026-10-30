"""Unreal Engine localization files (.locres): read their strings, write them back translated.

The layout follows the engine's TextLocalizationResource.cpp:

- an optional 16-byte magic GUID and a version byte (no magic: the legacy format);
- version 1+ (Compact): the offset of a shared string table at the end of the file;
- version 2+ (Optimized): an entry count, and a 32-bit hash before every namespace
  and key (CRC32 in version 2, CityHash64 folded to 32 bits in version 3);
- per namespace: its name and keys; per key: its name, the hash of the source
  (English) text, and the translated text (version 0) or its index in the table.

Translating keeps every hash as it was, including each line's source hash: the
engine uses it to tell whether a translation still matches its English, so it
must stay the English's. Only the text changes.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

MAGIC = struct.pack('<4I', 0x7574140E, 0xFC034A67, 0x9D90154A, 0x1B7F37C3)
LEGACY, COMPACT, OPTIMIZED_CRC32, OPTIMIZED_CITYHASH64 = 0, 1, 2, 3


class LocResError(ValueError):
    pass


@dataclass
class Entry:
    key: str
    text: str
    source_hash: int
    key_hash: int = 0


@dataclass
class Namespace:
    name: str
    entries: list = field(default_factory=list)
    name_hash: int = 0


@dataclass
class LocRes:
    version: int
    namespaces: list = field(default_factory=list)

    def rows(self):
        """(namespace/key, text) for every line."""
        return [(f'{ns.name}/{e.key}', e.text) for ns in self.namespaces for e in ns.entries]

    def translated(self, translations: dict) -> 'LocRes':
        """A copy with each line whose "namespace/key" is in `translations` replaced."""
        return LocRes(self.version, [
            Namespace(ns.name, [Entry(e.key, translations.get(f'{ns.name}/{e.key}', e.text), e.source_hash, e.key_hash)
                                for e in ns.entries], ns.name_hash)
            for ns in self.namespaces])


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.at = 0

    def take(self, n: int) -> bytes:
        if self.at + n > len(self.data):
            raise LocResError('The .locres file ends too soon.')
        chunk = self.data[self.at:self.at + n]
        self.at += n
        return chunk

    def u8(self):
        return self.take(1)[0]

    def u32(self):
        return struct.unpack('<I', self.take(4))[0]

    def i32(self):
        return struct.unpack('<i', self.take(4))[0]

    def i64(self):
        return struct.unpack('<q', self.take(8))[0]

    def string(self) -> str:
        n = self.i32()
        if n == 0:
            return ''
        if n > 0:
            if n > 1 << 24:
                raise LocResError('A string in the .locres file is too long.')
            return self.take(n).decode('latin-1').rstrip('\0')
        if -n > 1 << 24:
            raise LocResError('A string in the .locres file is too long.')
        return self.take(-n * 2).decode('utf-16-le').rstrip('\0')


def read(data: bytes) -> LocRes:
    r = _Reader(data)
    version = LEGACY
    if data[:16] == MAGIC:
        r.at = 16
        version = r.u8()
        if version > OPTIMIZED_CITYHASH64:
            raise LocResError(f'This .locres is version {version}, newer than this tool knows.')

    table = None
    if version >= COMPACT:
        offset = r.i64()
        if offset != -1:
            back = r.at
            r.at = offset
            count = r.i32()
            if count < 0 or count > 1 << 22:
                raise LocResError('The .locres string table is damaged.')
            table = []
            for _ in range(count):
                table.append(r.string())
                if version >= OPTIMIZED_CRC32:
                    r.i32()  # how many keys use it; recounted when writing
            r.at = back
    if version >= OPTIMIZED_CRC32:
        r.u32()  # entry count; recounted when writing

    out = LocRes(version)
    for _ in range(r.u32()):
        name_hash = r.u32() if version >= OPTIMIZED_CRC32 else 0
        namespace = Namespace(r.string(), name_hash=name_hash)
        for _ in range(r.u32()):
            key_hash = r.u32() if version >= OPTIMIZED_CRC32 else 0
            key = r.string()
            source_hash = r.u32()
            if version >= COMPACT:
                index = r.i32()
                if table is None or not 0 <= index < len(table):
                    raise LocResError('A .locres line points outside its string table.')
                text = table[index]
            else:
                text = r.string()
            namespace.entries.append(Entry(key, text, source_hash, key_hash))
        out.namespaces.append(namespace)
    return out


def _string(text: str) -> bytes:
    if not text:
        return struct.pack('<i', 0)
    if all(ord(ch) < 128 for ch in text):
        raw = text.encode('ascii') + b'\0'
        return struct.pack('<i', len(raw)) + raw
    raw = text.encode('utf-16-le') + b'\0\0'
    return struct.pack('<i', -(len(raw) // 2)) + raw


def write(locres: LocRes) -> bytes:
    version = locres.version
    body = bytearray()
    strings: dict = {}
    counts: list = []

    def index_of(text):
        if text not in strings:
            strings[text] = len(strings)
            counts.append(0)
        counts[strings[text]] += 1
        return strings[text]

    total = 0
    body += struct.pack('<I', len(locres.namespaces))
    for ns in locres.namespaces:
        if version >= OPTIMIZED_CRC32:
            body += struct.pack('<I', ns.name_hash)
        body += _string(ns.name)
        body += struct.pack('<I', len(ns.entries))
        for e in ns.entries:
            total += 1
            if version >= OPTIMIZED_CRC32:
                body += struct.pack('<I', e.key_hash)
            body += _string(e.key) + struct.pack('<I', e.source_hash)
            body += struct.pack('<i', index_of(e.text)) if version >= COMPACT else _string(e.text)

    if version == LEGACY:
        return bytes(body)
    head = bytearray(MAGIC) + bytes([version])
    head_size = len(head) + 8 + (4 if version >= OPTIMIZED_CRC32 else 0)
    head += struct.pack('<q', head_size + len(body))
    if version >= OPTIMIZED_CRC32:
        head += struct.pack('<I', total)
    table = bytearray(struct.pack('<i', len(strings)))
    for text, i in strings.items():
        table += _string(text)
        if version >= OPTIMIZED_CRC32:
            table += struct.pack('<i', counts[i])
    return bytes(head + body + table)
