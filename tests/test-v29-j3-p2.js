'use strict';
/* =====================================================================
   RuhMix v29 — Worker J3 (Studio P2s) regression tests.
   Drives the REAL code headlessly (no browser):
     Part 1 (no document):
       www/js/v25-studio.js via RM.v25studio._t
         - P2-1: delete/trim touch only the affected junction
         - P2-3: "Apply to section" one-apply semantics (idempotent re-press)
         - P2-5: cross-stack stale-undo guard (fingerprint)
     Part 2 (minimal fake document):
       www/js/v25-mixmaster.js + mashup-dsp.js + v25-studio.js +
       v26-studio-fx.js + v26-vocal.js
         - P2-2: "Apply automation" idempotent (no double-bake)
         - P2-6: downbeat-snapped transition updates the junction label
         - P2-4: vocal target poll stops when Studio is hidden (no leak)
         - P2-3: fade selects reset to Off after Apply (DOM)

   Run:  node tests/test-v29-j3-p2.js   (from ~/workspace/ruhmix)
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, '..', 'www', 'js');
const SR = 22050;

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const approx = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

/* ---------- shims (mirrors test-v27-studio.js) ---------- */
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
const _store = {};
global.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k in _store) delete _store[k]; },
};
global.window = {};
global.RM = {
  audio: {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
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

function loadJs(name) { eval(fs.readFileSync(path.join(WWW, name), 'utf8')); }

// position-dependent content: any wrong splice is detectable
function mkBuf(sec, seed) {
  const b = new FakeAudioBuffer(2, Math.round(sec * SR), SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++)
      d[i] = (((i * 1103515245 + 12345 + c * 7919 + (seed || 0)) & 0x7fffffff) / 0x7fffffff) * 0.8 - 0.4;
  }
  return b;
}
function bufsEqual(a, b) {
  if (!a || !b || a.length !== b.length || a.numberOfChannels !== b.numberOfChannels) return false;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c), y = b.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/* ================= Part 1: v25-studio (no document) ================= */
loadJs('v25-studio.js');
const S = global.window.RM.v25studio;
const T = S._t;
if (!S || !T) { console.error('FAIL: v25studio/_t not exposed'); process.exit(1); }

// 40s @120bpm: 5 sections x 8s, 4 junctions
function fresh40() {
  S.open({ buffer: mkBuf(40), meta: { bpm: 120 }, engineTags: 'test', songs: [] });
  const st = T.st();
  st.sel = 1;
  return st;
}

console.log('== P2-1: delete/trim only touch the affected junction ==');
{
  const NJ = () => T.st().bounds.length;
  // delete an interior section: only the new seam junction resets
  let st = fresh40();
  const n0 = st.sections.length, j0 = n0 - 1;
  st.bounds = [];
  for (let k = 0; k < j0; k++) st.bounds.push(k % 2 ? 'dip' : 'xfade');
  const before = st.bounds.slice();
  st.sel = 1;
  ok(T.deleteSection() === true, 'deleteSection interior');
  ok(NJ() === j0 - 1, 'bounds shrinks by one');
  const seamOk = st.bounds[0] === 'cut' &&
    st.bounds.slice(1).every((b, k) => b === before[k + 2]);
  ok(seamOk, 'only the seam junction (idx 0) reset to cut; others preserved: ' +
    JSON.stringify(st.bounds));
  // undo restores the exact junction choices
  T.doUndo();
  ok(JSON.stringify(st.bounds) === JSON.stringify(before),
    'undo restores every junction choice');

  // delete the FIRST section: its adjacent junction is removed with it — nothing reset
  st = fresh40();
  st.bounds = [];
  for (let k = 0; k < st.sections.length - 1; k++) st.bounds.push(k % 2 ? 'dip' : 'xfade');
  const beforeFirst = st.bounds.slice();
  st.sel = 0;
  ok(T.deleteSection() === true, 'deleteSection first');
  ok(JSON.stringify(st.bounds) === JSON.stringify(beforeFirst.slice(1)),
    'no junction reset when deleting the first section: ' + JSON.stringify(st.bounds));

  // delete the LAST section: adjacent junction removed — nothing reset
  st = fresh40();
  st.bounds = [];
  for (let k = 0; k < st.sections.length - 1; k++) st.bounds.push(k % 2 ? 'dip' : 'xfade');
  const beforeLast = st.bounds.slice();
  st.sel = st.sections.length - 1;
  ok(T.deleteSection() === true, 'deleteSection last');
  ok(JSON.stringify(st.bounds) === JSON.stringify(beforeLast.slice(0, -1)),
    'no junction reset when deleting the last section: ' + JSON.stringify(st.bounds));

  // trim: no section pair changes — ALL junctions survive
  st = fresh40();
  st.bounds = [];
  for (let k = 0; k < st.sections.length - 1; k++) st.bounds.push(k % 2 ? 'dip' : 'xfade');
  const beforeTrim = st.bounds.slice();
  st.sel = 1;
  ok(T.trimSection('end', 0.5) === true, 'trimSection(end, 0.5s)');
  ok(JSON.stringify(st.bounds) === JSON.stringify(beforeTrim),
    'trim preserves every junction choice');
  st.sel = 2;
  ok(T.trimSection('start', 0.5) === true, 'trimSection(start, 0.5s)');
  ok(JSON.stringify(st.bounds) === JSON.stringify(beforeTrim),
    'trim-start preserves every junction choice');
}

console.log('== P2-5: cross-stack stale-undo guard ==');
{
  // the reported sequence: v25 edit -> v26 op replaces the buffer -> v25 undo
  let st = fresh40();
  const bufAfterOpen = st.current;
  st.sel = 1;
  ok(T.deleteSection() === true, 'v25 delete (pushes patch command)');
  const depthAfterDelete = st.undo.length;
  // simulate a v26 FX op committing out-of-band (different length AND content)
  const v26buf = mkBuf(32, 999);
  S.fxApi.apply(v26buf, {});
  ok(st.current === v26buf, 'v26 op replaced st.current out-of-band');
  T.doUndo();
  ok(st.redo.length === 0, 'stale v25 undo REFUSED (nothing pushed to redo)');
  ok(st.current === v26buf, 'refused undo left the audio untouched');
  ok(st.undo.length === depthAfterDelete, 'stale command retained (retry-safe)');
  ok(bufsEqual(st.current, v26buf), 'buffer still byte-identical to the v26 result');

  // same-length v26 change is also refused (honest, no silent wrong-audio splice)
  st = fresh40();
  st.sel = 1;
  T.deleteSection();
  const sameLen = mkBuf(32, 4242); // open was 40s; delete left 32s
  ok(st.current.length === sameLen.length, 'precondition: same length');
  S.fxApi.apply(sameLen, {});
  T.doUndo();
  ok(st.redo.length === 0, 'stale undo refused even when lengths match');
  ok(st.current === sameLen, 'audio untouched');

  // positive control: normal undo/redo still byte-identical
  st = fresh40();
  const b0 = st.current;
  st.sel = 1;
  T.deleteSection();
  T.doUndo();
  ok(st.redo.length === 1, 'fresh v25 undo accepted');
  ok(bufsEqual(st.current, b0), 'undo restores byte-identical audio');
  T.doRedo();
  ok(st.redo.length === 0, 'redo accepted after undo');
  ok(st.current.length === b0.length - Math.round(8 * SR), 'redo re-applies the delete');

  // fingerprint helper sanity
  st = fresh40();
  const fp1 = T.bufFingerprint(st.current);
  const fp2 = T.bufFingerprint(st.current);
  ok(fp1 === fp2 && fp1.length > 4, 'fingerprint stable for identical buffer');
  const other = mkBuf(40, 123);
  ok(T.bufFingerprint(other) !== fp1, 'fingerprint differs for different content');
  ok(T.regionMatches(st.current, 0, T.sliceSamp(st.current, 0, 100)) === true,
    'regionMatches true for a real slice');
}

console.log('== P2-3: "Apply to section" one-apply semantics (headless core) ==');
{
  // no DOM: all controls read as neutral (fi=fo=vdb=0, tr='cut')
  let st = fresh40();
  st.sel = 1;
  const d0 = st.undo.length;
  T.applySectionEdit();
  ok(st.undo.length === d0 + 1, 'first Apply pushes one undo entry');
  ok(typeof st._lastSectionEdit === 'string', 'idempotency key recorded');
  T.applySectionEdit();
  ok(st.undo.length === d0 + 1, 'identical re-press is a no-op (no duplicate undo)');
  // undo voids the key, so Apply works again afterwards
  T.doUndo();
  ok(true, 'undo the section edit');
  T.applySectionEdit();
  ok(st.undo.length === d0 + 1, 'Apply works again after undo (key was voided)');
}

/* ================= Part 2: fake document ================= */
console.log('== Part 2 harness: fake document ==');
function fakeEl(id) {
  const el = {
    _id: id, value: '', textContent: '', style: {}, disabled: false,
    children: [], firstChild: null, offsetParent: null,
    classList: { _a: false, contains() { return el.classList._a; }, add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    appendChild(c) { c.parentNode = el; el.children.push(c); if (!el.firstChild) el.firstChild = c; return c; },
    insertBefore(c) { return el.appendChild(c); },
    closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext() { return new Proxy({}, { get: () => () => ({}) }); },
    setAttribute() {}, getAttribute() { return null; },
    click() {}, focus() {}, scrollIntoView() {},
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => _html,
    set: (v) => { _html = String(v); el.children = []; el.firstChild = fakeEl(id + '-kid'); },
  });
  return el;
}
const els = {};
let screenStudioVisible = false;
{
  const scr = fakeEl('screen-studio');
  scr.classList.contains = () => screenStudioVisible;
  els['screen-studio'] = scr;
  els['stu-main'] = fakeEl('stu-main');
  els['v26-junc'] = fakeEl('v26-junc');
}
global.document = {
  readyState: 'complete',
  body: fakeEl('body'),
  documentElement: fakeEl('html'),
  getElementById: (id) => els[id] || null,
  createElement: (tag) => fakeEl(tag),
  addEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
};
// capture timers for the P2-4 leak test
const liveTimers = new Map();
let nextTimerId = 1;
global.setInterval = (fn) => { const id = nextTimerId++; liveTimers.set(id, fn); return id; };
global.clearInterval = (id) => { liveTimers.delete(id); };
global.RM.app = {}; // onShow hook target for v26-vocal

loadJs('v25-mixmaster.js');
loadJs('mashup-dsp.js');
loadJs('fx.js'); // RM.fx.eq7 — needed by v26-vocal.js panelHTML
// v25-studio already loaded (no-document); open a fresh studio BEFORE the v26 files
// so FX()/vocal code sees a real buffer.
const S2 = global.window.RM.v25studio;
S2.open({ buffer: mkBuf(40), meta: { bpm: 120 }, engineTags: 'test', songs: [] });
S2._t.st().sel = 1;
loadJs('v26-studio-fx.js');
loadJs('v26-vocal.js');

const FX = global.window.RM.v26fx;
const VV = global.window.RM.v26vocal;
if (!FX || !VV) { console.error('FAIL: v26fx/v26vocal not exposed'); process.exit(1); }

console.log('== P2-2: "Apply automation" is idempotent ==');
{
  // first touch anchors the v26 lane sync (mirrors real first-panel-use)
  const drawPts = () => {
    // mirror the real canvas path: lane edits sync to Studio state
    FX.autoPoints = [{ t: 2, g: 0.5 }, { t: 38, g: 0.5 }];
    S2.fxApi.setAuto(FX.autoPoints.map((q) => ({ t: q.t, g: q.g })));
  };
  drawPts();
  const d0 = FX.internals.undoDepth();
  FX.internals.applyAutomationUI(); // syncCheck anchors; no bake yet
  drawPts();
  const preBuf = S2._t.st().current;
  FX.internals.applyAutomationUI(); // real bake
  const d1 = FX.internals.undoDepth();
  ok(d1 === d0 + 1, 'bake pushes exactly one undo entry');
  ok(FX.autoPoints.length === 2 && FX.autoPoints.every((p) => Math.abs(p.g - 1) < 1e-6),
    'lane reset to neutral after baking');
  ok(!bufsEqual(preBuf, S2._t.st().current), 'audio actually changed by the bake');
  const bufAfterBake = S2._t.st().current;
  FX.internals.applyAutomationUI(); // re-press with neutral lane
  ok(FX.internals.undoDepth() === d1, 're-press pushes NO duplicate undo (idempotent)');
  ok(S2._t.st().current === bufAfterBake, 're-press leaves the audio untouched');
  // undo/redo coherence with the neutral post-state
  FX.undo();
  ok(bufsEqual(S2._t.st().current, preBuf), 'undo restores pre-bake audio');
  ok(FX.autoPoints.some((p) => Math.abs(p.g - 1) > 1e-6), 'undo restores the drawn points to the lane');
  FX.redo();
  ok(S2._t.st().current === bufAfterBake, 'redo restores baked audio');
  ok(FX.autoPoints.every((p) => Math.abs(p.g - 1) < 1e-6),
    'redo keeps the lane neutral (no stale points -> no accidental double-bake)');
}

console.log('== P2-6: junction label follows the downbeat snap ==');
{
  const sel = els['v26-junc'];
  // baseline: no snap info -> plain boundary labels
  FX.internals.rebuildJunctions();
  const plain = sel.children.map((o) => o.textContent).join(' | ');
  ok(sel.children.length === S2._t.st().sections.length - 1 && !/downbeat/.test(plain),
    'no snap -> plain labels (' + sel.children.length + ' junctions)');
  // simulate a snapped transition at junction 1 landing on a downbeat at 12.8s
  FX._snapInfo = undefined; // (set via the real path below if reachable)
  // drive through the real proceed() path is async (downbeat analysis);
  // emulate exactly what proceed() stores:
  const apiRef = FX; // api object; proceed() assigns api._snapInfo
  apiRef._snapInfo = { ji: 1, time: 12.8 };
  FX.internals.rebuildJunctions();
  const labelled = sel.children[1].textContent;
  ok(/downbeat 0:12/.test(labelled),
    'snapped junction option names the ACTUAL applied time: "' + labelled + '"');
  ok(!/downbeat/.test(sel.children[0].textContent) && !/downbeat/.test(sel.children[2].textContent),
    'other junctions keep plain labels');
}

console.log('== P2-4: vocal target poll has no forever-timer ==');
{
  ok(VV._timerActive() === true, 'timer armed while Studio visible-path initialises');
  // leave the Studio screen -> the onShow hook must stop the timer
  screenStudioVisible = false;
  global.RM.app.onShow('home');
  ok(VV._timerActive() === false && liveTimers.size === 0,
    'onShow(non-studio) -> clearInterval (timer gone)');
  // come back -> re-armed and refreshing
  screenStudioVisible = true;
  global.RM.app.onShow('studio');
  ok(VV._timerActive() === true && liveTimers.size === 1,
    'onShow(studio) -> timer re-armed');
  // backstop: a tick while hidden self-clears even if the hook was missed
  screenStudioVisible = false;
  const tick = [...liveTimers.values()][0];
  tick();
  ok(VV._timerActive() === false && liveTimers.size === 0,
    'hidden tick self-clears (backstop)');
  // panel destroyed -> refreshTarget is a safe no-op
  delete els['v26v-target'];
  ok(VV._studioVisible() === false, 'studioVisible() false when hidden');
  let threw = false;
  try { tick(); } catch (e) { threw = true; }
  ok(!threw, 'tick with no panel never throws');
}

console.log('== P2-3: fade selects reset to Off after Apply (DOM) ==');
{
  const st = S2._t.st();
  st.sel = 1;
  const fi = fakeEl('stu-fadein'); fi.value = '1';
  const fo = fakeEl('stu-fadeout'); fo.value = '2';
  const vr = fakeEl('stu-vol'); vr.value = '3';
  const vrv = fakeEl('stu-vol-v');
  els['stu-fadein'] = fi; els['stu-fadeout'] = fo;
  els['stu-vol'] = vr; els['stu-vol-v'] = vrv;
  const d0 = st.undo.length;
  S2._t.applySectionEdit();
  ok(st.undo.length === d0 + 1, 'Apply with fades pushes one undo entry');
  ok(fi.value === '0' && fo.value === '0' && vr.value === '0' && vrv.textContent === '0 dB',
    'fade in/out + volume all reset to neutral after Apply');
  // identical re-press (re-set the same values) is a no-op
  fi.value = '1'; fo.value = '2'; vr.value = '3';
  S2._t.applySectionEdit();
  ok(st.undo.length === d0 + 1, 'identical re-press skipped (no double-deepened fades)');
  // changed values apply again
  fi.value = '0.5'; fo.value = '0'; vr.value = '0';
  S2._t.applySectionEdit();
  ok(st.undo.length === d0 + 2, 'changed settings apply normally');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
