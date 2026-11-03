"""FromSoftware games' text (Dark Souls, Bloodborne-era PC ports, Sekiro, Dark
Souls III, Elden Ring, Armored Core VI): .fmg message tables, inside BND4
binders (item.msgbnd, menu.msgbnd), compressed as DCX.

Read and written here in pure Python, from the game's own unpacked files
(msg/engus/*.msgbnd.dcx, as UXM or a mod loader leaves them); nothing is
decrypted: the encrypted .bdt archives these come from are never read.

FMG (the layout SoulsFormats documents):
    0x00  byte 0, byte big-endian, byte version (0 Demon's Souls, 1 Dark Souls,
          2 Dark Souls III and later: 64-bit offsets), byte 0
    0x04  int32 file size; byte 1, byte (0xFF in version 0), 2 bytes 0
    0x0C  int32 group count, int32 string count
          version 2: int32 0xFF, int64 string offsets offset, int64 0
          else:      int32 string offsets offset, int32 0
    groups: int32 first offset index, int32 first id, int32 last id (+ int32 0 in v2)
    string offsets: one per id in the groups (int64 in v2), 0 for an empty slot
    strings: UTF-16 (the file's byte order), zero-terminated

BND4: "BND4", flags, file count, header size 0x40, an 8-byte version, the
file header size, where the data starts, Unicode names, the format byte
(which says which fields the file headers have), and an optional path hash
table (extended = 4). Files inside may be DCX-compressed themselves.

DCX (big-endian): "DCX\\0", "DCS\\0" with the sizes, "DCP\\0" with the format:
DFLT (zlib, all games up to Elden Ring), ZSTD (later), or KRAK (Oodle Kraken,
Sekiro, Elden Ring, AC6), which only the game's own oo2core DLL decompresses:
on Windows it's loaded from the game's folder; GameShelf ships no Oodle.
"""

from __future__ import annotations

import ctypes
import struct
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

try:  # optional: zstandard, for DCX_ZSTD
    import zstandard
except ImportError:  # pragma: no cover
    zstandard = None


class FromSoftError(ValueError):
    pass


# ---- FMG ------------------------------------------------------------------------------------

@dataclass
class Fmg:
    version: int = 2
    big_endian: bool = False
    entries: dict = field(default_factory=dict)  # id -> text or None, in id order when written


def read_fmg(data: bytes) -> Fmg:
    if len(data) < 0x1C or data[0] != 0 or data[3] != 0 or data[2] > 2:
        raise FromSoftError('This isn\'t an FMG message table.')
    big = bool(data[1])
    version = data[2]
    e = '>' if big else '<'
    wide = version == 2
    try:
        groups, strings = struct.unpack_from(e + 'ii', data, 0x0C)
        if wide:
            offsets_at = struct.unpack_from(e + 'q', data, 0x18)[0]
            groups_at = 0x28
        else:
            offsets_at = struct.unpack_from(e + 'i', data, 0x14)[0]
            groups_at = 0x1C
        if groups < 0 or strings < 0 or groups > 1_000_000 or offsets_at > len(data):
            raise FromSoftError('This FMG\'s header is damaged.')
        entries = {}
        group_size = 16 if wide else 12
        for g in range(groups):
            index, first, last = struct.unpack_from(e + 'iii', data, groups_at + g * group_size)
            if last < first or last - first > 1_000_000:
                raise FromSoftError('This FMG has a damaged group.')
            for j in range(last - first + 1):
                at = offsets_at + (index + j) * (8 if wide else 4)
                offset = struct.unpack_from(e + ('q' if wide else 'i'), data, at)[0]
                entries[first + j] = _utf16z(data, offset, big) if offset > 0 else None
    except struct.error:
        raise FromSoftError('This FMG is cut short.') from None
    return Fmg(version, big, entries)


def _utf16z(data: bytes, offset: int, big: bool) -> str:
    end = offset
    while end + 1 < len(data) and (data[end] or data[end + 1]):
        end += 2
    if end + 1 >= len(data):
        raise FromSoftError('An FMG string runs past the end.')
    return data[offset:end].decode('utf-16-be' if big else 'utf-16-le', errors='replace')


