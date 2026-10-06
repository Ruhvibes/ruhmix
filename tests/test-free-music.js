#!/usr/bin/env node
/*
 * RuhMix Free Music Library E2E test (Puppeteer + chrome-headless-shell).
 *
 * - Home shows the "Free Music" section: 6 cards (name + style tag + BPM +
 *   duration + preview button + free-to-use note), subtitle
 *   "6 original tracks — more coming soon".
 * - Preview button plays/stops in place (no editor load).
 * - Tapping a card loads it into the Editor via the same hardened decode
 *   path as a normal import (fully offline): duration + license line verified.
 * - On one track: playback, FX (EQ + 8D), Auto Remix generate, DSP stem
 *   separation (Vocal Cut), MP3 export.
 *
 * Exit code: 0 if every test passes, 1 otherwise.
 */
'use strict';
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';

const EXPECT = [
  { name: 'Pop',       bpm: '120', dur: '0:32', secs: 32.5, tag: 'Upbeat' },
  { name: 'Lofi',      bpm: '80',  dur: '0:37', secs: 37.0, tag: 'Chill' },
  { name: 'EDM',       bpm: '128', dur: '0:31', secs: 31.4, tag: 'Energetic' },
  { name: 'Trap',      bpm: '140', dur: '0:35', secs: 35.5, tag: 'Dark' },
  { name: 'Sufi',      bpm: '85',  dur: '0:35', secs: 35.4, tag: 'Emotional' },
  { name: 'Piano',     bpm: '75',  dur: '0:34', secs: 34.0, tag: 'Emotional' },
];
const LICENSE = '© Original — Free to use in your projects';

const pageErrors = [];
const results = [];
const add = (name, pass, detail) =>
  results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });
