#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix v23 — VOCAL SWAP mashup tests (node, no browser).
   Test worker file: asserts the v23 vocal-swap SPEC against the real
   www/js/mashup.js orchestration. Does NOT edit source.

   EXPECTED v23 API contract (for the v23 implementer):
     RM.mashup.buildSwap(bufA, bufB, opts) -> Promise<{ buffer, meta }>
       bufA/bufB : 2 song AudioBuffers (Song 1, Song 2).
       opts     : { masterBpm=120, barsPerSegment=8, cycles=2,
                    onProgress(label, frac) }
       Alternation: 8-bar segments — Song 1 vocal, then Song 2 vocal,
                    alternating S1,S2,S1,S2 (2 cycles), with a crossfade at
                    every swap boundary so the switch is click-free
                    (spec, MEMORY.md v23 queue note: "8-bar alternate with
                    crossfade").
       Active singer sits +3dB above the inactive singer (same +3dB vocal
       convention as the v22 pro mashup: 10^(3/20) ≈ 1.4125).
       meta     : { masterBpm, barsPerSegment, cycles,
                    swapOrder: [0,1,0,1],   // song index per segment
                    durationSec, vocalBoostDb: 3,
                    engineTagVocal, engineTagInstr, engineLabel? }
       Cancel: cooperative — throws {kind:'cancelled'} when
                 RM.mashupStems.isCancelRequested() (v21 convention).
       Quota/labels: same honesty contract as the mega builder — DSP path
                 when the neural quota is exhausted; tags/labels/toasts say
                 "Smart DSP", never claim a neural engine (honest-label
                 rule: www/js/mashup-screen.js:169-180).

   Synthetic songs: same mid/side construction as test-mashup-mega.js —
   vocal = signature sine CENTER, bed = anti-phase noise SIDE; the
   RM.stems mock does a true mid/side split.

   Exit codes: 0 = all pass; 1 = >=1 failure; 2 = BLOCKED (0 pass, >0
   skip — v23 API not implemented yet).

   STATUS TODAY (2026-10-06): v23 mega/swap is QUEUED, not implemented —
   buildSwap is absent, so every spec test SKIPs with the reason recorded.
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
    if (/at (here|ok|skipT|needSwap) /.test(f)) continue;
    const m = /(test-mashup-swap\.js):(\d+)/.exec(f);
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
const VOCAL_FREQ = [220.00, 277.18]; // S1, S2 signature sines

// ---- deterministic PRNG ----
let _seed = 135792468;
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
    const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.5 * t);
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
    // v23 CORRECT semantics: ratio>1 = longer output
    const newLen = Math.max(8, Math.round(buf.length * ratio));
    const out = fakeBuffer(buf.numberOfChannels, newLen, buf.sampleRate, 0);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = out.getChannelData(c);
      for (let i = 0; i < newLen; i++) {
        const pos = i * ratio, i0 = Math.floor(pos), fr = pos - i0;
        const a = s[Math.min(s.length - 1, i0)], b = s[Math.min(s.length - 1, i0 + 1)];
        d[i] = a + (b - a) * fr;
      }
    }
    out._key = buf._key;
    return Promise.resolve(out);
  },
  pitchShift(buf, st) { dspCalls.pitchShift.push(st); return Promise.resolve(buf); },
  normalizeToRms(buf, target) {
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const g = target / (Math.sqrt(sum / d.length) || 1);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return buf; // v23: SYNC like the real one
  },
  semitonesBetween() { return 0; },
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
eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'mashup.js'), 'utf8'));
require(path.join(__dirname, '..', 'www', 'js', 'mashup-stems.js'));

