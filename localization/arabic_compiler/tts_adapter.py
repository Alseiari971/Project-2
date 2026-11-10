"""Arabic speech for a dub line, from a text-to-speech program on this PC, fitted to the original line's length.

Two ways to make the speech, neither of them code inside GameShelf:
- a local TTS server over HTTP (VoiceStudio's API on http://127.0.0.1:3900 by default; only this PC's own address is
  ever called), or
- the f5-tts command line (f5-tts_infer-cli, with an Arabic model), run through safe_exec.

Whose voice: by default nobody's. A dub's characters are cast to synthetic voice presets (VOICE_ARCHETYPES:
male_protagonist_deep, female_warrior_calm, narrator_epic, ...): a speaker the TTS server has built in under that
name, or a recording of that name in GameShelf's own royalty-free voice bank (a folder of <preset>.wav with a
voices.json saying where each came from and its licence). The game's audio is only measured, for each line's length.

Cloning is still there for a voice of one's own: a cloned voice is a person's voice. The reference recording must be one the admin has the right to use
(their own voice, or a voice actor's with their consent), said so in a VoiceConsent that goes into the dub pack's
record. A reference taken from the game's own files (its actors' performances) is refused.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

from . import safe_exec
from . import uelogo

DEFAULT_TTS_URL = 'http://127.0.0.1:3900'
SPEAK_PATH = '/api/v1/tts'
# The synthetic voices a dub's characters are cast to. A TTS server's built-in speakers, or the voice bank's recordings, go by these names.
VOICE_ARCHETYPES = ('male_protagonist_deep', 'male_young_bold', 'male_elder_wise', 'male_villain_cold', 'female_warrior_calm',
                    'female_young_bright', 'female_elder_stern', 'narrator_epic', 'child_curious', 'crowd_neutral')
_PRESET = re.compile(r'^[a-z][a-z0-9_]{1,40}$')
CLONE_PATH = '/api/v1/tts/clone'
MIN_TEMPO, MAX_TEMPO = 0.85, 1.30
_LOOPBACK = {'127.0.0.1', 'localhost', '::1'}


class DubError(RuntimeError):
    pass


@dataclass(frozen=True)
class VoiceConsent:
    """Who the reference voice is, and that they agreed to it being cloned for this dub."""
    speaker: str
    statement: str

    def check(self):
        if len(self.speaker.strip()) < 2 or len(self.statement.strip()) < 10:
            raise DubError('A cloned voice needs its speaker\'s name and a statement that they agreed to it (VoiceConsent).')


def check_reference(ref_wav_path, consent, game_dir=None) -> Path:
    """The reference recording, if it may be cloned: there, with consent, and not one of the game's own files."""
    if not isinstance(consent, VoiceConsent):
        raise DubError('A cloned voice needs its speaker\'s name and a statement that they agreed to it (VoiceConsent).')
    consent.check()
    ref = Path(ref_wav_path).resolve()
    if not ref.is_file():
        raise DubError(f'{ref} isn\'t there.')
    if game_dir and Path(game_dir).resolve() in ref.parents:
        raise DubError('The reference voice is a file from the game: its actors\' voices aren\'t cloned. Use a recording you have the right to use.')
    return ref


def tts_url() -> str:
    """The local TTS server's address (GAMESHELF_TTS_URL, default 127.0.0.1:3900): this PC only."""
    url = os.environ.get('GAMESHELF_TTS_URL') or DEFAULT_TTS_URL
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'http' or parsed.hostname not in _LOOPBACK:
        raise DubError('The TTS server must be on this PC (http://127.0.0.1:<port>): recordings and lines aren\'t sent anywhere else.')
    return url.rstrip('/')


def _multipart(fields: dict, files: dict) -> tuple:
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode() + str(value).encode('utf-8') + b'\r\n')
    for name, (filename, data) in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                     f'Content-Type: audio/wav\r\n\r\n'.encode() + data + b'\r\n')
    return b''.join(parts) + f'--{boundary}--\r\n'.encode(), f'multipart/form-data; boundary={boundary}'


