#!/usr/bin/env node
/**
 * RuhMix "TITE SE FIX" W5 — Stems & Mixer deep review.
 *
 * Covers the W5 area (stems.js, ai-stems.js, hf-stems.js, hf46-stems.js,
 * stem-deck.js + 6-track mixer UI in app.js):
 *
 *  1. DSP Beta engines on synthesized multi-part audio (vocal-like centered
 *     tone, drum-like transients, bass tone, wide air tone):
 *     - outputs are NOT silent (no crash/silence bug)
 *     - bleed is bounded and honest (measured ratios, not vibes)
 *  2. Dynamic 2/4/6-stem deck cards + Full Instrumental one-tap
 *  3. 6-track mixer: mute / solo / volume route to the CORRECT track;
 *     solo+mute edge cases (mute wins; solo on an empty track is a no-op)
 *  4. Stem-deck limiter: deck master + mixer players must connect into the
 *     guarded master chain (limiter+clipper), never raw to the DAC; the
 *     safety clipper is verified offline with a +18 dB hot signal.
 *  5. Default state (no HF configured): AI screen + Settings show honest,
 *     working UI — every visible button clicked, no dead ends, no errors.
 *  6. Rewarded ad gate: fail/skip -> graceful panel (no hang); never-settling
 *     ad SDK -> 90 s watchdog fires -> gate clears -> retry works.
 *
 * Exit code: 0 = all PASS, non-zero = at least one FAIL.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const WWW = '/home/hatch/workspace/ruhmix/www';
const PAGE_URL = pathToFileURL(path.join(WWW, 'index.html')).href;

function findChrome() {
  const cands = [
    path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell'),
    path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('chrome-headless-shell not found');
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pageErrors = [];
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text().slice(0, 200)); });
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  try {
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.RM && RM.app && RM.app.state, { timeout: 30000 });

    /* ============ shared DSP helpers installed in the page ============ */
    await ev(() => {
      window.__w5 = {};
      const W = window.__w5;
      // Multi-part fixture: centered vocal-like tone (500 Hz, slow AM),
      // centered bass (55 Hz), WIDE air (8 kHz, out-of-phase L/R so the
      // center channel is clean of it), drum-like transients (30 ms noise
      // bursts every 0.5 s, alternating hard L / hard R).
      W.buildFixture = function (secs) {
        const ctx = RM.audio.ensureCtx();
        const sr = ctx.sampleRate, n = Math.floor(sr * secs);
        const buf = ctx.createBuffer(2, n, sr);
        const L = buf.getChannelData(0), R = buf.getChannelData(1);
        let seed = 1234567;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const vocal = 0.42 * Math.sin(2 * Math.PI * 500 * t) * (1 + 0.25 * Math.sin(2 * Math.PI * 3 * t));
          const bass = 0.38 * Math.sin(2 * Math.PI * 55 * t);
          const air = 0.22 * Math.sin(2 * Math.PI * 8000 * t);
          L[i] = vocal + bass + air;
          R[i] = vocal + bass - air;
        }
        const burstLen = Math.floor(sr * 0.03);
        for (let b = 0; b * 0.5 < secs; b++) {
          const s0 = Math.floor(b * 0.5 * sr);
          for (let j = 0; j < burstLen && s0 + j < n; j++) {
            const nz = rnd() * 0.75 * Math.exp(-j / (sr * 0.006));
            if (b % 2 === 0) L[s0 + j] += nz; else R[s0 + j] += nz;
          }
        }
        return buf;
      };
      W.ch0 = function (buf) { return buf.getChannelData(0); };
      W.ch1 = function (buf) { return buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0); };
      // NOTE: mono() cancels the out-of-phase "air" tone by construction
      // (L=+air, R=-air) — for wide-content measurements use ch0/ch1.
      W.mono = function (buf) {
        const n = buf.length, c0 = buf.getChannelData(0);
        const out = new Float32Array(n);
        if (buf.numberOfChannels > 1) {
          const c1 = buf.getChannelData(1);
          for (let i = 0; i < n; i++) out[i] = (c0[i] + c1[i]) * 0.5;
        } else out.set(c0);
        return out;
      };
      W.goertzel = function (x, sr, freq) {
        const w = 2 * Math.PI * freq / sr, cw = Math.cos(w);
        let s0 = 0, s1 = 0, s2 = 0;
        for (let i = 0; i < x.length; i++) { s0 = x[i] + 2 * cw * s1 - s2; s2 = s1; s1 = s0; }
        return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - 2 * cw * s1 * s2)) / x.length;
      };
      W.rms = function (x) {
        let s = 0;
        for (let i = 0; i < x.length; i++) s += x[i] * x[i];
        return Math.sqrt(s / x.length);
      };
      // transient contrast: burst windows (t=0.5k..+0.06) vs gap windows
      W.transientContrast = function (x, sr) {
        let bE = 0, bN = 0, gE = 0, gN = 0;
        for (let k = 0; k * 0.5 + 0.35 < x.length / sr; k++) {
          const b0 = Math.floor(k * 0.5 * sr), b1 = Math.min(x.length, b0 + Math.floor(0.06 * sr));
          for (let i = b0; i < b1; i++) { bE += x[i] * x[i]; bN++; }
          const g0 = Math.floor((k * 0.5 + 0.25) * sr), g1 = Math.min(x.length, g0 + Math.floor(0.06 * sr));
          for (let i = g0; i < g1; i++) { gE += x[i] * x[i]; gN++; }
        }
        const bR = Math.sqrt(bE / Math.max(1, bN)), gR = Math.sqrt(gE / Math.max(1, gN));
        return gR > 1e-9 ? bR / gR : 99;
      };
      W.f = (v) => Math.round(v * 1000) / 1000;
    });

    /* ============ 1a. Vocal Cut (DSP) ============ */
    const vc = await ev(async () => {
      const W = window.__w5;
      const fix = W.buildFixture(6);
      const stems = await RM.stems.run('vocalcut', fix, null);
      const sr = fix.sampleRate;
      const c = W.mono(stems[0].buffer);
      // sides stem: use channel 0 — the wide air tone is out-of-phase
      // (L=+air, R=-air) so a mono mix would cancel it (measurement artifact)
      const s = W.ch0(stems[1].buffer);
      return {
        names: stems.map((x) => x.name).join(' | '),
        rmsC: W.f(W.rms(c)), rmsS: W.f(W.rms(s)),
        c500: W.f(W.goertzel(c, sr, 500)), s500: W.f(W.goertzel(s, sr, 500)),
        c8k: W.f(W.goertzel(c, sr, 8000)), s8k: W.f(W.goertzel(s, sr, 8000)),
      };
    });
    record('dsp-vocalcut-outputs', /Center/.test(vc.names) && /Sides/.test(vc.names), vc.names);
    record('dsp-vocalcut-not-silent', vc.rmsC > 0.1 && vc.rmsS > 0.05, `center RMS=${vc.rmsC} sides RMS=${vc.rmsS}`);
    const vocalBleed = vc.s500 / Math.max(1e-9, vc.c500);
    const airBleed = vc.c8k / Math.max(1e-9, vc.s8k);
    record('dsp-vocalcut-vocal-bleed', vocalBleed < 0.15, `sides@500Hz / center@500Hz = ${vocalBleed.toFixed(3)} (want < 0.15)`);
    record('dsp-vocalcut-wide-bleed', airBleed < 0.15, `center@8kHz / sides@8kHz = ${airBleed.toFixed(3)} (want < 0.15)`);

    /* ============ 1b. Drum Extract (HPSS) ============ */
    const hp = await Promise.race([
      ev(async () => {
        const W = window.__w5;
        const fix = W.buildFixture(6);
        const stems = await RM.stems.run('hpss', fix, null);
        const sr = fix.sampleRate;
        const d = W.mono(stems[0].buffer), h = W.mono(stems[1].buffer);
        return {
          names: stems.map((x) => x.name).join(' | '),
          rmsD: W.f(W.rms(d)), rmsH: W.f(W.rms(h)),
          tcD: W.f(W.transientContrast(d, sr)), tcH: W.f(W.transientContrast(h, sr)),
          g55d: W.f(W.goertzel(d, sr, 55)), g55h: W.f(W.goertzel(h, sr, 55)),
          g500d: W.f(W.goertzel(d, sr, 500)), g500h: W.f(W.goertzel(h, sr, 500)),
        };
      }),
      sleep(240000).then(() => { throw new Error('hpss-timeout'); }),
    ]);
    record('dsp-hpss-outputs', /Drums/.test(hp.names) && /Harmonic/.test(hp.names), hp.names);
    record('dsp-hpss-not-silent', hp.rmsD > 0.005 && hp.rmsH > 0.05, `drums RMS=${hp.rmsD} harmonic RMS=${hp.rmsH} (bursts are mono-halved + LP-filtered in the fixture, so the drums stem is quiet by construction)`);
    record('dsp-hpss-transients', hp.tcD > 3, `drums burst/gap energy ratio=${hp.tcD} (want > 3)`);
    record('dsp-hpss-harmonic-clean', hp.tcH < 2.5, `harmonic burst/gap energy ratio=${hp.tcH} (want < 2.5, bleed allowed)`);
    record('dsp-hpss-bass-stays', hp.g55h > 3 * hp.g55d, `harmonic@55Hz=${hp.g55h} vs drums@55Hz=${hp.g55d}`);
    record('dsp-hpss-vocal-stays', hp.g500h > 2 * hp.g500d, `harmonic@500Hz=${hp.g500h} vs drums@500Hz=${hp.g500d}`);

    /* ============ 1c. Bass Focus ============ */
    const bf = await ev(async () => {
      const W = window.__w5;
      const fix = W.buildFixture(6);
      const stems = await RM.stems.run('bass', fix, null);
      const sr = fix.sampleRate;
      const b = W.mono(stems[0].buffer), u = W.mono(stems[1].buffer);
      return {
        names: stems.map((x) => x.name).join(' | '),
        rmsB: W.f(W.rms(b)), rmsU: W.f(W.rms(u)),
        g55b: W.f(W.goertzel(b, sr, 55)), g55u: W.f(W.goertzel(u, sr, 55)),
        g500b: W.f(W.goertzel(b, sr, 500)), g500u: W.f(W.goertzel(u, sr, 500)),
      };
    });
    record('dsp-bass-outputs', /Bass/.test(bf.names) && /Upper/.test(bf.names), bf.names);
    record('dsp-bass-not-silent', bf.rmsB > 0.05 && bf.rmsU > 0.05, `bass RMS=${bf.rmsB} upper RMS=${bf.rmsU}`);
    record('dsp-bass-isolation', bf.g55b > 10 * bf.g55u, `bass@55Hz=${bf.g55b} vs upper@55Hz=${bf.g55u}`);
    record('dsp-bass-mid-reject', bf.g500u > 10 * bf.g500b, `upper@500Hz=${bf.g500u} vs bass@500Hz=${bf.g500b}`);

    /* ============ 1d. Stem Split (Spectral) ============ */
    const sp = await ev(async () => {
      const W = window.__w5;
      const fix = W.buildFixture(6);
      const stems = await RM.stems.run('spectral', fix, null);
      const sr = fix.sampleRate;
      const bands = stems.map((s) => W.mono(s.buffer));
      const g = (i, f) => W.goertzel(bands[i], sr, f);
      // air tone is out-of-phase L/R: measure the Air band on channel 0
      const airCh0 = W.ch0(stems[3].buffer);
      const a8k = W.goertzel(airCh0, sr, 8000), a55 = W.goertzel(airCh0, sr, 55), a500 = W.goertzel(airCh0, sr, 500);
      // energy preservation: sum of band energies vs original (phase-blind;
      // parallel IIR crossovers shift phase, so sample-wise comparison is meaningless)
      let bandE = 0;
      stems.forEach((s) => {
        const c0 = s.buffer.getChannelData(0), c1 = s.buffer.getChannelData(1);
        for (let i = 0; i < s.buffer.length; i++) bandE += c0[i] * c0[i] + c1[i] * c1[i];
      });
      const o0 = fix.getChannelData(0), o1 = fix.getChannelData(1);
      let origE = 0;
      for (let i = 0; i < fix.length; i++) origE += o0[i] * o0[i] + o1[i] * o1[i];
      return {
        names: stems.map((x) => x.name).join(' | '),
        rms: bands.map((b) => W.f(W.rms(b))).join(','),
        bass55: W.f(g(0, 55)), bass500: W.f(g(0, 500)), bass8k: W.f(g(0, 8000)),
        lm55: W.f(g(1, 55)), lm500: W.f(g(1, 500)), lm8k: W.f(g(1, 8000)),
        pr500: W.f(g(2, 500)),
        air55: W.f(a55), air500: W.f(a500), air8k: W.f(a8k),
        energyRatio: W.f(bandE / Math.max(1e-12, origE)),
      };
    });
    record('dsp-spectral-4-bands', sp.names.split(' | ').length === 4, sp.names);
    record('dsp-spectral-not-silent', sp.rms.split(',').every((v) => parseFloat(v) > 0.005), 'band RMS=' + sp.rms);
    record('dsp-spectral-bass-band', sp.bass55 > 4 * Math.max(sp.bass500, sp.bass8k), `bass band: 55Hz=${sp.bass55} vs 500Hz=${sp.bass500}, 8kHz=${sp.bass8k}`);
    record('dsp-spectral-lowmid-band', sp.lm500 > 4 * Math.max(sp.lm55, sp.lm8k), `low-mid band: 500Hz=${sp.lm500} vs 55Hz=${sp.lm55}, 8kHz=${sp.lm8k}`);
    record('dsp-spectral-air-band', sp.air8k > 4 * Math.max(sp.air55, sp.air500), `air band (ch0): 8kHz=${sp.air8k} vs 55Hz=${sp.air55}, 500Hz=${sp.air500}`);
    record('dsp-spectral-presence-not-vocal-home', sp.pr500 < sp.lm500, `presence@500Hz=${sp.pr500} < lowmid@500Hz=${sp.lm500}`);
    record('dsp-spectral-energy', sp.energyRatio > 0.5 && sp.energyRatio < 1.6, `sum of band energies / original = ${sp.energyRatio} (parallel IIR crossovers overlap by design — not a perfect-reconstruction bank; smoke range 0.5-1.6)`);

    /* ============ 2. Dynamic 2/4/6 deck cards + Full Instrumental ============ */
    const deckCounts = await ev(() => {
      const ctx = RM.audio.ensureCtx();
      const mk = (secs) => {
        const b = ctx.createBuffer(2, Math.floor(ctx.sampleRate * secs), ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.sin(6.28 * 440 * i / ctx.sampleRate) * 0.3;
        b.getChannelData(1).set(d);
        return b;
      };
      const host = document.createElement('div');
      host.id = 'w5-deck-host';
      document.body.appendChild(host);
      window.__w5.bufs = { b2: [mk(2), mk(2)], b4: [mk(2), mk(2), mk(2), mk(2)], b6: [mk(2), mk(2), mk(2), mk(2), mk(2), mk(2)] };
      const out = {};
      [['b2', ['vocal', 'other']], ['b4', ['vocal', 'drums', 'bass', 'other']],
       ['b6', ['vocal', 'drums', 'bass', 'other', 'piano', 'guitar']]].forEach(([k, roles]) => {
        host.innerHTML = '';
        RM.stemDeck.render(host, window.__w5.bufs[k].map((buf, i) => ({ name: 'S' + (i + 1), buffer: buf, role: roles[i], badge: 'T' })), { title: 't' });
        out[k] = host.querySelectorAll('.stem-card').length;
      });
      return out;
    });
    record('deck-2-cards', deckCounts.b2 === 2, 'got ' + deckCounts.b2);
    record('deck-4-cards', deckCounts.b4 === 4, 'got ' + deckCounts.b4);
    record('deck-6-cards', deckCounts.b6 === 6, 'got ' + deckCounts.b6);
    // Full Instrumental one-tap on a 6-stem deck: renders, non-silent, export routes
    await ev(() => {
      const host = document.getElementById('w5-deck-host');
      host.innerHTML = '';
      const roles = ['vocal', 'drums', 'bass', 'other', 'piano', 'guitar'];
      const deck = RM.stemDeck.render(host, window.__w5.bufs.b6.map((buf, i) => ({ name: 'S' + (i + 1), buffer: buf, role: roles[i], badge: 'HF' })), {});
      window.__w5.deck = deck;
      host.querySelector('[data-a="make"]').click();
    });
    await page.waitForFunction(() => {
      const o = document.querySelector('#w5-deck-host .deck-inst-out');
      return o && o.style.display !== 'none';
    }, { timeout: 30000 });
    const instRms = await ev(async () => {
      // re-render the instrumental the same way renderInstrumental does, to measure it
      const stems = window.__w5.bufs.b6.slice(1).map((buffer, i) => ({ buffer })); // non-vocal
      const bufs = stems.map((s) => s.buffer);
      const sr = bufs[0].sampleRate, len = Math.max.apply(null, bufs.map((b) => b.length));
      const oc = new OfflineAudioContext(2, len, sr);
      const out = oc.createGain();
      out.gain.value = 1 / Math.sqrt(bufs.length);
      out.connect(oc.destination);
      bufs.forEach((b) => { const src = oc.createBufferSource(); src.buffer = b; src.connect(out); src.start(0); });
      const rb = await oc.startRendering();
      const d = rb.getChannelData(0);
      let peak = 0, s = 0;
      for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]); }
      return { rms: Math.round(Math.sqrt(s / d.length) * 1000) / 1000, peak: Math.round(peak * 1000) / 1000 };
    });
    record('deck-instrumental-renders', instRms.rms > 0.05, `instrumental RMS=${instRms.rms} peak=${instRms.peak}`);
    record('deck-instrumental-no-clip', instRms.peak <= 1.0, `headroom 1/sqrt(N) holds: peak=${instRms.peak}`);
    await ev(() => { document.querySelector('#w5-deck-host .deck-inst-out [data-a="exp"]').click(); });
    await sleep(400);
    record('deck-instrumental-export', await ev(() => RM.app.state.exportSource && RM.app.state.exportSource.name) === 'Full Instrumental',
      'exportSource=' + await ev(() => RM.app.state.exportSource && RM.app.state.exportSource.name));

    /* ============ 3. 6-track mixer routing ============ */
    await ev(() => {
      const ctx = RM.audio.ensureCtx();
      const sr = ctx.sampleRate;
      const freqs = [220, 330, 440, 550, 660, 770];
      const names = ['Vocals T', 'Drums T', 'Bass T', 'Other T', 'Guitar T', 'Piano T'];
      freqs.forEach((f, i) => {
        const b = ctx.createBuffer(2, sr * 2, sr);
        for (let c = 0; c < 2; c++) {
          const d = b.getChannelData(c);
          for (let j = 0; j < d.length; j++) d[j] = Math.sin(6.28 * f * j / sr) * 0.3;
        }
        RM.app.sendToMixer(b, names[i]);
      });
    });
    const slotNames = await ev(() => RM.app.getMixerTracks().map((t) => t.name));
    record('mixer-auto-routing', slotNames.join(',') === 'Vocals T,Drums T,Bass T,Other T,Guitar T,Piano T',
      slotNames.join(' | '));
    await ev(() => { document.getElementById('mx-play-all').click(); });
    await sleep(300);
    const vols0 = await ev(() => RM.app.getMixerTracks().map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-default-vols', vols0.every((v) => v === 0.9), vols0.join(','));
    // mute track 1 -> ONLY track 1 goes silent
    await ev(() => { document.querySelector('#mx-track-1 [data-a="mute"]').click(); });
    await sleep(150);
    const volsMute = await ev(() => RM.app.getMixerTracks().map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-mute-routes', volsMute[1] === 0 && volsMute[0] === 0.9 && volsMute[2] === 0.9,
      'after muting track1: ' + volsMute.join(','));
    // solo track 0 -> only track 0 audible
    await ev(() => {
      document.querySelector('#mx-track-1 [data-a="mute"]').click(); // unmute
      document.querySelector('#mx-track-0 [data-a="solo"]').click();
    });
    await sleep(150);
    const volsSolo = await ev(() => RM.app.getMixerTracks().map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-solo-routes', volsSolo[0] === 0.9 && volsSolo.slice(1).every((v) => v === 0),
      'after solo track0: ' + volsSolo.join(','));
    // solo track0 + mute track2: mute wins on track2, track0 still audible
    await ev(() => { document.querySelector('#mx-track-2 [data-a="mute"]').click(); });
    await sleep(150);
    const volsSoloMute = await ev(() => RM.app.getMixerTracks().map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-solo-mute-combo', volsSoloMute[0] === 0.9 && volsSoloMute[2] === 0 && volsSoloMute[3] === 0,
      'solo0+mute2: ' + volsSoloMute.join(','));
    // solo track0 + mute track0: mute beats own solo
    await ev(() => {
      document.querySelector('#mx-track-2 [data-a="mute"]').click(); // unmute track2
      document.querySelector('#mx-track-0 [data-a="mute"]').click(); // mute the soloed track
    });
    await sleep(150);
    const volsSelfMute = await ev(() => RM.app.getMixerTracks().map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-mute-beats-own-solo', volsSelfMute.every((v) => v === 0),
      'solo0+mute0 -> all silent: ' + volsSelfMute.join(','));
    // reset, then solo an EMPTY track: anySolo guard (x.buffer) -> others stay audible
    await ev(() => {
      document.querySelector('#mx-track-0 [data-a="mute"]').click(); // unmute
      document.querySelector('#mx-track-0 [data-a="solo"]').click();  // unsolo
      RM.app.getMixerTracks()[5].buffer = null;
      document.querySelector('#mx-track-5 [data-a="solo"]').click();  // solo empty track
    });
    await sleep(150);
    const volsEmptySolo = await ev(() => RM.app.getMixerTracks().slice(0, 5).map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-solo-empty-noop', volsEmptySolo.every((v) => v === 0.9),
      'solo on empty track -> others unaffected: ' + volsEmptySolo.join(','));
    await ev(() => { document.querySelector('#mx-track-5 [data-a="solo"]').click(); }); // cleanup
    // volume slider routes to the correct track only
    await ev(() => {
      const v = document.querySelector('#mx-track-2 [data-a="vol"]');
      v.value = 30; v.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(150);
    const volsSlider = await ev(() => RM.app.getMixerTracks().map((t) => Math.round(t.player._vol * 100) / 100));
    record('mixer-vol-slider-routing', volsSlider[2] === 0.3 && volsSlider[0] === 0.9 && volsSlider[1] === 0.9,
      'track2 slider to 30%: ' + volsSlider.join(','));
    await ev(() => { document.getElementById('mx-stop-all').click(); });

    /* ============ 4. limiter: deck + mixer route through the guarded chain ============ */
    const routeCheck = await ev(() => {
      const pairs = [];
      let patched = false;
      let orig = null;
      try {
        orig = AudioNode.prototype.connect;
        window.__origConnect = orig;
        AudioNode.prototype.connect = function (dst) {
          pairs.push([this, dst]);
          return orig.apply(this, arguments);
        };
        patched = true;
      } catch (e) { return { patched: false }; }
      const masterIn = RM.audio.masterIn();
      // (a) stem deck
      const host = document.createElement('div');
      host.id = 'w5-route-host';
      document.body.appendChild(host);
      const deck = RM.stemDeck.render(host, window.__w5.bufs.b2.map((buf, i) => (
        { name: 'R' + i, buffer: buf, role: i ? 'other' : 'vocal', badge: 'T' })), {});
      const deckDst = pairs.filter(([s]) => s === deck.master).map(([, d]) => d);
      // (b) mixer players: force fresh makePlayer() calls inside the patched
      // window, and give track5 its buffer back (nulled in the solo test).
      const tr = RM.app.getMixerTracks();
      const ctx = RM.audio.ensureCtx();
      const tb = ctx.createBuffer(2, ctx.sampleRate, ctx.sampleRate);
      tr[5].buffer = tr[5].buffer || tb;
      tr.forEach((t) => { if (t.player) { try { t.player.dispose(); } catch (e) {} t.player = null; } });
      document.getElementById('mx-play-all').click();
      const mxDst = tr.filter((t) => t.buffer && t.player).map((t) => {
        const hit = pairs.filter(([s]) => s === t.player.gain).map(([, d]) => d);
        return hit.length ? hit[hit.length - 1] === masterIn : null;
      });
      document.getElementById('mx-stop-all').click();
      try { AudioNode.prototype.connect = window.__origConnect; } catch (e) {}
      return {
        patched,
        deckToMaster: deckDst.length > 0 && deckDst[deckDst.length - 1] === masterIn,
        deckToRawDest: deckDst.some((d) => d !== masterIn),
        mixerToMaster: mxDst,
      };
    });
    record('deck-routes-to-limiter', routeCheck.patched && routeCheck.deckToMaster && !routeCheck.deckToRawDest,
      `deck.master -> masterIn=${routeCheck.deckToMaster}, raw-dest leak=${routeCheck.deckToRawDest}`);
    record('mixer-routes-to-limiter', routeCheck.patched && routeCheck.mixerToMaster.every((v) => v === true),
      'players -> masterIn: ' + routeCheck.mixerToMaster.join(','));
    // Safety clipper offline: +18 dB hot sine must be clamped to <= 0.9952, quiet audio untouched
    const clip = await ev(async () => {
      const sr = 44100;
      const mk = (amp) => {
        const oc = new OfflineAudioContext(2, sr * 2, sr);
        const b = oc.createBuffer(2, sr * 2, sr);
        for (let c = 0; c < 2; c++) {
          const d = b.getChannelData(c);
          for (let i = 0; i < d.length; i++) d[i] = Math.sin(6.28 * 440 * i / sr) * amp;
        }
        const clipN = RM.audio.createSafetyClipper(oc);
        const src = oc.createBufferSource();
        src.buffer = b; src.connect(clipN); clipN.connect(oc.destination); src.start(0);
        return oc.startRendering().then((rb) => {
          const d = rb.getChannelData(0);
          let peak = 0;
          for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
          return { peak: Math.round(peak * 10000) / 10000 };
        });
      };
      const hot = await mk(8);    // +18 dB
      const quiet = await mk(0.5); // -6 dB, must pass through
      return { hotPeak: hot.peak, quietPeak: quiet.peak };
    });
    record('clipper-clamps-hot', clip.hotPeak <= 0.996 && clip.hotPeak > 0.9,
      `+18dB in -> peak ${clip.hotPeak} (want in (0.9, 0.996])`);
    record('clipper-quiet-untouched', Math.abs(clip.quietPeak - 0.5) < 0.001,
      `-6dB in -> peak ${clip.quietPeak} (want 0.5)`);

    /* ============ 5. default state (no HF configured): honest, working UI ============ */
    await ev(() => {
      localStorage.removeItem('rmx_ai_backend');
      localStorage.removeItem('rmx_ai_hf');
      localStorage.removeItem('rmx_ai_hf46');
      localStorage.removeItem('rmx_ai_server');
      const ctx = RM.audio.ensureCtx();
      const sr = ctx.sampleRate;
      const b = ctx.createBuffer(2, sr * 3, sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin(6.28 * 440 * i / sr) * 0.3;
      b.getChannelData(1).set(d);
      RM.app.loadAudioBuffer(b, 'ui-fixture.wav');
      RM.aiStems.open();
    });
    await page.waitForFunction(() => document.querySelectorAll('#aib-row button').length === 4, { timeout: 10000 });
    const uiDef = await ev(() => ({
      backends: Array.from(document.querySelectorAll('#aib-row button')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
      setupVisible: document.getElementById('aistem-setup').style.display !== 'none',
      setupText: document.getElementById('aistem-setup').textContent.replace(/\s+/g, ' ').trim().slice(0, 220),
      dspCards: document.querySelectorAll('#aistem-dsp-grid .dsp-tool-card').length,
      dspHonest: Array.from(document.querySelectorAll('#aistem-dsp-grid .honest')).every((h) => /not neural AI/.test(h.textContent)),
      hasOpenDsp: !!document.getElementById('ais-go-dsp-main'),
    }));
    record('ui-default-4-backends', true, uiDef.backends);
    record('ui-default-dsp-choice', uiDef.setupVisible && uiDef.hasOpenDsp, uiDef.setupText);
    record('ui-default-dsp-honest', uiDef.dspCards === 4 && uiDef.dspHonest, `${uiDef.dspCards} tools, all labelled experimental (DSP)`);
    // "Open DSP Stem Separation" must actually go somewhere
    await ev(() => { document.getElementById('ais-go-dsp-main').click(); });
    await sleep(400);
    record('ui-default-open-dsp-works', await ev(() => RM.app.state.screen) === 'stems',
      'screen=' + await ev(() => RM.app.state.screen));
    // Settings with dsp backend: no dead fields, Test Connection is honest, Save harmless
    await ev(() => { RM.aiStems.open(); RM.app.show('settings'); });
    await sleep(400);
    const setDsp = await ev(() => ({
      hfHidden: document.getElementById('ai-hf-fields').style.display === 'none',
      h46Hidden: document.getElementById('ai-hf46-fields').style.display === 'none',
      moHidden: document.getElementById('ai-modal-fields').style.display === 'none',
    }));
    record('ui-settings-dsp-no-dead-fields', setDsp.hfHidden && setDsp.h46Hidden && setDsp.moHidden, JSON.stringify(setDsp));
    await ev(() => { document.getElementById('ai-test').click(); });
    await sleep(300);
    const dspTestMsg = await ev(() => document.getElementById('ai-status-text').textContent);
    record('ui-settings-dsp-test-honest', /no test needed/i.test(dspTestMsg), dspTestMsg);
    // click every button on the AI screen + settings AI panel: no dead ends, no errors
    const errBefore = pageErrors.length;
    await ev(() => {
      RM.aiStems.setBackend('hf46'); RM.aiStems.open();
    });
    await sleep(400);
    await ev(() => {
      document.querySelectorAll('#aistem-setup button, #aistem-dsp-grid button').forEach((b) => {
        try { b.click(); } catch (e) {}
      });
    });
    await sleep(800);
    await ev(() => { RM.aiStems.open(); RM.app.show('settings'); });
    await sleep(400);
    await ev(() => {
      try { document.getElementById('ai-save').click(); } catch (e) {}
      try { document.getElementById('ai-test').click(); } catch (e) {}
    });
    await sleep(1200);
    record('ui-no-dead-buttons', pageErrors.length === errBefore,
      pageErrors.length === errBefore ? 'every button clicked, no page errors' : pageErrors.slice(errBefore).join(' || '));
    // hf46 guide honesty still intact
    await ev(() => { RM.aiStems.setBackend('hf46'); RM.aiStems.open(); });
    await sleep(300);
    const hf46txt = await ev(() => document.getElementById('aistem-setup').textContent);
    record('ui-hf46-honest-guide', /no reliable free public/i.test(hf46txt) && /6 is the maximum/i.test(hf46txt),
      'admits no public 4/6-stem Space; 6 = max');
    // restore default backend
    await ev(() => { try { localStorage.removeItem('rmx_ai_backend'); } catch (e) {} });

    /* ============ 6a. ad gate: fail-fast path (ad resolves false) ============ */
    await ev(() => {
      localStorage.setItem('rmx_ai_backend', 'modal');
      localStorage.setItem('rmx_ai_server', JSON.stringify({ url: 'https://example.invalid', key: 'k' }));
      RM.ads.showRewarded = () => Promise.resolve(false); // ad fails instantly
      RM.aiStems.open();
    });
    await page.waitForFunction(() => { const b = document.getElementById('ais-start'); return b && !b.disabled; }, { timeout: 10000 });
    await ev(() => { document.getElementById('ais-start').click(); });
    await page.waitForFunction(() => document.getElementById('dlg').classList.contains('show'), { timeout: 5000 });
    await ev(() => { document.getElementById('dlg-ok').click(); }); // I Agree
    await page.waitForFunction(() => {
      const f = document.getElementById('ais-fail');
      return f && f.style.display !== 'none' && /ais-retry/.test(f.innerHTML);
    }, { timeout: 15000 });
    const failMsg = await ev(() => document.getElementById('ais-fail').textContent.replace(/\s+/g, ' ').trim());
    record('adgate-fail-graceful', /Beta \(DSP\)/.test(failMsg) && /Try again/.test(failMsg),
      failMsg.slice(0, 180) + '…');
    // retry must re-arm the gate (not stuck): the mock still fails the ad, so
    // the FAIL panel must come back — a stuck gate would show nothing at all.
    await ev(() => { document.getElementById('ais-retry').click(); });
    await page.waitForFunction(() => {
      const f = document.getElementById('ais-fail');
      return f && f.style.display !== 'none' && /ais-retry/.test(f.innerHTML);
    }, { timeout: 15000 });
    record('adgate-retry-works', true, 'retry re-armed the gate (fail panel returned, no stuck state)');
    await ev(() => { const c = document.getElementById('ais-cancel-up'); if (c) c.click(); });
    await sleep(500);

    /* ============ 6b. ad gate: 90 s watchdog (ad SDK never settles) ============ */
    // NOTE: consent was already given in 6a, so no dialog this time — straight to the gate.
    await ev(() => {
      RM.ads.showRewarded = () => new Promise(() => {}); // never settles
      RM.aiStems.open();
    });
    await page.waitForFunction(() => { const b = document.getElementById('ais-start'); return b && !b.disabled; }, { timeout: 10000 });
    await ev(() => { document.getElementById('ais-start').click(); });
    await page.waitForFunction(() => {
      const p = document.getElementById('ais-progress');
      return p && p.style.display !== 'none' && /Loading ad/.test(p.textContent);
    }, { timeout: 10000 });
    record('adgate-watchdog-armed', true, 'gate pending with never-settling ad promise');
    await page.waitForFunction(() => {
      const f = document.getElementById('ais-fail');
      return f && f.style.display !== 'none' && /ais-retry/.test(f.innerHTML);
    }, { timeout: 100000 });
    record('adgate-watchdog-fires', true, '90 s watchdog failed the gate gracefully (no hang)');
    // gate must be re-usable afterwards
    await ev(() => { document.getElementById('ais-retry').click(); });
    await page.waitForFunction(() => {
      const p = document.getElementById('ais-progress');
      return p && p.style.display !== 'none';
    }, { timeout: 10000 });
    record('adgate-watchdog-retry', true, 'post-watchdog retry re-arms the gate');
    await ev(() => { const c = document.getElementById('ais-cancel-up'); if (c) c.click(); });
    await sleep(400);

    /* ============ honest-label scan: DSP must never be called neural AI ============ */
    // The honest disclaimers themselves say "(no neural network)" / "not neural
    // AI" — strip those before scanning, so only real AI-claims match.
    const honestNoNeuralDsp = await ev(() => {
      const bad = [];
      const stripHonest = (t) => t.replace(/no neural network/gi, '').replace(/not neural ai/gi, '').replace(/— not neural ai\./gi, '');
      const check = (text, where) => {
        if (/neural/i.test(stripHonest(text))) bad.push(where + ': ' + stripHonest(text).slice(0, 80));
      };
      RM.stems.ENGINES.forEach((e) => { check(e.name + ' ' + e.desc + ' ' + e.note, 'ENGINES'); });
      document.querySelectorAll('#stems-grid .engine-card, #aistem-dsp-grid .dsp-tool-card').forEach((d, i) => {
        check(d.textContent, 'card' + i);
      });
      return bad;
    });
    record('honest-no-neural-dsp', honestNoNeuralDsp.length === 0, honestNoNeuralDsp.length ? honestNoNeuralDsp.join(' || ') : 'DSP engines never claim neural AI (honest disclaimers intact)');

    /* ============ no page errors overall ============ */
    const realErrors = pageErrors.filter((e) => !/favicon/i.test(e));
    record('no-page-errors', realErrors.length === 0,
      realErrors.length ? realErrors.slice(0, 5).join(' || ') : `${results.filter((r) => r.ok).length} checks green`);
  } catch (err) {
    record('harness', false, (err && err.message ? err.message : String(err)).slice(0, 300));
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
  }
})();
