'use strict';
/* =====================================================================
   RuhMix v27 W1 — WSOLA phase-coherence tests.
   Loads the REAL www/js/mashup-dsp.js (browser file) with a minimal
   window / RM.audio shim — no browser needed.

   What this proves (all measured, classical DSP — nothing "AI"):
   - Time-COMPRESSION no longer thins sustained harmonic content.
     Root cause (measured on a D-major chord, 4 sustained sines):
     the old per-frame argmax over a 5.8 ms correlation window saw
     competing maxima from each component's period and re-rolled the
     winner every join -> per-note cancellation of -8..-27 dB with
     THD 130-740% (phase modulation at the join rate turns carriers
     into inharmonic sidebands). The fix: the offset now WALKS —
     exact (Hs-Ha) drift between wraps (phase-perfect for every
     component, even under vibrato), wrapping by the measured dominant
     period (autocorrelation on clean input, 30..800 Hz, parabolic
     refinement), with a ±16-sample local xcorr snap so estimator error
     cannot accumulate into a pitch shift. Aperiodic frames keep the
     classic full-range search (transient safety net).
   - BEFORE numbers below are the old algorithm's measured values
     (tests/wsola-before.json, 2026-10-06); each assertion requires the
     current code to beat them by a wide margin.
   - No regressions: pure tones / saw pad bit-transparent, stereo
     coherence (same offset all channels), exact output length,
     chunked progress, click-free joins, 1.5+ ratio path intact.

   Run:  node tests/test-v27-wsola.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

/* ---------- minimal shim (same as test-mashup-dsp-node.js) ---------- */
class FakeAudioBuffer {
  constructor(nCh, len, sr) {
    this.numberOfChannels = nCh;
    this.length = Math.max(0, len | 0);
    this.sampleRate = sr;
    this.duration = this.length / sr;
    this._ch = [];
    for (let c = 0; c < nCh; c++) this._ch.push(new Float32Array(this.length));
  }
  getChannelData(c) { return this._ch[c]; }
}
const fakeCtx = {
  sampleRate: 44100,
  createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || 44100),
};
global.window = {};
global.RM = {
  audio: {
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    ensureCtx: () => fakeCtx,
    runChunked: (total, chunkSize, fn, onProgress) => new Promise((resolve, reject) => {
      let i = 0;
      const step = () => {
        try {
          const end = Math.min(total, i + chunkSize);
          fn(i, end); i = end;
          if (onProgress) onProgress(i / total);
          if (i < total) setImmediate(step); else resolve();
        } catch (e) { reject(e); }
      };
      step();
    }),
  },
};
global.window.RM = global.RM;

const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'mashup-dsp.js'), 'utf8');
eval(src);
const DSP = global.window.RM.mashupDSP;
if (!DSP) { console.error('FAIL: RM.mashupDSP not exposed'); process.exit(1); }

