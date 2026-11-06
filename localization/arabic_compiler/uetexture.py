"""An Arabic title logo in an Unreal game's menu, where the logo is a texture drawn by a menu widget: Phantom Blade
Zero's start menu (WB_StartMenu_V2) draws UINew/testplaceholder/T_Logo_V2_EN, a 2048x128 DXT5 texture, in an image
whose brush is 1024x64, in a box that scales it to fit.

Both are legacy assets (.uasset + .uexp) that retoc's to-legacy takes out of the game's containers, and both are
changed in place, so nothing in either file moves:
- the texture gets the logo's pixels, encoded in its own format, and may be given other dimensions with the same
  number of pixels (2048x128 -> 1024x256), closer to the logo's shape;
- the widget's brush for that texture gets the new shape (1024x64 -> 1024x256), keeping its width, so the box
  draws the logo unsquashed (the game's Japanese and Korean logos are 4:1 like that).
retoc's to-zen turns them back into packages for the game's .utoc/.ucas loader.

A cooked texture's data (FTexturePlatformData) is: SizeX, SizeY, PackedData (int32 each), the pixel format's name
(FString, "PF_DXT5"), then the mips; in these single-mip UI textures, 12 bytes, the pixels, and a 24-byte tail with the
mip's SizeX, SizeY and SizeZ. (Read 4 bytes early, a DXT5 picture still shows its shape but its colours come out as
speckles: every block's colour endpoints, pure white in a white logo, are its last 4 bytes, ff ff 00 00.) That's checked before anything is changed, and anything else is refused.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

from . import safe_exec

# Bytes per 4x4 block, or per pixel for the uncompressed formats.
_BLOCK = {'PF_DXT5': 16, 'PF_BC3': 16, 'PF_DXT1': 8, 'PF_BC1': 8}
_PIXEL = {'PF_B8G8R8A8': 4, 'PF_R8G8B8A8': 4}
_PF = re.compile(rb'(?<=[\x05-\x20]\x00\x00\x00)PF_[A-Z0-9_]{2,24}\x00')
_TAIL = 24


class TextureError(ValueError):
    pass


@dataclass
class Texture:
    width: int
    height: int
    pixel_format: str
    size_at: int      # where SizeX, SizeY are in the platform data
    data_at: int      # where the pixels start
    data_len: int
    mip_size_at: int  # where the mip's SizeX, SizeY, SizeZ are


def data_length(fmt: str, w: int, h: int) -> int:
    if fmt in _BLOCK:
        return ((w + 3) // 4) * ((h + 3) // 4) * _BLOCK[fmt]
    if fmt in _PIXEL:
        return w * h * _PIXEL[fmt]
    raise TextureError(f'Textures in {fmt} can\'t be written yet (only DXT5/BC3, DXT1/BC1 and 8-bit RGBA).')


def read_texture(uexp: bytes) -> Texture:
    """Where a cooked single-mip texture's sizes and pixels are in its .uexp."""
    found = list(_PF.finditer(uexp))
    if len(found) != 1:
        raise TextureError('This isn\'t a texture GameShelf can read (no single pixel format name in it).')
    m = found[0]
    fmt = m.group(0)[:-1].decode('ascii')
    size_at = m.start() - 16
    w, h, _packed = struct.unpack_from('<iii', uexp, size_at)
    length = data_length(fmt, w, h)
    data_at = m.end() + 12
    mip_size_at = len(uexp) - _TAIL
    if data_at + length != len(uexp) - _TAIL or struct.unpack_from('<iii', uexp, mip_size_at) != (w, h, 1):
        raise TextureError(f'This {w}x{h} {fmt} texture isn\'t laid out as a single mip in its .uexp '
                           '(it may have mipmaps or a separate .ubulk), so it wasn\'t changed.')
    return Texture(w, h, fmt, size_at, data_at, length, mip_size_at)


def same_size_shapes(tex: Texture) -> list:
    """Other dimensions with exactly as many bytes of pixels, powers of two, widest first."""
    pixels = tex.width * tex.height
    shapes = []
    w = 4
    while w <= pixels // 4:
        h = pixels // w
        if w * h == pixels and h >= 4 and h & (h - 1) == 0 and w & (w - 1) == 0 \
                and data_length(tex.pixel_format, w, h) == tex.data_len:
            shapes.append((w, h))
        w *= 2
    return sorted(shapes, reverse=True)


