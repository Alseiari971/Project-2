"""Compiled Ren'Py games: .rpyc scripts (RPYC2 slots and old zlib-only files)
and .rpa archives, read without running anything from them."""

import os
import pickle
import shutil
import struct
import sys
import tempfile
import types
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from arabic_compiler import renpyc  # noqa: E402
from arabic_compiler.sources import SourceError, read_source  # noqa: E402

# ---- A stand-in for Ren'Py's own classes, so pickles name renpy.ast.* as real .rpyc files do ----

renpy_pkg = types.ModuleType('renpy')
ast_module = types.ModuleType('renpy.ast')
renpy_pkg.ast = ast_module


class _Base:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _make(name, base=_Base):
    cls = type(name, (base,), {'__module__': 'renpy.ast'})
    setattr(ast_module, name, cls)
    return cls


class PyExpr(str):
    """renpy.ast.PyExpr: a str with a file and line, pickled through __reduce__ like Ren'Py's."""

    def __new__(cls, s, filename, linenumber):
        self = str.__new__(cls, s)
        self.filename, self.linenumber = filename, linenumber
        return self

    def __reduce__(self):
        return (PyExpr, (str(self), self.filename, self.linenumber))


PyExpr.__module__ = 'renpy.ast'
PyExpr.__qualname__ = 'PyExpr'
ast_module.PyExpr = PyExpr
for _name in ('Label', 'Say', 'Menu', 'Define', 'PyCode', 'Translate', 'TranslateString', 'If', 'Init', 'Python'):
    _make(_name)


class RevertableList(list):
    pass


revertable = types.ModuleType('renpy.revertable')
RevertableList.__module__ = 'renpy.revertable'
revertable.RevertableList = RevertableList
sys.modules.update({'renpy': renpy_pkg, 'renpy.ast': ast_module, 'renpy.revertable': revertable})

A = ast_module


def statements():
    code = A.PyCode(source=PyExpr('Character("Eileen", color="#c8ffc8")', 'game/script.rpy', 1), mode='eval')
    say1 = A.Say(who='e', what='Hi there! How was class?', filename='game/script.rpy', linenumber=5)
    say2 = A.Say(who=None, what='She said "hello" and waved.', filename='game/script.rpy', linenumber=6)
    named = A.Say(who='"Narrator Bob"', what='Use {i}tags{/i} and [player].', filename='game/script.rpy', linenumber=7)
    menu = A.Menu(items=RevertableList([
        ('As soon as she catches my eye, I decide...', 'True', None),
        ('To ask her right away.', 'True', [A.Say(who='e', what='Right now?', filename='game/script.rpy', linenumber=10)]),
        ('To ask her later.', 'True', []),
    ]), filename='game/script.rpy', linenumber=8)
    screen_code = A.Python(code=A.PyCode(source=PyExpr('textbutton _("Start") action Start()\ntext __(\'Quit\')', 'game/screens.rpy', 3)))
    french = A.Translate(language='french', identifier='start_1', block=[A.Say(who=None, what='Bonjour', filename='game/tl/french/script.rpy', linenumber=2)])
    existing = A.TranslateString(language='arabic', old='Start', new='ابدأ')
    label = A.Label(name='start', block=[say1, say2, named, menu, A.Translate(language=None, identifier='start_x', block=[A.Say(who='e', what='Inside a translate block.', filename='game/script.rpy', linenumber=12)])])
    return [A.Init(block=[A.Define(varname='e', code=code, filename='game/script.rpy', linenumber=1)]), label, screen_code, french, existing]


def rpyc2(stmts, extra_slot=None):
    payload = zlib.compress(pickle.dumps(({'version': 5003000, 'key': 'unlocked'}, stmts), 2))
    slots = [(1, payload)] + ([(2, extra_slot)] if extra_slot else [])
    header = len(renpyc.RPYC2) + 12 * (len(slots) + 1)
    table, body, position = b'', b'', header
    for slot, data in slots:
        table += struct.pack('<III', slot, position, len(data))
        body += data
        position += len(data)
    return renpyc.RPYC2 + table + struct.pack('<III', 0, 0, 0) + body


def archive(path: Path, files: dict, key=0x42424242):
    index = {}
    with path.open('wb') as f:
        f.write(b'RPA-3.0 XXXXXXXXXXXXXXXX XXXXXXXX\n')
        for name, data in files.items():
            f.write(b"Made with Ren'Py.")
            offset = f.tell()
            f.write(data)
            index[name] = [(offset ^ key, len(data) ^ key, b'')]
        at = f.tell()
        f.write(zlib.compress(pickle.dumps(index, 2)))
        f.seek(0)
        f.write(b'RPA-3.0 %016x %08x\n' % (at, key))
    return path


