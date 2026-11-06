"""An Arabic logo in an Unreal game's menu, where the menu draws a logo texture (uetexture.py). The texture and
widget files here are made up, laid out like Phantom Blade Zero's T_Logo_V2_EN and WB_StartMenu_V2."""

import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from arabic_compiler import packbuild, retoc, uelogo, uetexture

FFMPEG = uelogo.ffmpeg_exe()


def texture_uexp(w: int, h: int, fmt: str = 'PF_DXT5', fill: int = 0x11, tail_size: tuple | None = None) -> bytes:
    data = bytes([fill]) * uetexture.data_length(fmt, w, h)
    name = fmt.encode() + b'\0'
    tail = struct.pack('<i', 0) + struct.pack('<iii', *(tail_size or (w, h, 1))) + bytes(12)
    return (b'\x05\x04\x09\x03' + bytes(73) + struct.pack('<iii', w, h, 1) + struct.pack('<i', len(name)) + name
            + struct.pack('<ii', 0, 1) + data + tail)


def fstring(text: str) -> bytes:
    raw = text.encode() + b'\0'
    return struct.pack('<i', len(raw)) + raw


def widget_files(texture: str = 'T_Logo_V2_EN') -> tuple:
    names = ['/Script/CoreUObject', '/Script/Engine', '/Script/UMG', 'Package', 'Texture2D', 'Class',
             f'/Game/UI/{texture}', texture, '/Game/UI/T_Logo_V2_JA', 'T_Logo_V2_JA', 'Image', 'WB_StartMenu_V2']
    index = {n: i for i, n in enumerate(names)}

    def imp(package, cls, outer, obj):
        return struct.pack('<ii', index[package], 0) + struct.pack('<ii', index[cls], 0) + struct.pack('<i', outer) \
            + struct.pack('<ii', index[obj], 0) + bytes(4)

    imports = [imp('/Script/CoreUObject', 'Package', 0, f'/Game/UI/{texture}'),   # -1
               imp('/Script/Engine', 'Texture2D', -1, texture),                     # -2
               imp('/Script/CoreUObject', 'Package', 0, '/Game/UI/T_Logo_V2_JA'),   # -3
               imp('/Script/Engine', 'Texture2D', -3, 'T_Logo_V2_JA'),              # -4
               imp('/Script/UMG', 'Class', 0, 'Image')]                             # -5
    uasset = b'\xc1\x83\x2a\x9e' + bytes(120) + b''.join(fstring(n) + b'\x12\x34\x56\x78' for n in names) + b''.join(imports) + bytes(64)
    uexp = (bytes(40) + b'\x02\x05\x03' + struct.pack('<ff', 1024, 64) + struct.pack('<i', -2) + b'\x26\x01'
            + b'\x02\x05\x03' + struct.pack('<ff', 680, 170) + struct.pack('<i', -4) + bytes(30))
    return uasset, uexp


