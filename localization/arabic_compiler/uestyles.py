"""Arabic in an Unreal game's per-language text styles, for UE5 games whose style tables keep one style per
language (Phantom Blade Zero's DT_PBZSettingsDescriptionStyles: every row maps "en-US", "ja", "zh-Hans", ...
to a font, size and colour). With Arabic switched on as the game's language, a row without an "ar" entry has
no style for it; this adds one to every row, a copy of the English entry (whose fonts GameShelf already gives
the Arabic font), so every decorator (<Ability_Yellow>, <Bold>, <Tutorial_Body_Red>, ...) keeps its look.

In Phantom Blade Zero the row is PBZRichTextStyleRow { TextStyleMap: TMap<FString, FTextBlockStyle>;
DefaultTextStyle: FTextBlockStyle } (from the game's own .usmap): the map is what this adds "ar" to, and the
default style right after it is why a map whose English entry comes last isn't copied.

It works on the legacy asset (.uasset + .uexp) retoc's to-legacy writes from the game's own containers, and
needs no field names: a per-language map is a count, then (language code, style) pairs, so the English pair's
bytes are copied under the new code and the count goes up by one. The .uasset header then gets the export's
new size, the offsets of later exports, and the end of the data (BulkDataStartOffset). retoc's to-zen turns
the result back into a package for the game's own .utoc/.ucas loader.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

# A language code as an FString: int32 length (with its NUL), ASCII, NUL.
_CULTURE = re.compile(rb'([\x03-\x0b])\x00\x00\x00([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\x00')
STYLE_TABLE = re.compile(r'(?i)(?:^|/)(?:DT_[^/]*Styles?[^/]*|[^/]*TextStyles?[^/]*)\.uasset$')


class StyleError(ValueError):
    pass


@dataclass
class CultureMap:
    count_at: int          # where the map's element count (int32) is
    keys: list             # [(code, key_start, key_end)], in order


def fstring(code: str) -> bytes:
    raw = code.encode('ascii') + b'\0'
    return struct.pack('<i', len(raw)) + raw


def culture_maps(data: bytes, template: str = 'en-US') -> list:
    """The per-language maps in an export's data that have a `template` entry: each one starts with
    int32 0 (keys to remove) and int32 n, followed by n (code, style) pairs whose codes are found in order."""
    keys = []
    for m in _CULTURE.finditer(data):
        if m.group(1)[0] == len(m.group(2)) + 1:
            keys.append((m.group(2).decode('ascii'), m.start(), m.end()))
    maps = []
    i = 0
    while i < len(keys):
        code, start, end = keys[i]
        if start >= 8:
            removed, count = struct.unpack_from('<ii', data, start - 8)
            group = keys[i:i + count] if removed == 0 and 1 <= count <= 64 else []
            if len(group) == count and any(k[0] == template for k in group):
                maps.append(CultureMap(start - 4, group))
                i += count
                continue
        i += 1
    return maps


def add_culture(data: bytes, culture: str = 'ar', template: str = 'en-US') -> tuple:
    """`data` with a `culture` entry, a copy of `template`'s, in every map that has `template` and not `culture`.
    Returns (new data, [(position, inserted bytes)]) for the header to be fixed. A map whose `template` entry
    is its last can't be copied (its end isn't known without field names) and is left as it is."""
    inserts = []
    for m in culture_maps(data, template):
        codes = [k[0] for k in m.keys]
        if culture in codes:
            continue
        at = codes.index(template)
        if at == len(m.keys) - 1:
            continue
        _, _, value_start = m.keys[at]
        value_end = m.keys[at + 1][1]
        inserts.append((m.count_at, value_end, fstring(culture) + data[value_start:value_end]))
    out = bytearray(data)
    for count_at, position, blob in reversed(inserts):  # from the end, so earlier positions stay right
        out[position:position] = blob
        (count,) = struct.unpack_from('<i', out, count_at)
        struct.pack_into('<i', out, count_at, count + 1)
    return bytes(out), [(position, len(blob)) for _, position, blob in inserts]


def _int64s(data: bytes, value: int) -> list:
    return [i for i in range(len(data) - 7) if struct.unpack_from('<q', data, i)[0] == value]


def fix_header(uasset: bytes, uexp_size: int, inserts: list) -> bytes:
    """The .uasset header for a .uexp that grew by `inserts` [(position in .uexp, bytes added)]: each export
    entry's (SerialSize, SerialOffset) pair and BulkDataStartOffset are found by their values and corrected."""
    if not inserts:
        return uasset
    header = len(uasset)
    out = bytearray(uasset)
    # Export entries: SerialSize (int64) followed by SerialOffset (int64), the data being in the .uexp.
    exports = []
    for i in range(header - 15):
        size, offset = struct.unpack_from('<qq', uasset, i)
        if 0 < size <= uexp_size and header <= offset and offset + size <= header + uexp_size:
            exports.append((i, size, offset - header))
    # The real entries are the ones that tile the .uexp exactly, end to end; chance matches in the header don't.
    by_start = {}
    for entry in exports:
        by_start.setdefault(entry[2], []).append(entry)
    chains = []

    def walk(start, chain):
        if len(chains) > 1:
            return
        if start == uexp_size:
            chains.append(list(chain))
            return
        for entry in by_start.get(start, []):
            if entry not in chain:
                walk(start + entry[1], chain + [entry])

    walk(0, [])
    if len(chains) != 1:
        raise StyleError('Couldn\'t find the exports in the .uasset header, so the style table wasn\'t changed.')
    exports = chains[0]
    for at, size, start in exports:
        grow = sum(n for pos, n in inserts if start < pos <= start + size)
        shift = sum(n for pos, n in inserts if pos <= start)
        struct.pack_into('<qq', out, at, size + grow, header + start + shift)
    total = _int64s(uasset, header + uexp_size)
    if len(total) > 1:
        raise StyleError('The .uasset header has more than one place that could be its data\'s end.')
    for at in total:
        struct.pack_into('<q', out, at, header + uexp_size + sum(n for _, n in inserts))
    return bytes(out)


def patch_style_asset(uasset_path: Path, out_dir: Path, rel: Path, cultures=('ar',), template: str = 'en-US') -> int:
    """Writes the patched .uasset/.uexp of a style table at `out_dir`/`rel`. Returns how many entries were added."""
    uasset = Path(uasset_path).read_bytes()
    uexp_path = Path(uasset_path).with_suffix('.uexp')
    if not uexp_path.is_file():
        raise StyleError(f'{Path(uasset_path).name} has no .uexp beside it.')
    data = uexp_path.read_bytes()
    added = 0
    for culture in cultures:
        before = len(data)
        data_new, inserts = add_culture(data, culture, template)
        uasset = fix_header(uasset, before, inserts)
        data = data_new
        added += len(inserts)
    if added:
        target = Path(out_dir) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(uasset)
        target.with_suffix('.uexp').write_bytes(data)
    return added
