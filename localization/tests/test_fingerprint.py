"""Tests for the overlay's fingerprint table: OCR mistakes still find the right
line, wrong lines don't, and the app's matcher agrees exactly (shared vectors)."""

import csv
import json
import tempfile
import unittest
from pathlib import Path

from arabic_compiler.__main__ import main
from arabic_compiler.fingerprint import (FingerprintTable, build_table, english_text, fingerprint, normalize,
                                         overlay_text)

VECTORS = json.loads((Path(__file__).resolve().parents[2] / 'test/fixtures/fingerprint-vectors.json').read_text(encoding='utf-8'))

LINES = [
    ('We must reach the castle before nightfall.', 'يجب أن نصل إلى القلعة قبل حلول الليل.'),
    ("I'll be right back.", 'سأعود حالًا.'),
    ('Hello, {0}! Welcome to <color=#ff0>Riverwood</color>.', 'مرحبًا يا {0}! أهلًا بك في <color=#ff0>ريفروود</color>.'),
    ('Press [E] to open the gate.', 'اضغط [E] لفتح البوابة.'),
    ('We must reach the village before dawn.', 'يجب أن نصل إلى القرية قبل الفجر.'),
    ("The bridge is out. We'll have to find another way across the river.", 'الجسر مدمر. علينا أن نجد طريقًا آخر لعبور النهر.'),
    ("Don't let them see you.", 'لا تدعهم يرونك.'),
]


def table():
    return FingerprintTable(build_table(LINES)[0])


class Normalizing(unittest.TestCase):
    def test_case_punctuation_accents_and_apostrophes_go(self):
        self.assertEqual(normalize("Café — naïve, ISN'T it?"), 'cafe nalve lsnt lt')

    def test_letters_ocr_mixes_up_fold_together(self):
        self.assertEqual(normalize('I l 1 |'), normalize('l l l l'))
        self.assertEqual(normalize('0'), normalize('o'))
        self.assertEqual(normalize('modern'), normalize('modem'))   # rn reads as m
        self.assertEqual(normalize('vvorld'), normalize('world'))

    def test_markup_and_slots_are_not_text(self):
        self.assertEqual(english_text('Hi {0}, <b>press</b> [E]%s'), ('Hi  , press   ', 3))

    def test_spaces_dont_change_the_fingerprint(self):
        self.assertEqual(fingerprint(normalize('the castle')), fingerprint(normalize('thecastle')))

    def test_overlay_text_keeps_reading_order_and_drops_markup(self):
        self.assertEqual(overlay_text('مرحبًا يا {0}!<br><color=red>[E]</color> للمتابعة'), 'مرحبًا يا …!\n[E] للمتابعة')


class NoisyOcr(unittest.TestCase):
    def assertFinds(self, read, english):
        expected = dict(LINES)[english]
        match = table().lookup(read)
        self.assertIsNotNone(match, f'nothing found for {read!r}')
        self.assertEqual(match.arabic, overlay_text(expected))

    def test_misread_letters(self):
        self.assertFinds('We rnust reach the castle bef0re nightfall', 'We must reach the castle before nightfall.')
        self.assertFinds("The bridge is 0ut. We'll have to fínd another vvay across the rlver.",
                         "The bridge is out. We'll have to find another way across the river.")
        self.assertFinds("l'll be right back", "I'll be right back.")

    def test_spaces_case_and_line_breaks(self):
        self.assertFinds('Wemustreachthecastlebeforenightfall.', 'We must reach the castle before nightfall.')
        self.assertFinds('WE MUST REACH THE CASTLE\nBEFORE NIGHTFALL', 'We must reach the castle before nightfall.')
        self.assertFinds('Dont let them see you', "Don't let them see you.")

    def test_a_couple_of_wrong_letters(self):
        self.assertFinds('The bridqe is out. Well have to find anather way across the river',
                         "The bridge is out. We'll have to find another way across the river.")

    def test_too_many_wrong_letters_find_nothing_rather_than_guess(self):
        # Each wrong letter breaks three trigrams: three in one line is past 0.72.
        self.assertIsNone(table().lookup('The bridqe is out. Well have to find anather way acress the river'))

    def test_filled_in_slots(self):
        self.assertFinds('Hello, Arthur! Welcome to Riverwood.', 'Hello, {0}! Welcome to <color=#ff0>Riverwood</color>.')
        self.assertFinds('Hello, Maximilian the Third! Welcome to Riverwood.', 'Hello, {0}! Welcome to <color=#ff0>Riverwood</color>.')
        self.assertFinds('Press E to open the gate', 'Press [E] to open the gate.')

    def test_the_closest_of_two_similar_lines_wins(self):
        self.assertFinds('We must reach the village before dawn', 'We must reach the village before dawn.')
        self.assertFinds('We must reach the castle before nightfall', 'We must reach the castle before nightfall.')

    def test_unrelated_or_empty_text_finds_nothing(self):
        for read in ['Completely different text here', '', '   ', '!!!', 'Hello!']:
            self.assertIsNone(table().lookup(read), read)

    def test_the_threshold_can_be_changed(self):
        read = 'The bridqe is out. Well have to find anather way across the river'
        self.assertIsNotNone(table().lookup(read))
        self.assertIsNone(table().lookup(read, threshold=0.95))
        self.assertIsNotNone(table().lookup('The bridqe is out. Well have to find anather way acress the river', threshold=0.6))

    def test_lines_far_off_in_length_are_skipped(self):
        long_read = 'We must reach the castle before nightfall, said the old knight to his weary companions.'
        self.assertIsNone(table().lookup(long_read))


class Vectors(unittest.TestCase):
    """The app's matcher (desktop/localization/fingerprint.js) is checked against the same file."""

    def test_fingerprints_match_the_shared_vectors(self):
        for v in VECTORS['vectors']:
            shown, slots = english_text(v['text'])
            n = normalize(shown)
            fp = fingerprint(n)
            self.assertEqual((n, slots, fp.length, f'{fp.simhash:016x}', list(fp.grams)),
                             (v['normalized'], v['slots'], v['length'], v['simhash'], v['grams']), v['text'])

    def test_lookups_match_the_shared_vectors(self):
        t = FingerprintTable(VECTORS['table'])
        for case in VECTORS['lookups']:
            match = t.lookup(case['query'])
            self.assertEqual(match.arabic if match else None, case['arabic'], case['query'])
            if match:
                self.assertAlmostEqual(match.score, case['score'], places=5)


class Output(unittest.TestCase):
    def test_the_table_holds_no_readable_english(self):
        data, _ = build_table(LINES)
        dumped = json.dumps(data, ensure_ascii=False).lower()
        for word in ['castle', 'nightfall', 'riverwood', 'bridge', 'river']:
            self.assertNotIn(word, dumped)

    def test_command_line_writes_the_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'ar.csv'
            with source.open('w', encoding='utf-8', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['source', 'arabic'])
                writer.writerows(LINES)
            out = Path(tmp) / 'build'
            self.assertEqual(main([str(source), '--out', str(out)]), 0)
            data = json.loads((out / 'fingerprints.json').read_text(encoding='utf-8'))
            t = FingerprintTable(data)
            self.assertEqual(t.lookup('Dont let them see you').arabic, 'لا تدعهم يرونك.')


if __name__ == '__main__':
    unittest.main()
