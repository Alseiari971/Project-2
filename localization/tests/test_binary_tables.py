"""Games' own binary message tables, read and written natively: FromSoftware
.fmg in BND4 binders and DCX, Rockstar .gxt2, Capcom MT Framework .gmd in .arc
archives; and the loose-file scanner reading them out of a game folder and
writing each back in its own format."""

import shutil
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

from arabic_compiler import fromsoft, loose, mtframework, rage


def fmg(entries, version=2, big=False):
    return fromsoft.write_fmg(fromsoft.Fmg(version, big, dict(entries)))


def msgbnd(tables: dict, kind='DFLT') -> bytes:
    files = [fromsoft.BndFile(f'N:\\GR\\data\\INTERROOT_win64\\msg\\engUS\\{name}', fmg(entries), id_)
             for id_, (name, entries) in enumerate(tables.items())]
    bnd = fromsoft.new_bnd4(files)
    return fromsoft.write_dcx(fromsoft.Dcx(kind, fromsoft.new_dcx_header(kind), b''), bnd) if kind else bnd


ITEMS = {100: 'Flask of Crimson Tears', 101: 'Restores HP.', 102: None, 200: 'Golden Seed', 7000: 'Use to strengthen your flask.'}
TALK = {10000: 'You are unmaidened, it seems.', 10001: 'Then I shall be your maiden.\nTake my hand.', 10002: 'Farewell.'}


class FromSoftware(unittest.TestCase):
    def test_fmg_round_trips_in_every_version_and_byte_order(self):
        for version, big in ((2, False), (1, False), (1, True), (0, True)):
            data = fmg(ITEMS, version, big)
            back = fromsoft.read_fmg(data)
            self.assertEqual((back.version, back.big_endian, back.entries), (version, big, ITEMS), (version, big))
            self.assertEqual(fromsoft.write_fmg(back), data)
            self.assertEqual(struct.unpack_from('>i' if big else '<i', data, 4)[0], len(data))

    def test_fmg_groups_follow_consecutive_ids(self):
        data = fmg(ITEMS)
        self.assertEqual(struct.unpack_from('<ii', data, 0x0C), (3, 5))  # 100-102, 200, 7000

    def test_damaged_fmg_is_refused(self):
        for data in (b'', b'\x01' * 40, fmg(ITEMS)[:30]):
            with self.assertRaises(fromsoft.FromSoftError):
                fromsoft.read_fmg(data)

    def test_dcx_dflt_round_trips_and_keeps_its_header(self):
        body = b'BND4' + b'x' * 5000
        packed = fromsoft.write_dcx(fromsoft.Dcx('DFLT', fromsoft.new_dcx_header('DFLT'), b''), body)
        self.assertEqual(packed[:4], b'DCX\0')
        self.assertEqual(struct.unpack_from('>II', packed, 0x1C)[0], len(body))
        dcx = fromsoft.read_dcx(packed)
        self.assertEqual((dcx.kind, dcx.data), ('DFLT', body))
        self.assertEqual(fromsoft.write_dcx(dcx, body)[:0x1C], packed[:0x1C])

    def test_oodle_files_need_the_games_own_library(self):
        head = fromsoft.new_dcx_header('KRAK')
        packed = bytearray(head) + b'\0' * 16
        struct.pack_into('>II', packed, 0x1C, 100, 16)
        with self.assertRaisesRegex(fromsoft.FromSoftError, 'oo2core'):
            fromsoft.read_dcx(bytes(packed))

    def test_bnd4_binders_round_trip_with_names_ids_and_their_hash_table(self):
        files = [fromsoft.BndFile('N:\\GR\\msg\\engUS\\Item.fmg', fmg(ITEMS), 1), fromsoft.BndFile('N:\\GR\\msg\\engUS\\Talk.fmg', fmg(TALK), 2)]
        data = fromsoft.new_bnd4(files)
        bnd = fromsoft.read_bnd4(data)
        self.assertEqual([(f.name, f.id) for f in bnd.files], [('N:\\GR\\msg\\engUS\\Item.fmg', 1), ('N:\\GR\\msg\\engUS\\Talk.fmg', 2)])
        self.assertEqual(fromsoft.read_fmg(bnd.files[1].data).entries, TALK)
        self.assertEqual(fromsoft.write_bnd4(bnd), data)
        hash_table, = struct.unpack_from('<q', data, 0x38)
        self.assertGreater(hash_table, 0x40)
        groups, = struct.unpack_from('<I', data, hash_table + 16)
        self.assertEqual(groups, 2)  # the first prime from count / 7
        self.assertEqual(fromsoft.path_hash('a'), (ord('/') * 37 + ord('a')) & 0xFFFFFFFF)

    def test_a_msgbnd_dcx_is_rewritten_with_only_the_changed_lines(self):
        data = msgbnd({'Item.fmg': ITEMS, 'Talk.fmg': TALK})
        found = fromsoft.read_messages(data)
        self.assertEqual(sorted(found.tables), ['0:Item.fmg', '1:Talk.fmg'])
        talk = found.tables['1:Talk.fmg']
        changed = fromsoft.Fmg(talk.version, talk.big_endian, {**talk.entries, 10002: 'وداعًا.'})
        again = fromsoft.read_messages(found.rebuild({'1:Talk.fmg': changed}))
        self.assertEqual(again.tables['1:Talk.fmg'].entries[10002], 'وداعًا.')
        self.assertEqual(again.tables['0:Item.fmg'].entries, ITEMS)
        self.assertEqual(fromsoft.read_dcx(found.rebuild({})).kind, 'DFLT')


