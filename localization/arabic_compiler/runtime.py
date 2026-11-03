"""The native runtime adapter's side of the pack builder: for single-player
games made with their own engines whose archives no tool can repack, but whose
UI text goes through Windows' own text APIs (GDI, DirectWrite). The adapter
(localization/runtime/, a stand-in version.dll or dinput8.dll the game loads
from its own folder) swaps each English string for its Arabic right before
Windows lays it out, so the game's own UI draws the Arabic. Nothing on disk
is unpacked, decrypted or changed.

This module:

- reads English the game ships in readable form, without unpacking anything:
  runs of UTF-8 and UTF-16 text in its .bin/.dat/.lang/.wad/.loc/.str files,
  kept only when they read like dialogue or UI text (words with vowels, not
  paths, code or identifiers). Files that look compressed or encrypted (their
  bytes are close to random) are skipped, never opened up;
- reads the strings the adapter saw in the game but had no Arabic for
  (untranslated.txt, one per line), so playing the game fills in the rest;
- writes gameshelf_strings.bin: FNV-1a 64 of each English string (normalized:
  whitespace runs as one space, none at the ends, in UTF-8) to its Arabic, in
  UTF-16, sorted by hash (see localization/runtime/gs_core.h). The Arabic is
  plain, in reading order: GDI and DirectWrite join the letters and lay them
  out right to left themselves (pre-shaped text would come out reversed).
"""

from __future__ import annotations

import math
import os
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = b'GSAR'
VERSION = 2
LENGTH_FILTER = 1   # flags: the length filter follows the header (gs_core.h)
MAX_UTF8 = 4096
ENTRIES_AT = 16 + 520  # where a version 2 table's entries start, after its length filter
SCAN_EXTENSIONS = {'.bin', '.dat', '.lang', '.wad', '.loc', '.str', '.locale', '.txt'}
SKIP_DIRS = {'_commonredist', 'redist', 'directx', 'vcredist', '.git', 'crashreporter', 'easyanticheat', 'battleye',
             'gameshelf_arabic', 'saves', 'logs', 'shadercache', 'mono', 'monobleedingedge'}
MAX_FILE = 512 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024
MAX_STRINGS = 100_000
RANDOM_LOOKING = 7.5  # bits of entropy per byte, above which a file is taken as compressed or encrypted
CHUNK = 16 * 1024 * 1024
# Text in files: printable ASCII and UTF-8 letters; or UTF-16LE of the same.
_UTF8_RUN = re.compile(rb'(?:[\x20-\x7e\t]|[\xc2-\xdf][\x80-\xbf]|[\xe0-\xef][\x80-\xbf]{2}){6,600}')
_UTF16_RUN = re.compile(rb'(?:[\x20-\x7e\t]\x00|[\xa0-\xff]\x00|[\x00-\xff][\x01-\x05]){6,600}')
_WORD = re.compile(r"[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’\-]*")
_VOWELS = re.compile(r'[aeiouyAEIOUYÀ-ÿ]')
_CODE = re.compile(r'[\\/]|::|->|==|!=|&&|\|\||\(\)|(?i:\b(?:null|void|return|function)\b)'
                   r'|(?i:\.(?:dds|png|tga|wav|ogg|wem|fbx|mesh|mat|bin|dat|lua|xml|json|exe|dll)\b)'
                   r'|^[\w.]+\(|[{};]\s*$|^\s*[#@$<]|_[A-Za-z]|[A-Za-z]_|[a-z][A-Z][a-z]|\b[A-Z]{2,}_|\b\w+\.\w+\.\w+')
_SHAPED = re.compile('[ﭐ-﷿ﹰ-ﻼ]')
UI_WORDS = {
    'Continue', 'Options', 'Settings', 'Quit', 'Exit', 'Start', 'Load', 'Save', 'Resume', 'Back', 'Yes', 'No', 'Cancel',
    'Apply', 'Audio', 'Video', 'Graphics', 'Controls', 'Language', 'Credits', 'Difficulty', 'Easy', 'Normal', 'Hard',
    'Inventory', 'Map', 'Quests', 'Journal', 'Skills', 'Equipment', 'Items', 'Accept', 'Decline', 'Confirm', 'Pause',
    'Restart', 'Retry', 'Loading', 'Paused', 'Victory', 'Defeat', 'Health', 'Level', 'Gold', 'Close', 'Next', 'Previous',
}


