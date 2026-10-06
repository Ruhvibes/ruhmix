'use strict';
/* =====================================================================
   RuhMix — mashup-screen.js (Worker 3)
   "🤖 Auto Mashup" screen UI. window.RM.mashupScreen module.

   Pick flow: reuses the EXACT #cdx-pick flow (RM.ux.pickMusic() -> import
   screen). Before routing, pickTarget = 1|2 is set; app.js landing points
   (handleAudioPicked direct-load + import "Use" button) call
   RM.mashupScreen.onPicked(slot, buffer, name) instead of loadAudioBuffer,
   which lands the decoded AudioBuffer in the mashup slot and returns to
   the mashup screen. Stale pending picks are cleared if the user abandons
   the import screen without picking.

   Playback: preview starts ONLY from the user's tap on #mashup-play
   (never autoplay), and is always stopped when the mashup screen is left.

   Depends on other workers' files: RM.mashup.build (build engine) and
   RM.mashupExport.sendToExport (Worker 5) — both called defensively.
   ===================================================================== */
window.RM = window.RM || {};

(function () {
  var RM = window.RM;
  function A() { return RM.app || null; }
  function $(id) { return document.getElementById(id); }

  var ms = {
    pickTarget: 0,        // 0 = none, 1 = Song 1 (Vocals), 2 = Song 2 (Beat)
    slot1: null, slot2: null, // { buffer: AudioBuffer, name: string }
    result: null,         // { buffer: AudioBuffer, meta: string }
    pvSrc: null,          // active preview BufferSourceNode
    building: false,
    _wired: false,
    _hook: null,
  };

  /* ================= picker (exact #cdx-pick flow) ================= */

  function requestPick(slot) {
    var a = A();
    if (!a) return;
    stopPreview();
    ms.pickTarget = slot;
    try {
      if (RM.ux && typeof RM.ux.pickMusic === 'function') {
        RM.ux.pickMusic(); // same mechanism as the #cdx-pick button
      } else {
        a.show('import');
      }
    } catch (e) { ms.pickTarget = 0; return; }
    a.toast(slot === 1 ? 'Pick Song 1 — Vocals 🎤' : 'Pick Song 2 — Beat 🥁');
  }

  // Called by app.js (mashupIntercept) with the decoded AudioBuffer + name.
  function onPicked(slot, buffer, name) {
    var a = A();
    if (!buffer || (slot !== 1 && slot !== 2)) { if (a) a.toast('Pick failed — try again'); ms.pickTarget = 0; return; }
    var entry = { buffer: buffer, name: name || 'audio' };
    if (slot === 1) ms.slot1 = entry; else ms.slot2 = entry;
    ms.pickTarget = 0;
    renderNames();
    if (a) {
      a.toast('Song ' + slot + ' selected ✓');
      a.show('mashup');
    }
  }

  function renderNames() {
    var n1 = $('mashup-name1'), n2 = $('mashup-name2');
    if (n1) { n1.textContent = ms.slot1 ? ms.slot1.name : 'No song selected'; }
    if (n2) { n2.textContent = ms.slot2 ? ms.slot2.name : 'No song selected'; }
  }

  /* ================= progress ================= */

  function setProgress(label, frac) {
    var wrap = $('mashup-progress'), lb = $('mashup-prog-label'), bar = $('mashup-prog-bar');
    if (!wrap) return;
    wrap.hidden = false;
    if (lb) lb.textContent = label || '';
    if (bar) bar.style.width = Math.max(0, Math.min(100, Math.round((frac || 0) * 100))) + '%';
  }
  function hideProgress() { var w = $('mashup-progress'); if (w) w.hidden = true; }

  /* ================= build ================= */

  function setBuildUI(running) {
    ms.building = running;
    var b = $('mashup-make');
    if (b) b.disabled = running;
    // v21: Cancel button — the only escape if the neural call stalls.
    var c = $('mashup-cancel');
    if (c) c.hidden = !running;
    if (running) { var r = $('mashup-result'); if (r) r.hidden = true; }
    else hideProgress();
  }

  function fail(msg) {
    var a = A();
    setBuildUI(false);
    // v21: user Cancel shows a clean "Cancelled." (never an error stack).
    var txt = (msg && msg.kind === 'cancelled') ? 'Cancelled.' : (a.cleanErrMsg(msg) || 'Something went wrong. Please try again.');
    if (a) a.toast(txt);
  }

  // Professional one-line summary of what the auto pipeline did.
  function formatMeta(m) {
    if (!m || typeof m !== 'object') return String(m || '');
    var parts = [];
    if (m.bpm1 && m.targetBpm) parts.push(m.bpm1 + ' → ' + m.targetBpm + ' BPM');
    if (m.key1 && m.key1 !== 'Unknown') {
      var ks = m.key1 + (m.semitones ? ' (key matched ' + (m.semitones > 0 ? '+' : '') + m.semitones + ' st)' : ' (key matched)');
      parts.push(ks);
    }
    if (m.durationSec) parts.push(m.durationSec + 's');
    return parts.join(' • ') || 'Mashup ready';
  }

  function make() {
    var a = A();
    if (!a || ms.building) return;
    var src = (BU && BU.beatSource) || 'builtin';
    if (!ms.slot1) {
      a.toast('Pick Song 1 — Vocals first 🎤');
      return;
    }
    if (src === 'song2' && !ms.slot2) {
      a.toast('Pick Song 2 — Beat first 🥁');
      return;
    }
    // Engine contract (W3): RM.mashup.buildAuto(voxBuffer, styleId, onProgress, onStep)
    // -> Promise<{ buffer, meta }>; W3's engine calls onStep('vocals'|'beat'|'mix'|'done').
    var canBuiltin = RM.mashup && typeof RM.mashup.buildAuto === 'function';
    var canSong2 = RM.mashup && typeof RM.mashup.build === 'function';
    if ((src === 'builtin' && !canBuiltin) || (src === 'song2' && !canSong2)) {
      a.toast('Mashup engine not ready — update the app and retry.');
      return;
    }
    stopPreview();
    setBuildUI(true);
    // v21: fresh build — clear any stale cancel flag from a previous run.
    try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (e) {}
    BU.resetSteps();
    setProgress('Analyzing…', 0);
    var done = false;
    var onProg = function (label, frac) { if (!done) setProgress(label, frac); };
    // Song 2 mode: the classic build() has no onStep — drive the 3-step
    // indicator from progress fractions so it never sits static.
    var onProgSong2 = function (label, frac) {
      onProg(label, frac);
      try {
        if (frac >= 1) BU.onStep('done');
        else if (frac >= 0.6) BU.onStep('mix');
        else if (frac >= 0.25) BU.onStep('beat');
        else BU.onStep('vocals');
      } catch (e) {}
    };
    Promise.resolve()
      .then(function () {
        if (src === 'builtin') return RM.mashup.buildAuto(ms.slot1.buffer, BU.selectedStyle, onProg, BU.onStep);
        return RM.mashup.build(ms.slot1.buffer, ms.slot2.buffer, onProgSong2);
      })
      .then(function (res) {
        done = true;
        try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (e) {}
        var buf = res && res.buffer ? res.buffer : (res instanceof AudioBuffer ? res : null);
        if (!buf) throw new Error('Mashup build produced no audio.');
        var m = (res && res.meta) || {};
        // Honest engine label from the real per-call provider tags (Worker 4):
        // never claim DSP when neural stems were used, or vice versa.
        var tagV = m.engineTagVocal || '', tagI = m.engineTagInstr || '';
        var engineLabel = 'Smart DSP engine';
        // HONESTY: the fallback tag 'smart DSP (neural failed)' contains the
        // word "neural" — it must NOT count as neural (the actual engine was
        // DSP). Only a real neural success tag ('neural stems') counts.
        var neuralV = /neural/i.test(tagV) && !/neural failed/i.test(tagV),
            neuralI = /neural/i.test(tagI) && !/neural failed/i.test(tagI);
        if (neuralV && neuralI) engineLabel = 'Neural stems engine';
        else if (neuralV || neuralI) engineLabel = 'Smart DSP + neural stems';
        else if (/failed/i.test(tagV + ' ' + tagI)) engineLabel = 'Smart DSP engine (neural unavailable)';
        ms.result = {
          buffer: buf,
          meta: m,
          engine: engineLabel,
        };
        // Friendly export name: picked song(s) (+ built-in beat style name).
        try {
          var nm = 'Mashup ' + (ms.slot1.name || 'A') + ' x ';
          if (src === 'builtin') {
            var stN = BU.styleById(BU.selectedStyle);
            nm += (stN && stN.name) ? stN.name + ' Beat' : (BU.selectedStyle ? 'Built-in Beat' : 'Auto Beat');
          } else {
            nm += (ms.slot2.name || 'B');
          }
          ms.result.meta.name = nm;
          // W5 export uses meta.style for the "RuhMix-mashup-<style>.mp3" filename.
          ms.result.meta.style = (src === 'builtin') ? (BU.selectedStyle || 'auto') : 'song2';
        } catch (e) {}
        setBuildUI(false);
        var meta = $('mashup-meta');
        if (meta) meta.textContent = formatMeta(m);
        var tag = $('mashup-engine-tag');
        if (tag) tag.textContent = '⚙️ ' + ms.result.engine;
        var r = $('mashup-result');
        if (r) r.hidden = false;
        var play = $('mashup-play');
        if (play) play.textContent = '▶ Preview';
        a.toast('Mashup ready ✨');
      })
      .catch(function (e) {
        done = true;
        try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (err) {}
        fail(e);
      });
  }

  /* ================= preview (user tap only — NEVER autoplay) ================= */

  function stopPreview() {
    if (ms.pvSrc) {
      try { ms.pvSrc.onended = null; ms.pvSrc.stop(); } catch (e) {}
      try { ms.pvSrc.disconnect(); } catch (e) {}
      ms.pvSrc = null;
    }
    // Also stop any beat-card preview so mix preview and beat preview never overlap.
    try { if (RM.BeatsPreview && typeof RM.BeatsPreview.stop === 'function') RM.BeatsPreview.stop(); } catch (e) {}
    var play = $('mashup-play');
    if (play) play.textContent = '▶ Preview';
  }

  function isPreviewing() { return !!ms.pvSrc; }

  function togglePreview() {
    var a = A();
    if (!a) return;
    if (isPreviewing()) { stopPreview(); return; } // user tap -> stop
    if (!ms.result || !ms.result.buffer) { a.toast('Create a mashup first ✨'); return; }
    // Stop any beat-card preview first — mix preview and beat preview never overlap.
    try { if (RM.BeatsPreview && typeof RM.BeatsPreview.stop === 'function') RM.BeatsPreview.stop(); } catch (e) {}
    // User tapped ▶ — the ONLY place preview ever starts. No autoplay anywhere.
    try {
      var ctx = RM.audio.ensureCtx();
      var src = ctx.createBufferSource();
      src.buffer = ms.result.buffer;
      src.connect(RM.audio.masterIn());
      src.onended = function () { if (ms.pvSrc === src) stopPreview(); };
      ms.pvSrc = src;
      src.start();
      var play = $('mashup-play');
      if (play) play.textContent = '⏸ Stop';
    } catch (e) {
      stopPreview();
      a.toast(a.cleanErrMsg(e) || 'Could not start preview.');
    }
  }

  /* ================= export ================= */

  function doExport() {
    var a = A();
    if (!a) return;
    if (!ms.result || !ms.result.buffer) { a.toast('Create a mashup first ✨'); return; }
    if (!RM.mashupExport || typeof RM.mashupExport.sendToExport !== 'function') {
      a.toast('Export module not ready — update the app and retry.');
      return;
    }
    try {
      RM.mashupExport.sendToExport(ms.result.buffer, ms.result.meta);
    } catch (e) {
      a.toast(a.cleanErrMsg(e) || 'Could not hand off to export.');
    }
  }

  /* ================= W2: beat source + built-in beats + step indicator =========== */

  var BU = (RM.BeatsUI = RM.BeatsUI || {});
  BU.beatSource = 'builtin';   // 'builtin' (default) | 'song2'
  BU.selectedStyle = null;     // RM.Beats style id (W1 module)

  var CONSENT_BUILTIN = 'Built-in original beat (copyright-free, synthesized in-app) • vocals auto-matched. No fake AI claims.';
  var CONSENT_SONG2 = 'Smart DSP vocal isolation • tempo & key auto-matched. No fake AI claims.';
  var STEP2_BUILTIN = '🎹 Creating copyright-free beat…';
  var STEP2_SONG2 = '🥁 Preparing Song 2 beat…';

  function beatStyles() {
    try {
      var s = RM.Beats && RM.Beats.STYLES;
      return (s && s.length) ? s : [];
    } catch (e) { return []; }
  }

  BU.styleById = function (id) {
    var styles = beatStyles();
    for (var i = 0; i < styles.length; i++) if (styles[i] && styles[i].id === id) return styles[i];
    return null;
  };

  // Hook for W4 (beat preview playback). W4 implements RM.BeatsPreview.play
  // or RM.Beats.preview; until then this degrades to a toast. NEVER autoplays
  // on its own — it fires only from the user's tap on a card's ▶ button.
  BU.onPreviewClick = function (styleId) {
    var a = A();
    try {
      // Stop the mix preview first so beat preview and mix preview never overlap.
      if (RM.mashupScreen && typeof RM.mashupScreen.stopPreview === 'function') RM.mashupScreen.stopPreview();
    } catch (e) {}
    try {
      if (RM.BeatsPreview && typeof RM.BeatsPreview.play === 'function') { RM.BeatsPreview.play(styleId); return; }
      if (RM.Beats && typeof RM.Beats.preview === 'function') { RM.Beats.preview(styleId); return; }
    } catch (e) {}
    if (a) a.toast('Beat preview coming soon 🎹');
  };

  function selectStyle(id) {
    // id may be null = "Auto" (engine picks nearest-BPM style itself).
    BU.selectedStyle = id;
    var grid = $('mashup-beat-grid');
    if (!grid) return;
    var cards = grid.querySelectorAll('.beat-card');
    for (var i = 0; i < cards.length; i++) {
      var cid = cards[i].getAttribute('data-style') || null;
      cards[i].classList.toggle('sel', cid === id);
    }
  }

  // "✨ Auto" card — lets the engine pick the nearest-BPM style automatically.
  function renderAutoCard(grid) {
    var card = document.createElement('div');
    card.className = 'beat-card beat-auto';
    card.setAttribute('data-style', '');
    var main = document.createElement('div');
    main.className = 'bc-main';
    var nm = document.createElement('div');
    nm.className = 'bc-name';
    nm.textContent = '✨ Auto';
    var meta = document.createElement('div');
    meta.className = 'bc-meta';
    meta.textContent = 'Matches your song\u2019s tempo';
    main.appendChild(nm);
    main.appendChild(meta);
    card.appendChild(main);
    card.addEventListener('click', function () { selectStyle(null); });
    grid.appendChild(card);
  }

  // Renders the 8 beat cards from W1's RM.Beats.STYLES. Defensive: an empty
  // grid (with a placeholder note) when the module isn't loaded yet.
  BU.renderBeats = function () {
    var grid = $('mashup-beat-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var styles = beatStyles();
    if (!styles.length) {
      var ph = document.createElement('div');
      ph.className = 'muted small';
      ph.textContent = 'Beat styles loading…';
      grid.appendChild(ph);
      return;
    }
    renderAutoCard(grid);
    styles.forEach(function (st) {
      if (!st || !st.id) return;
      var card = document.createElement('div');
      card.className = 'beat-card';
      card.setAttribute('data-style', st.id);
      var main = document.createElement('div');
      main.className = 'bc-main';
      var nm = document.createElement('div');
      nm.className = 'bc-name';
      nm.textContent = st.name || st.id;
      var meta = document.createElement('div');
      meta.className = 'bc-meta';
      meta.textContent = (st.bpm ? st.bpm + ' BPM' : '') + (st.desc ? ' • ' + st.desc : '');
      main.appendChild(nm);
      main.appendChild(meta);
      var prev = document.createElement('button');
      prev.className = 'btn small beat-prev';
      prev.setAttribute('data-style', st.id);
      prev.setAttribute('aria-label', 'Preview ' + (st.name || st.id));
      prev.textContent = '▶';
      prev.addEventListener('click', function (e) { e.stopPropagation(); BU.onPreviewClick(st.id); });
      card.appendChild(main);
      card.appendChild(prev);
      card.addEventListener('click', function () { selectStyle(st.id); });
      grid.appendChild(card);
    });
    // Default = Auto (engine picks the nearest-BPM style itself).
    if (BU.selectedStyle) selectStyle(BU.selectedStyle);
    else selectStyle(null);
  };

  BU.setBeatSource = function (src) {
    if (src !== 'builtin' && src !== 'song2') return;
    BU.beatSource = src;
    var sb = $('mashup-src-builtin'), ss = $('mashup-src-song2');
    if (sb) sb.classList.toggle('on', src === 'builtin');
    if (ss) ss.classList.toggle('on', src === 'song2');
    var bw = $('mashup-beats-wrap'), sw = $('mashup-song2-wrap');
    if (bw) bw.hidden = src !== 'builtin';
    if (sw) sw.hidden = src !== 'song2';
    var h = $('mashup-honest');
    if (h) h.textContent = src === 'builtin' ? CONSENT_BUILTIN : CONSENT_SONG2;
    var s2li = $('mstep-beat'), s2lb = s2li ? s2li.querySelector('.mstep-label') : null;
    if (s2lb) s2lb.textContent = src === 'builtin' ? STEP2_BUILTIN : STEP2_SONG2;
    // v21: source switch pe purana result card clear — warna Preview/Export
    // purane (doosre flow ke) mashup pe chalta rehta. Sirf UI staleness thi.
    try { stopPreview(); } catch (e) {}
    ms.result = null;
    var r = $('mashup-result');
    if (r) r.hidden = true;
    BU.resetSteps();
  };

  /* ---- 3-step indicator: W3's engine calls BU.onStep('vocals'|'beat'|'mix'|'done') ---- */

  var STEP_ORDER = ['vocals', 'beat', 'mix'];

  BU.resetSteps = function () {
    STEP_ORDER.forEach(function (k) {
      var li = $('mstep-' + k);
      if (li) li.classList.remove('active', 'done');
    });
  };

  BU.onStep = function (step) {
    var i = STEP_ORDER.indexOf(step);
    STEP_ORDER.forEach(function (k, j) {
      var li = $('mstep-' + k);
      if (!li) return;
      li.classList.remove('active', 'done');
      if (step === 'done' || (i >= 0 && j < i)) li.classList.add('done');
      else if (j === i) li.classList.add('active');
    });
  };

  /* ================= wiring ================= */

  function wire() {
    if (ms._wired) return;
    ms._wired = true;
    var p1 = $('mashup-pick1'), p2 = $('mashup-pick2');
    if (p1) p1.addEventListener('click', function () { requestPick(1); });
    if (p2) p2.addEventListener('click', function () { requestPick(2); });
    var makeB = $('mashup-make');
    if (makeB) makeB.addEventListener('click', make);
    // v21: Cancel — cooperative: aborts the in-flight neural call and lets
    // the pipeline stages throw {kind:'cancelled'} at the next boundary.
    var cancelB = $('mashup-cancel');
    if (cancelB) cancelB.addEventListener('click', function () {
      try {
        if (RM.mashupStems && typeof RM.mashupStems.requestCancel === 'function')
          RM.mashupStems.requestCancel();
      } catch (e) {}
      setProgress('Cancelling…', 0);
    });
    var playB = $('mashup-play');
    if (playB) playB.addEventListener('click', togglePreview);
    var expB = $('mashup-export');
    if (expB) expB.addEventListener('click', doExport);
    // W2: beat source segmented control + built-in beat cards.
    var sb = $('mashup-src-builtin'), ss = $('mashup-src-song2');
    if (sb) sb.addEventListener('click', function () { BU.setBeatSource('builtin'); });
    if (ss) ss.addEventListener('click', function () { BU.setBeatSource('song2'); });
    BU.renderBeats();
    BU.setBeatSource(BU.beatSource || 'builtin');
    renderNames();
  }

  // Chain onto RM.app.onShow (same pattern as ux-flow.js / ai-stems.js):
  // leaving the mashup screen always stops preview; abandoning the import
  // screen clears a stale pending pick so later loads can't be hijacked.
  //
  // CAREFUL: app.js init() ASSIGNS A.onShow directly (no chaining), and it
  // runs on DOMContentLoaded AFTER this file's boot listener was registered
  // (script order). So an early wrap would be wiped out — re-assert until
  // the hook sticks. Re-wrapping is safe: we skip when A.onShow is already
  // our hook, and otherwise chain onto whatever is there.
  function wrapOnShow() {
    var a = A();
    if (!a || a.onShow === ms._hook) return;
    var prev = a.onShow;
    ms._hook = function (name) {
      try { if (typeof prev === 'function') prev(name); } catch (e) {}
      try {
        if (name !== 'mashup') stopPreview();
        if (name !== 'import' && name !== 'mashup' && ms.pickTarget) ms.pickTarget = 0;
      } catch (e) {}
    };
    a.onShow = ms._hook;
  }

  // This file loads BEFORE app.js (script order) — poll until RM.app exists,
  // then install the onShow hook with delayed re-asserts (see wrapOnShow).
  function ready(attempts) {
    if (RM.app && $('mashup-pick1')) {
      wire();
      wrapOnShow();
      setTimeout(wrapOnShow, 600);
      setTimeout(wrapOnShow, 2000);
      return;
    }
    if (attempts <= 0) return;
    setTimeout(function () { ready(attempts - 1); }, 200);
  }
  function boot() { ready(50); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  RM.mashupScreen = {
    onPicked: onPicked,
    requestPick: requestPick,
    stopPreview: stopPreview,
    getResult: function () { return ms.result; },
    // W2/W3: 3-step progress receiver — the engine calls it with
    // 'vocals' | 'beat' | 'mix' | 'done'.
    onStep: function (s) { return BU.onStep(s); },
  };
  // pickTarget is a live accessor so app.js interception always sees the
  // current value, and onPicked clearing it internally stays in sync.
  Object.defineProperty(RM.mashupScreen, 'pickTarget', {
    get: function () { return ms.pickTarget; },
    set: function (v) { ms.pickTarget = v ? 1 * v : 0; },
    configurable: true,
  });
})();
