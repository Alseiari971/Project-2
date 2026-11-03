#!/usr/bin/env python3
"""Gets the Arabic pack builder ready to ship inside the Windows app, in
build-tools/arabic-builder/ (electron-builder copies it into the app's
resources; see "extraResources" in package.json):

  python/       Python's embeddable package for Windows, with the builder's
                requirements (and REMSG_Converter's) installed from wheels
  localization/ the builder (arabic_compiler) and its fonts
  scripts/      build-arabic-pack.py
  remsg/        REMSG_Converter (MIT), for RE Engine message files
  tools/        repak (MIT or Apache-2.0), for Unreal games' .pak files, and retoc
                (MIT), for UE5 games' .utoc/.ucas IoStore containers; in
                tools/unity/, BepInEx (LGPL-2.1) and XUnity.AutoTranslator (MIT)
                for Unity games, Mono and IL2CPP (with UnityPy, MIT, in python/);
                in tools/quickbms/, QuickBMS (GPL-2.0, with its source), the
                tool most engine recipes run (localization/custom_engines.json);
                and in tools/runtime/, GameShelf's own native runtime adapter
                (version.dll, dinput8.dll, built from localization/runtime/)

That's what the "Request Arabic subtitles" button runs, so players never need
Python or a command prompt. Run it on any computer with Python 3 and internet:

    python scripts/bundle-arabic-builder.py            (again to refresh it)
    python scripts/bundle-arabic-builder.py --if-missing

`npm run dist` runs it with --if-missing. When run from source on Windows
(npm run app), the app uses this Python too.
"""

from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / 'build-tools' / 'arabic-builder'
PYTHON = '3.14.10'
# REMSG_Converter 2.0.1, pinned to its commit.
REMSG_COMMIT = '4289554cd0bdd8eba8c61fa0addbcbe9726a7c0f'
REMSG_URL = f'https://github.com/dtlnor/REMSG_Converter/archive/{REMSG_COMMIT}.zip'
# What REMSG_Converter needs (its requirements.txt).
REMSG_REQUIREMENTS = ['chardet>=5.2.0', 'mmh3>=4.0.1']
# Tools for more engines. Each is optional: when one can't be fetched, the app
# just can't make Arabic for that engine on players' PCs (it sends a request instead).
REPAK_URL = 'https://github.com/trumank/repak/releases/download/v0.2.3/repak_cli-x86_64-pc-windows-msvc.zip'
RETOC_URL = 'https://github.com/trumank/retoc/releases/download/v0.1.5/retoc_cli-x86_64-pc-windows-msvc.zip'
# QuickBMS by Luigi Auriemma, for engine recipes; its source goes alongside (GPL-2.0).
QUICKBMS_URL = 'https://aluigi.altervista.org/papers/quickbms.zip'
QUICKBMS_SOURCE_URL = 'https://aluigi.altervista.org/papers/quickbms_src.zip'
UNITY_TOOLS = {
    'bepinex-mono.zip': 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.6/BepInEx_win_x64_5.4.23.6.zip',
    'bepinex-il2cpp.zip': 'https://builds.bepinex.dev/projects/bepinex_be/791/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.791%2Bb782da4.zip',
    'xunity-mono.zip': 'https://github.com/bbepis/XUnity.AutoTranslator/releases/download/v5.6.3.1/XUnity.AutoTranslator-BepInEx-5.6.3.1.zip',
    'xunity-il2cpp.zip': 'https://github.com/bbepis/XUnity.AutoTranslator/releases/download/v5.6.3.1/XUnity.AutoTranslator-BepInEx-IL2CPP-5.6.3.1.zip',
}


def download(url: str) -> bytes:
    print(f'Downloading {url}')
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def requirements() -> list[str]:
    lines = (REPO / 'localization' / 'requirements.txt').read_text(encoding='utf-8').splitlines()
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith('#')] + REMSG_REQUIREMENTS


def add_python(out: Path, version: str):
    target = out / 'python'
    with zipfile.ZipFile(io.BytesIO(download(f'https://www.python.org/ftp/python/{version}/python-{version}-embed-amd64.zip'))) as archive:
        archive.extractall(target)
    # The embeddable Python only looks where its ._pth file says (not even beside the script it runs).
    short = ''.join(version.split('.')[:2])
    (target / f'python{short}._pth').write_text('\n'.join([
        f'python{short}.zip', '.', r'Lib\site-packages', r'..\localization', r'..\remsg\src', 'import site', '']), encoding='utf-8')
    site = target / 'Lib' / 'site-packages'
    site.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as wheels:
        # Windows wheels, whatever computer this runs on.
        subprocess.run([sys.executable, '-m', 'pip', 'download', '--only-binary=:all:', '--platform', 'win_amd64',
                        '--python-version', '.'.join(version.split('.')[:2]), '--dest', wheels, *requirements()], check=True)
        for wheel in sorted(Path(wheels).glob('*.whl')):
            print(f'Installing {wheel.name}')
            with zipfile.ZipFile(wheel) as archive:
                archive.extractall(site)


