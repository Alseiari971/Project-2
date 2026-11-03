"""Compiled Ren'Py games: the text in .rpa archives and .rpyc scripts, read
without running anything from them.

Ren'Py (MIT, renpy.org) keeps a game's scripts compiled, as a zlib-compressed
pickle of its parsed statements (renpy.ast), in two containers:

- "RENPY RPC2" files (Ren'Py 6.18 and later): a table of slots, each
  (uint32 slot, uint32 start, uint32 length), ending with slot 0; slot 1 holds
  the statements;
- older files: the zlib-compressed pickle on its own.

Unpickling normally makes the objects a pickle names, which means running
code: here every class a pickle names is an inert stand-in (_Node) that only
keeps what the pickle gives it, so nothing from the game ever runs. Only plain
containers (set, frozenset) and the constructor helper pickle itself uses
(copyreg._reconstructor) are real.

From the statements it takes:
- dialogue (renpy.ast.Say: what is said, and who says it),
- menu choices (renpy.ast.Menu items),
- speaker names, from `define x = Character("Name", ...)`,
- interface strings marked for translation in code, _("...") and __("..."),
and skips translations already in the game (Translate, TranslateString in tl/).

Archives (RPA-3.0 "RPA-3.0 <index offset> <key>", RPA-2.0 without a key): the
index is a zlib-compressed pickle {name: [(offset, length[, prefix])]}, offsets
and lengths XORed with the key; files are read as slices of the archive, which
is never changed. Their index holds only names and numbers, so any class in it
is refused.
"""

from __future__ import annotations

import ast as python_ast
import io
import pickle
import re
import struct
import zlib
from pathlib import Path

RPYC2 = b'RENPY RPC2'
MAX_INDEX = 64 * 1024 * 1024
MAX_SCRIPT = 256 * 1024 * 1024


class RenpyError(ValueError):
    pass


# ---- Archives ---------------------------------------------------------------------------

def _encode(text, encoding='latin1'):
    """_codecs.encode, as Python 3 pickles bytes at protocol 2: text to bytes, nothing more."""
    if not isinstance(text, str) or str(encoding).lower().replace('-', '') not in ('latin1', 'latin', 'iso88591', 'utf8', 'ascii'):
        raise pickle.UnpicklingError('unexpected _codecs.encode')
    return text.encode(encoding)


def _bytes(*args):
    """bytes(), as protocol 2 pickles empty bytes; never bytes(n), which would make n of them."""
    if not args:
        return b''
    if isinstance(args[0], str):
        return _encode(*args)
    if isinstance(args[0], (bytes, bytearray, list, tuple)) and len(args) == 1:
        return bytes(args[0])
    raise pickle.UnpicklingError('unexpected bytes()')


_INDEX_SAFE = {('_codecs', 'encode'): _encode, ('__builtin__', 'bytes'): _bytes, ('builtins', 'bytes'): _bytes}


class _IndexOnly(pickle.Unpickler):
    """An archive's index: names and numbers (and bytes), nothing else."""

    def find_class(self, module, name):
        if (module, name) in _INDEX_SAFE:
            return _INDEX_SAFE[(module, name)]
        raise RenpyError('This .rpa archive\'s index holds more than names and numbers, so it won\'t be read.')


def rpa_header(head: bytes):
    """(index offset, key) from an archive's first line, or None when it isn't RPA-2.0 or 3.0."""
    line = head.split(b'\n', 1)[0]
    parts = line.split()
    try:
        if parts[:1] == [b'RPA-3.0'] and len(parts) >= 3:
            return int(parts[1], 16), int(parts[2], 16)
        if parts[:1] == [b'RPA-2.0'] and len(parts) >= 2:
            return int(parts[1], 16), 0
    except ValueError:
        return None
    return None


def rpa_index(path: Path) -> dict:
    """{name: [(offset, length, prefix bytes)]}, de-obfuscated."""
    with Path(path).open('rb') as f:
        found = rpa_header(f.read(64))
        if not found:
            raise RenpyError(f'{Path(path).name} isn\'t a Ren\'Py archive GameShelf can read (RPA-2.0 or 3.0).')
        offset, key = found
        f.seek(offset)
        packed = f.read(MAX_INDEX + 1)
    if len(packed) > MAX_INDEX:
        raise RenpyError(f'{Path(path).name}\'s index is too big.')
    try:
        index = _IndexOnly(io.BytesIO(zlib.decompress(packed)), encoding='bytes').load()
    except (zlib.error, pickle.UnpicklingError, EOFError, ValueError, TypeError) as err:
        raise RenpyError(f'{Path(path).name}\'s index can\'t be read ({err}).') from None
    if not isinstance(index, dict):
        raise RenpyError(f'{Path(path).name}\'s index can\'t be read.')
    out = {}
    for name, parts in index.items():
        name = name.decode('utf-8', 'replace') if isinstance(name, bytes) else str(name)
        slices = []
        for part in parts:
            if not isinstance(part, (tuple, list)) or len(part) < 2 or not all(isinstance(n, int) for n in part[:2]):
                raise RenpyError(f'{Path(path).name}\'s index can\'t be read.')
            prefix = part[2] if len(part) > 2 else b''
            prefix = prefix.encode('latin-1') if isinstance(prefix, str) else (prefix or b'')
            slices.append((part[0] ^ key, part[1] ^ key, prefix))
        out[name.replace('\\', '/')] = slices
    return out


