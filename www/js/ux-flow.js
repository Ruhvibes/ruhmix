'use strict';
/* =====================================================================
   RuhMix — ux-flow.js
   Demand 1 (Music super-simple) + Demand 2 (Export har jagah).
   window.RM.ux module. Uses only the public RM.app API — no edits in
   app.js. Coordinator patches (see report): switchImportTab export,
   getMixerTracks export, export done/cancel par wapas origin screen.
   ===================================================================== */
window.RM = window.RM || {};

(function () {
  var RM = window.RM;
  function A() { return RM.app || null; }
  function $(id) { return document.getElementById(id); }

  var ux = { origin: null, _wrapped: false, _wired: false };

  function hasMusicBridge() {
    try {
      return !!(RM.audio && RM.audio.native && RM.audio.native.method('listMusic'));
    } catch (e) { return false; }
  }

  // switchImportTab-equivalent DOM toggle — fallback only (when there is
  // no bridge, initImportTabs wires no listeners, so force the Files tab).
  function forceTab(which) {
    var tabF = $('tab-files'), tabM = $('tab-music');
    var paneF = $('pane-files'), paneM = $('pane-music');
    if (tabF) tabF.classList.toggle('active', which === 'files');
    if (tabM) tabM.classList.toggle('active', which === 'music');
    if (paneF) paneF.hidden = which !== 'files';
    if (paneM) paneM.hidden = which !== 'music';
  }

  // Import screen khulne par Music tab preselect + list auto-load.
  function ensureMusicTab() {
    var a = A();
    if (!a) return;
    var tabM = $('tab-music'), tabF = $('tab-files');
    if (!tabM || !tabF) return;
    if (hasMusicBridge()) {
      // Coordinator patch ke baad: A.switchImportTab('music').
      if (typeof a.switchImportTab === 'function') {
        try { a.switchImportTab('music'); return; } catch (e) {}
      }
      // initImportTabs ne click listener wire kiya hai ->
      // switchImportTab('music') -> loadMusic(). Pehle se active tab par
      // click bhi handler chalata hai, isliye idempotent hai.
      tabM.click();
      return;
    }
    if (typeof a.switchImportTab === 'function') {
      try { a.switchImportTab('files'); return; } catch (e) {}
    }
    forceTab('files');
  }

  // Demand 1: Home -> bada "Pick Music" button. 2 taps: button + song.
  function pickMusic() {
    var a = A();
    if (!a) return;
    try {
      if (!a.state.project) a.newProject();
      else a.show('import');
    } catch (e) { return; }
    ensureMusicTab();
  }

  /* ================= Demand 2: export har screen se ================= */

  function currentBuf() {
    var a = A();
    return (a.state.viewBuffer || a.state.buffer) || null;
  }

  function explicitSrc(buffer, name) {
    if (!buffer) return null;
    // refreshExportSource() isko "Selected" option banakar auto-check karta hai.
    return { kind: 'buffer', buffer: buffer, name: name || 'audio' };
  }

  // Access to mixer tracks — coordinator patch: A.getMixerTracks().
  function mixerTracks() {
    var a = A();
    if (a && typeof a.getMixerTracks === 'function') {
      try { return a.getMixerTracks() || []; } catch (e) { return []; }
    }
    return null; // patch pending: mixdown render nahi ho sakta
  }

  // Mixer mixdown: audible tracks (vol/pan/mute/solo) ka offline render.
  function renderMixdown() {
    var tracks = mixerTracks();
    if (!tracks) return Promise.resolve(null);
    var audible = tracks.filter(function (t) { return t && t.buffer; });
    if (!audible.length) return Promise.resolve(null);
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) return Promise.resolve(null);
    try {
      var sr = 44100, dur = 0, i;
      for (i = 0; i < audible.length; i++) dur = Math.max(dur, audible[i].buffer.duration);
      var oc = new OC(2, Math.max(1, Math.ceil((dur + 0.5) * sr)), sr);
      var anySolo = tracks.some(function (x) { return x.solo && x.buffer; });
      audible.forEach(function (t) {
        if (t.mute || (anySolo && !t.solo)) return;
        var src = oc.createBufferSource();
        src.buffer = t.buffer;
        var g = oc.createGain();
        g.gain.value = (t.vol == null ? 0.9 : t.vol);
        src.connect(g);
        if (oc.createStereoPanner) {
          var p = oc.createStereoPanner();
          p.pan.value = t.pan || 0;
          g.connect(p);
          p.connect(oc.destination);
        } else {
          g.connect(oc.destination);
        }
        src.start(0);
      });
      return oc.startRendering();
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // Mastered buffer: current project par mastering chain ka offline render.
  function renderMastered() {
    var a = A();
    var b = currentBuf();
    if (!b) return Promise.resolve(null);
    try {
      var settings = (a.state.mastering && a.state.mastering.settings) || {};
      return RM.exp.renderOffline(b, function (oc, srcNode) {
        var chain = RM.fx.makeMasterChain(oc, settings);
        srcNode.connect(chain.input);
        return chain.output;
      }, { sampleRate: b.sampleRate, tail: 0 });
    } catch (e) {
      return Promise.resolve(b);
    }
  }

  function resolveSource(from) {
    var a = A();
    var name = a.state.fileName || 'audio';
    var done = function (v) { return Promise.resolve(v); };
    switch (from) {
      case 'editor':
      case 'slowed':
        return done(explicitSrc(currentBuf(), name));
      case 'record': {
        var imp = (a.state.imports && a.state.imports[0]) || null;
        return done(explicitSrc(currentBuf() || (imp && imp.buffer), name));
      }
      case 'remix': {
        var rb = a.state.remixBuffer;
        return done(explicitSrc(rb || currentBuf(), rb ? (a.state.remixBufferName || 'remix') : name));
      }
      case 'stems': {
        if (a.state.stemMix) return done(explicitSrc(a.state.stemMix, 'stem-mix'));
        var rs = (RM.stems && RM.stems.results) || [];
        if (rs.length === 1 && rs[0] && rs[0].buffer) return done(explicitSrc(rs[0].buffer, rs[0].name));
        return done(null); // kayi stems: user radio list se khud chune
      }
      case 'mixer':
        return renderMixdown().then(function (b) { return explicitSrc(b, 'mixdown'); });
      case 'master':
        return renderMastered().then(function (b) { return explicitSrc(b, 'mastered-' + name); });
      default:
        return done(explicitSrc(currentBuf(), name));
    }
  }

  // Har screen ke header Export button ka shared handler.
  function openExport(fromScreen) {
    var a = A();
    if (!a) return;
    if (!a.needAudio()) return; // existing guard: toast + import screen
    ux.origin = fromScreen || null;
    resolveSource(fromScreen).then(function (src) {
      a.state.exportSource = src; // null -> export screen ki poori radio list
      a.show('export');
      a.refreshExportSource();
    }).catch(function () {
      a.state.exportSource = null;
      a.show('export');
      a.refreshExportSource();
    });
  }

  // Export complete/cancel ke baad (coordinator patch app.js me ye call
  // karega) wapas origin screen par.
  function onExportFinished() {
    var o = ux.origin;
    ux.origin = null;
    var a = A();
    if (o && a) { try { a.show(o); } catch (e) {} }
  }

  /* ================= wiring ================= */

  function wire() {
    if (ux._wired) return;
    ux._wired = true;
    var btns = document.querySelectorAll('.ux-export-btn');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { openExport(b.getAttribute('data-from')); });
      })(btns[i]);
    }
    var pm = $('home-pick-music');
    if (pm) pm.addEventListener('click', pickMusic);
  }

  // RM.app.init() ke baad onShow wrap karo taaki import screen jab bhi
  // khule, Music tab preselected + loaded rahe. ai-stems.js bhi onShow wrap
  // ai-stems.js also wraps onShow — calling prev keeps the chain intact.
  function wrapOnShow() {
    var a = A();
    if (!a || ux._wrapped) return;
    ux._wrapped = true;
    var prev = a.onShow;
    a.onShow = function (name) {
      try { if (typeof prev === 'function') prev(name); } catch (e) {}
      try { if (name === 'import') ensureMusicTab(); } catch (e) {}
    };
  }

  function boot() { wrapOnShow(); wire(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  RM.ux = {
    pickMusic: pickMusic,
    ensureMusicTab: ensureMusicTab,
    openExport: openExport,
    onExportFinished: onExportFinished,
    returnToOrigin: onExportFinished,
    getOrigin: function () { return ux.origin; },
  };
})();
