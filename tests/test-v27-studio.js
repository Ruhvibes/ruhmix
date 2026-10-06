'use strict';
/* =====================================================================
   v27 W3 tests: beat-grid snap polish + loop controls + autosave /
   crash-recovery. Drives the REAL code headlessly (no browser):
     - www/js/v25-studio.js  via RM.v25studio._t (snap math + commit paths)
     - www/js/v27-loop.js    via require()      (region model + render)
     - www/js/projects.js + www/js/app.js via RM.proj / RM.app (autosave,
       clean/dirty flags, and the REAL checkCrashRecovery() init sequence
       with a fake banner DOM)

   Run:  node tests/test-v27-studio.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, '..', 'www', 'js');
const SR = 22050; // test sample rate — impl must be rate-agnostic

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const approx = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

/* ---------- shims ---------- */
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
// localStorage fake with write counting
const _store = {};
let lsWrites = 0;
global.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { lsWrites++; _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k in _store) delete _store[k]; },
};
global.window = {};
global.RM = {
  audio: {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    ensureCtx: () => fakeCtx,
  },
};
global.window.RM = global.RM;
// NOTE: no `document` yet — v25-studio tests run exactly like
// test-v25-studio-i2.js (document undefined => DOM paths skipped).

function loadJs(name) {
  eval(fs.readFileSync(path.join(WWW, name), 'utf8'));
}

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

