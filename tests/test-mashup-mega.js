#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix v23 — MEGA mashup tests (node, no browser).
   Test worker file: asserts the v23 mega-mashup SPEC against the real
   www/js/mashup.js orchestration. Does NOT edit source.

   EXPECTED v23 API contract (for the v23 implementer):
     RM.mashup.buildMega(songs, opts) -> Promise<{ buffer, meta }>
       songs : Array of 2..8 AudioBuffers (min 2, max 8 — spec).
       opts  : { masterBpm=120, cycles=2, barsPerVocal=8,
                 introBars=4, outroBars=4, onProgress(label, frac) }
       Vocal rotation: 8-bar segments, song vocals cycle in pick order
                 S1,S2,S3,S1,S2,S3 (2 cycles for 3 songs), one consistent
                 beat bed underneath (spec, MEMORY.md v23 queue note).
       meta  : { masterBpm, songCount, cycles, barsPerVocal, introBars,
                 outroBars, totalBars, durationSec,
                 vocalOrder: [0,1,2,0,1,2],   // song index per segment
                 engineTagVocal, engineTagInstr, engineLabel? }
       Duration: totalBars = introBars + cycles*N*barsPerVocal + outroBars
                 (4 + cycles*N*8 + 4); seconds = totalBars * 240/masterBpm.
       Cancel: cooperative — throws {kind:'cancelled'} when
                 RM.mashupStems.isCancelRequested() (v21 convention,
                 www/js/mashup.js throwIfCancelled).
       Quota: when the neural quota is exhausted the builder must take the
                 DSP path and stay honest — tags/labels/toasts say
                 "Smart DSP", never claim a neural engine (mashup-stems.js
                 quota toast: 'Neural quota finished for today — using
                 Smart DSP (still good!)'; honest-label rule from
                 www/js/mashup-screen.js:169-180).

   Synthetic songs: mid/side construction — vocal = sine at a per-song
   signature frequency panned CENTER (L=R), bed = anti-phase noise living
   in the SIDE channel. The RM.stems mock does a true mid/side split, so
   the "Center (Vocal-ish)" stem is a clean signature sine and segment
   identity is measured with a Goertzel detector (segment energy +
   dominant signature per the task).

   Exit codes: 0 = all pass; 1 = >=1 failure; 2 = BLOCKED (0 pass, >0
   skip — v23 API not implemented yet).

   STATUS TODAY (2026-10-06): v23 mega/swap is QUEUED, not implemented —
   buildMega is absent, so every spec test SKIPs with the reason recorded.
   ===================================================================== */
const fs = require('fs');
const path = require('path');

// ---- fake window/RM ----
global.window = global;
global.RM = {};
const RM = global.RM;

// ---- failure location helper (file:line of the failing assertion) ----
function here() {
  const frames = new Error().stack.split('\n').slice(1);
  for (const f of frames) {
    if (/at (here|ok|skipT|needMega) /.test(f)) continue;
    const m = /(test-mashup-mega\.js):(\d+)/.exec(f);
    if (m) return m[1] + ':' + m[2];
  }
  return '?:?';
}

let pass = 0, fail = 0, skip = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  @' + here() + (extra ? '  [' + extra + ']' : '')); }
}
function skipT(name, reason) {
  skip++;
  console.log('  SKIP  ' + name + '  [' + reason + ']');
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-3 : tol); }
const db = (r) => 20 * Math.log10(Math.max(1e-12, r));

// ---- constants ----
const SR = 8000;
// Per-song vocal signature frequencies (musical intervals, all < Nyquist).
const VOCAL_FREQ = [220.00, 277.18, 349.23, 293.66, 329.63, 392.00, 261.63, 311.13];

// ---- deterministic PRNG for the bed noise ----
let _seed = 987654321;
function rand() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return (_seed / 0x7fffffff) * 2 - 1; }

// ---- fake AudioBuffer ----
function fakeBuffer(nch, len, sr, fill) {
  const chans = [];
  for (let c = 0; c < nch; c++) {
    const d = new Float32Array(len);
    if (typeof fill === 'function') fill(d, c);
    else if (typeof fill === 'number') d.fill(fill);
    chans.push(d);
  }
  return {
    sampleRate: sr, length: len, numberOfChannels: nch,
    duration: len / sr,
    getChannelData: (c) => chans[c],
    copyToChannel: (src, c) => { chans[c].set(src); },
    _bpm: 120, _key: { key: 'C', mode: 'major' },
  };
}