const step = (m) => console.log('STEP:', m);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    "window.RM && window.RM.app && typeof window.RM.app.show === 'function'",
    { timeout: 60000 }
  );
  await new Promise((r) => setTimeout(r, 800));

  // ---- 1. Free Music section: 6 cards ----------------------------------
  const cards = await page.$$eval('#free-music .fm-card', (els) =>
    els.map((el) => el.innerText.replace(/\n/g, ' | '))
  );
  add('home: 6 free-music cards visible', cards.length === 6, cards.length + ' cards');
  EXPECT.forEach((e) => {
    const hit = cards.find((c) => c.includes(e.name) && c.includes(e.bpm + ' BPM') &&
      c.includes(e.dur) && c.includes(e.tag));
    add(`home: "${e.name}" card (${e.tag}, ${e.bpm} BPM, ${e.dur})`, !!hit, hit || 'missing');
  });
  const sub = await page.$eval('.fm-sub', (el) => el.innerText);
  add('home: honest subtitle (6 tracks, more coming soon)',
    /6 original tracks/i.test(sub) && /more coming soon/i.test(sub), sub);
  const noHype = await page.evaluate(() =>
    !document.body.innerText.match(/thousands of tracks/i));
  add('home: no false "thousands of tracks" claim', noHype, '');
  const prevBtns = await page.$$eval('#free-music .fm-play', (els) => els.length);
  add('home: every card has a preview button', prevBtns === 6, prevBtns + ' buttons');

  // ---- 2. Preview plays + stops in place --------------------------------
  step('preview start');
  await page.$$eval('#free-music .fm-play', (els) => els[3].click()); // Trap preview
  await page.waitForFunction("window.RM.app.fmPreviewId === 'trap'", { timeout: 30000 });
  const prevBtnState = await page.$$eval('#free-music .fm-play',
    (els) => els[3].classList.contains('playing') && els[3].textContent === '⏸');
  add('preview: Trap preview starts in place', prevBtnState === true, 'fmPreviewId=trap');
  const stillHome = await page.evaluate(() =>
    document.querySelector('#screen-home').classList.contains('active'));
  add('preview: stays on Home (no editor load)', stillHome === true, '');
  await page.$$eval('#free-music .fm-play', (els) => els[3].click()); // stop
  await new Promise((r) => setTimeout(r, 600));
  const stopped = await page.evaluate(() => window.RM.app.fmPreviewId === null);
  add('preview: stops on second tap', stopped === true, '');

  // ---- 3. Tap each card -> Editor loads ---------------------------------
  for (let i = 0; i < EXPECT.length; i++) {
    const e = EXPECT[i];
    step('load card ' + i);
    await page.$$eval('#free-music .fm-card', (els, idx) => els[idx].click(), i);
    // NOTE: state.buffer set hota hai sync, lekin ed-meta refreshView() ke
    // baad async update hota hai — isliye meta me current fileName dikhne
    // tak wait karo (warna pichhle track ka stale meta padha jata hai).
    await page.waitForFunction(
      "document.querySelector('#screen-editor').classList.contains('active') && window.RM.app.state.buffer && window.RM.app.state.fileName && document.getElementById('ed-meta').innerText.includes(window.RM.app.state.fileName)",
      { timeout: 60000 }
    );
    const got = await page.evaluate(() => ({
      dur: window.RM.app.state.buffer.duration,
      ch: window.RM.app.state.buffer.numberOfChannels,
      meta: document.getElementById('ed-meta').innerText,
      fname: window.RM.app.state.fileName,
      type: (window.RM.app.state.project.audioRef || {}).type,
    }));
    add(`${e.name}: decoded ~${e.secs}s stereo`, Math.abs(got.dur - e.secs) < 0.8 && got.ch === 2,
      `got ${got.dur.toFixed(1)}s, ${got.ch}ch, "${got.fname}", type=${got.type}`);
    add(`${e.name}: license line in track info`, got.meta.includes(LICENSE),
      got.meta.replace(/\n/g, ' | '));
    await page.evaluate(() => window.RM.app.show('home'));
    await new Promise((r) => setTimeout(r, 300));
  }

  // ---- 4. Full feature flow on Trap -------------------------------------
  step('flow: load trap');
  await page.$$eval('#free-music .fm-card', (els, idx) => els[idx].click(), 3);
  await page.waitForFunction(
    "document.querySelector('#screen-editor').classList.contains('active') && window.RM.app.state.buffer",
    { timeout: 60000 }
  );
  step('flow: play');
  await page.click('#ed-play');
  await new Promise((r) => setTimeout(r, 1500));
  const playing = await page.evaluate(() => window.RM.app.state.player.playing);
  add('flow: playback starts on library track', playing === true, 'playing=' + playing);
  await page.click('#ed-stop');

  step('flow: fx');
  await page.evaluate(() => window.RM.app.show('fx'));
  await page.evaluate(() => {
    const el = document.getElementById('fx-bass');
    el.value = '6'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const eqOk = await page.evaluate(() => window.RM.app.state.fx.eq3[0] === 6);
  add('flow: EQ applies on library track', eqOk, '');
  await page.click('#fx-8d-on');
  await new Promise((r) => setTimeout(r, 300));
  const spatialOk = await page.evaluate(() => window.RM.app.state.fx.spatial.mode === '8d');
  add('flow: 8D toggle wires on library track', spatialOk === true, '');
  await page.click('#fx-8d-on');

  step('flow: remix');
  await page.evaluate(() => window.RM.app.show('remix'));
  await new Promise((r) => setTimeout(r, 400));
  await page.$$eval('#remix-grid .style-card', (els) => els[4].click()); // EDM style on trap
  // evaluate-click: puppeteer mouse click kabhi overlay/scroll race me chhoot jata hai
  await page.evaluate(() => {
    const b = document.getElementById('remix-generate');
    b.scrollIntoView({ block: 'center' });
    b.click();
  });
  await new Promise((r) => setTimeout(r, 3000));
  step('remix debug: ' + await page.evaluate(() =>
    'btnDisabled=' + document.getElementById('remix-generate').disabled +
    ' status=' + document.getElementById('remix-status').innerText.slice(0, 100).replace(/\n/g, '|') +
    ' style=' + window.RM.app.state.remix.style));
  await page.waitForFunction(
    "document.getElementById('remix-status').innerText.includes('Tap Preview')",
    { timeout: 180000, polling: 1000 }
  );
  // NOTE: "Tap Preview" status render kickoff ke turant baad likha jata hai;
  // state.remixBuffer offline render complete hone par set hota hai (35s track
  // me kai second lag sakte hain) — isliye uske liye alag se wait karo.
  await page.waitForFunction(
    "!!window.RM.app.state.remixBuffer",
    { timeout: 180000, polling: 1000 }
  );
  const remixOk = await page.evaluate(() => !!window.RM.app.state.remixBuffer);
  add('flow: Auto Remix generates on library track', remixOk === true, '');

  step('flow: stems');
  await page.evaluate(() => window.RM.app.show('stems'));
  await new Promise((r) => setTimeout(r, 400));
  await page.$eval('#stems-grid [data-run="vocalcut"]', (el) => el.click());
  await page.waitForFunction(
    "document.getElementById('stems-status').innerText.includes('Done')",
    { timeout: 180000, polling: 1000 }
  );
  const stemRows = await page.$$eval('#stems-results > div', (els) => els.length);
  add('flow: Vocal Cut separates library track', stemRows > 0, stemRows + ' rows');

  step('flow: export');
  await page.evaluate(() => window.RM.app.show('export'));
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#exp-start');
  await page.waitForFunction(
    "document.getElementById('exp-share').style.display !== 'none'",
    { timeout: 240000, polling: 1000 }
  );
  const expStatus = await page.$eval('#exp-status', (el) => el.innerText);
  add('flow: MP3 export completes on library track', /Done/i.test(expStatus), expStatus);

  // ---- 5. page errors -----------------------------------------------------
  add('no page errors during library flows', pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 5).join(' ;; ') : '0 errors');

  await browser.close();

  let fail = 0;
  results.forEach((r) => {
    if (!r.pass) fail++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  });
  console.log(fail === 0 ? `\nALL ${results.length} TESTS PASSED` : `\n${fail}/${results.length} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST CRASH:', e && e.message);
  console.error('pageErrors:', pageErrors.slice(0, 5));
  process.exit(1);
});
