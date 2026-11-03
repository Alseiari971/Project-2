#!/usr/bin/env python3
"""Fetches the Arabic font styles GameShelf offers beside IBM Plex Sans Arabic,
from Google Fonts' repository (all SIL Open Font License 1.1, no reserved
font names), into localization/assets/fonts/:

  Cairo-Regular.ttf, Cairo-Bold.ttf                        modern, for HUDs and menus
  NotoNaskhArabic-Regular.ttf, NotoNaskhArabic-Bold.ttf    classic naskh, for story games
  OFL-Cairo.txt, OFL-NotoNaskhArabic.txt                    their licenses

Google ships them as variable fonts; GameShelf makes a regular (400) and a
bold (700) instance of each (some engines don't read variable fonts), and
fills in the Arabic Presentation Forms-B code points the font draws only
through OpenType (see arabic_compiler/fontforms.py), so the shaped text that
engines without Arabic support get never shows boxes. The results are kept in
the repository; run this again only to refresh them:

    python scripts/fetch-arabic-fonts.py
"""

from __future__ import annotations

import io
import sys
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'localization'))
from arabic_compiler.fontforms import add_forms, missing_forms  # noqa: E402

OUT = REPO / 'localization' / 'assets' / 'fonts'
SOURCE = 'https://raw.githubusercontent.com/google/fonts/main/ofl'
FONTS = {
    'Cairo': ('cairo/Cairo%5Bslnt,wght%5D.ttf', 'cairo/OFL.txt', {'slnt': 0}),
    'NotoNaskhArabic': ('notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf', 'notonaskharabic/OFL.txt', {}),
}
WEIGHTS = {'Regular': 400, 'Bold': 700}


def download(path: str) -> bytes:
    print(f'Downloading {SOURCE}/{path}')
    with urllib.request.urlopen(f'{SOURCE}/{path}', timeout=120) as response:
        return response.read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for family, (font_path, license_path, axes) in FONTS.items():
        variable = download(font_path)
        (OUT / f'OFL-{family}.txt').write_bytes(download(license_path))
        for style, weight in WEIGHTS.items():
            font = TTFont(io.BytesIO(variable))
            static = instancer.instantiateVariableFont(font, {'wght': weight, **axes}, updateFontNames=True)
            added = add_forms(static)
            left = missing_forms(static)
            target = OUT / f'{family}-{style}.ttf'
            static.save(target)
            print(f'{target.name}: {len(added)} presentation forms added, {len(left)} letters still missing, {target.stat().st_size // 1024} KB')
            if left:
                print('  missing: ' + ' '.join(f'U+{c:04X}' for c in left))
    return 0


if __name__ == '__main__':
    sys.exit(main())
