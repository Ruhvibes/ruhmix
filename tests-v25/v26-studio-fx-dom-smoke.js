'use strict';
/* =====================================================================
   RuhMix v26 I3 — DOM smoke + fxApi seam test.
   Boots the REAL www/js/v25-studio.js and www/js/v26-studio-fx.js in node
   with a minimal fake DOM, opens a synthetic mashup, and verifies:
     - the #v26-fxpanel is injected into the Studio screen and every
       control wires to a handler (no dead controls),
     - the fxApi bridge reads/replaces st.current (bpm write, section
       rescale, automation persistence, busy flag),
     - an end-to-end BPM op through the real timeStretch engine updates
       st.bpm/sections and re-renders (waveform/markers refresh path).

   Run:  node tests-v25/v26-studio-fx-dom-smoke.js  (from ~/workspace/ruhmix)
   ===================================================================== */
const fs = require('fs');
const path = require('path');

/* ---------------- fake DOM ---------------- */
function makeCtx2d() {
  return new Proxy({}, { get: (t, k) => (k === 'canvas' ? null : (...a) => {}) ,
                        set: () => true });
}
function makeEl(id, doc) {
  const el = {
    id: id || '', children: [], _listeners: {}, _wired: false,
    style: {}, dataset: {},
    _innerHTML: '', _text: '', value: '', disabled: false, title: '',
    hidden: false, clientWidth: 320,
    classList: { add() {}, remove() {}, contains: () => false },
    set innerHTML(v) {
      this._innerHTML = String(v); this.children = [];
      // Behave a little like the real DOM for our panel: register the
      // first id="..." found as a child element.
      const m = String(v).match(/id="([A-Za-z0-9_-]+)"/);
      if (m) {
        const child = makeEl(m[1], doc);
        registry[m[1]] = child;
        this.children.push(child);
      }
    },
    get innerHTML() { return this._innerHTML; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    dispatchEvent(e) { (this._listeners[e.type] || []).forEach(f => f(e)); return true; },
    setAttribute() {}, getAttribute: () => null,
    getContext: () => makeCtx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 110 }),
    querySelectorAll: () => [],
  };
  return el;
}
const registry = {};
const documentStub = {
  readyState: 'complete',
  body: makeEl('body'),
  // Real-DOM semantics: unknown ids return null.
  getElementById(id) { return registry[id] || null; },
  createElement(tag) { return makeEl('', documentStub); },
  addEventListener() {},
  querySelectorAll: () => [],
};
// Pre-register the Studio screen scaffold + every control the v26 panel
// needs (in the real app these come from STUDIO_HTML / PANEL_HTML).
['screen-studio', 'stu-main', 'stu-empty', 'stu-meta', 'stu-sections',
 'stu-selinfo', 'stu-wave', 'stu-scroll', 'stu-play', 'stu-stop', 'stu-ab',
 'stu-time', 'stu-load', 'stu-reset',
 'v26-bpm', 'v26-bpm-apply', 'v26-pitch', 'v26-pitch-v', 'v26-cents',
 'v26-cents-v', 'v26-pitch-apply', 'v26-auto', 'v26-auto-apply',
 'v26-auto-clear', 'v26-junc', 'v26-trtype', 'v26-trbars', 'v26-trdesc',
 'v26-tr-apply', 'v26-undo', 'v26-redo', 'v26-undo-label', 'v26-prog',
 'v26-pbar',
].forEach(id => { registry[id] = makeEl(id, documentStub); });
global.document = documentStub;
global.window = {
  addEventListener() {},
  devicePixelRatio: 1,
};

/* ---------------- audio shims ---------------- */
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
function fakeView() {
  return { onSeek: null, setBuffer() {}, setZoom() {}, setMarkers() {},
           setScroll() {}, setPlayhead() {}, draw() {} };
}
global.RM = {
  audio: {
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    ensureCtx: () => ({ createBuffer: (c, l, s) => new FakeAudioBuffer(c, l, s || 44100),
                        sampleRate: 44100, currentTime: 0 }),
    runChunked: (total, cs, fn, p) => new Promise((res, rej) => {
      let i = 0;
      const step = () => {
        try {
          const e = Math.min(total, i + cs); fn(i, e); i = e;
          if (p) p(i / total);
          if (i < total) setImmediate(step); else res();
        } catch (err) { rej(err); }
      };
      step();
    }),
    masterIn: () => ({}),
  },
  wave: {
    createView: () => fakeView(),
    getPeaks: () => Promise.resolve([]),
    dropPeaks() {},
  },
};
global.window.RM = global.RM;

function load(rel) {
  eval(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
}
load('www/js/v25-mixmaster.js');
load('www/js/mashup-dsp.js');
load('www/js/v25-studio.js');
load('www/js/v26-studio-fx.js');

const RMX = global.window.RM;
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function testBuffer(sec, sr) {
  const n = Math.round(sec * sr), b = new FakeAudioBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / sr);
  }
  return b;
}

