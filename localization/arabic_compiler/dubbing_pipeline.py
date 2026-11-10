"""An optional Arabic voice dub as its own .pak, in the game's English audio slot.

A game with several voice languages keeps each one's audio under that language's name (.../English(US)/...,
.../en-US/..., .../English/...). The dub's files take the English ones' places and nothing else: the game's Chinese
and Japanese voices stay as they are, so a player chooses in the game's own settings, text Arabic and voices English
for the dub, or voices Chinese or Japanese for the originals, without taking the dub out.

Voices are synthetic: each character is cast to a voice preset (the TTS server's own speakers, or GameShelf's
royalty-free voice bank), never cloned from the game's actors. The game's audio is only measured for each line's length.

What this does: says each line (tts_adapter.py), fits it to the original's length, and packs files, already in the
game's own audio format, at the English slot's paths into pakchunk99-ArabicDub_P.pak with repak. Turning the fitted
WAV files into a game's audio format (Wwise .wem, Unreal sound assets) is that format's own tool's work, not done here.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path, PurePosixPath

from . import safe_exec
from . import tts_adapter
from .tts_adapter import DubError, VoiceConsent

DUB_PAK_NAME = 'pakchunk99-ArabicDub_P.pak'
# What the app shows beside an Arabic dub: text Arabic, voices English, in the game's settings.
DUB_INSTRUCTION_AR = 'للدبلجة الصوتية: اختر لغة النصوص (العربية) ولغة الصوت (الإنجليزية) من إعدادات اللعبة'
DUB_INSTRUCTION_EN = 'For the Arabic dub: in the game\'s settings choose Arabic text and English voices. Chinese or Japanese voices play the originals.'
# A path part that names the English voice language.
_ENGLISH_PART = re.compile(r'^(?:English(?:\(US\)|\(UK\)| ?\(?United States\)?)?|en(?:[-_](?:US|GB))?)$', re.I)
# Path parts that name another voice language: never written to.
_OTHER_PART = re.compile(r'^(?:Chinese(?:\([^)]*\))?|Mandarin|Cantonese|Japanese|Korean|French(?:\([^)]*\))?|German|Spanish(?:\([^)]*\))?|Russian|'
                         r'zh(?:[-_][A-Za-z]{2,4})?|ja(?:[-_]JP)?|ko(?:[-_]KR)?|fr(?:[-_][A-Z]{2})?|de(?:[-_]DE)?|es(?:[-_][A-Z0-9]{2,3})?|ru(?:[-_]RU)?)$', re.I)
_AUDIO = ('.wem', '.bnk', '.pck', '.ogg', '.wav', '.uasset', '.uexp', '.ubulk', '.opus', '.bank')


def slot_of(path: str) -> str | None:
    """The English voice slot a game audio path is in ('English(US)', 'en-US', ...), or None if it's in none, or
    in another language's."""
    parts = PurePosixPath(str(path).replace('\\', '/')).parts
    if any(_OTHER_PART.match(p) for p in parts[:-1]):
        return None
    for part in parts[:-1]:
        if _ENGLISH_PART.match(part):
            return part
    return None


def english_slot_files(listing) -> list:
    """The game's English voice files, from its file list: where a dub's files can go."""
    return sorted(p for p in (str(line).strip().replace('\\', '/') for line in listing)
                  if p.lower().endswith(_AUDIO) and slot_of(p))


def stage_dub(files: dict, stage: Path) -> list:
    """Copies {path inside the game: dubbed file} under `stage`, each at its path. Every path must be in the English
    voice slot and keep the game file's type; anything else is refused before a single file is copied."""
    plan = []
    for inside, local in sorted(files.items()):
        target = PurePosixPath(str(inside).replace('\\', '/').lstrip('/'))
        if '..' in target.parts or target.is_absolute():
            raise DubError(f'"{inside}" points outside the game.')
        if not slot_of(target.as_posix()):
            raise DubError(f'"{inside}" isn\'t in the game\'s English voice slot: a dub only takes the English voices\' places, '
                           'so the original voices stay.')
        local = Path(local)
        if not local.is_file():
            raise DubError(f'{local} isn\'t there.')
        if local.suffix.lower() != target.suffix.lower() or target.suffix.lower() not in _AUDIO:
            raise DubError(f'{local.name} isn\'t a {target.suffix} file like the game\'s "{target.name}": put it in the game\'s audio format first.')
        plan.append((local, target))
    if not plan:
        raise DubError('There are no dubbed files to pack.')
    stage = Path(stage)
    shutil.rmtree(stage, ignore_errors=True)
    for local, target in plan:
        to = stage.joinpath(*target.parts)
        to.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local, to)
    return [target.as_posix() for _, target in plan]


