'use strict';
/* =====================================================================
   RuhMix — mashup-stems.js  (Worker 4)
   Stem-engine provider for the "🤖 Auto Mashup" feature.

   Job: choose the best stem engine for the mashup and hand it to
   Worker 2's API via RM.mashup.setStemsProvider(fn).

   Provider signature:
     async (audioBuffer, want /* 'vocal'|'instrumental' *\/, onProgress)
       -> Promise<{ buffer, tag }>        tag: 'smart DSP' | 'neural stems'

   Engine choice:
     • NEURAL — only when the user configured their OWN HF Space
       (RM.hfStems.getCfg().url is non-empty) AND the hf-stems internals
       expose a clean, ad-free call path. The HF backend is FREE with NO
       rewarded-ad gate (verified in hf-stems.js header: the ad gate lives
       only in ai-stems.js for the Modal backend — never touched here).
       2 stems come back: Vocal + Instrumental (honest note, hf-stems.js).
       Per-song results are cached, so Song1-vocal and Song2-instrumental
       each separate exactly once.
     • DSP — default. RM.stems.run('vocalcut', …) splits Center (Vocal-ish)
       / Sides (Instrumental) on-device, instantly, offline.

   HONESTY RULE (hard): DSP output is NEVER labelled AI/neural. If the
   neural path fails at runtime the provider falls back to DSP and says
   so in the result tag: 'smart DSP (neural failed)'.

   hf-stems.js / ai-stems.js are READ-ONLY (another worker owns them) —
   this file only *reads* their public surface and re-implements the
   small stateless helpers (WAV encode, XHR upload, SSE wait) it needs.
   ===================================================================== */
window.RM = window.RM || {};

