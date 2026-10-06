#!/usr/bin/env node
/* =====================================================================
   RuhMix — "TITE SE FIX" round W2: Audio Editor deep-review edge tests.
   Drives the REAL app code (RM.proj.applyOps, RM.app handlers, RM.audio
   player, RM.wave) in headless Chrome via file:// — no mocks of the
   code under test.

   Exit code: 0 = all PASS, 1 = at least one FAIL.
   ===================================================================== */
'use strict';
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';

const results = [];
const pageErrors = [];
function rec(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' — ' + detail : ''));
}

let browser, page;
async function newPage() {
  if (page) { try { await page.close(); } catch (e) {} }
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text().slice(0, 160)); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.app && RM.app.state && RM.proj && RM.audio && RM.wave', { timeout: 30000 });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
}
async function ev(fn) { return page.evaluate(fn); }
async function waitFor(expr, timeout) {
  timeout = timeout || 20000;
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout: ' + String(expr).slice(0, 100));
    await new Promise((r) => setTimeout(r, 150));
  }
}

/* In-page synth helper shared by all chunks. */
const SYNTH = `
window.__S = {
  make: function (secs) {
    const ctx = RM.audio.ensureCtx();
    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.floor(sr * secs));
    const b = ctx.createBuffer(2, n, sr);
    const L = b.getChannelData(0), R = b.getChannelData(1);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      L[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
      R[i] = 0.5 * Math.sin(2 * Math.PI * 660 * t);
    }
    return b;
  },
  copy: function (b) {
    const c = new Float32Array(b.length);
    c.set(b.getChannelData(0));
    return c;
  },
  maxAbs: function (a) { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; },
  maxDiff: function (a, ao, b, bo, len) {
    let m = 0;
    for (let i = 0; i < len; i++) { const d = Math.abs(a[ao + i] - b[bo + i]); if (d > m) m = d; }
    return m;
  }
};`;

