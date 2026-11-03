"""Sound effects for the ad, on its animation beats: pops, whooshes, a click, a ding and two bass hits (no music)."""
import wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)
track = np.zeros(int(SR * 30))

def env(n, attack=0.004, decay=8.0):
    t = np.arange(n) / SR
    return np.minimum(1, t / attack) * np.exp(-t * decay)

def pop(f=600, d=0.12, vol=0.5):
    n = int(SR * d); t = np.arange(n) / SR
    freq = f * (1 + 0.6 * t / d)
    return np.sin(2 * np.pi * np.cumsum(freq) / SR) * env(n, decay=30) * vol

def whoosh(d=0.45, vol=0.35, rising=True):
    n = int(SR * d); noise = rng.standard_normal(n)
    out = np.zeros(n); y = 0.0
    for i in range(n):  # a one-pole low-pass whose cutoff sweeps
        k = i / n
        a = 0.02 + 0.25 * (k if rising else 1 - k)
        y += a * (noise[i] - y); out[i] = y
    shape = np.sin(np.pi * np.arange(n) / n) ** 2
    return out / (np.abs(out).max() + 1e-9) * shape * vol

def hit(vol=0.8):
    n = int(SR * 0.55); t = np.arange(n) / SR
    freq = 40 + 90 * np.exp(-t * 14)
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 6)
    return body * vol + pop(2400, 0.02, 0.15).tolist() + [0] * 0 if False else body * vol

def click(vol=0.45):
    n = int(SR * 0.03)
    return rng.standard_normal(n) * env(n, 0.0005, 160) * vol + pop(2200, 0.03, 0.3)[:n]

def ding(vol=0.35):
    n = int(SR * 0.7); t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1320 * t) + 0.6 * np.sin(2 * np.pi * 1980 * t)) * np.exp(-t * 5) * env(n, 0.002, 0) * vol

def thud(vol=0.4):
    n = int(SR * 0.22); t = np.arange(n) / SR
    return np.sign(np.sin(2 * np.pi * 150 * t)) * np.exp(-t * 18) * vol * 0.5

def at(sec, sound):
    i = int(sec * SR); sound = np.asarray(sound)[: len(track) - i]
    track[i:i + len(sound)] += sound

at(0.02, pop(520)); [at(0.05 + i * 0.07, pop(700 + i * 60, vol=0.22)) for i in range(6)]
at(1.25, whoosh(0.4)); at(1.95, thud())
at(3.80, whoosh(0.45, rising=False)); at(4.05, hit())
for i in range(3): at(5.55 + i * 0.15, pop(620 + i * 90, vol=0.35))
for i in range(8): at(5.85 + i * 0.09, pop(760 + i * 40, vol=0.18))
at(8.12, whoosh(0.4)); at(8.6, pop(980, vol=0.3))
for i in range(2): at(9.2 + i * 0.25, pop(700 + i * 120, vol=0.3))
at(10.48, hit(0.7)); at(11.70, whoosh(0.45))
at(13.0, click()); at(13.03, ding(0.32)); at(13.7, whoosh(0.3, vol=0.25))
at(15.74, whoosh(0.45)); at(17.6, click()); at(19.55, ding(0.4))
at(20.1, whoosh(0.4))
for i in range(3): at(20.55 + i * 0.22, pop(900 + i * 140, vol=0.32))
at(21.25, whoosh(0.4, vol=0.3, rising=False))
at(22.45, whoosh(0.5)); at(22.55, hit(0.85)); at(25.15, pop(560, 0.16, 0.5)); at(26.0, pop(820, vol=0.3))

track /= max(1.0, np.abs(track).max() / 0.9)
pcm = (np.repeat(track[:, None], 2, axis=1) * 32767).astype('<i2')
with wave.open('sfx.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('sfx.wav', len(track) / SR, 's')
