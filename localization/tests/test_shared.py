"""The pack builder with a GameShelf server's shared translation memory (--shared):
the real server (started from Node, with a stand-in for OpenAI) translates each
line once, and a second build costs nothing."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from arabic_compiler.packbuild import BuildError, build, parse_args
from arabic_compiler.shared import game_key, line_hash
from test_build_pack import HAS_NODE, REPO

HERE = Path(__file__).resolve().parent


@unittest.skipUnless(HAS_NODE, 'the server needs Node.js')
class SharedMemoryBuilds(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.server = subprocess.Popen(['node', str(HERE / 'shared_server.js')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, cwd=REPO)
        self.addCleanup(self.stop)
        first = json.loads(self.server.stdout.readline())
        self.base, self.token = first['base'], first['token']
        self.keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(self.keys)], check=True, capture_output=True)
        self.source = self.tmp / 'lines.csv'
        self.source.write_text('source\nWe must reach the castle before nightfall.\n"<TIME 4.4, 8.44>Hey Captain.<PAGE>It\'s Jill."\n100\n', encoding='utf-8')
        self.logged = []
        os.environ['GAMESHELF_TOKEN'] = self.token
        self.addCleanup(lambda: os.environ.pop('GAMESHELF_TOKEN', None))

    def stop(self):
        if not self.server.stdin.closed:
            self.server.stdin.close()
        self.server.wait(timeout=10)
        self.server.stdout.close()

    def asked(self):
        """How many lines the stand-in OpenAI was asked for, so far."""
        self.server.stdin.close()
        out = self.server.stdout.read()
        return sum(json.loads(line)['asked'] for line in out.splitlines() if line.startswith('{"asked"'))

    def run_build(self, out, *extra):
        args = parse_args([str(self.source), '--id', 'test-ar', '--version', '1.0.0', '--steam-app-id', '1173690',
                           '--key', str(self.keys / 'pack-signing.key'), '--out', str(self.tmp / out), '--shared', self.base, *extra])
        return build(args, log=self.logged.append)

    def test_lines_are_translated_once_for_everyone(self):
        pack = self.run_build('first')
        self.assertTrue((pack / 'pack.json').exists())
        self.assertTrue(any('Shared memory had 0 of 2 lines.' in line for line in self.logged))
        # A second build (another player, another PC: no local cache) gets everything from the memory.
        self.logged.clear()
        self.run_build('second', '--no-translate')
        self.assertTrue(any('Shared memory had 2 of 2 lines.' in line for line in self.logged))
        self.assertEqual(self.asked(), 2)  # the numbers-only line was never sent
        with (self.tmp / 'second' / 'translations.csv').open(encoding='utf-8-sig') as f:
            text = f.read()
        self.assertIn('عربي <TIME 4.4, 8.44>Hey Captain.<PAGE>It\'s Jill.', text)

    def test_what_the_memory_lacks_comes_from_your_own_cache_and_your_fixes_are_kept(self):
        # An earlier run with your own key paid for one line; the shared memory has nothing yet.
        from arabic_compiler.translate import Cache, Provider, Translator
        out = self.tmp / 'mine'
        out.mkdir()
        cache = Cache(out / 'translation-cache.sqlite')
        line = 'We must reach the castle before nightfall.'
        key = Translator(Provider('openai', 'gpt-4.1-mini', None, None), cache, context='').cache_key(line)
        cache.put_many([(key, line, 'يجب أن نصل إلى القلعة قبل حلول الليل.')], 'gpt-4.1-mini')
        cache.close()
        (out / 'translations.csv').write_text('key,source,arabic,problem\n,START GAME,ابدأ اللعبة,\n', encoding='utf-8-sig')
        self.run_build('mine', '--no-translate', '--provider', 'openai', '--model', 'gpt-4.1-mini')
        self.assertEqual(self.asked(), 0)
        with (out / 'translations.csv').open(encoding='utf-8-sig') as f:
            self.assertIn('يجب أن نصل إلى القلعة', f.read())
        # The translations.csv that was there (with its fixes) is kept beside the new one.
        kept = list(out.glob('translations-*.csv'))
        self.assertEqual(len(kept), 1)
        self.assertIn('ابدأ اللعبة', kept[0].read_text(encoding='utf-8-sig'))

    def test_a_missing_or_wrong_token_says_what_to_do(self):
        os.environ.pop('GAMESHELF_TOKEN')
        with self.assertRaisesRegex(BuildError, 'Set GAMESHELF_TOKEN'):
            self.run_build('none')
        os.environ['GAMESHELF_TOKEN'] = 'gst_' + 'x' * 43
        with self.assertRaisesRegex(BuildError, 'didn\'t accept the access token'):
            self.run_build('wrong')

    def test_keys(self):
        self.assertEqual(game_key(1173690, None), 'steam:1173690')
        self.assertEqual(game_key(None, 'hades'), 'game:hades')
        # The server checks every hash against its line: both sides must hash the same way.
        line = 'START GAME — «ابدأ» <TIME 4.4, 8.44>'
        script = "process.stdout.write(require(process.argv[1]).sha256(process.argv[2]))"
        server = subprocess.run(['node', '-e', script, str(REPO / 'src/translation-memory.js'), line], capture_output=True, text=True, check=True).stdout
        self.assertEqual(line_hash(line), server)


if __name__ == '__main__':
    unittest.main()
