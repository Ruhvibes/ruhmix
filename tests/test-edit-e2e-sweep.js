'use strict';
/* =====================================================================
   RuhMix — Edit-tools E2E sweep (Puppeteer, headless-shell, file://)
   READ-ONLY verification: no APK build/upload. Exit non-zero on any
   failure. Screenshots -> /tmp/edit-e2e/
   Covers: Editor screen nav, every edit tool button (no-audio + loaded),
   fade/gain dialogs, speed 0.5x-2.0x, English-only labels, mixer screen,
   console/page errors.
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = '/tmp/edit-e2e';
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const verdicts = [];
const pageErrors = [];
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function verdict(name, cond, detail) {
  const v = { name, status: cond ? 'PASS' : 'FAIL', detail: detail || '' };
  verdicts.push(v);
  console.log(`${v.status}  ${v.name}  -- ${v.detail}`);
  if (!cond) failures.push(`${name}: ${detail || 'failed'}`);
}

(async () => {
  // ---- locate chrome-headless-shell ----
  const base = path.join(process.env.HOME, '.cache/puppeteer/chrome-headless-shell');
  const dirs = fs.readdirSync(base);
  const exe = path.join(base, dirs[0], 'chrome-headless-shell');
  if (!fs.existsSync(exe)) throw new Error('chrome-headless-shell not found under ' + base);

  const browser = await puppeteer.launch({
    headless: 'shell',
    executablePath: exe,
    args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

  await page.goto('file:///home/hatch/workspace/ruhmix/www/index.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  // dismiss any dialog on load (defensive)
  const dlgOpen0 = await page.evaluate(() =>
    !!(document.getElementById('dlg') && document.getElementById('dlg').classList.contains('show')));
  if (dlgOpen0) await page.evaluate(() => document.getElementById('dlg-ok').click());
  verdict('welcome-dialog', true, dlgOpen0 ? 'dialog on load dismissed' : 'no dialog on load');

  const appReady = await page.evaluate(() => !!(window.RM && RM.app && RM.app.state && RM.app.show));
  verdict('app-initialized', appReady, 'RM.app present');
  if (!appReady) throw new Error('app did not initialize');

  // in-page click (same handlers a real tap triggers)
  const clickSel = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error('missing element: ' + s);
    el.click();
  }, sel);
  const noErrAt = () => pageErrors.length;
  const toastTxt = () => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  const dlgShown = () => page.evaluate(() => document.getElementById('dlg').classList.contains('show'));
  const dlgInfo = () => page.evaluate(() => ({
    title: document.getElementById('dlg-title').textContent,
    body: document.getElementById('dlg-body').innerText,
    num: (document.getElementById('dlg-num') || {}).value,
  }));
  const curScreen = () => page.evaluate(() => RM.app.state.screen);
  const goEditor = () => page.evaluate(() => RM.app.show('editor'));

  // ================= 1. EDITOR NAV =================
  // 1a. with NO audio: nav guard -> friendly toast + import screen (no crash)
  let e0 = noErrAt();
  await clickSel('.navbtn[data-screen="editor"]');
  await sleep(500);
  const t1 = await toastTxt();
  const s1 = await curScreen();
  verdict('nav-editor-noaudio', pageErrors.length === e0 &&
    /import audio/i.test(t1) && s1 === 'import',
    `toast="${t1.slice(0, 40)}", screen="${s1}" (graceful degrade expected)`);

  // ================= 2a. EVERY EDIT BUTTON, NO AUDIO =================
  // fade/gain open dialogs only WITH audio; with no audio -> toast, no dialog
  const toolsNoAudio = [
    'ed-trim', 'ed-cut', 'ed-delete', 'ed-split', 'ed-copy', 'ed-paste', 'ed-duplicate',
    'ed-fadein', 'ed-fadeout', 'ed-gain-up', 'ed-gain-dn', 'ed-reverse',
    'ed-undo', 'ed-redo', 'ed-marker-add', 'ed-loop', 'ed-play', 'ed-stop',
  ];
  for (const id of toolsNoAudio) {
    e0 = noErrAt();
    await clickSel('#' + id);
    await sleep(400);
    const noCrash = pageErrors.length === e0;
    const noDlg = !(await dlgShown());
    const tt = await toastTxt();
    await page.evaluate(() => { if (RM.app.state.screen !== 'editor') RM.app.show('editor'); });
    await sleep(150);
    verdict(`noaudio:${id}`, noCrash && noDlg,
      noCrash ? (noDlg ? `graceful; toast="${tt.slice(0, 50)}"` : 'UNEXPECTED DIALOG OPENED')
              : `PAGEERROR: ${pageErrors[pageErrors.length - 1]}`);
  }

  // ================= 2b. LOAD SYNTHETIC AUDIO =================
  await page.evaluate(() => {
    const ctx = RM.audio.ensureCtx();
    const sr = 44100, dur = 8, len = sr * dur;
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const g = 0.25 + 0.25 * Math.sin(2 * Math.PI * 1.25 * t);
        d[i] = g * (0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * (c ? 554 : 659) * t));
      }
    }
    RM.app.loadAudioBuffer(buf, 'test-tone.wav');
  });
  let viewReady = false;
  for (let i = 0; i < 40 && !viewReady; i++) {
    await sleep(300);
    viewReady = await page.evaluate(() => !!(RM.app.state.viewBuffer && RM.app.state.viewBuffer.length));
  }
  verdict('audio-loaded', viewReady, '8s stereo buffer loaded, viewBuffer rendered');
  verdict('load-clean', pageErrors.length === 0, `pageErrors so far: ${pageErrors.length}`);

  // 1b. with audio: nav button activates editor
  e0 = noErrAt();
  await page.evaluate(() => RM.app.show('home'));
  await sleep(200);
  await clickSel('.navbtn[data-screen="editor"]');
  await sleep(500);
  const editorActive = await page.evaluate(() =>
    document.getElementById('screen-editor').classList.contains('active'));
  verdict('nav-editor-loaded', pageErrors.length === e0 && editorActive,
    'editor screen active via bottom nav after audio load');

  // selection 1.0s -> 3.0s
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('ed-sel-a', 1); set('ed-sel-b', 3);
  });
  await sleep(300);

  const bufDur = () => page.evaluate(() => RM.app.state.viewBuffer ? RM.app.state.viewBuffer.duration : -1);
  const peak = () => page.evaluate(() => {
    const d = RM.app.state.viewBuffer.getChannelData(0);
    let p = 0; for (let i = 0; i < d.length; i += 37) { const a = Math.abs(d[i]); if (a > p) p = a; }
    return p;
  });
  const headEnergy = () => page.evaluate(() => {
    const d = RM.app.state.viewBuffer.getChannelData(0);
    let s = 0; for (let i = 0; i < 200; i++) s += d[i] * d[i];
    return s;
  });
  const tailAbs = () => page.evaluate(() => {
    const d = RM.app.state.viewBuffer.getChannelData(0);
    return Math.abs(d[d.length - 5]);
  });
  const opsLen = () => page.evaluate(() => RM.app.state.project.ops.length);
  const W = 2400; // wait after each op (chunked render)

  const d0 = await bufDur();

  // ================= 2c. EDIT OPS WITH AUDIO =================
  // TRIM -> UNDO -> REDO -> UNDO
  e0 = noErrAt();
  await clickSel('#ed-trim'); await sleep(W);
  const dTrim = await bufDur();
  verdict('tool:ed-trim', pageErrors.length === e0 && Math.abs(dTrim - 2) < 0.1,
    `duration ${d0.toFixed(2)} -> ${dTrim.toFixed(2)}s (expect ~2.0)`);
  await clickSel('#ed-undo'); await sleep(W);
  verdict('tool:ed-undo', pageErrors.length === e0 && Math.abs(await bufDur() - d0) < 0.15,
    `undo restores ${d0.toFixed(2)}s`);
  await clickSel('#ed-redo'); await sleep(W);
  verdict('tool:ed-redo', pageErrors.length === e0 && Math.abs(await bufDur() - 2) < 0.15,
    'redo re-applies trim');
  await clickSel('#ed-undo'); await sleep(W);

  // CUT
  e0 = noErrAt();
  await clickSel('#ed-cut'); await sleep(W);
  verdict('tool:ed-cut', pageErrors.length === e0 && Math.abs(await bufDur() - 6) < 0.15,
    `cut [1,3] of 8s -> ~6s, toast="${(await toastTxt()).slice(0, 40)}"`);
  await clickSel('#ed-undo'); await sleep(W);

  // DELETE (no clipboard copy)
  e0 = noErrAt();
  await page.evaluate(() => RM.proj.clearClipboard());
  await clickSel('#ed-delete'); await sleep(W);
  const clipAfterDel = await page.evaluate(() => !!RM.proj.getClipboard());
  verdict('tool:ed-delete', pageErrors.length === e0 && Math.abs(await bufDur() - 6) < 0.15 && !clipAfterDel,
    `delete [1,3] -> ~6s, clipboard untouched (${clipAfterDel})`);
  await clickSel('#ed-undo'); await sleep(W);

  // COPY -> PASTE
  e0 = noErrAt();
  await clickSel('#ed-copy'); await sleep(1200);
  const clip = await page.evaluate(() => !!RM.proj.getClipboard());
  verdict('tool:ed-copy', pageErrors.length === e0 && clip,
    `clipboard set; toast="${(await toastTxt()).slice(0, 30)}"`);
  await clickSel('#ed-paste'); await sleep(W);
  verdict('tool:ed-paste', pageErrors.length === e0 && (await bufDur()) > d0 + 1.8,
    `paste -> ${(await bufDur()).toFixed(2)}s (expect ~10)`);
  await clickSel('#ed-undo'); await sleep(W);

  // DUPLICATE
  e0 = noErrAt();
  await clickSel('#ed-duplicate'); await sleep(W);
  verdict('tool:ed-duplicate', pageErrors.length === e0 && Math.abs(await bufDur() - 16) < 0.3,
    `duplicate -> ${(await bufDur()).toFixed(2)}s (expect ~16), toast="${(await toastTxt()).slice(0, 30)}"`);
  await clickSel('#ed-undo'); await sleep(W);

  // SPLIT at position 0 (player at 0) -> tail to clipboard, view ~0s
  e0 = noErrAt();
  await clickSel('#ed-split'); await sleep(1600);
  const splitClip = await page.evaluate(() => !!RM.proj.getClipboard());
  verdict('tool:ed-split', pageErrors.length === e0 && splitClip,
    `toast="${(await toastTxt()).slice(0, 50)}", clipboard=${splitClip}`);
  await clickSel('#ed-undo'); await sleep(W);
  verdict('tool:ed-split-undo', Math.abs(await bufDur() - d0) < 0.15, 'undo restores full length');

  // ---- FADE IN: dialog cancel, then apply ----
  e0 = noErrAt();
  await clickSel('#ed-fadein'); await sleep(600);
  const fi = await dlgInfo();
  verdict('tool:ed-fadein-dialog', pageErrors.length === e0 && (await dlgShown()) &&
    fi.title === 'Fade In' && /Fade duration/.test(fi.body) && fi.num === '2',
    `title="${fi.title}", default=${fi.num}s`);
  const fiEng = await page.evaluate(() => document.getElementById('dlg').innerText);
  verdict('english:fadein-dialog', !/[।-ॿ]/.test(fiEng), 'dialog English-only');
  await clickSel('#dlg-cancel'); await sleep(400);
  verdict('tool:ed-fadein-cancel', !(await dlgShown()) && (await opsLen()) === 0,
    'cancel leaves op list untouched');
  const h0 = await headEnergy();
  await clickSel('#ed-fadein'); await sleep(600);
  await clickSel('#dlg-ok'); await sleep(W);
  const h1 = await headEnergy();
  verdict('tool:ed-fadein-apply', pageErrors.length === e0 && h1 < h0 * 0.3 && (await opsLen()) === 1,
    `head energy ${h0.toFixed(2)} -> ${h1.toFixed(4)}`);
  await clickSel('#ed-undo'); await sleep(W);

  // ---- FADE OUT ----
  e0 = noErrAt();
  await clickSel('#ed-fadeout'); await sleep(600);
  const fo = await dlgInfo();
  verdict('tool:ed-fadeout-dialog', pageErrors.length === e0 && fo.title === 'Fade Out' && fo.num === '3',
    `title="${fo.title}", default=${fo.num}s`);
  await clickSel('#dlg-ok'); await sleep(W);
  const tA = await tailAbs();
  verdict('tool:ed-fadeout-apply', pageErrors.length === e0 && tA < 0.01 &&
    Math.abs(await bufDur() - d0) < 0.15,
    `tail sample=${tA.toExponential(2)} (expect ~0), duration kept`);
  await clickSel('#ed-undo'); await sleep(W);

  // ---- GAIN +3 / -3 via dialogs ----
  e0 = noErrAt();
  await clickSel('#ed-gain-up'); await sleep(600);
  const gup = await dlgInfo();
  verdict('tool:ed-gain-up-dialog', pageErrors.length === e0 && gup.title === 'Gain' && gup.num === '3',
    `title="${gup.title}", default=${gup.num} dB`);
  const p0 = await peak();
  await clickSel('#dlg-ok'); await sleep(W);
  const p1 = await peak();
  const ratio = p1 / p0;
  verdict('tool:ed-gain-up-apply', pageErrors.length === e0 && Math.abs(ratio - 1.4125) < 0.25,
    `peak ${p0.toFixed(3)} -> ${p1.toFixed(3)} (ratio ${ratio.toFixed(3)}, expect ~1.41)`);
  await clickSel('#ed-gain-dn'); await sleep(600);
  const gdn = await dlgInfo();
  verdict('tool:ed-gain-dn-dialog', pageErrors.length === e0 && gdn.num === '-3',
    `default=${gdn.num} dB`);
  await clickSel('#dlg-ok'); await sleep(W);
  const p2 = await peak();
  verdict('tool:ed-gain-dn-apply', pageErrors.length === e0 && Math.abs(p2 - p0) / p0 < 0.25,
    `peak after -3dB: ${p2.toFixed(3)} (orig ${p0.toFixed(3)})`);
  await clickSel('#ed-undo'); await sleep(1200);
  await clickSel('#ed-undo'); await sleep(W);

  // ---- REVERSE (signal check) ----
  e0 = noErrAt();
  const endsBefore = await page.evaluate(() => {
    const d = RM.app.state.viewBuffer.getChannelData(0);
    return { first: d[0], last: d[d.length - 1] };
  });
  await clickSel('#ed-reverse'); await sleep(W);
  const endsAfter = await page.evaluate(() => {
    const d = RM.app.state.viewBuffer.getChannelData(0);
    return { first: d[0], last: d[d.length - 1], len: d.length };
  });
  const revOk = pageErrors.length === e0 &&
    Math.abs(endsAfter.first - endsBefore.last) < 1e-6 &&
    Math.abs(endsAfter.last - endsBefore.first) < 1e-6;
  verdict('tool:ed-reverse', revOk,
    `first/last swapped: ${endsBefore.first.toFixed(4)}/${endsBefore.last.toFixed(4)} -> ${endsAfter.first.toFixed(4)}/${endsAfter.last.toFixed(4)}`);
  await clickSel('#ed-undo'); await sleep(W);

  // ---- LOOP toggle ----
  e0 = noErrAt();
  await clickSel('#ed-loop'); await sleep(400);
  const loopOn = await page.evaluate(() => RM.app.state.project.settings.loop === true &&
    document.getElementById('ed-loop').classList.contains('on'));
  verdict('tool:ed-loop-on', pageErrors.length === e0 && loopOn, 'settings.loop=true, .on set');
  await clickSel('#ed-loop'); await sleep(400);
  verdict('tool:ed-loop-off', (await page.evaluate(() => RM.app.state.project.settings.loop)) === false,
    'second click disables loop');

  // ---- MARKER ----
  e0 = noErrAt();
  await clickSel('#ed-marker-add'); await sleep(500);
  const mk = await page.evaluate(() => ({
    n: RM.app.state.project.settings.markers.length,
    rows: document.querySelectorAll('#ed-markers .marker-row').length,
  }));
  verdict('tool:ed-marker-add', pageErrors.length === e0 && mk.n === 1 && mk.rows === 1,
    `markers=${mk.n}, rendered=${mk.rows}`);

  // ---- ZOOM / SCROLL / VOL / PAN ----
  e0 = noErrAt();
  await page.$eval('#ed-zoom', (el) => { el.value = 8; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  await page.$eval('#ed-scroll', (el) => { el.value = 50; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  verdict('controls:zoom+scroll', pageErrors.length === e0, 'zoom 8x + scroll 50%: no error');
  await page.$eval('#ed-vol', (el) => { el.value = 50; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  const volV = await page.evaluate(() => document.getElementById('ed-vol-v').textContent);
  verdict('control:volume', pageErrors.length === e0 && volV === '50%', `label="${volV}"`);
  await page.$eval('#ed-pan', (el) => { el.value = -100; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  const panV = await page.evaluate(() => RM.app.state.project.settings.pan);
  await page.$eval('#ed-pan', (el) => { el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); });
  verdict('control:pan', pageErrors.length === e0 && panV === -1, `settings.pan=${panV} at full-left`);

  // ================= 4. SPEED 0.5x - 2.0x =================
  const spd = await page.evaluate(() => {
    const el = document.getElementById('ed-speed');
    return { min: el.min, max: el.max };
  });
  verdict('speed-range', spd.min === '50' && spd.max === '200',
    `slider min=${spd.min} max=${spd.max} (=0.5x-2.0x)`);
  e0 = noErrAt();
  for (const [val, label, rate] of [[50, '0.50×', 0.5], [200, '2.00×', 2], [100, '1.00×', 1]]) {
    await page.$eval('#ed-speed', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, val);
    await sleep(250);
    const got = await page.evaluate(() => ({
      label: document.getElementById('ed-speed-v').textContent,
      rate: RM.app.state.project.settings.speed,
    }));
    verdict(`speed-${rate}x`, pageErrors.length === e0 && got.label === label && got.rate === rate,
      `label="${got.label}" rate=${got.rate}`);
  }

  // ---- PLAY / STOP ----
  e0 = noErrAt();
  await clickSel('#ed-play'); await sleep(800);
  await clickSel('#ed-stop'); await sleep(400);
  verdict('control:play-stop', pageErrors.length === e0, 'play then stop: no pageerror');

  // ================= SCREENSHOT 1: editor main =================
  await goEditor();
  await sleep(600);
  await page.screenshot({ path: OUT + '/01-editor-main.png' });

  // ================= 3. ENGLISH CHECK =================
  const checkEnglish = async (screenId, name) => {
    const txt = await page.evaluate((id) => document.getElementById(id).innerText, screenId);
    const dev = (txt.match(/[।-ॿ]/g) || []).length;
    const btns = await page.evaluate((id) =>
      Array.from(document.querySelectorAll('#' + id + ' button')).map((b) => b.innerText.trim()), screenId);
    const blank = btns.filter((t) => !t).length;
    verdict(`english:${name}-no-devanagari`, dev === 0, `devanagari chars: ${dev}`);
    verdict(`english:${name}-no-undefined`, !/\bundefined\b/.test(txt), 'no "undefined" text');
    verdict(`english:${name}-no-null`, !/\bnull\b/.test(txt), 'no "null" text');
    verdict(`english:${name}-buttons-labeled`, blank === 0,
      `${btns.length} buttons, blank: ${blank}`);
  };
  await checkEnglish('screen-editor', 'editor');

  // ================= 7. MIXER =================
  e0 = noErrAt();
  await clickSel('.navbtn[data-screen="mixer"]');
  await sleep(800);
  const mixerActive = await page.evaluate(() =>
    document.getElementById('screen-mixer').classList.contains('active'));
  verdict('nav-mixer', pageErrors.length === e0 && mixerActive, 'mixer screen active');
  await page.screenshot({ path: OUT + '/03-mixer.png' });
  await checkEnglish('screen-mixer', 'mixer');
  const trackRows = await page.evaluate(() =>
    document.querySelectorAll('#mixer-tracks .track-card, #mixer-tracks .mx-track, #mixer-tracks .track').length);
  verdict('mixer:tracks-rendered', trackRows > 0, `track rows: ${trackRows}`);
  e0 = noErrAt();
  await clickSel('#mx-play-all'); await sleep(600);
  await clickSel('#mx-stop-all'); await sleep(400);
  verdict('mixer:play-stop', pageErrors.length === e0, 'play-all/stop-all: no error');

  // bottom nav English
  const navText = await page.evaluate(() => document.getElementById('bottomnav').innerText);
  verdict('english:nav', !/[।-ॿ]/.test(navText), `nav: ${JSON.stringify(navText.replace(/\n/g, ' '))}`);

  // ================= SCREENSHOT 2: open tool dialog =================
  e0 = noErrAt();
  await page.evaluate(() => RM.app.show('projects'));
  await sleep(600);
  await clickSel('#proj-new');
  await sleep(700);
  const dlg2 = await dlgShown();
  verdict('dialog:new-project', pageErrors.length === e0 && dlg2, 'New Project dialog opens');
  await page.screenshot({ path: OUT + '/02-tool-dialog.png' });
  const dlg2txt = await page.evaluate(() => document.getElementById('dlg').innerText);
  verdict('english:new-project-dialog', !/[।-ॿ]/.test(dlg2txt) && !/\bundefined\b/.test(dlg2txt),
    `dialog: ${JSON.stringify(dlg2txt.slice(0, 50))}`);
  await clickSel('#dlg-cancel');
  await sleep(400);

  await browser.close();

  // ================= 6. ERROR REPORT =================
  console.log('\n===== PAGE ERRORS (' + pageErrors.length + ') =====');
  pageErrors.forEach((c, i) => console.log(`[${i}] ${c}`));
  console.log('\n===== CONSOLE ERRORS (' + consoleErrors.length + ') =====');
  consoleErrors.forEach((c, i) => console.log(`[${i}] ${c}`));

  const passed = verdicts.filter((v) => v.status === 'PASS').length;
  console.log(`\n===== TOTAL: ${verdicts.length}, PASS: ${passed}, FAIL: ${failures.length} =====`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  FAIL: ' + f));
    process.exit(1);
  }
  console.log('E2E sweep clean.');
  process.exit(0);
})().catch((e) => {
  console.error('SWEEP CRASHED:', (e && e.stack) || e);
  console.log(`\nVERDICTS SO FAR: ${verdicts.filter((v) => v.status === 'PASS').length}/${verdicts.length} passed`);
  failures.forEach((f) => console.log('  FAIL: ' + f));
  console.log(`\nPAGE ERRORS (${pageErrors.length}):`); pageErrors.forEach((c, i) => console.log(`[${i}] ${c}`));
  console.log(`\nCONSOLE ERRORS (${consoleErrors.length}):`); consoleErrors.forEach((c, i) => console.log(`[${i}] ${c}`));
  process.exit(2);
});