def write_fmg(fmg: Fmg) -> bytes:
    e = '>' if fmg.big_endian else '<'
    wide = fmg.version == 2
    ids = sorted(fmg.entries)
    groups = []  # (first index, first id, last id)
    for i, id_ in enumerate(ids):
        if groups and id_ == groups[-1][2] + 1:
            groups[-1][2] = id_
        else:
            groups.append([i, id_, id_])
    out = bytearray()
    out += bytes([0, 1 if fmg.big_endian else 0, fmg.version, 0])
    out += b'\0\0\0\0'  # file size
    out += bytes([1, 0xFF if fmg.version == 0 else 0, 0, 0])
    out += struct.pack(e + 'ii', len(groups), len(ids))
    if wide:
        out += struct.pack(e + 'i', 0xFF)
        offsets_field = len(out)
        out += struct.pack(e + 'qq', 0, 0)
    else:
        offsets_field = len(out)
        out += struct.pack(e + 'ii', 0, 0)
    for index, first, last in groups:
        out += struct.pack(e + 'iii', index, first, last) + (struct.pack(e + 'i', 0) if wide else b'')
    offsets_at = len(out)
    struct.pack_into(e + ('q' if wide else 'i'), out, offsets_field, offsets_at)
    width = 8 if wide else 4
    out += b'\0' * (width * len(ids))
    encoding = 'utf-16-be' if fmg.big_endian else 'utf-16-le'
    for i, id_ in enumerate(ids):
        text = fmg.entries[id_]
        if text is None:
            continue
        struct.pack_into(e + ('q' if wide else 'i'), out, offsets_at + i * width, len(out))
        out += text.encode(encoding) + b'\0\0'
    struct.pack_into(e + 'i', out, 4, len(out))
    return bytes(out)


# ---- DCX ------------------------------------------------------------------------------------

@dataclass
class Dcx:
    kind: str          # DFLT, ZSTD, KRAK
    header: bytes      # the original header, kept (with its level and flags) for writing back
    data: bytes        # uncompressed


def is_dcx(data: bytes) -> bool:
    return data[:4] == b'DCX\0'


def _oodle(near: Path | None):
    """The game's own oo2core DLL (Windows), from its folder or one above it, or None."""
    if sys.platform != 'win32' or near is None:
        return None
    folder = Path(near).resolve().parent
    for _ in range(5):
        found = sorted(folder.glob('oo2core_*_win64.dll'))
        if found:
            try:
                return ctypes.WinDLL(str(found[-1]))
            except OSError:
                return None
        folder = folder.parent
    return None


def read_dcx(data: bytes, near: Path | None = None) -> Dcx:
    if not is_dcx(data) or len(data) < 0x4C or data[0x18:0x1C] != b'DCS\0' or data[0x24:0x28] != b'DCP\0':
        raise FromSoftError('This isn\'t a DCX file GameShelf can read.')
    size, packed = struct.unpack_from('>II', data, 0x1C)
    kind = data[0x28:0x2C].decode('ascii', 'replace')
    if data[0x44:0x48] != b'DCA\0':
        raise FromSoftError('This DCX file\'s header is damaged.')
    start = 0x44 + struct.unpack_from('>I', data, 0x48)[0]
    body = data[start:start + packed]
    if kind == 'DFLT':
        raw = zlib.decompress(body)
    elif kind == 'ZSTD':
        if zstandard is None:
            raise FromSoftError('This game\'s files are ZSTD-compressed: install the zstandard package (pip install zstandard).')
        raw = zstandard.ZstdDecompressor().decompress(body, max_output_size=size)
    elif kind == 'KRAK':
        oodle = _oodle(near)
        if oodle is None:
            raise FromSoftError('This game\'s files are Oodle-compressed (DCX KRAK): GameShelf uses the game\'s own oo2core DLL for '
                                'them, which it found only on Windows, in the game\'s folder.')
        out = ctypes.create_string_buffer(size)
        got = oodle.OodleLZ_Decompress(body, len(body), out, size, 0, 0, 0, None, 0, None, None, None, 0, 3)
        if got != size:
            raise FromSoftError('The game\'s Oodle library couldn\'t decompress this file.')
        raw = out.raw
    else:
        raise FromSoftError(f'GameShelf can\'t read DCX_{kind} files.')
    if len(raw) != size:
        raise FromSoftError('This DCX file decompressed to the wrong size.')
    return Dcx(kind, data[:start], raw)


