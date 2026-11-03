"""Capcom MT Framework games' text (Resident Evil 5 and 6, Resident Evil 0/1 HD,
Revelations 1 and 2, Dragon's Dogma, Devil May Cry 4, Monster Hunter: World):
.gmd message tables, usually inside .arc archives, read and written in pure
Python from the game's own files (nativePC/arc/...), which these games load
as they are; nothing is decrypted.

ARC (little-endian), versions 7 to 9 and 0x10/0x11:
    "ARC\\0", uint16 version, uint16 file count, (4 bytes more in some versions)
    count x 0x50-byte entries: char name[64] (a path without its extension),
        uint32 type hash (the kind of file), uint32 stored size,
        uint32 size and flags (size in the low 29 bits, flags above),
        uint32 offset
    the files' data, each zlib-compressed (or stored as it is)

GMD: "GMD\\0", a version (0x00010201 in the older games, 0x00010302 in
Monster Hunter: World), counts and block sizes, the table's name, the keys'
index, and last the strings: UTF-8, zero-terminated, one after another. The
strings are rewritten in place with the size of their block updated; nothing
before them changes, so every key keeps pointing at its string.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

ARC_MAGIC = b'ARC\0'
GMD_MAGIC = b'GMD\0'
ENTRY = 0x50
SIZE_MASK = 0x1FFFFFFF


class MtError(ValueError):
    pass


# ---- GMD ------------------------------------------------------------------------------------

# Where the string count, the string block's size and the name's length are, by layout.
_GMD_LAYOUTS = ({'strings': 0x18, 'block': 0x20, 'name_len': 0x24, 'name': 0x28},
                {'strings': 0x14, 'block': 0x1C, 'name_len': 0x20, 'name': 0x24})


@dataclass
class Gmd:
    prefix: bytes      # everything before the strings
    layout: dict
    name: str
    strings: list

    def write(self, strings: list | None = None) -> bytes:
        strings = self.strings if strings is None else strings
        if len(strings) != len(self.strings):
            raise MtError('A .gmd keeps its number of strings.')
        block = b''.join(s.encode('utf-8') + b'\0' for s in strings)
        head = bytearray(self.prefix)
        struct.pack_into('<I', head, self.layout['block'], len(block))
        return bytes(head) + block


def read_gmd(data: bytes) -> Gmd:
    if data[:4] != GMD_MAGIC:
        raise MtError('This isn\'t a .gmd message table.')
    for layout in _GMD_LAYOUTS:
        try:
            count, = struct.unpack_from('<I', data, layout['strings'])
            block, = struct.unpack_from('<I', data, layout['block'])
            name_len, = struct.unpack_from('<I', data, layout['name_len'])
        except struct.error:
            continue
        start = len(data) - block
        name_end = layout['name'] + name_len
        if not (0 < name_len < 256 and name_end < len(data) and data[name_end] == 0 and name_end < start <= len(data)):
            continue
        body = data[start:]
        if count and not body.endswith(b'\0'):
            continue
        parts = body.split(b'\0')[:-1] if count else []
        if len(parts) != count:
            continue
        try:
            name = data[layout['name']:name_end].decode('ascii')
        except UnicodeDecodeError:
            continue
        return Gmd(data[:start], layout, name, [p.decode('utf-8', errors='replace') for p in parts])
    raise MtError('This .gmd is laid out in a way GameShelf doesn\'t know.')


# ---- ARC ------------------------------------------------------------------------------------

@dataclass
class ArcEntry:
    name: str
    type_hash: int
    flags: int
    data: bytes          # uncompressed
    compressed: bool


@dataclass
class Arc:
    version: int
    table_at: int
    first_data: int      # where the original's data started (kept, as some games expect it)
    entries: list


def read_arc(data: bytes) -> Arc:
    if data[:4] != ARC_MAGIC or len(data) < 8:
        raise MtError('This isn\'t an MT Framework .arc archive.')
    version, count = struct.unpack_from('<HH', data, 4)
    for table_at in (8, 12):
        if table_at + count * ENTRY > len(data):
            continue
        entries, ok, first = [], True, len(data)
        for i in range(count):
            at = table_at + i * ENTRY
            raw_name = data[at:at + 64].split(b'\0', 1)[0]
            type_hash, stored, size_flags, offset = struct.unpack_from('<IIII', data, at + 64)
            size = size_flags & SIZE_MASK
            if offset < table_at + count * ENTRY or offset + stored > len(data) or not raw_name:
                ok = False
                break
            body = data[offset:offset + stored]
            compressed = stored != size or body[:1] == b'\x78'
            try:
                raw = zlib.decompress(body) if compressed else body
            except zlib.error:
                ok = False
                break
            if len(raw) != size:
                ok = False
                break
            first = min(first, offset)
            entries.append(ArcEntry(raw_name.decode('ascii', 'replace'), type_hash, size_flags & ~SIZE_MASK, raw, compressed))
        if ok:
            return Arc(version, table_at, first if count else table_at, entries)
    raise MtError('This .arc archive\'s table is damaged, or in a version GameShelf doesn\'t know.')


def write_arc(arc: Arc, entries: list | None = None) -> bytes:
    entries = arc.entries if entries is None else entries
    head = bytearray(ARC_MAGIC + struct.pack('<HH', arc.version, len(entries)))
    head += b'\0' * (arc.table_at - len(head))
    table_end = arc.table_at + ENTRY * len(entries)
    start = arc.first_data if arc.first_data >= table_end else (table_end + 15) // 16 * 16
    out = bytearray(head + b'\0' * (start - len(head)))
    stored = []
    for e in entries:
        body = zlib.compress(e.data, 9) if e.compressed else e.data
        stored.append((len(out), body))
        out += body
    for i, (e, (offset, body)) in enumerate(zip(entries, stored)):
        name = e.name.encode('ascii')[:63].ljust(64, b'\0')
        if len(e.data) > SIZE_MASK:
            raise MtError(f'{e.name} is too big for an .arc archive.')
        out[arc.table_at + i * ENTRY:arc.table_at + (i + 1) * ENTRY] = name + struct.pack('<IIII', e.type_hash, len(body), len(e.data) | e.flags, offset)
    return bytes(out)


# ---- A game's message files -----------------------------------------------------------------

@dataclass
class MessageFile:
    tables: dict      # name -> Gmd
    rebuild: object   # {name: [strings]} -> bytes


def read_messages(data: bytes) -> MessageFile:
    """A .gmd, or an .arc's .gmd tables (keyed by their entry number and name)."""
    if data[:4] == GMD_MAGIC:
        gmd = read_gmd(data)
        return MessageFile({'': gmd}, lambda changed: gmd.write(changed.get('')))
    arc = read_arc(data)
    tables = {}
    for i, entry in enumerate(arc.entries):
        if entry.data[:4] == GMD_MAGIC:
            try:
                tables[f'{i}:{entry.name.replace(chr(92), "/")}'] = read_gmd(entry.data)
            except MtError:
                continue

    def rebuild(changed):
        entries = list(arc.entries)
        for key, strings in changed.items():
            i = int(key.split(':', 1)[0])
            old = entries[i]
            entries[i] = ArcEntry(old.name, old.type_hash, old.flags, tables[key].write(strings), old.compressed)
        return write_arc(arc, entries)
    return MessageFile(tables, rebuild)
