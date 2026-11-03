"""Games whose English sits in plain files: the loose-file scanner.

Many games made with their own engines keep their text readable, in files
such as localization/en.json, lang/english.txt, data/text/strings_en.csv,
Localisation/English.xml or locale/en/messages.po. This finds those files in
the game's folder, reads the English out of them, and writes the same files
back with the Arabic in place of the English, in the same format, so the game
shows Arabic where it showed English. GameShelf replaces the files when Arabic
is turned on, keeps the originals aside, and puts them back when it's turned
off (desktop/localization/stager.js, replace mode).

Formats: JSON, CSV and TSV, XML, gettext .po and .mo, and line-based text
(key=value .txt, .ini, .cfg, .lang, .loc, YAML-style "key: value", Valve-style
"key" "value", Apple-style .strings, or one line of text per line).

Which files: ones in folders named for text (localization, lang, locale, i18n,
text, strings, dialog, subtitles...), or with an English marker in their path
(en, english, en_US...), that hold enough lines that read like text. Files
marked for another language are left alone, and in tables with a column per
language only the English column changes.

Message tables in games' own binary formats are read and written natively too:
FromSoftware .fmg (and .msgbnd/.dcx binders of them, fromsoft.py), Rockstar
.gxt2 (rage.py), and Capcom MT Framework .gmd (and .arc archives of them,
mtframework.py); each comes back in its own format.

Loose font files in the game's fonts folders (.ttf, .otf) can be swapped for
IBM Plex Sans Arabic too, keeping their names, so the game draws the Arabic
letters; icon and symbol fonts are left alone.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

TEXT_EXTENSIONS = {'.json', '.csv', '.tsv', '.xml', '.po', '.mo', '.txt', '.ini', '.cfg', '.lang', '.loc', '.yaml', '.yml', '.strings',
                   '.fmg', '.msgbnd', '.dcx', '.gxt2', '.gmd', '.arc'}
BINARY_TEXT = {'.fmg', '.msgbnd', '.dcx', '.gxt2', '.gmd', '.arc'}
FONT_EXTENSIONS = {'.ttf', '.otf'}
TEXT_DIRS = {'localization', 'localisation', 'locale', 'locales', 'lang', 'langs', 'language', 'languages', 'i18n', 'l10n',
             'loc', 'text', 'texts', 'strings', 'string', 'dialog', 'dialogs', 'dialogue', 'dialogues', 'subtitles', 'subs',
             'translation', 'translations', 'messages', 'msg', 'message'}
WEAK_DIRS = {'data', 'content', 'assets', 'resources', 'res', 'gamedata', 'game'}
FONT_DIRS = {'font', 'fonts', 'typeface', 'typefaces'}
SKIP_DIRS = {'_commonredist', 'redist', 'redistributables', 'directx', 'vcredist', '.git', 'crashreporter', 'crashpad',
             'easyanticheat', 'battleye', 'licenses', 'license', 'legal', 'eula', 'manual', 'docs', 'mono', 'monobleedingedge',
             'jre', 'java', 'python', 'node_modules', 'saves', 'savegames', 'logs', 'shadercache', 'gameshelf_arabic'}
ENGLISH_CODES = {'en', 'eng', 'english', 'en_us', 'en-us', 'enus', 'en_gb', 'en-gb', 'engb', 'en_uk', 'en-uk', 'us', 'default',
                 'engus', 'american'}
OTHER_CODES = {
    'fr', 'fra', 'fre', 'french', 'de', 'deu', 'ger', 'german', 'es', 'esp', 'spa', 'spanish', 'es_mx', 'es-mx', 'mx',
    'it', 'ita', 'italian', 'pt', 'por', 'portuguese', 'pt_br', 'pt-br', 'ptbr', 'br', 'brazilian', 'ru', 'rus', 'russian',
    'pl', 'pol', 'polish', 'ja', 'jp', 'jpn', 'japanese', 'ko', 'kr', 'kor', 'korean', 'zh', 'cn', 'chs', 'cht', 'zh_cn',
    'zh-cn', 'zh_tw', 'zh-tw', 'zh-hans', 'zh-hant', 'chinese', 'schinese', 'tchinese', 'tr', 'tur', 'turkish', 'ar',
    'ara', 'arabic', 'nl', 'dutch', 'sv', 'swedish', 'da', 'danish', 'no', 'nb', 'norwegian', 'fi', 'finnish', 'cs', 'cz',
    'czech', 'hu', 'hungarian', 'ro', 'romanian', 'uk', 'ua', 'ukrainian', 'el', 'greek', 'th', 'thai', 'vi', 'vietnamese',
    'id', 'indonesian', 'he', 'hebrew', 'bg', 'bulgarian', 'latam',
    # FromSoftware's msg/<language> folders, Rockstar's language names
    'jpnjp', 'frafr', 'deude', 'itait', 'spaes', 'spaar', 'polpl', 'porbr', 'rusru', 'korkr', 'zhotw', 'zhocn', 'thath', 'araae',
    'engbr', 'mexican', 'chinesesimp', 'tur',
}
ALL_CODES = ENGLISH_CODES | OTHER_CODES
# Codes that are also ordinary words or abbreviations in file names ("item_id", "no_save"): only a whole name counts.
WEAK_CODES = {'id', 'no', 'it', 'us', 'uk', 'th', 'default', 'br', 'mx', 'da', 'el', 'he', 'cs', 'cz', 'ua', 'kr', 'jp', 'cn'}
# What shaped Arabic (rtl.py's output) is written in: a sign that GameShelf's Arabic is in the game right now.
SHAPED_ARABIC = re.compile('[\uFB50-\uFDFF\uFE70-\uFEFC]')
ICON_FONT = re.compile(r'icon|symbol|glyph|emoji|awesome|material|button|controller|gamepad|keyboard|dingbat|wingding|mono|code', re.I)
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_FILES_SEEN = 60000
MAX_DEPTH = 9
MIN_LINES = 3
MAX_FONTS = 24

_LETTERS = re.compile(r'[^\W\d_]')
_IDENTIFIER = re.compile(r'^[\w.\-/\\:#@$%{}\[\]]+$')
_PLACEHOLDER_ONLY = re.compile(r'^(?:\s|\{[^}]*\}|%\w|<[^>]*>|\$\w+|\[[^\]]*\])*$')


class LooseError(ValueError):
    pass


def looks_like_text(value: str) -> bool:
    """A string a player reads, rather than a key, a path or a number."""
    text = value.strip()
    if not 2 <= len(text) <= 4000 or not _LETTERS.search(text) or _PLACEHOLDER_ONLY.match(text):
        return False
    if '://' in text or text.startswith(('{"', '<?xml', 'res://', 'Assets/')):
        return False
    if re.search(r'\.(png|jpe?g|dds|tga|wav|ogg|mp3|wem|bank|json|xml|txt|ttf|otf|mat|prefab|mesh|fbx|anim)\b', text, re.I) and ' ' not in text:
        return False
    if ' ' not in text:
        # One word: "Continue", "Options", "OK!" read like text; "menu_start", "btnOk", "ITEM_SWORD" don't.
        return bool(re.fullmatch(r"[A-Z][a-z'\u00C0-\u024F]+[!?.:]?|[A-Z]{2,3}[!?.]?", text))
    return not _IDENTIFIER.match(text)


def _tokens(part: str) -> set:
    return {t for t in re.split(r'[_\-.\s]+', part.lower()) if t} | {part.lower()}


def language_marks(part: str) -> set:
    """The language codes a folder or file name carries: "fr", "strings_fr", "French", "en_US", "zh-Hans"."""
    name = part.lower()
    tokens = [t for t in re.split(r'[_\-.\s]+', name) if t]
    marks = {name} & ALL_CODES
    marks |= {t for t in tokens if len(t) > 3 and t in ALL_CODES}
    if len(tokens) > 1:
        for edge in (tokens[0], tokens[-1], '_'.join(tokens[-2:])):
            if edge in ALL_CODES and edge not in WEAK_CODES:
                marks.add(edge)
    return marks - {'default'}


def language_of(rel: PurePosixPath) -> str | None:
    """'en' when a file's path marks it English, 'other' for another language, else None."""
    marks = set()
    for part in list(rel.parts[:-1]) + [rel.stem]:
        marks |= language_marks(part)
    if marks & ENGLISH_CODES:
        return 'en'
    return 'other' if marks & OTHER_CODES else None


