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
from types import SimpleNamespace

from arabic_compiler import packbuild
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


# The same English under two keys, to a man and to a woman; a line that marks a woman; "you" with no marker; a name.
ALIGNED = {
    'Dialogue/Ready_M': {'en': 'Are you ready?', 'zh-Hans': '你准备好了吗？', 'ru': 'Ты готов?'},
    'Dialogue/Ready_F': {'en': 'Are you ready?', 'zh-Hans': '你准备好了吗？', 'ru': 'Ты готова?'},
    'UI/Go_1': {'en': 'Go', 'ru': 'Иди'}, 'UI/Go_2': {'en': 'Go', 'ru': 'Иди'},
    'Dialogue/Back': {'en': 'She came back.', 'ru': 'Она вернулась.'},
    'Dialogue/Power': {'en': 'Your power grows.', 'ru': 'Твоя сила растёт.'},
    'Skill/Skill_Name_7': {'en': 'Seven Star Strike', 'zh-Hans': '七星击'},
    'Skill/Skill_Desc_7': {'en': 'Strikes seven times.', 'zh-Hans': '连击七次。'},
    'UI/Plain': {'en': 'Continue'},
}


def rows_of(aligned):
    return [SimpleNamespace(key=key, source=entry['en'], arabic=None) for key, entry in aligned.items()]


