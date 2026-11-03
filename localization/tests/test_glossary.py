"""Tests for the glossary pass: candidate names and terms, gender samples, the
glossary request, and each translation batch getting the terms in its own
lines and how to speak to the player."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from arabic_compiler import glossary
from arabic_compiler.packbuild import build, parse_args
from test_build_pack import HAS_NODE, REPO, FakeApi

LINES = [
    'Kratos, the Leviathan Axe is yours now.',
    'Take the Leviathan Axe to Brok before nightfall.',
    'Brok forged it in the old days, long before Midgard froze.',
    'We must cross Midgard before the winter.',
    'Health Potion',
    'Skill Tree',
    'Thank you, my lady. You saved us all.',
    'Yes',
    'The bridge is out.',
    'Press {0} to open the Skill Tree.',
]


class Candidates(unittest.TestCase):
    def test_names_recurring_proper_nouns_and_ui_terms(self):
        found = glossary.candidates(LINES)
        for term in ('Leviathan Axe', 'Brok', 'Midgard', 'Health Potion', 'Skill Tree'):
            self.assertIn(term, found)
        for word in ('Kratos', 'Take', 'The', 'Yes', 'Thank', 'We'):  # once at a sentence start, or plain English
            self.assertNotIn(word, found)
        # Most frequent first: "Skill Tree" twice (a menu label and in a line), "Health Potion" once.
        self.assertLess(found.index('Skill Tree'), found.index('Health Potion'))

    def test_samples_hint_at_the_players_gender(self):
        self.assertEqual(glossary.samples(LINES), ['Thank you, my lady. You saved us all.'])

    def test_a_glossary_is_kept_to_its_shape(self):
        cleaned = glossary.clean({'terms': {'Brok': 'بروك', 'Steam': 'Steam', 'Midgard': 'Midgard land', 'x' * 90: 'س', 'Axe': 7},
                                  'player': {'gender': 'robot', 'name': 'Kratos'}})
        self.assertEqual(cleaned, {'terms': {'Brok': 'بروك', 'Steam': 'Steam'}, 'player': {'gender': 'unknown', 'name': 'Kratos'}})
        self.assertEqual(glossary.parse_answer('```json\n{"terms": {"Brok": "بروك"}, "player": {"gender": "feminine"}}\n```'),
                         {'terms': {'Brok': 'بروك'}, 'player': {'gender': 'feminine', 'name': ''}})
        self.assertEqual(glossary.merge({'terms': {'Brok': 'بروك'}}, {'terms': {'Brok': 'بروكي', 'Midgard': 'ميدغارد'}, 'player': {'gender': 'masculine'}}),
                         {'terms': {'Brok': 'بروك', 'Midgard': 'ميدغارد'}, 'player': {'gender': 'masculine', 'name': ''}})

    def test_each_batch_is_told_only_its_own_terms_and_how_to_speak_to_the_player(self):
        known = {'terms': {'Brok': 'بروك', 'Midgard': 'ميدغارد', 'Axe': 'فأس'}, 'player': {'gender': 'feminine', 'name': 'Freya'}}
        section = glossary.prompt_section(known, ['Brok forged it.', 'Climb the Axeman tower.'])
        self.assertIn('- Brok -> بروك', section)
        self.assertNotIn('Midgard', section)
        self.assertNotIn('فأس', section)  # "Axeman" isn't "Axe"
        self.assertIn('female (Freya)', section)
        self.assertIn('أنتِ', section)
        self.assertIn('masculine', glossary.prompt_section({'terms': {'Brok': 'بروك'}, 'player': {'gender': 'unknown'}}, ['Hi']))
        # Nothing known: nothing said, and cached lines stay as they were.
        self.assertEqual(glossary.prompt_section({'terms': {}, 'player': {'gender': 'unknown'}}, ['Brok']), '')
        self.assertEqual(glossary.line_key({'terms': {}, 'player': {'gender': 'unknown'}}, 'Brok'), '')
        self.assertNotEqual(glossary.line_key(known, 'Brok forged it.'), glossary.line_key(known, 'Climb the tower.'))


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class GlossaryInBuilds(unittest.TestCase):
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
        self.source = self.tmp / 'lines.json'
        self.source.write_text(json.dumps([{'source': line} for line in LINES]), encoding='utf-8')

    def build(self, *extra):
        args = parse_args([str(self.source), '--id', 'g-ar', '--version', '1.0.0', '--steam-app-id', '4242', '--key', str(self.keys / 'pack-signing.key'),
                           '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', self.api.base, *extra])
        return build(args, log=lambda *_: None)

    def test_the_glossary_is_made_first_kept_and_given_to_every_batch(self):
        self.build('--batch', '4')
        systems = self.api.systems
        self.assertTrue(systems[0].startswith('You prepare a translation glossary'))
        asked = json.loads(self.api.requests[0]['body']['messages'][1]['content'])
        self.assertIn('Leviathan Axe', asked['terms'])
        self.assertEqual(asked['samples'], ['Thank you, my lady. You saved us all.'])
        saved = json.loads((self.tmp / 'out' / 'glossary.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['terms']['Brok'], 'عربي-Brok')
        self.assertEqual(saved['player']['gender'], 'feminine')
        batches = systems[1:]
        self.assertGreaterEqual(len(batches), 3)
        self.assertTrue(all('use feminine Arabic forms' in s for s in batches))
        with_brok = [s for s, r in zip(batches, self.api.requests[1:]) if 'Brok' in r['body']['messages'][1]['content']]
        self.assertTrue(with_brok and all('- Brok -> عربي-Brok' in s for s in with_brok))
        # Another build uses the saved glossary (edit it to fix a name) and pays for nothing again.
        before = len(self.api.requests)
        self.build('--batch', '4')
        self.assertEqual(len(self.api.requests), before)

    def test_no_glossary_when_asked(self):
        self.build('--no-glossary')
        self.assertFalse(any(s.startswith('You prepare a translation glossary') for s in self.api.systems))
        self.assertFalse(any('Use these Arabic renderings' in s for s in self.api.systems))


if __name__ == '__main__':
    unittest.main()
