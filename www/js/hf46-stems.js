'use strict';
/* =====================================================================
   RuhMix — hf46-stems.js
   "HF 4/6-Stem" backend: Hugging Face Space separation with 4 or 6
   stems, from the USER'S OWN duplicated/deployed Space.

   HONESTY (verified 2026-10-05): no reliable free PUBLIC 4-stem or 6-stem
   Space was found — every candidate checked was down (runtime/build
   errors). So this backend does NOT pretend a public option exists: it
   is guide-only until the user pastes their own Space URL. The guide
   explains how to duplicate/deploy a Demucs Gradio Space and pick the
   model (htdemucs = 4 stems, htdemucs_6s = 6 stems).

   Canonical Demucs source order (facebookresearch/demucs release notes):
     htdemucs:    drums, bass, other, vocals
     htdemucs_6s: drums, bass, other, vocals, piano, guitar  (experimental)
   Output FILES are matched by name first (vocals.wav etc.); the order
   above is only the fallback. 6 is the maximum for standard open
   models — there is nothing bigger to offer, and the UI says so.

   Transport: raw Gradio HTTP API, same as hf-stems.js. Pure helpers
   (startCall, parseSSE, outputUrl, fetchStemBuffer, errToMessage) are
   reused from RM.hfStems.internals; upload + SSE-wait keep LOCAL state
   (never touch hf-stems' module state).

   Config localStorage 'rmx_ai_hf46' = { url, apiName, model } — no
   secrets. FREE, no ads.
   ===================================================================== */
window.RM = window.RM || {};

