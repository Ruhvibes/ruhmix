#!/usr/bin/env node
/* =====================================================================
   RuhMix v25/v26 — I8 ACCEPTANCE TEST (§20 ship gate).

   Drives the REAL modules headlessly in Node and proves each of the 20
   acceptance steps with MEASURED audio evidence (not "no throw").

   Steps:
     1.  Import 3 songs (synth -> AudioBuffer; see NOTE 1)
     2.  Real BPM detection  (RM.audio.detectBPM, audio-engine.js)
     3.  Real key detection  (RM.mashupDSP.detectKey, mashup-dsp.js)
     4.  Waveform peaks      (RM.wave.getPeaks, waveform.js)
     5.  Beat/bar marker grid consistent with detected BPM (v25-studio)
     6.  DSP stems           (RM.stems.run('vocalcut'), stems.js)
     7.  Auto Mashup mega build, 3 songs (RM.mashupMega.build) — vocal
         rotation proven via Goertzel, not a sequential join
     8.  Load into Studio model (RM.v25studio.open — sections built)
     9.  Drag reorder: model order changed AND buffer bytes reordered
         (byte-compare proof)
     10. Split section: count +1, buffer byte-identical (meta-only)
     11. Vocal volume -6 dB: rendered RMS of the region drops ~6 dB
     12. Master BPM 100->140: duration shrinks by 100/140 (+-2%)
     13. Pitch +4 st: duration unchanged, dominant freq x2^(4/12)
     14. Riser transition at a junction: junction bytes differ
     15. Preview path renders (RM.v25studio.getMixBuffer)
     16. Undo -> buffer byte-identical to pre-edit snapshot
     17. Redo -> buffer byte-identical to post-edit snapshot
     18. Export MP3 via the real pipeline (RM.v25exportui.exportPipeline
         + RM.exp.encodeMp3/lamejs) -> valid MP3 bytes
     19. Decode the MP3 (ffmpeg) -> edits proven present in the audio:
         BPM duration, pitch freq, quieter vocal region, transition
         region differs from a no-edit control render
     20. §25 gate: export blocked until the copyright checkbox is ticked
         (RM.v25exportui._t.guardCopyright + code-path documentation)

   ENVIRONMENT SUBSTITUTIONS (documented, minimal):
     NOTE 1 — Import: there is no file decode in Node, so songs are
       synthesized straight into AudioBuffers (click+chord+melody beds
       with KNOWN BPM 100/120/128 and KNOWN key C major). This is the
       buffer-inject path the task allows; the decode path
       (decodeArrayBuffer) is browser-only.
     NOTE 2 — RM.Beats.renderBeat is STUBBED with a synthetic pulsed
       beat (same pattern as the repo's own tests/test-mashup-mega.js):
       OfflineAudioContext does not exist in Node, and the beat bed is
       incidental to every step under test. All vocal/BPM/key/stretch/
       arrange/studio/export code is real.
     NOTE 3 — Master BPM / pitch / transition are driven through
       v26-studio-fx.js INTERNALS (the real timeStretch/pitchShift/
       applyTransitionAt DSP, the real fxApi.apply commit path and the
       real pushUndo/doUndo/doRedo) because applyBpm/applyPitch/
       applyTransitionUI read DOM inputs and are not on the module's
       public surface. The only bypassed code is the 3-line DOM input
       read; every sample the user hears goes through real functions.

   Run:  node tests/test-v25-v26-acceptance.js   (background; ~5-10 min)
   Exit: 0 = all 20 pass; 1 = any failure.
   Verdict NOT SHIPPED if any of steps 9,11,12,13,14,16,17,19 fail.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const JS = (f) => fs.readFileSync(path.join(ROOT, 'www', 'js', f), 'utf8');
const SR = 22050;
const TMP = '/tmp/ruh-accept';

/* ---------------- shims ---------------- */
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
  sampleRate: SR,
  createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || SR),
};
// Fake Web Audio constructor for audio-engine.js's INTERNAL ensureCtx()
// (used by resampleBuffer/floatToInt16). Supports the master-chain build.
function fakeParam() {
  return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {},
           cancelScheduledValues() {}, setTargetAtTime() {} };
}
function fakeNode() {
  return { connect() {}, disconnect() {}, start() {}, stop() {},
           gain: fakeParam(), threshold: fakeParam(), knee: fakeParam(),
           ratio: fakeParam(), attack: fakeParam(), release: fakeParam(),
           frequency: fakeParam(), Q: fakeParam(), curve: null, type: '' };
}
global.window = {};
global.window.AudioContext = function () {
  const inst = Object.create(fakeCtx);
  inst.state = 'running'; inst.resume = () => {}; inst.currentTime = 0;
  inst.destination = fakeNode();
  inst.createGain = () => { const n = fakeNode(); n.gain = { value: 1 }; return n; };
  inst.createAnalyser = () => { const n = fakeNode(); n.fftSize = 256; return n; };
  inst.createDynamicsCompressor = fakeNode;
  inst.createWaveShaper = fakeNode;
  inst.createBufferSource = fakeNode;
  inst.createOscillator = fakeNode;
  inst.createBiquadFilter = fakeNode;
  return inst;
};
global.RM = {};
global.window.RM = global.RM;

