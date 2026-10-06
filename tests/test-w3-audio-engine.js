#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix — W3 "TITE SE FIX": audio engine deep (Hasnain: "AWAZ pe focus")
   ---------------------------------------------------------------------
   Signal-level verification of the REAL RM.audio / RM.fx / RM.exp code
   in headless Chrome (OfflineAudioContext renders).

   KNOWN CHROME QUIRK (measured, documented in audio-engine.js): the
   DynamicsCompressor used as limiter lifts sub-threshold signals by
   ~+0.85 dB and adds ~137 samples of latency. The chain limiter sits in
   BOTH playback and export paths (cancels for vol/pan match); the master
   limiter is playback-only (+0.85 dB systematic, reported in S4).

   S1 BYPASS: every FX OFF -> true bypass (reverb/chorus/echo/EQ/drive/
       filter/comp/8D/3D/16D/360°; 360° "HRTF active while off" regression)
   S2 TAIL: export tail covers echo RT60 (doExport + RM.exp.tailForFx unit
       tests + remix-buffer/stem-pipeline render sites)
   S3 CLIP: hot chains hard-limited <= 0.9952, never NaN/>1.0
   S4 WYSIWYG: vol/pan playback vs export (lag-compensated); master-limiter
       +0.85 dB reported, not "fixed" (Chrome quirk in a safety block)
   S5 SR: 44.1k<->48k resample keeps pitch+duration; slowed rate math
   S6 DOUBLE/CLICK: no dry/wet doubling; mid-playback toggles click-free,
       incl. the 1200ms spatial-bypass fix (paced realtime simulation)
   S7 STUTTER: idle bypass states; per-FX render-time proxy (convolver cost
       appears ONLY when that FX is on)

   Exit code non-zero on any failure.
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const SHELL = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE_URL = 'file:///home/hatch/workspace/ruhmix/www/index.html';

