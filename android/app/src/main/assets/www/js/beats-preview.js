'use strict';
/* =====================================================================
   RuhMix — beats-preview.js (W4)
   Beat preview playback system. window.RM.BeatsPreview module.

   CONTRACT (sibling workers):
     W1 (RM.Beats): renderBeat(styleId, bpm, bars) -> Promise<AudioBuffer>.
                    Optional: RM.Beats.bpmFor(styleId) -> number, ya
                    RM.Beats.STYLES = [{id, bpm, ...}] (bpm wahi se aata hai).
     W2 (beat cards, mashup-screen.js): card me preview button par
                    `data-style="<styleId>"` (.beat-card ke andar) — W2 seedha
                    RM.BeatsPreview.play(styleId) call karta hai (bina button
                    ke); yeh module button ko DOM se dhoondh kar ⏸/▶ toggle
                    dikhata hai. Kahin bhi `data-beat-preview="<styleId>"`
                    wala element bhi auto-wire hota hai (delegated click).

   RULES (hard):
     - Sirf user TAP pe bajta hai. Koi autoplay, koi page-load play nahi.
     - Ek waqt me sirf EK preview. Naya tap -> purana turant stop (no overlap).
     - Usi button pe dobara tap -> toggle stop.
     - Screen change / tab hidden -> preview stop.
     - Volume moderate: preview gain 0.8 (master chain ka limiter/clipper
       waise bhi ceiling lagata hai).
     - Stop pe saare nodes disconnect + timer clear (no leak).
   ===================================================================== */
window.RM = window.RM || {};