def write_dcx(dcx: Dcx, data: bytes, near: Path | None = None) -> bytes:
    if dcx.kind == 'DFLT':
        level = dcx.header[0x30] if len(dcx.header) > 0x30 and 1 <= dcx.header[0x30] <= 9 else 9
        body = zlib.compress(data, level)
    elif dcx.kind == 'ZSTD':
        if zstandard is None:
            raise FromSoftError('Writing ZSTD-compressed files needs the zstandard package.')
        body = zstandard.ZstdCompressor(level=15).compress(data)
    elif dcx.kind == 'KRAK':
        oodle = _oodle(near)
        if oodle is None:
            raise FromSoftError('Writing Oodle-compressed files needs the game\'s own oo2core DLL (Windows).')
        out = ctypes.create_string_buffer(len(data) + 65536)
        # OodleLZ_Compress(compressor=Kraken (8), raw, rawLen, comp, level=Optimal2 (6), ...)
        got = oodle.OodleLZ_Compress(8, data, len(data), out, 6, None, None, None, None, 0)
        if got <= 0:
            raise FromSoftError('The game\'s Oodle library couldn\'t compress this file.')
        body = out.raw[:got]
    else:
        raise FromSoftError(f'GameShelf can\'t write DCX_{dcx.kind} files.')
    header = bytearray(dcx.header)
    struct.pack_into('>II', header, 0x1C, len(data), len(body))
    return bytes(header) + body


def new_dcx_header(kind: str = 'DFLT') -> bytes:
    """A DCX header as Dark Souls III and later write it (for tests and new files)."""
    level = {'DFLT': 9, 'KRAK': 6, 'ZSTD': 21}[kind]
    head = bytearray(b'DCX\0' + struct.pack('>IIIII', 0x11000, 0x18, 0x24, 0x44, 0x4C) + b'DCS\0' + b'\0' * 8 + b'DCP\0'
                     + kind.encode() + struct.pack('>I', 0x20) + bytes([level, 0, 0, 0]) + struct.pack('>IIII', 0, 0, 0, 0x00010100)
                     + b'DCA\0' + struct.pack('>I', 8))
    return bytes(head)


# ---- BND4 -----------------------------------------------------------------------------------

F_BIG_ENDIAN, F_IDS, F_NAMES1, F_NAMES2, F_LONG_OFFSETS, F_COMPRESSION = 1, 2, 4, 8, 0x10, 0x20


def _reverse_bits(b: int) -> int:
    return int(f'{b:08b}'[::-1], 2)


@dataclass
class BndFile:
    name: str
    data: bytes
    id: int = -1
    flags_raw: int = 0x40
    raw_size: int | None = None  # uncompressed size, for binders whose files say it


@dataclass
class Bnd4:
    files: list
    header: bytes           # the first 0x40 bytes, kept for writing back
    fmt: int                # the format, bits in reading order
    fmt_raw: int
    unicode: bool
    extended: int
    big_endian: bool
    bit_big_endian: bool


def _bnd_format(raw: int, bit_big_endian: bool) -> int:
    reverse = bit_big_endian or ((raw & 1) and not (raw & 0x80))
    return raw if reverse else _reverse_bits(raw)


def _file_header_size(fmt: int) -> int:
    return (0x10 + (8 if fmt & F_LONG_OFFSETS else 4) + (8 if fmt & F_COMPRESSION else 0)
            + (4 if fmt & F_IDS else 0) + (4 if fmt & (F_NAMES1 | F_NAMES2) else 0) + (8 if fmt == F_NAMES1 else 0))