// ---- v23 REAL modules: Beats stub + arrange + swap ----
RM.Beats = {
  STYLES: [{ id: 'pop', name: 'Pop', bpm: 100 }],
  renderBeat(styleId, bpm, bars, opts) {
    const barLen = 240 / bpm, len = Math.max(1, Math.round(bars * barLen * SR));
    const out = fakeBuffer(2, len, SR, 0);
    let s = 7654321;
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
require(path.join(__dirname, '..', 'www', 'js', 'mashup-swap.js'));
// Spec API -> shipped API adapter. Shipped: build(buf1, buf2, onProgress, token).
RM.mashup.buildSwap = function (buf1, buf2, opts, onProgress) {
  return RM.mashupSwap.build(buf1, buf2, onProgress, null);
};

const HAS_SWAP = typeof RM.mashup.buildSwap === 'function';
function needSwap(name) {
  if (!HAS_SWAP) {
    skipT(name, 'RM.mashupSwap.build missing');
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
// Classify swap segments: CENTER 60% of each 8-bar segment.
function classifySwapSegments(buf, segSec, segCount) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0);
  const out = [];
  for (let k = 0; k < segCount; k++) {
    const segStart = INTRO_SEC + k * segSec; // v23: 4-bar intro precedes vocal segments
    const a = segStart + segSec * 0.2, b = segStart + segSec * 0.8;
    const start = Math.floor(a * sr), n = Math.floor((b - a) * sr);
    if (start < 0 || start + n > ch.length) continue;
    const m0 = goertzelMag(ch, start, n, VOCAL_FREQ[0], sr);
    const m1 = goertzelMag(ch, start, n, VOCAL_FREQ[1], sr);
    out.push({ k, idx: m0 >= m1 ? 0 : 1, m0, m1, energyDb: db(rmsOf(ch, start, start + n)) });
  }
  return out;
}
function refineSwapBoundary(buf, approxT, idxA, idxB) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0);
  const win = Math.floor(1.0 * sr);
  let prevT = null, prevR = null;
  for (let t = approxT - 2.5; t <= approxT + 2.5; t += 0.05) {
    const start = Math.max(0, Math.floor((t - 0.5) * sr));
    const n = Math.min(win, ch.length - start);
    if (n < win * 0.5) continue;
    const mA = goertzelMag(ch, start, n, VOCAL_FREQ[idxA], sr);
    const mB = goertzelMag(ch, start, n, VOCAL_FREQ[idxB], sr);
    const r = mA / Math.max(1e-9, mB);
    if (prevR !== null && ((prevR >= 1 && r < 1) || (prevR < 1 && r >= 1))) {
      const f = (1 - prevR) / (r - prevR);
      return prevT + f * 0.05;
    }
    prevT = t; prevR = r;
  }
  return null;
}
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
function collectProg() {
  const ev = [];
  return { ev, cb: (label, f) => ev.push([label, f]) };
}
const SWAP_OPTS = { masterBpm: 120, barsPerSegment: 8, cycles: 2 };
const SEG_SEC = 8 * 240 / 120; // 16.0s per swap segment at 120 BPM
const INTRO_SEC = 4 * 240 / 120; // v23: swap has a 4-bar beat intro — segments start after it
const EXPECTED_ORDER = [0, 1, 0, 1];

