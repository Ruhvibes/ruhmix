#!/usr/bin/env python3
"""
RuhMix Free Music Library — 100% original synthesized music (build-time render).

Ten copyright-free tracks rendered offline with numpy (shipped set: best 6 —
Pop, Lofi, EDM, Trap, Sufi, Piano; the rest stay in the script for later):
   1. pop       — 120 BPM upbeat pop (drums + bass + pads + lead)
   2. lofi      —  80 BPM chill lofi (soft drums + rhodes-ish chords + vinyl)
   3. edm       — 128 BPM energetic EDM (four-on-floor + supersaw + lead)
   4. trap      — 140 BPM dark trap (808-style bass, hat rolls, bell melody)
   5. acoustic  —  90 BPM warm acoustic feel (fingerpicked plucks + pads)
   6. synthwave — 100 BPM retro synthwave (driving bass, gated pads, glide lead)
   7. sufi      —  85 BPM emotional sufi feel (harmonium-like lead, tabla-like
                   keherwa pattern, drone — original melody, nothing copied)
   8. dance     — 124 BPM upbeat party dance (four-floor, funky bass, brass stabs)
   9. piano     —  75 BPM emotional piano (piano-ish lead + strings pad)
  10. boombap   —  92 BPM hip-hop boom bap (dusty drums, jazzy rhodes, vinyl)

No samples, no copyrighted melodies — every note is programmed here with
plain oscillators (sine/square/saw stacks), ADSR-ish envelopes and
programmed drum patterns. Original compositions for the RuhMix Free Music
Library — free to use in your projects.

Usage:  python3 tools/gen-free-music.py [--out www/music]
Output: 6 MP3 files (128 kbps stereo), ~0.5 MB each, total ~3.2 MB.
Requires: numpy, ffmpeg on PATH.
"""
import argparse
import os
import subprocess
import sys

import numpy as np

SR = 44100

# ---------------------------------------------------------------- helpers
def mtof(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)

def secs(n):
    return n / SR

def t_axis(dur):
    return np.arange(int(dur * SR)) / SR

def adsr_env(n, a, d, s, r):
    """Attack/decay/sustain/release envelope over n samples."""
    na = max(1, int(a * SR)); nd = max(1, int(d * SR)); nr = max(1, int(r * SR))
    ns = max(0, n - na - nd - nr)
    env = np.ones(n)
    if na: env[:na] = np.linspace(0, 1, na)
    if nd: env[na:na + nd] = np.linspace(1, s, nd)
    if ns: env[na + nd:na + nd + ns] = s
    if nr: env[n - nr:] = np.linspace(s, 0, nr)
    return env

def exp_env(n, tau, attack=0.005):
    t = np.arange(n) / SR
    e = np.exp(-t / tau)
    na = max(1, int(attack * SR))
    if na < n:
        e[:na] *= np.linspace(0, 1, na)
    return e

def spectral_filter(x, fc, kind='low', rolloff=0.35):
    """Fast vectorized low/high-pass via FFT (no scipy needed)."""
    if fc <= 0:
        return x
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    if kind == 'low':
        mask = np.exp(-np.maximum(0.0, f - fc) / (fc * rolloff + 1e-9))
    else:
        mask = np.exp(-np.maximum(0.0, fc - f) / (fc * rolloff + 1e-9))
    return np.fft.irfft(X * mask, n).astype(np.float32)

def pan_stereo(mono, pan):
    """Constant-power pan, pan in [-1, 1]."""
    ang = (pan + 1) * np.pi / 4.0
    return np.stack([mono * np.cos(ang), mono * np.sin(ang)], axis=1)

class Track:
    """Stereo mix bus; add() layers mono or stereo clips at a time offset."""
    def __init__(self, dur):
        self.n = int(dur * SR)
        self.mix = np.zeros((self.n, 2), dtype=np.float64)

    def add(self, clip, at=0.0, gain=1.0, pan=0.0):
        clip = np.asarray(clip, dtype=np.float64)
        if clip.ndim == 1:
            clip = pan_stereo(clip, pan)
        elif clip.ndim == 2 and clip.shape[1] == 1:
            clip = pan_stereo(clip[:, 0], pan)
        i = int(at * SR)
        j = min(self.n, i + clip.shape[0])
        if j <= i:
            return
        self.mix[i:j] += clip[:j - i] * gain

    def finished(self):
        x = self.mix
        peak = np.max(np.abs(x)) + 1e-9
        x = x / peak * 0.89
        x = np.tanh(x * 1.1) * 0.98   # gentle soft-clip glue
        peak2 = np.max(np.abs(x)) + 1e-9
        x = x / peak2 * 0.89
        return x.astype(np.float32)

# ------------------------------------------------------------------ drums
def kick(dur=0.42):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 48.0 + 130.0 * np.exp(-t * 42.0)
    ph = np.cumsum(2 * np.pi * f / SR)
    body = np.sin(ph) * np.exp(-t * 11.0)
    click = np.random.default_rng(7).standard_normal(n) * np.exp(-t * 220.0) * 0.35
    return (body + click).astype(np.float32)

def snare(dur=0.28):
    rng = np.random.default_rng(11)
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = spectral_filter(noise, 1800, 'high')
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 28.0) * 0.6
    return (noise * np.exp(-t * 16.0) * 0.8 + tone).astype(np.float32)

def clap(dur=0.30):
    rng = np.random.default_rng(13)
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = spectral_filter(noise, 1200, 'high')
    bursts = np.zeros(n)
    for b in (0.0, 0.012, 0.024, 0.036):
        i = int(b * SR)
        bursts[i:] += np.exp(-(t[:n - i]) * 90.0)[:n - i]
    return (noise * bursts * np.exp(-t * 14.0)).astype(np.float32)

