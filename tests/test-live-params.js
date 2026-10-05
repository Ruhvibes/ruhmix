#!/usr/bin/env node
'use strict';
/* =====================================================================
   RuhMix — live edit params verification (speed, volume, pan, loop)
   ---------------------------------------------------------------------
   Signal-level tests for the live (non-op) params in www/js/audio-engine.js
   (makePlayer) plus the small wiring in app.js.

   Method:
   - Real player: window.RM.audio.makePlayer() on a live AudioContext —
     verifies the actual setter code paths (setRate/setVolume/setPan/setLoop),
     stored fields, play()-time re-application, and loop flag behavior.
   - Offline renders: an OfflineAudioContext graph that mirrors makePlayer's
     EXACT topology (src -> env -> insert -> panner -> gain -> destination)
     with params applied exactly the way play()/the setters converge them to
     (playbackRate/loop assigned directly by play(); volume/pan converge to
     the setter target). A live AudioContext cannot render offline, so this
     is the ground truth for what the listener actually hears.
   - UI labels: DOM checks on www/index.html (English + honest).

   Exit code is non-zero on any failure. Each test prints PASS/FAIL.
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const SHELL = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE_URL = 'file:///home/hatch/workspace/ruhmix/www/index.html';

/* Runs entirely inside the page; returns an array of {name, pass, detail}. */
const PAGE_TESTS = `async () => {
  const T = [];
  const ok = (name, pass, detail) => T.push({ name, pass: !!pass, detail: detail || '' });
  const SR = 44100;

  /* ---- shared DSP helpers (offline ground truth) ---- */
  function testBuffer(oc, secs) {
    // L = 440 Hz, R = 660 Hz, amplitude 0.5 — channels separable by ear and by measurement
    const b = oc.createBuffer(2, Math.floor(SR * secs), SR);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c), f = c === 0 ? 440 : 660;
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
    }
    return b;
  }
  // Offline replica of makePlayer's exact topology:
  // src -> env -> insert -> panner -> gain -> destination.
  // Params are applied the way the real code converges them:
  //   rate/loop: assigned directly by play(); vol/pan: setter targets.
  async function renderPlayerGraph({ rate, vol, pan, loop, loopStart, loopEnd, bufSecs, renderSecs }) {
    rate = rate == null ? 1 : rate; vol = vol == null ? 1 : vol; pan = pan || 0;
    const oc = new OfflineAudioContext(2, Math.ceil(SR * renderSecs), SR);
    const src = oc.createBufferSource();
    src.buffer = testBuffer(oc, bufSecs);
    src.playbackRate.value = rate;
    if (loop && loopEnd > loopStart) { src.loop = true; src.loopStart = loopStart; src.loopEnd = loopEnd; }
    const env = oc.createGain(); env.gain.value = 0;
    env.gain.setTargetAtTime(1, 0, 0.008); // FADE_TC, mirrors play()
    const insert = oc.createGain();
    const panner = oc.createStereoPanner(); panner.pan.value = pan;
    const gain = oc.createGain(); gain.gain.value = vol;
    src.connect(env); env.connect(insert); insert.connect(panner);
    panner.connect(gain); gain.connect(oc.destination);
    if (loop && loopEnd > loopStart) src.start(0, 0);
    else src.start(0, 0, Math.max(0.05, bufSecs));
    return oc.startRendering();
  }
  const rms = (ch, a, b) => {
    let s = 0; for (let i = a; i < b; i++) s += ch[i] * ch[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const skip = (rendered) => Math.floor(SR * 0.3); // past env convergence
  function freqByZeroCross(ch, a, b) {
    let zc = 0;
    for (let i = a + 1; i < b; i++) if ((ch[i - 1] < 0) !== (ch[i] < 0)) zc++;
    return zc / 2 / ((b - a) / SR);
  }
  function toneDb(ch, freq, at) {
    // single-bin DFT magnitude at freq, dBFS
    const N = 8192, s0 = Math.max(0, at);
    let re = 0, im = 0;
    for (let n = 0; n < N && s0 + n < ch.length; n++) {
      const ph = 2 * Math.PI * freq * n / SR;
      re += ch[s0 + n] * Math.cos(ph); im -= ch[s0 + n] * Math.sin(ph);
    }
    const mag = 2 * Math.sqrt(re * re + im * im) / N;
    return 20 * Math.log10(Math.max(1e-9, mag));
  }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /* ================= 1. SPEED ================= */
  try {
    const p = RM.audio.makePlayer();
    p.load(testBuffer(RM.audio.ensureCtx(), 3));
    let allOk = true, det = [];
    for (const r of [0.5, 1, 1.5, 2]) {
      p.setRate(r);
      const fieldOk = p.rate === r;
      p.play(0); await sleep(120);
      const nodeOk = p.src && Math.abs(p.src.playbackRate.value - r) < 1e-6;
      p.stop(true);
      allOk = allOk && fieldOk && nodeOk;
      det.push(r + 'x:' + (fieldOk && nodeOk ? 'ok' : 'MISMATCH'));
    }
    // clamp documented in setRate: [0.25, 4]
    p.setRate(0.1); const c1 = p.rate === 0.25;
    p.setRate(9); const c2 = p.rate === 4;
    p.dispose();
    ok('speed: playbackRate set on node for 0.5/1/1.5/2x (+clamp)', allOk && c1 && c2, det.join(' ') + ' clamp:' + (c1 && c2));
  } catch (e) { ok('speed: playbackRate set on node for 0.5/1/1.5/2x (+clamp)', false, String(e)); }

  try {
    // duration scales inversely; pitch follows rate (honest resample, no pitch-shifter)
    const r05 = await renderPlayerGraph({ rate: 0.5, bufSecs: 3, renderSecs: 6.4 });
    const r20 = await renderPlayerGraph({ rate: 2.0, bufSecs: 3, renderSecs: 1.9 });
    const L05 = r05.getChannelData(0), L20 = r20.getChannelData(0);
    const sound05 = rms(L05, skip(r05), L05.length) > 0.05;         // still sounding at 5.9s
    const f05 = freqByZeroCross(L05, skip(r05), skip(r05) + SR * 2); // expect ~220
    const f20 = freqByZeroCross(L20, skip(r20), skip(r20) + SR * 1); // expect ~880 (inside the 1.5s of sound)
    const pass = sound05 && Math.abs(f05 - 220) < 4 && Math.abs(f20 - 880) < 8;
    ok('speed: duration inversely proportional, pitch follows tempo (offline)',
      pass, '0.5x freq=' + f05.toFixed(1) + 'Hz sounding@5.9s=' + sound05 + '; 2x freq=' + f20.toFixed(1) + 'Hz');
  } catch (e) { ok('speed: duration inversely proportional, pitch follows tempo (offline)', false, String(e)); }

  /* ================= 2. VOLUME ================= */
  try {
    const ref = await renderPlayerGraph({ vol: 1.0, bufSecs: 3, renderSecs: 3.4 });
    const v09 = await renderPlayerGraph({ vol: 0.9, bufSecs: 3, renderSecs: 3.4 });
    const v00 = await renderPlayerGraph({ vol: 0.0, bufSecs: 3, renderSecs: 3.4 });
    const Lr = ref.getChannelData(0), L9 = v09.getChannelData(0), L0 = v00.getChannelData(0);
    const a = skip(ref);
    const ratio = rms(L9, a, Lr.length) / rms(Lr, a, Lr.length);
    const silent = rms(L0, a, L0.length) < 1e-4;
    ok('volume: gain mapping is exact, no hidden boost/cut (offline)',
      Math.abs(ratio - 0.9) < 0.02 && silent,
      'rms(0.9)/rms(1.0)=' + ratio.toFixed(4) + ' (expect 0.90); vol=0 silent=' + silent);
  } catch (e) { ok('volume: gain mapping is exact, no hidden boost/cut (offline)', false, String(e)); }

  try {
    // unity check: vol=1.0/pan=0 render == source buffer (chain is transparent;
    // Chrome's StereoPannerNode passes stereo through unchanged at pan=0)
    const oc = new OfflineAudioContext(2, SR * 3, SR);
    const srcBuf = testBuffer(oc, 3);
    const rendered = await renderPlayerGraph({ vol: 1.0, bufSecs: 3, renderSecs: 3.4 });
    const a = skip(rendered);
    const inRms = rms(srcBuf.getChannelData(0), Math.floor(SR * 0.3), Math.floor(SR * 2.8));
    const outRms = rms(rendered.getChannelData(0), a, a + Math.floor(SR * 2.5));
    const dev = Math.abs(outRms - inRms) / inRms;
    ok('volume: unity chain at vol=1.0/pan=0 (offline)', dev < 0.02,
      'out/in=' + (outRms / inRms).toFixed(4) + ' expect 1.0000');
  } catch (e) { ok('volume: unity chain at vol=1.0/pan=0 (offline)', false, String(e)); }

  try {
    // stored value re-applied at play(): slider moved while stopped is never lost
    const p = RM.audio.makePlayer();
    p.load(testBuffer(RM.audio.ensureCtx(), 2));
    p.play(0); await sleep(150); p.stop(true);
    await sleep(400); // past any automation-freeze window
    p.setVolume(0.9);
    p.play(0); await sleep(150);
    const applied = Math.abs(p.gain.gain.value - 0.9) < 1e-6 && Math.abs(p._vol - 0.9) < 1e-9;
    p.stop(true); p.dispose();
    ok('volume: play() re-applies stored value (real player)', applied,
      'gain.value=' + (p.gain ? p.gain.gain.value : 'n/a'));
  } catch (e) { ok('volume: play() re-applies stored value (real player)', false, String(e)); }

  /* ================= 3. PAN ================= */
  try {
    const rl = await renderPlayerGraph({ pan: -1, bufSecs: 3, renderSecs: 3.4 });
    const rr = await renderPlayerGraph({ pan: 1, bufSecs: 3, renderSecs: 3.4 });
    const rc = await renderPlayerGraph({ pan: 0, bufSecs: 3, renderSecs: 3.4 });
    const a = skip(rl);
    const L = (r) => r.getChannelData(0), R = (r) => r.getChannelData(1);
    const db = (v) => 20 * Math.log10(Math.max(1e-9, v));
    const lL = rms(L(rl), a, a + SR), lR = rms(R(rl), a, a + SR);
    const rL = rms(L(rr), a, a + SR), rR = rms(R(rr), a, a + SR);
    const cL = rms(L(rc), a, a + SR), cR = rms(R(rc), a, a + SR);
    const hardL = db(lR / Math.max(1e-9, lL)) < -60;
    const hardR = db(rL / Math.max(1e-9, rR)) < -60;
    const centerEq = Math.abs(cL - cR) / Math.max(cL, cR) < 0.01;
    // hard-pan folds the opposite channel INTO the surviving one (measured
    // Chrome StereoPannerNode behavior): left RMS = sqrt(inL^2 + inR^2),
    // nothing is lost, opposite channel is silent.
    const inL = rms(testBuffer(new OfflineAudioContext(2, SR * 3, SR), 3).getChannelData(0), Math.floor(SR * 0.3), Math.floor(SR * 2.8));
    const summed = Math.abs(lL - inL * Math.SQRT2) / (inL * Math.SQRT2) < 0.03;
    ok('pan: L/C/R exact, hard-pan silences opposite channel (offline)',
      hardL && hardR && centerEq && summed,
      'pan=-1 R/L=' + db(lR / lL).toFixed(1) + 'dB; pan=+1 L/R=' + db(rL / rR).toFixed(1) + 'dB; center L/R=' + (cL / cR).toFixed(4) + '; hard-L sums mix (nothing lost)=' + summed);
  } catch (e) { ok('pan: L/C/R exact, hard-pan silences opposite channel (offline)', false, String(e)); }

  try {
    // mono compatibility: fold (L+R)/2 — no phase-cancellation weirdness
    const rc = await renderPlayerGraph({ pan: 0, bufSecs: 3, renderSecs: 3.4 });
    const rl = await renderPlayerGraph({ pan: -1, bufSecs: 3, renderSecs: 3.4 });
    const fold = (r) => {
      const L = r.getChannelData(0), R = r.getChannelData(1), m = new Float32Array(L.length);
      for (let i = 0; i < m.length; i++) m[i] = (L[i] + R[i]) / 2;
      return m;
    };
    const mc = fold(rc), ml = fold(rl), at = Math.floor(SR * 1.0);
    const c440 = toneDb(mc, 440, at), c660 = toneDb(mc, 660, at);
    const l440 = toneDb(ml, 440, at), l660 = toneDb(ml, 660, at);
    // center fold: both tones present, equal level. hard-L fold: surviving
    // channel carries the summed mix, so BOTH tones are still present —
    // nothing cancels, nothing is lost.
    const pass = c440 > -30 && c660 > -30 && Math.abs(c440 - c660) < 3 && l440 > -30 && l660 > -30;
    ok('pan: mono fold-down has no cancellation weirdness (offline)', pass,
      'center fold: 440Hz=' + c440.toFixed(1) + 'dB 660Hz=' + c660.toFixed(1) + 'dB; hard-L fold: 440Hz=' + l440.toFixed(1) + 'dB 660Hz=' + l660.toFixed(1) + 'dB');
  } catch (e) { ok('pan: mono fold-down has no cancellation weirdness (offline)', false, String(e)); }

  try {
    // real player: pan converges while playing; stored; re-applied at play()
    const p = RM.audio.makePlayer();
    p.load(testBuffer(RM.audio.ensureCtx(), 2));
    p.play(0); await sleep(150);
    p.setPan(-1); await sleep(400);
    const v1 = p.panner.pan.value;
    p.setPan(1); await sleep(400);
    const v2 = p.panner.pan.value;
    p.stop(true); await sleep(300);
    p.setPan(-1); // while stopped: stored...
    const stored = p._pan === -1;
    p.play(0); await sleep(150); // ...and re-applied at play()
    const v3 = p.panner.pan.value;
    p.stop(true); p.dispose();
    ok('pan: live converge + stored + re-applied at play() (real player)',
      Math.abs(v1 + 1) < 0.05 && Math.abs(v2 - 1) < 0.05 && stored && Math.abs(v3 + 1) < 1e-6,
      'whilePlaying -1->' + v1.toFixed(3) + ', +1->' + v2.toFixed(3) + '; stored=' + stored + '; after play()=' + v3.toFixed(3));
  } catch (e) { ok('pan: live converge + stored + re-applied at play() (real player)', false, String(e)); }

  /* ================= 4. LOOP ================= */
  try {
    // seamless joint: 2s buffer with integer cycles (440Hz -> 880 cycles), loop 0-2
    const oc = new OfflineAudioContext(2, Math.ceil(SR * 4.1), SR);
    const src = oc.createBufferSource();
    src.buffer = testBuffer(oc, 2);
    src.loop = true; src.loopStart = 0; src.loopEnd = 2;
    src.connect(oc.destination);
    src.start(0);
    const out = await oc.startRendering();
    const ch = out.getChannelData(0);
    const maxDelta = (a, b) => { let m = 0; for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(ch[i] - ch[i - 1])); return m; };
    const base = maxDelta(Math.floor(SR * 0.5), Math.floor(SR * 1.5));
    const j1 = maxDelta(Math.floor(SR * 2) - 132, Math.floor(SR * 2) + 132);
    const j2 = maxDelta(Math.floor(SR * 4) - 132, Math.floor(SR * 4) + 132);
    const pass = j1 <= 3 * base && j2 <= 3 * base && j1 < 0.06 && j2 < 0.06;
    ok('loop: seamless joint, no click transient at boundary (offline)',
      pass, 'baseline max|d|=' + base.toFixed(4) + ' joint@2s=' + j1.toFixed(4) + ' joint@4s=' + j2.toFixed(4));
  } catch (e) { ok('loop: seamless joint, no click transient at boundary (offline)', false, String(e)); }

  try {
    // live toggle mid-playback (regression: flag-only set left src.loop untouched)
    const p = RM.audio.makePlayer();
    const buf = testBuffer(RM.audio.ensureCtx(), 3);
    p.load(buf);
    p.setLoop(true, 0, buf.duration);
    p.play(0); await sleep(200);
    const onWhilePlaying = p.src.loop === true;
    p.setLoop(false);
    const offWhilePlaying = p.src.loop === false;
    p.setLoop(true, 0, buf.duration);
    const onAgain = p.src.loop === true && p.src.loopStart === 0 && p.src.loopEnd === buf.duration;
    p.stop(true); p.dispose();
    ok('loop: setLoop applies to live source mid-playback (real player)',
      onWhilePlaying && offWhilePlaying && onAgain,
      'on=' + onWhilePlaying + ' off=' + offWhilePlaying + ' onAgain=' + onAgain);
  } catch (e) { ok('loop: setLoop applies to live source mid-playback (real player)', false, String(e)); }

  try {
    // stale loop range refreshes on load (shorter buffer under enabled loop)
    const p = RM.audio.makePlayer();
    const longBuf = testBuffer(RM.audio.ensureCtx(), 4);
    const shortBuf = testBuffer(RM.audio.ensureCtx(), 2);
    p.load(longBuf);
    p.setLoop(true, 0, longBuf.duration);
    p.load(shortBuf); // simulates trim-while-looped (refreshView path)
    const refreshed = p.loopStart === 0 && Math.abs(p.loopEnd - shortBuf.duration) < 1e-6;
    p.play(0); await sleep(200);
    const srcOk = p.src.loop === true && Math.abs(p.src.loopEnd - shortBuf.duration) < 1e-3;
    p.stop(true); p.dispose();
    ok('loop: range refreshes on load under enabled loop (real player)', refreshed && srcOk,
      'loopEnd after load=' + p.loopEnd.toFixed(2) + ' (buffer ' + shortBuf.duration.toFixed(2) + 's); src.loopEnd ok=' + srcOk);
  } catch (e) { ok('loop: range refreshes on load under enabled loop (real player)', false, String(e)); }

  /* ================= 5. COMBINED ================= */
  try {
    const out = await renderPlayerGraph({ rate: 0.5, vol: 0.5, pan: -1, loop: true, loopStart: 0, loopEnd: 3, bufSecs: 3, renderSecs: 6.4 });
    const L = out.getChannelData(0), R = out.getChannelData(1), a = skip(out);
    const lRms = rms(L, a, L.length - 100), rRms = rms(R, a, R.length - 100);
    const inRms = 0.5 / Math.SQRT2; // 0.5-amplitude sine
    const db = (v) => 20 * Math.log10(Math.max(1e-9, v));
    // pan L sums both channels into left: 0.5 vol * sqrt(inL^2+inR^2) = 0.5*0.5
    const expectL = 0.5 * inRms * Math.SQRT2;
    const pass = db(rRms / Math.max(1e-9, lRms)) < -60 &&   // pan L: right silent
      Math.abs(lRms - expectL) / expectL < 0.03 &&         // vol 0.5, summed mix
      lRms > 0.05;                                          // sounding through 6s (looped 2x)
    ok('combined: 0.5x + pan L + vol 0.5 + loop, all apply, no crash (offline)',
      pass, 'leftRMS=' + lRms.toFixed(4) + ' (expect ' + expectL.toFixed(4) + ') right/left=' + db(rRms / lRms).toFixed(1) + 'dB');
  } catch (e) { ok('combined: 0.5x + pan L + vol 0.5 + loop, all apply, no crash (offline)', false, String(e)); }

  /* ================= 6. RAPID PARAM CHANGES ================= */
  try {
    const p = RM.audio.makePlayer();
    p.load(testBuffer(RM.audio.ensureCtx(), 4));
    const rates = [0.5, 1, 1.5, 2, 0.75, 1.25, 0.5, 2, 1, 1.5];
    for (let i = 0; i < 10; i++) {
      p.setRate(rates[i]);
      p.setVolume(0.1 + i * 0.09);
      p.setPan(-1 + i * 0.222);
      p.setLoop(i % 2 === 0, 0, p.buffer.duration);
      if (i % 3 === 0) p.play(0);
      if (i % 3 === 1) p.pause();
      if (i % 3 === 2) p.stop(true);
      await sleep(30);
    }
    p.play(0); await sleep(150);
    const wasPlaying = p.playing;
    const consistent = wasPlaying === true &&
      Math.abs(p.rate - 1.5) < 1e-9 &&
      Math.abs(p._vol - (0.1 + 9 * 0.09)) < 1e-9 &&
      Math.abs(p._pan - (-1 + 9 * 0.222)) < 1e-9 &&
      Math.abs(p.gain.gain.value - p._vol) < 1e-6 &&
      Math.abs(p.panner.pan.value - p._pan) < 1e-6 &&
      p.src.loop === p.loop;
    p.stop(true); p.dispose();
    ok('rapid: 10 quick param toggles + play/pause/stop, no stuck nodes (real player)', consistent,
      'final rate=' + p.rate + ' _vol=' + p._vol.toFixed(3) + ' _pan=' + p._pan.toFixed(3) + ' playing(before stop)=' + wasPlaying);
  } catch (e) { ok('rapid: 10 quick param toggles + play/pause/stop, no stuck nodes (real player)', false, String(e)); }

  /* ================= 7. UI LABELS ================= */
  try {
    const t = (id) => { const el = document.getElementById(id); return el ? (el.closest('.row') ? el.closest('.row').textContent : el.textContent) : null; };
    const speedRow = t('ed-speed') || '', volRow = t('ed-vol') || '', panRow = t('ed-pan') || '';
    const loopBtn = document.getElementById('ed-loop');
    const honest = Array.from(document.querySelectorAll('.honest')).map((e) => e.textContent);
    const has = (s, sub) => s.toLowerCase().includes(sub.toLowerCase());
    const devanagari = /[\\u0900-\\u097F]/;
    const pass = has(speedRow, 'speed') && has(volRow, 'volume') && has(panRow, 'pan') &&
      loopBtn && has(loopBtn.textContent, 'loop') &&
      honest.some((h) => has(h, 'pitch changes with tempo') && has(h, 'no independent pitch-shift')) &&
      ![speedRow, volRow, panRow, loopBtn.textContent, ...honest].some((s) => devanagari.test(s));
    ok('ui: English labels + honest pitch-tempo note', pass,
      'speed/vol/pan/loop labels present; honesty note: "' + (honest.find((h) => has(h, 'pitch')) || 'MISSING') + '"');
  } catch (e) { ok('ui: English labels + honest pitch-tempo note', false, String(e)); }

  return T;
}`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: SHELL, headless: true,
    args: ['--allow-file-access-from-files', '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.audio && RM.audio.makePlayer', { timeout: 30000 });
  // App init may throw on missing elements in this bare context; audio engine is independent.
  const results = await page.evaluate('(' + PAGE_TESTS + ')()');
  await browser.close();

  let fails = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.detail ? ' | ' + r.detail : ''));
    if (!r.pass) fails++;
  }
  const appErrors = errors.filter((e) => !/addEventListener/.test(e));
  if (appErrors.length) { console.log('FAIL | unexpected page errors | ' + appErrors.join('; ')); fails++; }
  console.log('----');
  console.log(fails === 0 ? `ALL ${results.length} TESTS PASSED` : `${fails}/${results.length} TESTS FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FATAL: ' + (e && e.message || e)); process.exit(2); });