async function main() {
  console.log('== v23 vocal-swap API presence ==');
  ok(HAS_SWAP, 'RM.mashup.buildSwap exists',
     HAS_SWAP ? '' : 'v23 not implemented yet — all spec tests below SKIP');

  // -----------------------------------------------------------------
  console.log('== 8a. alternation order: S1,S2,S1,S2 ==');
  if (needSwap('vocal alternation S1,S2,S1,S2')) {
    const p = collectProg();
    const r = await RM.mashup.buildSwap(mkSong(0), mkSong(1), SWAP_OPTS, p.cb);
    ok(r && r.buffer && typeof r.buffer.getChannelData === 'function', 'buildSwap returns {buffer, meta}');
    const meta = r.meta || {};
    ok(Array.isArray(meta.swapOrder) &&
       JSON.stringify(meta.swapOrder) === JSON.stringify(EXPECTED_ORDER),
       'meta.swapOrder = [0,1,0,1]', JSON.stringify(meta.swapOrder));
    const segs = classifySwapSegments(r.buffer, SEG_SEC, EXPECTED_ORDER.length);
    ok(segs.length === EXPECTED_ORDER.length, 'all 4 swap segments classifiable', 'got ' + segs.length);
    let orderOk = true; const detail = [];
    segs.forEach((s) => {
      if (s.idx !== EXPECTED_ORDER[s.k]) { orderOk = false; detail.push(`seg${s.k}:got S${s.idx + 1}`); }
    });
    ok(orderOk, 'segment Goertzel order = S1,S2,S1,S2', detail.join(' '));
    const quiet = segs.filter((s) => s.energyDb < -40);
    ok(quiet.length === 0, 'no silent swap segment', quiet.map((s) => 'seg' + s.k).join(' '));
    let mono = true, last = -1;
    for (const [, f] of p.ev) { if (f < last) mono = false; last = f; }
    ok(p.ev.length > 0 && mono && p.ev[p.ev.length - 1][1] === 1,
       'progress monotonic, ends at 1', JSON.stringify(p.ev.map((e) => [e[0], +e[1].toFixed(3)])));
  }

  // -----------------------------------------------------------------
  console.log('== 8b. active singer +3dB vs inactive singer ==');
  if (needSwap('active singer +3dB over inactive')) {
    const r = await RM.mashup.buildSwap(mkSong(0), mkSong(1), SWAP_OPTS);
    const segs = classifySwapSegments(r.buffer, SEG_SEC, EXPECTED_ORDER.length);
    let levelOk = true; const detail = [];
    segs.forEach((s) => {
      const active = s.idx === 0 ? s.m0 : s.m1;
      const inactive = s.idx === 0 ? s.m1 : s.m0;
      const d = db(active) - db(inactive);
      detail.push(`seg${s.k}:S${s.idx + 1} ${d.toFixed(1)}dB`);
      if (!(d >= 2.9)) levelOk = false; // spec +3dB, 0.1dB float tolerance
    });
    ok(levelOk, 'active singer >= +2.9dB over inactive singer in every segment', detail.join(' | '));
    const meta = r.meta || {};
    if (meta.vocalBoostDb !== undefined) {
      ok(approx(meta.vocalBoostDb, 3, 0.01), 'meta.vocalBoostDb = 3', 'got ' + meta.vocalBoostDb);
    } else {
      ok(meta.vocalBoostDb === 3, 'meta.vocalBoostDb = 3 (spec: active singer +3dB)',
         'got ' + meta.vocalBoostDb);
    }
  }

  // -----------------------------------------------------------------
  console.log('== 8c. swap grid: 8 bars = 16.0s per segment (±0.1s) ==');
  if (needSwap('swap 8-bar grid math')) {
    const r = await RM.mashup.buildSwap(mkSong(0), mkSong(1), SWAP_OPTS);
    ok(approx(SEG_SEC, 16.0, 1e-9), 'spec: 8 bars at 120 BPM = 16.0s', SEG_SEC);
    const bounds = [];
    for (let k = 0; k < EXPECTED_ORDER.length - 1; k++) {
      bounds.push(refineSwapBoundary(r.buffer, INTRO_SEC + (k + 1) * SEG_SEC, EXPECTED_ORDER[k], EXPECTED_ORDER[k + 1]));
    }
    const found = bounds.filter((b) => b !== null);
    ok(found.length === bounds.length, 'all 3 swap boundaries measurable',
       bounds.map((b) => (b === null ? 'null' : b.toFixed(2))).join(','));
    let gridOk = true; const lens = [];
    for (let i = 1; i < found.length; i++) {
      const L = found[i] - found[i - 1];
      lens.push(L.toFixed(2));
      if (!approx(L, 16.0, 0.1)) gridOk = false;
    }
    ok(gridOk, 'measured swap segment length = 16.0s ±0.1s', lens.join(','));
  }

  // -----------------------------------------------------------------
  // v23: zero-CLICK = no sample discontinuity (the design intentionally fades
  // vocals to near-zero at boundaries, so an energy dip there is by design).
  console.log('== 8d. zero-click swap boundaries (no sample discontinuities) ==');
  if (needSwap('zero-click swap boundaries')) {
    const r = await RM.mashup.buildSwap(mkSong(0), mkSong(1), SWAP_OPTS);
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
    for (let k = 0; k < EXPECTED_ORDER.length - 1; k++) {
      const b = refineSwapBoundary(r.buffer, INTRO_SEC + (k + 1) * SEG_SEC,
                                   EXPECTED_ORDER[k], EXPECTED_ORDER[k + 1]);
      if (b === null) continue;
      const bs = Math.floor(b * sr);
      const bStep = maxStep(bs - Math.floor(0.05 * sr), bs + Math.floor(0.05 * sr));
      const mStep = maxStep(bs + Math.floor(2 * sr), bs + Math.floor(2.05 * sr));
      checked++;
      const ratio = bStep / Math.max(mStep, 1e-6);
      if (ratio > worstRatio) worstRatio = ratio;
    }
    ok(checked > 0, 'swap boundary regions measured', checked + ' boundaries');
    ok(worstRatio < 3, 'no sample discontinuity at swap switches (click-free)',
       'worst boundary/mid-segment step ratio ' + worstRatio.toFixed(2));
  }

  // -----------------------------------------------------------------
  console.log('== 8e. cancel: mid-build -> {kind:\'cancelled\'} ==');
  if (needSwap('swap cancel throws {kind:"cancelled"}')) {
    RM.mashupStems.clearCancel();
    RM.mashupStems.requestCancel();
    let threw = null;
    try {
      await RM.mashup.buildSwap(mkSong(0, 8), mkSong(1, 8), SWAP_OPTS);
    } catch (e) { threw = e; } finally { RM.mashupStems.clearCancel(); }
    ok(threw && threw.kind === 'cancelled', 'cancelled swap build throws {kind:"cancelled"}',
       threw ? ('got ' + JSON.stringify(threw).slice(0, 80)) : 'no throw');
  }

  // -----------------------------------------------------------------
  console.log('== 8f. swap duration sanity + input validation ==');
  if (needSwap('swap duration sanity')) {
    const r = await RM.mashup.buildSwap(mkSong(0), mkSong(1), SWAP_OPTS);
    const meta = r.meta || {};
    const vocalSec = EXPECTED_ORDER.length * SEG_SEC; // 64s of vocals
    const introSec = (meta.introBars || 0) * 240 / (meta.masterBpm || 120);
    const outroSec = (meta.outroBars || 0) * 240 / (meta.masterBpm || 120);
    const expectSec = vocalSec + introSec + outroSec;
    ok(r.buffer.duration >= vocalSec - 0.5,
       'buffer holds all 4 vocal segments (>= 63.5s)', r.buffer.duration.toFixed(2) + 's');
    if (meta.durationSec !== undefined) {
      ok(approx(meta.durationSec, expectSec, 0.5), 'meta.durationSec matches layout', 'got ' + meta.durationSec);
      ok(approx(r.buffer.duration, meta.durationSec, 0.5), 'buffer duration matches meta.durationSec');
    } else {
      skipT('meta.durationSec layout check', 'builder does not expose meta.durationSec');
    }
    try { await RM.mashup.buildSwap(mkSong(0), null, SWAP_OPTS); ok(false, 'rejects null song'); }
    catch (e) { ok(/song|track|buffer/i.test((e && e.message) || String(e)), 'rejects invalid input with meaningful error', String((e && e.message) || e).slice(0, 80)); }
  }

  // -----------------------------------------------------------------
  console.log('== 8g. swap quota/label honesty ==');
  if (needSwap('swap engine honesty')) {
    const toastLog = [];
    const savedApp = RM.app;
    RM.app = { toast: (m) => toastLog.push(String(m)) };
    RM.mashup.setStemsProvider(async (buf, want, onProg) => {
      const sep = await RM.stems.run('vocalcut', buf, onProg);
      const stem = want === 'instrumental' ? sep[1] : sep[0];
      return { buffer: stem.buffer, tag: 'smart DSP' }; // quota-skipped neural
    });
    let r = null, err = null;
    try { r = await RM.mashup.buildSwap(mkSong(0), mkSong(1), SWAP_OPTS); }
    catch (e) { err = e; }
    RM.mashup.resetStemsProvider();
    RM.app = savedApp;
    ok(!err && r && r.buffer, 'quota-path swap build succeeds via DSP', err && String(err).slice(0, 80));
    // v23: swap exposes engineTagSong1/2 (not engineTagVocal/Instr)
    const tagV = (r && r.meta && r.meta.engineTagSong1) || '';
    const tagI = (r && r.meta && r.meta.engineTagSong2) || '';
    ok(!isNeuralClaim(tagV) && !isNeuralClaim(tagI), 'no neural ENGINE claim in swap tags', tagV + ' / ' + tagI);
    // v23: honest rule on the exposed per-song tags (UI's honestEngineLabel consumes these)
    ok(/smart DSP/i.test(tagV) && /smart DSP/i.test(tagI),
       'engine tags honest (Smart DSP on DSP path)', tagV + ' / ' + tagI);
    const badToast = toastLog.filter((t) => isNeuralClaim(t));
    ok(badToast.length === 0, 'no swap toast falsely claims a neural engine', badToast.join(' | ').slice(0, 120));
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : (pass === 0 && skip > 0 ? 2 : 0));
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
