"""An Arabic font for games whose interface is Scaleform (Bethesda's, see
bethesda.py): a small SWF file holding IBM Plex Sans Arabic (or --font) as
DefineFont3 fonts, which the game loads as a font library from fontconfig.txt.

Only the characters the pack's text uses are put in (with basic Latin, Latin-1
and common punctuation, for the lines left in English). Glyph outlines come
from the bundled open-source font with fontTools; nothing of the game's own
fonts is read.

SWF details: DefineFont3 keeps outlines at 20 times the 1024-unit em square
(20480 units), in quadratic curves, y pointing down; each glyph's first style
record turns fill style 0 on. DefineFontName names it, ExportAssets exports it
so the font library's movie shares it.
"""

from __future__ import annotations

import struct
from pathlib import Path

from fontTools.pens.basePen import decomposeQuadraticSegment
from fontTools.cu2qu import curve_to_quadratic
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

EM = 1024 * 20
BASE_CHARS = (''.join(chr(c) for c in range(0x20, 0x7F)) + ''.join(chr(c) for c in range(0xA0, 0x100))
              + '–—‘’“”…•،؛؟٪٫٬ـ')
SWF_VERSION = 8
TAG_END, TAG_SHOW_FRAME, TAG_EXPORT, TAG_FILE_ATTRIBUTES, TAG_DEFINE_FONT3, TAG_FONT_NAME = 0, 1, 56, 69, 75, 88
MAX_SI16 = 32767


class Bits:
    """Writes the bit fields SWF shapes are made of, most significant bit first."""

    def __init__(self):
        self.data = bytearray()
        self.byte = 0
        self.count = 0

    def ub(self, value: int, bits: int):
        for shift in range(bits - 1, -1, -1):
            self.byte = (self.byte << 1) | ((value >> shift) & 1)
            self.count += 1
            if self.count == 8:
                self.data.append(self.byte)
                self.byte = self.count = 0

    def sb(self, value: int, bits: int):
        self.ub(value & ((1 << bits) - 1), bits)

    def flush(self) -> bytes:
        if self.count:
            self.data.append(self.byte << (8 - self.count))
            self.byte = self.count = 0
        return bytes(self.data)


def signed_bits(*values) -> int:
    """How many bits a signed field needs to hold every value."""
    return max([2] + [(v if v >= 0 else ~v).bit_length() + 1 for v in values])


def rect(xmin: int, xmax: int, ymin: int, ymax: int) -> bytes:
    bits = Bits()
    n = signed_bits(xmin, xmax, ymin, ymax)
    bits.ub(n, 5)
    for v in (xmin, xmax, ymin, ymax):
        bits.sb(v, n)
    return bits.flush()


def _contours(glyph_set, name: str, scale: float):
    """The glyph's outline as closed contours of ('L', (x, y)) and ('Q', control, (x, y)), in SWF units."""
    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[name].draw(pen)

    def pt(p):
        return round(p[0] * scale), round(-p[1] * scale)

    contours, current, start, last = [], None, None, None

    def close():
        nonlocal current
        if current is not None:
            if last != start:
                current[1].append(('L', start))
            if current[1]:
                contours.append(current)
        current = None

    for op, args in pen.value:
        if op == 'moveTo':
            close()
            start = last = pt(args[0])
            current = (start, [])
        elif op == 'lineTo':
            last = pt(args[0])
            current[1].append(('L', last))
        elif op == 'qCurveTo':
            points = list(args)
            if points[-1] is None:  # a contour of off-curve points only: start halfway between the last and first
                points = points[:-1]
                close()
                first = ((points[-1][0] + points[0][0]) / 2, (points[-1][1] + points[0][1]) / 2)
                start = last = pt(first)
                current = (start, [])
                points.append(first)
            if len(points) == 1:
                last = pt(points[0])
                current[1].append(('L', last))
            else:
                for control, anchor in decomposeQuadraticSegment(points):
                    last = pt(anchor)
                    current[1].append(('Q', pt(control), last))
        elif op == 'curveTo':
            p0 = (last[0] / scale, -last[1] / scale)
            quads = curve_to_quadratic([p0, *args], 1.0)
            for control, anchor in decomposeQuadraticSegment(quads[1:]):
                last = pt(anchor)
                current[1].append(('Q', pt(control), last))
        elif op in ('closePath', 'endPath'):
            close()
    close()
    return contours


def _straight(bits: Bits, dx: int, dy: int):
    n = signed_bits(dx, dy)
    if n > 17:  # too long for one edge: two halves
        hx, hy = dx // 2, dy // 2
        _straight(bits, hx, hy)
        _straight(bits, dx - hx, dy - hy)
        return
    bits.ub(1, 1)
    bits.ub(1, 1)
    bits.ub(n - 2, 4)
    if dx and dy:
        bits.ub(1, 1)
        bits.sb(dx, n)
        bits.sb(dy, n)
    else:
        bits.ub(0, 1)
        bits.ub(1 if dx == 0 else 0, 1)
        bits.sb(dy if dx == 0 else dx, n)


def _curve(bits: Bits, cx: int, cy: int, ax: int, ay: int):
    n = signed_bits(cx, cy, ax, ay)
    if n > 17:
        raise ValueError('A glyph curve is too big for a SWF font.')
    bits.ub(1, 1)
    bits.ub(0, 1)
    bits.ub(n - 2, 4)
    for v in (cx, cy, ax, ay):
        bits.sb(v, n)