(function () {
  var RM = window.RM;

  var PREVIEW_BARS = 4;   // 2-bar loop nahi — ek baar 4 bars, phir stop
  var PREVIEW_GAIN = 0.8; // moderate — preview me kaan na phate
  var END_SLOP_MS = 500;  // onended safety net (call aane pe ctx interrupt etc.)

  // Local fallback BPMs — sirf tab jab W1 bpmFor/STYLES na de.
  var FALLBACK_BPM = {
    commercial: 120, lofi: 85, slowed: 70, emotional: 95, edm: 128,
    trap: 140, synthwave: 105, acoustic: 100, sufi: 90, vocalfocus: 110,
    custom: 120
  };

  var seq = 0;   // har preview() call pe badhta hai — stale renders ko maarne ke liye
  var cur = null; // { token, styleId, btn, labelHTML, nodes:[], timer, phase }

  function toast(msg) {
    try {
      if (RM.app && typeof RM.app.toast === 'function') RM.app.toast(msg);
      else if (typeof console !== 'undefined') console.warn('[BeatsPreview]', msg);
    } catch (e) {}
  }
  function cleanErr(e) {
    try {
      if (RM.app && typeof RM.app.cleanErrMsg === 'function') return RM.app.cleanErrMsg(e);
    } catch (ign) {}
    return (e && e.message) ? e.message : String(e || 'error');
  }

  /* ================= BPM ================= */

  function bpmFor(styleId) {
    try {
      var B = RM.Beats;
      if (B) {
        if (typeof B.bpmFor === 'function') {
          var b = B.bpmFor(styleId);
          if (b > 30 && b < 300) return b;
        }
        if (B.STYLES && B.STYLES.length) {
          for (var i = 0; i < B.STYLES.length; i++) {
            var s = B.STYLES[i];
            if (s && s.id === styleId && s.bpm > 30 && s.bpm < 300) return s.bpm;
          }
        }
      }
    } catch (e) {}
    return FALLBACK_BPM[styleId] || 120;
  }

  /* ================= buttons ================= */

  function setBtn(btn, html, playing) {
    if (!btn) return;
    try {
      btn.innerHTML = html;
      btn.classList.toggle('bp-playing', !!playing);
      btn.classList.toggle('bp-loading', html === '⏳');
      btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    } catch (e) {}
  }

  /* ================= core state machine ================= */

  // Synchronous, idempotent teardown. Har exit path yahin se guzarta hai:
  // toggle-off, naya preview, screen change, onended, safety timer.
  function kill() {
    var c = cur;
    cur = null;
    if (!c) return;
    if (c.timer) { try { clearTimeout(c.timer); } catch (e) {} c.timer = 0; }
    // Pehle onended null (stop() khud onended fire karta hai -> recursion se bacho),
    // phir stop, phir disconnect. Har node apne try/catch me (rapid taps me
    // aadhe-bane graph bhi safely mar jayein).
    for (var i = 0; i < c.nodes.length; i++) {
      (function (n) {
        try { n.onended = null; } catch (e) {}
        try { if (typeof n.stop === 'function') n.stop(); } catch (e) {}
        try { n.disconnect(); } catch (e) {}
      })(c.nodes[i]);
    }
    c.nodes = [];
    if (c.btn && c.labelHTML != null) setBtn(c.btn, c.labelHTML, false); // wapas ▶
  }

  function fail(token, e) {
    if (cur && cur.token === token) kill(); // sirf apni attempt ko maro
    toast(cleanErr(e) || 'Could not play beat preview.');
  }

  function begin(buf, token) {
    if (!cur || cur.token !== token) return; // superseded — discard
    var ctx = RM.audio.ensureCtx(); // throw kare to fail() handle karega
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var g = ctx.createGain();
    g.gain.value = PREVIEW_GAIN;
    src.connect(g);
    g.connect(RM.audio.masterIn()); // limiter+clipper wali safe chain
    cur.nodes = [src, g];
    cur.phase = 'playing';
    setBtn(cur.btn, '⏸', true);
    var myToken = token;
    src.onended = function () { if (cur && cur.token === myToken) kill(); };
    src.start();
    // Safety net: onended aam taur pe fire hota hai, lekin agar context
    // interrupt ho (call, etc.) to timer teardown guarantee karta hai.
    cur.timer = setTimeout(function () { if (cur && cur.token === myToken) kill(); },
      Math.max(500, (buf.duration * 1000) + END_SLOP_MS));
  }

  // PUBLIC: preview(styleId, btnEl?) — toggle semantics.
  // Usi style pe dobara tap -> stop. Dusre style pe tap -> purana turant stop.
  function preview(styleId, btnEl) {
    styleId = String(styleId || '').trim();
    if (!styleId) return;
    var btn = (btnEl instanceof Element) ? btnEl : null;

    var wasOurs = !!(cur && cur.styleId === styleId);
    var token = ++seq;
    kill(); // purana preview SYNCHRONOUSLY khatm — overlap impossible
    if (wasOurs) return; // toggle off

    if (!RM.Beats || typeof RM.Beats.renderBeat !== 'function') {
      toast('Beat engine not ready — update the app and retry.');
      return;
    }
    // User gesture abhi live hai (tap handler ke andar) — isi waqt context
    // resume karo taaki mobile browsers me playback block na ho. Render async
    // ho sakta hai; gesture window ke baad start() phir bhi chalta hai kyunki
    // context pehle se running hai.
    try { RM.audio.ensureCtx(); } catch (e) { toast(cleanErr(e)); return; }

    cur = {
      token: token, styleId: styleId, btn: btn,
      labelHTML: btn ? btn.innerHTML : null,
      nodes: [], timer: 0, phase: 'render'
    };
    setBtn(btn, '⏳', false);

    var rendered;
    try {
      rendered = RM.Beats.renderBeat(styleId, bpmFor(styleId), PREVIEW_BARS);
    } catch (e) { fail(token, e); return; }
    Promise.resolve(rendered).then(function (buf) {
      if (!cur || cur.token !== token) return; // beech me naya tap aa gaya — discard
      if (!(buf instanceof AudioBuffer)) throw new Error('Beat render failed.');
      begin(buf, token);
    }).catch(function (e) { fail(token, e); });
  }

  function stop() { kill(); }

  // W2 (mashup-screen.js BU.onPreviewClick) play(styleId) call karta hai —
  // button element nahi deta. Button ko DOM se resolve karo taaki ⏸/▶ toggle
  // beat cards pe bhi dikhe.
  function findPreviewButton(styleId) {
    try {
      var esc = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
        ? CSS.escape(styleId)
        : String(styleId).replace(/["\\]/g, '\\$&');
      var sel = '[data-beat-preview="' + esc + '"], .beat-card button[data-style="' + esc + '"]';
      return document.querySelector(sel);
    } catch (e) { return null; }
  }

  function play(styleId, btnEl) {
    var btn = (btnEl instanceof Element) ? btnEl : findPreviewButton(styleId);
    preview(styleId, btn);
  }

  function isPlaying(styleId) {
    return !!(cur && cur.phase === 'playing' && (!styleId || cur.styleId === styleId));
  }

  /* ================= auto-wire (tap-only) ================= */

  // Single delegated listener — koi per-card wiring nahi, koi boot-time
  // playback nahi. Sirf asli user click pe preview() chalta hai.
  function onDocClick(e) {
    if (!e || e.defaultPrevented) return;
    var t = e.target;
    if (!t || !t.closest) return;
    // 1) explicit opt-in: kahin bhi [data-beat-preview="<styleId>"]
    var el = t.closest('[data-beat-preview]');
    var styleId = el ? el.getAttribute('data-beat-preview') : null;
    var btn = el;
    // 2) W2 beat cards: preview button par data-style="<styleId>"
    if (!styleId) {
      el = t.closest('.beat-card [data-style]');
      if (el) {
        styleId = el.getAttribute('data-style');
        // Sirf button-jaisa element hi label swap kare — agar data-style
        // card root pe laga ho to poora card '⏸' me na badal jaye.
        // (Headless bhi toggle kaam karta hai: preview() styleId se match karta hai.)
        var tag = (el.tagName || '').toUpperCase();
        btn = (tag === 'BUTTON' || tag === 'A' ||
               (el.getAttribute && el.getAttribute('role') === 'button')) ? el : null;
      }
    }
    if (!styleId) return;
    if (btn && btn.disabled) return;
    e.preventDefault();
    preview(styleId, btn);
  }

  /* ================= lifecycle hooks ================= */

  // Screen change -> preview stop. (mashup-screen.js wala re-assert pattern:
  // app.js init() A.onShow ko directly assign karta hai, isliye hook ko
  // re-assert karna padta hai.)
  var _wired = false, _hook = null;
  function wrapOnShow() {
    var a = RM.app;
    if (!a) return;
    if (_hook && a.onShow === _hook) return; // already ours — dobara wrap nahi
    var prev = a.onShow;
    _hook = function (name) {
      try { if (typeof prev === 'function') prev(name); } catch (e) {}
      try { stop(); } catch (e) {} // koi bhi screen change -> preview band
    };
    a.onShow = _hook;
  }

  function boot() {
    if (_wired) return;
    _wired = true;
    document.addEventListener('click', onDocClick, false);
    // Tab hidden / app background -> preview band (pocket me bajta na rahe).
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { try { stop(); } catch (e) {} }
    }, false);
    var attempts = 60;
    (function hookApp() {
      wrapOnShow();
      if (attempts-- > 0 && (!RM.app || RM.app.onShow !== _hook)) {
        setTimeout(hookApp, 250);
      }
    })();
    setTimeout(wrapOnShow, 800);
    setTimeout(wrapOnShow, 2500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  RM.BeatsPreview = {
    preview: preview,
    play: play, // W2 contract: BU.onPreviewClick -> play(styleId)
    stop: stop,
    isPlaying: isPlaying,
  };
})();