def best_shape(tex: Texture, logo: tuple, widest: float = 16.0) -> tuple:
    """The texture's dimensions for a logo of `logo` (w, h): of the shapes with the same number of bytes, the one
    whose width-to-height is nearest the logo's (compared as ratios), never wider than `widest` to 1."""
    want = logo[0] / logo[1]
    shapes = [s for s in same_size_shapes(tex) if s[0] / s[1] <= widest] or [(tex.width, tex.height)]
    return min(shapes, key=lambda s: max(s[0] / s[1], want) / min(s[0] / s[1], want))


# DXT5 (BC3): 8 bytes of alpha (two levels and 3-bit indices), 8 of colour (two RGB565 colours and 2-bit indices).
_CLEAR_BLOCK = bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])


def _rgb565(r: int, g: int, b: int) -> int:
    return ((r * 31 + 127) // 255) << 11 | ((g * 63 + 127) // 255) << 5 | ((b * 31 + 127) // 255)


def _from565(c: int) -> tuple:
    return ((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31


def _alpha_block(alphas: list) -> bytes:
    hi, lo = max(alphas), min(alphas)
    if hi == lo:
        return bytes([hi, lo, 0, 0, 0, 0, 0, 0])
    bits = 0
    for i, a in enumerate(alphas):
        t = round((hi - a) * 7 / (hi - lo))  # 0 at hi, 7 at lo
        index = 0 if t == 0 else 1 if t == 7 else t + 1
        bits |= index << (3 * i)
    return bytes([hi, lo]) + bits.to_bytes(6, 'little')


def _colour_block(pixels: list) -> bytes:
    shown = [p for p in pixels if p[3]] or pixels
    lum = [(p[0] * 2 + p[1] * 5 + p[2], p) for p in shown]
    c0 = _rgb565(*max(lum)[1][:3])
    c1 = _rgb565(*min(lum)[1][:3])
    if c0 == c1:
        return struct.pack('<HHI', c0, c1, 0)
    if c0 < c1:
        c0, c1 = c1, c0
    a, b = _from565(c0), _from565(c1)
    axis = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    span = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2
    bits = 0
    for i, p in enumerate(pixels):
        t = ((p[0] - a[0]) * axis[0] + (p[1] - a[1]) * axis[1] + (p[2] - a[2]) * axis[2]) / span
        step = min(3, max(0, round(t * 3)))  # 0 at c0, 3 at c1
        bits |= (0, 2, 3, 1)[step] << (2 * i)
    return struct.pack('<HHI', c0, c1, bits)


def encode_dxt5(rgba: bytes, w: int, h: int) -> bytes:
    if w % 4 or h % 4 or len(rgba) != w * h * 4:
        raise TextureError('DXT5 needs a picture whose sides are multiples of 4.')
    out = bytearray()
    row = w * 4
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            pixels = []
            for y in range(by, by + 4):
                at = y * row + bx * 4
                chunk = rgba[at:at + 16]
                pixels += [tuple(chunk[i:i + 4]) for i in range(0, 16, 4)]
            if not any(p[3] for p in pixels):
                out += _CLEAR_BLOCK
                continue
            out += _alpha_block([p[3] for p in pixels]) + _colour_block(pixels)
    return bytes(out)


def encode(fmt: str, rgba: bytes, w: int, h: int) -> bytes:
    if fmt in ('PF_DXT5', 'PF_BC3'):
        return encode_dxt5(rgba, w, h)
    if fmt == 'PF_R8G8B8A8':
        return rgba
    if fmt == 'PF_B8G8R8A8':
        return bytes(b for i in range(0, len(rgba), 4) for b in (rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]))
    raise TextureError(f'Textures in {fmt} can\'t be written yet (only DXT5/BC3 and 8-bit RGBA).')


def logo_pixels(ffmpeg: str, png: Path, w: int, h: int) -> bytes:
    """The logo as w x h RGBA: as big as fits, at the left (where a menu's logo starts), centred top to bottom."""
    graph = (f'format=rgba,scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,'
             f'pad={w}:{h}:0:(oh-ih)/2:color=0x00000000,format=rgba')
    result = safe_exec.run([ffmpeg, '-hide_banner', '-nostdin', '-i', str(png), '-vf', graph, '-frames:v', '1',
                            '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], capture_output=True, timeout=300)
    if result.returncode != 0 or len(result.stdout) != w * h * 4:
        raise TextureError('ffmpeg couldn\'t read the logo: ' + (result.stderr or b'').decode('utf-8', 'replace').strip()[-300:])
    return result.stdout


def write_texture(uexp: bytes, tex: Texture, pixels: bytes, w: int, h: int) -> bytes:
    """The .uexp with new pixels, and new dimensions if they hold the same number of bytes."""
    if len(pixels) != tex.data_len or data_length(tex.pixel_format, w, h) != tex.data_len:
        raise TextureError('The new pixels don\'t fit the texture\'s place.')
    out = bytearray(uexp)
    struct.pack_into('<ii', out, tex.size_at, w, h)
    out[tex.data_at:tex.data_at + tex.data_len] = pixels
    struct.pack_into('<iii', out, tex.mip_size_at, w, h, 1)
    return bytes(out)


# A legacy package's name map: FStrings, each followed by a 4-byte hash.
def _fstring(data: bytes, at: int):
    if at + 4 > len(data):
        return None, at
    n = struct.unpack_from('<i', data, at)[0]
    if 1 < n < 1024 and at + 4 + n <= len(data) and data[at + 3 + n] == 0:
        text = data[at + 4:at + 3 + n]
        if all(32 <= c < 127 for c in text):
            return text.decode('ascii'), at + 4 + n
    return None, at


def package_imports(uasset: bytes) -> list:
    """A legacy package's imports, as (class name, object name), in order (import i is package index -(i+1))."""
    start = None
    for at in range(0, min(len(uasset), 4096)):
        i, count = at, 0
        while count < 8:
            text, j = _fstring(uasset, i)
            if text is None:
                break
            count, i = count + 1, j + 4
        if count == 8:
            start = at
            break
    if start is None:
        raise TextureError('Couldn\'t read the package\'s names.')
    names, i = [], start
    while True:
        text, j = _fstring(uasset, i)
        if text is None:
            break
        names.append(text)
        i = j + 4

    def name(at):
        index, _ = struct.unpack_from('<ii', uasset, at)
        if 0 <= index < len(names):
            return names[index]
        raise IndexError

    roots = ('/Script/', '/Game/', '/Engine/')
    for size in (32, 36, 40):
        for at in range(i, min(len(uasset) - size * 4, i + 65536), 4):
            try:
                entries = []
                while at + size * len(entries) + 28 <= len(uasset):
                    e = at + size * len(entries)
                    package = name(e)
                    if not package.startswith(roots):
                        break
                    entries.append((name(e + 8), name(e + 20)))
            except (IndexError, struct.error):
                pass
            if len(entries) >= 4:
                return entries
    raise TextureError('Couldn\'t read the package\'s imports.')


def find_brush(widget_uasset: bytes, widget_uexp: bytes, texture_name: str) -> int:
    """Where, in a widget's .uexp, the brush that draws `texture_name` has its size: two floats (width, height) right
    before the texture's package index."""
    imports = package_imports(widget_uasset)
    index = [i for i, (cls, obj) in enumerate(imports) if obj == texture_name and cls.startswith('Texture')]
    if len(index) != 1:
        raise TextureError(f'The widget doesn\'t use {texture_name}.')
    ref = struct.pack('<i', -(index[0] + 1))
    spots = []
    at = widget_uexp.find(ref)
    while at != -1:
        if at >= 8:
            w, h = struct.unpack_from('<ff', widget_uexp, at - 8)
            if 1 <= w <= 8192 and 1 <= h <= 8192 and w == int(w) and h == int(h):
                spots.append(at - 8)
        at = widget_uexp.find(ref, at + 1)
    if len(spots) != 1:
        raise TextureError(f'Found {len(spots)} brushes for {texture_name} in the widget, not one, so it wasn\'t changed.')
    return spots[0]


def brush_size(widget_uexp: bytes, at: int) -> tuple:
    return struct.unpack_from('<ff', widget_uexp, at)


def set_brush_size(widget_uexp: bytes, at: int, w: float, h: float) -> bytes:
    out = bytearray(widget_uexp)
    struct.pack_into('<ff', out, at, float(w), float(h))
    return bytes(out)
