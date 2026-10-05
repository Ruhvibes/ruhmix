'use strict';
/* =====================================================================
   RuhMix — ai-stems.js
   "AI Stem Separation" — REAL neural-model separation on a REMOTE
   server (Modal, T4 GPU, Demucs htdemucs). The word "AI" is used ONLY
   for this server-based neural flow. The on-device DSP engines are
   always labeled "Beta (DSP)" and are NEVER called AI.

   Server API contract (Modal app: ruhmix-ai-server/ruhmix_stems.py):
     POST {url}/separate            multipart/form-data, field "file"
                                    (WAV/MP3). Header: X-API-Key.
                                    -> 200 application/zip
                                       (vocals.wav, drums.wav, bass.wav,
                                        other.wav — 16-bit PCM, stored)
                                    Single synchronous request — NO job
                                    polling. 401/403 when the key is wrong.
     GET  {url}/health              -> 200 { "ok": true }
                                    (401/403 when the key is wrong)
                                    "Test Connection" isi ko call karta hai.

   Flow: consent -> REWARDED AD (1 ad = 1 gaana; ad complete tabhi
   separation start; ad fail/skip par graceful message, separation nahi)
   -> upload (XHR %) -> server 1-3 min process -> ZIP -> unzip -> mixer.

   Config lives ONLY in localStorage under 'rmx_ai_server' as
   { url, key }. No secret is bundled in the app, sent anywhere else,
   or committed to any repo. The key is never logged or displayed.
   ===================================================================== */
window.RM = window.RM || {};

