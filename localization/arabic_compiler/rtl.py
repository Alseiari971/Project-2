"""Arabic for game engines that can't shape or order it.

Most engines draw text left to right, one glyph per character, with no Arabic
shaping, so Arabic typed normally comes out as separate letters in reverse
(م ر ح ب ا). Given Arabic as typed (logical order, unjoined letters), this
returns the string such an engine has to be fed:

- every letter already in its joined form from Unicode Arabic Presentation
  Forms-B (U+FE70 to U+FEFF), so the joining is in the glyphs themselves;
- lines longer than ``max_line`` wrapped first, in reading order, and only then
  each line put in screen order on its own, so a two-line subtitle still reads
  top to bottom;
- the game's own markup left working: rich text tags (<color=#fff>...</color>,
  <b>, Unreal's </>), placeholders ({0}, %s, %1$s, %PLAYER%), key prompts ([E],
  [Press E]), inline icons (<sprite=3>) and line breaks (<br>, \\n).

Reordering follows the Unicode Bidirectional Algorithm: python-bidi resolves
each character's embedding level, then this module reverses the runs (rule L2)
and mirrors brackets in right-to-left runs (rule L4) itself, keeping track of
where every character goes. That map is what lets tags and placeholders come
back out exactly where they belong instead of being reversed with the text.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from arabic_reshaper import ArabicReshaper
from arabic_reshaper.ligatures import LIGATURES
from arabic_reshaper.reshaper_config import default_config
from bidi import get_display

try:  # python-bidi's full mirroring table
    from bidi.mirror import MIRRORED as _LIBRARY_MIRRORS
except ImportError:  # pragma: no cover - older layouts of the package
    _LIBRARY_MIRRORS = {}

FORMS_B = range(0xFE70, 0xFF00)
DEFAULT_MAX_LINE = 55

# Stand-ins used while shaping and reordering. A placeholder reads as a left to
# right word (Private Use characters are strong left-to-right); an inline icon
# reads as a neutral object.
_ATOM_LTR = ''
_ATOM_OBJECT = '￼'

_MIRRORS = {
    '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<',
    '«': '»', '»': '«', '‹': '›', '›': '‹',
    **_LIBRARY_MIRRORS,
}

# Rich text tags that stand alone instead of opening a styled span.
_VOID_TAGS = {'sprite', 'quad', 'space', 'pos', 'page', 'img', 'input', 'icon', 'nbsp'}

_ATTR_VALUE = r'''(?:"[^"]*"|'[^']*'|[^\s>"']+)'''
_TOKENS = re.compile(
    r'(?P<br><br\s*/?>|\r\n|\r|\n|\\n)'
    r'|(?P<tag></>|</?[A-Za-z][\w.\-]*(?:\s*=\s*' + _ATTR_VALUE + r')?'
    r'(?:\s+[A-Za-z][\w\-]*(?:\s*=\s*' + _ATTR_VALUE + r')?)*\s*/?>)'
    r'|(?P<ph>\{[A-Za-z0-9_.:,#\- ]{0,40}\}'          # {0} {name} {0:N2}
    r'|\$\{[A-Za-z0-9_.]{1,40}\}'                     # ${name}
    r'|%(?:\d+\$)?[-+#0]*(?:\d+|\*)?(?:\.\d+)?(?:hh|ll|[hlLqjzt])?[diouxXeEfFgGaAcspn@%]'  # printf
    r'|%[A-Z_][A-Z0-9_]*%'                            # %PLAYER%
    r'|\[[\x20-\x5A\x5C\x5E-\x7E]{1,40}\])'           # [E] [Press E], ASCII only
)
_TAG_NAME = re.compile(r'</?([A-Za-z][\w.\-]*)')


class UnshapedTextError(ValueError):
    """Raised in strict mode when a letter has no Presentation Forms-B glyph."""


@dataclass(frozen=True)
class _Atom:
    """A placeholder or inline icon: copied out exactly, never shaped or mirrored."""

    raw: str
    width: int


@dataclass(frozen=True)
class _Unit:
    """One character on its way to the screen, with the tags styling it."""

    ch: str
    style: tuple = ()          # ((name, opening tag), ...) from outermost in
    atom: _Atom | None = None

    @property
    def width(self) -> int:
        if self.atom is not None:
            return self.atom.width
        return 0 if unicodedata.combining(self.ch) or unicodedata.category(self.ch) in ('Mn', 'Me', 'Cf') else 1


@dataclass
class _Paragraph:
    chars: list = field(default_factory=list)    # text to shape, with atoms as stand-ins
    styles: list = field(default_factory=list)   # the tag stack for each character
    atoms: list = field(default_factory=list)    # the atoms, in order


@dataclass
class Compiled:
    """A compiled subtitle: the string for the game, its lines, and anything to check."""

    text: str
    lines: list
    warnings: list


def _forms_b_reshaper(keep_harakat: bool) -> ArabicReshaper:
    """A reshaper that only ever outputs Presentation Forms-B.

    The default configuration also uses ligatures from Presentation Forms-A
    (such as the single glyph for "Allah", U+FDF2), which most game fonts lack.
    Only ligatures whose every form is in Forms-B (the lam-alef pairs) stay on.
    """
    config = dict(default_config)
    config['delete_harakat'] = not keep_harakat
    for name, (_match, forms) in LIGATURES:
        config[name] = all(ord(form) in FORMS_B for form in forms if form)
    return ArabicReshaper(configuration=config)


def _is_rtl(ch: str) -> bool:
    return unicodedata.bidirectional(ch) in ('R', 'AL')


def _levels(text: str) -> list:
    """The Unicode bidi embedding level of each character, in a right-to-left paragraph.

    python-bidi's debug mode returns the resolved levels (one per UTF-8 byte),
    which is what reordering needs. The format is checked strictly, so a change
    in the library fails loudly instead of producing wrong text.
    """
    dump = get_display(text, base_dir='R', debug=True)
    start = dump.find('\n    levels: [')
    end = dump.find('\n    ],\n    paragraphs:', start)
    if start < 0 or end < 0:
        raise RuntimeError('python-bidi returned levels in an unexpected format; use python-bidi 0.6.x')
    byte_levels = [int(n) for n in re.findall(r'Level\(\s*(\d+),?\s*\)', dump[start:end])]
    encoded = text.encode('utf-8')
    if len(byte_levels) != len(encoded):
        raise RuntimeError('python-bidi returned levels in an unexpected format; use python-bidi 0.6.x')
    levels, offset = [], 0
    for ch in text:
        levels.append(byte_levels[offset])
        offset += len(ch.encode('utf-8'))
    return levels


def _visual_order(levels: list) -> list:
    """Rule L2: from the highest level down to the lowest odd one, reverse every
    run at that level or above. Returns the logical index shown at each position."""
    order = list(range(len(levels)))
    current = list(levels)
    if not current:
        return order
    lowest_odd = min((lv for lv in current if lv % 2), default=None)
    if lowest_odd is None:
        return order
    for level in range(max(current), lowest_odd - 1, -1):
        i = 0
        while i < len(order):
            if current[i] >= level:
                j = i
                while j < len(order) and current[j] >= level:
                    j += 1
                order[i:j] = order[i:j][::-1]
                current[i:j] = current[i:j][::-1]
                i = j
            else:
                i += 1
    return order


class ArabicCompiler:
    """Turns Arabic translations into strings left-to-right game engines show correctly.

    ``max_line``: lines longer than this many visible characters are wrapped
    (55 suits most subtitle boxes; use the width of the game's box). Tags take
    no room; a placeholder counts as its own length.
    ``line_break``: what to put between wrapped lines. By default the same kind
    of break the text already uses (<br>, a newline, or a literal \\n), else a newline.
    ``keep_harakat``: keep vowel marks. Off by default: few game fonts place them.
    ``strict``: raise UnshapedTextError instead of warning when a letter has no
    Forms-B glyph (Persian and Urdu letters, for example).
    """

    def __init__(self, *, max_line: int = DEFAULT_MAX_LINE, line_break: str | None = None,
                 keep_harakat: bool = False, strict: bool = False):
        if max_line < 8:
            raise ValueError('max_line must be at least 8')
        self.max_line = max_line
        self.line_break = line_break
        self.strict = strict
        self._reshaper = _forms_b_reshaper(keep_harakat)

    # ---- Public ----------------------------------------------------------------

    def compile(self, text: str) -> Compiled:
        warnings: list = []
        bare_closers = '</>' in text
        paragraphs, breaks = self._parse(text, warnings)
        joiner = self.line_break or (breaks[0] if breaks else '\n')

        lines = []
        for paragraph in paragraphs:
            units = self._shape(paragraph, warnings)
            for line in self._wrap(units, warnings):
                lines.append(self._emit(self._to_screen_order(line), bare_closers))

        result = joiner.join(lines)
        self._check_glyphs(result, warnings)
        return Compiled(result, lines, warnings)

    def __call__(self, text: str) -> str:
        return self.compile(text).text

    # ---- 1. Markup ---------------------------------------------------------------

    def _parse(self, text: str, warnings: list):
        """Splits the subtitle into paragraphs at its own line breaks, and each
        paragraph into characters (with the tags that style them) and atoms."""
        paragraphs = [_Paragraph()]
        breaks: list = []
        stack: list = []  # open tags: (name, opening tag)
        position = 0

        def add_text(chunk: str) -> None:
            paragraph = paragraphs[-1]
            for ch in chunk:
                # The game's own private-use glyphs (button icons in many games)
                # and object characters are kept exactly, like placeholders.
                if ch == _ATOM_OBJECT or 0xE000 <= ord(ch) <= 0xF8FF:
                    add_atom(_Atom(ch, 1), _ATOM_LTR)
                else:
                    paragraph.chars.append(ch)
                    paragraph.styles.append(tuple(stack))

        def add_atom(atom: _Atom, stand_in: str) -> None:
            paragraph = paragraphs[-1]
            paragraph.chars.append(stand_in)
            paragraph.styles.append(tuple(stack))
            paragraph.atoms.append(atom)

        for match in _TOKENS.finditer(text):
            add_text(text[position:match.start()])
            position = match.end()
            raw = match.group(0)
            if match.group('br'):
                breaks.append(raw)
                paragraphs.append(_Paragraph())
            elif match.group('ph'):
                add_atom(_Atom(raw, len(raw)), _ATOM_LTR)
            elif raw == '</>':
                if stack:
                    stack.pop()
                else:
                    warnings.append(f'"{raw}" closes nothing and was left out.')
            else:
                name = _TAG_NAME.match(raw).group(1)
                if raw.startswith('</'):
                    index = next((i for i in range(len(stack) - 1, -1, -1)
                                  if stack[i][0].lower() == name.lower()), None)
                    if index is None:
                        warnings.append(f'"{raw}" closes nothing and was left out.')
                    else:
                        del stack[index]
                elif raw.endswith('/>') or name.lower() in _VOID_TAGS:
                    add_atom(_Atom(raw, 2), _ATOM_OBJECT)
                else:
                    stack.append((name, raw))
        add_text(text[position:])
        return paragraphs, breaks

    # ---- 2. Shaping --------------------------------------------------------------

    def _shape(self, paragraph: _Paragraph, warnings: list) -> list:
        """Joins the letters (Forms-B) and keeps each character's styling.

        Shaping can merge characters (lam + alef become one glyph) or drop them
        (vowel marks), so where styles change, the shaped length of the text up
        to that point says where the change lands in the shaped text.
        """
        source = ''.join(paragraph.chars)
        if not source:
            return []
        shaped = self._reshaper.reshape(source)

        styles = paragraph.styles
        changes = [i for i in range(1, len(source)) if styles[i] != styles[i - 1]]
        cuts = [0] + [len(self._reshaper.reshape(source[:i])) for i in changes] + [len(shaped)]
        shaped_styles: list = []
        for k, style in enumerate([styles[0]] + [styles[i] for i in changes]):
            shaped_styles.extend([style] * max(0, cuts[k + 1] - cuts[k]))
        if len(shaped_styles) != len(shaped):
            warnings.append('Tags inside a joined letter group were moved to the nearest letter.')
            shaped_styles = (shaped_styles + [shaped_styles[-1] if shaped_styles else ()] * len(shaped))[:len(shaped)]

        atoms = iter(paragraph.atoms)
        units = []
        for ch, style in zip(shaped, shaped_styles):
            if ch in (_ATOM_LTR, _ATOM_OBJECT):
                units.append(_Unit(ch, style, next(atoms)))
            else:
                units.append(_Unit(ch, style))
        return units

    # ---- 3. Wrapping, in reading order -------------------------------------------

    def _wrap(self, units: list, warnings: list) -> list:
        """Splits a paragraph into lines of at most max_line visible characters,
        at spaces, as evenly as the words allow (subtitles read best balanced)."""
        if sum(u.width for u in units) <= self.max_line:
            return [units]

        words, word = [], []
        for unit in units:
            if unit.atom is None and unit.ch == ' ':
                if word:
                    words.append(word)
                    word = []
            else:
                word.append(unit)
        if word:
            words.append(word)
        if not words:
            return [[]]
        widths = [sum(u.width for u in w) for w in words]

        def greedy(limit: int) -> list:
            lines, current, width = [], [], 0
            for i, w in enumerate(widths):
                if current and width + 1 + w > limit:
                    lines.append(current)
                    current, width = [], 0
                width = w if not current else width + 1 + w
                current.append(i)
            lines.append(current)
            return lines

        # The fewest lines that fit, then the narrowest width that still gives
        # that many lines: the most even split.
        count = len(greedy(self.max_line))
        high = self.max_line
        low = min(high, -(-(sum(widths) + len(widths) - 1) // count))
        while low < high:
            middle = (low + high) // 2
            if len(greedy(middle)) <= count:
                high = middle
            else:
                low = middle + 1
        lines = []
        for indexes in greedy(high):
            line = []
            for n, i in enumerate(indexes):
                if n:
                    # The space takes the styling of the word it follows (underlines stay unbroken).
                    line.append(_Unit(' ', words[indexes[n - 1]][-1].style))
                line.extend(words[i])
            if sum(u.width for u in line) > self.max_line:
                warnings.append(f'A word is longer than {self.max_line} characters and overflows its line.')
            lines.append(line)
        return lines

    # ---- 4. Screen order ---------------------------------------------------------

    def _to_screen_order(self, units: list) -> list:
        text = ''.join(u.ch for u in units)
        if not any(_is_rtl(ch) for ch in text):
            return units  # nothing right to left: already in screen order
        levels = _levels(text)
        # Rule L1: whitespace at the end of a line takes the paragraph's level.
        i = len(text) - 1
        while i >= 0 and text[i] in ' \t':
            levels[i] = 1
            i -= 1
        screen = []
        for index in _visual_order(levels):
            unit = units[index]
            if levels[index] % 2 and unit.atom is None and unit.ch in _MIRRORS:
                unit = _Unit(_MIRRORS[unit.ch], unit.style)  # rule L4: "(" faces the other way
            screen.append(unit)
        return screen

    # ---- 5. Tags back in ---------------------------------------------------------

    @staticmethod
    def _emit(units: list, bare_closers: bool) -> str:
        """Writes the line, opening and closing tags around each run of characters
        that share a style, so every line is balanced on its own."""
        def close(name: str) -> str:
            return '</>' if bare_closers else f'</{name}>'

        out, open_tags = [], ()
        for unit in units:
            if unit.style != open_tags:
                keep = 0
                while keep < min(len(open_tags), len(unit.style)) and open_tags[keep] == unit.style[keep]:
                    keep += 1
                out.extend(close(name) for name, _ in reversed(open_tags[keep:]))
                out.extend(tag for _, tag in unit.style[keep:])
                open_tags = unit.style
            out.append(unit.atom.raw if unit.atom else unit.ch)
        out.extend(close(name) for name, _ in reversed(open_tags))
        return ''.join(out)

    # ---- 6. Checks ---------------------------------------------------------------

    def _check_glyphs(self, text: str, warnings: list) -> None:
        missing = sorted({ch for ch in text
                          if unicodedata.bidirectional(ch) == 'AL'
                          and unicodedata.category(ch) == 'Lo'
                          and ord(ch) not in FORMS_B})
        if missing:
            listed = ', '.join(f'{ch} (U+{ord(ch):04X})' for ch in missing)
            message = f'No Presentation Forms-B glyph for: {listed}. These stay unjoined in the game.'
            if self.strict:
                raise UnshapedTextError(message)
            warnings.append(message)


def compile_subtitle(text: str, **options) -> str:
    """Shortcut for ArabicCompiler(**options).compile(text).text."""
    return ArabicCompiler(**options).compile(text).text


def glyphs_needed(strings) -> str:
    """Every character outside plain ASCII that the compiled strings use, sorted.

    Paste it into the font tool (TextMeshPro's Font Asset Creator "Custom
    Characters", or an Unreal font's character set) so the font has every glyph.
    """
    chars = {ch for s in strings for ch in s if ord(ch) > 0x7E and unicodedata.category(ch)[0] != 'C'}
    return ''.join(sorted(chars))