def decode_dxt5_alpha(data: bytes, w: int, h: int) -> list:
    """The alpha of a DXT5 picture, row by row (the test's own decoder)."""
    out = [[0] * w for _ in range(h)]
    p = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            a0, a1 = data[p], data[p + 1]
            bits = int.from_bytes(data[p + 2:p + 8], 'little')
            levels = [a0, a1] + ([((6 - i) * a0 + (1 + i) * a1) // 7 for i in range(6)] if a0 > a1
                                 else [((4 - i) * a0 + (1 + i) * a1) // 5 for i in range(4)] + [0, 255])
            for i in range(16):
                out[by + i // 4][bx + i % 4] = levels[(bits >> (3 * i)) & 7]
            p += 16
    return out


class Encoding(unittest.TestCase):
    def test_dxt5_keeps_the_logos_shape_and_leaves_clear_blocks_clear(self):
        w, h = 16, 8
        rgba = bytearray(w * h * 4)
        for y in range(h):
            for x in range(w):
                if 4 <= x < 12:  # an opaque white bar, soft at one edge
                    rgba[(y * w + x) * 4:(y * w + x) * 4 + 4] = bytes([255, 255, 255, 255 if x < 11 else 128])
        data = uetexture.encode_dxt5(bytes(rgba), w, h)
        self.assertEqual(len(data), w * h)
        alpha = decode_dxt5_alpha(data, w, h)
        for y in range(h):
            for x in range(w):
                want = rgba[(y * w + x) * 4 + 3]
                self.assertLessEqual(abs(alpha[y][x] - want), 20, (x, y))
        self.assertEqual(data[:16], bytes(16))  # the clear left-hand block
        with self.assertRaises(uetexture.TextureError):
            uetexture.encode_dxt5(bytes(10 * 10 * 4), 10, 10)

    def test_uncompressed_bgra_swaps_red_and_blue(self):
        self.assertEqual(uetexture.encode('PF_B8G8R8A8', bytes([1, 2, 3, 4]), 1, 1), bytes([3, 2, 1, 4]))


class Textures(unittest.TestCase):
    def test_a_single_mip_texture_is_read_and_rewritten_in_place_with_the_same_number_of_bytes(self):
        uexp = texture_uexp(2048, 128)
        tex = uetexture.read_texture(uexp)
        self.assertEqual((tex.width, tex.height, tex.pixel_format, tex.data_len), (2048, 128, 'PF_DXT5', 262144))
        # Phantom Blade Zero's 16:1 strip, for a 3:1 logo: 1024x256, the same bytes (the shape of its Japanese logo).
        self.assertEqual(uetexture.best_shape(tex, (2172, 724)), (1024, 256))
        self.assertEqual(uetexture.best_shape(tex, (4000, 250)), (2048, 128))
        new = uetexture.write_texture(uexp, tex, bytes([0x22]) * tex.data_len, 1024, 256)
        self.assertEqual(len(new), len(uexp))
        again = uetexture.read_texture(new)
        self.assertEqual((again.width, again.height), (1024, 256))
        self.assertEqual(new[again.data_at:again.data_at + again.data_len], bytes([0x22]) * 262144)
        with self.assertRaises(uetexture.TextureError):
            uetexture.write_texture(uexp, tex, bytes(10), 1024, 256)

    def test_a_texture_laid_out_otherwise_is_left_alone(self):
        with self.assertRaises(uetexture.TextureError):  # its mip says another size: mipmaps or a .ubulk
            uetexture.read_texture(texture_uexp(256, 64, tail_size=(128, 32, 1)))
        with self.assertRaises(uetexture.TextureError):
            uetexture.read_texture(b'not a texture' * 100)
        with self.assertRaises(uetexture.TextureError):
            uetexture.data_length('PF_BC7', 64, 64)  # can't be encoded here, so it isn't touched


class Widgets(unittest.TestCase):
    def test_the_brush_that_draws_the_texture_is_found_by_its_import(self):
        uasset, uexp = widget_files()
        imports = uetexture.package_imports(uasset)
        self.assertIn(('Texture2D', 'T_Logo_V2_EN'), imports)
        at = uetexture.find_brush(uasset, uexp, 'T_Logo_V2_EN')
        self.assertEqual(uetexture.brush_size(uexp, at), (1024.0, 64.0))
        self.assertEqual(uetexture.brush_size(uexp, uetexture.find_brush(uasset, uexp, 'T_Logo_V2_JA')), (680.0, 170.0))
        changed = uetexture.set_brush_size(uexp, at, 1024, 256)
        self.assertEqual(len(changed), len(uexp))
        self.assertEqual(uetexture.brush_size(changed, at), (1024.0, 256.0))
        with self.assertRaises(uetexture.TextureError):
            uetexture.find_brush(uasset, uexp, 'T_Logo_V2_KO')


@unittest.skipUnless(FFMPEG, 'needs ffmpeg')
class InTheBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def legacy_game(self, folder: Path):
        ui = folder / 'PhantomBlade' / 'Content' / 'UI'
        ui.mkdir(parents=True)
        uasset, uexp = widget_files()
        (ui / 'WB_StartMenu_V2.uasset').write_bytes(uasset)
        (ui / 'WB_StartMenu_V2.uexp').write_bytes(uexp)
        (ui / 'T_Logo_V2_EN.uasset').write_bytes(b'texture header')
        (ui / 'T_Logo_V2_EN.uexp').write_bytes(texture_uexp(256, 16))

    def test_the_menu_logo_texture_and_its_brush_are_changed_for_the_arabic_logo(self):
        made_up = self.tmp / 'game-legacy'
        self.legacy_game(made_up)
        logo = self.tmp / 'logo.png'
        subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=white@0.0:s=300x100,format=rgba',
                        '-vf', 'drawbox=x=0:y=0:w=300:h=100:color=white@1.0:t=fill:replace=1', '-frames:v', '1', str(logo)], check=True)
        paks = self.tmp / 'Paks'
        paks.mkdir()
        (paks / 'pakchunk0-Windows.utoc').write_bytes(b'x')
        taken = []

        def to_legacy(tool, *args, timeout=None):
            taken.append(args[args.index('--filter') + 1])
            shutil.copytree(made_up, Path(args[-1]), dirs_exist_ok=True)
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        source = SimpleNamespace(pak_listing='\n'.join([
            'PhantomBlade/Content/UI/WB_StartMenu_V2.uasset', 'PhantomBlade/Content/UI/T_Logo_V2_EN.uasset',
            'PhantomBlade/Content/Hud/T_Weapon_Sword_Logo.uasset', 'PhantomBlade/Content/UI/W_Inventory.uasset']))
        args = SimpleNamespace(retoc='retoc', source=str(self.tmp), ue_version='UE5_7', logo_image=str(logo))
        logged = []
        with mock.patch.object(retoc, 'find_tool', return_value='retoc'), mock.patch.object(retoc, '_run', to_legacy), \
                mock.patch.object(retoc, 'game_containers', return_value=[paks / 'pakchunk0-Windows.utoc']):
            out = packbuild.stage_menu_logo(args, source, {}, self.tmp / 'stage', logged.append)
        self.assertEqual(sorted(taken), ['T_Logo_V2_EN', 'WB_StartMenu_V2'])  # not the weapon icon or other menus
        ui = out / 'PhantomBlade' / 'Content' / 'UI'
        tex = uetexture.read_texture((ui / 'T_Logo_V2_EN.uexp').read_bytes())
        self.assertEqual((tex.width, tex.height), (128, 32))  # 16:1 -> 4:1, the same bytes, for a 3:1 logo
        alpha = decode_dxt5_alpha((ui / 'T_Logo_V2_EN.uexp').read_bytes()[tex.data_at:tex.data_at + tex.data_len], 128, 32)
        self.assertGreater(alpha[16][10], 200)  # the logo, from the left
        self.assertEqual(alpha[16][120], 0)     # and clear after it
        uasset, uexp = (ui / 'WB_StartMenu_V2.uasset').read_bytes(), (ui / 'WB_StartMenu_V2.uexp').read_bytes()
        self.assertEqual(uetexture.brush_size(uexp, uetexture.find_brush(uasset, uexp, 'T_Logo_V2_EN')), (1024.0, 256.0))
        self.assertEqual(uetexture.brush_size(uexp, uetexture.find_brush(uasset, uexp, 'T_Logo_V2_JA')), (680.0, 170.0))
        self.assertTrue(any('Arabic logo in the menu: T_Logo_V2_EN (256x16 -> 128x32 PF_DXT5) in WB_StartMenu_V2 '
                            '(brush 1024x64 -> 1024x256)' in line for line in logged), logged)

    def test_a_game_without_a_menu_logo_texture_is_left_alone(self):
        source = SimpleNamespace(pak_listing='PhantomBlade/Content/UI/WB_StartMenu_V2.uasset')
        args = SimpleNamespace(retoc=None, source=str(self.tmp), ue_version='UE5_7', logo_image='logo.png')
        self.assertIsNone(packbuild.stage_menu_logo(args, source, {}, self.tmp / 'stage', print))


if __name__ == '__main__':
    unittest.main()
