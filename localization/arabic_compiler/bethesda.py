"""Bethesda Creation Engine games: Skyrim Special Edition (and Anniversary
Edition, and VR), Fallout 4 (and VR) and Starfield. Their text is in string
tables, <plugin>_<language>.strings, .dlstrings and .ilstrings, loose in
Data/Strings or inside the game's .bsa and .ba2 archives:

- every table starts with how many strings it has and the size of their data,
  then a directory of (string ID, offset into the data);
- in .strings each string ends with a zero byte; in .dlstrings (descriptions,
  books) and .ilstrings (dialogue) each also starts with its length.

The game loads loose files over its archives, so the Arabic goes into copies
of the English tables in Data/Strings, which GameShelf adds and takes out
again (keeping any loose table that was there before). The game's interface
(Scaleform) can't join Arabic letters or lay them out right to left, so the
Arabic goes in shaped and in screen order (rtl.py). Its fonts have no Arabic
either: Data/Interface/fontconfig.txt, the game's own with one more font
library, points the game's text fonts at IBM Plex Sans Arabic, which
swffont.py puts into Data/Interface/gameshelf_arabic.swf. Rune and symbol
fonts (dragon script, controller buttons) stay as they are.

Archives read here: .bsa version 104 (zlib) and 105 (Skyrim Special Edition,
LZ4), and general .ba2 archives version 1, 7 and 8 (Fallout 4, zlib) and 2
and 3 (Starfield, zlib or LZ4). These games don't encrypt their archives.
"""

from __future__ import annotations

import re
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from .lz4codec import LZ4Error, decompress_block, decompress_frame

# skyrim_english.strings, Fallout4_en.DLSTRINGS, starfield_en.ilstrings
TABLE_NAME = re.compile(r'^(?P<plugin>.+)_(?P<language>[a-z]+)\.(?P<kind>strings|dlstrings|ilstrings)$', re.I)
ENGLISH = ('english', 'en')
FONT_NAME = 'GameShelf Arabic'
FONT_LIBRARY = 'Interface\\gameshelf_arabic.swf'
# Font aliases that aren't for reading: runes, scripts, symbols and controller buttons keep their fonts.
KEEP_FONT = re.compile(r'dragon|daedric|dwemer|falmer|mage ?script|symbol|unreadable|button|controller|icon|glyph|rune|wingding|keyboard|gamepad', re.I)
_MAP_LINE = re.compile(r'^(?P<lead>\s*map\s+)"(?P<alias>[^"]+)"(?P<eq>\s*=\s*)"(?P<font>[^"]+)"(?P<rest>.*)$', re.I)
_FONTLIB_LINE = re.compile(r'^\s*fontlib\s+"(?P<lib>[^"]+)"', re.I)


class BethesdaError(ValueError):
    pass


# ---- String tables ----------------------------------------------------------

def decode(raw: bytes) -> str:
    """Newer games write UTF-8; older tables (and some mods) Windows-1252."""
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('cp1252', errors='replace')


def table_kind(name: str) -> str:
    match = TABLE_NAME.match(Path(name).name)
    if not match:
        raise BethesdaError(f'{name} isn\'t a .strings, .dlstrings or .ilstrings file.')
    return match.group('kind').lower()


def read_table(data: bytes, kind: str) -> list:
    """[(string ID, text)] in the table's own order."""
    try:
        count, size = struct.unpack_from('<II', data, 0)
        start = 8 + count * 8
        if start + size > len(data):
            raise BethesdaError('The string table is shorter than its header says.')
        blob = data[start:start + size]
        entries = []
        for n in range(count):
            string_id, offset = struct.unpack_from('<II', data, 8 + n * 8)
            if offset >= size:
                raise BethesdaError(f'String {string_id} points past the end of the table.')
            if kind == 'strings':
                end = blob.find(b'\0', offset)
                raw = blob[offset:end if end >= 0 else size]
            else:
                (length,) = struct.unpack_from('<I', blob, offset)
                raw = blob[offset + 4:offset + 4 + length]
                if raw.endswith(b'\0'):
                    raw = raw[:-1]
            entries.append((string_id, decode(raw)))
        return entries
    except struct.error:
        raise BethesdaError('The string table ends too soon.') from None


def write_table(entries: list, kind: str) -> bytes:
    """A string table of [(string ID, text)], in UTF-8 (what the game reads Arabic in)."""
    directory = bytearray()
    blob = bytearray()
    for string_id, text in entries:
        directory += struct.pack('<II', string_id, len(blob))
        raw = text.encode('utf-8') + b'\0'
        if kind != 'strings':
            blob += struct.pack('<I', len(raw))
        blob += raw
    return struct.pack('<II', len(entries), len(blob)) + bytes(directory) + bytes(blob)


