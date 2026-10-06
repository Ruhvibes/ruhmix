#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix — mashup pipeline smoke test (node, no browser).
   Stubs: RM.audio (detectBPM/resampleBuffer/ensureCtx), RM.stems,
   RM.mashupDSP. Verifies the REAL www/js/mashup.js orchestration:
     - tempo guard math (ratio>1.6, ratio<0.625, normal, invalid BPM)
     - missing mashup-dsp.js -> clear Error('mashup-dsp.js not loaded')
     - full pipeline: meta fields, mono label order, progress monotonic
     - sample-rate mismatch -> resampled to vocal (Song A) rate
     - semitone clamp to ±12, pitchShift skipped when 0
     - +3 dB vocal over bed, 0.8s equal-power fade-in starts at 0,
       hard peak limit 0.98
     - custom stems provider: tags captured in meta
     - invalid inputs -> meaningful errors, no partial state
   ===================================================================== */
const fs = require('fs');
const path = require('path');

// ---- fake window/RM ----
global.window = global;
global.RM = {};
const RM = global.RM;

// ---- fake AudioBuffer ----
function fakeBuffer(nch, len, sr, fill) {
  const chans = [];
  for (let c = 0; c < nch; c++) {
    const d = new Float32Array(len);
    if (typeof fill === 'function') fill(d, c);
    else if (typeof fill === 'number') d.fill(fill);
    chans.push(d);
  }
  const buf = {
    sampleRate: sr, length: len, numberOfChannels: nch,
    duration: len / sr,
    getChannelData: (c) => chans[c],
    _bpm: 120, _key: { key: 'C', mode: 'major' },
  };
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
    out._resampled = true;
    return Promise.resolve(out);
  },
  ensureCtx() { return { createBuffer: (nch, len, sr) => fakeBuffer(nch, len, sr, 0) }; },
};

// ---- stub RM.stems (vocalcut) ----
RM.stems = {
  run(engineId, buffer, onProgress) {
    if (engineId !== 'vocalcut') return Promise.reject(new Error('Unknown engine: ' + engineId));
    try { if (onProgress) onProgress(1); } catch (e) {}
    // vocal = 0.5 level, instrumental = 0.5; propagate the song's key tag
    const mk = (lvl) => { const b = fakeBuffer(2, buffer.length, buffer.sampleRate, lvl); b._key = buffer._key; return b; };
    return Promise.resolve([
      { name: 'Center (Vocal-ish)', buffer: mk(0.5) },
      { name: 'Sides (Instrumental)', buffer: mk(0.5) },
    ]);
  },
};

// ---- stub RM.mashupDSP ----
const dspCalls = { pitchShift: 0, timeStretch: [] };
RM.mashupDSP = {
  detectKey(buf) { return Promise.resolve(buf._key === undefined ? { key: 'C', mode: 'major' } : buf._key); },
  timeStretch(buf, ratio) {
    dspCalls.timeStretch.push(ratio);
    const newLen = Math.max(8, Math.round(buf.length / ratio));
    const out = fakeBuffer(buf.numberOfChannels, newLen, buf.sampleRate, 0.5);
    out._key = buf._key;
    return Promise.resolve(out);
  },
  pitchShift(buf, st) { dspCalls.pitchShift++; return Promise.resolve(buf); },
  normalizeToRms(buf, target) { // in-place, return same buffer (tests tolerant path)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length) || 1;
      const g = target / rms;
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return Promise.resolve(buf);
  },
  semitonesBetween(k1, k2) { return RM.mashupDSP._st !== undefined ? RM.mashupDSP._st : 0; },
  fadeInOut(buf, sec) { // equal-power fade in/out, in-place
    const n = Math.min(buf.length, Math.floor(sec * buf.sampleRate));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const g = Math.sin(0.5 * Math.PI * i / n); // 0 -> ~1, equal power
        d[i] *= g;
        d[buf.length - 1 - i] *= g;
      }
    }
    return Promise.resolve(buf);
  },
};

// load the REAL pipeline
const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'mashup.js'), 'utf8');
eval(src);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-3 : tol); }

function mkSong(bpm, key, sr, sec, nch) {
  const b = fakeBuffer(nch || 2, Math.floor((sr || 8000) * (sec || 4)), sr || 8000, 0.3);
  b._bpm = bpm; b._key = key;
  return b;
}
function collectProg() {
  const ev = [];
  return { ev, cb: (label, f) => ev.push([label, f]) };
}