def pack_dub(files: dict, out_dir: Path, repak: str, *, cast: dict | None = None, consents=(), pak_version: str = 'V11', mount_point: str = '../../../') -> dict:
    """pakchunk99-ArabicDub_P.pak with the dubbed files in the English voice slot, and dub.json beside it: the slot,
    the instruction for players, and whose voices they are. Returns dub.json's contents."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stage = out_dir / 'dub-stage'
    staged = stage_dub(files, stage)
    pak = out_dir / DUB_PAK_NAME
    result = safe_exec.run([repak, 'pack', '--version', pak_version, '--mount-point', mount_point, str(stage), str(pak)],
                           capture_output=True, text=True, timeout=3600)
    if result.returncode != 0 or not pak.is_file():
        raise DubError(f'repak couldn\'t pack the dub: {(result.stderr or result.stdout or "").strip()[-300:]}')
    record = {
        'pak': DUB_PAK_NAME,
        'slot': sorted({slot_of(p) for p in staged}),
        'files': len(staged),
        'instruction': {'ar': DUB_INSTRUCTION_AR, 'en': DUB_INSTRUCTION_EN},
        'cast': dict(cast or {}),
        'voices': [{'speaker': c.speaker, 'statement': c.statement} for c in consents],
    }
    (out_dir / 'dub.json').write_text(json.dumps(record, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return record


def original_durations(files: dict, ffmpeg: str | None = None) -> dict:
    """{key: length in ms} of the game's own lines, from sound files ffmpeg can read ({key: file}): the dub's lines
    are fitted to these. Only the length is taken from the game's audio; nothing of its sound is used."""
    ffmpeg = ffmpeg or tts_adapter.uelogo.ffmpeg_exe()
    if not ffmpeg:
        raise DubError('Measuring the original lines needs ffmpeg.')
    out = {}
    for key, path in files.items():
        try:
            out[key] = tts_adapter.duration_ms(ffmpeg, Path(path))
        except DubError:
            pass
    return out


def check_cast(cast: dict, lines: list) -> dict:
    """The cast, {speaker: voice preset}, checked: every preset a name like male_protagonist_deep, and every line's
    speaker cast (a line without a speaker is the narrator's, "*" in the cast, else narrator_epic)."""
    cast = dict(cast or {})
    for speaker, preset in cast.items():
        if not tts_adapter._PRESET.match(str(preset)):
            raise DubError(f'{speaker}\'s voice "{preset}" isn\'t a preset\'s name (like {tts_adapter.VOICE_ARCHETYPES[0]}).')
    cast.setdefault('*', 'narrator_epic')
    missing = sorted({str(l.get('speaker')) for l in lines if l.get('speaker') and l.get('speaker') not in cast})
    if missing:
        raise DubError('No voice is cast for: ' + ', '.join(missing[:12]) + ('...' if len(missing) > 12 else '') + '.')
    return cast


def dub_lines(lines: list, work_dir: Path, *, cast: dict | None = None, voice_bank=None, consent: VoiceConsent | None = None,
              backend: str = 'http', game_dir=None, log=print) -> list:
    """Says and fits every line: `lines` is [{key, arabic, duration_ms, speaker}] (the original line's length, and who
    says it), and `cast` maps each speaker to a synthetic voice preset ({"Soul": "male_protagonist_deep", "*":
    "narrator_epic"}), from the voice bank or the TTS server's own speakers. A line with a "reference" recording is
    cloned from it instead, which needs `consent` (one's own voice). Returns [{key, file, tempo, overrun_ms, ...}];
    a line that failed has {key, error} and the rest go on."""
    if any(l.get('reference') for l in lines):
        if not isinstance(consent, VoiceConsent):
            raise DubError('A cloned voice needs its speaker\'s name and a statement that they agreed to it (VoiceConsent).')
        consent.check()
    cast = check_cast(cast, [l for l in lines if not l.get('reference')])
    done = []
    for line in lines:
        key = str(line.get('key') or '')
        name = re.sub(r'[^\w.\-]', '_', key) or f'line-{len(done)}'
        try:
            common = {'out_path': Path(work_dir) / f'{name}.wav', 'backend': backend, 'game_dir': game_dir}
            if line.get('reference'):
                report = tts_adapter.synthesize_cloned_line(line['reference'], str(line.get('arabic') or ''), int(line['duration_ms']),
                                                            line.get('dialect') or 'MSA', consent=consent, **common)
            else:
                preset = cast.get(line.get('speaker')) or cast['*']
                report = {**tts_adapter.synthesize_preset_line(preset, str(line.get('arabic') or ''), int(line['duration_ms']),
                                                               line.get('dialect') or 'MSA', voice_bank=voice_bank, **common), 'preset': preset}
            done.append({'key': key, **report})
            if report['overrun_ms']:
                log(f'{key}: {report["overrun_ms"]} ms longer than the original even at full speed; shorten its Arabic.')
        except (DubError, KeyError, ValueError) as err:
            done.append({'key': key, 'error': str(err)})
            log(f'{key}: {err}')
    return done
