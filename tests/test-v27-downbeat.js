'use strict';
/* =====================================================================
   Node tests for www/js/v27-downbeat.js (W7: real downbeat detection).
   Browser file loaded with minimal shims (FakeAudioBuffer, RM.audio,
   window/global). No browser needed.

   Covers: synthetic 4/4 (kick on 1) -> 100% downbeat accuracy;
   phase-shifted loop (kick on 2) -> shifted downbeat detected;
   ambiguous inputs (white noise, four-on-the-floor) -> confidence < 0.5
   and flagged uncertain; silence/short -> null; sync helpers
   (quantizeToDownbeat, shouldSnap, buildDownbeatMarkers); honest labels;
   3/4-ish evidence -> documented + confidence reduced; cache identity.

   Run: node tests/test-v27-downbeat.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

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
  sampleRate: 22050,
  createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || 22050),
};
global.window = {};
global.RM = {
  audio: {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
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

const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'v27-downbeat.js'), 'utf8');
eval(src);
const DB = global.window.RM.v27downbeat;
if (!DB) { console.error('FAIL: RM.v27downbeat not exposed'); process.exit(1); }

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------- deterministic synth ---------- */
const SR = 22050;
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mkBuf(secs, nCh) {
  return new FakeAudioBuffer(nCh || 1, Math.round(secs * SR), SR);
}
function addKick(d, at, amp, rng) {
  const s0 = Math.round(at * SR), n = Math.round(0.30 * SR);
  for (let i = 0; i < n && s0 + i < d.length; i++) {
    const t = i / SR;
    const env = Math.exp(-t / 0.07);
    d[s0 + i] += amp * (Math.sin(2 * Math.PI * 55 * t) * env +
      0.35 * Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t / 0.03));
  }
  // click transient (real kick drums have one — cf. beats.js): short
  // 2.8 kHz ping + noise click so the onset envelope sees the kick.
  const nc = Math.round(0.012 * SR);
  let prev = 0;
  for (let i = 0; i < nc && s0 + i < d.length; i++) {
    const t = i / SR, dec = Math.exp(-t / 0.004);
    const w = rng ? rng() * 2 - 1 : 0;
    const hp = w - prev; prev = w;
    d[s0 + i] += amp * 0.45 * (Math.sin(2 * Math.PI * 2800 * t) * dec + 0.6 * hp * dec);
  }
}
function addHat(d, at, amp, rng) {
  const s0 = Math.round(at * SR), n = Math.round(0.06 * SR);
  let prev = 0;
  for (let i = 0; i < n && s0 + i < d.length; i++) {
    const w = rng() * 2 - 1;
    const hp = w - prev; prev = w; // crude highpass: energy lives > 5 kHz
    d[s0 + i] += amp * hp * Math.exp(-(i / SR) / 0.015);
  }
}
function addBass(d, at, freq, amp, dur) {
  const s0 = Math.round(at * SR), n = Math.round((dur || 0.45) * SR);
  for (let i = 0; i < n && s0 + i < d.length; i++) {
    const t = i / SR;
    d[s0 + i] += amp * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.25);
  }
}
// 4/4 loop with the kick on `kickBeat` (0-based) of each bar. The whole
// musical bar — kick AND harmony — is anchored at the kick, so a
// kickBeat=1 loop is a coherent phase-shifted pattern (with a pickup hat
// before the first kick so the audio never starts on the downbeat).
function loop44(bars, kickBeat) {
  const bpm = 120, beat = 0.5, bar = 2.0;
  const buf = mkBuf(bars * bar + kickBeat * beat, 1);
  const d = buf.getChannelData(0);
  const rng = mulberry32(1234);
  const roots = [65.41, 98.0, 110.0, 87.31]; // C2 G2 A2 F2
  if (kickBeat > 0) { // pickup: hat (+old root) before the first kick
    addHat(d, 0, 0.30, rng); addBass(d, 0, roots[3], 0.16, 0.30);
  }
  for (let b = 0; b < bars; b++) {
    const barStart = b * bar + kickBeat * beat;
    for (let q = 0; q < 4; q++) {
      const t = barStart + q * beat, root = roots[b % 4];
      if (q === 0) { addKick(d, t, 0.9, rng); addBass(d, t, root, 0.35); }
      else { addHat(d, t, 0.30, rng); addBass(d, t, root, 0.16, 0.30); }
    }
  }
  return buf;
}

