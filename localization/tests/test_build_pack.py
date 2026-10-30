"""Tests for the pack builder: .locres files, reading game text, translating
through a stand-in API, and building and signing whole packs."""

import csv
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from arabic_compiler import locres
from arabic_compiler.fingerprint import FingerprintTable
from arabic_compiler.packbuild import BuildError, build, parse_args
from arabic_compiler.sources import SourceError, looks_like_text, read_source
from arabic_compiler.translate import Cache, Provider, Translator, problem_with

REPO = Path(__file__).resolve().parents[2]
HAS_NODE = shutil.which('node') is not None


# ---- A .locres written byte by byte, separately from locres.write -------------------

def fstring(text):
    if all(ord(c) < 128 for c in text):
        raw = text.encode() + b'\0'
        return struct.pack('<i', len(raw)) + raw
    raw = text.encode('utf-16-le') + b'\0\0'
    return struct.pack('<i', -(len(raw) // 2)) + raw


KEYS = [('Greeting', 0x11111111, 0xAAAA0001, 'Hello'), ('Farewell', 0x22222222, 0xAAAA0002, 'Goodbye'), ('Again', 0x33333333, 0xAAAA0003, 'Hello')]


def handmade_v3():
    table = ['Hello', 'Goodbye']
    body = struct.pack('<I', 1) + struct.pack('<I', 0x0BADF00D) + fstring('Game') + struct.pack('<I', len(KEYS))
    for key, key_hash, source_hash, text in KEYS:
        body += struct.pack('<I', key_hash) + fstring(key) + struct.pack('<I', source_hash) + struct.pack('<i', table.index(text))
    head_size = 16 + 1 + 8 + 4
    head = locres.MAGIC + bytes([3]) + struct.pack('<q', head_size + len(body)) + struct.pack('<I', len(KEYS))
    strings = struct.pack('<i', 2) + fstring('Hello') + struct.pack('<i', 2) + fstring('Goodbye') + struct.pack('<i', 1)
    return head + body + strings


def handmade_legacy():
    body = struct.pack('<I', 1) + fstring('Game') + struct.pack('<I', len(KEYS))
    for key, _, source_hash, text in KEYS:
        body += fstring(key) + struct.pack('<I', source_hash) + fstring(text)
    return body


class LocResFiles(unittest.TestCase):
    def test_reads_the_optimized_format(self):
        parsed = locres.read(handmade_v3())
        self.assertEqual(parsed.version, 3)
        self.assertEqual(parsed.rows(), [('Game/Greeting', 'Hello'), ('Game/Farewell', 'Goodbye'), ('Game/Again', 'Hello')])
        self.assertEqual(parsed.namespaces[0].name_hash, 0x0BADF00D)
        self.assertEqual([e.source_hash for e in parsed.namespaces[0].entries], [0xAAAA0001, 0xAAAA0002, 0xAAAA0003])

    def test_reads_the_legacy_format(self):
        self.assertEqual(locres.read(handmade_legacy()).rows(), locres.read(handmade_v3()).rows())

    def test_writing_back_unchanged_gives_the_same_bytes(self):
        self.assertEqual(locres.write(locres.read(handmade_v3())), handmade_v3())
        self.assertEqual(locres.write(locres.read(handmade_legacy())), handmade_legacy())

    def test_translating_keeps_every_hash(self):
        for version in (0, 1, 2, 3):
            original = locres.read(handmade_v3())
            original.version = version
            translated = locres.read(locres.write(original.translated({'Game/Greeting': 'مرحبًا', 'Game/Again': 'مرحبًا مجددًا'})))
            self.assertEqual(translated.version, version)
            self.assertEqual(translated.rows(), [('Game/Greeting', 'مرحبًا'), ('Game/Farewell', 'Goodbye'), ('Game/Again', 'مرحبًا مجددًا')])
            entries = translated.namespaces[0].entries
            self.assertEqual([e.source_hash for e in entries], [0xAAAA0001, 0xAAAA0002, 0xAAAA0003])
            if version >= 2:
                self.assertEqual([e.key_hash for e in entries], [0x11111111, 0x22222222, 0x33333333])

    def test_damaged_files_are_refused(self):
        with self.assertRaises(locres.LocResError):
            locres.read(handmade_v3()[:40])


# ---- Reading game text --------------------------------------------------------------

class Sources(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write(self, name, content):
        path = self.tmp / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content) if isinstance(content, bytes) else path.write_text(content, encoding='utf-8')
        return path

    def test_csv_and_json(self):
        rows = read_source(self.write('a.csv', 'key,source,arabic\ng,Hello,مرحبا\nb,Bye,\n')).rows
        self.assertEqual([(r.key, r.source, r.arabic) for r in rows], [('g', 'Hello', 'مرحبا'), ('b', 'Bye', None)])
        nested = read_source(self.write('b.json', json.dumps({'menu': {'start': 'Start game', 'quit': 'Quit'}, 'n': 3}))).rows
        self.assertEqual([(r.key, r.source) for r in nested], [('menu.start', 'Start game'), ('menu.quit', 'Quit')])
        listed = read_source(self.write('c.json', json.dumps([{'source': 'Hi', 'arabic': 'أهلًا'}]))).rows
        self.assertEqual(listed[0].arabic, 'أهلًا')

    def test_xunity_text_files(self):
        source = read_source(self.write('t.txt', '// comment\nPress \\= to continue=اضغط \\= للمتابعة\nLine one\\nLine two=\n'))
        self.assertEqual([(r.source, r.arabic) for r in source.rows], [('Press = to continue', 'اضغط = للمتابعة'), ('Line one\nLine two', None)])
        self.assertEqual(source.engine, 'unity')

    def test_a_game_folder_with_loose_locres_files(self):
        self.write('MyGame/Content/Localization/Game/fr/Game.locres', handmade_legacy())
        self.write('MyGame/Content/Localization/Game/en/Game.locres', handmade_v3())
        source = read_source(self.tmp)
        self.assertEqual(source.engine, 'unreal')
        self.assertEqual(source.locres_path, 'MyGame/Content/Localization/Game/en/Game.locres')
        self.assertEqual(len(source.rows), 3)

    def test_text_packed_in_paks_is_left_for_the_engines_tools(self):
        self.write('Engine/Binaries/x.txt', 'x')
        self.write('MyGame/Content/Paks/pakchunk0.pak', b'pak')
        with self.assertRaisesRegex(SourceError, 'Extract its English Game.locres'):
            read_source(self.tmp)

    def test_unity_assets_through_unitypy(self):
        objects = [
            types.SimpleNamespace(type=types.SimpleNamespace(name='TextAsset'), path_id=1,
                                  read=lambda: types.SimpleNamespace(m_Script='Welcome back, traveler.\nui_button_ok\nassets/ui/icon.png', m_Name='Dialogue')),
            types.SimpleNamespace(type=types.SimpleNamespace(name='MonoBehaviour'), path_id=2,
                                  read_typetree=lambda: {'m_Name': 'Item', 'description': 'A sharp sword.', 'id': 'sword_01', 'lines': ['Run!', 'Continue']}),
            types.SimpleNamespace(type=types.SimpleNamespace(name='Texture2D'), path_id=3),
        ]
        fake = types.ModuleType('UnityPy')
        fake.load = lambda path: types.SimpleNamespace(objects=objects)
        sys.modules['UnityPy'] = fake
        try:
            self.write('Game_Data/resources.assets', b'unity')
            self.write('Game.exe', b'MZ')
            rows = read_source(self.tmp).rows
        finally:
            del sys.modules['UnityPy']
        self.assertEqual([r.source for r in rows], ['Welcome back, traveler.', 'A sharp sword.', 'Run!', 'Continue'])

    def test_what_counts_as_game_text(self):
        for text in ['Press any key to start', 'Continue', 'Yes!', 'You found 3 coins.']:
            self.assertTrue(looks_like_text(text), text)
        for text in ['ui_button_ok', 'Assets/Textures/a.png', 'https://example.com', 'x', '1234', 'snake_case_id', 'Some.Namespace.Class']:
            self.assertFalse(looks_like_text(text), text)


# ---- A stand-in translation API -------------------------------------------------------

class FakeApi:
    """OpenAI-style and Gemini-style endpoints that "translate" by prefixing
    Arabic, and can misbehave on request."""

    def __init__(self):
        self.requests = []
        self.drop_once = set()      # first time: lose this line's placeholders
        self.always_drop = set()    # every time
        self.rate_limit_first = False
        self.lock = threading.Lock()
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                with api.lock:
                    api.requests.append({'path': self.path, 'headers': dict(self.headers), 'body': body})
                    limited = api.rate_limit_first and len(api.requests) == 1
                if limited:
                    self.send_response(429)
                    self.send_header('Retry-After', '0')
                    self.end_headers()
                    return
                gemini = ':generateContent' in self.path
                user = body['contents'][0]['parts'][0]['text'] if gemini else body['messages'][1]['content']
                retry = not user.lstrip().startswith('[')
                items = json.loads(user[user.index('['):])
                out = []
                for item in items:
                    text = item['text']
                    arabic = 'عربي ' + text
                    if text in api.always_drop or (text in api.drop_once and not retry):
                        arabic = 'عربي ' + text.replace('{0}', '')
                    out.append({'id': item['id'], 'arabic': arabic})
                answer = json.dumps({'translations': out}, ensure_ascii=False)
                payload = {'candidates': [{'content': {'parts': [{'text': answer}]}}]} if gemini else {'choices': [{'message': {'content': answer}}]}
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.base = f'http://127.0.0.1:{self.server.server_port}/v1'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Translating(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        self.api.close()
        shutil.rmtree(self.tmp)

    def translator(self, kind='openai', **options):
        cache = Cache(self.tmp / 'cache.sqlite')
        self.addCleanup(cache.close)
        provider = Provider(kind, 'test-model', 'secret-key', self.api.base)
        return Translator(provider, cache, log=lambda *_: None, sleep=lambda *_: None, **options)

    def test_lines_go_out_in_parallel_batches(self):
        lines = [f'Line number {i}' for i in range(10)]
        done, failed = self.translator(batch_size=4, workers=3).translate(lines)
        self.assertEqual(failed, {})
        self.assertEqual(done['Line number 7'], 'عربي Line number 7')
        self.assertEqual(len(self.api.requests), 3)

    def test_a_second_run_costs_nothing(self):
        lines = ['Open the gate', 'Close the gate']
        self.translator().translate(lines)
        before = len(self.api.requests)
        again = self.translator()
        done, _ = again.translate(lines)
        self.assertEqual(len(self.api.requests), before)
        self.assertEqual(again.requests_made, 0)
        self.assertEqual(done['Close the gate'], 'عربي Close the gate')

    def test_a_lost_placeholder_is_asked_for_again(self):
        self.api.drop_once = {'Hello, {0}!'}
        done, failed = self.translator().translate(['Hello, {0}!', 'Bye'])
        self.assertEqual(failed, {})
        self.assertEqual(done['Hello, {0}!'], 'عربي Hello, {0}!')
        self.assertEqual(len(self.api.requests), 2)

    def test_a_line_that_keeps_failing_is_reported_not_kept(self):
        self.api.always_drop = {'Give {0} the key'}
        done, failed = self.translator().translate(['Give {0} the key'])
        self.assertNotIn('Give {0} the key', done)
        self.assertIn('lost {0}', failed['Give {0} the key'])
        # Not cached, so the next run tries again.
        self.api.always_drop = set()
        done, _ = self.translator().translate(['Give {0} the key'])
        self.assertIn('Give {0} the key', done)

    def test_rate_limits_are_waited_out(self):
        self.api.rate_limit_first = True
        done, failed = self.translator().translate(['Run'])
        self.assertEqual(failed, {})
        self.assertEqual(len(self.api.requests), 2)

    def test_numbers_and_symbols_need_no_request(self):
        done, _ = self.translator().translate(['100', '{0}/{1}', '...'])
        self.assertEqual(done, {'100': '100', '{0}/{1}': '{0}/{1}', '...': '...'})
        self.assertEqual(self.api.requests, [])

    def test_keys_travel_in_headers_only(self):
        self.translator('gemini').translate(['Hello there'])
        self.translator('openai').translate(['Good night'])
        gemini, openai = self.api.requests
        headers = [{k.lower(): v for k, v in r['headers'].items()} for r in (gemini, openai)]
        self.assertIn('/models/test-model:generateContent', gemini['path'])
        self.assertNotIn('secret-key', gemini['path'])
        self.assertEqual(headers[0]['x-goog-api-key'], 'secret-key')
        self.assertEqual(openai['path'], '/v1/chat/completions')
        self.assertEqual(headers[1]['authorization'], 'Bearer secret-key')
        self.assertEqual(openai['body']['response_format'], {'type': 'json_object'})

    def test_what_makes_a_translation_unusable(self):
        self.assertIsNone(problem_with('Hello {0}', 'مرحبا {0}'))
        self.assertIn('lost {0}', problem_with('Hello {0}', 'مرحبا'))
        self.assertIn('added %s', problem_with('Hello', 'مرحبا %s'))
        self.assertEqual(problem_with('Hello', 'Hello'), 'it isn\'t Arabic')
        self.assertEqual(problem_with('Hello', ''), 'it came back empty')


# ---- Whole packs ----------------------------------------------------------------------

def node_read_pack(pack_dir, public_key_file):
    script = ("require(process.argv[1]).readPack(process.argv[2], { publicKey: require('fs').readFileSync(process.argv[3], 'utf8') })"
              ".then((p) => console.log(JSON.stringify({ manifest: p.manifest, files: p.files.map((f) => f.target) })))"
              ".catch((e) => { console.error(e.message); process.exit(1); })")
    result = subprocess.run(['node', '-e', script, str(REPO / 'desktop/localization/pack.js'), str(pack_dir), str(public_key_file)],
                            capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(HAS_NODE, 'signing needs Node.js')
class Building(unittest.TestCase):
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

    def csv_source(self):
        path = self.tmp / 'lines.csv'
        with path.open('w', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['key', 'source', 'arabic'])
            writer.writerow(['a', 'We must reach the castle before nightfall.', 'يجب أن نصل إلى القلعة قبل حلول الليل.'])
            writer.writerow(['b', 'Hello, {0}! Welcome to Riverwood.', ''])
            writer.writerow(['c', 'The bridge is out.', ''])
        return path

    def test_an_overlay_pack_from_a_csv(self):
        pack = self.run_build(self.csv_source(), '--title', 'Test Game in Arabic')
        read = node_read_pack(pack, self.keys / 'k/pack-signing.pub')
        self.assertEqual(read['manifest']['engine'], 'overlay')
        self.assertEqual(read['manifest']['game'], {'steamAppId': 4242})
        self.assertEqual(read['manifest']['title'], 'Test Game in Arabic')
        self.assertEqual(read['files'], ['fingerprints.json'])
        table = FingerprintTable(json.loads((pack / 'payload/fingerprints.json').read_text(encoding='utf-8')))
        self.assertEqual(table.lookup('Hello, Arthur! Welcome to Riverwood.').arabic, 'عربي Hello, ⁨Arthur⁩! Welcome to Riverwood.')
        self.assertEqual(table.lookup('We rnust reach the castle bef0re nightfall').arabic, 'يجب أن نصل إلى القلعة قبل حلول الليل.')
        self.assertEqual(len(self.api.requests), 1)  # one batch for the two blank lines

    def test_review_then_rebuild_from_the_edited_csv_without_paying_again(self):
        out = self.run_build(self.csv_source(), '--review')
        self.assertFalse((out / 'pack').exists())
        reviewed = out / 'translations.csv'
        text = reviewed.read_text(encoding='utf-8').replace('عربي The bridge is out.', 'الجسر مدمر.')
        reviewed.write_text(text, encoding='utf-8')
        before = len(self.api.requests)
        pack = self.run_build(reviewed)
        self.assertEqual(len(self.api.requests), before)
        table = FingerprintTable(json.loads((pack / 'payload/fingerprints.json').read_text(encoding='utf-8')))
        self.assertEqual(table.lookup('The bridge is out').arabic, 'الجسر مدمر.')

    def zip_of(self, name, files):
        path = self.tmp / name
        with zipfile.ZipFile(path, 'w') as z:
            for inner, content in files.items():
                z.writestr(inner, content)
        return path

    def test_a_unity_pack(self):
        bepinex = self.zip_of('BepInEx.zip', {'winhttp.dll': 'dll', 'doorstop_config.ini': '[General]', 'changelog.txt': 'notes', 'BepInEx/core/BepInEx.dll': 'core'})
        xunity = self.zip_of('XUnity.zip', {'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll': 'plugin',
                                            'BepInEx/config/AutoTranslatorConfig.ini': '[Service]\nEndpoint=GoogleTranslate', '../evil.dll': 'no'})
        font = self.tmp / 'gameshelf_arabic_sdf'
        font.write_bytes(b'bundle')
        pack = self.run_build(self.csv_source(), '--kind', 'unity', '--bepinex', str(bepinex), '--autotranslator', str(xunity),
                              '--font-bundle', str(font), '--backend', 'mono')
        read = node_read_pack(pack, self.keys / 'k/pack-signing.pub')
        self.assertEqual(read['manifest']['fontBundle'], 'gameshelf_arabic_sdf')
        self.assertEqual(read['manifest']['requires'], {'unityBackend': 'mono'})
        self.assertEqual(sorted(read['files']), sorted([
            'winhttp.dll', 'doorstop_config.ini', 'BepInEx/core/BepInEx.dll', 'gameshelf_arabic_sdf',
            'BepInEx/plugins/XUnity.AutoTranslator/XUnity.AutoTranslator.Plugin.Core.dll',
            'BepInEx/Translation/ar/Text/_AutoGeneratedTranslations.txt']))
        dictionary = (pack / 'payload/BepInEx/Translation/ar/Text/_AutoGeneratedTranslations.txt').read_text(encoding='utf-8')
        line = next(l for l in dictionary.splitlines() if l.startswith('We must reach'))
        self.assertTrue(all(0xFE70 <= ord(ch) <= 0xFEFF for ch in line.split('=', 1)[1] if '؀' <= ch <= '﻿' and ch.isalpha()))

    def unreal_source(self):
        path = self.tmp / 'Game.locres'
        path.write_bytes(handmade_v3())
        return path

    def fake_packer(self):
        script = self.tmp / 'repak'
        script.write_text(f'#!{sys.executable}\n'
                          'import sys, json, pathlib\n'
                          'stage, out = pathlib.Path(sys.argv[-2]), pathlib.Path(sys.argv[-1])\n'
                          'out.write_bytes(b"FAKEPAK" + b"".join(p.read_bytes() for p in sorted(stage.rglob("*")) if p.is_file()))\n'
                          'pathlib.Path(sys.argv[0] + ".args").write_text(json.dumps(sys.argv[1:]))\n')
        script.chmod(0o755)
        return script

    def test_an_unreal_pack_with_plain_arabic_and_the_same_hashes(self):
        packer = self.fake_packer()
        pack = self.run_build(self.unreal_source(), '--locres-path', 'MyGame/Content/Localization/Game/en/Game.locres', '--packer-path', str(packer))
        read = node_read_pack(pack, self.keys / 'k/pack-signing.pub')
        self.assertEqual(read['manifest']['engine'], 'unreal')
        self.assertEqual(read['files'], ['pakchunk99-ArabicLocalization_P.pak'])
        args = json.loads(Path(str(packer) + '.args').read_text())
        self.assertEqual(args[:5], ['pack', '--version', 'V11', '--mount-point', '../../../'])
        staged = locres.read((self.tmp / 'out/stage/pak/MyGame/Content/Localization/Game/en/Game.locres').read_bytes())
        self.assertEqual(staged.rows(), [('Game/Greeting', 'عربي Hello'), ('Game/Farewell', 'عربي Goodbye'), ('Game/Again', 'عربي Hello')])
        self.assertEqual([e.source_hash for e in staged.namespaces[0].entries], [0xAAAA0001, 0xAAAA0002, 0xAAAA0003])
        self.assertFalse(any(0xFE70 <= ord(c) <= 0xFEFF for _, t in staged.rows() for c in t))  # Unreal shapes it itself

    def test_unreal_without_a_pak_tool_stops_after_staging(self):
        node = Path(shutil.which('node')).parent
        path = os.environ['PATH']
        os.environ['PATH'] = str(node)  # node for signing, but no pak tool
        try:
            with self.assertRaisesRegex(BuildError, 'no pak tool was found'):
                self.run_build(self.unreal_source(), '--locres-path', 'MyGame/Content/Localization/Game/en/Game.locres')
        finally:
            os.environ['PATH'] = path
        self.assertTrue((self.tmp / 'out/stage/pak/MyGame/Content/Localization/Game/en/Game.locres').exists())

    def test_a_translations_csv_open_in_excel_doesnt_stop_the_build(self):
        from unittest import mock
        out = self.run_build(self.csv_source(), '--review')
        reviewed = out / 'translations.csv'
        before = reviewed.read_bytes()
        # Windows refuses to replace a file Excel has open.
        with mock.patch('arabic_compiler.packbuild.os.replace', side_effect=PermissionError(13, 'Permission denied')):
            pack = self.run_build(self.csv_source(), '--translations', str(reviewed))
            self.assertTrue((pack / 'pack.json').exists())
            self.assertTrue(any('open in another program' in line for line in self.logged))
            self.assertEqual(reviewed.read_bytes(), before)  # left exactly as it was
            self.assertFalse(reviewed.with_name('translations.csv.tmp').exists())
            with self.assertRaisesRegex(BuildError, 'Close it and run again'):
                self.run_build(self.csv_source(), '--review')

    def test_without_a_provider_it_says_what_to_do(self):
        args = parse_args([str(self.csv_source()), '--id', 'x', '--version', '1', '--game-id', 'g', '--key', 'k', '--out', str(self.tmp / 'o')])
        with self.assertRaisesRegex(BuildError, '--provider and --model'):
            build(args, log=lambda *_: None)


if __name__ == '__main__':
    unittest.main()
