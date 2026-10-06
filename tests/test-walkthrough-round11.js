#!/usr/bin/env node
/*
 * RuhMix Round-11 full walkthrough: all 16 screens, zero pageerrors,
 * zero console errors, no blank buttons/labels.
 * Exit 0 = all pass.
 */
'use strict';
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';

let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('PASS', n, d ? ' — ' + d : ''); };
const no = (n, d) => { fail++; console.log('FAIL', n, d ? ' — ' + d : ''); };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.app && RM.ux', { timeout: 60000 });
  await page.evaluate(() => {
    const ctx = RM.audio.ensureCtx();
    const buf = ctx.createBuffer(2, 44100 * 4, 44100);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.35 * Math.sin(2 * Math.PI * 330 * i / 44100);
    buf.getChannelData(1).set(d);
    RM.app.loadAudioBuffer(buf, 'walkthrough-track');
  });
  await page.waitForFunction('RM.app.state.viewBuffer', { timeout: 20000 });
  ok('boot', 'audio loaded');

  const screens = await page.evaluate(() =>
    Array.from(document.querySelectorAll('section.screen')).map((s) => s.id.replace(/^screen-/, '')));
  ok('screen-count', screens.length + ' screens: ' + screens.join(','));
  if (screens.length !== 16) no('screen-count-16', 'found ' + screens.length);

  for (const s of screens) {
    await page.evaluate((n) => RM.app.show(n), s);
    await new Promise((r) => setTimeout(r, 350));
    const r = await page.evaluate((n) => {
      const sec = document.getElementById('screen-' + n);
      const active = sec && sec.classList.contains('active');
      const blankBtns = [];
      sec.querySelectorAll('button').forEach((b) => {
        const t = (b.textContent || '').trim();
        const aria = (b.getAttribute('aria-label') || '').trim();
        const hasIcon = b.querySelector('img,svg');
        if (!t && !aria && !hasIcon) blankBtns.push(b.id || b.className || 'unnamed');
      });
      const blankLabels = [];
      sec.querySelectorAll('label').forEach((l) => {
        if (!(l.textContent || '').trim() && !l.querySelector('input,select,button')) blankLabels.push(l.className || 'unnamed');
      });
      const h = sec.querySelector('h1,h2,h3');
      return { active, blankBtns, blankLabels, hasHeading: !!h, heading: h ? h.textContent.trim().slice(0, 40) : null };
    }, s);
    if (!r.active) { no('screen[' + s + ']-active', 'not active after show()'); continue; }
    if (r.blankBtns.length) no('screen[' + s + ']-blank-buttons', r.blankBtns.join(','));
    else if (r.blankLabels.length) no('screen[' + s + ']-blank-labels', r.blankLabels.join(','));
    else ok('screen[' + s + ']', (r.heading || 'no-heading') + ' — clean');
  }

  // Export buttons presence on all 7 screens.
  const expBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ux-export-btn')).map((b) => b.getAttribute('data-from')));
  const want = ['editor', 'remix', 'slowed', 'stems', 'mixer', 'master', 'record'];
  const missing = want.filter((w) => !expBtns.includes(w));
  if (missing.length) no('export-buttons-all-7', 'missing: ' + missing.join(','));
  else ok('export-buttons-all-7', expBtns.join(','));

  // Devanagari sweep (English-only build) + version check.
  const dev = await page.evaluate(() => {
    const hits = [];
    document.querySelectorAll('section.screen').forEach((sec) => {
      const t = sec.innerText || '';
      if (/[\u0900-\u097F]/.test(t)) hits.push(sec.id);
    });
    return hits;
  });
  if (dev.length) no('no-devanagari', dev.join(','));
  else ok('no-devanagari', 'English-only clean');

  if (pageErrors.length) no('zero-pageerrors', pageErrors.length + ': ' + pageErrors.slice(0, 3).join(' | '));
  else ok('zero-pageerrors', 'clean');
  if (consoleErrors.length) no('zero-console-errors', consoleErrors.length + ': ' + consoleErrors.slice(0, 3).join(' | '));
  else ok('zero-console-errors', 'clean');

  await browser.close();
  console.log('\n==== WALKTHROUGH: ' + pass + ' PASS / ' + fail + ' FAIL ====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e); process.exit(1); });