# ---- Archives -----------------------------------------------------------------

@dataclass
class _Entry:
    offset: int
    size: int
    compressed: bool
    unpacked: int = 0


@dataclass
class Archive:
    """A .bsa or general .ba2 archive: its file names (lower case, with /) and how to read each."""
    path: Path
    kind: str
    version: int
    entries: dict = field(default_factory=dict)
    embedded_names: bool = False
    lz4_blocks: bool = False

    def names(self) -> list:
        return list(self.entries)

    def read(self, name: str) -> bytes:
        entry = self.entries[name.lower().replace('\\', '/')]
        with self.path.open('rb') as f:
            f.seek(entry.offset)
            data = f.read(entry.size)
        try:
            if self.kind == 'bsa':
                if self.embedded_names:
                    data = data[1 + data[0]:]
                if not entry.compressed:
                    return data
                (unpacked,) = struct.unpack_from('<I', data, 0)
                body = data[4:]
                result = decompress_frame(body) if self.version >= 105 else zlib.decompress(body)
                if len(result) != unpacked:
                    raise BethesdaError(f'{name} in {self.path.name} unpacked to the wrong size.')
                return result
            if not entry.compressed:
                return data
            if self.lz4_blocks:
                return decompress_block(data, entry.unpacked)
            return zlib.decompress(data)
        except (zlib.error, LZ4Error, struct.error) as err:
            raise BethesdaError(f'Couldn\'t unpack {name} from {self.path.name}: {err}') from None


def _bstring(f) -> bytes:
    length = f.read(1)
    return f.read(length[0]) if length else b''


def read_bsa(path: Path) -> Archive:
    with path.open('rb') as f:
        head = f.read(36)
        if len(head) < 36 or head[:4] != b'BSA\0':
            raise BethesdaError(f'{path.name} isn\'t a .bsa archive.')
        version, _, flags, folders, files, _, names_length, _, _ = struct.unpack('<IIIIIIIHH', head[4:])
        if version not in (104, 105):
            raise BethesdaError(f'{path.name} is a version {version} .bsa, which GameShelf doesn\'t read.')
        record = 24 if version == 105 else 16
        counts = []
        for _ in range(folders):
            raw = f.read(record)
            counts.append(struct.unpack_from('<I', raw, 8)[0])
        listing = []
        for count in counts:
            folder = _bstring(f).rstrip(b'\0').decode('cp1252') if flags & 0x1 else ''
            for _ in range(count):
                _, size, offset = struct.unpack('<QII', f.read(16))
                listing.append((folder, size, offset))
        names = f.read(names_length).split(b'\0') if flags & 0x2 else []
    if len(names) < len(listing):
        raise BethesdaError(f'{path.name} has no file names, so GameShelf can\'t find its string tables.')
    archive = Archive(path, 'bsa', version, embedded_names=bool(flags & 0x100))
    default_compressed = bool(flags & 0x4)
    for (folder, size, offset), name in zip(listing, names):
        full = f'{folder}/{name.decode("cp1252")}' if folder else name.decode('cp1252')
        archive.entries[full.lower().replace('\\', '/')] = _Entry(offset, size & 0x3FFFFFFF, default_compressed != bool(size & 0x40000000))
    return archive


def read_ba2(path: Path) -> Archive:
    with path.open('rb') as f:
        head = f.read(24)
        if len(head) < 24 or head[:4] != b'BTDX':
            raise BethesdaError(f'{path.name} isn\'t a .ba2 archive.')
        version, kind, count, names_at = struct.unpack('<I4sIQ', head[4:])
        if kind != b'GNRL':
            return Archive(path, 'ba2', version)  # textures: no text in there
        if version not in (1, 2, 3, 7, 8):
            raise BethesdaError(f'{path.name} is a version {version} .ba2, which GameShelf doesn\'t read.')
        lz4_blocks = False
        if version in (2, 3):
            f.read(8)
            if version == 3:
                lz4_blocks = struct.unpack('<I', f.read(4))[0] == 3
        records = [struct.unpack('<I4sIIQIII', f.read(36)) for _ in range(count)]
        f.seek(names_at)
        archive = Archive(path, 'ba2', version, lz4_blocks=lz4_blocks)
        for record in records:
            length = struct.unpack('<H', f.read(2))[0]
            name = f.read(length).decode('utf-8', errors='replace')
            _, _, _, _, offset, packed, unpacked, _ = record
            archive.entries[name.lower().replace('\\', '/')] = _Entry(offset, packed or unpacked, bool(packed), unpacked)
    return archive


def read_archive(path: Path) -> Archive:
    return read_bsa(path) if path.suffix.lower() == '.bsa' else read_ba2(path)


# ---- A game's text ------------------------------------------------------------

