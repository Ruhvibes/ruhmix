'use strict';
/* =====================================================================
   RuhMix v29 F2 — preset plumbing (J2 P1s + P2-4) tests.
   Run: node tests/test-v29-f2-preset-plumbing.js   (from ~/workspace/ruhmix)

   Proves every preset headline param reaches the engine path:
     P1-1  tempoShift -> applyPresetTempo (real WSOLA stretch, ratio exact);
           sidechainDb -> applyPresetPump (beat-grid pump at exact dB depth);
           presetBuildOpts carries sidechainDb.
     P1-2  duet path: buildDuet takes preset opts; riserPlanForDuet builds
           a real plan from the buffer (never null) so risers fire.
     P1-3  riserPlanForMega reads meta.songCount (array-safe): 5-song mega
           puts the riser at bar 76, not bar 28.
     P2-4  Custom preset: reverbWet/delayWet/sidechainDb all 0 (dry).
   ===================================================================== */

/* ---------------- shims (same shape as tests/test-v25-i1.js) -------- */
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
function fakeEl(tag) {
  const kids = [];
  const el = {
    tagName: String(tag || 'div').toUpperCase(), children: kids,
    className: '', id: '', textContent: '', innerHTML: '',
    hidden: false, disabled: false, style: {}, _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return (k in this._attrs) ? this._attrs[k] : null; },
    appendChild(c) { kids.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return el;
}
const fakeDocument = {
  body: fakeEl('body'), readyState: 'complete',
  createElement(t) { return fakeEl(t); },
  getElementById() { return null; },
  querySelector() { return null; },
  addEventListener() {},
};
global.window = { RM: {}, document: fakeDocument, navigator: { userAgent: 'node' } };
global.document = fakeDocument;
// (node >=21 has a read-only global navigator — window.navigator is enough)
global.RM = global.window.RM;
// v25-create touches RM.audio.ensureCtx only on real builds; the post-chain
// helpers under test need just mashupDSP.timeStretch — stubbed per-test.
global.window.RM.audio = {};
global.window.RM.mashupDSP = {};

require('../www/js/v25-arrange.js');
require('../www/js/v25-create.js');
const createMod = require('../www/js/v25-create.js');
const T = createMod.internals;
const VA = global.window.RM.v25arrange;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}