/* ================= Chunk 1: applyOps engine edge cases ================= */
async function chunkEngine() {
  console.log('--- engine: applyOps edge cases ---');
  await ev(SYNTH);
  const R = await ev(`(async () => {
    const out = [];
    const add = (n, p, d) => out.push({ n, p: !!p, d: String(d === undefined ? '' : d) });
    const sr = RM.audio.ensureCtx().sampleRate;
    const buf = __S.make(10);
    const inL = __S.copy(buf);
    const sec = (s) => Math.round(s * sr);
    const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]*a[i]; return Math.sqrt(s/a.length); };
    const L = (b) => b.getChannelData(0);

    // 1. cut reversed range {a:8,b:2} == cut {a:2,b:8}, no duplication
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'cut', a: 8, b: 2 }]);
      const d1 = __S.maxDiff(L(r), 0, inL, 0, sec(2));
      const d2 = __S.maxDiff(L(r), sec(2), inL, sec(8), sec(2));
      add('cut reversed {a:8,b:2} -> 4s, content kept, no duplication', r.length === sec(4) && d1 === 0 && d2 === 0, 'len=' + r.length + ' d1=' + d1 + ' d2=' + d2);
    }
    // 2. cut whole file -> 1-sample view, no crash
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'cut', a: 0, b: 10 }]);
      add('cut whole file -> 1-sample buffer, no crash', r.length === 1, 'len=' + r.length);
    }
    // 3. trim zero-length -> 1-sample, no crash
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'trim', a: 3, b: 3 }]);
      add('trim zero-length -> 1-sample, no crash', r.length === 1, 'len=' + r.length);
    }
    // 4. trim out-of-range clamps to whole buffer
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'trim', a: -5, b: 999 }]);
      const d = __S.maxDiff(L(r), 0, inL, 0, buf.length);
      add('trim {a:-5,b:999} -> whole buffer clamped', r.length === buf.length && d === 0, 'len=' + r.length);
    }
    // 5. paste with null clipboard -> op ignored, buffer unchanged
    {
      RM.proj.clearClipboard();
      const r = await RM.proj.applyOps(buf, [{ t: 'paste', at: 2 }]);
      const d = __S.maxDiff(L(r), 0, inL, 0, buf.length);
      add('paste with empty clipboard -> ignored, audio unchanged', r.length === buf.length && d === 0, 'len=' + r.length);
    }
    // 6. paste at > duration -> appended at end
    {
      const clip = __S.make(2);
      RM.proj.setClipboard(clip);
      const r = await RM.proj.applyOps(buf, [{ t: 'paste', at: 999 }]);
      const d1 = __S.maxDiff(L(r), 0, inL, 0, buf.length);
      const d2 = __S.maxDiff(L(r), buf.length, clip.getChannelData(0), 0, clip.length);
      add('paste at:999 -> appended at end', r.length === buf.length + clip.length && d1 === 0 && d2 === 0, 'len=' + r.length);
      RM.proj.clearClipboard();
    }
    // 7. fadein dur > file -> ramps over whole file, no NaN
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'fadein', dur: 999 }]);
      const l = L(r);
      let nan = false;
      for (let i = 0; i < l.length; i += 997) if (!Number.isFinite(l[i])) { nan = true; break; }
      const g0 = Math.abs(l[0]) < 1e-4;
      const mid = Math.abs(l[Math.floor(l.length / 2)] / inL[Math.floor(l.length / 2)] - 0.5) < 0.01;
      add('fadein dur=999 -> full-length ramp, no NaN', !nan && g0 && mid, 'l0=' + l[0] + ' midRatio~0.5=' + mid);
    }
    // 8. fadein dur=0 -> defaults to 1s fade, no crash
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'fadein', dur: 0 }]);
      const l = L(r);
      const fl = sec(1);
      const d = __S.maxDiff(l, fl, inL, fl, buf.length - fl);
      add('fadein dur=0 -> 1s default fade, rest untouched', Math.abs(l[0]) < 1e-4 && d < 1e-6, 'd=' + d);
    }
    // 9. gain +-30dB -> correct factor, no NaN/Inf
    {
      const rp = await RM.proj.applyOps(buf, [{ t: 'gain', db: 30 }]);
      const rm = await RM.proj.applyOps(buf, [{ t: 'gain', db: -30 }]);
      const lp = L(rp), lm = L(rm);
      const fp = Math.pow(10, 30 / 20), fm = Math.pow(10, -30 / 20);
      let okp = true, okm = true;
      for (let i = 0; i < lp.length; i += 977) {
        if (!Number.isFinite(lp[i]) || !Number.isFinite(lm[i])) { okp = false; okm = false; break; }
        if (Math.abs(lp[i] / fp - inL[i]) > 1e-4) okp = false;
        if (Math.abs(lm[i] / fm - inL[i]) > 1e-6) okm = false;
      }
      add('gain +30dB -> x31.62 exact, no NaN/Inf', okp, 'peak=' + __S.maxAbs(lp).toFixed(2));
      add('gain -30dB -> x0.0316 exact, no NaN', okm, 'rms=' + rms(lm).toExponential(2));
    }
    // 10. sanitizeOps drops NaN db
    {
      const clean = RM.proj.deserialize(JSON.stringify({ id: 'x', ops: [{ t: 'gain', db: NaN }, { t: 'gain', db: 6 }, null, { t: 'bogus' }] }));
      add('sanitizeOps drops NaN db / null / unknown op', clean && clean.ops.length === 1 && clean.ops[0].db === 6, 'ops=' + JSON.stringify(clean && clean.ops));
    }
    // 11. reverse incl. odd length center sample
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'reverse' }]);
      const l = L(r), n = l.length;
      const dEnds = Math.max(Math.abs(l[0] - inL[n - 1]), Math.abs(l[n - 1] - inL[0]));
      const mid = n % 2 === 1 ? Math.abs(l[(n - 1) / 2] - inL[(n - 1) / 2]) : 0;
      const rr = await RM.proj.applyOps(buf, [{ t: 'reverse' }, { t: 'reverse' }]);
      const dBack = __S.maxDiff(L(rr), 0, inL, 0, n);
      add('reverse -> ends swapped, double reverse == original', dEnds === 0 && mid === 0 && dBack === 0, 'dEnds=' + dEnds + ' dBack=' + dBack);
    }
    // 12. 10 mixed ops then 10 undos -> original bit-exact
    {
      const ops = [
        { t: 'cut', a: 1, b: 2 }, { t: 'gain', db: 6 }, { t: 'fadein', dur: 1 },
        { t: 'reverse' }, { t: 'cut', a: 0.5, b: 1 }, { t: 'fadeout', dur: 2 },
        { t: 'gain', db: -3 }, { t: 'trim', a: 1, b: 6 }, { t: 'reverse' }, { t: 'gain', db: 1.5 },
      ];
      const live = ops.slice();
      let v = await RM.proj.applyOps(buf, live);
      add('10 mixed ops apply -> view renders', v.length > 1 && Number.isFinite(v.getChannelData(0)[0]), 'len=' + v.length);
      for (let i = 0; i < 10; i++) { live.pop(); v = await RM.proj.applyOps(buf, live); }
      const d = __S.maxDiff(L(v), 0, inL, 0, buf.length);
      add('10 undos -> bit-exact original restored', v.length === buf.length && d === 0, 'len=' + v.length + ' d=' + d);
    }
    // 13. cut then paste at 0 (prepend) -> order correct
    {
      const clip = __S.make(1);
      RM.proj.setClipboard(clip);
      const r = await RM.proj.applyOps(buf, [{ t: 'paste', at: 0 }]);
      const d = __S.maxDiff(L(r), 0, clip.getChannelData(0), 0, clip.length);
      const d2 = __S.maxDiff(L(r), clip.length, inL, 0, buf.length);
      add('paste at:0 -> prepended, order correct', r.length === buf.length + clip.length && d === 0 && d2 === 0, 'len=' + r.length);
      RM.proj.clearClipboard();
    }
    // 14. clipGen: clipboard change between paste renders -> no stale cache
    {
      const cA = __S.make(1), cB = __S.make(1);
      const dB = cB.getChannelData(0);
      for (let i = 0; i < dB.length; i++) dB[i] = 0.9; // DC marker
      RM.proj.setClipboard(cA);
      const r1 = await RM.proj.applyOps(buf, [{ t: 'paste', at: 1 }]);
      RM.proj.setClipboard(cB);
      const r2 = await RM.proj.applyOps(buf, [{ t: 'paste', at: 1 }]);
      const l2 = L(r2), s1 = sec(1);
      let isB = true;
      for (let i = 0; i < Math.min(1000, cB.length); i++) if (Math.abs(l2[s1 + i] - 0.9) > 1e-6) { isB = false; break; }
      const l1 = L(r1);
      let r1notB = Math.abs(l1[s1] - 0.9) > 1e-6;
      add('clipboard swap -> re-render uses NEW clipboard (no stale cache)', isB && r1notB, 'isB=' + isB);
      RM.proj.clearClipboard();
    }
    // 15. undo of paste after clipboard cleared -> applyOps ignores (no crash)
    {
      const r = await RM.proj.applyOps(buf, [{ t: 'paste', at: 2 }, { t: 'gain', db: 3 }]);
      add('paste op w/o clipboard + later ops -> renders, no crash', r.length === buf.length, 'len=' + r.length);
    }
    return out;
  })()`);
  for (const r of R) rec('engine | ' + r.n, r.p, r.d);
}