RM.mashupStems = (function () {
  const T = (hi, en) => en; // English-only build: language locked to English

  const ENGINE_DSP = 'smart DSP';
  const ENGINE_NEURAL = 'neural stems';
  const FALLBACK_NOTE = ' (neural failed)';

  const HF_DEFAULT_API = 'inference';
  const HF_SSE_TIMEOUT = 5 * 60 * 1000;
  const HF_UPLOAD_TIMEOUT = 2 * 60 * 1000;

  let engine = ENGINE_DSP;      // chosen engine for this session
  let engineReason = '';        // why this engine was chosen (debug/honesty)
  let registered = false;       // true once RM.mashup.setStemsProvider landed

  // v21 cooperative cancel: the mashup UI's Cancel button sets this flag;
  // the in-flight neural /call is aborted and the provider rethrows
  // {kind:'cancelled'} instead of silently falling back to DSP.
  let userCancelFlag = false;
  let activeCallCtrl = null;    // AbortController of the in-flight /call POST
  const NEURAL_CALL_TIMEOUT = 60 * 1000; // matches hf-stems CALL_TIMEOUT

  // v23 neural quota honesty (session-only): the shared public HF Space has
  // a daily ZeroGPU quota. Once a neural call fails with a quota signal,
  // later separations in THIS session skip neural entirely and go straight
  // to DSP (no wasted upload/wait). Never persisted — a fresh app load
  // starts with quotaExhausted === false again.
  let quotaExhausted = false;
  let quotaToastShown = false;  // the honest toast shows exactly once per session

  // Per-song neural cache — keyed on the AudioBuffer object identity, so
  // the mashup's Song1-vocal and Song2-instrumental each separate once.
  // WeakMap: buffers are released when the song is unloaded.
  const neuralCache = new WeakMap();

  /* ================= engine decision ================= */
  function hfCleanCall() {
    try {
      const I = RM.hfStems && RM.hfStems.internals;
      return !!(I &&
        typeof I.startCall === 'function' &&
        typeof I.fetchStemBuffer === 'function' &&
        typeof I.parseSSE === 'function');
    } catch (e) { return false; }
  }

  function hfCfg() {
    try {
      const c = RM.hfStems && RM.hfStems.getCfg ? RM.hfStems.getCfg() : null;
      if (c && typeof c.url === 'string' && c.url.trim()) return c;
    } catch (e) {}
    return null;
  }

  function decideEngine() {
    const cfg = hfCfg();
    if (cfg && hfCleanCall()) {
      engine = ENGINE_NEURAL;
      engineReason = 'user configured their own HF Space (' + cfg.url +
        ') — free, no ad gate; hf-stems internals give a clean call path';
    } else if (cfg && !hfCleanCall()) {
      engine = ENGINE_DSP;
      engineReason = 'HF Space is configured but the ad-free call path is unavailable — DSP default';
    } else {
      engine = ENGINE_DSP;
      engineReason = 'no HF Space configured (Settings → AI Server) — DSP default';
    }
    return engine;
  }

  function report(p, onProgress, msg) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(Math.max(0, Math.min(1, p)), msg || ''); } catch (e) {}
  }

  /* ================= DSP provider (always available) ================= */
  async function dspSeparate(buffer, want, onProgress) {
    // RM.stems.run('vocalcut') -> [{name:'Center (Vocal-ish)',…},
    //                             {name:'Sides (Instrumental)',…}]
    const stems = await RM.stems.run('vocalcut', buffer, (f) => report(f, onProgress, T('', 'Smart DSP separating…')));
    const wantVocal = want !== 'instrumental';
    const re = wantVocal ? /center/i : /sides/i;
    const list = Array.isArray(stems) ? stems : [];
    const hit = list.find((s) => re.test(String((s && s.name) || ''))) ||
      list[wantVocal ? 0 : 1];
    if (!hit || !hit.buffer || !hit.buffer.getChannelData) {
      throw new Error('DSP separation returned no usable stem');
    }
    return { buffer: hit.buffer, tag: ENGINE_DSP };
  }

  /* ================= HF neural helpers (self-contained) ================= */
  // WAV encoder — same 16-bit PCM layout as hf-stems' bufferToWavBlob
  // (kept local: that function is not on hf-stems' public surface).
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

  // Upload with % progress — mirrors hf-stems' uploadFile semantics
  // (uploadFile itself keeps module-local state, so it is not reusable).
  function uploadWav(spaceUrl, blob, filename, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', spaceUrl + '/gradio_api/upload', true);
      xhr.timeout = HF_UPLOAD_TIMEOUT;
      xhr.responseType = 'text';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) report(e.loaded / e.total, onProgress, '');
      };
      xhr.onload = () => {
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
      xhr.onerror = () => reject({ kind: 'connect' });
      xhr.ontimeout = () => reject({ kind: 'timeout' });
      xhr.onabort = () => reject({ kind: 'cancel' });
      const fd = new FormData();
      fd.append('files', blob, filename);
      try { xhr.send(fd); }
      catch (e) { reject({ kind: 'connect' }); }
    });
  }

  // SSE wait — single GET, parse with hf-stems' own parseSSE (public).
  async function sseWait(spaceUrl, api, eventId, onStatus) {
    const ctrl = new AbortController();
    const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, HF_SSE_TIMEOUT);
    try {
      const r = await fetch(spaceUrl + '/gradio_api/call/' + api + '/' + eventId, { signal: ctrl.signal });
      if (r.status === 503) throw { kind: 'asleep' };
      if (r.status === 429) throw { kind: 'quota' };
      if (r.status >= 500) throw { kind: 'server', status: r.status };
      if (!r.ok) throw { kind: 'connect', status: r.status };
      const text = await r.text();
      if (typeof onStatus === 'function') { try { onStatus(text); } catch (e) {} }
      return RM.hfStems.internals.parseSSE(text);
    } catch (e) {
      if (e && e.name === 'AbortError') throw { kind: 'timeout' };
      throw (e && e.kind) ? e : { kind: 'connect' };
    } finally {
      clearTimeout(to);
    }
  }

  // Full ad-free HF separation: WAV -> upload -> call -> SSE -> 2 stems.
  // Returns { vocal, instrumental } AudioBuffers. Throws {kind} on failure.
  async function separateNeural(buffer, onProgress) {
    const cached = neuralCache.get(buffer);
    if (cached && cached.vocal && cached.instrumental) {
      report(1, onProgress, T('', 'AI stems (cached) ✓'));
      return cached;
    }
    const cfg = hfCfg();
    if (!cfg) throw { kind: 'nocfg' };
    if (!hfCleanCall()) throw { kind: 'nopath' };
    const I = RM.hfStems.internals;
    const spaceUrl = String(cfg.url).replace(/\/+$/, '');
    const api = (String(cfg.apiName || HF_DEFAULT_API).replace(/^\/+/, '')) || HF_DEFAULT_API;

    report(0, onProgress, T('', 'Preparing audio…'));
    const blob = bufferToWavBlob(buffer);

    // 1. upload (0 → 0.2)
    report(0, onProgress, T('', 'Uploading to AI server…'));
    const srvPath = await uploadWav(spaceUrl, blob, 'mashup-song.wav',
      (f) => report(f * 0.2, onProgress, T('', 'Uploading') + ' ' + Math.round(f * 100) + '%'));

    // 2. call -> event_id (uses the PUBLIC internals entry — no ad gate,
    //    no consent dialog; HF is free per hf-stems.js header)
    report(0.22, onProgress, T('', '🧠 AI request sent…'));
    // v21: this POST had NO timeout — a hung server froze the whole mashup
    // with no escape. Bound it exactly like hf-stems' own runHf (60 s).
    const callCtrl = new AbortController();
    activeCallCtrl = callCtrl;
    const callTo = setTimeout(function () { try { callCtrl.abort(); } catch (e) {} }, NEURAL_CALL_TIMEOUT);
    let eventId;
    try {
      eventId = await I.startCall(spaceUrl, api, srvPath, callCtrl.signal);
    } catch (e) {
      if (userCancelFlag) throw { kind: 'cancelled' };
      if (e && e.kind === 'cancel') throw { kind: 'timeout' }; // our 60 s timer fired
      throw e;
    } finally {
      try { clearTimeout(callTo); } catch (e) {}
      if (activeCallCtrl === callCtrl) activeCallCtrl = null;
    }

    // 3. SSE wait (0.25 → 0.45)
    report(0.25, onProgress, T('', '🧠 AI is separating the stems… (~30-60 s)'));
    const out = await sseWait(spaceUrl, api, eventId,
      () => report(0.35, onProgress, T('', '🧠 AI is working…')));
    const files = (out.outputs || []).filter((f) => f && (f.path || f.url));
    if (files.length < 2) throw { kind: 'process' };

    // 4. download + decode. Honest order per hf-stems.js: outputs are
    //    "Vocals" then "No Vocals / Instrumental" — only 2 stems, no 4-stem claim.
    const ctx = RM.audio.ensureCtx();
    const vocal = await I.fetchStemBuffer(spaceUrl, files[0], ctx, null);
    report(0.7, onProgress, T('', 'Downloading stem 1/2…'));
    const instrumental = await I.fetchStemBuffer(spaceUrl, files[1], ctx, null);
    report(0.95, onProgress, T('', 'Downloading stem 2/2…'));
    if (!vocal || !instrumental || !vocal.length || !instrumental.length) {
      throw { kind: 'empty' };
    }
    const pair = { vocal: vocal, instrumental: instrumental };
    neuralCache.set(buffer, pair);
    report(1, onProgress, T('', 'AI stems ready ✓'));
    return pair;
  }

  /* ================= the provider ================= */
  // v23: quota signal detector. Internal failures are already normalized
  // to {kind:'quota'} for HTTP 429 on upload/SSE. Errors coming back from
  // hf-stems internals (startCall/fetchStemBuffer) or raw HTTP failures
  // may instead carry a status code or a free-text message, so we scan
  // those too: 429 / quota / rate-limit / daily-limit / usage-limit /
  // "too many requests". Anything else (500s, timeouts, offline) is NOT
  // quota — it stays a one-off failure and neural is retried next time.
  function isQuotaError(e) {
    if (!e) return false;
    if (e.kind === 'quota') return true;
    let msg = '';
    try {
      msg = String((e && e.message) || (e && e.msg) || '');
    } catch (x) {}
    let st = '';
    try {
      st = String((e && e.status) == null ? '' : e.status);
    } catch (x) {}
    return /\b429\b|quota|daily[\s_-]?limit|rate[\s_-]?limit|too many requests|usage[\s_-]?exceeded|limit[\s_-]?exceeded|credits?[\s_-]?exhausted/i
      .test(msg + ' ' + st);
  }

  // Defensive app toast (same pattern as mashup-export.js): never throws.
  function appToast(msg) {
    try {
      const A = window.RM && RM.app;
      if (A && typeof A.toast === 'function') A.toast(msg);
    } catch (e) {}
  }

  async function provider(audioBuffer, want, onProgress) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('mashupStems: valid AudioBuffer required');
    }
    const w = want === 'instrumental' ? 'instrumental' : 'vocal';

    // Neural engine: re-check config at call time so a removed Space
    // degrades gracefully instead of hard-failing mid-mashup.
    // v23: quotaExhausted skips neural entirely — no wasted upload/wait.
    if (!quotaExhausted && engine === ENGINE_NEURAL && hfCfg() && hfCleanCall()) {
      try {
        const pair = await separateNeural(audioBuffer, onProgress);
        return { buffer: pair[w], tag: ENGINE_NEURAL };
      } catch (e) {
        // v21: user pressed Cancel — stop the build, don't silently DSP-fallback.
        if (userCancelFlag || (e && e.kind === 'cancelled')) throw { kind: 'cancelled' };
        // v23: quota hit — remember for the rest of the session and tell
        // the user ONCE, honestly. (A cancel above rethrows, so a quota
        // check here can't misfire on a user cancel.)
        if (isQuotaError(e)) {
          quotaExhausted = true;
          if (!quotaToastShown) {
            quotaToastShown = true;
            appToast(T('', 'Neural quota finished for today — using Smart DSP (still good!)'));
          }
        }
        // Runtime fallback — honest tag: DSP is never sold as neural.
        try {
          const dsp = await dspSeparate(audioBuffer, w, onProgress);
          return { buffer: dsp.buffer, tag: ENGINE_DSP + FALLBACK_NOTE };
        } catch (e2) {
          throw e; // surface the original neural error if DSP also failed
        }
      }
    }
    return dspSeparate(audioBuffer, w, onProgress);
  }

  /* ================= public surface ================= */
  function engineTag() { return engine; }

  function describe() {
    if (engine === ENGINE_NEURAL) {
      return T('',
        'Neural stems from your free Hugging Face AI Space — 2 stems: Vocal + Instrumental, no ads.');
    }
    return T('',
      'Smart DSP separation on your phone — fast, offline, no AI; quality varies by song.');
  }

  // Re-run the engine decision (e.g. user just configured their HF Space
  // in Settings) and re-register if Worker 2's API is present.
  function refresh() {
    decideEngine();
    register();
    return engine;
  }

  function register() {
    try {
      if (RM.mashup && typeof RM.mashup.setStemsProvider === 'function') {
        RM.mashup.setStemsProvider(provider);
        registered = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  decideEngine();
  if (!register()) {
    // RM.mashup (Worker 2) hasn't landed yet — keep the provider handy and
    // retry registration briefly; the provider is also exposed below so it
    // can be picked up directly.
    let tries = 0;
    const iv = setInterval(() => {
      if (register() || ++tries > 60) clearInterval(iv); // ~30 s
    }, 500);
  }

  // Node unit tests (browser-harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { engineTag, describe, refresh, provider,
               quotaExhausted: () => quotaExhausted === true,
               requestCancel: () => { userCancelFlag = true; },
               clearCancel: () => { userCancelFlag = false; },
               isCancelRequested: () => userCancelFlag === true },
        internals: { bufferToWavBlob, decideEngine: () => engine, hfCfg, hfCleanCall },
      };
    }
  } catch (e) {}

  return {
    provider: provider,   // the fn registered via RM.mashup.setStemsProvider
    engineTag: engineTag, // 'smart DSP' | 'neural stems' — honest UI tag
    describe: describe,   // one-line honest description for the UI
    refresh: refresh,     // re-decide engine + re-register
    isRegistered: function () { return registered; },
    // v23 neural quota honesty (session-only, W2 checks this for the mega
    // mashup): true once a neural call failed with a quota signal; all
    // later separations then skip neural and go straight to DSP.
    quotaExhausted: function () { return quotaExhausted === true; },
    // v21 cooperative cancel (mashup UI Cancel button):
    requestCancel: function () {
      userCancelFlag = true;
      try { if (activeCallCtrl) activeCallCtrl.abort(); } catch (e) {}
    },
    clearCancel: function () { userCancelFlag = false; },
    isCancelRequested: function () { return userCancelFlag === true; },
  };
})();
