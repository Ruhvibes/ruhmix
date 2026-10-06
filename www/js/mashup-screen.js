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
    if (running) { var r = $('mashup-result'); if (r) r.hidden = true; }
    else hideProgress();
  }

  function fail(msg) {
    var a = A();
    setBuildUI(false);
    if (a) a.toast(a.cleanErrMsg(msg) || 'Something went wrong. Please try again.');
  }

  function make() {
    var a = A();
    if (!a || ms.building) return;
    if (!ms.slot1 || !ms.slot2) {
      a.toast(!ms.slot1 && !ms.slot2 ? 'Pick both songs first 🎤🥁' : (!ms.slot1 ? 'Pick Song 1 — Vocals first 🎤' : 'Pick Song 2 — Beat first 🥁'));
      return;
    }
    if (!RM.mashup || typeof RM.mashup.build !== 'function') {
      a.toast('Mashup engine not ready — update the app and retry.');
      return;
    }
    stopPreview();
    setBuildUI(true);
    setProgress('Analyzing…', 0);
    var done = false;
    var onProg = function (label, frac) { if (!done) setProgress(label, frac); };
    Promise.resolve()
      .then(function () { return RM.mashup.build(ms.slot1.buffer, ms.slot2.buffer, onProg); })
      .then(function (res) {
        done = true;
        var buf = res && res.buffer ? res.buffer : (res instanceof AudioBuffer ? res : null);
        if (!buf) throw new Error('Mashup build produced no audio.');
        ms.result = {
          buffer: buf,
          meta: (res && res.meta) || (ms.slot1.name + ' × ' + ms.slot2.name),
          engine: (res && res.engine) || 'Smart DSP engine',
        };
        setBuildUI(false);
        var meta = $('mashup-meta');
        if (meta) meta.textContent = ms.result.meta;
        var tag = $('mashup-engine-tag');
        if (tag) tag.textContent = '⚙️ ' + ms.result.engine;
        var r = $('mashup-result');
        if (r) r.hidden = false;
        var play = $('mashup-play');
        if (play) play.textContent = '▶ Preview';
        a.toast('Mashup ready ✨');
      })
      .catch(function (e) { done = true; fail(e); });
  }

  /* ================= preview (user tap only — NEVER autoplay) ================= */

  function stopPreview() {
    if (ms.pvSrc) {
      try { ms.pvSrc.onended = null; ms.pvSrc.stop(); } catch (e) {}
      try { ms.pvSrc.disconnect(); } catch (e) {}
      ms.pvSrc = null;
    }
    var play = $('mashup-play');
    if (play) play.textContent = '▶ Preview';
  }

  function isPreviewing() { return !!ms.pvSrc; }

  function togglePreview() {
    var a = A();
    if (!a) return;
    if (isPreviewing()) { stopPreview(); return; } // user tap -> stop
    if (!ms.result || !ms.result.buffer) { a.toast('Create a mashup first ✨'); return; }
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

  /* ================= wiring ================= */

  function wire() {
    if (ms._wired) return;
    ms._wired = true;
    var p1 = $('mashup-pick1'), p2 = $('mashup-pick2');
    if (p1) p1.addEventListener('click', function () { requestPick(1); });
    if (p2) p2.addEventListener('click', function () { requestPick(2); });
    var makeB = $('mashup-make');
    if (makeB) makeB.addEventListener('click', make);
    var playB = $('mashup-play');
    if (playB) playB.addEventListener('click', togglePreview);
    var expB = $('mashup-export');
    if (expB) expB.addEventListener('click', doExport);
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
  };
  // pickTarget is a live accessor so app.js interception always sees the
  // current value, and onPicked clearing it internally stays in sync.
  Object.defineProperty(RM.mashupScreen, 'pickTarget', {
    get: function () { return ms.pickTarget; },
    set: function (v) { ms.pickTarget = v ? 1 * v : 0; },
    configurable: true,
  });
})();