class CompiledScripts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_dialogue_choices_speakers_and_interface_strings_come_out_in_order(self):
        found = renpyc.read_rpyc(rpyc2(statements()))
        texts = [(kind, text) for kind, text, _ in found]
        self.assertEqual([t for k, t in texts if k == 'say'], [
            'Hi there! How was class?', 'She said "hello" and waved.', 'Use {i}tags{/i} and [player].', 'Right now?', 'Inside a translate block.'])
        self.assertEqual([t for k, t in texts if k == 'menu'], [
            'As soon as she catches my eye, I decide...', 'To ask her right away.', 'To ask her later.'])
        self.assertEqual(sorted(t for k, t in texts if k == 'who'), ['Eileen', 'Narrator Bob'])
        self.assertEqual(sorted(t for k, t in texts if k == 'string'), ['Quit', 'Start'])
        # Another language's translations (tl/french) and translations already there are left out.
        self.assertNotIn('Bonjour', [t for _, t in texts])
        self.assertNotIn('ابدأ', [t for _, t in texts])
        say = next(item for item in found if item[1] == 'Hi there! How was class?')
        self.assertEqual(say[2], 'script.rpy:5')

    def test_old_compiled_scripts_are_zlib_alone(self):
        old = zlib.compress(pickle.dumps(({'version': 1}, statements()), 2))
        self.assertIn('Hi there! How was class?', [t for _, t, _ in renpyc.read_rpyc(old)])

    def test_nothing_in_a_compiled_script_runs(self):
        marker = self.tmp / 'ran'

        class Evil:
            def __reduce__(self):
                return (os.system, (f'touch {marker}',))
        stmts = [A.Say(who=None, what='Fine line.', filename='x.rpy', linenumber=1, payload=Evil())]
        found = renpyc.read_rpyc(rpyc2(stmts))
        self.assertEqual([t for _, t, _ in found], ['Fine line.'])
        self.assertFalse(marker.exists())
        # The stand-in for os.system is inert.
        loaded = renpyc.load_rpyc(rpyc2(stmts))
        self.assertEqual(loaded[0].payload.kind, 'posix.system' if os.name == 'posix' else 'nt.system')

    def test_broken_scripts_are_refused(self):
        for data in (b'RENPY RPC2' + struct.pack('<III', 1, 999, 999), b'not zlib at all', zlib.compress(b'not a pickle')):
            with self.assertRaises(renpyc.RenpyError):
                renpyc.read_rpyc(data)

    def test_archives_are_read_in_place_and_their_index_must_be_data(self):
        compiled = rpyc2(statements())
        path = archive(self.tmp / 'scripts.rpa', {'script.rpyc': compiled, 'images/bg.png': b'png'})
        before = path.read_bytes()
        self.assertEqual(renpyc.read_rpa(path, ('.rpyc',)), {'script.rpyc': compiled})
        self.assertEqual(path.read_bytes(), before)
        # An index pointing past the end is refused.
        bad = self.tmp / 'bad.rpa'
        index = zlib.compress(pickle.dumps({'a.rpyc': [(10 ** 9, 10, b'')]}, 2))
        bad.write_bytes(b'RPA-2.0 %016x\n' % 25 + index)
        with self.assertRaisesRegex(renpyc.RenpyError, 'outside'):
            renpyc.read_rpa(bad, ('.rpyc',))

    def test_a_game_shipped_compiled_is_read_from_its_archives(self):
        game = self.tmp / 'Compiled'
        (game / 'renpy').mkdir(parents=True)
        (game / 'game').mkdir()
        archive(game / 'game/scripts.rpa', {'script.rpyc': rpyc2(statements()), 'tl/french/script.rpyc': rpyc2([A.Say(who=None, what='Bonjour', filename='f', linenumber=1)])})
        (game / 'game/options.rpyc').write_bytes(rpyc2([A.Say(who=None, what='A loose compiled line.', filename='game/options.rpy', linenumber=3)]))
        source = read_source(game)
        texts = [r.source for r in source.rows]
        self.assertEqual(source.engine, 'renpy')
        self.assertIn('A loose compiled line.', texts)
        self.assertIn('Hi there! How was class?', texts)
        self.assertIn('Eileen', texts)
        self.assertNotIn('Bonjour', texts)
        self.assertTrue(any('compiled scripts' in n for n in source.notes))
        self.assertIn('scripts.rpa/script.rpyc:5', [r.key for r in source.rows])

    def test_a_script_beside_its_compiled_copy_is_read_once(self):
        game = self.tmp / 'Both'
        (game / 'renpy').mkdir(parents=True)
        (game / 'game').mkdir()
        (game / 'game/script.rpy').write_text('label start:\n    "From the script."\n', encoding='utf-8')
        (game / 'game/script.rpyc').write_bytes(rpyc2([A.Say(who=None, what='From the compiled copy.', filename='game/script.rpy', linenumber=2)]))
        self.assertEqual([r.source for r in read_source(game).rows], ['From the script.'])

    def test_unreadable_compiled_scripts_say_what_to_do(self):
        game = self.tmp / 'Broken'
        (game / 'renpy').mkdir(parents=True)
        (game / 'game').mkdir()
        (game / 'game/script.rpyc').write_bytes(b'compiled')
        with self.assertRaisesRegex(SourceError, 'unrpyc'):
            read_source(game)

    def test_string_literals_for_translation_files(self):
        self.assertEqual(renpyc.rpy_string('a "b" \\ c\nd'), '"a \\"b\\" \\\\ c\\nd"')


if __name__ == '__main__':
    unittest.main()
