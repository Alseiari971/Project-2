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

The game's own paks are read too, to take the message files out of them:
entries stored as they are, or compressed with deflate or (with the zstandard
package, or Python 3.14) zstd. Paks whose entry table is encrypted, and
encrypted entries, are refused: that needs the game's key, which this won't
look for.
"""

from __future__ import annotations

import struct
import zlib

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


def write_pak(files: list[tuple[str | tuple[int, int], bytes]]) -> bytes:
    """A version 4.0 pak holding `files` ([(path inside the pak, or its two hashes, bytes)])."""
    seen = set()
    entries, offset = [], HEADER.size + ENTRY.size * len(files)
    for path, data in files:
        hashes = path if isinstance(path, tuple) else path_hashes(path)
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


# Feature flags that change how a pak is laid out or read.
ENTRY_ENCRYPTION = 0x08
CHUNK_TABLE = 0x20
COMPRESSION_MASK = 0x0F
ENTRY_ENCRYPTION_MASK = 0xFF0000


def _zstd_streams():
    """Makes zstd decompressors that take a frame in pieces (each call returns what it can), or None."""
    try:
        from compression import zstd  # Python 3.14
        return lambda: zstd.ZstdDecompressor().decompress
    except ImportError:
        pass
    try:
        import zstandard
    except ImportError:
        return None
    return lambda: zstandard.ZstdDecompressor().decompressobj().decompress


class GamePak:
    """A game's own .pak, opened for reading entries by their hashes."""

    def __init__(self, path, zstd=None):
        self.path = path
        self.file = open(path, 'rb')
        try:
            self._read_table()
        except BaseException:
            self.file.close()
            raise
        self.zstd = zstd if zstd is not None else _zstd_streams()

    def _read_table(self):
        path = self.path
        head = self.file.read(HEADER.size)
        if len(head) < HEADER.size:
            raise PakError(f'{path} is too short to be a pak.')
        magic, major, minor, feature, count, _ = HEADER.unpack(head)
        if magic != MAGIC:
            raise PakError(f'{path} isn\'t an RE Engine pak.')
        if major != 4:
            raise PakError(f'{path} is a version {major}.{minor} pak, which this can\'t read.')
        if feature & ENTRY_ENCRYPTION:
            raise PakError(f'{path} has an encrypted file table. Reading it needs the game\'s key, which this won\'t look for.')
        table = self.file.read(ENTRY.size * count)
        if len(table) < ENTRY.size * count:
            raise PakError(f'{path} is cut short.')
        self.chunked = bool(feature & CHUNK_TABLE)
        self.entries = {}
        for i in range(count):
            lower, upper, offset, stored, size, attributes, _ = ENTRY.unpack_from(table, i * ENTRY.size)
            self.entries[(lower, upper)] = (offset, stored, size, attributes)

    def close(self):
        self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def read(self, hashes, limit=None) -> bytes:
        """An entry's bytes, or just its first `limit` bytes (reading only the start of the file)."""
        offset, stored, size, attributes = self.entries[hashes]
        if attributes & ENTRY_ENCRYPTION_MASK or (self.chunked and attributes & (1 << 24)):
            raise PakError('That file is encrypted or split into chunks.')
        compression = attributes & COMPRESSION_MASK
        self.file.seek(offset)
        # The first 4 KB of a compressed file is plenty to decompress its first few bytes.
        data = self.file.read(min(stored, limit if compression == 0 else 4096) if limit else stored)
        if compression == 0:
            return data
        if compression == 1:
            out = zlib.decompressobj(-15)
            return out.decompress(data, limit) if limit else out.decompress(data) + out.flush()
        if compression == 2:
            if not self.zstd:
                raise PakError('This game compresses files with zstd: run  pip install zstandard  and try again.')
            out = self.zstd()(data)
            return out[:limit] if limit else out
        raise PakError(f'Unknown compression {compression}.')
