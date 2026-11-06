"""An Arabic title logo for Unreal games whose logo is a video: a colour track (..._RGB.mp4) and a transparency
track (..._Alpha.mp4) played together, as in Phantom Blade Zero (Movies/PBZLogo_En_RGB.mp4 + PBZLogo_En_Alpha.mp4
for the intro, Movies/UI/AlphaVideo/PBZlogo-EN_*.mp4 behind the main menu, and their MoviesHalfRes copies).

From the admin's own logo (a transparent PNG), each pair is made again with the game's own size, frame rate and
length, the logo placed where the game's logo is and fading in and out with it: the brightness of the game's
transparency track, frame by frame, is the new logo's opacity. The new files go into the Arabic .pak at the same
paths, so the game plays them in place of its own. Everything is done by ffmpeg.

Which videos: a game's title logo is the one it has in several languages (PBZLogo, PBZLogo_En, PBZLogo_Ja, ...);
the English one and the one without a language are replaced, the others (and a studio's logo, which has no
languages) are left alone.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from . import safe_exec

_TRACK = re.compile(r'^(?P<base>.*?)[_-](?P<track>rgb|alpha)\.mp4$', re.I)
_LANGUAGE = re.compile(r'[_-](?P<lang>en|ja|jp|ko|kr|cn|zh|chs|cht|tw|hk|ru|fr|de|es|it|pt|br|pl|tr|ar|th|vi|id)(?=$|[_-])', re.I)
_REPLACED = {'', 'en'}


class LogoError(RuntimeError):
    pass


def ffmpeg_exe() -> str | None:
    """ffmpeg: GAMESHELF_FFMPEG, one on PATH, one winget installed (Gyan.FFmpeg), or imageio-ffmpeg's."""
    given = os.environ.get('GAMESHELF_FFMPEG')
    if given and Path(given).is_file():
        return given
    found = shutil.which('ffmpeg')
    if found:
        return found
    winget = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Packages'
    if os.environ.get('LOCALAPPDATA') and winget.is_dir():
        for exe in sorted(winget.glob('Gyan.FFmpeg*/*/bin/ffmpeg.exe'), reverse=True):
            return str(exe)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 (not installed, or its program is missing)
        return None


def logo_videos(listing) -> list:
    """The title logo's (colour, transparency) video pairs in a game's file list that an Arabic logo replaces."""
    files = {}
    for name in listing:
        name = name.strip().replace('\\', '/')
        path = PurePosixPath(name)
        m = _TRACK.match(path.name)
        if m and 'logo' in m.group('base').lower():
            files.setdefault((str(path.parent), m.group('base')), {})[m.group('track').lower()] = name
    families = {}
    for (folder, base), tracks in files.items():
        if set(tracks) != {'rgb', 'alpha'}:
            continue
        lang = _LANGUAGE.search(base)
        family = (folder, (_LANGUAGE.sub('', base) if lang else base).lower())
        families.setdefault(family, []).append(((lang.group('lang').lower() if lang else ''), tracks))
    pairs = []
    for members in families.values():
        if len(members) < 2:  # a logo in one language only (a studio's logo) isn't the game's title
            continue
        for lang, tracks in members:
            if lang in _REPLACED:
                pairs.append((tracks['rgb'], tracks['alpha']))
    return sorted(pairs)


@dataclass
class Video:
    width: int
    height: int
    fps: str
    audio: bool


def _run(ffmpeg: str, args: list, what: str) -> subprocess.CompletedProcess:
    result = safe_exec.run([ffmpeg, '-hide_banner', '-nostdin', *args], capture_output=True, text=True, timeout=1800)
    if result.returncode != 0:
        lines = [l.strip() for l in (result.stderr or '').splitlines() if l.strip()]
        # ffmpeg says what went wrong first and how it stopped last: both, without the progress lines between.
        why = [l for l in lines if re.search(r'(?i)error|invalid|not supported|unable|cannot|could not|no such|does not', l)
               and not l.startswith(('frame=', '[out#'))]
        raise LogoError(f'ffmpeg couldn\'t {what}: ' + ' | '.join(dict.fromkeys(why[:8] or lines[-4:]))[:1200])
    return result


