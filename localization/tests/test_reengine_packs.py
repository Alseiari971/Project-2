"""Tests for RE Engine packs: the .pak format, REMSG_Converter's message dumps,
and building whole packs (with a stand-in for REMSG_Converter, which the pack's
author installs)."""

import csv
import json
import shutil
import struct
import zlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from arabic_compiler.fingerprint import FingerprintTable
from arabic_compiler.packbuild import BuildError, build, parse_args
from arabic_compiler.remsg import PATCH_MARKER, MsgError, extract_messages
from arabic_compiler.remsg import read_dump, write_dump
from arabic_compiler.repak import ENTRY, HEADER, GamePak, PakError, murmur3_32, path_hashes, read_pak, write_pak
from arabic_compiler.sources import SourceError, read_source
from test_build_pack import HAS_NODE, REPO, FakeApi, node_read_pack

LANGUAGES = list(range(0, 33))  # a full RE Engine language list: English is 1, Arabic 21


def dump_json(entries, languages=LANGUAGES):
    """A REMSG_Converter JSON dump: entries are (guid, English)."""
    return {
        'version': 22,
        'languages': languages,
        'attribute_headers': [],
        'entries': [{'name': f'line_{i}', 'guid': guid, 'soundId': 0, 'hash': 0, 'attributes': [],
                     'content': ['' if lang != 1 else english for lang in languages]}
                    for i, (guid, english) in enumerate(entries)],
    }


ENTRIES = [('00000000-0000-0000-0000-000000000001', 'We must reach the castle before nightfall.'),
           ('00000000-0000-0000-0000-000000000002', 'Leon, <COL RED>get down</COL>!'),
           ('00000000-0000-0000-0000-000000000003', '')]

# Stands in for REMSG_Converter's command line: -m json|csv -i <file.msg.N> [-e <edited>].
# Reading writes <file>.json from the fake .msg (which holds JSON); writing makes <file>.new from the edited dump.
FAKE_TOOL = '''
import argparse, json, pathlib
p = argparse.ArgumentParser()
p.add_argument("-m"); p.add_argument("-i"); p.add_argument("-e")
a = p.parse_args()
src = pathlib.Path(a.i)
if a.e:
    pathlib.Path(a.i + ".new").write_bytes(b"FAKEMSG" + pathlib.Path(a.e).read_bytes())
else:
    raw = src.read_bytes()
    # A message file out of a game pak: version, "GMSG", then (here) the dump itself.
    text = raw[8:] if raw[4:8] == b"GMSG" else raw
    pathlib.Path(a.i + "." + a.m).write_bytes(text)
print("All Done.")
'''


class PakFormat(unittest.TestCase):
    def test_murmur3_and_the_games_path_hashes(self):
        self.assertEqual(murmur3_32(b'hello', 0), 0x248BFA47)
        # The values ree-pak-rs checks its own hashing against.
        self.assertEqual(path_hashes('natives/stm/camera/collisionfilter/defaultcamera.cfil.7'), (0x65B486A1, 0x958EDD0C))
        self.assertEqual(path_hashes('NATIVES\\STM\\CAMERA\\COLLISIONFILTER\\DEFAULTCAMERA.CFIL.7'), (0x65B486A1, 0x958EDD0C))

    def test_entries_are_laid_out_as_the_game_reads_them(self):
        # An entry from ree-pak-rs's own tests: hashes, offset, sizes, attributes, checksum.
        fixture = bytes.fromhex('342f6ec2ebbee68095fa060000000000408a000000000000408a000000000000' + '00' * 16)
        self.assertEqual(ENTRY.unpack(fixture), (3262000948, 2162605803, 457365, 35392, 35392, 0, 0))

    def test_a_pak_round_trips(self):
        files = [('natives/stm/message/a.msg.22', b'first'), ('natives/stm/message/b.msg.22', b'second file')]
        blob = write_pak(files)
        self.assertEqual(blob[:16], b'KPKA\x04\x00\x00\x00\x02\x00\x00\x00\x00\x00\x00\x00')
        read = read_pak(blob)
        self.assertEqual(read[path_hashes('natives/stm/message/b.msg.22')], b'second file')
        self.assertEqual(len(blob), 16 + 48 * 2 + len(b'first') + len(b'second file'))
        with self.assertRaisesRegex(PakError, 'twice'):
            write_pak([('natives/a.msg.22', b'1'), ('NATIVES/A.MSG.22', b'2')])


