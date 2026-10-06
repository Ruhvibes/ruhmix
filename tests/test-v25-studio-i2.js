'use strict';
/* =====================================================================
   Node tests for v25-studio I2: drag reorder, undo/redo command stack,
   copy/paste, beat/bar snap.
   Browser file loaded with minimal shims (FakeAudioBuffer, RM.audio).
   No browser needed. Drives the REAL edit/undo functions headlessly via
   RM.v25studio._t.

   Run:  node tests/test-v25-studio-i2.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const SR = 22050; // test sample rate — impl must be rate-agnostic

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

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
// Deterministic position-dependent content: any permutation is detectable.
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
function sliceSamples(b, aSamp, bSamp) {
  const o = new FakeAudioBuffer(b.numberOfChannels, bSamp - aSamp, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++)
    o.getChannelData(c).set(b.getChannelData(c).subarray(aSamp, bSamp));
  return o;
}
function concatParts(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const o = new FakeAudioBuffer(2, total, SR);
  let pos = 0;
  for (const p of parts) {
    for (let c = 0; c < 2; c++) o.getChannelData(c).set(p.getChannelData(c), pos);
    pos += p.length;
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
function secIds() { return T.st().sections.map((s) => s.id); }

async function main() {
  console.log('== I2: drag reorder permutes model + buffer ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const idsB = secIds();
    // move intro (idx 0) to the end: insertion index 3 in the array without it
    ok(T.dragCommit(0, 3) === true, 'dragCommit(0,3) reports a real move');
    const idsA = secIds();
    ok(idsA.join() === [idsB[1], idsB[2], idsB[3], idsB[0]].join(), 'section order permuted in the model');
    ok(JSON.stringify(secLens()) === JSON.stringify([8, 16, 8, 8]), 'section lens follow the move');
    const S8 = 8 * SR, S16 = 16 * SR, S40 = 40 * SR;
    const expect = concatParts([
      sliceSamples(before, S8, S8 + S8),          // vocal 8s
      sliceSamples(before, S8 + S8, S8 + S8 + S16), // vocal 16s
      sliceSamples(before, S8 + S8 + S16, S40),   // outro 8s
      sliceSamples(before, 0, S8),                // intro 8s
    ]);
    ok(bufsEqual(st.current, expect), 'buffer rebuilt as the exact section permutation (byte-compare)');
    ok(st.undo.length === 1 && st.undo[0].kind === 'perm', 'one perm command pushed');
    // undo restores model + buffer exactly
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo restores the exact pre-drag buffer');
    ok(secIds().join() === idsB.join(), 'undo restores the section order');
    T.doRedo();
    ok(bufsEqual(st.current, expect), 'redo restores the post-drag buffer');
    // export receives the edited buffer
    let captured = null;
    global.RM.mashupExport = { sendToExport: (buf) => { captured = buf; } };
    T.doExport();
    ok(captured === st.current, 'doExport hands st.current (the edited buffer) to export');
    delete global.RM.mashupExport;
    // no-op drag pushes nothing
    const n0 = st.undo.length;
    ok(T.dragCommit(0, 0) === false, 'drag to the same slot is a no-op');
    ok(st.undo.length === n0, 'no-op drag pushes no undo command');
  }

  console.log('== I2: split -> undo -> redo restores the exact buffer ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const idsB = secIds();
    ok(T.splitSectionAt(1, 3.0) === true, 'splitSectionAt(1, 3.0)');
    ok(st.sections.length === 5, 'split adds one section');
    ok(bufsEqual(st.current, before), 'split does not touch the audio');
    ok(Math.abs(st.sections[1].lenSec - 3.0) < 1e-9 && Math.abs(st.sections[2].lenSec - 5.0) < 1e-9,
      'split lens 3.0s / 5.0s');
    T.doUndo();
    ok(st.sections.length === 4 && secIds().join() === idsB.join(), 'undo restores sections');
    ok(bufsEqual(st.current, before), 'undo: buffer byte-identical');
    T.doRedo();
    ok(st.sections.length === 5, 'redo re-splits');
    ok(bufsEqual(st.current, before), 'redo: buffer byte-identical');
  }

  console.log('== I2: delete -> undo -> redo ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const S8 = 8 * SR, S40 = 40 * SR;
    ok(T.deleteSection() === true, 'deleteSection (sel=1, the 8s vocal)');
    ok(Math.abs(st.current.duration - 32) < 1e-9, 'buffer shrinks 40s -> 32s');
    const expect = concatParts([sliceSamples(before, 0, S8), sliceSamples(before, 2 * S8, S40)]);
    ok(bufsEqual(st.current, expect), 'deleted region excised exactly');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: deleted audio spliced back byte-identically');
    ok(st.sections.length === 4, 'undo: section restored');
    T.doRedo();
    ok(bufsEqual(st.current, expect), 'redo: deletion re-applied');
  }

  console.log('== I2: duplicate -> undo ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    st.sel = 2;
    ok(T.duplicateSection() === true, 'duplicateSection (sel=2, the 16s vocal)');
    ok(Math.abs(st.current.duration - 56) < 1e-9, 'buffer grows 40s -> 56s');
    ok(st.sections.length === 5, 'section inserted after the original');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: duplicate removed, buffer byte-identical');
    ok(st.sections.length === 4, 'undo: section removed');
  }

  console.log('== I2: trim -> undo ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    ok(T.trimSection('end', 0.5) === true, 'trimSection(end, 0.5s)');
    ok(Math.abs(st.current.duration - 39.5) < 1e-9, 'buffer 39.5s');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: trimmed audio restored byte-identically');
    ok(Math.abs(st.sections[1].lenSec - 8) < 1e-9, 'undo: section length restored');
  }

  console.log('== I2: fade/volume apply -> undo -> redo (byte-exact) ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    ok(T.applySectionEditCore(1, 0.5, 0.5, 6, 'cut') === true, 'applySectionEditCore(fade 0.5s, +6dB, cut)');
    const edited = snapBuf(st.current);
    ok(!bufsEqual(st.current, before), 'edit audibly changes the buffer');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: pre-edit region spliced back byte-identically');
    T.doRedo();
    ok(bufsEqual(st.current, edited), 'redo: edited buffer restored byte-identically');
  }

  console.log('== I2: xfade junction change -> undo (buffer shrinks, then restores) ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const lensB = secLens();
    ok(T.applySectionEditCore(1, 0, 0, 0, 'xfade') === true, 'applySectionEditCore(xfade)');
    ok(Math.abs(st.current.duration - 39) < 1e-9, 'xfade shrinks buffer by 0.5 bar (1s)');
    ok(st.bounds[1] === 'xfade', 'junction type recorded');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: pre-xfade audio restored byte-identically');
    ok(JSON.stringify(secLens()) === JSON.stringify(lensB), 'undo: section lens restored');
    ok(st.bounds[1] === 'cut', 'undo: junction type restored');
  }

  console.log('== I2: copy/paste ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const S8 = 8 * SR;
    ok(T.copySection() === true, 'copySection (sel=1)');
    ok(!!st.clip && Math.abs(st.clip.buf.duration - 8) < 1e-9, 'clipboard holds the 8s section audio');
    ok(T.pasteSection() === true, 'pasteSection inserts after the selection');
    ok(st.sections.length === 5, 'section count 4 -> 5');
    ok(Math.abs(st.current.duration - 48) < 1e-9, 'buffer 48s');
    const pasted = sliceSamples(st.current, 2 * S8, 3 * S8); // inserted right after sel
    ok(bufsEqual(pasted, sliceSamples(before, S8, 2 * S8)), 'pasted audio == copied section audio');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: paste removed, buffer byte-identical');
    ok(st.sections.length === 4, 'undo: section count restored');
    // empty clipboard: no crash, no change
    st.clip = null;
    const nUndo = st.undo.length;
    ok(T.pasteSection() === false, 'paste with empty clipboard is a safe no-op');
    ok(bufsEqual(st.current, before) && st.undo.length === nUndo, 'no-op paste changes nothing');
  }

  console.log('== I2: beat/bar snap ==');
  {
    ok(T.snapToBar(3.3) === 4.0, 'snapToBar(3.3) -> 4.0 (bar=2s @120bpm)');
    ok(T.snapToBar(2.9) === 2.0, 'snapToBar(2.9) -> 2.0');
    ok(T.snapToBar(0.2) === 0.0, 'snapToBar clamps to buffer start');
    ok(T.snapInsertIndex([7.7, 0.7], 2) === 1, 'snapInsertIndex snaps drop slot to the nearer bar boundary');
    ok(T.snapInsertIndex([8, 8, 8], 1) === 1, 'snapInsertIndex leaves bar-aligned slots alone');
    // split with snap ON quantizes the playhead split to the bar grid
    const st = fresh40();
    st.snap = true;
    T.tp().offset = 8 + 3.3; // inside section 1, off-grid
    ok(T.splitSection() === true, 'splitSection with snap on');
    ok(Math.abs(st.sections[1].lenSec - 4.0) < 1e-9, 'split landed on the bar line (4.0s), not 3.3s');
    // snap OFF: free positioning
    const st2 = fresh40();
    st2.snap = false;
    T.tp().offset = 8 + 3.3;
    ok(T.splitSection() === true, 'splitSection with snap off');
    ok(Math.abs(st2.sections[1].lenSec - 3.3) < 1e-6, 'split keeps the exact playhead position (3.3s)');
    // toggle flips state
    const was = st2.snap;
    T.toggleSnap();
    ok(st2.snap === !was, 'toggleSnap flips the snap state');
  }

  console.log('== I2: undo stack cap + redo clearing ==');
  {
    fresh40();
    for (let k = 0; k < 55; k++) { const c = T.cmdBegin('x', 'meta'); T.cmdEnd(c); }
    ok(T.st().undo.length === 50, 'undo stack capped at 50');
    fresh40();
    const st = T.st();
    T.splitSectionAt(1, 2);
    T.doUndo();
    ok(st.redo.length === 1, 'undo populates the redo stack');
    T.splitSectionAt(1, 2);
    ok(st.redo.length === 0, 'a new edit clears the redo stack');
  }

  console.log('== I2: nudge -> undo ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    const idsB = secIds();
    st.sel = 2; // the 16s vocal
    ok(T.nudgeSection(-3) === true, 'nudgeSection(-3)');
    const idsA = secIds();
    ok(idsA.join() !== idsB.join(), 'nudge reorders the model');
    const S8 = 8 * SR, S16 = 16 * SR, S40 = 40 * SR;
    const expect = concatParts([
      sliceSamples(before, 0, S8),
      sliceSamples(before, 2 * S8, 2 * S8 + S16),
      sliceSamples(before, S8, 2 * S8),
      sliceSamples(before, 2 * S8 + S16, S40),
    ]);
    ok(bufsEqual(st.current, expect), 'nudge rebuilds the buffer in the new order (byte-compare)');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'undo: nudge reversed byte-identically');
    ok(secIds().join() === idsB.join(), 'undo: order restored');
  }

  console.log('== I2: mixed sequence perm -> patch -> undo x2 -> redo x2 ==');
  {
    const st = fresh40();
    const before = snapBuf(st.current);
    T.dragCommit(0, 3); // perm: intro to the end
    const afterDrag = snapBuf(st.current);
    st.sel = 0; // the 8s vocal now leads
    T.deleteSection(); // patch on the permuted layout
    const afterDel = snapBuf(st.current);
    ok(Math.abs(st.current.duration - 32) < 1e-9, 'mixed: 40s -> 32s after drag+delete');
    T.doUndo();
    ok(bufsEqual(st.current, afterDrag), 'mixed: undo delete -> post-drag buffer byte-identical');
    T.doUndo();
    ok(bufsEqual(st.current, before), 'mixed: undo drag -> original buffer byte-identical');
    T.doRedo();
    ok(bufsEqual(st.current, afterDrag), 'mixed: redo drag -> post-drag buffer byte-identical');
    T.doRedo();
    ok(bufsEqual(st.current, afterDel), 'mixed: redo delete -> post-delete buffer byte-identical');
    ok(st.undo.length === 2 && st.redo.length === 0, 'mixed: stack depths consistent');
  }

  console.log('== I2: toolbar buttons exist in the Studio HTML (no placeholders) ==');
  {
    for (const id of ['stu-undo', 'stu-redo', 'stu-copy', 'stu-paste', 'stu-snap'])
      ok(S.STUDIO_HTML.indexOf('id="' + id + '"') !== -1, 'STUDIO_HTML contains #' + id);
    ok(typeof T.doUndo === 'function' && typeof T.doRedo === 'function', 'undo/redo wired');
    ok(typeof T.copySection === 'function' && typeof T.pasteSection === 'function', 'copy/paste wired');
    ok(typeof T.dragCommit === 'function', 'dragCommit wired');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
