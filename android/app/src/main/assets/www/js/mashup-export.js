'use strict';
/* =====================================================================
   RuhMix — mashup-export.js
   Bridge: 🤖 Auto Mashup  ->  v25 Export overlay (RM.v25exportui).

   Contract: RM.mashupExport.sendToExport(audioBuffer, meta)
     - audioBuffer: AudioBuffer with the fully-built mashup mix. This also
       covers the W3 beat-mashup: RM.Mashup.makeWithBeat() returns the final
       mixed AudioBuffer (vocals + synthesized beat, loudness-matched,
       peak-limited) — a normal AudioBuffer, no special-casing needed.
     - meta (optional): { name, style, stop } where `stop` is a function
       that stops any mashup preview playback owned by the mashup builder,
       and `style` is the beat style (W3) used for the export filename.

   Mechanism (v26 — the v25 export OVERLAY, RM.v25exportui):
     1. Stop mashup preview playback (meta.stop, then RM.mashup.stopPreview,
        then the main studio player as a defensive last resort). Nothing
        autoplays after this.
     2. RM.v25exportui.show(buffer, meta, { name }) — "Your Mashup Is Ready":
        the v25 Smart Check (RM.v25qc.runCheck, 11 real DSP scans) runs on the
        finished buffer with the builder's arrangement meta; "Fix Issues"
        applies real DSP repairs (RM.v25qc.fixAll) and re-checks; the §25
        copyright notice has a MANDATORY per-session checkbox (export/share
        stay disabled until ticked); MP3/WAV/FLAC + bitrate/sample-rate
        selectors; real progress; save via the EXISTING deliver path
        (RM.exp.deliver -> Music/RuhMix/); share. The mashup is a FINISHED
        mix: the overlay's exportPipeline encodes the buffer directly
        (resample -> int16 -> MP3/WAV/FLAC), exactly as previewed — no studio
        compressor, no re-render, no effect tail.
        Filename (v23): derived from meta.style (unchanged) —
          'mega'      -> "RuhMix-mashup-mega-<N>songs" (N = meta.songCount
                        or meta.songs.length; no suffix if unknown)
          'swap'      -> "RuhMix-mashup-swap"
          'song2'     -> "RuhMix-mashup-song2"
          beat-style  -> "RuhMix-mashup-<style>" (e.g. hiphop, trap, auto)
          no style    -> meta.name || "AI Mashup" (classic friendly name)
        The overlay sanitizes the base and appends the chosen extension
        (.mp3/.wav/.flac), so the extension is NOT added here.
     3. Fallback: if RM.v25exportui is missing (should never happen — the
        script is bundled), the old classic-screen handoff runs unchanged:
        A.state.exportSource = { kind: 'buffer', buffer, name, fx, tail } —
        the slot app.js refreshExportSource() already understands, then
        A.show('export').

   Long buffers (5–12 min, v23 mega): the handoff passes the AudioBuffer
   BY REFERENCE — the overlay holds the reference; nothing is serialized,
   copied, or re-rendered by this bridge. All downstream encoders are
   long-buffer safe (chunked): MP3/WAV/FLAC + blobToBase64 + deliver()
   (v22 MediaStore -> Music/RuhMix/) as before.

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
    // v26: route through the v25 export overlay (QC smart check + mandatory
    // §25 copyright checkbox + MP3/WAV/FLAC + progress + Music/RuhMix save
    // + share). Positional form: show(buffer, meta, opts).
    try {
      if (window.RM && RM.v25exportui && typeof RM.v25exportui.show === 'function') {
        RM.v25exportui.show(buf, meta, { name: lastName });
        return true;
      }
    } catch (e) { /* fall through to the classic screen below */ }
    // Fallback — overlay module missing: the classic export screen handoff
    // (pre-v26 mechanism). Do NOT touch state.buffer/viewBuffer — the
    // editor's current project stays exactly as it was.
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
