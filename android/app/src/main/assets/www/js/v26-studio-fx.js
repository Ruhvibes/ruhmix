'use strict';
/* =====================================================================
   RuhMix — v26-studio-fx.js (Worker I3, v26)
   "Studio FX": Master BPM, Pitch, Volume-automation lane, Junction
   transitions — all REAL on-device Smart DSP, all undoable.

   OWNERSHIP (v26 worker map)
   - This file owns: NEW file www/js/v26-studio-fx.js (all UI + logic),
     the #v26-fxpanel container (appended into the Studio screen at
     runtime by init()), a ≤10-line bridge in v25-studio.js
     (RM.v25studio.fxApi) + a 1-line init hook in wire(), and a script
     tag in www/index.html.
   - READ-ONLY deps (never edited): v25-mixmaster.js
       buildTransition (10 real transition builders),
       buildAutomationCurve / applyAutomation (real per-sample curves),
     mashup-dsp.js: timeStretch (WSOLA), pitchShift (tempo-preserving).
   - Does NOT touch version fields.

   Bridge contract (v25-studio.js fxApi):
     cur() -> st.current | bpm() -> st.bpm | secs() -> st.sections
     auto()/setAuto(p) -> st.automation (the project model for points)
     apply(nb, opts) -> replace st.current; opts: {bpm, sections[lens],
                        rescale, automation}; re-renders waveform/markers
     busy(v?) | refresh() | toast(m)

   UNDO INTEGRATION (final design — see worker notes)
   - This panel keeps its own command stack (undoStack/redoStack, cap 8)
     with ABSOLUTE snapshots {buf, bpm, lens[], automation}, so undo/redo
     always restores an exact state and is safe to run twice. Redo is
     supported for this panel's own ops.
   - Shared v26 convention (first-wins, signature matches I6/v26-vocal.js
     which adopts it when present, else publishes its own):
         __v26pushUndo(label, undoFn) — push an undoable op
         __v26undo() — pop & run the latest undo
     v26-studio-fx.js loads BEFORE v26-vocal.js, so this file publishes
     the shared pair at eval (only when absent). I6's vocal-chain ops
     then land in this stack too — one shared undo history for the v26
     workers, undoable from either worker's Undo button. Entries pushed
     by other workers carry no redo fn (their redo is unavailable here).
   - I2's Studio undo stack (st.undo, v25-studio.js) is separate and
     internal to v25 — it covers v25's own section edits, not FX ops.
   - RM.v26fx.lastOp always mirrors this panel's most recent op.

   HONESTY
   - Master BPM: WSOLA time-stretch, pitch preserved; ratio clamped to
     0.5–2.0 by the engine, so the target BPM is clamped to ±2x and the
     UI says so.
   - Pitch: engine clamps to ±6 semitones effective; the slider goes to
     ±12 but values beyond ±6 are clamped with an on-screen note.
   - Automation: evaluated through the REAL buildAutomationCurve /
     applyAutomation (≤3 dB/bar slew — changes are gradual, never jumps).
   - Transitions: the REAL buildTransition builders, applied at the
     selected junction over the window [B-N, B) ending AT the boundary,
     beat-synced from the CURRENT master BPM (st.bpm).
   - Everything mutates st.current via the bridge, so preview (A/B "B")
     and export (sendToExport(st.current)) both carry the edits.
   ===================================================================== */
var __rmRoot = typeof window !== 'undefined' ? window
  : (typeof global !== 'undefined' ? global : {});
__rmRoot.RM = __rmRoot.RM || {};