def glyph_shape(contours) -> bytes:
    """A SHAPE: one fill bit, no line bits, a move to each contour, its edges, then the end."""
    bits = Bits()
    bits.ub(1, 4)
    bits.ub(0, 4)
    first = True
    for (sx, sy), edges in contours:
        n = signed_bits(sx, sy)
        bits.ub(0, 1)          # style change record
        bits.ub(0, 1)          # new styles
        bits.ub(0, 1)          # line style
        bits.ub(0, 1)          # fill style 1
        bits.ub(1 if first else 0, 1)  # fill style 0
        bits.ub(1, 1)          # move to
        bits.ub(n, 5)
        bits.sb(sx, n)
        bits.sb(sy, n)
        if first:
            bits.ub(1, 1)      # fill style 0 = 1
            first = False
        x, y = sx, sy
        for edge in edges:
            if edge[0] == 'L':
                ex, ey = edge[1]
                if (ex, ey) != (x, y):
                    _straight(bits, ex - x, ey - y)
                x, y = ex, ey
            else:
                (cx, cy), (ex, ey) = edge[1], edge[2]
                if (cx, cy) == (x, y) or (cx, cy) == (ex, ey):
                    if (ex, ey) != (x, y):
                        _straight(bits, ex - x, ey - y)
                else:
                    _curve(bits, cx - x, cy - y, ex - cx, ey - cy)
                x, y = ex, ey
    bits.ub(0, 6)              # end of shape
    return bits.flush()


def _tag(code: int, body: bytes) -> bytes:
    if len(body) < 0x3F:
        return struct.pack('<H', (code << 6) | len(body)) + body
    return struct.pack('<HI', (code << 6) | 0x3F, len(body)) + body


def define_font3(font_id: int, path: Path, chars: str, name: str, bold: bool) -> tuple:
    """A DefineFont3 tag body for the characters of `chars` the font has. Returns (body, characters put in)."""
    font = TTFont(str(path), lazy=True)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    scale = EM / font['head'].unitsPerEm
    metrics = font['hmtx'].metrics
    codes, shapes, advances, bounds = [], [], [], []
    for code in sorted({ord(c) for c in chars if ord(c) <= 0xFFFF}):
        glyph = cmap.get(code)
        if glyph is None:
            continue
        advance = round(metrics[glyph][0] * scale)
        if advance > MAX_SI16:
            continue  # wider than a SWF font can say (a few long ligatures)
        contours = _contours(glyph_set, glyph, scale)
        points = [p for start, edges in contours for p in [start] + [e[-1] for e in edges] + [e[1] for e in edges if e[0] == 'Q']]
        xs = [p[0] for p in points] or [0]
        ys = [p[1] for p in points] or [0]
        codes.append(code)
        shapes.append(glyph_shape(contours))
        advances.append(advance)
        bounds.append(rect(min(xs), max(xs), min(ys), max(ys)))
    count = len(codes)
    table_size = 2 * (count + 1)
    total = table_size + sum(len(s) for s in shapes)
    wide = total > 0xFFFF
    if wide:
        table_size = 4 * (count + 1)
    offsets, at = [], table_size
    for shape in shapes:
        offsets.append(at)
        at += len(shape)
    fmt = '<I' if wide else '<H'
    name_bytes = name.encode('utf-8')
    hhea = font['hhea']
    clamp = lambda v: max(-MAX_SI16, min(MAX_SI16, round(v)))  # noqa: E731
    body = bytearray(struct.pack('<HBBB', font_id, 0x80 | (0x08 if wide else 0) | 0x04 | (0x01 if bold else 0), 0, len(name_bytes)))
    body += name_bytes + struct.pack('<H', count)
    for offset in offsets:
        body += struct.pack(fmt, offset)
    body += struct.pack(fmt, at)  # where the code table starts
    for shape in shapes:
        body += shape
    for code in codes:
        body += struct.pack('<H', code)
    body += struct.pack('<hhh', clamp(hhea.ascent * scale), clamp(-hhea.descent * scale), clamp(hhea.lineGap * scale))
    for advance in advances:
        body += struct.pack('<h', advance)
    for bound in bounds:
        body += bound
    body += struct.pack('<H', 0)  # no kerning pairs
    font.close()
    return bytes(body), ''.join(chr(c) for c in codes)


def font_name_tag(font_id: int, name: str, copyright_text: str) -> bytes:
    return struct.pack('<H', font_id) + name.encode('utf-8') + b'\0' + copyright_text.encode('utf-8') + b'\0'


def make_swf(faces: list, chars: str, name: str, copyright_text: str = '') -> tuple:
    """A font library SWF with one DefineFont3 per (font file, bold) in `faces`, all named `name`.
    Returns (SWF bytes, the characters the regular face has)."""
    tags = [_tag(TAG_FILE_ATTRIBUTES, struct.pack('<I', 0))]
    exports, covered = [], None
    for index, (path, bold) in enumerate(faces, start=1):
        body, have = define_font3(index, Path(path), BASE_CHARS + chars, name, bold)
        covered = have if covered is None else covered
        tags.append(_tag(TAG_DEFINE_FONT3, body))
        tags.append(_tag(TAG_FONT_NAME, font_name_tag(index, name, copyright_text)))
        exports.append((index, f'{name} Bold' if bold else name))
    export = struct.pack('<H', len(exports)) + b''.join(struct.pack('<H', i) + n.encode('utf-8') + b'\0' for i, n in exports)
    tags += [_tag(TAG_EXPORT, export), _tag(TAG_SHOW_FRAME, b''), _tag(TAG_END, b'')]
    movie = rect(0, 20 * 20, 0, 20 * 20) + struct.pack('<HH', 24 << 8, 1) + b''.join(tags)
    return b'FWS' + bytes([SWF_VERSION]) + struct.pack('<I', 8 + len(movie)) + movie, covered or ''
