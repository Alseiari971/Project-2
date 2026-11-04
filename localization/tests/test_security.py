"""Security regression tests for the pack builder: each one tries an attack.

- Shell metacharacters in game paths, file names and AES keys never reach a
  shell (tools run from argument lists through safe_exec).
- Batch files, single-string commands and shell=True are refused.
- Recipes can't reach outside the game, put programs into it, or smuggle an
  AES key with extra characters.
- Zips can't drop files outside the pack (zip-slip), with / or \\ paths.
- The loose-file scanner doesn't follow links out of the game folder.
- No module in the compiler uses os.system, os.popen or a raw subprocess call.
"""
import io
import json
import os
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from arabic_compiler import loose, packbuild, recipes, safe_exec
from arabic_compiler.packbuild import BuildError

REPO = Path(__file__).resolve().parents[2]
COMPILER = REPO / 'localization' / 'arabic_compiler'
HOSTILE = [
    '; touch {m}', '&& touch {m}', '| touch {m}', '$(touch {m})', '`touch {m}`',
    '" & echo pwned > {m} & "', "'; touch {m}; '", '%COMSPEC% /c echo pwned > {m}', '\n touch {m}',
    'C:\\Games\\Evil & calc.exe\\game.exe', '0x' + 'A' * 64 + ' && touch {m}',
]


class SafeExecTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.marker = self.tmp / 'pwned'

    def test_shell_metacharacters_reach_the_tool_as_plain_text(self):
        args = [a.format(m=self.marker) for a in HOSTILE]
        result = safe_exec.run([sys.executable, '-c', 'import json, sys; print(json.dumps(sys.argv[1:]))', *args],
                               capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), args, 'every argument arrives exactly as given')
        self.assertFalse(self.marker.exists(), 'nothing ran a shell')

    def test_commands_that_need_a_shell_are_refused(self):
        with self.assertRaises(safe_exec.UnsafeCommand):
            safe_exec.run(f'{sys.executable} -c "print(1)"')
        with self.assertRaises(safe_exec.UnsafeCommand):
            safe_exec.run([sys.executable, '-c', 'print(1)'], shell=True)
        with self.assertRaises(safe_exec.UnsafeCommand):
            safe_exec.run([sys.executable, '-c', 'print(1)', 'a\0b'])
        with self.assertRaises(safe_exec.UnsafeCommand):
            safe_exec.run([])

    def test_batch_files_are_refused_on_windows(self):
        # cmd.exe reads &, | and %VAR% in a .bat's arguments even without a shell.
        for tool in ('C:\\tools\\repak.bat', 'C:\\tools\\retoc.CMD', 'C:\\tools\\x.bat.', 'quickbms.bat '):
            with self.assertRaises(safe_exec.UnsafeCommand, msg=tool):
                safe_exec.check_command([tool, 'unpack', 'x'], platform='win32')
        self.assertEqual(safe_exec.check_command(['C:\\tools\\repak.exe', 'a & b'], platform='win32'), ['C:\\tools\\repak.exe', 'a & b'])

    def test_no_module_uses_a_shell_or_a_raw_subprocess(self):
        for file in sorted(COMPILER.glob('*.py')):
            text = file.read_text(encoding='utf-8')
            self.assertNotRegex(text, r'\bos\.system\(|\bos\.popen\(|shell\s*=\s*True|commands\.getoutput', file.name)
            if file.name != 'safe_exec.py':
                self.assertNotRegex(text, r'subprocess\.(run|Popen|call|check_call|check_output)\(', f'{file.name} runs a tool without safe_exec')


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.registry = json.loads((REPO / 'localization/custom_engines.json').read_text(encoding='utf-8'))

    def recipe(self, **changes):
        base = {
            'format': 1, 'game': {'steamAppId': 1}, 'engine': 'custom', 'tool': 'quickbms',
            'extract': [['{tool_dir}/script.bms', '{game}/data.pak', '{extracted}']],
            'repack': [['-w', '-r', '{tool_dir}/script.bms', '{work}/data.pak', '{edited}']],
            'text': [{'glob': '**/*.json', 'format': 'json'}],
            'stage': [{'from': '{work}/data.pak', 'to': 'data/data_ar.pak'}],
        }
        base.update(changes)
        return base

    def test_traversal_and_programs_in_recipes_are_refused(self):
        for target in ('../../evil.dll', '..\\..\\evil.dll', '/abs/evil.pak', 'C:\\evil.pak', 'data/../../evil.pak', 'evil.dll', 'run.bat', 'data/x.ps1'):
            with self.assertRaises(recipes.RecipeError, msg=target):
                recipes.check_recipe(self.recipe(stage=[{'from': '{work}/x', 'to': target}]), self.registry)
        for arg in ('{extracted}/../../x', '../x', '@list.txt', '-o=/etc/passwd', 'a\nb', 'a\0b'):
            with self.assertRaises(recipes.RecipeError, msg=arg):
                recipes.check_recipe(self.recipe(extract=[[arg]]), self.registry)
        with self.assertRaises(recipes.RecipeError):
            recipes.check_recipe(self.recipe(tool='powershell'), self.registry)
        with self.assertRaises(recipes.RecipeError):
            recipes.check_recipe(self.recipe(text=[{'glob': '../**/*.json', 'format': 'json'}]), self.registry)

    def test_aes_keys_are_exactly_64_hex_digits(self):
        good = {'format': 1, 'game': {'steamAppId': 1}, 'engine': 'unreal', 'aesKey': '0x' + 'ab' * 32}
        recipes.check_recipe(good, self.registry)
        for key in ('0x' + 'A' * 64 + ' && calc', '0x' + 'A' * 64 + '\n', '0x' + 'A' * 63 + ';', '$(calc)', '0x' + 'G' * 64, ''):
            with self.assertRaises(recipes.RecipeError, msg=key):
                recipes.check_recipe({**good, 'aesKey': key}, self.registry)
        with self.assertRaises(recipes.RecipeError):
            recipes.check_recipe({**good, 'extract': [['x']]}, self.registry)

    def test_only_allowlisted_exe_tools(self):
        for tool, entry in self.registry['tools'].items():
            for exe in entry.get('exe', []):
                self.assertFalse(exe.lower().endswith(('.bat', '.cmd', '.ps1', '.vbs')), f'{tool}: {exe}')


