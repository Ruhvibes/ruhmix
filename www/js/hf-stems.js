'use strict';
/* =====================================================================
   RuhMix — hf-stems.js
   Hugging Face Spaces backend (FREE, NO ad) for AI Stem Separation.

   RAW Gradio HTTP API — koi library nahi, sirf plain fetch()/XHR:
     1. POST {SPACE}/gradio_api/upload     multipart/form-data, field "files"
        -> ["/tmp/gradio/<hash>/song.mp3"]            (server-side paths)
     2. POST {SPACE}/gradio_api/call/<api>
        {"data":[{"path":srvPath,"meta":{"_type":"gradio.FileData"}}]}
        -> {"event_id":"..."}
     3. GET  {SPACE}/gradio_api/call/<api>/<event_id>   (SSE, ek hi stream —
        heartbeat-friendly, koi polling nahi; 5 min timeout; 1 auto-retry)
        -> "event: complete" block ke "data:" me output FileData list
     4. Har output download: {SPACE}/gradio_api/file=<server path>

   REAL /gradio_api/info se verified (2026-10-05, Space
   "abidlabs/music-separation"): named endpoint "/inference", input = 1
   audio file, outputs = 2 audio files — "Vocals" aur "No Vocals /
   Instrumental". ISLIYE HF se 2 stems milte hain (4 nahi) — UI ye baat
   honestly batata hai, "4 stems" ka daava kahin nahi.

   Config localStorage me 'rmx_ai_hf' ke andar { url, apiName } — koi
   secret/key nahi. Public Space pe bina auth ke chalta hai.
   Rewarded ad gate SIRF Modal backend ke liye hai — HF bilkul FREE, ad nahi.
   ===================================================================== */
window.RM = window.RM || {};