# ---- Reading and writing text in the file's own encoding ----------------------

@dataclass
class Encoded:
    text: str
    encoding: str
    bom: bytes
    newline: str


def decode(data: bytes) -> Encoded:
    for bom, encoding in ((b'\xef\xbb\xbf', 'utf-8'), (b'\xff\xfe', 'utf-16-le'), (b'\xfe\xff', 'utf-16-be')):
        if data.startswith(bom):
            text = data[len(bom):].decode(encoding, errors='replace')
            return Encoded(text, encoding, bom, '\r\n' if '\r\n' in text else '\n')
    try:
        text = data.decode('utf-8')
        encoding = 'utf-8'
    except UnicodeDecodeError:
        # Arabic can't be written in Windows-1252, so these files come back as UTF-8.
        text = data.decode('cp1252', errors='replace')
        encoding = 'utf-8'
    return Encoded(text, encoding, b'', '\r\n' if '\r\n' in text else '\n')


def encode(original: Encoded, text: str) -> bytes:
    return original.bom + text.encode(original.encoding)


@dataclass
class TextFile:
    """One file's English: entries [(key, English)], and how to write it back with {key: Arabic}."""
    path: Path
    rel: str
    fmt: str
    entries: list
    writer: object
    breaks: bool = True  # whether a line break can go inside a line of this file

    def write(self, arabic: dict) -> bytes:
        return self.writer(arabic)


