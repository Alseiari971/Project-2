"""An optional Arabic voice dub (tts_adapter.py, dubbing_pipeline.py): lines said by a TTS program on this PC in
a voice with its speaker's consent, fitted to the original line's length, and packed into the game's English voice
slot so its original voices stay."""

import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from arabic_compiler import dubbing_pipeline as dub
from arabic_compiler import tts_adapter as tts
from arabic_compiler import uelogo
from test_ue5_runtime import tool

FFMPEG = uelogo.ffmpeg_exe()
CONSENT = tts.VoiceConsent('Hamad', 'My own voice, recorded for this dub; I agree to it being cloned.')
# A repak that writes down what it was asked to pack.
RECORDING_REPAK = r'''
import json, sys
from pathlib import Path
args = sys.argv[1:]
assert args[0] == 'pack', args
stage, pak = Path(args[-2]), Path(args[-1])
pak.write_text(json.dumps({'files': sorted(p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_file()),
                           'mount': args[args.index('--mount-point') + 1]}))
'''


def tone(path: Path, seconds: float, lead_silence: float = 0.0):
    filters = f'adelay={int(lead_silence * 1000)}:all=1' if lead_silence else 'anull'
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=f=220:d={seconds}', '-af', filters,
                    '-ar', '44100', '-ac', '1', str(path)], check=True)
    return path


class Slots(unittest.TestCase):
    def test_only_the_english_voice_slot_is_a_dubs_place(self):
        self.assertEqual(dub.slot_of('Game/Content/WwiseAudio/Windows/English(US)/Voice_001.wem'), 'English(US)')
        self.assertEqual(dub.slot_of('Game/Content/Audio/VO/en-US/line_12.ogg'), 'en-US')
        self.assertEqual(dub.slot_of('Game/Content/Audio/VO/en/line_12.ogg'), 'en')
        self.assertIsNone(dub.slot_of('Game/Content/WwiseAudio/Windows/Chinese/Voice_001.wem'))
        self.assertIsNone(dub.slot_of('Game/Content/Audio/VO/ja/line_12.ogg'))
        self.assertIsNone(dub.slot_of('Game/Content/WwiseAudio/Windows/SFX/Sword.wem'))  # not a voice language at all
        self.assertIsNone(dub.slot_of('Game/Content/Audio/zh-Hans/en/line.ogg'))  # inside another language's folder
        self.assertIsNone(dub.slot_of('Game/Content/Audio/English(US).wem'))  # a file's name isn't a slot
        listing = ['G/Content/WwiseAudio/Windows/English(US)/a.wem', 'G/Content/WwiseAudio/Windows/Japanese/a.wem',
                   'G/Content/Localization/Game/en/Game.locres', 'G/Content/WwiseAudio/Windows/English(US)/b.wem']
        self.assertEqual(dub.english_slot_files(listing), ['G/Content/WwiseAudio/Windows/English(US)/a.wem', 'G/Content/WwiseAudio/Windows/English(US)/b.wem'])


