'use strict';
/* =====================================================================
   RuhMix — mashup-screen.js (W1, v23)
   "🤖 Auto Mashup" screen UI. window.RM.mashupScreen module.

   v23: dynamic song slots (2–8). Mode auto-derives from the picked song
   count:
     1 song  -> built-in beat flow: RM.mashup.buildAuto(slot1, styleId, onProg, onStep)
     2 songs -> style cards: 🎤 Classic (RM.mashup.build) or 🔄 Vocal Swap
                (RM.mashupSwap.build). Beat-source seg + beat grid hidden.
     3–8     -> Mega mode: RM.mashupMega.build(songs, opts, onProgress, onStep)
                with a built-in copyright-free beat (auto-matched).

   Pick flow: reuses the EXACT #cdx-pick flow (RM.ux.pickMusic() -> import
   screen). Before routing, pickTarget = 1..8 is set; app.js landing points
   (handleAudioPicked direct-load + import "Use" button) call
   RM.mashupScreen.onPicked(slot, buffer, name) instead of loadAudioBuffer,
   which lands the decoded AudioBuffer in the mashup slot and returns to
   the mashup screen. Stale pending picks are cleared if the user abandons
   the import screen without picking.

   Playback: preview starts ONLY from the user's tap on #mashup-play
   (never autoplay), and is always stopped when the mashup screen is left.

   Depends on other workers' files: RM.mashup.build / buildAuto,
   RM.mashupSwap.build (W2), RM.mashupMega.build (W4),
   RM.mashupExport.sendToExport — all called defensively.
   ===================================================================== */
window.RM = window.RM || {};

