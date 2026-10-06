'use strict';
/* =====================================================================
   RuhMix — v25-stems-ui.js
   v25 Worker 7: Stem Separation UI + performance helpers.

   Module: RM.v25stems

   1. Stem preview panel (spec §4 — per separated song):
        renderPreviewPanel(container, songs)
          songs: [{ title, stems: [{ name, buffer, role?, engine? }], engineTag? }]
          Renders one panel per song; each stem row shows:
            Play preview, Solo, Mute, Volume slider, and an HONEST
            per-stem engine tag:
              "Neural"        — ONLY when the stem was actually produced by
                                the Hugging Face backend (engine === 'hf' or
                                engineTag() === 'neural stems').
              "Smart DSP (beta)" — everything else (on-device DSP engines).
          Never invents stems the backend did not return, and never claims
          "Neural" for DSP output.

   2. Performance (§22):
        chunkedProcess(items, worker, opts) — generic chunked loop that
          yields to the UI between slices (long renders stay responsive),
          reports progress, and honours a cancel token.
        cleanupTempBuffers(list) — releases temp buffers between stages.
        renderChunked(btn, bar, task) — one-tap wiring: progress bar +
          Cancel button around any chunked task, honours cancel where the
          engine allows (HF/AbortController + mashup-stems cancel flags).

   Browser-only for the panel; chunkedProcess/cleanupTempBuffers are
   pure and Node-testable (see the module.exports block at the bottom).
   ===================================================================== */
window.RM = window.RM || {};