def probe(ffmpeg: str, video: Path) -> Video:
    result = safe_exec.run([ffmpeg, '-hide_banner', '-nostdin', '-i', str(video)], capture_output=True, text=True, timeout=120)
    info = result.stderr or ''
    stream = re.search(r'Stream #\S+.*?Video: .*?, (\d{2,5})x(\d{2,5})[ ,].*?(?:, ([\d.]+) (?:fps|tbr))', info)
    if not stream:
        raise LogoError(f'{video.name} doesn\'t look like a video ffmpeg can read.')
    fps = re.search(r', ([\d.]+) fps', info) or re.search(r', ([\d.]+) tbr', info)
    return Video(int(stream.group(1)), int(stream.group(2)), fps.group(1) if fps else '30', bool(re.search(r'Stream #\S+.*?Audio:', info)))


def timing(ffmpeg: str, alpha: Path, scale: int = 4) -> tuple:
    """The game's logo, from its transparency track: (its opacity on each frame, 0 to 1, and the box the logo
    fills while it's fully shown, in the video's own pixels)."""
    graph = f'scale=iw/{scale}:-2,format=gray,signalstats,bbox=min_val=64,metadata=mode=print:file=-'
    out = _run(ffmpeg, ['-i', str(alpha), '-vf', graph, '-an', '-f', 'null', '-'], 'read the logo\'s transparency video').stdout
    frames, current = [], None
    for line in out.splitlines():
        if line.startswith('frame:'):
            current = {}
            frames.append(current)
        elif current is not None and '=' in line:
            key, _, value = line.partition('=')
            try:
                current[key.rsplit('.', 1)[-1]] = float(value)
            except ValueError:
                pass
    levels = [f.get('YAVG', 0.0) for f in frames]
    if not levels:
        raise LogoError(f'{alpha.name} has no frames ffmpeg could measure.')
    low, high = min(levels), max(levels)
    shown = [f for f in frames if 'x1' in f and f.get('YAVG', 0) >= low + (high - low) * 0.9]
    if high - low < 0.5 or not shown:
        raise LogoError(f'{alpha.name} doesn\'t show a logo (its transparency never changes).')
    opacity = [min(1.0, max(0.0, (v - low) / (high - low))) for v in levels]
    box = (min(f['x1'] for f in shown) * scale, min(f['y1'] for f in shown) * scale,
           (max(f['x2'] for f in shown) + 1) * scale, (max(f['y2'] for f in shown) + 1) * scale)
    return opacity, box


def png_size(png: Path) -> tuple:
    head = Path(png).read_bytes()[:24]
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise LogoError(f'{Path(png).name} isn\'t a PNG image.')
    return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')