// minimal fake document (only what v26-studio-fx.js needs at eval/call time)
const domEls = {};
function stubEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    click() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 110 }; },
    getContext() { return null; }, clientWidth: 320,
  };
}
function el(id) { if (!domEls[id]) domEls[id] = stubEl(id); return domEls[id]; }
global.document = {
  getElementById: (id) => domEls[id] || null,
  createElement: (t) => stubEl('new-' + t),
  addEventListener() {}, removeEventListener() {},
  readyState: 'complete', querySelectorAll() { return []; },
  body: { appendChild() {} }, documentElement: {},
};

/* ---------------- load real modules ---------------- */
eval(JS('audio-engine.js'));
RM.audio.ensureCtx = () => fakeCtx; // headless AudioContext
eval(JS('waveform.js'));
eval(JS('mashup-dsp.js'));
eval(JS('stems.js'));
eval(JS('mashup-stems.js'));
eval(JS('beats.js'));
// NOTE 2: stub the OfflineAudioContext-backed beat renderer (repo test pattern).
RM.Beats.renderBeat = function (styleId, bpm, bars, opts) {
  const barLen = 240 / bpm, len = Math.max(1, Math.round(bars * barLen * SR));
  const out = fakeCtx.createBuffer(2, len, SR);
  let s = 987654321;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let c = 0; c < 2; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / SR, bt = t % (60 / bpm), env = Math.exp(-bt / 0.03);
      d[i] = 0.22 * env * rnd(); // broadband 4-on-floor pulse, no tonal content
    }
  }
  return Promise.resolve(out);
};
eval(JS('mashup-arrange.js'));
eval(JS('mashup-mega.js'));
eval(JS('v25-studio.js'));
eval(JS('v25-mixmaster.js')); // RM.v25mix: real transition builders
eval(JS('v26-studio-fx.js'));
eval(JS('vendor/lame.min.js'));
window.lamejs = lamejs; // export.js checks window.lamejs.Mp3Encoder
eval(JS('export.js'));
eval(JS('v25-export-ui.js'));

for (const [n, o, f] of [
  ['RM.audio.detectBPM', RM.audio, 'detectBPM'],
  ['RM.mashupDSP', RM.mashupDSP, 'detectKey'],
  ['RM.stems', RM.stems, 'run'], ['RM.mashupMega', RM.mashupMega, 'build'],
  ['RM.v25studio', RM.v25studio, 'open'], ['RM.v26fx', RM.v26fx, 'undo'],
  ['RM.v25mix', RM.v25mix, 'buildTransition'], ['RM.exp', RM.exp, 'encodeMp3'],
  ['RM.v25exportui', RM.v25exportui, 'exportPipeline'],
]) {
  if (!o || (f && typeof o[f] !== 'function')) {
    console.error('FATAL: ' + n + ' not loaded'); process.exit(2);
  }
}
console.log('setup: all real modules loaded (beat renderer stubbed per NOTE 2)');

/* ---------------- helpers ---------------- */
let pass = 0, fail = 0;
const fails = [];
function ok(name, detail) { pass++; console.log('PASS ' + name + (detail ? ' — ' + detail : '')); }
function no(name, detail) { fail++; fails.push(name); console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }

function bufsEqual(a, b) {
  if (!a || !b || a.length !== b.length || a.numberOfChannels !== b.numberOfChannels) return false;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c), y = b.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
function snapBuf(b) {
  const o = fakeCtx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) o.getChannelData(c).set(b.getChannelData(c));
  return o;
}
function rmsOf(buf, aSamp, bSamp) {
  let s = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const a = Math.max(0, aSamp | 0), b = Math.min(d.length, bSamp == null ? d.length : bSamp | 0);
    for (let i = a; i < b; i++) { s += d[i] * d[i]; n++; }
  }
  return Math.sqrt(s / Math.max(1, n));
}
// exact-frequency Goertzel magnitude (normalized)
function goertzel(ch, start, n, freq, sr) {
  const w = 2 * Math.PI * freq / sr, cw = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  const end = Math.min(ch.length, start + n);
  for (let i = start; i < end; i++) { const x = ch[i]; s0 = x + cw * s1 - s2; s2 = s1; s1 = s0; }
  const p = s1 * s1 + s2 * s2 - cw * s1 * s2;
  return Math.sqrt(Math.max(0, p)) / Math.max(1, end - start);
}
const db = (r) => 20 * Math.log10(Math.max(1e-12, r));
// Robust tone magnitude: max over 1s Goertzel windows. WSOLA can leave
// sustained tones locally strong but phase-incoherent across frame
// boundaries, which collapses a single long-window coherent measurement.
// The question "is the tone at this frequency present" needs the
// incoherent (per-window-max) answer.
function toneMag(ch, t0, t1, freq, sr) {
  let best = 0;
  for (let t = t0; t + 1 <= t1 + 1e-9; t += 0.5) {
    const m = goertzel(ch, Math.floor(t * sr), Math.min(sr, Math.floor((t1 - t) * sr)), freq, sr);
    if (m > best) best = m;
  }
  return best;
}

