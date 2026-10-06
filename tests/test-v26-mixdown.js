#!/usr/bin/env node
/*
 * RuhMix v26 (I5) — mixer mixdown export + mastering->export verification.
 * Headless Chrome (puppeteer), real code, no mocks except RM.exp.deliver
 * (stubbed to capture the exported blob for decode-back analysis).
 *
 * T1: all-muted mix renders silence
 * T2: solo isolates one track
 * T3: pan law — hard-left pan => L RMS >> R RMS
 * T4: vol change reflected in rendered RMS (ratio ~2)
 * T5: master chain ON vs OFF (unit) — different, limiter tames hot signal
 * T6: "Export Mix" button -> export screen with "Selected: mixdown" checked
 * T7: mastering toggle -> export screen shows "Mastering: ON" (and hides when OFF)
 * T8: full doExport with mastering ON vs OFF — different, louder/limited output
 *
 * Exit 0 = all pass.
 */
'use strict';
const puppeteer = require('/home/hatch/workspace/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';

let pass = 0, fail = 0;
function ok(name, detail) { pass++; console.log('PASS', name, detail ? ' — ' + detail : ''); }
function no(name, detail) { fail++; console.log('FAIL', name, detail ? ' — ' + detail : ''); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.app && RM.v26mixdown && RM.fx && RM.exp && RM.audio', { timeout: 60000 });
  ok('setup: boot with RM.v26mixdown');

  // Synthetic buffers: A = 440Hz (left-biased content), B = 880Hz, hot = 0.9 sine.
  await page.evaluate(() => {
    const ctx = RM.audio.ensureCtx();
    const SR = 44100;
    const mk = (freq, amp, secs) => {
      const buf = ctx.createBuffer(2, Math.floor(SR * secs), SR);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
      }
      return buf;
    };
    window.__A = mk(440, 0.5, 2);
    window.__B = mk(880, 0.5, 2);
    window.__hot = mk(440, 0.9, 2);
  });
  const rmsOf = (buf) => page.evaluate((b) => {
    let s = 0, n = 0;
    const out = [];
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c); let cs = 0;
      for (let i = 0; i < d.length; i++) cs += d[i] * d[i];
      out.push(Math.sqrt(cs / d.length)); s += cs; n += d.length;
    }
    return { ch: out, all: Math.sqrt(s / n) };
  }, buf).catch(() => null);

  const setTracks = (cfg) => page.evaluate((cfg) => {
    const trs = RM.app.getMixerTracks();
    trs.forEach((t, i) => {
      const c = cfg[i] || {};
      t.buffer = c.buf || null;
      t.vol = c.vol != null ? c.vol : 0.9;
      t.pan = c.pan || 0;
      t.mute = !!c.mute;
      t.solo = !!c.solo;
    });
  }, cfg);

  // ---- T1: all muted -> silence ----
  await setTracks([{ buf: '__A', mute: true }, { buf: '__B', mute: true }].map((c, i) => {
    return { buf: null, mute: true };
  }));
  let r = await page.evaluate(async () => {
    const trs = RM.app.getMixerTracks();
    trs[0].buffer = window.__A; trs[1].buffer = window.__B;
    trs[0].mute = true; trs[1].mute = true; trs[0].solo = false; trs[1].solo = false;
    trs[0].vol = 1; trs[1].vol = 1; trs[0].pan = 0; trs[1].pan = 0;
    const out = await RM.v26mixdown.renderMixerOffline(trs);
    let s = 0, n = 0;
    for (let c = 0; c < 2; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; n++; } }
    return Math.sqrt(s / n);
  });
  (r < 1e-6) ? ok('T1 all-muted mix renders silence', 'RMS=' + r.toExponential(2)) : no('T1 all-muted mix renders silence', 'RMS=' + r);

  // ---- T2: solo isolates ----
  r = await page.evaluate(async () => {
    const trs = RM.app.getMixerTracks();
    trs[0].buffer = window.__A; trs[1].buffer = window.__B;
    trs[0].mute = false; trs[1].mute = false;
    trs[0].solo = true; trs[1].solo = false;   // only A soloed
    trs[0].vol = 1; trs[1].vol = 1; trs[0].pan = -1; trs[1].pan = 1;
    const out = await RM.v26mixdown.renderMixerOffline(trs);
    const R = out.getChannelData(1);
    let s = 0; for (let i = 0; i < R.length; i++) s += R[i] * R[i];
    return Math.sqrt(s / R.length);
  });
  (r < 1e-4) ? ok('T2 solo isolates one track', 'R-ch RMS=' + r.toExponential(2)) : no('T2 solo isolates one track', 'R-ch RMS=' + r);

  // ---- T3: pan law ----
  r = await page.evaluate(async () => {
    const trs = RM.app.getMixerTracks();
    trs[0].buffer = window.__A; trs[1].buffer = null;
    trs[0].mute = false; trs[0].solo = false; trs[0].vol = 1; trs[0].pan = -1;
    const out = await RM.v26mixdown.renderMixerOffline(trs);
    const L = out.getChannelData(0), R = out.getChannelData(1);
    let sl = 0, sr2 = 0;
    for (let i = 0; i < L.length; i++) { sl += L[i] * L[i]; sr2 += R[i] * R[i]; }
    return { l: Math.sqrt(sl / L.length), r: Math.sqrt(sr2 / R.length) };
  });
  (r.l > 0.2 && r.l / Math.max(r.r, 1e-9) > 20)
    ? ok('T3 pan law audible L/R difference', `L=${r.l.toFixed(3)} R=${r.r.toExponential(1)}`)
    : no('T3 pan law audible L/R difference', JSON.stringify(r));

  // ---- T4: vol reflected in RMS ----
  r = await page.evaluate(async () => {
    const trs = RM.app.getMixerTracks();
    trs[0].buffer = window.__A; trs[1].buffer = null;
    trs[0].mute = false; trs[0].solo = false; trs[0].pan = 0;
    const rms = async (v) => {
      trs[0].vol = v;
      const out = await RM.v26mixdown.renderMixerOffline(trs);
      const d = out.getChannelData(0);
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / d.length);
    };
    const a = await rms(1.0), b = await rms(0.5);
    return { a, b, ratio: a / b };
  });
  (Math.abs(r.ratio - 2) < 0.06)
    ? ok('T4 vol change reflected in rendered RMS', 'ratio=' + r.ratio.toFixed(3))
    : no('T4 vol change reflected in rendered RMS', 'ratio=' + r.ratio);

  // ---- T5: master chain ON vs OFF (unit) ----
  r = await page.evaluate(async () => {
    const SR = 44100, len = SR * 2;
    const render = async (useMst) => {
      const oc = new OfflineAudioContext(2, len, SR);
      const buf = oc.createBuffer(2, len, SR);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = 0.9 * Math.sin(2 * Math.PI * 440 * i / SR);
      }
      const src = oc.createBufferSource(); src.buffer = buf;
      let chain = null, tail = src;
      if (useMst) {
        const mc = RM.v26mixdown.applyMasterChainOffline(oc, src, Object.assign({}, RM.fx.MASTER_PRESETS.loud));
        tail = mc.out; chain = mc.chain;
      }
      tail.connect(oc.destination); src.start(0);
      const out = await oc.startRendering();
      if (chain) chain.dispose();
      let peak = 0, s = 0, n = 0;
      for (let c = 0; c < 2; c++) {
        const d = out.getChannelData(c);
        for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; s += d[i] * d[i]; n++; }
      }
      return { peak, rms: Math.sqrt(s / n) };
    };
    const off = await render(false), on = await render(true);
    return { off, on };
  });
  const peakDiff = r.off.peak - r.on.peak;
  (peakDiff > 0.02 && Math.abs(r.on.rms - r.off.rms) > 0.005)
    ? ok('T5 mastering ON vs OFF differs (limited)', `peak OFF=${r.off.peak.toFixed(3)} ON=${r.on.peak.toFixed(3)}`)
    : no('T5 mastering ON vs OFF differs (limited)', JSON.stringify(r));

  // ---- T6: "Export Mix" button -> export screen, mixdown preselected ----
  await setTracks([{ buf: '__A', vol: 1 }, { buf: '__B', vol: 0.5, pan: 0.5 }].map(() => ({})));
  await page.evaluate(() => {
    const trs = RM.app.getMixerTracks();
    trs[0].buffer = window.__A; trs[0].vol = 1; trs[0].pan = 0; trs[0].mute = false; trs[0].solo = false;
    trs[1].buffer = window.__B; trs[1].vol = 0.5; trs[1].pan = 0.5; trs[1].mute = false; trs[1].solo = false;
    for (let i = 2; i < 6; i++) trs[i].buffer = null;
  });
  await page.evaluate(() => { RM.app.show('mixer'); });
  await page.waitForFunction(`document.querySelector('#screen-mixer.active')`, { timeout: 10000 });
  await page.click('#mx-export-mix');
  await page.waitForFunction(
    `document.querySelector('#screen-export.active') && RM.app.state.exportSource && RM.app.state.exportSource.name === 'mixdown'`,
    { timeout: 30000 });
  r = await page.evaluate(() => {
    const sel = document.querySelector('input[name="expsrc"]:checked');
    return sel ? sel.parentElement.textContent.trim() : null;
  });
  (r && r.indexOf('mixdown') >= 0)
    ? ok('T6 Export Mix -> export flow with mixdown selected', r)
    : no('T6 Export Mix -> export flow with mixdown selected', String(r));

  // ---- T7: mastering toggle -> "Mastering: ON" on export screen ----
  await page.evaluate(() => {
    const cb = document.getElementById('mst-apply-export');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    RM.app.show('export');
  });
  await page.waitForFunction(
    `document.getElementById('exp-mastering-flag').style.display !== 'none'`,
    { timeout: 10000 });
  r = await page.evaluate(() => document.getElementById('exp-mastering-flag').textContent);
  const flagOn = /Mastering:\s*ON/.test(r) && await page.evaluate(() => RM.v26mixdown.masteringEnabled());
  await page.evaluate(() => {
    const cb = document.getElementById('mst-apply-export');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    RM.v26mixdown.updateExportFlag();
  });
  const flagOff = await page.evaluate(() => document.getElementById('exp-mastering-flag').style.display === 'none');
  (flagOn && flagOff)
    ? ok('T7 toggle -> "Mastering: ON" flag on export screen', r.trim())
    : no('T7 toggle -> "Mastering: ON" flag on export screen', `on=${flagOn} off=${flagOff}`);

  // ---- T8: full doExport, mastering ON vs OFF ----
  const doExportOnce = () => page.evaluate(async () => {
    const A = RM.app;
    A.state._exportOpts = [{
      kind: 't26', label: 't26',
      get: () => ({ buffer: window.__hot, rate: 1, fx: A.flatFx(), name: 't26' }),
    }];
    document.querySelectorAll('input[name="expsrc"]').forEach((x) => { x.checked = false; });
    document.querySelector('input[name="expfmt"][value="wav"]').checked = true;
    document.getElementById('exp-normalize').checked = false; // isolate mastering effect
    RM.exp.deliver = (blob) => { window.__t26out = blob; return Promise.resolve({ method: 'test', name: 't26.wav' }); };
    document.getElementById('exp-start').click();
    await new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = document.getElementById('exp-status').textContent;
        if (s.indexOf('✓ Done') === 0) { clearInterval(iv); res(); }
        else if (s.indexOf('Failed') === 0) { clearInterval(iv); rej(new Error('export failed')); }
        else if (Date.now() - t0 > 90000) { clearInterval(iv); rej(new Error('export timeout')); }
      }, 250);
    });
    const ab = await window.__t26out.arrayBuffer();
    const dc = new OfflineAudioContext(2, 1, 44100);
    const dec = await dc.decodeAudioData(ab);
    let peak = 0, s = 0, n = 0;
    for (let c = 0; c < 2; c++) {
      const d = dec.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; s += d[i] * d[i]; n++; }
    }
    return { peak, rms: Math.sqrt(s / n) };
  });
  await page.evaluate(() => {
    RM.app.state.mastering.settings = Object.assign({}, RM.fx.MASTER_PRESETS.loud);
    const cb = document.getElementById('mst-apply-export');
    cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const off = await doExportOnce();
  await page.evaluate(() => {
    const cb = document.getElementById('mst-apply-export');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const on = await doExportOnce();
  const differ = Math.abs(on.peak - off.peak) > 0.02 || Math.abs(on.rms - off.rms) > 0.005;
  (differ && on.peak < off.peak)
    ? ok('T8 doExport mastering ON vs OFF differs (limited)', `OFF peak=${off.peak.toFixed(3)} ON peak=${on.peak.toFixed(3)}`)
    : no('T8 doExport mastering ON vs OFF differs (limited)', `OFF=${JSON.stringify(off)} ON=${JSON.stringify(on)}`);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
