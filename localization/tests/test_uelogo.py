"""The Arabic title logo for Unreal games whose logo is a video pair (..._RGB.mp4 + ..._Alpha.mp4)."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from arabic_compiler import uelogo
from arabic_compiler.packbuild import BuildError, build, parse_args
from test_build_pack import HAS_NODE, REPO, FakeApi, node_read_pack
from test_ue5_runtime import FAKE_REPAK, FAKE_RETOC, english_locres, tool, utoc

FFMPEG = uelogo.ffmpeg_exe()

# Like Phantom Blade Zero's: the intro and main menu title logos in several languages, a studio logo, a demo video.
PBZ_MOVIES = [
    'ProjectPBZ/Content/Movies/Complete/DEMO_EN_logo.mp4',
    'ProjectPBZ/Content/Movies/PBZLogo_Alpha.mp4', 'ProjectPBZ/Content/Movies/PBZLogo_RGB.mp4',
    'ProjectPBZ/Content/Movies/PBZLogo_En_Alpha.mp4', 'ProjectPBZ/Content/Movies/PBZLogo_En_RGB.mp4',
    'ProjectPBZ/Content/Movies/PBZLogo_Ja_Alpha.mp4', 'ProjectPBZ/Content/Movies/PBZLogo_Ja_RGB.mp4',
    'ProjectPBZ/Content/Movies/PBZLogo_Ko_Alpha.mp4', 'ProjectPBZ/Content/Movies/PBZLogo_Ko_RGB.mp4',
    'ProjectPBZ/Content/Movies/SGameLogo_Alpha.mp4', 'ProjectPBZ/Content/Movies/SGameLogo_RGB.mp4',
    'ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo-EN_Alpha.mp4', 'ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo-EN_RGB.mp4',
    'ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo_Alpha.mp4', 'ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo_RGB.mp4',
    'ProjectPBZ/Content/Movies/UI/Ending/Ending_SGameLogo_Alpha.mp4', 'ProjectPBZ/Content/Movies/UI/Ending/Ending_SGameLogo_RGB.mp4',
    'ProjectPBZ/Content/MoviesHalfRes/PBZLogo_En_Alpha.mp4', 'ProjectPBZ/Content/MoviesHalfRes/PBZLogo_En_RGB.mp4',
    'ProjectPBZ/Content/MoviesHalfRes/PBZLogo_Ja_Alpha.mp4', 'ProjectPBZ/Content/MoviesHalfRes/PBZLogo_Ja_RGB.mp4',
]


def ffmpeg(*args):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', *args], check=True)


def game_logo_pair(folder: Path):
    """A 320x180, 2-second logo pair: the logo fades in from 0.3s to 0.7s and out from 1.4s."""
    rgb, alpha = folder / 'game_RGB.mp4', folder / 'game_Alpha.mp4'
    ffmpeg('-f', 'lavfi', '-i', 'color=black:s=320x180:r=30:d=2', '-vf',
           'drawbox=x=100:y=70:w=120:h=40:color=white:t=fill,fade=in:st=0.3:d=0.4,fade=out:st=1.4:d=0.4', '-pix_fmt', 'yuv420p', str(alpha))
    ffmpeg('-f', 'lavfi', '-i', 'color=0x202020:s=320x180:r=30:d=2', '-vf', 'drawbox=x=100:y=70:w=120:h=40:color=red:t=fill',
           '-pix_fmt', 'yuv420p', str(rgb))
    return rgb, alpha


def arabic_logo(path: Path):
    """A transparent 300x100 PNG: a white bar on nothing."""
    ffmpeg('-f', 'lavfi', '-i', 'color=white@0.0:s=300x100,format=rgba', '-vf', 'drawbox=x=20:y=30:w=260:h=40:color=white@1.0:t=fill:replace=1',
           '-frames:v', '1', str(path))
    return path


def levels(video: Path, stat='YMAX'):
    out = subprocess.run([FFMPEG, '-hide_banner', '-i', str(video), '-vf', f'format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.{stat}:file=-',
                          '-f', 'null', '-'], capture_output=True, text=True, check=True).stdout
    return [float(line.split('=')[1]) for line in out.splitlines() if stat in line]


class WhichVideos(unittest.TestCase):
    def test_the_english_and_language_free_title_logos_are_replaced_and_the_studio_logo_is_not(self):
        pairs = uelogo.logo_videos(PBZ_MOVIES)
        self.assertEqual(pairs, [
            ('ProjectPBZ/Content/Movies/PBZLogo_En_RGB.mp4', 'ProjectPBZ/Content/Movies/PBZLogo_En_Alpha.mp4'),
            ('ProjectPBZ/Content/Movies/PBZLogo_RGB.mp4', 'ProjectPBZ/Content/Movies/PBZLogo_Alpha.mp4'),
            ('ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo-EN_RGB.mp4', 'ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo-EN_Alpha.mp4'),
            ('ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo_RGB.mp4', 'ProjectPBZ/Content/Movies/UI/AlphaVideo/PBZlogo_Alpha.mp4'),
            ('ProjectPBZ/Content/MoviesHalfRes/PBZLogo_En_RGB.mp4', 'ProjectPBZ/Content/MoviesHalfRes/PBZLogo_En_Alpha.mp4'),
        ])

    def test_a_logo_in_one_language_only_or_without_its_other_track_is_left_alone(self):
        self.assertEqual(uelogo.logo_videos(['G/Content/Movies/StudioLogo_RGB.mp4', 'G/Content/Movies/StudioLogo_Alpha.mp4']), [])
        self.assertEqual(uelogo.logo_videos(['G/Content/Movies/Logo_En_RGB.mp4', 'G/Content/Movies/Logo_Ja_RGB.mp4',
                                             'G/Content/Movies/Logo_Ja_Alpha.mp4']), [])

    def test_the_logo_is_fitted_into_the_games_logo_box(self):
        self.assertEqual(uelogo.fit((300, 100), (100, 70, 220, 110), (320, 180)), (100, 70, 120, 40))
        x, y, w, h = uelogo.fit((100, 100), (100, 70, 220, 110), (320, 180))  # a square logo: as tall as the box, centred
        self.assertEqual((w, h), (40, 40))
        self.assertEqual(x, 140)

    def test_a_box_as_big_as_the_frame_never_makes_the_logo_bigger_than_the_video(self):
        # Like Phantom Blade Zero's: the transparency track's smoke fills (and, measured coarsely, overshoots) the frame.
        for logo in ((2172, 724), (300, 1000), (1920, 1080)):
            x, y, w, h = uelogo.fit(logo, (0, 0, 1924, 1084), (1920, 1080))
            self.assertTrue(0 <= x and 0 <= y and x + w <= 1920 and y + h <= 1080, (logo, x, y, w, h))
            self.assertLessEqual(w, 1920 * 0.6)
            self.assertLessEqual(h, 1080 * 0.5)
        self.assertEqual(uelogo.fit((2172, 724), (0, 0, 1924, 1084), (1920, 1080)), (384, 348, 1152, 384))

    def test_only_a_png_is_taken(self):
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
            f.write(b'GIF89a not a png')
        self.addCleanup(os.unlink, f.name)
        with self.assertRaises(uelogo.LogoError):
            uelogo.png_size(Path(f.name))


@unittest.skipUnless(FFMPEG, 'needs ffmpeg')
class MakeVideos(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_the_new_pair_has_the_games_size_and_frames_and_fades_with_it(self):
        rgb, alpha = game_logo_pair(self.tmp)
        logo = arabic_logo(self.tmp / 'logo.png')
        made = uelogo.make_pair(FFMPEG, logo, rgb, alpha, self.tmp / 'out' / 'new_RGB.mp4', self.tmp / 'out' / 'new_Alpha.mp4')
        self.assertEqual(made['size'], '320x180')
        # Where the game's logo is, to within the few pixels the box is measured at (a quarter of the size).
        for got, want in zip(made['box'], (100, 70, 120, 40)):
            self.assertLessEqual(abs(got - want), 4)
        self.assertEqual(sorted(p.name for p in (self.tmp / 'out').iterdir()), ['new_Alpha.mp4', 'new_RGB.mp4'])  # no leftovers
        shown = levels(self.tmp / 'out' / 'new_Alpha.mp4')
        self.assertEqual(len(shown), 60)
        self.assertLess(shown[3], 20)     # before the game's logo fades in: nothing
        self.assertGreater(shown[30], 240)  # fully shown with it
        self.assertLess(shown[58], 20)    # gone again at the end
        self.assertTrue(20 < shown[15] < 240)  # and part way while it fades in
        # Outside the logo the transparency is nothing at all (no faint box around it).
        corner = subprocess.run([FFMPEG, '-hide_banner', '-i', str(self.tmp / 'out' / 'new_Alpha.mp4'), '-vf',
                                 'crop=60:40:0:0,format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX:file=-',
                                 '-f', 'null', '-'], capture_output=True, text=True, check=True).stdout
        self.assertTrue(all(float(l.split('=')[1]) == 0 for l in corner.splitlines() if 'YMAX' in l))
        self.assertEqual(len(levels(self.tmp / 'out' / 'new_RGB.mp4')), 60)

    def test_a_transparency_track_that_never_changes_is_refused(self):
        ffmpeg('-f', 'lavfi', '-i', 'color=black:s=64x64:r=10:d=1', '-pix_fmt', 'yuv420p', str(self.tmp / 'flat.mp4'))
        with self.assertRaises(uelogo.LogoError):
            uelogo.timing(FFMPEG, self.tmp / 'flat.mp4')


@unittest.skipUnless(FFMPEG and HAS_NODE, 'needs ffmpeg and Node.js')
class InThePack(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        tools = self.tmp / 'tools'
        tools.mkdir()
        # A repak that records what it packs, so the test can see the logo videos in the Arabic .pak.
        repak = FAKE_REPAK.replace("Path(args[-1]).write_bytes(b'the Arabic pak'); sys.exit(0)",
                                   "Path(args[-1]).write_text(json.dumps(sorted(str(p.relative_to(args[-2])).replace('\\\\', '/') "
                                   "for p in Path(args[-2]).rglob('*') if p.is_file()))); sys.exit(0)")
        env = mock.patch.dict(os.environ, {'GAMESHELF_REPAK': str(tool(tools, 'repak', repak)),
                                           'GAMESHELF_RETOC': str(tool(tools, 'retoc', FAKE_RETOC)), 'OPENAI_API_KEY': 'secret-key'})
        env.start()
        self.addCleanup(env.stop)

    def test_the_logo_videos_go_into_the_arabic_pak_at_the_games_paths(self):
        rgb, alpha = game_logo_pair(self.tmp)
        files = {'PhantomBlade/Content/Localization/Game/en/Game.locres': english_locres().hex()}
        for lang in ('En', 'Ja'):
            files[f'PhantomBlade/Content/Movies/PBZLogo_{lang}_RGB.mp4'] = rgb.read_bytes().hex()
            files[f'PhantomBlade/Content/Movies/PBZLogo_{lang}_Alpha.mp4'] = alpha.read_bytes().hex()
        game = self.tmp / 'PhantomBlade'
        paks = game / 'PhantomBlade' / 'Content' / 'Paks'
        paks.mkdir(parents=True)
        (paks / 'pakchunk0-Windows.pak').write_text(json.dumps({'files': files}))
        utoc(paks / 'pakchunk0-Windows.utoc', [{'id': '0b' * 12, 'type': 'ExportBundleData', 'path': '../../../PhantomBlade/Content/Maps/Town.umap', 'hex': '00'}])
        (paks / 'pakchunk0-Windows.ucas').write_bytes(b'ucas')
        binaries = game / 'PhantomBlade' / 'Binaries' / 'Win64'
        binaries.mkdir(parents=True)
        (binaries / 'PhantomBlade-Win64-Shipping.exe').write_bytes(b'MZ' + '++UE5+Release-5.4-CL-0'.encode('utf-16-le') + b'\0' * 100)
        keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(keys)], check=True, capture_output=True)
        api = FakeApi()
        self.addCleanup(api.close)
        logged = []
        args = parse_args([str(game), '--id', 'pbz-ar', '--version', '1.0.0', '--steam-app-id', '2109880', '--key', str(keys / 'pack-signing.key'),
                           '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', api.base,
                           '--logo-image', str(arabic_logo(self.tmp / 'logo.png'))])
        pack = build(args, log=logged.append)
        node_read_pack(pack, keys / 'pack-signing.pub')
        packed = json.loads((pack / 'payload' / 'pakchunk99-ArabicLocalization_P.pak').read_text())
        self.assertIn('PhantomBlade/Content/Movies/PBZLogo_En_RGB.mp4', packed)
        self.assertIn('PhantomBlade/Content/Movies/PBZLogo_En_Alpha.mp4', packed)
        self.assertNotIn('PhantomBlade/Content/Movies/PBZLogo_Ja_RGB.mp4', packed)
        self.assertFalse(any(p.endswith('.raw') for p in packed))
        self.assertTrue(any('Arabic logo: PBZLogo_En_RGB.mp4 and PBZLogo_En_Alpha.mp4 (320x180' in line for line in logged))

    def test_a_logo_that_isnt_a_png_stops_the_build(self):
        (self.tmp / 'logo.png').write_bytes(b'not a picture')
        game = self.tmp / 'G'
        paks = game / 'G' / 'Content' / 'Paks'
        paks.mkdir(parents=True)
        (paks / 'pakchunk0-Windows.pak').write_text(json.dumps({'files': {'G/Content/Localization/Game/en/Game.locres': english_locres().hex()}}))
        keys = self.tmp / 'keys'
        subprocess.run(['node', str(REPO / 'scripts/localization-pack.js'), 'keygen', str(keys)], check=True, capture_output=True)
        api = FakeApi()
        self.addCleanup(api.close)
        args = parse_args([str(game), '--id', 'g-ar', '--version', '1.0.0', '--steam-app-id', '1', '--key', str(keys / 'pack-signing.key'),
                           '--out', str(self.tmp / 'out'), '--provider', 'openai', '--model', 'm', '--api-base', api.base,
                           '--logo-image', str(self.tmp / 'logo.png')])
        with self.assertRaises(BuildError) as caught:
            build(args, log=lambda *_: None)
        self.assertIn('isn\'t a PNG', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
