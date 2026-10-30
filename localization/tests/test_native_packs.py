"""Tests for native packs beyond Unreal and Unity: reading Ren'Py scripts and
archives and Godot translation tables, and building Ren'Py and Godot packs,
Unreal packs that replace the game's fonts, and Unity's font settings."""

import csv
import json
import os
import pickle
import shutil
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

from arabic_compiler.packbuild import DEFAULT_BOLD_FONT, DEFAULT_FONT, build, parse_args
from arabic_compiler.sources import SourceError, read_rpa, read_source, renpy_lines
from arabic_compiler.translate import problem_with, tokens
from test_build_pack import HAS_NODE, REPO, FakeApi, handmade_v3, node_read_pack

SCRIPT = '''\
# The game's script.
define s = Character("Sylvie", color="#c8ffc8")
image bg meadow = "meadow.jpg"

init python:
    config.thing = "Not dialogue at all"
# A comment at the left edge inside the block doesn't end it.
    renpy.notify("Still code")

label start:
    play music "illurock.opus"
    voice "line_001.ogg"
    scene bg lecturehall
    "It's only when I hear the sounds of shuffling feet that I realize that the lecture's over."
    s happy "Hi there! How was class?" with dissolve
    s "She said \\"hello\\" and   waved.\\nThen left."
    "Use {{braces}} and [[brackets]] like this."
    "Hello, [player_name]! {i}Welcome{/i} back."
    $ renpy.pause(1.0)
    menu:
        "As soon as she catches my eye, I decide..."
        "To ask her right away.":
            jump rightaway
        "To ask her later." if not asked:
            jump later

screen hud():
    text "Score"
    textbutton "Start" action Start()
'''


def renpy_archive(path: Path, files: dict, version=3):
    """An archive as Ren'Py writes it (launcher/game/archiver.rpy)."""
    key = 0x42424242 if version == 3 else 0
    index = {}
    with path.open('wb') as f:
        f.write(b'RPA-3.0 XXXXXXXXXXXXXXXX XXXXXXXX\n' if version == 3 else b'RPA-2.0 XXXXXXXXXXXXXXXX\n')
        for name, data in files.items():
            f.write(b"Made with Ren'Py.")
            offset = f.tell()
            f.write(data)
            index[name] = [(offset ^ key, len(data) ^ key, b'')]
        index_offset = f.tell()
        f.write(zlib.compress(pickle.dumps(index, pickle.HIGHEST_PROTOCOL)))
        f.seek(0)
        f.write(b'RPA-3.0 %016x %08x\n' % (index_offset, key) if version == 3 else b'RPA-2.0 %016x\n' % index_offset)
    return path