async function main() {
  console.log('== v27-downbeat: synthetic 4/4, kick on beat 1 ==');
  const b44 = loop44(8, 0);
  const r44 = await DB.analyze(b44, { bpm: 120 });
  ok(!!r44, '4/4 analysis returns an object (not null)');
  const expected = [];
  for (let b = 0; b < 8; b++) expected.push(+(b * 2).toFixed(3));
  ok(r44.downbeats.length === 8,
    '4/4: 8 downbeats detected', 'got ' + r44.downbeats.length);
  ok(r44.downbeats.every((t, i) => near(t, expected[i], 0.06)),
    '4/4: downbeat accuracy 100% (all within 60 ms of bar starts)',
    JSON.stringify(r44.downbeats.slice(0, 4)));
  ok(r44.confidence >= 0.7, '4/4: high confidence', 'conf=' + r44.confidence);
  ok(r44.uncertain === false, '4/4: not flagged uncertain');
  ok(/estimated/i.test(r44.method) && !/ai detected/i.test(r44.method),
    '4/4: honest method label ("estimated", never "AI detected")',
    r44.method);
  ok(r44.barPhase === 0, '4/4: bar phase = 0 (kick phase)');

  console.log('== BPM fallback (no tracker BPM passed) ==');
  DB.clearCache(b44);
  const rFb = await DB.detectDownbeats(b44, {});
  ok(!!rFb && Math.abs(rFb.bpm - 120) <= 3,
    'fallback BPM estimate ≈ 120 (±3)', 'bpm=' + (rFb && rFb.bpm));
  // With an estimated (not exact) BPM the bar count may be off by one;
  // what matters is the downbeats sit on a consistent bar grid.
  const sp = [];
  for (let i = 1; i < rFb.downbeats.length; i++) sp.push(rFb.downbeats[i] - rFb.downbeats[i - 1]);
  const barExp = 4 * 60 / rFb.bpm;
  ok(rFb.downbeats.length >= 6 && rFb.downbeats.length <= 10 &&
     sp.every((s) => Math.abs(s - barExp) < 0.15),
    'fallback: downbeats on a consistent bar grid',
    'n=' + rFb.downbeats.length + ' spacing=' + sp.slice(0, 3).map((s) => s.toFixed(2)).join(','));

  console.log('== phase-shifted loop: kick on beat 2 ==');
  const bShift = loop44(8, 1);
  const rShift = await DB.analyze(bShift, { bpm: 120 });
  const expShift = [];
  for (let b = 0; b < 8; b++) expShift.push(+((b * 2) + 0.5).toFixed(3));
  ok(rShift.downbeats.length === 8, 'shifted: 8 downbeats', 'got ' + rShift.downbeats.length);
  ok(rShift.downbeats.every((t, i) => near(t, expShift[i], 0.06)),
    'shifted: downbeats land on the kick phase (beat 2)',
    JSON.stringify(rShift.downbeats.slice(0, 4)));
  // All cues should agree on the shifted downbeat — the pattern is
  // coherent (kick + harmony both shifted).
  ok(rShift.detail.agree === 1, 'shifted: all cues agree on the downbeat phase');
  ok(rShift.confidence >= 0.7, 'shifted: high confidence', 'conf=' + rShift.confidence);

  console.log('== ambiguous: white noise ==');
  const nbuf = mkBuf(8, 1);
  {
    const d = nbuf.getChannelData(0), rng = mulberry32(777);
    for (let i = 0; i < d.length; i++) d[i] = (rng() * 2 - 1) * 0.4;
  }
  const rNoise = await DB.analyze(nbuf, { bpm: 120 });
  ok(!!rNoise, 'noise: returns an object (not null)');
  ok(rNoise.confidence < 0.5, 'noise: confidence < 0.5', 'conf=' + rNoise.confidence);
  ok(rNoise.uncertain === true, 'noise: flagged uncertain');
  const snapNoise = await DB.snapTransitionTime(nbuf, 3.7, { bpm: 120 });
  ok(snapNoise.snapped === false && near(snapNoise.time, 3.7, 1e-9),
    'noise: transition snap gate holds (no snap on uncertain)');

  console.log('== ambiguous: four-on-the-floor (kick every beat, static harmony) ==');
  const fbuf = mkBuf(8, 1);
  {
    const d = fbuf.getChannelData(0), rng = mulberry32(42);
    for (let q = 0; q < 16; q++) {
      addKick(d, q * 0.5, 0.9, rng);
      addBass(d, q * 0.5, 65.41, 0.25, 0.4); // same root every beat
      if (q % 2 === 1) addHat(d, q * 0.5, 0.25, rng);
    }
  }
  const rFof = await DB.analyze(fbuf, { bpm: 120 });
  ok(rFof.confidence < 0.5, 'four-on-floor: confidence < 0.5 (genuinely ambiguous)',
    'conf=' + rFof.confidence);
  ok(rFof.uncertain === true, 'four-on-floor: flagged uncertain');

  console.log('== degenerate inputs ==');
  const silent = mkBuf(4, 1); // all zeros
  const rSil = await DB.analyze(silent, { bpm: 120 });
  ok(!!rSil && rSil.uncertain === true && rSil.confidence === 0 && rSil.downbeats.length === 0,
    'digital silence (+explicit BPM): uncertain, confidence 0, no downbeats (honest)');
  DB.clearCache(silent);
  ok((await DB.analyze(silent, {})) === null,
    'digital silence (no BPM): null — no tempo information at all');
  const short = mkBuf(1.0, 1);
  { const d = short.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR); }
  ok((await DB.analyze(short, { bpm: 120 })) === null, '1 s buffer -> null (too short)');

  console.log('== sync helpers ==');
  const fake = { downbeats: [0, 2, 4, 6], confidence: 0.9 };
  ok(DB.quantizeToDownbeat(2.3, fake) === 2, 'quantize: 2.3 -> 2.0');
  ok(DB.quantizeToDownbeat(3.2, fake) === 4, 'quantize: 3.2 -> 4.0');
  ok(DB.quantizeToDownbeat(5.0, null) === 5.0, 'quantize: null analysis -> unchanged');
  ok(DB.shouldSnap({ downbeats: [0, 2], confidence: 0.9 }) === true, 'shouldSnap: 0.9 -> true');
  ok(DB.shouldSnap({ downbeats: [0, 2], confidence: 0.4 }) === false, 'shouldSnap: 0.4 -> false (gate)');
  ok(DB.shouldSnap({ downbeats: [], confidence: 0.95 }) === false, 'shouldSnap: empty downbeats -> false');
  const mkConf = DB.buildDownbeatMarkers(fake, 8);
  ok(mkConf.length === 4 && mkConf[0].style === 'downbeat' && mkConf[0].color === '#ff9f43',
    'markers: confident tier solid orange');
  const mkUnc = DB.buildDownbeatMarkers({ downbeats: [0, 2], confidence: 0.3 }, 8);
  ok(mkUnc.length === 2 && mkUnc[0].style === 'uncertain',
    'markers: low confidence -> "uncertain" style (dashed render)');
  ok(DB.buildDownbeatMarkers(null, 8).length === 0, 'markers: null analysis -> no markers');

  console.log('== transition snap on confident 4/4 ==');
  const snap1 = await DB.snapTransitionTime(b44, 2.3, { bpm: 120 });
  ok(snap1.snapped === true && near(snap1.time, 2.0, 1e-9),
    'snap: 2.3 s -> 2.0 s (nearest estimated downbeat)', JSON.stringify(snap1));
  const snap2 = await DB.snapTransitionTime(b44, 2.0, { bpm: 120 });
  ok(snap2.snapped === false && snap2.alreadyAligned === true,
    'snap: already on a downbeat -> no-op, alreadyAligned');

  console.log('== cache identity ==');
  const p1 = DB.analyze(b44, { bpm: 120 });
  const p2 = DB.analyze(b44, { bpm: 120 });
  ok(p1 === p2, 'analyze: same buffer -> cached promise (no re-analysis)');
  DB.clearCache(b44);
  ok(DB.analyze(b44, { bpm: 120 }) !== p1, 'clearCache: forces re-analysis');

  console.log('== 3/4-ish evidence ==');
  const wbuf = mkBuf(6, 1); // waltz: kick every 3 beats @120bpm
  {
    const d = wbuf.getChannelData(0), rng = mulberry32(99);
    for (let q = 0; q < 12; q++) {
      if (q % 3 === 0) addKick(d, q * 0.5, 0.9, rng);
      else addHat(d, q * 0.5, 0.3, rng);
    }
  }
  const rWaltz = await DB.analyze(wbuf, { bpm: 120 });
  ok(!!rWaltz && /3\/4/.test(rWaltz.method),
    'waltz: method documents the 3/4 evidence', rWaltz && rWaltz.method);
  ok(rWaltz.confidence < r44.confidence,
    'waltz: confidence reduced vs clean 4/4',
    'waltz=' + rWaltz.confidence + ' vs 4/4=' + r44.confidence);

  console.log('== realistic groove: kick1/snare2+4/swung hats/pad ==');
  const gbuf = mkBuf(16, 1);
  {
    const d = gbuf.getChannelData(0), rng = mulberry32(2026);
    const roots = [65.41, 98.0, 110.0, 87.31];
    const thirds = [82.41, 123.47, 130.81, 103.83];
    for (let b = 0; b < 8; b++) {
      const bar0 = b * 2, root = roots[b % 4], third = thirds[b % 4];
      // kick on 1 (humanized), snare on 2 & 4, swung 8th hats, pad chord
      for (let q = 0; q < 4; q++) {
        const t = bar0 + q * 0.5;
        if (q === 0) addKick(d, t, 0.85 + rng() * 0.1, rng);
        if (q === 1 || q === 3) { // snare: noise burst + 190 Hz body
          const s0 = Math.round(t * SR), n = Math.round(0.18 * SR);
          let p2 = 0;
          for (let i = 0; i < n && s0 + i < d.length; i++) {
            const tt = i / SR, dec = Math.exp(-tt / 0.05);
            const w = rng() * 2 - 1, hp = w - p2; p2 = w;
            d[s0 + i] += 0.5 * (hp * dec + 0.6 * Math.sin(2 * Math.PI * 190 * tt) * dec);
          }
        }
        addBass(d, t, root, q === 0 ? 0.32 : 0.15, 0.35);
      }
      for (let e = 0; e < 8; e++) { // swung 8ths
        const sw = (e % 2 === 1) ? 0.06 : 0;
        addHat(d, bar0 + e * 0.25 + sw * 0.25, 0.16 + rng() * 0.06, rng);
      }
      // pad: root+third through the bar (quiet)
      for (const f of [root * 2, third * 2]) {
        const s0 = Math.round(bar0 * SR), n = Math.round(1.9 * SR);
        for (let i = 0; i < n && s0 + i < d.length; i++) {
          const tt = i / SR, envp = Math.min(1, tt / 0.3) * Math.min(1, (1.9 - tt) / 0.3);
          d[s0 + i] += 0.05 * Math.sin(2 * Math.PI * f * tt) * envp;
        }
      }
    }
  }
  const rGroove = await DB.analyze(gbuf, { bpm: 120 });
  const expG = [];
  for (let b = 0; b < 8; b++) expG.push(+(b * 2).toFixed(3));
  ok(!!rGroove && rGroove.downbeats.length === 8,
    'groove: 8 downbeats', 'got ' + (rGroove && rGroove.downbeats.length));
  ok(rGroove.downbeats.every((t, i) => near(t, expG[i], 0.08)),
    'groove: downbeats on bar starts (±80 ms)',
    JSON.stringify(rGroove.downbeats.slice(0, 4)));
  ok(rGroove.confidence >= 0.6 && rGroove.uncertain === false,
    'groove: confident estimate', 'conf=' + rGroove.confidence);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
