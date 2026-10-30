"""Fingerprints of a game's English lines, for the subtitle overlay.

The overlay reads the game's English subtitles off the screen (OCR) and shows
the Arabic for whichever line it reads. To find that line it needs something to
compare against, but shipping the game's English script would mean handing out
the publisher's text. So each English line is kept only as a fingerprint:

- its normalized length;
- a 64-bit SimHash of its character trigrams (close lines get close hashes,
  so most of the table can be skipped with a cheap bit count);
- the set of its trigrams, each hashed down to 16 bits (to score candidates by
  Jaccard overlap: how many trigrams two lines share);
- how many slots the game fills in at runtime ({0}, %s, [E]). A filled slot
  ("Hello, {0}!" on screen as "Hello, Arthur!") makes the line longer, so
  those lines get room for it in length, and also score by how much of the
  stored line shows up in what was read.

Normalization makes OCR mistakes cost little: it lowercases, drops accents,
apostrophes and punctuation, folds letters OCR mixes up (I/l/1/|, O/0, rn/m,
vv/w) and ignores spaces, which OCR often drops or adds.

Fingerprints aren't readable text, but they aren't encryption either: someone
determined could recover much of a line from its trigram hashes. They keep the
script out of plain sight; the publisher's permission is still what makes a
pack fine to publish.

desktop/localization/fingerprint.js does the same in the app. Both must match
exactly; test/fixtures/fingerprint-vectors.json holds cases both are checked against.
"""

from __future__ import annotations

import base64
import bisect
import re
import struct
import unicodedata
from dataclasses import dataclass

from .rtl import _TOKENS

FORMAT = 1
NORMALIZATION = 1
KIND = 'gameshelf-overlay-fingerprints'

DEFAULT_THRESHOLD = 0.72
LENGTH_TOLERANCE = 0.25
SLOT_ROOM = 16  # characters a filled-in slot may add
MAX_HAMMING = 24
MAX_CANDIDATES = 48

_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_MASK64 = 0xFFFFFFFFFFFFFFFF

_APOSTROPHES = re.compile("['‘’ʼ`´]")
_CONFUSABLES = str.maketrans({'0': 'o', '1': 'l', 'i': 'l', '|': 'l'})
_LETTER_PAIRS = (('rn', 'm'), ('vv', 'w'))
_NOT_WORD = re.compile('[^a-z0-9]+')


def normalize(text: str) -> str:
    """The form both sides compare: "I'll be RIGHT back!" -> "lll be rlght back"."""
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(ch for ch in text if not unicodedata.category(ch).startswith('M'))
    text = _APOSTROPHES.sub('', text.lower()).translate(_CONFUSABLES)
    for pair, single in _LETTER_PAIRS:
        text = text.replace(pair, single)
    return _NOT_WORD.sub(' ', text).strip()


def english_text(source: str) -> tuple:
    """A game string as it appears on screen, and how many slots the game fills in:
    tags gone, placeholders, key prompts and line breaks as spaces."""
    slots = 0

    def replace(match):
        nonlocal slots
        if match.group('tag'):
            return ''
        if match.group('ph'):
            slots += 1
        return ' '
    return _TOKENS.sub(replace, source), slots


def overlay_text(arabic: str) -> str:
    """Arabic for the overlay, which shapes it itself: kept in reading order,
    with tags removed, line breaks as newlines, and placeholders (filled in by
    the game at runtime, so unknown here) shown as an ellipsis."""
    def replace(match):
        raw = match.group(0)
        if match.group('br'):
            return '\n'
        if match.group('tag'):
            return ''
        return raw if raw.startswith('[') else '…'
    text = _TOKENS.sub(replace, arabic)
    return '\n'.join(re.sub(r'[ \t]+', ' ', line).strip() for line in text.split('\n')).strip()


def fnv1a64(text: str) -> int:
    h = _FNV_OFFSET
    for byte in text.encode('utf-8'):
        h = ((h ^ byte) * _FNV_PRIME) & _MASK64
    return h


@dataclass(frozen=True)
class Fingerprint:
    length: int
    simhash: int
    grams: tuple  # sorted, unique 16-bit trigram hashes


def fingerprint(normalized: str) -> Fingerprint:
    squashed = normalized.replace(' ', '')
    if not squashed:
        return Fingerprint(0, 0, ())
    padded = f'^{squashed}$'
    hashes = [fnv1a64(g) for g in sorted({padded[i:i + 3] for i in range(len(padded) - 2)})]
    counts = [0] * 64
    for h in hashes:
        for bit in range(64):
            counts[bit] += 1 if (h >> bit) & 1 else -1
    simhash = sum(1 << bit for bit in range(64) if counts[bit] > 0)
    return Fingerprint(len(squashed), simhash, tuple(sorted({h & 0xFFFF for h in hashes})))