async function main() {
  /* ================= 1. beat-grid snap (v25-studio) ================= */
  loadJs('v25-studio.js');
  const S = global.window.RM.v25studio;
  const T = S._t;
  if (!S || !T) { console.error('FAIL: v25studio/_t not exposed'); process.exit(1); }

  // 40s @120bpm builtin: bar=2s, beat=0.5s
  function fresh40() {
    S.open({ buffer: mkBuf(40), meta: { bpm: 120 }, engineTags: 'test', songs: [] });
    const st = T.st();
    st.sel = 1;
    st.snap = true; st.snapRes = 'bar';
    return st;
  }

  console.log('== W3: snapToBeat math ==');
  {
    fresh40();
    // THE acceptance: a clip dropped at beat+13ms snaps to the beat
    ok(approx(T.snapToBeat(2.5 + 0.013), 2.5), 'beat+13ms snaps to the beat (2.513 -> 2.5)');
    ok(approx(T.snapToBeat(0.5 + 0.013), 0.5), 'beat+13ms snaps to the beat (0.513 -> 0.5)');
    // sensible near boundaries: the bar magnet wins within half a beat
    ok(approx(T.snapToBeat(2.0 + 0.013), 2.0), 'bar+13ms snaps to the BAR (boundary wins)');
    ok(approx(T.snapToBeat(1.99), 2.0), '1.99 -> bar 2.0, not beat 1.5');
    ok(approx(T.snapToBeat(0.02), 0.0), '0.02 -> bar 0.0');
    // mid-bar: nearest beat, not the bar
    ok(approx(T.snapToBeat(1.7), 1.5), '1.7 -> nearest beat 1.5 (bar 0.3s away loses)');
    ok(approx(T.snapToBeat(3.3), 3.5), '3.3 -> nearest beat 3.5');
    // clamps to the buffer
    ok(T.snapToBeat(-0.3) === 0, 'negative clamps to 0');
    ok(T.snapToBeat(39.9) === 40, 'near-end snaps to duration (bar magnet)');
    ok(T.snapToBeat(999) === 40, 'far past end clamps to duration');
    // snap OFF: identity
    const st = T.st();
    st.snap = false;
    ok(T.snapTime(3.14159) === 3.14159, 'snap off -> position untouched');
    st.snap = true;
  }

  console.log('== W3: snap toggle cycles Off->Bar->Beat ==');
  {
    const st = fresh40(); // snap:true, res:'bar'
    T.toggleSnap();
    ok(st.snap === true && st.snapRes === 'beat', 'toggle 1: Bar -> Beat (still on)');
    T.toggleSnap();
    ok(st.snap === false, 'toggle 2: Beat -> Off');
    T.toggleSnap();
    ok(st.snap === true && st.snapRes === 'bar', 'toggle 3: Off -> Bar');
  }

  console.log('== W3: snap quantizes real commit paths ==');
  {
    // beat-mode split lands on the beat grid
    const st = fresh40();
    st.snap = true; st.snapRes = 'beat';
    T.tp().offset = 8 + 2.6; // inside section 1, 2.6s in
    ok(T.splitSection() === true, 'splitSection in beat mode');
    ok(approx(st.sections[1].lenSec, 2.5), 'split landed on beat 2.5s, not 2.6s');
    // bar mode unchanged (legacy behavior preserved)
    const st2 = fresh40();
    st2.snap = true; st2.snapRes = 'bar';
    T.tp().offset = 8 + 3.3;
    ok(T.splitSection() === true, 'splitSection in bar mode');
    ok(approx(st2.sections[1].lenSec, 4.0), 'bar mode still lands on the bar (4.0s)');
    // drop-slot index honors the grid parameter
    fresh40();
    ok(T.snapInsertIndex([0.9, 15.1], 1) === 0, 'bar grid (default): slot snaps to bar boundary 0');
    ok(T.snapInsertIndex([0.9, 15.1], 1, 0.5) === 1, 'beat grid: same drop keeps slot 1');
    // beat-mode drag commit: model + buffer stay consistent
    const st3 = fresh40();
    st3.snap = true; st3.snapRes = 'beat';
    const n0 = st3.sections.length, d0 = st3.current.duration;
    T.dragCommit(0, 3);
    ok(st3.sections.length === n0 && approx(st3.current.duration, d0), 'beat-mode dragCommit keeps model+buffer consistent');
  }

  /* ================= 2. loop controls (v27-loop) ================= */
  const LOOP = require(path.join(WWW, 'v27-loop.js'));
  const mkOut = (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr);

  console.log('== W3: loop region model ==');
  {
    LOOP.clear(null);
    ok(LOOP.setRegion(5, 3, null, 10) === true, 'setRegion accepts a range');
    ok(LOOP.state().inSec === 3 && LOOP.state().outSec === 5, 'inverted range is swapped (5,3 -> 3..5)');
    ok(LOOP.setRegion(2, 2.01, null, 10) === false, 'sub-0.05s region rejected');
    ok(LOOP.setRegion(-5, 20, null, 10) === true, 'out-of-range accepted');
    ok(LOOP.state().inSec === 0 && LOOP.state().outSec === 10, 'region clamped to [0, duration]');
    ok(LOOP.setRegion('x', 4, null, 10) === false, 'non-numeric rejected');
    ok(LOOP.setFromBars(4, 8, 0.5, null, 60) === true, 'setFromBars accepts');
    ok(LOOP.state().inSec === 2 && LOOP.state().outSec === 4, 'bars 4..8 @0.5s = 2..4s');
    ok(LOOP.setFromBars(0, 4, 0, null, 60) === false, 'setFromBars rejects bad barSec');
    ok(LOOP.setTimes(3, null) === 3 && LOOP.state().times === 3, 'setTimes(3)');
    ok(LOOP.setTimes(99, null) === 8, 'times clamped to 8');
    ok(LOOP.regionLabel() === '0:02.0 – 0:04.0 ×8', 'region label shows in/out × repeats');
  }

  console.log('== W3: loop toggle + player ==');
  {
    const calls = [];
    const fakePlayer = { setLoop: (on, a, b) => calls.push([on, a, b]) };
    LOOP.clear(null);
    ok(LOOP.toggle(fakePlayer, null, 10) === true, 'toggle ON with no region');
    ok(LOOP.state().on && LOOP.state().inSec === 0 && LOOP.state().outSec === 10, 'no region -> whole-track fallback (old behavior)');
    let last = calls[calls.length - 1];
    ok(last[0] === true && last[1] === 0 && last[2] === 10, 'player.setLoop(true, 0, 10) — live source re-pointed');
    ok(LOOP.toggle(fakePlayer, null, 10) === false, 'toggle OFF');
    last = calls[calls.length - 1];
    ok(last[0] === false, 'player.setLoop(false)');
    // region path
    LOOP.setRegion(2, 4, null, 10);
    LOOP.toggle(fakePlayer, null, 10);
    last = calls[calls.length - 1];
    ok(last[0] === true && approx(last[1], 2) && approx(last[2], 4), 'player follows the region in/out (2..4)');
    ok(LOOP.applyToPlayer(null) === false, 'applyToPlayer(null) is a safe no-op');
    // no audio at all: stays off
    LOOP.clear(null);
    ok(LOOP.toggle(fakePlayer, null, 0) === false, 'toggle with no audio stays off');
  }

  console.log('== W3: loop render (spec: head + region×N + tail) ==');
  {
    // content: d[i] = i (per channel offset) — every splice verifiable
    const src = new FakeAudioBuffer(2, 10 * SR, SR);
    for (let c = 0; c < 2; c++) {
      const d = src.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = i + c * 1000000;
    }
    const at = (b, c, sec) => b.getChannelData(c)[Math.round(sec * SR)];
    const out = LOOP.renderLooped(mkOut, src, 2, 4, 3);
    ok(out && out.length === Math.round(14 * SR), 'render length = in + N*(out-in) + (dur-out) = 2+6+6 = 14s');
    ok(out && out.numberOfChannels === 2 && out.sampleRate === SR, 'channels + rate preserved');
    ok(approx(at(out, 0, 1.0), at(src, 0, 1.0)), 'head intact (1.0s)');
    ok(approx(at(out, 0, 2.5), at(src, 0, 2.5)), '1st repeat == region (2.5s)');
    ok(approx(at(out, 0, 4.5), at(src, 0, 2.5)), '2nd repeat == region (4.5s maps to 2.5s)');
    ok(approx(at(out, 0, 6.5), at(src, 0, 2.5)), '3rd repeat == region (6.5s maps to 2.5s)');
    ok(approx(at(out, 0, 9.0), at(src, 0, 5.0)), 'tail follows (9.0s maps to 5.0s)');
    ok(approx(at(out, 1, 4.5), at(src, 1, 2.5)), 'channel 2 repeats too');
    // N=1 is an identity splice
    const one = LOOP.renderLooped(mkOut, src, 2, 4, 1);
    ok(one && bufsEqual(one, src), 'times=1 renders byte-identical audio');
    // invalid regions
    ok(LOOP.renderLooped(mkOut, src, 4, 4, 2) === null, 'zero-length region -> null');
    ok(LOOP.renderLooped(mkOut, src, 5, 3, 2) === null, 'inverted region -> null');
    ok(LOOP.renderLooped(mkOut, null, 2, 4, 2) === null, 'null src -> null');
    const many = LOOP.renderLooped(mkOut, src, 2, 4, 99);
    ok(many && many.length === Math.round(24 * SR), 'times clamped to 8 (2+16+6=24s)');
  }

  console.log('== W3: loop persistence ==');
  {
    LOOP.clear(null);
    LOOP.syncFromSettings({ loop: true, loopRegion: { inSec: 1.5, outSec: 3.5, times: 4 } }, 10);
    const s1 = LOOP.state();
    ok(s1.on && s1.inSec === 1.5 && s1.outSec === 3.5 && s1.times === 4, 'region restored from settings');
    LOOP.clear(null);
    LOOP.syncFromSettings({ loop: true }, 10); // legacy: no region stored
    ok(LOOP.state().inSec === 0 && LOOP.state().outSec === 10, 'legacy whole-track loop -> full region');
    LOOP.clear(null);
    LOOP.syncFromSettings({ loop: false }, 10);
    ok(LOOP.state().on === false, 'loop off stays off');
    // settings mirror (what autosave persists)
    const settings = {};
    LOOP.setRegion(8, 16, settings, 60);
    LOOP.setTimes(3, settings);
    LOOP.toggle({ setLoop() {} }, settings, 60);
    ok(settings.loop === true && settings.loopRegion &&
      settings.loopRegion.inSec === 8 && settings.loopRegion.outSec === 16 &&
      settings.loopRegion.times === 3, 'settings.loop + loopRegion mirror the model');
    // export spec
    const spec = LOOP.exportSpec(settings, 60);
    ok(spec && spec.inSec === 8 && spec.outSec === 16 && spec.times === 3, 'exportSpec carries region+times');
    LOOP.clear(settings);
    ok(LOOP.exportSpec(settings, 60) === null, 'exportSpec null when loop off');
  }

  /* ================= 3. autosave / crash recovery ================= */
  // Now the DOM exists (fake) so app.js can load.
  const els = {};
  function mkEl(id) {
    return {
      id, style: { display: 'none' }, innerHTML: '', textContent: '', value: '', title: '',
      _h: {},
      addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    };
  }
  for (const id of ['recovery-banner', 'recovery-text', 'recovery-yes', 'recovery-no']) els[id] = mkEl(id);
  global.document = {
    readyState: 'loading', // => app.js does NOT auto-init()
    addEventListener() {},
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    createElement: () => mkEl('x'),
    body: { classList: { toggle() {} } },
  };
  loadJs('projects.js');
  loadJs('app.js');
  const P = global.window.RM.proj;
  const APP = global.window.RM.app;
  const LS_A = 'ruhmix.autosave.v1', LS_C = 'ruhmix.cleanExit.v1';

  console.log('== W3: autosave debounce + flags ==');
  {
    localStorage.clear();
    const p = P.create('Debounce');
    // count writes per key: one autosave firing = 1 autosave write + 1 flag write
    let asWrites = 0;
    const _set = localStorage.setItem;
    localStorage.setItem = (k, v) => { if (k === LS_A) asWrites++; return _set(k, v); };
    P.autosave(p); P.autosave(p); P.autosave(p); // 3 rapid edits
    await sleep(1100);
    localStorage.setItem = _set;
    ok(asWrites === 1, 'debounced: 3 rapid autosaves -> 1 autosave write (got ' + asWrites + ')');
    ok(localStorage.getItem(LS_C) === '0', 'autosave marks the exit flag dirty');
    ok(P.loadAutosave() && P.loadAutosave().id === p.id, 'autosave payload round-trips');
    P.markCleanExit();
    ok(localStorage.getItem(LS_C) === '1', 'markCleanExit sets clean');
    P.markDirty();
    ok(localStorage.getItem(LS_C) === '0', 'markDirty sets dirty');
  }

  console.log('== W3: needsRecovery truth table ==');
  {
    localStorage.clear();
    ok(P.needsRecovery() === false, 'no autosave -> no recovery');
    const p = P.create('T');
    localStorage.setItem(LS_A, P.serialize(p));
    localStorage.setItem(LS_C, '1');
    ok(P.needsRecovery() === false, 'autosave + clean exit -> no recovery');
    localStorage.setItem(LS_C, '0');
    ok(P.needsRecovery() === true, 'autosave + dirty exit -> recovery');
    localStorage.setItem(LS_A, '{corrupt-json');
    localStorage.setItem(LS_C, '0');
    ok(P.needsRecovery() === false, 'corrupt autosave -> no recovery');
    ok(localStorage.getItem(LS_A) === null, 'corrupt autosave is discarded (no stuck banner)');
  }

  console.log('== W3: checkCrashRecovery end-to-end (REAL init sequence) ==');
  {
    localStorage.clear();
    // session 1: user edits -> autosave fires (dirty). NO clean exit = crash.
    const p = P.create('Crash <b>Test</b>');
    P.autosave(p);
    await sleep(1100);
    // session 2: launch
    const shown = APP.checkCrashRecovery();
    ok(shown === true, 'banner shown after a dirty exit');
    ok(els['recovery-banner'].style.display === '', 'banner element visible');
    // the template bolds the name with its OWN <b> tags; the project name's
    // angle brackets must arrive escaped inside them
    ok(els['recovery-text'].innerHTML.indexOf('Crash &lt;b&gt;Test&lt;/b&gt;') !== -1,
      'project name is HTML-escaped in the banner');
    ok((els['recovery-yes']._h.click || []).length === 1, 'Recover handler wired');
    ok((els['recovery-no']._h.click || []).length === 1, 'Dismiss handler wired');
    // Dismiss path
    els['recovery-no']._h.click[0]();
    ok(els['recovery-banner'].style.display === 'none', 'Dismiss hides the banner');
    ok(localStorage.getItem(LS_A) === null, 'Dismiss discards the autosave');
    ok(localStorage.getItem(LS_C) === '1', 'Dismiss marks a clean exit');
    ok(P.needsRecovery() === false, 'nothing pending after Dismiss');
    // relaunches stay quiet
    ok(APP.checkCrashRecovery() === false, 'next launch: no banner');
  }

  console.log('== W3: clean-exit regression (the fixed ordering bug) ==');
  {
    localStorage.clear();
    const p = P.create('Clean');
    P.autosave(p);
    await sleep(1100);
    P.markCleanExit(); // pagehide: the user exited properly
    // OLD code called markDirty() BEFORE needsRecovery(), clobbering the
    // flag — the banner appeared after EVERY launch with an autosave.
    ok(APP.checkCrashRecovery() === false, 'no banner after a clean exit');
    ok(els['recovery-banner'].style.display === 'none', 'banner stays hidden');
    const appSrc = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
    const iNeed = appSrc.indexOf('const crashed = RM.proj.needsRecovery();');
    const iDirty = appSrc.indexOf('RM.proj.markDirty();', iNeed);
    ok(iNeed !== -1 && iDirty > iNeed, 'needsRecovery() is evaluated BEFORE markDirty()');
    ok(/\$\('recovery-yes'\)\.addEventListener\('click', \(\) => \{\s*banner\.style\.display = 'none';\s*openProject\(p\);\s*\}\)/.test(appSrc),
      'Recover hides the banner and opens the project');
    // part 1 of app.js has no `A` alias (it only exists in parts 2/3) —
    // referencing it there throws ReferenceError at runtime.
    const part1 = appSrc.split('/* ---- Native shell contract')[0];
    ok(!/\bA\.(state|updateLoopUI|toast|show|needAudio|ensureStudio)\b/.test(part1),
      'part 1 never uses the part-2/3-only `A` alias');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
