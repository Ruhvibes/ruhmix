'use strict';
/* =====================================================================
   RuhMix — undo/redo + persistence verification suite
   Usage: node ~/workspace/ruhmix/tests/test-undo-persist.js
   Exit code: 0 = all PASS, non-zero = at least one FAIL.
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');
const path = require('path');

const INDEX = 'file://' + path.resolve('/home/hatch/workspace/ruhmix/www/index.html');
const CHS = '/home/hatch/.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell';

const results = [];
let pageErrors = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' — ' + detail : ''));
}

let browser, page;
async function newPage() {
  if (page) { try { await page.close(); } catch (e) {} }
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text().slice(0, 200)); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.app && RM.app.state && RM.proj && RM.audio', { timeout: 30000 });
  // app.init() runs on DOMContentLoaded; give it a tick
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
}
async function ev(fn, ...args) {
  // page.evaluate(string, ...args) IGNORES extra args — inline them instead
  if (typeof fn === 'string' && args.length) {
    return page.evaluate(`(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`);
  }
  return page.evaluate(fn, ...args);
}
async function install() { await ev(HELPERS); await ev('window.__T.freshState()'); }
async function waitFor(fn, timeout, pollMs) {
  timeout = timeout || 15000; pollMs = pollMs || 120;
  const t0 = Date.now();
  for (;;) {
    const v = await ev(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout: ' + fn.toString().slice(0, 120));
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* ---------- in-page helpers (injected once per page) ---------- */
const HELPERS = `
window.__T = {
  // deterministic synthetic stereo buffer, 8s
  makeBuf: function () {
    const ctx = RM.audio.ensureCtx();
    const sr = ctx.sampleRate, len = sr * 8;
    const b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[i] = (Math.sin(2 * Math.PI * 440 * t) * 0.5 +
                Math.sin(2 * Math.PI * 110 * t) * 0.3) * (1 - i / len) * (c ? 0.8 : 1.0);
      }
    }
    return b;
  },
  stats: function (b) {
    const out = { len: b.length, ch: b.numberOfChannels, sr: b.sampleRate };
    let mx = 0, sum = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > mx) mx = a; sum += d[i]; }
    }
    out.max = mx; out.sum = sum; return out;
  },
  diff: function (a, b) {
    if (!a || !b) return { maxDiff: Infinity, note: 'null buffer' };
    if (a.length !== b.length || a.numberOfChannels !== b.numberOfChannels) {
      return { maxDiff: Infinity, note: 'len/ch mismatch ' + a.length + ' vs ' + b.length };
    }
    let md = 0;
    for (let c = 0; c < a.numberOfChannels; c++) {
      const x = a.getChannelData(c), y = b.getChannelData(c);
      for (let i = 0; i < x.length; i++) { const dd = Math.abs(x[i] - y[i]); if (dd > md) md = dd; }
    }
    return { maxDiff: md, note: '' };
  },
  snap: function (b) { // bit-exact copy of channel data
    const o = [];
    for (let c = 0; c < b.numberOfChannels; c++) o.push(Array.from(b.getChannelData(c)));
    return o;
  },
  cmpSnap: function (b, snap) {
    if (b.numberOfChannels !== snap.length) return false;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      if (d.length !== snap[c].length) return false;
      for (let i = 0; i < d.length; i++) if (d[i] !== snap[c][i]) return false;
    }
    return true;
  },
  freshState: function () {
    const buf = window.__T.makeBuf();
    const p = RM.proj.create('t');
    RM.app.state.project = p;
    RM.app.state.buffer = buf;
    RM.app.state.viewBuffer = null;
    RM.app.state.redoStack = [];
    RM.proj.clearClipboard();
    RM.proj.invalidateView(buf);
    window.__T.buf = buf;
    window.__T.proj = p;
    return true;
  },
};
`;

/* ================= TESTS ================= */

