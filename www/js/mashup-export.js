'use strict';
/* =====================================================================
   RuhMix — mashup-export.js
   Bridge: 🤖 Auto Mashup  ->  existing Export screen.

   Contract: RM.mashupExport.sendToExport(audioBuffer, meta)
     - audioBuffer: AudioBuffer with the fully-built mashup mix. This also
       covers the W3 beat-mashup: RM.Mashup.makeWithBeat() returns the final
       mixed AudioBuffer (vocals + synthesized beat, loudness-matched,
       peak-limited) — a normal AudioBuffer, no special-casing needed.
     - meta (optional): { name, style, stop } where `stop` is a function
       that stops any mashup preview playback owned by the mashup builder,
       and `style` is the beat style (W3) used for the export filename.

   Mechanism (reuses the app's own explicit-source hook, same as the
   Stem-deck "Export" buttons in stem-deck.js — export.js untouched):
     1. Stop mashup preview playback (meta.stop, then RM.mashup.stopPreview,
        then the main studio player as a defensive last resort). Nothing
        autoplays after this.
     2. A.state.exportSource = { kind: 'buffer', buffer, name, fx, tail } —
        the slot app.js refreshExportSource() already understands: it
        unshifts a "🎯 Selected: <name>" radio option and auto-checks it.
        fx = flatFx() (compressor OFF) and tail = 0 because the mashup is a
        FINISHED mix: the preview plays buffer -> masterIn() (brickwall
        limiter + safety clip only, no studio compressor), so exporting
        through A.defaultFx() (comp ON, -18 dB / 4:1) would squash the W3
        loudness balance and pump the beat's transients. flatFx matches the
        preview path exactly — same treatment as the finished stem-mix and
        remix-buffer exports. tail = 0: no 2.5 s of dead air appended.
     3. RM.app.show('export') — the app's own navigation. The onShow hook
        (app.js init) calls refreshExportSource() + syncExpDefaults(), so
        the mashup is selected with current format/bitrate defaults and
        MP3 (128/192/256/320), WAV, FLAC + Share all work unchanged.
        Filename (v23): derived from meta.style —
          'mega'      -> "RuhMix-mashup-mega-<N>songs" (N = meta.songCount
                        or meta.songs.length; no suffix if unknown)
          'swap'      -> "RuhMix-mashup-swap"
          'song2'     -> "RuhMix-mashup-song2"
          beat-style  -> "RuhMix-mashup-<style>" (e.g. hiphop, trap, auto)
          no style    -> meta.name || "AI Mashup" (classic friendly name)
        The export screen sanitizes the base and appends the chosen
        extension (.mp3/.wav/.flac), so the extension is NOT added here.

   Long buffers (5–12 min, v23 mega): the handoff passes the AudioBuffer
   BY REFERENCE — A.state.exportSource only holds the reference; nothing
   is serialized, copied, or re-rendered by this bridge. refreshExportSource
   wraps it in a get() closure for the radio option; doExport picks it up
   by reference. All downstream encoders are long-buffer safe (chunked):
     - MP3: export.js encodeMp3 — 1152*32-sample steps via setTimeout,
       per-chunk progress + cancel token (resampleBuffer/floatToInt16
       before it are chunked too, audio-engine.js).
     - WAV: audio-engine.js encodeWavBuffer — runChunked(1<<18) per-sample
       loop, per-chunk progress.
     - FLAC: export.js encodeFlac — chunked MD5 pass (1<<18) + per-frame
       frameStep (4096-sample blocks) via setTimeout, progress 0→1,
       cancel token.
     - Saving: blobToBase64 is chunked (0x8000) with progress; deliver()
       (v22) goes MediaStore -> Music/RuhMix/ first, cache/browser fallback
       intact. Share (saveFile -> shareFile / shareAudioUri) untouched.

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

  // Finished-mix FX for the export render: flatFx() = defaultFx with the
  // compressor OFF, everything else neutral. Matches the mashup preview
  // path (buffer -> masterIn: limiter + safety clip, no comp), so the W3
  // loudness match (vocals + beat) exports exactly as previewed. Same
  // treatment the finished stem-mix / remix-buffer exports already get.
  function finishedMixFx() {
    try {
      var A = app();
      if (A && typeof A.flatFx === 'function') return A.flatFx();
    } catch (e) {}
    return null;
  }

  // v23 filename scheme, derived from meta.style (style ids come from the
  // mashup builders: 'mega'/'swap' from the v23 workers, 'song2' for the
  // classic Song1+Song2 flow, a beat-style id for built-in-beat mashups):
  //   mega  -> "RuhMix-mashup-mega-<N>songs"   (N from meta.songCount,
  //            else meta.songs.length; no suffix when unknown)
  //   swap  -> "RuhMix-mashup-swap"
  //   song2 / beat-style / auto -> "RuhMix-mashup-<style>"
  //   no style -> meta.name || "AI Mashup" (classic friendly name)
  // Base name only — the export screen appends the chosen extension
  // (.mp3/.wav/.flac) after sanitizing, so never add one here.
  function exportName(meta) {
    meta = meta || {};
    var raw = meta.style != null ? String(meta.style).trim().toLowerCase() : '';
    // Keep only filename-safe chars from a worker-supplied style id.
    var style = raw.replace(/[^a-z0-9_-]/g, '');
    if (!style) return meta.name || 'AI Mashup';
    if (style === 'mega') {
      var n = 0;
      if (typeof meta.songCount === 'number' && isFinite(meta.songCount)) {
        n = Math.floor(meta.songCount);
      } else if (meta.songs && typeof meta.songs.length === 'number') {
        n = meta.songs.length;
      }
      return n > 0 ? 'RuhMix-mashup-mega-' + n + 'songs' : 'RuhMix-mashup-mega';
    }
    if (style === 'swap') return 'RuhMix-mashup-swap';
    return 'RuhMix-mashup-' + style;
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
    // Filename: v23 style-derived scheme (see exportName above); classic
    // mashup keeps its friendly "Mashup A x B" name when no style is set.
    lastName = exportName(meta);
    // Established explicit-source hook (see refreshExportSource in
    // app.js: {kind:'buffer'} unshifts "🎯 Selected: <name>" and checks
    // it). Do NOT touch state.buffer/viewBuffer — the editor's current
    // project stays exactly as it was.
    var es = { kind: 'buffer', buffer: buf, name: lastName };
    // Finished mix: flat FX (no studio compressor — the beat must render
    // exactly as W3 loudness-matched it) and no effect tail appended.
    var ffx = finishedMixFx();
    if (ffx) es.fx = ffx;
    es.tail = 0;
    A.state.exportSource = es;
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