# ---- JSON -------------------------------------------------------------------

def _json_walk(value, path=()):
    if isinstance(value, dict):
        keys = {str(k).lower(): k for k in value}
        langs = [k for k in keys if k in ALL_CODES and k not in WEAK_CODES]
        english = [keys[k] for k in langs if k in ENGLISH_CODES]
        if len(langs) >= 2 and english:
            # {"en": "Start", "fr": "Démarrer"}: only the English one.
            yield from _json_walk(value[english[0]], path + (english[0],))
            return
        for key, inner in value.items():
            if str(key).lower() in langs and len(langs) >= 2:
                continue
            yield from _json_walk(inner, path + (key,))
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            yield from _json_walk(inner, path + (index,))
    elif isinstance(value, str) and looks_like_text(value):
        yield path, value


def read_json(path: Path, rel: str, data: bytes) -> TextFile | None:
    raw = decode(data)
    try:
        doc = json.loads(raw.text)
    except ValueError:
        return None
    found = list(_json_walk(doc))
    keys = {json.dumps(p): p for p, _ in found}
    indent = None
    match = re.search(r'\n([ \t]+)\S', raw.text)
    if match:
        indent = '\t' if match.group(1).startswith('\t') else len(match.group(1))
    compact = indent is None and not re.search(r'[,:] ', raw.text[:4000])

    def writer(arabic):
        out = json.loads(raw.text)
        for key, text in arabic.items():
            target = out
            path_ = keys[key]
            for step in path_[:-1]:
                target = target[step]
            target[path_[-1]] = text
        body = json.dumps(out, ensure_ascii=False, indent=indent, separators=(',', ':') if compact else None)
        return encode(raw, body.replace('\n', raw.newline) + (raw.newline if raw.text.endswith(('\n', '\r\n')) else ''))
    return TextFile(path, rel, 'json', [(json.dumps(p), v) for p, v in found], writer)


# ---- CSV and TSV --------------------------------------------------------------

_TEXT_COLUMNS = ('text', 'value', 'string', 'translation', 'source', 'default', 'message', 'content', 'line', 'dialogue', 'subtitle')


def _english_column(header: list) -> int | None:
    names = [h.strip().lower() for h in header]
    for i, name in enumerate(names):
        if language_marks(name) & ENGLISH_CODES:
            return i
    if any(language_marks(n) & OTHER_CODES - WEAK_CODES for n in names):
        return None  # a column per language, none of them English
    for i, name in enumerate(names):
        if name in _TEXT_COLUMNS:
            return i
    return None


