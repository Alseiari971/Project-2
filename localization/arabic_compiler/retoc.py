"""Unreal Engine 5 IoStore containers (.utoc/.ucas), with retoc by trumank (MIT,
github.com/trumank/retoc), the same author's companion to repak.

UE5 games keep their cooked packages (.uasset/.uexp/.ubulk, as "Zen" packages)
in .utoc/.ucas containers, with a .pak beside each for files that aren't
packages (.locres text tables and .ufont font files usually stay there, which
repak reads). This module:

- reads a container's header itself, to tell an encrypted container from an
  open one. Encrypted ones are read only with a key an admin gave for that
  game, in its signed recipe (handed to the builder in GAMESHELF_AES_KEY, see
  aes_key below), and passed on to retoc and repak as --aes-key. GameShelf
  never looks for a key: not in the game's program, its memory or anywhere else;
- lists a container's files with `retoc list --path <utoc>` (one chunk per
  line: container, chunk ID, chunk type, path);
- takes one file out with `retoc get <utoc> <chunk ID> <file>`, for a .locres
  kept in a container rather than in its .pak;
- converts cooked replacement packages (an Arabic font face cooked for the
  game's engine version) into a container of their own with
  `retoc to-zen <folder> pakchunk99-ArabicLocalization_P.utoc --version UE5_x`,
  so the Zen loader mounts them beside the game's. to-zen writes the .utoc and
  .ucas, and an empty .pak only when there isn't one already, so the Arabic
  .pak (with the .locres and .ufont files) is packed first.

Engine versions (for to-zen) come from the "++UE5+Release-5.x" string Unreal
puts in every game's program, or from --ue-version. A game whose program hides
that string (copy protection) is matched by format instead: an empty container
is made with each UE5 version and the one laid out like the game's own
containers (the .utoc version and the container header's version) is used
(version_from_containers).
"""

from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from . import safe_exec

TOC_MAGIC = b'-==--==--==--==-'
# EIoContainerFlags
COMPRESSED, ENCRYPTED, SIGNED, INDEXED = 1, 2, 4, 8
_LIST_LINE = re.compile(r'^(?P<container>\S+)\s+(?P<id>[0-9a-fA-F]{16,32})\s+(?P<type>[A-Za-z]\w*)\s+(?P<path>\S.*?)\s*$')
_UE_RELEASE = re.compile(rb'\+\+UE(?P<major>[45])\+Release-(?P=major)\.(?P<minor>\d{1,2})')
_OUR_CONTAINER = re.compile(r'ArabicLocalization', re.I)
FONT_PACKAGE = re.compile(r'(?:^|/)(?:[^/]*fonts?[^/]*/[^/]+|[^/]*font[^/]*)\.uasset$', re.I)


class RetocError(ValueError):
    pass


@dataclass
class TocHeader:
    version: int
    entries: int
    flags: int

    @property
    def encrypted(self) -> bool:
        return bool(self.flags & ENCRYPTED)

    @property
    def indexed(self) -> bool:
        return bool(self.flags & INDEXED)


def toc_header(path: Path) -> TocHeader:
    """A .utoc's header (FIoStoreTocHeader): its version, how many chunks, and its flags."""
    with Path(path).open('rb') as f:
        head = f.read(84)
    if len(head) < 84 or head[:16] != TOC_MAGIC:
        raise RetocError(f'{Path(path).name} isn\'t an IoStore .utoc file.')
    version = head[16]
    (entries,) = struct.unpack_from('<I', head, 24)
    return TocHeader(version, entries, head[80])


AES_KEY = re.compile(r'0x[0-9A-Fa-f]{64}')


def aes_key(env=None) -> str | None:
    """The game's AES key an admin gave (GAMESHELF_AES_KEY, "0x" and 64 hex digits), or None."""
    value = (os.environ if env is None else env).get('GAMESHELF_AES_KEY', '').strip()
    if not value:
        return None
    if not AES_KEY.fullmatch(value):
        raise RetocError('The game\'s key from its recipe isn\'t "0x" and 64 hex digits.')
    return value


def key_args(env=None) -> list:
    """['--aes-key', key] for retoc and repak, when an admin gave the game's key; [] otherwise."""
    key = aes_key(env)
    return ['--aes-key', key] if key else []


def redact(text: str) -> str:
    """A tool's output, with any key in it hidden."""
    return AES_KEY.sub('0x…', text or '')


def find_tool(given: str | None = None) -> str | None:
    return given or os.environ.get('GAMESHELF_RETOC') or shutil.which('retoc')


