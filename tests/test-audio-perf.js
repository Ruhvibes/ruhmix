#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix — audio performance test (stutter/dropout hunt)
   ---------------------------------------------------------------------
   Hasnain's #1 priority: playback must not stutter on his phone.

   What this measures (headless Chromium, OfflineAudioContext — the REAL
   RM.fx.makeChain code, not a replica):

   1. FULL-FX 3-MIN RENDER: 180s stereo mix through the complete insert
      chain (EQ, drive, chorus, echo, reverb, comp, limiter, 8D spatial,
      clipper) — scans the output for dropouts/glitches:
        - NaN / Infinity samples
        - discontinuities: |x[n]-x[n-1]| jumps (the test signal is smooth
          sines, so any sharp jump is a rendering glitch, not music)
        - DC offset, RMS sanity
      Plus wall-clock render time (proxy for per-quantum CPU cost).

   2. IDLE-FX COST, BEFORE vs AFTER: typical playback has reverb OFF and
      spatial 'off'. BEFORE the fix both convolvers (1.8s main + 1.0s
      spatial) convolved the full signal at all times (only wet gains were
      zeroed). AFTER, they are truly bypassed (edges disconnected).
      Renders the same 60s buffer both ways and compares render time.

   3. BYPASS TRANSPARENCY: the bypassed chain must sound EXACTLY like the
      old always-connected chain with effects off (max sample diff ~ 0).

   4. BYPASS ENGAGEMENT: getBypass() reflects reverb/spatial state, and
      toggling reverb/spatial on/off reconnects correctly.

   Exit code is non-zero on any failure. Each test prints PASS/FAIL + numbers.
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const SHELL = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE_URL = 'file:///home/hatch/workspace/ruhmix/www/index.html';

