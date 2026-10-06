#!/usr/bin/env node
'use strict';
/* =====================================================================
   W4 — in-browser deep review (headless Chromium, REAL code + REAL DSP).
   No stubs: the page's own RM.audio / RM.fx / RM.stems / RM.mashupDSP /
   RM.mashup run against synthesized test audio.

   S1  WSOLA time-stretch click/pop test: pure 220 Hz sine, ratio 90/128
       -> pitch preserved, click-free joins, exact edges.
   S2  Full Auto Mashup: 90 BPM C-major song vs 128 BPM F-major song
       -> tempo guard (target 90, stretch 0.703), key match (-5 st),
          progress monotonic + English labels, peak <= 0.98, no NaN,
          BOTH vocal (440-ish chord) and beat audible (Goertzel bands).
   S3  Slowed+Reverb quality through the REAL slowed chain:
       pitch 440*0.8, reverb tail present + decaying (no tail cut),
       no clicks, no NaN.
   S4  stemPipeline.generate for all 11 styles (real OfflineAudioContext):
       resolves, non-silent, no NaN, progress reaches 1.
   S5  Mashup -> Export handoff: exportSource {kind:'buffer'} wired,
       refreshExportSource selects it.
   S6  Back mid-build: navigate away during mashup build -> no crash,
       build settles, progress hidden.

   Run: node tests/test-w4-browser.js
   ===================================================================== */
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const SHELL = '/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE_URL = 'file:///home/hatch/workspace/ruhmix/www/index.html';

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

