"""Where a game's English text comes from, for the pack builder.

- CSV with "source" (and optionally "arabic", "key") columns;
- JSON: [{"source": ..., "arabic": ..., "key": ...}] or {"key": "English"},
  nested objects flattened to dotted keys;
- XUnity.AutoTranslator text files ("English=translation" lines);
- Unreal .locres files (see locres.py);
- Unity asset files (.assets, .bundle, data.unity3d), with the UnityPy library;
- Ren'Py scripts (.rpy), and Ren'Py archives (.rpa) holding them;
- Godot translation tables (CSV with a "keys" column) and gettext .po/.pot files;
- Capcom RE Engine message dumps (.msg.<version>.json/.csv from REMSG_Converter),
  or a folder of message files extracted from your own copy (natives/...);
- a game folder: loose .locres files, a Unity game's data folder, a Ren'Py
  game, or a Godot project (the game's source, or one you recovered from your
  own copy with GDRE Tools).

Text inside encrypted or packed game archives is out of reach on purpose:
extract it from your own copy with the engine's tools first. This never looks
for decryption keys.
"""

from __future__ import annotations

import csv
import io
import json
import pickle
import re
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from . import locres as locres_format
from . import remsg


class SourceError(ValueError):
    pass


@dataclass
class Row:
    source: str
    arabic: str | None = None
    key: str | None = None


@dataclass
class Source:
    rows: list
    engine: str | None = None          # 'unreal', 'unity', 'renpy' or 'godot' when the input says so
    locres: object = None              # the parsed .locres, for writing it back translated
    locres_path: str | None = None     # where it goes inside the game's pak, when known
    notes: list = field(default_factory=list)
    # True when the game looks lines up by key (Godot translation tables), so
    # the pack maps keys, not English, to Arabic.
    keyed: bool = False
    # RE Engine: message dumps to write the Arabic into, and .msg files found
    # without dumps ([(path, natives/... path)]).
    msg_dumps: list = field(default_factory=list)
    msg_files: list = field(default_factory=list)
    # RE Engine: the game's own paks, base first, to take the message files out of.
    game_paks: list = field(default_factory=list)


def _csv(path: Path) -> Source:
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if 'source' not in (reader.fieldnames or []):
            raise SourceError(f'{path.name} needs a "source" column (and optionally "arabic" and "key").')
        records = [r for r in reader if r['source']]
    # translations.csv from a game that looks text up by key says so in its "lookup" column.
    keyed = bool(records) and all((r.get('lookup') or '').strip() == 'key' and r.get('key') for r in records)
    return Source([Row(r['source'], (r.get('arabic') or '').strip() or None, r.get('key') or None) for r in records], keyed=keyed)


def _flatten(value, prefix=''):
    if isinstance(value, dict):
        for key, inner in value.items():
            yield from _flatten(inner, f'{prefix}.{key}' if prefix else str(key))
    elif isinstance(value, str) and value.strip():
        yield prefix, value


def _json(path: Path) -> Source:
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    if isinstance(data, list):
        rows = []
        for item in data:
            if not isinstance(item, dict) or not isinstance(item.get('source'), str):
                raise SourceError(f'{path.name}: each item needs a "source" string.')
            rows.append(Row(item['source'], item.get('arabic') or None, item.get('key')))
        return Source(rows)
    if isinstance(data, dict):
        return Source([Row(text, None, key) for key, text in _flatten(data)])
    raise SourceError(f'{path.name} should hold a list of lines or an object of "key": "English".')


_XUNITY_ESCAPES = {'\\\\': '\\', '\\=': '=', '\\n': '\n', '\\r': '\r', '\\/': '/'}


def _xunity_unescape(text: str) -> str:
    return re.sub(r'\\[\\=nr/]', lambda m: _XUNITY_ESCAPES[m.group()], text)


