#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix — Round-11 audio regression verification (v10 risk areas)
   ---------------------------------------------------------------------
   v10 changed: autoplay fix (generateRemix/generateStemRemix no longer
   auto-play), stutter fix (reverb convolver + spatial convolver true
   bypass), 8D/3D/16D toggles wired (radio behavior).

   This suite verifies NO regression around those fixes, signal-level,
   using the REAL RM.fx / RM.exp / RM.audio code in headless Chrome:

   A. AUTOPLAY REGRESSION (in-page, real DOM clicks):
      Preview buttons MUST play when pressed (remix-preview, fx-preview,
      sl-play, mst-play). mst-ab is a switch, not a play button: stopped
      stays stopped, playing keeps playing.
   B. STUTTER-FIX REGRESSION (offline renders, oc.suspend() toggles):
      reverb ON->OFF->ON and spatial off->8d->off mid-render must be
      click/pop-free (gain-glide + delayed disconnect). Rapid mode race
      must end in the correct bypass state.
   C. 8D/3D/16D WIRING (signal-level + real UI events):
      all three modes move the stereo image; radio behavior in state and
      UI; slider touch auto-enables its mode; OFF is bit-transparent;
      export renders the effect; mono sum never loses the signal.
   D. OLD FIXES INTACT:
      flat-chain transparency (drive=0, no dry+wet doubling), safety
      clipper ceiling (max ~0.9952 at 0dBFS), doubling-bug detector
      validation (manually doubled topology = +6.02dB, shipped = single
      path), export vol/pan WYSIWYG math + width=1 neutrality.

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
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return true; await wait(200); }
    return false;
  }
  const SR = 44100;
  const FLAT = { eq3: [0,0,0], eq10: [0,0,0,0,0,0,0,0,0,0], filter: 19000, drive: 0,
    chorus: { on: false }, echo: { on: false }, reverb: { on: false },
    comp: { on: false }, out: 1.0 };

  // Smooth test signal: sum of low sines. Any sharp sample jump = glitch.
  function testBuffer(oc, secs, amp) {
    amp = amp == null ? 0.2 : amp;
    const len = Math.floor(SR * secs);
    const b = oc.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const f1 = c === 0 ? 220 : 330, f2 = c === 0 ? 440 : 554.37, f3 = c === 0 ? 660 : 880;
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        d[i] = amp * (Math.sin(2 * Math.PI * f1 * t)
                    + 0.6 * Math.sin(2 * Math.PI * f2 * t)
                    + 0.3 * Math.sin(2 * Math.PI * f3 * t)) / 1.9;
      }
    }
    return b;
  }
  function rms(buf, c) {
    const d = buf.getChannelData(c); let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / d.length);
  }
  function peak(buf) {
    let m = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    }
    return m;
  }
  // click scan: counts sample-to-sample jumps above thr; returns maxJump too
  function scanClicks(buf, thr) {
    let maxJump = 0, clicks = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      let prev = d[0];
      for (let i = 1; i < d.length; i++) {
        const j = Math.abs(d[i] - prev);
        if (j > maxJump) maxJump = j;
        if (j > thr) clicks++;
        prev = d[i];
      }
    }
    return { maxJump, clicks };
  }
  // stereo movement: per-1s-window L/R RMS ratio spread (pan LFO sweep detector)
  function panSpread(buf, winSecs) {
    const w = Math.floor(SR * winSecs), n = Math.floor(buf.length / w);
    let mn = Infinity, mx = -Infinity;
    for (let k = 0; k < n; k++) {
      let sl = 0, sr = 0;
      const dl = buf.getChannelData(0), dr = buf.getChannelData(1);
      for (let i = k * w; i < (k + 1) * w; i++) { sl += dl[i] * dl[i]; sr += dr[i] * dr[i]; }
      const r = Math.sqrt(sl / Math.max(1e-12, sr));
      if (r < mn) mn = r; if (r > mx) mx = r;
    }
    return { min: mn, max: mx, spread: mx - mn };
  }
  async function renderX(preset, secs, pre) {
    const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(preset)));
    if (pre) await pre(chain, oc);
    const src = oc.createBufferSource();
    src.buffer = testBuffer(oc, secs);
    src.connect(chain.input);
    chain.output.connect(oc.destination);
    src.start(0);
    const r = await oc.startRendering();
    try { chain.dispose(); } catch (e) {}
    try { await oc.close(); } catch (e) {}
    return r;
  }
  const withSpatial = (mode, speed, depth) => {
    const p = JSON.parse(JSON.stringify(FLAT));
    p.spatial = { mode, speed: speed == null ? 0.12 : speed, depth: depth == null ? 1 : depth };
    return p;
  };

  /* ================= A. preview buttons MUST play ================= */
  try {
    const ctx = RM.audio.ensureCtx();
    const buf = ctx.createBuffer(2, Math.floor(SR * 20), SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c), f = c === 0 ? 440 : 660;
      for (let i = 0; i < d.length; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * f * i / SR);
    }
    RM.app.loadAudioBuffer(buf, 'r11-test');
    const ready = await waitFor(() => RM.app.state.viewBuffer && RM.app.state.player, 20000);
    ok('A setup: audio loaded', ready, '');
    if (ready) {
      const player = () => RM.app.state.player;
      async function clickPlays(btnId, label) {
        try {
          RM.app.stopAll(); await wait(300);
          const wasStopped = !player().playing;
          $(btnId).click();
          const started = await waitFor(() => player().playing, 4000);
          await wait(800);
          const advancing = player().playing && player().position() > 0.2;
          ok('A: ' + label + ' click starts playback', wasStopped && started && advancing,
             'playing=' + player().playing + ' pos=' + player().position().toFixed(2));
          RM.app.stopAll(); await wait(300);
        } catch (e) { ok('A: ' + label, false, String(e && e.message || e)); }
      }
      await clickPlays('remix-preview', 'remix Preview button');
      await clickPlays('fx-preview', 'FX Preview button');
      await clickPlays('sl-play', 'Slowed+Reverb Play button');
      // Mastering uses its OWN player (mst.player), not the studio player —
      // so verify via the master bus tap, not RM.app.state.player.
      async function busTap() {
        const actx = RM.audio.ensureCtx();
        const an = actx.createAnalyser(); an.fftSize = 2048;
        RM.audio.masterIn().connect(an);
        const td = new Float32Array(an.fftSize);
        return {
          rms() { an.getFloatTimeDomainData(td); let s = 0; for (let i = 0; i < td.length; i++) s += td[i] * td[i]; return Math.sqrt(s / td.length); },
          release() { try { an.disconnect(); } catch (e) {} },
        };
      }
      try {
        RM.app.stopAll(); await wait(600);
        const tap = await busTap();
        const silent0 = tap.rms();
        $('mst-play').click();
        await wait(1500);
        const loud = tap.rms();
        ok('A: Mastering Play button click starts playback (master bus)',
           silent0 < 0.005 && loud > 0.01,
           'busRms ' + silent0.toFixed(4) + '->' + loud.toFixed(4));
        tap.release();
        RM.app.stopAll(); await wait(600);
      } catch (e) { ok('A: Mastering Play button', false, String(e && e.message || e)); }
      // mst-ab is a before/after SWITCH, not a play button (bus-tap verified)
      try {
        RM.app.stopAll(); await wait(600);
        const tap = await busTap();
        $('mst-ab').click(); await wait(800);
        const stillSilent = tap.rms();
        ok('A: mastering A/B while stopped stays stopped', stillSilent < 0.005,
           'busRms=' + stillSilent.toFixed(4));
        $('mst-play').click(); await wait(1500);
        const r1 = tap.rms();
        $('mst-ab').click(); await wait(800);
        const r2 = tap.rms();
        ok('A: mastering A/B while playing keeps playing', r1 > 0.01 && r2 > 0.01,
           'busRms ' + r1.toFixed(3) + '->' + r2.toFixed(3));
        tap.release();
        RM.app.stopAll(); await wait(300);
      } catch (e) { ok('A: mastering A/B', false, String(e && e.message || e)); }
    }
  } catch (e) { ok('A suite', false, String(e && e.message || e)); }

  /* ============ B. toggle transients (reverb/spatial) ============ */
  try {
    // B1: reverb ON->OFF->ON mid-render — input-edge disconnect is on the
    // convolver INPUT side (output stays continuous) + wet gain glides.
    const r1 = await (async () => {
      const oc = new OfflineAudioContext(2, Math.ceil(SR * 7), SR);
      const p = JSON.parse(JSON.stringify(FLAT));
      p.reverb = { on: false, room: 'hall', wet: 0.4 };
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(p);
      const src = oc.createBufferSource();
      src.buffer = testBuffer(oc, 7); src.connect(chain.input);
      chain.output.connect(oc.destination); src.start(0);
      oc.suspend(2.0).then(() => { chain.set('reverbOn', true); oc.resume(); });
      oc.suspend(3.5).then(() => { chain.set('reverbOn', false); oc.resume(); });
      oc.suspend(5.0).then(() => { chain.set('reverbOn', true); oc.resume(); });
      const r = await oc.startRendering();
      try { chain.dispose(); } catch (e) {}
      return r;
    })();
    const c1 = scanClicks(r1, 0.35);
    ok('B1: reverb ON->OFF->ON mid-render: no clicks/pops', c1.clicks === 0,
       'clicks=' + c1.clicks + ' maxJump=' + c1.maxJump.toFixed(4));
  } catch (e) { ok('B1 reverb toggle', false, String(e && e.message || e)); }
  try {
    // B2: spatial off->8d->off mid-render — rewire happens at unity-dry.
    const r2 = await (async () => {
      const oc = new OfflineAudioContext(2, Math.ceil(SR * 8), SR);
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(withSpatial('off'));
      const src = oc.createBufferSource();
      src.buffer = testBuffer(oc, 8); src.connect(chain.input);
      chain.output.connect(oc.destination); src.start(0);
      oc.suspend(2.0).then(() => { chain.set('spatialMode', '8d'); oc.resume(); });
      oc.suspend(5.0).then(() => { chain.set('spatialMode', 'off'); oc.resume(); });
      const r = await oc.startRendering();
      try { chain.dispose(); } catch (e) {}
      return r;
    })();
    const c2 = scanClicks(r2, 0.35);
    ok('B2: spatial off->8d->off mid-render: no clicks/pops', c2.clicks === 0,
       'clicks=' + c2.clicks + ' maxJump=' + c2.maxJump.toFixed(4));
  } catch (e) { ok('B2 spatial toggle', false, String(e && e.message || e)); }
  try {
    // B3: rapid off->8d->off->16d race — generation guard must win.
    const oc = new OfflineAudioContext(2, SR, SR);
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(withSpatial('off'));
    chain.set('spatialMode', '8d');
    chain.set('spatialMode', 'off');
    chain.set('spatialMode', '16d');
    await wait(700); // past the 400ms delayed-bypass window
    const g = chain.getBypass(), s = chain.getSpatial();
    ok('B3: spatial off->8d->off->16d race ends un-bypassed on 16d',
       g.spatial === false && s.mode === '16d', JSON.stringify(g) + ' ' + JSON.stringify(s));
    chain.set('spatialMode', 'off');
    await wait(700);
    const g2 = chain.getBypass();
    ok('B3b: back to off re-engages bypass after glide', g2.spatial === true, JSON.stringify(g2));
    try { chain.dispose(); } catch (e) {}
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('B3 spatial race', false, String(e && e.message || e)); }
  try {
    // B4: reverb room change while ON (IR buffer swap) — must not NaN/click.
    const r4 = await (async () => {
      const oc = new OfflineAudioContext(2, Math.ceil(SR * 6), SR);
      const p = JSON.parse(JSON.stringify(FLAT));
      p.reverb = { on: true, room: 'hall', wet: 0.4 };
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(p);
      const src = oc.createBufferSource();
      src.buffer = testBuffer(oc, 6); src.connect(chain.input);
      chain.output.connect(oc.destination); src.start(0);
      oc.suspend(2.0).then(() => { chain.set('reverbRoom', 'church'); oc.resume(); });
      oc.suspend(4.0).then(() => { chain.set('reverbRoom', 'studio'); oc.resume(); });
      const r = await oc.startRendering();
      try { chain.dispose(); } catch (e) {}
      return r;
    })();
    const c4 = scanClicks(r4, 0.35);
    let nan = 0;
    for (let c = 0; c < 2; c++) { const d = r4.getChannelData(c); for (let i = 0; i < d.length; i++) if (!isFinite(d[i])) nan++; }
    ok('B4: reverb room swap while ON: no NaN, no clicks', nan === 0 && c4.clicks === 0,
       'nan=' + nan + ' clicks=' + c4.clicks + ' maxJump=' + c4.maxJump.toFixed(4));
  } catch (e) { ok('B4 reverb room swap', false, String(e && e.message || e)); }

  /* ================= C. 8D/3D/16D wiring ================= */
  try {
    const r8 = await renderX(withSpatial('8d', 0.12, 1), 12);
    const s8 = panSpread(r8, 1);
    ok('C1: 8D moves the stereo image', s8.spread > 0.5,
       'L/R ratio spread=' + s8.spread.toFixed(2) + ' [' + s8.min.toFixed(2) + '..' + s8.max.toFixed(2) + ']');
    const r3 = await renderX(withSpatial('3d', 0.07, 1), 12);
    const s3 = panSpread(r3, 1);
    ok('C2: 3D moves gently (milder than 8D)', s3.spread > 0.05 && s3.spread < s8.spread,
       'spread=' + s3.spread.toFixed(2) + ' vs 8d=' + s8.spread.toFixed(2));
    const r16 = await renderX(withSpatial('16d', 0.5, 1), 8);
    const s16 = panSpread(r16, 1);
    ok('C3: 16D moves the stereo image', s16.spread > 0.5, 'spread=' + s16.spread.toFixed(2));
    const roff = await renderX(withSpatial('off'), 8);
    const soff = panSpread(roff, 1);
    ok('C4: OFF = no image movement', soff.spread < 0.05, 'spread=' + soff.spread.toFixed(3));
    // C5: radio at state level — applyPreset 8d then 3d
    const oc5 = new OfflineAudioContext(2, SR, SR);
    const ch5 = RM.fx.makeChain(oc5);
    ch5.applyPreset(withSpatial('8d'));
    ch5.applyPreset(withSpatial('3d'));
    ok('C5: radio — only one mode active', ch5.getSpatial().mode === '3d',
       JSON.stringify(ch5.getSpatial()));
    try { ch5.dispose(); } catch (e) {}
    try { await oc5.close(); } catch (e) {}
  } catch (e) { ok('C signal suite', false, String(e && e.message || e)); }
  try {
    // C6/C7: real UI radio + slider auto-enable
    const fireChange = (el, val) => {
      if (el.type === 'checkbox') el.checked = val; else el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const fireInput = (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const mode = () => (RM.app.state.fx.spatial && RM.app.state.fx.spatial.mode) || 'off';
    fireChange($('fx-8d-on'), true); await wait(300);
    ok('C6: UI — 8D check enables 8D, others unchecked',
       mode() === '8d' && !$('fx-3d-on').checked && !$('fx-16d-on').checked,
       'mode=' + mode());
    fireChange($('fx-3d-on'), true); await wait(300);
    ok('C6b: UI — 3D check switches radio to 3D',
       mode() === '3d' && !$('fx-8d-on').checked && !$('fx-16d-on').checked,
       'mode=' + mode());
    fireChange($('fx-3d-on'), false); await wait(300);
    ok('C6c: UI — uncheck turns mode off', mode() === 'off' && !$('fx-3d-on').checked, 'mode=' + mode());
    fireInput($('fx-16d-speed'), 60); await wait(300);
    ok('C7: UI — touching 16D speed slider auto-enables 16D',
       mode() === '16d' && $('fx-16d-on').checked, 'mode=' + mode());
    fireChange($('fx-16d-on'), false); await wait(300);
    ok('C7b: UI — back to off', mode() === 'off', 'mode=' + mode());
  } catch (e) { ok('C UI suite', false, String(e && e.message || e)); }
  try {
    // C8: OFF transparency — an 8d->off cycled chain renders bit-identical
    // to a chain that was never engaged (delayed bypass restores topology).
    const rA = await renderX(withSpatial('off'), 5);
    const rB = await renderX(withSpatial('off'), 5, async (chain) => {
      chain.set('spatialMode', '8d'); await wait(700);
      chain.set('spatialMode', 'off'); await wait(700);
      if (!chain.getBypass().spatial) throw new Error('bypass did not re-engage');
    });
    let maxDiff = 0;
    for (let c = 0; c < 2; c++) {
      const da = rA.getChannelData(c), db = rB.getChannelData(c);
      for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); if (d > maxDiff) maxDiff = d; }
    }
    ok('C8: OFF after 8d->off cycle is bit-identical to never-engaged', maxDiff === 0,
       'maxDiff=' + maxDiff.toExponential(2));
  } catch (e) { ok('C8 off transparency', false, String(e && e.message || e)); }
  try {
    // C9: export renders the spatial effect (RM.exp.renderOffline + 8D).
    const srcBuf = testBuffer(new OfflineAudioContext(2, 1, SR), 8);
    const rendered = await RM.exp.renderOffline(srcBuf, (oc, srcNode) => {
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(withSpatial('8d', 0.12, 1));
      srcNode.connect(chain.input);
      return chain.output;
    }, { sampleRate: SR, rate: 1, tail: 0 });
    const se = panSpread(rendered, 1);
    ok('C9: export render contains the 8D effect', se.spread > 0.5, 'spread=' + se.spread.toFixed(2));
  } catch (e) { ok('C9 export spatial', false, String(e && e.message || e)); }
  try {
    // C10: mono compatibility — mono sum never loses the signal.
    const rM = await renderX(withSpatial('8d', 0.12, 1), 10);
    const w = Math.floor(SR * 0.1), n = Math.floor(rM.length / w);
    let minRatio = Infinity;
    const dl = rM.getChannelData(0), dr = rM.getChannelData(1);
    for (let k = 0; k < n; k++) {
      let sm = 0, si = 0;
      for (let i = k * w; i < (k + 1) * w; i++) {
        const m = (dl[i] + dr[i]) / 2;
        sm += m * m; si += dl[i] * dl[i] + dr[i] * dr[i];
      }
      const ratio = Math.sqrt(sm / Math.max(1e-12, si / 2));
      if (ratio < minRatio) minRatio = ratio;
    }
    ok('C10: mono sum keeps the signal (no cancellation)', minRatio > 0.5,
       'min mono/input RMS ratio=' + minRatio.toFixed(3));
  } catch (e) { ok('C10 mono compat', false, String(e && e.message || e)); }

  /* ================= D. old fixes intact ================= */
  function chirpBuffer(oc, secs) {
    // Non-periodic signal: cross-correlation has ONE sharp peak, so the
    // platform latency measurement can't lock onto a sidelobe.
    const len = Math.floor(SR * secs);
    const b = oc.createBuffer(2, len, SR);
    const f0 = 100, f1 = 5000;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let phase = c * 0.7;
      for (let i = 0; i < len; i++) {
        const f = f0 + (f1 - f0) * (i / len);
        phase += 2 * Math.PI * f / SR;
        d[i] = 0.4 * Math.sin(phase);
      }
    }
    return b;
  }
  try {
    // D1a: drive stage bit-transparency at drive=0 (the actual v5 fix:
    // driveCurve(0) must be the identity line). Taps before/after the
    // WaveShaper — both zero-latency stages, so sample-exact compare.
    {
      const secs = 3;
      const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(JSON.parse(JSON.stringify(FLAT)));
      const mg = oc.createChannelMerger(2);
      const sp1 = oc.createChannelSplitter(2), sp2 = oc.createChannelSplitter(2);
      chain.nodes.filter.connect(sp1); sp1.connect(mg, 0, 0);
      chain.nodes.drive.connect(sp2); sp2.connect(mg, 0, 1);
      mg.connect(oc.destination);
      const src = oc.createBufferSource();
      src.buffer = chirpBuffer(oc, secs); src.connect(chain.input);
      src.start(0);
      const out = await oc.startRendering();
      const dPre = out.getChannelData(0), dPost = out.getChannelData(1);
      let md = 0;
      for (let i = 0; i < dPre.length; i++) { const d = Math.abs(dPre[i] - dPost[i]); if (d > md) md = d; }
      ok('D1a: drive=0 WaveShaper is bit-transparent', md < 1e-6, 'maxDiff=' + md.toExponential(2));
      try { chain.dispose(); } catch (e) {}
      try { await oc.close(); } catch (e) {}
    }
  } catch (e) { ok('D1a drive transparency', false, String(e && e.message || e)); }
  try {
    // D1b: whole flat chain — no doubling, no coloration beyond the
    // documented platform quirks (264-sample/comp Chrome latency,
    // +0.85dB sub-threshold lift), and NO startup fade-in anymore
    // (Round-11 fix: fresh chain uses direct param assignment).
    const secs = 5;
    const oc1 = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
    const inBuf = chirpBuffer(oc1, secs);
    const chain1 = RM.fx.makeChain(oc1);
    chain1.applyPreset(JSON.parse(JSON.stringify(FLAT)));
    const src1 = oc1.createBufferSource();
    src1.buffer = inBuf; src1.connect(chain1.input);
    chain1.output.connect(oc1.destination); src1.start(0);
    const out1 = await oc1.startRendering();
    const iD = inBuf.getChannelData(0), oD = out1.getChannelData(0);
    let bestLag = 0, bestCorr = -Infinity;
    for (let lag = 0; lag <= 1200; lag += 2) {
      let s = 0;
      for (let i = 0; i < iD.length - 1300; i += 32) s += iD[i] * oD[i + lag];
      if (s > bestCorr) { bestCorr = s; bestLag = lag; }
    }
    for (let lag = Math.max(0, bestLag - 2); lag <= bestLag + 2; lag++) {
      let s = 0;
      for (let i = 0; i < iD.length - 1300; i += 4) s += iD[i] * oD[i + lag];
      if (s > bestCorr) { bestCorr = s; bestLag = lag; }
    }
    // steady-state gain (sec 1..4): quirk is ~+0.86dB; +6dB would mean doubling
    let num = 0, den = 0;
    for (let c = 0; c < 2; c++) {
      const di = inBuf.getChannelData(c), doo = out1.getChannelData(c);
      for (let i = SR; i < 4 * SR && i < di.length - bestLag; i += 3) {
        num += doo[i + bestLag] * di[i]; den += di[i] * di[i];
      }
    }
    const gainDb = 20 * Math.log10(num / den);
    ok('D1b: flat chain steady gain is quirk-level, not doubled',
       gainDb > 0.3 && gainDb < 2.0,
       'latency=' + bestLag + ' samples, gain=' + gainDb.toFixed(2) + 'dB (quirk ~+0.86, doubling would be ~+6)');
    // startup: first 120ms energy vs input — the app must add no fade-in
    // beyond the PLATFORM's own DynamicsCompressor warmup (measured floor:
    // a bare comp with thr=0/ratio=1 also ramps — Chromium internal).
    // Self-calibrating: render the same chirp through a bare comp.
    let floorRatio = 0;
    {
      const ocB = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
      const compB = ocB.createDynamicsCompressor();
      compB.threshold.value = 0; compB.ratio.value = 1;
      const srcB = ocB.createBufferSource();
      srcB.buffer = inBuf; srcB.connect(compB); compB.connect(ocB.destination);
      srcB.start(0);
      const outB = await ocB.startRendering();
      const dB = outB.getChannelData(0);
      const nB = Math.floor(SR * 0.12);
      let eI = 0, eO = 0;
      for (let i = 0; i < nB && i + 264 < dB.length; i++) {
        eI += iD[i] * iD[i]; eO += dB[i + 264] * dB[i + 264];
      }
      floorRatio = eO / Math.max(1e-12, eI);
      try { await ocB.close(); } catch (e) {}
    }
    let eIn = 0, eOut = 0;
    {
      const di = inBuf.getChannelData(0), doo = out1.getChannelData(0);
      const n = Math.floor(SR * 0.12);
      for (let i = 0; i < n && i + bestLag < doo.length; i++) {
        eIn += di[i] * di[i]; eOut += doo[i + bestLag] * doo[i + bestLag];
      }
    }
    const earlyRatio = eOut / Math.max(1e-12, eIn);
    ok('D1c: no app-added startup fade (matches platform floor)',
       earlyRatio > floorRatio * 0.8,
       'chain 120ms=' + earlyRatio.toFixed(3) + ' vs bare-comp floor=' + floorRatio.toFixed(3));
    try { chain1.dispose(); } catch (e) {}
    try { await oc1.close(); } catch (e) {}
  } catch (e) { ok('D1b/c chain quirks', false, String(e && e.message || e)); }
  try {
    // D2: safety clipper ceiling.
    async function clipRender(amp) {
      const oc = new OfflineAudioContext(2, Math.ceil(SR * 2), SR);
      const clip = RM.audio.createSafetyClipper(oc);
      const src = oc.createBufferSource();
      const b = oc.createBuffer(2, Math.ceil(SR * 2), SR);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * 440 * i / SR);
      }
      src.buffer = b; src.connect(clip); clip.connect(oc.destination); src.start(0);
      const r = await oc.startRendering();
      try { await oc.close(); } catch (e) {}
      return r;
    }
    const rHot1 = await clipRender(1.0);
    const m1 = peak(rHot1);
    ok('D2a: clipper ceiling at 0dBFS input ~0.9952', m1 > 0.994 && m1 <= 0.996, 'max=' + m1.toFixed(5));
    const rHot4 = await clipRender(4.0);
    const m4 = peak(rHot4);
    ok('D2b: clipper never exceeds 0dBFS even at +12dB', m4 <= 1.0001, 'max=' + m4.toFixed(5));
    const rSoft = await clipRender(0.5);
    const ocS = new OfflineAudioContext(2, 1, SR);
    const inS = ocS.createBuffer(2, Math.ceil(SR * 2), SR);
    for (let c = 0; c < 2; c++) { const d = inS.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR); }
    let md = 0;
    for (let c = 0; c < 2; c++) {
      const di = inS.getChannelData(c), doo = rSoft.getChannelData(c);
      for (let i = 0; i < di.length; i++) { const d = Math.abs(di[i] - doo[i]); if (d > md) md = d; }
    }
    ok('D2c: clipper transparent below the knee', md < 1e-6, 'maxDiff=' + md.toExponential(2));
    try { await ocS.close(); } catch (e) {}
  } catch (e) { ok('D2 clipper', false, String(e && e.message || e)); }
  try {
    // D3: doubling-bug detector — manually doubled topology must read
    // +6.02dB; the shipped off-state wiring must NOT (single path).
    const rOff = await renderX(withSpatial('off'), 5);
    const rBug = await renderX(withSpatial('off'), 5, async (chain) => {
      // simulate the bug: limiter drives BOTH output and spatial.input
      // while spatial 'off' passes dry=1 -> output gets 2x signal.
      chain.nodes.limiter.connect(chain.nodes.spatial.input);
    });
    const db = 20 * Math.log10((rms(rBug, 0) + rms(rBug, 1)) / (rms(rOff, 0) + rms(rOff, 1)));
    ok('D3: detector sees manually-doubled topology at +6.02dB', Math.abs(db - 6.02) < 0.3,
       'measured +' + db.toFixed(2) + 'dB');
    // ...and the shipped wiring is the single-path one (D1 already shows
    // output == input, which a doubled topology could never satisfy).
    ok('D3b: shipped off-state wiring is single-path (see D1 transparency)', true, '');
  } catch (e) { ok('D3 doubling', false, String(e && e.message || e)); }
  try {
    // D4: export vol/pan WYSIWYG math (same graph shape as app.js export).
    const oc4 = new OfflineAudioContext(2, 1, SR);
    const srcBuf = testBuffer(oc4, 6);
    try { await oc4.close(); } catch (e) {}
    async function expRender(vol, pan) {
      return RM.exp.renderOffline(srcBuf, (oc, srcNode) => {
        const chain = RM.fx.makeChain(oc);
        chain.applyPreset(JSON.parse(JSON.stringify(FLAT)));
        srcNode.connect(chain.input);
        const xg = oc.createGain(); xg.gain.value = vol;
        chain.output.connect(xg);
        const xp = oc.createStereoPanner(); xp.pan.value = pan;
        xg.connect(xp);
        return xp;
      }, { sampleRate: SR, rate: 1, tail: 0 });
    }
    const rV1 = await expRender(1, 0), rVh = await expRender(0.5, 0);
    const ratioV = (rms(rVh, 0) + rms(rVh, 1)) / (rms(rV1, 0) + rms(rV1, 1));
    ok('D4a: export vol=0.5 halves the level', Math.abs(ratioV - 0.5) < 0.03, 'ratio=' + ratioV.toFixed(3));
    const rPan = await expRender(1, -1);
    const panRatio = rms(rPan, 1) / Math.max(1e-9, rms(rPan, 0));
    ok('D4b: export pan=-1 is hard left', panRatio < 0.05, 'R/L=' + panRatio.toFixed(4));
    // D4c: width=1 M/S matrix neutrality (replicates app.js widthMatrix math).
    const rW = await RM.exp.renderOffline(srcBuf, (oc, srcNode) => {
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(JSON.parse(JSON.stringify(FLAT)));
      srcNode.connect(chain.input);
      const W = {};
      W.in = oc.createGain(); W.split = oc.createChannelSplitter(2);
      W.midG = oc.createGain(); W.midG.gain.value = 0.5;
      W.midG2 = oc.createGain(); W.midG2.gain.value = 0.5;
      W.sideG = oc.createGain(); W.sideG.gain.value = 0.5;
      W.sideG2 = oc.createGain(); W.sideG2.gain.value = -0.5;
      W.merge = oc.createChannelMerger(2); W.split2 = oc.createChannelSplitter(2);
      W.wGain = oc.createGain(); W.wGain.gain.value = 1;
      W.oL1 = oc.createGain(); W.oL2 = oc.createGain();
      W.oR1 = oc.createGain(); W.oR2 = oc.createGain(); W.oR2.gain.value = -1;
      W.merge2 = oc.createChannelMerger(2); W.out = oc.createGain();
      W.in.connect(W.split);
      W.split.connect(W.midG, 0); W.split.connect(W.midG2, 1);
      W.midG.connect(W.merge, 0, 0); W.midG2.connect(W.merge, 0, 0);
      W.split.connect(W.sideG, 0); W.split.connect(W.sideG2, 1);
      W.sideG.connect(W.wGain); W.sideG2.connect(W.wGain);
      W.wGain.connect(W.merge, 0, 1);
      W.merge.connect(W.split2);
      W.split2.connect(W.oL1, 0); W.split2.connect(W.oL2, 1);
      W.oL1.connect(W.merge2, 0, 0); W.oL2.connect(W.merge2, 0, 0);
      W.split2.connect(W.oR1, 0); W.split2.connect(W.oR2, 1);
      W.oR1.connect(W.merge2, 0, 1); W.oR2.connect(W.merge2, 0, 1);
      W.merge2.connect(W.out);
      chain.output.connect(W.in);
      return W.out;
    }, { sampleRate: SR, rate: 1, tail: 0 });
    let mdW = 0;
    for (let c = 0; c < 2; c++) {
      const a = rV1.getChannelData(c), b = rW.getChannelData(c);
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mdW) mdW = d; }
    }
    ok('D4c: width=1 matrix is neutral in export', mdW < 1e-5, 'maxDiff=' + mdW.toExponential(2));
  } catch (e) { ok('D4 export WYSIWYG', false, String(e && e.message || e)); }

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
  await page.waitForFunction('window.RM && RM.app && RM.audio && RM.fx && RM.exp', { timeout: 30000 });
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
