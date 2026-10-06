'use strict';
/* =====================================================================
   RuhMix — v25-studio.js (W5, v25)
   "🎚 Studio" — DAW-style timeline for mashup results.
   Spec §15 (Studio Timeline), §16 (Regenerate), §17 (A/B Preview).

   NEW FILE ONLY — never edits existing files. Coordinator wires it in:
     1. Call RM.v25studio.renderStudio() once (idempotent; auto-runs on
        DOMContentLoaded too) — inserts <section id="screen-studio">.
     2. Add 'studio' to SCREENS in app.js (or rely on the module's own
        manual-activation fallback in showStudio()).
     3. Add a nav entry / an "Open in Studio" button that calls
        RM.v25studio.openFromMashup().
     4. Optionally pass original song buffers for W3-preset rebuilds:
        RM.v25studio.open({buffer, meta, engineTags, songs:[{buffer,name}]}).
        Without songs, "More Lofi/Commercial" use the Smart-DSP chain.

   Data model
   ----------
   - st.original : pristine AudioBuffer from the mashup build (NEVER mutated).
   - st.current  : edited AudioBuffer. Every edit produces a new buffer
                   (or a dup) — A/B compares original vs current.
   - st.sections : [{id,name,kind,vocalSong,lenSec}] — contiguous partition
                   of st.current; lens always sum to buffer length.
   - Sections are DERIVED FROM REAL meta: intro/outro bar counts and the
     arrangement constants are the actual values the engines used
     (4-bar intro/outro everywhere; 8-bar vocal slots in mega/swap;
     vocalOrder from mega meta; alternating S1/S2 in swap meta).
   - Stem lanes: extracted on demand with the REAL RM.stems DSP engines
     (vocalcut/hpss/bass). Vocals+Instrumental form an exact partition
     (center+sides = original), so the lane-mix commit uses those two.
     Drums/Bass are audition references (they overlap the partition).

   HONESTY: everything is labelled "Smart DSP", never "AI". Every button
   performs a real buffer edit. Controls that cannot be real in a given
   mode are hidden (vocal-source swap needs ≥2 distinct vocal sources).
   ===================================================================== */
var __rmRoot = typeof window !== 'undefined' ? window
  : (typeof global !== 'undefined' ? global : {});
__rmRoot.RM = __rmRoot.RM || {};