RM.hfStems = (function () {
  let A = null;
  let $ = null;
  const HI = () => false; // English-only build: language locked to English
  const T = (hi, en) => en; // English-only build

  const LS_KEY = 'rmx_ai_hf';
  const DEFAULT_API = 'inference';   // /gradio_api/info se verified
  const SSE_TIMEOUT = 5 * 60 * 1000; // 5 min
  const UPLOAD_TIMEOUT = 2 * 60 * 1000;
  const CALL_TIMEOUT = 60 * 1000;
  // NOTE: let hai (const nahi) taaki Node torture suite isko fast-forward karke
  // dead-download timeout verify kar sake — production me hamesha 3 min.
  let DL_TIMEOUT_MS = 3 * 60 * 1000; // per stem download; dead connection pe stuck spinner nahi

  // Consent text — consent dialog me verbatim dikhaya jata hai. The Space is
  // the USER's own duplicate (setup guide), so the text says "aapke Space".
  const CONSENT_HF = 'Free AI can take ~30-60 seconds, with a daily limit of ~6-10 songs. Your audio will be processed on your Hugging Face Space (free AI server); the file is deleted as soon as processing finishes. This option has no ads — completely free.';

  const st = {
    song: null,
    consentGiven: false,
    running: false,
    xhr: null,
    abort: null,
    players: [],
    results: [],
    setupEl: null,
    mainEl: null,
  };
  let runSeq = 0; // retry-race guard: har runHf apna token leta hai

  /* ================= config (localStorage only, no secrets) ================= */
  function getCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (c && typeof c.url === 'string' && c.url.trim()) {
        return {
          url: c.url.trim().replace(/\/+$/, ''),
          apiName: (c.apiName || DEFAULT_API).trim().replace(/^\/+/, '') || DEFAULT_API,
        };
      }
    } catch (e) {}
    return null;
  }
  function setCfg(url, apiName) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ url: url, apiName: apiName || DEFAULT_API })); } catch (e) {}
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

  /* ================= raw Gradio HTTP client ================= */

  // 1. upload -> server path (XHR taaki % progress mile)
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
        } else if (xhr.status === 503) {
          reject({ kind: 'asleep' });
        } else if (xhr.status === 429) {
          reject({ kind: 'quota' });
        } else if (xhr.status >= 500) {
          reject({ kind: 'server', status: xhr.status });
        } else {
          reject({ kind: 'connect', status: xhr.status });
        }
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

  // 2. call -> event_id
  async function startCall(spaceUrl, api, serverPath, signal) {
    let r;
    try {
      r = await fetch(spaceUrl + '/gradio_api/call/' + api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ path: serverPath, meta: { _type: 'gradio.FileData' } }] }),
        signal: signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { kind: 'cancel' };
      throw { kind: 'connect' };
    }
    if (r.status === 503) throw { kind: 'asleep' };
    if (r.status === 429) throw { kind: 'quota' };
    if (r.status >= 500) throw { kind: 'server', status: r.status };
    if (!r.ok) throw { kind: 'connect', status: r.status };
    const j = await r.json();
    if (!j || !j.event_id) throw { kind: 'process' };
    return j.event_id;
  }

  // 3. SSE stream parse — event: complete ke data: me output FileData list
  function parseSSE(text) {
    const blocks = String(text || '').split(/\n\n+/);
    let lastError = null;
    for (const b of blocks) {
      const lines = b.split('\n');
      let ev = '', data = '';
      for (const ln of lines) {
        if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
        else if (ln.indexOf('data:') === 0) data += (data ? '\n' : '') + ln.slice(5).trim();
        else if (data) data += '\n' + ln; // multiline data continuation
      }
      if (ev === 'error' || ev === 'unexpected_error') lastError = data || ev;
      if (ev === 'complete') {
        try {
          const arr = JSON.parse(data);
          return { outputs: arr };
        } catch (e) { throw { kind: 'process' }; }
      }
    }
    if (lastError) {
      const m = String(lastError).toLowerCase();
      if (m.indexOf('quota') >= 0 || m.indexOf('exceed') >= 0 || m.indexOf('limit') >= 0) {
        throw { kind: 'quota', raw: lastError };
      }
      throw { kind: 'process', raw: lastError };
    }
    throw { kind: 'process' };
  }

  // 3b. SSE GET — ek hi stream (heartbeat-friendly), progress status ke saath
  async function waitResult(spaceUrl, api, eventId, onStatus) {
    const ctrl = new AbortController();
    st.abort = ctrl;
    const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, SSE_TIMEOUT);
    try {
      const r = await fetch(spaceUrl + '/gradio_api/call/' + api + '/' + eventId, { signal: ctrl.signal });
      if (r.status === 503) throw { kind: 'asleep' };
      if (r.status === 429) throw { kind: 'quota' };
      if (r.status >= 500) throw { kind: 'server', status: r.status };
      if (!r.ok) throw { kind: 'connect', status: r.status };
      // Stream ko chunk-by-chunk padho taaki estimation/progress dikhe.
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
            if (last === 'estimation' && typeof onStatus === 'function') {
              onStatus(T('', '⏳ Queued on the server — please wait…'));
            } else if ((last === 'progress' || last === 'generating') && typeof onStatus === 'function') {
              onStatus(T('', '🧠 AI is separating the stems…'));
            }
          }
        }
        text += dec.decode();
      } else {
        text = await r.text();
      }
      return parseSSE(text);
    } catch (e) {
      if (e && e.name === 'AbortError') throw { kind: 'timeout' };
      throw (e && e.kind) ? e : { kind: 'connect' };
    } finally {
      clearTimeout(to);
      st.abort = null;
    }
  }

  // 4. output FileData -> download URL
  function outputUrl(spaceUrl, f) {
    if (!f) return null;
    if (f.url && /^https?:\/\//i.test(f.url)) return f.url;
    if (f.url && f.url.charAt(0) === '/') return spaceUrl + f.url;
    if (f.path) return spaceUrl + '/gradio_api/file=' + f.path;
    return null;
  }

  async function fetchStemBuffer(spaceUrl, f, ctx, signal) {
    const url = outputUrl(spaceUrl, f);
    if (!url) throw { kind: 'process' };
    // Apna AbortController: outer signal (user cancel) AUR andar ka DL timeout
    // dono isi ko abort karte hain — taaki cancel turant lage aur dead
    // connection pe download hamesha ke liye atka na rahe (stuck spinner).
    const ctrl = new AbortController();
    const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, DL_TIMEOUT_MS);
    const onOuterAbort = () => { try { ctrl.abort(); } catch (e) {} };
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    // 'cancel' = user ne cancel dabaya (outer signal aborted);
    // 'timeout' = andar ka DL timer fire hua.
    const abortedKind = () => ((signal && signal.aborted) ? 'cancel' : 'timeout');
    try {
      let r;
      try {
        r = await fetch(url, { signal: ctrl.signal });
      } catch (e) {
        if (e && e.name === 'AbortError') throw { kind: abortedKind() };
        throw { kind: 'connect' };
      }
      if (r.status === 503) throw { kind: 'asleep' };
      if (r.status === 429) throw { kind: 'quota' };
      if (r.status >= 500) throw { kind: 'server', status: r.status };
      if (!r.ok) throw { kind: 'connect', status: r.status };
      let ab;
      try {
        ab = await r.arrayBuffer(); // beech me network/cancel/timeout toot jaye to reject hota hai
      } catch (e) {
        if (e && e.name === 'AbortError') throw { kind: abortedKind() };
        throw { kind: 'connect' }; // aadha-downloaded data discard — corrupt stem nahi banta
      }
      if (!ab || ab.byteLength === 0) throw { kind: 'empty' }; // 0-byte stem
      let buf;
      try {
        buf = await new Promise((res, rej) => {
          try {
            const p = ctx.decodeAudioData(ab.slice(0), res, rej);
            if (p && typeof p.then === 'function') p.then(res, rej);
          } catch (e) { rej(e); }
        });
      } catch (e) {
        throw { kind: 'decode' }; // corrupt audio bytes
      }
      if (!buf || !buf.length) throw { kind: 'empty' };
      return buf;
    } finally {
      clearTimeout(to);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onOuterAbort);
    }
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
      renderSetupHf();
    } else {
      setupEl.style.display = 'none'; mainEl.style.display = '';
      renderMainHf();
    }
  }

  /* ================= setup guide (no Space configured) ================= */
  function renderSetupHf() {
    st.setupEl.innerHTML = `
      <div class="panel">
        <h4>🤗 Hugging Face — FREE AI Setup</h4>
        <p>${T('', 'Your own FREE AI server — no card needed:')}</p>
        <ol class="setup-steps">
          <li>${T('', 'Create a free account on <b>huggingface.co</b> (no card needed).')}</li>
          <li>${T('', 'Open the <b>abidlabs/music-separation</b> Space → <b>⋮ menu → "Duplicate"</b> → choose hardware <b>ZeroGPU</b> → keep visibility <b>Public</b>.')}</li>
          <li>${T('', 'Paste the URL you get (like <span class="mono">https://username-music-separation.hf.space</span>) into <b>Settings → AI Server</b>.')}</li>
          <li>⚠️ ${T('', '<b>Honest note:</b> a new account must be <b>30 days old</b> to host on ZeroGPU — wait it out or use an older account.')}</li>
        </ol>
        <button class="btn primary big block" id="hf-go-settings">${T('', 'Open Settings')}</button>
      </div>
      <div class="divider"><span>${T('', 'or')}</span></div>
      <div class="panel">
        <h4>${T('', 'Basic separation without server')} <span class="beta">Beta (DSP)</span></h4>
        <p class="muted small">${T('', 'On-device DSP technique — not neural AI, but works instantly.')}</p>
        <button class="btn block" id="hf-go-dsp">✂️ ${T('', 'Try DSP Beta (instant)')}</button>
      </div>`;
    $('hf-go-settings').addEventListener('click', () => A.show('settings'));
    $('hf-go-dsp').addEventListener('click', () => A.show('stems'));
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

  function renderMainHf() {
    const box = st.mainEl;
    const opts = songOptions();
    st.song = opts[0] || null;
    st.results = [];
    box.innerHTML = `
      <div class="panel">
        <h4>${T('', 'Select song')}</h4>
        <div id="ais-songs"></div>
        <div class="honest">🤗 ${T('', 'This is FREE AI separation — it may take ~30-60 seconds, with a daily limit of ~6-10 songs. No ads. You get 2 stems: Vocal + Instrumental.')}</div>
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
    $('ais-start').addEventListener('click', startFlowHf);
  }

  function startFlowHf() {
    if (st.running) return;
    if (!st.song || !st.song.buffer) { A.toast(T('', 'Select a song first')); return; }
    const cfg = getCfg();
    if (!cfg) { renderInto(st.setupEl, st.mainEl); return; }
    // NOTE: HF me koi rewarded ad nahi — free hai.
    if (st.consentGiven) { runHf(cfg, false); return; }
    A.dialog('🤗 ' + T('', 'Hugging Face AI Stem Separation'),
      `<p>${A.escapeHtml(CONSENT_HF)}</p>` +
      `<p class="muted small">Space: <span class="mono">${A.escapeHtml(cfg.url)}</span></p>`,
      T('', 'I Agree'), T('', 'Decline')).then((ok) => {
      if (!ok) return;
      st.consentGiven = true;
      runHf(cfg, false);
    });
  }

  /* ================= HF flow: upload -> call -> SSE -> download ================= */
  async function runHf(cfg, autoRetried) {
    const myRun = ++runSeq; // is run ka token (retry race guard)
    // Purane HF results hatao taaki repeat runs accumulate na hon.
    for (let i = RM.stems.results.length - 1; i >= 0; i--) {
      if (RM.stems.results[i].engine === 'hf') RM.stems.results.splice(i, 1);
    }
    RM.stems.clearStemPack();
    let blob;
    try {
      blob = bufferToWavBlob(st.song.buffer);
    } catch (e) {
      return failHf(T('', 'Could not prepare audio: ') + A.cleanErrMsg(e && e.message ? e.message : e), 'process');
    }
    if (st.song.buffer.duration > 600) {
      A.toast(T('', 'Large file — upload may take a while'));
    }
    st.running = true;
    const spaceUrl = cfg.url.replace(/\/+$/, '');
    const api = (cfg.apiName || DEFAULT_API).replace(/^\/+/, '') || DEFAULT_API;
    try {
      // 1. upload — cold-start (soya Space) pe response aane me 1-2 min lag
      // sakta hai; 20 s tak koi progress event na aaye to user ko batao
      // (dead 0%/100% bar nahi). Progress aate hi % wapas aa jayega.
      showProgress(0, T('', 'Uploading…'), true);
      const upT0 = Date.now();
      let upLastEv = upT0, upHinted = false;
      const upHintTo = setInterval(() => {
        if (!st.running || upHinted) { clearInterval(upHintTo); return; }
        if (Date.now() - upLastEv > 20000) {
          upHinted = true;
          showProgress(-1, T('', '⏳ Waiting for the server… (a sleeping Space can take 1-2 min to wake)'), true);
        }
      }, 5000);
      let srvPath;
      try {
        srvPath = await uploadFile(spaceUrl, blob, safeName(st.song.label) + '.wav', (p) => {
          upLastEv = Date.now();
          if (st.running) showProgress(p, T('', 'Uploading') + ' ' + Math.round(p * 100) + '%', true);
        });
      } finally {
        clearInterval(upHintTo);
      }
      if (!st.running) return;
      // 2. call
      showProgress(-1, T('', '🧠 AI request sent…'), true);
      const callCtrl = new AbortController();
      st.abort = callCtrl;
      const callTo = setTimeout(() => { try { callCtrl.abort(); } catch (e) {} }, CALL_TIMEOUT);
      let eventId;
      try {
        eventId = await startCall(spaceUrl, api, srvPath, callCtrl.signal);
      } finally {
        clearTimeout(callTo);
        if (st.abort === callCtrl) st.abort = null;
      }
      if (!st.running) return;
      // 3. SSE — server line/progress khud batata hai
      showProgress(-1, T('', '🧠 AI is processing… (~30-60 seconds)'), true);
      const out = await waitResult(spaceUrl, api, eventId, (msg) => {
        if (st.running) showProgress(-1, msg, true);
      });
      if (!st.running) return;
      const files = (out.outputs || []).filter((f) => f && (f.path || f.url));
      if (!files.length) throw { kind: 'process' };
      // 4. stems download + decode
      const ctx = RM.audio.ensureCtx();
      const stems = [];
      const labels = ['Vocal (HF)', 'Instrumental (HF)'];
      for (let i = 0; i < files.length; i++) {
        if (!st.running) return;
        showProgress(-1, T('', 'Downloading stem') + ` ${i + 1}/${files.length}…`, true);
        // Har download ka apna AbortController — cancel turant request maar de,
        // server pe orphan connection latki na rahe (st.abort via abortAll).
        const dlCtrl = new AbortController();
        st.abort = dlCtrl;
        let buf;
        try {
          buf = await fetchStemBuffer(spaceUrl, files[i], ctx, dlCtrl.signal);
        } finally {
          if (st.abort === dlCtrl) st.abort = null;
        }
        // Cancel race: download poora hone ke BAAD cancel daba to results
        // render mat karo — warna cancel ke baad bhi "taiyaar" dikhega.
        if (!st.running) return;
        stems.push({ name: labels[i] || (T('', 'Stem ') + (i + 1) + ' (HF)'), buffer: buf, engine: 'hf' });
      }
      if (!st.running) return;
      finishHf(stems);
    } catch (e) {
      // NOTE: abortAll() hamesha sabse pehle st.running=false karta hai —
      // isliye !st.running ka matlab pakka USER-cancel hai. startCall() ka
      // timeout-abort bhi AbortError deta hai ({kind:'cancel'}), lekin us
      // waqt st.running=true rehta hai: use 'timeout' me badlo, warna
      // progress spinner hamesha ke liye atka reh jayega.
      if (!st.running) return; // user ne cancel kiya
      if (e && e.kind === 'cancel') e = { kind: 'timeout' }; // /call step ka timeout-abort
      if (!autoRetried && e && (e.kind === 'asleep' || e.kind === 'connect' || e.kind === 'server')) {
        // 1 auto-retry — space jag raha ho to dusri baar lag jata hai.
        // 'asleep' pe user ko saaf batao ki server jag raha hai (dead spinner nahi).
        // Cancel button rakha hai taaki 5 s wait me user atka na rahe.
        // Race guard: beech me cancel + naya run shuru hua to purana timeout
        // dusra flow na chalaye (myRun token).
        showProgress(-1, e.kind === 'asleep'
          ? T('', '🤗 Space is waking up… retrying')
          : T('', '🔁 Retrying…'), true);
        const tok = myRun;
        setTimeout(() => { if (st.running && tok === runSeq) runHf(cfg, true); }, 5000);
        return;
      }
      failHf(errToMessage(e), e && e.kind);
    }
  }

  function errToMessage(e) {
    const kind = e && e.kind;
    if (kind === 'asleep') {
      return T('', 'The Space is waking up (first start can take 1-2 min). Please try again in a bit.');
    }
    if (kind === 'quota') {
      return T('', 'The free daily limit seems over (~6-10 songs/day). Try again tomorrow or duplicate your own Space.');
    }
    if (kind === 'timeout') {
      return T('', 'The response took too long (timeout). Try a shorter song or try again.');
    }
    if (kind === 'server') {
      return T('', 'The server returned an error' + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '. Please wait a bit and try again.');
    }
    if (kind === 'empty') {
      return T('', 'The server returned an empty stem (0 seconds of audio). Try again or use a shorter song.');
    }
    if (kind === 'decode') {
      return T('', 'Could not decode the stem audio. Please try again.');
    }
    if (kind === 'connect') {
      return T('', 'Cannot connect to the server. Check your internet and the Space URL.');
    }
    return T('', 'Something went wrong during AI processing. Please try again.');
  }

  /* ================= done: results + mixer ================= */
  function finishHf(stems) {
    st.running = false;
    st.results = stems;
    stems.forEach((s) => RM.stems.results.push({ name: s.name, buffer: s.buffer, engine: 'hf' }));
    // Round-6 (W7 Issue 9): HF ke 2 stems (Vocal + Instrumental) ko stem pack me
    // register karo taaki Auto Remix stem pipeline use kare — pehle silently
    // preset flow chalta tha. labels = ['Vocal (HF)', 'Instrumental (HF)'].
    try {
      RM.stems.setStemPack({
        source: 'hf',
        roles: stems.map((s, i) => ({ role: i === 0 ? 'vocal' : 'other', label: s.name, buffer: s.buffer })),
      });
      try { if (A.updateRemixStemBadge) A.updateRemixStemBadge(); } catch (e) {}
    } catch (e) { /* pack optional — preset flow fallback rehta hai */ }
    hideProgress();
    renderResultsHf(stems);
    A.toast(T('', 'HF stems are ready ✓'));
  }

  function renderResultsHf(stems) {
    const box = $('ais-results');
    box.innerHTML = '';
    const deckBox = document.createElement('div');
    box.appendChild(deckBox);
    try {
      RM.stemDeck.render(deckBox, stems.map((s, i) => ({
        name: s.name,
        buffer: s.buffer,
        role: i === 0 ? 'vocal' : 'other',
        badge: 'HF',
      })), {
        title: '✓ HF stems are ready — ' + stems.length,
        honest: '🤗 These are 2 stems — Vocal + Instrumental (everything this HF Space outputs). No 4-stem claim: this backend cannot separate drums, bass or other.',
      });
    } catch (e) {
      deckBox.innerHTML = '<div class="err">Could not display the stems.</div>';
    }
    const ok = document.createElement('div');
    ok.className = 'ok';
    ok.style.margin = '8px 0';
    ok.textContent = '✓ HF stems are ready — ' + stems.length;
    box.insertBefore(ok, deckBox);
  }

  function stopHfPlayers() {
    st.players.forEach((p) => { try { p.stop(true); p.dispose(); } catch (e) {} });
    st.players = [];
  }

  /* ================= failure panel ================= */
  function failHf(msg, kind) {
    st.running = false;
    stopHfPlayers();
    hideProgress();
    const box = $('ais-fail');
    if (!box) return;
    box.style.display = '';
    const retryBtn = `<button class="btn primary" id="ais-retry">${T('', '🔁 Try again')}</button>`;
    const cancelBtn = `<button class="btn ghost" id="ais-cancel">${T('', 'Cancel')}</button>`;
    const dspBtn = (kind === 'connect' || kind === 'asleep' || kind === 'quota' || kind === 'timeout' ||
      kind === 'server' || kind === 'empty' || kind === 'decode')
      ? `<button class="btn" id="ais-go-dsp2">✂️ ${T('', 'Try DSP Beta (instant)')}</button>`
      : '';
    box.innerHTML = `
      <div class="panel">
        <div class="err" style="margin-bottom:8px">⚠ ${A.escapeHtml(msg)}</div>
        <div class="btn-row">${retryBtn}${dspBtn}${cancelBtn}</div>
      </div>`;
    $('ais-retry').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; startFlowHf(); });
    $('ais-cancel').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; renderMainHf(); });
    const dsp = $('ais-go-dsp2');
    if (dsp) dsp.addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; A.show('stems'); });
    // Error panel fixed bottom-nav ke peeche na chhupe — user ko dikhai de
    try { box.scrollIntoView({ block: 'center' }); } catch (e) {}
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
    // miss ho sakta tha (button gayab → dobara bana → tap beech me).
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
      // Fixed bottom-nav (#bottomnav, z-index 50) ke peeche dab sakta hai —
      // pehli baar dikhe to viewport center me lao taaki tap ho sake.
      try { btn.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
  }
  function hideProgress() {
    const b = $('ais-progress');
    if (b) { b.style.display = 'none'; b.innerHTML = ''; }
  }
  function abortAll(silent) {
    if (!A && window.RM && RM.app) { A = RM.app; $ = A.$; } // render() se pehle bhi call ho sakta hai
    st.running = false;
    if (st.xhr) { try { st.xhr.abort(); } catch (e) {} st.xhr = null; }
    if (st.abort) { try { st.abort.abort(); } catch (e) {} st.abort = null; }
    stopHfPlayers();
    hideProgress();
    if (!silent && st.mainEl) renderMainHf();
  }

  /* ================= Settings test helper ================= */
  // Settings > AI Server "Test Connection" calls this for HF.
  function testSpace(spaceUrl, apiName) {
    const url = String(spaceUrl || '').trim().replace(/\/+$/, '');
    const api = (String(apiName || DEFAULT_API).trim().replace(/^\/+/, '')) || DEFAULT_API;
    const ctrl = new AbortController();
    const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 60000);
    return fetch(url + '/gradio_api/info', { signal: ctrl.signal }).then((r) => {
      clearTimeout(to);
      if (r.status === 503) throw { kind: 'asleep' };
      if (!r.ok) throw { kind: 'connect', status: r.status };
      return r.json();
    }).then((info) => {
      const eps = (info && info.named_endpoints) || {};
      const key = '/' + api;
      if (!eps[key]) {
        const names = Object.keys(eps);
        throw { kind: 'badapi', found: names };
      }
      const returns = eps[key].returns || [];
      return { ok: true, api: key, outputs: returns.length };
    }).catch((e) => {
      clearTimeout(to);
      if (e && e.name === 'AbortError') throw { kind: 'asleep' };
      throw (e && e.kind) ? e : { kind: 'connect' };
    });
  }

  // Node unit tests ke liye (browser me harmless): gradio client internals export.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { getCfg, setCfg, renderInto, abortAll, testSpace, DEFAULT_API },
        internals: {
          uploadFile, startCall, parseSSE, waitResult, outputUrl, fetchStemBuffer,
          errToMessage, CONSENT_HF,
          _test: {
            getDlTimeout: () => DL_TIMEOUT_MS,
            setDlTimeout: (ms) => { DL_TIMEOUT_MS = ms; },
          },
        },
      };
    }
  } catch (e) {}

  return {
    getCfg, setCfg, renderInto, abortAll, testSpace, DEFAULT_API,
    // Pure, stateless helpers reused by the HF 4/6-Stem backend
    // (hf46-stems.js). Stateful upload/SSE live here only.
    internals: { startCall, parseSSE, outputUrl, fetchStemBuffer, errToMessage },
  };
})();
