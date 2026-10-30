"""Tests for the Arabic compiler. Run from the localization folder:

    python -m unittest discover -s tests
"""

import csv
import json
import re
import tempfile
import unittest
from pathlib import Path

from arabic_compiler import ArabicCompiler, UnshapedTextError, compile_subtitle, glyphs_needed
from arabic_compiler.__main__ import main
from arabic_compiler.xunity import escape, write_translations

# مرحبا shaped and in screen order: alef (final), beh (medial), hah (initial),
# reh (final), meem (initial).
MARHABA = 'ﺎﺒﺣﺮﻣ'
TAG = re.compile(r'</?[A-Za-z][^>]*>|</>')


def visible(line: str) -> str:
    return TAG.sub('', line)


def is_arabic_letter(ch: str) -> bool:
    return 0x0620 <= ord(ch) <= 0x06FF or 0xFB50 <= ord(ch) <= 0xFEFF


class Shaping(unittest.TestCase):
    def test_letters_are_joined_and_in_screen_order(self):
        self.assertEqual(compile_subtitle('مرحبا'), MARHABA)

    def test_only_presentation_forms_b(self):
        out = compile_subtitle('الله أكبر، لا إله إلا هو. السلام عليكم ورحمة الله وبركاته')
        letters = [ch for ch in out if is_arabic_letter(ch)]
        self.assertTrue(letters)
        for ch in letters:
            self.assertTrue(0xFE70 <= ord(ch) <= 0xFEFF, f'U+{ord(ch):04X} is outside Forms-B')

    def test_lam_alef_ligature_is_used(self):
        self.assertEqual(compile_subtitle('لا'), 'ﻻ')

    def test_vowel_marks_dropped_unless_kept(self):
        self.assertEqual(compile_subtitle('مَرْحَبًا'), MARHABA)
        self.assertIn('َ', ArabicCompiler(keep_harakat=True)('مَرحبا'))

    def test_letters_without_forms_b_are_reported(self):
        result = ArabicCompiler().compile('گربه')  # Persian gaf has only a Forms-A glyph
        self.assertTrue(any('Forms-B' in w for w in result.warnings))
        with self.assertRaises(UnshapedTextError):
            ArabicCompiler(strict=True).compile('گربه')


class Order(unittest.TestCase):
    def test_english_alone_is_untouched(self):
        for text in ['Hello.', 'Press [E] to open (the door).', '<b>Bold</b> move!']:
            self.assertEqual(compile_subtitle(text), text)

    def test_numbers_keep_their_digit_order(self):
        out = compile_subtitle('لديك 25 رصاصة')
        self.assertIn('25', out)
        self.assertNotIn('52', out)

    def test_brackets_face_the_right_way(self):
        self.assertEqual(compile_subtitle('(مرحبا)'), f'({MARHABA})')

    def test_english_words_stay_left_to_right(self):
        out = compile_subtitle('العب على PlayStation الآن')
        self.assertIn('PlayStation', out)

    def test_full_stop_ends_up_on_the_left(self):
        self.assertTrue(compile_subtitle('مرحبا.').startswith('.'))


class Markup(unittest.TestCase):
    def test_color_tag_still_wraps_its_word(self):
        out = compile_subtitle('<color=#fff>مرحبا</color> بك')
        self.assertEqual(re.search(r'<color=#fff>(.*?)</color>', out).group(1), MARHABA)
        self.assertEqual(visible(out).replace(MARHABA, ''), 'ﻚﺑ ')

    def test_unreal_closing_tags(self):
        out = compile_subtitle('<RichText.Warning>تحذير</>: احذر')
        self.assertRegex(out, r'<RichText\.Warning>[^<]+</>')
        self.assertNotIn('</RichText', out)

    def test_nested_tags_stay_nested(self):
        out = compile_subtitle('<b><i>مرحبا</i></b>')
        self.assertEqual(out, f'<b><i>{MARHABA}</i></b>')

    def test_tag_inside_a_word_keeps_the_letters_joined(self):
        out = compile_subtitle('م<color=red>ر</color>حبا')
        self.assertEqual(out, 'ﺎﺒﺣ<color=red>ﺮ</color>ﻣ')

    def test_placeholders_and_key_prompts_are_kept_exactly(self):
        text = 'اضغط [Press E] لإرسال {0} إلى %1$s مع %s و %PLAYER% و ${name}'
        out = compile_subtitle(text, max_line=200)
        for token in ['[Press E]', '{0}', '%1$s', '%s', '%PLAYER%', '${name}']:
            self.assertIn(token, out)
        self.assertNotIn(']E sserP[', out)

    def test_key_prompt_sits_between_its_words(self):
        out = compile_subtitle('اضغط [E] للمتابعة')
        left, prompt, right = out.partition(' [E] ')
        self.assertEqual(prompt, ' [E] ')
        self.assertEqual(right, compile_subtitle('اضغط'))
        self.assertEqual(left, compile_subtitle('للمتابعة'))

    def test_inline_icons_are_kept(self):
        out = compile_subtitle('اجمع <sprite name="coin"> عملات')
        self.assertIn('<sprite name="coin">', out)

    def test_private_use_icons_from_the_game_font_are_kept(self):
        out = compile_subtitle('اضغط  للقفز')
        self.assertIn('', out)

    def test_stray_closing_tag_is_reported(self):
        result = ArabicCompiler().compile('مرحبا</b>')
        self.assertEqual(result.text, MARHABA)
        self.assertTrue(result.warnings)


