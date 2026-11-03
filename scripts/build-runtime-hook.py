#!/usr/bin/env python3
"""Builds GameShelf's native runtime adapter (localization/runtime/) for 64-bit
Windows: version.dll and dinput8.dll, the same adapter standing in for either
library. The results go to localization/runtime/prebuilt/ (kept in the
repository, so the app can be packaged without a C compiler), with their
SHA-256 in SHA256SUMS; scripts/bundle-arabic-builder.py copies them into the
app, which only ever installs a library whose hash matches the one it ships.

Needs MinGW-w64 (x86_64-w64-mingw32-gcc; on Windows, MSYS2's mingw-w64 gcc),
or clang with --target=x86_64-w64-windows-gnu:

    python scripts/build-runtime-hook.py
    python scripts/build-runtime-hook.py --check      (fails if prebuilt/ is out of date)
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SOURCES = REPO / 'localization' / 'runtime'
OUT = SOURCES / 'prebuilt'
PROXIES = {'version.dll': ('GS_PROXY_VERSION', 'version.def'), 'dinput8.dll': ('GS_PROXY_DINPUT8', 'dinput8.def')}
FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-shared', '-s', '-static-libgcc',
         '-Wl,--no-insert-timestamp', '-Wl,--build-id=none', '-Wl,--image-base=0x180000000', '-Wl,--dynamicbase',
         '-Wl,--high-entropy-va', '-Wl,--nxcompat', '-fno-ident']


def compiler() -> list:
    for name in ('x86_64-w64-mingw32-gcc', 'x86_64-w64-mingw32-clang'):
        if shutil.which(name):
            return [name]
    if sys.platform == 'win32' and shutil.which('gcc'):
        return ['gcc']
    if shutil.which('clang'):
        return ['clang', '--target=x86_64-w64-windows-gnu']
    raise SystemExit('No compiler for 64-bit Windows found: install MinGW-w64 (x86_64-w64-mingw32-gcc).')


def build(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    cc = compiler()
    hashes = {}
    for name, (define, exports) in PROXIES.items():
        target = out / name
        command = [*cc, *FLAGS, f'-D{define}', '-o', str(target),
                   str(SOURCES / 'gs_core.c'), str(SOURCES / 'gs_hook.c'), str(SOURCES / 'gs_proxy.c'), str(SOURCES / exports)]
        print(' '.join(command))
        subprocess.run(command, check=True)
        hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    return hashes


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--check', action='store_true', help='build into a temporary folder and compare with prebuilt/')
    parser.add_argument('--out', help=f'output folder (default {OUT})')
    args = parser.parse_args(argv)
    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            fresh = build(Path(tmp))
        kept = {name: hashlib.sha256((OUT / name).read_bytes()).hexdigest() for name in PROXIES if (OUT / name).is_file()}
        if kept != fresh:
            print('prebuilt/ is out of date (or was built with another compiler): run this script.')
            return 1
        print('prebuilt/ matches the sources.')
        return 0
    out = Path(args.out) if args.out else OUT
    hashes = build(out)
    (out / 'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for n, h in sorted(hashes.items())), encoding='utf-8')
    for name, digest in hashes.items():
        print(f'{digest}  {name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