def hat(dur=0.07, open_=False):
    rng = np.random.default_rng(17)
    n = int((0.32 if open_ else dur) * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = spectral_filter(noise, 7500, 'high')
    tau = 0.09 if open_ else 0.028
    return (noise * np.exp(-t / tau) * 0.55).astype(np.float32)

def crash(dur=1.6):
    rng = np.random.default_rng(19)
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = spectral_filter(noise, 5000, 'high')
    return (noise * np.exp(-t * 2.6) * 0.6).astype(np.float32)

def vinyl_crackle(dur, seed=23, density=0.0006):
    """Sparse pops + faint surface hiss."""
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    crack = np.zeros(n, dtype=np.float64)
    idx = rng.random(n) < density
    crack[idx] = rng.standard_normal(idx.sum()) * rng.uniform(0.15, 0.6, idx.sum())
    hiss = rng.standard_normal(n) * 0.012
    hiss = spectral_filter(hiss, 6000, 'low')
    return (crack * 0.5 + hiss).astype(np.float32)

# ------------------------------------------------------------------ tones
def osc(freq, n, wave='saw', detune_cents=0.0, vib_rate=0.0, vib_depth=0.0, seed=0):
    t = np.arange(n) / SR
    f = freq * 2.0 ** (detune_cents / 1200.0)
    if vib_rate > 0:
        f = f * (1.0 + vib_depth * np.sin(2 * np.pi * vib_rate * t))
    ph = np.cumsum(2 * np.pi * f / SR)
    if wave == 'sine':
        return np.sin(ph)
    if wave == 'square':
        return np.sign(np.sin(ph)) * 0.8
    if wave == 'tri':
        return np.arcsin(np.sin(ph)) * (2 / np.pi)
    # saw: sum of first 12 harmonics (band-limited-ish, no aliasing harshness)
    y = np.zeros(n)
    for h in range(1, 13):
        y += np.sin(h * ph) / h
    return y * 0.55

def note(freq, dur, wave='saw', vel=0.8, a=0.01, d=0.08, s=0.7, r=0.12,
         detune_cents=0.0, vib_rate=0.0, vib_depth=0.0, lp=None):
    n = int(dur * SR)
    y = osc(freq, n, wave, detune_cents, vib_rate, vib_depth)
    y = y * adsr_env(n, a, d, s, r) * vel
    if lp:
        y = spectral_filter(y, lp, 'low')
    return y.astype(np.float32)

def rhodes_note(freq, dur, vel=0.8, seed=0):
    """Mellow electric-piano-ish tone: decaying sine stack."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = (np.sin(2 * np.pi * freq * t)
         + 0.35 * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t * 3)
         + 0.16 * np.sin(2 * np.pi * 3 * freq * t) * np.exp(-t * 5)
         + 0.07 * np.sin(2 * np.pi * 4.02 * freq * t) * np.exp(-t * 7))
    y = y * exp_env(n, 1.1, attack=0.015) * vel
    return spectral_filter(y, 5200, 'low').astype(np.float32)

def chord_stab(midis, dur, wave='saw', vel=0.5, lp=6500, detune=6.0, vib=(0, 0)):
    n = int(dur * SR)
    y = np.zeros(n)
    for i, m in enumerate(midis):
        y += osc(mtof(m), n, wave, detune_cents=detune * (1 if i % 2 else -1),
                 vib_rate=vib[0], vib_depth=vib[1])
    y /= max(1, len(midis))
    y = y * adsr_env(n, 0.008, 0.06, 0.75, min(0.15, dur * 0.4)) * vel
    return spectral_filter(y, lp, 'low').astype(np.float32)

# ------------------------------------------------- extra tone helpers
def bass808(freq, dur, glide_to=None, vel=0.85):
    """808-style: sine with pitch drop, slight saturation, long body."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = freq + (freq * 0.9) * np.exp(-t * 25.0)
    if glide_to:
        f = f + (glide_to - freq) * np.minimum(1.0, t / max(0.06, dur * 0.4))
    ph = np.cumsum(2 * np.pi * f / SR)
    y = np.tanh(np.sin(ph) * 1.6) * 0.8
    return (y * exp_env(n, dur * 0.5, attack=0.005) * vel).astype(np.float32)

def tabla_dha(dur=0.35):
    """Low 'dha/dhi' thump."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 95.0 + 60.0 * np.exp(-t * 30.0)
    ph = np.cumsum(2 * np.pi * f / SR)
    return (np.sin(ph) * np.exp(-t * 9.0)).astype(np.float32)

def tabla_ge(dur=0.22):
    """Mid 'ge' resonant tone."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 160.0 + 80.0 * np.exp(-t * 35.0)
    ph = np.cumsum(2 * np.pi * f / SR)
    return (np.sin(ph) * np.exp(-t * 14.0) * 0.9).astype(np.float32)

def tabla_na(dur=0.09):
    """Crisp 'na/ti/ka' click."""
    rng = np.random.default_rng(41)
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = spectral_filter(rng.standard_normal(n), 3000, 'high')
    tone = np.sin(2 * np.pi * 620 * t) * np.exp(-t * 60.0)
    return (noise * np.exp(-t * 70.0) * 0.5 + tone * 0.5).astype(np.float32)

def piano_note(freq, dur, vel=0.7):
    """Piano-ish: bright decaying harmonic stack + hammer tick."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = (np.sin(2 * np.pi * freq * t)
         + 0.40 * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t * 2.5)
         + 0.22 * np.sin(2 * np.pi * 3 * freq * t) * np.exp(-t * 4.0)
         + 0.10 * np.sin(2 * np.pi * 4.01 * freq * t) * np.exp(-t * 6.0))
    rng = np.random.default_rng(int(freq) % 1000)
    n2 = min(n, int(0.02 * SR))
    y[:n2] += rng.standard_normal(n2) * 0.12 * np.exp(-np.arange(n2) / (0.004 * SR))
    y = y * exp_env(n, 1.6, attack=0.004) * vel
    return y.astype(np.float32)

def pluck_note(freq, dur, vel=0.6):
    """Acoustic-guitar-ish finger pluck: mellow, fast decay, soft chorus."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.arcsin(np.sin(2 * np.pi * freq * t)) * (2 / np.pi)
    y += 0.5 * np.arcsin(np.sin(2 * np.pi * freq * 1.003 * t)) * (2 / np.pi)
    y = y * 0.5 * exp_env(n, 0.32, attack=0.003) * vel
    return spectral_filter(y, 6000, 'low').astype(np.float32)

def glide_note(f0, f1, dur, vel=0.5, lp=6000):
    """Portamento synth lead glide between two pitches."""
    n = int(dur * SR)
    fr = f0 * (f1 / f0) ** (np.arange(n) / n)
    ph = np.cumsum(2 * np.pi * fr / SR)
    y = np.zeros(n)
    for h in range(1, 9):
        y += np.sin(h * ph) / h
    y = y * 0.55 * adsr_env(n, 0.03, 0.08, 0.75, 0.12) * vel
    return spectral_filter(y, lp, 'low').astype(np.float32)

def bell_note(freq, dur, vel=0.5):
    """Dark bell: sine + harmonics, long shimmering decay."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = (np.sin(2 * np.pi * freq * t)
         + 0.35 * np.sin(2 * np.pi * 2.76 * freq * t) * np.exp(-t * 2.0)
         + 0.18 * np.sin(2 * np.pi * 5.40 * freq * t) * np.exp(-t * 3.5))
    return (y * exp_env(n, 1.4, attack=0.004) * vel).astype(np.float32)

# ============================================================== DEMO POP
def render_pop():
    BPM, BEAT = 120, 0.5
    BAR = 4 * BEAT
    BARS = 16
    DUR = BARS * BAR                      # 32 s
    tr = Track(DUR + 0.5)
    K, S, H, C = kick(), snare(), hat(), clap()
    HO = hat(open_=True)

    # I–V–vi–IV in C: C  G  Am  F  (x4)
    prog = [([48, 55, 64], 36), ([43, 50, 59], 31), ([45, 52, 60], 33), ([41, 48, 57], 29)]

    # Lead melody — original, 8 bars x2 (second pass brighter)
    lead = [
        # bar: [(beat_off, beats, midi), ...]
        [(0, 1, 76), (1, 1, 79), (2, 1, 81), (3, 1, 79)],
        [(0, 1, 83), (1, 1, 81), (2, 1, 79), (3, 1, 76)],
        [(0, 1, 81), (1, 1, 84), (2, 1, 83), (3, 1, 81)],
        [(0, 1, 79), (1, 1, 81), (2, 1, 79), (3, 1, 76)],
        [(0, 2, 84), (2, 1, 83), (3, 1, 81)],
        [(0, 1, 79), (1, 1, 81), (2, 1, 83), (3, 1, 86)],
        [(0, 2, 84), (2, 1, 83), (3, 1, 79)],
        [(0, 1, 81), (1, 1, 79), (2, 1, 76), (3, 1, 74)],
    ]

    for b in range(BARS):
        t0 = b * BAR
        chord, root = prog[b % 4]
        # --- drums: four-floor kick, backbeat snare+clap, 8th hats
        for q in range(4):
            tr.add(K, t0 + q * BEAT, gain=0.95, pan=0.0)
        for q in (1, 3):
            tr.add(S, t0 + q * BEAT, gain=0.7, pan=0.05)
            tr.add(C, t0 + q * BEAT, gain=0.5, pan=-0.05)
        for e in range(8):
            tr.add(H, t0 + e * BEAT / 2, gain=0.34 if e % 2 == 0 else 0.22,
                   pan=0.35 if e % 2 else -0.35)
        if b % 4 == 3:
            tr.add(HO, t0 + 3.5 * BEAT, gain=0.4, pan=0.3)
        # --- bass: root 8ths, root/octave pump
        for e in range(8):
            m = root + (12 if e % 4 == 2 else 0) + (7 if e == 7 and b % 4 == 3 else 0)
            tr.add(note(mtof(m), BEAT * 0.48, wave='saw', vel=0.62, a=0.004,
                        d=0.05, s=0.6, r=0.05, lp=900),
                   t0 + e * BEAT / 2, pan=-0.1)
        tr.add(note(mtof(root - 12), BEAT * 0.9, wave='sine', vel=0.5,
                    a=0.004, d=0.05, s=0.7, r=0.08),
               t0, pan=0.0)
        # --- chord stabs on beats
        for q in range(4):
            tr.add(chord_stab(chord, BEAT * 0.85, vel=0.34, lp=5200),
                   t0 + q * BEAT, pan=0.15 if q % 2 else -0.15)
        # --- lead
        for off, ln, m in lead[b % 8]:
            bright = 1.0 if b < 8 else 1.15
            tr.add(note(mtof(m), ln * BEAT * 0.92, wave='saw', vel=0.42 * bright,
                        a=0.012, d=0.06, s=0.8, r=0.1, detune_cents=5,
                        vib_rate=5.5, vib_depth=0.004, lp=6800),
                   t0 + off * BEAT, pan=0.1)
    # sparkle: soft shaker 16ths last 4 bars
    for b in range(12, 16):
        for s16 in range(16):
            tr.add(H, b * BAR + s16 * BAR / 16, gain=0.12, pan=-0.5)
    return tr.finished(), 'Demo Pop', 120

# ============================================================== DEMO LOFI
def render_lofi():
    BPM, BEAT = 80, 0.75
    BAR = 4 * BEAT
    BARS = 12
    DUR = BARS * BAR                       # 36 s
    tr = Track(DUR + 1.0)
    K, S = kick(), snare()
    H = hat()

    # Am9 – Fmaj9 – Cmaj9 – G6 (jazzier voicings, original progression)
    prog = [
        (45, [60, 64, 67, 71]),   # Am9
        (41, [57, 60, 64, 67]),   # Fmaj9
        (48, [55, 59, 62, 67]),   # Cmaj9
        (43, [55, 59, 62, 64]),   # G6/9
    ]
    # sparse original melody (2 phrases)
    mel = [
        [(0, 2.5, 81)],                                            # A4
        [(0, 1, 79), (2, 1.5, 76)],                                # G4 E4
        [(0, 3, 84)],                                              # C5
        [(0, 1, 83), (1, 1, 81), (2.5, 1, 79)],                    # B4 A4 G4
        [(0, 2.5, 79)],
        [(0, 1, 81), (2, 1.5, 83)],
        [(0, 3, 86)],                                              # D5
        [(0, 1, 84), (1, 1, 81), (2.5, 1, 76)],
    ]

    for b in range(BARS):
        t0 = b * BAR
        root, tones = prog[b % 4]
        # --- drums: laid-back, swung 8th hats
        tr.add(K, t0, gain=0.8, pan=0.0)
        tr.add(K, t0 + 2.62 * BEAT, gain=0.62, pan=0.0)      # lazy "and of 2"
        for q in (1, 3):
            tr.add(S, t0 + q * BEAT, gain=0.42, pan=0.05)
        for e in range(8):
            sw = 0.10 * BEAT if e % 2 == 1 else 0.0          # swing
            tr.add(H, t0 + e * BEAT / 2 + sw,
                   gain=0.20 if e % 2 == 0 else 0.13,
                   pan=0.3 if e % 2 else -0.3)
        if b % 4 == 1:
            tr.add(hat(open_=True), t0 + 3.5 * BEAT, gain=0.25, pan=-0.25)
        # --- bass: root + fifth, soft
        tr.add(note(mtof(root - 12), BEAT * 1.6, wave='sine', vel=0.55,
                    a=0.01, d=0.1, s=0.8, r=0.2), t0, pan=0.0)
        tr.add(note(mtof(root - 5), BEAT * 1.2, wave='sine', vel=0.4,
                    a=0.01, d=0.1, s=0.8, r=0.2), t0 + 2.5 * BEAT, pan=0.0)
        # --- rhodes chords, strummed
        for i, m in enumerate(tones):
            tr.add(rhodes_note(mtof(m), BAR * 0.95, vel=0.5),
                   t0 + i * 0.014, pan=-0.2 + 0.1 * i)
        # --- melody
        for off, ln, m in mel[b % 8]:
            tr.add(note(mtof(m), ln * BEAT * 0.95, wave='tri', vel=0.4,
                        a=0.02, d=0.15, s=0.75, r=0.25,
                        vib_rate=4.5, vib_depth=0.003, lp=4200),
                   t0 + off * BEAT, pan=0.15)
    # vinyl feel over everything
    tr.mix[:, 0] += vinyl_crackle(DUR + 1.0, seed=23) * 0.5
    tr.mix[:, 1] += vinyl_crackle(DUR + 1.0, seed=29) * 0.5
    out = tr.finished()
    out = np.stack([spectral_filter(out[:, 0], 8800, 'low'),
                    spectral_filter(out[:, 1], 8800, 'low')], axis=1)
    return out, 'Demo Lofi', 80

# ============================================================== DEMO EDM
def render_edm():
    BPM, BEAT = 128, 60.0 / 128
    BAR = 4 * BEAT
    BARS = 16
    DUR = BARS * BAR + 1.4                   # ~31.4 s
    tr = Track(DUR)
    K, S, C = kick(), snare(), clap()
    H = hat()
    HO = hat(open_=True)

    # vi–IV–I–V in C: Am  F  C  G
    prog = [
        (45, [57, 60, 64]),   # Am
        (41, [57, 60, 65]),   # F
        (48, [55, 60, 64]),   # C
        (43, [55, 59, 62]),   # G
    ]
    # original 16th lead riff (1 bar, transposed per chord root motion)
    riff = [(0, 69), (1, 72), (2, 76), (3, 72), (4, 74), (5, 72), (6, 69), (7, 67),
            (8, 69), (9, 72), (10, 76), (11, 79), (12, 76), (13, 72), (14, 74), (15, 71)]

    def sidechain_duck(n, kick_times):
        """Pumping gain curve synced to kicks."""
        g = np.ones(n)
        t = np.arange(n) / SR
        for kt in kick_times:
            dt = t - kt
            m = dt >= 0
            g[m] *= (1.0 - 0.65 * np.exp(-dt[m] * 7.0))
        return g

    chord_bus_n = int(DUR * SR)
    chord_bus = np.zeros((chord_bus_n, 2))
    lead_bus = np.zeros((chord_bus_n, 2))
    kick_times = []

    for b in range(BARS):
        t0 = b * BAR
        root, chord = prog[b % 4]
        full = b >= 2
        # --- four-on-the-floor
        for q in range(4):
            kt = t0 + q * BEAT
            tr.add(K, kt, gain=1.0, pan=0.0)
            kick_times.append(kt)
        if full:
            for q in (1, 3):
                tr.add(S, t0 + q * BEAT, gain=0.62, pan=0.05)
                tr.add(C, t0 + q * BEAT, gain=0.5, pan=-0.05)
            for e in range(8):
                if e % 2 == 1:
                    i = int((t0 + e * BEAT / 2) * SR)
                    j = min(chord_bus_n, i + HO.shape[0])
                    if j > i:
                        st = pan_stereo(HO, 0.4) * 0.4
                        tr.mix[i:j] += st[:j - i]
                else:
                    tr.add(H, t0 + e * BEAT / 2, gain=0.3, pan=-0.35)
        else:
            # intro: hats only
            for e in range(8):
                tr.add(H, t0 + e * BEAT / 2, gain=0.28, pan=-0.3)
        if b == 2 or b == 14:
            tr.add(crash(1.4), t0, gain=0.7, pan=0.0)
        # --- driving 16th bass
        if full:
            pat = [0, 0, 12, 0, 0, 0, 7, 0, 0, 0, 12, 0, 10, 0, 7, 5]
            for s16, iv in enumerate(pat):
                m = root + iv
                tr.add(note(mtof(m), BAR / 16 * 0.9, wave='saw', vel=0.55,
                            a=0.003, d=0.03, s=0.55, r=0.03, lp=1400),
                       t0 + s16 * BAR / 16, pan=-0.05)
        # --- supersaw offbeat stabs -> chord bus (sidechained later)
        if full:
            for off in (0.5, 1.5, 2.5, 3.5):
                st = chord_stab([c + 12 for c in chord], BEAT * 0.42,
                                vel=0.30, lp=7500, detune=9.0)
                st = pan_stereo(st, 0.0)
                i = int((t0 + off * BEAT) * SR)
                j = min(chord_bus_n, i + st.shape[0])
                if j > i:
                    chord_bus[i:j] += st[:j - i]
        # --- lead riff -> lead bus
        if full:
            base = chord[0] + 12
            rel = riff[0][1]
            for s16, rm in riff:
                m = base + (rm - rel)
                st = note(mtof(m), BAR / 16 * 0.88, wave='saw', vel=0.38,
                          a=0.005, d=0.03, s=0.7, r=0.05,
                          detune_cents=7, vib_rate=6.0, vib_depth=0.003, lp=8200)
                st = pan_stereo(st, 0.12)
                i = int((t0 + s16 * BAR / 16) * SR)
                j = min(chord_bus_n, i + st.shape[0])
                if j > i:
                    lead_bus[i:j] += st[:j - i]
        # --- riser into bar 15
        if b == 13:
            rng = np.random.default_rng(31)
            n = int(2 * BAR * SR)
            nz = rng.standard_normal(n)
            sw = np.linspace(400, 9000, n)
            # rising brightness: blend progressively less-filtered noise
            seg = n // 8
            ris = np.zeros(n)
            for k in range(8):
                a0, a1 = k * seg, min(n, (k + 1) * seg)
                part = spectral_filter(nz[a0:a1], 400 + k * 1100, 'high')
                ris[a0:a1] = part * np.linspace(0.1, 1.0, 8)[k]
            ris = ris * np.linspace(0.05, 1.0, n) ** 2 * 0.5
            st = pan_stereo(ris.astype(np.float32), 0.0)
            i = int(t0 * SR)
            tr.mix[i:i + n] += st
            # snare roll
            for s16 in range(32):
                tr.add(S, t0 + s16 * (2 * BAR) / 32,
                       gain=0.25 + 0.45 * s16 / 32, pan=0.0)

    # apply sidechain pump to chord + lead buses
    duck = sidechain_duck(chord_bus_n, kick_times)
    tr.mix += chord_bus * duck[:, None] * 1.0
    tr.mix += lead_bus * duck[:, None] * 1.0
    # final bar: everything stops, let tail ring
    return tr.finished(), 'Demo EDM', 128

# ============================================================== TRAP (140)
def render_trap():
    BPM, BEAT = 140, 60.0 / 140
    BAR = 4 * BEAT
    BARS = 20
    DUR = BARS * BAR                       # ~34.3 s
    tr = Track(DUR + 1.2)
    K, S = kick(), snare()
    H = hat()
    # Am – F – C – G (dark minor loop)
    prog = [45, 41, 48, 43]
    # dark bell motif, 4-bar phrases (original)
    bell = [
        [(0, 1.5, 76), (2, 1, 74), (3, 1.5, 72)],
        [(0, 2, 71), (2.5, 1, 74)],
        [(0, 1.5, 72), (2, 1, 76), (3, 1.5, 79)],
        [(0, 2.5, 76), (3, 1, 74)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        root = prog[b % 4]
        full = b >= 4
        # --- hats: 16ths, rolls on every 4th bar tail
        for s16 in range(16):
            tr.add(H, t0 + s16 * BAR / 16, gain=0.30 if s16 % 2 == 0 else 0.18,
                   pan=0.3 if s16 % 2 else -0.3)
        if b % 4 == 3:
            for r in range(8):  # 32nd roll into next bar
                tr.add(H, t0 + 3 * BEAT + r * BEAT / 8, gain=0.16 + 0.02 * r, pan=0.0)
        # --- snare on beat 3 (trap backbeat)
        tr.add(S, t0 + 2 * BEAT, gain=0.75 if full else 0.5, pan=0.05)
        if full:
            # --- syncopated kick + long 808s
            tr.add(K, t0, gain=0.9, pan=0.0)
            tr.add(K, t0 + 2.5 * BEAT, gain=0.85, pan=0.0)
            tr.add(bass808(mtof(root - 12), BEAT * 1.6, vel=0.9), t0, pan=0.0)
            tr.add(bass808(mtof(root - 12), BEAT * 1.1,
                           glide_to=mtof(root - 12 - 3), vel=0.85), t0 + 2.5 * BEAT, pan=0.0)
            if b % 4 == 3:
                tr.add(K, t0 + 3.5 * BEAT, gain=0.8, pan=0.0)
                tr.add(bass808(mtof(root - 12), BEAT * 0.9,
                               glide_to=mtof(root - 12 + 7), vel=0.8), t0 + 3.5 * BEAT, pan=0.0)
        # --- dark bell motif
        for off, ln, m in bell[b % 4]:
            tr.add(bell_note(mtof(m), ln * BEAT * 1.4, vel=0.42),
                   t0 + off * BEAT, pan=-0.15)
        # --- sparse counter hats melody layer (intro texture)
        if not full and b % 2 == 0:
            tr.add(bell_note(mtof(root + 24), BEAT * 2.0, vel=0.25), t0 + BEAT, pan=0.35)
    # final 808 slide-down
    tr.add(bass808(mtof(33), 1.1, glide_to=mtof(24), vel=0.9), (BARS - 1) * BAR + 2 * BEAT, pan=0.0)
    return tr.finished(), 'Trap', 140

# ============================================================== ACOUSTIC (90)
def render_acoustic():
    BPM, BEAT = 90, 60.0 / 90
    BAR = 4 * BEAT
    BARS = 12
    DUR = BARS * BAR                        # 32 s
    tr = Track(DUR + 1.0)
    K = kick()
    H = hat()
    # C – G – Am – F
    prog = [([48, 52, 55], 36), ([43, 47, 50], 31), ([45, 48, 52], 33), ([41, 45, 48], 29)]
    # gentle plucked melody (original)
    mel = [
        [(0, 1, 76), (2, 1, 79)],
        [(0, 2, 83), (2.5, 1, 81)],
        [(0, 1, 81), (1, 1, 79), (2, 2, 76)],
        [(0, 2, 77), (2.5, 1, 76)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        chord, root = prog[b % 4]
        # --- fingerpicked 8ths: root, inner voices
        pat = [root + 12, chord[1], chord[2], chord[1], chord[0], chord[1], chord[2], chord[1] + 12]
        for e, m in enumerate(pat):
            tr.add(pluck_note(mtof(m), 0.55, vel=0.55 if e % 2 == 0 else 0.42),
                   t0 + e * BEAT / 2, pan=0.18 if e % 2 else -0.18)
        # --- warm pad, slow bloom
        for i, m in enumerate(chord):
            tr.add(note(mtof(m), BAR * 0.98, wave='saw', vel=0.16, a=0.5, d=0.3,
                        s=0.85, r=0.4, detune_cents=8, lp=2600),
                   t0 + i * 0.02, pan=-0.25 + 0.12 * i)
        # --- soft pulse + brush
        tr.add(K, t0, gain=0.45, pan=0.0)
        tr.add(K, t0 + 2 * BEAT, gain=0.38, pan=0.0)
        for e in range(8):
            tr.add(H, t0 + e * BEAT / 2, gain=0.10, pan=0.4)
        # --- melody from bar 4
        if b >= 4:
            for off, ln, m in mel[b % 4]:
                tr.add(pluck_note(mtof(m), ln * BEAT, vel=0.5),
                       t0 + off * BEAT, pan=0.12)
    return tr.finished(), 'Acoustic', 90

# ============================================================== SYNTHWAVE (100)
def render_synthwave():
    BPM, BEAT = 100, 0.6
    BAR = 4 * BEAT
    BARS = 14
    DUR = BARS * BAR                         # 33.6 s
    tr = Track(DUR + 1.0)
    K, S = kick(), snare()
    H = hat()
    # Am – F – C – G
    prog = [([57, 60, 64], 33), ([57, 60, 65], 29), ([55, 60, 64], 36), ([55, 59, 62], 31)]
    # retro lead with glides (original)
    lead = [
        [(0, 1, 69, 72), (1, 1, 72, 72), (2, 2, 74, 76)],
        [(0, 1, 77, 76), (1.5, 1, 74, 74), (2.5, 1.5, 72, 71)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        chord, root = prog[b % 4]
        full = b >= 2
        # --- driving 8th bass
        for e in range(8):
            m = root + (12 if e % 4 == 3 else 0)
            tr.add(note(mtof(m), BEAT * 0.46, wave='saw', vel=0.5, a=0.004,
                        d=0.04, s=0.6, r=0.04, lp=750), t0 + e * BEAT / 2, pan=-0.08)
        # --- gated-style pad: 8th tremolo on detuned saws
        n = int(BAR * SR)
        pad = np.zeros(n)
        for i, m in enumerate(chord):
            pad += osc(mtof(m), n, 'saw', detune_cents=9 if i % 2 else -9)
        pad /= len(chord)
        tt = np.arange(n) / SR
        gate = 0.45 + 0.55 * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * (2 / BAR) * tt + 0.4)))
        pad = pad * gate * adsr_env(n, 0.05, 0.1, 0.9, 0.25) * 0.30
        pad = spectral_filter(pad, 5200, 'low').astype(np.float32)
        tr.add(pan_stereo(pad, 0.0), t0)
        if full:
            # --- drums: 4-floor, snare + gated-echo repeats, 8th hats
            for q in range(4):
                tr.add(K, t0 + q * BEAT, gain=0.8, pan=0.0)
            tr.add(S, t0 + BEAT, gain=0.6, pan=0.05)
            tr.add(S, t0 + 3 * BEAT, gain=0.6, pan=0.05)
            for rep, g in ((0.28, 0.30), (0.56, 0.15)):
                tr.add(S, t0 + BEAT + rep * BEAT, gain=g, pan=0.3)
                tr.add(S, t0 + 3 * BEAT + rep * BEAT, gain=g, pan=-0.3)
            for e in range(8):
                tr.add(H, t0 + e * BEAT / 2, gain=0.26 if e % 2 == 0 else 0.16, pan=0.32)
            # --- glide lead
            for off, ln, f0m, f1m in lead[(b // 2) % 2]:
                tr.add(glide_note(mtof(f0m), mtof(f1m), ln * BEAT * 0.95, vel=0.42),
                       t0 + off * BEAT, pan=0.1)
    return tr.finished(), 'Synthwave', 100

# ============================================================== SUFI (85)
def render_sufi():
    BPM, BEAT = 85, 60.0 / 85
    BAR = 4 * BEAT
    BARS = 12
    DUR = BARS * BAR                          # ~33.9 s
    tr = Track(DUR + 1.5)
    DHA, GE, NA = tabla_dha(), tabla_ge(), tabla_na()
    # Am – G – F – E (emotional Andalusian-style loop; original melody)
    prog = [45, 43, 41, 40]
    # harmonium-like lead phrases (original, natural minor)
    lead = [
        [(0, 2, 69), (2, 1.5, 71)],
        [(0, 1, 72), (1, 1, 71), (2, 2, 69)],
        [(0, 2, 67), (2, 1.5, 69)],
        [(0, 1, 71), (1, 1, 69), (2, 1, 67), (3, 1, 64)],
        [(0, 3, 69), (3, 1, 71)],
        [(0, 1.5, 72), (1.5, 1, 74), (2.5, 1.5, 72)],
        [(0, 2, 71), (2, 2, 69)],
        [(0, 1, 67), (1, 1, 64), (2, 2, 62)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        root = prog[b % 4]
        # --- keherwa-style 8-beat theka on 8ths: DHA GE GE TI NA KA DHI NA
        theka = [(DHA, 0.85), (GE, 0.7), (GE, 0.7), (NA, 0.55),
                 (NA, 0.7), (NA, 0.5), (DHA, 0.8), (NA, 0.65)]
        for e, (dr, g) in enumerate(theka):
            tr.add(dr, t0 + e * BEAT / 2, gain=g, pan=0.12 if e % 2 else -0.12)
        # --- tanpura-like drone: root / fifth / octave plucks each beat
        for q, m in enumerate([root - 12, root - 5, root, root - 5]):
            tr.add(piano_note(mtof(m), 1.8, vel=0.30), t0 + q * BEAT, pan=-0.3)
        # --- harmonium-like lead from bar 2
        if b >= 2:
            for off, ln, m in lead[b % 8]:
                tr.add(note(mtof(m), ln * BEAT * 0.96, wave='saw', vel=0.44,
                            a=0.09, d=0.12, s=0.85, r=0.18, detune_cents=4,
                            vib_rate=5.0, vib_depth=0.006, lp=4500),
                       t0 + off * BEAT, pan=0.08)
        # --- soft low swell under phrases
        if b % 4 == 0:
            tr.add(note(mtof(root - 24), BAR, wave='sine', vel=0.35, a=0.6,
                        d=0.4, s=0.9, r=0.8), t0, pan=0.0)
    return tr.finished(), 'Sufi', 85

# ============================================================== DANCE (124)
def render_dance():
    BPM, BEAT = 124, 60.0 / 124
    BAR = 4 * BEAT
    BARS = 16
    DUR = BARS * BAR                           # ~31 s
    tr = Track(DUR + 0.6)
    K, S, C = kick(), snare(), clap()
    H = hat()
    HO = hat(open_=True)
    # C – Am – F – G
    prog = [([48, 55, 64], 36), ([45, 52, 60], 33), ([41, 48, 57], 29), ([43, 50, 59], 31)]
    # catchy lead riff (original)
    riff = [
        [(0, 0.5, 76), (0.5, 0.5, 79), (1, 0.5, 81), (1.5, 0.5, 79),
         (2, 0.5, 84), (2.5, 0.5, 81), (3, 1, 79)],
        [(0, 0.5, 81), (0.5, 0.5, 79), (1, 0.5, 76), (1.5, 0.5, 79),
         (2, 1, 83), (3, 1, 81)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        chord, root = prog[b % 4]
        # --- party drums
        for q in range(4):
            tr.add(K, t0 + q * BEAT, gain=0.95, pan=0.0)
        for q in (1, 3):
            tr.add(C, t0 + q * BEAT, gain=0.55, pan=0.0)
            tr.add(S, t0 + q * BEAT, gain=0.4, pan=0.05)
        for e in range(8):
            if e % 2 == 1:
                tr.add(HO, t0 + e * BEAT / 2, gain=0.38, pan=0.35)
            else:
                tr.add(H, t0 + e * BEAT / 2, gain=0.28, pan=-0.35)
        for s16 in range(16):
            tr.add(H, t0 + s16 * BAR / 16, gain=0.10, pan=0.5)
        # --- funky 16th bass with rests
        bpat = [0, -1, 0, -1, 12, -1, 0, 7, -1, 0, -1, 0, 10, -1, 7, 5]
        for s16, iv in enumerate(bpat):
            if iv < 0:
                continue
            tr.add(note(mtof(root + iv), BAR / 16 * 0.9, wave='saw', vel=0.55,
                        a=0.004, d=0.04, s=0.55, r=0.04, lp=1100),
                   t0 + s16 * BAR / 16, pan=-0.06)
        # --- brass-ish offbeat stabs
        for off in (0.5, 1.5, 2.5, 3.5):
            y = np.zeros(int(BEAT * 0.4 * SR))
            for i, m in enumerate(chord):
                y += osc(mtof(m + 12), len(y), 'saw', detune_cents=7 if i % 2 else -7)
            y /= len(chord)
            y = (y * adsr_env(len(y), 0.01, 0.05, 0.7, 0.1) * 0.34)
            y = spectral_filter(y, 5200, 'low').astype(np.float32)
            tr.add(pan_stereo(y, 0.0), t0 + off * BEAT)
        # --- lead riff
        for off, ln, m in riff[b % 2]:
            tr.add(note(mtof(m), ln * BEAT * 0.92, wave='square', vel=0.34,
                        a=0.008, d=0.05, s=0.8, r=0.08, lp=7200),
                   t0 + off * BEAT, pan=0.1)
    return tr.finished(), 'Dance', 124

# ============================================================== PIANO (75)
def render_piano():
    BPM, BEAT = 75, 0.8
    BAR = 4 * BEAT
    BARS = 10
    DUR = BARS * BAR                            # 32 s
    tr = Track(DUR + 2.0)
    K = kick()
    # C – G – Am – F – C – G – Am – F – C – G
    prog = [48, 43, 45, 41, 48, 43, 45, 41, 48, 43]
    chords = {48: [48, 52, 55], 43: [43, 47, 50], 45: [45, 48, 52], 41: [41, 45, 48]}
    # emotional right-hand lines (original), 2-bar phrases
    rh = [
        [(0, 1.5, 76), (2, 1, 79), (3, 1.5, 81)],
        [(0, 2, 83), (2.5, 1.5, 81)],
        [(0, 1, 81), (1, 1, 79), (2, 1.5, 76), (3.5, 0.5, 74)],
        [(0, 3, 76), (3, 1, 74)],
        [(0, 1.5, 72), (2, 1, 74), (3, 1.5, 76)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        root = prog[b]
        chord = chords[root]
        # --- left hand: root + fifth
        tr.add(piano_note(mtof(root - 12), 2.2, vel=0.62), t0, pan=-0.12)
        tr.add(piano_note(mtof(root - 5), 1.8, vel=0.5), t0 + 2 * BEAT, pan=-0.12)
        # --- mid voices, soft
        for i, m in enumerate(chord):
            tr.add(piano_note(mtof(m), 2.6, vel=0.34), t0 + i * 0.03, pan=0.1)
        # --- right hand melody
        for off, ln, m in rh[b % 5]:
            tr.add(piano_note(mtof(m), ln * BEAT * 1.2, vel=0.6),
                   t0 + off * BEAT, pan=0.14)
        # --- strings pad from bar 2
        if b >= 2:
            for i, m in enumerate(chord):
                tr.add(note(mtof(m), BAR * 0.98, wave='saw', vel=0.15, a=0.7,
                            d=0.4, s=0.9, r=0.6, detune_cents=10, lp=3000),
                       t0 + i * 0.03, pan=-0.2 + 0.13 * i)
        # --- heartbeat thump
        tr.add(K, t0, gain=0.32, pan=0.0)
    return tr.finished(), 'Piano', 75

# ============================================================== BOOM BAP (92)
def render_boombap():
    BPM, BEAT = 92, 60.0 / 92
    BAR = 4 * BEAT
    BARS = 12
    DUR = BARS * BAR                             # ~31.3 s
    tr = Track(DUR + 1.0)
    K, S = kick(), snare()
    H = hat()
    # Am9 – D9 – Gmaj7 – Cmaj9 (jazzy loop)
    prog = [
        (45, [57, 60, 64, 71]),
        (50, [54, 57, 60, 64]),
        (43, [55, 59, 62, 66]),
        (48, [60, 62, 64, 67]),
    ]
    # sparse jazzy licks (original)
    licks = [
        [(0.5, 1, 76), (2, 1.5, 74)],
        [(1, 1, 72), (2.5, 1, 76)],
        [(0.5, 2, 79), (2.5, 1, 77)],
        [(1.5, 1, 74), (2.5, 1.5, 72)],
    ]
    for b in range(BARS):
        t0 = b * BAR
        root, tones = prog[b % 4]
        # --- dusty boom-bap: kick 1 + lazy "and of 2", crunchy snare 2 & 4
        tr.add(K, t0, gain=0.85, pan=0.0)
        tr.add(K, t0 + 2.62 * BEAT, gain=0.7, pan=0.0)
        for q in (1, 3):
            tr.add(S, t0 + q * BEAT, gain=0.66, pan=0.05)
        for e in range(8):
            sw = 0.10 * BEAT if e % 2 == 1 else 0.0
            tr.add(H, t0 + e * BEAT / 2 + sw, gain=0.22 if e % 2 == 0 else 0.14,
                   pan=0.3 if e % 2 else -0.3)
        # --- rhodes chops on the "ands"
        for off in (0.5, 1.5, 2.5, 3.5):
            y = np.zeros(int(BEAT * 0.5 * SR))
            for m in tones:
                y += rhodes_note(mtof(m), BEAT * 0.5, vel=0.5)
            y /= len(tones)
            tr.add(pan_stereo((y * 0.8).astype(np.float32), -0.1), t0 + off * BEAT)
        # --- upright-ish bass
        tr.add(note(mtof(root - 12), BEAT * 1.1, wave='sine', vel=0.6,
                    a=0.008, d=0.08, s=0.7, r=0.15), t0, pan=0.0)
        tr.add(note(mtof(root - 12 + 7), BEAT * 0.8, wave='sine', vel=0.45,
                    a=0.008, d=0.08, s=0.7, r=0.15), t0 + 2.5 * BEAT, pan=0.0)
        # --- licks from bar 4
        if b >= 4:
            for off, ln, m in licks[b % 4]:
                tr.add(note(mtof(m), ln * BEAT * 0.9, wave='tri', vel=0.4,
                            a=0.015, d=0.1, s=0.75, r=0.2,
                            vib_rate=4.5, vib_depth=0.003, lp=4400),
                       t0 + off * BEAT, pan=0.15)
    tr.mix[:, 0] += vinyl_crackle(DUR + 1.0, seed=53) * 0.45
    tr.mix[:, 1] += vinyl_crackle(DUR + 1.0, seed=59) * 0.45
    out = tr.finished()
    out = np.stack([spectral_filter(out[:, 0], 9000, 'low'),
                    spectral_filter(out[:, 1], 9000, 'low')], axis=1)
    return out, 'Boom Bap', 92

# ------------------------------------------------------------------ main
# Shipped set: best 6 of 10 (quality > quantity; APK size). The other four
# renderers remain above for future expansion — just add them back here.
TRACKS = {'pop': render_pop, 'lofi': render_lofi, 'edm': render_edm,
          'trap': render_trap, 'sufi': render_sufi, 'piano': render_piano}
FILES = {'pop': 'pop.mp3', 'lofi': 'lofi.mp3', 'edm': 'edm.mp3',
         'trap': 'trap.mp3', 'sufi': 'sufi.mp3', 'piano': 'piano.mp3'}

def encode_mp3(stereo, path):
    pcm = np.ascontiguousarray(stereo, dtype=np.float32)
    cmd = ['ffmpeg', '-y', '-v', 'error',
           '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', 'pipe:0',
           '-b:a', '128k', '-ar', '44100', path]
    pr = subprocess.run(cmd, input=pcm.tobytes(), capture_output=True)
    if pr.returncode != 0:
        sys.stderr.write(pr.stderr.decode()[-2000:])
        raise RuntimeError('ffmpeg failed for ' + path)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  '..', 'www', 'music'))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for key, fn in TRACKS.items():
        print(f'[gen] rendering {key} …', flush=True)
        stereo, name, bpm = fn()
        dur = stereo.shape[0] / SR
        path = os.path.join(args.out, FILES[key])
        encode_mp3(stereo, path)
        size = os.path.getsize(path)
        print(f'[gen] {name}: {dur:.1f}s, {bpm} BPM, {size/1024:.0f} KB -> {path}')

if __name__ == '__main__':
    main()