def read_csv(path: Path, rel: str, data: bytes, delimiter: str | None = None) -> TextFile | None:
    raw = decode(data)
    first = raw.text.split('\n', 1)[0]
    if delimiter is None:
        delimiter = max([',', ';', '\t', '|'], key=first.count)
        if not first.count(delimiter):
            return None
    rows = list(csv.reader(io.StringIO(raw.text, newline=''), delimiter=delimiter))
    if len(rows) < 2:
        return None
    column = _english_column(rows[0])
    start = 1
    if column is None:
        widths = {len(r) for r in rows if r}
        if widths == {2}:
            column = 1  # key,text without a header line
            start = 0 if looks_like_text(rows[0][1]) else 1
        else:
            return None
    entries = [(str(i), r[column]) for i, r in enumerate(rows) if i >= start and len(r) > column and looks_like_text(r[column])]
    quoted = raw.text.count('"') >= sum(len(r) for r in rows[:50]) * 1.5

    def writer(arabic):
        out = io.StringIO(newline='')
        sheet = csv.writer(out, delimiter=delimiter, lineterminator=raw.newline, quoting=csv.QUOTE_ALL if quoted else csv.QUOTE_MINIMAL)
        for i, row in enumerate(rows):
            if str(i) in arabic:
                row = list(row)
                row[column] = arabic[str(i)]
            sheet.writerow(row)
        return encode(raw, out.getvalue())
    return TextFile(path, rel, 'tsv' if delimiter == '\t' else 'csv', entries, writer)


# ---- XML --------------------------------------------------------------------

_XML_TOKEN = re.compile(r'(<!--.*?-->)|(<!\[CDATA\[(.*?)\]\]>)|(<\?.*?\?>)|(<![^>]*>)|(<[^>]+>)|([^<]+)', re.S)
_XML_ATTR = re.compile(r'([\w:.\-]+)(\s*=\s*)("([^"]*)"|\'([^\']*)\')')
_TEXT_ATTRS = {'text', 'value', 'string', 'label', 'caption', 'title', 'tooltip', 'description', 'desc', 'content', 'message',
               'msg', 'line', 'subtitle', 'translation', 'en', 'english'}
