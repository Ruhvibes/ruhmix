'use strict';
/* =====================================================================
   RuhMix — v25-mixmaster.js
   W4: Vocal Mix + Transitions + Mastering (spec §9, §10, §11, §12).

   PURE LOGIC, no UI code. All processing is deterministic on-device DSP —
   every meta object carries engineTag: 'smart DSP'. NOTHING here is
   neural/AI and nothing may be labeled "AI mastering" or similar.

   Depends on: nothing (standalone). Optionally uses RM.audio.ensureCtx()
   for buffer allocation when present; otherwise falls back to an internal
   AudioBuffer shim, so this module also runs under plain node for tests.

   API (RM.v25mix):
     processVocal(buf, opts) -> { buffer, meta }
         Vocal chain: center (mono-sum) -> de-ess (real dynamic 4-8 kHz
         dip) -> harsh-resonance tamer (dynamic 2-5 kHz cut) -> gentle EQ
         (70 Hz HP + air shelf) -> gentle 3:1 compression.
     resolveOverlap(vocalA, vocalB, opts) -> { decision, score, ... }
         Deterministic policy from a compatibility score (key + tempo +
         energy): 'blend' | 'alternate' | 'backing' (-6 dB) | 'drop'.
     renderOverlap(a, b, opts) -> { buffer, meta }
         Resolves the policy and renders the mixed overlap.
     buildTransition(type, bars, ctx, opts) -> transition descriptor
         Beat-synced transition builders. ctx = { bpm, key, energy, sr }.
         Types: crossfade, smooth, fill, riser, downlifter, filter-sweep,
         echo-out, reverb-tail, vocal-chop, drop. All audio is SYNTHESIZED
         (oscillators + filtered noise) — no audio files, like beats.js.
         Every builder output is exactly bars x 4 beats long and all
         onsets sit on the beat grid.
     listTransitions() -> [{ id, name, desc }]
     master(buf, opts) -> { buffer, meta }
         Mastering: loudness normalize (Natural/Balanced/Loud targets) ->
         gentle mastering EQ -> 30 Hz high-pass -> v24 true-peak limiter
         (TP_CEIL 0.71 = -3 dBTP). The limiter runs LAST, so the output
         can never clip: measured true peak <= 0.71, guaranteed.
     buildAutomationCurve(sections, opts) -> { curve, bars, barLen, dbPerBar }
         Volume automation with a maximum slew of +/-3 dB per bar —
         no sudden jumps at section boundaries.
     applyAutomation(buf, curveObj) -> AudioBuffer (new buffer)

   Test hooks: RM.v25mix._test exposes the pure building blocks.
   ===================================================================== */
