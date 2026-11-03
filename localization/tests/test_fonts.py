"""Tests for the Arabic font styles: presentation forms filled in from a
font's own GSUB, the bundled Cairo and Noto Naskh Arabic, and --font-style in
packs."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

from arabic_compiler.fontforms import add_forms, missing_forms
from arabic_compiler.packbuild import FONT_STYLES, build, parse_args
from test_build_pack import HAS_NODE, REPO, FakeApi, node_read_pack
from test_native_packs import SCRIPT

FONTS = REPO / 'localization' / 'assets' / 'fonts'


def outline(font, glyph):
    glyphs = font.getGlyphSet()
    pen = DecomposingRecordingPen(glyphs)
    glyphs[glyph].draw(pen)
    return pen.value, font['hmtx'][glyph][0]


class PresentationForms(unittest.TestCase):
    def test_missing_forms_are_drawn_as_the_fonts_own_shaping_draws_them(self):
        font = TTFont(FONTS / 'IBMPlexSansArabic-Regular.ttf')
        original = {c: g for c, g in font.getBestCmap().items() if 0xFE80 <= c <= 0xFEFC}
        reference = TTFont(FONTS / 'IBMPlexSansArabic-Regular.ttf')
        for table in font['cmap'].tables:
            if table.isUnicode():
                for code in [c for c in table.cmap if 0xFE70 <= c <= 0xFEFC]:
                    del table.cmap[code]
        self.assertEqual(len(missing_forms(font)), len(original))
        added = add_forms(font)
        self.assertEqual(missing_forms(font), [])
        self.assertTrue(set(original) <= set(added))
        now = font.getBestCmap()
        for code, glyph in original.items():
            # The same glyph, or (isolated forms) one that draws exactly the same.
            self.assertEqual(outline(font, now[code]), outline(reference, glyph), f'U+{code:04X}')

    def test_a_font_with_all_its_forms_is_left_as_it_is(self):
        font = TTFont(FONTS / 'NotoNaskhArabic-Regular.ttf')
        self.assertEqual(add_forms(font), [])


class BundledStyles(unittest.TestCase):
    def test_every_style_has_static_regular_and_bold_with_every_letter_form_and_its_license(self):
        self.assertEqual(sorted(FONT_STYLES), ['cairo', 'naskh', 'plex'])
        for style, (regular, bold, license_text) in FONT_STYLES.items():
            for path, weight in ((regular, 400), (bold, 700)):
                font = TTFont(path)
                self.assertNotIn('fvar', font, f'{path.name} is a static font')
                self.assertEqual(font['OS/2'].usWeightClass, weight, path.name)
                self.assertEqual(missing_forms(font), [], f'{path.name} draws every Forms-B letter')
                for code in (0x0627, 0x0644, 0x0645, 0x0041, 0x0030):
                    self.assertIn(code, font.getBestCmap(), f'{path.name}: U+{code:04X}')
            self.assertIn('SIL OPEN FONT LICENSE', license_text.read_text(encoding='utf-8').upper(), style)


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class FontStylePacks(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(self.keys)], check=True, capture_output=True)
        self.api = FakeApi()
        self.addCleanup(self.api.close)
        env = mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-key'})
        env.start()
        self.addCleanup(env.stop)

    def build(self, *extra):
        script = self.tmp / 'script.rpy'
        script.write_text(SCRIPT, encoding='utf-8')
        args = parse_args([str(script), '--id', 'g-ar', '--version', '1.0.0', '--steam-app-id', '4242', '--key', str(self.keys / 'pack-signing.key'),
                           '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', self.api.base, *extra])
        return build(args, log=lambda *_: None)

    def test_the_chosen_style_goes_into_the_pack_with_its_license(self):
        pack = self.build('--font-style', 'cairo')
        read = node_read_pack(pack, self.keys / 'pack-signing.pub')
        self.assertEqual(read['manifest']['fontStyle'], 'cairo')
        folder = 'game/tl/arabic/gameshelf/'
        self.assertEqual(sorted(read['files']), [folder + 'Cairo-Regular.ttf', folder + 'FONT-LICENSE-OFL-Cairo.txt', folder + 'strings.json'])
        self.assertEqual((pack / 'payload' / folder / 'Cairo-Regular.ttf').read_bytes(), (FONTS / 'Cairo-Regular.ttf').read_bytes())
        data = json.loads((pack / 'payload' / folder / 'strings.json').read_text(encoding='utf-8'))
        self.assertEqual(data['font'], 'Cairo-Regular.ttf')

    def test_the_default_is_ibm_plex_and_a_given_font_file_is_custom(self):
        self.assertEqual(node_read_pack(self.build(), self.keys / 'pack-signing.pub')['manifest']['fontStyle'], 'plex')
        own = self.tmp / 'Mine.ttf'
        shutil.copyfile(FONTS / 'NotoNaskhArabic-Regular.ttf', own)
        self.assertEqual(node_read_pack(self.build('--font', str(own)), self.keys / 'pack-signing.pub')['manifest']['fontStyle'], 'custom')


if __name__ == '__main__':
    unittest.main()
