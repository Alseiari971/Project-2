"""Tests for UE5 IoStore containers (retoc) and the native runtime adapter: the
container header, listing and taking a .locres out of a .utoc, cooked font
packages into the Arabic .utoc/.ucas beside the .pak; the safe text scan,
gameshelf_strings.bin, and the adapter's own C string table code (built with
the system's C compiler) agreeing with the Python that writes the table."""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from arabic_compiler import locres as locres_format
from arabic_compiler import retoc, runtime
from arabic_compiler.packbuild import BuildError, build, parse_args
from arabic_compiler import packbuild
from arabic_compiler.sources import SourceError, read_source
from test_build_pack import HAS_NODE, REPO, FakeApi, node_read_pack

RUNTIME = REPO / 'localization' / 'runtime'
CC = shutil.which('cc') or shutil.which('gcc') or shutil.which('clang')
MINGW = shutil.which('x86_64-w64-mingw32-gcc')


def utoc(path: Path, chunks: list, encrypted=False):
    """A .utoc with a real header (magic, version, entry count, flags) and, for the stand-in retoc, its chunks."""
    head = bytearray(144)
    head[:16] = retoc.TOC_MAGIC
    head[16] = 8
    struct.pack_into('<I', head, 20, 144)
    struct.pack_into('<I', head, 24, len(chunks))
    head[80] = retoc.INDEXED | (retoc.ENCRYPTED if encrypted else 0)
    path.write_bytes(bytes(head) + json.dumps(chunks).encode())
    return path


FAKE_RETOC = r'''
import json, sys
from pathlib import Path
# Stands in for retoc: a .utoc here is a real header followed by a JSON list of chunks {id, type, path, hex}.
args = sys.argv[1:]
key = None
if args[:1] == ['--aes-key']:
    key, args = args[1], args[2:]
cmd = args[0]
GOOD = '0x' + 'ab' * 32
def chunks(utoc):
    data = Path(utoc).read_bytes()
    if data[80] & 2 and key != GOOD:
        sys.exit(f'{Path(utoc).name} is encrypted; the key {key} is wrong' if key else f'{Path(utoc).name} is encrypted')
    return json.loads(data[144:])
if cmd == 'list':
    utoc = [a for a in args[1:] if not a.startswith('--')][0]
    for c in chunks(utoc):
        print(f"{Path(utoc).stem:30} {c['id']} {c['type']:20} {c['path']}")
elif cmd == 'get':
    utoc, chunk_id, out = args[1:4]
    found = [c for c in chunks(utoc) if c['id'] == chunk_id]
    if not found:
        sys.exit('no such chunk')
    Path(out).write_bytes(bytes.fromhex(found[0]['hex']))
elif cmd == 'to-zen':
    if key:
        sys.exit('our own container is never encrypted')
    folder, out = Path(args[1]), Path(args[2])
    version = args[args.index('--version') + 1]
    files = sorted(p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file())
    out.write_bytes(b'-==--==--==--==-' + json.dumps({'version': version, 'files': files}).encode())
    out.with_suffix('.ucas').write_bytes(b'ucas for ' + ' '.join(files).encode())
    if not out.with_suffix('.pak').exists():
        out.with_suffix('.pak').write_bytes(b'empty pak')
else:
    sys.exit('unknown command ' + cmd)
'''

FAKE_REPAK = r'''
import json, sys
from pathlib import Path
argv = sys.argv[1:]
key = None
if argv[:1] == ['--aes-key']:
    key, argv = argv[1], argv[2:]
cmd, args = argv[0], argv[1:]
if cmd == 'pack':
    Path(args[-1]).write_bytes(b'the Arabic pak'); sys.exit(0)
pak = json.loads(Path(args[0]).read_text())
if pak.get('encrypted') and key != '0x' + 'ab' * 32:
    sys.exit('the pak is AES encrypted')
if cmd == 'list':
    print('\n'.join(pak['files']))
elif cmd == 'info':
    print('version: V11')
elif cmd == 'get':
    sys.stdout.buffer.write(bytes.fromhex(pak['files'][args[1]]))
'''


def tool(folder: Path, name: str, script: str) -> Path:
    source = folder / f'{name}.py'
    source.write_text(script, encoding='utf-8')
    path = folder / name
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{source}" "$@"\n', encoding='utf-8')
    path.chmod(0o755)
    return path


def english_locres():
    return locres_format.write(locres_format.LocRes(3, [locres_format.Namespace('UI', [
        locres_format.Entry('Start', 'Start the journey', 1), locres_format.Entry('Quit', 'Leave the blade behind', 2)])]))