_LANG_ATTRS = {'lang', 'language', 'xml:lang', 'locale', 'culture'}
_ENTITIES = {'&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'"}


def _xml_unescape(text: str) -> str:
    def entity(m):
        name = m.group(0)
        if name in _ENTITIES:
            return _ENTITIES[name]
        try:
            return chr(int(name[3:-1], 16) if name[2] in 'xX' else int(name[2:-1]))
        except ValueError:
            return name
    return re.sub(r'&(?:lt|gt|amp|quot|apos|#\d+|#[xX][0-9a-fA-F]+);', entity, text)


def _xml_escape(text: str, quote: str = '') -> str:
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return text.replace(quote, '&quot;' if quote == '"' else '&apos;') if quote else text


def read_xml(path: Path, rel: str, data: bytes) -> TextFile | None:
    raw = decode(data)
    if '<' not in raw.text[:2000]:
        return None
    tokens = [m for m in _XML_TOKEN.finditer(raw.text)]
    entries, stack = [], []  # stack: (element name, skip: another language)
    places = {}  # key -> (token index, attribute name or None)
    for index, m in enumerate(tokens):
        if m.group(6):
            tag = m.group(6)
            name = re.match(r'</?\s*([\w:.\-]+)', tag)
            if not name:
                continue
            element = name.group(1).lower()
            if tag.startswith('</'):
                while stack and stack.pop()[0] != element:
                    pass
                continue
            attrs = {a.group(1).lower(): (a.group(4) if a.group(4) is not None else a.group(5)) for a in _XML_ATTR.finditer(tag)}
            lang = next((attrs[a].lower() for a in _LANG_ATTRS if a in attrs), None)
            inherited = bool(stack and stack[-1][1])
            skip = inherited or element in OTHER_CODES or bool(lang and lang not in ENGLISH_CODES and lang.split('-')[0] not in ('en',))
            if not skip:
                for attr in _XML_ATTR.finditer(tag):
                    value = attr.group(4) if attr.group(4) is not None else attr.group(5)
                    if attr.group(1).lower() in _TEXT_ATTRS and looks_like_text(_xml_unescape(value)):
                        key = f'{index}@{attr.group(1)}'
                        places[key] = (index, attr.group(1))
                        entries.append((key, _xml_unescape(value)))
            if not tag.rstrip().endswith('/>'):
                stack.append((element, skip))
        elif (m.group(7) or m.group(2)) and not (stack and stack[-1][1]):
            text = m.group(3) if m.group(2) else _xml_unescape(m.group(7))
            if looks_like_text(text):
                key = str(index)
                places[key] = (index, None)
                entries.append((key, text.strip()))

    def writer(arabic):
        parts = [m.group(0) for m in tokens]
        for key, text in arabic.items():
            index, attr = places[key]
            m = tokens[index]
            if attr is None and m.group(2):
                parts[index] = f'<![CDATA[{text.replace("]]>", "]]&gt;")}]]>'
            elif attr is None:
                original = m.group(7)
                lead = original[:len(original) - len(original.lstrip())]
                trail = original[len(original.rstrip()):]
                parts[index] = lead + _xml_escape(text) + trail
            else:
                def swap(a):
                    if a.group(1) != attr:
                        return a.group(0)
                    quote = '"' if a.group(4) is not None else "'"
                    return f'{a.group(1)}{a.group(2)}{quote}{_xml_escape(text, quote)}{quote}'
                parts[index] = _XML_ATTR.sub(swap, parts[index])
        return encode(raw, ''.join(parts))
    return TextFile(path, rel, 'xml', entries, writer)


# ---- gettext .po and .mo -------------------------------------------------------

def _po_quote(text: str) -> str:
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t') + '"'


def _po_unquote(line: str) -> str:
    return json.loads(line) if line.startswith('"') else ''


def read_po(path: Path, rel: str, data: bytes) -> TextFile | None:
    raw = decode(data)
    lines = raw.text.splitlines()
    blocks, current = [], []
    for number, line in enumerate(lines):
        if line.strip():
            current.append(number)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    entries, places = [], {}
    for block in blocks:
        fields, last = {}, None
        for number in block:
            stripped = lines[number].strip()
            if stripped.startswith('#'):
                continue
            m = re.match(r'^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")$', stripped)
            if m:
                last = m.group(1)
                fields.setdefault(last, []).append((number, m.group(2)))
            elif stripped.startswith('"') and last:
                fields[last].append((number, stripped))
        try:
            msgid = ''.join(_po_unquote(v) for _, v in fields.get('msgid', []))
            msgstr_key = 'msgstr' if 'msgstr' in fields else 'msgstr[0]'
            msgstr = ''.join(_po_unquote(v) for _, v in fields.get(msgstr_key, []))
        except ValueError:
            return None
        if not msgid:
            continue  # the header
        english = msgstr or msgid
        if looks_like_text(english):
            key = str(block[0])
            places[key] = ([k for k in fields if k.startswith('msgstr')], fields)
            entries.append((key, english))
    if not entries:
        return None

    def writer(arabic):
        out = list(lines)
        drop = set()
        for key, text in arabic.items():
            names, fields = places[key]
            for name in names or ['msgstr']:
                numbers = [n for n, _ in fields.get(name, [])]
                if not numbers:
                    continue
                indent = out[numbers[0]][:len(out[numbers[0]]) - len(out[numbers[0]].lstrip())]
                out[numbers[0]] = f'{indent}{name} {_po_quote(text)}'
                drop.update(numbers[1:])
        body = raw.newline.join(line for n, line in enumerate(out) if n not in drop)
        return encode(raw, body + (raw.newline if raw.text.endswith(('\n', '\r\n')) else ''))
    return TextFile(path, rel, 'po', entries, writer)


def read_mo(path: Path, rel: str, data: bytes) -> TextFile | None:
    if len(data) < 28:
        return None
    magic = struct.unpack_from('<I', data)[0]
    order = '<' if magic == 0x950412DE else '>' if magic == 0xDE120495 else None
    if not order:
        return None
    try:
        _, count, originals_at, translations_at = struct.unpack_from(order + '4I', data, 4)
        pairs = []
        for i in range(count):
            olen, ooff = struct.unpack_from(order + '2I', data, originals_at + 8 * i)
            tlen, toff = struct.unpack_from(order + '2I', data, translations_at + 8 * i)
            pairs.append([data[ooff:ooff + olen], data[toff:toff + tlen]])
    except struct.error:
        return None
    entries = []
    for i, (original, translated) in enumerate(pairs):
        if not original:
            continue
        english = (translated or original).split(b'\0')[0].decode('utf-8', errors='replace')
        if b'\x04' in original and not translated:
            english = english.split('\x04', 1)[-1]
        if looks_like_text(english):
            entries.append((str(i), english))

    def writer(arabic):
        items = []
        for i, (original, translated) in enumerate(pairs):
            if str(i) in arabic:
                plural = original.count(b'\0')
                translated = b'\0'.join([arabic[str(i)].encode('utf-8')] * (plural + 1))
            elif not original:
                translated = re.sub(rb'charset=[\w\-]+', b'charset=UTF-8', translated)
            items.append((original, translated))
        head = 28
        originals_table = head
        translations_table = originals_table + 8 * len(items)
        at = translations_table + 8 * len(items)
        blob, otable, ttable = bytearray(), bytearray(), bytearray()
        for original, _ in items:
            otable += struct.pack('<2I', len(original), at + len(blob))
            blob += original + b'\0'
        for _, translated in items:
            ttable += struct.pack('<2I', len(translated), at + len(blob))
            blob += translated + b'\0'
        return struct.pack('<7I', 0x950412DE, 0, len(items), originals_table, translations_table, 0, at) + otable + ttable + blob
    return TextFile(path, rel, 'mo', entries, writer)


# ---- Line-based text: key=value, key: value, "key" "value", or plain lines ------

_KV = re.compile(r'^(?P<lead>\s*)(?P<key>[^\s=:#;"\'/\[][^=:]*?|"[^"]+")(?P<sep>\s*[=:]\s*)(?P<value>.*?)(?P<tail>\s*)$')
_VALVE = re.compile(r'^(?P<lead>\s*)(?P<key>"[^"]+")(?P<sep>\s+)(?P<value>"(?:[^"\\]|\\.)*")(?P<tail>.*)$')
_APPLE = re.compile(r'^(?P<lead>\s*)(?P<key>"(?:[^"\\]|\\.)*")(?P<sep>\s*=\s*)(?P<value>"(?:[^"\\]|\\.)*")(?P<tail>\s*;.*)$')
_COMMENT = re.compile(r'^\s*(?:#|;|//|--|\[[^\]]*\]\s*$)')
# Lines that only hold a file's structure: braces, or a lone quoted name ("lang", "Tokens" in Valve files).
_STRUCTURE = re.compile(r'^\s*(?:[{}()\[\]]|"[^"]*")\s*[,;]?\s*$')


def _unquote(value: str) -> tuple:
    """(text, quote character or '') for a value that may be quoted, with C-style escapes."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
        inner = value[1:-1]
        return re.sub(r'\\(["\'\\])', r'\1', inner), value[0]
    return value, ''


def _quote(text: str, quote: str) -> str:
    if not quote:
        return text.replace('\n', '\\n')
    return quote + text.replace('\\', '\\\\').replace(quote, '\\' + quote).replace('\n', '\\n') + quote


def read_lines(path: Path, rel: str, data: bytes) -> TextFile | None:
    raw = decode(data)
    lines = raw.text.splitlines()
    content = [n for n, line in enumerate(lines) if line.strip() and not _COMMENT.match(line) and not _STRUCTURE.match(line)]
    if not content:
        return None
    parsed = {}
    for n in content:
        line = lines[n]
        m = _APPLE.match(line) or _VALVE.match(line) or _KV.match(line)
        if m:
            parsed[n] = m
    keyed = len(parsed) >= 0.6 * len(content)
    entries, places = [], {}
    for n in content:
        if keyed:
            m = parsed.get(n)
            if not m:
                continue
            text, quote = _unquote(m.group('value'))
            if looks_like_text(text):
                places[str(n)] = (m, quote)
                entries.append((str(n), text))
        elif looks_like_text(lines[n]) and not parsed.get(n):
            places[str(n)] = (None, '')
            entries.append((str(n), lines[n].strip()))

    def writer(arabic):
        out = list(lines)
        for key, text in arabic.items():
            m, quote = places[key]
            n = int(key)
            if m is None:
                lead = out[n][:len(out[n]) - len(out[n].lstrip())]
                out[n] = lead + text.replace('\n', ' ')
            else:
                out[n] = f'{m.group("lead")}{m.group("key")}{m.group("sep")}{_quote(text, quote)}{m.group("tail")}'
        return encode(raw, raw.newline.join(out) + (raw.newline if raw.text.endswith(('\n', '\r\n')) else ''))
    return TextFile(path, rel, 'lines', entries, writer, breaks=False)


# ---- Message tables in games' own binary formats ------------------------------------------

def _binary_entries(tables: dict, items) -> list:
    entries = []
    for table, pairs in tables.items():
        for place, text in items(pairs):
            if text and looks_like_text(text):
                entries.append((f'{table}#{place}', text))
    return entries


def read_fromsoft(path: Path, rel: str, data: bytes) -> TextFile | None:
    """A FromSoftware .fmg, .msgbnd or .dcx of them."""
    from . import fromsoft
    if not (data[:4] in (b'DCX\0', b'BND4') or data[:1] == b'\0'):
        return None
    try:
        found = fromsoft.read_messages(data, path)
    except fromsoft.FromSoftError:
        return None
    entries = _binary_entries(found.tables, lambda fmg: fmg.entries.items())

    def writer(arabic):
        changed = {}
        for key, text in arabic.items():
            table, _, place = key.rpartition('#')
            fmg = found.tables.get(table)
            if fmg is None or not place.lstrip('-').isdigit():
                continue
            if table not in changed:
                changed[table] = fromsoft.Fmg(fmg.version, fmg.big_endian, dict(fmg.entries))
            changed[table].entries[int(place)] = text
        return found.rebuild(changed)
    return TextFile(path, rel, 'fmg', entries, writer)


def read_gxt2(path: Path, rel: str, data: bytes) -> TextFile | None:
    from . import rage
    try:
        strings = rage.read_gxt2(data)
    except rage.RageError:
        return None
    entries = [(f'{h:08X}', text) for h, text in strings.items() if looks_like_text(text)]

    def writer(arabic):
        out = dict(strings)
        for key, text in arabic.items():
            out[int(key, 16)] = text
        return rage.write_gxt2(out)
    return TextFile(path, rel, 'gxt2', entries, writer)


def read_mt(path: Path, rel: str, data: bytes) -> TextFile | None:
    """A Capcom MT Framework .gmd, or an .arc archive's .gmd tables."""
    from . import mtframework
    if data[:4] not in (b'GMD\0', b'ARC\0'):
        return None
    try:
        found = mtframework.read_messages(data)
    except mtframework.MtError:
        return None
    entries = _binary_entries(found.tables, lambda gmd: enumerate(gmd.strings))

    def writer(arabic):
        changed = {}
        for key, text in arabic.items():
            table, _, place = key.rpartition('#')
            if table in found.tables and place.isdigit():
                changed.setdefault(table, list(found.tables[table].strings))[int(place)] = text
        return found.rebuild(changed)
    return TextFile(path, rel, 'gmd', entries, writer)


READERS = {'.json': read_json, '.csv': read_csv, '.tsv': lambda p, r, d: read_csv(p, r, d, '\t'), '.xml': read_xml,
           '.po': read_po, '.mo': read_mo, '.fmg': read_fromsoft, '.msgbnd': read_fromsoft, '.dcx': read_fromsoft,
           '.gxt2': read_gxt2, '.gmd': read_mt, '.arc': read_mt}
FORMATS = {'json': read_json, 'csv': read_csv, 'tsv': READERS['.tsv'], 'xml': read_xml, 'po': read_po, 'mo': read_mo,
           'lines': read_lines, 'txt': read_lines, 'ini': read_lines, 'fmg': read_fromsoft, 'gxt2': read_gxt2, 'gmd': read_mt}


def read_file(path: Path, rel: str | None = None, fmt: str | None = None) -> TextFile | None:
    """A file's English, by its format (`fmt`, or from its extension), or None when it holds none."""
    rel = rel or path.name
    data = path.read_bytes()
    reader = FORMATS.get(fmt) if fmt else READERS.get(path.suffix.lower(), read_lines)
    if reader is None:
        raise LooseError(f'GameShelf can\'t read "{fmt}" files.')
    try:
        found = reader(path, rel, data)
    except (ValueError, csv.Error, UnicodeError, RecursionError, struct.error, IndexError, zlib.error):
        return None
    return found if found and found.entries else None


# ---- Finding a game's text ----------------------------------------------------

def _walk(root: Path):
    """Files under `root` (not following links), at most MAX_DEPTH folders down."""
    seen = 0
    stack = [(root, 0)]
    while stack:
        folder, depth = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name.lower())
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if seen > MAX_FILES_SEEN:
                return
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if depth < MAX_DEPTH and entry.name.lower() not in SKIP_DIRS:
                    stack.append((Path(entry.path), depth + 1))
            elif entry.is_file():
                yield Path(entry.path)