def _clone_http(ref: Path, arabic_text: str, dialect: str, out: Path):
    body, content_type = _multipart({'text': arabic_text, 'language': 'ar', 'dialect': dialect}, {'reference_audio': (ref.name, ref.read_bytes())})
    request = urllib.request.Request(tts_url() + CLONE_PATH, data=body, method='POST', headers={
        'Content-Type': content_type, 'Authorization': f'Bearer {os.environ.get("OMNIVOICE_API_KEY", "")}'})
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            audio = response.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        raise DubError(f'The local TTS server didn\'t answer: {err}') from None
    if audio[:4] != b'RIFF':
        raise DubError('The local TTS server didn\'t answer with a WAV file.')
    out.write_bytes(audio)


def _clone_f5(ref: Path, arabic_text: str, out: Path):
    result = safe_exec.run(['f5-tts_infer-cli', '--model', os.environ.get('GAMESHELF_F5_MODEL', 'Habibi-TTS-Arabic'), '--ref_audio', str(ref),
                            '--gen_text', arabic_text, '--output_file', str(out)], capture_output=True, text=True, timeout=1800)
    if result.returncode != 0 or not out.is_file():
        raise DubError(f'f5-tts couldn\'t make the line: {(result.stderr or result.stdout or "").strip()[-300:]}')


def bank_voice(voice_bank, preset: str, game_dir=None) -> Path | None:
    """The voice bank's recording for a preset, if it has one: <bank>/<preset>.wav, listed in <bank>/voices.json with
    its source and licence ({"<preset>": {"source": ..., "license": ...}}). A bank inside the game's folder, or a
    recording the bank doesn't account for, is refused."""
    if not voice_bank:
        return None
    bank = Path(voice_bank).resolve()
    recording = bank / f'{preset}.wav'
    if not recording.is_file():
        return None
    if game_dir and (Path(game_dir).resolve() == bank or Path(game_dir).resolve() in bank.parents):
        raise DubError('The voice bank is inside the game\'s folder: its actors\' voices aren\'t used. Keep your own recordings elsewhere.')
    try:
        listed = json.loads((bank / 'voices.json').read_text(encoding='utf-8')).get(preset) or {}
    except (OSError, ValueError):
        listed = {}
    if not str(listed.get('source') or '').strip() or not str(listed.get('license') or '').strip():
        raise DubError(f'The voice bank\'s voices.json doesn\'t say where {preset}.wav came from and its licence, so it isn\'t used.')
    return recording


