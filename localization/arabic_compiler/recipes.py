"""Engine recipes: Arabic for games whose text is packed in archives GameShelf
has no reader of its own for (God of War's .wad files, REDengine .archive,
.psarc ports and the rest of localization/custom_engines.json).

A recipe is written for one game by a GameShelf admin, signed with GameShelf's
pack key, and kept on GameShelf's server; each player's app checks the
signature before it runs one (desktop/localization/recipes.js). It says:

    {
      "format": 1,
      "game": {"steamAppId": 1593500},
      "engine": "santa-monica",                 an engine id from custom_engines.json
      "tool": "quickbms",                       a tool id from custom_engines.json
      "script": "...",                          optional: a QuickBMS script, saved as {script}
      "extract": [["-o", "{script}", "{game}/exec/wad/pc_le/r_english.wad", "{extracted}"]],
      "text": [{"glob": "**/*.json", "format": "json"}],
      "copy": [{"from": "{game}/exec/wad/pc_le/r_english.wad", "to": "{work}/repack/r_english.wad"}],
      "repack": [["-o", "-w", "-r", "{script}", "{work}/repack/r_english.wad", "{edited}"]],
      "stage": [{"from": "{work}/repack/r_english.wad", "to": "exec/wad/pc_le/r_english.wad"}],
      "shape": true, "maxLine": 55
    }

1. `extract`: each step runs the tool with those arguments, to take the game's
   text files out into {extracted}.
2. `text`: which of those files hold the English (paths under {extracted}),
   read with the loose-file readers (loose.py: json, csv, tsv, xml, po, mo,
   lines) or as Bethesda string tables (bethesda-strings).
3. The same files with the Arabic in them go to {edited}, at the same paths.
4. `copy` and `repack`: copies of the game's archives are made in {work} and
   the tool puts the edited files into them. The game's own files are never
   written to.
5. `stage`: which of the results go into the game, and where. GameShelf keeps
   the files they replace and puts them back when Arabic is turned off.

What a recipe can't do: run any program but the allowlisted tools (found in
GameShelf's own tools folder, never at a path a recipe gives), go through a
shell, name paths outside the game's folder and the work folder, or write into
the game's folder itself (`{game}` is for reading, in `extract` and `copy`).
Recipes never hold encryption keys, and GameShelf never looks for any.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath

from . import bethesda, loose
from . import safe_exec

REPO = Path(__file__).resolve().parents[2]
REGISTRY = Path(os.environ.get('GAMESHELF_ENGINES') or REPO / 'localization' / 'custom_engines.json')
DEFAULT_TOOLS = REPO / 'build-tools' / 'arabic-builder' / 'tools'
PLACEHOLDER = re.compile(r'\{(game|work|script|extracted|edited|out|font_bold|font)\}')
# The Arabic font GameShelf brings (IBM Plex Sans Arabic, or --font): a recipe can put it in place of the game's.
FONT_PLACES = {'font', 'font_bold'}
# Where each part of a recipe may point.
ALLOWED = {
    'extract': {'game', 'work', 'script', 'extracted', 'out'},
    'repack': {'work', 'script', 'extracted', 'edited', 'out', 'font', 'font_bold'},
    'copy.from': {'game', 'work', 'extracted', 'edited', 'out', 'font', 'font_bold'},
    'copy.to': {'work', 'out'},
    'stage.from': {'work', 'extracted', 'edited', 'out', 'font', 'font_bold'},
}
TEXT_FORMATS = set(loose.FORMATS) | {'bethesda-strings'}
EXECUTABLE = re.compile(r'\.(exe|dll|bat|cmd|ps1|vbs|js|jse|wsf|msi|scr|com|lnk|sys|so|dylib|jar|py|sh)$', re.I)
MAX_RECIPE_BYTES = 256 * 1024
MAX_STEPS = 16
MAX_ARGS = 64
STEP_TIMEOUT = 2 * 60 * 60
SECRET_ENV = re.compile(r'token|secret|password|passwd|session|cookie|api_?key|credential', re.I)


class RecipeError(ValueError):
    pass


def load_registry(path: Path | None = None) -> dict:
    data = json.loads(Path(path or REGISTRY).read_text(encoding='utf-8'))
    if data.get('format') != 1 or not isinstance(data.get('tools'), dict) or not isinstance(data.get('recipes'), list):
        raise RecipeError('custom_engines.json isn\'t in a format GameShelf knows.')
    return data


def _safe_relative(value: str, what: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or len(value) > 260 or value.startswith(('/', '\\')) or re.match(r'^[a-z]:', value, re.I):
        raise RecipeError(f'{what} "{value}" must be a path inside the game\'s folder.')
    parts = re.split(r'[\\/]', value)
    if any(not p or p in ('.', '..') or re.search(r'[:*?"<>|\x00-\x1f]', p) or p.endswith((' ', '.')) for p in parts):
        raise RecipeError(f'{what} "{value}" isn\'t a plain path.')
    return PurePosixPath(*parts)


def _check_arg(arg, phase: str):
    if not isinstance(arg, str) or len(arg) > 1024 or '\x00' in arg or '\n' in arg:
        raise RecipeError('A recipe step has an argument that isn\'t a short line of text.')
    used = PLACEHOLDER.findall(arg)
    if used:
        if len(used) > 1 or not arg.startswith('{'):
            raise RecipeError(f'"{arg}": a path starts with one placeholder.')
        if used[0] not in ALLOWED[phase]:
            raise RecipeError(f'"{arg}": {{{used[0]}}} can\'t be used in {phase.split(".")[0]}.')
        rest = PLACEHOLDER.sub('', arg, count=1)
        if rest and used[0] in FONT_PLACES:
            raise RecipeError(f'"{arg}": {{{used[0]}}} is a file, with nothing after it.')
        if rest and not rest.startswith(('/', '\\')):
            raise RecipeError(f'"{arg}": a path goes on from its placeholder with a slash.')
        if rest:
            _safe_relative(rest.lstrip('/\\'), 'A path')
    elif re.search(r'[\\/:]|\.\.|^[@<>|&]|\{', arg):
        raise RecipeError(f'"{arg}": paths in recipes start with a placeholder ({{game}}, {{work}}...).')


def check_recipe(recipe: dict, registry: dict) -> dict:
    """Checks a recipe's shape and every path and argument in it. Returns it."""
    if not isinstance(recipe, dict) or recipe.get('format') != 1:
        raise RecipeError('That isn\'t a GameShelf engine recipe (format 1).')
    if len(json.dumps(recipe)) > MAX_RECIPE_BYTES:
        raise RecipeError('The recipe is too big.')
    game = recipe.get('game')
    if not isinstance(game, dict) or not (isinstance(game.get('steamAppId'), int) or isinstance(game.get('gameId'), str)):
        raise RecipeError('The recipe must say which game it\'s for (steamAppId or gameId).')
    if not isinstance(recipe.get('engine'), str) or not re.fullmatch(r'[\w\-]{1,60}', recipe['engine']):
        raise RecipeError('The recipe must name its engine.')
    if recipe['engine'] == 'unreal':
        # An Unreal game's key recipe: only the AES key an admin gave (GameShelf never looks for one).
        extra = sorted(set(recipe) - {'format', 'game', 'engine', 'aesKey', 'note'})
        if extra:
            raise RecipeError(f'An Unreal key recipe holds only the game\'s key ("aesKey"), not {", ".join(extra)}.')
        if not isinstance(recipe.get('aesKey'), str) or not re.fullmatch(r'0x[0-9A-Fa-f]{64}', recipe['aesKey']):
            raise RecipeError('"aesKey" must be "0x" and 64 hex digits.')
        return recipe
    tool = recipe.get('tool')
    needs_tool = bool(recipe.get('extract') or recipe.get('repack'))
    if needs_tool and tool not in registry['tools']:
        raise RecipeError(f'The recipe\'s tool "{tool}" isn\'t one GameShelf allows ({", ".join(sorted(registry["tools"]))}).')
    if recipe.get('script') is not None and (not isinstance(recipe['script'], str) or len(recipe['script']) > 200_000):
        raise RecipeError('The recipe\'s script must be text.')
    for phase in ('extract', 'repack'):
        steps = recipe.get(phase, [])
        if not isinstance(steps, list) or len(steps) > MAX_STEPS:
            raise RecipeError(f'"{phase}" must be a list of up to {MAX_STEPS} steps.')
        for step in steps:
            if not isinstance(step, list) or not step or len(step) > MAX_ARGS:
                raise RecipeError(f'Each {phase} step is a list of the tool\'s arguments.')
            for arg in step:
                _check_arg(arg, phase)
    text = recipe.get('text')
    if not isinstance(text, list) or not text or len(text) > 64:
        raise RecipeError('The recipe must say which files hold the text ("text").')
    for item in text:
        if not isinstance(item, dict) or item.get('format') not in TEXT_FORMATS or not isinstance(item.get('glob'), str):
            raise RecipeError(f'Each "text" entry has a glob and a format ({", ".join(sorted(TEXT_FORMATS))}).')
        if '..' in item['glob'] or item['glob'].startswith(('/', '\\')) or ':' in item['glob']:
            raise RecipeError(f'"{item["glob"]}" must stay inside the extracted files.')
    if not isinstance(recipe.get('copy', []), list):
        raise RecipeError('"copy" must be a list.')
    for item in recipe.get('copy', []):
        if not isinstance(item, dict):
            raise RecipeError('Each "copy" entry has "from" and "to".')
        _check_arg(item.get('from'), 'copy.from')
        _check_arg(item.get('to'), 'copy.to')
        if not PLACEHOLDER.match(str(item['from'])) or not PLACEHOLDER.match(str(item['to'])):
            raise RecipeError('"copy" paths start with a placeholder.')
    stage = recipe.get('stage')
    if not isinstance(stage, list) or not stage or len(stage) > 64:
        raise RecipeError('The recipe must say what goes into the game ("stage").')
    for item in stage:
        if not isinstance(item, dict):
            raise RecipeError('Each "stage" entry has "from" and "to".')
        _check_arg(item.get('from'), 'stage.from')
        if not PLACEHOLDER.match(str(item['from'])):
            raise RecipeError('"stage" sources start with a placeholder.')
        target = _safe_relative(item.get('to'), 'A stage target')
        if EXECUTABLE.search(target.name):
            raise RecipeError(f'"{target}": recipes can\'t put programs or scripts into a game.')
    if recipe.get('maxLine') is not None and not (isinstance(recipe['maxLine'], int) and 8 <= recipe['maxLine'] <= 10000):
        raise RecipeError('maxLine must be a number from 8 to 10000.')
    return recipe