@dataclass
class Found:
    files: list    # TextFile
    fonts: list    # paths of the game's loose fonts, relative to the game folder
    looked: int    # how many candidate files were read


def candidates(root: Path) -> list:
    """Files that could hold the game's English, best first: [(score, path, rel)]."""
    out = []
    for path in _walk(root):
        suffix = path.suffix.lower()
        if suffix not in TEXT_EXTENSIONS:
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES or path.stat().st_size < 8:
                continue
        except OSError:
            continue
        rel = PurePosixPath(path.relative_to(root).as_posix())
        dirs = {p.lower() for p in rel.parts[:-1]}
        language = language_of(rel)
        if language == 'other':
            continue
        text_dir = bool(dirs & TEXT_DIRS) or bool(_tokens(rel.stem) & {'strings', 'localization', 'localisation', 'lang', 'text', 'dialog', 'dialogue', 'subtitles'})
        weak_dir = bool(dirs & WEAK_DIRS)
        score = (3 if language == 'en' else 0) + (2 if text_dir else 0) + (1 if weak_dir else 0) + (1 if suffix in ('.po', '.mo', '.loc', '.lang', '.strings') else 0)
        if language == 'en' or text_dir:
            out.append((score, path, str(rel)))
    out.sort(key=lambda c: (-c[0], c[2]))
    return out


