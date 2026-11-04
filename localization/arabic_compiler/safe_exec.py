"""Running the external tools packs need (repak, retoc, QuickBMS, REMSG, the
pack signer), one way only: an argument list, never a shell.

- The command must be a list (or tuple) of strings. A single string, which
  would need a shell to split, is refused, and so is ``shell=``.
- No argument may hold a NUL byte (it would cut the argument short).
- On Windows, a .bat or .cmd tool is refused: Windows runs those through
  cmd.exe, which reads ``&``, ``|`` and ``%VAR%`` in the arguments even when
  no shell was asked for, so a game path or AES key could run commands.

Game paths, file names and keys are therefore passed through exactly as
they are, whatever characters they hold.
"""
from __future__ import annotations

import os
import subprocess
import sys

BATCH_SUFFIXES = ('.bat', '.cmd')


class UnsafeCommand(ValueError):
    """A command that would go through a shell."""


def check_command(command, *, platform: str = sys.platform) -> list[str]:
    if isinstance(command, (str, bytes)) or not isinstance(command, (list, tuple)) or not command:
        raise UnsafeCommand('Commands are argument lists, never a single string for a shell.')
    args = [os.fspath(a) if not isinstance(a, str) else a for a in command]
    if not all(isinstance(a, str) for a in args):
        raise UnsafeCommand('Every argument must be text.')
    if any('\0' in a for a in args):
        raise UnsafeCommand('An argument holds a NUL byte.')
    if platform.startswith('win') and args[0].lower().rstrip(' .').endswith(BATCH_SUFFIXES):
        raise UnsafeCommand(f'{os.path.basename(args[0])} is a batch file; Windows would run it through cmd.exe. Use the tool\'s .exe.')
    return args


def run(command, **kwargs) -> subprocess.CompletedProcess:
    """``subprocess.run`` without a shell, after ``check_command``."""
    if kwargs.pop('shell', False):
        raise UnsafeCommand('GameShelf never runs tools through a shell.')
    return subprocess.run(check_command(command), shell=False, **kwargs)
