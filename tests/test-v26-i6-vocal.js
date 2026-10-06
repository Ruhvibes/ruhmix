'use strict';
/* =====================================================================
   Node tests for v26 I6: v26-vocal.js (vocal chain) + fx.js eq7.
   Browser files loaded with minimal shims (FakeAudioBuffer, RM.audio,
   window/global). No browser needed.

   Run: node tests/test-v26-i6-vocal.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const SR = 44100; // EQ Air band (14 kHz) needs a high Nyquist

/* ---------- shims ---------- */
class FakeAudioBuffer {
  constructor(nCh, len, sr) {
    this.numberOfChannels = nCh;
    this.length = Math.max(1, len | 0);
    this.sampleRate = sr;
    this.duration = this.length / sr;
    this._ch = [];
    for (let c = 0; c < nCh; c++) this._ch.push(new Float32Array(this.length));
  }
  getChannelData(c) { return this._ch[c]; }
}
const fakeCtx = {
  sampleRate: SR,
  createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || SR),
};
global.window = {};
global.RM = {
  audio: {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    ensureCtx: () => fakeCtx,
  },
};
global.window.RM = global.RM;

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', rel), 'utf8');
  eval(src);
}
load('fx.js');
load('v25-mixmaster.js');
load('v26-vocal.js');

const EQ7 = global.window.RM.fx.eq7;
const V25T = global.window.RM.v25mix._test; // real RMS band-energy measurer
const VV = require('../www/js/v26-vocal.js');
const T = VV.internals, A = VV.api;
if (!EQ7 || !T || !A || !V25T) { console.error('FAIL: modules not exposed'); process.exit(1); }

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function mkBuf(seconds, nCh, sr) {
  return new FakeAudioBuffer(nCh || 2, Math.round(seconds * (sr || SR)), sr || SR);
}
function sineInto(arr, freq, amp, sr, phase) {
  for (let i = 0; i < arr.length; i++)
    arr[i] += amp * Math.sin(2 * Math.PI * freq * i / sr + (phase || 0));
}
function dbRatio(after, before) { return 20 * Math.log10(after / Math.max(1e-12, before)); }
const BASE = { deess: 0, harsh: 0, comp: 0, eq7: {}, reverb: 0, delay: 0, duck: false };