RM.v25stems = (function () {
  /* ================= tiny utils ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  const ROLE_META = {
    vocal:    { icon: '🎤', label: 'Vocals' },
    vocals:   { icon: '🎤', label: 'Vocals' },
    instrumental: { icon: '🎼', label: 'Instrumental' },
    drums:    { icon: '🥁', label: 'Drums' },
    bass:     { icon: '🎸', label: 'Bass' },
    melody:   { icon: '🎹', label: 'Melody' },
    guitar:   { icon: '🎸', label: 'Guitar' },
    piano:    { icon: '🎹', label: 'Piano' },
    other:    { icon: '🎵', label: 'Other' },
  };
  function metaFor(role, name) {
    const m = ROLE_META[String(role || '').toLowerCase()];
    if (m) return m;
    return { icon: '🎵', label: name || String(role || 'Stem') };
  }

  /* ================= 1. honest engine tagging =================
     "Neural" ONLY when the HF backend actually produced the stem.
     Sources of truth in this codebase:
       - RM.stems.results items carry engine: 'hf' (hf-stems.js) or a DSP
         engine id ('vocalcut' / 'hpss' / 'bass' / 'spectral').
       - RM.mashupStems.engineTag() returns 'neural stems' | 'smart DSP'. */
  function isNeural(stem, songEngineTag) {
    const e = String((stem && stem.engine) || '').toLowerCase();
    if (e === 'hf' || e === 'neural' || e.indexOf('neural') >= 0) return true;
    const t = String(songEngineTag || '').toLowerCase();
    return t.indexOf('neural') >= 0;
  }
  function engineTagFor(stem, songEngineTag) {
    return isNeural(stem, songEngineTag)
      ? { text: 'Neural', cls: 'neural', honest: 'Separated by real neural AI (your Hugging Face Space).' }
      : { text: 'Smart DSP (beta)', cls: 'dsp', honest: 'On-device smart DSP (beta) — classical signal processing, some bleed possible. Not neural AI.' };
  }

  /* ================= 2. stem preview panel ================= */
  const panels = []; // active panels — stopAll() silences every one

  function renderPreviewPanel(container, songs, opts) {
    opts = opts || {};
    const list = (songs || []).filter((s) => s && s.stems && s.stems.length);
    // Dispose a previous panel living in this container.
    try {
      if (container && container._v25stemPanel) container._v25stemPanel.dispose();
    } catch (e) {}
    if (!container) return null;
    container.innerHTML = '';
    if (!list.length) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">🎵</div>No separated stems yet. Separate a song first.</div>';
      return null;
    }
    let ctx = null;
    try { ctx = RM.audio.ensureCtx(); } catch (e) {
      container.innerHTML = '<div class="err">Web Audio is not available on this device.</div>';
      return null;
    }

    const panel = {
      songs: [], playing: false, t0: 0, pos: 0, master: null,
      disposed: false, stop: null, dispose: null,
    };
    panels.push(panel);
    container._v25stemPanel = panel;

    panel.master = ctx.createGain();
    panel.master.gain.value = 1;
    // Guarded master chain (limiter), like stem-deck — never raw to DAC.
    try { panel.master.connect(RM.audio.masterIn()); }
    catch (e) { panel.master.connect(ctx.destination); }

    const head = document.createElement('div');
    head.className = 'v25-head';
    head.innerHTML = (opts.title ? `<div class="v25-title">${esc(opts.title)}</div>` : '') +
      '<div class="honest">Engine tags are honest: <b class="neural">Neural</b> appears only when your Hugging Face AI actually produced the stem. Everything else is <b class="dsp">Smart DSP (beta)</b> — on-device processing, not neural AI.</div>';
    container.appendChild(head);

    function anySolo() {
      return panel.songs.some((s) => s.rows.some((r) => r.solo));
    }
    function applyGate(r) {
      const audible = !r.mute && (!anySolo() || r.solo);
      try { r.gate.gain.setTargetAtTime(audible ? 1 : 0, ctx.currentTime, 0.015); } catch (e) {}
    }
    function refreshGates() { panel.songs.forEach((s) => s.rows.forEach(applyGate)); }
    function songNow() { return (ctx.currentTime - panel.t0) % 1e9; }

    function startRow(song, r) {
      if (r.playing || panel.disposed) return;
      const off = panel.playing ? songNow() % r.stem.buffer.duration : panel.pos % r.stem.buffer.duration;
      const src = ctx.createBufferSource();
      src.buffer = r.stem.buffer;
      src.loop = true;
      src.connect(r.vol);
      try { src.start(0, Math.max(0, off)); } catch (e) { try { src.start(0, 0); } catch (e2) {} }
      r.src = src;
      r.playing = true;
      if (!panel.playing) { panel.playing = true; panel.t0 = ctx.currentTime - panel.pos; }
      r.playBtn.textContent = '⏸';
      r.playBtn.classList.add('primary');
    }
    function pauseRow(r) {
      if (!r.playing) return;
      try { r.src.stop(0); } catch (e) {}
      try { r.src.disconnect(); } catch (e) {}
      r.src = null;
      r.playing = false;
      r.playBtn.textContent = '▶';
      r.playBtn.classList.remove('primary');
      if (!panel.songs.some((s) => s.rows.some((x) => x.playing))) panel.playing = false;
    }
    panel.stop = function () {
      panel.songs.forEach((s) => s.rows.forEach(pauseRow));
      panel.playing = false;
    };
    panel.dispose = function () {
      panel.disposed = true;
      panel.stop();
      panel.songs.forEach((s) => s.rows.forEach((r) => {
        try { r.vol.disconnect(); } catch (e) {}
        try { r.gate.disconnect(); } catch (e) {}
      }));
      try { panel.master.disconnect(); } catch (e) {}
      const i = panels.indexOf(panel);
      if (i >= 0) panels.splice(i, 1);
      if (container && container._v25stemPanel === panel) container._v25stemPanel = null;
    };

    /* ---- one section per song ---- */
    list.forEach((song) => {
      const sec = document.createElement('div');
      sec.className = 'panel v25-song';
      const secHead = document.createElement('div');
      secHead.className = 'v25-song-head';
      const neural = isNeural(null, song.engineTag);
      secHead.innerHTML = `
        <div class="v25-song-title">🎵 ${esc(song.title || 'Song')}</div>
        <div class="honest small">${neural
          ? '🧠 Separated by <b class="neural">Neural</b> AI (Hugging Face).'
          : '⚗️ Separated by <b class="dsp">Smart DSP (beta)</b> — on-device, not neural AI.'}</div>`;
      sec.appendChild(secHead);

      const rowsEl = document.createElement('div');
      rowsEl.className = 'v25-rows';
      sec.appendChild(rowsEl);

      const songState = { song: song, rows: [] };
      const stems = song.stems.filter((s) => s && s.buffer);

      stems.forEach((s) => {
        const m = metaFor(s.role, s.name);
        const tag = engineTagFor(s, song.engineTag);
        const row = document.createElement('div');
        row.className = 'v25-row';
        row.innerHTML = `
          <div class="v25-row-head">
            <span class="v25-ic">${m.icon}</span>
            <div class="v25-row-titles">
              <div class="v25-name">${esc(s.name || m.label)}</div>
              <div class="muted small">${fmtTime(s.buffer.duration)} • <span class="engine-tag ${tag.cls}" title="${esc(tag.honest)}">${esc(tag.text)}</span></div>
            </div>
          </div>
          <div class="v25-transport">
            <button class="btn small v25-play" title="Preview this stem">▶</button>
            <button class="btn small tog v25-mute" title="Mute">M</button>
            <button class="btn small tog v25-solo" title="Solo">S</button>
          </div>
          <div class="v25-volrow"><label>Vol</label><input type="range" class="v25-vol" min="0" max="120" value="100"><span class="v25-volv">100%</span></div>`;
        rowsEl.appendChild(row);

        const r = {
          stem: s, vol: null, gate: null, src: null,
          playing: false, mute: false, solo: false,
          playBtn: row.querySelector('.v25-play'),
        };
        r.vol = ctx.createGain(); r.vol.gain.value = 1;
        r.gate = ctx.createGain(); r.gate.gain.value = 1;
        r.vol.connect(r.gate);
        r.gate.connect(panel.master);

        r.playBtn.addEventListener('click', () => {
          if (r.playing) { pauseRow(r); return; }
          try { if (window.RM && RM.app && RM.app.stopAll) RM.app.stopAll(); } catch (e) {}
          try { if (RM.stemDeck && RM.stemDeck.stopAllDecks) RM.stemDeck.stopAllDecks(); } catch (e) {}
          panels.forEach((p) => { if (p !== panel) { try { p.stop(); } catch (e2) {} } });
          startRow(song, r);
        });
        const muteBtn = row.querySelector('.v25-mute');
        muteBtn.addEventListener('click', () => {
          r.mute = !r.mute;
          muteBtn.classList.toggle('on', r.mute);
          refreshGates();
        });
        const soloBtn = row.querySelector('.v25-solo');
        soloBtn.addEventListener('click', () => {
          r.solo = !r.solo;
          soloBtn.classList.toggle('on', r.solo);
          refreshGates();
        });
        const volIn = row.querySelector('.v25-vol');
        const volV = row.querySelector('.v25-volv');
        volIn.addEventListener('input', () => {
          const v = (+volIn.value) / 100;
          volV.textContent = volIn.value + '%';
          try { r.vol.gain.setTargetAtTime(v, ctx.currentTime, 0.02); } catch (e) {}
        });
        songState.rows.push(r);
      });
      panel.songs.push(songState);
      container.appendChild(sec);
    });

    return panel;
  }

  function stopAllPanels() {
    panels.slice().forEach((p) => { try { p.stop(); } catch (e) {} });
  }

  /* ================= 3. performance helpers (§22) ================= */
  // Yield to the UI thread so long renders don't freeze the app.
  // requestAnimationFrame when available (smooth), setTimeout fallback
  // (Node / headless contexts have no rAF).
  function yieldToUI() {
    return new Promise((resolve) => {
      try {
        if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(resolve); return; }
      } catch (e) {}
      setTimeout(resolve, 0);
    });
  }

  // chunkedProcess(items, worker, opts) -> Promise<{ results, cancelled }>
  //   items: array (processed in index slices)
  //   worker(item, index, cancel) -> result | Promise<result>  (per item)
  //   opts: { chunkSize (default 64), onProgress(done, total), cancel }
  //     cancel: optional token { cancelled: bool } or function -> bool.
  // Yields to the UI after every chunk; stops early on cancel.
  async function chunkedProcess(items, worker, opts) {
    opts = opts || {};
    const arr = items || [];
    const chunkSize = Math.max(1, opts.chunkSize | 0 || 64);
    const cancel = opts.cancel;
    const onProgress = opts.onProgress;
    const results = [];
    const isCancelled = () => {
      try {
        if (!cancel) return false;
        if (typeof cancel === 'function') return !!cancel();
        return !!cancel.cancelled;
      } catch (e) { return false; }
    };
    for (let i = 0; i < arr.length; i += chunkSize) {
      if (isCancelled()) return { results: results, cancelled: true };
      const end = Math.min(arr.length, i + chunkSize);
      for (let j = i; j < end; j++) {
        if (isCancelled()) return { results: results, cancelled: true };
        try {
          const r = await worker(arr[j], j, isCancelled);
          results.push(r);
        } catch (e) {
          results.push({ __error: e });
        }
      }
      if (typeof onProgress === 'function') {
        try { onProgress(Math.min(end, arr.length), arr.length); } catch (e) {}
      }
      // Yield between chunks so the UI (progress bar, Cancel button)
      // stays alive during long renders. No yield after the final chunk.
      if (end < arr.length) await yieldToUI();
    }
    return { results: results, cancelled: isCancelled() };
  }

  // cleanupTempBuffers(list) — free temp buffers between processing stages.
  // Handles: AudioBuffer-like objects (close() if provided), Float32Array
  // chunks, node graphs (disconnect()), and plain {dispose()} handles.
  // Returns the number of buffers released. Defensive: never throws.
  function cleanupTempBuffers(list) {
    let freed = 0;
    (list || []).forEach((b) => {
      try {
        if (!b) return;
        if (typeof b.close === 'function') { try { b.close(); } catch (e) {} freed++; return; }
        if (typeof b.dispose === 'function') { try { b.dispose(); } catch (e) {} freed++; return; }
        if (typeof b.disconnect === 'function') { try { b.disconnect(); } catch (e) {} freed++; return; }
        // Raw typed-array / plain-object chunk: nothing to call — drop the
        // reference so GC can reclaim it.
        if (b.constructor && /Array/.test(b.constructor.name)) { freed++; return; }
        freed++;
      } catch (e) {}
    });
    return freed;
  }

  // renderChunked(task, ui) — one-tap wiring of a long chunked render:
  //   task: async (cancelToken, progress) => result
  //   ui: { button, bar, label, onDone(result), onCancel() }
  // Wires: disable button, live progress bar, Cancel button; cancel token
  // is honored by chunkedProcess above and can be forwarded to engines
  // that support it (HF abort, mashup-stems requestCancel).
  function renderChunked(task, ui) {
    ui = ui || {};
    const btn = ui.button;
    const bar = ui.bar;
    const label = ui.label;
    const cancelToken = { cancelled: false };
    function setP(f, msg) {
      const pct = Math.max(0, Math.min(1, f || 0));
      if (bar) { try { bar.style.width = (pct * 100).toFixed(1) + '%'; } catch (e) {} }
      if (label && msg != null) { try { label.textContent = String(msg); } catch (e) {} }
    }
    function finish(ok, msg) {
      if (btn) { try { btn.disabled = false; } catch (e) {} }
      if (ui.cancelBtn) { try { ui.cancelBtn.style.display = 'none'; } catch (e) {} }
      if (msg && label) { try { label.textContent = msg; } catch (e) {} }
    }
    if (btn) { try { btn.disabled = true; } catch (e) {} }
    setP(0, ui.startMsg || 'Rendering…');
    if (ui.cancelBtn) {
      try {
        ui.cancelBtn.style.display = '';
        ui.cancelBtn.onclick = () => {
          cancelToken.cancelled = true;
          // Forward to engines that support cancel (§22 cancel wiring):
          try { if (RM.mashupStems && RM.mashupStems.requestCancel) RM.mashupStems.requestCancel(); } catch (e) {}
          try { if (RM.hfStems && RM.hfStems.cancel) RM.hfStems.cancel(); } catch (e) {}
          setP(1, 'Cancelling…');
        };
      } catch (e) {}
    }
    Promise.resolve()
      .then(() => task(cancelToken, (f, total) => setP(f, ui.progressMsg ? ui.progressMsg(f, total) : null)))
      .then(
        (res) => { finish(true, ui.doneMsg || '✓ Done'); if (typeof ui.onDone === 'function') ui.onDone(res); },
        (err) => {
          finish(false, cancelToken.cancelled ? 'Cancelled.' : 'Error: ' + (err && err.message ? err.message : err));
          if (typeof ui.onError === 'function') ui.onError(err);
        }
      );
    return cancelToken;
  }

  // Node unit tests (browser-harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { renderPreviewPanel, stopAllPanels, chunkedProcess,
               cleanupTempBuffers, renderChunked, engineTagFor, isNeural, metaFor },
        internals: { yieldToUI, esc, fmtTime },
      };
    }
  } catch (e) {}

  return {
    renderPreviewPanel: renderPreviewPanel,
    stopAllPanels: stopAllPanels,
    chunkedProcess: chunkedProcess,
    cleanupTempBuffers: cleanupTempBuffers,
    renderChunked: renderChunked,
    engineTagFor: engineTagFor,
    isNeural: isNeural,
  };
})();