def add_remsg(out: Path):
    target = out / 'remsg'
    with zipfile.ZipFile(io.BytesIO(download(REMSG_URL))) as archive:
        for item in archive.infolist():
            parts = item.filename.split('/', 1)
            if len(parts) < 2 or not parts[1] or item.is_dir():
                continue
            path = target / parts[1]
            if '..' in Path(parts[1]).parts:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.read(item))
    if not (target / 'src' / 'main.py').is_file() or not (target / 'LICENSE').is_file():
        raise SystemExit('REMSG_Converter\'s download doesn\'t look as expected (no src/main.py or LICENSE).')


def pip_install(site: Path, version: str, packages: list):
    with tempfile.TemporaryDirectory() as wheels:
        subprocess.run([sys.executable, '-m', 'pip', 'download', '--only-binary=:all:', '--platform', 'win_amd64',
                        '--python-version', '.'.join(version.split('.')[:2]), '--dest', wheels, *packages], check=True)
        for wheel in sorted(Path(wheels).glob('*.whl')):
            with zipfile.ZipFile(wheel) as archive:
                archive.extractall(site)


def add_tools(out: Path, version: str):
    """repak, UnityPy, BepInEx and XUnity.AutoTranslator. Only what's missing is fetched, so running
    this again retries what failed; each one that can't be fetched is skipped with a warning."""
    tools = out / 'tools'
    tools.mkdir(parents=True, exist_ok=True)
    if not (tools / 'repak.exe').is_file():
        try:
            with zipfile.ZipFile(io.BytesIO(download(REPAK_URL))) as archive:
                exe = next(n for n in archive.namelist() if n.lower().endswith('repak.exe'))
                (tools / 'repak.exe').write_bytes(archive.read(exe))
                for name in archive.namelist():
                    if 'license' in name.lower() and not name.endswith('/'):
                        (tools / f'repak-{Path(name).name}').write_bytes(archive.read(name))
        except Exception as err:  # noqa: BLE001 (any failure just leaves Unreal out)
            print(f'WARNING: repak wasn\'t added ({err}).')
    if not (tools / 'retoc.exe').is_file():
        try:
            with zipfile.ZipFile(io.BytesIO(download(RETOC_URL))) as archive:
                exe = next(n for n in archive.namelist() if n.lower().endswith('retoc.exe'))
                (tools / 'retoc.exe').write_bytes(archive.read(exe))
                for name in archive.namelist():
                    if 'license' in name.lower() and not name.endswith('/'):
                        (tools / f'retoc-{Path(name).name}').write_bytes(archive.read(name))
        except Exception as err:  # noqa: BLE001 (UE5 containers are optional: repak reads the .pak files)
            print(f'WARNING: retoc wasn\'t added ({err}). UE5 games\' .utoc/.ucas containers won\'t be read.')
    unity = tools / 'unity'
    unity.mkdir(exist_ok=True)
    site = out / 'python' / 'Lib' / 'site-packages'
    if not (site / 'UnityPy').is_dir():
        try:
            pip_install(site, version, ['UnityPy'])
        except Exception as err:  # noqa: BLE001
            print(f'WARNING: UnityPy wasn\'t added ({err}).')
    for name, url in UNITY_TOOLS.items():
        if (unity / name).is_file():
            continue
        try:
            (unity / f'{name}.part').write_bytes(download(url))
            (unity / f'{name}.part').replace(unity / name)
        except Exception as err:  # noqa: BLE001
            (unity / f'{name}.part').unlink(missing_ok=True)
            browser_only = getattr(err, 'code', None) == 403
            print(f'WARNING: {name} wasn\'t added ({err}). '
                  + ('That server only allows downloads from a web browser: open ' if browser_only else 'Download it yourself from ')
                  + f'{url} and save it as {unity / name}.')
    # GameShelf's runtime adapter, as built from its sources (scripts/build-runtime-hook.py): the app only ever
    # installs these exact files.
    runtime = tools / 'runtime'
    shutil.rmtree(runtime, ignore_errors=True)
    shutil.copytree(REPO / 'localization' / 'runtime' / 'prebuilt', runtime)
    quickbms = tools / 'quickbms'
    quickbms.mkdir(exist_ok=True)
    if not (quickbms / 'quickbms.exe').is_file():
        try:
            with zipfile.ZipFile(io.BytesIO(download(QUICKBMS_URL))) as archive:
                names = {Path(n).name.lower(): n for n in archive.namelist() if not n.endswith('/')}
                if 'quickbms.exe' not in names:
                    raise ValueError('no quickbms.exe in the download')
                for name in ('quickbms.exe', 'quickbms_4gb_files.exe', 'quickbms.txt'):
                    if name in names:
                        (quickbms / name).write_bytes(archive.read(names[name]))
            (quickbms / 'quickbms-source.zip').write_bytes(download(QUICKBMS_SOURCE_URL))
        except Exception as err:  # noqa: BLE001 (any failure just leaves engine recipes that need it out)
            for name in ('quickbms.exe', 'quickbms_4gb_files.exe'):
                (quickbms / name).unlink(missing_ok=True)
            browser_only = getattr(err, 'code', None) == 403
            print(f'WARNING: QuickBMS wasn\'t added ({err}). '
                  + ('That server only allows downloads from a web browser: open ' if browser_only else 'Download it yourself from ')
                  + f'{QUICKBMS_URL} (and its source, {QUICKBMS_SOURCE_URL}) and put quickbms.exe in {quickbms}.')
    ready = lambda flag: 'ready' if flag else 'NOT ready (request-only)'  # noqa: E731
    print(f'Unreal games (repak): {ready((tools / "repak.exe").is_file())}')
    print(f'UE5 IoStore containers (retoc): {"ready" if (tools / "retoc.exe").is_file() else "NOT ready (the .pak files are still read)"}')
    print(f'Unity Mono games: {ready((site / "UnityPy").is_dir() and all((unity / n).is_file() for n in ("bepinex-mono.zip", "xunity-mono.zip")))}')
    print(f'Unity IL2CPP games: {ready((site / "UnityPy").is_dir() and all((unity / n).is_file() for n in ("bepinex-il2cpp.zip", "xunity-il2cpp.zip")))}')
    print('Bethesda games and games with readable text files: ready')
    print(f'Runtime adapter: {ready((runtime / "version.dll").is_file() and (runtime / "dinput8.dll").is_file())}')
    print(f'Engine recipes that use QuickBMS: {ready((quickbms / "quickbms.exe").is_file())}')


