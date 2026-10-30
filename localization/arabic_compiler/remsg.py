"""Capcom RE Engine message files (natives/stm/.../<name>.msg.<version>), for
the pack builder.

GameShelf doesn't read or write .msg files itself: their text is stored
scrambled, and undoing that is left to the community's REMSG_Converter
(github.com/dtlnor/REMSG_Converter, MIT), which the pack's author installs and
points the builder to with --msg-tool. Its dumps are what this module reads and
writes:

- JSON (-m json): {"version", "languages": [language ids], "attribute_headers",
  "entries": [{"name", "guid", "content": [one text per language]}]};
- CSV (-m csv, UTF-8 with BOM): guid, soundId, <attribute>..., entry name,
  then one column per language, named "Japanese", "English", ... "Arabic".

English is language 1 and Arabic 21. The Arabic goes into the slots asked for:
English by default (the language the game is set to), and Arabic too for games
that have an Arabic option.

Message files can also be taken straight out of the game's own paks (see
extract_messages). Their names aren't kept in the pak, only two hashes of each,
so they're named by those ("unnamed/<hash>-<hash>.msg.<version>") and the
Arabic patch puts its files back under the same hashes.
"""

from __future__ import annotations

import csv
import json
import re
import shutil
import struct
import subprocess
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from .repak import GamePak, PakError, path_hashes

LANGUAGE_IDS = {'English': 1, 'Arabic': 21}
MSG_FILE = re.compile(r'\.msg\.\d+$', re.I)
UNNAMED = re.compile(r'^unnamed/([0-9a-f]{8})-([0-9a-f]{8})\.msg\.\d+$')
MSG_MAGIC = b'GMSG'
MAX_MSG_SIZE = 32 * 1024 * 1024
# A file every Arabic patch made by the pack builder holds (the game never
# asks for it), so a patch already in the game is never read as its English.
PATCH_MARKER = 'natives/stm/gameshelf/arabic_patch.txt'
PATCH_MARKER_TEXT = b'Arabic patch made by GameShelf. Turn Arabic off in GameShelf to take it out.\n'
DUMP_FILE = re.compile(r'\.msg\.\d+\.(json|csv)$', re.I)
_ARABIC = re.compile('[؀-ۿ]')


class MsgError(ValueError):
    pass


@dataclass
class MsgDump:
    path: Path                    # the dump (.msg.<version>.json or .csv)
    in_pak: str                   # natives/stm/.../<name>.msg.<version>
    kind: str                     # 'json' or 'csv'
    data: object                  # the parsed JSON, or [header, *rows] for CSV
    original: Path | None = None  # the .msg it was made from, which REMSG_Converter needs to rebuild it
    english: dict = field(default_factory=dict)   # guid -> English
    arabic: dict = field(default_factory=dict)    # guid -> Arabic already there


def pak_path(path: Path | str) -> str | None:
    """natives/... for a file inside an extracted game folder, else None."""
    parts = PurePosixPath(str(path).replace('\\', '/')).parts
    lower = [p.lower() for p in parts]
    if 'natives' not in lower:
        return None
    return '/'.join(parts[lower.index('natives'):])


def checked_pak_path(value: str) -> str:
    if UNNAMED.match(value):
        return value
    path = PurePosixPath(value.replace('\\', '/').lstrip('/'))
    if not path.parts or path.parts[0].lower() != 'natives' or '..' in path.parts or not MSG_FILE.search(path.name):
        raise MsgError(f'"{value}" should be the message file\'s path in the game, like natives/stm/message/.../name.msg.22.')
    return path.as_posix()


def pak_entry(in_pak: str):
    """What a file is called in a pak: its path, or the two hashes of one taken out of the game's paks."""
    found = UNNAMED.match(in_pak)
    return (int(found.group(1), 16), int(found.group(2), 16)) if found else in_pak


def extract_messages(paks: list, out: Path, log) -> list:
    """Takes every message file out of the game's paks (later paks win, as in the game). Returns [(file, name)]."""
    newest = {}
    opened = []
    try:
        ours = path_hashes(PATCH_MARKER)
        for path in paks:
            pak = GamePak(path)
            opened.append(pak)
            if ours in pak.entries:
                log(f'Skipped {Path(path).name}: it\'s GameShelf\'s Arabic patch, not the game\'s own text.')
                continue
            for hashes, (_, _, size, _) in pak.entries.items():
                if 24 <= size <= MAX_MSG_SIZE:
                    newest[hashes] = pak
        found, skipped = [], 0
        for hashes, pak in newest.items():
            try:
                if pak.read(hashes, limit=8)[4:8] != MSG_MAGIC:
                    continue
                data = pak.read(hashes)
            except PakError as err:
                if 'zstandard' in str(err):
                    raise
                skipped += 1
                continue
            except zlib.error:
                skipped += 1
                continue
            (version,) = struct.unpack_from('<I', data)
            name = f'unnamed/{hashes[0]:08x}-{hashes[1]:08x}.msg.{version}'
            target = out / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            found.append((target, name))
    except PakError as err:
        raise MsgError(str(err)) from None
    finally:
        for pak in opened:
            pak.close()
    log(f'Took {len(found)} message files out of {", ".join(Path(p).name for p in paks)}'
        + (f' ({skipped} encrypted or unreadable files skipped)' if skipped else '') + '.')
    return found


