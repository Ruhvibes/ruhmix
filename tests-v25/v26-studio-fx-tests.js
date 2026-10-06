'use strict';
/* =====================================================================
   RuhMix v26 — Worker I3 (Studio BPM / pitch / automation / transitions)
   Node tests for www/js/v26-studio-fx.js (+ its real DSP deps:
   v25-mixmaster.js buildTransition/buildAutomationCurve/applyAutomation,
   mashup-dsp.js timeStretch/pitchShift).

   Loads the browser files with a minimal window / RM.audio shim
   (FakeAudioBuffer + chunked runner) — no browser needed.

   Run:  node tests-v25/v26-studio-fx-tests.js   (from ~/workspace/ruhmix)
   ===================================================================== */
const fs = require('fs');
const path = require('path');

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

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  eval(src);
}
load('www/js/v25-mixmaster.js');
load('www/js/mashup-dsp.js');
load('www/js/v26-studio-fx.js');

const FX = global.window.RM.v26fx;
const T = FX.internals;
const DSP = global.window.RM.mashupDSP;
const MIX = global.window.RM.v25mix;
if (!FX || !DSP || !MIX) { console.error('FAIL: modules not exposed'); process.exit(1); }

const SR = 8000;
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function sineBuf(sec, freq, amp) {
  const n = Math.round(sec * SR);
  const b = new FakeAudioBuffer(2, n, SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
  }
  return b;
}
function rmsRange(buf, aSec, bSec) { return T.rmsOf(buf, aSec, bSec); }
function maxAbsDiff(a, b, from, to) {
  let m = 0;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c), y = b.getChannelData(c);
    for (let i = from; i < to && i < x.length && i < y.length; i++) {
      const d = Math.abs(x[i] - y[i]);
      if (d > m) m = d;
    }
  }
  return m;
}
function zeroXFreq(buf, aSec, bSec) { // dominant freq proxy for a clean tone
  const d = buf.getChannelData(0);
  const a = Math.round(aSec * SR), b = Math.round(bSec * SR);
  let zc = 0;
  for (let i = a + 1; i < b; i++) if ((d[i] >= 0) !== (d[i - 1] >= 0)) zc++;
  return zc / (bSec - aSec) / 2;
}