(function () {
  var RM = window.RM;
  function A() { return RM.app || null; }
  function $(id) { return document.getElementById(id); }

  var MAX_SONGS = 8, MIN_SLOTS = 2;

  var ms = {
    pickTarget: 0,        // 0 = none, 1..8 = song slot
    slots: [],            // [{ buffer: AudioBuffer|null, name: string }], length 2..8
    mode2: 'classic',     // 'classic' | 'swap' — only used in 2-song mode
    result: null,         // { buffer: AudioBuffer, meta: object, engine: string }
    pvSrc: null,          // active preview BufferSourceNode
    building: false,
    _wired: false,
    _hook: null,
  };
  function blankSlots() {
    var s = [];
    for (var i = 0; i < MIN_SLOTS; i++) s.push({ buffer: null, name: '' });
    return s;
  }
  ms.slots = blankSlots();

  /* ================= slots ================= */

  // Songs that actually have audio, in slot order.
  function pickedSongs() {
    return ms.slots.filter(function (s) { return s && s.buffer; });
  }
  function pickedCount() { return pickedSongs().length; }

  // Auto-derived mode: 'builtin' (1 song) | 'style2' (2 songs) | 'mega' (3–8).
  function mode() {
    var n = pickedCount();
    if (n <= 1) return 'builtin';
    if (n === 2) return 'style2';
    return 'mega';
  }

  /* ================= picker (exact #cdx-pick flow) ================= */

  function requestPick(slot) {
    var a = A();
    if (!a) return;
    stopPreview();
    if (slot < 1 || slot > ms.slots.length) { a.toast('Pick failed — try again'); return; }
    ms.pickTarget = slot;
    try {
      if (RM.ux && typeof RM.ux.pickMusic === 'function') {
        RM.ux.pickMusic(); // same mechanism as the #cdx-pick button
      } else {
        a.show('import');
      }
    } catch (e) { ms.pickTarget = 0; return; }
    a.toast('Pick Song ' + slot + ' 🎵');
  }

  // Called by app.js (mashupIntercept) with the decoded AudioBuffer + name.
  function onPicked(slot, buffer, name) {
    var a = A();
    if (!buffer || slot < 1 || slot > ms.slots.length) {
      if (a) a.toast('Pick failed — try again');
      ms.pickTarget = 0;
      return;
    }
    ms.slots[slot - 1] = { buffer: buffer, name: name || 'audio' };
    ms.pickTarget = 0;
    renderSlots();
    updateModeUI();
    if (a) {
      a.toast('Song ' + slot + ' selected ✓');
      a.show('mashup');
    }
  }

  function removeSlot(slot) {
    var a = A();
    if (slot < 1 || slot > ms.slots.length) return;
    if (ms.slots.length <= MIN_SLOTS) return; // keep the base pair
    stopPreview();
    ms.slots.splice(slot - 1, 1);
    if (ms.pickTarget === slot) ms.pickTarget = 0;
    renderSlots();
    updateModeUI();
    if (a) a.toast('Song removed');
  }

  function addSlot() {
    var a = A();
    if (ms.slots.length >= MAX_SONGS) {
      if (a) a.toast('Maximum ' + MAX_SONGS + ' songs');
      return;
    }
    ms.slots.push({ buffer: null, name: '' });
    renderSlots();
    updateModeUI();
  }

  function renderSlots() {
    var wrap = $('mashup-slots');
    if (!wrap) return;
    wrap.innerHTML = '';
    ms.slots.forEach(function (s, i) {
      var n = i + 1;
      var row = document.createElement('div');
      row.className = 'mashup-slot-row';
      var pick = document.createElement('button');
      pick.className = 'btn big block mashup-slot-pick';
      pick.setAttribute('data-pick', String(n));
      pick.setAttribute('aria-label', 'Pick Song ' + n);
      pick.textContent = '🎵 Song ' + n + (s.buffer ? ' ✓' : '');
      var nm = document.createElement('div');
      nm.className = 'muted small';
      nm.textContent = s.buffer ? s.name : 'No song selected';
      var mid = document.createElement('div');
      mid.className = 'mashup-slot-mid';
      mid.appendChild(pick);
      mid.appendChild(nm);
      row.appendChild(mid);
      // ✕ remove (only when more than the base pair exists).
      var x = document.createElement('button');
      x.className = 'btn small mashup-slot-x';
      x.setAttribute('data-remove', String(n));
      x.setAttribute('aria-label', 'Remove Song ' + n);
      x.textContent = '✕';
      if (ms.slots.length <= MIN_SLOTS) x.disabled = true;
      row.appendChild(x);
      wrap.appendChild(row);
    });
    var cnt = $('mashup-count');
    if (cnt) cnt.textContent = 'Songs: ' + pickedCount() + '/' + MAX_SONGS;
    var add = $('mashup-add');
    if (add) add.disabled = ms.slots.length >= MAX_SONGS;
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
    if (b) b.disabled = running || pickedCount() === 0;
    // v21: Cancel button — the only escape if the neural call stalls.
    var c = $('mashup-cancel');
    if (c) c.hidden = !running;
    if (running) { var r = $('mashup-result'); if (r) r.hidden = true; }
    else hideProgress();
  }

  function fail(msg) {
    var a = A();
    setBuildUI(false);
    updateCreateState();
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

  // Honest engine label from the real per-call provider tags:
  // never claim DSP when neural stems were used, or vice versa.
  // Accepts ALL engineTags schemas (v23 root fix — W8 found swap/mega used
  // different schemas and always fell through to "Smart DSP engine"):
  //   classic: meta.engineTagVocal/engineTagInstr or engineTags{vocal,instr}
  //   swap:    meta.engineTagSong1/engineTagSong2 or engineTags{song1,song2}
  //   mega:    engineTags = [tag, tag, ...] (array of per-song tags)
  function honestEngineLabel(res) {
    var m = (res && res.meta) || {};
    var et = (res && res.engineTags);
    var tags = [];
    function push(t) { if (typeof t === 'string' && t) tags.push(t); }
    // v21 classic schema + v23 swap meta schema (engineTagSong1/engineTagSong2)
    push(m.engineTagVocal); push(m.engineTagInstr);
    push(m.engineTagSong1); push(m.engineTagSong2);
    if (et && !Array.isArray(et) && typeof et === 'object') {
      // swap schema {song1,song2} + classic {vocal,instr} — collect every value
      for (var k in et) { if (Object.prototype.hasOwnProperty.call(et, k)) push(et[k]); }
    } else if (Array.isArray(et)) {
      // mega schema: array of per-song tag strings
      for (var i = 0; i < et.length; i++) push(et[i]);
    }
    // HONESTY: the fallback tag 'smart DSP (neural failed)' contains the
    // word "neural" — it must NOT count as neural (the actual engine was
    // DSP). Only a real neural success tag ('neural stems') counts.
    function isNeural(t) { return /neural/i.test(t) && !/neural failed/i.test(t); }
    var neuralCount = 0;
    for (var j = 0; j < tags.length; j++) if (isNeural(tags[j])) neuralCount++;
    if (tags.length > 0 && neuralCount === tags.length) return 'Neural stems engine';
    if (neuralCount > 0) return 'Smart DSP + neural stems';
    if (/failed/i.test(tags.join(' '))) return 'Smart DSP engine (neural unavailable)';
    return 'Smart DSP engine';
  }

  function make() {
    var a = A();
    if (!a || ms.building) return;
    var songs = pickedSongs();
    var m = mode();
    if (m === 'builtin' && !songs[0]) { a.toast('Pick Song 1 first 🎵'); return; }
    if (m === 'style2' && songs.length < 2) { a.toast('Pick both songs first 🎵'); return; }
    if (m === 'mega' && songs.length < 3) { a.toast('Add at least 3 songs for a Mega mashup 🎵'); return; }

    // Engine availability checks (defensive — W2/W4 modules may lag).
    var canBuiltin = RM.mashup && typeof RM.mashup.buildAuto === 'function';
    var canClassic = RM.mashup && typeof RM.mashup.build === 'function';
    var canSwap = RM.mashupSwap && typeof RM.mashupSwap.build === 'function';
    var canMega = RM.mashupMega && typeof RM.mashupMega.build === 'function';
    var need =
      m === 'builtin' ? canBuiltin :
      m === 'mega' ? canMega :
      (ms.mode2 === 'swap' ? canSwap : canClassic);
    if (!need) {
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
    // Builds without their own onStep (classic/swap): drive the 3-step
    // indicator from progress fractions so it never sits static.
    var onProgSteps = function (label, frac) {
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
        if (m === 'builtin') {
          // 1 song: built-in beat auto flow (existing W3 contract).
          return RM.mashup.buildAuto(songs[0].buffer, BU.selectedStyle, onProg, BU.onStep);
        }
        if (m === 'mega') {
          // 3–8 songs: Mega mode (W4 contract).
          var list = songs.map(function (s) { return { buffer: s.buffer, name: s.name }; });
          return RM.mashupMega.build(list, {}, onProg, BU.onStep);
        }
        if (ms.mode2 === 'swap') {
          // 2 songs, Vocal Swap (W2 contract). token is optional.
          var token = (RM.mashupStems && typeof RM.mashupStems.makeToken === 'function')
            ? RM.mashupStems.makeToken() : null;
          return RM.mashupSwap.build(songs[0].buffer, songs[1].buffer, onProgSteps, token);
        }
        // 2 songs, Classic (existing W3 contract).
        return RM.mashup.build(songs[0].buffer, songs[1].buffer, onProgSteps);
      })
      .then(function (res) {
        done = true;
        try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (e) {}
        var buf = res && res.buffer ? res.buffer : (res instanceof AudioBuffer ? res : null);
        if (!buf) throw new Error('Mashup build produced no audio.');
        var meta = (res && res.meta) || {};
        ms.result = { buffer: buf, meta: meta, engine: honestEngineLabel(res) };
        // Friendly export name per mode.
        try {
          var nm;
          if (m === 'mega') {
            nm = 'Mega Mashup (' + songs.length + ' songs)';
          } else if (m === 'style2' && ms.mode2 === 'swap') {
            nm = 'Mashup ' + (songs[0].name || 'A') + ' x ' + (songs[1].name || 'B') + ' (Vocal Swap)';
          } else {
            nm = 'Mashup ' + (songs[0].name || 'A') + ' x ';
            if (m === 'builtin') {
              var stN = BU.styleById(BU.selectedStyle);
              nm += (stN && stN.name) ? stN.name + ' Beat' : (BU.selectedStyle ? 'Built-in Beat' : 'Auto Beat');
            } else {
              nm += (songs[1].name || 'B');
            }
          }
          ms.result.meta.name = nm;
          // W5 export uses meta.style for the "RuhMix-mashup-<style>.mp3" filename.
          ms.result.meta.style = m === 'mega' ? 'mega'
            : (ms.mode2 === 'swap' && m === 'style2') ? 'swap'
            : (m === 'builtin' ? (BU.selectedStyle || 'auto') : 'song2');
        } catch (e) {}
        setBuildUI(false);
        updateCreateState();
        var metaEl = $('mashup-meta');
        if (metaEl) metaEl.textContent = formatMeta(meta);
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
  BU.beatSource = 'builtin';   // v23: 1-song mode always uses built-in beats
  BU.selectedStyle = null;     // RM.Beats style id (W1 module)

  var CONSENT_BUILTIN = 'Built-in original beat (copyright-free, synthesized in-app) • vocals auto-matched. No fake AI claims.';
  var CONSENT_CLASSIC = 'Smart DSP vocal isolation • tempo & key auto-matched. No fake AI claims.';
  var CONSENT_SWAP = 'Vocals auto-separated (neural AI if configured, else Smart DSP) • vocals alternate between both songs • tempo & key auto-matched. No fake AI claims.';
  var CONSENT_MEGA = 'Vocals auto-separated (neural AI if configured, else Smart DSP) • vocals rotate over an auto-matched built-in copyright-free beat. No fake AI claims.';
  var STEP2_BUILTIN = '🎹 Creating copyright-free beat…';
  var STEP2_SWAP = '🔄 Swapping vocals…';
  var STEP2_MEGA = '🎹 Matching built-in beat…';

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
    if (h) h.textContent = src === 'builtin' ? CONSENT_BUILTIN : CONSENT_CLASSIC;
    var s2li = $('mstep-beat'), s2lb = s2li ? s2li.querySelector('.mstep-label') : null;
    if (s2lb) s2lb.textContent = src === 'builtin' ? STEP2_BUILTIN : STEP2_SWAP;
  };

  /* ---- 3-step indicator: the engines call BU.onStep('vocals'|'beat'|'mix'|'done') ---- */

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

  /* ================= v23: mode UI (auto-derived) ================= */

  // v23: switching the visible mode clears a stale result — otherwise
  // Preview/Export would act on a mashup built from a different song set.
  function clearStaleResult() {
    try { stopPreview(); } catch (e) {}
    ms.result = null;
    var r = $('mashup-result');
    if (r) r.hidden = true;
    BU.resetSteps();
  }

  function updateModeUI() {
    var m = mode();
    var isBuiltin = m === 'builtin', isStyle2 = m === 'style2', isMega = m === 'mega';
    var panel = $('mashup-beatsrc-panel'), beats = $('mashup-beats-wrap');
    var styles = $('mashup-style-wrap'), mega = $('mashup-mega-note');
    if (panel) panel.hidden = !isBuiltin;
    if (beats) beats.hidden = !isBuiltin;
    if (styles) styles.hidden = !isStyle2;
    if (mega) mega.hidden = !isMega;
    var h = $('mashup-honest');
    if (h) h.textContent = isBuiltin ? CONSENT_BUILTIN
      : isMega ? CONSENT_MEGA
      : (ms.mode2 === 'swap' ? CONSENT_SWAP : CONSENT_CLASSIC);
    var s2lb = (function () {
      var li = $('mstep-beat');
      return li ? li.querySelector('.mstep-label') : null;
    })();
    if (s2lb) s2lb.textContent = isBuiltin ? STEP2_BUILTIN : (isMega ? STEP2_MEGA : STEP2_SWAP);
    updateCreateState();
  }

  // Min-song validation: Create is disabled with 0 songs; 2+-song modes
  // (classic/swap/mega) additionally require ≥2 songs (defensive, since the
  // mode auto-derives from the count).
  function updateCreateState() {
    var b = $('mashup-make'), hint = $('mashup-min2-hint');
    if (!b) return;
    var n = pickedCount();
    var ok = n >= 1 && !ms.building;
    if (ok && (mode() === 'style2' || mode() === 'mega') && n < 2) ok = false;
    b.disabled = !ok;
    if (hint) hint.hidden = ok;
  }

  function selectMode2(which) {
    if (which !== 'classic' && which !== 'swap') return;
    if (ms.mode2 === which) return;
    ms.mode2 = which;
    clearStaleResult();
    var gc = $('mashup-style-classic'), gs = $('mashup-style-swap');
    if (gc) gc.classList.toggle('sel', which === 'classic');
    if (gs) gs.classList.toggle('sel', which === 'swap');
    var h = $('mashup-honest');
    if (h) h.textContent = which === 'swap' ? CONSENT_SWAP : CONSENT_CLASSIC;
    var s2lb = (function () {
      var li = $('mstep-beat');
      return li ? li.querySelector('.mstep-label') : null;
    })();
    if (s2lb) s2lb.textContent = STEP2_SWAP;
  }

  /* ================= wiring ================= */

  function wire() {
    if (ms._wired) return;
    ms._wired = true;
    // Slot rows are rendered dynamically — delegate pick/remove clicks.
    var slotsWrap = $('mashup-slots');
    if (slotsWrap) slotsWrap.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== slotsWrap && !t.getAttribute) t = t.parentNode;
      if (!t || t === slotsWrap) return;
      var pk = t.getAttribute('data-pick');
      var rm = t.getAttribute('data-remove');
      if (pk) { requestPick(parseInt(pk, 10)); return; }
      if (rm) { removeSlot(parseInt(rm, 10)); }
    });
    var add = $('mashup-add');
    if (add) add.addEventListener('click', addSlot);
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
    // v23: 2-song style cards.
    var gc = $('mashup-style-classic'), gs = $('mashup-style-swap');
    if (gc) gc.addEventListener('click', function () { selectMode2('classic'); });
    if (gs) gs.addEventListener('click', function () { selectMode2('swap'); });
    // W2: beat source segmented control + built-in beat cards (1-song mode).
    var sb = $('mashup-src-builtin'), ss = $('mashup-src-song2');
    if (sb) sb.addEventListener('click', function () { BU.setBeatSource('builtin'); });
    if (ss) ss.addEventListener('click', function () { BU.setBeatSource('song2'); });
    BU.renderBeats();
    BU.setBeatSource('builtin');
    renderSlots();
    updateModeUI();
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
    if (RM.app && $('mashup-slots')) {
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
    // v23: read-only view of the dynamic slots (1..8) for debugging/tests.
    getSongs: function () { return pickedSongs().map(function (s) { return { name: s.name }; }); },
  };
  // pickTarget is a live accessor so app.js interception always sees the
  // current value, and onPicked clearing it internally stays in sync.
  // v23: slots are 1..8 (was 1|2).
  Object.defineProperty(RM.mashupScreen, 'pickTarget', {
    get: function () { return ms.pickTarget; },
    set: function (v) { ms.pickTarget = v ? 1 * v : 0; },
    configurable: true,
  });
})();
