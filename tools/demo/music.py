#!/usr/bin/env python3
"""The demo video's soundtrack: a chiptune at 120 BPM, 38 s, stereo 44.1 kHz,
written sample by sample with the standard library only.

  python3 -I tools/demo/music.py [<out.wav>]     (default <work>/music.wav)

Bars of 2 s start at t = 1.0 (the first second is a two-beat pickup), so every
scene cut of comp.html (3, 7, 11, ... 35 s) lands on a bar line; the last
chord hits at 37.0 and rings out. Effects (clicks, blips, swishes into the
cuts) are timed to the composition: see the "effects" section, and move them
with the scenes. Loudness comes out near -13 LUFS; finish.sh lowers it to -14.
"""
import array, math, os, random, struct, sys, wave

SR = 44100
DUR = 38.0
N = int(SR * DUR)
BEAT = 0.5
S16 = BEAT / 4
L = array.array('d', bytes(8 * N))
R = array.array('d', bytes(8 * N))
rnd = random.Random(7)

def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)

def add(buf_l, buf_r, start, samples, gain, pan):
    i0 = int(start * SR)
    gl = gain * math.cos((pan + 1) * math.pi / 4)
    gr = gain * math.sin((pan + 1) * math.pi / 4)
    for k, v in enumerate(samples):
        i = i0 + k
        if 0 <= i < N:
            buf_l[i] += v * gl
            buf_r[i] += v * gr

def env(n, a, d, s, r, length):
    """ADSR in seconds; `length` = gate time."""
    out = []
    for k in range(n):
        t = k / SR
        if t < a: e = t / a
        elif t < a + d: e = 1 - (1 - s) * (t - a) / d
        elif t < length: e = s
        else: e = s * max(0.0, 1 - (t - length) / r)
        out.append(e)
    return out

def pulse(midi, length, duty=0.5, a=0.004, d=0.08, s=0.6, r=0.06, vib=0.0):
    f = hz(midi)
    n = int((length + r) * SR)
    e = env(n, a, d, s, r, length)
    out, ph = [], 0.0
    for k in range(n):
        t = k / SR
        fv = f * (1 + vib * math.sin(2 * math.pi * 5.5 * t) * min(1, t / 0.15))
        ph = (ph + fv / SR) % 1.0
        v = 1.0 if ph < duty else -1.0
        out.append(v * e[k])
    # soften the edges a little (one-pole lowpass)
    y, c = 0.0, 0.35
    for k in range(n):
        y += c * (out[k] - y)
        out[k] = y
    return out

def tri(midi, length, r=0.03):
    f = hz(midi)
    n = int((length + r) * SR)
    e = env(n, 0.003, 0.05, 0.85, r, length)
    out, ph = [], 0.0
    for k in range(n):
        ph = (ph + f / SR) % 1.0
        out.append((4 * abs(ph - 0.5) - 1) * e[k])
    return out

def kick():
    n = int(0.28 * SR)
    out, ph = [], 0.0
    for k in range(n):
        t = k / SR
        f = 45 + 120 * math.exp(-t * 28)
        ph += f / SR
        out.append(math.sin(2 * math.pi * ph) * math.exp(-t * 11))
    return out

def noise(length, decay, cutoff=0.5, hp=False):
    n = int(length * SR)
    out, y, prev = [], 0.0, 0.0
    for k in range(n):
        t = k / SR
        x = rnd.uniform(-1, 1)
        y += cutoff * (x - y)
        v = (x - y) if hp else y
        out.append(v * math.exp(-t * decay))
    return out

def snare():
    body = noise(0.22, 18, 0.55)
    n = len(body)
    for k in range(n):
        t = k / SR
        body[k] = 0.8 * body[k] + 0.35 * math.sin(2 * math.pi * 190 * t) * math.exp(-t * 30)
    return body

def swish(length):
    """Filtered noise that swells into a cut, ending at its end."""
    n = int(length * SR)
    out, y = [], 0.0
    for k in range(n):
        p = k / n
        c = 0.02 + 0.25 * p * p
        y += c * (rnd.uniform(-1, 1) - y)
        out.append(y * (p ** 2.2) * (1 - max(0, (p - 0.92) / 0.08)))
    return out