(async function main() {
  console.log('— v26-studio-fx pure helpers —');
  {
    const r = T.stretchRatioForBpm(120, 160);
    ok(Math.abs(r.ratio - 0.75) < 1e-12 && Math.abs(r.effBpm - 160) < 1e-9 && !r.clamped,
      'stretchRatioForBpm(120,160) = 0.75, no clamp', JSON.stringify(r));
  }
  {
    const r = T.stretchRatioForBpm(120, 40); // ratio 3 -> clamped to 2
    ok(Math.abs(r.ratio - 2) < 1e-12 && Math.abs(r.effBpm - 60) < 1e-9 && r.clamped,
      'stretchRatioForBpm(120,40) clamps to eff 60 BPM', JSON.stringify(r));
  }
  {
    const r = T.stretchRatioForBpm(120, 300); // ratio 0.4 -> clamped to 0.5
    ok(Math.abs(r.ratio - 0.5) < 1e-12 && Math.abs(r.effBpm - 240) < 1e-9 && r.clamped,
      'stretchRatioForBpm(120,300) clamps to eff 240 BPM', JSON.stringify(r));
  }
  {
    const c = T.clampPitch(12, 0);
    ok(c.total === 6 && c.clamped === true, 'clampPitch(+12) -> +6, clamped', JSON.stringify(c));
    const c2 = T.clampPitch(-8, -50);
    ok(c2.total === -6 && c2.clamped === true, 'clampPitch(-8.5) -> -6, clamped', JSON.stringify(c2));
    const c3 = T.clampPitch(3, 50);
    ok(Math.abs(c3.total - 3.5) < 1e-12 && c3.clamped === false, 'clampPitch(+3.5) passes through', JSON.stringify(c3));
  }
  {
    const pts = [{ t: 0, g: 1 }, { t: 10, g: 0.5 }];
    ok(Math.abs(T.interpGain(pts, 5) - 0.75) < 1e-12, 'interpGain midpoint = 0.75');
    ok(T.interpGain(pts, -3) === 1 && T.interpGain(pts, 99) === 0.5, 'interpGain holds endpoints');
  }
  {
    const secs = T.automationToSections([{ t: 0, g: 1 }], 4, 120);
    ok(secs.length === 2 && Math.abs(secs[0].gainDb) < 1e-9 && secs[0].bars === 1,
      'automationToSections: 4s @120bpm -> 2 bars @ 0 dB', JSON.stringify(secs));
    const secs2 = T.automationToSections([{ t: 0, g: 0.5 }], 4, 120);
    ok(Math.abs(secs2[0].gainDb - (-6.0206)) < 0.01, 'gain 0.5 -> -6.02 dB', JSON.stringify(secs2[0]));
  }

  console.log('— timeStretch / pitchShift (real engines) —');
  {
    const buf = sineBuf(2, 440, 0.5);
    const out = await DSP.timeStretch(buf, 0.75);
    ok(out.length === Math.round(buf.length * 0.75),
      'timeStretch(0.75): duration scales exactly', out.length + ' vs ' + Math.round(buf.length * 0.75));
  }
  {
    const buf = sineBuf(2, 440, 0.5);
    const out = await DSP.timeStretch(buf, 1.5);
    ok(out.length === Math.round(buf.length * 1.5),
      'timeStretch(1.5): duration scales exactly', out.length + ' vs ' + Math.round(buf.length * 1.5));
  }
  {
    const buf = sineBuf(1, 440, 0.5);
    const out = await DSP.pitchShift(buf, 3);
    ok(Math.abs(out.length - buf.length) <= 2,
      'pitchShift(+3): duration preserved', 'in ' + buf.length + ' out ' + out.length);
  }
  {
    const buf = sineBuf(2, 440, 0.5);
    const out = await DSP.pitchShift(buf, 6);
    const f = zeroXFreq(out, 0.5, 1.5);
    const exp = 440 * Math.pow(2, 6 / 12);
    ok(Math.abs(f - exp) / exp < 0.06,
      'pitchShift(+6): 440 Hz -> ~622 Hz', 'measured ' + f.toFixed(1) + ' Hz, expected ' + exp.toFixed(1));
  }

  console.log('— automation render: RMS follows 100/70/40/100 —');
  {
    const DUR = 32, buf = sineBuf(DUR, 220, 0.5);
    const pts = [
      { t: 0, g: 1.0 }, { t: 8, g: 1.0 },
      { t: 8, g: 0.7 }, { t: 16, g: 0.7 },
      { t: 16, g: 0.4 }, { t: 24, g: 0.4 },
      { t: 24, g: 1.0 }, { t: 32, g: 1.0 },
    ];
    const out = T.renderAutomation(buf, pts, 120);
    ok(out.length === buf.length, 'renderAutomation keeps length');
    // The engine slews <=3 dB/bar and interpolates between bar values, so
    // ramps straddle the step instants: measure only fully-settled regions
    // (bars 0-2 @1.0, bars 5-6 @0.7, bar 9 @0.4, bars 14-15 @1.0).
    const r1 = rmsRange(out, 1, 5), r2 = rmsRange(out, 11, 13),
          r3 = rmsRange(out, 18.5, 19.5), r4 = rmsRange(out, 29, 31);
    ok(Math.abs(r2 / r1 - 0.7) < 0.08, 'segment RMS 70% of full', (r2 / r1).toFixed(3));
    ok(Math.abs(r3 / r1 - 0.4) < 0.08, 'segment RMS 40% of full', (r3 / r1).toFixed(3));
    ok(Math.abs(r4 - r1) / r1 < 0.1, 'final segment back to ~100%', (r4 / r1).toFixed(3));
    ok(r2 < r1 && r3 < r2, 'RMS ordering follows the lane (1.0 > 0.7 > 0.4)');
  }
  {
    const buf = sineBuf(4, 220, 0.5);
    const before = rmsRange(buf, 0, 4);
    const out = T.renderAutomation(buf, [{ t: 0, g: 0.5 }], 120);
    const after = rmsRange(out, 1, 3);
    ok(Math.abs(after / before - 0.5) < 0.06, 'flat 50% lane halves RMS', (after / before).toFixed(3));
  }

  console.log('— all 10 buildTransition types modify audio at a junction —');
  {
    const types = T.listTransitionTypes().map(t => t.id);
    const want = ['crossfade', 'smooth', 'fill', 'riser', 'downlifter',
                  'filter-sweep', 'echo-out', 'reverb-tail', 'vocal-chop', 'drop'];
    ok(want.every(id => types.indexOf(id) >= 0), 'all 10 types listed', types.join(','));
    for (const id of want) {
      const overlap = T.isCrossfadeFamily(id);
      const desc = MIX.buildTransition(id, 2, { bpm: 120, sr: SR, energy: 0.7 });
      const N = desc.lengthSamples;
      const junc = N + 2000;
      const len = junc + N + 40000; // room for the window + tail/overlap head
      let buf, beforeDesc;
      if (overlap) {
        // Different material each side: 440 Hz before, 660 Hz after —
        // a complementary crossfade of identical audio is transparent
        // by construction, so the blend needs contrast to be audible.
        buf = new FakeAudioBuffer(2, len, SR);
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < len; i++)
            d[i] = 0.5 * Math.sin(2 * Math.PI * (i < junc ? 440 : 660) * i / SR);
        }
        beforeDesc = 'two-tone buffer';
      } else {
        buf = sineBuf(len / SR, 440, 0.5);
        beforeDesc = 'sine buffer';
      }
      const before = buf.getChannelData(0).slice();
      const res = T.applyTransitionAt(buf, junc, desc, overlap);
      const out = res.buffer;
      const inputUntouched = (() => {
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) if (d[i] !== before[i]) return false;
        return true;
      })();
      if (overlap) {
        // True crossfade: buffer shrinks by N; the blend region changed.
        const changed = maxAbsDiff(out, buf, junc - N, junc);
        const headIntact = maxAbsDiff(out, buf, 0, junc - N) === 0;
        let tailIntact = true;
        for (let c = 0; c < 2 && tailIntact; c++) {
          const x = out.getChannelData(c), y = buf.getChannelData(c);
          for (let i = junc; i < x.length; i++) if (x[i] !== y[i + N]) { tailIntact = false; break; }
        }
        ok(out.length === buf.length - N && res.shrinkSamples === N &&
           changed > 1e-6 && headIntact && tailIntact && inputUntouched,
          'transition "' + id + '" is a true overlap crossfade',
          'maxDiff=' + changed.toExponential(2) + ' shrink=' + res.shrinkSamples);
      } else {
        const changed = maxAbsDiff(out, buf, junc - N, Math.min(len, junc + 40000));
        const preIntact = maxAbsDiff(out, buf, 0, junc - N) === 0;
        ok(out.length === buf.length && res.shrinkSamples === 0 &&
           changed > 1e-6 && preIntact && inputUntouched,
          'transition "' + id + '" modifies junction audio only',
          'maxDiff=' + changed.toExponential(2) + ' preIntact=' + preIntact);
      }
    }
  }
  {
    // Overlap crossfades genuinely blend the two sides (not a no-op):
    // left half sine 440 Hz, right half sine 660 Hz — the blend region
    // must contain energy from both.
    const desc = MIX.buildTransition('smooth', 2, { bpm: 120, sr: SR });
    const N = desc.lengthSamples, junc = N + 2000, len = junc + N + 8000;
    const buf = new FakeAudioBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++)
        d[i] = 0.5 * Math.sin(2 * Math.PI * (i < junc ? 440 : 660) * i / SR);
    }
    const res = T.applyTransitionAt(buf, junc, desc, true);
    const mid = res.buffer.getChannelData(0).subarray(junc - N, junc);
    // The first quarter of the blend should still look like the left side
    // (440 Hz) and the last quarter like the right side (660 Hz).
    const fA = (() => { let z = 0; const s = Math.floor(mid.length / 4);
      for (let i = 1; i < s; i++) if ((mid[i] >= 0) !== (mid[i-1] >= 0)) z++;
      return z / (s / SR) / 2; })();
    const fB = (() => { let z = 0; const s0 = Math.floor(mid.length * 3 / 4);
      for (let i = s0 + 1; i < mid.length; i++) if ((mid[i] >= 0) !== (mid[i-1] >= 0)) z++;
      return z / ((mid.length - s0) / SR) / 2; })();
    ok(Math.abs(fA - 440) / 440 < 0.1 && Math.abs(fB - 660) / 660 < 0.1,
      'smooth crossfade blends 440 Hz -> 660 Hz across the junction',
      fA.toFixed(0) + ' Hz / ' + fB.toFixed(0) + ' Hz');
  }
  {
    const desc = MIX.buildTransition('fill', 2, { bpm: 120, sr: SR });
    const buf = sineBuf(4, 440, 0.5);
    let threw = false;
    try { T.applyTransitionAt(buf, 100, desc); } catch (e) { threw = true; }
    ok(threw, 'applyTransitionAt throws when the junction is too early for the window');
    const descX = MIX.buildTransition('crossfade', 2, { bpm: 120, sr: SR });
    const Nx = descX.lengthSamples, jx = Nx + 2000;
    const shortBuf = sineBuf((jx + Nx / 2) / SR, 440, 0.5); // < N samples after junc
    let threw2 = false;
    try { T.applyTransitionAt(shortBuf, jx, descX, true); } catch (e) { threw2 = true; }
    ok(threw2, 'overlap crossfade throws when too little audio follows the junction');
  }

  console.log('— undo mini-stack + lastOp + shared v26 convention —');
  {
    const calls = [];
    T.pushUndo('test-op', () => calls.push('undo'), () => calls.push('redo'));
    ok(FX.lastOp && FX.lastOp.label === 'test-op', 'lastOp mirrors the pushed op');
    FX.undo();
    ok(calls.join(',') === 'undo', 'undo() runs the undo fn');
    FX.redo();
    ok(calls.join(',') === 'undo,redo', 'redo() runs the do fn');
    FX.undo(); FX.undo();
    ok(calls.join(',') === 'undo,redo,undo', 'second undo on empty stack is a safe no-op');
  }
  {
    // Shared convention: this file loads first, so it publishes
    // __v26pushUndo(label, undoFn) / __v26undo() (I6's signature).
    const g = global.window;
    ok(typeof g.__v26pushUndo === 'function' && g.__v26pushUndo._v26fx === true,
      '__v26pushUndo published (first-wins, I6-compatible signature)');
    ok(typeof g.__v26undo === 'function', '__v26undo published');
    const ext = [];
    const before = (function () { let n = 0; return n; })();
    g.__v26pushUndo('external-op', () => ext.push('undone'));
    ok(g.__v26undo() === true && ext.join(',') === 'undone',
      'foreign op pushed via shared convention is undoable here');
    // Foreign ops carry no redo fn: redo is honestly refused, state kept.
    const r = FX.redo();
    ok(r === false, 'redo of a foreign op is refused (no redo fn)');
    // pushUndo must not double-push when the shared fn is ours.
    const d0 = T.undoDepth();
    T.pushUndo('count-op', () => {}, () => {});
    ok(T.undoDepth() === d0 + 1, 'pushUndo adds exactly one entry (no double-push)',
      'depth ' + d0 + ' -> ' + T.undoDepth());
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
