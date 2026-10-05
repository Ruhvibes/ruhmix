#!/usr/bin/env node
/**
 * RuhMix stem-deck + HF 4/6-Stem backend tests.
 * Drives the REAL app in headless Chrome (file://):
 *  - AI Stem screen: 4 backends, DSP Beta tools section (experimental labels)
 *  - hf46 setup guide honesty (no fake public 4/6-stem Space)
 *  - stemDeck.render with 2/4/6 stems: card counts, per-card controls
 *    (Play/Vol/Pan/Mute/Solo/Export), Full Instrumental render+export,
 *    Load-all-into-Mixer (6 tracks incl. guitar/piano routing)
 *  - DSP engine run (vocalcut) renders the deck with DSP badge
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

  try {
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.RM && RM.app && RM.app.state, { timeout: 30000 });
    await page.evaluate(() => {
      const sk = document.getElementById('ob-skip');
      if (sk && document.getElementById('ob-ov') && document.getElementById('ob-ov').classList.contains('show')) sk.click();
    });
    await new Promise((r) => setTimeout(r, 300));

    const ev = (fn, ...args) => page.evaluate(fn, ...args);

    // ---------- 0. fixture audio (aiStems.open() needs audio) ----------
    await ev(() => {
      const ctx = RM.audio.ensureCtx();
      const sr = 44100, n = sr * 10;
      const buf = ctx.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = Math.sin(6.28 * (c ? 660 : 440) * i / sr) * 0.4; }
      RM.app.loadAudioBuffer(buf, 'stem-fixture.wav');
    });
    await page.waitForFunction(() => RM.app.state.viewBuffer && RM.app.state.viewBuffer.duration > 9.9, { timeout: 30000 });
    record('fixture-audio-loaded', true, '10s buffer ready');

    // ---------- 1. AI Stem screen: 4 backends ----------
    await ev(() => RM.aiStems.open());
    await page.waitForFunction(() => document.querySelectorAll('#aib-row button').length === 4, { timeout: 10000 });
    record('backend-picker-4-options', true, await ev(() =>
      Array.from(document.querySelectorAll('#aib-row button')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));

    // ---------- 2. DSP Beta tools section on the AI screen ----------
    const dspCards = await ev(() => Array.from(document.querySelectorAll('#aistem-dsp-grid .dsp-tool-card')).map((d) => ({
      name: d.querySelector('.ec-name').textContent.trim(),
      honest: d.querySelector('.honest').textContent.trim(),
    })));
    record('dsp-section-4-tools', dspCards.length === 4, dspCards.map((c) => c.name).join(' / '));
    const allHonest = dspCards.every((c) => /Experimental \(DSP\) — not neural AI/.test(c.honest));
    record('dsp-section-honest-labels', allHonest, allHonest ? 'every tool carries the experimental label' : JSON.stringify(dspCards));

    // ---------- 3. hf46 backend: honest setup guide (no fake public Space) ----------
    await ev(() => { RM.aiStems.setBackend('hf46'); RM.aiStems.open(); });
    await page.waitForFunction(() => /no reliable free/i.test(document.getElementById('aistem-setup').textContent || ''), { timeout: 10000 });
    const guideText = await ev(() => document.getElementById('aistem-setup').textContent);
    record('hf46-guide-no-fake-space', /no reliable free public/i.test(guideText), 'guide admits no verified public 4/6-stem Space');
    record('hf46-guide-6-max', /6 is the maximum/i.test(guideText), 'guide states 6 is the max');
    record('hf46-guide-quota-note', /uses more of your free GPU quota/i.test(guideText), 'guide warns 6-stem is slower/hungrier');

    // ---------- 4. Settings: hf46 fields ----------
    await ev(() => RM.app.show('settings'));
    await ev(() => { RM.aiStems.setBackend('hf46'); document.querySelectorAll('#ai-backend-picker button')[2].click(); });
    await new Promise((r) => setTimeout(r, 300));
    const hf46Visible = await ev(() => {
      const f = document.getElementById('ai-hf46-fields');
      return f && f.style.display !== 'none' && !!document.getElementById('ai-hf46-url') && !!document.getElementById('ai-hf46-model');
    });
    record('settings-hf46-fields', !!hf46Visible, 'URL + API name + model select visible');
    const modelOpts = await ev(() => Array.from(document.getElementById('ai-hf46-model').options).map((o) => o.value).join(','));
    record('settings-hf46-models', modelOpts === 'htdemucs,htdemucs_6s', modelOpts);

    // ---------- 5. stemDeck: dynamic card counts (2/4/6) ----------
    const counts = await ev(() => {
      const ctx = RM.audio.ensureCtx();
      const mk = (secs) => {
        const b = ctx.createBuffer(2, Math.floor(44100 * secs), 44100);
        for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.sin(6.28 * 440 * i / 44100) * 0.3; }
        return b;
      };
      window.__bufs = { b2: [mk(2), mk(2)], b4: [mk(2), mk(2), mk(2), mk(2)], b6: [mk(2), mk(2), mk(2), mk(2), mk(2), mk(2)] };
      const roles2 = ['vocal', 'other'];
      const roles4 = ['vocal', 'drums', 'bass', 'other'];
      const roles6 = ['vocal', 'drums', 'bass', 'other', 'piano', 'guitar'];
      const host = document.createElement('div');
      host.id = 'deck-test-host';
      document.body.appendChild(host);
      const out = {};
      [['b2', roles2], ['b4', roles4], ['b6', roles6]].forEach(([k, roles]) => {
        host.innerHTML = '';
        const stems = window.__bufs[k].map((buf, i) => ({ name: 'Stem ' + (i + 1), buffer: buf, role: roles[i], badge: 'T' }));
        RM.stemDeck.render(host, stems, { title: 't' });
        out[k] = host.querySelectorAll('.stem-card').length;
      });
      return out;
    });
    record('deck-2-cards', counts.b2 === 2, 'got ' + counts.b2);
    record('deck-4-cards', counts.b4 === 4, 'got ' + counts.b4);
    record('deck-6-cards', counts.b6 === 6, 'got ' + counts.b6);

    // ---------- 6. per-card controls exist and work ----------
    const controls = await ev(() => {
      const host = document.getElementById('deck-test-host');
      host.innerHTML = '';
      const roles = ['vocal', 'drums', 'bass', 'other', 'piano', 'guitar'];
      const stems = window.__bufs.b6.map((buf, i) => ({ name: 'S' + (i + 1), buffer: buf, role: roles[i], badge: 'HF' }));
      const deck = RM.stemDeck.render(host, stems, {});
      window.__deck = deck;
      const cards = Array.from(host.querySelectorAll('.stem-card'));
      const first = cards[0];
      return {
        n: cards.length,
        hasPlay: !!first.querySelector('.sc-play'),
        hasVol: !!first.querySelector('.sc-vol'),
        hasPan: !!first.querySelector('.sc-pan'),
        hasMute: !!first.querySelector('.sc-mute'),
        hasSolo: !!first.querySelector('.sc-solo'),
        hasExp: !!first.querySelector('.sc-exp'),
        icons: cards.map((c) => c.querySelector('.sc-icon').textContent).join(''),
      };
    });
    record('deck-card-controls', controls.n === 6 && controls.hasPlay && controls.hasVol && controls.hasPan && controls.hasMute && controls.hasSolo && controls.hasExp,
      `cards=${controls.n} icons=${controls.icons}`);

    // Play a card -> becomes pause, deck reports playing
    await ev(() => { document.querySelector('#deck-test-host .stem-card .sc-play').click(); });
    await new Promise((r) => setTimeout(r, 500));
    const playState = await ev(() => ({
      btn: document.querySelector('#deck-test-host .stem-card .sc-play').textContent,
      playing: window.__deck.cards[0].playing,
      deckPlaying: window.__deck.playing,
    }));
    record('deck-play', playState.btn === '⏸' && playState.playing && playState.deckPlaying, JSON.stringify(playState));

    // Volume slider moves the gain node
    await ev(() => {
      const v = document.querySelector('#deck-test-host .stem-card .sc-vol');
      v.value = 50; v.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 150));
    const volGain = await ev(() => window.__deck.cards[0].vol.gain.value);
    record('deck-volume-slider', Math.abs(volGain - 0.5) < 0.05, 'gain=' + volGain.toFixed(3));

    // Pan slider moves the panner
    await ev(() => {
      const p = document.querySelector('#deck-test-host .stem-card .sc-pan');
      p.value = -60; p.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 150));
    const panVal = await ev(() => (window.__deck.cards[0].pan ? window.__deck.cards[0].pan.pan.value : 999));
    record('deck-pan-slider', Math.abs(panVal - (-0.6)) < 0.05, 'pan=' + panVal);

    // Mute + Solo toggles (gate ramps via setTargetAtTime — allow it to settle)
    await ev(() => {
      document.querySelector('#deck-test-host .stem-card .sc-mute').click();
      document.querySelectorAll('#deck-test-host .stem-card .sc-solo')[1].click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const msState = await ev(() => ({
      mute: window.__deck.cards[0].mute,
      solo: window.__deck.cards[1].solo,
      gate0: window.__deck.cards[0].gate.gain.value,
    }));
    record('deck-mute-solo', msState.mute && msState.solo && msState.gate0 < 0.05,
      `mute=${msState.mute} solo=${msState.solo} gate0=${msState.gate0.toFixed(2)}`);

    // Pause the card again
    await ev(() => { document.querySelector('#deck-test-host .stem-card .sc-play').click(); });
    await new Promise((r) => setTimeout(r, 200));
    record('deck-pause', await ev(() => !window.__deck.cards[0].playing && !window.__deck.playing), 'card paused, deck idle');

    // ---------- 7. Full Instrumental: render + export ----------
    const instBtn = await ev(() => !!document.querySelector('#deck-test-host [data-a="make"]'));
    record('deck-full-instrumental-button', instBtn, 'one-tap button present');
    await ev(() => { document.querySelector('#deck-test-host [data-a="make"]').click(); });
    await page.waitForFunction(() => {
      const o = document.querySelector('#deck-test-host .deck-inst-out');
      return o && o.style.display !== 'none';
    }, { timeout: 30000 });
    const instInfo = await ev(() => {
      const d = window.__deck;
      return { outVisible: true };
    });
    record('deck-instrumental-rendered', instInfo.outVisible, 'instrumental mix ready');
    // Export the instrumental -> export screen source
    await ev(() => { document.querySelector('#deck-test-host .deck-inst-out [data-a="exp"]').click(); });
    await new Promise((r) => setTimeout(r, 400));
    const expSrc = await ev(() => RM.app.state.exportSource && RM.app.state.exportSource.name);
    record('deck-instrumental-export', expSrc === 'Full Instrumental', 'exportSource=' + expSrc);

    // ---------- 8. Individual stem export ----------
    await ev(() => { RM.stemDeck.stopAllDecks(); });
    await ev(() => {
      const host = document.getElementById('deck-test-host');
      host.innerHTML = '';
      const roles = ['vocal', 'drums'];
      const stems = window.__bufs.b2.map((buf, i) => ({ name: 'MyStem' + (i + 1), buffer: buf, role: roles[i], badge: 'HF' }));
      RM.stemDeck.render(host, stems, {});
      host.querySelectorAll('.stem-card .sc-exp')[1].click();
    });
    await new Promise((r) => setTimeout(r, 400));
    record('deck-individual-export', await ev(() => RM.app.state.exportSource && RM.app.state.exportSource.name) === 'MyStem2',
      'exportSource=' + await ev(() => RM.app.state.exportSource && RM.app.state.exportSource.name));

    // ---------- 9. Load all into Mixer: 6 tracks, guitar/piano routing ----------
    await ev(() => { RM.stemDeck.stopAllDecks(); });
    await ev(() => {
      const host = document.getElementById('deck-test-host');
      host.innerHTML = '';
      const roles = ['vocal', 'drums', 'bass', 'other', 'piano', 'guitar'];
      const names = ['Vocals (HF)', 'Drums (HF)', 'Bass (HF)', 'Other (HF)', 'Piano (HF)', 'Guitar (HF)'];
      const stems = window.__bufs.b6.map((buf, i) => ({ name: names[i], buffer: buf, role: roles[i], badge: 'HF' }));
      RM.stemDeck.render(host, stems, {});
      const btns = Array.from(host.querySelectorAll('button')).filter((b) => /Load all stems into the Mixer/.test(b.textContent));
      btns[0].click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const mixTracks = await ev(() => RM.app.getMixerTracks().map((t) => ({ name: t.name, has: !!t.buffer })));
    const allLoaded = mixTracks.every((t) => t.has);
    record('mixer-6-tracks-loaded', allLoaded, mixTracks.map((t) => t.name).join(','));
    const gp = await ev(() => {
      const tr = RM.app.getMixerTracks();
      return { t4: tr[4].name, t5: tr[5].name };
    });
    record('mixer-guitar-piano-slots', /guitar/i.test(gp.t4) && /piano/i.test(gp.t5), `track4=${gp.t4} track5=${gp.t5}`);

    // ---------- 10. DSP engine end-to-end (vocalcut) -> deck with DSP badge ----------
    await ev(() => {
      const ctx = RM.audio.ensureCtx();
      const sr = 44100, n = sr * 6;
      const buf = ctx.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = Math.sin(6.28 * (c ? 520 : 440) * i / sr) * 0.4; }
      RM.app.loadAudioBuffer(buf, 'dsp-test.wav');
      RM.app.show('stems');
    });
    await page.waitForFunction(() => RM.app.state.viewBuffer && RM.app.state.viewBuffer.duration > 5, { timeout: 30000 });
    await ev(() => RM.app.runStemEngine('vocalcut'));
    await page.waitForFunction(() => document.querySelectorAll('#stems-results .stem-card').length === 2, { timeout: 60000 });
    const dspDeck = await ev(() => ({
      cards: document.querySelectorAll('#stems-results .stem-card').length,
      badges: Array.from(document.querySelectorAll('#stems-results .stem-card .beta')).map((b) => b.textContent).join(','),
      experimental: /Experimental \(DSP\) — not neural AI/.test(document.getElementById('stems-results').textContent),
      instBtn: !!document.querySelector('#stems-results [data-a="make"]'),
    }));
    record('dsp-vocalcut-deck', dspDeck.cards === 2 && dspDeck.badges === 'DSP,DSP',
      `cards=${dspDeck.cards} badges=${dspDeck.badges}`);
    record('dsp-deck-experimental-note', dspDeck.experimental, 'experimental (DSP) note on deck');
    record('dsp-deck-full-instrumental', dspDeck.instBtn, 'Full Instrumental offered for DSP outputs');

    // ---------- 11. hf46 model registry sanity ----------
    const models = await ev(() => ({
      m4: RM.hf46Stems.MODELS.htdemucs.order.join(','),
      m6: RM.hf46Stems.MODELS.htdemucs_6s.order.join(','),
    }));
    record('hf46-model-orders', models.m4 === 'drums,bass,other,vocals' && models.m6 === 'drums,bass,other,vocals,piano,guitar',
      `4=[${models.m4}] 6=[${models.m6}]`);

    // ---------- 12. no page errors ----------
    const realErrors = pageErrors.filter((e) => !/favicon/i.test(e));
    record('no-page-errors', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 5).join(' || ') : `${results.filter((r) => r.ok).length} checks passed`);
  } catch (err) {
    record('harness', false, (err && err.message ? err.message : String(err)).slice(0, 300));
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
  }
})();
