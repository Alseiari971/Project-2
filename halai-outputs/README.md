# GameShelf TikTok ad (Arabic, 30 s, 9:16)

- `gameshelf-tiktok-ar.mp4`: the finished ad, 1080×1920, 30 fps, male Gulf-dialect voice-over, no music.
- `voice.mp3`: the voice-over (Halai, ElevenLabs v4, voice Liam, Arabic, energetic).
- `ad-source/ad.html`: the timeline (scenes, captions, zooms) over real GameShelf screenshots; `ad-source/render.js` renders its 900 frames with Playwright.

Re-render:

```bash
cd halai-outputs/ad-source && node render.js
```

```bash
cd halai-outputs && ffmpeg -y -framerate 30 -i ad-source/frames/f%04d.jpg -i voice.mp3 -filter_complex "[1:a]adelay=150|150,loudnorm=I=-14:TP=-1.5:LRA=11,apad[a]" -map 0:v -map "[a]" -t 30 -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart gameshelf-tiktok-ar.mp4
```

The library and vote counts on screen are sample data.