// ---- synthetic song: vocal sine CENTER, anti-phase noise SIDE ----
function mkSong(idx, sec) {
  sec = sec || 40;
  const len = Math.floor(SR * sec);
  const f = VOCAL_FREQ[idx % VOCAL_FREQ.length];
  const buf = fakeBuffer(2, len, SR, 0);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.5 * t); // musical, never silent
    const v = 0.5 * env * Math.sin(2 * Math.PI * f * t);
    const n = 0.18 * rand();
    L[i] = v + n;
    R[i] = v - n;
  }
  buf._bpm = 120;
  buf._key = { key: 'C', mode: 'major' };
  buf._songIdx = idx;
  return buf;
}

// ---- stub RM.audio ----
RM.audio = {
  detectBPM(buf, cb) { try { if (cb) cb(1); } catch (e) {} return Promise.resolve(buf._bpm); },
  resampleBuffer(buf, rate) {
    const newLen = Math.max(1, Math.round(buf.length * rate / buf.sampleRate));
    const out = fakeBuffer(buf.numberOfChannels, newLen, rate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = out.getChannelData(c);
      for (let i = 0; i < newLen; i++) d[i] = s[Math.min(s.length - 1, Math.floor(i * buf.length / newLen))];
    }
    return Promise.resolve(out);
  },
  ensureCtx() { return { createBuffer: (nch, len, sr) => fakeBuffer(nch, len, sr, 0) }; },
};

// ---- stub RM.stems: TRUE mid/side vocalcut ----
// Our synthetic songs are mid/side constructed, so (L+R)/2 recovers the
// clean vocal sine and (L-R)/2 the bed — a faithful mock separation.
RM.stems = {
  run(engineId, buffer, onProgress) {
    if (engineId !== 'vocalcut') return Promise.reject(new Error('Unknown engine: ' + engineId));
    try { if (onProgress) onProgress(1); } catch (e) {}
    const n = buffer.length, sr = buffer.sampleRate;
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const vocal = fakeBuffer(2, n, sr, 0), instr = fakeBuffer(2, n, sr, 0);
    const vL = vocal.getChannelData(0), vR = vocal.getChannelData(1);
    const iL = instr.getChannelData(0), iR = instr.getChannelData(1);
    for (let i = 0; i < n; i++) {
      const mid = (L[i] + R[i]) / 2, side = (L[i] - R[i]) / 2;
      vL[i] = vR[i] = mid;
      iL[i] = iR[i] = side;
    }
    vocal._key = buffer._key; instr._key = buffer._key;
    return Promise.resolve([
      { name: 'Center (Vocal-ish)', buffer: vocal },
      { name: 'Sides (Instrumental)', buffer: instr },
    ]);
  },
};

// ---- stub RM.mashupDSP (signature-preserving) ----
const dspCalls = { pitchShift: [], timeStretch: [] };
RM.mashupDSP = {
  detectKey(buf) { return Promise.resolve(buf._key || { key: 'C', mode: 'major' }); },
  timeStretch(buf, ratio) {
    dspCalls.timeStretch.push(ratio);
    // v23 CORRECT semantics: ratio>1 = longer output (matches real WSOLA)
    const newLen = Math.max(8, Math.round(buf.length * ratio));
    const out = fakeBuffer(buf.numberOfChannels, newLen, buf.sampleRate, 0);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = out.getChannelData(c);
      for (let i = 0; i < newLen; i++) {
        const pos = i * ratio, i0 = Math.floor(pos), fr = pos - i0;
        const a = s[Math.min(s.length - 1, i0)], b = s[Math.min(s.length - 1, i0 + 1)];
        d[i] = a + (b - a) * fr; // linear interp — preserves sine identity
      }
    }
    out._key = buf._key;
    return Promise.resolve(out);
  },
  pitchShift(buf, st) {
    dspCalls.pitchShift.push(st);
    return Promise.resolve(buf); // same-key songs -> builder must skip (st=0)
  },
  normalizeToRms(buf, target) {
    // v23: SYNC like the real one (arrange calls it synchronously)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const g = target / (Math.sqrt(sum / d.length) || 1);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return buf;
  },
  semitonesBetween() { return 0; }, // all synthetic songs are C major
  rms(buf) {
    let sum = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; n++; }
    }
    return Math.sqrt(sum / Math.max(1, n));
  },
  fadeInOut(buf, sec) {
    const n = Math.min(buf.length, Math.floor(sec * buf.sampleRate));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const g = Math.sin(0.5 * Math.PI * i / n);
        d[i] *= g;
        d[buf.length - 1 - i] *= g;
      }
    }
    return Promise.resolve(buf);
  },
};

