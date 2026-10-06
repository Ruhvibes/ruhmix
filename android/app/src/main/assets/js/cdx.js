'use strict';
/* =====================================================================
   RuhMix — cdx.js
   CD-ROMantic one-tap effect engine: Home screen effect cards ko REAL
   effect pipelines se jodta hai. Koi naya DSP nahi likha gaya — sirf
   existing capabilities ka reuse:
     slowed    -> RM.remix 'slowed'    : rate 0.80 + Slowed+Reverb chain
     nightcore -> tempo 1.25x + presence/air lift (existing EQ3 block).
                  v1 me INDEPENDENT pitch-shift nahi hai (Web Audio me
                  tempo+pitch linked hain) — 1.25x tempo se pitch khud upar
                  jata hai, wahi Nightcore sound hai (remix.js PITCH_NOTE).
     spedup    -> tempo 1.5x (existing playbackRate) + gentle comp
     lofi      -> RM.remix 'lofi'       : rate 0.92 + dusty/warm chain
     vapor     -> tempo 0.85x + chorus + reverb (existing FX blocks compose)
     8d        -> existing 8D spatial mode ON (RM.fx makeSpatial), current
                  chain rehti hai — sirf spatial mode flip hota hai
     360       -> 360° spatial rotation (HRTF) ON via RM.fx makeSpatial360
                  (mode '360' inside makeSpatial), current chain rehti hai —
                  sirf spatial mode flip hota hai. Honest DSP: Web Audio HRTF
                  panning, no AI claims anywhere.
     emo       -> RM.remix 'emotional'  : rate 0.90 + hall/echo chain
     edm       -> RM.remix 'edm'        : rate 1.04 + big energetic chain
     bass      -> RM.fx.EQ_PRESETS.bass (eq3 [7,2,0]) + tight comp
     echo      -> existing echo/delay send block (existing FX)

   Card tap -> effect apply + preview auto-play (1 tap). Ye autoplay yahan
   INTENTIONAL hai: card khud "preview" hai (CD-ROMantic ka 1-tap behavior) —
   doosri screens ka autoplay rule yahan apply nahi hota.
   Dobara tap -> toggle off: effect lagne se PEHLE wali state (dry) restore
   hoti hai. Preview bajta rehta hai taaki wet/dry A-B compare ho sake.
   Active card '.on' class se highlight hota hai (cards dusre worker ne
   banaye hain: #cdx-fxgrid .cdx-fxcard[data-id], CSS .cdx-fxcard.on).

   Export: A.state.fx + project.settings.speed set hote hain (+ autosave),
   isliye Export screen ka "Current project" source wahi effected audio
   (tempo + FX) render karta hai — alag wiring ki zaroorat nahi.

   Public API (tests ke liye):
     RM.cdx.applyEffect(id) -> true (applied/toggled), false (no audio/error)
     RM.cdx.clearEffect()    -> toggle-off restore, true/false
     RM.cdx.getActive()      -> active spec id ya null
     RM.cdx.normalizeId(id)  -> card id -> spec id (ya null)
     RM.cdx.list()           -> 11 spec ids
   ===================================================================== */
window.RM = window.RM || {};