def _has_language_siblings(path: Path) -> bool:
    """Whether a file's folder (or its parent) has files or folders for other languages."""
    for folder in (path.parent, path.parent.parent):
        try:
            names = [p.stem.lower() for p in folder.iterdir()]
        except OSError:
            continue
        if sum(1 for n in names if language_marks(n) & OTHER_CODES) >= 2:
            return True
    return False


def scan(root: Path, max_read: int = 400) -> Found:
    """The game's English text files (with enough lines that read like text) and its loose fonts."""
    root = Path(root)
    files, looked, shaped = [], 0, 0
    for _, path, rel in candidates(root):
        if looked >= max_read:
            break
        looked += 1
        if language_of(PurePosixPath(rel)) != 'en' and path.suffix.lower() not in ('.csv', '.tsv', '.xml', '.json') and _has_language_siblings(path):
            continue  # one language's file among others', and not marked English
        found = read_file(path, rel)
        if not found or len(found.entries) < MIN_LINES:
            continue
        if sum(1 for _, text in found.entries if SHAPED_ARABIC.search(text)) * 2 > len(found.entries):
            shaped += 1
            continue
        files.append(found)
    if shaped and not files:
        raise LooseError('GameShelf\'s Arabic is in this game right now. Turn Arabic off for it in GameShelf first, so the English is read.')
    return Found(files, find_fonts(root, files) if files else [], looked)


def find_fonts(root: Path, files: list) -> list:
    """The game's loose text fonts: .ttf and .otf files in a fonts folder, or beside its text files."""
    text_dirs = {Path(f.path).parent for f in files}
    fonts = []
    for path in _walk(root):
        if path.suffix.lower() not in FONT_EXTENSIONS or ICON_FONT.search(path.stem):
            continue
        rel = PurePosixPath(path.relative_to(root).as_posix())
        if {p.lower() for p in rel.parts[:-1]} & FONT_DIRS or path.parent in text_dirs:
            fonts.append(str(rel))
        if len(fonts) >= MAX_FONTS:
            break
    return sorted(fonts)
