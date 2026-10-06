'use strict';
/* =====================================================================
   RuhMix — mashup-dsp.js
   Pure DSP utilities for the "Auto Mashup" feature. No UI, no network,
   no dependencies — classical signal processing only.

   Exposes window.RM.mashupDSP:
     detectKey(audioBuffer, onProgress) -> Promise<{key, mode, confidence}>
       Chromagram (STFT, Hann 4096/2048) averaged over up to 30 s,
       matched against Krumhansl-Schmuckler major/minor profiles.
       key: 'C'..'B', mode: 'major'|'minor', confidence: 0..1.
     timeStretch(audioBuffer, ratio, onProgress) -> Promise<AudioBuffer>
       WSOLA time-stretcher. ratio > 1 = longer duration, pitch
       preserved. ratio clamped to [0.5, 2.0]. Mono + stereo.
     pitchShift(audioBuffer, semitones, onProgress) -> Promise<AudioBuffer>
       Linear-interp resample by 2^(st/12) (pitch + tempo change),
       then timeStretch back by 2^(st/12) to restore duration.
       semitones clamped to [-6, 6].
     rms(audioBuffer) -> number
     normalizeToRms(audioBuffer, targetRms) -> AudioBuffer
       Scales to target RMS, peak-limited at 0.98 (no clipping).
     semitonesBetween(keyA, keyB) -> int in [-6..6]
       Signed semitone shift that brings B's key onto A's key.
       Relative major/minor pairs (e.g. C major / A minor) give 0.
     fadeInOut(audioBuffer, fadeSec) -> AudioBuffer (in place)
       Equal-power fades; first/last samples forced to exactly 0
       so every join is click-free.

   All heavy loops run through RM.audio.runChunked so the main thread
   never blocks for long; every async function takes an optional
   onProgress(0..1).
   ===================================================================== */
window.RM = window.RM || {};

