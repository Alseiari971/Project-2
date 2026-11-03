"""Rockstar RAGE string tables (.gxt2: Grand Theft Auto V, Red Dead
Redemption 2, Max Payne 3), read and written in pure Python, from unpacked
files or a mod loader's folder. The .rpf archives they ship in are never read
(those are encrypted).

Layout (little-endian):
    "2TXG"                      magic ("GXT2" read as a number)
    uint32 count
    count x (uint32 hash, uint32 offset)   sorted by hash; hash = joaat(key)
    "2TXG"
    uint32 end                  the file's size
    strings: UTF-8, zero-terminated, at their offsets

Only the keys' hashes are in the file; joaat() gives a key's hash, for a
recipe or a mod that names its keys.
"""

from __future__ import annotations

import struct

MAGIC = b'2TXG'


class RageError(ValueError):
    pass


def joaat(key: str) -> int:
    """Jenkins one-at-a-time, as RAGE hashes names: over the lowercased key."""
    h = 0
    for byte in key.lower().encode('utf-8'):
        h = (h + byte) & 0xFFFFFFFF
        h = (h + (h << 10)) & 0xFFFFFFFF
        h ^= h >> 6
    h = (h + (h << 3)) & 0xFFFFFFFF
    h ^= h >> 11
    return (h + (h << 15)) & 0xFFFFFFFF


def read_gxt2(data: bytes) -> dict:
    """{hash: text}, in the file's order."""
    if data[:4] != MAGIC or len(data) < 16:
        raise RageError('This isn\'t a .gxt2 string table.')
    count, = struct.unpack_from('<I', data, 4)
    table_end = 8 + 8 * count
    if count > 2_000_000 or table_end + 8 > len(data) or data[table_end:table_end + 4] != MAGIC:
        raise RageError('This .gxt2 file\'s table is damaged.')
    out = {}
    for i in range(count):
        h, offset = struct.unpack_from('<II', data, 8 + 8 * i)
        end = data.find(b'\0', offset)
        if offset < table_end + 8 or end < 0:
            raise RageError('A string in this .gxt2 file points outside it.')
        out[h] = data[offset:end].decode('utf-8', errors='replace')
    return out


def write_gxt2(strings: dict) -> bytes:
    items = sorted(strings.items())
    table_end = 8 + 8 * len(items)
    at = table_end + 8
    table, blob = bytearray(), bytearray()
    for h, text in items:
        table += struct.pack('<II', h & 0xFFFFFFFF, at + len(blob))
        blob += text.encode('utf-8') + b'\0'
    return MAGIC + struct.pack('<I', len(items)) + bytes(table) + MAGIC + struct.pack('<I', at + len(blob)) + bytes(blob)