def _xunity(path: Path) -> Source:
    rows = []
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('//'):
            continue
        split = re.search(r'(?<!\\)=', line)
        if not split:
            continue
        original = _xunity_unescape(line[:split.start()])
        translated = _xunity_unescape(line[split.end():])
        if original:
            rows.append(Row(original, translated if translated and translated != original else None))
    return Source(rows, engine='unity')


def _locres(path: Path, locres_path: str | None = None) -> Source:
    parsed = locres_format.read(path.read_bytes())
    rows = [Row(text, None, key) for key, text in parsed.rows() if text.strip()]
    return Source(rows, engine='unreal', locres=parsed, locres_path=locres_path)


# A line of game text rather than an ID, path or code: letters, and either a
# space or a capital letter, without slashes, underscores or dots inside words.
_IDENTIFIER = re.compile(r'^[\w.\-/\\:]+$')
_HAS_LETTERS = re.compile(r'[A-Za-z]{2}')


def looks_like_text(value: str) -> bool:
    text = value.strip()
    if not 2 <= len(text) <= 500 or not _HAS_LETTERS.search(text):
        return False
    if '://' in text or text.startswith(('Assets/', 'Packages/', '{"', '<?xml')):
        return False
    if ' ' not in text:
        return bool(re.fullmatch(r'[A-Z][a-z]+[!?.]?', text))  # a single word: "Continue", "Yes!"
    return not _IDENTIFIER.match(text)


def _unity_strings(value, path=''):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, inner in value.items():
            if str(key).startswith('m_'):
                continue  # Unity's own fields (object names, references), not game text
            yield from _unity_strings(inner, f'{path}.{key}' if path else str(key))
    elif isinstance(value, list):
        for i, inner in enumerate(value):
            yield from _unity_strings(inner, f'{path}[{i}]')


def _unity(paths: list) -> Source:
    try:
        import UnityPy  # noqa: N813 (the library's own name)
    except ImportError:
        raise SourceError('Reading Unity asset files needs UnityPy: pip install UnityPy') from None
    rows, seen = [], set()
    for path in paths:
        env = UnityPy.load(str(path))
        for obj in env.objects:
            kind = obj.type.name
            try:
                if kind == 'TextAsset':
                    data = obj.read()
                    script = getattr(data, 'm_Script', None) or getattr(data, 'script', '')
                    if isinstance(script, bytes):
                        script = script.decode('utf-8', 'ignore')
                    found = ((f'line {n}', line) for n, line in enumerate(str(script).splitlines(), start=1))
                    name = getattr(data, 'm_Name', None) or getattr(data, 'name', '')
                elif kind == 'MonoBehaviour':
                    found = _unity_strings(obj.read_typetree())
                    name = ''
                else:
                    continue
            except Exception:  # an object UnityPy can't read: skip it
                continue
            for where, text in found:
                text = text.strip()
                if looks_like_text(text) and text not in seen:
                    seen.add(text)
                    rows.append(Row(text, None, f'{Path(path).name}:{obj.path_id}:{name}{":" if name else ""}{where}'))
    return Source(rows, engine='unity', notes=['Unity text was picked out of the asset files by guesswork. Check translations.csv and remove lines that aren\'t game text.'])


# ---- Ren'Py ----
#
# Dialogue lines ([who] "text") and menu choices ("text": or "text" if ...:),
# read the way Ren'Py reads them, so each line is exactly what the game passes
# to config.say_menu_text_filter (see desktop/localization/renpy.js).

_RENPY_STRING = r'(r?)(?:"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\')'
_RENPY_SAY = re.compile(r'^(?:(?P<who>[A-Za-z_][\w.]*)(?:\s+(?P<attrs>[\w\- ]+?))?\s+)?' + _RENPY_STRING
                        + r'(?:\s+(?:with\s+[\w.()]+|id\s+\w+|nointeract))*\s*$')