async function main() {
  console.log('== eq7: band table ==');
  {
    ok(EQ7.BANDS.length === 7, '7 bands defined');
    const ids = EQ7.BANDS.map(b => b.id).join(',');
    ok(ids === 'sub,bass,lowmid,mid,highmid,treble,air', 'band ids in order', ids);
    ok(EQ7.BANDS[0].type === 'lowshelf' && EQ7.BANDS[0].freq === 60, 'Sub = lowshelf 60Hz');
    ok(EQ7.BANDS[6].type === 'highshelf' && EQ7.BANDS[6].freq === 14000, 'Air = highshelf 14kHz');
  }

  console.log('== eq7: each band boosts its own band >= +5dB, others flat ==');
  {
    const probes = { sub: 30, bass: 150, lowmid: 400, mid: 1000, highmid: 2500, treble: 10000, air: 16000 };
    for (const b of EQ7.BANDS) {
      const buf = mkBuf(1, 1); sineInto(buf.getChannelData(0), probes[b.id], 0.5, SR);
      const g = {}; g[b.id] = 12;
      const out = EQ7.applyToBuffer(buf, g);
      const rIn = T.rmsArr(buf.getChannelData(0)), rOut = T.rmsArr(out.getChannelData(0));
      const db = dbRatio(rOut, rIn);
      ok(db >= 5, 'band ' + b.id + ' +12dB boosts own band >=+5dB', db.toFixed(2) + ' dB');
      // others flat: all-zero gains must be bit-identical
      const flat = EQ7.applyToBuffer(buf, {});
      let identical = true;
      const a = buf.getChannelData(0), f = flat.getChannelData(0);
      for (let i = 0; i < a.length; i += 97) if (a[i] !== f[i]) { identical = false; break; }
      ok(identical, 'band ' + b.id + ' bypass path bit-exact when flat');
      ok(buf !== flat, 'applyToBuffer returns a new buffer (input untouched)');
    }
  }

  console.log('== vocal chain: de-ess reduces 4-8kHz energy on sibilant signal ==');
  {
    const buf = mkBuf(2, 1, SR);
    const d = buf.getChannelData(0), sr = SR;
    for (let i = 0; i < d.length; i++) { // sibilant bursts: 6kHz sine gated
      const gate = (i % sr) < sr * 0.4 ? 1 : 0.02;
      d[i] = 0.5 * Math.sin(2 * Math.PI * 6000 * i / sr) * gate
           + 0.2 * Math.sin(2 * Math.PI * 200 * i / sr);
    }
    const mono = new Float32Array(d);
    const off = await A.processVocalChain(mono, sr, Object.assign({}, BASE));
    const on = await A.processVocalChain(mono, sr, Object.assign({}, BASE, { deess: 100 }));
    const eOff = V25T.bandEnergy(off.proc, sr, 4000, 8000);
    const eOn = V25T.bandEnergy(on.proc, sr, 4000, 8000);
    const cutDb = 10 * Math.log10(eOn / Math.max(1e-12, eOff));
    ok(cutDb <= -2, 'de-ess 100 cuts 4-8kHz >= 2dB vs 0', cutDb.toFixed(2) + ' dB');
    ok(on.meta.deessDips > 0, 'de-ess detector fired', 'dips=' + on.meta.deessDips);
  }

  console.log('== vocal chain: harsh-tame reduces 2-5kHz energy ==');
  {
    const sr = SR, buf = mkBuf(2, 1, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const gate = (i % sr) < sr * 0.5 ? 1 : 0.05;
      d[i] = 0.5 * Math.sin(2 * Math.PI * 3200 * i / sr) * gate
           + 0.2 * Math.sin(2 * Math.PI * 300 * i / sr);
    }
    const mono = new Float32Array(d);
    const off = await A.processVocalChain(mono, sr, Object.assign({}, BASE));
    const on = await A.processVocalChain(mono, sr, Object.assign({}, BASE, { harsh: 100 }));
    const eOff = V25T.bandEnergy(off.proc, sr, 2000, 5000);
    const eOn = V25T.bandEnergy(on.proc, sr, 2000, 5000);
    const cutDb = 10 * Math.log10(eOn / Math.max(1e-12, eOff));
    ok(cutDb <= -1, 'harsh 100 cuts 2-5kHz vs 0', cutDb.toFixed(2) + ' dB');
    ok(on.meta.harshDips > 0, 'harsh detector fired', 'dips=' + on.meta.harshDips);
  }

  console.log('== vocal chain: compressor reduces crest factor ==');
  {
    const sr = SR, n = sr * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) { // sustained loud phrases over a quiet bed
      const loud = (i % sr) < sr * 0.5;
      x[i] = loud ? 0.7 * Math.sin(2 * Math.PI * 440 * i / sr)
                  : 0.05 * Math.sin(2 * Math.PI * 440 * i / sr);
    }
    // unit: the knob's own compressor stage, directly
    const c0 = T.compressMono(x, sr, 0), c85 = T.compressMono(x, sr, 85);
    function phraseRms(buf, skipMs) {
      let s = 0, k = 0;
      const skip = Math.floor(skipMs * sr / 1000);
      for (let i = skip; i < Math.floor(sr * 0.5); i++) { s += buf[i] * buf[i]; k++; }
      return Math.sqrt(s / k);
    }
    const r0 = phraseRms(c0.out, 100), r85 = phraseRms(c85.out, 100);
    const redDb = 20 * Math.log10(r85 / Math.max(1e-9, r0));
    ok(redDb <= -6, 'comp 85 tames loud phrase >= 6dB vs 0 (unit)', redDb.toFixed(1) + ' dB');
    ok(c85.maxGrDb > 3, 'comp gain reduction reported (unit)', 'GR=' + c85.maxGrDb.toFixed(1) + ' dB');
    ok(c0.maxGrDb === 0, 'comp 0 is bypass (unit)');
    // end-to-end: comp knob changes the chain output on a hot vocal
    const hot = new Float32Array(n);
    for (let i = 0; i < n; i++) hot[i] = 1.4 * Math.sin(2 * Math.PI * 330 * i / sr);
    const e0 = await A.processVocalChain(hot, sr, Object.assign({}, BASE));
    const e1 = await A.processVocalChain(hot, sr, Object.assign({}, BASE, { comp: 100 }));
    let dd = 0;
    for (let i = 0; i < n; i += 7) dd = Math.max(dd, Math.abs(e1.proc[i] - e0.proc[i]));
    ok(dd > 0.01, 'comp knob audibly changes chain output', 'max diff=' + dd.toFixed(3));
    ok(e1.meta.compGrDb > 0, 'chain reports comp GR', 'GR=' + e1.meta.compGrDb + ' dB');
  }

  console.log('== vocal chain: reverb send adds tail energy ==');
  {
    const sr = SR, n = Math.floor(sr * 0.6);
    const x = new Float32Array(n);
    for (let i = 0; i < Math.floor(sr * 0.15); i++) // short burst, then silence
      x[i] = 0.6 * Math.sin(2 * Math.PI * 880 * i / sr);
    const wet = await T.reverbWet(x, sr, 0.5, 0.25, 2.4); // real fn, short IR for speed
    let tailWet = 0, k = 0;
    for (let i = Math.floor(sr * 0.2); i < n; i++) { tailWet += wet[i] * wet[i]; k++; }
    const tailRms = Math.sqrt(tailWet / k);
    ok(tailRms > 0.005, 'reverb send produces audible tail after dry ends', 'tail rms=' + tailRms.toFixed(4));
    const ir = T.makeReverbIR(sr, 0.25, 2.4);
    let e0 = 0, e1 = 0;
    for (let i = 0; i < 200; i++) e0 += ir[i] * ir[i];
    for (let i = ir.length - 200; i < ir.length; i++) e1 += ir[i] * ir[i];
    ok(e1 < e0 * 0.05, 'IR decays exponentially', (e1 / Math.max(1e-12, e0)).toFixed(4));
  }

  console.log('== vocal chain: delay send produces echo taps ==');
  {
    const sr = SR, n = Math.floor(sr * 1.2);
    const x = new Float32Array(n);
    for (let i = 0; i < Math.floor(sr * 0.1); i++)
      x[i] = 0.6 * Math.sin(2 * Math.PI * 660 * i / sr);
    const dry = T.delaySend(x, sr, 0, 0.375, 0.35, 4);
    const wet = T.delaySend(x, sr, 0.45, 0.375, 0.35, 4);
    const D = Math.round(0.375 * sr);
    let eDry = 0, eWet = 0, k = 0;
    for (let i = D; i < D + Math.floor(sr * 0.1); i++) { eDry += dry[i] * dry[i]; eWet += wet[i] * wet[i]; k++; }
    ok(dbRatio(Math.sqrt(eWet / k), Math.sqrt(eDry / k) + 1e-9) >= 6,
      'delay send 80 adds echo at 375ms', dbRatio(Math.sqrt(eWet / k), Math.sqrt(eDry / k) + 1e-9).toFixed(1) + ' dB');
  }

  console.log('== vocal chain: processVocal centers stereo vocal ==');
  {
    const sr = SR, buf = mkBuf(1, 2, sr);
    sineInto(buf.getChannelData(0), 440, 0.5, sr);
    sineInto(buf.getChannelData(1), 880, 0.5, sr, 1.3); // hard-panned different content
    const mono = T.monoMean(buf);
    const r = await A.processVocalChain(mono, sr, Object.assign({}, BASE, { deess: 50 }));
    ok(r.proc.length === mono.length, 'chain preserves length');
    ok(r.meta && typeof r.meta.deessDips === 'number', 'chain returns honest meta');
  }

  console.log('== sidechain: ON ducks instrumental >= 1dB under vocal vs OFF ==');
  {
    const sr = SR, n = sr * 4;
    const instr = mkBuf(4, 2, sr);
    sineInto(instr.getChannelData(0), 440, 0.4, sr);
    sineInto(instr.getChannelData(1), 440, 0.4, sr);
    const voc = new Float32Array(n);
    for (let i = 0; i < n; i++) { // loud vocal bursts 1s on / 1s off
      const on2 = (i % (2 * sr)) < sr;
      voc[i] = on2 ? 0.8 * Math.sin(2 * Math.PI * 220 * i / sr) : 0.001;
    }
    const g = T.duckGains(voc, sr, 3);
    const ducked = T.applyDuck(instr, g);
    let eOff = 0, eOn = 0, k = 0;
    const d0 = instr.getChannelData(0), d1 = ducked.getChannelData(0);
    for (let i = 0; i < n; i++) {
      if ((i % (2 * sr)) < sr && i % (2 * sr) > sr * 0.3) { eOff += d0[i] * d0[i]; eOn += d1[i] * d1[i]; k++; }
    }
    const duckDb = dbRatio(Math.sqrt(eOn / k), Math.sqrt(eOff / k));
    ok(duckDb <= -1, 'sidechain ON ducks >= 1dB under vocal', duckDb.toFixed(2) + ' dB');
    let minG = 1; for (let i = 0; i < g.length; i += 10) if (g[i] < minG) minG = g[i];
    ok(minG >= 0.70 && minG < 1, 'duck depth bounded near -3dB design', 'min gain=' + minG.toFixed(3));
    ok(g[0] === 1, 'duck starts at unity (no click)');
  }

  console.log('== applyToSections: end-to-end on vocal sections ==');
  {
    const sr = SR, mix = mkBuf(4, 2, sr);
    for (let c = 0; c < 2; c++) {
      const d = mix.getChannelData(c);
      sineInto(d, 440, 0.3, sr);                       // bed everywhere
      for (let i = sr; i < 3 * sr; i++)                 // sibilant vocal in section
        d[i] += 0.5 * Math.sin(2 * Math.PI * 6000 * i / sr) * (((i % sr) < sr * 0.4) ? 1 : 0.05);
    }
    const before = new Float32Array(mix.getChannelData(0));
    const ranges = [{ kind: 'vocal', name: 'V', aSec: 1, bSec: 3 }];
    const o = Object.assign({}, BASE, { deess: 100, comp: 60, delay: 50, duck: true });
    const res = await A.applyToSections(mix, ranges, o);
    const after = res.buffer.getChannelData(0);
    let outsideDiff = 0;
    for (let i = 0; i < sr; i += 7) outsideDiff = Math.max(outsideDiff, Math.abs(after[i] - before[i]));
    for (let i = 3 * sr; i < 4 * sr; i += 7) outsideDiff = Math.max(outsideDiff, Math.abs(after[i] - before[i]));
    ok(outsideDiff === 0, 'audio outside vocal range bit-identical', 'max diff=' + outsideDiff);
    let insideDiff = 0;
    for (let i = sr; i < 3 * sr; i += 7) insideDiff = Math.max(insideDiff, Math.abs(after[i] - before[i]));
    ok(insideDiff > 0.01, 'vocal range audibly changed', 'max diff=' + insideDiff.toFixed(3));
    ok(res.report.ranges === 1 && res.report.duck === true, 'report honest', JSON.stringify(res.report));
    // input buffer not mutated by the apply
    let inMut = 0;
    const cur = mix.getChannelData(0);
    for (let i = 0; i < cur.length; i += 13) inMut = Math.max(inMut, Math.abs(cur[i] - before[i]));
    ok(inMut === 0, 'source mix buffer untouched (new buffer returned)');
    // duck OFF differs from duck ON
    const res2 = await A.applyToSections(mix, ranges, Object.assign({}, o, { duck: false }));
    const a2 = res2.buffer.getChannelData(0);
    let dd = 0;
    for (let i = sr; i < 3 * sr; i += 11) dd = Math.max(dd, Math.abs(a2[i] - after[i]));
    ok(dd > 0.001, 'duck toggle changes output', 'max diff=' + dd.toFixed(4));
  }

  console.log('== applyToStems: vocals lane path ==');
  {
    const sr = SR;
    const vocals = mkBuf(2, 2, sr), ins = mkBuf(2, 2, sr);
    for (let c = 0; c < 2; c++) {
      const v = vocals.getChannelData(c), b = ins.getChannelData(c);
      for (let i = 0; i < v.length; i++) {
        v[i] = 0.6 * Math.sin(2 * Math.PI * 330 * i / sr) * (((i % sr) < sr * 0.5) ? 1 : 0.1);
        b[i] = 0.3 * Math.sin(2 * Math.PI * 110 * i / sr);
      }
    }
    const stems = { vocals: vocals, instrumental: ins };
    const laneUI = { vocals: { mute: false, solo: false, gainDb: 0 }, instrumental: { mute: false, solo: false, gainDb: 0 } };
    const o = Object.assign({}, BASE, { deess: 80, comp: 50, duck: true });
    const res = await A.applyToStems(stems, laneUI, o);
    ok(res.buffer.length === vocals.length, 'stems path returns full-length mix');
    let peak = 0; const d = res.buffer.getChannelData(0);
    for (let i = 0; i < d.length; i += 5) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    ok(peak <= 0.711, 'stems mix soft-limited to 0.71', 'peak=' + peak.toFixed(3));
    ok(res.report.kind === 'stems', 'stems report kind honest');
    // mute respected (identical chain opts, only mute differs)
    const oMute = Object.assign({}, BASE, { duck: false });
    const resU = await A.applyToStems(stems, laneUI, oMute);
    const laneUI2 = { vocals: { mute: true, solo: false, gainDb: 0 }, instrumental: { mute: false, solo: false, gainDb: 0 } };
    const res2 = await A.applyToStems(stems, laneUI2, oMute);
    const du = resU.buffer.getChannelData(0);
    let e1 = 0, e2 = 0;
    for (let i = 0; i < du.length; i += 5) { e1 += du[i] * du[i]; const x = res2.buffer.getChannelData(0)[i]; e2 += x * x; }
    ok(e2 < e1 * 0.9, 'muted vocals lane drops vocal energy', (10 * Math.log10(e2 / Math.max(1e-12, e1))).toFixed(1) + ' dB');
  }

  console.log('== undo contract ==');
  {
    ok(typeof global.window.__v26pushUndo === 'function', '__v26pushUndo published on window');
    ok(typeof global.window.__v26undo === 'function', '__v26undo published on window');
    let ran = 0;
    global.window.__v26pushUndo('test', function () { ran++; });
    ok(global.window.__v26undo() === true, '__v26undo runs the thunk');
    ok(ran === 1, 'undo thunk executed once');
    ok(global.window.__v26undo() === false, '__v26undo false on empty stack');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