/* ============ Chunk 2: UI handlers with NO project/audio ============ */
async function chunkNoAudio() {
  console.log('--- UI: no-audio guards ---');
  await ev(`(async () => {
    // handlers use the closure toast(), not RM.app.toast — read the DOM element
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
    const ids = ['ed-trim','ed-cut','ed-delete','ed-copy','ed-paste','ed-split','ed-duplicate','ed-reverse','ed-fadein','ed-fadeout','ed-gain-up','ed-gain-dn','ed-undo','ed-redo','ed-loop','ed-play','ed-marker-add'];
    for (const id of ids) {
      try { document.getElementById(id).click(); }
      catch (e) { window.__errs.push(id + ': ' + e.message); }
      await new Promise((r) => setTimeout(r, 60));
    }
    // dismiss any dialog left open by fade/gain buttons
    try { document.getElementById('dlg-cancel').click(); } catch (e) {}
    try { document.getElementById('dlg-cancel').click(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
    return { errs: window.__errs, toast: document.getElementById('toast').textContent, projectNull: RM.app.state.project === null };
  })()`).then((r) => {
    rec('no-audio | op buttons never throw', r.errs.length === 0, r.errs.join('; ') || 'projectNull=' + r.projectNull);
    rec('no-audio | friendly toast shown', /import audio/i.test(r.toast), 'toast="' + r.toast + '"');
  });
  // sliders with no project — must not throw (in-page error hook catches listener throws)
  const s = await ev(`(() => {
    window.__serrs = [];
    const hook = (e) => window.__serrs.push(String((e && e.message) || e));
    window.addEventListener('error', hook);
    const fire = (id) => {
      const el = document.getElementById(id);
      el.value = id === 'ed-pan' ? '50' : '60';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    ['ed-vol','ed-pan','ed-speed'].forEach(fire);
    return new Promise((res) => setTimeout(() => { window.removeEventListener('error', hook); res(window.__serrs); }, 300));
  })()`);
  rec('no-audio | vol/pan/speed sliders never throw', s.length === 0, s.join('; ') || 'ok');
}

