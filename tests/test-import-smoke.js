#!/usr/bin/env node
/*
 * RuhMix import-hardening smoke test (Puppeteer + chrome-headless-shell).
 *
 * Pass A (no Android bridge): index.html loads with 0 pageerrors,
 * window.RH exists with callable helpers, the Import screen opens,
 * Files tab visible, Music tab gracefully hidden (no crash).
 * Pass B (mock Android.listMusic): Music tab appears, opens, and renders
 * the track list delivered through window.onMusicListed.
 * Pass C (static): Devanagari sweep = 0 and public "V2" sweep = 0 over
 * import-hardening.js + import UI strings.
 *
 * Exit code: 0 if every test passes, 1 otherwise.
 * Prints one PASS/FAIL line per test.
 */
'use strict';
const fs = require('fs');
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';
const WWW = '/home/hatch/workspace/ruhmix/www';
const RH_SRC = WWW + '/js/import-hardening.js';

const pageErrors = [];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = [];
  const add = (name, pass, detail) =>
    results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });

  async function newPage(mockAndroid) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => { pageErrors.push(e.message); });
    if (mockAndroid) {
      await page.evaluateOnNewDocument(() => {
        window.Android = {
          listMusic: function () {
            window.onMusicListed(JSON.stringify({
              status: 'ok',
              tracks: [
                { uri: 'content://media/1', title: 'Mock Song', artist: 'Mock Artist', durationMs: 180000 },
                { uri: 'content://media/2', title: 'Second Track', artist: 'Other Artist', durationMs: 240000 },
              ],
            }));
          },
        };
      });
    }
    await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(
      "window.RM && window.RM.app && typeof window.RM.app.show === 'function' && window.RH",
      { timeout: 60000 }
    );
    return page;
  }

  try {
    /* ================= Pass A: no bridge ================= */
    const pA = await newPage(false);
    add('A1. index.html loads with import-hardening.js wired',
      pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : 'no pageerrors');

    const rhA = await pA.evaluate(() => {
      const fns = ['sniffAudioType', 'stripId3v2', 'findFirstMp3Frame', 'precheckAudio', 'classifyError', 'decodeStages'];
      const missing = fns.filter((f) => typeof window.RH[f] !== 'function');
      let smoke = 'n/a';
      try {
        const s = window.RH.sniffAudioType(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
        const p = window.RH.precheckAudio(new ArrayBuffer(0), 'x.mp3');
        const c = window.RH.classifyError('empty', 'x.mp3');
        const fr = window.RH.findFirstMp3Frame(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
        const st = window.RH.stripId3v2(new Uint8Array([0xFF, 0xFB, 0x90, 0x00]).buffer);
        const ds = window.RH.decodeStages();
        smoke = (s === 'mp3' && p.kind === 'empty' && c.title && fr === 0 && st && ds.length === 3) ? 'ok' : 'bad-values';
      } catch (e) { smoke = 'threw: ' + (e && e.message); }
      return { missing, smoke };
    });
    add('A2. window.RH exposes all helpers', rhA.missing.length === 0,
      rhA.missing.length ? 'missing: ' + rhA.missing.join(',') : 'all present');
    add('A3. RH helpers callable with sane returns', rhA.smoke === 'ok', rhA.smoke);

    const scrA = await pA.evaluate(() => {
      window.RM.app.show('import');
      const sec = document.getElementById('screen-import');
      const tabF = document.getElementById('tab-files');
      const tabM = document.getElementById('tab-music');
      const cs = tabM ? window.getComputedStyle(tabM) : null;
      return {
        active: !!(sec && sec.classList.contains('active')),
        tabFilesVisible: !!tabF && window.getComputedStyle(tabF).display !== 'none',
        tabMusicHidden: !!tabM && cs.display === 'none',
      };
    });
    add('A4. Import screen opens', scrA.active, JSON.stringify(scrA));
    add('A5. Files tab visible', scrA.tabFilesVisible, '');
    add('A6. Music tab gracefully hidden without Android bridge (no crash)',
      scrA.tabMusicHidden, scrA.tabMusicHidden ? 'display:none' : 'VISIBLE — not graceful');
    await pA.click('#tab-files');
    const paneA = await pA.evaluate(() => !document.getElementById('pane-files').hidden);
    add('A7. Files tab click shows files pane', paneA, '');
    await pA.close();

    /* ================= Pass B: mock bridge ================= */
    const pB = await newPage(true);
    const scrB = await pB.evaluate(() => {
      window.RM.app.show('import');
      const tabM = document.getElementById('tab-music');
      return { visible: !!tabM && window.getComputedStyle(tabM).display !== 'none' };
    });
    add('B1. Music tab visible when Android.listMusic exists', scrB.visible, '');
    await pB.click('#tab-music');
    await pB.waitForFunction(
      "!document.getElementById('pane-music').hidden && " +
      "document.getElementById('music-list').textContent.indexOf('Mock Song') !== -1",
      { timeout: 10000 }
    );
    const musicTxt = await pB.evaluate(() => document.getElementById('music-list').textContent);
    add('B2. Music tab opens and renders mocked track list',
      musicTxt.includes('Mock Song') && musicTxt.includes('Mock Artist'),
      musicTxt.trim().slice(0, 80).replace(/\s+/g, ' '));
    await pB.close();

    add('C0. zero pageerrors across both passes', pageErrors.length === 0,
      pageErrors.length ? pageErrors.join(' | ') : 'clean');
  } catch (e) {
    add('HARNESS', false, 'exception: ' + (e && e.stack || e));
  }

  /* ================= Pass C: static sweeps ================= */
  try {
    const deva = /[ऀ-ॿ]/;
    const rhSrc = fs.readFileSync(RH_SRC, 'utf8');
    add('C1. Devanagari sweep: import-hardening.js = 0', !deva.test(rhSrc), '');

    const html = fs.readFileSync(WWW + '/index.html', 'utf8');
    const secStart = html.indexOf('screen-import');
    const secEnd = html.indexOf('</section>', secStart);
    const importHtml = html.slice(secStart, secEnd);
    const appJs = fs.readFileSync(WWW + '/js/app.js', 'utf8').split('\n');
    const importJs = appJs.slice(399, 925).join('\n'); // import + music-library region
    const uiHits = (importHtml.match(/[ऀ-ॿ]/g) || []).length + (importJs.match(/[ऀ-ॿ]/g) || []).length;
    add('C2. Devanagari sweep: import UI strings = 0', uiHits === 0, uiHits + ' hits');

    const v2 = /\bV2\b/;
    const v2hits = (rhSrc.match(/\bV2\b/g) || []).length + (importHtml.match(/\bV2\b/g) || []).length;
    add('C3. Public "V2" sweep: hardening + import UI = 0', v2hits === 0 && !v2.test(importJs),
      v2hits + ' hits');
  } catch (e) { add('C. static sweeps', false, e && e.stack || e); }

  let fails = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    if (!r.pass) fails++;
  }
  console.log('---');
  console.log(fails === 0 ? `ALL ${results.length} TESTS PASSED` : `${fails}/${results.length} TESTS FAILED`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
