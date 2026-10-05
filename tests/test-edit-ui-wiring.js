#!/usr/bin/env node
/**
 * RuhMix editing-tools UI wiring tests.
 * Drives the REAL editor UI in headless Chrome (file://), pushes real ops,
 * and inspects RM.app.state.project.ops + RM.proj clipboard.
 * Exit code: 0 = all PASS, non-zero = at least one FAIL.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const WWW = '/home/hatch/workspace/ruhmix/www';
const PAGE_URL = pathToFileURL(path.join(WWW, 'index.html')).href;

function findChrome() {
  const cands = [
    path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell'),
    path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('chrome-headless-shell not found');
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const approx = (v, want, tol = 0.02) => Math.abs(v - want) <= tol;

(async () => {
  const pageErrors = [];
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text().slice(0, 200)); });

  try {
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.RM && RM.app && RM.app.state, { timeout: 30000 });

    // First-run onboarding overlay (ob-ov) swallows real mouse clicks — dismiss it.
    await page.evaluate(() => {
      const sk = document.getElementById('ob-skip');
      if (sk && document.getElementById('ob-ov') && document.getElementById('ob-ov').classList.contains('show')) sk.click();
      const wn = document.getElementById('wn-gotit');
      if (wn && document.getElementById('ob-ov') && document.getElementById('ob-ov').classList.contains('show')) wn.click();
    });
    await new Promise((r) => setTimeout(r, 300));

    // ---- fixture: 10s stereo test tone, loaded as a real project ----
    await page.evaluate(() => RM.app.show('editor'));
    await page.evaluate(() => {
      const ctx = RM.audio.ensureCtx();
      const sr = 44100, n = sr * 10;
      const buf = ctx.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * (c ? 660 : 440) * i / sr) * 0.5;
      }
      RM.app.loadAudioBuffer(buf, 'test-10s.wav');
    });
    await page.waitForFunction(
      () => RM.app.state.viewBuffer && RM.app.state.viewBuffer.duration > 9.9, { timeout: 30000 });
    record('fixture-audio-loaded', true, '10s buffer, view rendered');

    // ---- helpers ----
    const ops = () => page.evaluate(() => JSON.parse(JSON.stringify(RM.app.state.project.ops)));
    const reset = () => page.evaluate(async () => {
      RM.app.state.project.ops = [];
      RM.proj.clearClipboard();
      await RM.app.refreshView();
    });
    const setSel = (a, b) => page.evaluate((a, b) => {
      const x = document.getElementById('ed-sel-a'), y = document.getElementById('ed-sel-b');
      x.value = a; y.value = b;
      x.dispatchEvent(new Event('input', { bubbles: true }));
      y.dispatchEvent(new Event('input', { bubbles: true }));
    }, a, b);
    const waitOps = (n) => page.waitForFunction(
      (n) => window.RM && RM.app.state.project && RM.app.state.project.ops.length === n,
      { timeout: 25000 }, n);
    const clipDur = () => page.evaluate(() => {
      const c = RM.proj.getClipboard(); return c ? c.duration : null;
    });
    const dlgVal = () => page.evaluate(() => (document.getElementById('dlg-num') || {}).value);
    const setDlg = (v) => page.evaluate((v) => { document.getElementById('dlg-num').value = v; }, v);
    const toastText = () => page.evaluate(() => document.getElementById('toast').textContent);
    // Real mouse click, but scroll the target to viewport-center first: the
    // fixed bottom nav would otherwise swallow clicks on low-screen buttons.
    const click = async (id) => {
      await page.evaluate((id) => {
        document.getElementById(id).scrollIntoView({ block: 'center', inline: 'center' });
      }, id);
      await new Promise((r) => setTimeout(r, 200));
      await page.click('#' + id);
    };

    // ---- 1. every editing button exists, English label, enabled & visible ----
    const EXPECTED = [
      ['ed-trim', 'Trim'], ['ed-cut', 'Cut'], ['ed-delete', 'Delete'],
      ['ed-split', 'Split'], ['ed-copy', 'Copy'], ['ed-paste', 'Paste'],
      ['ed-duplicate', 'Duplicate'], ['ed-fadein', 'Fade In'], ['ed-fadeout', 'Fade Out'],
      ['ed-gain-up', 'Gain'], ['ed-gain-dn', 'Gain'], ['ed-reverse', 'Reverse'],
      ['ed-undo', 'Undo'], ['ed-redo', 'Redo'], ['ed-loop', 'Loop'],
    ];
    const btnReport = await page.evaluate((EXPECTED) => {
      const out = [];
      for (const [id, label] of EXPECTED) {
        const el = document.getElementById(id);
        if (!el) { out.push(id + ':MISSING'); continue; }
        const t = (el.textContent || '').trim();
        if (!t) { out.push(id + ':BLANK'); continue; }
        if (/undefined/i.test(t)) { out.push(id + ':UNDEFINED'); continue; }
        if (!t.includes(label)) { out.push(id + ':LABEL<' + t + '>'); continue; }
        if (el.disabled) { out.push(id + ':DISABLED'); continue; }
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) { out.push(id + ':INVISIBLE'); continue; }
        out.push(id + ':OK');
      }
      for (const id of ['ed-vol', 'ed-pan', 'ed-speed']) {
        const el = document.getElementById(id);
        if (!el || el.type !== 'range') out.push(id + ':MISSING-SLIDER'); else out.push(id + ':OK');
      }
      return out;
    }, EXPECTED);
    const btnBad = btnReport.filter((s) => !s.endsWith(':OK'));
    record('buttons-present-labeled-clickable', btnBad.length === 0, btnBad.join('; ') || 'all 18 controls OK');

    // ---- 2. no blank/"undefined" labels anywhere on the editor screen ----
    const badLabels = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('#screen-editor button').forEach((b) => {
        const t = (b.textContent || '').trim();
        if (!t) bad.push((b.id || '?') + ':blank');
        else if (/undefined/i.test(t)) bad.push((b.id || '?') + ':undefined');
      });
      return bad;
    });
    record('no-blank-or-undefined-labels', badLabels.length === 0, badLabels.join('; ') || 'clean');

    // ---- 3. Cut: selection 2–5 -> {t:'cut',a:2,b:5} ----
    await reset(); await setSel(2, 5); await click('ed-cut'); await waitOps(1);
    let o = await ops();
    record('cut-op-shape', o.length === 1 && o[0].t === 'cut' && o[0].a === 2 && o[0].b === 5,
      JSON.stringify(o));

    // ---- 4. Cut copies the range to the clipboard (standard cut semantics) ----
    const cd = await clipDur();
    record('cut-copies-to-clipboard', cd !== null && approx(cd, 3),
      'clipboard=' + cd + 's');

    // ---- 5. Trim ----
    await reset(); await setSel(2, 5); await click('ed-trim'); await waitOps(1);
    o = await ops();
    record('trim-op-shape', o.length === 1 && o[0].t === 'trim' && o[0].a === 2 && o[0].b === 5,
      JSON.stringify(o));

    // ---- 6. Split at 4s -> cut op on [4,10); tail (6s) in clipboard ----
    await reset();
    await page.evaluate(() => { RM.app.state.player.offset = 4; });
    await click('ed-split'); await waitOps(1);
    o = await ops();
    const splitOk = o.length === 1 && o[0].t === 'cut' && approx(o[0].a, 4) && approx(o[0].b, 10);
    const tailDur = await clipDur();
    record('split-op-shape', splitOk && tailDur !== null && approx(tailDur, 6),
      JSON.stringify(o) + ' clipboard=' + tailDur + 's');

    // ---- 7. Delete -> cut op with selection range, clipboard untouched ----
    await reset(); await setSel(2, 5); await click('ed-delete'); await waitOps(1);
    o = await ops();
    const delClip = await clipDur();
    record('delete-op-shape', o.length === 1 && o[0].t === 'cut' && o[0].a === 2 && o[0].b === 5 && delClip === null,
      JSON.stringify(o) + ' clipboard=' + delClip);

    // ---- 8. Copy selection -> clipboard 3s; Paste at cursor 1s -> {t:'paste',at:1} ----
    await reset(); await setSel(2, 5); await click('ed-copy');
    await page.waitForFunction(() => RM.proj.getClipboard() && RM.proj.getClipboard().duration > 2.9,
      { timeout: 25000 });
    const copyDur = await clipDur();
    await page.evaluate(() => { RM.app.state.player.offset = 1; });
    await click('ed-paste'); await waitOps(1);
    o = await ops();
    record('copy-paste', copyDur !== null && approx(copyDur, 3) &&
      o.length === 1 && o[0].t === 'paste' && approx(o[0].at, 1),
      JSON.stringify(o) + ' clipboard=' + copyDur + 's');

    // ---- 9. Duplicate -> copy-all + paste at end; view doubles to 20s ----
    await reset(); await click('ed-duplicate'); await waitOps(1);
    o = await ops();
    const dupClip = await clipDur();
    const viewDur = await page.evaluate(() => RM.app.state.viewBuffer.duration);
    record('duplicate-op', o.length === 1 && o[0].t === 'paste' && approx(o[0].at, 10) &&
      dupClip !== null && approx(dupClip, 10) && approx(viewDur, 20),
      JSON.stringify(o) + ' clipboard=' + dupClip + 's view=' + viewDur + 's');

    // ---- 10. Fade In dialog: default 2s, enter 1.5 -> {t:'fadein',dur:1.5} ----
    await reset(); await click('ed-fadein');
    await page.waitForFunction(() => document.getElementById('dlg').classList.contains('show'),
      { timeout: 5000 });
    const fiDef = await dlgVal();
    await setDlg('1.5'); await click('dlg-ok'); await waitOps(1);
    o = await ops();
    record('fadein-dialog', fiDef === '2' && o.length === 1 && o[0].t === 'fadein' && approx(o[0].dur, 1.5),
      'default=' + fiDef + ' op=' + JSON.stringify(o));

    // ---- 11. Fade Out dialog: default 3s, enter 2.5 -> {t:'fadeout',dur:2.5} ----
    await reset(); await click('ed-fadeout');
    await page.waitForFunction(() => document.getElementById('dlg').classList.contains('show'),
      { timeout: 5000 });
    const foDef = await dlgVal();
    await setDlg('2.5'); await click('dlg-ok'); await waitOps(1);
    o = await ops();
    record('fadeout-dialog', foDef === '3' && o.length === 1 && o[0].t === 'fadeout' && approx(o[0].dur, 2.5),
      'default=' + foDef + ' op=' + JSON.stringify(o));

    // ---- 12. Gain + dialog: default +3, enter +6 -> {t:'gain',db:6} ----
    await reset(); await click('ed-gain-up');
    await page.waitForFunction(() => document.getElementById('dlg').classList.contains('show'),
      { timeout: 5000 });
    const gDef = await dlgVal();
    await setDlg('6'); await click('dlg-ok'); await waitOps(1);
    o = await ops();
    record('gain-dialog-plus', gDef === '3' && o.length === 1 && o[0].t === 'gain' && o[0].db === 6,
      'default=' + gDef + ' op=' + JSON.stringify(o));

    // ---- 13. Gain − dialog: default −3, enter −4.5 -> {t:'gain',db:-4.5} ----
    await reset(); await click('ed-gain-dn');
    await page.waitForFunction(() => document.getElementById('dlg').classList.contains('show'),
      { timeout: 5000 });
    const gdDef = await dlgVal();
    await setDlg('-4.5'); await click('dlg-ok'); await waitOps(1);
    o = await ops();
    record('gain-dialog-minus', gdDef === '-3' && o.length === 1 && o[0].t === 'gain' && approx(o[0].db, -4.5),
      'default=' + gdDef + ' op=' + JSON.stringify(o));

    // ---- 14. dialog Cancel pushes no op ----
    await reset(); await click('ed-fadein');
    await page.waitForFunction(() => document.getElementById('dlg').classList.contains('show'),
      { timeout: 5000 });
    await click('dlg-cancel');
    await new Promise((r) => setTimeout(r, 800));
    o = await ops();
    record('dialog-cancel-no-op', o.length === 0, 'ops=' + o.length);

    // ---- 15. no selection: Cut/Trim/Delete -> clean toast, zero ops, no crash ----
    await reset(); await setSel(0, 0);
    await click('ed-cut'); await new Promise((r) => setTimeout(r, 400));
    const t1 = await toastText();
    await click('ed-trim'); await new Promise((r) => setTimeout(r, 400));
    await click('ed-delete'); await new Promise((r) => setTimeout(r, 400));
    o = await ops();
    const noSelOk = o.length === 0 && /selection/i.test(t1);
    // paste with empty clipboard
    await click('ed-paste'); await new Promise((r) => setTimeout(r, 400));
    const t2 = await toastText();
    o = await ops();
    record('no-selection-clean', noSelOk && o.length === 0 && /clipboard/i.test(t2),
      'toasts=[' + t1 + ' | ' + t2 + '] ops=' + o.length);

    // ---- 16. rapid clicks: 5x fast -> exactly 1 op, no crash ----
    await reset(); await setSel(2, 5);
    await Promise.all([1, 2, 3, 4, 5].map(() => click('ed-cut')));
    await waitOps(1);
    await new Promise((r) => setTimeout(r, 1500));
    o = await ops();
    const cutOnce = o.length === 1 && o[0].t === 'cut';
    await reset();
    await Promise.all([1, 2, 3, 4, 5].map(() => click('ed-reverse')));
    await waitOps(1);
    await new Promise((r) => setTimeout(r, 1500));
    o = await ops();
    record('rapid-click-single-op', cutOnce && o.length === 1 && o[0].t === 'reverse',
      'cut ops=1, reverse ops=' + o.length);

    // ---- 17. playback controls wired: Volume/Pan/Speed sliders + Loop ----
    const ctl = await page.evaluate(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('ed-vol', 50); set('ed-pan', -50); set('ed-speed', 150);
      const s = RM.app.state.project.settings;
      const before = s.loop;
      document.getElementById('ed-loop').click();
      const after = s.loop;
      document.getElementById('ed-loop').click();
      return { vol: s.volume, pan: s.pan, speed: s.speed, loopToggled: after === !before, loopBack: s.loop === before };
    });
    record('playback-controls-wired',
      approx(ctl.vol, 0.5) && approx(ctl.pan, -0.5) && approx(ctl.speed, 1.5) && ctl.loopToggled && ctl.loopBack,
      JSON.stringify(ctl));

    // ---- 18. zero pageerrors ----
  } catch (e) {
    record('harness', false, 'exception: ' + (e && e.message));
  } finally {
    record('zero-pageerrors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' || ') || 'none');
    await browser.close();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - fails.length}/${results.length} PASS ====`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