class Rockstar(unittest.TestCase):
    def test_joaat_is_rages_hash(self):
        self.assertEqual(rage.joaat('adder'), 0xB779A091)  # the Adder's model hash, as GTA V scripts know it
        self.assertEqual(rage.joaat('ADDER'), rage.joaat('adder'))

    def test_gxt2_round_trips_sorted_by_hash(self):
        strings = {rage.joaat('MISSION_PASSED'): 'Mission Passed', rage.joaat('HELP_1'): 'Press ~INPUT_CONTEXT~ to talk.', 5: 'ü'}
        data = rage.write_gxt2(strings)
        self.assertEqual(data[:4], b'2TXG')
        self.assertEqual(rage.read_gxt2(data), strings)
        hashes = [struct.unpack_from('<I', data, 8 + 8 * i)[0] for i in range(3)]
        self.assertEqual(hashes, sorted(hashes))
        self.assertEqual(struct.unpack_from('<I', data, 8 + 8 * 3 + 4)[0], len(data))

    def test_damaged_gxt2_is_refused(self):
        with self.assertRaises(rage.RageError):
            rage.read_gxt2(b'2TXG' + struct.pack('<I', 99) + b'\0' * 8)


def gmd(strings, version=0x00010302, name='npc_talk'):
    """A .gmd laid out like Monster Hunter: World's: header, name, keys' index, keys, then the strings."""
    keys = b''.join(f'KEY_{i}'.encode() + b'\0' for i in range(len(strings)))
    block = b''.join(s.encode() + b'\0' for s in strings)
    head = b'GMD\0' + struct.pack('<IIQ', version, 0, 0) + struct.pack('<IIIII', len(strings), len(strings), len(keys), len(block), len(name))
    index = b''.join(struct.pack('<IIIIQQ', i, 0, 0, 0xCDCDCDCD, 0, 0) for i in range(len(strings)))
    return head + name.encode() + b'\0' + index + keys + block


def arc(files: list, version=7) -> bytes:
    entries = [mtframework.ArcEntry(name, type_hash, 0x40000000, data, compressed) for name, type_hash, data, compressed in files]
    return mtframework.write_arc(mtframework.Arc(version, 8, 0x8000, entries))


LINES = ['Leon, can you hear me?', 'Ada... is that you?', '<COL RED>Danger</COL>: the bridge is out.']