def is_dump(path: Path) -> bool:
    """True for a REMSG_Converter dump."""
    try:
        if path.suffix.lower() == '.json':
            data = json.loads(path.read_text(encoding='utf-8-sig'))
            return isinstance(data, dict) and {'languages', 'entries'} <= set(data)
        if path.suffix.lower() == '.csv':
            with path.open(encoding='utf-8-sig', newline='') as f:
                header = next(csv.reader(f), [])
            return bool(header) and header[0] == 'guid' and 'entry name' in header
    except (OSError, ValueError, UnicodeDecodeError):
        return False
    return False


def read_dump(path: Path, in_pak: str | None = None) -> MsgDump:
    path = Path(path)
    in_pak = checked_pak_path(in_pak or pak_path(DUMP_FILE.sub(lambda m: m.group(0)[:-len(m.group(1)) - 1], str(path))) or '')
    original = path.with_name(path.name[:-len(path.suffix)])
    dump = MsgDump(path, in_pak, path.suffix.lower()[1:], None, original if original.is_file() else None)
    if dump.kind == 'json':
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        languages = data.get('languages') or []
        if LANGUAGE_IDS['English'] not in languages:
            raise MsgError(f'{path.name} has no English text.')
        en = languages.index(LANGUAGE_IDS['English'])
        ar = languages.index(LANGUAGE_IDS['Arabic']) if LANGUAGE_IDS['Arabic'] in languages else None
        for entry in data.get('entries', []):
            content = entry.get('content') or []
            guid = str(entry.get('guid'))
            dump.english[guid] = content[en] if en < len(content) else ''
            if ar is not None and ar < len(content) and _ARABIC.search(content[ar] or ''):
                dump.arabic[guid] = content[ar]
        dump.data = data
    else:
        with path.open(encoding='utf-8-sig', newline='') as f:
            table = list(csv.reader(f))
        header = table[0]
        if 'English' not in header:
            raise MsgError(f'{path.name} has no English column.')
        en, ar = header.index('English'), header.index('Arabic') if 'Arabic' in header else None
        for row in table[1:]:
            if not row:
                continue
            dump.english[row[0]] = row[en] if en < len(row) else ''
            if ar is not None and ar < len(row) and _ARABIC.search(row[ar]):
                dump.arabic[row[0]] = row[ar]
        dump.data = table
    return dump


def write_dump(dump: MsgDump, texts: dict, languages: list[str], out: Path) -> int:
    """Writes the dump with `texts` ({guid: Arabic}) in the given language slots. Returns how many entries changed."""
    out.parent.mkdir(parents=True, exist_ok=True)
    changed = 0
    if dump.kind == 'json':
        data = json.loads(json.dumps(dump.data))
        slots = [data['languages'].index(LANGUAGE_IDS[name]) for name in languages if LANGUAGE_IDS[name] in data['languages']]
        for entry in data['entries']:
            text = texts.get(str(entry.get('guid')))
            if text is None:
                continue
            for slot in slots:
                entry['content'][slot] = text
            changed += 1
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    else:
        header, *rows = [list(r) for r in dump.data]
        slots = [header.index(name) for name in languages if name in header]
        for row in rows:
            text = texts.get(row[0]) if row else None
            if text is None:
                continue
            for slot in slots:
                row[slot] = text
            changed += 1
        with out.open('w', encoding='utf-8-sig', newline='') as f:
            csv.writer(f).writerows([header, *rows])
    return changed


def _tool_command(tool: str) -> list[str]:
    return [sys.executable, tool] if tool.lower().endswith('.py') else [tool]


def _run_tool(tool: str, args: list[str], expect: Path, what: str):
    result = subprocess.run(_tool_command(tool) + args, capture_output=True, text=True)
    # REMSG_Converter reports a failed file in its output and still exits 0, so look for the file.
    if result.returncode != 0 or not expect.is_file():
        raise MsgError(f'REMSG_Converter couldn\'t {what}: {(result.stdout + result.stderr).strip()[-400:]}')


def export_dump(tool: str, original: Path, work: Path, in_pak: str) -> MsgDump:
    """Has REMSG_Converter dump an original .msg to JSON, in a copy under `work` (the game folder isn't written to)."""
    copy = work / in_pak
    copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(original, copy)
    dumped = copy.with_name(copy.name + '.json')
    _run_tool(tool, ['-m', 'json', '-i', str(copy)], dumped, f'read {original.name}')
    return read_dump(dumped, in_pak)


def rebuild_msg(tool: str, dump: MsgDump, edited: Path, out: Path):
    """Has REMSG_Converter write a new .msg from the original and the edited dump, to `out`."""
    if not dump.original:
        raise MsgError(f'{dump.path.name}: the original {Path(dump.in_pak).name} has to sit beside the dump; REMSG_Converter builds the new file from it.')
    work = edited.with_name(Path(dump.in_pak).name)
    shutil.copyfile(dump.original, work)
    new = work.with_name(work.name + '.new')
    new.unlink(missing_ok=True)
    _run_tool(tool, ['-m', dump.kind, '-i', str(work), '-e', str(edited)], new, f'write {work.name}')
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(new, out)