_RENPY_CHOICE = re.compile(r'^' + _RENPY_STRING + r'(?:\s+if\s+.+)?\s*:\s*$')
# Statements that take a string but aren't dialogue.
_RENPY_NOT_SAY = {
    'voice', 'play', 'queue', 'stop', 'jump', 'call', 'show', 'hide', 'scene', 'image', 'define', 'default',
    'with', 'window', 'pause', 'return', 'init', 'python', 'label', 'menu', 'screen', 'style', 'transform',
    'translate', 'old', 'new', 'if', 'elif', 'else', 'while', 'for', 'at', 'camera', 'layeredimage', 'text',
    'add', 'key', 'use', 'textbutton', 'imagebutton', 'button', 'action', 'font', 'renpy', 'nvl', 'testcase',
    'style_prefix', 'style_suffix', 'tag', 'zorder', 'outlines', 'xalign', 'yalign', 'align', 'variant',
}
_RENPY_ESCAPES = {'{': '{{', '[': '[[', '%': '%%', 'n': '\n'}
_FILE_NAME = re.compile(r'\.(ogg|opus|mp3|wav|png|jpe?g|webp|webm|mp4|ttf|otf|rpy|json|txt)$', re.I)


def _renpy_text(raw: str, body: str) -> str:
    if raw:
        return body
    text = re.sub(r' +', ' ', body.strip())

    def dequote(m):
        c = m.group(1)
        if c[0] == 'u' and m.group(2):
            return chr(int(m.group(2), 16))
        return _RENPY_ESCAPES.get(c, c)
    return re.sub(r'\\(u([0-9a-fA-F]{1,4})|.)', dequote, text)


def renpy_lines(script: str):
    """(line number, text) for each dialogue line and menu choice in a .rpy file."""
    python_indent = None
    for number, line in enumerate(script.splitlines(), start=1):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if python_indent is not None:
            if stripped and not stripped.startswith('#') and indent <= python_indent:
                python_indent = None
            else:
                continue
        if not stripped or stripped.startswith('#'):
            continue
        if re.match(r'^(init\b.*\bpython\b|python\b|screen\b|style\b|transform\b|translate\b)', stripped) and stripped.endswith(':'):
            python_indent = indent  # code, screens and translations: not the script's own lines
            continue
        choice = _RENPY_CHOICE.match(stripped)
        say = None if choice else _RENPY_SAY.match(stripped)
        match = choice or say
        if not match:
            continue
        if say and (say.group('who') in _RENPY_NOT_SAY or stripped.startswith('$')):
            continue
        groups = match.groups()[-3:]
        text = _renpy_text(groups[0], groups[1] if groups[1] is not None else groups[2])
        if text and _HAS_LETTERS.search(text) and not _FILE_NAME.search(text):
            yield number, text


class _IndexOnly(pickle.Unpickler):
    """Reads an archive's index (names and numbers) and refuses anything else."""

    def find_class(self, module, name):
        raise SourceError('This .rpa archive\'s index holds more than names and numbers, so it won\'t be read.')


def read_rpa(path: Path) -> dict:
    """The files in a Ren'Py archive: {name: bytes}, for .rpy scripts only."""
    with path.open('rb') as f:
        head = f.read(40)
        if head.startswith(b'RPA-3.0 '):
            offset, key = int(head[8:24], 16), int(head[25:33], 16)
        elif head.startswith(b'RPA-2.0 '):
            offset, key = int(head[8:24], 16), 0
        else:
            raise SourceError(f'{path.name} isn\'t a Ren\'Py archive GameShelf can read (RPA-2.0 or 3.0).')
        f.seek(offset)
        try:
            index = _IndexOnly(io.BytesIO(zlib.decompress(f.read())), encoding='bytes').load()
        except (zlib.error, pickle.UnpicklingError, EOFError, ValueError) as err:
            raise SourceError(f'{path.name}\'s index can\'t be read ({err}).') from None
        if not isinstance(index, dict):
            raise SourceError(f'{path.name}\'s index can\'t be read.')
        out = {}
        for name, parts in index.items():
            name = name.decode('utf-8', 'replace') if isinstance(name, bytes) else str(name)
            if not name.lower().endswith('.rpy'):
                continue
            data = b''
            for part in parts:
                start = part[2] if len(part) > 2 else b''
                start = start.encode('latin-1') if isinstance(start, str) else (start or b'')
                f.seek(part[0] ^ key)
                data += start + f.read((part[1] ^ key) - len(start))
            out[name] = data
        return out