class Packing(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repak = str(tool(self.tmp, 'repak', RECORDING_REPAK))
        self.wem = self.tmp / 'line.wem'
        self.wem.write_bytes(b'RIFF dubbed')

    def test_the_dub_pak_holds_the_english_slots_files_and_says_how_to_hear_it(self):
        files = {'Game/Content/WwiseAudio/Windows/English(US)/Voice_001.wem': self.wem,
                 'Game\\Content\\WwiseAudio\\Windows\\English(US)\\Voice_002.wem': self.wem}
        record = dub.pack_dub(files, self.tmp / 'out', self.repak, consents=[CONSENT])
        packed = json.loads((self.tmp / 'out' / dub.DUB_PAK_NAME).read_text())
        self.assertEqual(dub.DUB_PAK_NAME, 'pakchunk99-ArabicDub_P.pak')
        self.assertEqual(packed['files'], ['Game/Content/WwiseAudio/Windows/English(US)/Voice_001.wem',
                                           'Game/Content/WwiseAudio/Windows/English(US)/Voice_002.wem'])
        self.assertEqual(packed['mount'], '../../../')
        self.assertEqual(record['slot'], ['English(US)'])
        self.assertEqual(record['instruction']['ar'], 'للدبلجة الصوتية: اختر لغة النصوص (العربية) ولغة الصوت (الإنجليزية) من إعدادات اللعبة')
        self.assertEqual(record['voices'], [{'speaker': 'Hamad', 'statement': CONSENT.statement}])
        self.assertEqual(json.loads((self.tmp / 'out' / 'dub.json').read_text(encoding='utf-8')), record)

    def test_another_languages_voices_another_file_type_or_a_path_outside_the_game_are_refused_before_anything_is_copied(self):
        good = 'Game/Content/WwiseAudio/Windows/English(US)/Voice_001.wem'
        for bad, why in (('Game/Content/WwiseAudio/Windows/Chinese/Voice_001.wem', 'English voice slot'),
                         ('Game/Content/WwiseAudio/Windows/Japanese/Voice_001.wem', 'English voice slot'),
                         ('Game/Content/WwiseAudio/Windows/English(US)/Voice_001.ogg', 'audio format'),
                         ('../English(US)/Voice_001.wem', 'outside the game')):
            with self.assertRaises(dub.DubError) as caught:
                dub.stage_dub({good: self.wem, bad: self.wem}, self.tmp / 'stage')
            self.assertIn(why, str(caught.exception))
            self.assertFalse((self.tmp / 'stage').exists())
        with self.assertRaises(dub.DubError):
            dub.stage_dub({}, self.tmp / 'stage')


class Consent(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.ref = self.tmp / 'my-voice.wav'
        self.ref.write_bytes(b'RIFF ref')

    def test_a_voice_is_cloned_only_with_its_speakers_consent_and_never_from_the_games_files(self):
        with self.assertRaises(tts.DubError):
            tts.check_reference(self.ref, None)
        with self.assertRaises(tts.DubError):
            tts.check_reference(self.ref, tts.VoiceConsent('', 'ok'))
        self.assertEqual(tts.check_reference(self.ref, CONSENT), self.ref.resolve())
        game = self.tmp / 'Game'
        (game / 'Audio' / 'English(US)').mkdir(parents=True)
        actor = game / 'Audio' / 'English(US)' / 'Voice_001.wav'
        actor.write_bytes(b'RIFF the game\'s actor')
        with self.assertRaises(tts.DubError) as caught:
            tts.check_reference(actor, CONSENT, game_dir=game)
        self.assertIn('actors\' voices aren\'t cloned', str(caught.exception))
        with self.assertRaises(tts.DubError):
            tts.synthesize_cloned_line(actor, 'مرحبا', 1000, consent=CONSENT, out_path=self.tmp / 'o.wav', game_dir=game)

    def test_lines_and_recordings_only_go_to_a_tts_server_on_this_pc(self):
        with mock.patch.dict(os.environ, {'GAMESHELF_TTS_URL': 'https://tts.example.com'}):
            with self.assertRaises(tts.DubError):
                tts.tts_url()
        with mock.patch.dict(os.environ, {'GAMESHELF_TTS_URL': 'http://127.0.0.1:4000/'}):
            self.assertEqual(tts.tts_url(), 'http://127.0.0.1:4000')
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('GAMESHELF_TTS_URL', None)
            self.assertEqual(tts.tts_url(), 'http://127.0.0.1:3900')


@unittest.skipUnless(FFMPEG, 'needs ffmpeg')
class Fitting(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_a_line_is_sped_up_or_slowed_within_limits_and_padded_to_the_originals_length(self):
        # A little long: sped up to fit.
        report = tts.fit_audio_duration(tone(self.tmp / 'a.wav', 2.0), self.tmp / 'a-fit.wav', 1800)
        self.assertAlmostEqual(report['tempo'], 2000 / 1800, places=2)
        self.assertLessEqual(abs(report['final_ms'] - 1800), 60)
        self.assertEqual(report['overrun_ms'] > 60, False)
        # Short: slowed by no more than 15%, then silence to the length.
        report = tts.fit_audio_duration(tone(self.tmp / 'b.wav', 1.0), self.tmp / 'b-fit.wav', 2000)
        self.assertEqual(report['tempo'], 0.85)
        self.assertLessEqual(abs(report['final_ms'] - 2000), 60)
        # Far too long: 30% faster at most, and the report says how much is left over.
        report = tts.fit_audio_duration(tone(self.tmp / 'c.wav', 4.0), self.tmp / 'c-fit.wav', 2000)
        self.assertEqual(report['tempo'], 1.3)
        self.assertGreater(report['overrun_ms'], 900)
        with self.assertRaises(tts.DubError):
            tts.fit_audio_duration(self.tmp / 'a.wav', self.tmp / 'x.wav', 0)

    def test_a_line_is_said_by_the_local_server_in_the_consented_voice_and_fitted(self):
        speech = tone(self.tmp / 'speech.wav', 1.5).read_bytes()
        seen = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen['path'] = self.path
                seen['auth'] = self.headers.get('Authorization')
                seen['body'] = self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(speech)))
                self.end_headers()
                self.wfile.write(speech)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        ref = tone(self.tmp / 'my-voice.wav', 1.0)
        with mock.patch.dict(os.environ, {'GAMESHELF_TTS_URL': f'http://127.0.0.1:{server.server_address[1]}', 'OMNIVOICE_API_KEY': 'local-key'}):
            done = dub.dub_lines([{'key': 'Dialogue/Ready', 'arabic': 'هل أنتِ مستعدة؟', 'duration_ms': 1500, 'reference': str(ref)},
                                  {'key': 'Dialogue/Empty', 'arabic': '', 'duration_ms': 1500, 'reference': str(ref)}],
                                 self.tmp / 'work', consent=CONSENT, log=lambda *_: None)
        self.assertEqual(seen['path'], '/api/v1/tts/clone')
        self.assertEqual(seen['auth'], 'Bearer local-key')
        self.assertIn('name="language"\r\n\r\nar'.encode(), seen['body'])
        self.assertIn('هل أنتِ مستعدة؟'.encode('utf-8'), seen['body'])
        self.assertIn(b'name="reference_audio"; filename="my-voice.wav"', seen['body'])
        self.assertEqual(done[0]['key'], 'Dialogue/Ready')
        self.assertLessEqual(abs(done[0]['final_ms'] - 1500), 60)
        self.assertTrue(Path(done[0]['file']).is_file())
        self.assertFalse(list((self.tmp / 'work').glob('*.raw.wav')))  # nothing left over
        self.assertIn('no Arabic to say', done[1]['error'])  # one bad line doesn't stop the rest


@unittest.skipUnless(FFMPEG, 'needs ffmpeg')
class SyntheticVoices(unittest.TestCase):
    """Characters are cast to synthetic voice presets: nobody's voice is cloned, and the game's audio is only measured."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        speech = tone(self.tmp / 'speech.wav', 1.2).read_bytes()
        self.seen = seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                seen.append((self.path, self.headers.get('Content-Type', ''), body))
                self.send_response(200)
                self.send_header('Content-Length', str(len(speech)))
                self.end_headers()
                self.wfile.write(speech)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        env = mock.patch.dict(os.environ, {'GAMESHELF_TTS_URL': f'http://127.0.0.1:{server.server_address[1]}'})
        env.start()
        self.addCleanup(env.stop)

    def test_each_speaker_is_said_in_its_cast_preset_and_the_narrator_says_the_rest(self):
        lines = [{'key': 'D/1', 'speaker': 'Soul', 'arabic': 'لن أتراجع.', 'duration_ms': 1300},
                 {'key': 'D/2', 'arabic': 'وهكذا بدأت الرحلة.', 'duration_ms': 1300}]
        done = dub.dub_lines(lines, self.tmp / 'work', cast={'Soul': 'male_protagonist_deep'}, log=lambda *_: None)
        self.assertEqual([d.get('preset') for d in done], ['male_protagonist_deep', 'narrator_epic'])
        self.assertEqual([d['voice'] for d in done], ['server', 'server'])  # the TTS server's own speakers
        path, kind, body = self.seen[0]
        self.assertEqual((path, kind), ('/api/v1/tts', 'application/json'))
        self.assertEqual(json.loads(body), {'text': 'لن أتراجع.', 'language': 'ar', 'dialect': 'MSA', 'voice': 'male_protagonist_deep'})
        self.assertLessEqual(abs(done[0]['final_ms'] - 1300), 60)
        self.assertIn('male_protagonist_deep', tts.VOICE_ARCHETYPES)

    def test_a_speaker_nobody_cast_or_a_voice_that_isnt_a_presets_name_stops_the_dub_before_it_starts(self):
        with self.assertRaises(dub.DubError) as caught:
            dub.dub_lines([{'key': 'D/1', 'speaker': 'Zuo Shang', 'arabic': 'نص', 'duration_ms': 900}], self.tmp / 'work', cast={'Soul': 'male_protagonist_deep'})
        self.assertIn('Zuo Shang', str(caught.exception))
        with self.assertRaises(dub.DubError):
            dub.check_cast({'Soul': 'C:/game/voice.wav'}, [])
        self.assertEqual(self.seen, [])

    def test_the_voice_banks_recordings_are_used_only_when_it_says_where_they_came_from(self):
        bank = self.tmp / 'voice-bank'
        bank.mkdir()
        tone(bank / 'female_warrior_calm.wav', 1.0)
        line = [{'key': 'D/3', 'speaker': 'Hong', 'arabic': 'استعد.', 'duration_ms': 1200}]
        cast = {'Hong': 'female_warrior_calm'}
        done = dub.dub_lines(line, self.tmp / 'work', cast=cast, voice_bank=bank, log=lambda *_: None)
        self.assertIn('voices.json', done[0]['error'])  # an unaccounted recording isn't used
        self.assertEqual(self.seen, [])
        (bank / 'voices.json').write_text(json.dumps({'female_warrior_calm': {'source': 'Recorded for GameShelf', 'license': 'CC0'}}))
        done = dub.dub_lines(line, self.tmp / 'work', cast=cast, voice_bank=bank, log=lambda *_: None)
        self.assertEqual(done[0]['voice'], 'bank')
        self.assertEqual(self.seen[0][0], '/api/v1/tts/clone')  # said in the bank's voice
        self.assertIn(b'filename="female_warrior_calm.wav"', self.seen[0][2])
        # A "bank" inside the game's folder is the game's actors: refused.
        game = self.tmp / 'Game'
        shutil.copytree(bank, game / 'Audio')
        done = dub.dub_lines(line, self.tmp / 'work', cast=cast, voice_bank=game / 'Audio', game_dir=game, log=lambda *_: None)
        self.assertIn('actors', done[0]['error'])

    def test_the_games_lines_are_only_measured(self):
        original = tone(self.tmp / 'Voice_001.wav', 1.75)
        self.assertLessEqual(abs(dub.original_durations({'D/1': original, 'D/missing': self.tmp / 'nope.wav'})['D/1'] - 1750), 40)
        self.assertNotIn('D/missing', dub.original_durations({'D/missing': self.tmp / 'nope.wav'}))


if __name__ == '__main__':
    unittest.main()