def read_rpa(path: Path, suffixes=('.rpy',)) -> dict:
    """The files in an archive whose names end with one of `suffixes`: {name: bytes}."""
    index = rpa_index(path)
    out = {}
    size = Path(path).stat().st_size
    with Path(path).open('rb') as f:
        for name, slices in index.items():
            if not name.lower().endswith(tuple(suffixes)):
                continue
            data = b''
            for start, length, prefix in slices:
                body = length - len(prefix)
                if start < 0 or body < 0 or start + body > size:
                    raise RenpyError(f'{name} in {Path(path).name} points outside the archive.')
                f.seek(start)
                data += prefix + f.read(body)
            out[name] = data
    return out


# ---- Compiled scripts -------------------------------------------------------------------

class _Node:
    """A stand-in for any class a compiled script names: it keeps what the pickle gives it, and does nothing."""
    kind = ''

    def __new__(cls, *args, **kwargs):
        return object.__new__(cls)

    def __init__(self, *args, **kwargs):
        self.__dict__['_args'] = args

    def __setstate__(self, state):
        if isinstance(state, tuple) and len(state) == 2 and (state[0] is None or isinstance(state[0], dict)) and isinstance(state[1], (dict, type(None))):
            for part in state:
                if part:
                    self._update(part)
        elif isinstance(state, dict):
            self._update(state)
        else:
            self.__dict__['_state'] = state

    def _update(self, values):
        for k, v in values.items():
            self.__dict__[k.decode('latin-1') if isinstance(k, bytes) else str(k)] = v

    # Lists and dicts Ren'Py subclasses (RevertableList...) are filled in by the pickle.
    def append(self, item):
        self.__dict__.setdefault('_items', []).append(item)

    def extend(self, items):
        for item in items:
            self.append(item)

    def __setitem__(self, key, value):
        self.__dict__.setdefault('_map', {})[key] = value

    def add(self, item):
        self.append(item)

    def __iter__(self):
        return iter(self.__dict__.get('_items') or ())

    def __len__(self):
        return len(self.__dict__.get('_items') or ())

    def __bool__(self):
        return True

    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        return None

    def __repr__(self):
        return f'<{self.kind}>'


def _reconstructor(cls, base, state):
    """copyreg._reconstructor, for stand-ins only."""
    if isinstance(cls, type) and issubclass(cls, _Node):
        return cls.__new__(cls)
    return _node_class('copyreg', '_reconstructor')()


_SAFE = {('builtins', 'set'): set, ('__builtin__', 'set'): set, ('builtins', 'frozenset'): frozenset,
         ('__builtin__', 'frozenset'): frozenset, ('copy_reg', '_reconstructor'): _reconstructor,
         ('copyreg', '_reconstructor'): _reconstructor, **_INDEX_SAFE}
_classes: dict = {}


def _node_class(module: str, name: str):
    key = f'{module}.{name}'
    cls = _classes.get(key)
    if cls is None:
        cls = type(name, (_Node,), {'kind': key, '__module__': '_gameshelf_stub'})
        _classes[key] = cls
    return cls


class _Stubbed(pickle.Unpickler):
    def find_class(self, module, name):
        safe = _SAFE.get((module, name))
        if safe is not None:
            return safe
        if module in ('builtins', '__builtin__') and name == 'object':
            return _node_class(module, name)
        return _node_class(module, name)

    # Persistent ids aren't used in scripts; refuse rather than guess.
    def persistent_load(self, pid):
        raise pickle.UnpicklingError('persistent ids')


def _decompress(data: bytes) -> bytes:
    out = zlib.decompressobj()
    raw = out.decompress(data, MAX_SCRIPT)
    if out.unconsumed_tail:
        raise RenpyError('The compiled script is too big.')
    return raw


def rpyc_payload(data: bytes) -> bytes:
    """The uncompressed pickle of a compiled script (RPYC2 slot 1, or an old file's whole body)."""
    if data.startswith(RPYC2):
        position = len(RPYC2)
        slots = {}
        while position + 12 <= len(data):
            slot, start, length = struct.unpack_from('<III', data, position)
            position += 12
            if slot == 0:
                break
            if start + length > len(data):
                raise RenpyError('The compiled script\'s slot table points outside it.')
            slots[slot] = data[start:start + length]
        for slot in (1, *sorted(s for s in slots if s != 1)):
            if slot in slots:
                try:
                    return _decompress(slots[slot])
                except zlib.error:
                    continue
        raise RenpyError('The compiled script has no readable statements.')
    try:
        return _decompress(data)
    except zlib.error:
        raise RenpyError('This isn\'t a compiled Ren\'Py script.') from None