RM.cdx = (function () {
  function A() { return (window.RM && RM.app) ? RM.app : null; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Spec ids (task). Home cards ke ids se normalize hote hain.
  var IDS = ['slowed', 'nightcore', 'spedup', 'lofi', 'vapor',
             '8d', 'emo', 'edm', 'bass', 'echo', '360'];
  var ALIAS = { vaporwave: 'vapor', bassboost: 'bass', emotional: 'emo' };
  function normalizeId(id) {
    id = String(id == null ? '' : id).toLowerCase();
    if (ALIAS[id]) return ALIAS[id];
    return IDS.indexOf(id) >= 0 ? id : null;
  }

  var LABELS = {
    slowed: 'Slowed+Reverb', nightcore: 'Nightcore', spedup: 'Sped Up',
    lofi: 'Lofi', vapor: 'Vaporwave', '8d': '8D Audio', emo: 'Emotional',
    edm: 'EDM', bass: 'Bass Boost', echo: 'Echo', '360': '360° Audio',
  };

  /* ---------- effect recipes: existing pipelines only ---------- */
  function recipe(id) {
    var a = A();
    if (!a || !a.state) return null;
    var fx, rate;
    if (id === 'slowed' || id === 'lofi' || id === 'emo' || id === 'edm') {
      // RM.remix honest DSP recipes (rate + FX chain), remix screen wala wahi.
      var s = RM.remix.get(id === 'emo' ? 'emotional' : id);
      fx = clone(s.fx);
      fx.spatial = { mode: 'off', speed: 0.12, depth: 0.7 };
      rate = s.rate;
    } else if (id === 'nightcore') {
      fx = clone(a.defaultFx());
      fx.eq3 = [2, 1, 4]; // presence/air lift — 1.25x tempo se pitch khud upar
      fx.reverb = { on: true, room: 'hall', wet: 0.25 };
      rate = 1.25;
    } else if (id === 'spedup') {
      fx = clone(a.defaultFx());
      fx.eq3 = [1, 1, 3];
      rate = 1.5;
    } else if (id === 'vapor') {
      // Existing FX blocks compose: chorus + echo + reverb + warm EQ.
      fx = clone(a.defaultFx());
      fx.eq3 = [1, 2, -2];
      fx.filter = 9000;
      fx.chorus = { on: true, rate: 1.2, depth: 0.004 };
      fx.echo = { on: true, time: 0.45, fb: 0.38, wet: 0.25 };
      fx.reverb = { on: true, room: 'church', wet: 0.5 };
      fx.comp = { on: true, thr: -14, ratio: 3, atk: 0.01, rel: 0.3 };
      fx.out = 0.92;
      rate = 0.85;
    } else if (id === '8d') {
      // Existing 8D spatial mode ON — current chain rehti hai.
      fx = clone(a.state.fx);
      fx.spatial = { mode: '8d', speed: 0.12, depth: 1 };
      rate = (a.state.project && a.state.project.settings.speed) || 1; // tempo unchanged
    } else if (id === '360') {
      // 360° spatial rotation (HRTF) ON — current chain rehti hai, sirf
      // spatial mode flip hota hai (RM.fx makeSpatial360, mode '360').
      fx = clone(a.state.fx);
      fx.spatial = { mode: '360', speed: 0.25, depth: 1 };
      rate = (a.state.project && a.state.project.settings.speed) || 1; // tempo unchanged
    } else if (id === 'bass') {
      fx = clone(a.defaultFx());
      fx.eq3 = [7, 2, 0]; // RM.fx.EQ_PRESETS.bass
      fx.comp = { on: true, thr: -18, ratio: 5, atk: 0.005, rel: 0.2 };
      rate = (a.state.project && a.state.project.settings.speed) || 1;
    } else if (id === 'echo') {
      fx = clone(a.defaultFx());
      fx.echo = { on: true, time: 0.375, fb: 0.4, wet: 0.4 }; // existing echo block
      fx.reverb = { on: true, room: 'hall', wet: 0.3 };
      rate = (a.state.project && a.state.project.settings.speed) || 1;
    } else {
      return null;
    }
    return { fx: fx, rate: rate };
  }

  function hasAudio() {
    var a = A();
    return !!(a && a.state && a.state.buffer && a.state.project);
  }

  // Gaana load nahi: friendly English prompt + music picker auto-open.
  function noSongPrompt() {
    var a = A();
    if (a && a.toast) a.toast('Pick a song first');
    if (window.RM && RM.ux && typeof RM.ux.pickMusic === 'function') {
      try { RM.ux.pickMusic(); return; } catch (e) {}
    }
    try { // fallback: import screen, Music tab
      if (a) {
        if (!a.state.project) a.newProject();
        else a.show('import');
        if (typeof a.switchImportTab === 'function') a.switchImportTab('music');
      }
    } catch (e) {}
  }

  function paint() {
    var active = getActive();
    try {
      // Dusre worker ke cards: #cdx-fxgrid .cdx-fxcard[data-id]
      document.querySelectorAll('#cdx-fxgrid .cdx-fxcard').forEach(function (c) {
        c.classList.toggle('on', !!(active && normalizeId(c.dataset.id) === active));
      });
      // Task-spec ids `cdx-fx-<id>` (agar kabhi aayein to)
      IDS.forEach(function (id) {
        var el = document.getElementById('cdx-fx-' + id);
        if (el) el.classList.toggle('on', active === id);
      });
    } catch (e) {}
  }

  function getActive() {
    var a = A();
    if (!a || !a.state || !a.state.buffer) return null; // stale guard
    return normalizeId(a.state.cdxFx) || null;
  }

  // Toggle-off: effect se pehle wali state (dry) wapas. Preview bajta rehta
  // hai taaki wet/dry A-B compare ho sake.
  function clearEffect() {
    var a = A();
    if (!a || !a.state) return false;
    var prev = a.state.cdxPrev;
    a.state.cdxFx = null;
    a.state.cdxPrev = null;
    paint();
    if (prev && a.state.project) {
      a.state.fx = clone(prev.fx);
      a.state.project.settings.speed = prev.speed;
      try {
        a.ensureStudio();
        a.applyFxToChain();
        if (a.state.player) a.state.player.setRate(prev.speed);
        if (window.RM && RM.proj) RM.proj.autosave(a.state.project);
      } catch (e) {}
    }
    return true;
  }

  /* ---------- main API: card tap / test entry point ---------- */
  function applyEffect(rawId) {
    var a = A();
    var id = normalizeId(rawId);
    if (!a || !id) return false;
    if (!hasAudio()) { noSongPrompt(); return false; }
    if (normalizeId(a.state.cdxFx) === id) {
      clearEffect(); // dobara tap -> toggle off (dry)
      return true;
    }
    var r = recipe(id);
    if (!r) return false;
    // Pehli activation par pre-effect state snapshot karo; card-switch par
    // snapshot nahi badalta taaki toggle-off hamesha original dry pe aaye.
    if (!a.state.cdxFx) {
      a.state.cdxPrev = {
        fx: clone(a.state.fx),
        speed: (a.state.project.settings.speed || 1),
      };
    }
    a.state.fx = r.fx;
    a.state.project.settings.speed = r.rate; // export isi tempo pe render hota hai
    try {
      a.ensureStudio();
      a.applyFxToChain();
      // Stem-mix preview baj raha ho to roko — nahi to do audio overlap honge.
      try { if (RM.remix && RM.remix.stemPipeline) RM.remix.stemPipeline.stopPreview(); } catch (e2) {}
      var p = a.state.player;
      if (p) {
        p.setRate(r.rate);
        // Decode abhi chal raha ho (player khaali) to viewBuffer load karo.
        if (!p.buffer && a.state.viewBuffer) {
          p.load(a.state.viewBuffer);
          p.setVolume(a.state.project.settings.volume != null ? a.state.project.settings.volume : 0.9);
          p.setPan(a.state.project.settings.pan || 0);
        }
        if (!p.buffer) {
          a.state.cdxFx = id;
          paint();
          if (window.RM && RM.proj) RM.proj.autosave(a.state.project);
          a.toast('Preparing audio…');
          return true;
        }
        // 1-tap preview: INTENTIONAL autoplay — card khud "preview" hai.
        p.play(0);
      }
      if (window.RM && RM.proj) RM.proj.autosave(a.state.project); // settings.fx+speed persist
    } catch (e) {
      a.toast('Could not apply effect');
      return false;
    }
    a.state.cdxFx = id;
    paint();
    a.toast('✓ ' + LABELS[id] + ' — tap again to turn off');
    return true;
  }

  return {
    applyEffect: applyEffect,
    clearEffect: clearEffect,
    getActive: getActive,
    normalizeId: normalizeId,
    list: function () { return IDS.slice(); },
  };
})();