class RenpySources(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_dialogue_and_choices_read_as_renpy_reads_them(self):
        lines = [text for _, text in renpy_lines(SCRIPT)]
        self.assertEqual(lines, [
            "It's only when I hear the sounds of shuffling feet that I realize that the lecture's over.",
            'Hi there! How was class?',
            'She said "hello" and waved.\nThen left.',
            'Use {{braces}} and [[brackets]] like this.',
            'Hello, [player_name]! {i}Welcome{/i} back.',
            'As soon as she catches my eye, I decide...',
            'To ask her right away.',
            'To ask her later.',
        ])

    def test_archives_written_by_renpy_are_read(self):
        script = SCRIPT.encode('utf-8')
        for version in (3, 2):
            archive = renpy_archive(self.tmp / f'v{version}.rpa', {'script.rpy': script, 'script.rpyc': b'compiled', 'images/bg.jpg': b'jpeg'}, version)
            self.assertEqual(read_rpa(archive), {'script.rpy': script})

    def test_an_archive_index_with_code_in_it_is_refused(self):
        archive = self.tmp / 'evil.rpa'
        payload = zlib.compress(pickle.dumps({'x.rpy': [(os.system, 0, b'')]}))  # would run os.system if unpickled freely
        archive.write_bytes(b'RPA-2.0 %016x\n' % 25 + payload)
        with self.assertRaisesRegex(SourceError, 'more than names and numbers'):
            read_rpa(archive)

    def test_a_game_folder_reads_scripts_and_archives_but_not_translations(self):
        game = self.tmp / 'TheQuestion'
        (game / 'renpy').mkdir(parents=True)
        (game / 'game/tl/french').mkdir(parents=True)
        (game / 'game/tl/french/script.rpy').write_text('translate french start_1:\n    "Bonjour"\n', encoding='utf-8')
        (game / 'game/options.rpy').write_text('label splash:\n    "A loose script line."\n', encoding='utf-8')
        renpy_archive(game / 'game/scripts.rpa', {'script.rpy': SCRIPT.encode('utf-8')})
        source = read_source(game)
        self.assertEqual(source.engine, 'renpy')
        self.assertEqual(source.rows[0].source, 'A loose script line.')
        self.assertEqual(source.rows[0].key, 'options.rpy:2')
        self.assertIn('scripts.rpa/script.rpy:', source.rows[1].key)
        self.assertNotIn('Bonjour', [r.source for r in source.rows])

    def test_a_game_with_only_compiled_scripts_says_what_to_do(self):
        game = self.tmp / 'Compiled'
        (game / 'renpy').mkdir(parents=True)
        (game / 'game').mkdir()
        (game / 'game/script.rpyc').write_bytes(b'compiled')
        renpy_archive(game / 'game/scripts.rpa', {'script.rpyc': b'compiled'})
        with self.assertRaisesRegex(SourceError, 'unrpyc'):
            read_source(game)

    def test_renpy_text_tags_must_survive_translation(self):
        self.assertEqual(tokens('{i}Really{/i}? {w=0.5}[name]')['{/i}'], 1)
        self.assertIn('lost {/i}', problem_with('{i}Really{/i}?', '{i}حقًا؟'))
        self.assertIsNone(problem_with('{i}Really{/i}? {w=0.5}', '{i}حقًا{/i}؟ {w=0.5}'))


class GodotSources(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_translation_tables_are_looked_up_by_key(self):
        table = self.tmp / 'text.csv'
        table.write_text('keys,en,ar\nTITLE,Chapter One,الفصل الأول\nINTRO_1,"We must go, now.",\n', encoding='utf-8')
        source = read_source(table)
        self.assertTrue(source.keyed)
        self.assertEqual([(r.key, r.source, r.arabic) for r in source.rows],
                         [('TITLE', 'Chapter One', 'الفصل الأول'), ('INTRO_1', 'We must go, now.', None)])

    def test_gettext_files(self):
        po = self.tmp / 'game.po'
        po.write_text('msgid ""\nmsgstr "Content-Type: text/plain"\n\n#: main.tscn\nmsgid "Start game"\nmsgstr ""\n\n'
                      'msgid "A long line "\n"in two parts."\nmsgstr "سطر طويل"\n\nmsgctxt "menu"\nmsgid "Back"\nmsgstr ""\n', encoding='utf-8')
        source = read_source(po)
        self.assertEqual([(r.source, r.arabic) for r in source.rows], [('Start game', None), ('A long line in two parts.', 'سطر طويل')])
        self.assertTrue(source.keyed)

    def test_a_project_without_tables_is_read_from_scenes_and_scripts(self):
        project = self.tmp / 'game'
        project.mkdir()
        (project / 'project.godot').write_text('config_version=5\n', encoding='utf-8')
        (project / 'main.tscn').write_text('[node name="Title" type="Label"]\ntext = "Chapter One"\n[node name="Hint" type="Label"]\ntext = "res://x.png"\n', encoding='utf-8')
        (project / 'main.gd').write_text('func _ready():\n\t$Subtitle.text = tr("Don\'t let them see you.")\n\tvar path = "user://save.dat"\n', encoding='utf-8')
        source = read_source(project)
        self.assertFalse(source.keyed)
        self.assertEqual(sorted(r.source for r in source.rows), ['Chapter One', "Don't let them see you."])

    def test_a_project_with_tables_uses_them(self):
        project = self.tmp / 'game'
        (project / 'translations').mkdir(parents=True)
        (project / 'project.godot').write_text('config_version=5\n', encoding='utf-8')
        (project / 'translations/text.csv').write_text('keys,en\nTITLE,Chapter One\n', encoding='utf-8')
        (project / 'main.tscn').write_text('text = "TITLE"\n', encoding='utf-8')
        source = read_source(project)
        self.assertTrue(source.keyed)
        self.assertEqual([(r.key, r.source) for r in source.rows], [('TITLE', 'Chapter One')])

    def test_packed_godot_games_are_left_for_the_engines_tools(self):
        game = self.tmp / 'export'
        game.mkdir()
        (game / 'Game.pck').write_bytes(b'GDPC')
        with self.assertRaisesRegex(SourceError, 'GDRE Tools'):
            read_source(game)


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class BuildingNative(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = Path(tempfile.mkdtemp())
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(cls.keys / 'k')], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.keys)

    def setUp(self):
        self.api = FakeApi()
        self.tmp = Path(tempfile.mkdtemp())
        self.logged = []
        previous = os.environ.get('OPENAI_API_KEY')
        os.environ['OPENAI_API_KEY'] = 'secret-key'
        self.addCleanup(lambda: os.environ.pop('OPENAI_API_KEY') if previous is None else os.environ.__setitem__('OPENAI_API_KEY', previous))

    def tearDown(self):
        self.api.close()
        shutil.rmtree(self.tmp)

    def run_build(self, source, *extra):
        args = parse_args([str(source), '--id', 'test-ar', '--version', '1.0.0', '--steam-app-id', '4242', '--key', str(self.keys / 'k/pack-signing.key'),
                           '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base, *extra])
        return build(args, log=self.logged.append)

    def read(self, pack):
        return node_read_pack(pack, self.keys / 'k/pack-signing.pub')

    def test_a_renpy_pack_holds_plain_arabic_and_the_font(self):
        script = self.tmp / 'script.rpy'
        script.write_text(SCRIPT, encoding='utf-8')
        pack = self.run_build(script)
        read = self.read(pack)
        self.assertEqual(read['manifest']['engine'], 'renpy')
        folder = 'game/tl/arabic/gameshelf/'
        self.assertEqual(sorted(read['files']), [folder + 'FONT-LICENSE-OFL.txt', folder + 'IBMPlexSansArabic-Regular.ttf', folder + 'strings.json'])
        data = json.loads((pack / 'payload' / folder / 'strings.json').read_text(encoding='utf-8'))
        self.assertEqual(data['font'], 'IBMPlexSansArabic-Regular.ttf')
        # Ren'Py shapes it and fills in [names] itself: plain Arabic, tags and names kept.
        self.assertEqual(data['lines']['Hello, [player_name]! {i}Welcome{/i} back.'], 'عربي Hello, [player_name]! {i}Welcome{/i} back.')
        self.assertFalse(any(0xFE70 <= ord(c) <= 0xFEFF for text in data['lines'].values() for c in text))
        self.assertEqual((pack / 'payload' / folder / 'IBMPlexSansArabic-Regular.ttf').read_bytes(), DEFAULT_FONT.read_bytes())

    def godot_table(self):
        table = self.tmp / 'text.csv'
        table.write_text('keys,en\nTITLE,Chapter One\nINTRO_1,Don\'t let them see you.\n', encoding='utf-8')
        return table

    def test_a_godot_4_pack_maps_the_games_keys_to_plain_arabic(self):
        pack = self.run_build(self.godot_table())
        read = self.read(pack)
        self.assertEqual(read['manifest']['engine'], 'godot')
        self.assertEqual(read['manifest']['requires'], {'godot': 4})
        self.assertEqual(sorted(read['files']), ['gameshelf_arabic/FONT-LICENSE-OFL.txt', 'gameshelf_arabic/IBMPlexSansArabic-Bold.ttf',
                                                 'gameshelf_arabic/IBMPlexSansArabic-Regular.ttf', 'gameshelf_arabic/strings.json'])
        data = json.loads((pack / 'payload/gameshelf_arabic/strings.json').read_text(encoding='utf-8'))
        self.assertEqual(data['lines'], {'TITLE': 'عربي Chapter One', 'INTRO_1': "عربي Don't let them see you."})
        self.assertEqual(data['fonts'], {'regular': 'IBMPlexSansArabic-Regular.ttf', 'bold': 'IBMPlexSansArabic-Bold.ttf'})

    def test_a_godot_3_pack_is_shaped_and_keeps_its_keys_through_review(self):
        out = self.run_build(self.godot_table(), '--review')
        reviewed = out / 'translations.csv'
        self.assertTrue(reviewed.read_bytes().startswith(b'\xef\xbb\xbf'))  # opens in Excel as UTF-8
        with reviewed.open(encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        self.assertEqual({r['lookup'] for r in rows}, {'key'})
        rows[0]['arabic'] = 'الفصل الأول'
        with reviewed.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        pack = self.run_build(reviewed, '--kind', 'godot', '--godot', '3')
        self.assertEqual(self.read(pack)['manifest']['requires'], {'godot': 3})
        data = json.loads((pack / 'payload/gameshelf_arabic/strings.json').read_text(encoding='utf-8'))
        self.assertEqual(set(data['lines']), {'TITLE', 'INTRO_1'})
        self.assertEqual(data['lines']['TITLE'], 'ﻝﻭﻷﺍ ﻞﺼﻔﻟﺍ')  # shaped, screen order

    def fake_packer(self):
        script = self.tmp / 'repak'
        script.write_text(f'#!{shutil.which("python3")}\nimport pathlib, sys\npathlib.Path(sys.argv[-1]).write_bytes(b"FAKEPAK")\n')
        script.chmod(0o755)
        return script

    def test_an_unreal_pack_puts_the_arabic_font_in_place_of_the_games_fonts(self):
        locres_file = self.tmp / 'Game.locres'
        locres_file.write_bytes(handmade_v3())
        listing = self.tmp / 'paks.txt'
        listing.write_text('LogPakFile: Display: "../../../MyGame/Content/UI/Fonts/Roboto-Bold.ufont" offset: 1, size: 2\n'
                           'LogPakFile: Display: "../../../MyGame/Content/UI/Fonts/Roboto-Regular.ufont" offset: 3, size: 4\n'
                           'LogPakFile: Display: "../../../MyGame/Content/UI/Fonts/Roboto.uasset" offset: 5, size: 6\n', encoding='utf-8')
        pack = self.run_build(locres_file, '--locres-path', 'MyGame/Content/Localization/Game/en/Game.locres',
                              '--packer-path', str(self.fake_packer()), '--pak-list', str(listing))
        self.assertEqual(self.read(pack)['files'], ['pakchunk99-ArabicLocalization_P.pak'])
        fonts = self.tmp / 'out/stage/pak/MyGame/Content/UI/Fonts'
        self.assertEqual(sorted(p.name for p in fonts.iterdir()), ['Roboto-Bold.ufont', 'Roboto-Regular.ufont'])
        self.assertEqual((fonts / 'Roboto-Bold.ufont').read_bytes(), DEFAULT_BOLD_FONT.read_bytes())
        self.assertEqual((fonts / 'Roboto-Regular.ufont').read_bytes(), DEFAULT_FONT.read_bytes())

    def test_an_unreal_pack_takes_font_paths_from_extracted_files_too(self):
        locres_file = self.tmp / 'Game.locres'
        locres_file.write_bytes(handmade_v3())
        extracted = self.tmp / 'extracted'
        (extracted / 'Engine/Content/Slate/Fonts').mkdir(parents=True)
        (extracted / 'Engine/Content/Slate/Fonts/Roboto-Regular.ttf').write_bytes(b'font')
        (extracted / 'MyGame/Content/Movies').mkdir(parents=True)
        (extracted / 'MyGame/Content/Movies/intro.mp4').write_bytes(b'video')
        self.run_build(locres_file, '--locres-path', 'MyGame/Content/Localization/Game/en/Game.locres',
                       '--packer-path', str(self.fake_packer()), '--extracted', str(extracted))
        staged = self.tmp / 'out/stage/pak/Engine/Content/Slate/Fonts/Roboto-Regular.ttf'
        self.assertEqual(staged.read_bytes(), DEFAULT_FONT.read_bytes())
        self.assertFalse((self.tmp / 'out/stage/pak/MyGame/Content/Movies').exists())

    def test_unity_packs_turn_on_the_ui_font_unless_told_not_to(self):
        bepinex = self.tmp / 'BepInEx'
        (bepinex / 'BepInEx/core').mkdir(parents=True)
        (bepinex / 'BepInEx/core/BepInEx.dll').write_bytes(b'core')
        table = self.tmp / 'lines.csv'
        table.write_text('source,arabic\nHello there,مرحبًا\n', encoding='utf-8')
        pack = self.run_build(table, '--kind', 'unity', '--bepinex', str(bepinex), '--autotranslator', str(bepinex))
        self.assertEqual(self.read(pack)['manifest']['uguiFont'], 'Arial')
        pack = self.run_build(table, '--kind', 'unity', '--bepinex', str(bepinex), '--autotranslator', str(bepinex), '--no-ugui-font')
        self.assertNotIn('uguiFont', self.read(pack)['manifest'])


if __name__ == '__main__':
    unittest.main()