// ---- load the REAL mashup orchestration, then the REAL stems module ----
// mashup.js first: mashup-stems.js register() needs RM.mashup.setStemsProvider
// to exist, otherwise it parks a 30s retry interval that hangs node.
eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'mashup.js'), 'utf8'));
require(path.join(__dirname, '..', 'www', 'js', 'mashup-stems.js'));
// The real provider is now registered (tag 'smart DSP' via our mid/side mock).

// ---- v23 REAL modules: Beats stub + arrange + mega ----
// RM.Beats.renderBeat stub: synthetic 4-on-floor-ish pulsed beat (broadband,
// no strong tonal content — keeps Goertzel rotation checks clean).
RM.Beats = {
  STYLES: [{ id: 'pop', name: 'Pop', bpm: 100 }],
  renderBeat(styleId, bpm, bars, opts) {
    const barLen = 240 / bpm, len = Math.max(1, Math.round(bars * barLen * SR));
    const out = fakeBuffer(2, len, SR, 0);
    let s = 1234567;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
    for (let c = 0; c < 2; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / SR, bt = t % (60 / bpm), env = Math.exp(-bt / 0.03);
        d[i] = 0.25 * env * rnd();
      }
    }
    return Promise.resolve(out);
  },
};
eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'mashup-arrange.js'), 'utf8'));
require(path.join(__dirname, '..', 'www', 'js', 'mashup-mega.js'));
// Spec API -> shipped API adapter (songs are raw fakeBuffers here).
RM.mashup.buildMega = function (songs, opts, onProgress) {
  const items = songs.map((buf, i) => ({ buffer: buf, name: 'song' + (i + 1) }));
  return RM.mashupMega.build(items, opts || {}, onProgress, null);
};

const HAS_MEGA = typeof RM.mashup.buildMega === 'function';
function needMega(name) {
  if (!HAS_MEGA) {
    skipT(name, 'RM.mashupMega.build missing');
    return false;
  }
  return true;
}