RM.mashupDSP = (function () {
  const clamp = RM.audio.clamp;
  const chunked = RM.audio.runChunked;

  /* ================= radix-2 FFT (iterative, in-place) ================= */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const vr = re[b] * cwr - im[b] * cwi;
          const vi = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = nwr;
        }
      }
    }
  }

  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
    return w;
  }

  /* ================= small helpers ================= */
  function makeBuffer(nCh, len, sr) {
    return RM.audio.ensureCtx().createBuffer(nCh, Math.max(1, len | 0), sr);
  }

  function channelArrays(buf) {
    const out = [];
    for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c));
    return out;
  }

  async function copyBuffer(buf, onProgress) {
    const out = makeBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    const src = channelArrays(buf), dst = channelArrays(out);
    const len = buf.length;
    await chunked(buf.numberOfChannels * len, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        const c = (i / len) | 0;
        dst[c][i % len] = src[c][i % len];
      }
    }, onProgress);
    return out;
  }

  // Average of all channels, first `len` samples, chunked.
  // Mid/side "sides" sum to zero BY CONSTRUCTION (sL + sR = 0: the mashup's
  // instrumental IS such a sides signal), so a plain average would return
  // digital silence for perfectly valid content — detectKey would then see
  // nothing and report a phantom 'C major' (confidence 0), and the WSOLA
  // offset search would degrade. Detect that cancellation and fall back
  // to the loudest channel instead.
  async function monoMix(buf, len, onProgress) {
    const ch = channelArrays(buf);
    const nCh = ch.length;
    const inv = 1 / Math.max(1, nCh);
    const mono = new Float32Array(len);
    const eCh = new Float64Array(nCh);
    let eMix = 0;
    await chunked(len, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        let s = 0;
        for (let c = 0; c < nCh; c++) { const v = ch[c][i]; s += v; eCh[c] += v * v; }
        const m = s * inv;
        mono[i] = m;
        eMix += m * m;
      }
    }, onProgress);
    let eMax = 0, bc = 0;
    for (let c = 0; c < nCh; c++) { if (eCh[c] > eMax) { eMax = eCh[c]; bc = c; } }
    // Cancellation: the mix holds <1% of the loudest channel's energy while
    // that channel is non-silent -> the channels cancelled each other out.
    if (eMax > 1e-12 && eMix < 0.01 * eMax) {
      mono.set(ch[bc].subarray(0, len));
    }
    return mono;
  }

  /* ================= 1. key detection ================= */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Krumhansl-Schmuckler key profiles (tonal hierarchies).
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pearson(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return (da > 1e-12 && db > 1e-12) ? num / Math.sqrt(da * db) : 0;
  }

  async function detectKey(audioBuffer, onProgress) {
    const sr = audioBuffer.sampleRate;
    const prog = (p) => { if (onProgress) onProgress(p); };
    const len = Math.min(audioBuffer.length, Math.floor(30 * sr));
    if (len < 2048) return { key: 'C', mode: 'major', confidence: 0 };

    const mono = await monoMix(audioBuffer, len, (p) => prog(p * 0.08));

    const N = 4096, HOP = 2048;
    const win = hannWindow(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const mag = new Float32Array(N / 2 + 1);
    const chroma = new Float64Array(12);
    const frames = Math.max(1, Math.floor((len - N) / HOP) + 1);
    const minF = 55, maxF = 5000; // musical range only
    const binHz = sr / N;

    await chunked(frames, 8, (fa, fb) => {
      for (let f = fa; f < fb; f++) {
        const off = f * HOP;
        for (let n = 0; n < N; n++) {
          re[n] = (off + n < len ? mono[off + n] : 0) * win[n];
          im[n] = 0;
        }
        fft(re, im);
        let maxMag = 0;
        for (let b = 1; b <= N / 2; b++) {
          const a = re[b], c = im[b];
          const m = Math.sqrt(a * a + c * c);
          mag[b] = m;
          if (m > maxMag) maxMag = m;
        }
        if (maxMag <= 0) continue;
        const thresh = maxMag * 0.05;
        // Peak-picking: only local spectral maxima vote. With N=4096 the
        // bins are wider than low chroma bands at 44.1 kHz, so adding
        // every bin would smear leakage across neighbouring pitch
        // classes; peaks belong to real partials.
        for (let b = 2; b < N / 2; b++) {
          const m = mag[b];
          if (m < thresh || m <= mag[b - 1] || m < mag[b + 1]) continue;
          const fr = b * binHz;
          if (fr < minF || fr > maxF) continue;
          // Parabolic interpolation for a better frequency estimate.
          const al = mag[b - 1], be = m, ga = mag[b + 1];
          const den = al - 2 * be + ga;
          const delta = den !== 0 ? 0.5 * (al - ga) / den : 0;
          const fEst = (b + clamp(delta, -0.5, 0.5)) * binHz;
          const midi = Math.round(69 + 12 * Math.log2(fEst / 440));
          chroma[((midi % 12) + 12) % 12] += Math.sqrt(m); // mild compression
        }
      }
    }, (p) => prog(0.08 + p * 0.92));

    let mx = 0;
    for (let i = 0; i < 12; i++) if (chroma[i] > mx) mx = chroma[i];
    if (mx <= 0) return { key: 'C', mode: 'major', confidence: 0 };
    for (let i = 0; i < 12; i++) chroma[i] /= mx;

    const rot = new Float64Array(12);
    let bestR = -2, bestRoot = 0, bestMinor = false;
    for (let m = 0; m < 2; m++) {
      const prof = m ? KS_MINOR : KS_MAJOR;
      for (let root = 0; root < 12; root++) {
        for (let i = 0; i < 12; i++) rot[i] = prof[(i - root + 12) % 12];
        const r = pearson(chroma, rot);
        if (r > bestR) { bestR = r; bestRoot = root; bestMinor = !!m; }
      }
    }
    const confidence = clamp((bestR - 0.35) / 0.55, 0, 1);
    return { key: NOTE_NAMES[bestRoot], mode: bestMinor ? 'minor' : 'major', confidence };
  }

  /* ================= 2. WSOLA time-stretch ================= */
  async function timeStretch(audioBuffer, ratio, onProgress) {
    ratio = clamp(ratio || 1, 0.5, 2.0);
    const sr = audioBuffer.sampleRate;
    const nCh = audioBuffer.numberOfChannels;
    const inLen = audioBuffer.length;
    const prog = (p) => { if (onProgress) onProgress(p); };
    if (inLen === 0) return makeBuffer(nCh, 0, sr);
    if (ratio === 1) return copyBuffer(audioBuffer, onProgress);

    // WSOLA: step through the INPUT in analysis hops (Ha) and lay each
    // window down on the output in synthesis hops (Hs = Ha * ratio).
    // ratio > 1 -> Hs > Ha -> longer output, pitch preserved (every
    // placed segment is a genuine input excerpt; the offset search only
    // aligns periods so joins are phase-continuous).
    const W = Math.max(256, Math.round(0.025 * sr)); // ~25 ms window
    const Ha = Math.max(64, Math.round(W / 3));      // analysis hop
    const nFrames = Math.max(1, Math.round(inLen / Ha));
    const Hs = (inLen * ratio) / nFrames;            // exact-length synth hop
    const Tol = Math.max(32, Math.round(0.005 * sr));// offset search range
    const D = 16;                                   // search decimation
    const outLen = Math.max(1, Math.round(inLen * ratio));

    // One mono mix drives the offset search; the SAME winning offset is
    // applied to every channel, so the stereo image never drifts apart.
    const mono = await monoMix(audioBuffer, inLen, (p) => prog(p * 0.05));

    const chIn = channelArrays(audioBuffer);
    const chOut = [];
    for (let c = 0; c < nCh; c++) chOut.push(new Float32Array(outLen + W));
    const y0 = chOut[0]; // search reference: already-synthesized ch-0 overlap

    await chunked(nFrames, 16, (fa, fb) => {
      for (let k = fa; k < fb; k++) {
        const synPos = Math.round(k * Hs);
        const nat = k * Ha;
        let aStar = nat;
        // Actual output advance of this frame (Hs is fractional).
        const step = (k + 1 < nFrames ? Math.round((k + 1) * Hs) : outLen) - synPos;
        // Crossfade length: capped at `step` so every output sample is
        // written by at most 2 frames. The old code crossfaded over the
        // full W-step overlap, which for ratio < 1.5 exceeds step: samples
        // were then blended 3-6 times -> comb filtering that cancelled
        // true tones and minted phantom ones (measured on a D-major
        // chord at 0.703: D3 -18 dB, phantom G3 +79x, key detector
        // flipped D major -> G major). For ratio >= 1.5 this equals the
        // old W-step (proven path, unchanged).
        const xf = Math.max(1, Math.min(W - step, step));
        if (k > 0) {
          // Best integer offset: maximize normalized cross-correlation
          // between the synthesized overlap and the candidate input
          // segment (decimated for speed; full-rate offset applied).
          const L = Math.max(1, Math.floor(xf / D));
          let refE = 0;
          for (let n = 0; n < L; n++) { const v = y0[synPos + n * D]; refE += v * v; }
          let bestScore = -1, bestD = 0;
          for (let d = -Tol; d <= Tol; d++) {
            const a = nat + d;
            if (a < 0) continue;
            let num = 0, segE = 0;
            for (let n = 0; n < L; n++) {
              const idx = a + n * D;
              const v = idx < inLen ? mono[idx] : 0;
              num += v * y0[synPos + n * D];
              segE += v * v;
            }
            const score = (refE > 1e-12 && segE > 1e-12)
              ? num / Math.sqrt(refE * segE) : -1;
            if (score > bestScore) { bestScore = score; bestD = d; }
          }
          aStar = nat + bestD;
        }
        for (let c = 0; c < nCh; c++) {
          const x = chIn[c], y = chOut[c];
          if (k === 0) {
            // No previous frame: direct copy, plus 2 samples of slack so
            // frame 1's crossfade reference stays valid under Hs rounding.
            // (The slack is fully overwritten by frame 1's direct region.)
            const n0 = xf + step + 2;
            for (let n = 0; n < n0; n++) {
              const idx = aStar + n;
              y[n] = idx < inLen ? x[idx] : 0;
            }
          } else {
            for (let n = 0; n < xf; n++) {
              const w = n / xf; // linear crossfade: click-free join
              const idx = aStar + n;
              const s = idx < inLen ? x[idx] : 0;
              y[synPos + n] = y[synPos + n] * (1 - w) + s * w;
            }
            // Direct copy of the new material only — the NEXT frame's
            // crossfade blends over [synPos+step, synPos+step+xf).
            const nEnd = xf + step;
            for (let n = xf; n < nEnd; n++) {
              const idx = aStar + n;
              y[synPos + n] = idx < inLen ? x[idx] : 0;
            }
          }
        }
      }
    }, (p) => prog(0.05 + p * 0.95));

    const out = makeBuffer(nCh, outLen, sr);
    const dst = channelArrays(out);
    for (let c = 0; c < nCh; c++) dst[c].set(chOut[c].subarray(0, outLen));
    fadeInOut(out, Math.min(0.005, outLen / sr / 2)); // click-free edges
    prog(1);
    return out;
  }

  /* ================= 3. pitch shift (resample + stretch) ================= */
  async function pitchShift(audioBuffer, semitones, onProgress) {
    const st = clamp(semitones || 0, -6, 6);
    const prog = (p) => { if (onProgress) onProgress(p); };
    if (st === 0) return copyBuffer(audioBuffer, onProgress);
    const r = Math.pow(2, st / 12); // resample rate
    const sr = audioBuffer.sampleRate;
    const nCh = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const newLen = Math.max(1, Math.round(len / r));

    // Linear-interp resample: out[i] = in[i * r].
    // r > 1 (shift up) -> shorter buffer, pitch * r, tempo * r.
    const tmp = makeBuffer(nCh, newLen, sr);
    const chIn = channelArrays(audioBuffer), chTmp = channelArrays(tmp);
    await chunked(nCh * newLen, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        const c = (i / newLen) | 0, s = i % newLen;
        const pos = s * r;
        const i0 = Math.floor(pos), fr = pos - i0;
        const x = chIn[c];
        const v0 = i0 < len ? x[i0] : 0;
        const v1 = i0 + 1 < len ? x[i0 + 1] : 0;
        chTmp[c][s] = v0 + (v1 - v0) * fr;
      }
    }, (p) => prog(p * 0.25));

    // Restore the original duration with the pitch-preserving stretcher.
    // NOTE: the restore factor is 2^(+st/12) = r (lengthen the shortened
    // buffer back to `len`); a negative exponent here would shrink it again.
    return timeStretch(tmp, r, (p) => prog(0.25 + p * 0.75));
  }

  /* ================= 4. RMS + normalize ================= */
  function rms(audioBuffer) {
    const ch = channelArrays(audioBuffer);
    let sum = 0, n = 0;
    for (let c = 0; c < ch.length; c++) {
      const d = ch[c];
      for (let i = 0; i < d.length; i++) { const v = d[i]; sum += v * v; }
      n += d.length;
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  function normalizeToRms(audioBuffer, targetRms) {
    const target = Math.max(0, targetRms || 0);
    const nCh = audioBuffer.numberOfChannels;
    const out = makeBuffer(nCh, audioBuffer.length, audioBuffer.sampleRate);
    const chIn = channelArrays(audioBuffer), chOut = channelArrays(out);
    let peak = 0;
    for (let c = 0; c < nCh; c++) {
      const d = chIn[c];
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    const r = rms(audioBuffer);
    let g = r > 1e-12 ? target / r : 0;
    if (peak * g > 0.98 && peak > 1e-12) g = 0.98 / peak; // peak-limit
    for (let c = 0; c < nCh; c++) {
      const s = chIn[c], d = chOut[c];
      for (let i = 0; i < s.length; i++) d[i] = s[i] * g;
    }
    return out;
  }

  /* ================= 5. key distance ================= */
  const PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  const FLAT_ALIAS = { DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#' };
  function pitchClassOf(name) {
    const u = String(name || 'C').toUpperCase();
    const n = FLAT_ALIAS[u] || u;
    return PC[n] !== undefined ? PC[n] : 0;
  }
  // Effective pitch class: a minor key is represented by its relative major
  // (root + 3 semitones), so relative major/minor pairs compare equal.
  // Accepts {key, mode} objects OR strings like "C major" / "A minor" —
  // strings used to silently degrade to C major (wrong); now parsed properly.
  function normKey(k) {
    if (k && typeof k === 'object') return k;
    const m = String(k || '').trim().match(/^([A-Ga-g](?:#|b)?)\s*(major|minor|maj|min|m)?$/i);
    if (m) {
      let mode = 'major';
      const ms = (m[2] || '').toLowerCase();
      if (ms === 'minor' || ms === 'min' || ms === 'm') mode = 'minor';
      return { key: m[1].toUpperCase(), mode: mode };
    }
    return { key: 'C', mode: 'major' };
  }
  function effPc(k) {
    const nk = normKey(k);
    const p = pitchClassOf(nk.key);
    return nk.mode === 'minor' ? (p + 3) % 12 : p;
  }

  // Signed semitone shift to apply to B so its key matches A's key.
  // Positive = shift B up. Range [-6..6] (tritone reports +6).
  function semitonesBetween(keyA, keyB) {
    let s = (((effPc(keyA) - effPc(keyB)) % 12) + 12) % 12;
    if (s > 6) s -= 12;
    return s;
  }

  /* ================= 6. equal-power fades ================= */
  function fadeInOut(audioBuffer, fadeSec) {
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const n = Math.min(Math.floor(Math.max(0, fadeSec || 0) * sr), Math.floor(len / 2));
    if (n <= 0 || len < 2) return audioBuffer;
    const ch = channelArrays(audioBuffer);
    const halfPi = 0.5 * Math.PI;
    for (let c = 0; c < ch.length; c++) {
      const d = ch[c];
      for (let i = 0; i < n; i++) {
        const g = Math.sin(halfPi * i / n); // equal-power curve
        d[i] *= g;                          // fade in:  0 -> ~1
        d[len - 1 - i] *= g;                // fade out: ~1 -> 0
      }
      d[0] = 0;                             // exact zeros: click-free edges
      d[len - 1] = 0;
    }
    return audioBuffer;
  }

  return {
    detectKey, timeStretch, pitchShift,
    rms, normalizeToRms, semitonesBetween, fadeInOut,
  };
})();