(function (root) {
  var RM = root.RM || (root.RM = {});

  /* ---------------- generic helpers ---------------- */
  function isAudioBuffer(b) {
    return !!(b && typeof b.getChannelData === 'function' &&
               typeof b.numberOfChannels === 'number' &&
               typeof b.length === 'number' && typeof b.sampleRate === 'number');
  }

  // Minimal AudioBuffer stand-in for environments without Web Audio (node tests).
  function shimBuffer(ch, len, sr) {
    var chans = [];
    for (var c = 0; c < ch; c++) chans.push(new Float32Array(len));
    return {
      numberOfChannels: ch,
      length: len,
      sampleRate: sr,
      duration: len / sr,
      getChannelData: function (c) { return chans[c]; },
    };
  }

  function allocBuffer(ch, len, sr) {
    try {
      if (RM.audio && typeof RM.audio.ensureCtx === 'function') {
        var ctx = RM.audio.ensureCtx();
        if (ctx && typeof ctx.createBuffer === 'function')
          return ctx.createBuffer(ch, len, sr);
      }
    } catch (e) { /* fall through to shim */ }
    return shimBuffer(ch, len, sr);
  }

  function dbToLin(db) { return Math.pow(10, db / 20); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------- musical key -> root frequency ---------------- */
  var NOTE_SEMI = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
                    F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8,
                    A: 9, 'A#': 10, Bb: 10, B: 11 };
  // Accepts 'A', 'C#', 'Bb', 'F minor', 'G major', or a MIDI number.
  // Unknown -> A4 (69). Never throws.
  function keyToRootMidi(key) {
    if (typeof key === 'number' && isFinite(key)) return Math.round(key);
    if (!key) return 69;
    var m = String(key).trim().match(/^([A-Ga-g])([#b♯♭])?/);
    if (!m) return 69;
    var acc = m[2] === '♯' ? '#' : (m[2] === '♭' ? 'b' : (m[2] || ''));
    var semi = NOTE_SEMI[m[1].toUpperCase() + acc];
    if (semi === undefined) return 69;
    return 69 + (semi - 9);
  }
  function rootFreq(key) {
    return 440 * Math.pow(2, (keyToRootMidi(key) - 69) / 12);
  }

  /* ---------------- RBJ biquads (pure JS, no Web Audio needed) ---------------- */
  // Standard RBJ cookbook coefficients. Used for the vocal EQ, the
  // de-esser / harsh-tamer detector bands, and the mastering EQ.
  function biquadCoeffs(type, f0, Q, gainDb, sr) {
    var w0 = 2 * Math.PI * f0 / sr;
    var cw = Math.cos(w0), sw = Math.sin(w0);
    var A = Math.pow(10, gainDb / 40);
    var alpha, b0, b1, b2, a0, a1, a2;
    if (type === 'peaking') {
      alpha = sw / (2 * Q);
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    } else if (type === 'lowshelf') {
      alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2);
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
      a0 = (A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
    } else if (type === 'highshelf') {
      alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2);
      b0 = A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
      a0 = (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
    } else if (type === 'highpass') {
      alpha = sw / (2 * Q);
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      alpha = sw / (2 * Q);
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else { // 'bandpass', constant 0 dB peak gain
      alpha = sw / (2 * Q);
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  // Direct Form I, in-place.
  function biquadInPlace(d, c) {
    var b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < d.length; i++) {
      var x = d[i];
      var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      d[i] = y;
    }
  }
  function biquadFiltered(d, c) {
    var o = new Float32Array(d.length);
    o.set(d);
    biquadInPlace(o, c);
    return o;
  }

  // RMS energy inside a frequency band (for tests + detector calibration).
  function bandEnergy(d, sr, fLo, fHi) {
    var f0 = Math.sqrt(fLo * fHi), q = f0 / (fHi - fLo);
    var band = biquadFiltered(d, biquadCoeffs('bandpass', f0, q, 0, sr));
    var s = 0;
    for (var i = 0; i < band.length; i++) s += band[i] * band[i];
    return s / Math.max(1, band.length);
  }

  /* =====================================================================
     v24 ALGORITHM PORTS — true-peak limiter + 30 Hz high-pass.
     These are VERBATIM ports of the v24 functions in mashup.js
     (softPeakLimit / truePeak4x / highPass30). Those live inside the
     RM.mashup closure and are not exported, so the identical recurrence
     is reproduced here — same TP_CEIL = 0.71 (-3 dBTP). Do not "improve"
     them: the MP3 round-trip proof (-1.57 dBTP <= -1 dBTP) was measured
     against exactly this code.
     ===================================================================== */
  var TP_CEIL = 0.71; // -3 dBTP true-peak ceiling -> post-MP3 decode stays under -1 dBTP
  function truePeak4x(d) {
    var peak = 0, i, a, b, m1, m2, m3;
    for (i = 0; i < d.length; i++) {
      a = Math.abs(d[i]); if (a > peak) peak = a;
      if (i + 1 < d.length) {
        b = Math.abs(d[i + 1]);
        m1 = (a * 3 + b) * 0.25; if (m1 > peak) peak = m1;
        m2 = (a + b) * 0.5;      if (m2 > peak) peak = m2;
        m3 = (a + b * 3) * 0.25; if (m3 > peak) peak = m3;
      }
    }
    return peak;
  }
  function softPeakLimit(buf) {
    var peak = 0, c, d, i, tp;
    for (c = 0; c < buf.numberOfChannels; c++) {
      d = buf.getChannelData(c);
      tp = truePeak4x(d); if (tp > peak) peak = tp;
    }
    if (peak <= TP_CEIL) return peak;
    var g = TP_CEIL / peak;
    for (c = 0; c < buf.numberOfChannels; c++) {
      d = buf.getChannelData(c);
      for (i = 0; i < d.length; i++) d[i] *= g;
    }
    return peak; // pre-limit true peak (mirrors the mashup.js signature)
  }
  function highPass30(d, sr) {
    var rc = 1 / (2 * Math.PI * 30), dt = 1 / sr, a = rc / (rc + dt), y = 0, p = 0, x;
    for (var i = 0; i < d.length; i++) { x = d[i]; y = a * (y + x - p); p = x; d[i] = y; }
  }

  /* ---------------- small DSP utilities ---------------- */
  // Peak envelope follower with independent attack/release. Returns Float32Array.
  function peakEnv(x, sr, attackSec, releaseSec) {
    var n = x.length;
    var env = new Float32Array(n);
    var aA = 1 - Math.exp(-1 / (Math.max(1e-4, attackSec) * sr));
    var aR = 1 - Math.exp(-1 / (Math.max(1e-4, releaseSec) * sr));
    var e = 0;
    for (var i = 0; i < n; i++) {
      var v = x[i] < 0 ? -x[i] : x[i];
      var c = v > e ? aA : aR;
      e += c * (v - e);
      env[i] = e;
    }
    return env;
  }

  function rmsArr(d) {
    var s = 0;
    for (var i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, d.length));
  }

  function maxAbs(d) {
    var m = 0;
    for (var i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
    return m;
  }

  // Deterministic PRNG (LCG) — synthesized noise is reproducible so tests
  // don't depend on Math.random.
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 4294967296) * 2 - 1;
    };
  }

  /* =====================================================================
     §9 — VOCAL MIX CHAIN
     processVocal(buf, opts): lead vocal, clear and centered.
       1. Center: stereo -> mono sum, written to both channels (the lead
          vocal sits in the middle of the mix, never hard-panned).
       2. De-ess (REAL): the 4-8 kHz sibilance band is split out with a
          bandpass; a peak follower tracks its envelope; when the envelope
          exceeds an adaptive threshold the band gets a dynamic gain dip
          (up to maxDipDb, default 8 dB). Only the sibilant band is
          touched — the rest of the vocal is bit-identical.
       3. Harsh-frequency taming (REAL): same dynamic-EQ topology on the
          2-5 kHz resonance band (up to 4 dB cut). Takes the edge off
          harsh "honk" without dulling the vocal.
       4. Gentle EQ: 1st-order-clean 70 Hz high-pass (removes mud/rumble)
          + a +1 dB air shelf at 12 kHz.
       5. Gentle compression: feedforward peak compressor, 3:1,
          -18 dBFS threshold, 10 ms attack / 100 ms release — levels the
          vocal without pumping.
     Returns { buffer, meta } with engineTag 'smart DSP' (never "AI").
     ===================================================================== */

  // Generic dynamic band-dip: split `bandC`-filtered band out of x, dip the
  // band when its envelope exceeds thrFactor x its own slow peak.
  function dynamicBandDip(x, sr, bandC, o) {
    o = o || {};
    var maxDipDb = o.maxDipDb != null ? o.maxDipDb : 6;
    var thrFactor = o.thrFactor != null ? o.thrFactor : 0.4;
    var ratio = o.ratio != null ? o.ratio : 1.5;
    var attackSec = o.attackSec != null ? o.attackSec : 0.002;
    var releaseSec = o.releaseSec != null ? o.releaseSec : 0.05;
    var band = biquadFiltered(x, bandC);
    var rest = new Float32Array(x.length);
    for (var i = 0; i < x.length; i++) rest[i] = x[i] - band[i];
    var env = peakEnv(band, sr, attackSec, releaseSec);
    var peak = 0;
    for (i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
    var thr = Math.max(1e-4, thrFactor * peak);
    var thrDb = 20 * Math.log10(thr);
    var out = new Float32Array(x.length);
    var dips = 0, maxDip = 0;
    for (i = 0; i < x.length; i++) {
      var g = 1;
      if (env[i] > thr) {
        var envDb = 20 * Math.log10(Math.max(1e-9, env[i]));
        var red = Math.min(maxDipDb, (envDb - thrDb) * ratio);
        if (red > 0.05) {
          dips++;
          if (red > maxDip) maxDip = red;
          g = dbToLin(-red);
        }
      }
      out[i] = rest[i] + band[i] * g;
    }
    return { out: out, dips: dips, maxDipDb: maxDip, threshold: thr };
  }

  function deEss(x, sr, opts) {
    // Sibilance lives 4-8 kHz: bandpass centered on the geometric mean.
    var f0 = Math.sqrt(4000 * 8000);
    var c = biquadCoeffs('bandpass', f0, f0 / 4000, 0, sr);
    var o = opts || {};
    return dynamicBandDip(x, sr, c, {
      maxDipDb: o.maxDipDb != null ? o.maxDipDb : 8,
      thrFactor: o.thrFactor != null ? o.thrFactor : 0.4,
      ratio: 1.5,
      attackSec: 0.002,   // catches the 's' onset
      releaseSec: 0.05,
    });
  }

  function harshTame(x, sr, opts) {
    // Harsh 2-5 kHz resonances: wider band, gentler and slower.
    var f0 = Math.sqrt(2000 * 5000);
    var c = biquadCoeffs('bandpass', f0, f0 / 3000, 0, sr);
    var o = opts || {};
    return dynamicBandDip(x, sr, c, {
      maxDipDb: o.maxDipDb != null ? o.maxDipDb : 4,
      thrFactor: o.thrFactor != null ? o.thrFactor : 0.5,
      ratio: 1.0,
      attackSec: 0.010,
      releaseSec: 0.150,
    });
  }

  // Gentle feedforward peak compressor, mono. Returns { out, maxGrDb }.
  function compressMono(x, sr, thrDb, ratio, attackSec, releaseSec) {
    var thr = dbToLin(thrDb);
    var aA = 1 - Math.exp(-1 / (Math.max(1e-4, attackSec) * sr));
    var aR = 1 - Math.exp(-1 / (Math.max(1e-4, releaseSec) * sr));
    var inv = 1 - 1 / ratio;
    var out = new Float32Array(x.length);
    var env = 0, maxGr = 0;
    for (var i = 0; i < x.length; i++) {
      var v = x[i] < 0 ? -x[i] : x[i];
      var c = v > env ? aA : aR;
      env += c * (v - env);
      var g = 1;
      if (env > thr && env > 1e-9) {
        var overDb = 20 * Math.log10(env / thr);
        var gr = overDb * inv;
        if (gr > maxGr) maxGr = gr;
        g = dbToLin(-gr);
      }
      out[i] = x[i] * g;
    }
    return { out: out, maxGrDb: maxGr };
  }

  function processVocal(buf, opts) {
    if (!isAudioBuffer(buf)) throw new Error('processVocal needs an audio buffer.');
    opts = opts || {};
    var sr = buf.sampleRate, n = buf.length, nCh = buf.numberOfChannels;
    if (!n) throw new Error('processVocal: the vocal buffer is empty.');

    // 1. Center: mono sum -> both channels.
    var mono = new Float32Array(n);
    for (var c = 0; c < nCh; c++) {
      var cd = buf.getChannelData(c);
      for (var i = 0; i < n; i++) mono[i] += cd[i];
    }
    for (i = 0; i < n; i++) mono[i] /= nCh;

    // 2. De-ess (real dynamic 4-8 kHz dip).
    var de = deEss(mono, sr, opts.deess);
    // 3. Harsh-resonance taming (real dynamic 2-5 kHz cut).
    var ht = harshTame(de.out, sr, opts.harsh);
    var x = ht.out;
    // 4. Gentle EQ: 70 Hz HP (mud out) + +1 dB air shelf @ 12 kHz.
    biquadInPlace(x, biquadCoeffs('highpass', 70, 0.7, 0, sr));
    biquadInPlace(x, biquadCoeffs('highshelf', 12000, 0.7, 1.0, sr));
    // 5. Gentle 3:1 compression.
    var comp = compressMono(x, sr, -18, 3, 0.010, 0.100);

    var outBuf = allocBuffer(2, n, sr);
    outBuf.getChannelData(0).set(comp.out);
    outBuf.getChannelData(1).set(comp.out);
    return {
      buffer: outBuf,
      meta: {
        engineTag: 'smart DSP',
        centered: true,
        deess: { dips: de.dips, maxDipDb: Math.round(de.maxDipDb * 10) / 10 },
        harshTame: { dips: ht.dips, maxDipDb: Math.round(ht.maxDipDb * 10) / 10 },
        compGrDb: Math.round(comp.maxGrDb * 10) / 10,
        peak: Math.round(maxAbs(comp.out) * 1000) / 1000,
        rms: Math.round(rmsArr(comp.out) * 10000) / 10000,
      },
    };
  }

  /* ---------------- overlap policy (§9) ---------------- */
  // Decides what to do when two vocals overlap. Deterministic — driven by
  // a compatibility score, never random.
  //   score = 0.40 * keyScore + 0.35 * bpmScore + 0.25 * energyScore
  //   >= 0.75 -> 'blend'      (sing together, both full)
  //   >= 0.55 -> 'alternate'  (take turns, 1-bar crossfade)
  //   >= 0.35 -> 'backing'    (B sits -6 dB behind A)
  //   else    -> 'drop'       (B is dropped, A carries the section)
  function semitoneDistance(keyA, keyB) {
    var a = keyToRootMidi(keyA) % 12, b = keyToRootMidi(keyB) % 12;
    var d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d); // 0..6
  }

  function resolveOverlap(vocalA, vocalB, opts) {
    opts = opts || {};
    var hasKey = opts.keyA != null && opts.keyB != null;
    var keyScore = hasKey ? 1 - semitoneDistance(opts.keyA, opts.keyB) / 6 : 0.5;
    var hasBpm = opts.bpmA > 0 && opts.bpmB > 0;
    var bpmScore = 0.5;
    if (hasBpm) {
      var r = Math.min(opts.bpmA, opts.bpmB) / Math.max(opts.bpmA, opts.bpmB);
      bpmScore = clamp((r - 0.85) / 0.15, 0, 1);
    }
    var energyScore = 0.5;
    if (isAudioBuffer(vocalA) && isAudioBuffer(vocalB)) {
      var eA = rmsArr(vocalA.getChannelData(0)), eB = rmsArr(vocalB.getChannelData(0));
      var mx = Math.max(eA, eB, 1e-6);
      energyScore = clamp(1 - Math.abs(eA - eB) / mx, 0, 1);
    } else if (opts.energyA != null && opts.energyB != null) {
      var m2 = Math.max(opts.energyA, opts.energyB, 1e-6);
      energyScore = clamp(1 - Math.abs(opts.energyA - opts.energyB) / m2, 0, 1);
    }
    var score = 0.40 * keyScore + 0.35 * bpmScore + 0.25 * energyScore;
    var decision, reason;
    if (score >= 0.75) {
      decision = 'blend';
      reason = 'Keys and tempo are compatible — both vocals sing together.';
    } else if (score >= 0.55) {
      decision = 'alternate';
      reason = 'Close enough to share the section — the vocals take turns.';
    } else if (score >= 0.35) {
      decision = 'backing';
      reason = 'Partial clash — the second vocal sits -6 dB behind the first.';
    } else {
      decision = 'drop';
      reason = 'Keys/tempo clash — the second vocal is dropped for this section.';
    }
    return {
      decision: decision,
      score: Math.round(score * 1000) / 1000,
      components: {
        keyScore: Math.round(keyScore * 1000) / 1000,
        bpmScore: Math.round(bpmScore * 1000) / 1000,
        energyScore: Math.round(energyScore * 1000) / 1000,
      },
      reason: reason,
      engineTag: 'smart DSP',
    };
  }

  function renderOverlap(a, b, opts) {
    if (!isAudioBuffer(a)) throw new Error('renderOverlap needs vocal A.');
    opts = opts || {};
    var res = resolveOverlap(a, b, opts);
    var sr = a.sampleRate;
    var len = a.length;
    var bLen = isAudioBuffer(b) ? b.length : 0;
    var n = Math.max(len, bLen);
    var out = allocBuffer(2, n, sr);
    var bpm = opts.bpmA > 0 ? opts.bpmA : 120;
    var barLen = Math.max(1, Math.round((240 / bpm) * sr));
    var xfade = Math.min(barLen, n); // 1-bar crossfade for 'alternate'
    for (var ch = 0; ch < 2; ch++) {
      var ad = a.getChannelData(Math.min(ch, a.numberOfChannels - 1));
      var bd = isAudioBuffer(b) ? b.getChannelData(Math.min(ch, b.numberOfChannels - 1)) : null;
      var od = out.getChannelData(ch);
      if (res.decision === 'blend') {
        for (var i = 0; i < n; i++)
          od[i] = (i < len ? ad[i] : 0) + (bd && i < bLen ? bd[i] : 0);
      } else if (res.decision === 'backing') {
        for (i = 0; i < n; i++)
          od[i] = (i < len ? ad[i] : 0) + (bd && i < bLen ? bd[i] * 0.5012 : 0); // -6 dB
      } else if (res.decision === 'alternate' && bd) {
        var half = Math.floor(n / 2);
        for (i = 0; i < n; i++) {
          var va = i < len ? ad[i] : 0, vb = i < bLen ? bd[i] : 0;
          var f; // 1-bar equal-power crossfade around the midpoint
          if (i < half - xfade / 2) f = 0;
          else if (i >= half + xfade / 2) f = 1;
          else {
            var t = (i - (half - xfade / 2)) / xfade;
            f = Math.sin(0.5 * Math.PI * t);
          }
          od[i] = va * Math.cos(0.5 * Math.PI * f) + vb * Math.sin(0.5 * Math.PI * f);
        }
      } else { // 'drop', or B missing
        for (i = 0; i < n; i++) od[i] = i < len ? ad[i] : 0;
      }
    }
    return {
      buffer: out,
      meta: {
        engineTag: 'smart DSP',
        decision: res.decision,
        score: res.score,
        reason: res.reason,
      },
    };
  }

  /* =====================================================================
     §10 — TRANSITION LIBRARY
     buildTransition(type, bars, ctx, opts): beat-synced transition
     builders. ctx = { bpm, key, energy (0..1), sr }.
       - Every builder output is EXACTLY bars x 4 beats long.
       - Every onset (fill hits, riser start, drop impact, chop slices,
         echo pulses) sits on the beat grid derived from ctx.bpm.
       - All effect audio is SYNTHESIZED from oscillators + filtered
         noise (like beats.js) — no audio files, no samples, no network.
       - `key` tunes pitched elements (riser sweep target, drop sub,
         reverb wash shimmer) to the song's root.
       - `energy` scales brightness/velocity (0 = mellow, 1 = hype).
     Returns a descriptor:
       { type, bars, lengthSamples, beatLen, barLen, bpm, key, energy,
         sampleRate,
         buffer,      // synthesized AudioBuffer to ADD to the mix (stereo), or null
         tailBuffer,  // extra audio appended AFTER the window end (reverb-tail), or null
         inGain,      // Float32Array gain curve for the incoming track, or null
         outGain,     // Float32Array gain curve for the outgoing track, or null
         filter,      // filter-sweep spec { direction, fromHz, toHz }, or null
         meta,        // { engineTag: 'smart DSP', ... per-type info }
         placeAt(mix, offsetSamples),  // sums buffer (+tailBuffer) into a mix
         applyTo(track, which) }       // 'in'|'out': new buffer with gains
                                          (+ filter sweep) applied
     Usage at a section boundary B (sample index):
       out = transition.applyTo(outgoingTrack, 'out')   // over [B-N, B)
       in  = transition.applyTo(incomingTrack, 'in')    // over [B-N, B)
       transition.placeAt(mix, B - N)                   // synth FX at [B-N, B)
     ===================================================================== */

  var TRANSITION_TYPES = [
    { id: 'crossfade',   name: 'Crossfade',         desc: 'Equal-power crossfade, beat-synced (4/8/16/32 bars).' },
    { id: 'smooth',      name: 'Smooth Crossfade',  desc: 'S-curve equal-power crossfade — softer ends.' },
    { id: 'fill',        name: 'Drum Fill',         desc: 'Synthesized drum fill rolling into the boundary.' },
    { id: 'riser',       name: 'Riser',             desc: 'Synthesized noise + pitch sweep riser, key-aware.' },
    { id: 'downlifter',  name: 'Downlifter',        desc: 'Synthesized pitch-drop whoosh.' },
    { id: 'filter-sweep',name: 'Filter Sweep',      desc: 'Time-varying low-pass sweep (DSP, no files).' },
    { id: 'echo-out',    name: 'Echo Out',          desc: 'Beat-synced echo gate on the outgoing track.' },
    { id: 'reverb-tail', name: 'Reverb Tail',       desc: 'Synthesized wash tail ringing past the boundary.' },
    { id: 'vocal-chop',  name: 'Vocal Chop',        desc: 'Beat-sliced gate for the incoming vocal.' },
    { id: 'drop',        name: 'Drop',              desc: 'Pullback + synthesized impact on the boundary.' },
  ];

  function listTransitions() {
    return TRANSITION_TYPES.map(function (t) {
      return { id: t.id, name: t.name, desc: t.desc };
    });
  }

  function gridFor(ctx) {
    ctx = ctx || {};
    var bpm = ctx.bpm > 0 ? ctx.bpm : 120;
    bpm = clamp(bpm, 40, 240);
    var sr = ctx.sr > 0 ? Math.round(ctx.sr) : 44100;
    var key = ctx.key != null ? ctx.key : 'A';
    var energy = ctx.energy != null ? clamp(ctx.energy, 0, 1) : 0.7;
    var beatLen = Math.max(1, Math.round((60 / bpm) * sr));
    return {
      bpm: bpm, sr: sr, key: key, energy: energy,
      rootHz: rootFreq(key), beatLen: beatLen, barLen: 4 * beatLen,
    };
  }

  /* ---------------- synthesized drum primitives (pure sample math) ---------------- */
  function addKick(d, at, sr, vol, fStart, fEnd, dur) {
    var n = Math.min(d.length - at, Math.max(1, Math.floor(dur * sr)));
    if (at < 0 || n <= 0) return;
    var phase = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var f = fEnd + (fStart - fEnd) * Math.exp(-t * 28);
      phase += 2 * Math.PI * f / sr;
      d[at + i] += vol * (Math.sin(phase) * Math.exp(-t * 8) +
                          0.25 * Math.sin(phase * 2.02) * Math.exp(-t * 55));
    }
  }
  function addSnare(d, at, sr, vol, rng, bodyHz) {
    var n = Math.min(d.length - at, Math.floor(0.22 * sr));
    if (at < 0 || n <= 0) return;
    var phase = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      phase += 2 * Math.PI * bodyHz / sr;
      d[at + i] += vol * (0.65 * rng() * Math.exp(-t * 30) +
                          0.50 * Math.sin(phase) * Math.exp(-t * 45));
    }
  }
  function addHat(d, at, sr, vol, rng, open) {
    var n = Math.min(d.length - at, Math.floor((open ? 0.30 : 0.06) * sr));
    if (at < 0 || n <= 0) return;
    var prev = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var nz = rng();
      var hp = nz - prev; prev = nz; // crude high-pass: hats are all brightness
      d[at + i] += vol * hp * 0.5 * Math.exp(-t * (open ? 14 : 90));
    }
  }
  function addCrash(d, at, sr, vol, rng, dur) {
    var n = Math.min(d.length - at, Math.floor((dur || 1.2) * sr));
    if (at < 0 || n <= 0) return;
    var prev = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var nz = rng();
      var hp = nz - prev; prev = nz;
      d[at + i] += vol * hp * 0.45 * Math.exp(-t * 3.5);
    }
  }

  /* ---------------- synthesized transition elements ---------------- */
  function synthRiser(len, g, rng) {
    var d = new Float32Array(len);
    var phase = 0, lp = 0;
    for (var i = 0; i < len; i++) {
      var t = i / len;
      var f = g.rootHz * Math.pow(2, t); // rises exactly one octave, key-aware
      phase += 2 * Math.PI * f / g.sr;
      var nz = rng();
      lp += (0.05 + 0.50 * t) * (nz - lp); // brightens as it climbs
      var env = t * t;                     // exponential swell
      d[i] = env * (0.55 * Math.sin(phase) * (0.35 + 0.65 * g.energy) +
                    0.75 * lp * (0.40 + 0.60 * g.energy));
    }
    var fi = Math.min(len, Math.max(1, Math.round(0.010 * g.sr))); // click-free start
    for (i = 0; i < fi; i++) d[i] *= (i + 1) / fi;
    return d;
  }

  function synthDownlifter(len, g, rng) {
    var d = new Float32Array(len);
    var phase = 0, lp = 0;
    for (var i = 0; i < len; i++) {
      var t = i / len;
      var f = g.rootHz * 2 * Math.pow(2, -t); // falls one octave from 2x root
      phase += 2 * Math.PI * f / g.sr;
      var nz = rng();
      lp += (0.50 - 0.45 * t) * (nz - lp);
      var env = (1 - t) * (1 - t);
      d[i] = env * (0.55 * Math.sin(phase) * (0.35 + 0.65 * g.energy) +
                    0.75 * lp * (0.40 + 0.60 * g.energy));
    }
    var fo = Math.min(len, Math.max(1, Math.round(0.010 * g.sr))); // click-free end
    for (i = 0; i < fo; i++) d[len - 1 - i] *= (i + 1) / fo;
    return d;
  }

  // Synthesized drum fill, fillBars long (1 or 2). Bar 1 (if present):
  // kick 1 & 3, snare 2 & 4, 8th hats. Final bar: 16th snare roll with
  // rising velocity straight into the boundary. All hits on the grid.
  function synthFill(g, rng, fillBars) {
    var len = fillBars * g.barLen;
    var d = new Float32Array(len);
    var s16 = g.beatLen / 4;
    var rollOff = fillBars > 1 ? g.barLen : 0;
    if (fillBars > 1) {
      for (var b = 0; b < 4; b++) {
        var bt = Math.round(b * g.beatLen);
        if (b === 0 || b === 2) addKick(d, bt, g.sr, 0.9, 150, 50, 0.30);
        else addSnare(d, bt, g.sr, 0.70, rng, 190);
      }
      for (b = 0; b < 8; b++)
        addHat(d, Math.round(b * g.beatLen / 2), g.sr, 0.30 + 0.25 * g.energy, rng, false);
    }
    addKick(d, rollOff, g.sr, 0.9, 150, 50, 0.30);
    for (var s = 0; s < 16; s++) {
      var vel = 0.30 + 0.70 * (s / 15) * (0.5 + 0.5 * g.energy);
      addSnare(d, rollOff + Math.round(s * s16), g.sr, vel, rng, 190);
    }
    return d;
  }

  function synthWashTail(g, rng, tailBars) {
    var len = tailBars * g.barLen;
    var d = new Float32Array(len);
    var lp = 0, sPhase = 0;
    for (var i = 0; i < len; i++) {
      var t = i / len;
      lp += 0.50 * Math.pow(0.02, t) * (rng() - lp); // darkens as it decays
      sPhase += 2 * Math.PI * g.rootHz * 2 / g.sr;    // key shimmer, low level
      d[i] = Math.exp(-t * 5.5) * (0.8 * lp + 0.15 * Math.sin(sPhase));
    }
    return d;
  }

  // Drop: pullback over the first (bars-1) bars, snare-build in the final
  // bar, and the impact transient onset EXACTLY on the final beat
  // (impactOnset = N - beatLen: beat-aligned, and it IS the bar boundary
  // when the window is placed to end at the boundary).
  function synthDrop(N, bars, g, rng) {
    var d = new Float32Array(N);
    var onset = N - g.beatLen;
    var pullEnd = (bars - 1) * g.barLen;
    var subF = Math.max(30, g.rootHz / 2);
    var lp = 0, phase = 0, i;
    for (i = 0; i < pullEnd; i++) { // pullback: lowpassed wash + sub throb
      var t = i / Math.max(1, pullEnd);
      lp += 0.08 * (rng() - lp);
      phase += 2 * Math.PI * subF / g.sr;
      var env = (1 - t) * 0.5;
      d[i] = env * (0.6 * lp + 0.5 * Math.sin(phase) * (0.5 + 0.5 * g.energy));
    }
    var barStart = (bars - 1) * g.barLen;
    var rPhase = 0;
    for (i = barStart; i < onset; i++) { // final bar: riser-lite
      var tt = (i - barStart) / Math.max(1, onset - barStart);
      rPhase += 2 * Math.PI * g.rootHz * Math.pow(2, tt) / g.sr;
      d[i] += tt * tt * 0.5 * Math.sin(rPhase);
    }
    for (var s = 0; s < 4; s++) // quarter-note snare build
      addSnare(d, barStart + Math.round(s * g.beatLen), g.sr, 0.40 + 0.15 * s, rng, 200);
    addKick(d, onset, g.sr, 1.0, 120, 40, 0.60); // IMPACT
    var n2 = Math.min(d.length - onset, Math.floor(0.8 * g.sr));
    var sPhase = 0;
    for (i = 0; i < n2; i++) { // sub drop at the key root
      var t2 = i / g.sr;
      sPhase += 2 * Math.PI * subF / g.sr;
      d[onset + i] += 0.7 * Math.sin(sPhase) * Math.exp(-t2 * 5);
    }
    addCrash(d, onset, g.sr, 0.5 * (0.5 + 0.5 * g.energy), rng, 1.0);
    return { data: d, impactOnset: onset };
  }

  /* ---------------- gain-curve builders (all beat-grid aligned) ---------------- */
  function fadeCurve(N, dirIn, shape) {
    var d = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var t = N > 1 ? i / (N - 1) : 0;
      var v;
      if (shape === 'smooth') {
        v = t * t * t * (t * (t * 6 - 15) + 10); // smootherstep: soft ends
        d[i] = dirIn ? v : 1 - v;
      } else { // equal power: sin/cos
        d[i] = dirIn ? Math.sin(0.5 * Math.PI * t) : Math.cos(0.5 * Math.PI * t);
      }
    }
    return d;
  }

  // Echo-out: the outgoing track is gated into decaying pulses on the
  // half-beat grid — a beat-synced echo feel with zero delay lines.
  function echoOutGain(N, g) {
    var out = new Float32Array(N);
    var halfBeat = Math.max(1, Math.round(g.beatLen / 2));
    var pulseW = Math.min(Math.max(1, Math.round(0.040 * g.sr)), halfBeat);
    for (var i = 0; i < N; i++) {
      var k = Math.floor(i / halfBeat);
      if (i % halfBeat < pulseW) out[i] = Math.pow(0.65, k);
    }
    return out;
  }

  // Vocal chop: deterministic 16th-note gate (no randomness — the same
  // input always chops the same way), 5 ms raised-cosine edges: no clicks.
  var CHOP_PATTERN = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1];
  function vocalChopGain(N, g) {
    var out = new Float32Array(N);
    var s16 = g.beatLen / 4;
    var edge = Math.max(1, Math.round(0.005 * g.sr));
    for (var i = 0; i < N; i++) {
      var stepF = i / s16;
      var step = Math.floor(stepF) % 16;
      var posInStep = (stepF - Math.floor(stepF)) * s16;
      var e = 1;
      if (posInStep < edge) e = 0.5 - 0.5 * Math.cos(Math.PI * posInStep / edge);
      else if (posInStep > s16 - edge) e = 0.5 - 0.5 * Math.cos(Math.PI * (s16 - posInStep) / edge);
      out[i] = CHOP_PATTERN[step] === 1 ? e : 0;
    }
    return out;
  }

  function ones(N) { var d = new Float32Array(N); for (var i = 0; i < N; i++) d[i] = 1; return d; }

  function buildTransition(type, bars, ctx, opts) {
    var known = false;
    for (var k = 0; k < TRANSITION_TYPES.length; k++)
      if (TRANSITION_TYPES[k].id === type) { known = true; break; }
    if (!known) throw new Error('Unknown transition type: ' + type);
    opts = opts || {};
    var g = gridFor(ctx);
    bars = Math.round(bars);
    if (!(bars >= 1)) throw new Error('buildTransition needs bars >= 1.');
    if (type === 'crossfade' || type === 'smooth') {
      // The crossfade family snaps to the standard 4/8/16/32-bar set (ties go up).
      var set = [4, 8, 16, 32], best = set[0], bd = 1e9;
      for (var s = 0; s < set.length; s++) {
        var dd = Math.abs(bars - set[s]);
        if (dd < bd || (dd === bd && set[s] > best)) { bd = dd; best = set[s]; }
      }
      bars = best;
    } else {
      bars = clamp(bars, 1, 32);
    }
    var N = bars * g.barLen;
    var rng = makeRng(1000 + bars * 77 + type.length * 131);
    var parts = {};
    var i, t;

    if (type === 'crossfade' || type === 'smooth') {
      var shape = type === 'smooth' ? 'smooth' : 'eqpower';
      parts.inGain = fadeCurve(N, true, shape);
      parts.outGain = fadeCurve(N, false, shape);
      parts.meta = { curve: shape };
    } else if (type === 'fill') {
      var fillBars = Math.min(bars, 2);
      var fd = synthFill(g, rng, fillBars);
      var d = new Float32Array(N); // silence until the fill starts
      d.set(fd, N - fd.length);
      parts.data = d;
      var og = ones(N), ig = new Float32Array(N);
      var dipStart = N - fd.length;
      for (i = dipStart; i < N; i++) { // beat ducks under the fill (to -6 dB mid-fill)
        t = (i - dipStart) / fd.length;
        og[i] = 1 - 0.5 * Math.sin(Math.PI * Math.min(1, t));
      }
      for (i = dipStart; i < N; i++) { // incoming sneaks in over the fill
        t = (i - dipStart) / Math.max(1, fd.length);
        ig[i] = Math.sin(0.5 * Math.PI * Math.min(1, t));
      }
      parts.outGain = og; parts.inGain = ig;
      parts.meta = { fillBars: fillBars };
    } else if (type === 'riser') {
      parts.data = synthRiser(N, g, rng);
      var ogR = ones(N), igR = new Float32Array(N);
      var ls = N - g.barLen; // outgoing fades over the last bar
      for (i = ls; i < N; i++) ogR[i] = Math.cos(0.5 * Math.PI * (i - ls) / g.barLen);
      var is2 = Math.max(0, N - 2 * g.barLen); // incoming sneaks in over 2 bars
      for (i = is2; i < N; i++)
        igR[i] = Math.sin(0.5 * Math.PI * (i - is2) / Math.max(1, N - is2));
      parts.outGain = ogR; parts.inGain = igR;
      parts.meta = { sweepHz: [Math.round(g.rootHz), Math.round(g.rootHz * 2)] };
    } else if (type === 'downlifter') {
      parts.data = synthDownlifter(N, g, rng);
      parts.outGain = fadeCurve(N, false, 'eqpower'); // outgoing dives out
      var igD2 = new Float32Array(N);
      var lb = N - g.barLen; // incoming arrives over the last bar
      for (i = lb; i < N; i++) igD2[i] = Math.sin(0.5 * Math.PI * (i - lb) / g.barLen);
      parts.inGain = igD2;
      parts.meta = { sweepHz: [Math.round(g.rootHz * 2), Math.round(g.rootHz)] };
    } else if (type === 'filter-sweep') {
      var dir = opts.direction === 'down' ? 'down' : 'up';
      parts.filter = {
        direction: dir,
        fromHz: opts.fromHz > 0 ? opts.fromHz : (dir === 'up' ? 250 : 18000),
        toHz: opts.toHz > 0 ? opts.toHz : (dir === 'up' ? 18000 : 250),
      };
      parts.meta = { filter: parts.filter.direction };
    } else if (type === 'echo-out') {
      parts.outGain = echoOutGain(N, g);
      var igE = new Float32Array(N);
      var le = N - g.barLen; // incoming fades in over the last bar
      for (i = le; i < N; i++) igE[i] = Math.sin(0.5 * Math.PI * (i - le) / g.barLen);
      parts.inGain = igE;
      parts.meta = { pulseGrid: 'half-beat', decay: 0.65 };
    } else if (type === 'reverb-tail') {
      parts.outGain = fadeCurve(N, false, 'smooth');
      parts.tail = synthWashTail(g, rng, 2); // 2-bar wash past the boundary
      var igT = new Float32Array(N);
      var lt = N - g.barLen;
      for (i = lt; i < N; i++) igT[i] = Math.sin(0.5 * Math.PI * (i - lt) / g.barLen);
      parts.inGain = igT;
      parts.meta = { tailBars: 2 };
    } else if (type === 'vocal-chop') {
      parts.inGain = vocalChopGain(N, g);
      var ogV = ones(N);
      var fv = Math.min(g.barLen, N); // outgoing exits over the first bar
      for (i = 0; i < fv; i++) ogV[i] = 1 - (i / fv) * (i / fv) * (3 - 2 * (i / fv));
      parts.outGain = ogV;
      parts.meta = { grid: '16th', pattern: CHOP_PATTERN.join('') };
    } else if (type === 'drop') {
      var sd = synthDrop(N, bars, g, rng);
      parts.data = sd.data;
      parts.meta = { impactOnset: sd.impactOnset };
      var ogD = ones(N);
      var bo = (bars - 1) * g.barLen; // outgoing pulls back over the final bar
      for (i = bo; i < N; i++)
        ogD[i] = Math.cos(0.5 * Math.PI * Math.min(1, (i - bo) / g.barLen));
      var igDp = new Float32Array(N);
      var fadeN = Math.max(1, Math.round(g.beatLen / 2));
      for (i = sd.impactOnset; i < N; i++) // incoming slams in on the impact
        igDp[i] = Math.sin(0.5 * Math.PI * Math.min(1, (i - sd.impactOnset) / fadeN));
      parts.outGain = ogD; parts.inGain = igDp;
    }

    /* ---- assemble the descriptor ---- */
    function toStereo(data) {
      if (!data) return null;
      var b = allocBuffer(2, data.length, g.sr);
      b.getChannelData(0).set(data);
      b.getChannelData(1).set(data);
      return b;
    }
    var desc = {
      type: type,
      bars: bars,
      lengthSamples: N,
      beatLen: g.beatLen,
      barLen: g.barLen,
      bpm: g.bpm,
      key: g.key,
      energy: g.energy,
      sampleRate: g.sr,
      buffer: toStereo(parts.data),
      tailBuffer: toStereo(parts.tail),
      inGain: parts.inGain || null,
      outGain: parts.outGain || null,
      filter: parts.filter || null,
      meta: parts.meta || {},
    };
    desc.meta.engineTag = 'smart DSP';
    desc.meta.type = type;
    desc.meta.bars = bars;

    // Sum the synthesized transition audio into a mix buffer at a sample
    // offset (the tail, if any, lands right after the window end).
    desc.placeAt = function (mix, offset) {
      if (!isAudioBuffer(mix)) throw new Error('placeAt needs a mix buffer.');
      offset = Math.max(0, Math.round(offset || 0));
      function sum(buf, at) {
        if (!buf) return;
        var nCh = Math.min(2, buf.numberOfChannels), mCh = mix.numberOfChannels;
        for (var c = 0; c < mCh; c++) {
          var sdata = buf.getChannelData(Math.min(c, nCh - 1));
          var mdata = mix.getChannelData(c);
          var nn = Math.min(sdata.length, mdata.length - at);
          for (var j = 0; j < nn; j++) mdata[at + j] += sdata[j];
        }
      }
      sum(desc.buffer, offset);
      sum(desc.tailBuffer, offset + N);
      return mix;
    };

    // Apply this transition's gain curves (and filter sweep) to a track.
    // which: 'in' (incoming track) | 'out' (outgoing track).
    // Returns a NEW buffer — the input is never modified.
    desc.applyTo = function (track, which) {
      if (!isAudioBuffer(track)) throw new Error('applyTo needs a track buffer.');
      var nCh = track.numberOfChannels, n = track.length;
      var curve = which === 'in' ? desc.inGain : desc.outGain;
      var out = allocBuffer(nCh, n, track.sampleRate);
      for (var c = 0; c < nCh; c++) {
        var sdata = track.getChannelData(c), odata = out.getChannelData(c);
        if (curve) {
          var nn = Math.min(n, curve.length);
          var last = curve.length ? curve[curve.length - 1] : 1;
          for (var j = 0; j < nn; j++) odata[j] = sdata[j] * curve[j];
          for (j = nn; j < n; j++) odata[j] = sdata[j] * last;
        } else {
          odata.set(sdata);
        }
      }
      if (desc.filter) applyFilterSweepTo(out, desc.filter);
      return out;
    };
    return desc;
  }

  // Time-varying 1st-order low-pass (stable for any cutoff path).
  function applyFilterSweepTo(buf, spec) {
    var sr = buf.sampleRate, n = buf.length, nCh = buf.numberOfChannels;
    var from = spec.fromHz, to = spec.toHz;
    for (var c = 0; c < nCh; c++) {
      var d = buf.getChannelData(c);
      var y = 0;
      for (var i = 0; i < n; i++) {
        var t = n > 1 ? i / (n - 1) : 0;
        var fc = from * Math.pow(to / from, t);
        var rc = 1 / (2 * Math.PI * fc), dt = 1 / sr;
        var a = rc / (rc + dt);
        y += a * (d[i] - y);
        d[i] = y;
      }
    }
    return buf;
  }

  /* =====================================================================
     §11 — MASTERING CHAIN
     master(buf, opts): opts.mode = 'natural' | 'balanced' | 'loud'.
       1. Loudness normalize to the mode's RMS target (overall mix RMS —
          honest loudness matching, not a fake "AI" loudness model).
       2. Final gentle EQ: +1 dB low shelf @ 120 Hz, +1 dB air @ 12 kHz.
       3. v24 30 Hz high-pass (phone-speaker protection).
       4. v24 true-peak limiter (TP_CEIL 0.71 = -3 dBTP) — runs LAST, so
          the output true peak can NEVER exceed 0.71: no clipping,
          guaranteed. Post-MP3 decode stays under -1 dBTP (proven in v24).
     Returns { buffer, meta } with engineTag 'smart DSP'.
     ===================================================================== */
  var MASTER_MODES = {
    natural:  { rms: 0.100, label: 'Natural' },   // ≈ -20 dBFS: dynamic, quiet
    balanced: { rms: 0.158, label: 'Balanced' },  // ≈ -16 dBFS: the default
    loud:     { rms: 0.251, label: 'Loud' },      // ≈ -12 dBFS: competitive loudness
  };

  function master(buf, opts) {
    if (!isAudioBuffer(buf)) throw new Error('master needs an audio buffer.');
    opts = opts || {};
    var mode = MASTER_MODES[opts.mode] ? opts.mode : 'balanced';
    var target = MASTER_MODES[mode].rms;
    var sr = buf.sampleRate, n = buf.length, nCh = buf.numberOfChannels;
    if (!n) throw new Error('master: the buffer is empty.');

    // 1. Loudness normalize: one pure gain to the mode target RMS.
    var sum = 0, c, i;
    for (c = 0; c < nCh; c++) {
      var d0 = buf.getChannelData(c);
      for (i = 0; i < n; i++) sum += d0[i] * d0[i];
    }
    var rms = Math.sqrt(sum / Math.max(1, n * nCh));
    var g0 = rms > 1e-9 ? target / rms : 1;
    var out = allocBuffer(nCh, n, sr);
    for (c = 0; c < nCh; c++) {
      var sd = buf.getChannelData(c), od = out.getChannelData(c);
      for (i = 0; i < n; i++) od[i] = sd[i] * g0;
      // 2. Final gentle mastering EQ.
      biquadInPlace(od, biquadCoeffs('lowshelf', 120, 0.7, 1.0, sr));
      biquadInPlace(od, biquadCoeffs('highshelf', 12000, 0.7, 1.0, sr));
      // 3. v24 30 Hz high-pass BEFORE the limiter.
      highPass30(od, sr);
    }
    // 4. v24 true-peak limiter LAST — the no-clipping guarantee.
    var prePeak = softPeakLimit(out);
    var tp = 0, ar = 0;
    for (c = 0; c < nCh; c++) {
      var dd = out.getChannelData(c);
      var p = truePeak4x(dd);
      if (p > tp) tp = p;
      ar += rmsArr(dd);
    }
    ar /= Math.max(1, nCh);
    return {
      buffer: out,
      meta: {
        engineTag: 'smart DSP',
        mode: mode,
        modeLabel: MASTER_MODES[mode].label,
        targetRms: target,
        achievedRms: Math.round(ar * 10000) / 10000,
        preLimitTruePeak: Math.round(prePeak * 10000) / 10000,
        truePeak: Math.round(tp * 10000) / 10000,
        ceiling: TP_CEIL,
      },
    };
  }

  /* =====================================================================
     §12 — MIX AUTOMATION
     buildAutomationCurve(sections, opts): volume automation across song
     sections with a maximum slew of +/-3 dB per bar — section changes
     can never jump suddenly.
       sections: [{ bars, gainDb }, ...]
       opts: { bpm (default 120), sr (default 44100),
               maxSlewDbPerBar (default 3) }
     Returns { curve (Float32Array, linear gain per sample), bars,
               barLen, dbPerBar, bpm, sampleRate, maxSlewDbPerBar }.
     applyAutomation(buf, curveObj): returns a NEW buffer with the curve
     applied (input untouched; holds the last gain past the curve end).
     ===================================================================== */
  function buildAutomationCurve(sections, opts) {
    if (!sections || !sections.length)
      throw new Error('buildAutomationCurve needs at least one section.');
    opts = opts || {};
    var bpm = opts.bpm > 0 ? opts.bpm : 120;
    var sr = opts.sr > 0 ? Math.round(opts.sr) : 44100;
    var maxSlew = opts.maxSlewDbPerBar != null ? opts.maxSlewDbPerBar : 3;
    var barLen = Math.max(1, Math.round((240 / bpm) * sr));
    var secs = [], totalBars = 0, s, b;
    for (s = 0; s < sections.length; s++) {
      var nb = Math.max(1, Math.round(sections[s].bars || 4));
      totalBars += nb;
      secs.push({ bars: nb,
                  gainDb: typeof sections[s].gainDb === 'number' ? sections[s].gainDb : 0 });
    }
    // Per-bar dB values, slew-limited: each bar moves at most maxSlew dB
    // toward its section target. A big jump becomes a multi-bar ramp —
    // never a sudden step.
    var dbPerBar = new Array(totalBars);
    var bi = 0, cur = secs[0].gainDb;
    for (s = 0; s < secs.length; s++) {
      for (b = 0; b < secs[s].bars; b++) {
        cur += clamp(secs[s].gainDb - cur, -maxSlew, maxSlew);
        dbPerBar[bi++] = cur;
      }
    }
    var n = totalBars * barLen;
    var curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var bf = i / barLen;
      var i0 = Math.min(totalBars - 1, Math.floor(bf));
      var i1 = Math.min(totalBars - 1, i0 + 1);
      var fr = bf - i0;
      var db = dbPerBar[i0] + (dbPerBar[i1] - dbPerBar[i0]) * fr;
      curve[i] = dbToLin(db);
    }
    return {
      curve: curve,
      bars: totalBars,
      barLen: barLen,
      dbPerBar: dbPerBar,
      bpm: bpm,
      sampleRate: sr,
      maxSlewDbPerBar: maxSlew,
    };
  }

  function applyAutomation(buf, curveObj) {
    if (!isAudioBuffer(buf)) throw new Error('applyAutomation needs an audio buffer.');
    if (!curveObj || !curveObj.curve) throw new Error('applyAutomation needs a curve object.');
    var curve = curveObj.curve, n = buf.length, nCh = buf.numberOfChannels;
    var out = allocBuffer(nCh, n, buf.sampleRate);
    var last = curve.length ? curve[curve.length - 1] : 1;
    for (var c = 0; c < nCh; c++) {
      var sd = buf.getChannelData(c), od = out.getChannelData(c);
      for (var i = 0; i < n; i++) od[i] = sd[i] * (i < curve.length ? curve[i] : last);
    }
    return out;
  }

  /* ---------------- public API ---------------- */
  RM.v25mix = {
    processVocal: processVocal,
    resolveOverlap: resolveOverlap,
    renderOverlap: renderOverlap,
    buildTransition: buildTransition,
    listTransitions: listTransitions,
    master: master,
    buildAutomationCurve: buildAutomationCurve,
    applyAutomation: applyAutomation,
    MASTER_MODES: MASTER_MODES,
    TRANSITION_TYPES: TRANSITION_TYPES.map(function (t) {
      return { id: t.id, name: t.name, desc: t.desc };
    }),
    // Test hooks: pure building blocks, no DOM / Web Audio needed.
    _test: {
      shimBuffer: shimBuffer,
      isAudioBuffer: isAudioBuffer,
      biquadCoeffs: biquadCoeffs,
      biquadInPlace: biquadInPlace,
      bandEnergy: bandEnergy,
      truePeak4x: truePeak4x,
      softPeakLimit: softPeakLimit,
      highPass30: highPass30,
      TP_CEIL: TP_CEIL,
      keyToRootMidi: keyToRootMidi,
      rootFreq: rootFreq,
      peakEnv: peakEnv,
      rmsArr: rmsArr,
      maxAbs: maxAbs,
      makeRng: makeRng,
      dbToLin: dbToLin,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
