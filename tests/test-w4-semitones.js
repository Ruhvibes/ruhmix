#!/usr/bin/env node
'use strict';
/* =====================================================================
   W4 — semitonesBetween string-key fix verification (REAL mashup-dsp.js).
   Old bug: string keys ('C major', 'A minor') silently degraded to C
   major inside semitonesBetween -> wrong pitch-shift on the mashup beat.
   The fix parses strings via normKey(). This test loads the REAL
   www/js/mashup-dsp.js and checks object AND string inputs, including
   flat aliases, 'min'/'m' shorthand, and relative major/minor pairs.
   ===================================================================== */
const fs = require('fs');
const path = require('path');

global.window = {};
class FakeAudioBuffer {
  constructor(nCh, len, sr) {
    this.numberOfChannels = nCh; this.length = Math.max(0, len | 0);
    this.sampleRate = sr; this.duration = this.length / sr;
    this._ch = [];
    for (let c = 0; c < nCh; c++) this._ch.push(new Float32Array(this.length));
  }
  getChannelData(c) { return this._ch[c]; }
}
const fakeCtx = { sampleRate: 44100, createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || 44100) };
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

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const show = (k) => (typeof k === 'string' ? JSON.stringify(k) : k.key + ' ' + k.mode);

async function main() {
  console.log('== semitonesBetween: string keys (the old-bug case) ==');
  const T = [
    // [keyA, keyB, expected]  — positive = shift B up to match A
    ['C major', 'C major', 0],
    ['C major', 'A minor', 0],   // relative pair -> 0  (old bug: also 0 but for the WRONG reason)
    ['A minor', 'C major', 0],   // swapped relative pair
    ['G major', 'C major', -5],  // C down 5 -> G   (old bug: string->C major, 0)
    ['C major', 'G major', 5],   // G up 5 -> C
    ['C major', 'D major', -2],  // D down 2 -> C
    ['C major', 'F# major', 6], // tritone -> +6
    ['C major', 'E minor', 5],   // Em -> relative G, up 5 -> C
    ['C major', 'Bb major', 2],  // flat alias
    ['D minor', 'F major', 0],   // relative pair via strings
    ['C major', 'A min', 0],     // 'min' shorthand
    ['C major', 'A m', 0],       // 'm' shorthand
    ['E major', 'C# minor', 0],  // relative pair (E/C#m)
    ['F major', 'Bb major', -5],  // Bb down 5 -> F (up 5 would give Eb)
  ];
  for (const [a, b, want] of T) {
    const got = DSP.semitonesBetween(a, b);
    ok(got === want, `semi(${show(a)}, ${show(b)}) = ${want}`, 'got ' + got);
    ok(Number.isInteger(got) && got >= -6 && got <= 6, '  range [-6,6]');
  }

  console.log('== semitonesBetween: object keys still work (regression) ==');
  ok(DSP.semitonesBetween({ key: 'C', mode: 'major' }, { key: 'G', mode: 'major' }) === 5, 'objects unchanged');
  ok(DSP.semitonesBetween({ key: 'C', mode: 'major' }, { key: 'A', mode: 'minor' }) === 0, 'relative via objects');

  console.log('== semitonesBetween: mixed + garbage inputs (defensive) ==');
  ok(DSP.semitonesBetween('C major', { key: 'G', mode: 'major' }) === 5, 'mixed string/object');
  const g1 = DSP.semitonesBetween('weird', 'also weird');
  ok(Number.isInteger(g1) && g1 >= -6 && g1 <= 6, 'garbage strings -> safe default, in range', 'got ' + g1);
  const g2 = DSP.semitonesBetween(null, undefined);
  ok(Number.isInteger(g2) && g2 >= -6 && g2 <= 6, 'null/undefined -> safe default', 'got ' + g2);

  console.log('== the OLD bug would have produced ==');
  // Old behavior: any string -> C major, so semi('G major','C major') = 0
  // instead of -5. Verify we are NOT getting the old answers:
  const oldBugAnswers = { 'G major|C major': 0, 'C major|G major': 0, 'C major|F# major': 0 };
  for (const [pair, oldAns] of Object.entries(oldBugAnswers)) {
    const [a, b] = pair.split('|');
    const got = DSP.semitonesBetween(a, b);
    ok(got !== oldAns || pair === 'C major|C major', `NOT the old-bug answer for (${a}, ${b})`, 'got ' + got);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('FAILED:', fails.join(' | '));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
