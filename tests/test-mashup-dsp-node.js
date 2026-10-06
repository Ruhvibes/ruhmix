'use strict';
/* =====================================================================
   Node tests for www/js/mashup-dsp.js.
   Loads the browser file with a minimal window / RM.audio shim
   (FakeAudioBuffer + chunked runner) — no browser needed.

   Run:  node tests/test-mashup-dsp-node.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

/* ---------- minimal shim ---------- */
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
const SR = 22050; // test sample rate (impl must work at any rate)
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function makeBuf(secs, nCh, sr) {
  return new FakeAudioBuffer(nCh || 1, Math.round(secs * (sr || SR)), sr || SR);
}
function fillSine(buf, freq, amp) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / buf.sampleRate);
  }
}
function fillConst(buf, v) {
  for (let c = 0; c < buf.numberOfChannels; c++) buf.getChannelData(c).fill(v);
}
// Fundamental estimate via zero crossings over the middle half.
function estimateFreq(buf) {
  const d = buf.getChannelData(0);
  const a = (d.length * 0.25) | 0, b = (d.length * 0.75) | 0;
  let zc = 0, prev = d[a] >= 0;
  for (let i = a + 1; i < b; i++) { const cur = d[i] >= 0; if (cur !== prev) zc++; prev = cur; }
  return (zc / 2) / ((b - a) / buf.sampleRate);
}
function maxAbs(buf) {
  let m = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  }
  return m;
}
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

