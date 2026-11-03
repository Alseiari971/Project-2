"""Tests for engines beyond the big five: Bethesda string tables and archives
(with the Arabic font library and fontconfig.txt), the loose-file scanner and
its readers and writers, and engine recipes run with an allowlisted tool."""

import json
import os
import shutil
import stat
import struct
import sys
import tempfile
import unicodedata
import unittest
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from unittest import mock

from arabic_compiler import bethesda, loose, lz4codec, recipes, swffont
from arabic_compiler.lz4codec import LZ4Error, decompress_block, decompress_frame, literal_block, literal_frame
from arabic_compiler.packbuild import DEFAULT_FONT, BuildError, build, parse_args
from test_build_pack import HAS_NODE, REPO, FakeApi, node_read_pack

FORMS = range(0xFB50, 0xFEFD)


def shaped(text):
    return any(ord(c) in FORMS for c in text)


# ---- LZ4 --------------------------------------------------------------------

class Lz4(unittest.TestCase):
    def setUp(self):
        # The pure-Python decoder, even where the lz4 package is installed.
        for name in ('_native_block', '_native_frame'):
            patcher = mock.patch.object(lz4codec, name, None)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_block_with_overlapping_matches(self):
        # "abc", then a match 3 back for 9 bytes (overlapping: abcabcabc), then literals "xyz".
        block = bytes([0x35]) + b'abc' + struct.pack('<H', 3) + bytes([0x30]) + b'xyz'
        self.assertEqual(decompress_block(block, 15), b'abcabcabcabcxyz')
        with self.assertRaises(LZ4Error):
            decompress_block(bytes([0x15]) + b'a' + struct.pack('<H', 9), None)  # points before the start

    def test_literal_blocks_and_frames_round_trip(self):
        for size in (0, 5, 14, 15, 16, 300, 70000):
            data = bytes(range(256)) * (size // 256 + 1)
            data = data[:size]
            self.assertEqual(decompress_block(literal_block(data), size), data)
            self.assertEqual(decompress_frame(literal_frame(data)), data)

    def test_linked_blocks_reach_into_the_one_before(self):
        first = literal_block(b'hello world ')
        second = bytes([0x05]) + struct.pack('<H', 12) + bytes([0x10]) + b'!'  # 9 bytes from 12 back, then "!"
        frame = b'\x04\x22\x4d\x18' + bytes([0x40, 0x70, 0x00])
        for block in (first, second):
            frame += struct.pack('<I', len(block)) + block
        frame += b'\0\0\0\0'
        self.assertEqual(decompress_frame(frame), b'hello world hello wor!')


# ---- Bethesda ---------------------------------------------------------------

def handmade_table(entries, kind):
    """A string table built byte by byte, separately from bethesda.write_table."""
    data, directory = b'', b''
    for string_id, raw in entries:
        directory += struct.pack('<II', string_id, len(data))
        data += (struct.pack('<I', len(raw) + 1) if kind != 'strings' else b'') + raw + b'\0'
    return struct.pack('<II', len(entries), len(data)) + directory + data


def bsa(files: dict, version=105, embed_names=False, compress=True) -> bytes:
    """A .bsa with folders and file names, LZ4 (105) or zlib (104) compressed."""
    folders = {}
    for name, data in files.items():
        folder, _, base = name.rpartition('/')
        folders.setdefault(folder, []).append((base, data))
    flags = 0x1 | 0x2 | (0x4 if compress else 0) | (0x100 if embed_names else 0)
    record = 24 if version == 105 else 16
    names = b''.join(base.encode() + b'\0' for items in folders.values() for base, _ in items)
    folder_names = sum(len(f) + 1 for f in folders)
    head_size = 36 + record * len(folders)
    blocks_size = sum(1 + len(f) + 1 + 16 * len(items) for f, items in folders.items())
    data_at = head_size + blocks_size + len(names)
    head = b'BSA\0' + struct.pack('<IIIIIIIHH', version, 36, flags, len(folders), len(files), folder_names, len(names), 0, 0)
    blocks, payload = b'', b''
    for folder, items in folders.items():
        blocks += bytes([len(folder) + 1]) + folder.encode() + b'\0'
        for base, data in items:
            body = data
            if compress:
                body = struct.pack('<I', len(data)) + (literal_frame(data) if version == 105 else zlib.compress(data))
            if embed_names:
                full = f'{folder}\\{base}'.encode()
                body = bytes([len(full)]) + full + body
            blocks += struct.pack('<QII', 0, len(body), data_at + len(payload))
            payload += body
    # Folder records: hash, count, (padding,) offset.
    folder_records = b''.join(
        struct.pack('<QIIQ', 0, len(items), 0, 0) if version == 105 else struct.pack('<QII', 0, len(items), 0)
        for items in folders.values())
    return head + folder_records + blocks + names + payload


def ba2(files: dict, version=1, lz4=False) -> bytes:
    """A general .ba2: zlib (versions 1, 7, 8, 2), or LZ4 blocks (version 3 with compression 3)."""
    head_size = 24 + (8 if version in (2, 3) else 0) + (4 if version == 3 else 0)
    data_at = head_size + 36 * len(files)
    records, payload = b'', b''
    for name, data in files.items():
        body = literal_block(data) if lz4 else zlib.compress(data)
        records += struct.pack('<I4sIIQIII', 0, name.rsplit('.', 1)[-1][:4].encode().ljust(4, b'\0'), 0, 0,
                               data_at + len(payload), len(body), len(data), 0xBAADF00D)
        payload += body
    names = b''.join(struct.pack('<H', len(n)) + n.encode() for n in files)
    head = b'BTDX' + struct.pack('<I4sIQ', version, b'GNRL', len(files), data_at + len(payload))
    if version in (2, 3):
        head += struct.pack('<II', 1, 1)
    if version == 3:
        head += struct.pack('<I', 3 if lz4 else 0)
    return head + records + payload + names


FONTCONFIG = ('fontlib "Interface\\fonts_console.swf"\r\nfontlib "Interface\\fonts_en.swf"\r\n'
              'map "$ConsoleFont" = "Arial" Normal\r\nmap "$EverywhereFont" = "Futura CondensedLight" Normal\r\n'
              'map "$EverywhereBoldFont" = "Futura CondensedBold" Bold\r\nmap "$DragonFont" = "Dragon_script" Normal\r\n'
              'map "$SkyrimSymbolsFont" = "SkyrimSymbols" Normal\r\nvalidNameChars " abcdefghijklmnopqrstuvwxyz"\r\n')


class BethesdaTables(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_each_kind_of_table_reads_as_written_by_hand(self):
        entries = [(1, b'Iron Sword'), (0x2A, b'Caf\xe9 ' + 'Ä'.encode('utf-8')[:0]), (7, b'')]
        for kind in ('strings', 'dlstrings', 'ilstrings'):
            read = bethesda.read_table(handmade_table(entries, kind), kind)
            self.assertEqual(read, [(1, 'Iron Sword'), (0x2A, 'Café '), (7, '')])  # Windows-1252 when it isn't UTF-8

    def test_tables_round_trip_in_utf8(self):
        entries = [(5, 'Welcome to Whiterun'), (6, 'مرحبا'), (9, 'Line one\nLine two')]
        for kind in ('strings', 'dlstrings', 'ilstrings'):
            data = bethesda.write_table(entries, kind)
            self.assertEqual(bethesda.read_table(data, kind), entries)
            self.assertEqual(data, handmade_table([(i, t.encode('utf-8')) for i, t in entries], kind))
        with self.assertRaises(bethesda.BethesdaError):
            bethesda.read_table(b'\x05\0\0\0\xff\0\0\0', 'strings')

    def test_bsa_104_and_105_archives_with_and_without_embedded_names(self):
        table = bethesda.write_table([(1, 'Dragonborn')], 'strings')
        for version in (104, 105):
            for embed in (False, True):
                path = self.tmp / f'a{version}{embed}.bsa'
                path.write_bytes(bsa({'strings/skyrim_english.strings': table, 'interface/fontconfig.txt': b'fontlib "x"'}, version, embed))
                archive = bethesda.read_bsa(path)
                self.assertEqual(sorted(archive.names()), ['interface/fontconfig.txt', 'strings/skyrim_english.strings'])
                self.assertEqual(archive.read('strings/skyrim_english.strings'), table)
                self.assertEqual(archive.read('Interface\\FontConfig.txt'), b'fontlib "x"')
        path = self.tmp / 'plain.bsa'
        path.write_bytes(bsa({'strings/a_en.strings': table}, 104, compress=False))
        self.assertEqual(bethesda.read_bsa(path).read('strings/a_en.strings'), table)

    def test_ba2_archives_zlib_and_lz4(self):
        table = bethesda.write_table([(3, 'Vault-Tec')], 'dlstrings')
        for version, lz4 in ((1, False), (8, False), (2, False), (3, True)):
            path = self.tmp / f'b{version}.ba2'
            path.write_bytes(ba2({'Strings/Fallout4_en.DLSTRINGS': table}, version, lz4))
            archive = bethesda.read_ba2(path)
            self.assertEqual(archive.names(), ['strings/fallout4_en.dlstrings'])
            self.assertEqual(archive.read('strings/fallout4_en.dlstrings'), table)

    def test_fontconfig_points_text_fonts_at_the_arabic_font_and_keeps_runes(self):
        out = bethesda.rewrite_fontconfig(FONTCONFIG)
        lines = out.split('\r\n')
        self.assertEqual(lines[:3], ['fontlib "Interface\\fonts_console.swf"', 'fontlib "Interface\\fonts_en.swf"',
                                     'fontlib "Interface\\gameshelf_arabic.swf"'])
        self.assertIn('map "$EverywhereFont" = "GameShelf Arabic" Normal', lines)
        self.assertIn('map "$EverywhereBoldFont" = "GameShelf Arabic" Bold', lines)
        self.assertIn('map "$ConsoleFont" = "GameShelf Arabic" Normal', lines)
        self.assertIn('map "$DragonFont" = "Dragon_script" Normal', lines)
        self.assertIn('map "$SkyrimSymbolsFont" = "SkyrimSymbols" Normal', lines)
        self.assertIn('validNameChars " abcdefghijklmnopqrstuvwxyz"', lines)
        self.assertEqual(bethesda.rewrite_fontconfig(out), out)  # twice is the same as once
        self.assertEqual(bethesda.fonts_mapped(FONTCONFIG), ['$ConsoleFont', '$EverywhereFont', '$EverywhereBoldFont'])


# ---- The SWF font -------------------------------------------------------------

class BitReader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def ub(self, n):
        value = 0
        for _ in range(n):
            value = (value << 1) | ((self.data[self.pos // 8] >> (7 - self.pos % 8)) & 1)
            self.pos += 1
        return value

    def sb(self, n):
        value = self.ub(n)
        return value - (1 << n) if value & (1 << (n - 1)) else value


def decode_shape(data):
    """The contours of a SWF glyph SHAPE (each a list of points), and how many bytes it took."""
    r = BitReader(data)
    fill_bits, line_bits = r.ub(4), r.ub(4)
    contours, x, y, fills = [], 0, 0, []
    while True:
        if r.ub(1) == 0:
            flags = r.ub(5)
            if not flags:
                break
            if flags & 1:
                n = r.ub(5)
                x, y = r.sb(n), r.sb(n)
                contours.append([(x, y)])
            if flags & 2:
                fills.append(r.ub(fill_bits))
            if flags & 4:
                r.ub(fill_bits)
            if flags & 8:
                r.ub(line_bits)
        elif r.ub(1):
            n = r.ub(4) + 2
            if r.ub(1):
                x, y = x + r.sb(n), y + r.sb(n)
            elif r.ub(1):
                y += r.sb(n)
            else:
                x += r.sb(n)
            contours[-1].append((x, y))
        else:
            n = r.ub(4) + 2
            cx, cy, ax, ay = r.sb(n), r.sb(n), r.sb(n), r.sb(n)
            x, y = x + cx + ax, y + cy + ay
            contours[-1].append((x, y))
    return contours, fills, (r.pos + 7) // 8


def read_swf(data):
    """The tags of an uncompressed SWF: [(code, body)]."""
    assert data[:3] == b'FWS' and struct.unpack_from('<I', data, 4)[0] == len(data)
    r = BitReader(data[8:])
    n = r.ub(5)
    for _ in range(4):
        r.sb(n)
    at = 8 + (r.pos + 7) // 8 + 4
    tags = []
    while at < len(data):
        (head,) = struct.unpack_from('<H', data, at)
        code, length = head >> 6, head & 0x3F
        at += 2
        if length == 0x3F:
            (length,) = struct.unpack_from('<I', data, at)
            at += 4
        tags.append((code, data[at:at + length]))
        at += length
    return tags


def read_font3(body):
    font_id, flags, _, name_len = struct.unpack_from('<HBBB', body, 0)
    name = body[5:5 + name_len].decode()
    at = 5 + name_len
    (count,) = struct.unpack_from('<H', body, at)
    at += 2
    width, fmt = (4, '<I') if flags & 0x08 else (2, '<H')
    table = at
    offsets = [struct.unpack_from(fmt, body, table + width * i)[0] for i in range(count + 1)]
    shapes = [body[table + offsets[i]:table + (offsets[i + 1] if i + 1 < count else offsets[count])] for i in range(count)]
    codes_at = table + offsets[count]
    codes = list(struct.unpack_from(f'<{count}H', body, codes_at))
    at = codes_at + 2 * count
    ascent, descent, leading = struct.unpack_from('<hhh', body, at)
    advances = list(struct.unpack_from(f'<{count}h', body, at + 6))
    return {'id': font_id, 'bold': bool(flags & 1), 'layout': bool(flags & 0x80), 'name': name, 'codes': codes,
            'shapes': shapes, 'advances': advances, 'ascent': ascent, 'descent': descent}


class SwfFont(unittest.TestCase):
    def test_a_font_library_with_regular_and_bold_arabic(self):
        text = 'ﻣﺮﺣﺒﺎ ﺑﻚ ﻓﻲ ﺍﻟﻠﻌﺒﺔ'
        data, have = swffont.make_swf([(DEFAULT_FONT, False), (REPO / 'localization/assets/fonts/IBMPlexSansArabic-Bold.ttf', True)],
                                      text, 'GameShelf Arabic', 'IBM Plex Sans Arabic, SIL Open Font License')
        tags = read_swf(data)
        codes = [code for code, _ in tags]
        self.assertEqual(codes[0], 69)
        self.assertEqual(codes.count(75), 2)
        self.assertEqual(codes[-2:], [1, 0])
        fonts = [read_font3(body) for code, body in tags if code == 75]
        self.assertEqual([(f['name'], f['bold'], f['layout']) for f in fonts], [('GameShelf Arabic', False, True), ('GameShelf Arabic', True, True)])
        for font in fonts:
            self.assertEqual(font['codes'], sorted(font['codes']))
            for ch in set(text) | set('AZaz09?'):
                self.assertIn(ord(ch), font['codes'])
            self.assertGreater(font['ascent'], 0)
            self.assertGreater(font['descent'], 0)
            for code, shape, advance in zip(font['codes'], font['shapes'], font['advances']):
                contours, fills, used = decode_shape(shape)
                self.assertEqual(used, len(shape), chr(code))
                if not contours:
                    self.assertIn(unicodedata.category(chr(code))[0], 'ZC', f'U+{code:04X} has an outline')
                    continue
                self.assertEqual(fills, [1])  # fill style 0 is turned on once, at the first move
                for contour in contours:
                    self.assertEqual(contour[0], contour[-1], f'{chr(code)}: every contour is closed')
                    # In the 20480-unit em square, y pointing down.
                    self.assertTrue(all(-30000 < x < 40000 and -30000 < y < 20000 for x, y in contour))
                self.assertGreater(advance, 0)
        names = [body for code, body in tags if code == 88]
        self.assertEqual(names[0], struct.pack('<H', 1) + b'GameShelf Arabic\0IBM Plex Sans Arabic, SIL Open Font License\0')
        export = next(body for code, body in tags if code == 56)
        self.assertEqual(export, struct.pack('<H', 2) + struct.pack('<H', 1) + b'GameShelf Arabic\0' + struct.pack('<H', 2) + b'GameShelf Arabic Bold\0')
        self.assertTrue(set(text) <= set(have))


# ---- Loose files ----------------------------------------------------------------

def mo_file(pairs):
    """A .mo file as msgfmt writes it (little-endian, no hash table)."""
    originals = b''.join(o + b'\0' for o, _ in pairs)
    data_at = 28 + 16 * len(pairs)
    otable, ttable, blob = b'', b'', b''
    for original, _ in pairs:
        otable += struct.pack('<II', len(original), data_at + len(blob))
        blob += original + b'\0'
    for _, translated in pairs:
        ttable += struct.pack('<II', len(translated), data_at + len(blob))
        blob += translated + b'\0'
    del originals
    return struct.pack('<7I', 0x950412DE, 0, len(pairs), 28, 28 + 8 * len(pairs), 0, 0) + otable + ttable + blob


class LooseFormats(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def file(self, name, data):
        path = self.tmp / name
        path.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))
        return loose.read_file(path, name)

    def round_trip(self, found):
        written = found.write({key: f'AR {text}' for key, text in found.entries})
        path = self.tmp / ('again' + found.path.suffix)
        path.write_bytes(written)
        again = loose.read_file(path, path.name)
        return written, again

    def test_json_reads_text_values_only_and_only_the_english_of_language_tables(self):
        found = self.file('en.json', '{\n    "menu": {"start": "Start game", "id": "menu_start", "count": 3},\n'
                                     '    "lines": [{"en": "Hello there", "fr": "Bonjour"}, "Goodbye now"]\n}\n')
        self.assertEqual([t for _, t in found.entries], ['Start game', 'Hello there', 'Goodbye now'])
        written, again = self.round_trip(found)
        doc = json.loads(written)
        self.assertEqual(doc['menu'], {'start': 'AR Start game', 'id': 'menu_start', 'count': 3})
        self.assertEqual(doc['lines'][0], {'en': 'AR Hello there', 'fr': 'Bonjour'})
        self.assertTrue(written.decode().startswith('{\n    "menu"'))  # the file's own indent
        self.assertEqual(len(again.entries), 3)

    def test_csv_changes_only_the_english_column(self):
        found = self.file('strings.csv', 'id;English;French\r\nA;Open the door;Ouvrir\r\nB;"Say ""hi"";now";Dire\r\n')
        self.assertEqual([t for _, t in found.entries], ['Open the door', 'Say "hi";now'])
        written, _ = self.round_trip(found)
        self.assertEqual(written.decode(), 'id;English;French\r\nA;AR Open the door;Ouvrir\r\nB;"AR Say ""hi"";now";Dire\r\n')
        two = self.file('pairs.csv', 'START,Start the game\nQUIT,Leave for now\n')
        self.assertEqual([t for _, t in two.entries], ['Start the game', 'Leave for now'])

    def test_xml_text_attributes_and_cdata_but_not_other_languages(self):
        found = self.file('text.xml', '<?xml version="1.0"?>\n<!-- Shown in the menu -->\n<root>\n'
                                      '  <s id="a">Fish &amp; chips here</s>\n  <s id="b" label=\'Press "A" key\'/>\n'
                                      '  <s xml:lang="de"><t>Guten Morgen allerseits</t></s>\n  <s><![CDATA[Use <b>bold</b> words]]></s>\n</root>\n')
        self.assertEqual([t for _, t in found.entries], ['Fish & chips here', 'Press "A" key', 'Use <b>bold</b> words'])
        written = found.write({key: 'عربي <&>' for key, _ in found.entries}).decode()
        self.assertIn('<s id="a">عربي &lt;&amp;&gt;</s>', written)
        self.assertIn("label='عربي &lt;&amp;&gt;'", written)
        self.assertIn('<![CDATA[عربي <&>]]>', written)
        self.assertIn('<!-- Shown in the menu -->', written)
        self.assertIn('Guten Morgen allerseits', written)

    def test_po_entries_with_keys_continuations_and_plurals(self):
        found = self.file('en.po', 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n'
                                   '#: ui\nmsgid "MENU_START"\nmsgstr "Start a new game"\n\n'
                                   'msgid "Load the last save"\nmsgstr ""\n\n'
                                   'msgid "One apple left"\nmsgid_plural "%d apples left"\nmsgstr[0] ""\nmsgstr[1] ""\n\n'
                                   'msgid "LONG"\nmsgstr ""\n"First half, "\n"second half."\n')
        self.assertEqual([t for _, t in found.entries], ['Start a new game', 'Load the last save', 'One apple left', 'First half, second half.'])
        written, again = self.round_trip(found)
        text = written.decode()
        self.assertIn('msgid "MENU_START"\nmsgstr "AR Start a new game"', text)
        self.assertIn('msgstr[0] "AR One apple left"\nmsgstr[1] "AR One apple left"', text)
        self.assertIn('msgid "LONG"\nmsgstr "AR First half, second half."\n', text)
        self.assertIn('#: ui', text)
        self.assertEqual([t for _, t in again.entries], ['AR Start a new game', 'AR Load the last save', 'AR One apple left', 'AR First half, second half.'])

    def test_mo_files(self):
        data = mo_file([(b'', b'Content-Type: text/plain; charset=ISO-8859-1\n'), (b'GREETING', b'Good morning, friend'),
                        (b'Leave the city', b''), (b'ctx\x04Open the gate', b'')])
        found = self.file('en.mo', data)
        self.assertEqual([t for _, t in found.entries], ['Good morning, friend', 'Leave the city', 'Open the gate'])
        written, again = self.round_trip(found)
        self.assertIn(b'charset=UTF-8', written)
        self.assertEqual([t for _, t in again.entries], ['AR Good morning, friend', 'AR Leave the city', 'AR Open the gate'])

    def test_line_files_keep_keys_quotes_and_comments(self):
        found = self.file('english.txt', '// Valve style\n"lang"\n{\n"Tokens"\n{\n"START"  "Start the game"\n"QUIT"   "Quit to desktop"\n'
                                         '"HINT"   "Press \\"E\\" to use"\n}\n}\n')
        self.assertEqual([t for _, t in found.entries], ['Start the game', 'Quit to desktop', 'Press "E" to use'])
        written = found.write({key: 'عربي\nسطر' for key, _ in found.entries}).decode()
        self.assertIn('"START"  "عربي\\nسطر"', written)
        self.assertFalse(found.breaks)
        ini = self.file('en.ini', '[Menu]\n; comment\ntitle = The Lost Kingdom\ncount=12\nsub: "A tale of rivers"\n')
        self.assertEqual([t for _, t in ini.entries], ['The Lost Kingdom', 'A tale of rivers'])
        self.assertEqual(ini.write({k: 'X Y' for k, _ in ini.entries}).decode(), '[Menu]\n; comment\ntitle = X Y\ncount=12\nsub: "X Y"\n')
        apple = self.file('Localizable.strings', '/* menu */\n"start" = "Start the game";\n"quit" = "Quit now";\n')
        self.assertEqual(apple.write({k: 'X Y' for k, _ in apple.entries}).decode(), '/* menu */\n"start" = "X Y";\n"quit" = "X Y";\n')
        plain = self.file('credits_en.txt', 'Thank you for playing\nA game by Someone Great\n\nSee you next time\n')
        self.assertEqual(len(plain.entries), 3)

    def test_encodings_are_kept_and_windows_1252_becomes_utf8(self):
        found = self.file('en.json', b'\xef\xbb\xbf{"a": "Hello there", "b": "Good night"}')
        self.assertTrue(found.write({k: 'مرحبا' for k, _ in found.entries}).startswith(b'\xef\xbb\xbf'))
        utf16 = self.file('en.ini', '\ufeffa=Hello there\r\nb=Good night\r\n'.encode('utf-16-le'))
        self.assertEqual(utf16.write({k: 'X Y' for k, _ in utf16.entries}), '\ufeffa=X Y\r\nb=X Y\r\n'.encode('utf-16-le'))
        old = self.file('en.lang', b'a=Caf\xe9 tonight\nb=Good night\n')
        self.assertEqual(old.entries[0][1], 'Café tonight')
        self.assertEqual(old.write({'0': 'مرحبا'}).decode('utf-8'), 'a=مرحبا\nb=Good night\n')

    def test_what_counts_as_text_and_as_a_language(self):
        for text in ('Start game', 'Continue', 'OK!', 'Press [E] to open', "Don't go"):
            self.assertTrue(loose.looks_like_text(text), text)
        for text in ('menu_start', 'btnOk', 'textures/ui/a.png', '42', '{0}', 'ui.json', 'http://x.y z', ''):
            self.assertFalse(loose.looks_like_text(text), text)
        lang = lambda p: loose.language_of(PurePosixPath(p))  # noqa: E731
        self.assertEqual(lang('data/lang/en.json'), 'en')
        self.assertEqual(lang('Localization/English/ui.xml'), 'en')
        self.assertEqual(lang('text/strings_en-US.csv'), 'en')
        self.assertEqual(lang('lang/fr.json'), 'other')
        self.assertEqual(lang('lang/zh-Hans/ui.json'), 'other')
        self.assertEqual(lang('lang/strings_de.csv'), 'other')
        self.assertIsNone(lang('data/item_id.json'))
        self.assertIsNone(lang('text/no_save.txt'))


def make_loose_game(root: Path):
    (root / 'Game' / 'data' / 'lang').mkdir(parents=True)
    (root / 'Game' / 'data' / 'lang' / 'en.json').write_text(json.dumps({'menu': {'start': 'Start the game', 'quit': 'Quit to desktop'},
                                                                          'talk': ['Where are you going?', 'Stay a while.']}, indent=2), encoding='utf-8')
    (root / 'Game' / 'data' / 'lang' / 'fr.json').write_text(json.dumps({'menu': {'start': 'Commencer la partie'}}), encoding='utf-8')
    (root / 'Game' / 'data' / 'lang' / 'de.json').write_text(json.dumps({'menu': {'start': 'Spiel starten'}}), encoding='utf-8')
    (root / 'Game' / 'Localization').mkdir()
    (root / 'Game' / 'Localization' / 'subtitles.ini').write_text('[Intro]\nline1=The night was cold and long\nline2=We had to move on\nline3=Nobody slept\n', encoding='utf-8')
    (root / 'Game' / 'config').mkdir()
    (root / 'Game' / 'config' / 'settings.ini').write_text('width=1920\nheight=1080\nname=Hero Player\n', encoding='utf-8')
    (root / 'Game' / 'fonts').mkdir()
    (root / 'Game' / 'fonts' / 'Body.ttf').write_bytes(b'game font')
    (root / 'Game' / 'fonts' / 'Body-Bold.otf').write_bytes(b'game bold font')
    (root / 'Game' / 'fonts' / 'Icons.ttf').write_bytes(b'icon font')
    (root / 'Game' / 'Game.exe').write_bytes(b'MZ')
    return root / 'Game'


class LooseScan(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_the_english_files_and_text_fonts_are_found(self):
        game = make_loose_game(self.tmp)
        found = loose.scan(game)
        self.assertEqual(sorted(f.rel for f in found.files), ['Localization/subtitles.ini', 'data/lang/en.json'])
        self.assertEqual(found.fonts, ['fonts/Body-Bold.otf', 'fonts/Body.ttf'])

    def test_a_game_with_arabic_already_in_is_refused(self):
        game = self.tmp / 'G'
        (game / 'lang').mkdir(parents=True)
        (game / 'lang' / 'en.json').write_text(json.dumps({'a': 'ﻣﺮﺣﺒﺎ ﺑﻚ', 'b': 'ﻓﻲ ﺍﻟﻠﻌﺒﺔ', 'c': 'ﺍﻟﻠﻌﺒﺔ ﺍﻟﻠﻌﺒﺔ'}), encoding='utf-8')
        with self.assertRaisesRegex(loose.LooseError, 'Turn Arabic off'):
            loose.scan(game)


# ---- Recipes ----------------------------------------------------------------

FAKE_TOOL = f'''#!{sys.executable}
"""A stand-in for an unpacker: x <zip> <folder> takes everything out; r <zip> <folder> puts a folder's files back in."""
import json, os, sys, zipfile
command, archive, folder = sys.argv[1:4]
with open(os.path.join('out', 'env-' + command + '.json'), 'w') as f:
    json.dump(sorted(k for k in os.environ if k.startswith('GAMESHELF_') or 'TOKEN' in k.upper()), f)
if command == 'x':
    zipfile.ZipFile(archive).extractall(folder)
elif command == 'r':
    with zipfile.ZipFile(archive) as z:
        items = {{name: z.read(name) for name in z.namelist()}}
    for root, _, files in os.walk(folder):
        for name in files:
            full = os.path.join(root, name)
            items[os.path.relpath(full, folder).replace(os.sep, '/')] = open(full, 'rb').read()
    with zipfile.ZipFile(archive, 'w') as z:
        for name, data in items.items():
            z.writestr(name, data)
else:
    sys.exit('unknown command')
'''


def recipe_for(**changes):
    recipe = {
        'format': 1, 'game': {'steamAppId': 4242}, 'engine': 'test-engine', 'tool': 'ziptool',
        'extract': [['x', '{game}/content/text.pak', '{extracted}']],
        'text': [{'glob': '**/*.json', 'format': 'json'}],
        'copy': [{'from': '{game}/content/text.pak', 'to': '{work}/repack/text.pak'}],
        'repack': [['r', '{work}/repack/text.pak', '{edited}']],
        'stage': [{'from': '{work}/repack/text.pak', 'to': 'content/text.pak'}],
    }
    recipe.update(changes)
    return recipe


class Recipes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.tools = self.tmp / 'tools'
        (self.tools / 'ziptool').mkdir(parents=True)
        tool = self.tools / 'ziptool' / 'ziptool'
        tool.write_text(FAKE_TOOL, encoding='utf-8')
        tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
        registry = json.loads((REPO / 'localization/custom_engines.json').read_text(encoding='utf-8'))
        registry['tools']['ziptool'] = {'name': 'Zip tool', 'exe': ['ziptool']}
        self.registry_file = self.tmp / 'custom_engines.json'
        self.registry_file.write_text(json.dumps(registry), encoding='utf-8')
        self.registry = registry
        self.game = self.tmp / 'Game'
        (self.game / 'content').mkdir(parents=True)
        with zipfile.ZipFile(self.game / 'content' / 'text.pak', 'w') as z:
            z.writestr('loc/en/ui.json', json.dumps({'start': 'Start the game', 'quit': 'Quit to desktop', 'boss': 'Face the beast'}))
            z.writestr('models/hero.bin', b'\0\1\2')
        self.original = (self.game / 'content' / 'text.pak').read_bytes()

    def test_the_registry_knows_the_packed_engines(self):
        registry = recipes.load_registry()
        ids = {r['id'] for r in registry['recipes']}
        self.assertTrue({'bethesda-creation', 'santa-monica', 'redengine4', 'psarc'} <= ids)
        self.assertEqual(set(registry['tools']), {'quickbms', 'wolvenkit', 'repak'})

    def test_recipes_that_reach_too_far_are_refused(self):
        check = lambda **changes: recipes.check_recipe(recipe_for(**changes), self.registry)  # noqa: E731
        check()
        bad = {
            'tool': 'powershell',
            'extract': [['x', 'C:/Windows/System32/x.dll', '{extracted}']],
            'repack': [['r', '{game}/content/text.pak', '{edited}']],
            'stage': [{'from': '{work}/a.dll', 'to': 'bin/a.dll'}],
        }
        for key, value in bad.items():
            with self.assertRaises(recipes.RecipeError, msg=key):
                check(**{key: value})
        for arg in ('{extracted}/../../x', '../x', '{work}x', '-o=/etc/passwd', '{game}/{work}', '@list.txt'):
            with self.assertRaises(recipes.RecipeError, msg=arg):
                check(extract=[['x', arg]])
        for target in ('/abs/file.json', '..\\up.json', 'C:\\x.json', 'a/../b.json', 'run.bat'):
            with self.assertRaises(recipes.RecipeError, msg=target):
                check(stage=[{'from': '{work}/x', 'to': target}])
        with self.assertRaises(recipes.RecipeError):
            check(text=[{'glob': '../**/*.json', 'format': 'json'}])
        with self.assertRaises(recipes.RecipeError):
            check(copy=[{'from': '{game}/content/text.pak', 'to': '{game}/content/text2.pak'}])

    def test_a_missing_tool_says_where_it_goes(self):
        with self.assertRaisesRegex(recipes.RecipeError, 'QuickBMS isn\'t installed'):
            recipes.RecipeRun(recipe_for(tool='quickbms'), self.game, self.tmp / 'work', self.registry, self.tools)

    def test_a_run_takes_the_text_out_and_puts_the_arabic_back_into_a_copy(self):
        with mock.patch.dict(os.environ, {'GAMESHELF_SESSION': 'secret', 'GAMESHELF_TOKEN': 'gst_x', 'MY_API_TOKEN': 'x'}):
            run = recipes.RecipeRun(recipe_for(), self.game, self.tmp / 'work', self.registry, self.tools, log=lambda *_: None)
            files = run.extract()
            self.assertEqual([(f.rel, len(f.entries)) for f in files], [('loc/en/ui.json', 3)])
            self.assertEqual(run.write({'loc/en/ui.json': {key: 'عربي' for key, _ in files[0].entries}}), 1)
            outputs = run.repack()
        self.assertEqual([t for _, t in outputs], ['content/text.pak'])
        with zipfile.ZipFile(outputs[0][0]) as z:
            self.assertEqual(json.loads(z.read('loc/en/ui.json')), {'start': 'عربي', 'quit': 'عربي', 'boss': 'عربي'})
            self.assertEqual(z.read('models/hero.bin'), b'\0\1\2')
        self.assertEqual((self.game / 'content' / 'text.pak').read_bytes(), self.original)  # the game's own file is untouched
        self.assertEqual(json.loads((self.tmp / 'work' / 'out' / 'env-x.json').read_text()), [])  # no sign-in reached the tool


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class BuildingCustomEngines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import subprocess
        cls.keys = Path(tempfile.mkdtemp())
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(cls.keys / 'k')], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.keys)

    def setUp(self):
        self.api = FakeApi()
        self.tmp = Path(tempfile.mkdtemp())
        self.logged = []
        patcher = mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-key'})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.api.close()
        shutil.rmtree(self.tmp)

    def run_build(self, source, *extra):
        args = parse_args([str(source), '--id', 'test-ar', '--version', '1.0.0', '--steam-app-id', '4242', '--key', str(self.keys / 'k/pack-signing.key'),
                           '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'test-model', '--api-base', self.api.base, *extra])
        return build(args, log=self.logged.append)

    def read(self, pack):
        return node_read_pack(pack, self.keys / 'k/pack-signing.pub')

    def skyrim(self, arabic_loose=False):
        game = self.tmp / 'Skyrim Special Edition'
        (game / 'Data' / 'Strings').mkdir(parents=True)
        (game / 'SkyrimSE.exe').write_bytes(b'MZ')
        (game / 'Data' / 'Skyrim.esm').write_bytes(b'TES4')
        tables = {
            'strings/skyrim_english.strings': bethesda.write_table([(1, 'Iron Sword'), (2, 'Whiterun'), (3, '12')], 'strings'),
            'strings/skyrim_english.ilstrings': bethesda.write_table([(10, 'Never should have come here!')], 'ilstrings'),
            'strings/skyrim_french.strings': bethesda.write_table([(1, 'Épée en fer')], 'strings'),
            'interface/fontconfig.txt': FONTCONFIG.encode(),
        }
        (game / 'Data' / 'Skyrim - Interface.bsa').write_bytes(bsa(tables, 105))
        loose_text = 'ﻣﺮﺣﺒﺎ ﺑﻚ' if arabic_loose else 'Read the old scroll'
        (game / 'Data' / 'Strings' / 'Update_English.DLSTRINGS').write_bytes(bethesda.write_table([(5, loose_text)], 'dlstrings'))
        return game

    def test_a_bethesda_pack_has_arabic_tables_the_font_library_and_fontconfig(self):
        pack = self.run_build(self.skyrim())
        read = self.read(pack)
        self.assertEqual(read['manifest']['engine'], 'bethesda')
        self.assertEqual(sorted(read['files']), ['Data/Interface/GameShelf/FONT-LICENSE-OFL.txt', 'Data/Interface/fontconfig.txt',
                                                 'Data/Interface/gameshelf_arabic.swf', 'Data/Strings/Update_English.DLSTRINGS',
                                                 'Data/Strings/skyrim_english.ilstrings', 'Data/Strings/skyrim_english.strings'])
        strings = dict(bethesda.read_table((pack / 'payload/Data/Strings/skyrim_english.strings').read_bytes(), 'strings'))
        self.assertEqual(set(strings), {1, 2, 3})
        self.assertEqual(strings[3], '12')  # no letters: left as it is
        self.assertTrue(shaped(strings[1]) and shaped(strings[2]))
        dialogue = dict(bethesda.read_table((pack / 'payload/Data/Strings/skyrim_english.ilstrings').read_bytes(), 'ilstrings'))
        self.assertTrue(shaped(dialogue[10]))
        config = (pack / 'payload/Data/Interface/fontconfig.txt').read_bytes().decode()
        self.assertIn('fontlib "Interface\\gameshelf_arabic.swf"\r\n', config)
        self.assertIn('map "$DragonFont" = "Dragon_script" Normal', config)
        swf = (pack / 'payload/Data/Interface/gameshelf_arabic.swf').read_bytes()
        fonts = [read_font3(body) for code, body in read_swf(swf) if code == 75]
        for ch in strings[1] + dialogue[10]:
            self.assertIn(ord(ch), fonts[0]['codes'])
        info = json.loads((self.tmp / 'out' / 'build-info.json').read_text(encoding='utf-8'))
        self.assertEqual(info['engine'], 'bethesda')

    def test_a_bethesda_game_with_the_arabic_in_is_refused(self):
        with self.assertRaisesRegex(BuildError, 'Turn Arabic off'):
            game = self.skyrim(arabic_loose=True)
            (game / 'Data' / 'Strings' / 'skyrim_english.strings').write_bytes(
                bethesda.write_table([(1, 'ﻣﺮﺣﺒﺎ ﺑﻚ'), (2, 'ﻓﻲ ﺍﻟﻠﻌﺒﺔ')], 'strings'))
            self.run_build(game)

    def test_a_loose_file_pack_rewrites_the_games_text_files_and_fonts(self):
        game = make_loose_game(self.tmp)
        pack = self.run_build(game, '--engine', 'loose')
        read = self.read(pack)
        self.assertEqual(read['manifest']['engine'], 'loose')
        self.assertEqual(sorted(read['files']), ['Localization/subtitles.ini', 'data/lang/en.json', 'fonts/Body-Bold.otf', 'fonts/Body.ttf',
                                                 'gameshelf_arabic/FONT-LICENSE-OFL.txt'])
        doc = json.loads((pack / 'payload/data/lang/en.json').read_text(encoding='utf-8'))
        self.assertTrue(all(shaped(t) for t in doc['menu'].values()))
        ini = (pack / 'payload/Localization/subtitles.ini').read_text(encoding='utf-8')
        self.assertEqual(len(ini.splitlines()), 4)  # no line breaks put into a line-based file
        self.assertTrue(ini.startswith('[Intro]\nline1='))
        self.assertEqual((pack / 'payload/fonts/Body.ttf').read_bytes(), DEFAULT_FONT.read_bytes())
        info = json.loads((self.tmp / 'out' / 'build-info.json').read_text(encoding='utf-8'))
        self.assertEqual(info['fontTargets'], ['fonts/Body-Bold.otf', 'fonts/Body.ttf'])

    def test_a_fromsoftware_game_gets_its_msgbnd_back_with_the_arabic_in_it(self):
        from test_binary_tables import ITEMS, TALK, msgbnd
        from arabic_compiler import fromsoft
        game = self.tmp / 'Sekiro'
        (game / 'msg' / 'engus').mkdir(parents=True)
        (game / 'msg' / 'engus' / 'item.msgbnd.dcx').write_bytes(msgbnd({'Item.fmg': ITEMS, 'Talk.fmg': TALK}))
        (game / 'sekiro.exe').write_bytes(b'MZ')
        pack = self.run_build(game, '--engine', 'loose', '--no-fonts')
        read = self.read(pack)
        self.assertEqual(read['manifest']['engine'], 'loose')
        self.assertEqual(read['files'], ['msg/engus/item.msgbnd.dcx'])
        found = fromsoft.read_messages((pack / 'payload/msg/engus/item.msgbnd.dcx').read_bytes())
        talk = found.tables['1:Talk.fmg'].entries
        self.assertTrue(all(shaped(talk[i]) for i in (10000, 10002)))
        self.assertEqual(found.tables['0:Item.fmg'].entries[102], None)
        self.assertEqual((game / 'msg' / 'engus' / 'item.msgbnd.dcx').read_bytes()[:4], b'DCX\0')  # the game's own file is untouched

    def test_a_game_with_no_readable_text_asks_for_a_recipe(self):
        game = self.tmp / 'Packed'
        (game / 'exec' / 'wad' / 'pc_le').mkdir(parents=True)
        (game / 'exec' / 'wad' / 'pc_le' / 'r_english.wad').write_bytes(b'\0' * 64)
        with self.assertRaisesRegex(BuildError, 'engine recipe'):
            self.run_build(game, '--engine', 'loose')

    def test_a_recipe_pack_holds_the_repacked_archive(self):
        helper = Recipes('test_the_registry_knows_the_packed_engines')
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        recipe_file = self.tmp / 'recipe.json'
        # As the app saves a signed recipe.
        recipe_file.write_text(json.dumps({'recipe': json.dumps(recipe_for()), 'signature': 'x'}), encoding='utf-8')
        with mock.patch.object(recipes, 'REGISTRY', helper.registry_file):
            pack = self.run_build(helper.game, '--recipe', str(recipe_file), '--tools-dir', str(helper.tools))
        read = self.read(pack)
        self.assertEqual(read['manifest']['engine'], 'custom')
        self.assertEqual(read['files'], ['content/text.pak'])
        with zipfile.ZipFile(pack / 'payload/content/text.pak') as z:
            texts = json.loads(z.read('loc/en/ui.json'))
        self.assertTrue(all(shaped(t) for t in texts.values()))
        self.assertEqual((helper.game / 'content' / 'text.pak').read_bytes(), helper.original)
        self.assertFalse((self.tmp / 'out' / 'recipe-work').exists())


if __name__ == '__main__':
    unittest.main()