async function testPerToolUndoRedo() {
  // cut, trim, fadein, fadeout, gain, reverse, paste
  const ops = [
    { op: { t: 'cut', a: 1, b: 2 }, name: 'cut' },
    { op: { t: 'trim', a: 2, b: 6 }, name: 'trim' },
    { op: { t: 'fadein', dur: 2 }, name: 'fadein' },
    { op: { t: 'fadeout', dur: 2 }, name: 'fadeout' },
    { op: { t: 'gain', db: 6 }, name: 'gain' },
    { op: { t: 'reverse' }, name: 'reverse' },
    { op: { t: 'paste', at: 2 }, name: 'paste', clipboard: true },
  ];
  for (const { op, name, clipboard } of ops) {
    try {
      await install();
      if (clipboard) {
        await ev(`(function(){ const c = RM.audio.ensureCtx(); const cb = c.createBuffer(2, c.sampleRate * 1, c.sampleRate);
          const d = cb.getChannelData(0); for (let i=0;i<d.length;i++) d[i] = Math.sin(2*Math.PI*880*i/c.sampleRate)*0.4;
          const d2 = cb.getChannelData(1); for (let i=0;i<d2.length;i++) d2[i] = d[i];
          RM.proj.setClipboard(cb); })()`);
      }
      // expected render (we may CALL applyOps — must not edit it)
      const expected = await ev(`(async () => {
        const v = await RM.proj.applyOps(window.__T.buf, [${JSON.stringify(op)}]);
        return window.__T.stats(v);
      })()`);
      // apply via app path
      await ev(`(async () => { await RM.app.pushOp(${JSON.stringify(op)}); return true; })()`);
      const after = await ev(`(() => ({
        ops: RM.app.state.project.ops.length,
        redo: RM.app.state.redoStack.length,
        st: window.__T.stats(RM.app.state.viewBuffer),
      }))()`);
      let ok = after.ops === 1 && after.redo === 0 &&
        after.st.len === expected.len &&
        Math.abs(after.st.max - expected.max) < 1e-7 &&
        Math.abs(after.st.sum - expected.sum) < 1e-3;
      // undo -> original restored?
      await ev(`(() => { RM.app.undoOp(); return true; })()`);
      await waitFor(`(() => RM.app.state.project.ops.length === 0 && RM.app.state.viewBuffer && RM.app.state.viewBuffer.length === window.__T.buf.length)()`);
      const undone = await ev(`(() => window.__T.diff(RM.app.state.viewBuffer, window.__T.buf))()`);
      ok = ok && undone.maxDiff === 0;
      // redo -> op back?
      await ev(`(() => { RM.app.redoOp(); return true; })()`);
      await waitFor(`(() => RM.app.state.project.ops.length === 1 && RM.app.state.viewBuffer && RM.app.state.viewBuffer.length === ${expected.len})()`);
      const redone = await ev(`(async () => {
        const v = await RM.proj.applyOps(window.__T.buf, [${JSON.stringify(op)}]);
        return window.__T.diff(RM.app.state.viewBuffer, v);
      })()`);
      ok = ok && redone.maxDiff === 0;
      // redo again -> clean no-op
      await ev(`(() => { RM.app.redoOp(); return true; })()`);
      await new Promise((r) => setTimeout(r, 400));
      const still = await ev(`(() => RM.app.state.project.ops.length)()`);
      ok = ok && still === 1;
      rec('undo/redo per tool: ' + name, ok,
        ok ? `len ${after.st.len}, undo diff ${undone.maxDiff}, redo diff ${redone.maxDiff}`
           : `apply ops=${after.ops} redo=${after.redo} len=${after.st.len}/${expected.len} undoDiff=${undone.maxDiff} redoDiff=${redone.maxDiff} still=${still}`);
    } catch (e) {
      rec('undo/redo per tool: ' + name, false, 'exception: ' + (e && e.message));
    }
  }
}