def read_bnd4(data: bytes) -> Bnd4:
    if data[:4] != b'BND4' or len(data) < 0x40:
        raise FromSoftError('This isn\'t a BND4 binder.')
    big = bool(data[9])
    bit_big = not bool(data[0x0A])
    e = '>' if big else '<'
    count = struct.unpack_from(e + 'i', data, 0x0C)[0]
    header_size, = struct.unpack_from(e + 'q', data, 0x10)
    file_header_size, = struct.unpack_from(e + 'q', data, 0x20)
    unicode = bool(data[0x30])
    fmt_raw = data[0x31]
    fmt = _bnd_format(fmt_raw, bit_big)
    extended = data[0x32]
    if header_size != 0x40 or count < 0 or count > 100_000 or file_header_size != _file_header_size(fmt):
        raise FromSoftError('This BND4 binder\'s header is one GameShelf doesn\'t know.')
    files = []
    at = 0x40
    try:
        for _ in range(count):
            flags_raw = data[at]
            if data[at + 1:at + 4] != b'\0\0\0' or struct.unpack_from(e + 'i', data, at + 4)[0] != -1:
                raise FromSoftError('A BND4 file header is damaged.')
            p = at + 8
            size, = struct.unpack_from(e + 'q', data, p)
            p += 8
            raw_size = None
            if fmt & F_COMPRESSION:
                raw_size, = struct.unpack_from(e + 'q', data, p)
                p += 8
            if fmt & F_LONG_OFFSETS:
                offset, = struct.unpack_from(e + 'q', data, p)
                p += 8
            else:
                offset, = struct.unpack_from(e + 'I', data, p)
                p += 4
            id_ = -1
            if fmt & F_IDS:
                id_, = struct.unpack_from(e + 'i', data, p)
                p += 4
            name = ''
            if fmt & (F_NAMES1 | F_NAMES2):
                name_at, = struct.unpack_from(e + 'i', data, p)
                p += 4
                name = _utf16z(data, name_at, big) if unicode else data[name_at:data.index(b'\0', name_at)].decode('shift_jis', 'replace')
            if fmt == F_NAMES1:
                id_, = struct.unpack_from(e + 'i', data, p)
                p += 8
            if offset + size > len(data):
                raise FromSoftError('A file in this binder points outside it.')
            files.append(BndFile(name, data[offset:offset + size], id_, flags_raw, raw_size))
            at += file_header_size
    except (struct.error, ValueError) as err:
        if isinstance(err, FromSoftError):
            raise
        raise FromSoftError('This BND4 binder is cut short.') from None
    return Bnd4(files, data[:0x40], fmt, fmt_raw, unicode, extended, big, bit_big)


def path_hash(name: str) -> int:
    text = name.lower().replace('\\', '/')
    if not text.startswith('/'):
        text = '/' + text
    value = 0
    for c in text:
        value = (value * 37 + ord(c)) & 0xFFFFFFFF
    return value


def _is_prime(n: int) -> bool:
    if n < 2:
        return False
    return all(n % d for d in range(2, int(n ** 0.5) + 1))