/* ---------------- test songs (NOTE 1: buffer-inject import) ----------------
   Known BPM 100/120/128, known key C major for all three.
   Center (L=R): noise-burst clicks each beat + C-major triad bed +
                 signature melody sine (per-song freq, diatonic in C).
   Sides (L=-R): wide pad (exercises the Sides stem). */
const SONGS = [
  { bpm: 100, mel: 261.63, name: 'Song 1' }, // C4 (C-major-safe)
  { bpm: 120, mel: 174.61, name: 'Song 2' }, // F3
  { bpm: 128, mel: 293.66, name: 'Song 3' }, // D4
];
const SONG_SECS = 44;
function synthSong(bpm, melHz) {
  const len = Math.floor(SR * SONG_SECS), b = fakeCtx.createBuffer(2, len, SR);
  const beat = 60 / bpm;
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      let v = 0;
      const bt = t % beat;
      if (bt < 0.005) v += 1.0 * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-bt * 300); // deterministic click: 5ms, strong onset
      v += 0.10 * Math.sin(2 * Math.PI * 130.81 * t)          // C3
         + 0.10 * Math.sin(2 * Math.PI * 164.81 * t)          // E3
         + 0.10 * Math.sin(2 * Math.PI * 196.00 * t);         // G3  (C major bed dominates chroma)
      v += 0.10 * Math.sin(2 * Math.PI * melHz * t);           // signature melody (diatonic, C-major-safe)
      const w = 0.12 * Math.sin(2 * Math.PI * 110 * t);        // wide pad (sides)
      d[i] = v + (c === 0 ? w : -w);
    }
  }
  return b;
}

