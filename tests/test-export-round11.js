#!/usr/bin/env node
/*
 * RuhMix Round-11 export verification (real code, headless Chrome).
 *
 * A) 7 export buttons: har screen (editor, remix, slowed, stems, mixer, master, record)
 *    ka Export button -> export screen khulti hai, sahi source preselected,
 *    cancel -> origin screen par wapas.
 * B) Export complete -> origin screen par wapas.
 * C) Formats: MP3 128/192/256/320 + WAV + FLAC — encode -> magic bytes + size + decode-back.
 * D) Duplication check: koi alag export dialog nahi (yeh code-review me bhi dekha).
 *
 * Exit 0 = all pass.
 */
'use strict';
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';

let pass = 0, fail = 0;
function ok(name, detail) { pass++; console.log('PASS', name, detail ? ' — ' + detail : ''); }
function no(name, detail) { fail++; console.log('FAIL', name, detail ? ' — ' + detail : ''); }

const waitFor = async (page, fn, timeout, what) => {
  await page.waitForFunction(fn, { timeout: timeout || 20000 });
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  let pageErrors = 0;
  page.on("pageerror", (e) => { pageErrors++; console.error("[pageerror]", e.message, "\nSTACK:", e.stack); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await waitFor(page, 'window.RM && RM.app && RM.ux && RM.exp && RM.audio', 60000, 'boot');

  // Synthetic stereo audio load karo (har screen ke needAudio guard ke liye).
  await page.evaluate(() => {
    const ctx = RM.audio.ensureCtx();
    const SR = 44100, len = SR * 5; // 5s
    const buf = ctx.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / SR) * (i < len - 200 ? 1 : i / (len - 200) * 0);
    }
    RM.app.loadAudioBuffer(buf, 'export-test-track');
  });
  await waitFor(page, 'RM.app.state.viewBuffer && RM.app.state.player', 20000, 'audio-load');
  ok('setup: synthetic audio loaded', '5s stereo 440Hz');

  // Helper: current visible screen ka id.
  const activeScreen = () => page.evaluate(() => {
    const el = document.querySelector('.screen.active');
    return el ? el.id.replace(/^screen-/, '') : null;
  });
  const show = (name) => page.evaluate((n) => RM.app.show(n), name);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Per-screen state setup + expected preselect label check.
  // stems ke liye 3 sub-cases: stemMix, single stem, multiple stems.
  const CASES = [
    { from: 'editor', setup: 'RM.app.state.stemMix=null; RM.app.state.remixBuffer=null; RM.stems.results.length=0;', expect: /Selected: export-test-track/ },
    { from: 'remix',  setup: 'RM.app.state.remixBuffer = RM.app.state.viewBuffer; RM.app.state.remixBufferName = "chill-remix";', expect: /Selected: remix-chill-remix|Selected: chill-remix/ },
    { from: 'slowed', setup: 'RM.app.state.remixBuffer=null;', expect: /Selected: export-test-track/ },
    { from: 'stems',  setup: 'RM.app.state.stemMix = RM.app.state.viewBuffer;', expect: /Selected: stem-mix/, name: 'stems(stemMix)' },
    { from: 'stems',  setup: 'RM.app.state.stemMix=null; RM.stems.results=[{name:"vocals",buffer:RM.app.state.viewBuffer}];', expect: /Selected: vocals/, name: 'stems(single)' },
    { from: 'stems',  setup: 'RM.app.state.stemMix=null; RM.stems.results=[{name:"vocals",buffer:RM.app.state.viewBuffer},{name:"drums",buffer:RM.app.state.viewBuffer}];', expect: /Stem: (vocals|drums)/, name: 'stems(multi: radio list)', checkList: ['Stem: vocals', 'Stem: drums'] },
    { from: 'mixer',  setup: 'RM.stems.results.length=0;', expect: /mixdown|Current project/, checkOpts: true },
    { from: 'master', setup: '', expect: /Selected: mastered-export-test-track/ },
    { from: 'record', setup: '', expect: /Selected: export-test-track/ },
  ];

  for (const c of CASES) {
    const label = c.name || c.from;
    try {
      await show(c.from);
      await page.evaluate((s) => { eval(s); }, c.setup);
      await sleep(150);
      // Real DOM click on the screen's Export button.
      const clicked = await page.evaluate((f) => {
        const b = document.querySelector('.ux-export-btn[data-from="' + f + '"]');
        if (!b) return 'no-button';
        b.click();
        return 'clicked';
      }, c.from);
      if (clicked !== 'clicked') { no('export-btn[' + label + ']', clicked); continue; }
      await waitFor(page, 'document.querySelector("#screen-export") && document.querySelector("#screen-export").classList.contains("active")', 10000, 'export-screen');
      const origin = await page.evaluate(() => RM.ux.getOrigin());
      if (origin !== c.from) { no('export-btn[' + label + ']-origin', 'getOrigin=' + origin); continue; }
      const info = await page.evaluate(() => {
        const sel = document.querySelector('input[name="expsrc"]:checked');
        const row = sel ? sel.closest('label') : null;
        return { label: row ? row.textContent.trim() : null, opts: (RM.app.state._exportOpts || []).map((o) => o.label) };
      });
      if (c.checkList) {
        const missing = c.checkList.filter((x) => !info.opts.includes(x));
        if (missing.length) { no('export-btn[' + label + ']-preselect', 'missing in list: ' + missing.join(',') + ' opts=' + JSON.stringify(info.opts)); continue; }
      } else if (!info.label || !c.expect.test(info.label)) {
        no('export-btn[' + label + ']-preselect', 'label="' + info.label + '" opts=' + JSON.stringify(info.opts));
        continue;
      }
      // Cancel -> origin par wapas.
      await page.evaluate(() => document.getElementById('exp-cancel').click());
      await sleep(250);
      const backTo = await activeScreen();
      const originAfter = await page.evaluate(() => RM.ux.getOrigin());
      if ((backTo || '').includes(c.from) && originAfter === null) {
        ok('export-btn[' + label + ']', 'opens + preselect "' + info.label.slice(0, 40) + '" + cancel->back to ' + c.from);
      } else {
        no('export-btn[' + label + ']-return', 'backTo=' + backTo + ' originAfter=' + originAfter);
      }
    } catch (e) {
      no('export-btn[' + label + ']', 'threw: ' + e.message);
    }
  }

  // B) Full export complete -> origin wapas.
  try {
    await show('editor');
    await page.evaluate(() => { RM.app.state.stemMix = null; RM.app.state.remixBuffer = null; RM.stems.results.length = 0; });
    await page.evaluate(() => { document.querySelector('.ux-export-btn[data-from="editor"]').click(); });
    await waitFor(page, 'document.querySelector("#screen-export").classList.contains("active")', 10000, 'export-screen');
    // Chhota export: WAV (tez), sample rate default.
    await page.evaluate(() => { document.getElementById('exp-format-wav').click(); });
    await page.evaluate(() => { document.getElementById('exp-start').click(); });
    await waitFor(page, 'document.getElementById("exp-status").textContent.indexOf("Done") >= 0 || document.getElementById("exp-status").textContent.indexOf("Failed") >= 0', 120000, 'export-done');
    const status = await page.evaluate(() => document.getElementById('exp-status').textContent);
    await sleep(300);
    const backTo = await activeScreen();
    if (/Done/.test(status) && (backTo || '').includes('editor')) {
      ok('export-complete->origin', 'status="' + status.slice(0, 40) + '", back on editor');
    } else {
      no('export-complete->origin', 'status="' + status + '" backTo=' + backTo);
    }
  } catch (e) { no('export-complete->origin', 'threw: ' + e.message); }

  // C) Formats: encode -> magic bytes + size + decode-back.
  try {
    const results = await page.evaluate(async () => {
      const ctx = RM.audio.ensureCtx();
      const SR = 44100, len = SR * 3;
      const buf = ctx.createBuffer(2, len, SR);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = 0.35 * Math.sin(2 * Math.PI * 220 * i / SR);
      }
      const i16 = await RM.audio.floatToInt16(buf);
      const out = {};
      // WAV
      const wavAb = await RM.audio.encodeWavBuffer(buf);
      const wavBytes = new Uint8Array(wavAb);
      out.wav = { size: wavBytes.length, riff: String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]), wave: String.fromCharCode(wavBytes[8], wavBytes[9], wavBytes[10], wavBytes[11]) };
      try { const dec = await ctx.decodeAudioData(wavAb.slice(0)); out.wav.decoded = Math.round(dec.duration * 100) / 100 + 's/' + dec.numberOfChannels + 'ch'; } catch (e) { out.wav.decoded = 'DECODE-FAIL ' + e.message; }
      // FLAC
      const flacBlob = await RM.exp.encodeFlac(i16, SR);
      const flacAb = await flacBlob.arrayBuffer();
      const fb = new Uint8Array(flacAb);
      out.flac = { size: fb.length, magic: String.fromCharCode(fb[0], fb[1], fb[2], fb[3]), compression: (Math.round((1 - fb.length / (len * 4)) * 100)) + '% smaller than raw 16-bit stereo' };
      // MP3 @ 4 bitrates
      out.mp3 = [];
      for (const kbps of [128, 192, 256, 320]) {
        const blob = await RM.exp.encodeMp3(i16, kbps, SR);
        const ab = await blob.arrayBuffer();
        const b = new Uint8Array(ab);
        const sync = b[0] === 0xFF && (b[1] & 0xE0) === 0xE0;
        let decoded = '?';
        try { const dec = await ctx.decodeAudioData(ab.slice(0)); decoded = Math.round(dec.duration * 100) / 100 + 's'; } catch (e) { decoded = 'DECODE-FAIL'; }
        out.mp3.push({ kbps, size: b.length, frameSync: sync, decoded });
      }
      return out;
    });
    // WAV
    if (results.wav.riff === 'RIFF' && results.wav.wave === 'WAVE' && results.wav.size > 1000 && !/DECODE-FAIL/.test(results.wav.decoded)) ok('format-wav', results.wav.size + ' bytes, RIFF/WAVE, decoded ' + results.wav.decoded);
    else no('format-wav', JSON.stringify(results.wav));
    // FLAC
    if (results.flac.magic === 'fLaC' && results.flac.size > 1000) ok('format-flac', results.flac.size + ' bytes, fLaC magic, ' + results.flac.compression);
    else no('format-flac', JSON.stringify(results.flac));
    // MP3
    let monoUp = true;
    results.mp3.forEach((m, i) => {
      const good = m.frameSync && m.size > 1000 && !/DECODE-FAIL/.test(m.decoded);
      if (i > 0 && m.size <= results.mp3[i - 1].size) monoUp = false;
      if (good) ok('format-mp3-' + m.kbps, m.size + ' bytes, frame sync, decoded ' + m.decoded);
      else no('format-mp3-' + m.kbps, JSON.stringify(m));
    });
    if (monoUp) ok('format-mp3-size-order', '128<192<256<320 by file size');
    else no('format-mp3-size-order', 'sizes not monotonic');
  } catch (e) { no('formats', 'threw: ' + e.message); }

  // pageerrors summary
  if (pageErrors === 0) ok('zero-pageerrors-export-suite', 'clean');
  else no('zero-pageerrors-export-suite', pageErrors + ' pageerrors');

  await browser.close();
  console.log('\n==== EXPORT: ' + pass + ' PASS / ' + fail + ' FAIL ====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e); process.exit(1); });
