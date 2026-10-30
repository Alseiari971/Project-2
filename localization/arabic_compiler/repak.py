"""Capcom RE Engine .pak archives (version 4.0, the "KPKA" format), for the
pack builder to put Arabic message files into a patch .pak.

    header (16 bytes): "KPKA", major 4, minor 0, feature flags 0 (u16),
                       file count (u32), 0 (u32)
    entries (48 bytes each): hash of the lowercase path (u32), of the
                       uppercase path (u32), offset (u64, from the start of
                       the file), stored size (u64), size (u64),
                       attributes (u64: 0 = stored as is), checksum (u64: 0)
    then each file's bytes.

Paths ("natives/stm/...") are hashed as UTF-16LE with MurmurHash3 (x86,
32-bit, seed 0xFFFFFFFF), ASCII letters lowercased for one hash and
uppercased for the other, as the game looks them up. Files are stored without
compression, and the entry table without encryption (feature flags 0).
"""

from __future__ import annotations

import struct

MAGIC = b'KPKA'
HEADER = struct.Struct('<4sBBHII')
ENTRY = struct.Struct('<IIQQQqQ')
SEED = 0xFFFFFFFF


def murmur3_32(data: bytes, seed: int = 0) -> int:
    """MurmurHash3, x86 32-bit."""
    c1, c2 = 0xCC9E2D51, 0x1B873593
    h = seed & 0xFFFFFFFF
    rounded = len(data) - len(data) % 4
    for i in range(0, rounded, 4):
        k = int.from_bytes(data[i:i + 4], 'little')
        k = (k * c1) & 0xFFFFFFFF
        k = ((k << 15) | (k >> 17)) & 0xFFFFFFFF
        k = (k * c2) & 0xFFFFFFFF
        h ^= k
        h = ((h << 13) | (h >> 19)) & 0xFFFFFFFF
        h = (h * 5 + 0xE6546B64) & 0xFFFFFFFF
    k = 0
    tail = data[rounded:]
    if len(tail) >= 3:
        k ^= tail[2] << 16
    if len(tail) >= 2:
        k ^= tail[1] << 8
    if tail:
        k ^= tail[0]
        k = (k * c1) & 0xFFFFFFFF
        k = ((k << 15) | (k >> 17)) & 0xFFFFFFFF
        k = (k * c2) & 0xFFFFFFFF
        h ^= k
    h ^= len(data)
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    h ^= h >> 16
    return h


def _ascii_case(text: str, upper: bool) -> str:
    # Only ASCII letters change case, as in the game.
    return ''.join(chr(ord(c) - 32) if upper and 'a' <= c <= 'z' else chr(ord(c) + 32) if not upper and 'A' <= c <= 'Z' else c
                   for c in text)


def path_hashes(path: str) -> tuple[int, int]:
    """(lowercase hash, uppercase hash) of a path inside a pak, e.g. natives/stm/message/x.msg.22."""
    path = path.replace('\\', '/')
    return (murmur3_32(_ascii_case(path, False).encode('utf-16-le'), SEED),
            murmur3_32(_ascii_case(path, True).encode('utf-16-le'), SEED))


class PakError(ValueError):
    pass


def write_pak(files: list[tuple[str, bytes]]) -> bytes:
    """A version 4.0 pak holding `files` ([(path inside the pak, bytes)])."""
    seen = set()
    entries, offset = [], HEADER.size + ENTRY.size * len(files)
    for path, data in files:
        hashes = path_hashes(path)
        if hashes in seen:
            raise PakError(f'{path} is in the pak twice.')
        seen.add(hashes)
        entries.append(ENTRY.pack(hashes[0], hashes[1], offset, len(data), len(data), 0, 0))
        offset += len(data)
    return b''.join([HEADER.pack(MAGIC, 4, 0, 0, len(files), 0), *entries, *(data for _, data in files)])


def read_pak(blob: bytes) -> dict[tuple[int, int], bytes]:
    """{(lowercase hash, uppercase hash): bytes} for an unencrypted, uncompressed pak."""
    if len(blob) < HEADER.size:
        raise PakError('Too short to be a pak.')
    magic, major, minor, feature, count, _ = HEADER.unpack_from(blob)
    if magic != MAGIC or major != 4:
        raise PakError('Not an RE Engine version 4 pak.')
    if feature:
        raise PakError(f'This pak uses features (flags {feature:#x}) this reader doesn\'t.')
    out = {}
    for i in range(count):
        lower, upper, offset, stored, size, attributes, _ = ENTRY.unpack_from(blob, HEADER.size + i * ENTRY.size)
        if attributes or stored != size or offset + size > len(blob):
            raise PakError(f'Entry {i} is compressed, encrypted or out of bounds.')
        out[(lower, upper)] = blob[offset:offset + size]
    return out