def find_tool(tool: str, registry: dict, tools_dir: Path | None = None) -> Path:
    """The allowlisted tool's program, from GameShelf's tools folder."""
    entry = registry['tools'][tool]
    folders = [Path(tools_dir or os.environ.get('GAMESHELF_TOOLS') or DEFAULT_TOOLS)]
    for folder in folders:
        for name in entry.get('exe', []):
            for path in (folder / tool / name, folder / name):
                if path.is_file():
                    return path.resolve()
    raise RecipeError(f'{entry.get("name", tool)} isn\'t installed in GameShelf\'s tools folder: put '
                      f'{entry.get("exe", [tool])[0]} in {folders[0] / tool} (from {entry.get("home", "its website")}).')


def _inside(root: Path, path: Path) -> bool:
    root, path = os.path.normcase(os.path.realpath(root)), os.path.normcase(os.path.realpath(path))
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


class RecipeRun:
    """One build with a recipe: work folders, the tool, and what it made."""

    def __init__(self, recipe: dict, game: Path, work: Path, registry: dict | None = None, tools_dir: Path | None = None,
                 fonts: tuple = (None, None), log=print):
        self.registry = registry or load_registry()
        self.recipe = check_recipe(recipe, self.registry)
        self.game = Path(game).resolve()
        self.work = Path(work).resolve()
        self.log = log
        if _inside(self.game, self.work) or _inside(self.work, self.game):
            raise RecipeError('The work folder can\'t be inside the game\'s folder.')
        shutil.rmtree(self.work, ignore_errors=True)
        self.places = {name: self.work / name for name in ('extracted', 'edited', 'out')}
        self.places.update(game=self.game, work=self.work, script=self.work / 'recipe-script.txt')
        self.fonts = {'font': fonts[0], 'font_bold': fonts[1] or fonts[0]}
        for name in ('extracted', 'edited', 'out'):
            self.places[name].mkdir(parents=True, exist_ok=True)
        self.tool = find_tool(recipe['tool'], self.registry, tools_dir) if recipe.get('extract') or recipe.get('repack') else None
        if recipe.get('script') is not None:
            self.places['script'].write_text(recipe['script'], encoding='utf-8')
        self.files = []

    def path(self, arg: str, phase: str) -> str:
        """An argument with its placeholder filled in, checked to stay where that placeholder points."""
        match = PLACEHOLDER.match(arg)
        if not match:
            return arg
        if match.group(1) in FONT_PLACES:
            font = self.fonts[match.group(1)]
            if not font:
                raise RecipeError(f'{arg}: no Arabic font was given.')
            return str(Path(font).resolve())
        base = self.places[match.group(1)]
        rest = arg[match.end():].lstrip('/\\')
        full = base.joinpath(*re.split(r'[\\/]', rest)) if rest else base
        root = self.game if match.group(1) == 'game' else self.work
        if not _inside(root, full):
            raise RecipeError(f'"{arg}" leads outside {"the game" if root == self.game else "the work folder"}.')
        return str(full)

    def _run(self, phase: str):
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GAMESHELF_') and not SECRET_ENV.search(k)}
        for number, step in enumerate(self.recipe.get(phase, []), start=1):
            args = [self.path(arg, phase) for arg in step]
            self.log(f'Recipe {phase} step {number}: {self.tool.name} {" ".join(args)}')
            try:
                result = safe_exec.run([str(self.tool), *args], cwd=self.work, env=env, stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True, errors='replace', timeout=STEP_TIMEOUT, shell=False)
            except (OSError, subprocess.TimeoutExpired) as err:
                raise RecipeError(f'{self.tool.name} couldn\'t run: {err}') from None
            if result.returncode != 0:
                tail = (result.stderr or result.stdout).strip()[-400:]
                raise RecipeError(f'{self.tool.name} failed in {phase} step {number}: {tail or f"exit code {result.returncode}"}')

    def extract(self) -> list:
        """Runs the extract steps and reads the English from the files `text` names."""
        self._run('extract')
        extracted = self.places['extracted']
        files, seen = [], set()
        for item in self.recipe['text']:
            for path in sorted(extracted.glob(item['glob'])):
                if path in seen or not path.is_file() or path.is_symlink() or not _inside(extracted, path):
                    continue
                seen.add(path)
                rel = path.relative_to(extracted).as_posix()
                found = table_file(path, rel) if item['format'] == 'bethesda-strings' else loose.read_file(path, rel, item['format'])
                if found and found.entries:
                    files.append(found)
        if not files:
            raise RecipeError('The recipe found no English text in the extracted files.')
        self.log(f'Recipe: read {sum(len(f.entries) for f in files)} lines from {len(files)} files.')
        self.files = files
        return files

    def write(self, arabic_by_file: dict) -> int:
        """Writes each text file with its Arabic ({rel: {key: Arabic}}) to {edited}. Returns how many files."""
        count = 0
        for found in self.files:
            arabic = arabic_by_file.get(found.rel)
            if not arabic:
                continue
            target = self.places['edited'].joinpath(*found.rel.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(found.write(arabic))
            count += 1
        return count

    def repack(self) -> list:
        """Makes the copies, runs the repack steps, and returns [(file made, where it goes in the game)]."""
        for item in self.recipe.get('copy', []):
            source, target = Path(self.path(item['from'], 'copy.from')), Path(self.path(item['to'], 'copy.to'))
            if not source.is_file():
                raise RecipeError(f'"{item["from"]}" isn\'t there to copy.')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        self._run('repack')
        outputs = []
        for item in self.recipe['stage']:
            made = Path(self.path(item['from'], 'stage.from'))
            if not made.is_file():
                raise RecipeError(f'The recipe made no "{item["from"]}".')
            outputs.append((made, str(_safe_relative(item['to'], 'A stage target'))))
        return outputs


def table_file(path: Path, rel: str) -> loose.TextFile | None:
    """A Bethesda string table as a loose.TextFile, for recipes."""
    kind = bethesda.table_kind(path.name)
    entries = bethesda.read_table(path.read_bytes(), kind)

    def writer(arabic):
        return bethesda.write_table([(i, arabic.get(str(i), text)) for i, text in entries], kind)
    return loose.TextFile(path, rel, 'bethesda-strings', [(str(i), t) for i, t in entries if loose.looks_like_text(t)], writer)


def read_recipe(path: Path) -> dict:
    data = Path(path).read_bytes()
    if len(data) > MAX_RECIPE_BYTES:
        raise RecipeError('The recipe is too big.')
    try:
        recipe = json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        raise RecipeError(f'{Path(path).name} isn\'t JSON.') from None
    # A signed recipe as the app saves it: {"recipe": "<the JSON that was signed>", "signature": "..."}.
    if isinstance(recipe, dict) and isinstance(recipe.get('recipe'), str):
        recipe = json.loads(recipe['recipe'])
    return recipe