def load_rpyc(data: bytes):
    """The statements of a compiled script, as stand-ins."""
    payload = rpyc_payload(data)
    try:
        loaded = _Stubbed(io.BytesIO(payload), encoding='utf-8', errors='surrogateescape').load()
    except RecursionError:
        raise RenpyError('The compiled script is nested too deeply to read.') from None
    except Exception as err:  # a damaged pickle can fail in many ways; none of them run anything
        raise RenpyError(f'The compiled script can\'t be read ({type(err).__name__}).') from None
    if isinstance(loaded, tuple) and len(loaded) == 2:
        loaded = loaded[1]
    return loaded


def _text(value):
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    if isinstance(value, str):
        return value
    if isinstance(value, _Node):
        # renpy.ast.PyExpr and friends are str subclasses, pickled as (str, (text, file, line)).
        args = value.__dict__.get('_args') or ()
        if args and isinstance(args[0], (str, bytes)):
            return _text(args[0])
        state = value.__dict__.get('_state')
        if isinstance(state, tuple):
            for part in state:
                found = _text(part)
                if found:
                    return found
        source = value.__dict__.get('source')
        if source is not None:
            return _text(source)
    return None


def _children(value):
    if isinstance(value, _Node):
        return list(value.__dict__.values())
    if isinstance(value, (list, tuple, set, frozenset)):
        return list(value)
    if isinstance(value, dict):
        return list(value.keys()) + list(value.values())
    return []


_MARKED = re.compile(r'(?<![\w.])__?\(\s*(?P<q>[ru]?(?:"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'))\s*\)')
_CHARACTER = re.compile(r'(?<![\w.])(?:Character|DynamicCharacter|ADVCharacter|NVLCharacter)\s*\(\s*(?P<q>[ru]?(?:"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'))')
_QUOTED_WHO = re.compile(r'^\s*[ru]?(?:"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')\s*$')


def _literal(code: str):
    try:
        value = python_ast.literal_eval(code.strip())
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return None
    return value if isinstance(value, str) else None


def _where(node):
    name = _text(node.__dict__.get('filename')) or ''
    line = node.__dict__.get('linenumber')
    return f'{name.replace(chr(92), "/").split("/")[-1]}:{line}' if isinstance(line, int) else name


def rpyc_strings(statements, name: str = 'script.rpyc') -> list:
    """[(kind, text, where)] for the text in compiled statements: kind is 'say', 'menu', 'who' or 'string'."""
    out = []
    seen_ids = set()
    stack = [(statements, False)]
    while stack:
        value, in_translation = stack.pop()
        if id(value) in seen_ids:
            continue
        seen_ids.add(id(value))
        if isinstance(value, _Node):
            kind = value.kind
            if kind in ('renpy.ast.TranslateString', 'renpy.ast.TranslateBlock', 'renpy.ast.TranslateEarlyBlock', 'renpy.ast.TranslatePython'):
                continue
            # A translation in the game's tl/ folder: its lines are another language's.
            translating = in_translation or (kind == 'renpy.ast.Translate' and _text(value.__dict__.get('language')) not in (None, ''))
            if kind == 'renpy.ast.Say' and not translating:
                what = _text(value.__dict__.get('what'))
                if what:
                    out.append(('say', what, _where(value) or name))
                who = _text(value.__dict__.get('who'))
                if who and _QUOTED_WHO.match(who):
                    literal = _literal(who)
                    if literal:
                        out.append(('who', literal, _where(value) or name))
            elif kind == 'renpy.ast.Menu' and not translating:
                for item in value.__dict__.get('items') or ():
                    label = _text(item[0]) if isinstance(item, (tuple, list)) and item else None
                    if label:
                        out.append(('menu', label, _where(value) or name))
            elif kind == 'renpy.ast.Define':
                code = _text(value.__dict__.get('code'))
                for match in _CHARACTER.finditer(code or ''):
                    literal = _literal(match.group('q'))
                    if literal:
                        out.append(('who', literal, _where(value) or name))
            for child in _children(value):
                stack.append((child, translating))
            continue
        text = _text(value) if isinstance(value, (str, bytes)) else None
        if text and ('_(' in text) and not in_translation:
            for match in _MARKED.finditer(text):
                literal = _literal(match.group('q'))
                if literal:
                    out.append(('string', literal, name))
        for child in _children(value):
            stack.append((child, in_translation))
    # The order the game has them in (statements are walked depth first, last first).
    out.sort(key=lambda item: _order(item[2]))
    return out


def _order(where: str):
    file, _, line = where.rpartition(':')
    return (file, int(line)) if line.isdigit() else (where, 0)


def read_rpyc(data: bytes, name: str = 'script.rpyc') -> list:
    return rpyc_strings(load_rpyc(data), name)


# ---- What Ren'Py loads: tl/arabic -------------------------------------------------------

def rpy_string(text: str) -> str:
    """A Ren'Py string literal for text, as Ren'Py's own translation files write them."""
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'