# ---- harmony ---------------------------------------------------------------
A3, C4, D4, E4, F4, G4, A4 = 57, 60, 62, 64, 65, 67, 69
CHORDS = {  # root (bass), chord tones for arps
    'Am': (45, [57, 60, 64, 69]),
    'F':  (41, [53, 57, 60, 65]),
    'G':  (43, [55, 59, 62, 67]),
    'C':  (48, [55, 60, 64, 67]),
    'E':  (40, [52, 56, 59, 64]),
}
# (bar start time, chord); bars are 2 s from 1.0
PROG = ['Am', 'F', 'G', 'C', 'Am', 'F', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'G']
BARS = [(0.0, 'E')] + [(1.0 + 2 * i, c) for i, c in enumerate(PROG)] + [(37.0, 'C')]

def chord_at(t):
    name = BARS[0][1]
    for start, c in BARS:
        if t >= start - 1e-9: name = c
    return name

END_HIT = 37.0  # the last bar is one held chord

# ---- bass: eighths, root / octave ------------------------------------------
t = 0.0
while t < END_HIT - 1e-9:
    root = CHORDS[chord_at(t)][0]
    step = int(round(t / (BEAT / 2)))
    note = root + (12 if step % 2 else 0)
    add(L, R, t, tri(note, BEAT / 2 * 0.8), 0.30, 0.0)
    t += BEAT / 2
add(L, R, END_HIT, tri(36, 0.9, r=0.4), 0.32, 0.0)

# ---- arp: 16ths over chord tones, quiet, panned left -------------------------
t = 0.0
k = 0
while t < END_HIT - 1e-9:
    tones = CHORDS[chord_at(t)][1]
    pattern = [0, 1, 2, 3, 2, 1, 2, 3]
    note = tones[pattern[k % 8]] + 12
    add(L, R, t, pulse(note, S16 * 0.7, duty=0.25, d=0.05, s=0.3, r=0.03), 0.085, -0.45)
    t += S16
    k += 1

# ---- lead: from the reveal on, a motif per bar, panned right, with echo -------
MOTIFS = {  # (beat offset, scale note, length in beats)
    'F':  [(0, A4, 1), (1, C4 + 12, 0.5), (1.5, A4, 0.5), (2, G4, 1), (3, F4, 1)],
    'G':  [(0, G4, 0.5), (0.5, A4, 0.5), (1, 71, 1), (2, D4 + 12, 1.5), (3.5, 71, 0.5)],
    'C':  [(0, C4 + 12, 1.5), (1.5, 71, 0.5), (2, C4 + 12, 0.5), (2.5, D4 + 12, 0.5), (3, E4 + 12, 1)],
    'Am': [(0, E4 + 12, 1), (1, D4 + 12, 0.5), (1.5, C4 + 12, 0.5), (2, A4, 1.5), (3.5, C4 + 12, 0.5)],
}
lead_l = array.array('d', bytes(8 * N))
lead_r = array.array('d', bytes(8 * N))
for start, name in BARS:
    if start < 3.0 or start >= END_HIT: continue
    for off, note, beats in MOTIFS.get(name, []):
        add(lead_l, lead_r, start + off * BEAT, pulse(note, beats * BEAT * 0.85, duty=0.5, d=0.12, s=0.55, r=0.08, vib=0.004), 0.11, 0.3)
# final lead note on the end hit
add(lead_l, lead_r, END_HIT, pulse(C4 + 12, 0.7, duty=0.5, d=0.2, s=0.5, r=0.3, vib=0.006), 0.12, 0.3)
# dotted-eighth ping-pong echo
delay = int(SR * BEAT * 0.75)
for i in range(N):
    dl = lead_l[i - delay] if i >= delay else 0.0
    dr = lead_r[i - delay] if i >= delay else 0.0
    L[i] += lead_l[i] + 0.28 * dr
    R[i] += lead_r[i] + 0.28 * dl

# ---- final chord: held, ringing out ------------------------------------------
for note in [60, 64, 67, 72]:
    add(L, R, END_HIT, pulse(note, 0.6, duty=0.25, d=0.3, s=0.4, r=0.35), 0.05, -0.2)