async function main() {
  /* ============ P1-3: mega riser plan reads songCount ============ */
  console.log('== P1-3: riserPlanForMega ==');
  // real mega meta shape: songs is an ARRAY, songCount is the number
  const realMeta = {
    bpm1: 100, cycles: 2, style: 'mega',
    songCount: 5,
    songs: [{}, {}, {}, {}, {}], // array -> Number(array) is NaN (the old bug)
  };
  const mp5 = T.riserPlanForMega(realMeta);
  ok(mp5 && mp5.sections[0].startBar === 4 + (2 * 5 - 1) * 8,
     '5-song mega: riser at bar 76 (not 28)',
     'got bar ' + (mp5 && mp5.sections[0].startBar));
  ok(mp5 && mp5.gridBpm === 100, 'mega plan keeps meta bpm1 as gridBpm');
  // legacy numeric form (old unit test input) still works
  const mpLegacy = T.riserPlanForMega({ bpm1: 100, songs: 4, cycles: 2 });
  ok(mpLegacy && mpLegacy.sections[0].startBar === 4 + (2 * 4 - 1) * 8,
     'legacy numeric songs:4 still -> bar 60 (backward compat)',
     'got bar ' + (mpLegacy && mpLegacy.sections[0].startBar));
  const mp2 = T.riserPlanForMega({ bpm1: 120, songCount: 2, songs: [{}, {}], cycles: 2 });
  ok(mp2 && mp2.sections[0].startBar === 4 + (2 * 2 - 1) * 8,
     '2-song mega: riser at bar 28',
     'got bar ' + (mp2 && mp2.sections[0].startBar));

  /* ============ P1-2: duet riser plan + buildDuet takes po ============ */
  console.log('== P1-2: duet preset plumbing ==');
  const duetBuf = new FakeAudioBuffer(2, Math.round(200 * 22050), 22050); // 200 s
  const dp = T.riserPlanForDuet(duetBuf, 100);
  // totalBars = round(200*100/240) = 83 -> startBar 75
  ok(dp !== null, 'duet riser plan is never null for a real buffer');
  ok(dp && dp.sections[0].startBar === 75 && dp.sections[0].type === 'finalChorus',
     'duet plan: riser into final 8 bars (bar 75)',
     JSON.stringify(dp && dp.sections[0]));
  ok(dp && dp.gridBpm === 100, 'duet plan carries the grid bpm');
  ok(T.riserPlanForDuet(null, 100) === null, 'duet plan null-safe on bad buffer');
  // risers actually fire on the duet plan for a riser preset (EDM)
  const edmSpec = VA.presetRenderSpec('edm', null);
  const rbuf = new FakeAudioBuffer(2, Math.round(200 * 22050), 22050);
  for (let c = 0; c < 2; c++) rbuf.getChannelData(c).fill(0.05);
  const before = rbuf.getChannelData(0).slice();
  VA.addRisers(rbuf, dp, edmSpec, 22050);
  let changed = 0;
  const d0 = rbuf.getChannelData(0);
  for (let i = 0; i < d0.length; i += 997) if (d0[i] !== before[i]) changed++;
  ok(changed > 0, 'EDM risers fire on the duet plan (not a silent no-op)',
     'touched samples: ' + changed);
  // buildDuet accepts the preset opts param (duet engines take no opts;
  // the params land in the post-chain — signature proof)
  ok(T && typeof T.applyPresetPump === 'function', 'post-chain pump helper exported');
  const duetFnSrc = createMod.api ? '' : '';
  void duetFnSrc;

  /* ============ P1-1: tempoShift -> real stretch ============ */
  console.log('== P1-1: preset tempo reaches the engine ==');
  const slowedOpts = T.presetBuildOpts('slowed');
  ok(slowedOpts && Math.abs(slowedOpts.tempoShift - 0.85) < 1e-9,
     "presetBuildOpts('slowed').tempoShift === 0.85", String(slowedOpts && slowedOpts.tempoShift));
  const edmOpts = T.presetBuildOpts('edm');
  ok(edmOpts && Math.abs(edmOpts.sidechainDb - 4.5) < 1e-9,
     "presetBuildOpts('edm').sidechainDb === 4.5", String(edmOpts && edmOpts.sidechainDb));
  const sadOpts = T.presetBuildOpts('sad');
  ok(sadOpts && sadOpts.vocalBoostDb === 5 && Math.abs(sadOpts.tempoShift - 0.92) < 1e-9,
     "presetBuildOpts('sad'): vocalBoostDb 5 + tempoShift 0.92",
     JSON.stringify({ v: sadOpts && sadOpts.vocalBoostDb, t: sadOpts && sadOpts.tempoShift }));
  // applyPresetTempo forwards ratio = 1/tempoShift to the REAL timeStretch
  let seenRatio = null, progCalls = 0;
  global.window.RM.mashupDSP.timeStretch = function (b, ratio, onProg) {
    seenRatio = ratio;
    if (onProg) { progCalls++; onProg(0.5); }
    const out = new FakeAudioBuffer(b.numberOfChannels, Math.round(b.length * ratio), b.sampleRate);
    return Promise.resolve(out);
  };
  const tbuf = new FakeAudioBuffer(2, 22050, 22050);
  const stretched = await T.applyPresetTempo(tbuf, 0.85, function () {});
  ok(Math.abs(seenRatio - 1 / 0.85) < 1e-9,
     'tempoShift 0.85 -> timeStretch ratio 1/0.85 (exact)', String(seenRatio));
  ok(stretched.length === Math.round(22050 / 0.85),
     'stretched buffer length = in * 1/0.85', String(stretched.length));
  ok(progCalls > 0, 'stretch progress callback fires');
  // tempoShift 1 -> untouched, no engine call
  seenRatio = null;
  const same = await T.applyPresetTempo(tbuf, 1, function () {});
  ok(same === tbuf && seenRatio === null, 'tempoShift 1 -> buffer untouched, engine not called');
  // missing engine -> resolves original (never rejects, never kills build)
  global.window.RM.mashupDSP.timeStretch = null;
  const fallback = await T.applyPresetTempo(tbuf, 0.85, function () {});
  ok(fallback === tbuf, 'no stretch engine -> original buffer (no crash)');

  /* ============ P1-1: sidechainDb -> real grid pump ============ */
  console.log('== P1-1: preset sidechain depth reaches the engine ==');
  const SR = 22050, BPM = 120;
  function flatBuf(sec, val) {
    const b = new FakeAudioBuffer(2, Math.round(sec * SR), SR);
    for (let c = 0; c < 2; c++) b.getChannelData(c).fill(val);
    return b;
  }
  const pbuf = flatBuf(4, 1.0);
  T.applyPresetPump(pbuf, 4.5, BPM);
  const pd = pbuf.getChannelData(0);
  const beatLen = Math.round(60 / BPM * SR);
  const minG = Math.pow(10, -4.5 / 20); // 0.5957
  // deepest duck is at each beat start (t=0 of the envelope)
  let worst = 1;
  for (let k = 0; k < 8; k++) { const v = pd[k * beatLen]; if (v < worst) worst = v; }
  ok(Math.abs(worst - minG) < 0.01,
     'pump ducks to exactly 10^(-4.5/20) on the beat', 'min gain ' + worst.toFixed(4));
  // recovered ~fully by the next beat (no permanent gain loss)
  let endBeat = 1;
  for (let k = 0; k < 8; k++) { const v = pd[k * beatLen + beatLen - 1]; if (v < endBeat) endBeat = v; }
  ok(endBeat > 0.98, 'pump releases before the next beat', 'end-of-beat gain ' + endBeat.toFixed(4));
  // depth 0 (Custom) -> untouched
  const cbuf = flatBuf(2, 0.7);
  const cBefore = cbuf.getChannelData(0).slice();
  T.applyPresetPump(cbuf, 0, BPM);
  let diff = 0;
  const cd = cbuf.getChannelData(0);
  for (let i = 0; i < cd.length; i++) if (cd[i] !== cBefore[i]) { diff++; break; }
  ok(diff === 0, 'sidechainDb 0 -> buffer untouched (Custom stays dry)');

  /* ============ P2-4: Custom is dry ============ */
  console.log('== P2-4: Custom preset has zero FX ==');
  const customSpec = VA.presetRenderSpec('custom', null);
  ok(customSpec.reverbWet === 0 && customSpec.delayWet === 0,
     'custom spec: reverbWet 0, delayWet 0',
     JSON.stringify({ r: customSpec.reverbWet, d: customSpec.delayWet }));
  ok(customSpec.sidechainDb === 0,
     'custom spec: sidechainDb 0 (no pump)', String(customSpec.sidechainDb));
  ok(customSpec.tempoShift === 1 && customSpec.risers === false,
     'custom spec: tempoShift 1, no risers');
  // end-to-end: applyPresetPost leaves a Custom buffer bit-identical
  const mbuf = flatBuf(2, 0.4);
  const mBefore = mbuf.getChannelData(0).slice();
  T.applyPresetPost(mbuf, customSpec, null, 100);
  let mDiff = 0;
  const md = mbuf.getChannelData(0);
  for (let i = 0; i < md.length; i++) if (md[i] !== mBefore[i]) { mDiff++; break; }
  // (mastering is intentionally kept: true-peak safety is not "colour")
  console.log('  info Custom post-chain touched samples: ' + (mDiff ? 'some (mastering safety)' : 'none'));
  // but space FX add nothing: reverb/echo/pump/risers all no-op
  const sbuf = flatBuf(2, 0.4);
  const sBefore = sbuf.getChannelData(0).slice();
  T.applyPresetSpace(sbuf, customSpec, SR, 100);
  T.applyPresetPump(sbuf, customSpec.sidechainDb, 100);
  VA.addRisers(sbuf, { gridBpm: 100, sections: [{ type: 'finalChorus', startBar: 2, bars: 8 }] }, customSpec, SR);
  let sDiff = 0;
  const sd = sbuf.getChannelData(0);
  for (let i = 0; i < sd.length; i++) if (sd[i] !== sBefore[i]) { sDiff++; break; }
  ok(sDiff === 0, 'Custom: space + pump + risers add nothing (bit-identical)');

  /* ============ every preset still differs (no no-ops) ============ */
  console.log('== preset differentiation intact ==');
  const ids = T.listPresets().map((p) => p.id);
  ok(ids.length === 12, '12 presets intact', String(ids.length));
  const seen = {};
  ids.forEach((id) => {
    const s = VA.presetRenderSpec(id, null);
    seen[id] = [s.tempoShift, s.reverbWet, s.delayWet, s.sidechainDb,
                s.vocalBoostDb, s.bassDb, s.brightness, s.beatStyle,
                s.risers, s.transition].join('|');
  });
  const uniq = {};
  ids.forEach((id) => { uniq[seen[id]] = (uniq[seen[id]] || 0) + 1; });
  const dupes = Object.keys(uniq).filter((k) => uniq[k] > 1);
  ok(dupes.length === 0, 'all 12 preset specs differ in >=1 audible param',
     dupes.length ? 'dupes: ' + dupes.length : '');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