def add_builder(out: Path):
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc')
    shutil.copytree(REPO / 'localization' / 'arabic_compiler', out / 'localization' / 'arabic_compiler', ignore=ignore)
    shutil.copytree(REPO / 'localization' / 'assets' / 'fonts', out / 'localization' / 'assets' / 'fonts', ignore=ignore)
    # The engines and the only tools engine recipes may run (recipes.py reads it from here).
    shutil.copy2(REPO / 'localization' / 'custom_engines.json', out / 'localization' / 'custom_engines.json')
    (out / 'scripts').mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO / 'scripts' / 'build-arabic-pack.py', out / 'scripts' / 'build-arabic-pack.py')
    (out / 'README.txt').write_text(
        'GameShelf\'s Arabic pack builder, run by the app\'s "Request Arabic subtitles" button.\n'
        f'python/: Python {PYTHON} for Windows (Python Software Foundation License, python/LICENSE.txt), with the\n'
        '  builder\'s requirements from PyPI (each with its license in its .dist-info folder).\n'
        f'remsg/: REMSG_Converter by dtlnor, MIT License (remsg/LICENSE), commit {REMSG_COMMIT}.\n'
        'localization/assets/fonts/: IBM Plex Sans Arabic (OFL.txt), Cairo (OFL-Cairo.txt) and Noto Naskh Arabic\n'
        '  (OFL-NotoNaskhArabic.txt), all SIL Open Font License; see README.md there for what was changed.\n'
        'tools/repak.exe: repak by trumank, MIT or Apache-2.0 (github.com/trumank/repak).\n'
        'tools/retoc.exe: retoc by trumank, MIT (github.com/trumank/retoc).\n'
        'tools/runtime/: GameShelf\'s runtime adapter, built from localization/runtime/ in GameShelf\'s source.\n'
        'tools/unity/: BepInEx (LGPL-2.1, github.com/BepInEx/BepInEx) and XUnity.AutoTranslator by bbepis\n'
        '  (MIT, github.com/bbepis/XUnity.AutoTranslator), installed into Unity games when a player turns Arabic on;\n'
        '  python/Lib/site-packages/UnityPy: UnityPy by K0lb3 (MIT).\n'
        'tools/quickbms/: QuickBMS by Luigi Auriemma (GPL-2.0, aluigi.altervista.org/quickbms.htm), run only by engine\n'
        '  recipes an admin signed; its source code is tools/quickbms/quickbms-source.zip.\n', encoding='utf-8')


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--if-missing', action='store_true', help='do nothing when build-tools/arabic-builder is already there')
    parser.add_argument('--python', default=PYTHON, help=f'the Python version to bundle (default {PYTHON})')
    args = parser.parse_args(argv)
    if args.if_missing and (OUT / 'python').is_dir() and (OUT / 'remsg' / 'src' / 'main.py').is_file():
        # The builder's own code is copied fresh every time, so the app never ships an old one.
        shutil.rmtree(OUT / 'localization', ignore_errors=True)
        add_builder(OUT)
        add_tools(OUT, args.python)
        print(f'{OUT} is there; refreshed the builder\'s code.')
        return 0
    temp = OUT.with_name(OUT.name + '.new')
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True)
    try:
        add_python(temp, args.python)
        add_remsg(temp)
        add_builder(temp)
        add_tools(temp, args.python)
    except Exception:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    shutil.rmtree(OUT, ignore_errors=True)
    temp.rename(OUT)
    if sys.platform == 'win32':
        python = OUT / 'python' / 'python.exe'
        subprocess.run([str(python), '-c', 'import arabic_compiler.packbuild, mmh3, chardet; print("The bundled builder works.")'], check=True)
    print(f'Done: {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