def deflate(data):
    out = zlib.compressobj(9, zlib.DEFLATED, -15)
    return out.compress(data) + out.flush()


def game_pak(entries, feature=0):
    """A pak as a game ships it: entries are (path, bytes, attributes); attributes 1 = deflate, 2 = zstd (stood in by deflate here)."""
    stored = [(path, deflate(data) if attributes & 0xF in (1, 2) else data, len(data), attributes) for path, data, attributes in entries]
    offset = HEADER.size + ENTRY.size * len(stored)
    table, blobs = [], []
    for path, blob, size, attributes in stored:
        table.append(ENTRY.pack(*path_hashes(path), offset, len(blob), size, attributes, 0))
        blobs.append(blob)
        offset += len(blob)
    return HEADER.pack(b'KPKA', 4, 0, feature, len(stored), 0) + b''.join(table) + b''.join(blobs)


def game_msg(entries, version=22):
    """A message file as it comes out of a game pak: version, "GMSG", then (for the stand-in tool) its dump."""
    return struct.pack('<I', version) + b'GMSG' + json.dumps(dump_json(entries)).encode('utf-8')


MSG_PATH = 'natives/stm/message/mes_main/ch_mes_main.msg.22'


class GamePaks(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_message_files_come_out_of_the_games_paks(self):
        base = self.tmp / 're_chunk_000.pak'
        base.write_bytes(game_pak([
            (MSG_PATH, game_msg(ENTRIES[:1]), 0),
            ('natives/stm/message/ui.msg.22', game_msg(ENTRIES[1:2]), 1),
            ('natives/stm/texture/a.tex.10', b'\0' * 64, 1),
            ('natives/stm/message/secret.msg.22', game_msg(ENTRIES), 1 << 16),  # an encrypted file
        ]))
        patch = self.tmp / 're_chunk_000.pak.patch_001.pak'
        patch.write_bytes(game_pak([(MSG_PATH, game_msg(ENTRIES[:2]), 1)]))  # the patch's version wins
        logged = []
        found = extract_messages([base, patch], self.tmp / 'out', logged.append)
        names = sorted(name for _, name in found)
        lower, upper = path_hashes(MSG_PATH)
        self.assertIn(f'unnamed/{lower:08x}-{upper:08x}.msg.22', names)
        self.assertEqual(len(names), 2)
        by_name = {name: path for path, name in found}
        self.assertEqual(by_name[f'unnamed/{lower:08x}-{upper:08x}.msg.22'].read_bytes(), game_msg(ENTRIES[:2]))
        self.assertIn('1 encrypted or unreadable files skipped', logged[0])

    def test_zstd_files_need_a_zstd_decompressor(self):
        path = self.tmp / 're_chunk_000.pak'
        path.write_bytes(game_pak([(MSG_PATH, game_msg(ENTRIES[:1]), 2)]))
        with GamePak(path, zstd=lambda: (lambda data: zlib.decompressobj(-15).decompress(data))) as pak:
            self.assertEqual(pak.read(path_hashes(MSG_PATH), limit=8)[4:8], b'GMSG')
        with GamePak(path) as pak:
            pak.zstd = None
            with self.assertRaisesRegex(PakError, 'pip install zstandard'):
                pak.read(path_hashes(MSG_PATH))

    def test_an_encrypted_file_table_is_refused(self):
        path = self.tmp / 're_chunk_000.pak'
        path.write_bytes(game_pak([(MSG_PATH, game_msg(ENTRIES[:1]), 0)], feature=0x08))
        with self.assertRaisesRegex(MsgError, 'won\'t look for'):
            extract_messages([path], self.tmp / 'out', lambda *_: None)


class OftFonts(unittest.TestCase):
    def test_our_font_is_wrapped_as_the_engine_expects(self):
        from arabic_compiler.reefont import FontError, _key, encode_oft
        # For a length that's a multiple of 64 the key is the format's constant, low byte first.
        self.assertEqual(_key(64), bytes.fromhex('455f358ab5396eae'))
        font = b'\x00\x01\x00\x00' + bytes(range(256)) * 3 + b'\x07'
        wrapped = encode_oft(font)
        key = _key(len(font))
        self.assertEqual(wrapped[:4], b'FBFO')
        self.assertEqual(len(wrapped), 4 + len(font))
        self.assertEqual(bytes(b ^ key[i % 8] for i, b in enumerate(wrapped[4:])), font)
        # Only plain fonts go in: never an .oft (such as the game's own) or anything else.
        for not_a_font in (wrapped, b'PK\x03\x04' + b'\0' * 100):
            with self.assertRaisesRegex(FontError, 'Only a plain'):
                encode_oft(not_a_font)


class CutsceneText(unittest.TestCase):
    def test_timing_cues_stay_first_and_pages_stay_in_order(self):
        from arabic_compiler.packbuild import shape_re_text
        from arabic_compiler.rtl import ArabicCompiler
        compiler = ArabicCompiler()
        cues = '<TIME 4.4, 8.44><TIME 12.3, 17.7><TIME 19.45, 25.5>'
        pages = ['أيها القائد.\nهذه الشابة الجميلة بحاجة إلى مساعدتنا.', 'اسمي جيل.', 'شكرًا <COLOR FF0000>لكِ</COLOR> يا جيل.']
        shaped = shape_re_text(cues + '<PAGE>'.join(pages), compiler)
        self.assertTrue(shaped.startswith(cues))
        out_pages = shaped[len(cues):].split('<PAGE>')
        self.assertEqual(out_pages, [compiler(p) for p in pages])  # each page on its own, in the same order
        self.assertIn('<COLOR FF0000>', out_pages[2])
        self.assertNotIn('TIME', shaped[len(cues):])

    def test_lines_of_a_page_end_together_on_the_right(self):
        try:
            import fontTools  # noqa: F401
        except ImportError:
            self.skipTest('fonttools is not installed')
        from arabic_compiler.packbuild import DEFAULT_FONT, LineWidths, shape_re_text
        from arabic_compiler.rtl import ArabicCompiler
        compiler, widths = ArabicCompiler(), LineWidths(DEFAULT_FONT)
        cues = '<TIME 4.4, 8.44>'
        pages = ['أيها القائد.\nهذه الشابة <COLOR FF0000>الجميلة</COLOR> بحاجة إلى مساعدتنا.', 'اسمي جيل.']
        shaped = shape_re_text(cues + '<PAGE>'.join(pages), compiler, widths)
        self.assertTrue(shaped.startswith(cues))
        first, second = shaped[len(cues):].split('<PAGE>')
        short, long = first.split('\n')
        self.assertTrue(short.startswith('    ') and not long.startswith(' '))  # the shorter line is pushed right
        self.assertLessEqual(abs(widths.width(short) - widths.width(long)), widths.space)  # tags take no room
        self.assertEqual(second, compiler(pages[1]))  # one line: nothing to line up


class MessageDumps(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_json_dumps_by_language_id_not_position(self):
        path = self.tmp / 'natives/stm/message/ch.msg.22.json'
        path.parent.mkdir(parents=True)
        data = dump_json(ENTRIES, languages=[0, 21, 1])
        data['entries'][0]['content'][1] = 'يجب أن نصل'
        path.write_text(json.dumps(data), encoding='utf-8')
        dump = read_dump(path)
        self.assertEqual(dump.in_pak, 'natives/stm/message/ch.msg.22')
        self.assertEqual(dump.english[ENTRIES[1][0]], 'Leon, <COL RED>get down</COL>!')
        self.assertEqual(dump.arabic, {ENTRIES[0][0]: 'يجب أن نصل'})
        out = self.tmp / 'edited.json'
        self.assertEqual(write_dump(dump, {ENTRIES[1][0]: 'ليون، انخفض!'}, ['English', 'Arabic'], out), 1)
        content = json.loads(out.read_text(encoding='utf-8'))['entries'][1]['content']
        self.assertEqual(content, ['', 'ليون، انخفض!', 'ليون، انخفض!'])

    def test_csv_dumps(self):
        path = self.tmp / 'natives/stm/message/ch.msg.22.csv'
        path.parent.mkdir(parents=True)
        with path.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['guid', 'soundId', '<speaker>', 'entry name', 'Japanese', 'English', 'Arabic'])
            writer.writerow([ENTRIES[0][0], '0', 'Leon', 'line_0', '夜までに', ENTRIES[0][1], ''])
        dump = read_dump(path)
        self.assertEqual(dump.english, {ENTRIES[0][0]: ENTRIES[0][1]})
        out = self.tmp / 'edited.csv'
        write_dump(dump, {ENTRIES[0][0]: 'يجب أن نصل'}, ['English'], out)
        with out.open(encoding='utf-8-sig', newline='') as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[1], [ENTRIES[0][0], '0', 'Leon', 'line_0', '夜までに', 'يجب أن نصل', ''])
        self.assertTrue(out.read_bytes().startswith(b'\xef\xbb\xbf'))

    def test_sources(self):
        folder = self.tmp / 'extracted'
        dump = folder / 'natives/stm/message/ch.msg.22.json'
        dump.parent.mkdir(parents=True)
        dump.write_text(json.dumps(dump_json(ENTRIES)), encoding='utf-8')
        source = read_source(folder)
        self.assertEqual(source.engine, 'reengine')
        self.assertEqual([(r.key, r.source) for r in source.rows], [
            (f'natives/stm/message/ch.msg.22#{ENTRIES[0][0]}', ENTRIES[0][1]),
            (f'natives/stm/message/ch.msg.22#{ENTRIES[1][0]}', ENTRIES[1][1])])
        # A dump on its own says where its file goes.
        lone = self.tmp / 'ch.msg.22.json'
        lone.write_text(dump.read_text(encoding='utf-8'), encoding='utf-8')
        with self.assertRaisesRegex(SourceError, 'natives/stm/message'):
            read_source(lone)
        self.assertEqual(read_source(lone, msg_path='natives/stm/message/ch.msg.22').msg_dumps[0].in_pak, 'natives/stm/message/ch.msg.22')
        # Message files without dumps, and a game whose text is still in its paks.
        bare = self.tmp / 'bare/natives/stm/message'
        bare.mkdir(parents=True)
        (bare / 'ch.msg.22').write_bytes(b'msg')
        self.assertEqual(read_source(self.tmp / 'bare').msg_files[0][1], 'natives/stm/message/ch.msg.22')
        # A game folder: its own paks are read, base first, then its patches in order.
        game = self.tmp / 'RE2'
        game.mkdir()
        for name in ('re_chunk_000.pak', 're_chunk_000.pak.patch_002.pak', 're_chunk_000.pak.patch_001.pak', 'other.pak'):
            (game / name).write_bytes(b'KPKA')
        self.assertEqual([p.name for p in read_source(game).game_paks],
                         ['re_chunk_000.pak', 're_chunk_000.pak.patch_001.pak', 're_chunk_000.pak.patch_002.pak'])


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class BuildingReEngine(unittest.TestCase):
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
        self.tool = self.tmp / 'REMSG_Converter' / 'main.py'
        self.tool.parent.mkdir()
        self.tool.write_text(FAKE_TOOL, encoding='utf-8')
        import os
        self.addCleanup(lambda: os.environ.pop('OPENAI_API_KEY', None))
        os.environ['OPENAI_API_KEY'] = 'secret-key'

    def tearDown(self):
        self.api.close()
        shutil.rmtree(self.tmp)

    def run_build(self, source, *extra):
        args = parse_args([str(source), '--engine', 'reengine', '--id', 'test-re', '--version', '1.0.0', '--steam-app-id', '883710',
                           '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out'),
                           '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base, *extra])
        return build(args, log=self.logged.append)

    def extracted(self, with_dump=True):
        """A folder extracted from the game: the original .msg (here, JSON the stand-in tool can read), and maybe its dump."""
        folder = self.tmp / 'extracted'
        msg = folder / 'natives/stm/message/mes_main/ch_mes_main.msg.22'
        msg.parent.mkdir(parents=True, exist_ok=True)
        msg.write_text(json.dumps(dump_json(ENTRIES)), encoding='utf-8')
        if with_dump:
            msg.with_name(msg.name + '.json').write_text(json.dumps(dump_json(ENTRIES)), encoding='utf-8')
        return folder

    def packed_msg(self, pack):
        read = node_read_pack(pack, self.keys / 'k/pack-signing.pub')
        self.assertEqual(read['manifest']['engine'], 'reengine')
        self.assertEqual(read['files'], ['re_chunk_000.pak.patch_XXX.pak'])
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        blob = files[path_hashes('natives/stm/message/mes_main/ch_mes_main.msg.22')]
        self.assertTrue(blob.startswith(b'FAKEMSG'))
        return {e['guid']: e['content'] for e in json.loads(blob[len(b'FAKEMSG'):])['entries']}

    def test_dumps_become_shaped_arabic_in_the_english_slot(self):
        entries = self.packed_msg(self.run_build(self.extracted(), '--msg-tool', str(self.tool)))
        english = entries[ENTRIES[0][0]][1]
        # Shaped (joined letters, screen order) by default, for older games; tags kept.
        self.assertTrue(any(0xFE70 <= ord(c) <= 0xFEFF for c in english))
        self.assertIn('<COL RED>', entries[ENTRIES[1][0]][1])
        self.assertEqual(entries[ENTRIES[0][0]][21], '')  # the Arabic slot wasn't asked for
        self.assertEqual(entries[ENTRIES[2][0]][1], '')   # empty lines stay empty

    def test_no_shape_and_the_arabic_slot_for_games_that_lay_arabic_out_themselves(self):
        entries = self.packed_msg(self.run_build(self.extracted(), '--msg-tool', str(self.tool), '--no-shape',
                                                 '--msg-language', 'English', '--msg-language', 'Arabic'))
        content = entries[ENTRIES[0][0]]
        self.assertEqual(content[1], 'عربي ' + ENTRIES[0][1])
        self.assertEqual(content[21], content[1])

    def test_message_files_without_dumps_are_read_with_the_tool(self):
        entries = self.packed_msg(self.run_build(self.extracted(with_dump=False), '--msg-tool', str(self.tool), '--no-shape'))
        self.assertEqual(entries[ENTRIES[0][0]][1], 'عربي ' + ENTRIES[0][1])
        # The game's own folder isn't written to.
        self.assertEqual(sorted(p.name for p in (self.tmp / 'extracted/natives/stm/message/mes_main').iterdir()), ['ch_mes_main.msg.22'])

    def test_straight_from_the_game_folder(self):
        game = self.tmp / 'RE3 Demo'
        game.mkdir()
        (game / 're_chunk_000.pak').write_bytes(game_pak([(MSG_PATH, game_msg(ENTRIES), 1), ('natives/stm/x.tex.10', b'\0' * 99, 1)]))
        args = parse_args([str(game), '--engine', 'reengine', '--msg-tool', str(self.tool), '--no-shape',
                           '--id', 'test-re', '--version', '1.0.0', '--steam-app-id', '1173690',
                           '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out'),
                           '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base])
        pack = build(args, log=self.logged.append)
        # The Arabic message file goes back under the same two hashes as the game's own.
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        self.assertEqual(sorted(files), sorted([path_hashes(MSG_PATH), path_hashes(PATCH_MARKER)]))
        content = {e['guid']: e['content'] for e in json.loads(files[path_hashes(MSG_PATH)][len(b'FAKEMSG'):])['entries']}
        self.assertEqual(content[ENTRIES[0][0]][1], 'عربي ' + ENTRIES[0][1])
        self.assertTrue(any('Took 1 message files out of re_chunk_000.pak' in line for line in self.logged))
        self.assertEqual(sorted(p.name for p in game.iterdir()), ['re_chunk_000.pak'])  # the game folder isn't written to

    def test_only_message_files_with_arabic_go_into_the_patch(self):
        game = self.tmp / 'RE3 Demo'
        game.mkdir()
        other = [('00000000-0000-0000-0000-0000000000aa', 'Press any button.')]
        (game / 're_chunk_000.pak').write_bytes(game_pak([(MSG_PATH, game_msg(ENTRIES), 1),
                                                          ('natives/stm/message/ui.msg.22', game_msg(other), 1)]))
        common = [str(game), '--engine', 'reengine', '--msg-tool', str(self.tool), '--no-shape', '--no-translate',
                  '--id', 'test-re', '--version', '1.0.0', '--steam-app-id', '1173690',
                  '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out')]
        out = build(parse_args(common + ['--review']), log=self.logged.append)
        reviewed = out / 'translations.csv'
        with reviewed.open(encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        for row in rows:
            if row['source'] == ENTRIES[0][1]:
                row['arabic'] = 'يجب أن نصل إلى القلعة قبل حلول الليل.'
        with reviewed.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        pack = build(parse_args(common + ['--translations', str(reviewed)]), log=self.logged.append)
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        # The UI file has no Arabic, so the game keeps its own.
        self.assertEqual(sorted(files), sorted([path_hashes(MSG_PATH), path_hashes(PATCH_MARKER)]))
        self.assertTrue(any('1 message files have no Arabic yet' in line for line in self.logged))

    def test_an_arabic_patch_already_in_the_game_isnt_read_as_its_english(self):
        game = self.tmp / 'RE3 Demo'
        game.mkdir()
        (game / 're_chunk_000.pak').write_bytes(game_pak([(MSG_PATH, game_msg(ENTRIES), 1)]))
        common = [str(game), '--engine', 'reengine', '--msg-tool', str(self.tool), '--no-shape',
                  '--id', 'test-re', '--version', '1.0.0', '--steam-app-id', '1173690',
                  '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out'),
                  '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base]
        pack = build(parse_args(common), log=self.logged.append)
        # GameShelf puts the patch in the game, and the pack is built again.
        shutil.copyfile(pack / 'payload/re_chunk_000.pak.patch_XXX.pak', game / 're_chunk_000.pak.patch_001.pak')
        self.logged.clear()
        out = build(parse_args(common + ['--review']), log=self.logged.append)
        self.assertTrue(any('Skipped re_chunk_000.pak.patch_001.pak' in line for line in self.logged))
        with (out / 'translations.csv').open(encoding='utf-8-sig') as f:
            sources = [r['source'] for r in csv.DictReader(f)]
        self.assertEqual(sources, [ENTRIES[0][1], ENTRIES[1][1]])  # the game's English, not the Arabic

    def test_the_games_plain_fonts_get_the_arabic_font_in_their_place(self):
        from arabic_compiler.packbuild import DEFAULT_FONT
        game = self.tmp / 'RE3 Demo'
        game.mkdir()
        ttf = b'\x00\x01\x00\x00' + b'\0' * 2000
        (game / 're_chunk_000.pak').write_bytes(game_pak([
            (MSG_PATH, game_msg(ENTRIES), 1),
            ('natives/stm/gui/font/main.oft', ttf, 1),          # a plain TrueType font, compressed
            ('natives/stm/gui/font/sub.oft', b'OTTO' + b'\0' * 2000, 0),
            ('natives/stm/gui/font/scrambled.oft', b'\x8f\x13' + b'\0' * 2000, 0),  # can't be told from any other file
        ]))
        common = [str(game), '--engine', 'reengine', '--msg-tool', str(self.tool),
                  '--id', 'test-re', '--version', '1.0.0', '--steam-app-id', '1173690',
                  '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out'),
                  '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base]
        pack = build(parse_args(common), log=self.logged.append)
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        for path in ('natives/stm/gui/font/main.oft', 'natives/stm/gui/font/sub.oft'):
            self.assertEqual(files[path_hashes(path)], DEFAULT_FONT.read_bytes())
        self.assertNotIn(path_hashes('natives/stm/gui/font/scrambled.oft'), files)
        self.assertTrue(any('in place of the game\'s 2 font files' in line for line in self.logged))

        pack = build(parse_args(common + ['--no-fonts']), log=self.logged.append)
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        self.assertNotIn(path_hashes('natives/stm/gui/font/main.oft'), files)

    def test_the_arabic_font_goes_in_as_the_games_oft_fonts_from_a_file_list(self):
        from arabic_compiler.packbuild import DEFAULT_BOLD_FONT, DEFAULT_FONT
        from arabic_compiler.reefont import encode_oft
        game = self.tmp / 'RE3 Demo'
        game.mkdir()
        font_dir = 'natives/stm/escape/ui/ui0000/font/'
        # The game's own fonts are marked encrypted: reading one would fail the build.
        (game / 're_chunk_000.pak').write_bytes(game_pak([
            (MSG_PATH, game_msg(ENTRIES), 1),
            (font_dir + 'helveticaneueltw1g-cn.oft.1', b'FBFO' + b'\x11' * 3000, 1 << 16),
            (font_dir + 'courbd.oft.1', b'FBFO' + b'\x22' * 3000, 1 << 16),
            (font_dir + 'courbd.oft.1.stm', b'FBFO' + b'\x33' * 3000, 1 << 16),
        ]))
        listing = self.tmp / 'RE3_RC_STM_Demo.list'
        listing.write_text('natives/stm/streaming/x.tex.10\n' + ''.join(
            font_dir + name + '\n' for name in ('helveticaneueltw1g-cn.oft.1', 'helveticaneueltw1g-cn.oft.1.stm',
                                                 'courbd.oft.1', 'fotk-ydgothic130.oft.1')), encoding='utf-8')
        common = [str(game), '--engine', 'reengine', '--msg-tool', str(self.tool),
                  '--id', 'test-re', '--version', '1.0.0', '--steam-app-id', '1173690',
                  '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out'),
                  '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base]
        pack = build(parse_args(common + ['--pak-list', str(listing)]), log=self.logged.append)
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        self.assertEqual(files[path_hashes(font_dir + 'helveticaneueltw1g-cn.oft.1')], encode_oft(DEFAULT_FONT.read_bytes()))
        self.assertEqual(files[path_hashes(font_dir + 'courbd.oft.1')], encode_oft(DEFAULT_BOLD_FONT.read_bytes()))  # bold
        self.assertNotIn(path_hashes(font_dir + 'fotk-ydgothic130.oft.1'), files)  # not in this game's paks
        self.assertTrue(any('2 of the 4 font names given are in the game\'s paks' in line for line in self.logged))
        # The game keeps courbd twice (.oft.1 and .oft.1.stm, the one RE3 draws with): both get the Arabic font.
        self.assertEqual(files[path_hashes(font_dir + 'courbd.oft.1.stm')], encode_oft(DEFAULT_BOLD_FONT.read_bytes()))

        # Names without their copies (as the server may have them) still reach every copy.
        pack = build(parse_args(common + ['--font-targets', font_dir + 'courbd.oft.1', '--require-fonts']), log=self.logged.append)
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        self.assertIn(path_hashes(font_dir + 'courbd.oft.1.stm'), files)
        # With no font for the Arabic, the app's builds stop rather than make a pack that shows boxes.
        with self.assertRaisesRegex(BuildError, 'show as boxes'):
            build(parse_args(common + ['--font-targets', font_dir + 'fotk-ydgothic130.oft.1', '--require-fonts']), log=self.logged.append)

        # Or with an installed converter.
        converter = self.tmp / 'converter.py'
        converter.write_text('import sys; open(sys.argv[2], "wb").write(b"FBFO" + b"made by the tool " + open(sys.argv[1], "rb").read()[:4])\n')
        pack = build(parse_args(common + ['--font-targets', font_dir + 'courbd.oft.1',
                                          '--font-converter-cmd', f'"{sys.executable}" "{converter}" {{input}} {{output}}']), log=self.logged.append)
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        self.assertTrue(files[path_hashes(font_dir + 'courbd.oft.1')].startswith(b'FBFOmade by the tool'))

    def test_an_overlay_pack_from_the_same_message_files(self):
        args = parse_args([str(self.extracted(with_dump=False)), '--engine', 'overlay', '--msg-tool', str(self.tool),
                           '--id', 'test-re-overlay', '--version', '1.0.0', '--steam-app-id', '1173690',
                           '--key', str(self.keys / 'k/pack-signing.key'), '--out', str(self.tmp / 'out'),
                           '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base])
        pack = build(args, log=self.logged.append)
        read = node_read_pack(pack, self.keys / 'k/pack-signing.pub')
        self.assertEqual(read['manifest']['engine'], 'overlay')
        self.assertEqual(read['files'], ['fingerprints.json'])
        table = FingerprintTable(json.loads((pack / 'payload/fingerprints.json').read_text(encoding='utf-8')))
        # What OCR reads has no colour tags.
        self.assertEqual(table.lookup('Leon, get down!').arabic, 'عربي Leon, get down!')

    def test_without_the_tool_it_stops_with_the_arabic_dumps_written(self):
        with self.assertRaisesRegex(BuildError, '--msg-tool'):
            self.run_build(self.extracted())
        edited = self.tmp / 'out/msg-edited/natives/stm/message/mes_main/ch_mes_main.msg.22.json'
        content = json.loads(edited.read_text(encoding='utf-8'))['entries'][0]['content']
        self.assertTrue(content[1].endswith('\uFEF2\uFE91\uFEAE\uFECB'))  # "عربي", shaped and in screen order

    def test_a_checked_translations_csv_is_used_when_rebuilding(self):
        out = self.run_build(self.extracted(), '--review')
        reviewed = out / 'translations.csv'
        with reviewed.open(encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        rows[0]['arabic'] = 'يجب أن نصل إلى القلعة قبل حلول الليل.'
        with reviewed.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        entries = self.packed_msg(self.run_build(self.extracted(), '--msg-tool', str(self.tool), '--no-shape', '--translations', str(reviewed)))
        self.assertEqual(entries[ENTRIES[0][0]][1], 'يجب أن نصل إلى القلعة قبل حلول الليل.')

    def test_prebuilt_message_files_and_other_files_are_packed_as_they_are(self):
        folder = self.tmp / 'arabic'
        msg = folder / 'natives/stm/message/mes_main/ch_mes_main.msg.22'
        msg.parent.mkdir(parents=True)
        msg.write_bytes(b'already arabic')
        extra = self.tmp / 'fonts/natives/stm/gui/font/arabic.oft'
        extra.parent.mkdir(parents=True)
        extra.write_bytes(b'font from the author\'s tools')
        pack = self.run_build(folder, '--msg-prebuilt', '--natives', str(self.tmp / 'fonts'))
        files = read_pak((pack / 'payload/re_chunk_000.pak.patch_XXX.pak').read_bytes())
        self.assertEqual(files[path_hashes('natives/stm/message/mes_main/ch_mes_main.msg.22')], b'already arabic')
        self.assertEqual(files[path_hashes('natives/stm/gui/font/arabic.oft')], b'font from the author\'s tools')
        self.assertEqual(len(self.api.requests), 0)  # nothing to translate

    def test_a_tool_that_fails_is_reported(self):
        self.tool.write_text('print("error with file")\n', encoding='utf-8')  # exits 0, writes nothing, like REMSG_Converter on a bad file
        with self.assertRaisesRegex(BuildError, 'REMSG_Converter couldn\'t write'):
            self.run_build(self.extracted(), '--msg-tool', str(self.tool))


if __name__ == '__main__':
    unittest.main()