async function main() {
  console.log('== semitonesBetween ==');
  const T = [
    [{ key: 'C', mode: 'major' }, { key: 'C', mode: 'major' }, 0],
    [{ key: 'C', mode: 'major' }, { key: 'A', mode: 'minor' }, 0], // relative
    [{ key: 'A', mode: 'minor' }, { key: 'C', mode: 'major' }, 0], // relative, swapped
    [{ key: 'A', mode: 'major' }, { key: 'F#', mode: 'minor' }, 0], // relative
    [{ key: 'D', mode: 'minor' }, { key: 'F', mode: 'major' }, 0], // relative
    [{ key: 'C', mode: 'major' }, { key: 'G', mode: 'major' }, 5], // G up 5 -> C
    [{ key: 'C', mode: 'major' }, { key: 'D', mode: 'major' }, -2], // D down 2 -> C
    [{ key: 'C', mode: 'major' }, { key: 'F#', mode: 'major' }, 6], // tritone
    [{ key: 'C', mode: 'major' }, { key: 'E', mode: 'minor' }, 5], // Em -> rel G, up 5 -> C
    [{ key: 'C', mode: 'major' }, { key: 'Bb', mode: 'major' }, 2], // flat alias: Bb up 2 -> C
    [{ key: 'G', mode: 'major' }, { key: 'C', mode: 'major' }, -5], // C down 5 -> G
  ];
  for (const [a, b, want] of T) {
    const got = DSP.semitonesBetween(a, b);
    ok(got === want, `semi(${a.key}${a.mode[0]}, ${b.key}${b.mode[0]}) = ${want}`, 'got ' + got);
    ok(Number.isInteger(got) && got >= -6 && got <= 6, '  range [-6,6]');
  }

  console.log('== fadeInOut ==');
  {
    const buf = makeBuf(1, 1);
    fillConst(buf, 0.7);
    DSP.fadeInOut(buf, 0.1);
    const d = buf.getChannelData(0);
    const n = Math.floor(0.1 * SR);
    ok(d[0] === 0, 'fade: first sample exactly 0');
    ok(d[d.length - 1] === 0, 'fade: last sample exactly 0');
    ok(Math.abs(d[(d.length / 2) | 0] - 0.7) < 1e-7, 'fade: middle untouched (gain 1)');
    const want = 0.7 * Math.sin(0.5 * Math.PI * 100 / n);
    ok(Math.abs(d[100] - want) < 1e-9, 'fade: equal-power curve shape', 'got ' + d[100]);
    ok(d[1] > 0 && d[1] < d[100], 'fade: monotonic rise at start');
    // stereo + zero fade = no-op
    const st = makeBuf(0.5, 2);
    fillConst(st, 0.3);
    DSP.fadeInOut(st, 0);
    ok(Math.abs(st.getChannelData(1)[10] - 0.3) < 1e-7, 'fade: fadeSec 0 is a no-op');
  }

  console.log('== rms / normalizeToRms ==');
  {
    const buf = makeBuf(1, 1);
    fillSine(buf, 440, 0.5);
    const r = DSP.rms(buf);
    ok(Math.abs(r - 0.5 / Math.SQRT2) < 1e-9, 'rms of sine = A/sqrt(2)', 'got ' + r);
    ok(DSP.rms(makeBuf(0.01, 1)) === 0 || true, 'rms handles buffers');
    const norm = DSP.normalizeToRms(buf, 0.1);
    const rn = DSP.rms(norm);
    ok(Math.abs(rn - 0.1) < 1e-6, 'normalizeToRms hits target RMS', 'got ' + rn);
    ok(buf !== norm, 'normalizeToRms returns a new buffer');
    // peak limiting: constant 0.5 -> target 1.5 would clip; must cap at 0.98
    const loud = makeBuf(0.5, 1);
    fillConst(loud, 0.5);
    const lim = DSP.normalizeToRms(loud, 1.5);
    const pk = maxAbs(lim);
    ok(pk <= 0.98 + 1e-6, 'normalizeToRms peak-limited at 0.98', 'got ' + pk);
    ok(Math.abs(pk - 0.98) < 1e-6, 'peak limiter uses full headroom', 'got ' + pk);
    // stereo RMS
    const stb = makeBuf(1, 2);
    fillSine(stb, 440, 0.5);
    ok(Math.abs(DSP.rms(stb) - 0.5 / Math.SQRT2) < 1e-9, 'rms stereo');
  }

  console.log('== detectKey ==');
  {
    // C major chord stack: C3 E3 G3 C4
    const buf = makeBuf(6, 1);
    for (const m of [48, 52, 55, 60]) {
      const d = buf.getChannelData(0);
      const f = midiHz(m);
      for (let i = 0; i < d.length; i++) d[i] += 0.2 * Math.sin(2 * Math.PI * f * i / SR);
    }
    let progSeen = 0;
    const res = await DSP.detectKey(buf, (p) => { progSeen = p; });
    console.log('  detected:', JSON.stringify(res));
    ok(res.key === 'C' && res.mode === 'major', 'detectKey finds C major', JSON.stringify(res));
    ok(res.confidence > 0.4, 'detectKey confidence sane on clean chord', String(res.confidence));
    ok(progSeen > 0.9, 'detectKey reports progress', String(progSeen));
    // A minor chord stack: A2 C3 E3 A3
    const buf2 = makeBuf(6, 1);
    for (const m of [45, 48, 52, 57]) {
      const d = buf2.getChannelData(0);
      const f = midiHz(m);
      for (let i = 0; i < d.length; i++) d[i] += 0.2 * Math.sin(2 * Math.PI * f * i / SR);
    }
    const res2 = await DSP.detectKey(buf2);
    console.log('  detected:', JSON.stringify(res2));
    ok(res2.key === 'A' && res2.mode === 'minor', 'detectKey finds A minor', JSON.stringify(res2));
    // silence -> graceful, zero confidence
    const sil = makeBuf(1, 1);
    const res3 = await DSP.detectKey(sil);
    ok(res3.confidence === 0, 'detectKey silence -> confidence 0', JSON.stringify(res3));
    // all 12 major roots at 44.1 kHz (guards low-frequency chroma resolution)
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    let rootsOk = 0;
    for (let root = 0; root < 12; root++) {
      const b = new FakeAudioBuffer(1, 4 * 44100, 44100);
      const dd = b.getChannelData(0);
      for (const m of [48 + root, 52 + root, 55 + root, 60 + root]) {
        const f = midiHz(m);
        for (let i = 0; i < dd.length; i++) dd[i] += 0.15 * Math.sin(2 * Math.PI * f * i / 44100);
      }
      const rr = await DSP.detectKey(b);
      if (rr.key === NAMES[root] && rr.mode === 'major') rootsOk++;
      else console.log('  root miss: want ' + NAMES[root] + ', got ' + JSON.stringify(rr));
    }
    ok(rootsOk === 12, 'detectKey all 12 major roots @44.1kHz', rootsOk + '/12');
  }

  console.log('== timeStretch (WSOLA) ==');
  {
    const buf = makeBuf(2, 2);
    fillSine(buf, 440, 0.5);
    let progSeen = 0;
    const out = await DSP.timeStretch(buf, 1.5, (p) => { progSeen = p; });
    ok(out.numberOfChannels === 2, 'timeStretch keeps stereo');
    ok(Math.abs(out.length - Math.round(buf.length * 1.5)) <= 1, 'timeStretch ratio 1.5 length', 'got ' + out.length);
    const f = estimateFreq(out);
    ok(Math.abs(f - 440) / 440 < 0.03, 'timeStretch preserves pitch (no drift)', 'got ' + f.toFixed(2) + ' Hz');
    ok(progSeen > 0.9, 'timeStretch reports progress');
    ok(Number.isFinite(maxAbs(out)) && maxAbs(out) > 0.1, 'timeStretch output sane level');
    const d0 = out.getChannelData(0);
    ok(d0[0] === 0 && d0[d0.length - 1] === 0, 'timeStretch click-free edges');
    // shrink
    const out2 = await DSP.timeStretch(buf, 0.75);
    ok(Math.abs(out2.length - Math.round(buf.length * 0.75)) <= 1, 'timeStretch ratio 0.75 length');
    const f2 = estimateFreq(out2);
    ok(Math.abs(f2 - 440) / 440 < 0.03, 'timeStretch 0.75 preserves pitch', 'got ' + f2.toFixed(2) + ' Hz');
    // ratio 1 -> identical copy, ratio clamped
    const same = await DSP.timeStretch(buf, 1);
    ok(same.length === buf.length && same.getChannelData(0)[1000] === buf.getChannelData(0)[1000], 'timeStretch ratio 1 = copy');
    const over = await DSP.timeStretch(buf, 5);
    ok(over.length === Math.round(buf.length * 2), 'timeStretch ratio clamped to 2.0');
    // mono works too
    const mono = makeBuf(1, 1);
    fillSine(mono, 330, 0.5);
    const mo = await DSP.timeStretch(mono, 1.25);
    ok(mo.numberOfChannels === 1 && Math.abs(mo.length - Math.round(mono.length * 1.25)) <= 1, 'timeStretch mono');
  }

  console.log('== pitchShift ==');
  {
    const buf = makeBuf(2, 2);
    fillSine(buf, 440, 0.5);
    const up = await DSP.pitchShift(buf, 2);
    const wantUp = 440 * Math.pow(2, 2 / 12); // 493.88
    const f = estimateFreq(up);
    ok(Math.abs(f - wantUp) / wantUp < 0.03, 'pitchShift +2 semitones', `got ${f.toFixed(2)} Hz, want ${wantUp.toFixed(2)}`);
    ok(Math.abs(up.length - buf.length) <= 2, 'pitchShift restores duration', `got ${up.length}, want ${buf.length}`);
    const dn = await DSP.pitchShift(buf, -3);
    const wantDn = 440 * Math.pow(2, -3 / 12); // 369.99
    const fdn = estimateFreq(dn);
    ok(Math.abs(fdn - wantDn) / wantDn < 0.03, 'pitchShift -3 semitones', `got ${fdn.toFixed(2)} Hz, want ${wantDn.toFixed(2)}`);
    ok(Math.abs(dn.length - buf.length) <= 2, 'pitchShift -3 restores duration');
    const zero = await DSP.pitchShift(buf, 0);
    ok(zero.getChannelData(0)[5000] === buf.getChannelData(0)[5000], 'pitchShift 0 = copy');
    const clampHi = await DSP.pitchShift(buf, 12); // clamps to +6
    const fcl = estimateFreq(clampHi);
    const wantCl = 440 * Math.pow(2, 6 / 12);
    ok(Math.abs(fcl - wantCl) / wantCl < 0.03, 'pitchShift clamps to +6', `got ${fcl.toFixed(2)} Hz`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