def _speak_http(preset: str, arabic_text: str, dialect: str, out: Path):
    body = json.dumps({'text': arabic_text, 'language': 'ar', 'dialect': dialect, 'voice': preset}, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(tts_url() + (os.environ.get('GAMESHELF_TTS_SPEAK_PATH') or SPEAK_PATH), data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': f'Bearer {os.environ.get("OMNIVOICE_API_KEY", "")}'})
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            audio = response.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        raise DubError(f'The local TTS server didn\'t answer: {err}') from None
    if audio[:4] != b'RIFF':
        raise DubError(f'The local TTS server didn\'t answer with a WAV file (does it have a voice called "{preset}"?).')
    out.write_bytes(audio)


def synthesize_preset_line(preset: str, arabic_text: str, target_duration_ms: int, dialect: str = 'MSA', *, out_path,
                           voice_bank=None, backend: str = 'http', game_dir=None, ffmpeg: str | None = None) -> dict:
    """One dub line in a synthetic voice: `preset` from the voice bank when it has a recording of that name (said in
    its voice by the TTS, `backend` 'http' or 'f5'), else the TTS server's own speaker of that name. Fitted to the
    original line's length. Returns fit_audio_duration's report, with the file's path and where the voice came from."""
    if not _PRESET.match(preset or ''):
        raise DubError(f'"{preset}" isn\'t a voice preset\'s name (like male_protagonist_deep).')
    if not arabic_text.strip():
        raise DubError('There\'s no Arabic to say.')
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.with_name(out.stem + '.raw.wav')
    recording = bank_voice(voice_bank, preset, game_dir)
    try:
        if recording and backend == 'f5':
            _clone_f5(recording, arabic_text, raw)
        elif recording:
            _clone_http(recording, arabic_text, dialect, raw)
        elif backend == 'http':
            _speak_http(preset, arabic_text, dialect, raw)
        else:
            raise DubError(f'f5-tts needs a recording to speak from: put {preset}.wav in the voice bank.')
        return {**fit_audio_duration(raw, out, target_duration_ms, ffmpeg), 'file': str(out), 'voice': 'bank' if recording else 'server'}
    finally:
        raw.unlink(missing_ok=True)


def duration_ms(ffmpeg: str, wav: Path) -> int:
    """A sound file's length, from ffprobe when it's beside ffmpeg, else from ffmpeg's own report."""
    probe = Path(ffmpeg).with_name('ffprobe' + Path(ffmpeg).suffix)
    if probe.is_file():
        result = safe_exec.run([str(probe), '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(wav)],
                               capture_output=True, text=True, timeout=120)
        try:
            return round(float(result.stdout.strip()) * 1000)
        except ValueError:
            pass
    result = safe_exec.run([ffmpeg, '-hide_banner', '-nostdin', '-i', str(wav)], capture_output=True, text=True, timeout=120)
    m = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', result.stderr or '')
    if not m:
        raise DubError(f'{Path(wav).name} isn\'t a sound file ffmpeg can read.')
    return round((int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))) * 1000)


def fit_audio_duration(wav_in, wav_out, target_ms: int, ffmpeg: str | None = None) -> dict:
    """`wav_in` as long as the original line (`target_ms`), mono 44.1 kHz: silence cut from its start, sped up or
    slowed down by at most 30% / 15% (so it still sounds like speech), then padded with silence to the length.
    Returns {tempo, actual_ms, final_ms, overrun_ms}: a line still longer than the original (overrun_ms > 0) needs
    a shorter translation, not more speed."""
    ffmpeg = ffmpeg or uelogo.ffmpeg_exe()
    if not ffmpeg:
        raise DubError('Fitting a dub line needs ffmpeg (in PowerShell: winget install Gyan.FFmpeg --source winget).')
    if target_ms <= 0:
        raise DubError('The original line\'s length must be more than nothing.')
    actual = duration_ms(ffmpeg, Path(wav_in))
    tempo = max(MIN_TEMPO, min(MAX_TEMPO, actual / target_ms))
    Path(wav_out).parent.mkdir(parents=True, exist_ok=True)
    filters = f'silenceremove=start_periods=1:start_threshold=-45dB,atempo={tempo:.4f},apad=whole_dur={target_ms / 1000:.3f}'
    result = safe_exec.run([ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', str(wav_in), '-af', filters, '-ar', '44100', '-ac', '1', str(wav_out)],
                           capture_output=True, text=True, timeout=600)
    if result.returncode != 0 or not Path(wav_out).is_file():
        raise DubError(f'ffmpeg couldn\'t fit the line: {(result.stderr or "").strip()[-300:]}')
    final = duration_ms(ffmpeg, Path(wav_out))
    return {'tempo': round(tempo, 4), 'actual_ms': actual, 'final_ms': final, 'overrun_ms': max(0, final - target_ms)}


def synthesize_cloned_line(ref_wav_path, arabic_text: str, target_duration_ms: int, dialect: str = 'MSA', *, consent, out_path,
                           backend: str = 'http', game_dir=None, ffmpeg: str | None = None) -> dict:
    """One dub line: `arabic_text` said in the reference voice, as long as the original line. `backend` is 'http' (the
    local TTS server) or 'f5' (f5-tts_infer-cli). Returns fit_audio_duration's report, with the file's path."""
    ref = check_reference(ref_wav_path, consent, game_dir)
    if not arabic_text.strip():
        raise DubError('There\'s no Arabic to say.')
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.with_name(out.stem + '.raw.wav')
    try:
        if backend == 'http':
            _clone_http(ref, arabic_text, dialect, raw)
        elif backend == 'f5':
            _clone_f5(ref, arabic_text, raw)
        else:
            raise DubError('The TTS backend is "http" or "f5".')
        return {**fit_audio_duration(raw, out, target_duration_ms, ffmpeg), 'file': str(out)}
    finally:
        raw.unlink(missing_ok=True)