class MtFramework(unittest.TestCase):
    def test_gmd_strings_are_rewritten_in_place(self):
        data = gmd(LINES)
        table = mtframework.read_gmd(data)
        self.assertEqual((table.name, table.strings), ('npc_talk', LINES))
        self.assertEqual(table.write(), data)
        written = table.write(['ليون، هل تسمعني؟', LINES[1], LINES[2]])
        again = mtframework.read_gmd(written)
        self.assertEqual(again.strings[0], 'ليون، هل تسمعني؟')
        # Everything before the strings is as it was, but the string block's size.
        prefix = len(table.prefix)
        self.assertEqual(written[:0x20] + written[0x24:prefix], data[:0x20] + data[0x24:prefix])
        self.assertEqual(struct.unpack_from('<I', written, 0x20)[0], len(written) - prefix)
        with self.assertRaises(mtframework.MtError):
            table.write(LINES[:2])

    def test_the_older_gmd_layout_is_read_too(self):
        keys, block = b'K\0', b'Hello there\0'
        data = b'GMD\0' + struct.pack('<III', 0x00010201, 0, 0) + struct.pack('<IIIII', 1, 1, len(keys), len(block), 3) + b'msg\0' + keys + block
        self.assertEqual(mtframework.read_gmd(data).strings, ['Hello there'])

    def test_arc_round_trips_and_keeps_where_its_data_started(self):
        data = arc([('message\\msg_eng', 0x242BB29A, gmd(LINES), True), ('ui\\icon', 0x241F5DEB, b'TEX\0' + b'\1' * 300, False)])
        archive = mtframework.read_arc(data)
        self.assertEqual([(e.name, e.compressed) for e in archive.entries], [('message\\msg_eng', True), ('ui\\icon', False)])
        self.assertEqual(archive.first_data, 0x8000)
        self.assertEqual(mtframework.write_arc(archive), data)
        size_flags, = struct.unpack_from('<I', data, 8 + 64 + 8)
        self.assertEqual(size_flags & 0x40000000, 0x40000000)

    def test_an_arcs_gmd_tables_change_and_nothing_else(self):
        data = arc([('message\\msg_eng', 0x242BB29A, gmd(LINES), True), ('ui\\icon', 0x241F5DEB, b'TEX\0' + b'\1' * 300, False)])
        found = mtframework.read_messages(data)
        self.assertEqual(list(found.tables), ['0:message/msg_eng'])
        again = mtframework.read_arc(found.rebuild({'0:message/msg_eng': ['أ', 'ب', 'ج']}))
        self.assertEqual(mtframework.read_gmd(again.entries[0].data).strings, ['أ', 'ب', 'ج'])
        self.assertEqual(again.entries[1].data, b'TEX\0' + b'\1' * 300)

    def test_damaged_archives_are_refused(self):
        bad = bytearray(arc([('a', 1, b'data' * 10, True)]))
        struct.pack_into('<I', bad, 8 + 64 + 12, 10 ** 8)
        with self.assertRaises(mtframework.MtError):
            mtframework.read_arc(bytes(bad))


class InAGameFolder(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def write(self, rel, data):
        path = self.tmp.joinpath(*rel.split('/'))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_the_scanner_reads_each_format_and_writes_it_back_in_kind(self):
        self.write('Game/msg/engus/item.msgbnd.dcx', msgbnd({'Item.fmg': ITEMS, 'Talk.fmg': TALK}))
        self.write('Game/msg/jpnjp/item.msgbnd.dcx', msgbnd({'Item.fmg': {1: '日本語のテキストです'}}))
        self.write('mods/update/lang/american.gxt2', rage.write_gxt2({rage.joaat(f'L{i}'): f'Line number {i} of the story.' for i in range(4)}))
        self.write('nativePC/arc/message/msg_eng.arc', arc([('message\\msg_eng', 0x242BB29A, gmd(LINES), True)]))
        found = loose.scan(self.tmp)
        by_rel = {f.rel: f for f in found.files}
        self.assertEqual(sorted(by_rel), ['Game/msg/engus/item.msgbnd.dcx', 'mods/update/lang/american.gxt2', 'nativePC/arc/message/msg_eng.arc'])
        fs_file = by_rel['Game/msg/engus/item.msgbnd.dcx']
        self.assertEqual(fs_file.fmt, 'fmg')
        self.assertIn(('1:Talk.fmg#10001', 'Then I shall be your maiden.\nTake my hand.'), fs_file.entries)
        self.assertNotIn(None, [t for _, t in fs_file.entries])

        written = fromsoft.read_messages(fs_file.write({'1:Talk.fmg#10002': 'وداعًا.', '0:Item.fmg#200': 'بذرة ذهبية'}))
        self.assertEqual(written.tables['1:Talk.fmg'].entries[10002], 'وداعًا.')
        self.assertEqual(written.tables['0:Item.fmg'].entries[200], 'بذرة ذهبية')
        self.assertEqual(written.tables['0:Item.fmg'].entries[102], None)

        gxt = by_rel['mods/update/lang/american.gxt2']
        key = f'{rage.joaat("L2"):08X}'
        self.assertEqual(rage.read_gxt2(gxt.write({key: 'السطر الثالث'}))[rage.joaat('L2')], 'السطر الثالث')

        mt = by_rel['nativePC/arc/message/msg_eng.arc']
        self.assertEqual([k for k, _ in mt.entries], ['0:message/msg_eng#0', '0:message/msg_eng#1', '0:message/msg_eng#2'])
        out = mtframework.read_messages(mt.write({'0:message/msg_eng#1': 'آدا... أهذه أنتِ؟'}))
        self.assertEqual(out.tables['0:message/msg_eng'].strings[1], 'آدا... أهذه أنتِ؟')

    def test_files_that_only_look_like_these_are_left_alone(self):
        self.write('msg/engus/broken.msgbnd.dcx', b'DCX\0' + b'\0' * 100)
        self.write('text/english/music.arc', b'ARC\0' + b'\xff' * 50)
        self.write('text/english/notes.gxt2', b'2TXG' + b'\xff' * 50)
        self.assertEqual(loose.scan(self.tmp).files, [])


if __name__ == '__main__':
    unittest.main()