def _renpy(files: list) -> Source:
    """files: [(name, script text)]."""
    rows, seen = [], set()
    for name, script in files:
        for number, text in renpy_lines(script):
            if text not in seen:
                seen.add(text)
                rows.append(Row(text, None, f'{name}:{number}'))
    return Source(rows, engine='renpy')


def _renpy_folder(game: Path) -> Source:
    files = [(p.relative_to(game).as_posix(), p.read_text(encoding='utf-8-sig', errors='replace'))
             for p in sorted(game.rglob('*.rpy')) if 'tl' not in p.relative_to(game).parts[:1]]
    for archive in sorted(game.rglob('*.rpa')):
        for name, data in read_rpa(archive).items():
            if not name.startswith('tl/'):
                files.append((f'{archive.name}/{name}', data.decode('utf-8-sig', 'replace')))
    if not files:
        raise SourceError('This Ren\'Py game has only compiled scripts (.rpyc), which don\'t keep the text readably. '
                          'Decompile your own copy (for example with unrpyc) and run this on the .rpy files, or give a CSV.')
    return _renpy(files)


# ---- Godot ----

def _godot_csv(path: Path) -> Source:
    """A Godot translation table: keys,en,fr,... (the English column is the source)."""
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.reader(f)
        header = [h.strip() for h in next(reader, [])]
        if not header or header[0].lower() not in ('keys', 'key', 'id'):
            raise SourceError(f'{path.name} isn\'t a Godot translation table (its first column should be "keys").')
        english = next((i for i, h in enumerate(header) if h.lower() in ('en', 'en_us', 'en_gb', 'english')), None)
        if english is None:
            raise SourceError(f'{path.name} has no English column ("en").')
        arabic = next((i for i, h in enumerate(header) if h.lower() in ('ar', 'arabic')), None)
        rows = []
        for record in reader:
            if len(record) <= english or not record[0].strip() or not record[english].strip():
                continue
            found = record[arabic].strip() if arabic is not None and len(record) > arabic else ''
            rows.append(Row(record[english], found or None, record[0].strip()))
    return Source(rows, engine='godot', keyed=True)


def _po_string(lines: list) -> str:
    return ''.join(json.loads(line) for line in lines)


def _po(path: Path) -> Source:
    """A gettext .po/.pot file. msgid is what the game looks up (English or a key)."""
    rows, entry, current = [], {}, None

    def flush():
        msgid = _po_string(entry.get('msgid', []))
        if msgid and 'msgctxt' not in entry:
            arabic = _po_string(entry.get('msgstr', []))
            rows.append(Row(msgid, arabic or None, msgid))
        entry.clear()
    for line in path.read_text(encoding='utf-8-sig').splitlines() + ['']:
        line = line.strip()
        if not line:
            if entry:
                flush()
            current = None
            continue
        if line.startswith('#'):
            continue
        keyword = re.match(r'^(msgctxt|msgid_plural|msgid|msgstr(?:\[0\])?)\s+(".*")$', line)
        if keyword:
            current = keyword.group(1).replace('[0]', '')
            entry.setdefault(current, []).append(keyword.group(2))
        elif line.startswith('"') and current:
            entry[current].append(line)
    return Source(rows, engine='godot', keyed=True)


_GODOT_TEXT_PROPERTY = re.compile(r'^(?:text|tooltip_text|hint_tooltip|placeholder_text|title|dialog_text)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$', re.M)
_GODOT_TR_CALL = re.compile(r'\btr\(\s*"((?:[^"\\]|\\.)*)"\s*\)')


def _godot_unescape(text: str) -> str:
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), text)


