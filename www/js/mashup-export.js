'use strict';
/* =====================================================================
   RuhMix — mashup-export.js
   Bridge: 🤖 Auto Mashup  ->  existing Export screen.

   Contract: RM.mashupExport.sendToExport(audioBuffer, meta)
     - audioBuffer: AudioBuffer with the fully-built mashup mix.
     - meta (optional): { name, stop } where `stop` is a function that
       stops any mashup preview playback owned by the mashup builder.

   Mechanism (reuses the app's own explicit-source hook, same as the
   Stem-deck "Export" buttons in stem-deck.js — export.js untouched):
     1. Stop mashup preview playback (meta.stop, then RM.mashup.stopPreview,
        then the main studio player as a defensive last resort). Nothing
        autoplays after this.
     2. A.state.exportSource = { kind: 'buffer', buffer, name } — this is
        the slot app.js refreshExportSource() already understands: it
        unshifts a "🎯 Selected: <name>" radio option and auto-checks it.
     3. RM.app.show('export') — the app's own navigation. The onShow hook
        (app.js init) calls refreshExportSource() + syncExpDefaults(), so
        the mashup is selected with current format/bitrate defaults and
        MP3 (128/192/256/320), WAV, FLAC + Share all work unchanged.

   Normal editor→export flow is untouched: we only ever set
   A.state.exportSource at the moment the mashup's Export/Share button is
   tapped, and changing the radio afterwards replaces it with {idx}.
   ===================================================================== */
window.RM = window.RM || {};

RM.mashupExport = (function () {
  // Module-level ref to the last mashup so re-export works even if the
  // caller hands us nothing on a later tap.
  var lastBuffer = null;
  var lastName = null;

  function app() { return window.RM && RM.app ? RM.app : null; }

  function toast(msg) {
    try { var A = app(); if (A && typeof A.toast === 'function') A.toast(msg); } catch (e) {}
  }

  // Stop any mashup preview playback before navigating away. Order:
  // caller-provided stopper first (knows its own players), then the
  // mashup builder's own stop if another worker exposes one, then the
  // main studio player as a defensive fallback. Never throws.
  function stopPreview(meta) {
    try { if (meta && typeof meta.stop === 'function') meta.stop(); } catch (e) {}
    try {
      if (window.RM && RM.mashup && typeof RM.mashup.stopPreview === 'function') {
        RM.mashup.stopPreview();
      }
    } catch (e2) {}
    try {
      var A = app();
      if (A && A.state && A.state.player && A.state.player.playing) {
        try { A.state.player.pause(); } catch (e3) {}
      }
    } catch (e4) {}
  }

  function validBuffer(b) {
    return !!(b && typeof b.duration === 'number' && b.duration > 0 && b.length > 0);
  }

  function sendToExport(audioBuffer, meta) {
    var A = app();
    if (!A) { toast('Export unavailable'); return false; }
    meta = meta || {};
    // Re-export support: fall back to the last mashup buffer if the
    // caller passes nothing.
    var buf = audioBuffer || lastBuffer;
    if (!validBuffer(buf)) {
      // Edge: no buffer — friendly message, no navigation, no crash.
      toast('Build a mashup first, then export');
      return false;
    }
    stopPreview(meta);
    lastBuffer = buf;
    lastName = meta.name || 'AI Mashup';
    // Established explicit-source hook (see refreshExportSource in
    // app.js: {kind:'buffer'} unshifts "🎯 Selected: <name>" and checks
    // it). Do NOT touch state.buffer/viewBuffer — the editor's current
    // project stays exactly as it was.
    A.state.exportSource = { kind: 'buffer', buffer: buf, name: lastName };
    A.show('export');
    // onShow already runs refreshExportSource(); repeat defensively so a
    // race between nav and render can never leave the wrong source
    // selected.
    try { if (typeof A.refreshExportSource === 'function') A.refreshExportSource(); } catch (e) {}
    return true;
  }

  function reExport() {
    // Re-export the last mashup without needing the buffer handed again.
    return sendToExport(lastBuffer, { name: lastName || 'AI Mashup' });
  }

  function clear() {
    lastBuffer = null;
    lastName = null;
  }

  return {
    sendToExport: sendToExport,
    reExport: reExport,
    clear: clear,
  };
})();