class IoStore(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        tools = self.tmp / 'tools'
        tools.mkdir()
        env = mock.patch.dict(os.environ, {'GAMESHELF_REPAK': str(tool(tools, 'repak', FAKE_REPAK)),
                                           'GAMESHELF_RETOC': str(tool(tools, 'retoc', FAKE_RETOC))})
        env.start()
        self.addCleanup(env.stop)

    def game(self, pak_files: dict, chunks: list, encrypted=False):
        game = self.tmp / 'PhantomBlade'
        paks = game / 'PhantomBlade' / 'Content' / 'Paks'
        paks.mkdir(parents=True)
        (paks / 'pakchunk0-Windows.pak').write_text(json.dumps({'files': pak_files, 'encrypted': encrypted}))
        utoc(paks / 'pakchunk0-Windows.utoc', chunks, encrypted)
        (paks / 'pakchunk0-Windows.ucas').write_bytes(b'ucas')
        binaries = game / 'PhantomBlade' / 'Binaries' / 'Win64'
        binaries.mkdir(parents=True)
        (binaries / 'PhantomBlade-Win64-Shipping.exe').write_bytes(b'MZ' + b'\0' * 5000 + '++UE5+Release-5.4-CL-0'.encode('utf-16-le') + b'\0' * 100)
        return game

    def test_the_container_header_says_whether_it_is_encrypted(self):
        path = utoc(self.tmp / 'a.utoc', [{'id': '00' * 12}] * 3)
        header = retoc.toc_header(path)
        self.assertEqual((header.version, header.entries, header.encrypted, header.indexed), (8, 3, False, True))
        self.assertTrue(retoc.toc_header(utoc(self.tmp / 'b.utoc', [], encrypted=True)).encrypted)
        (self.tmp / 'c.utoc').write_bytes(b'not a container' * 10)
        with self.assertRaises(retoc.RetocError):
            retoc.toc_header(self.tmp / 'c.utoc')

    def test_the_engine_version_comes_from_the_games_program(self):
        exe = self.tmp / 'Game.exe'
        exe.write_bytes(b'MZ' + os.urandom(9 * 1024 * 1024) + b'++UE5+Release-5.3-CL-123' + b'\0' * 10)
        self.assertEqual(retoc.engine_version(exe), 'UE5_3')
        exe.write_bytes(b'MZ' + b'\0' * 100)
        self.assertIsNone(retoc.engine_version(exe))
        self.assertEqual(retoc.check_version('UE5_4'), 'UE5_4')
        with self.assertRaises(retoc.RetocError):
            retoc.check_version('5.4; rm -rf')

    def test_the_version_is_found_when_the_games_binaries_folder_has_only_helper_tools(self):
        # Like Phantom Blade Zero: Binaries/Win64 holds a 7-Zip tool and helpers, and the engine's
        # own UnrealCEFSubProcess.exe is the program that says which Unreal Engine the game uses.
        game = self.tmp / 'PBZ'
        win64 = game / 'ProjectPBZ' / 'Binaries' / 'Win64'
        win64.mkdir(parents=True)
        (win64 / '8za_v2.exe').write_bytes(b'MZ' + b'\0' * 5000)
        (win64 / 'CheckEnv.exe').write_bytes(b'MZ' + b'\0' * 500)
        (win64 / 'crashpad_handler.exe').write_bytes(b'MZ' + b'\0' * 3000)
        cef = game / 'Engine' / 'Binaries' / 'ThirdParty' / 'CEF3' / 'Win64'
        cef.mkdir(parents=True)
        (cef / 'libcef_helper.exe').write_bytes(b'MZ ++UE5+Release-5.0')  # not the engine's: ignored
        engine = game / 'Engine' / 'Binaries' / 'Win64'
        engine.mkdir(parents=True)
        (engine / 'UnrealCEFSubProcess.exe').write_bytes(b'MZ' + '++UE5+Release-5.4-CL-0'.encode('utf-16-le') + b'\0' * 10)
        names = [p.name for p in packbuild.unreal_programs(game)]
        self.assertNotIn('8za_v2.exe', names)
        self.assertNotIn('libcef_helper.exe', names)
        self.assertEqual(packbuild.game_engine_version(game), 'UE5_4')
        # The game's own -Shipping program comes first when there is one.
        (win64 / 'ProjectPBZ-Win64-Shipping.exe').write_bytes(b'MZ ++UE5+Release-5.5-CL-1')
        self.assertEqual(packbuild.unreal_programs(game)[0].name, 'ProjectPBZ-Win64-Shipping.exe')
        self.assertEqual(packbuild.game_engine_version(game), 'UE5_5')

    def test_a_hidden_version_is_matched_from_the_games_own_containers(self):
        # Each engine version lays out an empty container its own way: (.utoc version, container header version).
        layout = {'UE5_0': (5, None), 'UE5_1': (5, 1), 'UE5_2': (5, 2), 'UE5_3': (6, 3), 'UE5_4': (7, 3), 'UE5_5': (8, 4), 'UE5_6': (8, 4)}

        def container(path, toc, header, encrypted=False):
            utoc(path, [], encrypted=encrypted)
            data = bytearray(path.read_bytes())
            data[16] = toc
            path.write_bytes(bytes(data))
            ucas = retoc.CONTAINER_HEADER_SIGNATURE + struct.pack('<i', header) if header is not None else b'\xff' * 8
            path.with_suffix('.ucas').write_bytes(ucas + b'\0' * 56)

        def fake_to_zen(tool, legacy, out, version, log=print):
            if version not in layout:
                raise retoc.RetocError(f'unknown version {version}')
            container(Path(out), *layout[version])
            return [Path(out).with_suffix(e) for e in ('.utoc', '.ucas', '.pak')]

        paks = self.tmp / 'Paks'
        paks.mkdir()
        container(paks / 'pakchunkMovies-Windows.utoc', 7, 3)
        container(paks / 'Game-Windows.utoc', 9, None, encrypted=True)  # encrypted: not compared
        with mock.patch.object(retoc, 'to_zen', fake_to_zen):
            self.assertEqual(retoc.version_from_containers('retoc', retoc.game_containers(paks), self.tmp / 'probe', log=lambda *_: None), 'UE5_4')
            # Two versions with the same layout are interchangeable for an empty container.
            container(paks / 'pakchunkMovies-Windows.utoc', 8, 4)
            self.assertIn(retoc.version_from_containers('retoc', retoc.game_containers(paks), self.tmp / 'probe2', log=lambda *_: None), ('UE5_5', 'UE5_6'))
            # Nothing laid out like the game's, or game containers that disagree: no guess.
            container(paks / 'pakchunkMovies-Windows.utoc', 9, 9)
            self.assertIsNone(retoc.version_from_containers('retoc', retoc.game_containers(paks), self.tmp / 'probe3', log=lambda *_: None))
            container(paks / 'pakchunkMovies-Windows.utoc', 7, 3)
            container(paks / 'pakchunkUI-Windows.utoc', 8, 4)
            self.assertIsNone(retoc.version_from_containers('retoc', retoc.game_containers(paks), self.tmp / 'probe4', log=lambda *_: None))
            # Without a readable container header, layouts that differ only there can't be told apart.
            (paks / 'pakchunkUI-Windows.utoc').unlink()
            container(paks / 'pakchunkMovies-Windows.utoc', 5, None)
            self.assertIsNone(retoc.version_from_containers('retoc', retoc.game_containers(paks), self.tmp / 'probe5', log=lambda *_: None))

    def test_a_locres_kept_in_a_container_is_read_from_it_and_font_packages_are_listed(self):
        game = self.game({'PhantomBlade/Content/Movies/intro.bk2': '00'}, [
            {'id': '0a' * 12, 'type': 'ExportBundleData', 'path': '../../../PhantomBlade/Content/UI/Fonts/Body_Font.uasset', 'hex': '00'},
            {'id': '0b' * 12, 'type': 'ExportBundleData', 'path': '../../../PhantomBlade/Content/Maps/Town.umap', 'hex': '00'},
            {'id': '0c' * 12, 'type': 'ExternalFile', 'path': '../../../PhantomBlade/Content/Localization/Game/en/Game.locres', 'hex': english_locres().hex()},
            {'id': '0d' * 12, 'type': 'ExternalFile', 'path': '../../../PhantomBlade/Content/Localization/Game/zh-Hans/Game.locres', 'hex': '00'},
        ])
        source = read_source(game)
        self.assertEqual(source.locres_path, 'PhantomBlade/Content/Localization/Game/en/Game.locres')
        self.assertEqual([r.source for r in source.rows], ['Start the journey', 'Leave the blade behind'])
        self.assertEqual(source.extra['iostore']['font_packages'], ['PhantomBlade/Content/UI/Fonts/Body_Font.uasset'])
        self.assertIn('PhantomBlade/Content/Maps/Town.umap', source.pak_listing)
        self.assertTrue(any('Read PhantomBlade/Content/Localization/Game/en/Game.locres from pakchunk0-Windows.utoc' in n for n in source.notes))

    def test_encrypted_containers_are_left_alone(self):
        game = self.game({}, [{'id': '0c' * 12, 'type': 'ExternalFile', 'path': '../../../PhantomBlade/Content/Localization/Game/en/Game.locres', 'hex': '00'}],
                         encrypted=True)
        with self.assertRaisesRegex(SourceError, 'encrypted .*never looks for keys: an admin can attach'):
            read_source(game)

    def encrypted_game(self):
        return self.game({}, [
            {'id': '0c' * 12, 'type': 'ExternalFile', 'path': '../../../PhantomBlade/Content/Localization/Game/en/Game.locres', 'hex': english_locres().hex()},
        ], encrypted=True)

    def test_an_admin_given_key_is_passed_to_retoc_and_repak_and_opens_them(self):
        game = self.encrypted_game()
        with mock.patch.dict(os.environ, {'GAMESHELF_AES_KEY': '0x' + 'ab' * 32}):
            source = read_source(game)
        self.assertEqual([r.source for r in source.rows], ['Start the journey', 'Leave the blade behind'])
        self.assertTrue(source.extra['iostore']['keyed'])
        self.assertTrue(any('read with the key from the game\'s recipe' in n for n in source.notes))

    def test_a_wrong_key_fails_without_showing_it_and_a_malformed_one_is_refused(self):
        game = self.encrypted_game()
        wrong = '0x' + 'cd' * 32
        with mock.patch.dict(os.environ, {'GAMESHELF_AES_KEY': wrong}):
            with self.assertRaisesRegex(SourceError, 'key in its recipe didn\'t open') as caught:
                read_source(game)
            self.assertNotIn(wrong, str(caught.exception))
            result = retoc._run(os.environ['GAMESHELF_RETOC'], 'list', '--path', str(next(game.rglob('*.utoc'))))
            self.assertIn('0x…', result.stderr)
            self.assertNotIn(wrong, result.stderr)
        for bad in ('abcd', '0x' + 'ab' * 31, '0x' + 'zz' * 32, '0x' + 'ab' * 32 + '; rm -rf /'):
            with mock.patch.dict(os.environ, {'GAMESHELF_AES_KEY': bad}):
                with self.assertRaises((SourceError, retoc.RetocError)):
                    read_source(game)
        self.assertEqual(retoc.key_args({}), [])
        self.assertEqual(retoc.key_args({'GAMESHELF_AES_KEY': '0x' + 'AB' * 32}), ['--aes-key', '0x' + 'AB' * 32])

    @unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
    def test_a_ue5_game_gets_the_pak_utoc_ucas_triplet_even_without_cooked_fonts(self):
        game = self.game({'PhantomBlade/Content/Localization/Game/en/Game.locres': english_locres().hex()},
                         [{'id': '0b' * 12, 'type': 'ExportBundleData', 'path': '../../../PhantomBlade/Content/Maps/Town.umap', 'hex': '00'}])
        keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(keys)], check=True, capture_output=True)
        api = FakeApi()
        self.addCleanup(api.close)
        logged = []
        with mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-key'}):
            args = parse_args([str(game), '--id', 'pbz-ar', '--version', '1.0.0', '--steam-app-id', '2109880', '--key', str(keys / 'pack-signing.key'),
                               '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', api.base])
            pack = build(args, log=logged.append)
        read = node_read_pack(pack, keys / 'pack-signing.pub')
        self.assertEqual(sorted(read['files']), ['pakchunk99-ArabicLocalization_P.pak', 'pakchunk99-ArabicLocalization_P.ucas',
                                                 'pakchunk99-ArabicLocalization_P.utoc'])
        zen = json.loads((pack / 'payload' / 'pakchunk99-ArabicLocalization_P.utoc').read_bytes()[16:])
        self.assertEqual(zen, {'version': 'UE5_4', 'files': []})
        self.assertEqual((pack / 'payload' / 'pakchunk99-ArabicLocalization_P.pak').read_bytes(), b'the Arabic pak')
        self.assertTrue(any('to go with the Arabic .pak' in line for line in logged))

    @unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
    def test_the_copyright_notice_stays_english_with_the_credit_under_it(self):
        english = locres_format.write(locres_format.LocRes(3, [locres_format.Namespace('UI', [
            locres_format.Entry('Start', 'Start the journey', 1),
            locres_format.Entry('Copyright', '\u00a92026 Phantom World Limited. All rights reserved.', 2)])]))
        game = self.game({'PhantomBlade/Content/Localization/Game/en/Game.locres': english.hex()},
                         [{'id': '0b' * 12, 'type': 'ExportBundleData', 'path': '../../../PhantomBlade/Content/Maps/Town.umap', 'hex': '00'}])
        keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(keys)], check=True, capture_output=True)
        api = FakeApi()
        self.addCleanup(api.close)
        logged = []
        with mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-key'}):
            args = parse_args([str(game), '--id', 'pbz-ar', '--version', '1.0.0', '--steam-app-id', '2109880', '--key', str(keys / 'pack-signing.key'),
                               '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', api.base, '--credit', '--ltr-layout'])
            build(args, log=logged.append)
        staged = locres_format.read((self.tmp / 'out' / 'stage' / 'pak' / 'PhantomBlade' / 'Content' / 'Localization' / 'Game' / 'en' / 'Game.locres').read_bytes())
        texts = {e.key: e.text for ns in staged.namespaces for e in ns.entries}
        self.assertTrue(texts['Copyright'].startswith('\u00a92026 Phantom World Limited. All rights reserved.\r\n'))
        self.assertTrue(texts['Copyright'].endswith(packbuild.CREDIT + '\u202c'))  # its own paragraph, laid out like the other Arabic
        self.assertNotIn('Phantom', texts['Copyright'].split('\r\n')[1])
        self.assertTrue(any('Kept 1 copyright line in English' in line for line in logged))

    @unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
    def test_cooked_font_packages_go_into_the_arabic_utoc_and_ucas_beside_the_pak(self):
        game = self.game({'PhantomBlade/Content/Localization/Game/en/Game.locres': english_locres().hex()},
                         [{'id': '0a' * 12, 'type': 'ExportBundleData', 'path': '../../../PhantomBlade/Content/UI/Fonts/Body_Font.uasset', 'hex': '00'}])
        cooked = self.tmp / 'cooked'
        (cooked / 'PhantomBlade' / 'Content' / 'UI' / 'Fonts').mkdir(parents=True)
        for ext in ('.uasset', '.uexp', '.ubulk'):
            (cooked / 'PhantomBlade' / 'Content' / 'UI' / 'Fonts' / f'Body_Font{ext}').write_bytes(b'cooked ' + ext.encode())
        keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(keys)], check=True, capture_output=True)
        api = FakeApi()
        self.addCleanup(api.close)
        logged = []
        with mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-key'}):
            args = parse_args([str(game), '--id', 'pbz-ar', '--version', '1.0.0', '--steam-app-id', '2109880', '--key', str(keys / 'pack-signing.key'),
                               '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', api.base,
                               '--font-assets', str(cooked)])
            pack = build(args, log=logged.append)
        read = node_read_pack(pack, keys / 'pack-signing.pub')
        self.assertEqual(read['manifest']['engine'], 'unreal')
        self.assertEqual(sorted(read['files']), ['pakchunk99-ArabicLocalization_P.pak', 'pakchunk99-ArabicLocalization_P.ucas',
                                                 'pakchunk99-ArabicLocalization_P.utoc'])
        self.assertEqual((pack / 'payload' / 'pakchunk99-ArabicLocalization_P.pak').read_bytes(), b'the Arabic pak')  # to-zen kept it
        zen = json.loads((pack / 'payload' / 'pakchunk99-ArabicLocalization_P.utoc').read_bytes()[16:])
        self.assertEqual(zen, {'version': 'UE5_4', 'files': ['PhantomBlade/Content/UI/Fonts/Body_Font.uasset', 'PhantomBlade/Content/UI/Fonts/Body_Font.ubulk',
                                                             'PhantomBlade/Content/UI/Fonts/Body_Font.uexp']})
        self.assertTrue(any('cooked packages into' in line for line in logged))

    @unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
    def test_arabic_as_its_own_language_patches_the_style_tables_and_packs_the_logo(self):
        from arabic_compiler import uestyles

        def row(styles):  # an unversioned row: a prefix, then the per-language map
            return b'\x00\x03' + struct.pack('<ii', 0, len(styles)) + b''.join(uestyles.fstring(c) + v for c, v in styles)

        uexp = row([('zh-Hans', b'ZH-STYLE'), ('en-US', b'EN-STYLE-1'), ('ja', b'JA')]) + row([('en-US', b'EN-STYLE-2'), ('ru', b'RU')])
        header = bytearray(b'\xc1\x83\x2a\x9e' + b'\0' * 200)
        struct.pack_into('<q', header, 60, len(header) + len(uexp))          # BulkDataStartOffset
        struct.pack_into('<qq', header, 120, len(uexp), len(header))         # the export's SerialSize, SerialOffset
        ui = self.tmp / 'ui'
        table = ui / 'PhantomBlade' / 'Content' / 'UI' / 'DT_GameDescriptionStyles.uasset'
        table.parent.mkdir(parents=True)
        table.write_bytes(bytes(header))
        table.with_suffix('.uexp').write_bytes(uexp)
        logo = self.tmp / 'logo'
        (logo / 'PhantomBlade' / 'Content' / 'UI' / 'Title').mkdir(parents=True)
        for ext in ('.uasset', '.uexp', '.ubulk'):
            (logo / 'PhantomBlade' / 'Content' / 'UI' / 'Title' / f'T_Logo_AR{ext}').write_bytes(b'logo ' + ext.encode())
        meta = locres_format.write_locmeta(locres_format.LocMeta('en', 'en/Game.locres', ['en', 'ja']))
        game = self.game({'PhantomBlade/Content/Localization/Game/en/Game.locres': english_locres().hex(),
                          'PhantomBlade/Content/Localization/Game/Game.locmeta': meta.hex()}, [])
        keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(keys)], check=True, capture_output=True)
        api = FakeApi()
        self.addCleanup(api.close)
        logged = []
        with mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-key'}):
            args = parse_args([str(game), '--id', 'pbz-ar', '--version', '1.0.0', '--steam-app-id', '2109880', '--key', str(keys / 'pack-signing.key'),
                               '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', api.base,
                               '--arabic-language', '--ui-assets', str(ui), '--logo-assets', str(logo), '--ue-version', 'UE5_7'])
            pack = build(args, log=logged.append)
        stage = self.tmp / 'out' / 'stage'
        # The Arabic .locres is there for "ar" too, and "ar" is among the game's languages.
        pak = stage / 'pak' / 'PhantomBlade' / 'Content' / 'Localization' / 'Game'
        self.assertEqual((pak / 'ar' / 'Game.locres').read_bytes(), (pak / 'en' / 'Game.locres').read_bytes())
        self.assertEqual(locres_format.read_locmeta((pak / 'Game.locmeta').read_bytes()).cultures, ['en', 'ja', 'ar'])
        # Every row with an English style got the same style for Arabic, and the header knows the new size.
        patched = stage / 'cooked' / 'PhantomBlade' / 'Content' / 'UI' / 'DT_GameDescriptionStyles.uasset'
        data = patched.with_suffix('.uexp').read_bytes()
        maps = uestyles.culture_maps(data)
        self.assertEqual([[k[0] for k in m.keys] for m in maps], [['zh-Hans', 'en-US', 'ar', 'ja'], ['en-US', 'ar', 'ru']])
        self.assertIn(uestyles.fstring('ar') + b'EN-STYLE-1', data)
        size, offset = struct.unpack_from('<qq', patched.read_bytes(), 120)
        self.assertEqual((size, offset), (len(data), 204))
        self.assertEqual(struct.unpack_from('<q', patched.read_bytes(), 60)[0], 204 + len(data))
        # The patched table and the logo are packages in the Arabic .utoc/.ucas, not an empty stand-in.
        zen = json.loads((pack / 'payload' / 'pakchunk99-ArabicLocalization_P.utoc').read_bytes()[16:])
        self.assertEqual(zen['version'], 'UE5_7')
        self.assertIn('PhantomBlade/Content/UI/DT_GameDescriptionStyles.uasset', zen['files'])
        self.assertIn('PhantomBlade/Content/UI/DT_GameDescriptionStyles.uexp', zen['files'])
        self.assertIn('PhantomBlade/Content/UI/Title/T_Logo_AR.ubulk', zen['files'])
        self.assertTrue(any('Added Arabic as a language' in line for line in logged))
        self.assertTrue(any('Added an Arabic style to every row' in line for line in logged))

    def test_cooked_packages_need_their_uexp_and_a_known_engine_version(self):
        broken = self.tmp / 'broken'
        (broken / 'G' / 'Content').mkdir(parents=True)
        (broken / 'G' / 'Content' / 'Font.uasset').write_bytes(b'x')
        with self.assertRaisesRegex(retoc.RetocError, 'no .uexp'):
            retoc.font_assets(broken)
        (broken / 'Loose.uasset').write_bytes(b'x')
        (broken / 'Loose.uexp').write_bytes(b'x')
        (broken / 'G' / 'Content' / 'Font.uexp').write_bytes(b'x')
        with self.assertRaisesRegex(retoc.RetocError, 'Content'):
            retoc.font_assets(broken)


