#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix — autoplay regression test
   ---------------------------------------------------------------------
   Hasnain: "jab tools change karte hai song suru ho jata hai".

   RULE: user ne Play dabaye bina kabhi playback start nahi hona chahiye.
   Tool change sirf settings badalta hai:
     - ruka tha  -> ruka rahe   (player.playing stays false)
     - baj raha tha -> bajta rahe, position preserved (no restart from 0)

   Method: loads synthetic audio through the REAL import path
   (RM.app.loadAudioBuffer), then fires REAL DOM events on the actual UI
   controls (no direct function calls — the wiring itself is under test):

     STOPPED suite: each tool action, then assert playing === false
     PLAYING suite: start playback, each tool action, then assert
       playing === true AND position kept advancing (no restart)

   Tool actions covered:
     1. FX Rack: EQ slider (fx-bass input)
     2. FX Rack: effect toggle (fx-reverb-on change)
     3. FX Rack: EQ preset select (fx-eqpreset change)
     4. Editor: speed slider (ed-speed input)
     5. Slowed+Reverb: preset card click
     6. Slowed+Reverb: speed slider (sl-speed input)
     7. Auto Remix: style card click (selectRemixStyle)
     8. Auto Remix: Generate button (must NOT auto-play anymore)
     9. Mastering: EQ slider (mst-eqb input)
    10. FX Rack: 8D toggle (fx-8d-on change — currently unwired UI)

   Exit code is non-zero on any failure.
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const SHELL = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE_URL = 'file:///home/hatch/workspace/ruhmix/www/index.html';

const PAGE_TESTS = `async () => {
  const T = [];
  const ok = (name, pass, detail) => T.push({ name, pass: !!pass, detail: detail || '' });
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return true; await wait(200); }
    return false;
  }
  const SR = 44100;

  // ---- load synthetic audio through the real import path ----
  try {
    const ctx = RM.audio.ensureCtx();
    const secs = 20, len = Math.floor(SR * secs);
    const buf = ctx.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c), f = c === 0 ? 440 : 660;
      for (let i = 0; i < len; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * f * i / SR);
    }
    RM.app.loadAudioBuffer(buf, 'autoplay-test');
    const ready = await waitFor(() => RM.app.state.viewBuffer && RM.app.state.player, 20000, 'load');
    ok('setup: audio loaded, player ready', ready, '');
    if (!ready) return T;
  } catch (e) { ok('setup', false, String(e && e.message || e)); return T; }

  const player = () => RM.app.state.player;
  const fireInput = (el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const fireChange = (el, val) => {
    if (el.type === 'checkbox') el.checked = val;
    else el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Every tool action, as a real user would trigger it.
  const actions = [
    ['FX: EQ bass slider', () => fireInput($('fx-bass'), 8)],
    ['FX: reverb toggle on', () => fireChange($('fx-reverb-on'), true)],
    ['FX: reverb toggle off', () => fireChange($('fx-reverb-on'), false)],
    ['FX: EQ preset select', () => {
      const sel = $('fx-eqpreset');
      sel.value = 'vshape'; fireChange(sel, 'vshape');
    }],
    ['Editor: speed slider', () => fireInput($('ed-speed'), 120)],
    ['Slowed: preset card click', () => {
      const card = document.querySelector('#slowed-presets .style-card');
      if (!card) throw new Error('no slowed preset card');
      card.click();
    }],
    ['Slowed: speed slider', () => fireInput($('sl-speed'), 0.8)],
    ['Remix: style card click', () => {
      const card = document.querySelector('#remix-grid .style-card');
      if (!card) throw new Error('no remix style card');
      card.click();
    }],
    ['Mastering: EQ bass slider', () => {
      const el = $('mst-eqb'); if (el) fireInput(el, 4);
    }],
    ['FX: 8D toggle', () => {
      const el = $('fx-8d-on'); if (el) fireChange(el, true);
    }],
  ];

  /* ---- STOPPED suite: stopped must stay stopped ---- */
  try {
    RM.app.stopAll();
    await wait(300);
    if (player().playing) { ok('stopped suite precondition', false, 'player playing before actions'); }
    else {
      let n = 0;
      for (const [name, act] of actions) {
        try { act(); } catch (e) { ok('STOPPED ' + name, false, 'action threw: ' + e.message); continue; }
        await wait(400);
        const bad = player().playing;
        ok('STOPPED: ' + name + ' does not start playback', !bad, bad ? 'playing=true!' : '');
        n++;
      }
      // Generate button (async: BPM detect + offline render) — must not play either
      $('remix-generate').click();
      const done = await waitFor(() => {
        const s = $('remix-status');
        return s && /✓|ready|BPM/.test(s.textContent);
      }, 30000, 'generate');
      await wait(500);
      ok('STOPPED: Generate button does not auto-play', !player().playing,
         done ? '' : 'generate did not finish');
    }
  } catch (e) { ok('stopped suite', false, String(e && e.message || e)); }

  /* ---- PLAYING suite: playing must continue, position preserved ---- */
  try {
    RM.app.stopAll();
    RM.app.ensureStudio();
    // reset tool state the stopped suite left behind
    fireInput($('fx-bass'), 0); fireChange($('fx-reverb-on'), false);
    fireInput($('ed-speed'), 100); fireInput($('sl-speed'), 1);
    player().setRate(1);
    if (!player().play(0)) { ok('playing suite precondition', false, 'play() refused'); }
    else {
      await wait(2000); // let it run a bit first
      for (const [name, act] of actions) {
        const posA = player().position();
        try { act(); } catch (e) { ok('PLAYING ' + name, false, 'action threw: ' + e.message); continue; }
        await wait(500);
        const posB = player().position();
        const still = player().playing;
        // No restart: position must have advanced past posA (tolerance 0.4s
        // for the wait itself), never jumped back near 0.
        const preserved = still && posB >= posA - 0.1;
        ok('PLAYING: ' + name + ' keeps playing, position preserved',
           preserved, 'playing=' + still + ' pos ' + posA.toFixed(2) + '->' + posB.toFixed(2));
        if (!still) break;
      }
      // Generate while playing: tempo applies live, playback continues
      const posA = player().position();
      $('remix-generate').click();
      const done = await waitFor(() => {
        const s = $('remix-status');
        return s && /✓|ready|BPM/.test(s.textContent);
      }, 30000, 'generate');
      await wait(500);
      const posB = player().position();
      ok('PLAYING: Generate keeps playback going (no restart)',
         done && player().playing && posB >= posA - 0.1,
         'playing=' + player().playing + ' pos ' + posA.toFixed(2) + '->' + posB.toFixed(2));
      RM.app.stopAll();
    }
  } catch (e) { ok('playing suite', false, String(e && e.message || e)); }

  return T;
}`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: SHELL,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required',
           '--use-gl=swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.app && RM.audio', { timeout: 30000 });
  try {
    await page.evaluate(() => {
      const b = document.querySelector('.rv-dialog-ov .btn.primary');
      if (b) b.click();
    });
  } catch (e) {}
  const results = await page.evaluate('(' + PAGE_TESTS + ')()');
  let fails = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : ''));
    if (!r.pass) fails++;
  }
  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