/* ============ Chunk 3: UI handlers with audio loaded ============ */
async function chunkWithAudio() {
  console.log('--- UI: editor tools with audio ---');
  await ev(SYNTH);
  await ev(`(async () => {
    const buf = __S.make(30);
    RM.app.loadAudioBuffer(buf, 'edge-test.wav', { name: 'edge-test.wav', size: 1, type: '', lastModified: 1 });
  })()`);
  await waitFor('!!(RM.app.state.viewBuffer && RM.app.state.viewBuffer.length > 1000)', 30000);
  const lastToast = () => ev(`document.getElementById('toast').textContent`);
  const nOps = () => ev(`RM.app.state.project.ops.length`);

  // trim via UI
  await ev(`(() => {
    document.getElementById('ed-sel-a').value = '5';
    document.getElementById('ed-sel-b').value = '15';
    document.getElementById('ed-trim').click();
  })()`);
  await waitFor('RM.app.state.project.ops.length >= 1 && !!(RM.app.state.viewBuffer) && Math.abs(RM.app.state.viewBuffer.duration - 10) < 0.2', 30000);
  {
    const d = await ev(`RM.app.state.viewBuffer.duration`);
    rec('ui | trim [5,15] via button -> 10s view', Math.abs(d - 10) < 0.2, 'dur=' + d.toFixed(2));
  }

  // 20 rapid reverse taps -> exactly 1 op (guardOp)
  await ev(`(() => { for (let i = 0; i < 20; i++) document.getElementById('ed-reverse').click(); })()`);
  await new Promise((r) => setTimeout(r, 2500));
  {
    const n = await nOps();
    rec('ui | 20 rapid reverse taps -> exactly 1 op (guardOp)', n === 2, 'ops=' + n);
  }

  // 20 rapid undos with 2 ops -> no crash, original restored
  const origLen = await ev(`RM.app.state.buffer.length`);
  await ev(`(() => { window.__uerrs = []; const h = (e) => window.__uerrs.push(String((e && e.message) || e)); window.addEventListener('error', h); window.__uh = h; for (let i = 0; i < 20; i++) document.getElementById('ed-undo').click(); })()`);
  await waitFor('RM.app.state.project.ops.length === 0', 30000).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  {
    const st = await ev(`({ vlen: RM.app.state.viewBuffer ? RM.app.state.viewBuffer.length : -1, errs: (window.__uerrs || []).length })`);
    try { await ev(`window.removeEventListener('error', window.__uh)`); } catch (e) {}
    rec('ui | 20 rapid undos (2 ops) -> empty ops, view==original, no crash', st.vlen === origLen && st.errs === 0, JSON.stringify(st));
  }

  // pushOp in-flight + immediate undo (gen-token race) -> consistent state
  await ev(`(() => {
    document.getElementById('ed-sel-a').value = '1';
    document.getElementById('ed-sel-b').value = '2';
    document.getElementById('ed-delete').click();
    document.getElementById('ed-undo').click();
  })()`);
  await new Promise((r) => setTimeout(r, 3000));
  {
    const st = await ev(`({ ops: RM.app.state.project.ops.length, vlen: RM.app.state.viewBuffer ? RM.app.state.viewBuffer.length : -1 })`);
    rec('ui | delete then instant undo (in-flight render) -> consistent, view==original', st.ops === 0 && st.vlen === origLen, JSON.stringify(st));
  }

  // selRange clamps to VIEW duration (not original buffer): trim to 10s, select 20-25
  await ev(`(() => {
    document.getElementById('ed-sel-a').value = '5';
    document.getElementById('ed-sel-b').value = '15';
    document.getElementById('ed-trim').click();
  })()`);
  await waitFor('RM.app.state.project.ops.length >= 1 && !!(RM.app.state.viewBuffer) && Math.abs(RM.app.state.viewBuffer.duration - 10) < 0.2', 30000);
  await new Promise((r) => setTimeout(r, 1500)); // guardOp window
  await ev(`(() => {
    document.getElementById('ed-sel-a').value = '20';
    document.getElementById('ed-sel-b').value = '25';
    document.getElementById('ed-cut').click();
  })()`);
  await new Promise((r) => setTimeout(r, 2000));
  {
    const ops = await nOps();
    const toast = await lastToast();
    rec('ui | cut with selection beyond 10s view -> blocked with helpful toast, no op', ops === 1 && /selection/i.test(toast), 'ops=' + ops + ' toast="' + toast + '"');
  }

  // askFade validation matrix
  async function fadeCase(input, expectDur, label) {
    const before = await nOps();
    await ev(`(() => { document.getElementById('ed-fadein').click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
    await ev(`(() => { document.getElementById('dlg-num').value = ${JSON.stringify(input)}; document.getElementById('dlg-ok').click(); })()`);
    await new Promise((r) => setTimeout(r, 2500));
    const op = await ev(`RM.app.state.project.ops[${before}]`);
    const ok = op && op.t === 'fadein' && Math.abs(op.dur - expectDur) < 1e-9;
    rec('ui | fadein input ' + label + ' -> dur=' + expectDur, ok, 'got=' + JSON.stringify(op));
  }
  await fadeCase('abc', 2, '"abc"->default 2');
  await fadeCase('9999', 60, '"9999"->clamp 60');
  await fadeCase('-3', 0.1, '"-3"->clamp 0.1');

  // askGain validation matrix
  async function gainCase(input, expectDb, label, expectOp) {
    const before = await nOps();
    await ev(`(() => { document.getElementById('ed-gain-up').click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
    await ev(`(() => { document.getElementById('dlg-num').value = ${JSON.stringify(input)}; document.getElementById('dlg-ok').click(); })()`);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await nOps();
    const op = expectOp ? await ev(`RM.app.state.project.ops[${before}]`) : null;
    const toast = await lastToast();
    const ok = expectOp
      ? (after === before + 1 && op && op.t === 'gain' && Math.abs(op.db - expectDb) < 1e-9)
      : (after === before && /0 dB/.test(toast));
    rec('ui | gain input ' + label, ok, 'got=' + JSON.stringify(op) + ' toast="' + toast + '"');
  }
  await gainCase('abc', 3, '"abc"->default +3', true);
  await gainCase('100', 24, '"100"->clamp +24', true);
  await gainCase('-100', -24, '"-100"->clamp -24', true);
  await gainCase('0', 0, '"0"->toast, no op', false);

  // duplicate: view length doubles
  const before = await ev(`RM.app.state.viewBuffer.duration`);
  await ev(`(() => { document.getElementById('ed-duplicate').click(); })()`);
  await waitFor('RM.app.state.viewBuffer && RM.app.state.viewBuffer.duration > ' + (before * 1.9), 30000).catch(() => {});
  {
    const d = await ev(`RM.app.state.viewBuffer.duration`);
    rec('ui | duplicate -> view length doubles', Math.abs(d - before * 2) < 0.3, before.toFixed(2) + ' -> ' + d.toFixed(2));
  }
  // split at playhead offset -> view keeps [0, pos], tail in clipboard
  await ev(`(() => { RM.app.state.player.offset = 4; document.getElementById('ed-split').click(); })()`);
  await new Promise((r) => setTimeout(r, 2500));
  {
    const st = await ev(`({ dur: RM.app.state.viewBuffer.duration, clip: !!RM.proj.getClipboard() })`);
    rec('ui | split at 4s -> view is first 4s, tail in clipboard', Math.abs(st.dur - 4) < 0.3 && st.clip, JSON.stringify({ dur: st.dur.toFixed(2), clip: st.clip }));
  }
  // paste the split tail back at 0 -> view grows by tail length
  const prePaste = await ev(`RM.app.state.viewBuffer.duration`);
  const tailLen = await ev(`RM.proj.getClipboard().duration`);
  await ev(`(() => { RM.app.state.player.offset = 0; document.getElementById('ed-paste').click(); })()`);
  await new Promise((r) => setTimeout(r, 2500));
  {
    const d = await ev(`RM.app.state.viewBuffer.duration`);
    rec('ui | paste clipboard at 0 -> view grows by tail length', Math.abs(d - (prePaste + tailLen)) < 0.3, prePaste.toFixed(2) + '+' + tailLen.toFixed(2) + ' -> ' + d.toFixed(2));
  }
  // full undo sweep back to original
  const n0 = await nOps();
  await ev(`(() => { for (let i = 0; i < 40; i++) document.getElementById('ed-undo').click(); })()`);
  await waitFor('RM.app.state.project.ops.length === 0', 60000).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  {
    const st = await ev(`({ ops: RM.app.state.project.ops.length, vlen: RM.app.state.viewBuffer ? RM.app.state.viewBuffer.length : -1 })`);
    rec('ui | undo-all (' + n0 + ' ops incl paste/dup/split) -> view==original', st.ops === 0 && st.vlen === origLen, JSON.stringify(st));
  }
}
/* ============ Chunk 4: pan / rate / loop on the real player ============ */
async function chunkPlayer() {
  console.log('--- player: pan/rate/loop ---');
  await ev(SYNTH);
  const R = await ev(`(async () => {
    const out = [];
    const add = (n, p, d) => out.push({ n, p: !!p, d: String(d === undefined ? '' : d) });
    const ctx = RM.audio.ensureCtx();
    const OC = window.OfflineAudioContext;
    // pan semantics: StereoPannerNode at -1 -> right channel silent (CORRECT per spec)
    {
      const sr = 44100;
      const oc = new OC(2, sr * 2, sr);
      const src = oc.createBufferSource();
      const b = oc.createBuffer(2, sr * 2, sr);
      const L = b.getChannelData(0), Rr = b.getChannelData(1);
      for (let i = 0; i < L.length; i++) { L[i] = 0.5; Rr[i] = 0.5; }
      src.buffer = b;
      const pan = oc.createStereoPanner();
      pan.pan.value = -1;
      src.connect(pan); pan.connect(oc.destination);
      src.start(0);
      const ren = await oc.startRendering();
      const rl = ren.getChannelData(0), rr = ren.getChannelData(1);
      let mL = 0, mR = 0;
      for (let i = sr; i < 2 * sr; i++) { mL = Math.max(mL, Math.abs(rl[i])); mR = Math.max(mR, Math.abs(rr[i])); }
      add('pan=-1 -> left intact, right silent (correct equal-power pan)', mL > 0.4 && mR < 1e-3, 'mL=' + mL.toFixed(3) + ' mR=' + mR.toExponential(1));
    }
    // player setPan clamps
    {
      const p = RM.audio.makePlayer();
      p.setPan(-5); const a = p._pan === -1;
      p.setPan(5); const b2 = p._pan === 1;
      p.dispose();
      add('player.setPan clamps to [-1,1]', a && b2, '');
    }
    // setRate clamps
    {
      const p = RM.audio.makePlayer();
      p.setRate(10); const a = p.rate === 4;
      p.setRate(0.01); const b2 = p.rate === 0.25;
      p.setRate(1.5); const c = p.rate === 1.5;
      p.dispose();
      add('player.setRate clamps to [0.25,4]', a && b2 && c, '');
    }
    // loop mid-playback applies to live source
    {
      const p = RM.audio.makePlayer();
      p.load(__S.make(3));
      const okPlay = p.play(0);
      p.setLoop(true, 0, 3);
      const liveLoop = !!(p.src && p.src.loop === true);
      p.stop(true);
      add('loop toggle mid-playback -> live source loops immediately', okPlay && liveLoop, '');
      p.dispose();
    }
    // loop range refreshes on load (stale loopEnd fix)
    {
      const p = RM.audio.makePlayer();
      p.load(__S.make(10));
      p.setLoop(true, 0, 10);
      p.load(__S.make(4));
      const ok = p.loopEnd === 4 && p.loopStart === 0;
      p.dispose();
      add('player.load refreshes loop range (no stale loopEnd)', ok, '');
    }
    // position() wraps inside loop
    {
      const p = RM.audio.makePlayer();
      p.load(__S.make(10));
      p.setLoop(true, 0, 10);
      p.play(9.5);
      await new Promise((r) => setTimeout(r, 900));
      const pos = p.position();
      p.stop(true); p.dispose();
      add('looping position() wraps at loopEnd (no runaway)', pos < 10 && pos >= 0, 'pos=' + pos.toFixed(2));
    }
    return out;
  })()`);
  for (const r of R) rec('player | ' + r.n, r.p, r.d);
}

/* ============ Chunk 5: waveform on long files ============ */
async function chunkWave() {
  console.log('--- waveform: long-file render ---');
  await ev(SYNTH);
  // 60s buffer: time peaks
  const t60 = await ev(`(async () => {
    const buf = __S.make(60);
    const t0 = performance.now();
    const peaks = await RM.wave.getPeaks(buf, 1200);
    const t1 = performance.now();
    let mx = 0, nan = false;
    for (let i = 0; i < peaks.length; i++) { if (!Number.isFinite(peaks[i])) nan = true; if (peaks[i] > mx) mx = peaks[i]; }
    const t2 = performance.now();
    const peaks2 = await RM.wave.getPeaks(buf, 1200); // cached
    const t3 = performance.now();
    return { ms: (t1 - t0).toFixed(0), cachedMs: (t3 - t2).toFixed(1), max: mx.toFixed(3), nan, same: peaks === peaks2 };
  })()`);
  rec('wave | 60s stereo peaks < 5s, sane, cached 2nd call', +t60.ms < 5000 && !t60.nan && +t60.max > 0.2 && t60.same, JSON.stringify(t60));
  // 300s buffer (5 min): peaks only, cheap fill
  const t300 = await ev(`(async () => {
    const ctx = RM.audio.ensureCtx();
    const sr = ctx.sampleRate, n = Math.floor(sr * 300);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (((i * 7919) % 1000) / 1000 - 0.5) * 0.8;
    }
    const t0 = performance.now();
    const peaks = await RM.wave.getPeaks(buf, 1200);
    const t1 = performance.now();
    let mx = 0, nan = false;
    for (let i = 0; i < peaks.length; i++) { if (!Number.isFinite(peaks[i])) nan = true; if (peaks[i] > mx) mx = peaks[i]; }
    return { ms: (t1 - t0).toFixed(0), max: mx.toFixed(3), nan, cols: peaks.length };
  })()`);
  rec('wave | 300s (5min) stereo peaks render, no NaN', !t300.nan && +t300.max > 0.1 && +t300.ms < 15000, JSON.stringify(t300));
  // draw() at max zoom — no exception
  const dr = await ev(`(() => {
    try {
      const v = RM.app.state.waveView;
      v.setZoom(64); v.setScroll(0.5); v.setPlayhead(12.5); v.draw();
      v.setZoom(1); v.setScroll(0); v.draw();
      return 'ok';
    } catch (e) { return 'THROW: ' + e.message; }
  })()`);
  rec('wave | draw() at zoom 64 + playhead, no exception', dr === 'ok', dr);
}

/* ============ Chunk 6: paste/clipboard snapshot regressions ============ */
async function chunkPasteSnapshot() {
  console.log('--- paste: clipboard snapshot (_clip) regressions ---');
  await ev(SYNTH);
  const R = await ev(`(async () => {
    const out = [];
    const add = (n, p, d) => out.push({ n, p: !!p, d: String(d === undefined ? '' : d) });
    const sr = RM.audio.ensureCtx().sampleRate;
    const sec = (s) => Math.round(s * sr);
    const buf = __S.make(30);
    const L = (b) => b.getChannelData(0);

    // A. duplicate -> split -> undo: undo must restore the true pre-split view (20s, same audio)
    {
      const dup = __S.make(10); // clipboard: 10s duplicate content
      const dd = dup.getChannelData(0);
      for (let i = 0; i < dd.length; i++) dd[i] = 0.5; // DC marker A
      RM.proj.setClipboard(dup);
      const ops = [{ t: 'trim', a: 5, b: 15 }, { t: 'paste', at: 10, _clip: dup }];
      const v20 = await RM.proj.applyOps(buf, ops);
      const tail = __S.make(16);
      const td = tail.getChannelData(0);
      for (let i = 0; i < td.length; i++) td[i] = -0.5; // DC marker B (split overwrites clipboard)
      RM.proj.setClipboard(tail);
      const ops2 = ops.concat([{ t: 'cut', a: 4, b: 20 }]);
      const v4 = await RM.proj.applyOps(buf, ops2);
      // undo the split
      const vBack = await RM.proj.applyOps(buf, ops);
      const dLen = v4.length === sec(4) && vBack.length === sec(20);
      const dContent = __S.maxDiff(L(vBack), 0, L(v20), 0, v20.length) === 0;
      // the 4s view must be the first 4s of the pre-split view (marker A region untouched by B)
      const dHead = __S.maxDiff(L(v4), 0, L(v20), 0, v4.length) === 0;
      let noB = true;
      const l4 = L(v4);
      for (let i = 0; i < l4.length; i += 997) if (Math.abs(l4[i] + 0.5) < 1e-6) { noB = false; break; }
      add('dup->split->undo: 4s view, undo restores exact 20s, no marker-B leak', dLen && dContent && dHead && noB,
        'v4=' + v4.length + ' vBack=' + vBack.length);
      RM.proj.clearClipboard();
    }
    // B. double duplicate via _clip snapshots -> 40s, not 50s
    {
      const c1 = __S.make(10), c2 = __S.make(20);
      const ops = [{ t: 'trim', a: 0, b: 10 }, { t: 'paste', at: 10, _clip: c1 }, { t: 'paste', at: 20, _clip: c2 }];
      const v = await RM.proj.applyOps(buf, ops);
      add('double duplicate with snapshots -> 40s (not 50s)', v.length === sec(40), 'len=' + v.length);
    }
    // C. copy A -> paste -> copy B -> undo -> redo renders A, not B
    {
      const cA = __S.make(2), cB = __S.make(2);
      const da = cA.getChannelData(0), db = cB.getChannelData(0);
      for (let i = 0; i < da.length; i++) da[i] = 0.3;
      for (let i = 0; i < db.length; i++) db[i] = -0.3;
      const ops = [{ t: 'paste', at: 1, _clip: cA }];
      RM.proj.setClipboard(cB); // user copies something else afterwards
      const v = await RM.proj.applyOps(buf, ops); // = redo path
      const l = L(v), s1 = sec(1);
      let isA = true;
      for (let i = 0; i < Math.min(2000, cA.length); i++) if (Math.abs(l[s1 + i] - 0.3) > 1e-6) { isA = false; break; }
      add('paste after clipboard changed -> still renders snapshot A', isA, '');
      RM.proj.clearClipboard();
    }
    // D. legacy paste op (no _clip) falls back to live clipboard (backward compat)
    {
      const c = __S.make(2);
      RM.proj.setClipboard(c);
      const v = await RM.proj.applyOps(buf, [{ t: 'paste', at: 1 }]);
      const d = __S.maxDiff(L(v), sec(1), c.getChannelData(0), 0, c.length);
      add('legacy paste op (no _clip) -> live clipboard fallback', v.length === buf.length + c.length && d === 0, 'len=' + v.length);
      RM.proj.clearClipboard();
    }
    // E. _clip survives serialize/deserialize round-trip as droppable {} (no crash, op ignored w/o audio)
    {
      const c = __S.make(2);
      const ops = [{ t: 'paste', at: 1, _clip: c }];
      const ser = JSON.stringify(ops);
      const back = RM.proj.deserialize(JSON.stringify({ id: 'x', ops: JSON.parse(ser) }));
      const ok = back && back.ops.length === 1 && back.ops[0].t === 'paste' && back.ops[0].at === 1 && !back.ops[0]._clip;
      add('paste op JSON round-trip: _clip dropped cleanly, op intact', !!ok, ser.slice(0, 60));
    }
    return out;
  })()`);
  for (const r of R) rec('paste-snap | ' + r.n, r.p, r.d);
}

/* ================= main ================= */
(async () => {
  browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    await newPage();
    await chunkEngine();
    await newPage(); // fresh: no project
    await chunkNoAudio();
    await newPage(); // fresh: load audio for UI tests
    await chunkWithAudio();
    await chunkPlayer();
    await chunkWave();
    await chunkPasteSnapshot();
  } catch (e) {
    console.error('HARNESS ERROR: ' + (e && e.stack || e));
    results.push({ name: 'harness', ok: false });
  }
  try { await browser.close(); } catch (e) {}
  const fails = results.filter((r) => !r.ok);
  console.log('\n==== ' + (results.length - fails.length) + '/' + results.length + ' PASS ====');
  if (pageErrors.length) console.log('page errors seen: ' + pageErrors.slice(0, 5).join(' || '));
  process.exit(fails.length ? 1 : 0);
})();