RM.hf46Stems = (function () {
  let A = null;
  let $ = null;
  const HI = () => false; // English-only build
  const T = (hi, en) => en;

  const LS_KEY = 'rmx_ai_hf46';
  const DEFAULT_API = 'inference';
  const SSE_TIMEOUT = 8 * 60 * 1000; // 6-stem is slower — 8 min
  const UPLOAD_TIMEOUT = 2 * 60 * 1000;
  const CALL_TIMEOUT = 60 * 1000;
  const DL_TIMEOUT_MS = 3 * 60 * 1000;

  const MODELS = {
    htdemucs: {
      id: 'htdemucs', label: 'htdemucs — 4 stems',
      honest: '4 stems: Vocals, Drums, Bass, Other',
      order: ['drums', 'bass', 'other', 'vocals'],
    },
    htdemucs_6s: {
      id: 'htdemucs_6s', label: 'htdemucs_6s — 6 stems',
      honest: '6 stems: Vocals, Drums, Bass, Other, Piano, Guitar. Slower — uses more of your free GPU quota.',
      order: ['drums', 'bass', 'other', 'vocals', 'piano', 'guitar'],
    },
  };
  const ROLE_INFO = {
    vocals: { role: 'vocal',  icon: '🎤', name: 'Vocals (HF)' },
    drums:  { role: 'drums',  icon: '🥁', name: 'Drums (HF)' },
    bass:   { role: 'bass',   icon: '🎸', name: 'Bass (HF)' },
    other:  { role: 'other',  icon: '🎵', name: 'Other (HF)' },
    piano:  { role: 'piano',  icon: '🎹', name: 'Piano (HF)' },
    guitar: { role: 'guitar', icon: '🎸', name: 'Guitar (HF)' },
  };

  const CONSENT_46 = 'Free AI separation on your own Hugging Face Space. 4-stem takes ~30-60 seconds; 6-stem takes ~1-3 minutes and uses more of your free GPU quota (daily limit ~6-10 songs). Your audio is processed on your Space and deleted as soon as processing finishes. No ads.';

  const st = {
    song: null, consentGiven: false, running: false,
    xhr: null, abort: null, setupEl: null, mainEl: null,
  };

  function H() { return RM.hfStems && RM.hfStems.internals; } // pure helpers

  /* ================= config ================= */
  function getCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (c && typeof c.url === 'string' && c.url.trim()) {
        const model = MODELS[c.model] ? c.model : 'htdemucs';
        return {
          url: c.url.trim().replace(/\/+$/, ''),
          apiName: (c.apiName || DEFAULT_API).trim().replace(/^\/+/, '') || DEFAULT_API,
          model,
        };
      }
    } catch (e) {}
    return null;
  }
  function setCfg(url, apiName, model) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        url, apiName: apiName || DEFAULT_API, model: MODELS[model] ? model : 'htdemucs',
      }));
    } catch (e) {}
  }

  /* ================= WAV encoder ================= */
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
    dv.setUint16(off, 1, true); off += 2;
    dv.setUint16(off, nCh, true); off += 2;
    dv.setUint32(off, sr, true); off += 4;
    dv.setUint32(off, sr * nCh * 2, true); off += 4;
    dv.setUint16(off, nCh * 2, true); off += 2;
    dv.setUint16(off, 16, true); off += 2;
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

  /* ================= entry / render ================= */
  function renderInto(setupEl, mainEl) {
    if (!A) { A = RM.app; $ = A.$; }
    st.setupEl = setupEl;
    st.mainEl = mainEl;
    abortAll(true);
    const cfg = getCfg();
    if (!cfg) {
      setupEl.style.display = ''; mainEl.style.display = 'none';
      renderSetup46();
    } else {
      setupEl.style.display = 'none'; mainEl.style.display = '';
      renderMain46(cfg);
    }
  }

  /* ================= setup guide (no Space configured) ================= */
  function renderSetup46() {
    st.setupEl.innerHTML = `
      <div class="panel">
        <h4>🤗 HF 4/6-Stem — Your Own Space</h4>
        <div class="honest">🔍 <b>Honest note:</b> no reliable free <b>public</b> 4-stem or 6-stem Space
        was found (every public one checked was down), so this backend uses
        <b>your own</b> Space — free, ~10 minutes of one-time setup, no card needed.</div>
        <ol class="setup-steps">
          <li>Create a free account on <b>huggingface.co</b> (no card needed).</li>
          <li>Duplicate a working <b>Demucs Gradio Space</b> (⋮ menu → "Duplicate" → hardware <b>ZeroGPU</b> → Public),
              <b>or</b> create a new Gradio Space from an open-source Demucs app
              (e.g. the <span class="mono">backtrack4drum</span> project on GitHub ships an <span class="mono">app.py</span> ready for Spaces and supports <span class="mono">htdemucs_6s</span>).</li>
          <li>If the Space offers a <b>model dropdown</b>, select <span class="mono">htdemucs</span> for 4 stems
              or <span class="mono">htdemucs_6s</span> for 6 stems (Drums, Bass, Other, Vocals, Piano, Guitar).</li>
          <li>Paste the Space URL in <b>Settings → AI Server</b> (backend: <b>HF 4/6-Stem</b>), pick the matching model, then <b>Test Connection</b>.</li>
          <li>⚠️ A new account must be <b>30 days old</b> to host on ZeroGPU — use an older account or wait it out.</li>
        </ol>
        <div class="honest">📐 The Space's Gradio API must be: <b>1 audio file in → N audio files out</b>
        (one per stem, e.g. <span class="mono">vocals.wav</span>, <span class="mono">drums.wav</span>…).
        "Test Connection" verifies the endpoint before anything is saved.<br>
        🐢 <b>6-Stem is slower</b> (bigger model) and uses more of your free GPU quota — daily limit ~6-10 songs.<br>
        🏁 <b>6 is the maximum</b> for standard open models — there is no 8-stem open model.</div>
        <button class="btn primary big block" id="hf46-go-settings">Open Settings</button>
      </div>
      <div class="divider"><span>or</span></div>
      <div class="panel">
        <h4>Need stems right now?</h4>
        <p class="muted small">The 2-stem Hugging Face backend works today with a simple duplicate.</p>
        <button class="btn block" id="hf46-go-hf2">🤗 Use HF 2-Stem (Vocals + Instrumental)</button>
      </div>`;
    $('hf46-go-settings').addEventListener('click', () => A.show('settings'));
    $('hf46-go-hf2').addEventListener('click', () => { RM.aiStems.setBackend('hf'); RM.aiStems.open(); });
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

  function renderMain46(cfg) {
    const box = st.mainEl;
    const opts = songOptions();
    const model = MODELS[cfg.model];
    const n = model.order.length;
    st.song = opts[0] || null;
    box.innerHTML = `
      <div class="panel">
        <h4>Select song</h4>
        <div id="ais46-songs"></div>
        <div class="honest">🤗 <b>${n}-stem AI</b> from <b>your Space</b> (<span class="mono">${escHtml(model.id)}</span>) — ${escHtml(model.honest)}.
        ${cfg.model === 'htdemucs_6s' ? '🐢 6-Stem is slower and uses more of your free GPU quota.' : ''}</div>
        <button class="btn primary big block" id="ais46-start">Separate ${n} Stems with AI</button>
      </div>
      <div id="ais46-progress" style="display:none"></div>
      <div id="ais46-fail" style="display:none"></div>
      <div id="ais46-results"></div>`;
    const list = $('ais46-songs');
    if (!opts.length) {
      list.innerHTML = '<div class="empty"><div class="empty-icon">🎵</div>No audio found — import first.</div>';
      $('ais46-start').disabled = true;
    }
    opts.forEach((o, i) => {
      const b = document.createElement('button');
      b.className = 'btn block listbtn' + (i === 0 ? ' primary' : '');
      b.innerHTML = `${escHtml(o.label)} <span class="muted small">• ${fmtTime(o.buffer.duration)}</span>`;
      b.addEventListener('click', () => {
        st.song = o;
        Array.prototype.forEach.call(list.children, (c, j) => c.classList.toggle('primary', j === i));
      });
      list.appendChild(b);
    });
    $('ais46-start').addEventListener('click', () => startFlow46(cfg));
  }
  function escHtml(s) { return A.escapeHtml(s); }
  function fmtTime(s) { return A.fmtTime(s); }

  function startFlow46(cfg) {
    if (st.running) return;
    if (!st.song || !st.song.buffer) { A.toast('Select a song first'); return; }
    if (st.consentGiven) { run46(cfg, false); return; }
    A.dialog('🤗 HF ' + MODELS[cfg.model].order.length + '-Stem Separation',
      '<p>' + escHtml(CONSENT_46) + '</p>' +
      '<p class="muted small">Space: <span class="mono">' + escHtml(cfg.url) + '</span></p>',
      'I Agree', 'Decline').then((ok) => {
      if (!ok) return;
      st.consentGiven = true;
      run46(cfg, false);
    });
  }

  /* ---- local stateful upload (XHR with %) ---- */
  function uploadFile(spaceUrl, blob, filename, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      st.xhr = xhr;
      xhr.open('POST', spaceUrl + '/gradio_api/upload', true);
      xhr.timeout = UPLOAD_TIMEOUT;
      xhr.responseType = 'text';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0 && typeof onProgress === 'function') onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        st.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const arr = JSON.parse(xhr.responseText);
            const first = Array.isArray(arr) ? arr[0] : null;
            const p = typeof first === 'string' ? first : (first && first.path);
            if (p) resolve(p); else reject({ kind: 'process' });
          } catch (e) { reject({ kind: 'process' }); }
        } else if (xhr.status === 503) reject({ kind: 'asleep' });
        else if (xhr.status === 429) reject({ kind: 'quota' });
        else if (xhr.status >= 500) reject({ kind: 'server', status: xhr.status });
        else reject({ kind: 'connect', status: xhr.status });
      };
      xhr.onerror = () => { st.xhr = null; reject({ kind: 'connect' }); };
      xhr.ontimeout = () => { st.xhr = null; reject({ kind: 'timeout' }); };
      xhr.onabort = () => { st.xhr = null; reject({ kind: 'cancel' }); };
      const fd = new FormData();
      fd.append('files', blob, filename);
      try { xhr.send(fd); }
      catch (e) { st.xhr = null; reject({ kind: 'connect' }); }
    });
  }

  /* ---- local SSE wait (single stream) ---- */
  async function waitResult(spaceUrl, api, eventId, onStatus) {
    const h = H();
    const ctrl = new AbortController();
    st.abort = ctrl;
    const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, SSE_TIMEOUT);
    try {
      const r = await fetch(spaceUrl + '/gradio_api/call/' + api + '/' + eventId, { signal: ctrl.signal });
      if (r.status === 503) throw { kind: 'asleep' };
      if (r.status === 429) throw { kind: 'quota' };
      if (r.status >= 500) throw { kind: 'server', status: r.status };
      if (!r.ok) throw { kind: 'connect', status: r.status };
      let text = '';
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        const seen = {};
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += dec.decode(chunk.value, { stream: true });
          const m = /event:\s*([a-z_]+)/g;
          let last = null, mm;
          while ((mm = m.exec(text)) !== null) last = mm[1];
          if (last && !seen[last]) {
            seen[last] = true;
            if (last === 'estimation' && typeof onStatus === 'function') onStatus('⏳ Queued on the server — please wait…');
            else if ((last === 'progress' || last === 'generating') && typeof onStatus === 'function') onStatus('🧠 AI is separating the stems…');
          }
        }
        text += dec.decode();
      } else {
        text = await r.text();
      }
      return h.parseSSE(text);
    } catch (e) {
      if (e && e.name === 'AbortError') throw { kind: 'timeout' };
      throw (e && e.kind) ? e : { kind: 'connect' };
    } finally {
      clearTimeout(to);
      st.abort = null;
    }
  }

  /* ================= flow: upload -> call -> SSE -> download ================= */
  async function run46(cfg, autoRetried) {
    const h = H();
    if (!h) { fail46('The HF engine failed to load. Restart the app and try again.', 'process'); return; }
    for (let i = RM.stems.results.length - 1; i >= 0; i--) {
      if (RM.stems.results[i].engine === 'hf46') RM.stems.results.splice(i, 1);
    }
    RM.stems.clearStemPack();
    let blob;
    try { blob = bufferToWavBlob(st.song.buffer); }
    catch (e) { return fail46('Could not prepare audio: ' + A.cleanErrMsg(e && e.message ? e.message : e), 'process'); }
    if (st.song.buffer.duration > 600) A.toast('Large file — upload may take a while');
    st.running = true;
    const spaceUrl = cfg.url.replace(/\/+$/, '');
    const api = (cfg.apiName || DEFAULT_API).replace(/^\/+/, '') || DEFAULT_API;
    const model = MODELS[cfg.model] || MODELS.htdemucs;
    const want = model.order.length;
    try {
      showProgress(0, 'Uploading…', true);
      const srvPath = await uploadFile(spaceUrl, blob, safeName(st.song.label) + '.wav', (p) => {
        if (st.running) showProgress(p, 'Uploading ' + Math.round(p * 100) + '%', true);
      });
      if (!st.running) return;
      showProgress(-1, '🧠 AI request sent…', true);
      const callCtrl = new AbortController();
      st.abort = callCtrl;
      const callTo = setTimeout(() => { try { callCtrl.abort(); } catch (e) {} }, CALL_TIMEOUT);
      let eventId;
      try { eventId = await h.startCall(spaceUrl, api, srvPath, callCtrl.signal); }
      finally { clearTimeout(callTo); if (st.abort === callCtrl) st.abort = null; }
      if (!st.running) return;
      showProgress(-1, '🧠 AI is processing… (' + want + '-stem, may take a few minutes)', true);
      const out = await waitResult(spaceUrl, api, eventId, (msg) => {
        if (st.running) showProgress(-1, msg, true);
      });
      if (!st.running) return;
      const files = (out.outputs || []).filter((f) => f && (f.path || f.url));
      if (!files.length) throw { kind: 'process' };
      // Match outputs to stems: filename first, canonical order as fallback.
      const ordered = matchOutputs(files, model.order);
      const ctx = RM.audio.ensureCtx();
      const stems = [];
      for (let i = 0; i < ordered.length; i++) {
        if (!st.running) return;
        const id = ordered[i].id;
        const info = ROLE_INFO[id];
        showProgress(-1, 'Downloading stem ' + (i + 1) + '/' + ordered.length + ' (' + info.name + ')…', true);
        const dlCtrl = new AbortController();
        st.abort = dlCtrl;
        let buf;
        try { buf = await h.fetchStemBuffer(spaceUrl, ordered[i].file, ctx, dlCtrl.signal); }
        finally { if (st.abort === dlCtrl) st.abort = null; }
        if (!st.running) return;
        stems.push({ id, name: info.name, role: info.role, buffer: buf, engine: 'hf46' });
      }
      if (!st.running) return;
      finish46(stems, model);
    } catch (e) {
      if (!st.running) return;
      if (e && e.kind === 'cancel') e = { kind: 'timeout' };
      if (!autoRetried && e && (e.kind === 'asleep' || e.kind === 'connect' || e.kind === 'server')) {
        showProgress(-1, e.kind === 'asleep' ? '🤗 Space is waking up… retrying' : '🔁 Retrying…', true);
        setTimeout(() => { if (st.running) run46(cfg, true); }, 5000);
        return;
      }
      fail46(h.errToMessage(e), e && e.kind);
    }
  }

  // Match each returned file to a stem id. Filename match wins
  // (e.g. "vocals.wav"); leftovers fill the canonical Demucs order.
  // Never invent stems: output count is capped at the model's order.
  function matchOutputs(files, order) {
    const used = new Array(files.length).fill(false);
    const base = (f) => {
      const p = (f && (f.orig_name || f.path || f.url)) || '';
      return String(p).split(/[\\/]/).pop().toLowerCase();
    };
    const out = [];
    order.forEach((id) => {
      let idx = -1;
      for (let i = 0; i < files.length; i++) {
        if (used[i]) continue;
        if (base(files[i]).indexOf(id) !== -1) { idx = i; break; }
      }
      if (idx === -1) {
        for (let i = 0; i < files.length; i++) { if (!used[i]) { idx = i; break; } }
      }
      if (idx !== -1) { used[idx] = true; out.push({ id, file: files[idx] }); }
    });
    return out;
  }

  /* ================= done ================= */
  function finish46(stems, model) {
    st.running = false;
    stems.forEach((s) => RM.stems.results.push({ name: s.name, buffer: s.buffer, engine: 'hf46' }));
    try {
      RM.stems.setStemPack({
        source: 'hf46',
        roles: stems.map((s) => ({ role: s.role, label: s.name, buffer: s.buffer })),
      });
      try { if (A.updateRemixStemBadge) A.updateRemixStemBadge(); } catch (e) {}
    } catch (e) { /* pack optional */ }
    hideProgress();
    renderResults46(stems, model);
    A.toast(model.order.length + '-stem AI results ready ✓');
  }

  function renderResults46(stems, model) {
    const box = $('ais46-results');
    box.innerHTML = '';
    const deckBox = document.createElement('div');
    box.appendChild(deckBox);
    const ok = document.createElement('div');
    ok.className = 'ok';
    ok.style.margin = '8px 0';
    ok.textContent = '✓ ' + stems.length + '-stem AI results ready (' + model.id + ')';
    box.insertBefore(ok, deckBox);
    try {
      RM.stemDeck.render(deckBox, stems.map((s) => ({
        name: s.name, buffer: s.buffer, role: s.role, badge: 'HF',
      })), {
        title: '🎤 ' + stems.length + ' stems — play, mix, or export each one',
        honest: '🤗 REAL neural AI from <b>your Space</b> (' + escHtml(model.id) + '): ' +
          escHtml(model.honest) + '. ' +
          (model.id === 'htdemucs_6s'
            ? 'The 6th-stem model is <b>experimental</b> — expect more bleed on guitar/piano.'
            : ''),
      });
    } catch (e) {
      deckBox.innerHTML = '<div class="err">Could not display the stems.</div>';
    }
  }

  /* ================= failure ================= */
  function fail46(msg, kind) {
    const h = H();
    st.running = false;
    hideProgress();
    const box = $('ais46-fail');
    if (!box) return;
    box.style.display = '';
    const retryable = ['connect', 'asleep', 'quota', 'timeout', 'server', 'empty', 'decode'].indexOf(kind) !== -1;
    box.innerHTML = `
      <div class="panel">
        <div class="err" style="margin-bottom:8px">⚠ ${escHtml(msg)}</div>
        <div class="btn-row">
          <button class="btn primary" id="ais46-retry">🔁 Try again</button>
          ${retryable ? '<button class="btn" id="ais46-go-dsp">✂️ Try DSP Beta (instant)</button>' : ''}
          <button class="btn ghost" id="ais46-cancel">Cancel</button>
        </div>
      </div>`;
    $('ais46-retry').addEventListener('click', () => {
      box.style.display = 'none'; box.innerHTML = '';
      const cfg = getCfg();
      if (cfg) startFlow46(cfg);
      else renderInto(st.setupEl, st.mainEl);
    });
    $('ais46-cancel').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; renderInto(st.setupEl, st.mainEl); });
    const dsp = $('ais46-go-dsp');
    if (dsp) dsp.addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; A.show('stems'); });
    try { box.scrollIntoView({ block: 'center' }); } catch (e) {}
  }

  /* ================= progress / abort ================= */
  function showProgress(p, label, cancelable) {
    const box = $('ais46-progress');
    if (!box) return;
    box.style.display = '';
    const indet = !(p >= 0);
    const pct = indet ? 0 : Math.max(0, Math.min(100, Math.round(p * 100)));
    const bar = box.querySelector('.pbar');
    const status = box.querySelector('.status');
    const cancelBtn = box.querySelector('#ais46-cancel-up');
    if (bar && status && !!cancelBtn === !!cancelable) {
      bar.className = 'pbar' + (indet ? ' indet' : '');
      bar.style.width = pct + '%';
      status.textContent = label || '';
      return;
    }
    box.innerHTML = `
      <div class="panel">
        <div class="progress"><div class="pbar${indet ? ' indet' : ''}" style="width:${pct}%"></div></div>
        <div class="status">${escHtml(label || '')}</div>
        ${cancelable ? '<button class="btn ghost" id="ais46-cancel-up">Cancel</button>' : ''}
      </div>`;
    if (cancelable) {
      $('ais46-cancel-up').addEventListener('click', () => abortAll(false));
    }
  }
  function hideProgress() {
    const b = $('ais46-progress');
    if (b) { b.style.display = 'none'; b.innerHTML = ''; }
  }
  function abortAll(silent) {
    if (!A && window.RM && RM.app) { A = RM.app; $ = A.$; }
    st.running = false;
    if (st.xhr) { try { st.xhr.abort(); } catch (e) {} st.xhr = null; }
    if (st.abort) { try { st.abort.abort(); } catch (e) {} st.abort = null; }
    hideProgress();
    if (!silent && st.mainEl) renderInto(st.setupEl, st.mainEl);
  }

  // Node unit tests (browser me harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { getCfg, setCfg, renderInto, abortAll, MODELS, ROLE_INFO },
        internals: { matchOutputs, bufferToWavBlob, safeName },
      };
    }
  } catch (e) {}

  return { getCfg, setCfg, renderInto, abortAll, MODELS };
})();