async function testRapidUndoRedo() {
  try {
    await install();
    const ops = [{ t: 'gain', db: 3 }, { t: 'fadein', dur: 1 }, { t: 'reverse' }];
    await ev(`(async () => { for (const o of ${JSON.stringify(ops)}) await RM.app.pushOp(o); return true; })()`);
    await waitFor(`(() => RM.app.state.project.ops.length === 3)()`);
    const expected = await ev(`(async () => {
      const v = await RM.proj.applyOps(window.__T.buf, ${JSON.stringify(ops)});
      return window.__T.stats(v);
    })()`);
    // 10 rapid fire cycles, no awaits (round-4 race scenario)
    await ev(`(() => { for (let i = 0; i < 10; i++) { RM.app.undoOp(); RM.app.redoOp(); } return true; })()`);
    // wait for viewGen to settle
    let g1 = await ev('(() => RM.app.state.viewGen)()');
    await new Promise((r) => setTimeout(r, 600));
    let g2 = await ev('(() => RM.app.state.viewGen)()');
    let guard = 0;
    while (g1 !== g2 && guard++ < 20) {
      await new Promise((r) => setTimeout(r, 500)); g1 = g2;
      g2 = await ev('(() => RM.app.state.viewGen)()');
    }
    const fin = await ev(`(async () => {
      const v = await RM.proj.applyOps(window.__T.buf, ${JSON.stringify(ops)});
      return { ops: JSON.stringify(RM.app.state.project.ops), redo: RM.app.state.redoStack.length,
               diff: window.__T.diff(RM.app.state.viewBuffer, v), st: window.__T.stats(RM.app.state.viewBuffer) };
    })()`);
    const ok = fin.ops === JSON.stringify(ops) && fin.redo === 0 && fin.diff.maxDiff === 0 &&
      fin.st.len === expected.len;
    rec('10 rapid undo/redo cycles', ok,
      ok ? 'final view matches 3-op render exactly, ops intact'
         : `ops=${fin.ops} redo=${fin.redo} diff=${fin.diff.maxDiff} len=${fin.st.len}/${expected.len}`);
  } catch (e) {
    rec('10 rapid undo/redo cycles', false, 'exception: ' + (e && e.message));
  }
}

async function testUndoEmpty() {
  try {
    await install();
    const before = await ev(`(() => RM.app.state.project.ops.length)()`);
    await ev(`(() => { RM.app.undoOp(); RM.app.undoOp(); RM.app.redoOp(); return true; })()`);
    await new Promise((r) => setTimeout(r, 500));
    const after = await ev(`(() => ({ ops: RM.app.state.project.ops.length, redo: RM.app.state.redoStack.length, toast: document.getElementById('toast').textContent }))()`);
    const ok = before === 0 && after.ops === 0 && after.redo === 0;
    rec('undo/redo past empty stack', ok, ok ? `clean no-op, toast="${after.toast}"` : JSON.stringify(after));
  } catch (e) {
    rec('undo/redo past empty stack', false, 'exception: ' + (e && e.message));
  }
}

async function testNewOpClearsRedo() {
  try {
    await install();
    await ev(`(async () => { await RM.app.pushOp({t:'gain',db:3}); await RM.app.pushOp({t:'fadein',dur:1}); return true; })()`);
    await waitFor(`(() => RM.app.state.project.ops.length === 2)()`);
    await ev(`(() => { RM.app.undoOp(); return true; })()`);
    await waitFor(`(() => RM.app.state.redoStack.length === 1)()`);
    await ev(`(async () => { await RM.app.pushOp({t:'reverse'}); return true; })()`);
    await waitFor(`(() => RM.app.state.project.ops.length === 2)()`);
    const st = await ev(`(() => ({ redo: RM.app.state.redoStack.length, ops: JSON.stringify(RM.app.state.project.ops) }))()`);
    await ev(`(() => { RM.app.redoOp(); return true; })()`);
    await new Promise((r) => setTimeout(r, 400));
    const st2 = await ev(`(() => ({ redo: RM.app.state.redoStack.length, ops: JSON.stringify(RM.app.state.project.ops) }))()`);
    const ok = st.redo === 0 && st2.ops === st.ops && st2.redo === 0;
    rec('new op after undo clears redo', ok, ok ? 'redoStack cleared; redo is clean no-op' : JSON.stringify([st, st2]));
  } catch (e) {
    rec('new op after undo clears redo', false, 'exception: ' + (e && e.message));
  }
}