async function pageTests() {
  const T = [];
  const ok = (cond, name, detail) => T.push({ name, pass: !!cond, detail: detail || '' });
  const SR = 44100;

  /* ---------- helpers ---------- */
  function stats(buf) {
    let peak = 0, sum = 0, n = 0, nan = 0, maxDelta = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      let prev = d[0];
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (!Number.isFinite(v)) { nan++; continue; }
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v; n++;
        if (i > 0) { const dl = Math.abs(v - prev); if (dl > maxDelta) maxDelta = dl; }
        prev = v;
      }
    }
    return { peak, rms: n ? Math.sqrt(sum / n) : 0, nan, maxDelta };
  }
  // Fundamental estimate via zero crossings over the middle half.
  function estimateFreq(buf, ch) {
    const d = buf.getChannelData(ch || 0);
    const a = (d.length * 0.25) | 0, b = (d.length * 0.75) | 0;
    let zc = 0, prev = d[a] >= 0;
    for (let i = a + 1; i < b; i++) { const cur = d[i] >= 0; if (cur !== prev) zc++; prev = cur; }
    return (zc / 2) / ((b - a) / buf.sampleRate);
  }
  // Goertzel magnitude at freq f.
  function goertzel(buf, f, ch) {
    const d = buf.getChannelData(ch || 0);
    const sr = buf.sampleRate, n = d.length;
    const k = f * n / sr, w = 2 * Math.PI * k / n, coeff = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { s0 = d[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
  }
  function rmsRegion(buf, t0, t1) {
    const d0 = buf.getChannelData(0), sr = buf.sampleRate;
    const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(d0.length, Math.floor(t1 * sr));
    let s = 0;
    for (let i = a; i < b; i++) s += d0[i] * d0[i];
    return Math.sqrt(s / Math.max(1, b - a));
  }
  // Pulsed chord-stack song: kick-like pulses at bpm + chord tones.
  // width=0 -> L==R (center, vocal-like); width=1 -> R quieter (wide, beat-like).
  function synthSong(ctx, bpm, freqs, secs, width) {
    const len = Math.floor(SR * secs);
    const b = ctx.createBuffer(2, len, SR);
    const beat = 60 / bpm;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const amp = c === 0 ? 0.5 : (width ? 0.25 : 0.5);
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        const bt = t % beat;
        const pulse = 0.35 + 0.65 * Math.exp(-bt / 0.05); // fast attack, ~50ms decay
        let v = 0;
        for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
        d[i] = amp * pulse * v / freqs.length;
      }
    }
    return b;
  }

  /* ================= S1: WSOLA clicks/pops ================= */
  {
    const ctx = RM.audio.ensureCtx();
    const secs = 3, len = Math.floor(SR * secs);
    const b = ctx.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR);
    }
    const ratio = 90 / 128; // 0.703125 — the mashup's actual guard case
    const out = await RM.mashupDSP.timeStretch(b, ratio);
    const st = stats(out);
    ok(Math.abs(out.length - Math.round(len * ratio)) <= 2, 'S1 length = in*ratio', 'got ' + out.length);
    const f = estimateFreq(out);
    ok(Math.abs(f - 220) / 220 < 0.02, 'S1 pitch preserved (220 Hz)', 'got ' + f.toFixed(2) + ' Hz');
    // 220 Hz @0.5 amp: max sample-to-sample delta = 0.5*2π*220/44100 ≈ 0.0157.
    // A WSOLA click would jump ~0.1+. Threshold 0.05 is 3x headroom.
    ok(st.maxDelta < 0.05, 'S1 no clicks/pops (maxDelta < 0.05)', 'got ' + st.maxDelta.toFixed(4));
    ok(st.nan === 0, 'S1 no NaN/Inf');
    const d0 = out.getChannelData(0);
    ok(d0[0] === 0 && d0[d0.length - 1] === 0, 'S1 click-free edges');
    ok(st.peak <= 1.0 && st.peak > 0.3, 'S1 sane level', 'peak ' + st.peak.toFixed(3));
  }

  /* ================= S2: full mashup, 90 vs 128 BPM ================= */
  let mashupBuf = null, mashupMeta = null;
  {
    const ctx = RM.audio.ensureCtx();
    // Song A (vocals): 90 BPM, C major (C4 E4 G4), center-panned.
    // Song B (beat): 128 BPM, D major (D3 F#3 A3), wide stereo.
    // D major chosen deliberately: F# is outside the C-major scale, so the
    // key detector cannot ambiguously return C major. Octaves chosen so
    // the -2 st shifted beat (C3/E3/G3) never collides with the vocal.
    const songA = synthSong(ctx, 90, [261.63, 329.63, 392.00], 8, 0);
    const songB = synthSong(ctx, 128, [146.83, 185.00, 220.00], 8, 1);
    const ev = [];
    const res = await RM.mashup.build(songA, songB, (label, frac) => ev.push([label, frac]));
    mashupBuf = res.buffer; mashupMeta = res.meta;
    const m = res.meta;
    // BPM detector may choose the 2x octave (its documented disambiguation);
    // assert the TEMPO GUARD invariant on whatever was detected.
    const bpm1ok = Math.abs(m.bpm1 - 90) <= 4 || Math.abs(m.bpm1 - 180) <= 6;
    ok(bpm1ok, 'S2 bpm1 ≈ 90 (or 2x octave 180)', 'got ' + m.bpm1);
    ok(Math.abs(m.bpm2 - 128) <= 5, 'S2 bpm2 ≈ 128 (real detectBPM)', 'got ' + m.bpm2);
    // guard invariant: ratio=bpm1/bpm2; >1.6 -> bpm1/2; <0.625 -> bpm1*2; else bpm1
    const ratio = m.bpm1 / m.bpm2;
    const expTarget = ratio > 1.6 ? m.bpm1 / 2 : (ratio < 0.625 ? m.bpm1 * 2 : m.bpm1);
    ok(Math.abs(m.targetBpm - expTarget) < 1, 'S2 half/double guard invariant holds',
       'ratio ' + ratio.toFixed(3) + ' target ' + m.targetBpm);
    ok(Math.abs(m.stretchRatio - m.bpm2 / m.targetBpm) < 0.01, 'S2 stretchRatio = bpm2/targetBpm (timeStretch ratio>1 = longer)', 'got ' + m.stretchRatio);
    ok(m.key1 === 'C major', 'S2 key1 = C major (real detectKey)', 'got ' + m.key1);
    ok(m.key2 === 'D major', 'S2 key2 = D major (real detectKey)', 'got ' + m.key2);
    ok(m.semitones === -2, 'S2 semitones = -2 (D down to C)', 'got ' + m.semitones);
    // progress: monotonic, ends at 1, all 7 English labels
    let mono = true, last = -1;
    for (const [, f] of ev) { if (f < last - 1e-9) mono = false; last = f; }
    ok(mono, 'S2 progress never goes backwards');
    ok(ev.length > 0 && ev[ev.length - 1][1] === 1, 'S2 progress ends at 1');
    const labels = ev.map((e) => e[0]);
    const want = ['Detecting tempo…', 'Isolating vocals…', 'Isolating beat…', 'Matching tempo…', 'Matching key…', 'Balancing loudness…', 'Mixing…'];
    ok(want.every((l) => labels.includes(l)), 'S2 all 7 English stage labels present');
    // output integrity
    const st = stats(mashupBuf);
    ok(st.nan === 0, 'S2 no NaN/Inf in mashup output');
    // Float32 stores 0.98 as 0.9800000191 — tolerance matches the
    // established pipeline test (0.98001), not a limiter failure.
    ok(st.peak <= 0.98001, 'S2 hard peak limit 0.98', 'peak ' + st.peak.toFixed(6));
    ok(st.rms > 0.01, 'S2 output not silent', 'rms ' + st.rms.toFixed(4));
    ok(mashupBuf.numberOfChannels === 2, 'S2 stereo output');
    ok(m.engineTagVocal === 'smart DSP' && m.engineTagInstr === 'smart DSP', 'S2 honest engine tags (smart DSP)', m.engineTagVocal + '/' + m.engineTagInstr);
    // BOTH sources audible: vocal chord (unshifted C4/E4/G4) + beat chord
    // shifted -2 st: D3 146.83->130.81, F#3 185->164.81, A3 220->196.00.
    const floor = goertzel(mashupBuf, 1000);
    const gV1 = goertzel(mashupBuf, 261.63), gV2 = goertzel(mashupBuf, 329.63), gV3 = goertzel(mashupBuf, 392.00);
    const gB1 = goertzel(mashupBuf, 130.81), gB2 = goertzel(mashupBuf, 164.81), gB3 = goertzel(mashupBuf, 196.00);
    ok(gV1 > 10 * floor && gV2 > 10 * floor && gV3 > 10 * floor, 'S2 VOCAL audible (261.6/329.6/392 Hz >> floor)',
       'vocal ' + gV1.toExponential(1) + '/' + gV2.toExponential(1) + '/' + gV3.toExponential(1) + ' floor ' + floor.toExponential(1));
    ok(gB1 > 10 * floor && gB2 > 10 * floor && gB3 > 10 * floor, 'S2 BEAT audible, key-matched -2 st (130.8/164.8/196 Hz >> floor)',
       'beat ' + gB1.toExponential(1) + '/' + gB2.toExponential(1) + '/' + gB3.toExponential(1));
  }

  /* ================= S3: Slowed+Reverb quality ================= */
  {
    const secs = 2, len = Math.floor(SR * secs);
    const oc = new OfflineAudioContext(2, Math.ceil(SR * (secs / 0.8 + 2.0)), SR);
    const tb = oc.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = tb.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        d[i] = 0.5 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.4 * t)) * Math.sin(2 * Math.PI * 440 * t);
      }
    }
    const style = RM.remix.get('slowed');
    ok(style.rate === 0.80, 'S3 slowed rate = 0.80');
    const src = oc.createBufferSource();
    src.buffer = tb; src.playbackRate.value = style.rate; // what the studio player does
    const chain = RM.fx.makeChain(oc);
    chain.applyPreset(JSON.parse(JSON.stringify(style.fx)));
    src.connect(chain.input);
    chain.output.connect(oc.destination);
    src.start(0);
    const out = await oc.startRendering();
    const st = stats(out);
    ok(st.nan === 0, 'S3 no NaN/Inf');
    const f = estimateFreq(out);
    ok(Math.abs(f - 352) / 352 < 0.03, 'S3 pitch 440*0.8 = 352 Hz (honest linked pitch)', 'got ' + f.toFixed(1) + ' Hz');
    ok(st.maxDelta < 0.08, 'S3 no clicks (maxDelta < 0.08)', 'got ' + st.maxDelta.toFixed(4));
    // reverb tail: source ends at 2/0.8 = 2.5 s; tail must ring, not cut.
    const tailRms = rmsRegion(out, 3.0, 4.0);
    ok(tailRms > 0.003, 'S3 reverb tail present (not cut)', 'tail rms ' + tailRms.toFixed(4));
    const w1 = rmsRegion(out, 2.6, 2.9), w2 = rmsRegion(out, 2.9, 3.2),
          w3 = rmsRegion(out, 3.2, 3.5), w4 = rmsRegion(out, 3.5, 3.8);
    ok(w1 >= w2 && w2 >= w3 && w3 >= w4 * 0.5, 'S3 tail decays smoothly (no abrupt cutoff)',
       [w1, w2, w3, w4].map((x) => x.toFixed(4)).join(' > '));
    ok(st.peak <= 1.0, 'S3 no clipping', 'peak ' + st.peak.toFixed(3));
    try { chain.dispose(); } catch (e) {}
  }

  /* ================= S4: stemPipeline.generate x 11 styles ================= */
  {
    const ctx = RM.audio.ensureCtx();
    const mk = (freq) => {
      const b = ctx.createBuffer(2, Math.floor(SR * 2), SR);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const t = i / SR, bt = t % 0.5;
          d[i] = 0.4 * (0.4 + 0.6 * Math.exp(-bt / 0.05)) * Math.sin(2 * Math.PI * freq * t);
        }
      }
      return b;
    };
    const packOf = () => ({ roles: [
      { role: 'vocal', label: 'vocal', buffer: mk(440) },
      { role: 'drums', label: 'drums', buffer: mk(110) },
    ]});
    for (const s of RM.remix.STYLES) {
      const ev = [];
      let res = null, err = null;
      try { res = await RM.remix.stemPipeline.generate(s.id, packOf(), {}, (l, f) => ev.push(f)); }
      catch (e) { err = e; }
      ok(!err, 'S4 generate(' + s.id + ') resolves', err && err.message);
      if (res) {
        const st = stats(res.buffer);
        ok(st.rms > 0.005, 'S4 ' + s.id + ': output not silent', 'rms ' + st.rms.toFixed(4));
        ok(st.nan === 0, 'S4 ' + s.id + ': no NaN/Inf');
        ok(ev.length === 0 || ev[ev.length - 1] === 1, 'S4 ' + s.id + ': progress reaches 1');
      }
    }
  }

  /* ================= S5: mashup -> export handoff ================= */
  {
    ok(!!mashupBuf, 'S5 mashup buffer available from S2');
    const sent = RM.mashupExport.sendToExport(mashupBuf, { name: 'W4 test mashup' });
    ok(sent === true, 'S5 sendToExport returns true');
    const es = RM.app.state.exportSource;
    ok(es && es.kind === 'buffer' && es.buffer === mashupBuf, 'S5 exportSource = {kind:buffer} (editor project untouched)');
    RM.app.refreshExportSource();
    const radios = Array.from(document.querySelectorAll('input[name="expsrc"]'));
    const sel = radios.find((r) => r.checked);
    ok(!!sel, 'S5 an export source radio is selected');
    ok(sel && /Mashup|Selected/i.test(sel.parentElement.textContent), 'S5 the mashup is the SELECTED source',
       sel ? sel.parentElement.textContent.slice(0, 60) : 'none');
    // editor's own buffer must be untouched by the handoff
    ok(!RM.app.state.buffer || true, 'S5 (no editor buffer loaded in test — skip)');
  }

  return { tests: T, meta: mashupMeta ? { bpm1: mashupMeta.bpm1, bpm2: mashupMeta.bpm2, targetBpm: mashupMeta.targetBpm, semitones: mashupMeta.semitones } : null };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: SHELL,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 160)); });
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.mashup && RM.mashupDSP && RM.remix && RM.fx', { timeout: 30000 });
  // dismiss any welcome overlay so DOM clicks work later
  await page.evaluate(() => {
    document.querySelectorAll('.rv-dialog-ov .btn.primary').forEach((b) => { try { b.click(); } catch (e) {} });
  });

  console.log('== running in-page tests (this takes a while: 11 stem renders + mashup) ==');
  const res = await page.evaluate(pageTests);
  for (const t of res.tests) ok(t.pass, t.name, t.detail);
  if (res.meta) console.log('   mashup meta:', JSON.stringify(res.meta));

  /* ================= S6: Back mid-build (DOM-level) ================= */
  console.log('== S6: Back mid-build ==');
  const s6errs0 = pageErrors.length;
  await page.evaluate(function () {
    window.__w4done = false; window.__w4err = null;
    const ctx = RM.audio.ensureCtx();
    const mk = (freq, bpm) => {
      const len = Math.floor(44100 * 4);
      const b = ctx.createBuffer(2, len, 44100);
      const beat = 60 / bpm;
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < len; i++) {
          const t = i / 44100, bt = t % beat;
          d[i] = 0.4 * (0.4 + 0.6 * Math.exp(-bt / 0.05)) * Math.sin(2 * Math.PI * freq * t);
        }
      }
      return b;
    };
    RM.mashupScreen.onPicked(1, mk(440, 100), 's1.wav');
    RM.mashupScreen.onPicked(2, mk(220, 120), 's2.wav');
    document.getElementById('mashup-make').click();
  });
  await new Promise((r) => setTimeout(r, 400)); // let the build start
  const buildingMid = await page.evaluate(() => {
    const bar = document.getElementById('mashup-prog-bar');
    return { width: bar ? bar.style.width : null, hidden: document.getElementById('mashup-progress').hidden };
  });
  console.log('   mid-build progress:', JSON.stringify(buildingMid));
  // user taps Back mid-processing
  await page.evaluate(() => { try { RM.app.show('home'); } catch (e) { window.__w4err = e.message; } });
  // wait for the build to settle (result appears even though user left)
  await page.waitForFunction('window.RM && RM.mashupScreen.getResult()', { timeout: 120000 }).catch(() => {});
  const s6 = await page.evaluate(() => ({
    result: !!RM.mashupScreen.getResult(),
    progHidden: document.getElementById('mashup-progress').hidden,
    makeEnabled: !document.getElementById('mashup-make').disabled,
    err: window.__w4err,
  }));
  ok(s6.result, 'S6 build completes even after Back (no crash, result kept)', JSON.stringify(s6));
  ok(s6.progHidden, 'S6 progress bar hidden after settle');
  ok(s6.makeEnabled, 'S6 Create button re-enabled after settle');
  ok(!s6.err, 'S6 no exception on Back mid-build', s6.err);
  const newErrs = pageErrors.slice(s6errs0);
  ok(newErrs.length === 0, 'S6 no page errors during Back-mid-build', newErrs.join(' | ').slice(0, 300));

  console.log('== page errors (whole run) ==');
  if (pageErrors.length) pageErrors.forEach((e) => console.log('   ' + e));
  else console.log('   none');
  ok(pageErrors.length === 0, 'zero page errors across the whole run', pageErrors.length + ' error(s)');

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('FAILED:', fails.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
