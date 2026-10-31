"""Reading a Godot game's .pck (or the one built into its .exe), for its text.

A .pck is a header, a directory (each file's res:// path, offset and size) and
the files. Godot 3 writes format 1, Godot 4 format 2 (4.4 and later: 3, with
the directory possibly at the end). Packs with an encrypted directory, and
encrypted files, can't be read without the game's key and are refused or skipped.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

MAGIC = b'GDPC'
DIR_ENCRYPTED = 1
FILE_ENCRYPTED = 1
REL_FILEBASE = 2
MAX_FILE = 64 * 1024 * 1024


class PckError(ValueError):
    pass


@dataclass
class PckFile:
    path: str      # res://...
    offset: int    # from the start of the file the pack is in
    size: int
    encrypted: bool


@dataclass
class Pck:
    file: Path
    format: int
    godot: tuple    # (major, minor, patch)
    files: list

    def read(self, entry: PckFile) -> bytes:
        if entry.encrypted:
            raise PckError(f'{entry.path} is encrypted.')
        if entry.size > MAX_FILE:
            raise PckError(f'{entry.path} is too big to read.')
        with open(self.file, 'rb') as f:
            f.seek(entry.offset)
            return f.read(entry.size)


def _start(f, size: int) -> int:
    """Where the pack starts in the file: 0 for a .pck, or near the end of an .exe with one built in."""
    f.seek(0)
    if f.read(4) == MAGIC:
        return 0
    if size < 16:
        raise PckError('No Godot pack here.')
    f.seek(size - 4)
    if f.read(4) != MAGIC:
        raise PckError('No Godot pack here.')
    f.seek(size - 12)
    (length,) = struct.unpack('<Q', f.read(8))
    start = size - 12 - length
    f.seek(start)
    if start < 0 or f.read(4) != MAGIC:
        raise PckError('No Godot pack here.')
    return start


def read_pck(path: Path | str) -> Pck:
    path = Path(path)
    size = path.stat().st_size
    with open(path, 'rb') as f:
        start = _start(f, size)
        f.seek(start + 4)
        fmt, major, minor, patch = struct.unpack('<4I', f.read(16))
        if fmt not in (1, 2, 3):
            raise PckError(f'Godot pack format {fmt} isn\'t one GameShelf can read.')
        flags, file_base, dir_offset = 0, 0, 0
        if fmt >= 2:
            flags, file_base = struct.unpack('<IQ', f.read(12))
            if fmt >= 3:
                (dir_offset,) = struct.unpack('<Q', f.read(8))
        if flags & DIR_ENCRYPTED:
            raise PckError('The game\'s pack is encrypted; it needs the game\'s own key, which GameShelf won\'t look for.')
        f.read(16 * 4)  # reserved
        if dir_offset:
            f.seek(start + dir_offset)
        (count,) = struct.unpack('<I', f.read(4))
        if count > 1_000_000:
            raise PckError('The game\'s pack looks damaged.')
        base = start + file_base if fmt >= 2 else start
        files = []
        for _ in range(count):
            (length,) = struct.unpack('<I', f.read(4))
            name = f.read(length).rstrip(b'\0').decode('utf-8', 'replace')
            offset, file_size = struct.unpack('<QQ', f.read(16))
            f.read(16)  # md5
            file_flags = struct.unpack('<I', f.read(4))[0] if fmt >= 2 else 0
            files.append(PckFile(name, base + offset, file_size, bool(file_flags & FILE_ENCRYPTED)))
    return Pck(path, fmt, (major, minor, patch), files)


def find_pck(folder: Path) -> Path | None:
    """The game's pack: a .pck beside it, or an .exe with one built in."""
    packs = sorted(folder.glob('*.pck'), key=lambda p: -p.stat().st_size)
    if packs:
        return packs[0]
    for exe in sorted(folder.glob('*.exe'), key=lambda p: -p.stat().st_size):
        try:
            with open(exe, 'rb') as f:
                size = exe.stat().st_size
                f.seek(max(0, size - 4))
                if f.read(4) == MAGIC:
                    return exe
        except OSError:
            continue
    return None


# Godot's binary resources (.scn, .res) and tokenized scripts (.gdc) keep text
# as a 32-bit length (the UTF-8 bytes and a closing zero) before the string.
_BINARY_STRING = re.compile(rb'[\x20-\x7e\xc2-\xf4][\x09\x0a\x20-\x7e\x80-\xbf\xc2-\xf4]{2,}\x00')


def binary_strings(data: bytes):
    """The length-prefixed strings in a Godot binary resource."""
    for m in _BINARY_STRING.finditer(data):
        start = m.start()
        if start < 4:
            continue
        (length,) = struct.unpack_from('<I', data, start - 4)
        if length == m.end() - start:
            try:
                yield data[start:m.end() - 1].decode('utf-8')
            except UnicodeDecodeError:
                continue