def write_bnd4(bnd: Bnd4, files: list | None = None) -> bytes:
    files = bnd.files if files is None else files
    e = '>' if bnd.big_endian else '<'
    fmt = bnd.fmt
    out = bytearray(bnd.header)
    struct.pack_into(e + 'i', out, 0x0C, len(files))
    names = fmt & (F_NAMES1 | F_NAMES2)
    header_size = _file_header_size(fmt)
    positions = []
    for f in files:
        start = len(out)
        out += bytes([f.flags_raw, 0, 0, 0]) + struct.pack(e + 'i', -1) + struct.pack(e + 'q', 0)
        if fmt & F_COMPRESSION:
            out += struct.pack(e + 'q', 0)
        out += struct.pack(e + ('q' if fmt & F_LONG_OFFSETS else 'I'), 0)
        if fmt & F_IDS:
            out += struct.pack(e + 'i', f.id)
        if names:
            out += struct.pack(e + 'i', 0)
        if fmt == F_NAMES1:
            out += struct.pack(e + 'ii', f.id, 0)
        assert len(out) - start == header_size
        positions.append(start)
    if names:
        for f, start in zip(files, positions):
            name_field = start + header_size - (12 if fmt == F_NAMES1 else 4)
            struct.pack_into(e + 'i', out, name_field, len(out))
            out += (f.name.encode('utf-16-be' if bnd.big_endian else 'utf-16-le') + b'\0\0') if bnd.unicode else f.name.encode('shift_jis') + b'\0'
    if bnd.extended == 4:
        while len(out) % 8:
            out += b'\0'
        struct.pack_into(e + 'q', out, 0x38, len(out))
        groups = next(p for p in range(max(1, len(files) // 7), 100_001) if _is_prime(p))
        buckets = [[] for _ in range(groups)]
        for i, f in enumerate(files):
            h = path_hash(f.name)
            buckets[h % groups].append((h, i))
        hashes, table = [], []
        for bucket in buckets:
            bucket.sort()
            table.append((len(bucket), len(hashes)))
            hashes += bucket
        out += struct.pack(e + 'q', 0)
        pointer = len(out)
        out += struct.pack(e + 'q', 0) + struct.pack(e + 'II', groups, 0x00080810)
        for length, index in table:
            out += struct.pack(e + 'ii', length, index)
        while len(out) % 8:
            out += b'\0'
        struct.pack_into(e + 'q', out, pointer, len(out))
        for h, i in hashes:
            out += struct.pack(e + 'Ii', h, i)
    struct.pack_into(e + 'q', out, 0x28, len(out))
    for f, start in zip(files, positions):
        if f.data:
            while len(out) % 0x10:
                out += b'\0'
        p = start + 8
        struct.pack_into(e + 'q', out, p, len(f.data))
        p += 8
        if fmt & F_COMPRESSION:
            struct.pack_into(e + 'q', out, p, len(f.data) if f.raw_size is None else f.raw_size)
            p += 8
        struct.pack_into(e + ('q' if fmt & F_LONG_OFFSETS else 'I'), out, p, len(out))
        out += f.data
    return bytes(out)


def new_bnd4(files: list, extended: int = 4) -> bytes:
    """A message binder laid out as Dark Souls III and later write them (for tests): names, ids, hash table."""
    fmt = F_IDS | F_NAMES1 | F_NAMES2 | F_COMPRESSION
    head = bytearray(0x40)
    head[0:4] = b'BND4'
    head[0x0A] = 1
    struct.pack_into('<q', head, 0x10, 0x40)
    head[0x18:0x20] = b'07D7R6\0\0'
    struct.pack_into('<q', head, 0x20, _file_header_size(fmt))
    head[0x30] = 1
    head[0x31] = _reverse_bits(fmt)
    head[0x32] = extended
    bnd = Bnd4([], bytes(head), fmt, head[0x31], True, extended, False, False)
    return write_bnd4(bnd, files)


# ---- A game's message files -----------------------------------------------------------------

@dataclass
class MessageFile:
    """One .fmg, a .msgbnd(.dcx) or a .fmg.dcx: its tables {name: Fmg}, and how to write it back."""
    tables: dict
    rebuild: object  # {name: Fmg} -> bytes


def read_messages(data: bytes, near: Path | None = None) -> MessageFile:
    dcx = read_dcx(data, near) if is_dcx(data) else None
    raw = dcx.data if dcx else data
    wrap = (lambda body: write_dcx(dcx, body, near)) if dcx else (lambda body: body)
    if raw[:4] == b'BND4':
        bnd = read_bnd4(raw)
        tables = {}
        for i, f in enumerate(bnd.files):
            inner = read_dcx(f.data, near) if is_dcx(f.data) else None
            body = inner.data if inner else f.data
            if f.name.lower().endswith('.fmg') or (body[:1] == b'\0' and len(body) > 0x1C and body[2] <= 2):
                try:
                    tables[f'{i}:{f.name.replace(chr(92), "/").split("/")[-1]}'] = (read_fmg(body), inner)
                except FromSoftError:
                    continue

        def rebuild(changed):
            files = list(bnd.files)
            for key, fmg in changed.items():
                i = int(key.split(':', 1)[0])
                inner = tables[key][1]
                body = write_fmg(fmg)
                files[i] = BndFile(files[i].name, write_dcx(inner, body, near) if inner else body, files[i].id, files[i].flags_raw, len(body))
            return wrap(write_bnd4(bnd, files))
        return MessageFile({k: v[0] for k, v in tables.items()}, rebuild)
    fmg = read_fmg(raw)
    return MessageFile({'': fmg}, lambda changed: wrap(write_fmg(changed.get('', fmg))))