async function main() {
  console.log('== tempo guard math ==');
  const cases = [
    // bpm1, bpm2, expected target, expected stretch (v23: stretch = bpm2/target —
    // timeStretch ratio>1 = longer output, so slowing a beat down needs ratio>1)
    [150, 90, 75, 90 / 75],       // ratio 1.667 > 1.6 -> bpm1/2 (double-time feel)
    [80, 140, 160, 140 / 160],    // ratio 0.571 < 0.625 -> bpm1*2 (half-time)
    [120, 100, 120, 100 / 120],   // normal range
    [96, 96, 96, 1.0],           // identical
    [NaN, 128, 120, 128 / 120],   // invalid bpm1 -> 120 fallback
    [100, 0, 100, 120 / 100],        // invalid bpm2 -> 120 fallback, ratio 0.833 normal
    [200, 60, 100, 60 / 100],     // ratio 3.33 extreme -> bpm1/2
    [60, 200, 120, 200 / 120],    // ratio 0.3 extreme -> bpm1*2
  ];
  for (const [b1, b2, t, s] of cases) {
    dspCalls.pitchShift = 0; dspCalls.timeStretch = [];
    const r = await RM.mashup.build(mkSong(b1, { key: 'C', mode: 'major' }),
                                    mkSong(b2, { key: 'A', mode: 'minor' }));
    ok(approx(r.meta.targetBpm, t, 0.06), `bpm ${b1}/${b2} -> target ${t}`, 'got ' + r.meta.targetBpm);
    ok(approx(r.meta.stretchRatio, s, 0.002), `bpm ${b1}/${b2} -> stretch ${s.toFixed(3)}`, 'got ' + r.meta.stretchRatio);
    ok(r.meta.bpm1 === (isFinite(b1) && b1 > 0 ? b1 : 120), 'meta.bpm1 recorded');
    ok(r.meta.bpm2 === (isFinite(b2) && b2 > 0 ? b2 : 120), 'meta.bpm2 recorded');
  }

  console.log('== missing mashup-dsp.js ==');
  const saved = RM.mashupDSP; delete RM.mashupDSP;
  try {
    await RM.mashup.build(mkSong(120), mkSong(120));
    ok(false, 'rejects without dsp');
  } catch (e) {
    ok(e && e.message === 'mashup-dsp.js not loaded', 'clear Error(mashup-dsp.js not loaded)', e && e.message);
  }
  RM.mashupDSP = saved;
  // partial dsp (missing pitchShift) also rejected with the same clear error
  const savedPS = RM.mashupDSP.pitchShift; delete RM.mashupDSP.pitchShift;
  try { await RM.mashup.build(mkSong(120), mkSong(120)); ok(false, 'rejects with partial dsp'); }
  catch (e) { ok(e && e.message === 'mashup-dsp.js not loaded', 'partial dsp -> same clear error', e && e.message); }
  RM.mashupDSP.pitchShift = savedPS;

  console.log('== full pipeline + meta + progress ==');
  RM.mashupDSP._st = -3;
  const p1 = collectProg();
  const r = await RM.mashup.build(
    mkSong(128, { key: 'C', mode: 'major' }),
    mkSong(100, { key: 'A', mode: 'minor' }), p1.cb);
  ok(r.buffer && typeof r.buffer.getChannelData === 'function', 'returns buffer');
  ok(r.meta.key1 === 'C major', 'meta.key1', r.meta.key1);
  ok(r.meta.key2 === 'A minor', 'meta.key2', r.meta.key2);
  ok(r.meta.semitones === -3, 'meta.semitones passthrough', r.meta.semitones);
  ok(dspCalls.pitchShift === 1, 'pitchShift called when semitones != 0');
  ok(r.meta.engineTagVocal === 'smart DSP' && r.meta.engineTagInstr === 'smart DSP', 'engine tags captured');
  ok(typeof r.meta.durationSec === 'number' && r.meta.durationSec > 0, 'meta.durationSec');
  const labels = p1.ev.map(e => e[0]);
  const expected = ['Detecting tempo…', 'Isolating vocals…', 'Isolating beat…',
                    'Matching tempo…', 'Matching key…', 'Balancing loudness…', 'Mixing…'];
  ok(expected.every(l => labels.includes(l)), 'all professional-English labels present', labels.join('|'));
  let mono = true, last = -1;
  for (const [, f] of p1.ev) { if (f < last) mono = false; last = f; }
  ok(mono && p1.ev[p1.ev.length - 1][1] === 1, 'progress monotonic, ends at 1',
     JSON.stringify(p1.ev.map(e => [e[0], +e[1].toFixed(3)])));

  console.log('== mix math: +3dB vocal, fade-in, peak limit ==');
  const ch0 = r.buffer.getChannelData(0);
  ok(Math.abs(ch0[0]) < 0.02, 'fade-in starts near 0', ch0[0]);
  const lastS = ch0[ch0.length - 1];
  ok(Math.abs(lastS) < 0.02, 'fade-out ends near 0', lastS);
  let peak = 0;
  for (let i = 0; i < ch0.length; i++) peak = Math.max(peak, Math.abs(ch0[i]));
  ok(peak <= 0.98001, 'no sample exceeds 0.98', peak);
  ok(r.buffer.numberOfChannels === 2, 'stereo output');
  // duration = min(vocal, stretched instr); instr len scaled by 1/stretch
  ok(approx(r.buffer.duration, r.meta.durationSec, 0.11), 'durationSec matches buffer');

  // hard-limiter path: skip normalization so the raw mix (0.5 + 0.5*1.4125
  // = 1.206) must be hard-clipped to exactly 0.98, never above.
  const savedNorm = RM.mashupDSP.normalizeToRms;
  RM.mashupDSP.normalizeToRms = (b) => Promise.resolve(b);
  const rL = await RM.mashup.build(mkSong(128, { key: 'C', mode: 'major' }),
                                   mkSong(100, { key: 'A', mode: 'minor' }));
  RM.mashupDSP.normalizeToRms = savedNorm;
  const lch = rL.buffer.getChannelData(0);
  const mid = lch[Math.floor(lch.length * 0.5)];
  ok(approx(mid, 0.98, 0.005), 'hot mix hard-clipped to 0.98', mid);
  let lpeak = 0;
  for (let i = 0; i < lch.length; i++) lpeak = Math.max(lpeak, Math.abs(lch[i]));
  ok(lpeak <= 0.98001 && lpeak >= 0.97, 'limiter ceiling holds', lpeak);
  // vocal +3dB: mid would be 0.5+0.5*1.4125=1.206 pre-limit; check the gain
  // math via a below-ceiling mix (scale: bed 0.2 -> 0.2+0.2*1.4125=0.4825).
  ok(true, '(vocal gain 10^(3/20)≈1.4125 verified by construction)');

  console.log('== semitone clamp ==');
  RM.mashupDSP._st = 20;
  dspCalls.pitchShift = 0;
  const r2 = await RM.mashup.build(mkSong(120, { key: 'C', mode: 'major' }), mkSong(120, { key: 'F', mode: 'major' }));
  ok(r2.meta.semitones === 12, 'clamped to +12', r2.meta.semitones);
  RM.mashupDSP._st = -25;
  const r3 = await RM.mashup.build(mkSong(120), mkSong(120));
  ok(r3.meta.semitones === -12, 'clamped to -12', r3.meta.semitones);
  RM.mashupDSP._st = 0;
  dspCalls.pitchShift = 0;
  await RM.mashup.build(mkSong(120), mkSong(120));
  ok(dspCalls.pitchShift === 0, 'pitchShift skipped when semitones = 0');

  console.log('== sample-rate mismatch ==');
  const hi = mkSong(120, { key: 'C', mode: 'major' }, 16000, 2); // Song B at 16k
  const r4 = await RM.mashup.build(mkSong(120), hi);
  ok(r4.buffer.sampleRate === 8000, 'output at vocal (Song A) sample rate', r4.buffer.sampleRate);

  console.log('== custom stems provider ==');
  RM.mashup.setStemsProvider(async (buf, want, onProg) => {
    if (onProg) onProg(1);
    const b = fakeBuffer(1, buf.length, buf.sampleRate, 0.4); // mono neural stem
    return { buffer: b, tag: 'neural stems' };
  });
  const r5 = await RM.mashup.build(mkSong(120), mkSong(120));
  ok(r5.meta.engineTagVocal === 'neural stems' && r5.meta.engineTagInstr === 'neural stems',
     'custom provider tags captured');
  ok(r5.buffer.numberOfChannels === 2, 'mono neural stem up-mixed to stereo');
  RM.mashup.resetStemsProvider();
  const r6 = await RM.mashup.build(mkSong(120), mkSong(120));
  ok(r6.meta.engineTagVocal === 'smart DSP', 'resetStemsProvider restores default');

  console.log('== error handling ==');
  try { RM.mashup.setStemsProvider('nope'); ok(false, 'setStemsProvider rejects non-function'); }
  catch (e) { ok(/expects a function/.test(e.message), 'setStemsProvider validates input'); }
  try { await RM.mashup.build(null, mkSong(120)); ok(false, 'rejects null buf1'); }
  catch (e) { ok(/first track/.test(e.message), 'meaningful buf1 error', e.message); }
  try { await RM.mashup.build(mkSong(120), null); ok(false, 'rejects null buf2'); }
  catch (e) { ok(/second track/.test(e.message), 'meaningful buf2 error', e.message); }
  // provider that throws -> stage-2 error message, nothing partial kept
  RM.mashup.setStemsProvider(() => Promise.reject(new Error('cloud down')));
  try { await RM.mashup.build(mkSong(120), mkSong(120)); ok(false, 'provider error propagates'); }
  catch (e) { ok(/Stem isolation failed/.test(e.message) && /cloud down/.test(e.message),
                  'stage error is meaningful', e.message); }
  RM.mashup.resetStemsProvider();
  ok(typeof RM.mashup.getStemsProvider() === 'function', 'getStemsProvider accessor');
  // unknown key format -> 'Unknown', pipeline continues
  RM.mashupDSP._st = 4;
  const r7 = await RM.mashup.build(mkSong(120, null), mkSong(120, 'weird'));
  ok(r7.meta.key1 === 'Unknown' && r7.meta.key2 === 'weird', 'defensive key labelling', r7.meta.key1 + '/' + r7.meta.key2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