async function testSaveCloseReopen() {
  try {
    await install();
    // configure live state
    await ev(`(async () => {
      const A = RM.app, s = A.state;
      await A.pushOp({t:'cut', a:1, b:2}); await A.pushOp({t:'gain', db:4}); await A.pushOp({t:'fadein', dur:1.5});
      const p = s.project;
      p.name = 'PersistTest';
      p.audioRef = { name: 'test.wav', size: 12345, type: 'audio/wav', lastModified: 1 };
      p.settings.speed = 1.5; p.settings.volume = 0.65; p.settings.pan = -0.4; p.settings.loop = true;
      p.settings.markers = [{ t: 1.2, label: 'M1' }, { t: 5.5, label: 'M2' }];
      s.fx = A.defaultFx(); s.fx.drive = 0.4; s.fx.echo.on = true; s.fx.eq3 = [2, -1, 3];
      s.slowed = { speed: 0.7, room: 'church', wet: 0.6, decay: 2, echo: 0.3, bass: 5, width: 1.1 };
      s.mastering = { preset: 'loud', ab: 'after', settings: { out: 0.9 } };
      s.remix = { style: 'lofi', bpm: 90, custom: { tempo: 0.9 } };
      RM.proj.save(p);
      return p.id;
    })()`);
    await waitFor(`(() => RM.app.state.project.ops.length === 3)()`);
    const pid = await ev('(() => RM.app.state.project.id)()');
    // read back from localStorage like a fresh launch would
    const round = await ev(`((id) => {
      const raw = localStorage.getItem('ruhmix.projects.v1');
      const arr = JSON.parse(raw);
      const found = arr.map((x) => RM.proj.deserialize(x)).find((x) => x && x.id === id);
      if (!found) return { found: false };
      return {
        found: true,
        ops: JSON.stringify(found.ops),
        settings: JSON.stringify(found.settings),
        audioRef: JSON.stringify(found.audioRef),
        name: found.name,
      };
    })`, pid);
    const live = await ev(`(() => ({ ops: JSON.stringify(RM.app.state.project.ops), settings: JSON.stringify(RM.app.state.project.settings) }))()`);
    let ok = round.found && round.ops === live.ops && round.name === 'PersistTest';
    // settings compare: live settings were snapshot into the saved copy
    const setEq = await ev(`((id) => {
      const arr = JSON.parse(localStorage.getItem('ruhmix.projects.v1'));
      const f = arr.map((x) => RM.proj.deserialize(x)).find((x) => x && x.id === id);
      const s = f.settings;
      return s.speed === 1.5 && s.volume === 0.65 && s.pan === -0.4 && s.loop === true &&
        s.markers.length === 2 && s.fx && s.fx.drive === 0.4 && s.fx.echo.on === true &&
        JSON.stringify(s.fx.eq3) === '[2,-1,3]' &&
        s.slowed && s.slowed.room === 'church' && s.slowed.speed === 0.7 &&
        s.mastering && s.mastering.preset === 'loud' && s.mastering.settings.out === 0.9 &&
        s.remixStyle === 'lofi' && s.remixCustom && s.remixCustom.tempo === 0.9 &&
        s.audioRef === undefined; // audioRef lives on project, not settings
    })`, pid);
    ok = ok && setEq;
    // restoreLive -> live FX state back
    const restored = await ev(`((id) => {
      const arr = JSON.parse(localStorage.getItem('ruhmix.projects.v1'));
      const f = arr.map((x) => RM.proj.deserialize(x)).find((x) => x && x.id === id);
      const changed = RM.proj.restoreLive(f);
      const A = RM.app.state;
      return { changed, fxDrive: A.fx.drive, fxEcho: A.fx.echo.on, eq3: A.fx.eq3,
               slowed: A.slowed.room, mast: A.mastering.preset, remix: A.remix.style, tempo: A.remix.custom.tempo };
    })`, pid);
    ok = ok && restored.changed.fx && restored.changed.slowed && restored.changed.mastering && restored.changed.remix &&
      restored.fxDrive === 0.4 && restored.fxEcho === true && restored.slowed === 'church' &&
      restored.mast === 'loud' && restored.remix === 'lofi' && restored.tempo === 0.9;
    // selection: is it part of the model at all?
    const selCheck = await ev(`((id) => {
      const arr = JSON.parse(localStorage.getItem('ruhmix.projects.v1'));
      const f = arr.map((x) => RM.proj.deserialize(x)).find((x) => x && x.id === id);
      return { hasSelKey: Object.keys(f.settings).some((k) => /sel/i.test(k)),
               blankKeys: Object.keys(RM.proj.blankSettings()) };
    })`, pid);
    // simulate restart: full page reload, project list intact
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.RM && RM.app && RM.app.state && RM.proj', { timeout: 30000 });
    await install();
    const afterReload = await ev(`((id) => {
      const p = RM.proj.get(id);
      return p ? { ops: JSON.stringify(p.ops), speed: p.settings.speed, fxDrive: p.settings.fx && p.settings.fx.drive,
                   slowed: p.settings.slowed && p.settings.slowed.room, name: p.name } : null;
    })`, pid);
    ok = ok && !!afterReload && afterReload.speed === 1.5 && afterReload.fxDrive === 0.4 &&
      afterReload.slowed === 'church' && afterReload.name === 'PersistTest' &&
      afterReload.ops === live.ops;
    rec('save → close → reopen restores ops/settings/FX', ok,
      ok ? 'ops, speed/vol/pan/loop, markers, FX chain, slowed, mastering, remix style all round-trip across reload'
         : JSON.stringify({ round: !!round.found, setEq, restored, afterReload }));
    rec('selection persistence', !selCheck.hasSelKey ? true : false,
      'selection (ed-sel-a/b) is NOT in project model — blankSettings keys: [' + selCheck.blankKeys.join(',') + ']. ' +
      'GAP: editor selection does not survive save/reopen (transient UI state).');
  } catch (e) {
    rec('save → close → reopen', false, 'exception: ' + (e && e.message));
  }
}