class KeyedLines(unittest.TestCase):
    def test_the_same_english_said_to_someone_else_keeps_its_own_arabic_under_its_key(self):
        variants = locres_pivot.variant_keys(ALIGNED)
        self.assertEqual(variants, {'Dialogue/Ready_M', 'Dialogue/Ready_F'})  # "Go" has one reference: one Arabic
        self.assertEqual(locres_pivot.by_key(ALIGNED)['Dialogue/Ready_F'], {'zh-Hans': '你准备好了吗？', 'ru': 'Ты готова?'})
        self.assertNotIn('UI/Plain', locres_pivot.by_key(ALIGNED))
        # Its hash is of its English and its key; every other line's, of its English alone, as before.
        self.assertNotEqual(line_hash('Are you ready?', 'Dialogue/Ready_F'), line_hash('Are you ready?', 'Dialogue/Ready_M'))
        self.assertEqual(line_hash('Go'), line_hash('Go', None))
        args = SimpleNamespace(variant_keys=variants)
        rows = rows_of(ALIGNED)
        self.assertEqual(packbuild.line_item(rows[1], args), ('Are you ready?', 'Dialogue/Ready_F'))
        self.assertEqual(packbuild.line_item(rows[2], args), 'Go')

    def test_which_lines_the_other_languages_can_change(self):
        groups = locres_pivot.context_candidates(rows_of(ALIGNED), locres_pivot.by_key(ALIGNED), locres_pivot.variant_keys(ALIGNED))
        self.assertEqual(groups['variant'], [('Dialogue/Ready_M', 'Are you ready?'), ('Dialogue/Ready_F', 'Are you ready?')])
        self.assertEqual(groups['feminine'], [('Dialogue/Back', 'She came back.')])
        # "сила" (strength) ends like a feminine verb and isn't one.
        self.assertEqual(groups['second_person'], [('Dialogue/Power', 'Your power grows.')])
        self.assertEqual(groups['names'], [('Skill/Skill_Name_7', 'Seven Star Strike')])  # the description isn't a name
        self.assertEqual(sum(len(g) for g in groups.values()), 5)  # "Go" and "Continue" gain nothing

    def test_a_keyed_line_goes_to_the_memory_with_its_key_and_a_refresh_says_so(self):
        memory = SharedMemory('http://127.0.0.1:9', {'token': 't'})
        posted = []

        def post(path, body):
            posted.append(body)
            return {'arabic': {l['hash']: f'عربي {l.get("key", "")}' for l in body['lines']}}

        item = ('Are you ready?', 'Dialogue/Ready_F')
        with mock.patch.object(memory, '_post', post):
            done, _, _ = memory.translate('steam:1', [item, 'Go'], references={item: {'ru': 'Ты готова?'}}, refresh=True, log=lambda *_: None)
        self.assertEqual(done, {item: 'عربي Dialogue/Ready_F', 'Go': 'عربي '})
        self.assertTrue(posted[0]['refresh'])
        self.assertEqual(posted[0]['lines'][0], {'hash': line_hash(*item), 'english': 'Are you ready?', 'key': 'Dialogue/Ready_F', 'ref': {'ru': 'Ты готова?'}})
        self.assertEqual(posted[0]['lines'][1], {'hash': line_hash('Go'), 'english': 'Go'})

    def build_args(self, tmp, **more):
        return SimpleNamespace(shared='http://127.0.0.1:9', steam_app_id='4115450', game_id=None, resolved_kind='unreal', font_targets=None,
                               pak_list=None, no_translate=False, context='', out=str(tmp), references=locres_pivot.by_source(ALIGNED),
                               references_by_key=locres_pivot.by_key(ALIGNED), variant_keys=locres_pivot.variant_keys(ALIGNED),
                               refresh_context=None, refresh_groups=None, **more)

    def test_a_build_uses_a_keyed_lines_own_arabic_and_falls_back_to_its_englishs(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        stored = {line_hash('Are you ready?'): 'هل أنت مستعد؟',  # from before lines were kept by key
                  line_hash('Are you ready?', 'Dialogue/Ready_F'): 'هل أنتِ مستعدة؟'}
        asked = []

        class Memory:
            def __init__(self, *a):
                pass

            def lookup(self, game, hashes):
                return {h: stored[h] for h in hashes if h in stored}

            def translate(self, game, lines, context='', log=print, references=None, refresh=False):
                asked.append((lines, references, refresh))
                return {i: 'عربي جديد' for i in lines}, {}, False

        rows = rows_of(ALIGNED)
        with mock.patch.object(packbuild, 'SharedMemory', Memory), mock.patch.dict(os.environ, {'GAMESHELF_TOKEN': 't'}):
            packbuild.shared_translate(rows, self.build_args(tmp), lambda *_: None)
        by_key = {r.key: r.arabic for r in rows}
        self.assertEqual(by_key['Dialogue/Ready_F'], 'هل أنتِ مستعدة؟')  # her own line
        self.assertEqual(by_key['Dialogue/Ready_M'], 'هل أنت مستعد؟')    # the English's, until his own is made
        self.assertNotIn(('Are you ready?', 'Dialogue/Ready_M'), asked[0][0])
        self.assertIn('Go', asked[0][0])
        self.assertEqual(asked[0][1]['Seven Star Strike'], {'zh-Hans': '七星击'})

    def test_counting_spends_nothing_and_applying_translates_only_the_chosen_lines_again(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        logged, asked = [], []

        class Memory:
            def __init__(self, *a):
                pass

            def translate(self, game, lines, context='', log=print, references=None, refresh=False):
                asked.append((game, lines, references, refresh))
                return {i: 'عربي' for i in lines}, {}, False

        rows = rows_of(ALIGNED)
        with mock.patch.object(packbuild, 'SharedMemory', Memory), mock.patch.dict(os.environ, {'GAMESHELF_TOKEN': 't'}):
            stopped = packbuild.refresh_context(rows, SimpleNamespace(**{**vars(self.build_args(tmp)), 'refresh_context': 'count'}), logged.append)
            self.assertTrue(stopped)
            self.assertEqual(asked, [])  # counted only
            self.assertTrue(any('variant: 2 lines' in line for line in logged))
            self.assertTrue(any('second_person: 1 lines' in line and '(not chosen)' in line for line in logged))
            self.assertTrue(any('Chosen (variant, feminine, names): 4 of 7 lines' in line for line in logged), logged)
            listing = (tmp / 'context-candidates.csv').read_text(encoding='utf-8-sig')
            self.assertIn('feminine,Dialogue/Back,She came back.,Она вернулась.', listing)
            # Applying: the chosen lines, each with its own key's references, as a refresh.
            apply_args = SimpleNamespace(**{**vars(self.build_args(tmp)), 'refresh_context': 'apply', 'refresh_groups': 'variant,feminine'})
            self.assertFalse(packbuild.refresh_context(rows, apply_args, logged.append))
        game, lines, references, refresh = asked[0]
        self.assertEqual((game, refresh), ('steam:4115450', True))
        self.assertEqual(lines, [('Are you ready?', 'Dialogue/Ready_M'), ('Are you ready?', 'Dialogue/Ready_F'), 'She came back.'])
        self.assertEqual(references[('Are you ready?', 'Dialogue/Ready_F')]['ru'], 'Ты готова?')
        with self.assertRaises(packbuild.BuildError):
            packbuild.refresh_context(rows, SimpleNamespace(**{**vars(self.build_args(tmp)), 'refresh_context': 'count', 'refresh_groups': 'everything'}), logged.append)

    def test_a_set_of_arabic_by_hash_gives_a_keyed_line_its_own(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / 'set.json').write_text(json.dumps({'lines': [[line_hash('Are you ready?'), 'هل أنت مستعد؟'],
                                                            [line_hash('Are you ready?', 'Dialogue/Ready_F'), 'هل أنتِ مستعدة؟']]}), encoding='utf-8')
        rows = rows_of(ALIGNED)[:2]
        packbuild.apply_by_hash(rows, tmp / 'set.json', lambda *_: None)
        self.assertEqual([r.arabic for r in rows], ['هل أنت مستعد؟', 'هل أنتِ مستعدة؟'])


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