# ---- The runtime adapter's string table --------------------------------------------------

class StringTable(unittest.TestCase):
    def test_fnv1a_and_normalizing(self):
        self.assertEqual(runtime.fnv1a64(b''), 0xcbf29ce484222325)
        self.assertEqual(runtime.fnv1a64(b'a'), 0xaf63dc4c8601ec8c)
        self.assertEqual(runtime.fnv1a64(b'foobar'), 0x85944171f73967e8)
        self.assertEqual(runtime.normalize('  Press\tStart \r\n now \n'), 'Press Start now')
        self.assertEqual(runtime.key_of('Press  Start'), runtime.key_of('Press Start\n'))

    def test_the_table_round_trips_and_is_sorted(self):
        data = runtime.write_table([('Hello there, traveler.', 'مرحبًا أيها المسافر.'), ('Continue', 'متابعة'), ('Continue', 'later one'), ('', 'x')])
        self.assertEqual(data[:4], b'GSAR')
        table = runtime.read_table(data)
        self.assertEqual(len(table), 2)
        self.assertEqual(runtime.lookup(table, 'Hello there,  traveler.\n'), 'مرحبًا أيها المسافر.')
        self.assertEqual(runtime.lookup(table, 'Continue'), 'متابعة')
        hashes = [struct.unpack_from('<Q', data, runtime.ENTRIES_AT + i * 16)[0] for i in range(2)]
        self.assertEqual(hashes, sorted(hashes))
        # The length filter: the lengths English lines have (bytes of normalized UTF-8), and the shortest and longest.
        self.assertEqual(struct.unpack_from('<HHII', data, 4), (2, 1, 2, len(data[runtime.ENTRIES_AT + 32:]) // 2))
        self.assertEqual(struct.unpack_from('<HH', data, 16), (8, 22))
        bitmap = data[24:24 + 512]
        self.assertEqual([n for n in range(4096) if bitmap[n >> 3] >> (n & 7) & 1], [8, 22])

    def test_what_reads_like_text(self):
        for text in ('Where are you going, stranger?', 'The bridge is out. Find another way.', 'Continue', '"I never asked for this."',
                     'Press any key to start'):
            self.assertTrue(runtime.reads_like_text(text), text)
        for text in ('textures/ui/menu_bg.dds', 'void main() {', 'PlayerController_C', 'xqzt vbnm plkj', 'HP MP XP',
                     'Assets.Characters.Hero', 'm_fHealth = 0.0f;', 'ERROR_FILE_NOT_FOUND', 'aaaaaaaaaaaa bbbbbb',
                     'GetPlayerName(int index)', 'Options'.lower(), 'ﻣﺮﺣﺒﺎ ﺑﻚ'):
            self.assertFalse(runtime.reads_like_text(text), text)

    def test_the_scan_reads_text_in_data_files_and_leaves_compressed_ones_alone(self):
        game = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, game)
        (game / 'data').mkdir()
        filler = bytes(range(0x80, 0x100)) * 2  # not text, and the same every run
        blob = (filler + b'\x00Where are you going, stranger?\x00' + filler
                + 'The bridge is out. Find another way.'.encode('utf-16-le') + b'\x00\x00'
                + b'\x01\x02textures/ui/menu_bg.dds\x00PlayerController_C\x00' + b'Continue\x00' + filler
                + b'\x1dAThe lantern flickers once more.\x00')  # a stray length byte in front: trimmed
        (game / 'data' / 'strings.dat').write_bytes(blob)
        (game / 'data' / 'world.wad').write_bytes(os.urandom(300_000))  # compressed or encrypted: never opened up
        (game / 'data' / 'model.mesh').write_bytes(b'\x00It is not a text file at all.\x00')
        found = runtime.scan(game)
        self.assertEqual(found.strings, ['Where are you going, stranger?', 'Continue', 'The lantern flickers once more.', 'The bridge is out. Find another way.'])
        self.assertEqual(found.read, ['data/strings.dat'])
        self.assertEqual(found.skipped, [('data/world.wad', 'compressed or encrypted: left as it is')])

    def test_the_dump_of_strings_seen_in_the_game(self):
        path = Path(tempfile.mkdtemp()) / 'untranslated.txt'
        self.addCleanup(shutil.rmtree, path.parent)
        path.write_text('Open the gate\nTwo\\nlines\nOpen the gate\nback\\\\slash\nﻣﺮﺣﺒﺎ\n', encoding='utf-8')
        self.assertEqual(runtime.read_dump(path), ['Open the gate', 'Two\nlines', 'back\\slash'])
        self.assertEqual(runtime.read_dump(path.parent / 'missing.txt'), [])


# ---- The adapter's own C code, against tables the Python writes ---------------------------

HARNESS = r'''
#include "gs_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char *slurp(const char *path, size_t *size) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); *size = (size_t)ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *data = malloc(*size ? *size : 1);
    if (fread(data, 1, *size, f) != *size) { fclose(f); return NULL; }
    fclose(f);
    return data;
}

int main(int argc, char **argv) {
    (void)argc;
    size_t size = 0, qsize = 0;
    unsigned char *table = slurp(argv[1], &size), *queries = slurp(argv[2], &qsize);
    gs_dict dict;
    printf("open %d\n", gs_dict_open(&dict, table, size));
    for (size_t at = 0; at + 4 <= qsize;) {
        uint32_t units; memcpy(&units, queries + at, 4); at += 4;
        uint16_t *text = malloc(units * 2 + 2); memcpy(text, queries + at, units * 2); at += units * 2;
        char utf8[GS_MAX_UTF8]; size_t n = gs_normalize(text, units, utf8, sizeof(utf8));
        uint32_t len = 0; uint64_t hash = 0;
        const uint16_t *found = gs_lookup(&dict, text, units, &len, &hash);
        char line[GS_MAX_UTF8]; size_t dumped = gs_dump_line(text, units, line, sizeof(line));
        printf("norm ");
        for (size_t i = 0; i < n && n != (size_t)-1; i++) printf("%02x", (unsigned char)utf8[i]);
        printf(" hash %016llx text %d dump ", (unsigned long long)hash, gs_looks_like_text(text, units));
        for (size_t i = 0; i < dumped && dumped != (size_t)-1; i++) printf("%02x", (unsigned char)line[i]);
        printf(" found ");
        if (found) for (uint32_t i = 0; i < len; i++) printf("%04x", found[i]); else printf("-");
        printf("\n");
        free(text);
    }
    uint64_t slots[8] = {0};
    gs_seen seen = { slots, 8, 0 };
    int r[6];
    const uint64_t hashes[6] = { 5, 5, 6, 7, 8, 9 };
    for (int i = 0; i < 6; i++) r[i] = gs_seen_add(&seen, hashes[i]);
    printf("seen %d %d %d %d %d %d\n", r[0], r[1], r[2], r[3], r[4], r[5]);
    return 0;
}
'''


@unittest.skipUnless(CC, 'needs a C compiler')
class AdapterCore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        (cls.tmp / 'harness.c').write_text(HARNESS, encoding='utf-8')
        cls.exe = cls.tmp / 'harness'
        subprocess.run([CC, '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', f'-I{RUNTIME}', str(RUNTIME / 'gs_core.c'),
                        str(cls.tmp / 'harness.c'), '-o', str(cls.exe)], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def run_harness(self, table: bytes, queries: list):
        (self.tmp / 'table.bin').write_bytes(table)
        (self.tmp / 'queries.bin').write_bytes(b''.join(struct.pack('<I', len(q.encode('utf-16-le', 'surrogatepass')) // 2)
                                                         + q.encode('utf-16-le', 'surrogatepass') for q in queries))
        out = subprocess.run([str(self.exe), str(self.tmp / 'table.bin'), str(self.tmp / 'queries.bin')], capture_output=True, text=True, check=True)
        return out.stdout.splitlines()

    def test_the_c_lookup_finds_what_the_python_wrote(self):
        pairs = [('Where are you going, stranger?', 'إلى أين أنت ذاهب أيها الغريب؟'), ('Continue', 'متابعة'), ('Café closed 😀', 'المقهى مغلق')]
        queries = ['Where are you going, stranger?', '  Where are you going,\tstranger?\r\n', 'Continue', 'Café closed 😀', 'Not in the table', 'ﻣﺮﺣﺒﺎ', 'x']
        lines = self.run_harness(runtime.write_table(pairs), queries)
        self.assertEqual(lines[0], 'open 0')
        results = [dict(zip(line.split()[0::2], line.split()[1::2])) for line in lines[1:-1]]
        table = dict(pairs)
        for query, result in zip(queries, results):
            normalized = runtime.normalize(query)
            self.assertEqual(result['norm'], normalized.encode('utf-8').hex(), query)
            self.assertEqual(int(result['hash'], 16), runtime.fnv1a64(normalized.encode('utf-8')) if normalized else 0, query)
            expected = table.get(normalized)
            self.assertEqual(result['found'], expected.encode('utf-16-be').hex() if expected else '-', query)
        self.assertEqual([r['text'] for r in results], ['1', '1', '1', '1', '1', '0', '0'])  # Arabic and one letter aren't noted
        self.assertEqual(lines[-1], 'seen 1 0 1 1 1 -1')  # a set of eight holds four

    def test_escapes_and_broken_text(self):
        lines = self.run_harness(runtime.write_table([('a b', 'x')]), ['Two\nlines \\ here', 'lone \ud800 surrogate'])
        dump = [dict(zip(l.split()[0::2], l.split()[1::2]))['dump'] for l in lines[1:3]]
        self.assertEqual(bytes.fromhex(dump[0]).decode(), 'Two\\nlines \\\\ here')
        self.assertEqual(bytes.fromhex(dump[1]).decode(), 'lone � surrogate')

    def test_damaged_tables_are_refused(self):
        good = runtime.write_table([('One line here', 'سطر'), ('Another line', 'آخر')])
        self.assertEqual(self.run_harness(b'NOPE' + good[4:], [])[0], 'open -1')
        self.assertEqual(self.run_harness(good[:-2], [])[0], 'open -3')
        at = runtime.ENTRIES_AT
        swapped = bytearray(good)
        swapped[at:at + 16], swapped[at + 16:at + 32] = good[at + 16:at + 32], good[at:at + 16]
        self.assertEqual(self.run_harness(bytes(swapped), [])[0], 'open -4')
        too_long = bytearray(good)
        struct.pack_into('<I', too_long, at + 12, 999)
        self.assertEqual(self.run_harness(bytes(too_long), [])[0], 'open -5')


BUFFERS_HARNESS = r"""
#include "gs_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static size_t widen(const char *s, uint16_t *out) {
    size_t n = gs_utf8_to_utf16(s, strlen(s), out, 512);
    return n == (size_t)-1 ? 0 : n;
}

int main(int argc, char **argv) {
    (void)argc;
    FILE *f = fopen(argv[1], "rb");
    static unsigned char table[1 << 20];
    size_t size = fread(table, 1, sizeof(table), f);
    fclose(f);
    gs_dict dict;
    int opened = gs_dict_open(&dict, table, size);
    printf("open %d filter %d %u %u\n", opened, dict.lengths != NULL, dict.min_bytes, dict.max_bytes);
    const char *seen[] = { "Where are you going, stranger?", "  Where are you going,\tstranger?\n", "C:\\Games\\Lantern\\data\\ui.dat",
                           "Continue", "%s has joined the party.", "x" };
    for (int i = 0; i < 6; i++) {
        uint16_t w[512]; size_t n = widen(seen[i], w); uint32_t len = 0;
        const uint16_t *found = gs_find(&dict, w, n, &len);
        char out[2048]; size_t m = found ? gs_utf16_to_utf8(found, len, out, sizeof(out)) : 0;
        printf("find %d %.*s\n", found != NULL, (int)m, out);
    }
    const char *pairs[][2] = {
        { "%s has joined the party.", "\xd8\xa7\xd9\x86\xd8\xb6\xd9\x85 %s \xd8\xa5\xd9\x84\xd9\x89 \xd8\xa7\xd9\x84\xd9\x81\xd8\xb1\xd9\x8a\xd9\x82." },
        { "%s gave you %d gold", "%d gold from %s" },
        { "%-10s %5.2f%%", "%s %.1f%%" },
        { "%*d items", "%d items" },
        { "%I64d points", "%lld points" },
        { "%I64d points", "%I64d \xd9\x86\xd9\x82\xd8\xb7\xd8\xa9" },
        { "100%% done", "\xd8\xaa\xd9\x85 100%%" },
        { "%s and %s", "%s" },
        { "%ls", "%s" },
    };
    for (int i = 0; i < 9; i++) {
        uint16_t a[512], b[512]; size_t an = widen(pairs[i][0], a), bn = widen(pairs[i][1], b);
        printf("same %d\n", gs_same_specifiers(a, an, b, bn));
    }
    const char *lines[] = { "Where are you going, stranger?", "Continue", "textures/ui/menu_bg.dds", "PLAYER_NAME_KEY", "Press <b>E</b> now please",
                            "The gate opens at dawn." };
    for (int i = 0; i < 6; i++) { uint16_t w[512]; size_t n = widen(lines[i], w); printf("line %d\n", gs_looks_like_line(w, n)); }
    uint16_t w[8]; char back[16];
    size_t bad = gs_utf8_to_utf16("\xc3\x28", 2, w, 8) == (size_t)-1 ? 0 : 1;
    size_t emoji = gs_utf8_to_utf16("\xf0\x9f\x98\x80", 4, w, 8);
    size_t again = gs_utf16_to_utf8(w, 2, back, sizeof(back));
    printf("utf8 %zu %zu %zu\n", bad, emoji, again);
    printf("ms %u %u %u\n", gs_subtitle_ms(3), gs_subtitle_ms(80), gs_subtitle_ms(500));
    return 0;
}
"""


@unittest.skipUnless(CC, 'needs a C compiler')
class AdapterBuffers(unittest.TestCase):
    """What the adapter's buffer hooks decide (gs_find, gs_same_specifiers...), in its own C, on a table the Python wrote."""

    def test_buffers_formats_and_lines(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / 'h.c').write_text(BUFFERS_HARNESS, encoding='utf-8')
        subprocess.run([CC, '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', f'-I{RUNTIME}', str(RUNTIME / 'gs_core.c'), str(tmp / 'h.c'), '-o', str(tmp / 'h')], check=True)
        pairs = [('Where are you going, stranger?', 'إلى أين أنت ذاهب أيها الغريب؟'), ('Continue', 'متابعة'),
                 ('%s has joined the party.', 'انضم %s إلى الفريق.')]
        (tmp / 't.bin').write_bytes(runtime.write_table(pairs))
        out = subprocess.run([str(tmp / 'h'), str(tmp / 't.bin')], capture_output=True, text=True, check=True).stdout.splitlines()
        self.assertEqual(out[0], 'open 0 filter 1 8 30')
        self.assertEqual(out[1:7], ['find 1 إلى أين أنت ذاهب أيها الغريب؟', 'find 1 إلى أين أنت ذاهب أيها الغريب؟', 'find 0 ',
                                    'find 1 متابعة', 'find 1 انضم %s إلى الفريق.', 'find 0 '])
        # Same arguments in the same order, or no swap: reordered, dropped or other-sized arguments are refused.
        self.assertEqual([line.split()[1] for line in out[7:16]], ['1', '0', '1', '0', '0', '1', '1', '0', '0'])
        self.assertEqual([line.split()[1] for line in out[16:22]], ['1', '0', '0', '0', '0', '1'])
        self.assertEqual(out[22], 'utf8 0 2 4')
        self.assertEqual(out[23], 'ms 2500 4800 8000')

    def test_version_1_tables_still_open(self):
        data = runtime.write_table([('Continue', 'متابعة')])
        old = bytearray(data[:16] + data[runtime.ENTRIES_AT:])
        struct.pack_into('<HH', old, 4, 1, 0)
        self.assertEqual(runtime.read_table(bytes(old)), runtime.read_table(data))


def pe_exports(data: bytes) -> list:
    """The exported names of a PE file (enough of the format for the adapter's libraries)."""
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    assert data[pe:pe + 4] == b'PE\0\0'
    sections, optional_size = struct.unpack_from('<H', data, pe + 6)[0], struct.unpack_from('<H', data, pe + 20)[0]
    optional = pe + 24
    assert struct.unpack_from('<H', data, optional)[0] == 0x20B  # 64-bit
    export_rva = struct.unpack_from('<I', data, optional + 112)[0]
    table = optional + optional_size
    spans = [struct.unpack_from('<IIII', data, table + i * 40 + 8) for i in range(sections)]

    def offset(rva):
        for size, va, raw_size, raw in spans:
            if va <= rva < va + max(size, raw_size):
                return rva - va + raw
        raise ValueError(rva)
    names_count, names_rva = struct.unpack_from('<I', data, offset(export_rva) + 24)[0], struct.unpack_from('<I', data, offset(export_rva) + 32)[0]
    out = []
    for i in range(names_count):
        at = offset(struct.unpack_from('<I', data, offset(names_rva) + 4 * i)[0])
        out.append(data[at:data.index(b'\0', at)].decode())
    return out


class AdapterLibraries(unittest.TestCase):
    def test_the_prebuilt_libraries_export_what_the_real_ones_do(self):
        version = (RUNTIME / 'prebuilt' / 'version.dll').read_bytes()
        self.assertEqual(pe_exports(version), ['GetFileVersionInfoA', 'GetFileVersionInfoByHandle', 'GetFileVersionInfoExA', 'GetFileVersionInfoExW',
                                               'GetFileVersionInfoSizeA', 'GetFileVersionInfoSizeExA', 'GetFileVersionInfoSizeExW', 'GetFileVersionInfoSizeW',
                                               'GetFileVersionInfoW', 'VerFindFileA', 'VerFindFileW', 'VerInstallFileA', 'VerInstallFileW',
                                               'VerLanguageNameA', 'VerLanguageNameW', 'VerQueryValueA', 'VerQueryValueW'])
        self.assertEqual(pe_exports((RUNTIME / 'prebuilt' / 'dinput8.dll').read_bytes()),
                         ['DirectInput8Create', 'DllCanUnloadNow', 'DllGetClassObject', 'DllRegisterServer', 'DllUnregisterServer', 'GetdfDIJoystick'])
        sums = dict(line.split()[::-1] for line in (RUNTIME / 'prebuilt' / 'SHA256SUMS').read_text().splitlines())
        import hashlib
        for name in ('version.dll', 'dinput8.dll'):
            self.assertEqual(hashlib.sha256((RUNTIME / 'prebuilt' / name).read_bytes()).hexdigest(), sums[name])

    @unittest.skipUnless(MINGW, 'needs MinGW-w64')
    def test_the_prebuilt_libraries_are_built_from_these_sources(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts' / 'build-runtime-hook.py'), '--check'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class RuntimePacks(unittest.TestCase):
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

    def build(self, game, *extra):
        args = parse_args([str(game), '--engine', 'runtime', '--id', 'g-ar', '--version', '1.0.0', '--steam-app-id', '4242',
                           '--key', str(self.keys / 'pack-signing.key'), '--out', str(self.tmp / 'out'), '--provider', 'openai',
                           '--model', 'm', '--api-base', self.api.base, *extra])
        return build(args, log=lambda *_: None)

    def test_a_runtime_pack_holds_the_adapter_and_plain_arabic_for_what_the_game_draws(self):
        game = self.tmp / 'Game'
        (game / 'data').mkdir(parents=True)
        (game / 'data' / 'ui.dat').write_bytes(bytes(range(0x80, 0xC0)) + b'\x00Press any key to start\x00' + 'Where are you going, stranger?'.encode('utf-16-le') + b'\0\0')
        seen = self.tmp / 'untranslated.txt'
        seen.write_text('The forge is cold tonight\n', encoding='utf-8')
        pack = self.build(game, '--extra-lines', str(seen), '--proxy', 'dinput8.dll')
        read = node_read_pack(pack, self.keys / 'pack-signing.pub')
        self.assertEqual(read['manifest']['engine'], 'runtime')
        self.assertEqual(sorted(read['files']), ['dinput8.dll', 'gameshelf_arabic/FONT-LICENSE-OFL.txt', 'gameshelf_arabic/IBMPlexSansArabic-Regular.ttf',
                                                 'gameshelf_arabic/gameshelf_strings.bin'])
        self.assertEqual((pack / 'payload' / 'dinput8.dll').read_bytes(), (RUNTIME / 'prebuilt' / 'dinput8.dll').read_bytes())
        table = runtime.read_table((pack / 'payload' / 'gameshelf_arabic' / 'gameshelf_strings.bin').read_bytes())
        self.assertEqual(runtime.lookup(table, 'Where are you going, stranger?\n'), 'عربي Where are you going, stranger?')
        self.assertEqual(runtime.lookup(table, 'The forge is cold tonight'), 'عربي The forge is cold tonight')
        self.assertEqual(runtime.lookup(table, 'Press any key to start'), 'عربي Press any key to start')
        # Plain Arabic, in reading order: Windows shapes it and lays it out right to left.
        self.assertFalse(any(0xFB50 <= ord(c) <= 0xFEFC for text in table.values() for c in text))

    def test_a_game_with_no_readable_text_gets_the_adapter_to_learn_it(self):
        game = self.tmp / 'Sealed'
        (game / 'data').mkdir(parents=True)
        (game / 'data' / 'all.wad').write_bytes(os.urandom(200_000))
        pack = self.build(game)
        self.assertEqual(runtime.read_table((pack / 'payload' / 'gameshelf_arabic' / 'gameshelf_strings.bin').read_bytes()), {})
        self.assertTrue((pack / 'payload' / 'version.dll').is_file())

    def test_the_adapter_must_be_there(self):
        game = self.tmp / 'G'
        game.mkdir()
        with self.assertRaisesRegex(BuildError, 'runtime adapter isn\'t in'):
            self.build(game, '--runtime-hook', str(self.tmp / 'nowhere'))


if __name__ == '__main__':
    unittest.main()


class LocMetaTest(unittest.TestCase):
    """Arabic goes into the game's own list of languages, and never replaces it."""

    def test_arabic_is_added_to_the_list_and_nothing_else_changes(self):
        meta = locres_format.write_locmeta(locres_format.LocMeta('en-US', 'en-US/Game.locres', ['en-US', 'ja', 'zh-Hans']))
        added = locres_format.add_locmeta_culture(meta + b'NEWER-FIELDS', 'ar')
        self.assertTrue(added.endswith(b'NEWER-FIELDS'))  # what a newer .locmeta has after the list stays
        self.assertEqual(locres_format.read_locmeta(added).cultures, ['en-US', 'ja', 'zh-Hans', 'ar'])
        self.assertEqual(locres_format.add_locmeta_culture(added, 'ar'), added)  # once only

    def test_a_file_without_a_list_of_languages_is_left_alone(self):
        empty = locres_format.write_locmeta(locres_format.LocMeta('en-US', 'en-US/Game.locres', []))
        self.assertIsNone(locres_format.add_locmeta_culture(empty, 'ar'))
        version0 = locres_format.LOCMETA_MAGIC + b'\x00' + empty[17:]
        self.assertIsNone(locres_format.add_locmeta_culture(version0, 'ar'))