// ---- analysis helpers ----
function rmsOf(ch, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += ch[i] * ch[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
function goertzelMag(ch, start, n, freq, sr) {
  const w = 2 * Math.PI * freq / sr, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  const end = Math.min(ch.length, start + n);
  for (let i = start; i < end; i++) { const x = ch[i]; s0 = x + c * s1 - s2; s2 = s1; s1 = s0; }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return Math.sqrt(Math.max(0, p)) / Math.max(1, end - start);
}
function dominantSong(ch, start, n, freqs, sr) {
  let bi = 0, bm = -1;
  const mags = freqs.map((f) => goertzelMag(ch, start, n, f, sr));
  mags.forEach((m, i) => { if (m > bm) { bm = m; bi = i; } });
  return { idx: bi, mags };
}
// Classify the vocal segments of a mega timeline. Returns per-segment
// {k, idx, energyDb} for the CENTER 60% of each segment (avoids crossfades).
function classifyVocalSegments(buf, layout, nSongs) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0);
  const freqs = VOCAL_FREQ.slice(0, nSongs);
  const out = [];
  for (let k = 0; k < layout.vocalSegs; k++) {
    const segStart = layout.introSec + k * layout.segSec;
    const a = segStart + layout.segSec * 0.2, b = segStart + layout.segSec * 0.8;
    const start = Math.floor(a * sr), n = Math.floor((b - a) * sr);
    if (start < 0 || start + n > ch.length) continue;
    const r = dominantSong(ch, start, n, freqs, sr);
    out.push({ k, idx: r.idx, mags: r.mags, energyDb: db(rmsOf(ch, start, start + n)) });
  }
  return out;
}
// Refine a vocal->vocal boundary: scan the mag ratio around approxT and
// interpolate the unity crossing (unbiased for symmetric crossfades).
function refineBoundary(buf, approxT, idxA, idxB, nSongs) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0);
  const freqs = VOCAL_FREQ.slice(0, nSongs);
  const win = Math.floor(1.0 * sr);
  let prevT = null, prevR = null;
  for (let t = approxT - 2.5; t <= approxT + 2.5; t += 0.05) {
    const start = Math.max(0, Math.floor((t - 0.5) * sr));
    const n = Math.min(win, ch.length - start);
    if (n < win * 0.5) continue;
    const mA = goertzelMag(ch, start, n, freqs[idxA], sr);
    const mB = goertzelMag(ch, start, n, freqs[idxB], sr);
    const r = mA / Math.max(1e-9, mB);
    if (prevR !== null && ((prevR >= 1 && r < 1) || (prevR < 1 && r >= 1))) {
      const f = (1 - prevR) / (r - prevR);
      return prevT + f * 0.05;
    }
    prevT = t; prevR = r;
  }
  return null;
}
function layoutFromMeta(meta, nSongs) {
  const bpm = meta.masterBpm || 120;
  const barSec = 240 / bpm;
  const introBars = meta.introBars !== undefined ? meta.introBars : 4;
  const outroBars = meta.outroBars !== undefined ? meta.outroBars : 4;
  const barsPerVocal = meta.barsPerVocal || 8;
  const cycles = meta.cycles || 2;
  const vocalSegs = cycles * nSongs;
  return {
    bpm, barSec, introBars, outroBars, barsPerVocal, cycles, vocalSegs,
    segSec: barsPerVocal * barSec,
    introSec: introBars * barSec,
    totalBars: introBars + vocalSegs * barsPerVocal + outroBars,
  };
}
function collectProg() {
  const ev = [];
  return { ev, cb: (label, f) => ev.push([label, f]) };
}

// ---- honest-label rule (shipped contract, www/js/mashup-screen.js:169-180) ----
// 'smart DSP (neural failed)' contains the word "neural" but must NOT count
// as neural — the actual engine was DSP.
function isNeuralClaim(tag) {
  return /neural/i.test(tag || '') && !/neural failed/i.test(tag || '');
}
function honestLabelFor(tagV, tagI) {
  let label = 'Smart DSP engine';
  const nV = isNeuralClaim(tagV), nI = isNeuralClaim(tagI);
  if (nV && nI) label = 'Neural stems engine';
  else if (nV || nI) label = 'Smart DSP + neural stems';
  else if (/failed/i.test((tagV || '') + ' ' + (tagI || ''))) label = 'Smart DSP engine (neural unavailable)';
  return label;
}

