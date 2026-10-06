'use strict';
/* =====================================================================
   Node tests for RuhMix v29 F4 (J3 P1s): every destructive Studio action
   is undoable via the I2 command stack ('state' kind = full buffer+model
   snapshot).
     P1-1  commitLanes ("Apply lane mix") -> one undoable unit
     P1-2  runRegen (all 9 Smart Regenerate ops) -> snapshot before regen;
           applyRebuild no longer clears history
     P1-3  async swapVocalSource joins the same undo unit as the section
           edit (no half-undo: vocal source restores too)
   Browser file loaded with minimal shims (FakeAudioBuffer, RM.audio).
   Drives the REAL functions headlessly via RM.v25studio._t.

   Run:  node tests/test-v29-f4-undo.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const SR = 22050;

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
global.window = {};
global.RM = { audio: { ensureCtx: () => fakeCtx } };
global.window.RM = global.RM;

const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'v25-studio.js'), 'utf8');
eval(src);

const S = global.window.RM.v25studio;
const T = S._t;
if (!S || !T) { console.error('FAIL: v25studio/_t not exposed'); process.exit(1); }
for (const fn of ['commitLanes', 'runRegen', 'swapVocalSource', 'captureStudioState', 'applySectionEdit']) {
  if (typeof T[fn] !== 'function') { console.error('FAIL: _t.' + fn + ' not exposed'); process.exit(1); }
}

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function mkBuf(sec) {
  const b = new FakeAudioBuffer(2, Math.round(sec * SR), SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++)
      d[i] = (((i * 1103515245 + 12345 + c * 7919) & 0x7fffffff) / 0x7fffffff) * 0.8 - 0.4;
  }
  return b;
}
function snapBuf(b) {
  const o = new FakeAudioBuffer(b.numberOfChannels, b.length, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) o.getChannelData(c).set(b.getChannelData(c));
  return o;
}
function bufsEqual(a, b) {
  if (!a || !b || a.length !== b.length || a.numberOfChannels !== b.numberOfChannels) return false;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c), y = b.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
function gainBuf(b, g) {
  const o = snapBuf(b);
  for (let c = 0; c < o.numberOfChannels; c++) {
    const d = o.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return o;
}
// 40s @120bpm builtin: [intro 8s][vocal 8s][vocal 16s][outro 8s], sel=1
function fresh40() {
  S.open({ buffer: mkBuf(40), meta: { bpm: 120 }, engineTags: 'test', songs: [] });
  const st = T.st();
  st.sel = 1;
  return st;
}
function secLens() { return T.st().sections.map((s) => Math.round(s.lenSec * 1000) / 1000); }
// wait until the studio is no longer busy (async ops), with a timeout
function waitIdle(timeoutMs) {
  const t0 = Date.now();
  return new Promise((res) => {
    (function poll() {
      if (!T.st().busy || Date.now() - t0 > (timeoutMs || 8000)) res();
      else setTimeout(poll, 5);
    })();
  });
}

async function main() {
  console.log('== F4 P1-1: commitLanes is one undoable unit ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const nUndo = st.undo.length;
    // fake extracted stems: full-length partition copies
    st.stems = {
      vocals: snapBuf(st.current), instrumental: gainBuf(st.current, 0.5),
      drums: snapBuf(st.current), bass: snapBuf(st.current),
    };
    st.laneUI = {
      vocals: { mute: false, solo: false, gainDb: -6 },
      instrumental: { mute: false, solo: false, gainDb: 0 },
    };
    T.commitLanes();
    ok(st.undo.length === nUndo + 1, 'commitLanes pushes exactly one undo command');
    const c = st.undo[st.undo.length - 1];
    ok(c && c.kind === 'state' && c.label === 'Apply lane mix', 'command is a state snapshot ("Apply lane mix")');
    const mixed = snapBuf(st.current);
    ok(!bufsEqual(st.current, before), 'lane mix audibly changes the buffer');
    ok(JSON.stringify(secLens()) === JSON.stringify([8, 8, 16, 8]), 'lane commit keeps the section model');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: pre-commit buffer restored byte-identically');
    ok(JSON.stringify(secLens()) === JSON.stringify([8, 8, 16, 8]), 'undo: section model intact');
    T.doRedo();
    ok(bufsEqual(st.current, mixed), 'redo: lane mix restored byte-identically');
    // no stems: safe no-op, pushes nothing
    const st2 = fresh40();
    const n2 = st2.undo.length;
    T.commitLanes();
    ok(st2.undo.length === n2, 'commitLanes without stems pushes nothing');
  }

  console.log('== F4 P1-2a: runRegen (buffer path) snapshots before, undo/redo round-trip ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const nUndo = st.undo.length;
    const def = {
      name: 'Test Regen',
      run: (buf) => Promise.resolve({ buf: gainBuf(buf, 0.9) }),
    };
    T.runRegen(def);
    await waitIdle();
    ok(st.undo.length === nUndo + 1, 'runRegen pushes exactly one undo command');
    const c = st.undo[st.undo.length - 1];
    ok(c && c.kind === 'state', 'regen command is a state snapshot');
    const regened = snapBuf(st.current);
    ok(!bufsEqual(st.current, before), 'regen audibly changes the buffer');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: pre-regen buffer restored byte-identically');
    ok(st.undo.length === nUndo && st.redo.length === 1, 'undo moves the command to the redo stack');
    T.doRedo();
    ok(bufsEqual(st.current, regened), 'redo: regen buffer restored byte-identically');
  }

  console.log('== F4 P1-2b: runRegen rebuild path keeps history (applyRebuild no longer clears) ==');
  {
    const st = fresh40();
    // a prior edit, so the undo stack is non-empty before the rebuild
    T.applySectionEditCore(1, 0, 0, 6, 'cut');
    const preRebuild = snapBuf(st.current);
    const preLens = secLens();
    const origRef = st.original;
    const nUndo = st.undo.length;
    ok(nUndo === 1, 'setup: one section-edit command on the stack');
    const newBuf = mkBuf(30);
    const def = {
      name: 'Test Rebuild',
      run: () => Promise.resolve({ rebuild: { buffer: newBuf, meta: { bpm: 100 } } }),
    };
    T.runRegen(def);
    await waitIdle();
    ok(st.undo.length === nUndo + 1, 'rebuild does NOT clear history (stack grew, not reset)');
    ok(Math.abs(st.bpm - 100) < 1e-9, 'rebuild applied: bpm is now 100');
    ok(Math.abs(st.current.duration - 30) < 1e-9, 'rebuild applied: 30s buffer');
    // undo the rebuild -> pre-rebuild mix back, byte-identical, model restored
    T.doUndo();
    ok(bufsEqual(st.current, preRebuild), 'undo rebuild: pre-rebuild buffer byte-identical');
    ok(JSON.stringify(secLens()) === JSON.stringify(preLens), 'undo rebuild: section lens restored');
    ok(Math.abs(st.bpm - 120) < 1e-9, 'undo rebuild: bpm restored to 120');
    ok(st.original === origRef, 'undo rebuild: original buffer reference restored');
    ok(bufsEqual(st.original, snapBuf(origRef)), 'undo rebuild: original audio intact');
    // redo the rebuild
    T.doRedo();
    ok(Math.abs(st.current.duration - 30) < 1e-9 && Math.abs(st.bpm - 100) < 1e-9,
      'redo rebuild: rebuilt mix back');
    // the older section-edit command still undoes beneath the rebuild
    T.doUndo(); // undo rebuild
    T.doUndo(); // undo the section edit
    ok(st.undo.length === 0 && st.redo.length === 2, 'older commands survive the rebuild round-trip');
  }

  console.log('== F4 P1-3: async vocal swap is one undoable unit (no half-undo) ==');
  {
    const st = fresh40();
    // two distinct vocal sources, like a real 2-song mashup
    st.sections[1].vocalSong = 0;
    st.sections[2].vocalSong = 1;
    st.sel = 1;
    // stub the Smart DSP stem engine: deterministic partition of the input
    global.RM.stems = {
      run: (kind, buf) => Promise.resolve([
        { name: 'vocal-center', buffer: snapBuf(buf) },
        { name: 'side-instrumental', buffer: gainBuf(buf, 0.25) },
      ]),
    };
    const before = T.captureStudioState();
    const beforeBuf = snapBuf(st.current);
    const nUndo = st.undo.length;
    ok(T.swapVocalSource(1, 1, before) === true, 'swapVocalSource starts the async swap');
    await waitIdle();
    delete global.RM.stems;
    ok(st.undo.length === nUndo + 1, 'swap pushes exactly one undo command');
    const c = st.undo[st.undo.length - 1];
    ok(c && c.kind === 'state' && c.label === 'Section edit + vocal swap',
      'command covers the whole Apply unit');
    ok(st.sections[1].vocalSong === 1, 'vocal source swapped to song 2');
    ok(!bufsEqual(st.current, beforeBuf), 'swap audibly changes the buffer');
    const swapped = snapBuf(st.current);
    // THE half-undo regression: undo must restore the vocal source too
    T.doUndo();
    ok(bufsEqual(st.current, beforeBuf), 'undo: pre-swap buffer restored byte-identically');
    ok(st.sections[1].vocalSong === 0, 'undo: vocal source restored (no half-undo)');
    ok(st.sections[1].name === before.sections[1].name, 'undo: section name restored');
    T.doRedo();
    ok(bufsEqual(st.current, swapped), 'redo: swapped buffer restored byte-identically');
    ok(st.sections[1].vocalSong === 1, 'redo: vocal source re-swapped');
  }

  console.log('== F4 P1-3b: swap that never starts keeps the section edit undoable ==');
  {
    const st = fresh40();
    st.sections[1].vocalSong = 0;
    st.sel = 1;
    const before = T.captureStudioState();
    const nUndo = st.undo.length;
    // no section sings song 99 -> early exit, returns false
    ok(T.swapVocalSource(1, 99, before) === false, 'swap with no target returns false');
    ok(st.undo.length === nUndo, 'a swap that never starts pushes nothing by itself');
    // the caller (applySectionEdit) then makes the section edit undoable alone
    T.pushStateCommand('Section edit', before, T.captureStudioState());
    ok(st.undo.length === nUndo + 1 && st.undo[st.undo.length - 1].kind === 'state',
      'section edit alone is still one undoable unit');
    T.doUndo();
    ok(st.undo.length === nUndo, 'undo works');
  }

  console.log('== F4: applySectionEdit without DOM keeps the classic patch path ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const nUndo = st.undo.length;
    T.applySectionEdit(); // no DOM: fade/vol 0, no vocal select -> plain section edit
    ok(st.undo.length === nUndo + 1, 'applySectionEdit pushes one command');
    ok(st.undo[st.undo.length - 1].kind === 'patch', 'no-swap Apply stays a patch command');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: buffer byte-identical');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