def _first_line(path: Path) -> str:
    with path.open(encoding='utf-8-sig', errors='replace') as f:
        return f.readline().lower()


def _godot_project(folder: Path) -> Source:
    tables = [p for p in sorted(folder.rglob('*.csv')) if _first_line(p).startswith(('keys,', 'key,', 'id,'))]
    pos = sorted(p for p in folder.rglob('*.po*') if p.suffix.lower() in ('.po', '.pot'))
    if tables or pos:
        # The game looks its text up by key: use its own tables.
        rows, seen = [], set()
        for path in tables:
            for row in _godot_csv(path).rows:
                if row.key not in seen:
                    seen.add(row.key)
                    rows.append(row)
        for path in pos:
            for row in _po(path).rows:
                if row.key not in seen:
                    seen.add(row.key)
                    rows.append(row)
        return Source(rows, engine='godot', keyed=True, notes=[f'Read the game\'s translation tables ({len(tables) + len(pos)} files).'])
    # No tables: the English is written straight into scenes and scripts.
    rows, seen = [], set()
    for path in sorted(folder.rglob('*')):
        if path.suffix.lower() in ('.tscn', '.tres'):
            found = (m.group(1) for m in _GODOT_TEXT_PROPERTY.finditer(path.read_text(encoding='utf-8', errors='replace')))
        elif path.suffix.lower() == '.gd':
            found = (m.group(1) for m in _GODOT_TR_CALL.finditer(path.read_text(encoding='utf-8', errors='replace')))
        else:
            continue
        for text in found:
            text = _godot_unescape(text)
            if looks_like_text(text) and text not in seen:
                seen.add(text)
                rows.append(Row(text, None, path.relative_to(folder).as_posix()))
    if not rows:
        raise SourceError(f'Found no text in the Godot project {folder}.')
    return Source(rows, engine='godot', notes=['Godot text was read from scenes and tr() calls. Check translations.csv for lines that aren\'t game text.'])


# ---- Capcom RE Engine ----

def msg_dump_source(dumps: list) -> Source:
    """The English of RE Engine message dumps, keyed <natives path>#<guid>."""
    rows = []
    for dump in dumps:
        for guid, english in dump.english.items():
            if english and english.strip():
                rows.append(Row(english, dump.arabic.get(guid), f'{dump.in_pak}#{guid}'))
    return Source(rows, engine='reengine', msg_dumps=dumps)


def _reengine_folder(folder: Path) -> Source:
    """Files extracted from an RE Engine game's paks: natives/... with message dumps or .msg files."""
    files = sorted(p for p in folder.rglob('*') if p.is_file())
    try:
        dumps = [remsg.read_dump(p) for p in files if remsg.DUMP_FILE.search(p.name) and remsg.is_dump(p)]
    except remsg.MsgError as err:
        raise SourceError(str(err)) from None
    if dumps:
        source = msg_dump_source(dumps)
        source.notes.append(f'Read {len(dumps)} message dumps.')
        return source
    found = [(p, remsg.pak_path(p)) for p in files if remsg.MSG_FILE.search(p.name)]
    if not found:
        raise SourceError(f'Found no message files (.msg.<version>) or their dumps in {folder}.')
    return Source([], engine='reengine', msg_files=found)