def fit(logo: tuple, box: tuple, frame: tuple) -> tuple:
    """Where the logo goes: as big as fits the game's logo box, centred on it, inside the frame. (x, y, w, h).
    A box nearly as big as the frame is the logo with its smoke or ink around it, not the logo: then the logo
    is at most 60% of the frame's width and half its height, still centred where the game's is."""
    fw, fh = frame
    x1, y1, x2, y2 = max(0, box[0]), max(0, box[1]), min(fw, box[2]), min(fh, box[3])
    bw, bh = max(2, x2 - x1), max(2, y2 - y1)
    if bw > fw * 0.8 or bh > fh * 0.8:
        bw, bh = min(bw, fw * 0.6), min(bh, fh * 0.5)
    s = min(bw / logo[0], bh / logo[1])
    w = max(2, min(int(logo[0] * s), fw) // 2 * 2)
    h = max(2, min(int(logo[1] * s), fh) // 2 * 2)
    x = int(min(max(0, (x1 + x2) / 2 - w / 2), fw - w))
    y = int(min(max(0, (y1 + y2) / 2 - h / 2), fh - h))
    return x, y, w, h


def make_pair(ffmpeg: str, logo: Path, game_rgb: Path, game_alpha: Path, out_rgb: Path, out_alpha: Path) -> dict:
    """The Arabic logo's two videos, made like the game's pair."""
    video = probe(ffmpeg, game_rgb)
    opacity, box = timing(ffmpeg, game_alpha)
    x, y, w, h = fit(png_size(logo), box, (video.width, video.height))
    # The opacity curve as a small video, a frame for each of the game's (ffmpeg can't scale a 1x1 frame up). Colour
    # (rgb24) rather than grey throughout, like the colour video: newer ffmpeg treats grey's range differently.
    curve = Path(out_alpha).with_name(Path(out_alpha).name + '.opacity.raw')
    shape = Path(out_alpha).with_name(Path(out_alpha).name + '.shape.png')
    curve.parent.mkdir(parents=True, exist_ok=True)
    curve.write_bytes(b''.join(bytes([round(o * 255)]) * (16 * 16 * 3) for o in opacity))
    encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
    # Colour: the logo's own colours where it's drawn, black elsewhere, on every frame of the game's video (its sound kept).
    colour = (f'[1:v]format=rgba,scale={w}:{h}:flags=lanczos,format=rgba,split[c][a];'
              f'[a]alphaextract,lut=y=\'if(gt(val,8),255,0)\',dilation,dilation[m];'
              f'[c]format=rgb24[cs];[cs][m]alphamerge[cm];'
              f'[0:v]format=rgb24,lutrgb=r=0:g=0:b=0[bg];[bg][cm]overlay={x}:{y}:shortest=1:format=auto,format=yuv420p[v]')
    out_rgb.parent.mkdir(parents=True, exist_ok=True)
    _run(ffmpeg, ['-y', '-i', str(game_rgb), '-loop', '1', '-framerate', video.fps, '-i', str(logo),
                  '-filter_complex', colour, '-map', '[v]', *(['-map', '0:a?', '-c:a', 'copy'] if video.audio else ['-an']),
                  *encode, str(out_rgb)], 'make the logo\'s colour video')
    # Transparency: the logo's shape (white where it's drawn, made once), times the game's logo opacity on each frame.
    try:
        _run(ffmpeg, ['-y', '-i', str(logo), '-vf',
                      f'format=rgba,scale={w}:{h}:flags=lanczos,format=rgba,pad={video.width}:{video.height}:{x}:{y}:color=0x00000000,'
                      f'alphaextract,lut=y=\'if(lt(val,8),0,val)\',format=rgb24', '-frames:v', '1', str(shape)],
             'make the logo\'s shape')
        alpha = (f'[0:v]scale={video.width}:{video.height}:flags=neighbor,format=gbrp[level];'
                 f'[1:v]format=gbrp[shape];'
                 f'[shape][level]blend=all_mode=multiply:shortest=1,format=yuv420p[v]')
        _run(ffmpeg, ['-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '16x16', '-framerate', video.fps, '-i', str(curve),
                      '-loop', '1', '-framerate', video.fps, '-i', str(shape),
                      '-filter_complex', alpha, '-map', '[v]', '-an', *encode, str(out_alpha)], 'make the logo\'s transparency video')
    finally:
        curve.unlink(missing_ok=True)
        shape.unlink(missing_ok=True)
    return {'size': f'{video.width}x{video.height}', 'fps': video.fps, 'box': (x, y, w, h)}


def stage_logo_videos(logo: Path, listing, fetch, stage: Path, log) -> list:
    """The Arabic logo's videos at the game's logo video paths under `stage`. `fetch(path inside the game, file)`
    copies one of the game's files out. Returns [(staged file, path inside the game)]."""
    logo = Path(logo)
    if not logo.is_file():
        raise LogoError(f'{logo} isn\'t there.')
    png_size(logo)
    ffmpeg = ffmpeg_exe()
    if not ffmpeg:
        raise LogoError('Making the logo videos needs ffmpeg. Install it (in PowerShell: winget install Gyan.FFmpeg), '
                        'restart GameShelf and build again.')
    pairs = logo_videos(listing)
    if not pairs:
        log('Found no title logo videos (..._RGB.mp4 with ..._Alpha.mp4, in several languages) in the game, so the logo wasn\'t added.')
        return []
    staged = []
    with tempfile.TemporaryDirectory() as tmp:
        for rgb, alpha in pairs:
            game_rgb, game_alpha = Path(tmp) / 'game_RGB.mp4', Path(tmp) / 'game_Alpha.mp4'
            fetch(rgb, game_rgb)
            fetch(alpha, game_alpha)
            out_rgb = stage.joinpath(*PurePosixPath(rgb).parts)
            out_alpha = stage.joinpath(*PurePosixPath(alpha).parts)
            made = make_pair(ffmpeg, logo, game_rgb, game_alpha, out_rgb, out_alpha)
            staged += [(out_rgb, PurePosixPath(rgb)), (out_alpha, PurePosixPath(alpha))]
            log(f'Arabic logo: {PurePosixPath(rgb).name} and {PurePosixPath(alpha).name} ({made["size"]}, {made["fps"]} fps, logo at {made["box"][0]},{made["box"][1]} '
                f'{made["box"][2]}x{made["box"][3]}).')
    return staged