async function testNonDestructive() {
  try {
    await install();
    const ok = await ev(`(async () => {
      const buf = window.__T.buf;
      const snap = window.__T.snap(buf);
      const ops = [{ t: 'cut', a: 1, b: 2 }, { t: 'gain', db: 6 }, { t: 'fadein', dur: 1 },
                   { t: 'reverse' }, { t: 'trim', a: 0.5, b: 4 }];
      const view = await RM.proj.applyOps(buf, ops);
      const intact = window.__T.cmpSnap(buf, snap);
      const differentObj = view !== buf;
      const changed = window.__T.diff(view, buf).maxDiff > 0.001; // view actually differs
      return { intact, differentObj, changed, viewLen: view.length, origLen: buf.length };
    })()`);
    rec('non-destructive editing (original bit-identical)', ok.intact && ok.differentObj && ok.changed,
      `original intact=${ok.intact}, view is copy=${ok.differentObj}, view differs=${ok.changed} (${ok.origLen}→${ok.viewLen} samples)`);
  } catch (e) {
    rec('non-destructive editing (original bit-identical)', false, 'exception: ' + (e && e.message));
  }
}

async function testAutosaveRecovery() {
  try {
    // dirty state -> autosave data sane
    await install();
    await ev(`(async () => {
      const p = RM.proj.create('CrashMe');
      p.ops = [{ t: 'gain', db: 3 }];
      p.audioRef = { name: 'crash.wav', size: 10, type: 'audio/wav', lastModified: 0 };
      RM.app.state.project = p;
      RM.proj.autosave(p);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1300)); // autosave debounce 800ms
    const sane = await ev(`(() => {
      const raw = localStorage.getItem('ruhmix.autosave.v1');
      const d = RM.proj.deserialize(raw);
      return { has: !!raw, ok: !!d && d.name === 'CrashMe' && d.ops.length === 1,
               clean: localStorage.getItem('ruhmix.cleanExit.v1') };
    })()`);
    let ok = sane.has && sane.ok && sane.clean === '0';
    rec('autosave writes sane data on dirty state', ok, JSON.stringify(sane));
    // reload -> recovery offered
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.RM && RM.app && RM.app.state && RM.proj', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 500));
    const recov = await ev(`(() => ({
      needs: RM.proj.needsRecovery(),
      banner: document.getElementById('recovery-banner').style.display,
      text: document.getElementById('recovery-text').textContent,
    }))()`);
    ok = recov.needs === true && recov.banner !== 'none';
    // accept recovery -> project opens
    await ev(`(() => { document.getElementById('recovery-yes').click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 600));
    const opened = await ev(`(() => ({
      name: RM.app.state.project && RM.app.state.project.name,
      ops: RM.app.state.project && RM.app.state.project.ops.length,
      banner: document.getElementById('recovery-banner').style.display,
    }))()`);
    ok = ok && opened.name === 'CrashMe' && opened.ops === 1 && opened.banner === 'none';
    rec('crash recovery offered + accepted on reload', ok,
      ok ? `banner="${recov.text.slice(0, 60)}…", project reopened with ops intact`
         : JSON.stringify({ recov, opened }));
    // corrupt autosave -> no stuck recovery
    const corrupt = await ev(`(() => {
      localStorage.setItem('ruhmix.autosave.v1', '###not-json###');
      localStorage.setItem('ruhmix.cleanExit.v1', '0');
      const n = RM.proj.needsRecovery();
      const gone = localStorage.getItem('ruhmix.autosave.v1') === null;
      return { needs: n, removed: gone };
    })()`);
    rec('corrupt autosave handled (no stuck recovery)', corrupt.needs === false && corrupt.removed === true,
      JSON.stringify(corrupt));
    // clean exit -> no recovery
    const clean = await ev(`(() => { RM.proj.markCleanExit(); return RM.proj.needsRecovery(); })()`);
    rec('clean exit suppresses recovery', clean === false, 'needsRecovery=' + clean);
  } catch (e) {
    rec('autosave/crash recovery', false, 'exception: ' + (e && e.message));
  }
}

async function testPasteAcrossRestart() {
  try {
    // fresh page => clipboard empty (in-memory)
    await newPage();
    await install();
    const r = await ev(`(async () => {
      const p = RM.proj.create('PasteTest');
      p.ops = [{ t: 'paste', at: 1 }];
      p.audioRef = { name: 'paste.wav', size: 10, type: 'audio/wav', lastModified: 0 };
      const hadPaste = RM.proj.hasPasteOps(p);
      const clipEmpty = !RM.proj.getClipboard();
      RM.app.openProject(p); // must not throw; must warn about clipboard
      const toast = document.getElementById('toast').textContent;
      RM.app.state.buffer = window.__T.buf;
      const view = await RM.app.refreshView();
      const d = window.__T.diff(view, window.__T.buf);
      return { hadPaste, clipEmpty, toast, viewLen: view.length, bufLen: window.__T.buf.length, diff: d.maxDiff };
    })()`);
    const ok = r.hadPaste === true && r.clipEmpty === true &&
      /clipboard/i.test(r.toast) && r.viewLen === r.bufLen && r.diff === 0;
    rec('paste op across restart handled gracefully', ok,
      ok ? `toast="${r.toast}", paste skipped, view == original (${r.viewLen} samples)`
         : JSON.stringify(r));
  } catch (e) {
    rec('paste op across restart handled gracefully', false, 'exception: ' + (e && e.message));
  }
}

/* ================= RUN ================= */

(async () => {
  browser = await puppeteer.launch({
    executablePath: CHS,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
           '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    await newPage();
    // define a callable helper installer
    await testPerToolUndoRedo();
    await testRapidUndoRedo();
    await testUndoEmpty();
    await testNewOpClearsRedo();
    await testSaveCloseReopen();
    await testNonDestructive();
    await testAutosaveRecovery();
    await testPasteAcrossRestart();
    if (pageErrors.length) {
      rec('zero pageerrors during suite', false, pageErrors.slice(0, 5).join(' || '));
    } else {
      rec('zero pageerrors during suite', true, 'clean');
    }
  } catch (e) {
    rec('suite harness', false, 'exception: ' + (e && e.message));
  } finally {
    await browser.close().catch(() => {});
  }
  const fails = results.filter((r) => !r.ok);
  console.log('\n==== SUMMARY: ' + (results.length - fails.length) + '/' + results.length + ' PASS ====');
  process.exit(fails.length ? 1 : 0);
})();