class ZipSlipTests(unittest.TestCase):
    def test_zip_entries_cant_leave_the_pack(self):
        tmp = Path(tempfile.mkdtemp())
        payload = tmp / 'pack' / 'payload'
        payload.mkdir(parents=True)
        archive = tmp / 'BepInEx.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            for name in ('../../evil.dll', '..\\..\\evil.dll', 'BepInEx/..\\..\\..\\evil.dll', 'BepInEx/../../evil.dll',
                         '/abs/evil.dll', 'C:/evil.dll', 'BepInEx/core/C:evil.dll', 'BepInEx/core/BepInEx.dll'):
                z.writestr(name, b'MZ')
        packbuild._copy_tree(archive, payload, lambda *_: None)
        written = sorted(str(p.relative_to(tmp)).replace('\\', '/') for p in tmp.rglob('*') if p.is_file())
        self.assertEqual(written, ['BepInEx.zip', 'pack/payload/BepInEx/core/BepInEx.dll'])

    def test_a_target_through_a_link_is_refused(self):
        tmp = Path(tempfile.mkdtemp())
        outside = tmp / 'outside'
        outside.mkdir()
        payload = tmp / 'payload'
        (payload / 'BepInEx').mkdir(parents=True)
        try:
            os.symlink(outside, payload / 'BepInEx' / 'core', target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('this system can\'t make links')
        source = tmp / 'src'
        (source / 'BepInEx' / 'core').mkdir(parents=True)
        (source / 'BepInEx' / 'core' / 'x.dll').write_bytes(b'MZ')
        with self.assertRaises(BuildError):
            packbuild._copy_tree(source, payload, lambda *_: None)
        self.assertEqual(list(outside.iterdir()), [])


class ScannerTests(unittest.TestCase):
    def test_the_loose_scanner_doesnt_follow_links_out_of_the_game(self):
        tmp = Path(tempfile.mkdtemp())
        game, secret = tmp / 'game', tmp / 'secret'
        game.mkdir()
        secret.mkdir()
        (secret / 'passwords.json').write_text(json.dumps({'title': 'Do not read me, this is private text'}), encoding='utf-8')
        (game / 'text.json').write_text(json.dumps({'title': 'New game', 'subtitle': 'Press start to begin your journey'}), encoding='utf-8')
        try:
            os.symlink(secret, game / 'linked', target_is_directory=True)
            os.symlink(secret / 'passwords.json', game / 'linked.json')
        except (OSError, NotImplementedError):
            self.skipTest('this system can\'t make links')
        seen = [p.name for p in loose._walk(game)]
        self.assertEqual(seen, ['text.json'])


if __name__ == '__main__':
    unittest.main()