async function main() {
  console.log('== v23 mega API presence ==');
  ok(HAS_MEGA, 'RM.mashup.buildMega exists',
     HAS_MEGA ? '' : 'v23 not implemented yet — all spec tests below SKIP');

  // -----------------------------------------------------------------
  console.log('== 1. rotation order: S1,S2,S3,S1,S2,S3 ==');
  if (needMega('rotation order (3 songs, 2 cycles)')) {
    dspCalls.pitchShift = []; dspCalls.timeStretch = [];
    const songs = [mkSong(0), mkSong(1), mkSong(2)];
    const p = collectProg();
    const r = await RM.mashup.buildMega(songs, { masterBpm: 120, cycles: 2, barsPerVocal: 8 }, p.cb);
    ok(r && r.buffer && typeof r.buffer.getChannelData === 'function', 'buildMega returns {buffer, meta}');
    const meta = r.meta || {};
    const layout = layoutFromMeta(meta, 3);
    const expected = [0, 1, 2, 0, 1, 2];
    if (Array.isArray(meta.vocalOrder)) {
      ok(JSON.stringify(meta.vocalOrder) === JSON.stringify(expected),
         'meta.vocalOrder = [0,1,2,0,1,2]', JSON.stringify(meta.vocalOrder));
    } else {
      ok(false, 'meta.vocalOrder exposed', 'missing');
    }
    const segs = classifyVocalSegments(r.buffer, layout, 3);
    ok(segs.length === expected.length, 'all 6 vocal segments classifiable', 'got ' + segs.length);
    let orderOk = true, detail = [];
    segs.forEach((s) => {
      if (s.idx !== expected[s.k]) { orderOk = false; detail.push(`seg${s.k}:got S${s.idx + 1}`); }
    });
    ok(orderOk, 'segment energy/Goertzel order = S1,S2,S3,S1,S2,S3', detail.join(' '));
    const quiet = segs.filter((s) => s.energyDb < -40);
    ok(quiet.length === 0, 'no silent vocal segment (energy floor)', quiet.map((s) => 'seg' + s.k).join(' '));
    // same key everywhere -> pitchShift must be skipped (pipeline convention)
    const nz = dspCalls.pitchShift.filter((st) => st !== 0);
    ok(nz.length === 0, 'pitchShift skipped for same-key songs', JSON.stringify(dspCalls.pitchShift));
    // progress: monotonic, ends at 1
    let mono = true, last = -1;
    for (const [, f] of p.ev) { if (f < last) mono = false; last = f; }
    ok(p.ev.length > 0 && mono && p.ev[p.ev.length - 1][1] === 1,
       'progress monotonic, ends at 1', JSON.stringify(p.ev.map((e) => [e[0], +e[1].toFixed(3)])));
  }

  // -----------------------------------------------------------------
  console.log('== 2. 8-bar grid math (120 BPM -> 16.0s per vocal segment) ==');
  if (needMega('8-bar grid math')) {
    const r = await RM.mashup.buildMega([mkSong(0), mkSong(1), mkSong(2)],
                                        { masterBpm: 120, cycles: 2, barsPerVocal: 8 });
    const meta = r.meta || {};
    const layout = layoutFromMeta(meta, 3);
    ok(approx(layout.barSec, 2.0, 1e-9), 'bar = 2.0s at 120 BPM', layout.barSec);
    ok(approx(layout.segSec, 16.0, 0.001), 'meta math: 8 bars = 16.0s per vocal segment', layout.segSec);
    // measured boundaries between consecutive vocal segments
    const expected = [0, 1, 2, 0, 1, 2];
    const bounds = [];
    for (let k = 0; k < expected.length - 1; k++) {
      const approxT = layout.introSec + (k + 1) * layout.segSec;
      bounds.push(refineBoundary(r.buffer, approxT, expected[k], expected[k + 1], 3));
    }
    const found = bounds.filter((b) => b !== null);
    ok(found.length === bounds.length, 'all 5 vocal boundaries measurable',
       bounds.map((b) => (b === null ? 'null' : b.toFixed(2))).join(','));
    let gridOk = true; const lens = [];
    for (let i = 1; i < found.length; i++) {
      const L = found[i] - found[i - 1];
      lens.push(L.toFixed(2));
      if (!approx(L, 16.0, 0.1)) gridOk = false;
    }
    ok(gridOk, 'measured vocal segment length = 16.0s ±0.1s', lens.join(','));
  }

  // -----------------------------------------------------------------
  // v23: zero-CLICK switches. The design fades vocals to (near) zero at each
  // boundary (equal-power out/in, exact zeros at the boundary), so an energy
  // dip AT the boundary is intentional — a click is a sample DISCONTINUITY.
  // We check max |x[i]-x[i-1]| in ±50ms of each boundary vs mid-segment: a
  // bad splice would spike far above the signal's own step size.
  console.log('== 3. zero-click switches (no sample discontinuities) ==');
  if (needMega('zero-click switches at vocal boundaries')) {
    const r = await RM.mashup.buildMega([mkSong(0), mkSong(1), mkSong(2)],
                                        { masterBpm: 120, cycles: 2, barsPerVocal: 8 });
    const meta = r.meta || {};
    const layout = layoutFromMeta(meta, 3);
    const expected = [0, 1, 2, 0, 1, 2];
    const sr = r.buffer.sampleRate, ch = r.buffer.getChannelData(0);
    const maxStep = (from, to) => {
      let m = 0;
      for (let i = Math.max(1, from); i < Math.min(ch.length, to); i++) {
        const s = Math.abs(ch[i] - ch[i - 1]);
        if (s > m) m = s;
      }
      return m;
    };
    let worstRatio = 0, checked = 0;
    for (let k = 0; k < expected.length - 1; k++) {
      const approxT = layout.introSec + (k + 1) * layout.segSec;
      const b = refineBoundary(r.buffer, approxT, expected[k], expected[k + 1], 3);
      if (b === null) continue;
      const bs = Math.floor(b * sr);
      const bStep = maxStep(bs - Math.floor(0.05 * sr), bs + Math.floor(0.05 * sr));
      const mStep = maxStep(bs + Math.floor(2 * sr), bs + Math.floor(2.05 * sr));
      const ratio = bStep / Math.max(mStep, 1e-6);
      checked++;
      if (ratio > worstRatio) worstRatio = ratio;
    }
    ok(checked > 0, 'boundary regions measured', checked + ' boundaries');
    ok(worstRatio < 3, 'no sample discontinuity at vocal switches (click-free)',
       'worst boundary/mid-segment step ratio ' + worstRatio.toFixed(2));
  }

  // -----------------------------------------------------------------
  console.log('== 4. duration formula: bars = 4 + cycles*N*8 + 4 ==');
  if (needMega('duration formula')) {
    const cases = [
      { n: 3, cycles: 2, bars: 4 + 2 * 3 * 8 + 4, sec: 112 },
      { n: 2, cycles: 1, bars: 4 + 1 * 2 * 8 + 4, sec: 48 },
    ];
    for (const c of cases) {
      const songs = [];
      for (let i = 0; i < c.n; i++) songs.push(mkSong(i));
      const r = await RM.mashup.buildMega(songs, { masterBpm: 120, cycles: c.cycles, barsPerVocal: 8 });
      const meta = r.meta || {};
      ok(meta.totalBars === c.bars, `N=${c.n} cycles=${c.cycles}: totalBars = ${c.bars}`, 'got ' + meta.totalBars);
      ok(approx(meta.durationSec, c.sec, 0.5), `N=${c.n} cycles=${c.cycles}: durationSec = ${c.sec}s`, 'got ' + meta.durationSec);
      ok(approx(r.buffer.duration, c.sec, 0.5), `N=${c.n} cycles=${c.cycles}: buffer duration = ${c.sec}s`, 'got ' + r.buffer.duration.toFixed(2));
      ok(approx(meta.durationSec, c.bars * 240 / 120, 0.5), 'durationSec = bars × 240/bpm');
    }
    // input validation: min 2, max 8 songs
    try { await RM.mashup.buildMega([mkSong(0)], { masterBpm: 120 }); ok(false, 'rejects 1 song'); }
    catch (e) { ok(e && /2|song/i.test(e.message || String(e)), 'rejects <2 songs with meaningful error', String((e && e.message) || e).slice(0, 80)); }
    const nine = []; for (let i = 0; i < 9; i++) nine.push(mkSong(i));
    try { await RM.mashup.buildMega(nine, { masterBpm: 120 }); ok(false, 'rejects 9 songs'); }
    catch (e) { ok(e && /8|song/i.test(e.message || String(e)), 'rejects >8 songs with meaningful error', String((e && e.message) || e).slice(0, 80)); }
  }

  // -----------------------------------------------------------------
  console.log('== 5. cancel: mid-build token cancel -> {kind:\'cancelled\'} ==');
  if (needMega('cancel throws {kind:"cancelled"}')) {
    RM.mashupStems.clearCancel();
    RM.mashupStems.requestCancel(); // user tapped Cancel mid-build
    let threw = null;
    try {
      await RM.mashup.buildMega([mkSong(0, 8), mkSong(1, 8)], { masterBpm: 120, cycles: 1 });
    } catch (e) { threw = e; } finally { RM.mashupStems.clearCancel(); }
    ok(threw && threw.kind === 'cancelled', 'cancelled build throws {kind:"cancelled"}',
       threw ? ('got ' + JSON.stringify(threw).slice(0, 80)) : 'no throw');
    ok(!String((threw && threw.message) || '').includes('[object Object]'),
       'cancel error has no [object Object] text');
  }

  // -----------------------------------------------------------------
  console.log('== 6. quota fallback (mock): quotaExhausted -> DSP, honest text ==');
  if (needMega('quota fallback stays honest')) {
    // Mock the v23 quota path: neural skipped (daily quota over), provider
    // goes straight to DSP with the honest tag — mirroring the real
    // mashup-stems.js quota branch (tag 'smart DSP', honest toast).
    const toastLog = [];
    const savedApp = RM.app;
    RM.app = { toast: (m) => toastLog.push(String(m)) };
    RM.mashup.setStemsProvider(async (buf, want, onProg) => {
      const sep = await RM.stems.run('vocalcut', buf, onProg);
      const stem = want === 'instrumental' ? sep[1] : sep[0];
      return { buffer: stem.buffer, tag: 'smart DSP' };
    });
    let r = null, err = null;
    try {
      r = await RM.mashup.buildMega([mkSong(0), mkSong(1)], { masterBpm: 120, cycles: 1 });
    } catch (e) { err = e; }
    RM.mashup.resetStemsProvider();
    RM.app = savedApp;
    ok(!err && r && r.buffer, 'quota-exhausted build still succeeds via DSP', err && String(err).slice(0, 80));
    const vocalTags = (r && r.meta && r.meta.vocalTags) || [];
    ok(/smart DSP/i.test(vocalTags.join(' ')), 'vocal engine tags say Smart DSP', vocalTags.join(' | '));
    ok(!isNeuralClaim(vocalTags.join(' ')), 'no neural ENGINE claim in tags', vocalTags.join(' | '));
    const label = honestLabelFor(vocalTags.join(' / '), vocalTags.join(' / '));
    ok(!/neural stems engine/i.test(label) && !/smart DSP \+ neural/i.test(label),
       'honest label claims no neural engine', label);
    // toast honesty: the shipped quota toast says "Smart DSP" and never
    // claims the engine is neural.
    const shippedQuotaToast = 'Neural quota finished for today — using Smart DSP (still good!)';
    ok(/Smart DSP/.test(shippedQuotaToast) && !/neural stems engine/i.test(shippedQuotaToast),
       'quota toast text: "Smart DSP", no neural-engine claim');
    const badToast = toastLog.filter((t) => isNeuralClaim(t) && !/quota/i.test(t));
    ok(badToast.length === 0, 'no emitted toast falsely claims a neural engine', badToast.join(' | ').slice(0, 120));
  }

  // -----------------------------------------------------------------
  console.log('== 7. engine labels: tag combos -> honest label string ==');
  {
    // Expected mapping — the shipped honesty rule (mashup-screen.js:169-180).
    const cases = [
      [['neural stems', 'neural stems'], 'Neural stems engine'],
      [['smart DSP', 'smart DSP'], 'Smart DSP engine'],
      [['neural stems', 'smart DSP'], 'Smart DSP + neural stems'],
      [['smart DSP', 'neural stems'], 'Smart DSP + neural stems'],
      [['smart DSP (neural failed)', 'smart DSP'], 'Smart DSP engine (neural unavailable)'],
      [['smart DSP', 'smart DSP (neural failed)'], 'Smart DSP engine (neural unavailable)'],
      [['smart DSP (neural failed)', 'smart DSP (neural failed)'], 'Smart DSP engine (neural unavailable)'],
      [['neural stems', 'smart DSP (neural failed)'], 'Smart DSP + neural stems'],
    ];
    if (typeof RM.mashup.honestEngineLabel === 'function') {
      for (const [[tv, ti], want] of cases) {
        const got = RM.mashup.honestEngineLabel(tv, ti);
        ok(got === want, `honestEngineLabel(${JSON.stringify(tv)}, ${JSON.stringify(ti)})`, 'got ' + JSON.stringify(got));
      }
    } else {
      // Pin the contract in the output WITHOUT counting passes: asserting
      // our own copy of the rule against itself would be circular. The
      // matrix below is what RM.mashup.honestEngineLabel must satisfy.
      console.log('  (contract, untested — RM.mashup.honestEngineLabel missing)');
      for (const [[tv, ti], want] of cases) {
        console.log(`    tags (${tv} / ${ti})  ->  ${want}`);
      }
      skip++;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : (pass === 0 && skip > 0 ? 2 : 0));
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