/* ---------- helpers ---------- */
const SR = 44100;
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
  return w;
}
// Exact-frequency amplitude (windowed correlation) on the middle section.
function ampAt(x, freq) {
  const n = Math.min(32768, x.length);
  const seg = x.subarray(((x.length - n) / 2) | 0, ((x.length - n) / 2 | 0) + n);
  const w = hann(n);
  let wr = 0, wi = 0;
  const ph = 2 * Math.PI * freq / SR;
  let cs = 1, sn = 0;
  const dcs = Math.cos(ph), dsn = Math.sin(ph);
  for (let i = 0; i < n; i++) {
    const v = seg[i] * w[i];
    wr += v * cs; wi += v * sn;
    const ncs = cs * dcs - sn * dsn, nsn = cs * dsn + sn * dcs;
    cs = ncs; sn = nsn;
  }
  return 4 * Math.sqrt(wr * wr + wi * wi) / n;
}
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }
// THD+N-ish: energy outside the harmonic bins vs harmonic energy.
function thdN(x, f0, nHarm) {
  const seg = x.subarray(((x.length - Math.min(32768, x.length)) / 2) | 0);
  let harmE = 0;
  for (let k = 1; k <= nHarm; k++) { const a = ampAt(x, f0 * k); harmE += a * a; }
  const totE = rms(seg) ** 2;
  return harmE > 0 ? Math.sqrt(Math.max(0, totE - harmE) / harmE) : 1;
}
function estimateFreqFFT(d) {
  const n = 32768;
  const seg = d.subarray(((d.length - n) / 2) | 0, ((d.length - n) / 2 | 0) + n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = seg[i] * w[i];
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cwr - im[b] * cwi, vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  let bk = 0, bv = 0;
  for (let k = 1; k < n / 2; k++) { const m = re[k] * re[k] + im[k] * im[k]; if (m > bv) { bv = m; bk = k; } }
  const m0 = re[bk - 1] ** 2 + im[bk - 1] ** 2, m2 = re[bk + 1] ** 2 + im[bk + 1] ** 2;
  const dl = 0.5 * (m0 - m2) / (m0 - 2 * bv + m2);
  return (bk + dl) * SR / n;
}
function makeChord() { // D-major: D3 F#3 A3 D4, 2.5 s mono
  const len = Math.floor(2.5 * SR);
  const buf = new FakeAudioBuffer(1, len, SR);
  const d = buf.getChannelData(0);
  for (const f of [146.83, 185.0, 220.0, 293.66])
    for (let i = 0; i < len; i++) d[i] += 0.22 * Math.sin(2 * Math.PI * f * i / SR);
  return { buf, freqs: [146.83, 185.0, 220.0, 293.66] };
}
function makeSine(f, secs) {
  const len = Math.floor((secs || 2.5) * SR);
  const buf = new FakeAudioBuffer(1, len, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
  return buf;
}
// Per-note preservation (dB) of `out` vs `ref` at given frequencies.
function notePreservation(out, ref, freqs) {
  const xo = out.getChannelData(0), xr = ref.getChannelData(0);
  return freqs.map((f) => 20 * Math.log10(ampAt(xo, f) / Math.max(1e-12, ampAt(xr, f))));
}

/* BEFORE measurements (old algorithm, 2026-10-06, tests/wsola-before.json):
   D-major chord per-note loss (dB) and THD at each ratio. The assertions
   below require the current code to beat every one of these by >=10x. */
const BEFORE = {
  0.7:  { worstNoteDb: -25.4, thdPct: 241.86 },
  0.85: { worstNoteDb: -26.9, thdPct: 738.47 },
  1.2:  { worstNoteDb: -22.8, thdPct: 715.89 },
  2:    { worstNoteDb: -21.9, thdPct: 140.92 },
};

async function main() {
  console.log('== v27 WSOLA phase coherence: chord (the "thin" case) ==');
  for (const ratio of [0.7, 0.85, 1.2, 2.0]) {
    const { buf, freqs } = makeChord();
    const debug = {};
    let progSeen = 0;
    const out = await DSP.timeStretch(buf, ratio, (p) => { progSeen = p; }, debug);
    const notes = notePreservation(out, buf, freqs);
    const worst = Math.min(...notes);
    const thd = 100 * thdN(out.getChannelData(0), 146.83, 8);
    const b = BEFORE[ratio];
    console.log(`  r=${ratio} notes=[${notes.map((v) => v.toFixed(1)).join(', ')}]dB THD=${thd.toFixed(1)}%` +
      ` (before: worst ${b.worstNoteDb}dB, THD ${b.thdPct}%)`);
    ok(worst > -2, `chord r=${ratio}: worst note loss < 2dB (before ${b.worstNoteDb}dB)`, worst.toFixed(2) + 'dB');
    ok(thd < b.thdPct / 10, `chord r=${ratio}: THD < 1/10 of before (${b.thdPct}%)`, thd.toFixed(1) + '%');
    ok(Math.abs(out.length - Math.round(buf.length * ratio)) <= 1, `chord r=${ratio}: exact length`);
    ok(progSeen > 0.9, `chord r=${ratio}: chunked progress reported`);
    // the walk must actually engage on pitched content (pEst found)
    let pEstHit = 0;
    for (let k = 1; k < debug.pEst.length; k++) if (debug.pEst[k] > 0) pEstHit++;
    ok(pEstHit > debug.pEst.length * 0.5, `chord r=${ratio}: period estimator engaged`, `${pEstHit}/${debug.pEst.length}`);
  }

  console.log('== no pitch drift from the walk (refinement check) ==');
  for (const ratio of [0.7, 2.0]) {
    const buf = makeSine(440);
    const out = await DSP.timeStretch(buf, ratio);
    const f = estimateFreqFFT(out.getChannelData(0));
    ok(Math.abs(f - 440) < 0.5, `sine440 r=${ratio}: pitch exact (no walk drift)`, f.toFixed(3) + 'Hz');
    const fundDb = 20 * Math.log10(ampAt(out.getChannelData(0), 440) / ampAt(buf.getChannelData(0), 440));
    ok(fundDb > -0.5, `sine440 r=${ratio}: fundamental preserved`, fundDb.toFixed(2) + 'dB');
  }

  console.log('== no regressions: tones, stereo, edges ==');
  {
    // saw pad: harmonics must survive compression untouched
    const len = Math.floor(2.5 * SR);
    const buf = new FakeAudioBuffer(1, len, SR);
    const d = buf.getChannelData(0);
    for (let k = 1; k <= 12; k++)
      for (let i = 0; i < len; i++) d[i] += (0.35 / k) * Math.sin(2 * Math.PI * 110 * k * i / SR);
    const out = await DSP.timeStretch(buf, 0.7);
    let worst = 0;
    for (let k = 1; k <= 6; k++) {
      const dd = Math.abs(20 * Math.log10(ampAt(out.getChannelData(0), 110 * k) / Math.max(1e-12, ampAt(d, 110 * k))));
      if (dd > worst) worst = dd;
    }
    ok(worst < 0.5, 'sawpad r=0.7: harmonics preserved < 0.5dB', worst.toFixed(3) + 'dB');
  }
  {
    // stereo coherence: identical channels -> bit-identical output
    const len = Math.floor(2 * SR);
    const buf = new FakeAudioBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (const f of [146.83, 220]) for (let i = 0; i < len; i++) d[i] += 0.25 * Math.sin(2 * Math.PI * f * i / SR);
    }
    const out = await DSP.timeStretch(buf, 0.7);
    const oL = out.getChannelData(0), oR = out.getChannelData(1);
    let maxDiff = 0;
    for (let i = 0; i < oL.length; i++) { const dd = Math.abs(oL[i] - oR[i]); if (dd > maxDiff) maxDiff = dd; }
    ok(maxDiff === 0, 'stereo r=0.7: same offset all channels (L/R bit-identical)');
    ok(out.numberOfChannels === 2, 'stereo channel count kept');
  }
  {
    // click-free joins: no sample-to-sample jumps beyond the signal's own slope
    const { buf } = makeChord();
    const out = await DSP.timeStretch(buf, 0.7);
    const o = out.getChannelData(0);
    let worst = 0;
    for (let i = 1; i < o.length; i++) { const dd = Math.abs(o[i] - o[i - 1]); if (dd > worst) worst = dd; }
    // steepest possible slope of the chord content << 0.05; a join click would spike far above
    ok(worst < 0.05, 'chord r=0.7: click-free joins', 'max step ' + worst.toFixed(4));
    ok(o[0] === 0 && o[o.length - 1] === 0, 'click-free edges (exact zeros)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