def _run(tool: str, *args, binary=False, timeout=900, keyed=True):
    try:
        result = safe_exec.run([tool, *(key_args() if keyed else []), *args], capture_output=True, text=not binary, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise RetocError(redact(f'retoc couldn\'t run: {err}')) from None
    if not binary:
        result.stdout, result.stderr = (result.stdout or ''), redact(result.stderr)
    return result


def game_containers(folder: Path) -> list:
    """The game's own .utoc files (not GameShelf's), biggest first."""
    found = [p for p in Path(folder).rglob('*.utoc') if not _OUR_CONTAINER.search(p.name)]
    return sorted(found, key=lambda p: -p.stat().st_size)


@dataclass
class Chunk:
    container: Path
    chunk_id: str
    kind: str
    path: str  # inside the game, without the ../../../ mount prefix


def list_chunks(tool: str, utoc: Path) -> list:
    """Every file in a container's directory index, as Chunks."""
    result = _run(tool, 'list', '--path', str(utoc))
    if result.returncode != 0:
        raise RetocError(f'retoc couldn\'t list {Path(utoc).name}: {(result.stderr or result.stdout).strip()[-300:]}')
    chunks = []
    for line in result.stdout.splitlines():
        match = _LIST_LINE.match(line.strip())
        if not match or match.group('path') == '-':
            continue
        path = re.sub(r'^(?:\.\./)+', '', match.group('path').replace('\\', '/')).lstrip('/')
        chunks.append(Chunk(Path(utoc), match.group('id').lower(), match.group('type'), path))
    return chunks


def get_chunk(tool: str, chunk: Chunk, out: Path) -> bytes:
    """One chunk's data, written to `out` and returned."""
    result = _run(tool, 'get', str(chunk.container), chunk.chunk_id, str(out))
    if result.returncode != 0 or not Path(out).is_file():
        raise RetocError(f'retoc couldn\'t take {chunk.path} out of {chunk.container.name}: {(result.stderr or result.stdout).strip()[-300:]}')
    return Path(out).read_bytes()


def engine_version(program: Path | None, limit: int = 2048 * 1024 * 1024) -> str | None:
    """'UE5_4' for a game whose program says "++UE5+Release-5.4", read in chunks; None when it doesn't say."""
    if not program or not Path(program).is_file():
        return None
    overlap = b''
    read = 0
    with Path(program).open('rb') as f:
        while read < limit:
            block = f.read(8 * 1024 * 1024)
            if not block:
                break
            read += len(block)
            data = overlap + block
            match = _UE_RELEASE.search(data) or _UE_RELEASE.search(data.replace(b'\0', b''))
            if match:
                return f'UE{match.group("major").decode()}_{match.group("minor").decode()}'
            overlap = data[-64:]
    return None


# FIoContainerHeader::Signature, at the start of a container's header chunk (in its .ucas) since UE 5.1.
CONTAINER_HEADER_SIGNATURE = struct.pack('<I', 0x496F436E)
UE5_VERSIONS = [f'UE5_{minor}' for minor in range(0, 8)]


def container_format(utoc: Path) -> tuple:
    """(the .utoc's version, the container header's version or None) of a container: what changes between engine versions."""
    toc = toc_header(utoc).version
    header = None
    try:
        with Path(utoc).with_suffix('.ucas').open('rb') as f:
            head = f.read(8)
        if len(head) == 8 and head[:4] == CONTAINER_HEADER_SIGNATURE:
            (header,) = struct.unpack_from('<i', head, 4)
    except OSError:
        pass
    return toc, header


def version_from_containers(tool: str, containers: list, workdir: Path, log=print) -> str | None:
    """The UE5 version whose empty container is laid out like the game's own, or None when the game's containers
    don't agree, nothing matches, or more than one layout would fit. Only open containers are compared: an encrypted
    one's .ucas can't be read."""
    references = []
    for utoc in sorted(containers, key=lambda p: Path(p).stat().st_size)[:12]:
        try:
            if toc_header(utoc).encrypted:
                continue
            references.append(container_format(utoc))
        except (OSError, RetocError):
            continue
    tocs = {toc for toc, _ in references}
    headers = {header for _, header in references if header is not None}
    if len(tocs) != 1 or len(headers) > 1:
        return None
    want_toc, want_header = tocs.pop(), (headers.pop() if headers else None)
    empty = Path(workdir) / 'empty'
    empty.mkdir(parents=True, exist_ok=True)
    matches = []
    for version in UE5_VERSIONS:
        out = Path(workdir) / version / 'probe.utoc'
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            to_zen(tool, empty, out, version, log=lambda *_: None)
            toc, header = container_format(out)
        except (OSError, RetocError):
            continue  # a version this retoc doesn't know
        if toc == want_toc and (want_header is None or header == want_header):
            matches.append((version, header))
    if not matches or (want_header is None and len({h for _, h in matches}) > 1):
        return None
    # Versions that lay out an empty container the same way are interchangeable for it.
    chosen = matches[-1][0]
    log(f'Matched the game\'s own containers (.utoc version {want_toc}'
        + (f', container header version {want_header}' if want_header is not None else '') + f'): {chosen}.')
    return chosen


def check_version(value: str) -> str:
    if not re.fullmatch(r'UE[45]_\d{1,2}', value or ''):
        raise RetocError(f'"{value}" isn\'t an engine version retoc knows (like UE5_4).')
    return value


def font_assets(folder: Path) -> list:
    """Cooked packages in a folder of replacements (.uasset with its .uexp, and .ubulk if any), as paths inside the game."""
    root = Path(folder)
    found = []
    for asset in sorted(root.rglob('*.uasset')):
        rel = PurePosixPath(asset.relative_to(root).as_posix())
        if '..' in rel.parts or 'Content' not in rel.parts:
            raise RetocError(f'{rel} must sit at its path inside the game (<Project>/Content/...).')
        if not asset.with_suffix('.uexp').is_file():
            raise RetocError(f'{rel} has no .uexp beside it: give cooked assets (cooked for the game\'s engine version).')
        found.append(rel)
    return found


def to_zen(tool: str, legacy: Path, out_utoc: Path, version: str, log=print) -> list:
    """Converts a folder of cooked (legacy) packages into a container: returns the .utoc, .ucas and .pak paths."""
    command = [tool, 'to-zen', str(legacy), str(out_utoc), '--version', check_version(version)]
    log('Converting to an IoStore container: ' + ' '.join(command))
    result = _run(*command, timeout=1800, keyed=False)
    made = [Path(out_utoc).with_suffix(ext) for ext in ('.utoc', '.ucas', '.pak')]
    if result.returncode != 0 or not all(p.is_file() for p in made):
        raise RetocError(f'retoc to-zen failed: {(result.stderr or result.stdout).strip()[-500:]}')
    return made