async function main() {
  try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {}

  /* ==== STEP 1: import ==== */
  const songs = SONGS.map((s) => ({ buf: synthSong(s.bpm, s.mel), ...s }));
  (songs.length === 3 && songs.every((s) => s.buf.length === Math.floor(SR * SONG_SECS) && s.buf.numberOfChannels === 2))
    ? ok('1 import', '3 songs buffer-injected (NOTE 1), 44.0s stereo @22050 each')
    : no('1 import', 'song buffer shape wrong');

  /* ==== STEP 2: real BPM detection ==== */
  const detBpm = [];
  for (const s of songs) detBpm.push(await RM.audio.detectBPM(s.buf));
  const bpmOk = detBpm.every((d, i) => d !== null && Math.abs(d - songs[i].bpm) <= 2);
  bpmOk
    ? ok('2 BPM detect', detBpm.map((d, i) => songs[i].bpm + '->' + d).join(', ') + ' (real autocorr, none null)')
    : no('2 BPM detect', 'detected=[' + detBpm.join(',') + '] expected=[100,120,128]');

  /* ==== STEP 3: real key detection ==== */
  const detKey = [];
  for (const s of songs) detKey.push(await RM.mashupDSP.detectKey(s.buf));
  const keyOk = detKey.every((k) => k && k.key === 'C' && k.mode === 'major');
  keyOk
    ? ok('3 key detect', detKey.map((k) => k.key + ' ' + k.mode + ' (conf ' + k.confidence.toFixed(2) + ')').join(', '))
    : no('3 key detect', JSON.stringify(detKey));

  /* ==== STEP 4: waveforms ==== */
  const peaks = await RM.wave.getPeaks(songs[0].buf, 1200);
  const pmax = Math.max(...peaks);
  (peaks.length === 1200 && pmax > 0.05)
    ? ok('4 waveform', '1200 peaks, max=' + pmax.toFixed(3) + ' (non-trivial)')
    : no('4 waveform', 'peaks len=' + peaks.length + ' max=' + pmax);

  /* ==== STEP 6: DSP stems (before mega consumes the buffers) ==== */
  const stemRes = await RM.stems.run('vocalcut', songs[0].buf);
  const center = stemRes.find((s) => /center/i.test(s.name));
  const sides = stemRes.find((s) => /sides/i.test(s.name));
  const cRms = center ? rmsOf(center.buffer) : 0, sRms = sides ? rmsOf(sides.buffer) : 0;
  const cMel = center ? goertzel(center.buffer.getChannelData(0), 0, SR * 4, songs[0].mel, SR) : 0;
  const sMel = sides ? goertzel(sides.buffer.getChannelData(0), 0, SR * 4, songs[0].mel, SR) : 0;
  (center && sides && cRms > 0.02 && sRms > 0.02 && cMel > 10 * sMel)
    ? ok('6 DSP stems', 'vocalcut -> Center RMS=' + cRms.toFixed(3) + ' / Sides RMS=' + sRms.toFixed(3) +
       '; melody ' + songs[0].mel + 'Hz in Center ' + (cMel / Math.max(sMel, 1e-9)).toFixed(0) + 'x vs Sides')
    : no('6 DSP stems', 'center/sides missing or silent: cRms=' + cRms + ' sRms=' + sRms);

  /* ==== STEP 7: mega Auto Mashup ==== */
  // mega NULLS entry.buffer — pass wrappers, keep pristine copies
  const entries = songs.map((s) => ({ buffer: snapBuf(s.buf), name: s.name }));
  let mega;
  try {
    mega = await RM.mashupMega.build(entries, {}, () => {}, () => {});
  } catch (e) { no('7 mega build', 'threw: ' + (e && e.message)); }
  const mbuf = mega && mega.buffer, mmeta = mega && mega.meta;
  const expDur = (4 + 2 * 3 * 8 + 4) * 240 / 100; // 56 bars @100bpm = 134.4s
  let rotOk = false, rotDetail = '';
  if (mbuf && mmeta) {
    const barSec = 240 / 100, introSec = 4 * barSec, segSec = 8 * barSec;
    const ch = mbuf.getChannelData(0);
    const got = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.floor((introSec + k * segSec + segSec * 0.3) * SR);
      const n = Math.floor(segSec * 0.4 * SR);
      const mags = songs.map((s) => goertzel(ch, a, n, s.mel, SR));
      let bi = 0; mags.forEach((m, i) => { if (m > mags[bi]) bi = i; });
      got.push(bi);
    }
    rotOk = got.every((g, k) => g === k % 3);
    rotDetail = 'slots->[' + got.join(',') + '] expected [0,1,2,0,1,2]';
  }
  const durOk = mbuf && Math.abs(mbuf.duration - expDur) < 1.5;
  const tagOk = mega && /Smart DSP engine/.test((mega.engineTags || []).join(' '));
  (mbuf && durOk && rotOk && tagOk)
    ? ok('7 mega mashup', 'dur=' + mbuf.duration.toFixed(1) + 's (exp ' + expDur.toFixed(1) + '); ' +
       rotDetail + '; tag=' + (mega.engineTags || []).join('+'))
    : no('7 mega mashup', 'dur=' + (mbuf && mbuf.duration.toFixed(1)) + ' durOk=' + durOk +
       ' ' + rotDetail + ' tags=' + (mega && mega.engineTags));

  /* ==== STEP 8: load into Studio ==== */
  const S = RM.v25studio, T = S._t;
  S.open({ buffer: mbuf, meta: mmeta, engineTags: (mega.engineTags || []).join(' '),
           songs: songs.map((s) => ({ name: s.name })) });
  const st8 = T.st();
  const kinds = st8.sections.map((s) => s.kind).join(',');
  const vsong = st8.sections.filter((s) => s.kind === 'vocal').map((s) => s.vocalSong).join(',');
  (st8.sections.length === 8 && kinds === 'intro,vocal,vocal,vocal,vocal,vocal,vocal,outro' &&
   vsong === '0,1,2,0,1,2' && st8.bpm === 100)
    ? ok('8 studio load', '8 sections, vocalSong=[' + vsong + '], bpm=' + st8.bpm)
    : no('8 studio load', 'sections=' + st8.sections.length + ' kinds=' + kinds + ' vsong=' + vsong + ' bpm=' + st8.bpm);

  /* ==== STEP 5: beat/bar marker grid ==== */
  const barSec = st8.barSec, bd = T.bounds();
  const gridOk = Math.abs(barSec - 240 / 100) < 1e-9 &&
    Math.abs(bd[0].b - 4 * barSec) < 1e-6 &&
    Math.abs(st8.sections.map((s) => s.lenSec).reduce((a, b) => a + b, 0) - st8.current.duration) < 0.05;
  gridOk
    ? ok('5 beat/bar grid', 'barSec=' + barSec.toFixed(3) + 's (=240/100); intro=4 bars; sections tile the buffer')
    : no('5 beat/bar grid', 'barSec=' + barSec);

  /* ==== STEP 9: drag reorder (model + buffer bytes) ==== */
  const idsBefore = st8.sections.map((s) => s.id);
  const sec2 = st8.sections[2]; // vocalSong 1 (Song 2)
  const bds9 = T.bounds();
  const preSlice = T.sliceSamp(st8.current, Math.round(bds9[2].a * SR), Math.round(bds9[2].b * SR));
  const dragOk = T.dragCommit(2, 1);
  const st9 = T.st();
  const orderAfter = st9.sections.map((s) => s.kind === 'vocal' ? s.vocalSong : '.').join(',');
  const newIdx = st9.sections.findIndex((s) => s.id === sec2.id);
  const bds9b = T.bounds();
  const postSlice = T.sliceSamp(st9.current, Math.round(bds9b[newIdx].a * SR), Math.round(bds9b[newIdx].b * SR));
  const bytesMoved = bufsEqual(preSlice, postSlice);
  const modelChanged = !idsBefore.every((id, i) => id === st9.sections[i].id);
  (dragOk && modelChanged && newIdx === 1 && bytesMoved)
    ? ok('9 drag reorder', 'Song-2 section 2->1; model order [' + orderAfter + ']; ' +
       preSlice.length + ' samples byte-identical at new position')
    : no('9 drag reorder', 'dragOk=' + dragOk + ' modelChanged=' + modelChanged + ' newIdx=' + newIdx + ' bytesMoved=' + bytesMoved);

  /* ==== STEP 10: split section ==== */
  const nBefore = T.st().sections.length;
  const bufBeforeSplit = snapBuf(T.st().current);
  const splitTarget = 2; // vocal section (vocalSong 0)
  const splitLen = T.st().sections[splitTarget].lenSec;
  const splitOk = T.splitSectionAt(splitTarget, splitLen / 2);
  const nAfter = T.st().sections.length;
  (splitOk && nAfter === nBefore + 1 && bufsEqual(bufBeforeSplit, T.st().current))
    ? ok('10 split', 'sections ' + nBefore + '->' + nAfter + '; buffer byte-identical (meta-only)')
    : no('10 split', 'splitOk=' + splitOk + ' n=' + nBefore + '->' + nAfter);

  /* ==== STEP 11: vocal volume -6 dB ==== */
  // sections: [0 intro, 1 v1, 2 v0A, 3 v0B, 4 v2, 5 v0, 6 v1, 7 v2, 8 outro];
  // -6dB on idx 5 (song-0 vocal, full length); pitch check (step 13) uses idx 2.
  const st11 = T.st();
  const vi = 5;
  if (st11.sections[vi].kind !== 'vocal' || st11.sections[vi].vocalSong !== 0) {
    no('11 vocal -6dB', 'section ' + vi + ' is not a song-0 vocal (order changed?)'); 
  } else {
  const b11 = T.bounds()[vi];
  const rBefore = rmsOf(st11.current, Math.round(b11.a * SR), Math.round(b11.b * SR));
  const editOk = T.applySectionEditCore(vi, 0, 0, -6, 'cut');
  const rAfter = rmsOf(T.st().current, Math.round(b11.a * SR), Math.round(b11.b * SR));
  const dB = db(rAfter / rBefore);
  const regA11 = b11.a, regB11 = b11.b; // pre-BPM coords; rescaled in step 12
  (editOk && Math.abs(dB - (-6)) < 0.6)
    ? ok('11 vocal -6dB', 'section ' + vi + ' RMS ' + rBefore.toFixed(4) + '->' + rAfter.toFixed(4) +
       ' = ' + dB.toFixed(2) + ' dB (real applySectionEditCore)')
    : no('11 vocal -6dB', 'editOk=' + editOk + ' dB=' + dB.toFixed(2));
  } // else (section order guard)

  /* ==== STEP 12: master BPM 100 -> 140 (NOTE 3: via v26fx internals) ==== */
  const fx = S.fxApi, FXI = RM.v26fx.internals;
  const rr = FXI.stretchRatioForBpm(fx.bpm(), 140);
  const preBpm = { buf: snapBuf(fx.cur()), bpm: fx.bpm(), lens: fx.secs().map((s) => s.lenSec) };
  const nbBpm = await RM.mashupDSP.timeStretch(fx.cur(), rr.ratio);
  const postBpm = { buf: nbBpm, bpm: rr.effBpm, lens: preBpm.lens.map((l) => l * rr.ratio) };
  fx.apply(nbBpm, { bpm: rr.effBpm, rescale: true });
  FXI.pushUndo('Master BPM 100->140',
    () => fx.apply(preBpm.buf, { bpm: preBpm.bpm, sections: preBpm.lens }),
    () => fx.apply(postBpm.buf, { bpm: postBpm.bpm, sections: postBpm.lens }));
  const r12 = postBpm.buf.duration / preBpm.buf.duration;
  const expR12 = 100 / 140;
  (Math.abs(r12 - expR12) / expR12 < 0.02 && Math.abs(fx.bpm() - 140) < 1e-9)
    ? ok('12 master BPM', 'dur ' + preBpm.buf.duration.toFixed(2) + 's->' + postBpm.buf.duration.toFixed(2) +
       's ratio=' + r12.toFixed(4) + ' (exp ' + expR12.toFixed(4) + '); WSOLA real')
    : no('12 master BPM', 'ratio=' + r12.toFixed(4) + ' exp=' + expR12.toFixed(4));

  /* ==== STEP 16/17: undo/redo the BPM change (v26fx stack) ==== */
  const u16 = RM.v26fx.undo();
  const undoBytes = bufsEqual(T.st().current, preBpm.buf);
  (u16 && undoBytes && Math.abs(fx.bpm() - 100) < 1e-9)
    ? ok('16 undo', 'buffer byte-identical to pre-BPM snapshot (' + preBpm.buf.length + ' samples); bpm back to 100')
    : no('16 undo', 'undoOk=' + u16 + ' bytesIdentical=' + undoBytes);
  const r17 = RM.v26fx.redo();
  const redoBytes = bufsEqual(T.st().current, postBpm.buf);
  (r17 && redoBytes && Math.abs(fx.bpm() - 140) < 1e-9)
    ? ok('17 redo', 'buffer byte-identical to post-BPM snapshot; bpm=140')
    : no('17 redo', 'redoOk=' + r17 + ' bytesIdentical=' + redoBytes);

  /* ==== STEP 13: pitch +4 st (NOTE 3: via v26fx internals) ==== */
  // song-0 vocal section idx 2 (v0A) — different section from the -6dB one.
  const st13 = T.st();
  const pIdx = 2;
  if (st13.sections[pIdx].kind !== 'vocal' || st13.sections[pIdx].vocalSong !== 0)
    no('13 pitch +4st', 'section ' + pIdx + ' is not a song-0 vocal (order changed?)');
  const b13 = T.bounds()[pIdx];
  const tm13 = (buf, f) => toneMag(buf.getChannelData(0), b13.a + (b13.b - b13.a) * 0.3, b13.a + (b13.b - b13.a) * 0.7, f, SR);
  const f0 = songs[0].mel, f1 = f0 * Math.pow(2, 4 / 12);
  const m0a = tm13(fx.cur(), f0), m0b = tm13(fx.cur(), f1);
  const preP = { buf: snapBuf(fx.cur()), lens: fx.secs().map((s) => s.lenSec) };
  const nbP = await RM.mashupDSP.pitchShift(fx.cur(), 4);
  fx.apply(nbP, {});
  FXI.pushUndo('Pitch +4st', () => fx.apply(preP.buf, { sections: preP.lens }),
                            () => fx.apply(nbP, {}));
  const durRatioP = nbP.duration / preP.buf.duration;
  const m1a = tm13(fx.cur(), f0), m1b = tm13(fx.cur(), f1);
  const pitchOk = Math.abs(durRatioP - 1) < 0.005 && m0a > 3 * m0b && m1b > 3 * m1a;
  pitchOk
    ? ok('13 pitch +4st', 'dur ratio=' + durRatioP.toFixed(4) + ' (~1); melody ' + f0.toFixed(1) + 'Hz->' +
       f1.toFixed(1) + 'Hz (x' + (f1 / f0).toFixed(4) + '=2^(4/12)); real pitchShift')
    : no('13 pitch +4st', 'durRatio=' + durRatioP.toFixed(4) + ' mags before=[' + m0a.toFixed(3) + ',' + m0b.toFixed(3) +
       '] after=[' + m1a.toFixed(3) + ',' + m1b.toFixed(3) + ']');

  /* ==== STEP 14: riser transition at a junction (NOTE 3: via internals) ==== */
  const types = FXI.listTransitionTypes().map((t) => t.id);
  const tType = types.includes('riser') ? 'riser' : 'echo-out';
  const desc = RM.v25mix.buildTransition(tType, 2, { bpm: fx.bpm(), sr: SR, energy: 0.7 });
  const secs14 = fx.secs();
  let ji = -1, acc = 0;
  for (let i = 0; i < secs14.length - 1; i++) {
    acc += secs14[i].lenSec;
    if (acc * SR >= desc.lengthSamples + SR) { ji = i; break; }
  }
  const juncSample = Math.round(acc * SR);
  const preT = { buf: snapBuf(fx.cur()), lens: fx.secs().map((s) => s.lenSec) };
  const res14 = FXI.applyTransitionAt(fx.cur(), juncSample, desc, FXI.isCrossfadeFamily(tType));
  fx.apply(res14.buffer, { sections: preT.lens });
  FXI.pushUndo('Transition ' + tType, () => fx.apply(preT.buf, { sections: preT.lens }),
                                       () => fx.apply(res14.buffer, { sections: preT.lens }));
  const N = desc.lengthSamples;
  const regA = fx.cur().getChannelData(0).subarray(juncSample - N, juncSample);
  const regB = preT.buf.getChannelData(0).subarray(juncSample - N, juncSample);
  let diffE = 0; for (let i = 0; i < regA.length; i += 7) diffE += (regA[i] - regB[i]) * (regA[i] - regB[i]);
  const diffRms = Math.sqrt(diffE / Math.ceil(regA.length / 7));
  const juncChanged = diffRms > 1e-4 && res14.buffer.length === preT.buf.length;
  juncChanged
    ? ok('14 transition', tType + ' @junction ' + ji + ' (' + (juncSample / SR).toFixed(1) + 's): region RMS diff=' +
       diffRms.toFixed(4) + ' (bytes differ); length unchanged')
    : no('14 transition', 'ji=' + ji + ' diffRms=' + diffRms);

  /* ==== STEP 15: preview path ==== */
  const pv = S.getMixBuffer();
  const pvOk = pv && pv === T.st().current && rmsOf(pv) > 0.01;
  pvOk
    ? ok('15 preview', 'getMixBuffer() = live edited buffer, RMS=' + rmsOf(pv).toFixed(3) +
       ', dur=' + pv.duration.toFixed(1) + 's (what the player would play)')
    : no('15 preview', 'preview buffer missing/not current');

  /* ==== STEP 18: export MP3 (real pipeline + lamejs) ==== */
  let mp3bytes = null;
  const deps = {
    resample: (b, sr, p) => RM.audio.resampleBuffer(b, sr, p),
    floatToInt16: (b, p) => RM.audio.floatToInt16(b, p),
    encodeMp3: (i16, kbps, sr, p, t) => RM.exp.encodeMp3(i16, kbps, sr, p, t),
    deliver: (blob, name, mime) => blob.arrayBuffer().then((ab) => { mp3bytes = Buffer.from(ab); return { method: 'test-capture', name }; }),
  };
  const finalBuf = T.st().current;
  await RM.v25exportui.exportPipeline(finalBuf, 'mp3', deps, null, { cancelled: false }, { kbps: 128, sampleRate: 44100 });
  try { fs.writeFileSync(path.join(TMP, 'accept.mp3'), mp3bytes); } catch (e) {}
  const isMp3 = mp3bytes && mp3bytes.length > 100000 &&
    (mp3bytes.slice(0, 3).toString() === 'ID3' || (mp3bytes[0] === 0xFF && (mp3bytes[1] & 0xE0) === 0xE0));
  let probeOk = false, probeInfo = '';
  try {
    const pr = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels',
      '-of', 'csv', path.join(TMP, 'accept.mp3')], { encoding: 'utf8' });
    probeOk = /mp3/.test(pr); probeInfo = pr.trim().replace(/\n/g, ' ');
  } catch (e) { probeInfo = 'ffprobe: ' + e.message; }
  (isMp3 && probeOk)
    ? ok('18 export MP3', mp3bytes.length + ' bytes, valid MP3 (' + probeInfo + '), real lamejs via exportPipeline')
    : no('18 export MP3', 'bytes=' + (mp3bytes && mp3bytes.length) + ' probe=' + probeInfo);

  /* ==== STEP 19: decode MP3, prove the edits are in it ==== */
  // control: pre-transition buffer through the identical encode path
  let ctlBytes = null;
  const depsCtl = { ...deps, deliver: (blob, name) => blob.arrayBuffer().then((ab) => { ctlBytes = Buffer.from(ab); return { method: 'test-capture', name }; }) };
  await RM.v25exportui.exportPipeline(preT.buf, 'mp3', depsCtl, null, { cancelled: false }, { kbps: 128, sampleRate: 44100 });
  fs.writeFileSync(path.join(TMP, 'control.mp3'), ctlBytes);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(TMP, 'accept.mp3'),
    '-ac', '2', '-ar', '44100', '-f', 's16le', path.join(TMP, 'accept.raw')]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(TMP, 'control.mp3'),
    '-ac', '2', '-ar', '44100', '-f', 's16le', path.join(TMP, 'control.raw')]);
  const DSR = 44100;
  const readRaw = (p) => {
    const b = fs.readFileSync(p), n = b.length / 4, L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = b.readInt16LE(i * 4) / 32768; R[i] = b.readInt16LE(i * 4 + 2) / 32768; }
    return { L, R, n, dur: n / DSR };
  };
  const dec = readRaw(path.join(TMP, 'accept.raw'));
  const ctl = readRaw(path.join(TMP, 'control.raw'));
  const gdec = (ch, t0, t1, f) => {
    let best = 0; // max over 1s windows (WSOLA phase-incoherence robust)
    for (let t = t0; t + 1 <= t1 + 1e-9; t += 0.5)
      best = Math.max(best, goertzel(ch, Math.floor(t * DSR), Math.min(DSR, Math.floor((t1 - t) * DSR)), f, DSR));
    return best;
  };
  const rdec = (d, t0, t1) => {
    let s = 0, n = 0;
    const a = Math.max(0, Math.floor(t0 * DSR)), b = Math.min(d.n, Math.floor(t1 * DSR));
    for (let i = a; i < b; i++) { s += d.L[i] * d.L[i] + d.R[i] * d.R[i]; n += 2; }
    return Math.sqrt(s / Math.max(1, n));
  };
  const parts19 = [];
  // (a) duration matches BPM-changed length
  const aOk = Math.abs(dec.dur - finalBuf.duration) < 0.25;
  parts19.push('dur ' + dec.dur.toFixed(2) + 's vs buf ' + finalBuf.duration.toFixed(2) + 's' + (aOk ? ' OK' : ' MISMATCH'));
  // (b) pitch-shifted freq present (song-0 vocal slot, post-pitch coords)
  const sb = T.bounds()[pIdx]; // pIdx section bounds on the pitched buffer
  const q0 = sb.a + (sb.b - sb.a) * 0.3, q1 = sb.a + (sb.b - sb.a) * 0.7;
  const g220 = gdec(dec.L, q0, q1, f0), g277 = gdec(dec.L, q0, q1, f1);
  // shifted tone must clearly dominate the unshifted one (>=8dB = 2.5x;
  // MP3 coding noise makes a strict 3x boundary fragile)
  const bOk = g277 > 2.5 * g220;
  parts19.push('pitch ' + f1.toFixed(1) + 'Hz mag ' + g277.toFixed(3) + ' vs ' + f0.toFixed(1) + 'Hz ' +
    g220.toFixed(3) + (bOk ? ' OK' : ' MISSING'));
  // (c) vocal region quieter: -6dB section vs sibling song-0 section (BPM-rescaled coords)
  const bdsF = T.bounds();
  const sib = bdsF.findIndex((_, i) => i !== vi && T.st().sections[i].kind === 'vocal' && T.st().sections[i].vocalSong === 0);
  const rq = rdec(dec, bdsF[vi].a, bdsF[vi].b), rc = rdec(dec, bdsF[sib].a, bdsF[sib].b);
  const cDb = db(rq / rc);
  const cOk = Math.abs(cDb - (-6)) < 1.5;
  parts19.push('vocal region ' + cDb.toFixed(2) + 'dB vs sibling' + (cOk ? ' OK' : ' MISMATCH'));
  // (d) transition region differs from no-edit control; far region does not
  const tReg = 0.6, tj0 = (juncSample - N) / SR, tj1 = juncSample / SR;
  const tm0 = tj0 + (tj1 - tj0) * (0.5 - tReg / 2), tm1 = tj0 + (tj1 - tj0) * (0.5 + tReg / 2);
  let sT = 0, nT = 0;
  { const a = Math.floor(tm0 * DSR), b = Math.floor(tm1 * DSR);
    for (let i = a; i < Math.min(b, dec.n, ctl.n); i++) { const d = dec.L[i] - ctl.L[i]; sT += d * d; nT++; } }
  const dTrans = Math.sqrt(sT / Math.max(1, nT));
  const far0 = dec.dur - 5, far1 = dec.dur - 1;
  let sF = 0, nF = 0;
  { const a = Math.floor(far0 * DSR), b = Math.floor(far1 * DSR);
    for (let i = a; i < Math.min(b, dec.n, ctl.n); i++) { const d = dec.L[i] - ctl.L[i]; sF += d * d; nF++; } }
  const dFar = Math.sqrt(sF / Math.max(1, nF));
  const dOk = dTrans > 0.015 && dFar < 0.008;
  parts19.push('transition-region diff RMS ' + dTrans.toFixed(4) + ' vs far-region ' + dFar.toFixed(4) + (dOk ? ' OK' : ' MISMATCH'));
  (aOk && bOk && cOk && dOk)
    ? ok('19 edits in MP3', parts19.join(' | '))
    : no('19 edits in MP3', parts19.join(' | '));

  /* ==== STEP 20: §25 copyright gate ==== */
  const EU = RM.v25exportui._t;
  EU.resetCrAck();
  const blocked = EU.guardCopyright() === false && EU.crChecked() === false;
  EU.setCrAck(true);
  const allowed = EU.guardCopyright() === true && EU.crChecked() === true;
  EU.resetCrAck();
  (blocked && allowed)
    ? ok('20 §25 gate', 'guardCopyright()=false before tick, =true after tick; ' +
       'doExport/doShare both call guardCopyright() first (v25-export-ui.js); resetCrAck() on every show()')
    : no('20 §25 gate', 'blocked=' + blocked + ' allowed=' + allowed);

  /* ---------------- report ---------------- */
  console.log('\n## I8 ACCEPTANCE');
  console.log('### PASS (' + pass + '/20)');
  console.log('### FAIL (' + fail + '/20): ' + (fails.join(', ') || 'none'));
  const critical = [9, 11, 12, 13, 14, 16, 17, 19];
  const critFail = fails.filter((f) => critical.some((c) => f.startsWith(c + ' ')));
  if (critFail.length) console.log('VERDICT: NOT SHIPPED — critical step(s) failed: ' + critFail.join(', '));
  else if (fail) console.log('VERDICT: SHIPPED WITH NON-CRITICAL FAILURES: ' + fails.join(', '));
  else console.log('VERDICT: SHIPPED — all 20 steps pass');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