const PAGE_TESTS = `async () => {
  const T = [];
  const ok = (name, pass, detail) => T.push({ name, pass: !!pass, detail: detail || '' });
  const SR = 44100;

  // Smooth, continuous test signal: sum of sines + slow tremolo.
  // Any sharp sample-to-sample jump in the output is a glitch, not music.
  function testBuffer(oc, secs) {
    const len = Math.floor(SR * secs);
    const b = oc.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const f1 = c === 0 ? 220 : 330, f2 = c === 0 ? 440 : 554.37, f3 = c === 0 ? 880 : 1174.7;
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        const trem = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.4 * t);
        d[i] = trem * (0.22 * Math.sin(2 * Math.PI * f1 * t)
                     + 0.14 * Math.sin(2 * Math.PI * f2 * t)
                     + 0.08 * Math.sin(2 * Math.PI * f3 * t));
      }
    }
    return b;
  }

  const FULL_FX = {
    eq3: [4, -2, 3], eq10: [2, 1, 0, -1, 2, 0, -2, 1, 3, -1], filter: 19000, drive: 0.3,
    chorus: { on: true, rate: 1.2, depth: 0.004 },
    echo: { on: true, time: 0.375, fb: 0.35, wet: 0.35 },
    reverb: { on: true, room: 'hall', wet: 0.4 },
    comp: { on: true, thr: -18, ratio: 4, atk: 0.01, rel: 0.25 },
    out: 1.0, spatial: { mode: '8d', speed: 0.12, depth: 1 },
  };
  const IDLE_FX = { // reverb off, spatial off — typical "FX rack untouched" playback
    eq3: [0, 0, 0], filter: 19000, drive: 0,
    chorus: { on: false }, echo: { on: false }, reverb: { on: false },
    comp: { on: true, thr: -18, ratio: 4 }, out: 1.0,
  };

  async function renderChain(preset, secs, replicateOldTopology) {
    const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(preset)));
    if (replicateOldTopology) {
      // Pre-fix wiring: convolvers always connected, spatial always in path.
      chain.nodes.rvHP.connect(chain.nodes.convolver);
      chain.nodes.limiter.disconnect();
      chain.nodes.limiter.connect(chain.nodes.spatial.input);
      chain.nodes.spatial.setConvolverStarved(false);
    }
    const src = oc.createBufferSource();
    src.buffer = testBuffer(oc, secs);
    src.connect(chain.input);
    chain.output.connect(oc.destination);
    src.start(0);
    const t0 = performance.now();
    const rendered = await oc.startRendering();
    const ms = performance.now() - t0;
    try { chain.dispose(); } catch (e) {}
    return { rendered, ms };
  }

  function analyze(buf) {
    let maxJump = 0, clicks = 0, nanInf = 0, sum = 0, sumSq = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      let prev = d[0];
      for (let i = 0; i < d.length; i++) {
        const x = d[i];
        if (!isFinite(x)) { nanInf++; continue; }
        if (i > 0) {
          const j = Math.abs(x - prev);
          if (j > maxJump) maxJump = j;
          if (j > 0.3) clicks++;
        }
        prev = x; sum += x; sumSq += x * x; n++;
      }
    }
    return { maxJump, clicks, nanInf, dc: sum / Math.max(1, n), rms: Math.sqrt(sumSq / Math.max(1, n)) };
  }

  /* ---- 1. full-FX 3-minute render: dropout/glitch scan ---- */
  try {
    const { rendered, ms } = await renderChain(FULL_FX, 180, false);
    const a = analyze(rendered);
    ok('full-fx 180s: no NaN/Inf', a.nanInf === 0, 'bad=' + a.nanInf);
    ok('full-fx 180s: no clicks/glitches', a.clicks === 0,
       'clicks=' + a.clicks + ' maxJump=' + a.maxJump.toFixed(4) + ' rms=' + a.rms.toFixed(3));
    ok('full-fx 180s: DC offset sane', Math.abs(a.dc) < 0.01, 'dc=' + a.dc.toFixed(5));
    T.push({ name: 'full-fx 180s render time (CPU proxy)', pass: true, detail: Math.round(ms) + ' ms' });
  } catch (e) { ok('full-fx 180s render', false, String(e && e.message || e)); }

  /* ---- 2. idle-FX cost: before (old topology) vs after (bypass) ---- */
  try {
    const SECS = 60;
    const after = await renderChain(IDLE_FX, SECS, false);
    const before = await renderChain(IDLE_FX, SECS, true);
    const saved = before.ms - after.ms;
    const pct = before.ms > 0 ? (100 * saved / before.ms) : 0;
    ok('idle-fx: bypass is faster than old topology', after.ms < before.ms,
       'before=' + Math.round(before.ms) + 'ms after=' + Math.round(after.ms) +
       'ms saved=' + Math.round(saved) + 'ms (' + pct.toFixed(1) + '%)');
    T.push({ name: 'idle-fx render time (60s)', pass: true,
             detail: 'before=' + Math.round(before.ms) + 'ms after=' + Math.round(after.ms) + 'ms' });
  } catch (e) { ok('idle-fx before/after', false, String(e && e.message || e)); }

  /* ---- 3. bypass transparency: bypassed === old wiring (FX off) ---- */
  try {
    const a = await renderChain(IDLE_FX, 20, false);
    const b = await renderChain(IDLE_FX, 20, true);
    let maxDiff = 0;
    for (let c = 0; c < 2; c++) {
      const da = a.rendered.getChannelData(c), db = b.rendered.getChannelData(c);
      for (let i = 0; i < da.length; i += 7) {
        const d = Math.abs(da[i] - db[i]);
        if (d > maxDiff) maxDiff = d;
      }
    }
    ok('bypass transparency (FX off): sample-identical', maxDiff < 1e-6,
       'maxDiff=' + maxDiff.toExponential(2));
  } catch (e) { ok('bypass transparency', false, String(e && e.message || e)); }

  /* ---- 4. bypass engagement ---- */
  try {
    const oc = new OfflineAudioContext(2, SR, SR);
    const chain = RM.fx.makeChain(oc);
    const g0 = chain.getBypass();
    ok('default: reverb+spatial bypassed', g0.reverb === true && g0.spatial === true, JSON.stringify(g0));
    chain.applyPreset({ reverb: { on: true, room: 'hall', wet: 0.4 } });
    const g1 = chain.getBypass();
    ok('reverb on: bypass released', g1.reverb === false, JSON.stringify(g1));
    chain.applyPreset({ reverb: { on: false } });
    const g2 = chain.getBypass();
    ok('reverb off: bypass re-engaged', g2.reverb === true, JSON.stringify(g2));
    chain.set('spatialMode', '8d');
    const g3 = chain.getBypass();
    ok('spatial 8d: bypass released', g3.spatial === false, JSON.stringify(g3));
    chain.set('spatialMode', 'off');
    await new Promise((r) => setTimeout(r, 600)); // delayed click-free bypass
    const g4 = chain.getBypass();
    ok('spatial off: bypass re-engaged (after glide)', g4.spatial === true, JSON.stringify(g4));
    // rapid off->on->off must not leave a stale bypass state (gen guard)
    chain.set('spatialMode', 'off');
    chain.set('spatialMode', '16d');
    await new Promise((r) => setTimeout(r, 600));
    const g5 = chain.getBypass();
    ok('spatial off->16d race: ends un-bypassed', g5.spatial === false, JSON.stringify(g5));
    // 360° HRTF branch input starve (true bypass — gate=0 ke alawa panner
    // bhi idle hona chahiye jab mode '360' nahi hai)
    const sp = chain.nodes.spatial;
    await new Promise((r) => setTimeout(r, 600));
    ok('360 branch: input starved when mode != 360', sp.isS360Starved() === true, '');
    chain.set('spatialMode', '360');
    ok('360 branch: input wired in 360 mode', sp.isS360Starved() === false, '');
    chain.set('spatialMode', 'off');
    await new Promise((r) => setTimeout(r, 600));
    ok('360 branch: input re-starved after leaving 360', sp.isS360Starved() === true, '');
    try { chain.dispose(); } catch (e) {}
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('bypass engagement', false, String(e && e.message || e)); }

  /* ---- 5. driveCurve quantization: slider jitter doesn't rebuild curve ---- */
  try {
    const oc = new OfflineAudioContext(2, SR, SR);
    const chain = RM.fx.makeChain(oc);
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    chain.set('drive', 0.312);
    const c1 = Array.from(chain.nodes.drive.curve);
    chain.set('drive', 0.314); // same 1% bucket -> identical curve (cache hit)
    const c2 = Array.from(chain.nodes.drive.curve);
    chain.set('drive', 0.5); // different bucket -> different curve
    const c3 = Array.from(chain.nodes.drive.curve);
    ok('driveCurve quantized per 1% bucket', eq(c1, c2) && !eq(c1, c3), '');
    try { chain.dispose(); } catch (e) {}
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('driveCurve quantization', false, String(e && e.message || e)); }

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
  await page.waitForFunction('window.RM && RM.fx && RM.audio', { timeout: 30000 });
  // Dismiss the welcome dialog if present (it overlays the page)
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
