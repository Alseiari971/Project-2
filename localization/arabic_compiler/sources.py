"""Where a game's English text comes from, for the pack builder.

- CSV with "source" (and optionally "arabic", "key") columns;
- JSON: [{"source": ..., "arabic": ..., "key": ...}] or {"key": "English"},
  nested objects flattened to dotted keys;
- XUnity.AutoTranslator text files ("English=translation" lines);
- Unreal .locres files (see locres.py);
- Unity asset files (.assets, .bundle, data.unity3d), with the UnityPy library;
- a game folder: loose .locres files, or a Unity game's data folder.

Text inside encrypted or packed game archives is out of reach on purpose:
extract it from your own copy with the engine's tools first. This never looks
for decryption keys.
"""

from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import locres as locres_format


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
    engine: str | None = None          # 'unreal' or 'unity' when the input says so
    locres: object = None              # the parsed .locres, for writing it back translated
    locres_path: str | None = None     # where it goes inside the game's pak, when known
    notes: list = field(default_factory=list)


def _csv(path: Path) -> Source:
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if 'source' not in (reader.fieldnames or []):
            raise SourceError(f'{path.name} needs a "source" column (and optionally "arabic" and "key").')
        return Source([Row(r['source'], (r.get('arabic') or '').strip() or None, r.get('key') or None) for r in reader if r['source']])


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


def _game_folder(folder: Path) -> Source:
    locres_files = sorted(folder.rglob('*.locres'))
    if locres_files:
        # The English: an "en" culture folder, the biggest file.
        english = [p for p in locres_files if p.parent.name.lower() in ('en', 'en-us', 'en-gb')] or locres_files
        best = max(english, key=lambda p: p.stat().st_size)
        relative = best.relative_to(folder).as_posix()
        source = _locres(best, relative)
        source.notes.append(f'Read {relative}.')
        return source
    data_dirs = [d for d in folder.iterdir() if d.is_dir() and d.name.endswith('_Data')]
    if data_dirs:
        assets = sorted(p for d in data_dirs for p in d.iterdir()
                        if p.is_file() and (p.suffix in ('.assets', '.bundle') or p.name == 'data.unity3d'))
        if not assets:
            raise SourceError(f'{data_dirs[0].name} has no .assets files to read.')
        return _unity(assets)
    if (folder / 'Engine').is_dir() or any(folder.rglob('*.pak')):
        raise SourceError('This game keeps its text inside .pak files. Extract its English Game.locres from your own copy '
                          '(with UnrealPak or FModel), then run this on that file. Encrypted paks need the game\'s own key, '
                          'which this tool won\'t look for.')
    raise SourceError(f'Found no game text in {folder}. Give a .locres, Unity .assets, CSV, JSON or XUnity .txt file instead.')


def read_source(path: str | Path, *, locres_path: str | None = None) -> Source:
    path = Path(path)
    if path.is_dir():
        return _game_folder(path)
    if not path.is_file():
        raise SourceError(f'{path} doesn\'t exist.')
    suffix = path.suffix.lower()
    if suffix == '.csv':
        return _csv(path)
    if suffix == '.json':
        return _json(path)
    if suffix == '.txt':
        return _xunity(path)
    if suffix == '.locres':
        return _locres(path, locres_path)
    if suffix in ('.assets', '.bundle', '.unity3d') or path.name == 'data.unity3d':
        return _unity([path])
    raise SourceError(f'Can\'t read {path.name}: use a .locres, Unity .assets, CSV, JSON or XUnity .txt file.')
