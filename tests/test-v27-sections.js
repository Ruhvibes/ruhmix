#!/usr/bin/env node
/*
 * RuhMix v27 W2 — smart section detection (pure DSP heuristics).
 * Node tests for www/js/v27-sections.js. Loads the browser file with a
 * minimal window / AudioBuffer shim — no browser needed.
 *
 * Song model: 24 bars @120 BPM — verse (quiet, low, tonal) 8 bars →
 * chorus (loud, harmonic, vocal-band energy) 8 bars → verse 8 bars.
 * The detector must find the hook region. Labels are honest: never "AI".
 *
 * Run:  node tests/test-v27-sections.js
 * Exit 0 = all pass.
 */
'use strict';
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
global.window = {};
global.RM = {};
global.window.RM = global.RM;

const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'v27-sections.js'), 'utf8');
eval(src);
const S = global.window.RM.v27sections;
if (!S) { console.error('FAIL: RM.v27sections not exposed'); process.exit(1); }

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const SR = 22050, BPM = 120;
const BAR = 2; // seconds per bar at 120 BPM (4 beats)

/* ---------- synthetic song: verse 8 / chorus 8 / verse 8 ---------- */
function synthSong() {
  const totalBars = 24;
  const buf = new FakeAudioBuffer(2, Math.round(totalBars * BAR * SR), SR);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const len = buf.length;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const bar = Math.floor(t / BAR);
    const chorus = bar >= 8 && bar < 16;
    let x;
    if (chorus) {
      // loud harmonic stack (220 + harmonics, all in vocal band) + light noise
      x = 0.25 * Math.sin(2 * Math.PI * 220 * t)
        + 0.18 * Math.sin(2 * Math.PI * 440 * t)
        + 0.12 * Math.sin(2 * Math.PI * 660 * t)
        + 0.08 * Math.sin(2 * Math.PI * 880 * t)
        + 0.010 * (Math.random() - 0.5);
    } else {
      // quiet bass-ish tone (110 Hz, below the 300 Hz vocal band) + faint noise
      x = 0.06 * Math.sin(2 * Math.PI * 110 * t)
        + 0.005 * (Math.random() - 0.5);
    }
    L[i] = x; R[i] = x;
  }
  return buf;
}

/* ---------- main detection test ---------- */
const det = S.detectSections(synthSong(), BPM);

ok(det && det.fallback === false, 'T1: verse→chorus→verse is NOT a fallback', JSON.stringify(det.note));
// Honest-label rule: must never CLAIM neural/AI detection. The required
// disclaimer "(DSP heuristic — not AI chorus detection)" is fine.
function noAiClaim(s) { return !/AI detected|AI-powered|neural/i.test(String(s || '')); }
ok(noAiClaim(det.note), 'T2: detection note makes no AI/neural claim', det.note);
ok(det.sections.every(s => s.bars >= 8), 'T3: every section ≥ 8 bars (min length enforced)',
   JSON.stringify(det.sections.map(s => s.bars)));
ok(det.sections.length === 3, 'T4: exactly 3 sections found (verse/chorus/verse)',
   JSON.stringify(det.sections.map(s => s.startBar + ':' + s.bars)));
const hooks = det.sections.filter(s => s.label === 'high-energy');
ok(hooks.length >= 1, 'T5: at least one high-energy section', JSON.stringify(det.sections.map(s => s.label)));
if (hooks.length) {
  const h = hooks[0];
  ok(Math.abs(h.startBar - 8) <= 4, 'T6: hook startBar within ±4 bars of chorus start (bar 8)',
     'startBar=' + h.startBar);
  ok(h.confidence >= S.HOOK_CONF_THRESHOLD, 'T7: hook confidence ≥ ' + S.HOOK_CONF_THRESHOLD,
     'conf=' + h.confidence);
  ok(noAiClaim(h.labelText), 'T8: hook labelText honest (no AI claim)', h.labelText);
}
ok(det.sections.every(s => isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1),
   'T9: all confidences in 0..1');
const allowed = ['high-energy', 'vocal-forward', 'breakdown', 'build', 'unknown'];
ok(det.sections.every(s => allowed.indexOf(s.label) >= 0),
   'T10: all labels from the honest label set',
   JSON.stringify(det.sections.map(s => s.label)));
const hookBar = S.hookStartBar(det.sections, S.HOOK_CONF_THRESHOLD);
ok(hookBar >= 0 && Math.abs(hookBar - 8) <= 4, 'T11: hookStartBar returns the chorus region',
   'hookBar=' + hookBar);

/* ---------- arrangement plan ---------- */
const plan = S.suggestArrangement(det);
ok(plan.fallback === false && Array.isArray(plan.plan) && plan.plan.length > 0,
   'T12: suggestArrangement returns a plan when confident',
   JSON.stringify(plan.plan.map(p => p.role)));
ok(plan.plan.some(p => p.role === 'hook'), 'T13: plan contains a hook role');
ok(noAiClaim(plan.note) && /not AI chorus detection/i.test(plan.note),
   'T14: plan note is honest about no AI chorus detection', plan.note);
const planFb = S.suggestArrangement(det.sections.length ? { fallback: true, note: 'x' } : null);
ok(planFb.fallback === true && /8-bar grid/i.test(planFb.note),
   'T15: uncertain detection falls back to 8-bar grid with honest note', planFb.note);
ok(S.labelText('high-energy') === 'Likely hook (high energy + vocal)' &&
   !/chorus/i.test(S.labelText('high-energy')),
   'T16: labelText never claims "chorus"', S.labelText('high-energy'));

/* ---------- edge cases ---------- */
function silentBuf(secs) {
  const b = new FakeAudioBuffer(2, Math.round(secs * SR), SR);
  b.getChannelData(0).fill(0); b.getChannelData(1).fill(0);
  return b;
}
const detSilent = S.detectSections(silentBuf(20), BPM);
ok(detSilent.fallback === true && /8-bar grid/i.test(detSilent.note),
   'T17: silence → honest fallback', detSilent.note);
let crashed = false;
try { S.detectSections(null, BPM); S.detectSections({}, BPM); } catch (e) { crashed = true; }
ok(!crashed, 'T18: null/garbage buffer → no crash');
const short = new FakeAudioBuffer(1, Math.round(4 * BAR * SR), SR); // 4 bars < 8
ok(S.detectSections(short, BPM).fallback === true,
   'T19: <8-bar audio → fallback');
ok(S.detectSections(synthSong(), NaN).fallback === true,
   'T20: invalid BPM → fallback');
// confidence rounding sanity
ok(det.sections.every(s => Math.abs(s.confidence * 100 - Math.round(s.confidence * 100)) < 1e-9),
   'T21: confidences rounded to 2 decimals');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