class Lines(unittest.TestCase):
    LONG = ('في هذه المدينة القديمة، كان الجميع يعرفون أن الملك لن يعود أبدًا '
            'من رحلته الطويلة عبر الصحراء الكبرى')

    def test_short_lines_are_not_wrapped(self):
        self.assertEqual(len(ArabicCompiler().compile('مرحبا بك في المدينة').lines), 1)

    def test_long_lines_wrap_before_reordering(self):
        result = ArabicCompiler().compile(self.LONG)
        self.assertGreater(len(result.lines), 1)
        for line in result.lines:
            self.assertLessEqual(len(visible(line)), 55)
        # Reading order is kept top to bottom: the sentence starts on line 1
        # (at its right end) and ends on the last line (at its left end).
        self.assertTrue(result.lines[0].endswith(compile_subtitle('في')))
        self.assertTrue(result.lines[-1].startswith(compile_subtitle('الكبرى')))
        self.assertEqual(result.text, '\n'.join(result.lines))

    def test_lines_are_balanced(self):
        lengths = [len(line) for line in ArabicCompiler().compile(self.LONG).lines]
        self.assertLessEqual(max(lengths) - min(lengths), 10)

    def test_custom_width(self):
        for line in ArabicCompiler(max_line=20).compile(self.LONG).lines:
            self.assertLessEqual(len(line), 20)

    def test_line_breaks_in_the_text_are_kept_in_its_own_style(self):
        self.assertEqual(compile_subtitle('مرحبا<br>بك'), f'{MARHABA}<br>ﻚﺑ')
        self.assertEqual(compile_subtitle('مرحبا\\nبك'), f'{MARHABA}\\nﻚﺑ')
        self.assertEqual(compile_subtitle('مرحبا\nبك'), f'{MARHABA}\nﻚﺑ')

    def test_a_tag_across_wrapped_lines_is_closed_and_reopened_on_each(self):
        result = ArabicCompiler(max_line=20).compile(f'<i>{self.LONG}</i>')
        for line in result.lines:
            self.assertTrue(line.startswith('<i>') and line.endswith('</i>'), line)
            self.assertEqual(line.count('<i>'), line.count('</i>'))


class Outputs(unittest.TestCase):
    def test_xunity_escaping(self):
        self.assertEqual(escape('a=b\nc//d\\e/f'), 'a\\=b\\nc\\/\\/d\\\\e/f')

    def test_glyphs_needed_lists_each_glyph_once(self):
        self.assertEqual(glyphs_needed([MARHABA, MARHABA + '!']), ''.join(sorted(MARHABA)))

    def test_translation_file_skips_empty_and_unchanged_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'Text' / '_AutoGeneratedTranslations.txt'
            count = write_translations([('Hello', MARHABA), ('', 'x'), ('Same', 'Same')], path)
            self.assertEqual(count, 1)
            lines = path.read_text(encoding='utf-8').splitlines()
            self.assertEqual(lines[-1], f'Hello={MARHABA}')
            self.assertTrue(all(line.startswith('//') for line in lines[:-1]))

    def test_command_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'ar.csv'
            with source.open('w', encoding='utf-8', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['key', 'source', 'arabic'])
                writer.writerow(['greet', 'Hello', 'مرحبا'])
                writer.writerow(['open', 'Press [E] to open', 'اضغط [E] للفتح'])
            out = Path(tmp) / 'build'
            self.assertEqual(main([str(source), '--out', str(out)]), 0)
            self.assertIn(f'Hello={MARHABA}', (out / '_AutoGeneratedTranslations.txt').read_text(encoding='utf-8'))
            self.assertEqual(json.loads((out / 'compiled.json').read_text(encoding='utf-8'))['Hello'], MARHABA)
            self.assertIn('ﻣ', (out / 'charset.txt').read_text(encoding='utf-8'))
            with (out / 'compiled.csv').open(encoding='utf-8') as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(rows[1]['key'], 'open')
            self.assertIn('[E]', rows[1]['compiled'])


if __name__ == '__main__':
    unittest.main()
