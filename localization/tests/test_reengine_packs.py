"""Tests for RE Engine packs: the .pak format, REMSG_Converter's message dumps,
and building whole packs (with a stand-in for REMSG_Converter, which the pack's
author installs)."""

import csv
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from arabic_compiler.packbuild import BuildError, build, parse_args
from arabic_compiler.remsg import read_dump, write_dump
from arabic_compiler.repak import ENTRY, PakError, murmur3_32, path_hashes, read_pak, write_pak
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
    pathlib.Path(a.i + "." + a.m).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
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
        game = self.tmp / 'RE2'
        game.mkdir()
        (game / 're_chunk_000.pak').write_bytes(b'KPKA')
        with self.assertRaisesRegex(SourceError, 'Extract the message files'):
            read_source(game)


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

    def test_without_the_tool_it_stops_with_the_arabic_dumps_written(self):
        with self.assertRaisesRegex(BuildError, '--msg-tool'):
            self.run_build(self.extracted())
        edited = self.tmp / 'out/msg-edited/natives/stm/message/mes_main/ch_mes_main.msg.22.json'
        content = json.loads(edited.read_text(encoding='utf-8'))['entries'][0]['content']
        self.assertTrue(content[1].endswith('\uFEF2\uFE91\uFEAE\uFECB'))  # "عربي", shaped and in screen order

    def test_a_checked_translations_csv_is_used_when_rebuilding(self):
        out = self.run_build(self.extracted(), '--review')
        reviewed = out / 'translations.csv'
        with reviewed.open(encoding='utf-8') as f:
            rows = list(csv.DictReader(f))
        rows[0]['arabic'] = 'يجب أن نصل إلى القلعة قبل حلول الليل.'
        with reviewed.open('w', encoding='utf-8', newline='') as f:
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