(function () {
  var RM = __rmRoot.RM;
  var hasDoc = (typeof document !== 'undefined');

  function clamp(v, a, b) { v = +v; if (!isFinite(v)) v = a; return v < a ? a : (v > b ? b : v); }
  function $(id) { return hasDoc ? document.getElementById(id) : null; }

  /* Bridge to the Studio state (private `st` in v25-studio.js). */
  function FX() {
    if (RM.v25studio && RM.v25studio.fxApi) return RM.v25studio.fxApi;
    return null;
  }
  function say(m) {
    var fx = FX();
    if (fx && typeof fx.toast === 'function') { try { fx.toast(m); } catch (e) {} return; }
    if (typeof console !== 'undefined' && console.log) console.log('[v26fx] ' + m);
  }

  /* ================= pure DSP glue (node-testable) ================= */

  // Master-BPM ratio: newBpm > oldBpm => faster => shorter (ratio < 1).
  // timeStretch clamps ratio to [0.5, 2], so the effective BPM is clamped
  // to [old/2, old*2]; the UI reports the clamp honestly.
  function stretchRatioForBpm(oldBpm, newBpm) {
    oldBpm = +oldBpm; newBpm = +newBpm;
    if (!(oldBpm > 0) || !(newBpm > 0)) return { ratio: 1, effBpm: oldBpm, clamped: true };
    var ratio = clamp(oldBpm / newBpm, 0.5, 2.0);
    var effBpm = oldBpm / ratio;
    return { ratio: ratio, effBpm: effBpm, clamped: Math.abs(effBpm - newBpm) > 1e-9 };
  }

  // Pitch: engine clamps to ±6 semitones effective (mashup-dsp pitchShift).
  function clampPitch(semitones, cents) {
    var total = (+semitones || 0) + (+cents || 0) / 100;
    var c = clamp(total, -6, 6);
    return { total: c, clamped: Math.abs(c - total) > 1e-9, requested: total };
  }
  function fmtPitch(p) {
    var s = (p >= 0 ? '+' : '') + (Math.round(p * 100) / 100);
    return s + ' st';
  }

  // Piecewise-linear gain over time with endpoint hold; duplicate times
  // (step points) take the later gain at the exact instant.
  function interpGain(pts, t) {
    if (!pts || !pts.length) return 1;
    var p = pts.slice().sort(function (a, b) { return a.t - b.t; });
    if (t <= p[0].t) return p[0].g;
    for (var i = 0; i < p.length - 1; i++) {
      var a = p[i], b = p[i + 1];
      if (t <= b.t) {
        if (b.t <= a.t) return b.g;
        var f = (t - a.t) / (b.t - a.t);
        return a.g + (b.g - a.g) * f;
      }
    }
    return p[p.length - 1].g;
  }

  // Convert free-form (time, gain) points to the per-bar sections that
  // buildAutomationCurve expects: [{bars: 1, gainDb}].
  function automationToSections(points, durSec, bpm) {
    var barSec = 240 / (bpm > 0 ? bpm : 120);
    var nBars = Math.max(1, Math.round(durSec / barSec));
    var secs = [];
    for (var b = 0; b < nBars; b++) {
      var g = interpGain(points, (b + 0.5) * barSec);
      var db = 20 * Math.log10(Math.max(1e-4, g));
      secs.push({ bars: 1, gainDb: clamp(db, -40, 4) });
    }
    return secs;
  }

  // Render path: points -> per-bar sections -> REAL curve -> REAL apply.
  function renderAutomation(buf, points, bpm) {
    if (!RM.v25mix || typeof RM.v25mix.buildAutomationCurve !== 'function')
      throw new Error('Automation engine (v25-mixmaster) not loaded.');
    var secs = automationToSections(points, buf.duration, bpm);
    var curve = RM.v25mix.buildAutomationCurve(secs, { bpm: bpm, sr: buf.sampleRate });
    return RM.v25mix.applyAutomation(buf, curve);
  }

  /* ---- minimal buffer helpers (real AudioBuffer when available,
         shim otherwise — keeps node tests honest) ---- */
  function allocBuf(nCh, len, sr) {
    try {
      if (RM.audio && typeof RM.audio.ensureCtx === 'function') {
        var ctx = RM.audio.ensureCtx();
        if (ctx && typeof ctx.createBuffer === 'function')
          return ctx.createBuffer(nCh, Math.max(1, len | 0), sr);
      }
    } catch (e) { /* fall through to shim */ }
    var n = Math.max(1, len | 0), chans = [];
    for (var c = 0; c < nCh; c++) chans.push(new Float32Array(n));
    return {
      numberOfChannels: nCh, length: n, sampleRate: sr, duration: n / sr,
      getChannelData: function (c) { return chans[c]; },
    };
  }
  function dupBuf(b) {
    var o = allocBuf(b.numberOfChannels, b.length, b.sampleRate);
    for (var c = 0; c < b.numberOfChannels; c++)
      o.getChannelData(c).set(b.getChannelData(c));
    return o;
  }
  function sliceBuf(b, a, c) { // sample indices [a, c)
    a = clamp(Math.round(a), 0, b.length); c = clamp(Math.round(c), 0, b.length);
    if (c <= a) return allocBuf(b.numberOfChannels, 1, b.sampleRate);
    var o = allocBuf(b.numberOfChannels, c - a, b.sampleRate);
    for (var ch = 0; ch < b.numberOfChannels; ch++)
      o.getChannelData(ch).set(b.getChannelData(ch).subarray(a, c));
    return o;
  }
  function copyInto(dst, src, at) {
    at = Math.max(0, Math.round(at));
    for (var c = 0; c < dst.numberOfChannels; c++) {
      var d = dst.getChannelData(c), s = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
      var n = Math.min(s.length, d.length - at);
      for (var i = 0; i < n; i++) d[at + i] = s[i];
    }
    return dst;
  }
  function addBufs(a, b) { // element-wise sum, length of `a`
    var o = allocBuf(a.numberOfChannels, a.length, a.sampleRate);
    for (var c = 0; c < a.numberOfChannels; c++) {
      var d = o.getChannelData(c), x = a.getChannelData(c),
          y = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      var n = Math.min(x.length, y.length);
      for (var i = 0; i < n; i++) d[i] = x[i] + y[i];
    }
    return o;
  }
  function rmsOf(buf, aSec, bSec) {
    var sr = buf.sampleRate;
    var a = clamp(Math.round(aSec * sr), 0, buf.length);
    var b = clamp(Math.round(bSec * sr), 0, buf.length);
    var sum = 0, n = 0;
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var d = buf.getChannelData(c);
      for (var i = a; i < b; i++) { sum += d[i] * d[i]; n++; }
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  // Apply a buildTransition descriptor at a single-buffer junction.
  //
  // Two modes, chosen by the caller:
  // - overlap=false (default): the descriptor's documented window
  //   [B-N, B) ends AT the boundary. The pre-junction region is shaped
  //   by outGain (+ inGain when present) and the synthesized FX is
  //   summed in. filter-sweep has no inGain, so its sweep is applied
  //   exactly once. Buffer length is unchanged.
  // - overlap=true (the crossfade family): a TRUE crossfade — the tail
  //   of the outgoing side x outGain blended with the head of the
  //   incoming side x inGain. This is required because for 'smooth'
  //   outGain+inGain == 1 by construction (in-place shaping would be a
  //   no-op), and for 'crossfade' in-place shaping would only make a
  //   +3 dB mid bump instead of a blend. The buffer shrinks by N
  //   samples (same convention as the Studio's own xfade).
  //
  // Returns { buffer, shrinkSamples }; the input is never modified.
  function applyTransitionAt(buf, juncSample, desc, overlap) {
    if (!desc || typeof desc.lengthSamples !== 'number' || typeof desc.applyTo !== 'function')
      throw new Error('applyTransitionAt needs a buildTransition descriptor.');
    juncSample = Math.round(juncSample);
    var N = desc.lengthSamples;
    if (!(juncSample >= N))
      throw new Error('Junction needs ' + N + ' samples before it (' +
        (N / buf.sampleRate).toFixed(1) + 's); this junction only has ' +
        (juncSample / buf.sampleRate).toFixed(1) + 's.');
    var nCh = buf.numberOfChannels, sr = buf.sampleRate, c;
    if (overlap) {
      if (juncSample + N > buf.length)
        throw new Error('Crossfade needs ' + N + ' samples after the junction too (' +
          (N / sr).toFixed(1) + 's); only ' +
          ((buf.length - juncSample) / sr).toFixed(1) + 's remain.');
      var out = allocBuf(nCh, buf.length - N, sr);
      for (c = 0; c < nCh; c++)
        out.getChannelData(c).set(buf.getChannelData(c).subarray(0, juncSample - N));
      var tail = sliceBuf(buf, juncSample - N, juncSample); // outgoing side
      var head = sliceBuf(buf, juncSample, juncSample + N); // incoming side
      var mixed = addBufs(desc.applyTo(tail, 'out'), desc.applyTo(head, 'in'));
      copyInto(out, mixed, juncSample - N);
      for (c = 0; c < nCh; c++)
        out.getChannelData(c).set(
          buf.getChannelData(c).subarray(juncSample + N), juncSample);
      desc.placeAt(out, juncSample - N); // no data/tail for this family; kept uniform
      return { buffer: out, shrinkSamples: N };
    }
    var out2 = dupBuf(buf);
    var start = juncSample - N;
    var region = sliceBuf(out2, start, juncSample);
    var shaped = desc.applyTo(region, 'out');
    if (desc.inGain) shaped = addBufs(shaped, desc.applyTo(region, 'in'));
    copyInto(out2, shaped, start);
    desc.placeAt(out2, start);
    return { buffer: out2, shrinkSamples: 0 };
  }

  function isCrossfadeFamily(type) { return type === 'crossfade' || type === 'smooth'; }

  function listTransitionTypes() {
    if (RM.v25mix && typeof RM.v25mix.listTransitions === 'function')
      return RM.v25mix.listTransitions();
    return [];
  }

  /* ================= undo stack =================
     Own command stack (cap 8) + the shared v26 convention published
     first-wins: __v26pushUndo(label, undoFn) / __v26undo().
     v26-studio-fx.js loads before v26-vocal.js, so this file is the
     publisher when no other worker published first; I6 then adopts it
     and its ops land here too (one shared undo history). */
  var undoStack = [], redoStack = [], MAX_UNDO = 8;

  var api = null; // RM.v26fx — assigned below

  function localPush(label, undoFn, doFn) {
    undoStack.push({ label: label, undo: undoFn, do: doFn });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoUI();
  }
  function pushUndo(label, undoFn, doFn) {
    api.lastOp = { label: label, undo: undoFn, redo: doFn };
    localPush(label, undoFn, doFn);
    // Cross-worker visibility: forward to the shared stack when it was
    // published by ANOTHER worker (I6). When it is ours (see below) the
    // op is already there — the _v26fx marker prevents double-pushing.
    var g = (typeof window !== 'undefined') ? window : null;
    if (g && typeof g.__v26pushUndo === 'function' && !g.__v26pushUndo._v26fx) {
      try { g.__v26pushUndo(label, undoFn); } catch (e) {}
    }
  }
  function doUndo() {
    var e = undoStack.pop();
    updateUndoUI();
    if (!e) { say('Nothing to undo'); return false; }
    try { e.undo(); } catch (err) { say('Undo failed: ' + err.message); return false; }
    redoStack.push(e);
    say('Undone: ' + e.label);
    return true;
  }
  function doRedo() {
    var e = redoStack.pop();
    if (!e) { say('Nothing to redo'); return false; }
    if (typeof e.do !== 'function') { say('This step cannot be redone'); return false; }
    try { e.do(); } catch (err) { say('Redo failed: ' + err.message); return false; }
    undoStack.push(e);
    updateUndoUI();
    say('Redone: ' + e.label);
    return true;
  }
  // Absolute snapshot of the editable Studio state (never mutates).
  function snapshot(label) {
    var fx = FX();
    return {
      label: label,
      buf: fx.cur(),
      bpm: fx.bpm(),
      lens: fx.secs().map(function (s) { return s.lenSec; }),
      auto: fx.auto() ? fx.auto().map(function (p) { return { t: p.t, g: p.g }; }) : null,
    };
  }
  function restore(snap) {
    var fx = FX();
    if (!fx || !snap || !snap.buf) return;
    fx.apply(snap.buf, { bpm: snap.bpm, sections: snap.lens, automation: snap.auto });
    lastBuf = snap.buf;
    api.autoPoints = snap.auto ? snap.auto.map(function (p) { return { t: p.t, g: p.g }; }) : [];
    refreshPanel();
  }

  /* The Studio buffer can also change outside our ops (open from the
     Mashup screen, v25 section edits, Reset). openFromMashup calls the
     closure-local open(), so wrapping the exported open() alone cannot
     catch it. syncCheck() re-anchors lazily: any buffer we did not
     produce ourselves resets the lane (absolute-second points would
     otherwise land on the wrong timeline) and rebuilds junctions. */
  var lastBuf = null;
  function syncCheck() {
    var fx = FX();
    if (!fx) return;
    var cur = fx.cur();
    if (cur && cur !== lastBuf) {
      lastBuf = cur;
      resetAutomation();
      rebuildJunctions();
      updateUndoUI();
    }
  }

  /* ================= UI ================= */

  var PANEL_CSS = '' +
    '#v26-fxpanel .v26-row{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}' +
    '#v26-fxpanel .v26-row .btn{min-height:52px}' +
    '#v26-fxpanel input[type=number]{width:84px;min-height:52px;font-size:16px}' +
    '#v26-fxpanel input[type=range]{flex:1;min-width:120px;min-height:48px}' +
    '#v26-fxpanel select{min-height:52px;max-width:100%}' +
    '#v26-fxpanel canvas#v26-auto{width:100%;height:110px;display:block;border-radius:8px;background:#0d1226;touch-action:none;cursor:crosshair}' +
    '#v26-fxpanel .v26-hint{font-size:12px;opacity:.75;margin:4px 0}' +
    '#v26-fxpanel h5{margin:14px 0 6px;font-size:14px}' +
    '#v26-prog{margin-top:8px}' +
    '#v26-pbar-wrap{height:6px;border-radius:3px;background:#1c2340;margin-top:6px;overflow:hidden}' +
    '#v26-pbar{height:100%;width:0%;background:linear-gradient(90deg,#29b6f6,#b537f2);transition:width .15s}';

  var PANEL_HTML = '' +
    '<div class="panel" id="v26-fxpanel">' +
    '<style>' + PANEL_CSS + '</style>' +
    '<h4>\uD83C\uDF9B\uFE0F Studio FX <span class="beta">Smart DSP</span></h4>' +
    '<div class="honest">Real on-device DSP \u2014 every control below changes the actual audio. All edits are undoable, audible in preview (A/B \u201CB\u201D) and present in export.</div>' +

    '<h5>Master BPM</h5>' +
    '<div class="v26-row"><label>Tempo <input type="number" id="v26-bpm" min="40" max="260" step="0.5" aria-label="Master BPM"></label>' +
    '<button class="btn" id="v26-bpm-apply">Apply BPM</button></div>' +
    '<div class="v26-hint">WSOLA time-stretch (Smart DSP) \u2014 pitch preserved, sections re-fit. Limited to \u00BD\u00D7\u20132\u00D7 of the current BPM (engine limit); out-of-range values are clamped.</div>' +

    '<h5>Pitch</h5>' +
    '<div class="v26-row"><label style="flex:1">Semitones <input type="range" id="v26-pitch" min="-12" max="12" step="1" value="0" aria-label="Pitch semitones"> <span id="v26-pitch-v">+0 st</span></label></div>' +
    '<div class="v26-row"><label style="flex:1">Fine <input type="range" id="v26-cents" min="-100" max="100" step="1" value="0" aria-label="Pitch fine cents"> <span id="v26-cents-v">+0\u00A2</span></label>' +
    '<button class="btn" id="v26-pitch-apply">Apply pitch</button></div>' +
    '<div class="v26-hint">Tempo-preserving pitch shift (Smart DSP) \u2014 duration unchanged. Engine range \u00B16 semitones: larger values are clamped and reported.</div>' +

    '<h5>Volume automation</h5>' +
    '<canvas id="v26-auto"></canvas>' +
    '<div class="v26-hint">Click: add point \u2022 drag: move \u2022 double-click / right-click: delete. Changes apply gradually (\u22643 dB/bar slew \u2014 no sudden jumps).</div>' +
    '<div class="v26-row"><button class="btn primary" id="v26-auto-apply">Apply automation</button>' +
    '<button class="btn" id="v26-auto-clear">Clear lane</button></div>' +

    '<h5>Junction transition</h5>' +
    '<div class="v26-row"><label>Junction <select id="v26-junc" class="textin" aria-label="Junction"></select></label>' +
    '<label>Type <select id="v26-trtype" class="textin" aria-label="Transition type"></select></label>' +
    '<label>Length <select id="v26-trbars" class="textin" aria-label="Transition length"><option value="1">1 bar</option><option value="2" selected>2 bars</option><option value="4">4 bars</option></select></label>' +
    '<button class="btn primary" id="v26-tr-apply">Apply transition</button></div>' +
    '<div class="v26-hint" id="v26-trdesc">Beat-synced to the master BPM. The transition window ends at the junction (build-up into the boundary). Crossfades snap to \u22654 bars (engine rule).</div>' +

    '<div class="v26-row"><button class="btn" id="v26-undo" aria-label="Undo">&#8617; Undo</button>' +
    '<button class="btn" id="v26-redo" aria-label="Redo">&#8618; Redo</button>' +
    '<span class="muted small" id="v26-undo-label"></span></div>' +
    '<div id="v26-prog" class="status"></div><div id="v26-pbar-wrap"><div id="v26-pbar"></div></div>' +
    '</div>';

  function setProg(label, frac) {
    var t = $('v26-prog'), b = $('v26-pbar');
    if (t && label != null) t.textContent = label;
    if (b) b.style.width = Math.round(clamp(frac || 0, 0, 1) * 100) + '%';
  }

  function fmtTime(s) {
    s = Math.max(0, +s || 0);
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* ---- automation lane (canvas) ---- */

  function laneGeom() {
    var cv = $('v26-auto');
    if (!cv) return null;
    var fx = FX();
    var dur = fx && fx.cur() ? fx.cur().duration : 60;
    var w = cv.clientWidth || 320, h = 110;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    return { cv: cv, w: w, h: h, dpr: dpr, dur: dur, gMax: 1.5,
             x: function (t) { return (t / dur) * w; },
             t: function (x) { return clamp(x / w, 0, 1) * dur; },
             y: function (g) { return h - (clamp(g, 0, 1.5) / 1.5) * h; },
             g: function (y) { return clamp(1 - y / h, 0, 1) * 1.5; } };
  }

  function drawLane() {
    var G = laneGeom();
    if (!G) return;
    var ctx = G.cv.getContext('2d');
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    ctx.clearRect(0, 0, G.w, G.h);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    [0, 0.5, 1, 1.5].forEach(function (g) {
      ctx.beginPath(); ctx.moveTo(0, G.y(g)); ctx.lineTo(G.w, G.y(g)); ctx.stroke();
    });
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '10px sans-serif';
    ctx.fillText('150%', 4, 12); ctx.fillText('100%', 4, G.y(1) - 4); ctx.fillText('0%', 4, G.h - 4);
    ctx.fillText(fmtTime(0), 4, G.h - 4); ctx.fillText(fmtTime(G.dur), G.w - 34, G.h - 4);
    // curve
    var pts = api.autoPoints.slice().sort(function (a, b) { return a.t - b.t; });
    ctx.strokeStyle = '#29b6f6'; ctx.lineWidth = 2; ctx.beginPath();
    if (pts.length === 0) {
      ctx.moveTo(0, G.y(1)); ctx.lineTo(G.w, G.y(1));
    } else {
      ctx.moveTo(0, G.y(interpGain(pts, 0)));
      var steps = Math.max(32, Math.floor(G.w / 4));
      for (var i = 1; i <= steps; i++) ctx.lineTo(G.w * i / steps, G.y(interpGain(pts, G.dur * i / steps)));
    }
    ctx.stroke();
    // points
    pts.forEach(function (p) {
      ctx.beginPath(); ctx.arc(G.x(p.t), G.y(p.g), 7, 0, 2 * Math.PI);
      ctx.fillStyle = '#b537f2'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    });
  }

  function resetAutomation() {
    var fx = FX();
    var dur = fx && fx.cur() ? fx.cur().duration : 60;
    api.autoPoints = [{ t: 0, g: 1 }, { t: dur, g: 1 }];
    if (fx) fx.setAuto(api.autoPoints.map(function (p) { return { t: p.t, g: p.g }; }));
    drawLane();
  }

  function nearestPoint(G, x, y) {
    var best = -1, bd = 14 * 14;
    var pts = api.autoPoints;
    for (var i = 0; i < pts.length; i++) {
      var dx = G.x(pts[i].t) - x, dy = G.y(pts[i].g) - y;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function wireLane() {
    var cv = $('v26-auto');
    if (!cv || cv._v26wired) return;
    cv._v26wired = true;
    var drag = -1;
    function pos(e) {
      var r = cv.getBoundingClientRect();
      var cx = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
      var cy = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
      return { x: cx - r.left, y: cy - r.top };
    }
    function down(e) {
      var G = laneGeom(); if (!G) return;
      var p = pos(e), i = nearestPoint(G, p.x, p.y);
      if (i >= 0) { drag = i; }
      else {
        api.autoPoints.push({ t: G.t(p.x), g: G.g(p.y) });
        drag = api.autoPoints.length - 1;
        syncAutoToState();
      }
      e.preventDefault();
    }
    function move(e) {
      if (drag < 0) return;
      var G = laneGeom(); if (!G) return;
      var p = pos(e);
      api.autoPoints[drag].t = G.t(p.x);
      api.autoPoints[drag].g = G.g(p.y);
      drawLane();
      e.preventDefault();
    }
    function up() {
      if (drag >= 0) { drag = -1; syncAutoToState(); drawLane(); }
    }
    function del(e) {
      var G = laneGeom(); if (!G) return;
      var p = pos(e), i = nearestPoint(G, p.x, p.y);
      if (i >= 0) { api.autoPoints.splice(i, 1); syncAutoToState(); drawLane(); }
      e.preventDefault();
    }
    cv.addEventListener('mousedown', down);
    cv.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    cv.addEventListener('dblclick', del);
    cv.addEventListener('contextmenu', del);
    cv.addEventListener('touchstart', down, { passive: false });
    cv.addEventListener('touchmove', move, { passive: false });
    cv.addEventListener('touchend', up);
  }

  function syncAutoToState() {
    var fx = FX();
    if (fx) fx.setAuto(api.autoPoints.map(function (p) { return { t: p.t, g: p.g }; }));
  }

  /* ---- panel refresh ---- */

  function rebuildJunctions() {
    var sel = $('v26-junc');
    if (!sel) return;
    sel.innerHTML = '';
    var fx = FX();
    var secs = fx ? fx.secs() : [];
    if (!secs || secs.length < 2) {
      var o = document.createElement('option');
      o.value = '-1'; o.textContent = 'No junctions (need ≥2 sections)';
      sel.appendChild(o); sel.disabled = true;
      return;
    }
    sel.disabled = false;
    var acc = 0;
    for (var i = 0; i < secs.length - 1; i++) {
      acc += secs[i].lenSec;
      var op = document.createElement('option');
      op.value = String(i);
      op.textContent = '#' + (i + 1) + ' ' + fmtTime(acc) + ' — after \u201C' +
        secs[i].name + '\u201D \u2192 \u201C' + secs[i + 1].name + '\u201D';
      sel.appendChild(op);
    }
  }

  function rebuildTypes() {
    var sel = $('v26-trtype');
    if (!sel || sel._v26filled) return;
    sel._v26filled = true;
    var types = listTransitionTypes();
    if (!types.length) {
      var o = document.createElement('option');
      o.value = ''; o.textContent = 'Transition engine not loaded';
      sel.appendChild(o); sel.disabled = true;
      return;
    }
    types.forEach(function (t) {
      var op = document.createElement('option');
      op.value = t.id; op.textContent = t.name; op.title = t.desc || '';
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () {
      var d = $('v26-trdesc');
      for (var i = 0; i < types.length; i++)
        if (types[i].id === sel.value && d) d.textContent = types[i].desc || '';
    });
    sel.dispatchEvent(new Event('change'));
  }

  function refreshPanel() {
    var fx = FX();
    var bi = $('v26-bpm');
    if (bi && fx) bi.value = String(Math.round(fx.bpm() * 10) / 10);
    rebuildJunctions();
    drawLane();
    updateUndoUI();
  }

  function updateUndoUI() {
    var u = $('v26-undo'), r = $('v26-redo'), l = $('v26-undo-label');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
    if (l) l.textContent = undoStack.length ? ('Last: ' + undoStack[undoStack.length - 1].label) : '';
  }

  /* ================= real operations ================= */

  function needBuf() {
    var fx = FX();
    if (!fx || !fx.cur()) { say('Load a mashup in the Studio first \uD83C\uDFB5'); return null; }
    syncCheck();
    return fx;
  }

  function applyBpm() {
    var fx = needBuf(); if (!fx) return;
    if (fx.busy()) { say('Studio is busy \u2014 wait for the current job'); return; }
    var raw = parseFloat(($('v26-bpm') || {}).value);
    if (!(raw >= 40 && raw <= 260)) { say('Enter a BPM between 40 and 260'); return; }
    var oldBpm = fx.bpm();
    var rr = stretchRatioForBpm(oldBpm, raw);
    if (Math.abs(rr.effBpm - oldBpm) < 0.005) { say('Already at ' + (Math.round(oldBpm * 10) / 10) + ' BPM'); return; }
    if (!RM.mashupDSP || typeof RM.mashupDSP.timeStretch !== 'function') { say('Time-stretch engine not loaded'); return; }
    var pre = snapshot('Master BPM');
    fx.busy(true);
    setProg('Time-stretching ' + oldBpm.toFixed(1) + ' \u2192 ' + rr.effBpm.toFixed(1) + ' BPM (WSOLA, Smart DSP)\u2026', 0);
    RM.mashupDSP.timeStretch(fx.cur(), rr.ratio, function (p) {
      setProg('Time-stretching\u2026 ' + Math.round(p * 100) + '%', p);
    }).then(function (nb) {
      var post = {
        label: 'Master BPM', buf: nb, bpm: rr.effBpm,
        lens: pre.lens.map(function (l) { return l * rr.ratio; }),
        auto: pre.auto ? pre.auto.map(function (p) { return { t: p.t * rr.ratio, g: p.g }; }) : null,
      };
      fx.apply(nb, { bpm: rr.effBpm, rescale: true, automation: post.auto });
      lastBuf = nb;
      api.autoPoints = post.auto ? post.auto.map(function (p) { return { t: p.t, g: p.g }; }) : [];
      pushUndo('Master BPM ' + oldBpm.toFixed(1) + '\u2192' + rr.effBpm.toFixed(1),
        function () { restore(pre); }, function () { restore(post); });
      var note = rr.clamped ? ' (clamped to \u00B12\u00D7 engine limit)' : '';
      say('Master BPM ' + oldBpm.toFixed(1) + ' \u2192 ' + rr.effBpm.toFixed(1) + ' \u2713' + note);
    }).catch(function (e) {
      say('BPM change failed: ' + (e && e.message || e));
    }).then(function () {
      fx.busy(false); setProg('', 1); refreshPanel();
    });
  }

  function applyPitch() {
    var fx = needBuf(); if (!fx) return;
    if (fx.busy()) { say('Studio is busy \u2014 wait for the current job'); return; }
    var semi = parseInt((($('v26-pitch') || {}).value) || '0', 10);
    var cents = parseInt((($('v26-cents') || {}).value) || '0', 10);
    var c = clampPitch(semi, cents);
    if (Math.abs(c.total) < 1e-9) { say('Pitch is 0 \u2014 move a slider first'); return; }
    if (!RM.mashupDSP || typeof RM.mashupDSP.pitchShift !== 'function') { say('Pitch engine not loaded'); return; }
    var pre = snapshot('Pitch');
    fx.busy(true);
    setProg('Pitch-shifting ' + fmtPitch(c.total) + ' (tempo-preserving, Smart DSP)\u2026', 0);
    RM.mashupDSP.pitchShift(fx.cur(), c.total, function (p) {
      setProg('Pitch-shifting\u2026 ' + Math.round(p * 100) + '%', p);
    }).then(function (nb) {
      var post = { label: 'Pitch', buf: nb, bpm: pre.bpm, lens: pre.lens, auto: pre.auto };
      fx.apply(nb, {});
      lastBuf = nb;
      pushUndo('Pitch ' + fmtPitch(c.total),
        function () { restore(pre); }, function () { restore(post); });
      var note = c.clamped ? ' (clamped to the \u00B16 st engine range from ' + fmtPitch(c.requested) + ')' : '';
      say('Pitch ' + fmtPitch(c.total) + ' applied \u2713' + note);
      var ps = $('v26-pitch'), cs = $('v26-cents');
      if (ps) { ps.value = '0'; var pv = $('v26-pitch-v'); if (pv) pv.textContent = '+0 st'; }
      if (cs) { cs.value = '0'; var cvv = $('v26-cents-v'); if (cvv) cvv.textContent = '+0\u00A2'; }
    }).catch(function (e) {
      say('Pitch shift failed: ' + (e && e.message || e));
    }).then(function () {
      fx.busy(false); setProg('', 1); refreshPanel();
    });
  }

  function applyAutomationUI() {
    var fx = needBuf(); if (!fx) return;
    if (fx.busy()) { say('Studio is busy \u2014 wait for the current job'); return; }
    var pts = api.autoPoints.map(function (p) { return { t: p.t, g: p.g }; });
    if (!pts.length) { say('Add at least one point on the lane first'); return; }
    var pre = snapshot('Volume automation');
    setProg('Applying volume automation (Smart DSP)\u2026', 0.5);
    var nb;
    try {
      nb = renderAutomation(fx.cur(), pts, fx.bpm());
    } catch (e) {
      setProg('', 0);
      say('Automation failed: ' + (e && e.message || e));
      return;
    }
    var post = { label: 'Volume automation', buf: nb, bpm: pre.bpm, lens: pre.lens, auto: pre.auto };
    fx.apply(nb, {});
    lastBuf = nb;
    pushUndo('Volume automation',
      function () { restore(pre); }, function () { restore(post); });
    setProg('', 1);
    say('Volume automation applied \u2713 (gradual \u22643 dB/bar)');
    refreshPanel();
  }

  function applyTransitionUI() {
    var fx = needBuf(); if (!fx) return;
    if (fx.busy()) { say('Studio is busy \u2014 wait for the current job'); return; }
    var ji = parseInt((($('v26-junc') || {}).value) || '-1', 10);
    var secs = fx.secs();
    if (!(ji >= 0 && ji < secs.length - 1)) { say('Pick a junction first'); return; }
    var type = (($('v26-trtype') || {}).value) || '';
    if (!type) { say('Transition engine not loaded'); return; }
    var bars = parseInt((($('v26-trbars') || {}).value) || '2', 10) || 2;
    if (!RM.v25mix || typeof RM.v25mix.buildTransition !== 'function') { say('Transition engine not loaded'); return; }
    var at = 0;
    for (var i = 0; i <= ji; i++) at += secs[i].lenSec;
    // v27: ONE clean hook — snap the transition start to the nearest
    // ESTIMATED downbeat, but only when the estimate is trustworthy
    // (confidence ≥ 0.6). snapTransitionTime is async (analysis is cached
    // per buffer); on any failure the original junction time passes
    // through untouched — a wrong snap is worse than no snap.
    var proceed = function (snap) {
      if (snap && snap.snapped) at = snap.time;
      finishTransitionAt(fx, ji, type, bars, at, snap);
    };
    try {
      if (RM.v27downbeat && typeof RM.v27downbeat.snapTransitionTime === 'function') {
        say('Estimating downbeats…');
        RM.v27downbeat.snapTransitionTime(fx.cur(), at, { bpm: fx.bpm() }).then(proceed, function () { proceed(null); });
      } else proceed(null);
    } catch (e) { proceed(null); }
  }

  // Continuation of applyTransitionUI after the (async) downbeat snap.
  // `snap`: null | { time, snapped, alreadyAligned, confidence }.
  function finishTransitionAt(fx, ji, type, bars, at, snap) {
    var sr = fx.cur().sampleRate;
    var juncSample = Math.round(at * sr);
    var desc;
    try {
      desc = RM.v25mix.buildTransition(type, bars, { bpm: fx.bpm(), sr: sr, energy: 0.7 });
    } catch (e) {
      say('Transition failed: ' + (e && e.message || e));
      return;
    }
    if (juncSample < desc.lengthSamples) {
      say('Not enough audio before this junction for a ' + desc.bars +
        '-bar ' + type + ' (needs ' + (desc.lengthSamples / sr).toFixed(1) +
        's, junction has ' + (juncSample / sr).toFixed(1) + 's)');
      return;
    }
    var pre = snapshot('Transition');
    var res;
    try {
      res = applyTransitionAt(fx.cur(), juncSample, desc, isCrossfadeFamily(type));
    } catch (e) {
      say('Transition failed: ' + (e && e.message || e));
      return;
    }
    var nb = res.buffer;
    // True crossfades shrink the buffer by N: section ji keeps its length,
    // section ji+1 absorbs the shrink (Studio xfade convention); automation
    // points at/after the junction shift left with the audio.
    var lens = pre.lens.slice(), auto = pre.auto;
    if (res.shrinkSamples > 0) {
      var shSec = res.shrinkSamples / sr;
      lens[ji + 1] = Math.max(0.25, lens[ji + 1] - shSec);
      if (auto) auto = auto.map(function (p) {
        return { t: p.t >= at ? Math.max(0, p.t - shSec) : p.t, g: p.g };
      });
    }
    var post = { label: 'Transition', buf: nb, bpm: pre.bpm, lens: lens, auto: auto };
    fx.apply(nb, { sections: lens, automation: auto });
    lastBuf = nb;
    api.autoPoints = auto ? auto.map(function (p) { return { t: p.t, g: p.g }; }) : [];
    var tname = type;
    var types = listTransitionTypes();
    for (var k = 0; k < types.length; k++) if (types[k].id === type) tname = types[k].name;
    pushUndo('Transition: ' + tname,
      function () { restore(pre); }, function () { restore(post); });
    say(tname + ' applied at ' + fmtTime(at) + ' \u2713 (beat-synced to ' +
      (Math.round(fx.bpm() * 10) / 10) + ' BPM' +
      (desc.bars !== bars ? ', ' + desc.bars + ' bars (engine snap)' : '') +
      (snap && snap.snapped ? '; snapped to estimated downbeat' : '') + ')');
    refreshPanel();
  }

  /* ================= init ================= */

  var _inited = false;

  function init(doc) {
    if (_inited) return;
    doc = doc || (hasDoc ? document : null);
    if (!doc) return;
    _inited = true;

    var screen = doc.getElementById('screen-studio');
    if (!screen) { _inited = false; return; } // studio not rendered yet; retry later
    if (doc.getElementById('v26-fxpanel')) { wireAll(); return; }

    var host = doc.getElementById('stu-main') || screen;
    var tmp = doc.createElement('div');
    tmp.innerHTML = PANEL_HTML;
    if (tmp.firstChild) host.appendChild(tmp.firstChild);
    wireAll();
    refreshPanel();

    // Keep automation + junction list in sync with Studio lifecycle,
    // without touching v25-studio.js. Note: openFromMashup calls the
    // closure-local open(), so we also listen on the #stu-load button
    // (our listener runs after v25's, since wire() ran first) and
    // self-heal lazily via syncCheck() on any panel interaction.
    try {
      if (RM.v25studio && !RM.v25studio._v26fxWrapped) {
        RM.v25studio._v26fxWrapped = true;
        ['open', 'openFromMashup'].forEach(function (k) {
          var orig = RM.v25studio[k];
          if (typeof orig === 'function') {
            RM.v25studio[k] = function () {
              var r = orig.apply(this, arguments);
              try { var fx = FX(); lastBuf = fx ? fx.cur() : null; } catch (e) {}
              try { resetAutomation(); rebuildJunctions(); refreshPanel(); } catch (e2) {}
              return r;
            };
          }
        });
      }
    } catch (e) {}
    var panel = doc.getElementById('v26-fxpanel');
    if (panel && !panel._v26synced) {
      panel._v26synced = true;
      panel.addEventListener('pointerdown', function () { try { syncCheck(); } catch (e) {} }, true);
    }
    var ld = doc.getElementById('stu-load');
    if (ld && !ld._v26wired) {
      ld._v26wired = true;
      ld.addEventListener('click', function () {
        setTimeout(function () {
          try { var fx = FX(); lastBuf = fx ? fx.cur() : null; } catch (e) {}
          try { resetAutomation(); rebuildJunctions(); refreshPanel(); } catch (e2) {}
        }, 0);
      });
    }
    try { var fxi = FX(); lastBuf = fxi ? fxi.cur() : null; } catch (e) {}
    var rst = doc.getElementById('stu-reset');
    if (rst && !rst._v26wired) {
      rst._v26wired = true;
      rst.addEventListener('click', function () {
        setTimeout(function () { try { resetAutomation(); refreshPanel(); } catch (e) {} }, 0);
      });
    }
  }

  function wireAll() {
    function on(id, fn) { var el = $(id); if (el && !el._v26wired) { el._v26wired = true; el.addEventListener('click', fn); } }
    on('v26-bpm-apply', applyBpm);
    on('v26-pitch-apply', applyPitch);
    on('v26-auto-apply', applyAutomationUI);
    on('v26-auto-clear', function () {
      api.autoPoints = [];
      syncAutoToState(); drawLane();
      say('Lane cleared \u2014 add points or Apply does nothing');
    });
    on('v26-tr-apply', applyTransitionUI);
    on('v26-undo', doUndo);
    on('v26-redo', doRedo);
    var ps = $('v26-pitch'), pv = $('v26-pitch-v');
    if (ps && pv && !ps._v26wired) {
      ps._v26wired = true;
      ps.addEventListener('input', function () {
        var v = parseInt(ps.value, 10) || 0;
        pv.textContent = (v >= 0 ? '+' : '') + v + ' st';
      });
    }
    var cs = $('v26-cents'), cvv = $('v26-cents-v');
    if (cs && cvv && !cs._v26wired) {
      cs._v26wired = true;
      cs.addEventListener('input', function () {
        var v = parseInt(cs.value, 10) || 0;
        cvv.textContent = (v >= 0 ? '+' : '') + v + '\u00A2';
      });
    }
    rebuildTypes();
    wireLane();
    resetAutomation();
  }

  api = {
    init: init,
    refreshPanel: refreshPanel,
    autoPoints: [],
    lastOp: null, // most recent {label, undo, redo} — for I2's undo stack
    undo: doUndo,
    redo: doRedo,
    // test / coordinator surface (pure functions)
    internals: {
      stretchRatioForBpm: stretchRatioForBpm,
      clampPitch: clampPitch,
      fmtPitch: fmtPitch,
      interpGain: interpGain,
      automationToSections: automationToSections,
      renderAutomation: renderAutomation,
      applyTransitionAt: applyTransitionAt,
      isCrossfadeFamily: isCrossfadeFamily,
      listTransitionTypes: listTransitionTypes,
      allocBuf: allocBuf,
      dupBuf: dupBuf,
      sliceBuf: sliceBuf,
      rmsOf: rmsOf,
      pushUndo: pushUndo,
      undoDepth: function () { return undoStack.length; },
    },
  };
  RM.v26fx = api;

  /* Publish the shared v26 undo convention, first-wins (see header).
     I6/v26-vocal.js checks for these at its own eval and adopts them
     when present. Signature matches I6: (label, undoFn). */
  (function publishSharedUndo() {
    try {
      var g = (typeof window !== 'undefined') ? window
        : ((typeof global !== 'undefined') ? global : null);
      if (!g || typeof g.__v26pushUndo === 'function') return;
      var p = function (label, undoFn) {
        if (typeof undoFn !== 'function') return;
        localPush(label, undoFn, null); // foreign op: undoable here, no redo
      };
      p._v26fx = true;
      var u = function () { return doUndo(); };
      u._v26fx = true;
      g.__v26pushUndo = p;
      g.__v26undo = u;
    } catch (e) { /* never break the app over undo plumbing */ }
  })();

  /* self-boot (idempotent; the v25-studio.js wire() hook also calls init) */
  if (hasDoc) {
    var bootFx = function () { try { init(document); } catch (e) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFx);
    else setTimeout(bootFx, 0);
    // If the Studio screen renders later than us, retry once shortly after.
    setTimeout(function () {
      try { if (!document.getElementById('v26-fxpanel')) init(document); } catch (e) {}
    }, 1500);
  }

  /* node unit-test hook (browser-harmless) */
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { api: api, internals: api.internals };
    }
  } catch (e) {}
})();