def _shared(a: tuple, b: tuple) -> int:
    i = j = shared = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            shared += 1
            i += 1
            j += 1
        elif a[i] < b[j]:
            i += 1
        else:
            j += 1
    return shared


def jaccard(a: tuple, b: tuple) -> float:
    shared = _shared(a, b)
    total = len(a) + len(b) - shared
    return shared / total if total else 0.0


def score(read: tuple, entry: tuple, slots: int) -> float:
    """Jaccard overlap; for lines with slots, at least the share of the line's
    own trigrams found in what was read (the filled-in text is extra)."""
    value = jaccard(read, entry)
    if slots and entry:
        value = max(value, _shared(read, entry) / len(entry))
    return value


def _pack_grams(grams: tuple) -> str:
    return base64.b64encode(struct.pack(f'<{len(grams)}H', *grams)).decode('ascii')


def _unpack_grams(packed: str) -> tuple:
    raw = base64.b64decode(packed)
    return struct.unpack(f'<{len(raw) // 2}H', raw)


def build_table(pairs) -> tuple:
    """(english, arabic) pairs -> (the fingerprints.json data, warnings).

    Lines whose English normalizes to nothing are skipped. When two English
    lines normalize the same, the later one wins.
    """
    warnings = []
    by_text: dict = {}
    for number, (english, arabic) in enumerate(pairs, start=1):
        shown_english, slots = english_text(english)
        normalized = normalize(shown_english)
        shown = overlay_text(arabic)
        if not normalized or not shown:
            warnings.append(f'line {number}: nothing to match or show, skipped.')
            continue
        if normalized in by_text and by_text[normalized] != shown:
            warnings.append(f'line {number}: reads the same as an earlier line on screen; the later Arabic is used.')
        by_text[normalized] = (shown, slots)
    entries = []
    for normalized, (shown, slots) in by_text.items():
        fp = fingerprint(normalized)
        entries.append([f'{fp.simhash:016x}', fp.length, _pack_grams(fp.grams), shown, slots])
    entries.sort(key=lambda e: (e[1], e[0]))
    data = {'format': FORMAT, 'kind': KIND, 'normalization': NORMALIZATION, 'entries': entries}
    return data, warnings


@dataclass(frozen=True)
class Match:
    arabic: str
    score: float
    index: int


class FingerprintTable:
    """Looks OCR'd English up in a fingerprints.json table (the app's matcher, in Python)."""

    def __init__(self, data: dict):
        if data.get('kind') != KIND or data.get('format') != FORMAT or data.get('normalization') != NORMALIZATION:
            raise ValueError('Not a fingerprint table this version understands.')
        self.entries = [(length, int(simhash, 16), _unpack_grams(grams), arabic, slots)
                        for simhash, length, grams, arabic, slots in data['entries']]
        self.lengths = [e[0] for e in self.entries]
        self.with_slots = [i for i, e in enumerate(self.entries) if e[4]]

    def lookup(self, text: str, *, threshold: float = DEFAULT_THRESHOLD, length_tolerance: float = LENGTH_TOLERANCE,
               max_hamming: int = MAX_HAMMING, max_candidates: int = MAX_CANDIDATES) -> Match | None:
        fp = fingerprint(normalize(text))
        if not fp.length:
            return None
        # Lines within the length tolerance, plus lines with slots that the
        # filled-in text could have made this long.
        low = bisect.bisect_left(self.lengths, fp.length * (1 - length_tolerance))
        high = bisect.bisect_right(self.lengths, fp.length * (1 + length_tolerance))
        candidates = set(range(low, high))
        for i in self.with_slots:
            length, slots = self.entries[i][0], self.entries[i][4]
            if length * (1 - length_tolerance) <= fp.length <= length * (1 + length_tolerance) + SLOT_ROOM * slots:
                candidates.add(i)
        near = sorted((bin(self.entries[i][1] ^ fp.simhash).count('1'), i) for i in candidates)
        best = None
        for distance, i in near[:max_candidates]:
            if distance > max_hamming:
                break
            value = score(fp.grams, self.entries[i][2], self.entries[i][4])
            if best is None or value > best.score:
                best = Match(self.entries[i][3], value, i)
        return best if best and best.score >= threshold else None
