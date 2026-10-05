#!/usr/bin/env node
/*
 * RuhMix onboarding + "What's New" test (Puppeteer + chrome-headless-shell).
 * - First run: onboarding overlay shows (4 slides, dots, Skip, Get Started,
 *   RuhMix + "By Hasnain Khan" branding), swipe/dots navigate.
 * - After Get Started: flags set, overlay gone; reload => not shown again.
 * - Upgrade (10, current 12): "What's New" shows once with
 *   bullets; "Got it" stamps the flag; reload => not shown.
 * - Settings > "Replay Intro" re-opens onboarding.
 * Exit code: 0 all pass, 1 otherwise. Prints one PASS/FAIL line per test.
 */
'use strict';
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';
const pageErrors = [];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = [];
  const add = (name, pass, detail) =>
    results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });

  const page = await browser.newPage();
  page.on('pageerror', (e) => { pageErrors.push(e.message); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.RM && RM.onboard, { timeout: 15000 });
  // fresh profile: clear flags, then reload as a true first run
  await page.evaluate(() => {
    localStorage.removeItem('ruhmix.introSeen');
    localStorage.removeItem('ruhmix.lastSeenVersion');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#ob-ov.show', { timeout: 8000 });

  // T1: onboarding visible on first run with 4 slides + dots + skip
  let t1 = await page.evaluate(() => ({
    shown: !!document.querySelector('#ob-ov.show'),
    slides: document.querySelectorAll('.ob-slide').length,
    dots: document.querySelectorAll('.ob-dot').length,
    skip: !!document.querySelector('#ob-skip'),
    brand: (document.querySelector('#ob-ov') || {}).textContent || '',
  }));
  add('T1 onboarding visible first-run (4 slides, 4 dots, skip, branding)',
    t1.shown && t1.slides === 4 && t1.dots === 4 && t1.skip &&
    /RuhMix/.test(t1.brand) && /By Hasnain Khan/.test(t1.brand),
    JSON.stringify({ shown: t1.shown, slides: t1.slides, dots: t1.dots }));

  // T2: slide content — headlines in expected order, CTA becomes Get Started
  const heads = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ob-head')).map((h) => h.textContent));
  add('T2 slide headlines Import/Edit/Remix/Export',
    JSON.stringify(heads) === JSON.stringify([
      'Import Your Music', 'Edit Like a Pro', 'Remix in One Tap', 'Export & Share']),
    heads.join(' | '));

  // T3: dots navigate; last slide CTA reads "Get Started"
  await page.evaluate(() => document.querySelectorAll('.ob-dot')[3].click());
  await page.waitForFunction(() =>
    document.querySelector('#ob-cta').textContent === 'Get Started');
  add('T3 dot navigation -> last slide shows "Get Started"', true);

  // T4: Get Started hides overlay + stamps flags
  await page.evaluate(() => document.querySelector('#ob-cta').click());
  await page.waitForFunction(() => !document.querySelector('#ob-ov.show'));
  const flags = await page.evaluate(() => ({
    seen: localStorage.getItem('ruhmix.introSeen'),
    lastV: localStorage.getItem('ruhmix.lastSeenVersion'),
  }));
  add('T4 Get Started hides overlay, flags stamped (seen=1, lastV=12)',
    flags.seen === '1' && flags.lastV === '12', JSON.stringify(flags));

  // T5: reload -> onboarding NOT shown again
  await page.reload({ waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 800));
  const obAfterReload = await page.evaluate(() => !!document.querySelector('#ob-ov.show'));
  add('T5 onboarding NOT shown on second run', !obAfterReload);

  // T6: simulate upgrade 10 -> 11: What's New shows once
  await page.evaluate(() => {
    localStorage.setItem('ruhmix.introSeen', '1');
    localStorage.setItem('ruhmix.lastSeenVersion', '10');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#wn-ov.show', { timeout: 8000 });
  const wn = await page.evaluate(() => ({
    title: (document.querySelector('.wn-title') || {}).textContent || '',
    bullets: document.querySelectorAll('.wn-list li').length,
    gotit: !!document.querySelector('#wn-gotit'),
  }));
  add('T6 upgrade 10->12 shows "What\'s New in RuhMix" with 8 bullets + Got it',
    wn.title === "What's New in RuhMix" && wn.bullets === 8 && wn.gotit,
    JSON.stringify({ title: wn.title, bullets: wn.bullets }));
  const bulletText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.wn-list li')).map((li) => li.textContent).join(' | '));
  add('T6b bullets are user-friendly (no jargon)',
    /2 taps/.test(bulletText) && /stutter/.test(bulletText) && !/convolver|dsp/i.test(bulletText),
    bulletText.slice(0, 80) + '...');

  // T7: Got it -> dialog gone, flag stamped 11, reload -> not shown again
  await page.evaluate(() => document.querySelector('#wn-gotit').click());
  await page.waitForFunction(() => !document.querySelector('#wn-ov.show'));
  const lastV2 = await page.evaluate(() => localStorage.getItem('ruhmix.lastSeenVersion'));
  await page.reload({ waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 800));
  const wnAgain = await page.evaluate(() => !!document.querySelector('#wn-ov.show'));
  add('T7 Got it stamps lastSeenVersion=12, dialog NOT shown again',
    lastV2 === '12' && !wnAgain, 'lastV=' + lastV2);

  // T8: Settings > "Replay Intro" re-opens onboarding
  await page.evaluate(() => RM.app.show('settings'));
  await page.waitForSelector('#set-replay-intro', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#set-replay-intro').click());
  await page.waitForSelector('#ob-ov.show', { timeout: 8000 });
  add('T8 Settings "Replay Intro" re-opens onboarding', true);
  // finish it via Skip so the app state is clean
  await page.evaluate(() => document.querySelector('#ob-skip').click());
  await page.waitForFunction(() => !document.querySelector('#ob-ov.show'));

  // T9: swipe navigation (touch) moves to next slide
  await page.evaluate(() => {
    localStorage.removeItem('ruhmix.introSeen');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#ob-ov.show', { timeout: 8000 });
  const touchStart = { clientX: 300, clientY: 400 };
  await page.touchscreen.touchStart(touchStart.clientX, touchStart.clientY);
  await page.touchscreen.touchMove(100, 400);
  await page.touchscreen.touchEnd();
  await new Promise((r) => setTimeout(r, 500));
  const cta = await page.evaluate(() => document.querySelector('#ob-cta').textContent);
  // after one left swipe, slide index = 1 -> CTA still "Next" (not first)
  const slideOk = await page.evaluate(() =>
    document.querySelectorAll('.ob-dot')[1].classList.contains('active'));
  add('T9 swipe left advances to slide 2', slideOk && cta === 'Next',
    'activeDot1=' + slideOk + ' cta=' + cta);

  // T10: Skip stamps flag even without finishing
  await page.evaluate(() => document.querySelector('#ob-skip').click());
  await page.waitForFunction(() => !document.querySelector('#ob-ov.show'));
  const seenAfterSkip = await page.evaluate(() => localStorage.getItem('ruhmix.introSeen'));
  add('T10 Skip hides overlay and stamps introSeen=1', seenAfterSkip === '1');

  // T11: zero pageerrors across the whole run
  add('T11 zero pageerrors', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' || '));

  let fails = 0;
  results.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : ''));
    if (!r.pass) fails++;
  });
  console.log('---');
  console.log(fails === 0 ? 'ALL TESTS PASSED' : fails + ' TEST(S) FAILED');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
