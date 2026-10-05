#!/usr/bin/env node
/*
 * RuhMix recent-files quick access test (Puppeteer + chrome-headless-shell).
 *
 * 1. Home loads: "Recent Files" section exists, empty state shows the
 *    professional message, Clear button hidden.
 * 2. Simulated native import (window.onAudioPicked with a file:// URL, the
 *    same path the Android picker uses) -> entry appears in Recent Files
 *    with song name + duration.
 * 3. Tapping the row opens the song straight in the Editor (no picker).
 * 4. Reload -> list persists (localStorage).
 * 5. Stale entry (file deleted) -> tap -> toast "File no longer available"
 *    + entry removed.
 * 6. Clear button empties the list.
 * 7. List capped at 8 entries.
 * 8. Static sweeps: Devanagari = 0, "V2"/Muse/Claude branding = 0 in
 *    recent.js + new UI strings.
 *
 * Exit code: 0 if every test passes, 1 otherwise.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';
const WWW = '/home/hatch/workspace/ruhmix/www';
const WAV = '/tmp/recent-test-song.wav';

const pageErrors = [];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = [];
  const add = (name, pass, detail) =>
    results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });

  // Fresh WAV for this run (3s stereo).
  execSync('node ' + WWW + '/../tests/gen-test-wav.js ' + WAV + ' 3', { stdio: 'pipe' });
  const fileUrl = 'file://' + WAV;

  const page = await browser.newPage();
  page.on('pageerror', (e) => { pageErrors.push(e.message); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    "window.RM && window.RM.app && typeof window.RM.app.show === 'function' && window.RM.recent",
    { timeout: 60000 }
  );
  await page.evaluate(() => { try { localStorage.removeItem('ruhmix.recentFiles'); } catch (e) {} RM.recent.render(); });
  // Dismiss first-run onboarding overlay (sibling feature) so clicks land.
  await page.evaluate(() => {
    const skip = document.getElementById('ob-skip');
    if (skip) skip.click();
    const gotit = document.getElementById('wn-gotit');
    if (gotit) gotit.click();
  });
  await page.waitForFunction("!document.getElementById('ob-ov') && !document.getElementById('wn-ov')", { timeout: 10000 })
    .catch(() => {});

  // 1. Empty state
  add('recent section exists on home', await page.$('#recent-files') !== null);
  add('heading is "Recent Files"', (await page.$eval('#screen-home .sec-head h3', (el) => el.textContent)).trim() === 'Recent Files');
  const emptyTxt = await page.$eval('#recent-files', (el) => el.textContent);
  add('empty state professional message', /No recent files yet — pick a song to get started/.test(emptyTxt), emptyTxt.trim().slice(0, 80));
  add('clear button hidden when empty', await page.$eval('#recent-files-clear', (el) => el.style.display === 'none'));
  add('recent-files distinct from projects', await page.$('#home-recent') !== null);

  // 2. Import via native path -> appears in recent
  await page.evaluate((url) => { window.onAudioPicked({ ok: [url], failed: [] }); }, fileUrl);
  await page.waitForFunction(
    "window.RM && RM.recent.list().length === 1",
    { timeout: 30000 }
  );
  const rowTxt = await page.$eval('#recent-files .recent-file', (el) => el.textContent);
  add('recent row has play glyph', (await page.$eval('#recent-files .recent-file .rf-play', (el) => el.textContent)).trim() === '▶');
  add('recent row shows song name', /recent-test-song\.wav/.test(rowTxt), rowTxt.trim().slice(0, 60));
  add('recent row shows duration', /0:0[23]/.test(rowTxt), rowTxt.trim().slice(0, 60));
  add('clear button visible with entries', await page.$eval('#recent-files-clear', (el) => el.style.display !== 'none'));
  add('entry stored with cached file url', await page.evaluate(() => RM.recent.list()[0].url === 'file:///tmp/recent-test-song.wav'));

  // 3. Tap row -> editor opens directly
  await page.evaluate(() => RM.app.show('home'));
  await page.click('#recent-files .recent-file');
  await page.waitForFunction(
    "document.querySelector('#screen-editor').classList.contains('active')",
    { timeout: 30000 }
  );
  add('tap opens editor (no picker)', true);
  const meta = await page.$eval('#ed-meta', (el) => el.textContent);
  add('editor loaded the song', /recent-test-song\.wav/.test(meta), meta.slice(0, 80));

  // 4. Reload -> persists
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    "window.RM && window.RM.recent && RM.recent.list().length === 1",
    { timeout: 60000 }
  );
  add('recent persists across reload', true);
  add('recent re-rendered after reload', await page.$('#recent-files .recent-file') !== null);

  // 5. Stale entry (missing file) -> graceful
  await page.evaluate(() => {
    RM.recent.track('ghost-song.mp3', 'file:///tmp/definitely-not-here-xyz.mp3', 125, 0);
  });
  await page.waitForFunction("RM.recent.list().length === 2", { timeout: 5000 });
  await page.evaluate(() => RM.app.show('home'));
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#recent-files .recent-file'));
    rows[0].click(); // ghost entry is newest (top)
  });
  await page.waitForFunction("RM.recent.list().length === 1", { timeout: 15000 });
  add('missing file entry removed', true);
  const toastTxt = await page.$eval('#toast', (el) => el.textContent);
  add('graceful "File no longer available" message', /File no longer available/.test(toastTxt), toastTxt);

  // 6. Clear button
  await page.click('#recent-files-clear');
  await page.waitForFunction("RM.recent.list().length === 0", { timeout: 5000 });
  add('clear empties the list', true);
  const emptyAgain = await page.$eval('#recent-files', (el) => el.textContent);
  add('empty state returns after clear', /No recent files yet/.test(emptyAgain));

  // 7. Cap at 8
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) RM.recent.track('song' + i + '.mp3', 'file:///tmp/s' + i + '.mp3', 60 + i, 0);
  });
  const n = await page.evaluate(() => RM.recent.list().length);
  add('list capped at 8', n === 8, 'got ' + n);
  add('newest first', await page.evaluate(() => RM.recent.list()[0].name === 'song9.mp3'));

  // 8. Static sweeps
  const src = fs.readFileSync(WWW + '/js/recent.js', 'utf8') +
    fs.readFileSync(WWW + '/index.html', 'utf8');
  add('no Devanagari in new code', !/[\u0900-\u097F]/.test(src));
  add('no V2/Muse/Claude branding', !/(^|[^A-Za-z])(V2|Muse|Claude)([^A-Za-z]|$)/.test(src));

  add('zero pageerrors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();

  let fail = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' — ' + r.name + (r.detail ? ' — ' + r.detail : ''));
    if (!r.pass) fail++;
  }
  console.log(fail === 0 ? 'ALL ' + results.length + ' TESTS PASSED' : fail + ' FAILURES');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
