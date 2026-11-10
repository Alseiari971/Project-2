"""A game's other official languages as context for its Arabic (locres_pivot.py): the .locres files of several
languages lined up by (namespace, key), and the references sent to the translator beside each English line."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from arabic_compiler import locres as locres_format
from arabic_compiler import locres_pivot
from arabic_compiler.shared import SharedMemory, line_hash
from arabic_compiler.sources import read_source
from arabic_compiler.translate import Cache, Translator
from test_ue5_runtime import FAKE_REPAK, FAKE_RETOC, tool


def locres(entries: dict) -> bytes:
    """A .locres with {namespace: {key: text}}."""
    return locres_format.write(locres_format.LocRes(3, [
        locres_format.Namespace(ns, [locres_format.Entry(key, text, i + 1) for i, (key, text) in enumerate(keys.items())])
        for ns, keys in entries.items()]))


ENGLISH = {'Dialogue': {'Ready_F': 'Are you ready?', 'Ready_M': 'Are you ready, Soul?', 'Sect': 'The Order of Seven Stars', 'Same': 'OK'},
           'UI': {'Start': 'Start the journey'}}
CHINESE = {'Dialogue': {'Ready_F': '你准备好了吗？', 'Ready_M': '魂，你准备好了吗？', 'Sect': '七星门', 'Same': 'OK'},
           'UI': {'Start': '踏上旅程'}}
FRENCH = {'Dialogue': {'Ready_F': 'Es-tu prête ?', 'Ready_M': 'Es-tu prêt, Soul ?', 'Sect': 'L\'Ordre des Sept Étoiles'},
          'UI': {'Start': 'Commencer le voyage'}}


class Alignment(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_english_chinese_and_french_line_up_by_namespace_and_key(self):
        for culture, entries in (('en', ENGLISH), ('zh-Hans', CHINESE), ('fr', FRENCH), ('ko', {'UI': {'Start': '여정을 시작'}})):
            (self.tmp / culture).mkdir()
            (self.tmp / culture / 'Game.locres').write_bytes(locres(entries))
        rows = {row['id']: row for row in locres_pivot.build_multilang_context(self.tmp)}
        # The feminine line: French says who is spoken to ("prête"), Chinese what was meant.
        self.assertEqual(rows['Dialogue/Ready_F'], {'id': 'Dialogue/Ready_F', 'en': 'Are you ready?', 'zh-Hans': '你准备好了吗？', 'fr': 'Es-tu prête ?'})
        self.assertEqual(rows['Dialogue/Ready_M']['fr'], 'Es-tu prêt, Soul ?')
        self.assertEqual(rows['Dialogue/Sect']['zh-Hans'], '七星门')  # the sect's own name, not the English rendering
        # A line the other language never translated (the same text) is no help; one it doesn't have is simply absent.
        self.assertEqual(rows['Dialogue/Same'], {'id': 'Dialogue/Same', 'en': 'OK'})
        self.assertNotIn('ko', rows['UI/Start'])  # Chinese is the original here; Korean isn't read as well
        self.assertEqual(len(rows), 5)

    def test_the_original_and_a_gendered_language_are_picked_from_what_the_game_has(self):
        # Phantom Blade Zero: no French or Spanish, so Russian (gendered past tense) is the gender hint.
        pbz = ['en-US', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'th', 'vi', 'ru']
        self.assertEqual(locres_pivot.pick_references(pbz), {'original': 'zh-Hans', 'gender': 'ru'})
        self.assertEqual(locres_pivot.pick_references(['de', 'ja', 'es', 'fr']), {'original': 'ja', 'gender': 'fr'})
        self.assertEqual(locres_pivot.pick_references(['de', 'pl']), {'original': None, 'gender': None})

    def test_the_other_languages_files_are_found_beside_the_english_one(self):
        listing = ['Game/Content/Localization/Game/en-US/Game.locres', 'Game/Content/Localization/Game/zh-Hans/Game.locres',
                   'Game/Content/Localization/Game/ru/Game.locres', 'Game/Content/Localization/Engine/fr/Engine.locres',
                   'Game/Content/Localization/Game/Game.locmeta', 'Game/Content/Movies/intro.mp4']
        self.assertEqual(locres_pivot.sibling_locres(listing, 'Game/Content/Localization/Game/en-US/Game.locres'),
                         {'zh-Hans': 'Game/Content/Localization/Game/zh-Hans/Game.locres', 'ru': 'Game/Content/Localization/Game/ru/Game.locres'})

    def test_an_english_line_under_several_keys_gets_the_reference_most_of_them_have(self):
        aligned = {'a': {'en': 'Go!', 'ru': 'Иди!'}, 'b': {'en': 'Go!', 'ru': 'Иди!'}, 'c': {'en': 'Go!', 'ru': 'Идите!'},
                   'd': {'en': 'Stop'}}
        self.assertEqual(locres_pivot.by_source(aligned), {'Go!': {'ru': 'Иди!'}})


class StubProvider:
    kind, model, timeout = 'openai', 'm', 5

    def request(self, system, user):
        return {'system': system, 'user': user}, {}

    def endpoint(self):
        return 'http://127.0.0.1:9/never'

    def answer_text(self, response):
        return response


class ToTheTranslator(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def translator(self, references):
        cache = Cache(self.tmp / 'cache.sqlite')
        self.addCleanup(cache.close)
        translator = Translator(StubProvider(), cache, references=references, log=lambda *_: None)
        sent = []

        def post(body, headers):
            sent.append(body)
            rows = json.loads(body['user'])
            return json.dumps({'translations': [{'id': r['id'], 'arabic': f'عربي {r["id"]}'} for r in rows]})

        translator._post = post
        return translator, sent

    def test_each_line_goes_with_its_references_and_the_rules_for_them(self):
        translator, sent = self.translator({'Are you ready?': {'zh-Hans': '你准备好了吗？', 'fr': 'Es-tu prête ?'}})
        done, failed = translator.translate(['Are you ready?', 'Continue'])
        self.assertEqual(failed, {})
        self.assertEqual(set(done), {'Are you ready?', 'Continue'})
        rows = json.loads(sent[0]['user'])
        self.assertIn({'id': 0, 'text': 'Are you ready?', 'zh-Hans': '你准备好了吗？', 'fr': 'Es-tu prête ?'}, rows)
        self.assertIn({'id': 1, 'text': 'Continue'}, rows)
        self.assertIn('أنتَ or أنتِ', sent[0]['system'])
        self.assertIn('translate what the original means', sent[0]['system'])
        self.assertIn('Keep the language clean', sent[0]['system'])

    def test_without_references_nothing_changes_and_a_new_reference_is_a_new_translation(self):
        plain, sent = self.translator({})
        plain.translate(['Continue'])
        self.assertEqual(json.loads(sent[0]['user']), [{'id': 0, 'text': 'Continue'}])
        self.assertNotIn('other languages', sent[0]['system'])
        with_ref, _ = self.translator({'Continue': {'fr': 'Continuer'}})
        self.assertNotEqual(plain.cache_key('Continue'), with_ref.cache_key('Continue'))
        self.assertEqual(plain.cache_key('Start'), with_ref.cache_key('Start'))

    def test_the_shared_memory_gets_the_references_with_the_lines(self):
        memory = SharedMemory('http://127.0.0.1:9', {'token': 't'})
        posted = []

        def post(path, body):
            posted.append((path, body))
            return {'arabic': {l['hash']: 'عربي' for l in body['lines']}}

        with mock.patch.object(memory, '_post', post):
            done, failed, limited = memory.translate('steam:4115450', ['Are you ready?', 'Continue'],
                                                     references={'Are you ready?': {'ru': 'Ты готова?', 'text': 'no'}}, log=lambda *_: None)
        self.assertEqual((set(done), failed, limited), ({'Are you ready?', 'Continue'}, {}, False))
        lines = {l['english']: l for l in posted[0][1]['lines']}
        self.assertEqual(lines['Are you ready?'], {'hash': line_hash('Are you ready?'), 'english': 'Are you ready?', 'ref': {'ru': 'Ты готова?'}})
        self.assertNotIn('ref', lines['Continue'])


class FromTheGame(unittest.TestCase):
    def test_a_games_chinese_and_french_text_are_read_with_its_english(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        tools = tmp / 'tools'
        tools.mkdir()
        env = mock.patch.dict(os.environ, {'GAMESHELF_REPAK': str(tool(tools, 'repak', FAKE_REPAK)),
                                           'GAMESHELF_RETOC': str(tool(tools, 'retoc', FAKE_RETOC))})
        env.start()
        self.addCleanup(env.stop)
        paks = tmp / 'Game' / 'Blade' / 'Content' / 'Paks'
        paks.mkdir(parents=True)
        base = 'Blade/Content/Localization/Game'
        (paks / 'pakchunk0-Windows.pak').write_text(json.dumps({'files': {
            f'{base}/en/Game.locres': locres(ENGLISH).hex(), f'{base}/zh-Hans/Game.locres': locres(CHINESE).hex(),
            f'{base}/fr/Game.locres': locres(FRENCH).hex(), f'{base}/de/Game.locres': locres({'UI': {'Start': 'Reise beginnen'}}).hex()}}))
        source = read_source(tmp / 'Game')
        references = source.extra['references']
        self.assertEqual(references['Are you ready?'], {'zh-Hans': '你准备好了吗？', 'fr': 'Es-tu prête ?'})
        self.assertEqual(references['The Order of Seven Stars']['zh-Hans'], '七星门')
        self.assertNotIn('OK', references)
        self.assertTrue(any('zh-Hans (the original) and fr (for gender)' in note for note in source.notes), source.notes)


if __name__ == '__main__':
    unittest.main()