def _game_folder(folder: Path) -> Source:
    if (folder / 're_chunk_000.pak').is_file():
        # An RE Engine game: its message files are taken out of its paks (base first, then each patch in order).
        patches = sorted((int(m.group(1)), p) for p in folder.iterdir()
                         if (m := re.match(r'^re_chunk_000\.pak\.patch_(\d{3,})\.pak$', p.name, re.I)))
        return Source([], engine='reengine', game_paks=[folder / 're_chunk_000.pak', *(p for _, p in patches)],
                      notes=['Reading the game\'s own paks. Turn Arabic off for this game in GameShelf first, '
                             'so its Arabic patch isn\'t read as the game\'s English.'])
    if folder.name.lower() == 'natives' or (folder / 'natives').is_dir():
        return _reengine_folder(folder)
    locres_files = sorted(folder.rglob('*.locres'))
    if locres_files:
        # The English: an "en" culture folder, the biggest file.
        english = [p for p in locres_files if p.parent.name.lower() in ('en', 'en-us', 'en-gb')] or locres_files
        best = max(english, key=lambda p: p.stat().st_size)
        relative = best.relative_to(folder).as_posix()
        source = _locres(best, relative)
        source.notes.append(f'Read {relative}.')
        return source
    if (folder / 'renpy').is_dir() and (folder / 'game').is_dir():
        return _renpy_folder(folder / 'game')
    if folder.name == 'game' and any(folder.glob('*.rp*')):
        return _renpy_folder(folder)
    if (folder / 'project.godot').is_file():
        return _godot_project(folder)
    data_dirs = [d for d in folder.iterdir() if d.is_dir() and d.name.endswith('_Data')]
    if data_dirs:
        assets = sorted(p for d in data_dirs for p in d.iterdir()
                        if p.is_file() and (p.suffix in ('.assets', '.bundle') or p.name == 'data.unity3d'))
        if not assets:
            raise SourceError(f'{data_dirs[0].name} has no .assets files to read.')
        return _unity(assets)
    if any(folder.glob('*.pck')):
        raise SourceError('This Godot game keeps its text inside its .pck file. Recover the project from your own copy '
                          '(with GDRE Tools) and run this on that folder, or give the game\'s translation CSV. Encrypted '
                          '.pck files need the game\'s own key, which this tool won\'t look for.')
    if (folder / 'Engine').is_dir() or any(folder.rglob('*.pak')):
        raise SourceError('This game keeps its text inside .pak files. Extract its English Game.locres from your own copy '
                          '(with UnrealPak or FModel), then run this on that file. Encrypted paks need the game\'s own key, '
                          'which this tool won\'t look for.')
    raise SourceError(f'Found no game text in {folder}. Give a .locres, Unity .assets, Ren\'Py .rpy/.rpa, CSV, .po, JSON or XUnity .txt file instead.')


def read_source(path: str | Path, *, locres_path: str | None = None, msg_path: str | None = None) -> Source:
    path = Path(path)
    if path.is_dir():
        return _game_folder(path)
    if not path.is_file():
        raise SourceError(f'{path} doesn\'t exist.')
    suffix = path.suffix.lower()
    if suffix in ('.json', '.csv') and remsg.is_dump(path):
        try:
            return msg_dump_source([remsg.read_dump(path, msg_path)])
        except remsg.MsgError as err:
            raise SourceError(str(err)) from None
    if remsg.MSG_FILE.search(path.name):
        try:
            return Source([], engine='reengine', msg_files=[(path, remsg.checked_pak_path(msg_path or remsg.pak_path(path) or ''))])
        except remsg.MsgError as err:
            raise SourceError(str(err)) from None
    if suffix == '.csv':
        first = _first_line(path)
        return _godot_csv(path) if first.startswith(('keys,', 'key,', 'id,')) and 'source' not in first else _csv(path)
    if suffix in ('.po', '.pot'):
        return _po(path)
    if suffix == '.rpy':
        return _renpy([(path.name, path.read_text(encoding='utf-8-sig', errors='replace'))])
    if suffix == '.rpa':
        return _renpy(sorted((name, data.decode('utf-8-sig', 'replace')) for name, data in read_rpa(path).items()))
    if suffix == '.json':
        return _json(path)
    if suffix == '.txt':
        return _xunity(path)
    if suffix == '.locres':
        return _locres(path, locres_path)
    if suffix in ('.assets', '.bundle', '.unity3d') or path.name == 'data.unity3d':
        return _unity([path])
    raise SourceError(f'Can\'t read {path.name}: use a .locres, Unity .assets, Ren\'Py .rpy/.rpa, CSV, .po, JSON or XUnity .txt file.')