def data_folder(game: Path) -> Path | None:
    for entry in (game.iterdir() if game.is_dir() else []):
        if entry.is_dir() and entry.name.lower() == 'data':
            return entry
    return None


def _child(folder: Path, name: str) -> Path | None:
    for entry in (folder.iterdir() if folder and folder.is_dir() else []):
        if entry.name.lower() == name.lower():
            return entry
    return None


def is_game(game: Path) -> bool:
    data = data_folder(game)
    if not data:
        return False
    names = [p.name.lower() for p in data.iterdir()]
    return any(n.endswith('.esm') for n in names) and (
        'strings' in names or any(n.endswith(('.bsa', '.ba2')) for n in names))


@dataclass
class Tables:
    """The English string tables of a game: name -> (kind, [(ID, text)]), where each came from, and its fontconfig.txt."""
    tables: dict
    origins: dict
    fontconfig: str | None
    fontconfig_from: str | None


def _archives(data: Path) -> list:
    return sorted((p for p in data.iterdir() if p.is_file() and p.suffix.lower() in ('.bsa', '.ba2')), key=lambda p: p.name.lower())


def read_game(game: Path, log=print) -> Tables:
    """Finds the English string tables (loose ones first, then inside the archives) and the game's fontconfig.txt."""
    data = data_folder(game)
    if not data:
        raise BethesdaError(f'{game} has no Data folder.')
    tables, origins = {}, {}
    strings = _child(data, 'Strings')
    if strings and strings.is_dir():
        for path in sorted(strings.iterdir()):
            match = TABLE_NAME.match(path.name)
            if path.is_file() and match and match.group('language').lower() in ENGLISH:
                tables[path.name.lower()] = (path.name, match.group('kind').lower(), read_table(path.read_bytes(), match.group('kind').lower()))
                origins[path.name.lower()] = f'Data/Strings/{path.name}'
    interface = _child(data, 'Interface')
    loose_config = _child(interface, 'fontconfig.txt') if interface else None
    fontconfig = decode(loose_config.read_bytes()) if loose_config and loose_config.is_file() else None
    fontconfig_from = 'Data/Interface/fontconfig.txt' if fontconfig is not None else None
    for path in _archives(data):
        try:
            archive = read_archive(path)
        except (OSError, BethesdaError) as err:
            log(f'Skipped {path.name}: {err}')
            continue
        for name in archive.names():
            if name.startswith('strings/'):
                match = TABLE_NAME.match(name.rsplit('/', 1)[1])
                key = name.rsplit('/', 1)[1]
                if match and match.group('language').lower() in ENGLISH and key not in tables:
                    kind = match.group('kind').lower()
                    tables[key] = (key, kind, read_table(archive.read(name), kind))
                    origins[key] = f'{path.name}:{name}'
            elif name == 'interface/fontconfig.txt' and fontconfig is None:
                fontconfig = decode(archive.read(name))
                fontconfig_from = f'{path.name}:{name}'
    if not tables:
        raise BethesdaError('Found no English string tables (Data/Strings, or strings/ in the game\'s archives). '
                            'Is the game set to English?')
    return Tables({key: (kind, entries) for key, (_, kind, entries) in tables.items()},
                  {key: (name, origins[key]) for key, (name, _, _) in tables.items()}, fontconfig, fontconfig_from)


# ---- Fonts --------------------------------------------------------------------

def rewrite_fontconfig(text: str, font: str = FONT_NAME, library: str = FONT_LIBRARY) -> str:
    """The game's fontconfig.txt with GameShelf's font library added and its text fonts pointed at `font`."""
    newline = '\r\n' if '\r\n' in text else '\n'
    lines = text.splitlines()
    out, last_lib = [], -1
    has_ours = any((m := _FONTLIB_LINE.match(line)) and m.group('lib').lower() == library.lower() for line in lines)
    for line in lines:
        match = _MAP_LINE.match(line)
        if match and not KEEP_FONT.search(match.group('alias')) and not KEEP_FONT.search(match.group('font')):
            line = f'{match.group("lead")}"{match.group("alias")}"{match.group("eq")}"{font}"{match.group("rest")}'
        out.append(line)
        if _FONTLIB_LINE.match(line):
            last_lib = len(out) - 1
    if not has_ours:
        out.insert(last_lib + 1, f'fontlib "{library}"')
    return newline.join(out) + newline


def fonts_mapped(text: str) -> list:
    """The aliases rewrite_fontconfig points at GameShelf's font (for the build's log)."""
    found = []
    for line in text.splitlines():
        match = _MAP_LINE.match(line)
        if match and not KEEP_FONT.search(match.group('alias')) and not KEEP_FONT.search(match.group('font')):
            found.append(match.group('alias'))
    return found