RM.aiStems = (function () {
  // NOTE: this file loads BEFORE app.js, so RM.app is bound lazily in init().
  let A = null;
  let $ = null;
  const HI = () => false; // English-only build: language locked to English
  const T = (hi, en) => en; // English-only build

  const LS_KEY = 'rmx_ai_server';
  const LS_BACKEND = 'rmx_ai_backend'; // 'dsp' | 'hf' | 'hf46' | 'modal' — DEFAULT 'dsp'
  function getBackend() {
    try {
      const b = localStorage.getItem(LS_BACKEND);
      if (b === 'hf' || b === 'hf46' || b === 'modal' || b === 'dsp') return b;
    } catch (e) {}
    return 'dsp';
  }
  function setBackend(b) {
    if (b !== 'hf' && b !== 'hf46' && b !== 'modal' && b !== 'dsp') return;
    try { localStorage.setItem(LS_BACKEND, b); } catch (e) {}
  }
  const STEMS = [
    { id: 'vocals', name: 'Vocal (AI)',  trackIdx: 0 },
    { id: 'drums',  name: 'Drums (AI)',  trackIdx: 1 },
    { id: 'bass',   name: 'Bass (AI)',   trackIdx: 2 },
    { id: 'other',  name: 'Other (AI)',  trackIdx: 3 },
  ];
  // Consent text shown verbatim before the first upload. The server is the
  // USER's own Modal deployment (setup guide: "Apna AI server chalayein"),
  // so the text says "aapke apne" — not "hamare".
  const CONSENT_TEXT = 'Your audio will be processed on your own cloud server (Modal, GPU). As soon as processing finishes, your file is deleted immediately — no copy is saved. This service is funded by ads: you will watch one short ad before each separation (1 ad = 1 song).';

  const st = {
    song: null,          // {label, buffer}
    consentGiven: false,
    xhr: null,
    pollTimer: null,
    pollCtrl: null,
    pollFails: 0,
    job: null,
    running: false,
    results: [],
    players: [],
  };

  /* ================= config (localStorage only) ================= */
  function getCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (c && typeof c.url === 'string' && c.url.trim()) {
        return { url: c.url.trim().replace(/\/+$/, ''), key: (c.key || '') };
      }
    } catch (e) {}
    return null;
  }
  function setCfg(url, key) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ url: url, key: key || '' })); } catch (e) {}
  }

  /* ================= WAV encoder (upload payload) ================= */
  function bufferToWavBlob(buffer) {
    const sr = buffer.sampleRate;
    const nCh = Math.min(2, buffer.numberOfChannels);
    const len = buffer.length;
    const chs = [];
    for (let c = 0; c < nCh; c++) chs.push(buffer.getChannelData(c));
    const dataBytes = len * nCh * 2;
    const ab = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(ab);
    let off = 0;
    const ws = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i)); };
    ws('RIFF'); dv.setUint32(off, 36 + dataBytes, true); off += 4;
    ws('WAVE'); ws('fmt '); dv.setUint32(off, 16, true); off += 4;
    dv.setUint16(off, 1, true); off += 2;                 // PCM
    dv.setUint16(off, nCh, true); off += 2;
    dv.setUint32(off, sr, true); off += 4;
    dv.setUint32(off, sr * nCh * 2, true); off += 4;      // byte rate
    dv.setUint16(off, nCh * 2, true); off += 2;           // block align
    dv.setUint16(off, 16, true); off += 2;                // bits
    ws('data'); dv.setUint32(off, dataBytes, true); off += 4;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        let v = chs[c][i];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }
  function safeName(label) {
    return String(label || 'audio').replace(/[^\w\-. ]+/g, '_').trim().slice(0, 80) || 'audio';
  }

  /* ================= entry ================= */
  function open() {
    if (!A.needAudio()) return;
    A.show('aistem');
    render();
  }

  function render() {
    const setup = $('aistem-setup'), main = $('aistem-main');
    if (!setup || !main) return;
    abortAll(true); // stop anything from a previous visit
    if (RM.hfStems) RM.hfStems.abortAll(true);
    if (RM.hf46Stems) RM.hf46Stems.abortAll(true);
    renderBackendPicker();
    renderDspSection(); // DSP Beta tools live on this screen too (experimental)
    const be = getBackend();
    if (be === 'hf' && RM.hfStems) {
      RM.hfStems.renderInto(setup, main);
      return;
    }
    if (be === 'hf46' && RM.hf46Stems) {
      RM.hf46Stems.renderInto(setup, main);
      return;
    }
    if (be === 'dsp') {
      setup.style.display = ''; main.style.display = 'none';
      renderDspChoice();
      return;
    }
    // Modal (existing flow)
    if (!getCfg()) {
      setup.style.display = ''; main.style.display = 'none';
      renderSetup();
    } else {
      setup.style.display = 'none'; main.style.display = '';
      renderMain();
    }
  }

  /* ================= backend selector (4 options) ================= */
  function backendDefs() {
    return [
      { id: 'dsp',   icon: '✂️', label: T('', 'DSP Beta'),       sub: T('', 'Instant — experimental') },
      { id: 'hf',    icon: '🤗', label: T('', 'Hugging Face'), sub: T('', 'FREE AI — 2 stems') },
      { id: 'hf46',  icon: '🤗', label: T('', 'HF 4/6-Stem'),  sub: T('', 'Your Space — 4 or 6 stems') },
      { id: 'modal', icon: '☁️', label: T('', 'Modal'),             sub: T('', 'Card required — 4 stems') },
    ];
  }
  function renderBackendPicker() {
    const box = $('aistem-backend');
    if (!box) return;
    const cur = getBackend();
    box.innerHTML = `<div class="muted small" style="margin-bottom:4px">${T('', 'Choose backend:')}</div><div class="btn-row" id="aib-row"></div>`;
    const row = $('aib-row');
    backendDefs().forEach((d) => {
      const b = document.createElement('button');
      b.className = 'btn small' + (d.id === cur ? ' primary' : '');
      // .btn is inline-flex: stack label above sub-label so they never collide on one row
      b.style.cssText = 'flex-direction:column;align-items:flex-start;text-align:left;line-height:1.35;gap:2px';
      b.innerHTML = `<span>${d.icon} ${A.escapeHtml(d.label)}</span><span class="muted" style="font-size:11px">${A.escapeHtml(d.sub)}</span>`;
      b.addEventListener('click', () => { setBackend(d.id); render(); });
      row.appendChild(b);
    });
  }

  /* ============ DSP Beta tools section (on THIS screen, experimental) ============
     The 4 on-device DSP tools live here as a clearly-labelled section.
     "Run" jumps to the Stem Separator screen and auto-starts the engine —
     no logic is duplicated. */
  function renderDspSection() {
    const box = $('aistem-dsp');
    if (!box) return;
    box.innerHTML = `
      <div class="panel">
        <h4>✂️ DSP Beta Tools <span class="beta">BETA</span></h4>
        <p class="muted small">Instant, on-device, no server — but <b>experimental</b>.</p>
        <div id="aistem-dsp-grid"></div>
      </div>`;
    const grid = $('aistem-dsp-grid');
    RM.stems.ENGINES.forEach((e) => {
      const d = document.createElement('div');
      d.className = 'engine-card dsp-tool-card';
      d.innerHTML = `
        <div class="ec-name">${A.escapeHtml(e.name)} <span class="beta">BETA</span></div>
        <div class="ec-desc">${A.escapeHtml(e.desc)}</div>
        <div class="honest">⚗️ <b>Experimental (DSP) — not neural AI.</b> ${A.escapeHtml(e.note)}</div>
        <button class="btn small block" data-run="${e.id}">Run ${A.escapeHtml(e.name)}</button>`;
      d.querySelector('[data-run]').addEventListener('click', () => {
        A.show('stems');
        try { if (A.runStemEngine) A.runStemEngine(e.id); } catch (err) {}
      });
      grid.appendChild(d);
    });
  }

  /* ================= DSP Beta choice (default backend) ================= */
  function renderDspChoice() {
    $('aistem-setup').innerHTML = `
      <div class="panel">
        <h4>✂️ DSP Beta — instant, no server</h4>
        <p class="muted small">${T('', 'This is an on-device DSP technique — not neural AI. Results may have bleed. No upload, no server, no ad.')}</p>
        <button class="btn primary big block" id="ais-go-dsp-main">${T('', 'Open DSP Stem Separation')}</button>
      </div>`;
    $('ais-go-dsp-main').addEventListener('click', () => A.show('stems'));
  }

  /* ================= setup screen (Modal: no server configured) ================= */
  function renderSetup() {
    $('aistem-setup').innerHTML = `
      <div class="panel">
        <h4>☁️ Modal — AI Stem Separation</h4>
        <p class="muted small">⚠️ ${T('', 'This backend needs a card (Modal account). Without a card, use the FREE Hugging Face option.')}</p>
        <p>${T('', 'AI Stem Separation needs a server setup. This feature uses a neural AI model that runs on the server — it will not work without one.')}</p>
        <ol class="setup-steps">
          <li>${T('', 'Run your AI server (the one with the neural model).')}</li>
          <li>${T('', 'Copy the server URL and API Key.')}</li>
          <li>${T('', 'Paste them in Settings → AI Server and test the connection.')}</li>
        </ol>
        <button class="btn primary big block" id="ais-go-settings">${T('', 'Open Settings')}</button>
      </div>`;
    $('ais-go-settings').addEventListener('click', () => A.show('settings'));
  }

  /* ================= main screen ================= */
  function songOptions() {
    const opts = [];
    const vb = A.state.viewBuffer || A.state.buffer;
    if (vb) opts.push({ label: A.state.fileName || T('', 'Current project'), buffer: vb });
    (A.state.imports || []).forEach((it) => {
      if (it && it.buffer) opts.push({ label: it.name, buffer: it.buffer });
    });
    return opts;
  }

  function renderMain() {
    const box = $('aistem-main');
    const opts = songOptions();
    st.song = opts[0] || null;
    st.results = [];
    box.innerHTML = `
      <div class="panel">
        <h4>${T('', 'Select song')}</h4>
        <div id="ais-songs"></div>
        <div class="honest">🧠 ${T('', 'This is REAL neural AI separation — your audio will be processed on the server.')}</div>
        <button class="btn primary big block" id="ais-start">${T('', 'Separate Stems with AI')}</button>
      </div>
      <div id="ais-progress" style="display:none"></div>
      <div id="ais-fail" style="display:none"></div>
      <div id="ais-results"></div>`;
    const list = $('ais-songs');
    if (!opts.length) {
      list.innerHTML = `<div class="empty"><div class="empty-icon">🎵</div>${T('', 'No audio found — import first.')}</div>`;
      $('ais-start').disabled = true;
    }
    opts.forEach((o, i) => {
      const b = document.createElement('button');
      b.className = 'btn block listbtn' + (i === 0 ? ' primary' : '');
      b.innerHTML = `${A.escapeHtml(o.label)} <span class="muted small">• ${A.fmtTime(o.buffer.duration)}</span>`;
      b.addEventListener('click', () => {
        st.song = o;
        Array.prototype.forEach.call(list.children, (c, j) => c.classList.toggle('primary', j === i));
      });
      list.appendChild(b);
    });
    $('ais-start').addEventListener('click', startFlow);
  }

  function startFlow() {
    if (st.running) return;
    if (!st.song || !st.song.buffer) { A.toast(T('', 'Select a song first')); return; }
    const cfg = getCfg();
    if (!cfg) { render(); return; }
    if (st.consentGiven) { gateWithAd(cfg); return; }
    A.dialog('🧠 ' + T('', 'AI Stem Separation'),
      `<p>${A.escapeHtml(CONSENT_TEXT)}</p>` +
      `<p class="muted small">Server: <span class="mono">${A.escapeHtml(cfg.url)}</span></p>`,
      T('', 'I Agree'), T('', 'Decline')).then((ok) => {
      if (!ok) return;
      st.consentGiven = true;
      gateWithAd(cfg);
    });
  }

  /* ============ rewarded ad gate: 1 ad dekho, 1 gaana separate karo ============ */
  let adGateToken = 0;
  let adGating = false; // Round-6 (W2): double-tap race — gate pending ho to dobara ad mat kholo
  function gateWithAd(cfg) {
    if (adGating) return; // ad gate already pending
    adGating = true;
    const myToken = ++adGateToken;
    showProgress(0, T('', '🎬 Loading ad…'), true);
    RM.ads.showRewarded().then((earned) => {
      adGating = false; // gate resolved (myToken check se pehle)
      if (myToken !== adGateToken) return; // user ne cancel kiya tha
      if (earned) {
        uploadAndProcess(cfg);
      } else {
        hideProgress();
        // Ad fail/skip: separation NAHI chalegi — graceful message, retry ka option.
        const box = $('ais-fail');
        if (box) {
          box.style.display = '';
          box.innerHTML = `
            <div class="panel">
              <div class="err" style="margin-bottom:8px">⚠ ${A.escapeHtml(RM.ads.rewardedSkippedMessage())}</div>
              <div class="btn-row">
                <button class="btn primary" id="ais-retry">${T('', '🔁 Try again')}</button>
                <button class="btn" id="ais-go-dsp3">${T('', 'Try Beta (DSP)')}</button>
                <button class="btn ghost" id="ais-cancel">${T('', 'Cancel')}</button>
              </div>
            </div>`;
          $('ais-retry').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; gateWithAd(cfg); });
          $('ais-cancel').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; });
          const dsp = $('ais-go-dsp3');
          if (dsp) dsp.addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; A.show('stems'); });
        } else {
          A.toast(T('', 'Ad could not play — please try again'));
        }
      }
    });
  }

  /* ============ stored-ZIP parser (server ZIP_STORED bhejta hai) ============
     Sirf uncompressed entries — chhota, dependency-free parser. */
  function parseStoredZip(ab) {
    const dv = new DataView(ab);
    const u8 = new Uint8Array(ab);
    const n = ab.byteLength;
    const SIG_EOCD = 0x06054b50, SIG_CDIR = 0x02014b50, SIG_LOCAL = 0x04034b50;
    // EOCD dhoondo (aakhir se)
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 66000); i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP end marker not found');
    const count = dv.getUint16(eocd + 10, true);
    let cOff = dv.getUint32(eocd + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(cOff, true) !== SIG_CDIR) throw new Error('ZIP central directory is corrupt');
      const method = dv.getUint16(cOff + 10, true);
      const nameLen = dv.getUint16(cOff + 28, true);
      const extraLen = dv.getUint16(cOff + 30, true);
      const commentLen = dv.getUint16(cOff + 32, true);
      const localOff = dv.getUint32(cOff + 42, true);
      const name = dec.decode(u8.subarray(cOff + 46, cOff + 46 + nameLen));
      if (method !== 0) throw new Error('ZIP compressed entry is not supported');
      if (dv.getUint32(localOff, true) !== SIG_LOCAL) throw new Error('ZIP local header is corrupt');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const dataLen = dv.getUint32(cOff + 24, true);
      out.push({ name, data: ab.slice(dataStart, dataStart + dataLen) });
      cOff += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /* ================= upload (XHR with % progress) — SINGLE POST ================= */
  function uploadAndProcess(cfg) {
    // Drop previous AI results so repeated runs don't accumulate.
    for (let i = RM.stems.results.length - 1; i >= 0; i--) {
      if (RM.stems.results[i].engine === 'ai') RM.stems.results.splice(i, 1);
    }
    RM.stems.clearStemPack();
    let blob;
    try {
      blob = bufferToWavBlob(st.song.buffer);
    } catch (e) {
      return fail(T('', 'Could not prepare audio: ') + A.cleanErrMsg(e && e.message ? e.message : e), 'process');
    }
    if (st.song.buffer.duration > 600) {
      A.toast(T('', 'Large file — upload may take a while'));
    }
    st.running = true;
    const xhr = new XMLHttpRequest();
    st.xhr = xhr;
    xhr.open('POST', cfg.url + '/separate', true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 30 * 60 * 1000; // server 30 min tak le sakta hai
    if (cfg.key) xhr.setRequestHeader('X-API-Key', cfg.key);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        const p = e.loaded / e.total;
        showProgress(p, T('', 'Uploading') + ' ' + Math.round(p * 100) + '%', true);
      }
    };
    xhr.onload = () => {
      st.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        handleZipResponse(cfg, xhr.response);
      } else if (xhr.status === 401 || xhr.status === 403) {
        fail(T('', 'Processing failed — the API key is wrong or unauthorized. Check the key in Settings.'), 'process');
      } else if (xhr.status === 413) {
        fail(T('', 'Processing failed — file too large (max 200 MB).'), 'process');
      } else {
        fail(T('', 'Processing failed — server error ') + xhr.status + '.', 'process');
      }
    };
    xhr.onerror = () => {
      st.xhr = null;
      fail(T('', 'Cannot connect to the server. Check your internet connection or the server URL.'), 'connect');
    };
    xhr.ontimeout = () => {
      st.xhr = null;
      fail(T('', 'The server took too long (timeout). Try a shorter song or try again.'), 'connect');
    };
    xhr.onabort = () => { st.xhr = null; st.running = false; hideProgress(); };
    const fd = new FormData();
    fd.append('file', blob, safeName(st.song.label) + '.wav');
    // Upload khatm hote hi server-side processing shuru — animated status.
    xhr.upload.onload = () => {
      if (!st.running) return;
      startProcessingAnim();
    };
    showProgress(0, T('', 'Uploading…'), true);
    try { xhr.send(fd); }
    catch (e) {
      st.xhr = null;
      fail(T('', 'Cannot connect to the server.'), 'connect');
    }
  }

  /* Server 1-3 min process karta hai — % fake nahi dikhayenge, honest status. */
  let procAnimTimer = null;
  function startProcessingAnim() {
    stopProcessingAnim();
    const msgs = [
      T('', '🧠 AI processing on server…'),
      T('', '🧠 Separating stems… (may take 1-3 min)'),
      T('', '🧠 GPU is working, please wait…'),
    ];
    let i = 0, dots = 0;
    const tick = () => {
      if (!st.running) { stopProcessingAnim(); return; }
      dots = (dots + 1) % 4;
      showProgress(-1, msgs[i % msgs.length] + '.'.repeat(dots), true);
      i++;
    };
    tick();
    procAnimTimer = setInterval(tick, 2500);
  }
  function stopProcessingAnim() {
    if (procAnimTimer) { clearInterval(procAnimTimer); procAnimTimer = null; }
  }

  /* ================= ZIP -> 4 stems decode -> mixer ================= */
  function handleZipResponse(cfg, ab) {
    if (!st.running) return;
    let entries;
    try {
      entries = parseStoredZip(ab);
    } catch (e) {
      return fail(T('', 'Processing failed — could not read the server response.'), 'process');
    }
    const ctx = RM.audio.ensureCtx();
    const out = [];
    let i = 0;
    const step = () => {
      if (!st.running) return;
      if (i >= STEMS.length) { stopProcessingAnim(); finish(out); return; }
      const sm = STEMS[i];
      const entry = entries.find((e) => e.name.toLowerCase() === sm.id + '.wav');
      if (!entry) {
        stopProcessingAnim();
        return fail(T('', 'Processing failed — stem missing: ') + sm.name, 'process');
      }
      showProgress(-1, T('', 'Preparing stem') + ` ${i + 1}/${STEMS.length} (${sm.name})…`, true);
      new Promise((res, rej) => {
        try {
          const p = ctx.decodeAudioData(entry.data.slice(0), res, rej);
          if (p && typeof p.then === 'function') p.then(res, rej);
        } catch (e) { rej(e); }
      }).then((buf) => {
        out.push({ name: sm.name, buffer: buf, engine: 'ai', trackIdx: sm.trackIdx });
        i++;
        step();
      }).catch(() => {
        stopProcessingAnim();
        fail(T('', 'Processing failed — could not decode stem: ') + sm.name, 'process');
      });
    };
    step();
  }

  /* ================= done: results + mixer ================= */
  function finish(stems) {
    st.running = false;
    st.job = null;
    st.results = stems;
    // Make AI stems available wherever DSP stems are (mixer load menu, etc.)
    stems.forEach((s) => RM.stems.results.push({ name: s.name, buffer: s.buffer, engine: 'ai' }));
    // Part 2 bridge: register the 4-role pack so Auto Remix automatically
    // uses the stem-based pipeline (per-stem FX -> arrange -> mix -> master).
    try {
      const roleOf = (id) => (id === 'vocals' ? 'vocal' : id); // vocals->vocal; drums/bass/other as-is
      RM.stems.setStemPack({
        source: 'ai',
        roles: STEMS.map((sm, i) => ({
          role: roleOf(sm.id),
          label: sm.name,
          buffer: stems[i] ? stems[i].buffer : null,
        })),
      });
    } catch (e) { /* pack stays unavailable; classic preset flow continues */ }
    hideProgress();
    renderResults(stems);
    A.toast(T('', 'AI stems are ready ✓'));
  }

  function renderResults(stems) {
    const box = $('ais-results');
    box.innerHTML = '';
    const ok = document.createElement('div');
    ok.className = 'ok';
    ok.style.margin = '8px 0';
    ok.textContent = '✓ ' + T('', 'AI stems are ready') + ' — ' + stems.length;
    box.appendChild(ok);
    const deckBox = document.createElement('div');
    box.appendChild(deckBox);
    const roleOf = (nm) => {
      const low = String(nm || '').toLowerCase();
      if (low.indexOf('vocal') !== -1) return 'vocal';
      if (low.indexOf('drum') !== -1) return 'drums';
      if (low.indexOf('bass') !== -1) return 'bass';
      return 'other';
    };
    try {
      RM.stemDeck.render(deckBox, stems.map((s) => ({
        name: s.name, buffer: s.buffer, role: roleOf(s.name), badge: 'AI',
      })), {
        title: '🧠 4 neural AI stems — play, mix, or export each one',
        honest: '🧠 REAL neural AI separation (Demucs on your Modal server): Vocals, Drums, Bass, Other.',
      });
    } catch (e) {
      deckBox.innerHTML = '<div class="err">Could not display the stems.</div>';
    }
    const remixBtn = document.createElement('button');
    remixBtn.className = 'btn block';
    remixBtn.style.marginTop = '8px';
    remixBtn.textContent = '⚡ ' + T('', 'Use in Auto Remix (4-stem pipeline)');
    remixBtn.addEventListener('click', () => A.show('remix'));
    box.appendChild(remixBtn);
  }

  function stopAiPlayers() {
    st.players.forEach((p) => { try { p.stop(true); p.dispose(); } catch (e) {} });
    st.players = [];
  }

  /* ================= failure panel (never a generic crash) ================= */
  function fail(msg, kind) {
    st.running = false;
    st.job = null;
    stopProcessingAnim();
    hideProgress();
    const box = $('ais-fail');
    if (!box) return;
    box.style.display = '';
    const retryBtn = `<button class="btn primary" id="ais-retry">${T('', 'Retry')}</button>`;
    const cancelBtn = `<button class="btn ghost" id="ais-cancel">${T('', 'Cancel')}</button>`;
    let extra = '';
    if (kind === 'connect') {
      extra = `<button class="btn" id="ais-go-dsp2">${T('', 'Basic separation without server (Beta DSP)')}</button>`;
    } else {
      extra = `<button class="btn" id="ais-save-proj">${T('', 'Save Project')}</button>`;
    }
    box.innerHTML = `
      <div class="panel">
        <div class="err" style="margin-bottom:8px">⚠ ${A.escapeHtml(msg)}</div>
        <div class="btn-row">${retryBtn}${extra}${cancelBtn}</div>
        ${kind === 'connect'
          ? `<p class="muted small">${T('', 'The DSP option runs on-device — not neural AI, but it works without a server.')}</p>`
          : ''}
      </div>`;
    $('ais-retry').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; startFlow(); });
    $('ais-cancel').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; renderMain(); });
    if (kind === 'connect') {
      $('ais-go-dsp2').addEventListener('click', () => A.show('stems'));
    } else {
      $('ais-save-proj').addEventListener('click', saveProject);
    }
    // Error panel fixed bottom-nav ke peeche na chhupe
    try { box.scrollIntoView({ block: 'center' }); } catch (e) {}
  }

  function saveProject() {
    try {
      const p = A.state.project || RM.proj.create('AI Stem ' + (st.song ? st.song.label : ''));
      RM.proj.save(p);
      A.toast(T('', 'Project saved ✓'));
    } catch (e) {
      A.toast(T('', 'Could not save: ') + A.cleanErrMsg(e && e.message ? e.message : e));
    }
  }

  /* ================= progress / abort ================= */
  function showProgress(p, label, cancelable) {
    const box = $('ais-progress');
    if (!box) return;
    box.style.display = '';
    const indet = !(p >= 0);
    const pct = indet ? 0 : Math.max(0, Math.min(100, Math.round(p * 100)));
    // In-place update jab panel pehle se bana ho — har tick me innerHTML
    // dobara banane se cancel button replace hota rehta tha aur tez tap
    // miss ho sakta tha.
    const bar = box.querySelector('.pbar');
    const status = box.querySelector('.status');
    const cancelBtn = box.querySelector('#ais-cancel-up');
    if (bar && status && !!cancelBtn === !!cancelable) {
      bar.className = 'pbar' + (indet ? ' indet' : '');
      bar.style.width = pct + '%';
      status.textContent = label || '';
      return;
    }
    box.innerHTML = `
      <div class="panel">
        <div class="progress"><div class="pbar${indet ? ' indet' : ''}" style="width:${pct}%"></div></div>
        <div class="status">${A.escapeHtml(label || '')}</div>
        ${cancelable ? `<button class="btn ghost" id="ais-cancel-up">${T('', 'Cancel')}</button>` : ''}
      </div>`;
    if (cancelable) {
      const btn = $('ais-cancel-up');
      btn.addEventListener('click', () => abortAll(false));
      // Fixed bottom-nav ke peeche dab sakta hai — viewport center me lao
      try { btn.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
  }
  function hideProgress() {
    const b = $('ais-progress');
    if (b) { b.style.display = 'none'; b.innerHTML = ''; }
  }
  function abortAll(silent) {
    st.running = false;
    st.job = null;
    adGateToken++; // gate me atka ad-callback ab kuch nahi karega
    adGating = false; // gate cancel — dobara start ho sake
    if (st.xhr) { try { st.xhr.abort(); } catch (e) {} st.xhr = null; }
    stopProcessingAnim();
    stopAiPlayers();
    hideProgress();
    if (!silent) renderMain();
  }

  /* ================= settings: AI Server section ================= */
  function setAiStatus(kind, text) {
    const dot = $('ai-dot'), txt = $('ai-status-text');
    if (dot) dot.className = 'status-dot' + (kind ? ' ' + kind : '');
    if (txt) txt.textContent = text || '';
  }

  function testConnection() {
    const be = getBackend();
    if (be === 'hf') { testHfConnection(); return; }
    if (be === 'hf46') { testHf46Connection(); return; }
    if (be === 'dsp') {
      setAiStatus('', T('', '✂️ DSP Beta — no test needed'));
      const res = $('ai-test-result');
      if (res) res.innerHTML = '';
      return;
    }
    const urlIn = $('ai-url'), keyIn = $('ai-key');
    const url = (urlIn ? urlIn.value : '').trim().replace(/\/+$/, '');
    const key = keyIn ? keyIn.value : '';
    const res = $('ai-test-result');
    if (res) res.innerHTML = '';
    if (!url) {
      setAiStatus('err', T('', 'Enter the server URL first'));
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setAiStatus('err', T('', 'The URL must start with http(s)://'));
      return;
    }
    // NOTE: test se pehle save NAHI karte — galat URL/key save ho jata to
    // AI screen setup ki jagah toote hue server pe khulti. Sirf safal test par save.
    setAiStatus('', T('', 'Checking… (first check may take 30-60s for GPU cold start)'));
    const ctrl = new AbortController();
    const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 90000);
    fetch(url + '/health', {
      headers: key ? { 'X-API-Key': key } : {},
      signal: ctrl.signal,
    }).then((r) => {
      clearTimeout(to);
      if (r.status === 401 || r.status === 403) throw { auth: true };
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text(); // body shape is not critical; reachability + auth is
    }).then(() => {
      setCfg(url, key); // safal test par hi save
      setAiStatus('ok', T('', 'Server is reachable ✓'));
      if (res) res.innerHTML = `<div class="ok">${T('', 'Connection successful — AI Stem Separation is ready.')}</div>`;
    }).catch((e) => {
      clearTimeout(to);
      if (e && e.auth) {
        setAiStatus('err', T('', 'API key wrong or unauthorized'));
        if (res) res.innerHTML = `<div class="err">${T('', 'The API key is wrong or unauthorized. Check the key and try again.')}</div>`;
      } else {
        setAiStatus('err', T('', 'Cannot connect to the server'));
        if (res) res.innerHTML = `<div class="err">${T('', 'Cannot connect to the server. Check the URL and your internet connection.')}</div>`;
      }
    });
  }

  /* HF test: /gradio_api/info se API name verify hota hai (koi key nahi). */
  function testHfConnection() {
    if (!RM.hfStems) return;
    const urlEl = $('ai-hf-url'), apiEl = $('ai-hf-api');
    if (!urlEl || !apiEl) return; // settings HTML me HF fields nahi hain
    const url = urlEl.value.trim().replace(/\/+$/, '');
    const api = (apiEl.value.trim() || RM.hfStems.DEFAULT_API).replace(/^\/+/, '');
    const res = $('ai-test-result');
    if (res) res.innerHTML = '';
    if (!url) {
      setAiStatus('err', T('', 'Enter the Space URL first'));
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setAiStatus('err', T('', 'The URL must start with http(s)://'));
      return;
    }
    // NOTE: test se pehle save NAHI karte — galat URL save ho jata to AI
    // screen setup guide ki jagah toote hue Space pe khulti. Sirf safal test par save.
    setAiStatus('', T('', 'Checking… (a sleeping Space can take 1-2 min to wake)'));
    RM.hfStems.testSpace(url, api).then((r) => {
      RM.hfStems.setCfg(url, api); // safal test par hi save
      setAiStatus('ok', T('', 'Space reachable ✓ (API: /' + r.api + ')'));
      if (res) res.innerHTML = `<div class="ok">${T('', 'Connection successful — Hugging Face AI is ready. Outputs: ' + r.outputs + ' (Vocal + Instrumental).')}</div>`;
    }).catch((e) => {
      const kind = e && e.kind;
      if (kind === 'asleep') {
        setAiStatus('err', T('', 'Space is waking up — retry in 1-2 min'));
        if (res) res.innerHTML = `<div class="err">${T('', 'The Space is waking up. Wait 1-2 minutes and press "Test Connection" again.')}</div>`;
      } else if (kind === 'badapi') {
        const names = (e.found && e.found.length ? e.found.join(', ') : '—');
        setAiStatus('err', T('', 'Wrong API name'));
        if (res) res.innerHTML = `<div class="err">${T('', 'This API name was not found on the Space. Check the correct name via "View API" on the Space page. Found: ' + names)}</div>`;
      } else {
        setAiStatus('err', T('', 'Cannot reach the Space'));
        if (res) res.innerHTML = `<div class="err">${T('', 'Cannot reach the Space. Check the URL and your internet connection.')}</div>`;
      }
    });
  }

  /* HF 4/6-Stem test: endpoint verify + model saved. The model choice tells
     the app how many stems to expect and how to label them. */
  function testHf46Connection() {
    if (!RM.hfStems || !RM.hf46Stems) return;
    const urlEl = $('ai-hf46-url'), apiEl = $('ai-hf46-api'), modelEl = $('ai-hf46-model');
    if (!urlEl || !apiEl || !modelEl) return;
    const url = urlEl.value.trim().replace(/\/+$/, '');
    const api = (apiEl.value.trim() || RM.hfStems.DEFAULT_API).replace(/^\/+/, '');
    const model = RM.hf46Stems.MODELS[modelEl.value] ? modelEl.value : 'htdemucs';
    const res = $('ai-test-result');
    if (res) res.innerHTML = '';
    if (!url) { setAiStatus('err', T('', 'Enter the Space URL first')); return; }
    if (!/^https?:\/\//i.test(url)) {
      setAiStatus('err', T('', 'The URL must start with http(s)://'));
      return;
    }
    setAiStatus('', T('', 'Checking… (a sleeping Space can take 1-2 min to wake)'));
    RM.hfStems.testSpace(url, api).then((r) => {
      RM.hf46Stems.setCfg(url, api, model); // safal test par hi save
      const n = RM.hf46Stems.MODELS[model].order.length;
      setAiStatus('ok', T('', 'Space reachable ✓ (API: /' + r.api + ', ' + n + ' stems)'));
      if (res) res.innerHTML = `<div class="ok">${T('', 'Connection successful — expecting ' + n + ' stems (' + model + ').')}</div>`;
    }).catch((e) => {
      const kind = e && e.kind;
      if (kind === 'asleep') {
        setAiStatus('err', T('', 'Space is waking up — retry in 1-2 min'));
        if (res) res.innerHTML = `<div class="err">${T('', 'The Space is waking up. Wait 1-2 minutes and press "Test Connection" again.')}</div>`;
      } else if (kind === 'badapi') {
        const names = (e.found && e.found.length ? e.found.join(', ') : '—');
        setAiStatus('err', T('', 'Wrong API name'));
        if (res) res.innerHTML = `<div class="err">${T('', 'This API name was not found on the Space. Check the correct name via "View API" on the Space page. Found: ' + names)}</div>`;
      } else {
        setAiStatus('err', T('', 'Cannot reach the Space'));
        if (res) res.innerHTML = `<div class="err">${T('', 'Cannot reach the Space. Check the URL and your internet connection.')}</div>`;
      }
    });
  }

  function refreshSettingsInputs() {
    const be = getBackend();
    const hfF = $('ai-hf-fields'), moF = $('ai-modal-fields'), h46F = $('ai-hf46-fields');
    if (hfF) hfF.style.display = be === 'hf' ? '' : 'none';
    if (moF) moF.style.display = be === 'modal' ? '' : 'none';
    if (h46F) h46F.style.display = be === 'hf46' ? '' : 'none';
    if (be === 'hf46') {
      const urlIn = $('ai-hf46-url'), apiIn = $('ai-hf46-api'), modelIn = $('ai-hf46-model');
      if (!urlIn || !apiIn || !modelIn || !RM.hf46Stems) return;
      const cfg = RM.hf46Stems.getCfg();
      urlIn.value = cfg ? cfg.url : '';
      apiIn.value = cfg ? cfg.apiName : RM.hfStems.DEFAULT_API;
      modelIn.value = cfg ? cfg.model : 'htdemucs';
      setAiStatus('', cfg ? T('', 'Saved — test the connection') : T('', 'Not set'));
      return;
    }
    if (be === 'hf') {
      const urlIn = $('ai-hf-url'), apiIn = $('ai-hf-api');
      if (!urlIn || !apiIn || !RM.hfStems) return;
      const cfg = RM.hfStems.getCfg();
      urlIn.value = cfg ? cfg.url : '';
      apiIn.value = cfg ? cfg.apiName : RM.hfStems.DEFAULT_API;
      setAiStatus('', cfg
        ? T('', 'Saved — test the connection')
        : T('', 'Not set'));
    } else if (be === 'modal') {
      const urlIn = $('ai-url'), keyIn = $('ai-key');
      if (!urlIn || !keyIn) return;
      const cfg = getCfg();
      if (cfg) {
        urlIn.value = cfg.url;
        keyIn.value = cfg.key || '';
        setAiStatus('', T('', 'Saved — test the connection'));
      } else {
        setAiStatus('', T('', 'Not set'));
      }
    } else {
      setAiStatus('', T('', '✂️ DSP Beta — no settings needed'));
    }
  }

  function renderSettingsBackendPicker() {
    const box = $('ai-backend-picker');
    if (!box) return;
    const cur = getBackend();
    box.innerHTML = '';
    backendDefs().forEach((d) => {
      const b = document.createElement('button');
      b.className = 'btn small' + (d.id === cur ? ' primary' : '');
      // .btn is inline-flex: stack label above sub-label so they never collide on one row
      b.style.cssText = 'flex-direction:column;align-items:flex-start;text-align:left;line-height:1.35;gap:2px';
      b.innerHTML = `<span>${d.icon} ${A.escapeHtml(d.label)}</span><span class="muted" style="font-size:11px">${A.escapeHtml(d.sub)}</span>`;
      b.addEventListener('click', () => {
        setBackend(d.id);
        renderSettingsBackendPicker();
        refreshSettingsInputs();
      });
      box.appendChild(b);
    });
  }

  function saveSettings() {
    const be = getBackend();
    if (be === 'hf46') {
      if (!RM.hfStems || !RM.hf46Stems) return;
      const url = $('ai-hf46-url').value.trim().replace(/\/+$/, '');
      const api = ($('ai-hf46-api').value.trim() || RM.hfStems.DEFAULT_API).replace(/^\/+/, '');
      const model = $('ai-hf46-model').value;
      if (!url) { setAiStatus('err', T('', 'Enter the Space URL first')); return; }
      if (!/^https?:\/\//i.test(url)) {
        setAiStatus('err', T('', 'The URL must start with http(s)://'));
        return;
      }
      RM.hf46Stems.setCfg(url, api, model);
      setAiStatus('', T('', 'Saved ✓'));
      A.toast(T('', 'HF 4/6-Stem settings saved'));
      return;
    }
    if (be === 'hf') {
      if (!RM.hfStems) return;
      const url = $('ai-hf-url').value.trim().replace(/\/+$/, '');
      const api = ($('ai-hf-api').value.trim() || RM.hfStems.DEFAULT_API).replace(/^\/+/, '');
      if (!url) { setAiStatus('err', T('', 'Enter the Space URL first')); return; }
      if (!/^https?:\/\//i.test(url)) {
        setAiStatus('err', T('', 'The URL must start with http(s)://'));
        return;
      }
      RM.hfStems.setCfg(url, api);
      setAiStatus('', T('', 'Saved ✓'));
      A.toast(T('', 'Hugging Face settings saved'));
      return;
    }
    if (be === 'dsp') {
      A.toast(T('', 'Nothing to save for DSP Beta'));
      return;
    }
    const urlIn = $('ai-url'), keyIn = $('ai-key');
    const url = urlIn.value.trim().replace(/\/+$/, '');
    if (!url) { setAiStatus('err', T('', 'Enter the server URL first')); return; }
    if (!/^https?:\/\//i.test(url)) {
      setAiStatus('err', T('', 'The URL must start with http(s)://'));
      return;
    }
    setCfg(url, keyIn.value);
    setAiStatus('', T('', 'Saved ✓'));
    A.toast(T('', 'AI server settings saved'));
  }

  function initSettings() {
    const urlIn = $('ai-url'), keyIn = $('ai-key');
    if (!urlIn || !keyIn) return;
    renderSettingsBackendPicker();
    refreshSettingsInputs();
    $('ai-save').addEventListener('click', saveSettings);
    $('ai-test').addEventListener('click', testConnection);
  }

  /* ================= init ================= */
  function init() {
    A = RM.app;
    $ = A.$;
    const btn = $('btn-ai-stem');
    if (btn) btn.addEventListener('click', open);
    initSettings();
    // Keep the AI Server fields in sync whenever Settings is opened.
    try {
      const prevOnShow = A.onShow;
      A.onShow = (name) => {
        try { if (typeof prevOnShow === 'function') prevOnShow(name); } catch (e) {}
        if (name === 'settings') refreshSettingsInputs();
      };
    } catch (e) {}
  }

  return {
    init, open, getCfg, testConnection, getBackend, setBackend,
  };
})();

