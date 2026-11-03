"""LZ4 decompression, block and frame formats, for Bethesda archives: Skyrim
Special Edition's .bsa files (version 105) hold LZ4 frames, Starfield's .ba2
files (version 3) LZ4 blocks. Uses the lz4 package when it's installed, and
the pure-Python decoder here otherwise (fast enough for string tables)."""

from __future__ import annotations

import struct

try:  # pragma: no cover - depends on what's installed
    import lz4.block as _native_block
    import lz4.frame as _native_frame
except ImportError:  # pragma: no cover
    _native_block = _native_frame = None

FRAME_MAGIC = b'\x04\x22\x4d\x18'
WINDOW = 65536


class LZ4Error(ValueError):
    pass


def _length(data, i, value):
    """Reads the extra length bytes that follow a 15 in a token."""
    while True:
        byte = data[i]
        i += 1
        value += byte
        if byte != 255:
            return value, i


def decompress_block(data: bytes, size: int | None = None, prefix: bytes = b'') -> bytes:
    """One LZ4 block. `prefix` is what came before it (linked blocks reach back into it)."""
    if _native_block is not None and not prefix and size is not None:
        try:
            return _native_block.decompress(data, uncompressed_size=size)
        except Exception as err:  # noqa: BLE001
            raise LZ4Error(f'Bad LZ4 block: {err}') from None
    out = bytearray(prefix)
    i, end = 0, len(data)
    try:
        while i < end:
            token = data[i]
            i += 1
            literals = token >> 4
            if literals == 15:
                literals, i = _length(data, i, literals)
            out += data[i:i + literals]
            i += literals
            if i >= end:
                break  # the last sequence has literals only
            offset = data[i] | (data[i + 1] << 8)
            i += 2
            match = token & 15
            if match == 15:
                match, i = _length(data, i, match)
            match += 4
            start = len(out) - offset
            if offset == 0 or start < 0:
                raise LZ4Error('Bad LZ4 block: a match points before the start.')
            if offset >= match:
                out += out[start:start + match]
            else:  # the match overlaps what it writes: the last `offset` bytes, repeated
                pattern = bytes(out[start:])
                out += (pattern * (match // offset + 1))[:match]
    except IndexError:
        raise LZ4Error('Bad LZ4 block: it ends too soon.') from None
    result = bytes(out[len(prefix):])
    if size is not None and len(result) != size:
        raise LZ4Error(f'Bad LZ4 block: {len(result)} bytes instead of {size}.')
    return result


def decompress_frame(data: bytes) -> bytes:
    """An LZ4 frame (magic 04 22 4D 18)."""
    if _native_frame is not None:
        try:
            return _native_frame.decompress(data)
        except Exception as err:  # noqa: BLE001
            raise LZ4Error(f'Bad LZ4 frame: {err}') from None
    if data[:4] != FRAME_MAGIC:
        raise LZ4Error('Not an LZ4 frame.')
    try:
        flags = data[4]
        if flags >> 6 != 1:
            raise LZ4Error('Unknown LZ4 frame version.')
        independent = flags & 0x20
        block_checksum = flags & 0x10
        i = 7 + (8 if flags & 0x08 else 0) + (4 if flags & 0x01 else 0)
        out = bytearray()
        while True:
            (size,) = struct.unpack_from('<I', data, i)
            i += 4
            if size == 0:
                break
            raw = size & 0x80000000
            size &= 0x7FFFFFFF
            block = data[i:i + size]
            if len(block) != size:
                raise LZ4Error('Bad LZ4 frame: it ends too soon.')
            i += size + (4 if block_checksum else 0)
            if raw:
                out += block
            else:
                out += decompress_block(block, None, b'' if independent else bytes(out[-WINDOW:]))
    except (IndexError, struct.error):
        raise LZ4Error('Bad LZ4 frame: it ends too soon.') from None
    return bytes(out)


def literal_block(data: bytes) -> bytes:
    """`data` as a valid LZ4 block with no matches (for tests, and writers that don't compress)."""
    length = len(data)
    if length < 15:
        return bytes([length << 4]) + data
    rest = length - 15
    return bytes([0xF0]) + b'\xff' * (rest // 255) + bytes([rest % 255]) + data


def literal_frame(data: bytes) -> bytes:
    """`data` as an LZ4 frame of uncompressed blocks."""
    out = bytearray(FRAME_MAGIC + bytes([0x60, 0x70, 0x73]))
    for start in range(0, len(data), 4 * 1024 * 1024):
        chunk = data[start:start + 4 * 1024 * 1024]
        out += struct.pack('<I', len(chunk) | 0x80000000) + chunk
    return bytes(out + b'\0\0\0\0')