# ---- drums -------------------------------------------------------------------
K, SN = kick(), snare()
t = 0.0
while t < END_HIT - 1e-9:
    beat = int(round(t / BEAT))
    add(L, R, t, K, 0.55, 0.0)
    if t >= 1.0 and (beat - 2) % 2 == 1:   # backbeat in bars from 1.0: beats 2 and 4
        add(L, R, t, SN, 0.22, 0.05)
    add(L, R, t + BEAT / 2, noise(0.05, 70, 0.9, hp=True), 0.07, 0.25)
    t += BEAT
# a short fill into the reveal and the outro
for t0 in (2.5, 14.5, 22.5, 34.5):
    for j in range(4):
        add(L, R, t0 + j * S16, SN, 0.10 + 0.04 * j, -0.1 + 0.07 * j)
add(L, R, END_HIT, K, 0.6, 0.0)
add(L, R, END_HIT, noise(0.9, 4.5, 0.5, hp=True), 0.06, 0.0)  # soft crash

# ---- effects: on the cuts, in key, under the music ---------------------------
CUTS = [3.0, 7.0, 11.0, 15.0, 19.0, 23.0, 27.0, 31.0, 35.0]
BLIPS = [76, 79, 81, 84, 79, 76, 81, 84, 88]
for cut, blip in zip(CUTS, BLIPS):
    s = swish(0.5)
    add(L, R, cut - 0.5, s, 0.10, -0.3)
    add(L, R, cut - 0.5, s[::-1][::-1], 0.10, 0.3)
    add(L, R, cut, pulse(blip, 0.06, duty=0.125, d=0.05, s=0.2, r=0.08), 0.05, 0.1)
# channel flips in the hook (Sonic, Monkey Ball)
for t0 in (1.0, 2.0):
    add(L, R, t0, noise(0.06, 60, 0.7, hp=True), 0.08, 0.0)
# cursor clicks: the card (8.5), Join (17.5), a key's + (32.5)
for tc in (8.5, 17.5, 32.5):
    add(L, R, tc, pulse(88, 0.02, duty=0.5, d=0.02, s=0.1, r=0.02), 0.06, 0.15)
    add(L, R, tc, noise(0.03, 120, 0.8, hp=True), 0.08, 0.15)
# filter switches (scene 6): soft blips on 24, 25, 26
for tc, nn in ((24.0, 79), (25.0, 81), (26.0, 84)):
    add(L, R, tc, pulse(nn, 0.05, duty=0.125, d=0.04, s=0.2, r=0.06), 0.04, -0.2)
# the 0 -> 62 count (scene 2): quiet ticks on 16ths from 5.0 to 6.5
t = 5.0
while t < 6.5 - 1e-9:
    add(L, R, t, pulse(96, 0.012, duty=0.5, d=0.01, s=0.1, r=0.01), 0.025, 0.2)
    t += S16
# the wall of 62 (scene 4): soft card clicks on 8ths from 11.0 to 13.0
t = 11.0
while t < 13.0 - 1e-9:
    add(L, R, t, noise(0.025, 150, 0.6, hp=True), 0.05, rnd.uniform(-0.5, 0.5))
    t += BEAT / 2
# the 4x wipe (scene 5): a rising pentatonic sweep under 15.5 -> 16.5
for j, note in enumerate([69, 72, 74, 76, 79, 81, 84, 86]):
    add(L, R, 27.5 + j * S16, pulse(note, S16 * 0.8, duty=0.125, d=0.04, s=0.3, r=0.04), 0.035, 0.35 - 0.1 * j)

# ---- master: fade in of 20 ms, fade out over the last 0.6 s, soft limit -----
peak = 0.0
for i in range(N):
    g = min(1.0, i / (0.02 * SR)) * min(1.0, (N - i) / (0.6 * SR))
    L[i] = math.tanh(1.15 * L[i]) * g
    R[i] = math.tanh(1.15 * R[i]) * g
    peak = max(peak, abs(L[i]), abs(R[i]))
scale = 0.89 / peak
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.abspath(os.environ.get('DEMO_WORK') or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'demo-work')), 'music.wav')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    frames = bytearray()
    for i in range(N):
        frames += struct.pack('<hh', int(L[i] * scale * 32767), int(R[i] * scale * 32767))
    w.writeframes(bytes(frames))
print('peak', round(peak, 3), 'written', OUT)