class TableError(ValueError):
    pass


def normalize(text: str) -> str:
    """As the adapter normalizes what the game draws: whitespace runs as one space, none at the ends."""
    return re.sub(r'[ \t\r\n\v\f]+', ' ', text).strip(' ')


def fnv1a64(data: bytes) -> int:
    value = 0xcbf29ce484222325
    for byte in data:
        value = ((value ^ byte) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return value


def key_of(english: str) -> int:
    return fnv1a64(normalize(english).encode('utf-8', 'replace'))


def write_table(pairs) -> bytes:
    """gameshelf_strings.bin from (English, Arabic) pairs; the first Arabic wins for an English line given twice."""
    entries = {}
    lengths = set()
    for english, arabic in pairs:
        if not english or not arabic or not normalize(english):
            continue
        entries.setdefault(key_of(english), arabic)
        lengths.add(len(normalize(english).encode('utf-8', 'replace')))
    blob = bytearray()
    table = []
    for hash_, arabic in sorted(entries.items()):
        units = arabic.encode('utf-16-le')
        table.append(struct.pack('<QII', hash_, len(blob) // 2, len(units) // 2))
        blob += units
    # The length filter: which lengths (bytes of normalized UTF-8) English lines have, so the adapter can pass
    # over the many strings a game converts and copies without hashing them.
    bitmap = bytearray(512)
    for n in lengths:
        if n < MAX_UTF8:
            bitmap[n >> 3] |= 1 << (n & 7)
    short = min((n for n in lengths if n < MAX_UTF8), default=0)
    long_ = max((n for n in lengths if n < MAX_UTF8), default=0)
    head = MAGIC + struct.pack('<HHII', VERSION, LENGTH_FILTER, len(table), len(blob) // 2)
    return head + struct.pack('<HHI', short, long_, 0) + bytes(bitmap) + b''.join(table) + bytes(blob)


def read_table(data: bytes) -> dict:
    """{hash: Arabic} from gameshelf_strings.bin (for checks and tests)."""
    if data[:4] != MAGIC:
        raise TableError('Not a GameShelf string table.')
    version, flags, count, units = struct.unpack_from('<HHII', data, 4)
    head = 16 + (520 if version >= 2 and flags & LENGTH_FILTER else 0)
    if version not in (1, 2) or head + count * 16 + units * 2 > len(data):
        raise TableError('The string table is damaged.')
    blob = data[head + count * 16:head + count * 16 + units * 2]
    out = {}
    for i in range(count):
        hash_, offset, length = struct.unpack_from('<QII', data, head + i * 16)
        out[hash_] = blob[offset * 2:(offset + length) * 2].decode('utf-16-le')
    return out


def lookup(table: dict, drawn: str) -> str | None:
    return table.get(key_of(drawn))


# ---- What the game ships in readable form -------------------------------------------

def entropy(sample: bytes) -> float:
    if not sample:
        return 0.0
    counts = [0] * 256
    for byte in sample:
        counts[byte] += 1
    total = len(sample)
    return -sum(c / total * math.log2(c / total) for c in counts if c)


def looks_random(path: Path) -> bool:
    """Whether a file's bytes look compressed or encrypted throughout (a few samples, all near-random)."""
    size = path.stat().st_size
    if size < 4096:
        return False
    samples = []
    with path.open('rb') as f:
        for at in (0, size // 3, 2 * size // 3, max(0, size - 65536)):
            f.seek(at)
            samples.append(f.read(65536))
    return all(entropy(s) > RANDOM_LOOKING for s in samples if len(s) >= 4096)


def reads_like_text(text: str) -> bool:
    """A string a player reads: dialogue, a sentence, or a menu label; not a path, code, an identifier or noise."""
    text = text.strip()
    if not 2 <= len(text) <= 500 or _SHAPED.search(text):
        return False
    if text in UI_WORDS:
        return True
    words = _WORD.findall(text)
    if len(words) < 2 or _CODE.search(text) or re.match(r'[A-Z][A-Z][a-z]', words[0]):  # "AThe": a stray byte in front
        return False
    letters = sum(c.isalpha() for c in text)
    if letters < 0.6 * len(text.replace(' ', '')):
        return False
    long_words = [w for w in words if len(w) >= 3]
    if not long_words or sum(1 for w in long_words if _VOWELS.search(w)) < 0.9 * len(long_words):
        return False
    if re.search(r'(.)\1{3,}', text) or max(len(w) for w in words) > 24:
        return False
    # Natural text: mostly lower case words after the first, starting with a capital, a quote, a digit or punctuation.
    lower = sum(1 for w in words[1:] if w[0].islower())
    return (text[0].isupper() or text[0] in '"\'“‘¿¡([0123456789-—…') and lower >= 0.4 * (len(words) - 1)


def _readable(raw: str) -> str | None:
    """The string as text a player reads, without up to two stray characters in front (a length byte, the end of
    something else); None when it doesn't read like text."""
    text = normalize(raw)
    for cut in range(3):
        candidate = text[cut:].lstrip(' ')
        if len(candidate) >= 2 and reads_like_text(candidate):
            return candidate
    return None


def _strings_in(data: bytes):
    for match in _UTF8_RUN.finditer(data):
        yield match.group().decode('utf-8', 'replace')
    for match in _UTF16_RUN.finditer(data):
        raw = match.group()
        yield raw[:len(raw) // 2 * 2].decode('utf-16-le', 'replace')


@dataclass
class Scan:
    strings: list = field(default_factory=list)
    read: list = field(default_factory=list)       # files read, relative to the game's folder
    skipped: list = field(default_factory=list)    # (file, why)


def scan(root: Path, limit: int = MAX_STRINGS) -> Scan:
    """English text in the game's data files, read as they are (nothing is unpacked or decrypted)."""
    root = Path(root)
    found, seen = Scan(), set()
    total = 0
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d.lower() not in SKIP_DIRS and not os.path.islink(os.path.join(folder, d)))
        for name in sorted(files):
            path = Path(folder) / name
            if path.suffix.lower() not in SCAN_EXTENSIONS or path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
            try:
                size = path.stat().st_size
                if size > MAX_FILE or total + size > MAX_TOTAL:
                    found.skipped.append((rel, 'too big to read whole'))
                    continue
                if looks_random(path):
                    found.skipped.append((rel, 'compressed or encrypted: left as it is'))
                    continue
                total += size
                kept = 0
                with path.open('rb') as f:
                    tail = b''
                    while True:
                        block = f.read(CHUNK)
                        if not block:
                            break
                        data = tail + block
                        for raw in _strings_in(data):
                            text = _readable(raw)
                            if text and text not in seen:
                                seen.add(text)
                                found.strings.append(text)
                                kept += 1
                                if len(found.strings) >= limit:
                                    found.read.append(rel)
                                    return found
                        tail = data[-1200:]
                if kept:
                    found.read.append(rel)
            except OSError as err:
                found.skipped.append((rel, str(err)))
    return found


def read_dump(path: Path) -> list:
    """The strings the adapter saw in the game without Arabic (untranslated.txt: UTF-8, one per line, \\n escaped)."""
    path = Path(path)
    if not path.is_file():
        return []
    out, seen = [], set()
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        text = re.sub(r'\\(.)', lambda m: {'n': '\n', 'r': '\r', '\\': '\\'}.get(m.group(1), m.group(0)), line)
        key = normalize(text)
        if key and key not in seen and not _SHAPED.search(key):
            seen.add(key)
            out.append(text)
    return out
