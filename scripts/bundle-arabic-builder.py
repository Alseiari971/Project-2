#!/usr/bin/env python3
"""Gets the Arabic pack builder ready to ship inside the Windows app, in
build-tools/arabic-builder/ (electron-builder copies it into the app's
resources; see "extraResources" in package.json):

  python/       Python's embeddable package for Windows, with the builder's
                requirements (and REMSG_Converter's) installed from wheels
  localization/ the builder (arabic_compiler) and its fonts
  scripts/      build-arabic-pack.py
  remsg/        REMSG_Converter (MIT), for RE Engine message files

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


def add_builder(out: Path):
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc')
    shutil.copytree(REPO / 'localization' / 'arabic_compiler', out / 'localization' / 'arabic_compiler', ignore=ignore)
    shutil.copytree(REPO / 'localization' / 'assets' / 'fonts', out / 'localization' / 'assets' / 'fonts', ignore=ignore)
    (out / 'scripts').mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO / 'scripts' / 'build-arabic-pack.py', out / 'scripts' / 'build-arabic-pack.py')
    (out / 'README.txt').write_text(
        'GameShelf\'s Arabic pack builder, run by the app\'s "Request Arabic subtitles" button.\n'
        f'python/: Python {PYTHON} for Windows (Python Software Foundation License, python/LICENSE.txt), with the\n'
        '  builder\'s requirements from PyPI (each with its license in its .dist-info folder).\n'
        f'remsg/: REMSG_Converter by dtlnor, MIT License (remsg/LICENSE), commit {REMSG_COMMIT}.\n'
        'localization/assets/fonts/: IBM Plex Sans Arabic, SIL Open Font License (OFL.txt).\n', encoding='utf-8')


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--if-missing', action='store_true', help='do nothing when build-tools/arabic-builder is already there')
    parser.add_argument('--python', default=PYTHON, help=f'the Python version to bundle (default {PYTHON})')
    args = parser.parse_args(argv)
    if args.if_missing and (OUT / 'python').is_dir() and (OUT / 'remsg' / 'src' / 'main.py').is_file():
        # The builder's own code is copied fresh every time, so the app never ships an old one.
        shutil.rmtree(OUT / 'localization', ignore_errors=True)
        add_builder(OUT)
        print(f'{OUT} is there; refreshed the builder\'s code.')
        return 0
    temp = OUT.with_name(OUT.name + '.new')
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True)
    try:
        add_python(temp, args.python)
        add_remsg(temp)
        add_builder(temp)
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
