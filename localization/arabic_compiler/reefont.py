"""Our own open-source font, in the container RE Engine games load fonts from
(".oft", e.g. natives/stm/.../font/name.oft.1), for RE Engine Arabic packs.

The container is the marker "FBFO" followed by the font, XORed with an 8-byte
key worked out from the font's length (the format's one constant, as in the
open-source REE.Fonts.Cryptor). This only ever wraps a plain font file we ship
or the pack's author gives (TrueType, OpenType, collections). It refuses
anything else, so it can't be used on the game's own font files, which are
never read.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

MAGIC = b'FBFO'
DELTA = 0xAE6E39B58A355F45
MASK = (1 << 64) - 1
FONT_MAGICS = (b'\x00\x01\x00\x00', b'OTTO', b'true', b'ttcf')


class FontError(ValueError):
    pass


def _key(length: int) -> bytes:
    size = length & 0x3F
    seed = (1 << (size + 1)) - 1 if size else 1
    key = (DELTA >> size) | (((seed & DELTA) << ((64 - size) & 63)) & MASK)
    return key.to_bytes(8, 'little')


def encode_oft(font: bytes) -> bytes:
    """A plain font file (ours), in the RE Engine .oft container."""
    if font[:4] not in FONT_MAGICS:
        raise FontError('Only a plain .ttf or .otf font can be packed for the game.')
    key = _key(len(font))
    return MAGIC + bytes(b ^ key[i % 8] for i, b in enumerate(font))


def convert_with(command: str, font: Path, out: Path):
    """Has an installed tool make the .oft: `command` with {input} and {output} in it."""
    if '{input}' not in command or '{output}' not in command:
        raise FontError('--font-converter-cmd needs {input} and {output} in it, e.g. "REE.Fonts.Cryptor.exe {input} {output}".')
    args = [part.replace('{input}', str(font)).replace('{output}', str(out)) for part in shlex.split(command, posix=False)]
    result = subprocess.run([a.strip('"') for a in args], capture_output=True, text=True)
    if result.returncode != 0 or not out.is_file() or out.read_bytes()[:4] != MAGIC:
        raise FontError(f'The font converter didn\'t make an .oft file: {(result.stdout + result.stderr).strip()[-300:]}')