const PAGE_TESTS = `async () => {
  const T = [];
  const ok = (name, pass, detail) => T.push({ name, pass: !!pass, detail: detail || '' });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SR = 44100;
  const FLAT = { eq3: [0,0,0], eq10: [0,0,0,0,0,0,0,0,0,0], filter: 19000, drive: 0,
    chorus: { on: false }, echo: { on: false }, reverb: { on: false },
    comp: { on: false }, out: 1.0 };

  function testTone(oc, secs, amp) {
    const len = Math.floor(SR * secs), b = oc.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const fs = c === 0 ? [220, 440, 660] : [330, 554.37, 880];
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        d[i] = amp * (Math.sin(2 * Math.PI * fs[0] * t)
                    + 0.6 * Math.sin(2 * Math.PI * fs[1] * t)
                    + 0.3 * Math.sin(2 * Math.PI * fs[2] * t)) / 1.9;
      }
    }
    return b;
  }
  function fadeTone(oc, secs, amp) {
    const b = testTone(oc, secs, amp), fade0 = secs - 0.5;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const t = i / SR;
        if (t > fade0) d[i] *= Math.max(0, 1 - (t - fade0) / 0.5);
      }
    }
    return b;
  }
  function impulseBuf(oc, secs, amp) {
    const len = Math.floor(SR * secs), b = oc.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) b.getChannelData(c)[Math.floor(SR * 0.05)] = amp;
    return b;
  }
  function rms(b) {
    let s = 0, n = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; n++; }
    }
    return Math.sqrt(s / Math.max(1, n));
  }
  function peak(b) {
    let m = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    }
    return m;
  }
  function hasNaN(b) {
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) if (!isFinite(d[i])) return true;
    }
    return false;
  }
  function maxAbsRange(b, t0, t1) {
    const i0 = Math.max(0, Math.floor(t0 * SR)), i1 = Math.min(b.length, Math.floor(t1 * SR));
    let m = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = i0; i < i1; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
    }
    return m;
  }
  function rmsRange(b, t0, t1) {
    const i0 = Math.max(0, Math.floor(t0 * SR)), i1 = Math.min(b.length, Math.floor(t1 * SR));
    let s = 0, n = 0;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = i0; i < i1; i++) { s += d[i] * d[i]; n++; }
    }
    return Math.sqrt(s / Math.max(1, n));
  }
  function maxDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let m = 0;
    for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) {
      const da = a.getChannelData(c), db = b.getChannelData(c);
      for (let i = 0; i < n; i++) { const d = Math.abs(da[i] - db[i]); if (d > m) m = d; }
    }
    return m;
  }
  // lag-compensated maxDiff (for graphs containing limiters: ~137-sample latency)
  // lag via cross-correlation over the FIRST second (covers impulse responses)
  function xcorrLag(a, b) {
    const da = a.getChannelData(0), db = b.getChannelData(0);
    const t0 = 0, t1 = Math.min(da.length, db.length, SR);
    let bestLag = 0, bestC = -Infinity;
    for (let lag = -500; lag <= 500; lag++) {
      let s = 0;
      for (let i = t0; i < t1; i += 2) {
        const j = i + lag;
        if (j < 0 || j >= db.length) continue;
        s += da[i] * db[j];
      }
      if (s > bestC) { bestC = s; bestLag = lag; }
    }
    return bestLag;
  }
  function maxDiffLag(a, b, lag) {
    const n = Math.min(a.length, b.length) - Math.abs(lag) - 10;
    let m = 0;
    for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) {
      const da = a.getChannelData(c), db = b.getChannelData(c);
      for (let i = 10; i < n; i++) {
        const d = Math.abs(da[i] - db[i + lag]);
        if (d > m) m = d;
      }
    }
    return m;
  }
  const db = (r) => 20 * Math.log10(Math.max(1e-12, r));
  function scanClicks(b, thr, t0, t1) {
    const i0 = t0 == null ? 1 : Math.floor(t0 * SR), i1 = t1 == null ? b.length : Math.floor(t1 * SR);
    let maxJump = 0, clicks = 0, clickT = -1;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      let prev = d[i0];
      for (let i = i0 + 1; i < i1; i++) {
        const j = Math.abs(d[i] - prev);
        if (j > maxJump) maxJump = j;
        if (j > thr) { clicks++; if (clickT < 0) clickT = i / SR; }
        prev = d[i];
      }
    }
    return { maxJump, clicks, clickT };
  }
  function panSpread(b, t0, t1, winSecs) {
    const w = Math.floor(SR * winSecs);
    const i0 = Math.floor(t0 * SR), i1 = Math.floor(t1 * SR);
    let mn = Infinity, mx = -Infinity;
    for (let k = i0; k + w <= i1; k += w) {
      let sl = 0, sr = 0;
      const dl = b.getChannelData(0), dr = b.getChannelData(1);
      for (let i = k; i < k + w; i++) { sl += dl[i] * dl[i]; sr += dr[i] * dr[i]; }
      const r = Math.sqrt(sl / Math.max(1e-12, sr));
      if (r < mn) mn = r; if (r > mx) mx = r;
    }
    return mx - mn;
  }
  function zeroXFreq(b, ch) {
    const sr = b.sampleRate, d = b.getChannelData(ch || 0);
    let zc = 0, first = -1, last = -1;
    for (let i = 1; i < d.length; i++) {
      if ((d[i - 1] < 0) !== (d[i] < 0)) { zc++; if (first < 0) first = i; last = i; }
    }
    if (zc < 4 || last <= first) return 0;
    return ((zc - 1) / 2) / ((last - first) / sr);
  }
  async function renderChain(preset, srcBuf, secs, tailSec) {
    const oc = new OfflineAudioContext(2, Math.ceil(SR * (secs + (tailSec || 0))), SR);
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(preset)));
    const src = oc.createBufferSource();
    src.buffer = srcBuf || testTone(oc, secs, 0.5);
    src.connect(chain.input);
    chain.output.connect(oc.destination);
    src.start(0);
    const r = await oc.startRendering();
    try { chain.dispose(); } catch (e) {}
    try { await oc.close(); } catch (e) {}
    return r;
  }
  function doExportGraph(oc, srcNode, fxp, vol, pan, widthVal) {
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(fxp)));
    srcNode.connect(chain.input);
    const W = RM.app.widthMatrix(oc, widthVal == null ? 1 : widthVal);
    chain.output.connect(W.in);
    let outNode = W.out;
    const xVol = (vol != null ? vol : 1), xPan = (pan || 0);
    if (xVol !== 1 || xPan !== 0) {
      const xg = oc.createGain(); xg.gain.value = xVol; W.out.connect(xg);
      const xp = oc.createStereoPanner(); xp.pan.value = Math.max(-1, Math.min(1, xPan));
      xg.connect(xp); outNode = xp;
    }
    return { outNode, chain };
  }
  function playbackGraph(oc, srcNode, fxp, vol, pan, widthVal) {
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(fxp)));
    srcNode.connect(chain.input);
    const W = RM.app.widthMatrix(oc, widthVal == null ? 1 : widthVal);
    chain.output.connect(W.in);
    const panner = oc.createStereoPanner(); panner.pan.value = pan || 0;
    const gain = oc.createGain(); gain.gain.value = (vol != null ? vol : 1);
    W.out.connect(panner); panner.connect(gain);
    const analyser = oc.createAnalyser();
    const limiter = oc.createDynamicsCompressor();
    limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.15;
    const clipper = RM.audio.createSafetyClipper(oc);
    gain.connect(analyser); analyser.connect(limiter); limiter.connect(clipper);
    return { outNode: clipper, chain };
  }
  const withSpatial = (mode) => {
    const p = JSON.parse(JSON.stringify(FLAT)); p.spatial = { mode, speed: 0.12, depth: 1 };
    return p;
  };

  /* ================= S1: BYPASS ================= */
  // S1a: whole-chain sanity — no doubling. (Per-block bit-transparency is
  // proven in S1b-g via same-topology comparisons. The chain's two
  // DynamicsCompressors add constant inaudible latency (Chrome), so a
  // sample-exact vs-input comparison is not meaningful; level is.)
  try {
    const oc = new OfflineAudioContext(2, SR * 3, SR);
    const tone = testTone(oc, 3, 0.5);
    const rFlat = await renderChain(FLAT, tone, 3);
    const ddb = Math.abs(db(rms(rFlat) / rms(tone)));
    ok('S1a flat chain: no doubling (only the documented limiter lift)',
       ddb < 1.2, 'dB=' + ddb.toFixed(3));
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('S1a flat level', false, String(e && e.message || e)); }

  // S1b: reverb ON -> tail; OFF (fresh) == flat; OFF (live toggle path) == flat
  try {
    const oc0 = new OfflineAudioContext(2, SR * 3, SR);
    const imp = impulseBuf(oc0, 3, 0.5);
    const pOn = JSON.parse(JSON.stringify(FLAT)); pOn.reverb = { on: true, room: 'church' };
    const rOn = await renderChain(pOn, imp, 3);
    const tailE = maxAbsRange(rOn, 0.06, 0.5);
    const rFlat = await renderChain(FLAT, imp, 3);
    const mdFresh = maxDiff(rFlat, await renderChain(
      (() => { const p = JSON.parse(JSON.stringify(FLAT)); p.reverb = { on: false, room: 'church' }; return p; })(),
      imp, 3));
    const oc2 = new OfflineAudioContext(2, SR * 3, SR);
    const chain = RM.fx.makeChain(oc2);
    chain.applyPreset(pOn);
    chain.set('reverbOn', false); // live toggle: convolver edge disconnects synchronously
    const bypassState = chain.getBypass().reverb === true;
    const src = oc2.createBufferSource(); src.buffer = imp;
    src.connect(chain.input); chain.output.connect(oc2.destination); src.start(0);
    const rOff = await oc2.startRendering();
    try { chain.dispose(); } catch (e) {}
    const mdToggle = maxDiff(rFlat, rOff);
    ok('S1b reverb ON has early tail (sanity)', tailE > 0.02, 'tailMax=' + tailE.toFixed(4));
    ok('S1b reverb OFF == flat (fresh + live-toggle path)', mdFresh < 2e-5 && mdToggle < 2e-5 && bypassState,
       'fresh=' + mdFresh.toExponential(1) + ' toggle=' + mdToggle.toExponential(1) + ' bypass=' + bypassState);
    try { await oc0.close(); await oc2.close(); } catch (e) {}
  } catch (e) { ok('S1b reverb bypass', false, String(e && e.message || e)); }

  // S1c/d: chorus + echo OFF (fresh) == flat
  for (const fxName of ['chorus', 'echo']) {
    try {
      const oc0 = new OfflineAudioContext(2, SR * 3, SR);
      const sig = fxName === 'echo' ? impulseBuf(oc0, 3, 0.5) : testTone(oc0, 3, 0.5);
      const pOn = JSON.parse(JSON.stringify(FLAT));
      if (fxName === 'chorus') pOn.chorus = { on: true, rate: 1.2, depth: 0.004 };
      else pOn.echo = { on: true, time: 0.375, fb: 0.35, wet: 0.35 };
      const rOn = await renderChain(pOn, sig, 3);
      const rFlat = await renderChain(FLAT, sig, 3);
      const pOff = JSON.parse(JSON.stringify(pOn));
      pOff[fxName].on = false;
      const rOff = await renderChain(pOff, sig, 3);
      const changed = maxDiff(rFlat, rOn), md = maxDiff(rFlat, rOff);
      ok('S1' + fxName + ' ON changes signal, OFF == flat', changed > 0.01 && md < 2e-5,
         'onDiff=' + changed.toFixed(4) + ' offDiff=' + md.toExponential(1));
      try { await oc0.close(); } catch (e) {}
    } catch (e) { ok('S1 ' + fxName + ' bypass', false, String(e && e.message || e)); }
  }

  // S1e: spatial 8d/3d/16d -> off == flat (waits out the 1200ms bypass timer)
  for (const m of ['8d', '3d', '16d']) {
    try {
      const oc0 = new OfflineAudioContext(2, SR * 8, SR);
      const tone = testTone(oc0, 8, 0.5);
      const rMode = await renderChain(withSpatial(m), tone, 8);
      const spread = panSpread(rMode, 1.5, 7.5, 1.0);
      const rFlat = await renderChain(FLAT, tone, 8);
      const oc2 = new OfflineAudioContext(2, SR * 8, SR);
      const chain = RM.fx.makeChain(oc2);
      chain.applyPreset(withSpatial(m));
      chain.set('spatialMode', 'off');
      await wait(1500); // 1200ms physical-bypass timer (real time)
      const bState = chain.getBypass().spatial === true;
      const src = oc2.createBufferSource(); src.buffer = tone;
      src.connect(chain.input); chain.output.connect(oc2.destination); src.start(0);
      const rOff = await oc2.startRendering();
      try { chain.dispose(); } catch (e) {}
      const md = maxDiff(rFlat, rOff);
      ok('S1e ' + m + ' moves image; ->off == flat, bypassed', spread > 0.1 && md < 1e-4 && bState,
         'spread=' + spread.toFixed(3) + ' offDiff=' + md.toExponential(1) + ' bypass=' + bState);
      try { await oc0.close(); await oc2.close(); } catch (e) {}
    } catch (e) { ok('S1e spatial ' + m, false, String(e && e.message || e)); }
  }

  // S1f: 360° HRTF regression — gate=0 and input starved in every non-360 mode
  try {
    const ocT = new OfflineAudioContext(2, SR * 3, SR);
    const chain = RM.fx.makeChain(ocT);
    let gateZero = true;
    for (const m of ['off', '8d', '3d', '16d']) {
      chain.set('spatialMode', m);
      if (chain.nodes.spatial.nodes.s360.nodes.gate.gain.value !== 0) gateZero = false;
    }
    chain.set('spatialMode', '8d');
    await wait(1600);
    const starved = chain.nodes.spatial.isS360Starved() === true;
    ok('S1f 360° gate=0 in off/8d/3d/16d', gateZero, '');
    ok('S1f 360° branch input physically disconnected when idle', starved, '');
    const oc0 = new OfflineAudioContext(2, SR * 4, SR);
    const tone = testTone(oc0, 4, 0.5);
    const rA = await renderChain(withSpatial('8d'), tone, 4);
    const rB = await (async () => {
      const oc2 = new OfflineAudioContext(2, SR * 4, SR);
      const ch2 = RM.fx.makeChain(oc2);
      ch2.applyPreset(withSpatial('8d'));
      const sp = ch2.nodes.spatial;
      try { sp.nodes.input.connect(sp.nodes.s360.input); } catch (e) {}
      sp.nodes.s360.setOn(true, true);
      const src = oc2.createBufferSource(); src.buffer = tone;
      src.connect(ch2.input); ch2.output.connect(oc2.destination); src.start(0);
      const r = await oc2.startRendering();
      try { ch2.dispose(); } catch (e) {}
      try { await oc2.close(); } catch (e) {}
      return r;
    })();
    const ddb = Math.abs(db(rms(rB) / rms(rA)));
    ok('S1f forced-on 360° changes 8d output (proves it was off)', ddb > 2, 'dB=' + ddb.toFixed(2));
    try { chain.dispose(); } catch (e) {}
    try { await ocT.close(); await oc0.close(); } catch (e) {}
  } catch (e) { ok('S1f 360 regression', false, String(e && e.message || e)); }

  // S1g: 360 mode — no doubling; 360 -> off == flat
  try {
    const oc0 = new OfflineAudioContext(2, SR * 8, SR);
    const tone = testTone(oc0, 8, 0.5);
    const p360 = withSpatial('360'); p360.spatial.speed = 0.25;
    const r360 = await renderChain(p360, tone, 8);
    const ddb = db(rms(r360) / rms(tone));
    const spread = panSpread(r360, 1.5, 7.5, 1.0);
    const rFlat = await renderChain(FLAT, tone, 8);
    const oc2 = new OfflineAudioContext(2, SR * 8, SR);
    const chain = RM.fx.makeChain(oc2);
    chain.applyPreset(p360);
    chain.set('spatialMode', 'off');
    await wait(1600);
    const starved = chain.nodes.spatial.isS360Starved() === true;
    const src = oc2.createBufferSource(); src.buffer = tone;
    src.connect(chain.input); chain.output.connect(oc2.destination); src.start(0);
    const rOff = await oc2.startRendering();
    try { chain.dispose(); } catch (e) {}
    const md = maxDiff(rFlat, rOff);
    ok('S1g 360°: no doubling, image orbits', Math.abs(ddb) < 1.5 && spread > 0.15,
       'dB=' + ddb.toFixed(2) + ' spread=' + spread.toFixed(3));
    ok('S1g 360° -> off == flat, branch starved', md < 1e-4 && starved,
       'offDiff=' + md.toExponential(1) + ' starved=' + starved);
    try { await oc0.close(); await oc2.close(); } catch (e) {}
  } catch (e) { ok('S1g 360 mode', false, String(e && e.message || e)); }

  /* ================= S2: TAIL ================= */
  // S2a: real export renderer — church + hot echo, RT60-aware tail
  try {
    const actx = RM.audio.ensureCtx();
    const imp = actx.createBuffer(2, Math.floor(SR * 3), SR);
    for (let c = 0; c < 2; c++) imp.getChannelData(c)[Math.floor(SR * 0.05)] = 0.5;
    const preset = JSON.parse(JSON.stringify(FLAT));
    preset.reverb = { on: true, room: 'church' };
    preset.echo = { on: true, time: 0.375, fb: 0.85, wet: 0.35 };
    const tail = RM.exp.tailForFx(preset); // ~15.94
    const rendered = await RM.exp.renderOffline(imp, (oc, srcNode) =>
      doExportGraph(oc, srcNode, preset, 1, 0, 1).outNode, { sampleRate: SR, tail });
    const tailPresent = maxAbsRange(rendered, 3.2, 4.0) > 0.005; // vs 0.5 input click
    const tailEnd = maxAbsRange(rendered, rendered.duration - 1.0, rendered.duration);
    const lenOk = Math.abs(rendered.length - Math.ceil((3 + tail) * SR)) <= 2;
    ok('S2a export tail present then fully decayed (tail=' + tail.toFixed(2) + 's)',
       tailPresent && tailEnd < 0.001 && lenOk,
       'present=' + tailPresent + ' endMax=' + tailEnd.toExponential(2) + ' lenOk=' + lenOk);
  } catch (e) { ok('S2a export tail', false, String(e && e.message || e)); }

  // S2b: tailForFx unit tests
  try {
    const t1 = RM.exp.tailForFx({ echo: { on: false } });
    const t2 = RM.exp.tailForFx({ echo: { on: true, time: 0.75, fb: 0.4 } });
    const t3 = RM.exp.tailForFx({ echo: { on: true, time: 0.375, fb: 0.85 } });
    const t4 = RM.exp.tailForFx({ echo: { on: true, time: 1.8, fb: 0.99 } });
    const t5 = RM.exp.tailForFx(null), t6 = RM.exp.tailForFx({ echo: { on: true, time: 0.375, fb: 0 } });
    ok('S2b tailForFx units', t1 === 2.5 && Math.abs(t2 - 5.65) < 0.02 && Math.abs(t3 - 15.94) < 0.02 &&
       t4 === 20 && t5 === 2.5 && t6 === 2.5,
       'off=' + t1 + ' fb.4=' + t2.toFixed(2) + ' fb.85=' + t3.toFixed(2) + ' cap=' + t4);
  } catch (e) { ok('S2b tailForFx', false, String(e && e.message || e)); }

  // S2c: the old 1487-style fixed 2.5s tail chopped beat-synced echo; the fix covers it
  try {
    const actx = RM.audio.ensureCtx();
    const song = fadeTone(actx, 3, 0.5);
    const preset = JSON.parse(JSON.stringify(FLAT));
    preset.reverb = { on: true, room: 'church' };
    preset.echo = { on: true, time: 0.75, fb: 0.4, wet: 0.3 }; // beat-synced @60BPM
    const graphOf = (oc, srcNode) => doExportGraph(oc, srcNode, preset, 1, 0, 1).outNode;
    const rShort = await RM.exp.renderOffline(song, graphOf, { sampleRate: SR }); // old fixed 2.5s
    const fixedTail = RM.exp.tailForFx(preset);
    const rLong = await RM.exp.renderOffline(song, graphOf, { sampleRate: SR, tail: fixedTail });
    const trunc = maxAbsRange(rShort, rShort.duration - 0.05, rShort.duration);
    const missing = rmsRange(rLong, 5.0, 6.5);
    const endLong = maxAbsRange(rLong, rLong.duration - 1, rLong.duration);
    ok('S2c old fixed tail chopped echo; tailForFx covers it',
       trunc > 0.005 && missing > 0.001 && Math.abs(fixedTail - 5.65) < 0.02 && endLong < 0.001,
       'trunc=' + trunc.toFixed(4) + ' missingRMS=' + missing.toFixed(4) +
       ' fixedTail=' + fixedTail.toFixed(2) + ' longEnd=' + endLong.toExponential(2));
  } catch (e) { ok('S2c tail fix', false, String(e && e.message || e)); }

  /* ================= S3: CLIP ================= */
  try {
    const oc0 = new OfflineAudioContext(2, SR * 3, SR);
    const hot = testTone(oc0, 3, 0.9);
    const pHot = JSON.parse(JSON.stringify(FLAT));
    pHot.out = 2; pHot.eq3 = [15, 15, 15]; pHot.drive = 0.5;
    pHot.comp = { on: true, thr: -18, ratio: 4, atk: 0.01, rel: 0.25 };
    const rHot = await renderChain(pHot, hot, 3);
    const pX = JSON.parse(JSON.stringify(pHot));
    pX.eq10 = [15,15,15,15,15,15,15,15,15,15];
    const rX = await renderChain(pX, hot, 3);
    const oc3 = new OfflineAudioContext(2, SR * 3, SR);
    const mc = RM.fx.makeMasterChain(oc3, { eqB: 0, eqM: 0, eqT: 0, thr: -14, knee: 8, ratio: 3, atk: 0.008, rel: 0.25, makeup: 2 });
    const src3 = oc3.createBufferSource(); src3.buffer = hot;
    src3.connect(mc.input); mc.output.connect(oc3.destination); src3.start(0);
    const rM = await oc3.startRendering();
    try { mc.dispose(); } catch (e) {}
    const pk = peak(rHot), pkX = peak(rX), pkM = peak(rM);
    ok('S3 hot chains hard-limited (true ceiling, no NaN)',
       pk <= 0.996 && pkX <= 0.996 && pkM <= 0.996 &&
       !hasNaN(rHot) && !hasNaN(rX) && !hasNaN(rM),
       'peaks=' + pk.toFixed(4) + '/' + pkX.toFixed(4) + '/' + pkM.toFixed(4));
    try { await oc0.close(); await oc3.close(); } catch (e) {}
  } catch (e) { ok('S3 clipping', false, String(e && e.message || e)); }

  /* ================= S4: VOL/PAN WYSIWYG ================= */
  // Bit-identical proof with an impulse (unambiguous lag): the playback
  // graph minus its master limiter vs the export graph. Playback order is
  // panner->gain, export is gain->panner — both linear, must commute.
  try {
    const actx = RM.audio.ensureCtx();
    const imp = actx.createBuffer(2, SR * 2, SR);
    for (let c = 0; c < 2; c++) imp.getChannelData(c)[2205] = 0.5;
    const preset = RM.app.defaultFx(); // deterministic (no reverb/echo)
    const rExp = await RM.exp.renderOffline(imp,
      (oc, s) => doExportGraph(oc, s, preset, 0.9, 0.3, 1).outNode,
      { sampleRate: SR, tail: 0 });
    // shorted playback graph: identical chain+width, then panner(pan)->gain(vol)
    // exactly like the live player, but without the master limiter.
    const rPlayShorted = await RM.exp.renderOffline(imp, (oc, srcNode) => {
      const chain = RM.fx.makeChain(oc);
      chain.applyPreset(JSON.parse(JSON.stringify(preset)));
      srcNode.connect(chain.input);
      const W = RM.app.widthMatrix(oc, 1);
      chain.output.connect(W.in);
      const panner = oc.createStereoPanner(); panner.pan.value = 0.3;
      const gain = oc.createGain(); gain.gain.value = 0.9;
      W.out.connect(panner); panner.connect(gain);
      return gain;
    }, { sampleRate: SR, tail: 0 });
    const lag = xcorrLag(rExp, rPlayShorted);
    const md = maxDiffLag(rExp, rPlayShorted, lag);
    const ddb = Math.abs(db(rms(rPlayShorted) / rms(rExp)));
    ok('S4a vol/pan bit-identical playback vs export (impulse, lag-compensated)',
       lag === 0 && md < 1e-6 && ddb < 1e-4,
       'lag=' + lag + ' maxDiff=' + md.toExponential(2) + ' dB=' + ddb.toFixed(5));
    // Full playback path (with master limiter) on a sustained tone: report
    // the Chrome limiter quirk (+0.85dB lift, ~137-sample latency).
    const tone = testTone(actx, 3, 0.5);
    const rExpT = await RM.exp.renderOffline(tone,
      (oc, s) => doExportGraph(oc, s, preset, 0.9, 0.3, 1).outNode,
      { sampleRate: SR, tail: 0 });
    const rPlayT = await RM.exp.renderOffline(tone,
      (oc, s) => playbackGraph(oc, s, preset, 0.9, 0.3, 1).outNode,
      { sampleRate: SR, tail: 0 });
    const ddbT = db(rms(rPlayT) / rms(rExpT));
    ok('S4b master-limiter quirk REPORT (playback-only, sustained tone)',
       ddbT > 0.5 && ddbT < 1.2, 'playback hotter by ' + ddbT.toFixed(3) + 'dB');
  } catch (e) { ok('S4 vol/pan', false, String(e && e.message || e)); }

  /* ================= S5: SAMPLE RATE ================= */
  try {
    const oc48 = new OfflineAudioContext(2, 48000 * 2, 48000);
    const pure48 = oc48.createBuffer(2, 48000 * 2, 48000);
    for (let c = 0; c < 2; c++) {
      const d = pure48.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
    }
    const rs441 = await RM.audio.resampleBuffer(pure48, 44100);
    const f441 = zeroXFreq(rs441, 0);
    const pure44 = oc48.createBuffer(2, 44100 * 2, 44100);
    for (let c = 0; c < 2; c++) {
      const d = pure44.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 44100);
    }
    const rs48 = await RM.audio.resampleBuffer(pure44, 48000);
    const f48 = zeroXFreq(rs48, 0);
    ok('S5a resample 48k->44.1k keeps pitch+duration',
       Math.abs(f441 - 440) < 0.5 && Math.abs(rs441.duration - 2) < 0.002,
       'f=' + f441.toFixed(2) + 'Hz');
    ok('S5b resample 44.1k->48k keeps pitch+duration',
       Math.abs(f48 - 440) < 0.5 && Math.abs(rs48.duration - 2) < 0.002,
       'f=' + f48.toFixed(2) + 'Hz');
    const r480 = await RM.exp.renderOffline(pure44, (oc, s) => s, { sampleRate: 48000, tail: 0 });
    ok('S5c export render 44.1k->48k keeps pitch',
       r480.sampleRate === 48000 && Math.abs(zeroXFreq(r480, 0) - 440) < 0.5,
       'f=' + zeroXFreq(r480, 0).toFixed(2) + 'Hz');
    const rSlow = await RM.exp.renderOffline(pure44, (oc, s) => s, { sampleRate: 44100, rate: 0.5, tail: 0 });
    ok('S5d slowed 0.5x: duration 2x, pitch halves (intended)',
       Math.abs(rSlow.duration - 4) < 0.01 && Math.abs(zeroXFreq(rSlow, 0) - 220) < 0.5,
       'dur=' + rSlow.duration.toFixed(2));
    try { await oc48.close(); } catch (e) {}
  } catch (e) { ok('S5 sample rate', false, String(e && e.message || e)); }

  /* ================= S6: DOUBLING + CLICK ================= */
  try {
    const oc0 = new OfflineAudioContext(2, SR * 3, SR);
    const tone = testTone(oc0, 3, 0.5);
    const ocD = new OfflineAudioContext(2, SR * 3, SR);
    const srcD = ocD.createBufferSource(); srcD.buffer = tone;
    const g1 = ocD.createGain(), g2 = ocD.createGain();
    srcD.connect(g1); g1.connect(ocD.destination);
    srcD.connect(g2); g2.connect(ocD.destination);
    srcD.start(0);
    const rDbl = await ocD.startRendering();
    const dblDb = db(rms(rDbl) / rms(tone));
    // flat chain vs input, lag-compensated (limiter latency), must show NO doubling
    const rFlat = await renderChain(FLAT, tone, 3);
    const flatDb = Math.abs(db(rms(rFlat) / rms(tone)));
    ok('S6a doubling detector valid; flat chain not doubled',
       Math.abs(dblDb - 6.02) < 0.05 && flatDb < 1.2,
       'doubled=' + dblDb.toFixed(2) + 'dB flat=' + flatDb.toFixed(3) + 'dB (quirk lift)');
    try { await oc0.close(); await ocD.close(); } catch (e) {}
  } catch (e) { ok('S6a doubling', false, String(e && e.message || e)); }

  // S6b: mid-render FX toggles (suspend/resume at valid render times) click-free
  try {
    const secs = 10;
    const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(FLAT)));
    const tone = testTone(oc, secs, 0.2);
    const src = oc.createBufferSource(); src.buffer = tone;
    src.connect(chain.input); chain.output.connect(oc.destination); src.start(0);
    const at = async (t, fn, holdMs) => {
      await oc.suspend(t); fn(chain);
      await wait(holdMs == null ? 150 : holdMs); oc.resume();
    };
    const seq = (async () => {
      await at(1.0, (c) => c.set('reverbOn', true));
      await at(2.5, (c) => c.set('reverbOn', false));
      await at(3.5, (c) => c.set('chorusOn', true));
      await at(4.5, (c) => c.set('chorusOn', false));
      await at(5.5, (c) => c.set('echoOn', true));
      await at(6.5, (c) => c.set('echoOn', false));
      await at(7.5, (c) => c.set('compOn', true));
      await at(8.5, (c) => c.set('compOn', false));
    })();
    const r = await oc.startRendering();
    await seq;
    try { chain.dispose(); } catch (e) {}
    const sc = scanClicks(r, 0.05);
    ok('S6b FX toggles mid-render click-free', sc.clicks === 0,
       'clicks=' + sc.clicks + ' maxJump=' + sc.maxJump.toFixed(4));
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('S6b toggle clicks', false, String(e && e.message || e)); }

  // S6c: spatial 8d->off, paced ~realtime — the 1200ms bypass must not click
  // and must land ~1.2s after the switch (not 0.4s)
  try {
    const secs = 8;
    const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(withSpatial('8d'));
    const tone = testTone(oc, secs, 0.5);
    const src = oc.createBufferSource(); src.buffer = tone;
    src.connect(chain.input); chain.output.connect(oc.destination); src.start(0);
    let disconnectT = -1;
    const seq = (async () => {
      await oc.suspend(1.0);
      chain.set('spatialMode', 'off'); // 0.3tc glide + 1200ms delayed bypass
      oc.resume();
      for (let t = 1.2; t <= 6.0; t += 0.2) {
        await oc.suspend(t);
        if (disconnectT < 0 && chain.getBypass().spatial) disconnectT = oc.currentTime;
        await wait(200); // pace ~realtime
        oc.resume();
      }
    })();
    const r = await oc.startRendering();
    await seq;
    try { chain.dispose(); } catch (e) {}
    const sc = scanClicks(r, 0.05, Math.max(0, disconnectT - 0.4), disconnectT + 0.4);
    const rFlat = await renderChain(FLAT, tone, secs);
    let mdTail = 0;
    {
      const i0 = Math.floor(6.5 * SR), i1 = Math.floor(8 * SR);
      for (let c = 0; c < 2; c++) {
        const a = r.getChannelData(c), bch = rFlat.getChannelData(c);
        for (let i = i0; i < i1; i++) { const d = Math.abs(a[i] - bch[i]); if (d > mdTail) mdTail = d; }
      }
    }
    ok('S6c spatial off->bypass: no click, lands ~1.2s after switch, settles to flat',
       disconnectT > 0 && Math.abs(disconnectT - 2.2) < 0.6 && sc.clicks === 0 && mdTail < 0.02,
       'disconnectT=' + disconnectT.toFixed(2) + 's clicks=' + sc.clicks +
       ' maxJump=' + sc.maxJump.toFixed(4) + ' tailDiff=' + mdTail.toExponential(1));
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('S6c spatial bypass timing', false, String(e && e.message || e)); }

  // S6d: 360->8d, paced — the s360 input starve at 1200ms must not click
  try {
    const secs = 8;
    const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
    const p360 = withSpatial('360'); p360.spatial.speed = 0.25;
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(p360);
    const tone = testTone(oc, secs, 0.5);
    const src = oc.createBufferSource(); src.buffer = tone;
    src.connect(chain.input); chain.output.connect(oc.destination); src.start(0);
    let starveT = -1;
    const seq = (async () => {
      await oc.suspend(1.0);
      chain.set('spatialMode', '8d'); // s360 gate glides 1->0, input starves 1200ms later
      oc.resume();
      for (let t = 1.2; t <= 6.0; t += 0.2) {
        await oc.suspend(t);
        if (starveT < 0 && chain.nodes.spatial.isS360Starved()) starveT = oc.currentTime;
        await wait(200);
        oc.resume();
      }
    })();
    const r = await oc.startRendering();
    await seq;
    try { chain.dispose(); } catch (e) {}
    const sc = scanClicks(r, 0.05, Math.max(0, starveT - 0.4), starveT + 0.4);
    ok('S6d 360->8d starve: no click, lands ~1.2s after switch',
       starveT > 0 && Math.abs(starveT - 2.2) < 0.6 && sc.clicks === 0,
       'starveT=' + starveT.toFixed(2) + 's clicks=' + sc.clicks + ' maxJump=' + sc.maxJump.toFixed(4));
    try { await oc.close(); } catch (e) {}
  } catch (e) { ok('S6d 360 starve timing', false, String(e && e.message || e)); }

  /* ================= S7: STUTTER / IDLE ================= */
  try {
    const ocT = new OfflineAudioContext(2, SR * 2, SR);
    const chain = RM.fx.makeChain(ocT);
    chain.applyPreset(JSON.parse(JSON.stringify(FLAT)));
    const bp = chain.getBypass();
    await wait(1600); // 1200ms starve timer
    const starved = chain.nodes.spatial.isS360Starved() === true;
    ok('S7a idle: reverb+spatial bypassed, 360 input starved',
       bp.reverb === true && bp.spatial === true && starved,
       JSON.stringify(bp) + ' s360starved=' + starved);
    try { chain.dispose(); } catch (e) {}
    try { await ocT.close(); } catch (e) {}
  } catch (e) { ok('S7a idle bypass', false, String(e && e.message || e)); }

  // S7b: per-FX render-time proxy — convolver cost appears ONLY when enabled
  try {
    const secs = 20;
    async function timeChain(preset) {
      const oc = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
      const tone = testTone(oc, secs, 0.2);
      const ch = RM.fx.makeChain(oc);
      ch.applyPreset(JSON.parse(JSON.stringify(preset)));
      const src = oc.createBufferSource(); src.buffer = tone;
      src.connect(ch.input); ch.output.connect(oc.destination); src.start(0);
      const t0 = performance.now();
      await oc.startRendering();
      const ms = performance.now() - t0;
      try { ch.dispose(); } catch (e) {}
      try { await oc.close(); } catch (e) {}
      return ms;
    }
    const pRev = JSON.parse(JSON.stringify(FLAT)); pRev.reverb = { on: true, room: 'church' };
    const pSpa = withSpatial('8d');
    const pBoth = JSON.parse(JSON.stringify(pRev)); pBoth.spatial = { mode: '8d', speed: 0.12, depth: 1 };
    const tF = await timeChain(FLAT);
    const tR = await timeChain(pRev);
    const tS = await timeChain(pSpa);
    const tB = await timeChain(pBoth);
    ok('S7b convolver cost only when enabled; idle chain has headroom',
       tF < 2000 && tR > tF * 1.1 && tS > tF * 1.1 && tB > tF * 1.2,
       'flat=' + tF.toFixed(0) + 'ms reverb=' + tR.toFixed(0) + 'ms spatial=' + tS.toFixed(0) +
       'ms both=' + tB.toFixed(0) + 'ms (20s audio)');
  } catch (e) { ok('S7b render-time proxy', false, String(e && e.message || e)); }

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