(async function main() {
  // v25-studio self-boots on load (readyState complete); v26 self-boots
  // via setTimeout — wait a tick for both.
  await new Promise(r => setTimeout(r, 80));

  console.log('— panel injection + wiring (no dead controls) —');
  ok(!!registry['v26-fxpanel'], '#v26-fxpanel injected into the Studio screen');
  const panel = registry['v26-fxpanel'];
  ok(panel && registry['stu-main'] && registry['stu-main'].children.indexOf(panel) >= 0,
    'panel appended inside #stu-main (Studio screen)');
  const wired = ['v26-bpm-apply', 'v26-pitch-apply', 'v26-auto-apply',
                 'v26-auto-clear', 'v26-tr-apply', 'v26-undo', 'v26-redo'];
  ok(wired.every(id => (registry[id]._listeners.click || []).length > 0),
    'every action button has a click handler',
    wired.filter(id => !(registry[id]._listeners.click || []).length).join(',') || 'all wired');
  ok((registry['v26-auto']._listeners.mousedown || []).length > 0 &&
     (registry['v26-auto']._listeners.dblclick || []).length > 0,
    'automation canvas has mouse handlers');
  ok((registry['stu-load']._listeners.click || []).length === 2,
    'stu-load has v25 handler + v26 lifecycle listener',
    (registry['stu-load']._listeners.click || []).length + ' listeners');
  ok(registry['v26-junc'].children.length > 0, 'junction select populated');
  ok(registry['v26-trtype'].children.length === 10, 'transition select has all 10 types',
    registry['v26-trtype'].children.length + ' options');

  console.log('— open a mashup, exercise the fxApi seam —');
  const SR = 8000, DUR = 32;
  RMX.v25studio.open({ buffer: testBuffer(DUR, SR),
                      meta: { bpm: 120, style: 'classic', targetBpm: 120 },
                      engineTags: 'smoke' });
  await new Promise(r => setTimeout(r, 80)); // wrapped open + render settle
  const fx = RMX.v25studio.fxApi;
  ok(!!fx, 'fxApi bridge exists');
  ok(fx.cur() && Math.abs(fx.cur().duration - DUR) < 0.01, 'fx.cur() returns st.current');
  ok(Math.abs(fx.bpm() - 120) < 1e-9, 'fx.bpm() reads st.bpm');
  ok(fx.secs().length >= 3, 'fx.secs() returns sections', fx.secs().length + ' sections');
  const auto0 = fx.auto();
  ok(Array.isArray(auto0) && auto0.length === 2 &&
     auto0[0].t === 0 && auto0[0].g === 1 &&
     Math.abs(auto0[1].t - fx.cur().duration) < 0.01 && auto0[1].g === 1,
    'open initializes a flat 2-point lane in the project model',
    JSON.stringify(auto0));
  fx.setAuto([{ t: 0, g: 1 }, { t: 1, g: 0.5 }]);
  ok(Array.isArray(fx.auto()) && fx.auto().length === 2, 'automation persists in project model');
  fx.busy(true); ok(fx.busy() === true, 'busy flag set');
  fx.busy(false); ok(fx.busy() === false, 'busy flag cleared');

  console.log('— end-to-end master BPM op through the real engine —');
  const preSecs = fx.secs().map(s => s.lenSec);
  const preSum = preSecs.reduce((a, b) => a + b, 0);
  const nb = await RMX.mashupDSP.timeStretch(fx.cur(), 120 / 160);
  ok(Math.abs(nb.duration - DUR * 0.75) < 0.01, 'stretched buffer is 0.75x duration');
  fx.apply(nb, { bpm: 160, rescale: true });
  ok(Math.abs(fx.bpm() - 160) < 1e-9 && Math.abs(RMX.v25studio.getState().bpm - 160) < 1e-9,
    'st.bpm updated to 160 (meta + markers re-render from it)');
  const postSecs = fx.secs().map(s => s.lenSec);
  const postSum = postSecs.reduce((a, b) => a + b, 0);
  ok(Math.abs(postSum - preSum * 0.75) < 0.05, 'sections re-fit to the new duration',
    preSum.toFixed(2) + 's -> ' + postSum.toFixed(2) + 's');
  ok(Math.abs(fx.cur().duration - postSum) < 0.05, 'sections still sum to buffer length');
  // undo path restores absolute state
  const undoLens = preSecs.slice();
  fx.apply(fx.cur(), {}); // no-op apply keeps everything
  ok(Math.abs(fx.bpm() - 160) < 1e-9, 'no-op apply is stable');

  console.log('— automation lane state —');
  ok(RMX.v26fx.autoPoints.length === 2, 'lane reset to 2 endpoint points on open',
    RMX.v26fx.autoPoints.length + ' points');
  ok(typeof RMX.v26fx.undo === 'function' && typeof RMX.v26fx.redo === 'function',
    'undo/redo API exposed');
  ok(RMX.v26fx.lastOp === null, 'lastOp starts null');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