(function () {
  var RM = __rmRoot.RM;
  function A() { return RM.app || null; }
  function $(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
  function toast(m) { try { var a = A(); if (a) a.toast(m); } catch (e) {} }
  function clamp(v, a, b) { v = +v; if (!isFinite(v)) v = a; return v < a ? a : (v > b ? b : v); }
  function dbToGain(db) { return Math.pow(10, (+db || 0) / 20); }
  function fmtTime(s) {
    s = Math.max(0, +s || 0);
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* ================= STUDIO_HTML ================= */

  var STUDIO_HTML = '' +
'<section class="screen" id="screen-studio">' +
'<style>' +
'.stu-strip{display:flex;overflow-x:auto;gap:4px;padding:10px 4px;-webkit-overflow-scrolling:touch}' +
'.stu-sec{flex:0 0 auto;border-radius:10px;padding:12px 8px;color:#fff;font-size:12px;line-height:1.25;min-width:84px;min-height:60px;text-align:center;border:2px solid transparent;cursor:pointer;touch-action:manipulation}' +
'.stu-sec.sel{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}' +
'.stu-sec .k{display:block;font-size:10px;opacity:.85;margin-top:2px}' +
'.stu-wave{width:100%;height:150px;display:block;border-radius:10px;touch-action:pan-x pan-y}' +
'.stu-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}' +
'.stu-grid .btn{min-height:56px;font-size:13px;line-height:1.3}' +
'.stu-lane{border:1px solid #2a3350;border-radius:10px;padding:10px;margin-top:10px}' +
'.stu-lane canvas{width:100%;height:64px;display:block;border-radius:6px;margin:6px 0}' +
'.stu-lane .btn{min-height:44px}' +
'.stu-lane input[type=range]{width:100%;min-height:44px}' +
'#stu-edit input[type=range]{width:100%;min-height:48px}' +
'#stu-scroll{min-height:44px;width:100%}' +
'.stu-tr{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}' +
'.stu-tr .btn{min-height:52px;min-width:52px}' +
'.stu-time{font-family:monospace;font-size:15px}' +
'.stu-selinfo{padding:8px;border-radius:8px;background:#141a30;margin-top:6px;font-size:13px}' +
'</style>' +
'<h2>\uD83C\uDF9A\uFE0F Studio</h2>' +
'<div class="honest">Smart DSP timeline \u2014 every edit changes the real audio, on your device. \u201CSmart\u201D = on-device DSP, never cloud AI.</div>' +
'<div id="stu-empty" class="panel">' +
'  <p class="muted">No mashup loaded in the Studio yet.</p>' +
'  <button class="btn primary big block" id="stu-load">\uD83C\uDFB5 Load from Mashup screen</button>' +
'</div>' +
'<div id="stu-main" hidden>' +
'  <div class="panel">' +
'    <div id="stu-meta" class="muted small"></div>' +
'    <div class="stu-tr">' +
'      <button class="btn primary big" id="stu-play" aria-label="Play or pause">\u25B6</button>' +
'      <button class="btn big" id="stu-stop" aria-label="Stop">\u23F9</button>' +
'      <button class="btn big" id="stu-ab" aria-label="Toggle A B comparison">A/B: B</button>' +
'      <span class="stu-time" id="stu-time">0:00 / 0:00</span>' +
'    </div>' +
'    <div class="row"><label style="flex:1">Zoom' +
'      <span class="btn-row" style="display:inline-flex;margin:0 6px">' +
'      <button class="btn small" id="stu-zout" aria-label="Zoom out">\u2212</button>' +
'      <button class="btn small" id="stu-zin" aria-label="Zoom in">+</button></span></label></div>' +
'    <div class="row"><label style="flex:1">Scroll <input type="range" id="stu-scroll" min="0" max="1000" value="0" aria-label="Timeline scroll"></label></div>' +
'  </div>' +
'  <div class="panel"><h4>Sections <span class="muted small">\u2014 tap to select &amp; edit</span></h4>' +
'    <div id="stu-sections" class="stu-strip"></div>' +
'    <div id="stu-selinfo" class="stu-selinfo">Tap a section above to edit it.</div>' +
'  </div>' +
'  <div class="panel"><h4>Waveform <span class="muted small">\u2014 tap to seek</span></h4>' +
'    <canvas id="stu-wave" class="stu-wave"></canvas>' +
'    <div class="muted small">\uD83D\uDFE1 bar &nbsp;\uD83D\uDD35 beat &nbsp;\uD83D\uDD34 playhead</div>' +
'  </div>' +
'  <div class="panel" id="stu-edit" hidden><h4>\u270F\uFE0F Edit section</h4>' +
'    <div id="stu-edit-name" class="muted small" style="margin-bottom:6px"></div>' +
'    <div class="btn-row">' +
'      <button class="btn small" id="stu-split">\u2702\uFE0F Split at playhead</button>' +
'      <button class="btn small" id="stu-del">\uD83D\uDDD1 Delete</button>' +
'      <button class="btn small" id="stu-dup">\u29C9 Duplicate</button>' +
'    </div>' +
'    <div class="btn-row">' +
'      <button class="btn small" id="stu-nudge-l">\u23EA \u22121 bar</button>' +
'      <button class="btn small" id="stu-nudge-r">+1 bar \u23E9</button>' +
'      <button class="btn small" id="stu-trim-s">Trim start \u22120.5s</button>' +
'      <button class="btn small" id="stu-trim-e">Trim end \u22120.5s</button>' +
'    </div>' +
'    <div class="row"><label>Fade in <select id="stu-fadein" class="textin">' +
'      <option value="0">Off</option><option value="0.5">0.5s</option>' +
'      <option value="1" selected>1s</option><option value="2">2s</option></select></label>' +
'      <label>Fade out <select id="stu-fadeout" class="textin">' +
'      <option value="0">Off</option><option value="0.5">0.5s</option>' +
'      <option value="1" selected>1s</option><option value="2">2s</option></select></label></div>' +
'    <div class="row"><label style="flex:1">Volume <input type="range" id="stu-vol" min="-12" max="12" step="1" value="0" aria-label="Section volume"> <span id="stu-vol-v">0 dB</span></label></div>' +
'    <div class="row" id="stu-vocal-row"><label>Vocal source <select id="stu-vocal-src" class="textin"></select></label>' +
'      <span class="muted small">Smart DSP vocal swap</span></div>' +
'    <div class="row" id="stu-trans-row"><label>Transition \u2192 next <select id="stu-trans" class="textin">' +
'      <option value="xfade">Crossfade (0.5 bar)</option>' +
'      <option value="dip">Dip (fade out/in)</option>' +
'      <option value="cut">Hard cut</option></select></label></div>' +
'    <button class="btn primary block" id="stu-apply-edit">\u2714 Apply to section</button>' +
'  </div>' +
'  <div class="panel"><h4>\uD83C\uDF9A Stem lanes <span class="beta">Smart DSP</span></h4>' +
'    <button class="btn block" id="stu-stems">\uD83D\uDD2C Extract stems (Vocals / Instrumental / Drums / Bass)</button>' +
'    <div class="muted small">Experimental on-device separation. Vocals + Instrumental form an exact partition, so the lane mix commits from those two; Drums / Bass are audition references.</div>' +
'    <div id="stu-lanes"></div>' +
'    <div class="btn-row">' +
'      <button class="btn" id="stu-audition">\u25B6 Audition lane mix</button>' +
'      <button class="btn primary" id="stu-commit-lanes">\u2714 Apply lane mix</button>' +
'    </div>' +
'  </div>' +
'  <div class="panel"><h4>\u2728 Smart Regenerate <span class="beta">DSP</span></h4>' +
'    <div class="muted small">Re-runs one stage at a time on the current mix. \u201CSmart\u201D = on-device DSP, not AI.</div>' +
'    <div id="stu-regen-grid" class="stu-grid"></div>' +
'    <div class="progress"><div class="pbar" id="stu-pbar"></div></div>' +
'    <div id="stu-ptext" class="status"></div>' +
'  </div>' +
'  <div class="btn-row">' +
'    <button class="btn primary big" id="stu-export">\uD83D\uDCE4 Export</button>' +
'    <button class="btn ghost" id="stu-reset">\u21BA Reset edits</button>' +
'  </div>' +
'</div>' +
'</section>';

  /* ================= state ================= */

  var st = {
    original: null,   // pristine mashup buffer — NEVER mutated
    current: null,    // edited buffer
    meta: {}, engine: '', songs: [],
    mode: 'builtin', bpm: 120, barSec: 2,
    sections: [],     // [{id,name,kind,vocalSong,lenSec}]
    bounds: [],       // per-junction transition: 'xfade'|'dip'|'cut'
    stems: null,      // {vocals,instrumental,drums,bass} AudioBuffers
    laneUI: {},       // per-lane {mute,solo,gainDb,view}
    ab: 'B',          // 'A' = original, 'B' = edited
    sel: -1,          // selected section index
    busy: false,
    zoom: 1,
    _wired: false, _hook: null,
    _idc: 0,
  };
  function nextId(p) { st._idc++; return (p || 's') + st._idc; }

  var tp = { src: null, startCtx: 0, offset: 0, playing: false, raf: 0, laneBuf: null };
  var waveView = null, laneViews = {};

  function actx() { return RM.audio.ensureCtx(); }

  /* ================= pure buffer utils =================
     (no DOM — unit-testable via the node hook at the bottom) */

  function dupBuf(b) {
    var c = actx().createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (var ch = 0; ch < b.numberOfChannels; ch++)
      c.getChannelData(ch).set(b.getChannelData(ch));
    return c;
  }
  function sliceBuf(b, aSec, bSec) {
    var sr = b.sampleRate;
    var a = clamp(Math.round(aSec * sr), 0, b.length);
    var c = clamp(Math.round(bSec * sr), 0, b.length);
    if (c <= a) return null;
    var o = actx().createBuffer(b.numberOfChannels, c - a, sr);
    for (var ch = 0; ch < b.numberOfChannels; ch++)
      o.getChannelData(ch).set(b.getChannelData(ch).subarray(a, c));
    return o;
  }
  function concatBufs(list) {
    var total = 0, nCh = 0, sr = 44100, i, ch;
    for (i = 0; i < list.length; i++) if (list[i]) {
      total += list[i].length; nCh = Math.max(nCh, list[i].numberOfChannels);
      sr = list[i].sampleRate;
    }
    nCh = Math.max(1, nCh);
    var o = actx().createBuffer(nCh, Math.max(1, total), sr);
    var pos = 0;
    for (i = 0; i < list.length; i++) {
      var b = list[i]; if (!b) continue;
      for (ch = 0; ch < nCh; ch++) {
        var dst = o.getChannelData(ch);
        var src = b.getChannelData(Math.min(ch, b.numberOfChannels - 1));
        dst.set(src, pos);
      }
      pos += b.length;
    }
    return o;
  }
  // Trim or zero-pad a buffer to an exact sample length.
  function fitLength(b, targetLen) {
    if (b.length === targetLen) return b;
    var o = actx().createBuffer(b.numberOfChannels, Math.max(1, targetLen), b.sampleRate);
    for (var ch = 0; ch < b.numberOfChannels; ch++) {
      var s = b.getChannelData(ch), d = o.getChannelData(ch);
      d.set(s.subarray(0, Math.min(s.length, o.length)));
    }
    return o;
  }
  function addInto(dst, src) { // dst += src (same length)
    var n = Math.min(dst.length, src.length);
    for (var ch = 0; ch < dst.numberOfChannels; ch++) {
      var d = dst.getChannelData(ch), s = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
      for (var i = 0; i < n; i++) d[i] += s[i];
    }
    return dst;
  }
  // Gain limiter + tanh safety, ceiling in linear (0.71 = -3 dBTP, v24 chain).
  function softLimit(b, ceiling) {
    ceiling = ceiling || 0.71;
    var peak = 0, ch, i, d;
    for (ch = 0; ch < b.numberOfChannels; ch++) {
      d = b.getChannelData(ch);
      for (i = 0; i < d.length; i++) { var a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    if (peak > ceiling) {
      var g = ceiling / peak;
      for (ch = 0; ch < b.numberOfChannels; ch++) {
        d = b.getChannelData(ch);
        for (i = 0; i < d.length; i++) d[i] *= g;
      }
    }
    for (ch = 0; ch < b.numberOfChannels; ch++) {
      d = b.getChannelData(ch);
      for (i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1) d[i] = Math.tanh(d[i]);
    }
    return b;
  }
  // Equal-power fade helpers on a region [aSec,bSec): 'in' | 'out' | 'inout'.
  function fadeRegion(b, aSec, bSec, fSec, kind) {
    var sr = b.sampleRate;
    var a = clamp(Math.round(aSec * sr), 0, b.length);
    var c = clamp(Math.round(bSec * sr), 0, b.length);
    var n = clamp(Math.round(fSec * sr), 0, Math.floor((c - a) / 2));
    if (n <= 0 || c <= a) return b;
    var halfPi = Math.PI / 2, ch, i, g;
    for (ch = 0; ch < b.numberOfChannels; ch++) {
      var d = b.getChannelData(ch);
      if (kind === 'in' || kind === 'inout')
        for (i = 0; i < n; i++) { g = Math.sin(halfPi * i / n); d[a + i] *= g; }
      if (kind === 'out' || kind === 'inout')
        for (i = 0; i < n; i++) { g = Math.sin(halfPi * i / n); d[c - 1 - i] *= g; }
    }
    return b;
  }
  function gainRegion(b, aSec, bSec, gain) {
    var sr = b.sampleRate;
    var a = clamp(Math.round(aSec * sr), 0, b.length);
    var c = clamp(Math.round(bSec * sr), 0, b.length);
    for (var ch = 0; ch < b.numberOfChannels; ch++) {
      var d = b.getChannelData(ch);
      for (var i = a; i < c; i++) d[i] *= gain;
    }
    return b;
  }
  function offlineRender(b, build) {
    return new Promise(function (res, rej) {
      try {
        var oc = new OfflineAudioContext(b.numberOfChannels, b.length, b.sampleRate);
        var src = oc.createBufferSource(); src.buffer = b;
        build(oc, src);
        src.start(0);
        oc.startRendering().then(res, rej);
      } catch (e) { rej(e); }
    });
  }

  /* ================= sections =================
     Derived from REAL meta + the engines' real arrangement constants:
       intro 4 bars / outro 4 bars (classic, swap, mega, buildAuto all use 4);
       8-bar vocal slots (mega BARS_PER_VOCAL=8, swap SWAP_SEG_BARS=8);
       mega vocalOrder = meta.vocalOrder (song index per slot);
       swap alternates Song 1 / Song 2 per cycle (order 0,1 per cycle).
     Sections are the source of truth for edits: contiguous, lens sum to
     buffer length. */

  function detectMode(meta) {
    meta = meta || {};
    if (meta.style === 'mega') return 'mega';
    if (meta.style === 'swap') return 'swap';
    if (meta.bpm2) return 'classic';
    return 'builtin';
  }
  function getBpm(meta, mode) {
    meta = meta || {};
    var b = (mode === 'builtin') ? (meta.bpm || meta.targetBpm)
      : (meta.targetBpm || meta.bpm1 || meta.bpm);
    b = +b;
    return (isFinite(b) && b >= 40 && b <= 260) ? b : 120;
  }

  var SONG_COLORS = ['#29b6f6', '#b537f2', '#ffd54a', '#4dd0a5', '#ff8a65', '#f06292', '#7986cb', '#aed581'];
  var KIND_COLORS = { intro: '#7c5cff', beat: '#546e7a', outro: '#78909c', vocal: null };

  function songLabel(i) {
    if (st.songs && st.songs[i] && st.songs[i].name) return st.songs[i].name;
    return 'Song ' + (i + 1);
  }
  function sectionColor(s) {
    if (s.kind === 'vocal' && s.vocalSong != null)
      return SONG_COLORS[s.vocalSong % SONG_COLORS.length];
    return KIND_COLORS[s.kind] || '#607d8b';
  }

  // Returns [{id,name,kind,vocalSong,lenSec}] covering [0,durSec).
  function deriveSections(meta, mode, bpm, durSec) {
    var barSec = 240 / bpm, secs = [], i, k;
    function push(name, kind, bars, vocalSong) {
      secs.push({ id: nextId('s'), name: name, kind: kind, vocalSong: vocalSong, lenSec: bars * barSec });
    }
    if (mode === 'mega') {
      var order = (meta && Array.isArray(meta.vocalOrder)) ? meta.vocalOrder : [0];
      push('Intro · Beat', 'intro', 4, null);
      for (k = 0; k < order.length; k++)
        push(songLabel(order[k]) + ' · Vocal', 'vocal', 8, order[k]);
      push('Outro · Beat', 'outro', 4, null);
    } else if (mode === 'swap') {
      var cycles = (meta && meta.cycles) || 2;
      push('Intro · Beat', 'intro', 4, null);
      for (k = 0; k < cycles; k++) {
        push(songLabel(0) + ' · Vocal', 'vocal', 8, 0);
        push(songLabel(1) + ' · Vocal', 'vocal', 8, 1);
      }
      push('Outro · Beat', 'outro', 4, null);
    } else {
      // classic / builtin: 4-bar intro, vocal body in 8-bar chunks, 4-bar outro.
      push('Intro · Beat', 'intro', 4, null);
      var bodySec = Math.max(0, durSec - 8 * barSec);
      var n = Math.max(1, Math.ceil(bodySec / (8 * barSec)));
      for (i = 0; i < n; i++)
        push(songLabel(0) + ' · Vocal' + (n > 1 ? ' ' + (i + 1) : ''), 'vocal', 8, 0);
      push('Outro · Beat', 'outro', 4, null);
    }
    // Fit exactly to durSec: put the slack on the largest vocal section.
    var sum = 0, big = -1;
    for (i = 0; i < secs.length; i++) {
      sum += secs[i].lenSec;
      if (secs[i].kind === 'vocal' && (big < 0 || secs[i].lenSec > secs[big].lenSec)) big = i;
    }
    var diff = durSec - sum;
    if (big >= 0) secs[big].lenSec = Math.max(barSec, secs[big].lenSec + diff);
    else if (secs.length) secs[secs.length - 1].lenSec = Math.max(0.25, secs[secs.length - 1].lenSec + diff);
    return secs;
  }

  // Cumulative [a,b) per section index.
  function bounds() {
    var out = [], t = 0;
    for (var i = 0; i < st.sections.length; i++) {
      out.push({ a: t, b: t + st.sections[i].lenSec });
      t += st.sections[i].lenSec;
    }
    return out;
  }
  function scaleSections(ratio) {
    if (!isFinite(ratio) || ratio <= 0) return;
    for (var i = 0; i < st.sections.length; i++) st.sections[i].lenSec *= ratio;
  }

  /* ================= render ================= */

  function setProg(label, frac) {
    var b = $('stu-pbar'), t = $('stu-ptext');
    if (b) b.style.width = Math.round(clamp(frac || 0, 0, 1) * 100) + '%';
    if (t && label != null) t.textContent = label;
  }

  function renderMeta() {
    var el = $('stu-meta'); if (!el) return;
    var bits = [];
    bits.push(st.mode.charAt(0).toUpperCase() + st.mode.slice(1) + ' mashup');
    bits.push(Math.round(st.bpm * 10) / 10 + ' BPM');
    bits.push(fmtTime(st.current ? st.current.duration : 0));
    if (st.engine) bits.push(st.engine);
    el.textContent = bits.join(' • ');
  }

  function renderStrip() {
    var wrap = $('stu-sections'); if (!wrap) return;
    wrap.innerHTML = '';
    var bd = bounds(), dur = st.current ? st.current.duration : 1;
    st.sections.forEach(function (s, i) {
      var d = document.createElement('div');
      d.className = 'stu-sec' + (i === st.sel ? ' sel' : '');
      d.style.background = sectionColor(s);
      d.style.minWidth = Math.max(84, Math.round((s.lenSec / dur) * 560)) + 'px';
      var nm = document.createElement('div'); nm.textContent = s.name;
      var k = document.createElement('span'); k.className = 'k';
      k.textContent = fmtTime(bd[i].a) + '–' + fmtTime(bd[i].b);
      d.appendChild(nm); d.appendChild(k);
      d.setAttribute('role', 'button');
      d.setAttribute('aria-label', 'Edit section ' + s.name);
      (function (idx) { d.addEventListener('click', function () { selectSection(idx); }); })(i);
      wrap.appendChild(d);
    });
  }

  function barBeatMarkers() {
    var mk = [], dur = st.current ? st.current.duration : 0;
    var bar = st.barSec, beat = bar / 4;
    var nBeats = Math.floor(dur / beat);
    for (var t = 0; t <= dur + 1e-6; t += bar) mk.push({ t: t, color: '#ffd54a' });
    if (nBeats <= 400)
      for (var b = beat; b < dur; b += beat) {
        if (Math.abs(b / bar - Math.round(b / bar)) < 1e-6) continue;
        mk.push({ t: b, color: '#29b6f6' });
      }
    return mk;
  }

  function refreshWave() {
    var cv = $('stu-wave'); if (!cv || !st.current) return;
    if (!waveView) {
      waveView = RM.wave.createView(cv);
      waveView.onSeek = function (sec) { seek(clamp(sec, 0, st.current.duration - 0.05)); };
    }
    var buf = st.current;
    RM.wave.getPeaks(buf, 1600).then(function (peaks) {
      if (st.current !== buf) return; // superseded
      waveView.setBuffer(buf, peaks);
      waveView.setZoom(st.zoom);
      waveView.setMarkers(barBeatMarkers());
      var sc = $('stu-scroll');
      waveView.setScroll(sc ? (+sc.value) / 1000 : 0);
      waveView.setPlayhead(tp.playing ? playheadNow() : tp.offset);
      waveView.draw();
    });
  }

  function renderAll() {
    renderMeta(); renderStrip(); refreshWave(); renderEditPanel(); renderLanes(); updateAB();
  }

  /* ---- edit panel ---- */

  function vocalSources() {
    var seen = {}, out = [];
    st.sections.forEach(function (s) {
      if (s.kind === 'vocal' && s.vocalSong != null && !seen[s.vocalSong]) {
        seen[s.vocalSong] = 1; out.push(s.vocalSong);
      }
    });
    return out.sort();
  }

  function selectSection(i) {
    st.sel = i;
    renderStrip(); renderEditPanel();
  }

  function renderEditPanel() {
    var p = $('stu-edit'); if (!p) return;
    var s = st.sections[st.sel];
    if (!s) { p.hidden = true; return; }
    p.hidden = false;
    var nm = $('stu-edit-name');
    var bd = bounds()[st.sel];
    if (nm) nm.textContent = s.name + '  •  ' + fmtTime(bd.a) + '–' + fmtTime(bd.b) +
      '  •  ' + Math.round(s.lenSec * 10) / 10 + 's';
    // Vocal source: only meaningful with ≥2 distinct vocal sources.
    var row = $('stu-vocal-row'), sel = $('stu-vocal-src');
    var srcs = vocalSources();
    var showVocal = s.kind === 'vocal' && srcs.length >= 2;
    if (row) row.style.display = showVocal ? '' : 'none';
    if (sel && showVocal) {
      sel.innerHTML = '';
      srcs.forEach(function (v) {
        var o = document.createElement('option');
        o.value = String(v); o.textContent = songLabel(v) + (v === s.vocalSong ? ' (current)' : '');
        if (v === s.vocalSong) o.selected = true;
        sel.appendChild(o);
      });
    }
    // Transition select = junction AFTER this section (hidden on the last one).
    var tr = $('stu-trans'), trow = $('stu-trans-row');
    if (trow) trow.style.display = (st.sel >= st.sections.length - 1) ? 'none' : '';
    if (tr) tr.value = st.bounds[st.sel] || 'cut';
    var info = $('stu-selinfo');
    if (info) info.textContent = 'Selected: ' + s.name + ' — edits below apply to this section.';
  }

  /* ---- stem lanes ---- */

  var LANES = [
    { id: 'vocals', name: '🎤 Vocals' },
    { id: 'instrumental', name: '🎹 Instrumental' },
    { id: 'drums', name: '🥁 Drums' },
    { id: 'bass', name: '🎸 Bass' },
  ];

  function renderLanes() {
    var wrap = $('stu-lanes'); if (!wrap) return;
    wrap.innerHTML = '';
    laneViews = {};
    if (!st.stems) {
      var ph = document.createElement('div');
      ph.className = 'muted small';
      ph.textContent = 'No stems extracted yet.';
      wrap.appendChild(ph);
      return;
    }
    LANES.forEach(function (L) {
      var buf = st.stems[L.id]; if (!buf) return;
      var ui = st.laneUI[L.id] || (st.laneUI[L.id] = { mute: false, solo: false, gainDb: 0 });
      var box = document.createElement('div');
      box.className = 'stu-lane';
      var head = document.createElement('div');
      var nm = document.createElement('b'); nm.textContent = L.name;
      head.appendChild(nm);
      box.appendChild(head);
      var cv = document.createElement('canvas');
      box.appendChild(cv);
      var ctr = document.createElement('div'); ctr.className = 'btn-row';
      var mb = document.createElement('button'); mb.className = 'btn small' + (ui.mute ? ' primary' : '');
      mb.textContent = ui.mute ? '🔇 Muted' : '🔈 Mute';
      mb.setAttribute('aria-label', 'Mute ' + L.name);
      var sb = document.createElement('button'); sb.className = 'btn small' + (ui.solo ? ' primary' : '');
      sb.textContent = ui.solo ? '⭐ Solo' : 'Solo';
      sb.setAttribute('aria-label', 'Solo ' + L.name);
      (function (id) {
        mb.addEventListener('click', function () { st.laneUI[id].mute = !st.laneUI[id].mute; renderLanes(); });
        sb.addEventListener('click', function () { st.laneUI[id].solo = !st.laneUI[id].solo; renderLanes(); });
      })(L.id);
      ctr.appendChild(mb); ctr.appendChild(sb);
      box.appendChild(ctr);
      var lab = document.createElement('label'); lab.className = 'muted small';
      lab.textContent = 'Volume ';
      var rg = document.createElement('input');
      rg.type = 'range'; rg.min = '-12'; rg.max = '6'; rg.step = '1'; rg.value = String(ui.gainDb);
      rg.setAttribute('aria-label', L.name + ' volume');
      var vv = document.createElement('span'); vv.textContent = ' ' + ui.gainDb + ' dB';
      (function (id, vEl) {
        rg.addEventListener('input', function () {
          st.laneUI[id].gainDb = +rg.value; vEl.textContent = ' ' + rg.value + ' dB';
        });
      })(L.id, vv);
      lab.appendChild(rg); lab.appendChild(vv);
      box.appendChild(lab);
      wrap.appendChild(box);
      // Mini waveform (reuse RM.wave).
      try {
        var v = RM.wave.createView(cv);
        laneViews[L.id] = v;
        (function (vv2, bb) {
          RM.wave.getPeaks(bb, 400).then(function (pk) { vv2.setBuffer(bb, pk); vv2.draw(); });
        })(v, buf);
      } catch (e) {}
    });
  }

  /* ================= transport ================= */

  function viewBuffer() { return st.ab === 'A' ? st.original : st.current; }

  function playheadNow() {
    if (!st.current) return 0;
    var t = tp.offset;
    if (tp.playing) { try { t = tp.offset + (actx().currentTime - tp.startCtx); } catch (e) {} }
    return clamp(t, 0, st.current.duration);
  }

  function stopSrc() {
    if (tp.src) { try { tp.src.onended = null; tp.src.stop(); } catch (e) {} try { tp.src.disconnect(); } catch (e) {} }
    tp.src = null;
  }
  function stopPlayback(reset) {
    stopSrc();
    tp.playing = false;
    if (reset) tp.offset = 0;
    if (tp.raf) { cancelAnimationFrame(tp.raf); tp.raf = 0; }
    var pb = $('stu-play'); if (pb) pb.textContent = '▶';
    drawPlayhead();
  }

  function drawPlayhead() {
    if (waveView && st.current) {
      waveView.setPlayhead(tp.playing ? playheadNow() : tp.offset);
      waveView.draw();
    }
    var te = $('stu-time');
    if (te && st.current) te.textContent = fmtTime(playheadNow()) + ' / ' + fmtTime(st.current.duration);
  }

  function tick() {
    if (!tp.playing) return;
    drawPlayhead();
    if (playheadNow() >= st.current.duration - 0.03) { stopPlayback(true); return; }
    tp.raf = requestAnimationFrame(tick);
  }

  function startAt(buf, offset) {
    stopSrc();
    var ctx = actx();
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(RM.audio.masterIn());
    var off = clamp(offset, 0, Math.max(0, buf.duration - 0.05));
    src.onended = function () { if (tp.src === src) stopPlayback(true); };
    tp.src = src; tp.offset = off; tp.startCtx = ctx.currentTime; tp.playing = true;
    src.start(0, off);
    var pb = $('stu-play'); if (pb) pb.textContent = '⏸';
    if (tp.raf) cancelAnimationFrame(tp.raf);
    tp.raf = requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (!st.current) { toast('Load a mashup first 🎵'); return; }
    if (tp.playing) { tp.offset = playheadNow(); stopPlayback(false); return; }
    var buf = tp.laneBuf || viewBuffer();
    if (!buf) { toast('Nothing to play'); return; }
    tp.laneBuf = null;
    startAt(buf, tp.offset >= buf.duration - 0.05 ? 0 : tp.offset);
  }
  function seek(sec) {
    if (!st.current) return;
    var was = tp.playing;
    if (was) stopSrc(), tp.playing = false;
    tp.offset = clamp(sec, 0, st.current.duration);
    drawPlayhead();
    if (was) startAt(tp.laneBuf || viewBuffer(), tp.offset);
    tp.laneBuf = null;
  }

  function updateAB() {
    var b = $('stu-ab'); if (b) b.textContent = 'A/B: ' + st.ab + (st.ab === 'A' ? ' (Original)' : ' (Edited)');
  }
  function toggleAB() {
    if (!st.original || !st.current) return;
    var keep = tp.playing ? playheadNow() : tp.offset;
    st.ab = (st.ab === 'A') ? 'B' : 'A';
    updateAB();
    // Instant switch: keep playing at the same position on the other buffer.
    if (tp.playing) startAt(viewBuffer(), Math.min(keep, viewBuffer().duration - 0.05));
    else { tp.offset = keep; drawPlayhead(); }
    toast(st.ab === 'A' ? 'A — original render' : 'B — your edits');
  }

  /* ================= edits (all REAL buffer ops) ================= */

  function replaceCurrent(nb, keepSections) {
    if (!nb) return false;
    try { RM.wave.dropPeaks(st.current); } catch (e) {}
    st.current = nb;
    if (!keepSections) { /* sections already updated by caller */ }
    tp.offset = clamp(tp.offset, 0, nb.duration);
    renderAll();
    return true;
  }

  function needSel() {
    if (st.sel < 0 || !st.sections[st.sel]) { toast('Select a section first'); return null; }
    return st.sections[st.sel];
  }

  // Split selected section at the playhead (or its midpoint). Buffer audio
  // is untouched — the region is divided; the junction gets a click guard.
  function splitSection() {
    var s = needSel(); if (!s || st.busy) return;
    var bd = bounds(), i = st.sel;
    var at = tp.playing ? playheadNow() : tp.offset;
    var rel = (at > bd[i].a + 0.1 && at < bd[i].b - 0.1) ? at - bd[i].a : s.lenSec / 2;
    if (rel <= 0.1 || rel >= s.lenSec - 0.1) { toast('Section too short to split'); return; }
    var jType = st.bounds[i] || 'cut';
    var a = { id: nextId('s'), name: s.name + ' A', kind: s.kind, vocalSong: s.vocalSong, lenSec: rel };
    var b = { id: nextId('s'), name: s.name + ' B', kind: s.kind, vocalSong: s.vocalSong, lenSec: s.lenSec - rel };
    st.sections.splice(i, 1, a, b);
    st.bounds.splice(i, 1, 'cut', jType);
    st.sel = i;
    renderAll();
    toast('Split ✓');
  }

  function deleteSection() {
    var s = needSel(); if (!s || st.busy) return;
    if (st.sections.length <= 1) { toast('Cannot delete the only section'); return; }
    var bd = bounds(), i = st.sel;
    var parts = [];
    if (bd[i].a > 0.001) parts.push(sliceBuf(st.current, 0, bd[i].a));
    if (bd[i].b < st.current.duration - 0.001) parts.push(sliceBuf(st.current, bd[i].b, st.current.duration));
    var nb = concatBufs(parts);
    st.sections.splice(i, 1);
    st.bounds.splice(Math.min(i, st.bounds.length - 1), 1);
    resetBounds();
    st.sel = Math.min(i, st.sections.length - 1);
    replaceCurrent(nb, true);
    toast('Section deleted ✓');
  }

  function duplicateSection() {
    var s = needSel(); if (!s || st.busy) return;
    var bd = bounds(), i = st.sel;
    var seg = sliceBuf(st.current, bd[i].a, bd[i].b);
    var nb = concatBufs([sliceBuf(st.current, 0, bd[i].b), seg, sliceBuf(st.current, bd[i].b, st.current.duration)]);
    st.sections.splice(i + 1, 0, { id: nextId('s'), name: s.name + ' (copy)', kind: s.kind, vocalSong: s.vocalSong, lenSec: s.lenSec });
    st.bounds.splice(i + 1, 0, 'cut');
    replaceCurrent(nb, true);
    toast('Duplicated ✓');
  }

  function moveSection(dir) {
    var s = needSel(); if (!s || st.busy) return;
    var i = st.sel, j = i + dir;
    if (j < 0 || j >= st.sections.length) { toast('Nowhere to move'); return; }
    // Adjacent sections: rebuild the buffer with the two regions swapped.
    var lo = Math.min(i, j), hi = Math.max(i, j);
    var L = bounds()[lo], R = bounds()[hi];
    var nb = concatBufs([
      sliceBuf(st.current, 0, L.a),
      sliceBuf(st.current, R.a, R.b),
      sliceBuf(st.current, L.a, L.b),
      sliceBuf(st.current, R.b, st.current.duration),
    ]);
    var tmp = st.sections[lo]; st.sections[lo] = st.sections[hi]; st.sections[hi] = tmp;
    resetBounds();
    st.sel = j;
    replaceCurrent(nb, true);
    toast('Moved ✓');
  }

  // Nudge = cut the section and re-insert ±bars in time (real reposition).
  function nudgeSection(bars) {
    var s = needSel(); if (!s || st.busy) return;
    var bd = bounds(), i = st.sel;
    var seg = sliceBuf(st.current, bd[i].a, bd[i].b);
    if (!seg) return;
    var rest = concatBufs([
      sliceBuf(st.current, 0, bd[i].a),
      sliceBuf(st.current, bd[i].b, st.current.duration),
    ]);
    var target = clamp(bd[i].a + bars * st.barSec, 0, rest.duration);
    var nb = concatBufs([sliceBuf(rest, 0, target), seg, sliceBuf(rest, target, rest.duration)]);
    // Rebuild section order: remove i, re-insert at the position whose
    // cumulative time best matches the target.
    var moved = st.sections.splice(i, 1)[0];
    var t = 0, at = 0;
    for (var k = 0; k <= st.sections.length; k++) {
      if (t + (k < st.sections.length ? st.sections[k].lenSec / 2 : 0) >= target) { at = k; break; }
      if (k < st.sections.length) t += st.sections[k].lenSec;
      at = k + 1;
    }
    st.sections.splice(at, 0, moved);
    resetBounds();
    st.sel = at;
    replaceCurrent(nb, true);
    toast('Nudged ' + (bars > 0 ? '+' : '') + bars + ' bar ✓');
  }

  function trimSection(edge, dSec) {
    var s = needSel(); if (!s || st.busy) return;
    var i = st.sel;
    if (s.lenSec - dSec < 0.25) { toast('Section too short to trim'); return; }
    var bd = bounds()[i];
    var na = bd.a + (edge === 'start' ? dSec : 0);
    var nb2 = bd.b - (edge === 'end' ? dSec : 0);
    var nb = concatBufs([
      sliceBuf(st.current, 0, bd.a),
      sliceBuf(st.current, na, nb2),
      sliceBuf(st.current, bd.b, st.current.duration),
    ]);
    s.lenSec -= dSec;
    resetBounds();
    replaceCurrent(nb, true);
    toast('Trimmed ✓');
  }

  function resetBounds() {
    st.bounds = st.sections.slice(0, -1).map(function () { return 'cut'; });
  }

  // Apply fade in/out + volume + vocal source + transition for the section.
  // Vocal swap is async; the rest applies first, then the swap re-renders.
  function applySectionEdit() {
    var s = needSel(); if (!s || st.busy) return;
    var i = st.sel, bd = bounds()[i];
    var nb = dupBuf(st.current);
    var fi = +($('stu-fadein') || {}).value || 0;
    var fo = +($('stu-fadeout') || {}).value || 0;
    if (fi > 0) fadeRegion(nb, bd.a, bd.b, Math.min(fi, s.lenSec / 2), 'in');
    if (fo > 0) fadeRegion(nb, bd.a, bd.b, Math.min(fo, s.lenSec / 2), 'out');
    var vdb = +(($('stu-vol') || {}).value || 0);
    if (vdb !== 0) gainRegion(nb, bd.a, bd.b, dbToGain(vdb));
    // Transition AFTER this section (no-op on the last section — no "next").
    var tr = (($('stu-trans') || {}).value) || 'cut';
    if (i < st.sections.length - 1) {
      st.bounds[i] = tr;
      nb = renderJunction(nb, i, tr);
    }
    var oldBuf = st.current;
    st.current = nb;
    try { RM.wave.dropPeaks(oldBuf); } catch (e) {}
    // Vocal source swap (async, Smart DSP).
    var vsel = $('stu-vocal-src');
    var want = vsel && vsel.style.display !== 'none' ? parseInt(vsel.value, 10) : NaN;
    var vv = $('stu-vol-v'); if (vv) vv.textContent = '0 dB';
    var vr = $('stu-vol'); if (vr) vr.value = '0';
    renderAll();
    if (!isNaN(want) && want !== s.vocalSong && s.kind === 'vocal') {
      swapVocalSource(i, want);
    } else {
      toast('Section updated ✓');
    }
  }

  /* ---- junctions: re-render the boundary AFTER section i ----
     xfade: 0.5-bar equal-power crossfade (buffer shrinks by xSec;
            section i keeps its length, section i+1 shrinks).
     dip:   0.25-bar fade-out + fade-in (length unchanged).
     cut:   5 ms click guard (length unchanged). */
  function renderJunction(buf, i, type) {
    if (i < 0 || i >= st.sections.length - 1) return buf;
    var bd = bounds(), at = bd[i].b, sr = buf.sampleRate;
    if (type === 'xfade') {
      var x = Math.round(0.5 * st.barSec * sr);
      x = Math.min(x, Math.floor(sr * at) - 1, buf.length - Math.floor(sr * at) - 1);
      if (x < 16) return buf;
      var halfPi = Math.PI / 2;
      var mixed = actx().createBuffer(buf.numberOfChannels, x, sr);
      for (var ch = 0; ch < buf.numberOfChannels; ch++) {
        var d = buf.getChannelData(ch), m = mixed.getChannelData(ch);
        var a0 = Math.floor(sr * at) - x;
        for (var k = 0; k < x; k++) {
          var g = Math.sin(halfPi * k / x); // 0→1
          m[k] = d[a0 + k] * Math.cos(halfPi * k / x) + d[a0 + x + k] * g;
        }
      }
      var nb = concatBufs([
        sliceBuf(buf, 0, at - x / sr),
        mixed,
        sliceBuf(buf, at + x / sr, buf.duration),
      ]);
      st.sections[i + 1].lenSec = Math.max(0.25, st.sections[i + 1].lenSec - x / sr);
      return nb;
    }
    var nb2 = dupBuf(buf);
    if (type === 'dip') {
      var dd = Math.min(0.25 * st.barSec, 2);
      fadeRegion(nb2, at - dd, at, dd, 'out');
      fadeRegion(nb2, at, at + dd, dd, 'in');
    } else { // cut: click guard
      fadeRegion(nb2, at - 0.005, at, 0.005, 'out');
      fadeRegion(nb2, at, at + 0.005, 0.005, 'in');
    }
    return nb2;
  }

  /* ---- vocal source swap (Smart DSP, real) ----
     Replaces section i's vocal with another section's isolated vocal:
     vocalCut both sections -> instrumental(i) + vocal(j), re-summed.
     For mega/swap modes this genuinely changes WHICH SONG's vocal sings. */
  function pickStem(results, re, fallbackIdx) {
    if (!results) return null;
    for (var i = 0; i < results.length; i++)
      if (results[i] && re.test(results[i].name || '')) return results[i].buffer;
    return (results[fallbackIdx] && results[fallbackIdx].buffer) || null;
  }
  function swapVocalSource(i, targetSong) {
    var s = st.sections[i];
    if (!s || s.kind !== 'vocal' || st.busy) return;
    var j = -1;
    for (var k = 0; k < st.sections.length; k++)
      if (k !== i && st.sections[k].kind === 'vocal' && st.sections[k].vocalSong === targetSong) { j = k; break; }
    if (j < 0) { toast('No section sings ' + songLabel(targetSong)); return; }
    if (!RM.stems || typeof RM.stems.run !== 'function') { toast('Stem engine not ready'); return; }
    st.busy = true; setProg('Smart DSP: isolating vocals…', 0.1);
    var bd = bounds();
    var secI = sliceBuf(st.current, bd[i].a, bd[i].b);
    var secJ = sliceBuf(st.current, bd[j].a, bd[j].b);
    RM.stems.run('vocalcut', secI, function (p) { setProg('Smart DSP: isolating vocals…', 0.1 + p * 0.4); })
      .then(function (ri) {
        setProg('Smart DSP: isolating source vocal…', 0.5);
        return RM.stems.run('vocalcut', secJ, function (p) { setProg('Smart DSP: isolating source vocal…', 0.5 + p * 0.4); })
          .then(function (rj) { return { ri: ri, rj: rj }; });
      })
      .then(function (r) {
        var insI = pickStem(r.ri, /side|instr/i, 1);
        var vocJ = pickStem(r.rj, /center|vocal/i, 0);
        if (!insI || !vocJ) throw new Error('Vocal isolation failed');
        vocJ = fitLength(vocJ, insI.length);
        var out = dupBuf(insI);
        addInto(out, vocJ);
        softLimit(out, 0.95);
        var nb = dupBuf(st.current);
        var sr = nb.sampleRate, a0 = Math.round(bd[i].a * sr);
        for (var ch = 0; ch < nb.numberOfChannels; ch++)
          nb.getChannelData(ch).set(out.getChannelData(Math.min(ch, out.numberOfChannels - 1)), a0);
        s.vocalSong = targetSong;
        s.name = songLabel(targetSong) + ' · Vocal (swapped)';
        st.busy = false; setProg('Vocal source swapped ✓', 1);
        replaceCurrent(nb, true);
        toast('Vocal source: ' + songLabel(targetSong) + ' ✓');
      })
      .catch(function (e) {
        st.busy = false; setProg('', 0);
        toast('Vocal swap failed — try again');
      });
  }

  /* ================= stem extraction + lane mix ================= */

  function extractStems() {
    if (st.busy || !st.current) return;
    if (!RM.stems || typeof RM.stems.run !== 'function') { toast('Stem engine not ready'); return; }
    st.busy = true;
    var cur = st.current;
    setProg('Smart DSP: vocals…', 0.05);
    RM.stems.run('vocalcut', cur, function (p) { setProg('Smart DSP: vocals…', 0.05 + p * 0.3); })
      .then(function (vc) {
        setProg('Smart DSP: drums…', 0.35);
        return RM.stems.run('hpss', cur, function (p) { setProg('Smart DSP: drums…', 0.35 + p * 0.3); })
          .then(function (hp) { return { vc: vc, hp: hp }; });
      })
      .then(function (r) {
        setProg('Smart DSP: bass…', 0.65);
        return RM.stems.run('bass', cur, function (p) { setProg('Smart DSP: bass…', 0.65 + p * 0.3); })
          .then(function (bf) { return { vc: r.vc, hp: r.hp, bf: bf }; });
      })
      .then(function (r) {
        st.stems = {
          vocals: pickStem(r.vc, /center|vocal/i, 0),
          instrumental: pickStem(r.vc, /side|instr/i, 1),
          drums: pickStem(r.hp, /drum|perc/i, 0),
          bass: pickStem(r.bf, /bass/i, 0),
        };
        if (!st.stems.vocals || !st.stems.instrumental) throw new Error('Vocal partition failed');
        st.busy = false; setProg('Stems extracted ✓', 1);
        renderLanes();
        toast('Stems ready 🎚');
      })
      .catch(function (e) {
        st.busy = false; setProg('', 0);
        toast('Stem extraction failed — try a shorter mix');
      });
  }

  // Lane mix = vocals*gV + instrumental*gI (exact partition). Drums/bass
  // are audition references — they overlap the partition, so mixing them in
  // would double-count. Mute/solo respected.
  function laneMixBuffer() {
    if (!st.stems) return null;
    var anySolo = st.laneUI.vocals.solo || st.laneUI.instrumental.solo;
    function g(id) {
      var u = st.laneUI[id];
      if (u.mute) return 0;
      if (anySolo && !u.solo) return 0;
      return dbToGain(u.gainDb);
    }
    var v = dupBuf(st.stems.vocals), ins = dupBuf(st.stems.instrumental);
    gainRegion(v, 0, v.duration, g('vocals'));
    gainRegion(ins, 0, ins.duration, g('instrumental'));
    addInto(v, ins);
    return softLimit(v, 0.71);
  }
  function auditionLanes() {
    if (!st.stems) { toast('Extract stems first 🔬'); return; }
    var mix = laneMixBuffer(); if (!mix) return;
    tp.laneBuf = mix;
    stopPlayback(false); tp.offset = 0;
    startAt(mix, 0);
  }
  function commitLanes() {
    if (!st.stems) { toast('Extract stems first 🔬'); return; }
    var mix = laneMixBuffer(); if (!mix) return;
    replaceCurrent(mix, true);
    toast('Lane mix applied ✓');
  }

  /* ================= Smart Regenerate (§16) =================
     Each button re-runs ONE stage with a documented parameter change,
     then re-renders. All stages are real on-device DSP ("Smart", not AI).
     "More Lofi / Energetic / Commercial" ALSO map to W3's beat presets:
     when the original song buffer is available (builtin mode), they do a
     REAL rebuild via RM.mashup.buildAuto(song, presetId); otherwise they
     use the Smart-DSP character chain (honest fallback, labelled). */

  function noteLengthChange(oldLen, newLen) {
    if (oldLen > 0 && newLen > 0 && oldLen !== newLen) scaleSections(newLen / oldLen);
  }
  function detectBpmSafe(buf) {
    try {
      return Promise.resolve(RM.audio.detectBPM(buf)).then(function (b) {
        b = +b; return (isFinite(b) && b >= 40 && b <= 260) ? b : null;
      });
    } catch (e) { return Promise.resolve(null); }
  }
  function addReverb(buf, wet, irSec) {
    var ir = RM.audio.buildImpulse(irSec || 1.8, 2.5);
    return offlineRender(buf, function (oc, src) {
      src.connect(oc.destination);
      var cv = oc.createConvolver(); cv.buffer = ir;
      var wg = oc.createGain(); wg.gain.value = wet;
      src.connect(cv); cv.connect(wg); wg.connect(oc.destination);
    });
  }
  function presenceBoost(buf, db, freq) {
    return offlineRender(buf, function (oc, src) {
      var f = oc.createBiquadFilter();
      f.type = 'highshelf'; f.frequency.value = freq || 6000; f.gain.value = db;
      src.connect(f); f.connect(oc.destination);
    });
  }
  function widenStereo(buf, sideGain) {
    return offlineRender(buf, function (oc, src) {
      var sp = oc.createChannelSplitter(2), mg = oc.createChannelMerger(2);
      var mid = oc.createGain(), side = oc.createGain();
      var m1 = oc.createGain(), m2 = oc.createGain();
      var s1 = oc.createGain(), s2 = oc.createGain();
      m1.gain.value = 0.5; m2.gain.value = 0.5;
      s1.gain.value = 0.5 * sideGain; s2.gain.value = -0.5 * sideGain;
      sp.connect(m1, 0); sp.connect(m2, 1); m1.connect(mid); m2.connect(mid);
      sp.connect(s1, 0); sp.connect(s2, 1); s1.connect(side); s2.connect(side);
      var oL1 = oc.createGain(), oL2 = oc.createGain();
      var oR1 = oc.createGain(), oR2 = oc.createGain();
      oR2.gain.value = -1; // outR = mid - side
      mid.connect(oL1); side.connect(oL2); oL1.connect(mg, 0, 0); oL2.connect(mg, 0, 0);
      mid.connect(oR1); side.connect(oR2); oR1.connect(mg, 0, 1); oR2.connect(mg, 0, 1);
      src.connect(sp); mg.connect(oc.destination);
    });
  }

  // Stage 1 — vocals: re-isolate with the Smart DSP vocal-cut engine, then
  // re-balance: vocals +3 dB (x1.4125), bed -1.5 dB (x0.841), limit 0.71.
  function stageVocals(buf, prog) {
    prog('Isolating vocals (Smart DSP)…', 0.1);
    return RM.stems.run('vocalcut', buf, function (p) { prog('Isolating vocals (Smart DSP)…', 0.1 + p * 0.7); })
      .then(function (r) {
        var voc = pickStem(r, /center|vocal/i, 0), ins = pickStem(r, /side|instr/i, 1);
        if (!voc || !ins) throw new Error('vocal isolation failed');
        prog('Re-balancing…', 0.85);
        var v = dupBuf(voc), b2 = dupBuf(ins);
        gainRegion(v, 0, v.duration, 1.4125);
        gainRegion(b2, 0, b2.duration, 0.841);
        addInto(v, b2);
        return { buf: softLimit(v, 0.71) }; // same length: sections untouched
      });
  }
  // Stage 2 — transitions: 0.5-bar equal-power crossfade at EVERY internal
  // boundary (param change: boundary xfade none/mixed -> 0.5 bar xfade).
  function stageTransitions(buf, prog) {
    return new Promise(function (res) {
      var nb = buf, n = st.sections.length;
      for (var i = 0; i < n - 1; i++) {
        nb = renderJunction(nb, i, 'xfade');
        st.bounds[i] = 'xfade';
        prog('Smoothing boundary ' + (i + 1) + '/' + (n - 1) + '…', (i + 1) / n);
      }
      res({ buf: softLimit(nb, 0.71) }); // renderJunction kept sections in sync
    });
  }
  // Stage 3 — beat match: detect BPM, stretch residual drift to exactly 0
  // vs the target BPM (ratio = detected/target), re-limit.
  function stageBeatMatch(buf, prog) {
    prog('Detecting BPM…', 0.1);
    return detectBpmSafe(buf).then(function (det) {
      if (det == null) throw new Error('BPM detect failed');
      var err = Math.abs(det - st.bpm);
      prog('Drift ' + err.toFixed(2) + ' BPM → locking…', 0.3);
      if (err < 0.3) return { buf: buf }; // already locked: honest no-op
      return RM.mashupDSP.timeStretch(buf, det / st.bpm, function (p) { prog('Locking tempo…', 0.3 + p * 0.6); })
        .then(function (b2) {
          noteLengthChange(buf.length, b2.length);
          return { buf: softLimit(b2, 0.71) };
        });
    });
  }
  // Mood — emotional: tempo x0.88, pitch -2 st, 25% convolver reverb.
  function moodEmotional(buf, prog) {
    prog('Slowing (x0.88)…', 0.05);
    return RM.mashupDSP.timeStretch(buf, 1 / 0.88, function (p) { prog('Slowing (x0.88)…', 0.05 + p * 0.35); })
      .then(function (b1) {
        noteLengthChange(buf.length, b1.length);
        prog('Pitch -2 st…', 0.45);
        return RM.mashupDSP.pitchShift(b1, -2, function (p) { prog('Pitch -2 st…', 0.45 + p * 0.25); });
      })
      .then(function (b2) {
        prog('Reverb…', 0.75);
        return addReverb(b2, 0.25, 1.8);
      })
      .then(function (b3) { return { buf: softLimit(b3, 0.71) }; });
  }
  // Mood — energetic: tempo x1.06, pitch +1 st, presence +2.5 dB @6kHz.
  function moodEnergetic(buf, prog) {
    prog('Lifting tempo (x1.06)…', 0.05);
    return RM.mashupDSP.timeStretch(buf, 1 / 1.06, function (p) { prog('Lifting tempo…', 0.05 + p * 0.35); })
      .then(function (b1) {
        noteLengthChange(buf.length, b1.length);
        prog('Pitch +1 st…', 0.45);
        return RM.mashupDSP.pitchShift(b1, 1, function (p) { prog('Pitch +1 st…', 0.45 + p * 0.2); });
      })
      .then(function (b2) { prog('Presence…', 0.7); return presenceBoost(b2, 2.5, 6000); })
      .then(function (b3) { return { buf: softLimit(b3, 0.71) }; });
  }
  // Mood — lofi: W3 'lofi' preset rebuild when the song is available,
  // else Smart DSP: lowpass 7.5 kHz + tape-style tanh saturation + x0.94.
  function moodLofi(buf, prog) {
    if (st.mode === 'builtin' && st.songs[0] && st.songs[0].buffer &&
        RM.mashup && typeof RM.mashup.buildAuto === 'function') {
      prog('Rebuilding with the Lo-Fi beat preset…', 0.1);
      return RM.mashup.buildAuto(st.songs[0].buffer, 'lofi',
        function (l, f) { prog(l || 'Rebuilding…', 0.1 + (f || 0) * 0.8); }, function () {})
        .then(function (res) { return { rebuild: res }; });
    }
    prog('Lo-Fi character (Smart DSP)…', 0.1);
    return offlineRender(buf, function (oc, src) {
      var lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500; lp.Q.value = 0.4;
      var ws = oc.createWaveShaper();
      var curve = new Float32Array(256);
      for (var i = 0; i < 256; i++) { var x = i / 128 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); }
      ws.curve = curve;
      src.connect(lp); lp.connect(ws); ws.connect(oc.destination);
    }).then(function (b1) {
      prog('Tape tempo (x0.94)…', 0.6);
      return RM.mashupDSP.timeStretch(b1, 1 / 0.94, function (p) { prog('Tape tempo…', 0.6 + p * 0.3); });
    }).then(function (b2) {
      noteLengthChange(buf.length, b2.length);
      return { buf: softLimit(b2, 0.71) };
    });
  }
  // Mood — commercial: W3 'pop' preset rebuild when the song is available,
  // else Smart DSP: presence +2 dB, stereo widen x1.25, limit 0.71.
  function moodCommercial(buf, prog) {
    if (st.mode === 'builtin' && st.songs[0] && st.songs[0].buffer &&
        RM.mashup && typeof RM.mashup.buildAuto === 'function') {
      prog('Rebuilding with the Pop beat preset…', 0.1);
      return RM.mashup.buildAuto(st.songs[0].buffer, 'pop',
        function (l, f) { prog(l || 'Rebuilding…', 0.1 + (f || 0) * 0.8); }, function () {})
        .then(function (res) { return { rebuild: res }; });
    }
    prog('Polish (Smart DSP)…', 0.1);
    return presenceBoost(buf, 2, 6000)
      .then(function (b1) { prog('Stereo widen…', 0.5); return widenStereo(b1, 1.25); })
      .then(function (b2) { return { buf: softLimit(b2, 0.71) }; });
  }
  // Arrangement: rotate vocal slots by one (intro/outro/beat fixed).
  // Real section reorder via buffer surgery; slot lengths preserved.
  function arrangeRotate(buf) {
    var idx = [];
    st.sections.forEach(function (s, i) { if (s.kind === 'vocal') idx.push(i); });
    if (idx.length < 2) return Promise.resolve(null);
    var bd = bounds(), sr = buf.sampleRate;
    var audios = idx.map(function (i) { return sliceBuf(buf, bd[i].a, bd[i].b); });
    var metas = idx.map(function (i) { return st.sections[i]; });
    var rotA = audios.slice(1).concat(audios.slice(0, 1));
    var rotM = metas.slice(1).concat(metas.slice(0, 1));
    var nb = dupBuf(buf);
    idx.forEach(function (pos, k) {
      var a0 = Math.round(bd[pos].a * sr);
      var want = Math.round(bd[pos].b * sr) - a0;
      var seg = fitLength(rotA[k], want);
      for (var ch = 0; ch < nb.numberOfChannels; ch++)
        nb.getChannelData(ch).set(seg.getChannelData(Math.min(ch, seg.numberOfChannels - 1)), a0);
      st.sections[pos].vocalSong = rotM[k].vocalSong;
      st.sections[pos].name = rotM[k].name;
    });
    return Promise.resolve({ buf: softLimit(nb, 0.71) });
  }
  function fullRegen(buf, prog) {
    return stageVocals(buf, function (p) { prog('1/3 Vocals…', p * 0.4); })
      .then(function (r1) { return stageTransitions(r1.buf, function (p) { prog('2/3 Transitions…', 0.4 + p * 0.3); }); })
      .then(function (r2) { return stageBeatMatch(r2.buf, function (p) { prog('3/3 Beat match…', 0.7 + p * 0.3); }); });
  }

  var REGENS = [
    { id: 'vocals', name: '🎤 Better Vocals', needsStems: true, param: 'vocalCut re-isolation; vocals ×1.4125 (+3 dB), bed ×0.841 (−1.5 dB), ceiling 0.71', run: stageVocals },
    { id: 'trans', name: '🌊 Better Transitions', param: 'every internal boundary → 0.5-bar equal-power crossfade', run: stageTransitions },
    { id: 'beat', name: '🥁 Better Beat Match', param: 'detectBPM → timeStretch ratio = detected/targetBpm; residual drift → 0', run: stageBeatMatch },
    { id: 'emo', name: '💜 More Emotional', param: 'tempo ×0.88, pitch −2 st, convolver reverb 25% wet (1.8 s IR)', run: moodEmotional },
    { id: 'energy', name: '⚡ More Energetic', param: 'tempo ×1.06, pitch +1 st, highshelf +2.5 dB @ 6 kHz', run: moodEnergetic },
    { id: 'lofi', name: '🌙 More Lofi', param: "W3 preset rebuild via buildAuto(song,'lofi') when song available; else Smart DSP: lowpass 7.5 kHz + tanh tape saturation + tempo ×0.94", run: moodLofi },
    { id: 'commercial', name: '📻 More Commercial', param: "W3 preset rebuild via buildAuto(song,'pop') when song available; else Smart DSP: presence +2 dB, mid-side widen ×1.25, limit 0.71", run: moodCommercial },
    { id: 'arrange', name: '🔀 Change Arrangement', param: 'vocal slots rotated by one position (intro/outro fixed); real buffer re-splice', run: arrangeRotate },
    { id: 'full', name: '✨ Full Regenerate', needsStems: true, param: 'chains Better Vocals → Better Transitions → Better Beat Match', run: fullRegen },
  ];

  function runRegen(def) {
    if (st.busy || !st.current) { if (!st.current) toast('Load a mashup first 🎵'); return; }
    if (def.needsStems && (!RM.stems || typeof RM.stems.run !== 'function')) { toast('DSP engine not ready'); return; }
    st.busy = true;
    stopPlayback(false);
    setProg(def.name + '…', 0);
    var prog = function (l, f) { setProg(l || (def.name + '…'), f == null ? 0.5 : f); };
    Promise.resolve()
      .then(function () { return def.run(st.current, prog); })
      .then(function (r) {
        st.busy = false;
        if (!r) { setProg('', 0); return; } // stage aborted with its own message
        if (!r.buf && !r.rebuild) throw new Error('empty result');
        if (r.rebuild) applyRebuild(r.rebuild);
        else replaceCurrent(r.buf, true);
        setProg('Done ✓', 1);
        toast(def.name + ' ✓');
      })
      .catch(function (e) {
        st.busy = false; setProg('', 0);
        toast('Regenerate failed — try again');
      });
  }

  // A rebuild (W3 preset path) becomes the new baseline: A and B both reset.
  function applyRebuild(res) {
    var buf = res && res.buffer ? res.buffer : null;
    if (!buf) { toast('Rebuild produced no audio'); return; }
    var meta = (res && res.meta) || {};
    try { RM.wave.dropPeaks(st.original); RM.wave.dropPeaks(st.current); } catch (e) {}
    st.original = buf;
    st.current = dupBuf(buf);
    st.meta = meta;
    st.mode = detectMode(meta);
    st.bpm = getBpm(meta, st.mode);
    st.barSec = 240 / st.bpm;
    st.sections = deriveSections(meta, st.mode, st.bpm, st.current.duration);
    resetBounds();
    st.stems = null; st.laneUI = {}; laneViews = {};
    st.ab = 'B'; st.sel = -1; tp.offset = 0; st.zoom = 1;
    var sc = $('stu-scroll'); if (sc) sc.value = '0';
    renderAll();
  }

  /* ================= A/B, export, reset ================= */

  function doExport() {
    if (!st.current) { toast('Load a mashup first 🎵'); return; }
    if (!RM.mashupExport || typeof RM.mashupExport.sendToExport !== 'function') {
      toast('Export module not ready'); return;
    }
    try {
      var meta = {};
      for (var k in st.meta) if (Object.prototype.hasOwnProperty.call(st.meta, k)) meta[k] = st.meta[k];
      meta.name = (st.meta.name || 'Mashup') + ' (Studio edit)';
      meta.style = st.meta.style || 'studio';
      RM.mashupExport.sendToExport(st.current, meta);
    } catch (e) { toast('Could not hand off to export'); }
  }

  function resetEdits() {
    if (!st.original || st.busy) return;
    stopPlayback(true);
    try { RM.wave.dropPeaks(st.current); } catch (e) {}
    st.current = dupBuf(st.original);
    st.sections = deriveSections(st.meta, st.mode, st.bpm, st.current.duration);
    resetBounds();
    st.stems = null; st.laneUI = {}; laneViews = {};
    st.ab = 'B'; st.sel = -1; tp.offset = 0;
    renderAll();
    toast('Edits reset ✓');
  }

  /* ================= open / wiring ================= */

  function showStudio() {
    var a = A();
    try { if (a && typeof a.show === 'function') a.show('studio'); } catch (e) {}
    var el = $('screen-studio');
    // Fallback: if 'studio' is not in app.js SCREENS yet, activate manually.
    if (el && !el.classList.contains('active')) {
      try {
        document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
        el.classList.add('active');
        document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.remove('active'); });
      } catch (e) {}
    }
  }

  // opts: {buffer: AudioBuffer, meta: object, engineTags: string,
  //        songs: [{buffer, name}] (optional — enables W3 preset rebuilds)}
  function open(opts) {
    if (!opts || !opts.buffer || !opts.buffer.getChannelData) { toast('Nothing to open in Studio'); return; }
    stopPlayback(true);
    try { if (st.current) RM.wave.dropPeaks(st.current); } catch (e) {}
    st.original = opts.buffer; // never mutated afterwards
    st.current = dupBuf(opts.buffer);
    st.meta = opts.meta || {};
    st.engine = opts.engineTags || opts.engine || '';
    st.songs = opts.songs || [];
    st.mode = detectMode(st.meta);
    st.bpm = getBpm(st.meta, st.mode);
    st.barSec = 240 / st.bpm;
    st.sections = deriveSections(st.meta, st.mode, st.bpm, st.current.duration);
    resetBounds();
    st.stems = null; st.laneUI = {}; laneViews = {};
    st.ab = 'B'; st.sel = -1; tp.offset = 0; st.zoom = 1; st.busy = false;
    var sc = $('stu-scroll'); if (sc) sc.value = '0';
    renderStudio();
    var empty = $('stu-empty'), main = $('stu-main');
    if (empty) empty.hidden = true;
    if (main) main.hidden = false;
    // Pre-select the first vocal section for one-tap editing.
    for (var i = 0; i < st.sections.length; i++)
      if (st.sections[i].kind === 'vocal') { st.sel = i; break; }
    renderAll();
    showStudio();
    toast('Studio ready 🎚');
  }

  function openFromMashup() {
    var res = null;
    try { res = RM.mashupScreen && typeof RM.mashupScreen.getResult === 'function' ? RM.mashupScreen.getResult() : null; } catch (e) {}
    if (!res || !res.buffer) { toast('Create a mashup first ✨'); return; }
    // NOTE: mashup-screen keeps song buffers private; without them the
    // "More Lofi/Commercial" buttons use the Smart-DSP chain (still real).
    open({ buffer: res.buffer, meta: res.meta || {}, engineTags: res.engine, songs: [] });
  }

  function renderRegenGrid() {
    var g = $('stu-regen-grid'); if (!g) return;
    g.innerHTML = '';
    REGENS.forEach(function (def) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.textContent = def.name;
      b.title = def.param;
      b.setAttribute('aria-label', def.name + '. ' + def.param);
      (function (d) { b.addEventListener('click', function () { runRegen(d); }); })(def);
      g.appendChild(b);
    });
  }

  function wire() {
    if (st._wired) return;
    st._wired = true;
    function on(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
    on('stu-load', openFromMashup);
    on('stu-play', togglePlay);
    on('stu-stop', function () { stopPlayback(true); });
    on('stu-ab', toggleAB);
    on('stu-zin', function () { st.zoom = clamp(st.zoom * 2, 1, 16); if (waveView) { waveView.setZoom(st.zoom); waveView.draw(); } });
    on('stu-zout', function () { st.zoom = clamp(st.zoom / 2, 1, 16); if (waveView) { waveView.setZoom(st.zoom); waveView.draw(); } });
    var sc = $('stu-scroll');
    if (sc) sc.addEventListener('input', function () { if (waveView) { waveView.setScroll((+sc.value) / 1000); waveView.draw(); } });
    on('stu-split', splitSection);
    on('stu-del', deleteSection);
    on('stu-dup', duplicateSection);
    on('stu-nudge-l', function () { nudgeSection(-1); });
    on('stu-nudge-r', function () { nudgeSection(1); });
    on('stu-trim-s', function () { trimSection('start', 0.5); });
    on('stu-trim-e', function () { trimSection('end', 0.5); });
    on('stu-apply-edit', applySectionEdit);
    var vv = $('stu-vol-v'), vr = $('stu-vol');
    if (vr && vv) vr.addEventListener('input', function () { vv.textContent = vr.value + ' dB'; });
    on('stu-stems', extractStems);
    on('stu-audition', auditionLanes);
    on('stu-commit-lanes', commitLanes);
    on('stu-export', doExport);
    on('stu-reset', resetEdits);
    renderRegenGrid();
  }

  // Inserts <section id="screen-studio"> (idempotent) and wires controls.
  function renderStudio() {
    if (typeof document === 'undefined') return;
    if (!$('screen-studio')) {
      var host = ($('screen-export') && $('screen-export').parentNode) || document.body;
      var tmp = document.createElement('div');
      tmp.innerHTML = STUDIO_HTML;
      if (tmp.firstChild) host.appendChild(tmp.firstChild);
    }
    wire();
  }

  // Stop Studio playback whenever the user leaves the screen (same chaining
  // pattern as mashup-screen.js). Re-asserted — app.js assigns A.onShow
  // after this file's boot listener runs (script order).
  function wrapOnShow() {
    var a = A();
    if (!a || a.onShow === st._hook) return;
    var prev = a.onShow;
    st._hook = function (name) {
      try { if (typeof prev === 'function') prev(name); } catch (e) {}
      try { if (name !== 'studio') stopPlayback(false); } catch (e) {}
    };
    a.onShow = st._hook;
  }
  function ready(attempts) {
    if (typeof document !== 'undefined' && RM.app && $('stu-load')) {
      wrapOnShow();
      setTimeout(wrapOnShow, 600);
      setTimeout(wrapOnShow, 2000);
      return;
    }
    if (attempts <= 0) return;
    setTimeout(function () { ready(attempts - 1); }, 200);
  }
  function boot() {
    renderStudio();
    ready(50);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  RM.v25studio = {
    STUDIO_HTML: STUDIO_HTML,
    renderStudio: renderStudio,
    open: open,
    openFromMashup: openFromMashup,
    // read-only state for the coordinator / tests
    getState: function () {
      return {
        mode: st.mode, bpm: st.bpm, ab: st.ab, busy: st.busy,
        sections: st.sections.map(function (s) { return { name: s.name, kind: s.kind, vocalSong: s.vocalSong, lenSec: Math.round(s.lenSec * 100) / 100 }; }),
        hasStems: !!st.stems,
      };
    },
    REGENS: REGENS.map(function (d) { return { id: d.id, name: d.name, param: d.param }; }),
  };

  // Node unit-test hook (browser-harmless): pure functions only.
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { open: open, renderStudio: renderStudio },
        internals: {
          detectMode: detectMode, getBpm: getBpm, deriveSections: deriveSections,
          fmtTime: fmtTime, dbToGain: dbToGain, clamp: clamp,
          REGEN_PARAMS: REGENS.map(function (d) { return { id: d.id, param: d.param }; }),
        },
      };
    }
  } catch (e) {}
})();
