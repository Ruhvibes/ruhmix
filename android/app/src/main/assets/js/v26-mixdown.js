/* RuhMix v26 — Worker I5: mixer mixdown export + mastering→export.
 *
 * RM.v26mixdown:
 *   renderMixerOffline(tracks, opts) -> Promise<AudioBuffer>
 *     Offline render of the 6-track mixer, replicating the live mixer graph
 *     (app.js applyTrackMix + audio-engine makePlayer): per track
 *       AudioBufferSource(buffer) -> Gain(vol × mute/solo gate) ->
 *       StereoPanner(pan) -> master gain -> destination.
 *     anySolo rule matches live: any solo track with a buffer => only solo
 *     tracks are audible; muted tracks are always gated to 0.
 *   applyMasterChainOffline(oc, inNode, settings) -> { out, chain }
 *     Inserts the SAME fx.makeMasterChain graph (fx.js) used by the
 *     mastering screen into an OfflineAudioContext graph, seeded with the
 *     CURRENT mst-* settings. Caller must chain.dispose() after rendering.
 *   masteringEnabled() -> bool — the "Apply to export" toggle state.
 *   exportMixerMix() — "Export Mix" button: renders the mixdown, hands the
 *     finished buffer to the existing export flow (format choice, progress,
 *     Music/RuhMix delivery) as the selected source.
 */
(function () {
  'use strict';

  function A() { return (window.RM && RM.app) || null; }

  /* ================= mixer mixdown ================= */

  function renderMixerOffline(tracks, opts) {
    opts = opts || {};
    const sr = opts.sampleRate || 44100;
    const list = (tracks || []).filter((t) => t && t.buffer);
    if (!list.length) return Promise.reject(new Error('No tracks loaded'));
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) return Promise.reject(new Error('OfflineAudioContext not supported.'));
    let dur = 0;
    list.forEach((t) => { if (t.buffer.duration > dur) dur = t.buffer.duration; });
    const tail = opts.tail != null ? Math.max(0, opts.tail) : 0.5;
    dur += tail;
    let oc;
    try {
      oc = new OC(2, Math.max(1, Math.ceil(dur * sr)), sr);
    } catch (e) {
      return Promise.reject(e);
    }
    // Master bus — same unity-gain role as the live master; kept at 1.0 so
    // the mixdown sounds exactly like the live mix (vol/pan/mute/solo only).
    const master = oc.createGain();
    master.gain.value = (opts.master != null ? opts.master : 1.0);
    master.connect(oc.destination);
    // Live rule (app.js applyTrackMix): any solo track with a buffer =>
    // non-solo tracks gated; muted tracks always gated.
    const anySolo = list.some((x) => x.solo && x.buffer);
    list.forEach((t) => {
      const audible = !t.mute && (!anySolo || t.solo);
      const src = oc.createBufferSource();
      src.buffer = t.buffer;
      const g = oc.createGain();
      g.gain.value = audible ? (t.vol == null ? 0.9 : t.vol) : 0;
      src.connect(g);
      if (oc.createStereoPanner) {
        const p = oc.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, t.pan || 0));
        g.connect(p);
        p.connect(master);
      } else {
        g.connect(master);
      }
      src.start(0);
    });
    return oc.startRendering();
  }

  /* ================= mastering -> export ================= */

  function masteringEnabled() {
    const a = A();
    return !!(a && a.state && a.state.mastering && a.state.mastering.applyToExport);
  }

  function currentMasterSettings() {
    const a = A();
    const m = a && a.state && a.state.mastering;
    const s = (m && m.settings) || {};
    const clean = (window.RM && RM.fx && RM.fx.MASTER_PRESETS && RM.fx.MASTER_PRESETS.clean) || {};
    return Object.assign({}, clean, s);
  }

  // Insert the mastering chain as the FINAL stage of an offline graph:
  // inNode (previous stage output) -> chain.input ... chain.output (=out).
  function applyMasterChainOffline(oc, inNode, settings) {
    const chain = RM.fx.makeMasterChain(oc, settings || currentMasterSettings());
    inNode.connect(chain.input);
    return { out: chain.output, chain: chain };
  }

  /* ================= "Export Mix" flow ================= */

  function exportMixerMix() {
    const a = A();
    if (!a || typeof a.getMixerTracks !== 'function') {
      if (a && a.toast) a.toast('Mixer not ready');
      return;
    }
    const tracks = a.getMixerTracks() || [];
    const loaded = tracks.filter((t) => t && t.buffer);
    if (!loaded.length) { a.toast('Load audio into mixer tracks first'); return; }
    a.toast('Rendering mixdown…');
    renderMixerOffline(tracks, { tail: 0.5 }).then((buf) => {
      // Feed the EXISTING export flow: explicit source => auto-selected,
      // format choice + progress + Music/RuhMix delivery unchanged.
      a.state.exportSource = {
        kind: 'buffer', buffer: buf, name: 'mixdown',
        fx: a.flatFx(), tail: 0,
      };
      a.show('export');
      a.refreshExportSource();
      a.toast('Mixdown ready — choose format and Export');
    }).catch((e) => {
      a.toast('Mixdown failed: ' + (e && e.message ? e.message : e));
    });
  }

  /* ================= toggle + export-screen flag ================= */

  function updateExportFlag() {
    const f = document.getElementById('exp-mastering-flag');
    if (!f) return;
    if (masteringEnabled()) {
      f.style.display = '';
      f.innerHTML = '🎛️ Mastering: <b>ON</b> — the mastering chain will be applied to this export';
    } else {
      f.style.display = 'none';
    }
  }

  function init() {
    const a = A();
    // Restore persisted toggle.
    let saved = false;
    try { saved = localStorage.getItem('ruhmix.masterApplyExport') === '1'; } catch (e) {}
    if (a && a.state && a.state.mastering && a.state.mastering.applyToExport == null && saved) {
      a.state.mastering.applyToExport = true;
    }
    const el = document.getElementById('mst-apply-export');
    if (el) {
      el.checked = masteringEnabled();
      el.addEventListener('change', () => {
        const on = !!el.checked;
        const aa = A();
        if (aa && aa.state && aa.state.mastering) aa.state.mastering.applyToExport = on;
        try { localStorage.setItem('ruhmix.masterApplyExport', on ? '1' : '0'); } catch (e) {}
        updateExportFlag();
      });
    }
    // Keep the export-screen "Mastering: ON" flag in sync whenever the
    // export screen is shown. Chain onto onShow (app.js, ux-flow, ai-stems
    // all wrap it — calling prev keeps the chain intact).
    if (a && !a._v26mixdownWrapped && typeof a.onShow === 'function') {
      a._v26mixdownWrapped = true;
      const prev = a.onShow;
      a.onShow = function (name) {
        try { prev(name); } catch (e) {}
        try { if (name === 'export') updateExportFlag(); } catch (e2) {}
      };
    }
    updateExportFlag();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.RM = window.RM || {};
  RM.v26mixdown = {
    renderMixerOffline: renderMixerOffline,
    applyMasterChainOffline: applyMasterChainOffline,
    currentMasterSettings: currentMasterSettings,
    masteringEnabled: masteringEnabled,
    exportMixerMix: exportMixerMix,
    updateExportFlag: updateExportFlag,
  };
})();
