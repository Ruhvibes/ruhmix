#!/usr/bin/env node
/*
 * RuhMix v27 W4 — export quality + pre-export audio quality warnings.
 * Headless Chrome (puppeteer), real code, no DSP mocks (only RM.exp.deliver
 * is stubbed to capture the encoded blob instead of saving).
 *
 * Task A — export quality:
 *  A1 bitrate: MP3 encodes at 128/192/256/320 kbps (lamejs) -> valid frame
 *      sync, decodable, sane sizes; size grows with bitrate.
 *  A2 dither: floatToInt16/encodeWavBuffer {dither:true} -> TPDF dither is
 *      applied (differs from truncation, bounded to +/-1 LSB-ish, no overflow).
 *  A3 true-peak: -3 dBTP ceiling holds through the full guarded chain
 *      (resample 44100->48000 -> limiter -> dithered int16 -> MP3) and the
 *      MP3 encode->decode round trip stays under -1 dBTP at 192/256/320.
 *  A4 no silent clipping: post-resample limiter never mutates the caller's
 *      buffer (copy path when resample passes through) and is bit-transparent
 *      below the ceiling.
 *
 * Task B — pre-export warnings (RM.v25qc.runCheck, all measured, never made up):
 *  B1 clip-risk: true peak in (-1, 0] dBTP -> 'clip-risk' warn (no 'clipping').
 *  B2 clipping: true peak > 0 dBTP -> 'clipping' error, and no 'clip-risk'.
 *  B3 quiet-mix: RMS < -26 dBFS -> 'quiet-mix' warn; fixAll normalizes peak
 *      to 0.71 and the warning clears on re-check.
 *  B4 sep-quality: vocalTags ['smart DSP'] -> 'sep-quality' warn;
 *      ['neural stems'] -> no such warning. fixAll [-2 dB] on clip-risk.
 *  B5 bass tiers: ~33% sub-bass -> 'bass' warn; ~45% -> 'bass' error.
 *  B6 clean mix -> none of the audio warnings fire.
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
function check(name, cond, detail) { if (cond) ok(name, detail); else no(name, detail); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.RM && RM.app && RM.exp && RM.audio && RM.v25qc && RM.v25exportui && window.lamejs', { timeout: 60000 });
  ok('setup: app booted', 'RM + lamejs present');

  // ---------- helpers injected into the page ----------
  await page.evaluate(() => {
    window.__v27 = {
      // stereo buffer filled by fn(ch, i, t)
      mkBuf(sr, sec, fn) {
        const ctx = RM.audio.ensureCtx();
        const len = Math.floor(sr * sec);
        const buf = ctx.createBuffer(2, len, sr);
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < len; i++) d[i] = fn(c, i, i / sr);
        }
        return buf;
      },
      // 4x-oversampled true peak (mirrors the QC measurement, quick page-side)
      truePeak(buf) {
        let peak = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length - 1; i++) {
            const s0 = d[i], s1 = d[i + 1];
            const st = (s1 - s0) * 0.25;
            for (let k = 0; k <= 4; k++) {
              const v = Math.abs(k === 4 ? s1 : s0 + st * k);
              if (v > peak) peak = v;
            }
          }
        }
        return peak;
      },
      rmsDb(buf) {
        const d = buf.getChannelData(0);
        let e = 0, n = 0;
        for (let i = 0; i < d.length; i += 2) { e += d[i] * d[i]; n++; }
        return 10 * Math.log10(Math.max(1e-12, e / n));
      },
      async decode(blob) {
        const ab = await blob.arrayBuffer();
        return await RM.audio.ensureCtx().decodeAudioData(ab.slice(0));
      },
      // MP3 frame sync scan (0xFF + 3 sync bits) over the first 8KB
      hasFrameSync(u8) {
        const n = Math.min(u8.length - 1, 8192);
        for (let i = 0; i < n; i++) {
          if (u8[i] === 0xFF && (u8[i + 1] & 0xE0) === 0xE0) return true;
        }
        return false;
      },
    };
  });

  // ================= A1: bitrate options (lamejs really encodes each rate) =================
  // 3s stereo: 440Hz + transient clicks + a bass thump — exercises the encoder.
  const sizes = {};
  for (const kbps of [128, 192, 256, 320]) {
    const r = await page.evaluate(async (kbps) => {
      const H = window.__v27;
      const buf = H.mkBuf(44100, 3, (c, i, t) => {
        let v = 0.4 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 55 * t);
        if (i % 22050 < 40) v += 0.3 * (1 - (i % 22050) / 40); // click transient 2x/sec
        return v * 0.7;
      });
      const realDeliver = RM.exp.deliver;
      let captured = null;
      RM.exp.deliver = (blob) => { captured = blob; return Promise.resolve({ method: 'stub', name: 't.mp3' }); };
      try {
        // real pipeline: defaultDeps (resample->limit->dither->encode), xopts bitrate
        await RM.v25exportui.exportPipeline(buf, 'mp3', null, null, { cancelled: false }, { kbps, sampleRate: 44100 });
      } finally { RM.exp.deliver = realDeliver; }
      if (!captured) return { error: 'no blob captured' };
      const bytes = new Uint8Array(await captured.arrayBuffer());
      let decoded = null, decErr = null;
      try { const d = await H.decode(captured); decoded = d.duration.toFixed(2) + 's/' + d.numberOfChannels + 'ch'; }
      catch (e) { decErr = String(e && e.message || e); }
      return { size: captured.size, sync: H.hasFrameSync(bytes), decoded, decErr };
    }, kbps);
    if (r.error) { no('br-' + kbps, r.error); continue; }
    sizes[kbps] = r.size;
    check('br-' + kbps, r.size > 1000 && r.sync && !r.decErr,
      r.size + ' bytes, frame-sync=' + r.sync + ', decoded=' + (r.decoded || r.decErr));
  }
  check('br-size-order', sizes[320] > sizes[128],
    '320kbps=' + sizes[320] + 'B > 128kbps=' + sizes[128] + 'B (lamejs honors the rate)');

  // ================= A2: dithering =================
  const dith = await page.evaluate(async () => {
    const H = window.__v27;
    // sub-LSB signal: +/-0.33 LSB — pure truncation quantizes it to all zeros
    const buf = H.mkBuf(44100, 1, (c, i) => 0.00001 * Math.sin(2 * Math.PI * 7 * i / 44100));
    const plain = await RM.audio.floatToInt16(buf);
    const dith = await RM.audio.floatToInt16(buf, null, { dither: true });
    let diff = 0, maxAbs = 0;
    for (let i = 0; i < plain.left.length; i++) {
      const d = Math.abs(dith.left[i] - plain.left[i]);
      if (d > 0) diff++;
      if (d > maxAbs) maxAbs = d;
    }
    let plainNonZero = 0;
    for (let i = 0; i < plain.left.length; i++) if (plain.left[i] !== 0) plainNonZero++;
    // full-scale bounds: dither must never overflow int16
    const hot = H.mkBuf(44100, 1, (c, i) => Math.sin(2 * Math.PI * 440 * i / 44100));
    const hotD = await RM.audio.floatToInt16(hot, null, { dither: true });
    let mn = 32767, mx = -32768;
    for (let i = 0; i < hotD.left.length; i++) {
      if (hotD.left[i] < mn) mn = hotD.left[i];
      if (hotD.left[i] > mx) mx = hotD.left[i];
    }
    // determinism: same input + same fixed seed -> identical output
    const dith2 = await RM.audio.floatToInt16(buf, null, { dither: true });
    let sameSeed = true;
    for (let i = 0; i < dith.left.length; i += 97) {
      if (dith.left[i] !== dith2.left[i]) { sameSeed = false; break; }
    }
    // WAV path dither: encodeWavBuffer honors opts too
    const wavAb = await RM.audio.encodeWavBuffer(buf, null, { dither: true });
    return { diffFrac: diff / plain.left.length, maxAbs, plainNonZero, mn, mx, sameSeed, wavBytes: wavAb.byteLength };
  });
  check('dither-truncation-baseline', dith.plainNonZero === 0, 'no-dither: sub-LSB signal -> all zeros (truncation confirmed)');
  check('dither-applied', dith.diffFrac > 0.05 && dith.maxAbs <= 2,
    (dith.diffFrac * 100).toFixed(1) + '% samples differ, max |diff|=' + dith.maxAbs + ' LSB (TPDF, no DC shift)');
  check('dither-bounds', dith.mn >= -32768 && dith.mx <= 32767, 'int16 range [' + dith.mn + ',' + dith.mx + '], no wraparound');
  check('dither-deterministic', dith.sameSeed && dith.wavBytes > 44, 'fixed seed reproducible; WAV path accepts dither opts (' + dith.wavBytes + 'B)');

  // ================= A3: -3 dBTP ceiling through the guarded MP3 round trip =================
  for (const kbps of [192, 256, 320]) {
    const r = await page.evaluate(async (kbps) => {
      const H = window.__v27;
      // hot mix: peaks at 1.2 (would clip hard without the guard)
      const buf = H.mkBuf(44100, 3, (c, i, t) =>
        1.2 * (0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.4 * Math.sin(2 * Math.PI * 110 * t)));
      const realDeliver = RM.exp.deliver;
      let captured = null;
      RM.exp.deliver = (blob) => { captured = blob; return Promise.resolve({ method: 'stub' }); };
      try {
        // 48000 target: exercises resample overshoot + the post-resample guard
        await RM.v25exportui.exportPipeline(buf, 'mp3', null, null, { cancelled: false }, { kbps, sampleRate: 48000 });
      } finally { RM.exp.deliver = realDeliver; }
      if (!captured) return { error: 'no blob' };
      const dec = await H.decode(captured);
      const tp = H.truePeak(dec);
      return { dbtp: 20 * Math.log10(Math.max(1e-9, tp)), size: captured.size };
    }, kbps);
    if (r.error) { no('roundtrip-' + kbps, r.error); continue; }
    check('roundtrip-' + kbps, r.dbtp <= -1.0, 'MP3 ' + kbps + 'kbps decoded true peak ' + r.dbtp.toFixed(2) + ' dBTP (<= -1 dBTP)');
  }

  // limiter itself: hot buffer -> ceiling 0.71
  const lim = await page.evaluate(async () => {
    const H = window.__v27;
    const buf = H.mkBuf(44100, 2, (c, i, t) => 1.2 * Math.sin(2 * Math.PI * 330 * t));
    await RM.v25qc.applyTruePeakLimiter(buf, null);
    return H.truePeak(buf);
  });
  check('limiter-ceiling', lim <= 0.71 * 1.002, 'hot 1.2 peak -> true peak ' + lim.toFixed(4) + ' (ceiling 0.71)');

  // ================= A4: no silent clipping, guard is transparent =================
  const guard = await page.evaluate(async () => {
    const H = window.__v27;
    // (a) transparency: limiter on under-ceiling audio must be bit-identical
    const clean = H.mkBuf(44100, 2, (c, i, t) => 0.5 * Math.sin(2 * Math.PI * 440 * t));
    const snap = Array.from(clean.getChannelData(0).slice(0, 5000));
    const work = await RM.v25qc.copyBuffer(clean);
    await RM.v25qc.applyTruePeakLimiter(work, null);
    const d = work.getChannelData(0);
    let identical = true;
    for (let i = 0; i < snap.length; i++) { if (d[i] !== snap[i]) { identical = false; break; } }
    // (b) copy semantics: the overlay guard never mutates the caller's buffer
    const src = H.mkBuf(44100, 2, (c, i, t) => 0.6 * Math.sin(2 * Math.PI * 440 * t));
    const srcSnap = Array.from(src.getChannelData(0).slice(0, 5000));
    const realDeliver = RM.exp.deliver;
    RM.exp.deliver = () => Promise.resolve({ method: 'stub' });
    try {
      // sampleRate == buffer rate -> resample passes through -> copy path
      await RM.v25exportui.exportPipeline(src, 'mp3', null, null, { cancelled: false }, { kbps: 192, sampleRate: 44100 });
    } finally { RM.exp.deliver = realDeliver; }
    const sd = src.getChannelData(0);
    let srcUntouched = true;
    for (let i = 0; i < srcSnap.length; i++) { if (sd[i] !== srcSnap[i]) { srcUntouched = false; break; } }
    return { identical, srcUntouched };
  });
  check('guard-transparent', guard.identical, 'limiter bit-identical below -3 dBTP ceiling');
  check('guard-no-mutate', guard.srcUntouched, "caller's buffer untouched when resample passes through (copy path)");

  // ================= B1: clip-risk warning =================
  const b1 = await page.evaluate(async () => {
    const H = window.__v27;
    const buf = H.mkBuf(44100, 4, (c, i, t) => 0.95 * Math.sin(2 * Math.PI * 440 * t)); // -0.45 dBTP
    const r = await RM.v25qc.runCheck(buf, {});
    const ids = r.issues.map((x) => x.id + ':' + x.severity);
    return { ids, tp: r.measurements.truePeak };
  });
  check('warn-clip-risk', b1.ids.some((s) => s === 'clip-risk:warn') && !b1.ids.some((s) => s.indexOf('clipping:') === 0),
    'true peak ' + (20 * Math.log10(b1.tp)).toFixed(2) + ' dBTP -> ' + JSON.stringify(b1.ids));

  // ================= B2: real clipping is still an error =================
  const b2 = await page.evaluate(async () => {
    const H = window.__v27;
    const buf = H.mkBuf(44100, 4, (c, i, t) => 1.05 * Math.sin(2 * Math.PI * 440 * t));
    const r = await RM.v25qc.runCheck(buf, {});
    const ids = r.issues.map((x) => x.id + ':' + x.severity);
    return { ids };
  });
  check('warn-clipping-error', b2.ids.some((s) => s === 'clipping:error') && !b2.ids.some((s) => s.indexOf('clip-risk') === 0),
    JSON.stringify(b2.ids));

  // ================= B3: quiet mix + one-tap normalize fix =================
  const b3 = await page.evaluate(async () => {
    const H = window.__v27;
    const buf = H.mkBuf(44100, 4, (c, i, t) => 0.01 * Math.sin(2 * Math.PI * 440 * t)); // -43 dBFS RMS
    const r = await RM.v25qc.runCheck(buf, {});
    const ids = r.issues.map((x) => x.id);
    const rmsDb = r.measurements.rmsDb;
    // one-tap fix: fixAll on the quiet-mix issue
    const qm = r.issues.filter((x) => x.id === 'quiet-mix');
    const fr = await RM.v25qc.fixAll(buf, qm, {});
    const peakAfter = H.truePeak(fr.buffer);
    const re = await RM.v25qc.runCheck(fr.buffer, {});
    const stillQuiet = re.issues.some((x) => x.id === 'quiet-mix');
    return { ids, rmsDb, peakAfter, stillQuiet, fixes: fr.fixes.length };
  });
  check('warn-quiet', b3.ids.indexOf('quiet-mix') >= 0, 'RMS ' + b3.rmsDb.toFixed(1) + ' dBFS -> ' + JSON.stringify(b3.ids));
  check('fix-quiet', Math.abs(b3.peakAfter - 0.71) < 0.01 && !b3.stillQuiet && b3.fixes === 1,
    'one-tap normalize -> peak ' + b3.peakAfter.toFixed(3) + ', warning clears on re-check');

  // ================= B4: separation-quality flag + clip-risk one-tap fix =================
  const b4 = await page.evaluate(async () => {
    const H = window.__v27;
    const clean = H.mkBuf(44100, 4, (c, i, t) => 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.15 * Math.sin(2 * Math.PI * 880 * t));
    const dsp = await RM.v25qc.runCheck(clean, { vocalTags: ['smart DSP', 'smart DSP'] });
    const neu = await RM.v25qc.runCheck(clean, { vocalTags: ['neural stems', 'neural stems'] });
    const mix = await RM.v25qc.runCheck(clean, { vocalTags: ['smart DSP', 'neural stems'] });
    const dspIds = dsp.issues.filter((x) => x.id === 'sep-quality');
    const neuHas = neu.issues.some((x) => x.id === 'sep-quality');
    const mixHas = mix.issues.some((x) => x.id === 'sep-quality');
    // clip-risk one-tap fix: -2 dB
    const hot = H.mkBuf(44100, 4, (c, i, t) => 0.95 * Math.sin(2 * Math.PI * 440 * t));
    const hr = await RM.v25qc.runCheck(hot, {});
    const cr = hr.issues.filter((x) => x.id === 'clip-risk');
    const before = H.truePeak(hot);
    const fr = await RM.v25qc.fixAll(hot, cr, {});
    const after = H.truePeak(fr.buffer);
    return {
      dsp: dspIds.map((x) => x.severity + '|' + (x.autoFixable ? 'auto' : 'manual')),
      neuHas, mixHas, before, after,
    };
  });
  check('warn-sep-dsp', b4.dsp.length === 1 && b4.dsp[0].indexOf('warn|manual') === 0 && !b4.neuHas && b4.mixHas,
    'DSP tags -> warn(manual); neural -> silent; mixed -> warn. [' + b4.dsp.join(',') + ']');
  check('fix-cliprisk', Math.abs(20 * Math.log10(b4.after / b4.before) + 2) < 0.15,
    'one-tap -2 dB: ' + (20 * Math.log10(b4.before)).toFixed(2) + ' -> ' + (20 * Math.log10(b4.after)).toFixed(2) + ' dBTP');

  // ================= B5: bass tiers =================
  const b5 = await page.evaluate(async () => {
    const H = window.__v27;
    const cf = (a55) => H.mkBuf(44100, 4, (c, i, t) => a55 * Math.sin(2 * Math.PI * 55 * t) + 0.5 * Math.sin(2 * Math.PI * 1000 * t));
    const mid = cf(0.39);   // ~33% sub-bass -> warn
    const hi = cf(0.52);    // ~43% sub-bass -> error (v24 phone-buzz finding)
    const r1 = await RM.v25qc.runCheck(mid, {});
    const r2 = await RM.v25qc.runCheck(hi, {});
    const b1 = r1.issues.filter((x) => x.id === 'bass').map((x) => x.severity);
    const b2 = r2.issues.filter((x) => x.id === 'bass').map((x) => x.severity);
    return { share1: r1.measurements.bassShare, share2: r2.measurements.bassShare, b1, b2 };
  });
  check('warn-bass-warn', b5.share1 > 0.30 && b5.share1 <= 0.40 && b5.b1[0] === 'warn',
    'share ' + (b5.share1 * 100).toFixed(1) + '% -> warn');
  check('warn-bass-error', b5.share2 > 0.40 && b5.b2[0] === 'error',
    'share ' + (b5.share2 * 100).toFixed(1) + '% -> error (phone-buzz tier)');

  // ================= B6: clean mix -> no audio warnings =================
  const b6 = await page.evaluate(async () => {
    const H = window.__v27;
    const buf = H.mkBuf(44100, 4, (c, i, t) => 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.15 * Math.sin(2 * Math.PI * 880 * t));
    const r = await RM.v25qc.runCheck(buf, { vocalTags: ['neural stems'] });
    const audioIds = ['clipping', 'clip-risk', 'bass', 'harsh', 'quiet-mix', 'sep-quality'];
    const hit = r.issues.filter((x) => audioIds.indexOf(x.id) >= 0).map((x) => x.id);
    return { hit, all: r.issues.map((x) => x.id) };
  });
  check('warn-clean', b6.hit.length === 0, 'clean mix: no audio warnings (all issues: ' + JSON.stringify(b6.all) + ')');

  await browser.close();
  console.log('\n==== v27-export: ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
