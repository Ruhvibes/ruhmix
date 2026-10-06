'use strict';
/* =====================================================================
   RuhMix — v25-create.js (W2)
   "Create Your Mashup" screen + multi-stage analysis (spec §2, §3).

   Module: window.RM.v25create

   §2 — Create screen:
     • Title "Create Your Mashup", description: "Add at least 2 songs.
       Add as many songs as you want depending on available processing
       resources."
     • Dynamic "+ Add Song": min 2, max 10 songs.
     • At 8+ songs: memory warning "⚠️ 8+ songs need more memory —
       processing will be slower."
     • Song card: song name, artist/file name, duration, BPM
       (auto-detected), key (auto-detected), mini waveform (canvas),
       remove ✕, reorder ↑↓, enable/disable toggle.
     • Formats: MP3/WAV/M4A/AAC/FLAC — via the EXACT #cdx-pick import
       flow (RM.ux.pickMusic()), the same path mashup-screen.js uses.
       No reinvented importer.

   §3 — analysis progress ("Analyzing your songs..."). ONLY stages with a
   REAL implementation are rendered; the rest are OMITTED from the UI
   (never fake progress):
     1. Detecting BPM       -> RM.audio.detectBPM (onset-energy DSP)
     2. Detecting Key       -> RM.mashupDSP.detectKey (chroma + Krumhansl)
     3. Detecting Structure -> OMITTED — no real structure/downbeat
                               detection exists in the codebase.
     4. Separating Stems    -> RM.mashupStems.provider (neural when the
                               user's own HF Space is configured, else
                               Smart DSP)
     5. Compatible Sections -> OMITTED — no real section-finder exists;
                               BPM/key compatibility is computed inside
                               the build itself.
     6. Building Arrangement-> RM.mashupMega.build (2–8 songs) or the
                               v25 extended pipeline (9–10 songs) built
                               from the same real public functions.
     7. Mixing              -> real: buildTimeline's balance + sidechain
                               duck + vocal glue (driven by its progress).
     8. Mastering           -> real: buildTimeline's bus compression +
                               30 Hz high-pass + true-peak limiter.

   HONESTY:
     • DSP-based detection is labelled "Smart" ("Smart BPM detect",
       "Smart key detect"). "AI" appears ONLY where the HF neural
       backend actually ran (stem tag === 'neural stems').
     • No placeholder buttons: Create is disabled with < 2 enabled songs
       and says why. The engine-missing case shows an honest message.

   Does NOT touch any existing file. Coordinator wires this screen into
   the nav (RM.app.show('v25create')) and the app.js pick interception.
   ===================================================================== */
window.RM = window.RM || {};

(function () {
  var RM = window.RM;
  function A() { return RM.app || null; }
  function $(id) { return document.getElementById(id); }

  var MIN_SONGS = 2, MAX_SONGS = 10, MEM_WARN_AT = 8;
  var SCREEN_ID = 'screen-v25create';

  var st = {
    songs: [],          // [{ id, buffer, name, fileName, enabled, bpm, key, analyzing, err }]
    pickId: null,       // pending pick song id (null = none)
    creating: false,
    stageState: {},     // stageKey -> 'pending'|'active'|'done'|'error'
    result: null,       // { buffer, meta, engine }
    pvSrc: null,
    nextId: 1,
    _wired: false,
    _hook: null,
  };

  /* ================= pure helpers (node-testable) ================= */

  function formatDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function displayName(name) {
    var n = String(name || 'Song').trim() || 'Song';
    // strip a trailing audio extension for a cleaner card title
    return n.replace(/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i, '');
  }

  function keyLabel(k) {
    if (!k || typeof k !== 'object') return '—';
    var nm = String(k.key || '').toUpperCase();
    if (!nm) return '—';
    var mode = (k.mode === 'minor') ? 'min' : 'maj';
    var conf = (typeof k.confidence === 'number') ? k.confidence : null;
    var s = nm + ' ' + mode;
    if (conf !== null) s += ' (' + Math.round(conf * 100) + '%)';
    return s;
  }

  // The stage list the UI actually renders. Stages WITHOUT a real
  // implementation (3 = structure, 5 = compatible sections) are not in
  // this list at all — see buildStageList().
  function buildStageList() {
    return [
      { key: 'bpm',     n: 1, label: 'Detecting BPM',    sub: 'Smart BPM detect — onset-energy analysis' },
      { key: 'key',     n: 2, label: 'Detecting Key',    sub: 'Smart key detect — chromagram + key-profile match' },
      { key: 'stems',   n: 4, label: 'Separating Stems', sub: 'AI stems (your HF Space) — or Smart DSP fallback' },
      { key: 'arrange', n: 6, label: 'Building Arrangement', sub: 'Vocals on the master grid, beat underneath' },
      { key: 'mix',     n: 7, label: 'Mixing',           sub: 'Balance, sidechain ducking, vocal glue' },
      { key: 'master',  n: 8, label: 'Mastering',        sub: 'Bus compression, 30 Hz filter, true-peak limit' },
    ];
  }

  function setStage(key, state, note) {
    st.stageState[key] = { state: state, note: note || '' };
    var row = document.querySelector('[data-stage="' + key + '"]');
    if (!row) return;
    row.className = 'v25-stage ' + state;
    var dot = row.querySelector('.v25-stage-dot');
    if (dot) dot.textContent = state === 'done' ? '✓' : state === 'active' ? '●' : state === 'error' ? '!' : '○';
    var sub = row.querySelector('.v25-stage-sub');
    if (sub && note) sub.textContent = note;
  }

  function allStages(state) {
    buildStageList().forEach(function (s) { setStage(s.key, state, state === 'pending' ? s.sub : ''); });
  }

  // Honest engine label from real per-song provider tags (same rule as
  // mashup-screen.js: 'smart DSP (neural failed)' must NOT count as neural).
  function honestEngineLabel(tags) {
    var list = (tags || []).filter(function (t) { return typeof t === 'string' && t; });
    function isNeural(t) { return /neural/i.test(t) && !/neural failed/i.test(t); }
    var n = 0, i;
    for (i = 0; i < list.length; i++) if (isNeural(list[i])) n++;
    if (list.length > 0 && n === list.length) return 'Neural stems engine';
    if (n > 0) return 'Smart DSP + neural stems';
    if (/failed/i.test(list.join(' '))) return 'Smart DSP engine (neural unavailable)';
    return 'Smart DSP engine';
  }

  function isAudioBuffer(b) {
    return !!(b && typeof b.getChannelData === 'function' &&
              typeof b.sampleRate === 'number' && typeof b.length === 'number');
  }

  /* ================= songs ================= */

  function enabledSongs() {
    return st.songs.filter(function (s) { return s && s.enabled && s.buffer; });
  }

  function getSong(id) {
    for (var i = 0; i < st.songs.length; i++) if (st.songs[i].id === id) return st.songs[i];
    return null;
  }

  // Runs the REAL per-song analysis (BPM + key) as soon as the song lands.
  // Results show on the card; the create flow reuses the cached values.
  function analyzeSong(song) {
    if (!song || !isAudioBuffer(song.buffer) || song.analyzing) return;
    song.analyzing = true;
    song.err = null;
    renderSongs();
    var bpmP = (RM.audio && typeof RM.audio.detectBPM === 'function')
      ? RM.audio.detectBPM(song.buffer, function () {})
      : Promise.reject(new Error('BPM detection not available'));
    var keyP = (RM.mashupDSP && typeof RM.mashupDSP.detectKey === 'function')
      ? RM.mashupDSP.detectKey(song.buffer, function () {})
      : Promise.reject(new Error('Key detection not available'));
    Promise.allSettled
      ? Promise.allSettled([bpmP, keyP]).then(function (r) {
          if (r[0].status === 'fulfilled') {
            var b = Number(r[0].value);
            song.bpm = (isFinite(b) && b >= 50 && b <= 220) ? Math.round(b * 10) / 10 : null;
          }
          if (r[1].status === 'fulfilled') song.key = r[1].value || null;
          song.analyzing = false;
          if (!song.bpm && !song.key) song.err = 'Analysis failed on this file';
          renderSongs();
        })
      : Promise.all([bpmP.catch(function () { return null; }), keyP.catch(function () { return null; })])
          .then(function (r) {
            if (r[0]) { var b = Number(r[0]); song.bpm = (isFinite(b) && b >= 50 && b <= 220) ? Math.round(b * 10) / 10 : null; }
            if (r[1]) song.key = r[1];
            song.analyzing = false;
            renderSongs();
          });
  }

  /* ================= screen DOM (self-built, no existing edits) ================= */

  function screenEl() {
    var el = $(SCREEN_ID);
    if (el) return el;
    el = document.createElement('section');
    el.className = 'screen';
    el.id = SCREEN_ID;
    el.innerHTML =
      '<div class="wrap">' +
      '  <h2>Create Your Mashup</h2>' +
      '  <p class="muted v25-desc">Add at least 2 songs. Add as many songs as you want depending on available processing resources.</p>' +
      '  <p class="muted small v25-formats">Formats: MP3 · WAV · M4A · AAC · FLAC (as decoded by your device)</p>' +
      '  <div id="v25-memwarn" class="v25-memwarn" hidden>⚠️ 8+ songs need more memory — processing will be slower.</div>' +
      '  <div id="v25-songs" class="v25-songs"></div>' +
      '  <button id="v25-add" class="btn big block">＋ Add Song</button>' +
      '  <div id="v25-count" class="muted small v25-count"></div>' +
      '  <button id="v25-create" class="btn primary big block" disabled>Create Mashup ✨</button>' +
      '  <div id="v25-hint" class="muted small v25-hint">Pick at least 2 songs to create a mashup.</div>' +
      '  <div id="v25-progress" class="v25-progress" hidden>' +
      '    <div class="v25-prog-head">Analyzing your songs…</div>' +
      '    <div class="v25-prog-track"><div id="v25-prog-bar" class="v25-prog-bar"></div></div>' +
      '    <div id="v25-prog-label" class="muted small"></div>' +
      '    <div id="v25-stages" class="v25-stages"></div>' +
      '    <button id="v25-cancel" class="btn small" hidden>Cancel</button>' +
      '  </div>' +
      '  <div id="v25-result" class="v25-result" hidden>' +
      '    <div id="v25-engine" class="muted small"></div>' +
      '    <div id="v25-meta" class="muted small"></div>' +
      '    <div class="v25-result-row">' +
      '      <button id="v25-play" class="btn big">▶ Preview</button>' +
      '      <button id="v25-export" class="btn big primary">Export ⤴</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    var host = document.querySelector('.screens') || document.body;
    host.appendChild(el);
    return el;
  }

  function setProgress(label, frac) {
    var lb = $('v25-prog-label'), bar = $('v25-prog-bar');
    if (lb) lb.textContent = label || '';
    if (bar) bar.style.width = Math.max(0, Math.min(100, Math.round((frac || 0) * 100))) + '%';
  }

  function renderStageList() {
    var wrap = $('v25-stages');
    if (!wrap) return;
    wrap.innerHTML = '';
    buildStageList().forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'v25-stage pending';
      row.setAttribute('data-stage', s.key);
      var dot = document.createElement('span');
      dot.className = 'v25-stage-dot';
      dot.textContent = '○';
      var tx = document.createElement('div');
      tx.className = 'v25-stage-tx';
      var t = document.createElement('div');
      t.className = 'v25-stage-title';
      t.textContent = s.n + '. ' + s.label;
      var sub = document.createElement('div');
      sub.className = 'v25-stage-sub muted small';
      sub.textContent = s.sub;
      tx.appendChild(t);
      tx.appendChild(sub);
      row.appendChild(dot);
      row.appendChild(tx);
      wrap.appendChild(row);
    });
  }

  /* ================= song cards ================= */

  function drawWaveform(canvas, buffer) {
    if (!canvas || !isAudioBuffer(buffer)) return;
    try {
      var ctx = canvas.getContext('2d');
      var W = canvas.width = 120, H = canvas.height = 36;
      ctx.clearRect(0, 0, W, H);
      var ch = buffer.getChannelData(0);
      var step = Math.max(1, Math.floor(ch.length / W));
      ctx.fillStyle = '#7CFC98';
      for (var x = 0; x < W; x++) {
        var peak = 0, off = x * step, end = Math.min(ch.length, off + step);
        for (var i = off; i < end; i += 4) {
          var v = Math.abs(ch[i]);
          if (v > peak) peak = v;
        }
        var h = Math.max(1, Math.round(peak * H));
        ctx.fillRect(x, (H - h) / 2, 1, h);
      }
    } catch (e) {}
  }

  function songCard(song, idx) {
    var card = document.createElement('div');
    card.className = 'v25-card' + (song.enabled ? '' : ' off');
    card.setAttribute('data-id', String(song.id));

    var top = document.createElement('div');
    top.className = 'v25-card-top';
    var nm = document.createElement('div');
    nm.className = 'v25-name';
    nm.textContent = song.buffer ? displayName(song.name) : 'Song ' + (idx + 1) + ' — not picked';
    var fn = document.createElement('div');
    fn.className = 'muted small';
    fn.textContent = song.buffer ? (song.fileName || song.name) : 'Tap "Pick audio" to add';
    top.appendChild(nm);
    top.appendChild(fn);

    var meta = document.createElement('div');
    meta.className = 'v25-meta-row';
    var cv = document.createElement('canvas');
    cv.className = 'v25-wave';
    meta.appendChild(cv);
    var info = document.createElement('div');
    info.className = 'v25-info';
    if (song.buffer) {
      var dur = document.createElement('div');
      dur.className = 'small';
      dur.textContent = '⏱ ' + formatDuration(song.buffer.duration);
      var bpm = document.createElement('div');
      bpm.className = 'small';
      bpm.textContent = song.analyzing ? '♪ Analyzing…' : '♪ ' + (song.bpm ? song.bpm + ' BPM' : 'BPM —');
      var key = document.createElement('div');
      key.className = 'small';
      key.textContent = song.analyzing ? '𝄞 Analyzing…' : '𝄞 ' + (song.key ? keyLabel(song.key) : 'Key —');
      info.appendChild(dur);
      info.appendChild(bpm);
      info.appendChild(key);
      if (song.err) {
        var er = document.createElement('div');
        er.className = 'small v25-err';
        er.textContent = song.err;
        info.appendChild(er);
      }
    }
    meta.appendChild(info);

    var bar = document.createElement('div');
    bar.className = 'v25-card-bar';
    function mkBtn(txt, act, title, disabled) {
      var b = document.createElement('button');
      b.className = 'btn tiny';
      b.textContent = txt;
      b.setAttribute('data-act', act);
      b.setAttribute('data-id', String(song.id));
      b.title = title || txt;
      if (disabled) b.disabled = true;
      return b;
    }
    bar.appendChild(mkBtn(song.buffer ? '↻ Re-pick' : '🎵 Pick audio', 'pick', 'Pick audio file'));
    bar.appendChild(mkBtn('↑', 'up', 'Move up', idx === 0));
    bar.appendChild(mkBtn('↓', 'down', 'Move down', idx === st.songs.length - 1));
    bar.appendChild(mkBtn(song.enabled ? '⏸ Disable' : '▶ Enable', 'toggle', 'Enable/disable this song', !song.buffer));
    bar.appendChild(mkBtn('✕', 'remove', 'Remove song', st.songs.length <= MIN_SONGS));

    card.appendChild(top);
    card.appendChild(meta);
    card.appendChild(bar);
    drawWaveform(cv, song.buffer);
    return card;
  }

  function renderSongs() {
    screenEl();
    var wrap = $('v25-songs');
    if (!wrap) return;
    wrap.innerHTML = '';
    st.songs.forEach(function (s, i) { wrap.appendChild(songCard(s, i)); });
    var cnt = $('v25-count');
    if (cnt) {
      var ok = enabledSongs().length;
      cnt.textContent = 'Songs: ' + st.songs.length + '/' + MAX_SONGS + ' • Ready: ' + ok;
    }
    var add = $('v25-add');
    if (add) add.disabled = st.songs.length >= MAX_SONGS;
    var mw = $('v25-memwarn');
    if (mw) mw.hidden = st.songs.length < MEM_WARN_AT;
    updateCreateState();
  }

  function updateCreateState() {
    var b = $('v25-create'), hint = $('v25-hint');
    if (!b) return;
    var n = enabledSongs().length;
    var ok = n >= MIN_SONGS && !st.creating;
    b.disabled = !ok;
    if (hint) {
      hint.hidden = ok;
      if (!ok && !st.creating) {
        hint.textContent = n === 0
          ? 'Pick at least 2 songs to create a mashup.'
          : 'Pick ' + (MIN_SONGS - n) + ' more song' + (MIN_SONGS - n > 1 ? 's' : '') + ' to create a mashup.';
      }
    }
  }

  /* ================= pick flow (exact #cdx-pick path) ================= */

  function requestPick(id) {
    var a = A();
    if (!a) return;
    stopPreview();
    st.pickId = id;
    try {
      if (RM.ux && typeof RM.ux.pickMusic === 'function') {
        RM.ux.pickMusic(); // same mechanism as the #cdx-pick button
      } else {
        a.show('import');
      }
    } catch (e) { st.pickId = null; return; }
    a.toast('Pick a song 🎵');
  }

  // Called by the coordinator's app.js interception with the decoded
  // AudioBuffer + file name. Name = file name (no invented artist names).
  function onPicked(id, buffer, name) {
    var a = A();
    var song = (id != null) ? getSong(id) : null;
    if (!song || !isAudioBuffer(buffer)) {
      if (a) a.toast('Pick failed — try again');
      st.pickId = null;
      return;
    }
    song.buffer = buffer;
    song.name = name || 'audio';
    song.fileName = name || 'audio';
    song.enabled = true;
    song.bpm = null;
    song.key = null;
    st.pickId = null;
    renderSongs();
    analyzeSong(song); // real BPM + key analysis, results land on the card
    if (a) {
      a.toast('Song added ✓');
      a.show('v25create');
    }
  }

  function addSong() {
    var a = A();
    if (st.songs.length >= MAX_SONGS) {
      if (a) a.toast('Maximum ' + MAX_SONGS + ' songs');
      return;
    }
    var song = { id: st.nextId++, buffer: null, name: '', fileName: '', enabled: true, bpm: null, key: null, analyzing: false, err: null };
    st.songs.push(song);
    renderSongs();
    requestPick(song.id);
  }

  function cardAction(act, id) {
    var a = A();
    var idx = -1;
    for (var i = 0; i < st.songs.length; i++) if (st.songs[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    var song = st.songs[idx];
    if (act === 'pick') { requestPick(id); }
    else if (act === 'remove') {
      if (st.songs.length <= MIN_SONGS) return;
      stopPreview();
      st.songs.splice(idx, 1);
      renderSongs();
      if (a) a.toast('Song removed');
    }
    else if (act === 'up' && idx > 0) {
      st.songs.splice(idx - 1, 0, st.songs.splice(idx, 1)[0]);
      renderSongs();
    }
    else if (act === 'down' && idx < st.songs.length - 1) {
      st.songs.splice(idx + 1, 0, st.songs.splice(idx, 1)[0]);
      renderSongs();
    }
    else if (act === 'toggle' && song.buffer) {
      song.enabled = !song.enabled;
      renderSongs();
    }
  }

  /* ================= preview (user tap only — NEVER autoplay) ================= */

  function stopPreview() {
    if (st.pvSrc) {
      try { st.pvSrc.onended = null; st.pvSrc.stop(); } catch (e) {}
      try { st.pvSrc.disconnect(); } catch (e) {}
      st.pvSrc = null;
    }
    var play = $('v25-play');
    if (play) play.textContent = '▶ Preview';
  }

  function togglePreview() {
    var a = A();
    if (!a) return;
    if (st.pvSrc) { stopPreview(); return; }
    if (!st.result || !isAudioBuffer(st.result.buffer)) { a.toast('Create a mashup first ✨'); return; }
    try {
      var ctx = RM.audio.ensureCtx();
      var src = ctx.createBufferSource();
      src.buffer = st.result.buffer;
      src.connect(RM.audio.masterIn());
      src.onended = function () { if (st.pvSrc === src) stopPreview(); };
      st.pvSrc = src;
      src.start();
      var play = $('v25-play');
      if (play) play.textContent = '⏸ Stop';
    } catch (e) {
      stopPreview();
      a.toast(a.cleanErrMsg(e) || 'Could not start preview.');
    }
  }

  function doExport() {
    var a = A();
    if (!a) return;
    if (!st.result || !isAudioBuffer(st.result.buffer)) { a.toast('Create a mashup first ✨'); return; }
    if (!RM.mashupExport || typeof RM.mashupExport.sendToExport !== 'function') {
      a.toast('Export module not ready — update the app and retry.');
      return;
    }
    try {
      RM.mashupExport.sendToExport(st.result.buffer, st.result.meta);
    } catch (e) {
      a.toast(a.cleanErrMsg(e) || 'Could not hand off to export.');
    }
  }

  /* ================= create: staged real analysis + build ================= */

  function fail(msg) {
    var a = A();
    st.creating = false;
    var c = $('v25-cancel');
    if (c) c.hidden = true;
    updateCreateState();
    var txt = (msg && msg.kind === 'cancelled') ? 'Cancelled.' : (a ? (a.cleanErrMsg(msg) || 'Something went wrong. Please try again.') : 'Something went wrong.');
    if (a) a.toast(txt);
  }

  function throwIfCancelled() {
    if (RM.mashupStems && typeof RM.mashupStems.isCancelRequested === 'function' &&
        RM.mashupStems.isCancelRequested()) {
      throw { kind: 'cancelled' };
    }
  }

  function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }

  function errText(e) {
    if (e && e.kind === 'cancelled') return 'cancelled';
    return String((e && e.message) || e || 'unknown error');
  }

  // Stage 1+2+4 analysis for the create run (uses cached BPM/key from card
  // analysis when present — both came from the same real functions).
  function analyzeRun(songs, spanOf, prog) {
    var N = songs.length;
    var chain = Promise.resolve();
    songs.forEach(function (song, i) {
      chain = chain.then(function () {
        throwIfCancelled();
        var base = (i / N) * spanOf;
        var span = spanOf / N;
        var p = function (q, label) { prog(label, base + q * span); };
        return ensureBpmKey(song, p).then(function () {
          throwIfCancelled();
          return separateVocals(song, p);
        });
      });
    });
    return chain;
  }

  function ensureBpmKey(song, p) {
    var todo = [];
    if (song.bpm == null && RM.audio && typeof RM.audio.detectBPM === 'function') {
      setStage('bpm', 'active', 'Smart BPM detect — ' + displayName(song.name));
      todo.push(RM.audio.detectBPM(song.buffer, function (q) { p(q * 0.5, 'Smart BPM detect: ' + displayName(song.name)); })
        .then(function (v) {
          var b = Number(v);
          song.bpm = (isFinite(b) && b >= 50 && b <= 220) ? Math.round(b * 10) / 10 : null;
        })
        .catch(function () { song.bpm = null; }));
    }
    if (song.key == null && RM.mashupDSP && typeof RM.mashupDSP.detectKey === 'function') {
      setStage('key', 'active', 'Smart key detect — ' + displayName(song.name));
      todo.push(RM.mashupDSP.detectKey(song.buffer, function (q) { p(0.5 + q * 0.5, 'Smart key detect: ' + displayName(song.name)); })
        .then(function (k) { song.key = k || null; })
        .catch(function () { song.key = null; }));
    }
    return Promise.all(todo).then(function () {
      setStage('bpm', 'done', 'Smart BPM detect ✓');
      setStage('key', 'done', 'Smart key detect ✓');
      renderSongs();
    });
  }

  function separateVocals(song, p) {
    var provider = (RM.mashupStems && typeof RM.mashupStems.provider === 'function')
      ? RM.mashupStems.provider : null;
    if (!provider) throw new Error('Stem separation is not available — update the app and retry.');
    setStage('stems', 'active', 'Separating stems — ' + displayName(song.name));
    return provider(song.buffer, 'vocal', function (f, label) {
      p(typeof f === 'number' ? f : 0, label || 'Separating stems: ' + displayName(song.name));
    }).then(function (sep) {
      if (!sep || !isAudioBuffer(sep.buffer)) throw new Error('Stem separation returned no audio (' + displayName(song.name) + ')');
      song.vocal = sep.buffer;
      song.tag = sep.tag || 'smart DSP';
      var ai = /neural/i.test(song.tag) && !/neural failed/i.test(song.tag);
      setStage('stems', 'active', (ai ? 'AI stems ✓' : 'Smart DSP stems ✓') + ' — ' + displayName(song.name));
      return song;
    });
  }

  /* ---- 2–8 songs: the real mega engine (its internals ARE stages
         1/2/4/6/7/8 — we map its callbacks onto our stage UI) ---- */

  function buildViaMega(songs, onProgress) {
    if (!RM.mashupMega || typeof RM.mashupMega.build !== 'function') {
      return Promise.reject(new Error('Mashup engine not ready — update the app and retry.'));
    }
    var list = songs.map(function (s) { return { buffer: s.buffer, name: s.name }; });
    var token = (RM.mashupStems && typeof RM.mashupStems.makeToken === 'function')
      ? RM.mashupStems.makeToken() : null;
    return RM.mashupMega.build(list, { token: token },
      function (label, frac) {
        var lb = String(label || '');
        // Map the engine's REAL work onto our stage list.
        if (/detecting tempo/i.test(lb)) setStage('bpm', 'active', 'Smart BPM detect — ' + lb);
        else if (/separating/i.test(lb)) setStage('stems', 'active', 'Separating stems — ' + lb);
        else if (/matching key/i.test(lb) && !/matching tempo/i.test(lb)) setStage('key', 'active', 'Smart key detect — ' + lb);
        else if (/matching tempo/i.test(lb)) setStage('arrange', 'active', 'Building arrangement — ' + lb);
        else if (/creating beat/i.test(lb)) setStage('arrange', 'active', 'Building arrangement — ' + lb);
        else if (/mixing/i.test(lb)) { setStage('arrange', 'done', 'Building arrangement ✓'); setStage('mix', 'active', 'Mixing — ' + lb); }
        else if (/gluing|balancing|placing|laying down/i.test(lb)) setStage('mix', 'active', 'Mixing — ' + lb);
        else if (/mastering/i.test(lb)) { setStage('mix', 'done', 'Mixing ✓'); setStage('master', 'active', 'Mastering — ' + lb); }
        else if (/ready ✓/i.test(lb)) { setStage('bpm', 'done', 'Smart BPM detect ✓'); setStage('key', 'done', 'Smart key detect ✓'); setStage('stems', 'done', 'Separating stems ✓'); }
        onProgress(lb, 0.55 + (frac || 0) * 0.45);
      },
      function (step) {
        if (step === 'arrange') setStage('arrange', 'active', 'Building arrangement…');
        else if (step === 'done') { setStage('mix', 'done', 'Mixing ✓'); setStage('master', 'done', 'Mastering ✓'); }
      });
  }

  /* ---- 9–10 songs: extended pipeline from the SAME real public
         functions the mega engine uses (no duplicated DSP) ---- */

  function nearestStyle(beats, masterBpm, styleId) {
    var styles = (beats && beats.STYLES) || [];
    if (styleId) {
      for (var i = 0; i < styles.length; i++) if (styles[i] && styles[i].id === styleId) return styles[i];
    }
    var best = null, bestD = Infinity;
    for (var j = 0; j < styles.length; j++) {
      var stn = styles[j];
      if (!stn || !isFinite(Number(stn.bpm))) continue;
      var d = Math.abs(Number(stn.bpm) - masterBpm);
      if (d < bestD) { bestD = d; best = stn; }
    }
    return best || styles[0] || null;
  }

  function trimToBars(buffer, sampleRate, bpm, bars) {
    var barLen = 240 / bpm * sampleRate; // 4 beats per bar
    var len = Math.min(buffer.length, Math.round(barLen * bars));
    if (len >= buffer.length) return buffer;
    var ctx = RM.audio.ensureCtx();
    var out = ctx.createBuffer(buffer.numberOfChannels, len, buffer.sampleRate);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      out.getChannelData(c).set(buffer.getChannelData(c).subarray(0, len));
    }
    return out;
  }

  function buildExtended(songs, onProgress) {
    var dsp = RM.mashupDSP;
    if (!dsp || typeof dsp.detectKey !== 'function' || typeof dsp.timeStretch !== 'function' ||
        typeof dsp.pitchShift !== 'function' || typeof dsp.semitonesBetween !== 'function') {
      return Promise.reject(new Error('mashup-dsp.js not loaded'));
    }
    var beats = RM.Beats;
    if (!beats || typeof beats.renderBeat !== 'function') {
      return Promise.reject(new Error('Beat engine not ready — update the app and retry.'));
    }
    if (!RM.mashupArrange || typeof RM.mashupArrange.buildTimeline !== 'function') {
      return Promise.reject(new Error('Arrangement engine not ready — update the app and retry.'));
    }
    var BPM_FALLBACK = 100, CYCLES = 2, BARS_PER_VOCAL = 8, XFADE_BARS = 0.5, INTRO_BARS = 4, OUTRO_BARS = 4;
    var N = songs.length;
    var vocalSegs = [], tags = [], masterBpm = BPM_FALLBACK, masterKey = null, sampleRate = 0;
    var chain = Promise.resolve();

    songs.forEach(function (song, i) {
      chain = chain.then(function () {
        throwIfCancelled();
        var base = (i / N) * 0.55, span = 0.55 / N;
        var p = function (q, label) { onProgress(label, base + q * span); };
        return ensureBpmKey(song, p).then(function () {
          throwIfCancelled();
          return separateVocals(song, p);
        }).then(function () {
          throwIfCancelled();
          var vocal = song.vocal;
          song.vocal = null; // handed to the timeline; original released below
          tags.push(song.tag);
          if (i === 0) {
            sampleRate = vocal.sampleRate;
            masterBpm = song.bpm || BPM_FALLBACK;
            masterKey = song.key;
            p(1, displayName(song.name) + ' ready ✓');
            var seg0 = trimToBars(vocal, sampleRate, masterBpm, CYCLES * BARS_PER_VOCAL + 1);
            vocalSegs.push({ buffer: seg0, name: song.name, index: 0 });
            return tick();
          }
          var afterResample = Promise.resolve(vocal);
          if (vocal.sampleRate !== sampleRate && RM.audio && typeof RM.audio.resampleBuffer === 'function') {
            afterResample = RM.audio.resampleBuffer(vocal, sampleRate);
          }
          return afterResample.then(function (v) { return tempoKeyMatch(v, song, i); });
        });
          function tempoKeyMatch(v, sg, idx2) {
            setStage('arrange', 'active', 'Building arrangement — tempo/key match ' + (idx2 + 1) + '/' + N);
            var raw = (sg.bpm || masterBpm) / masterBpm;
            var effBpm = masterBpm;
            if (raw > 1.6) effBpm = masterBpm * 2;
            else if (raw < 0.625) effBpm = masterBpm / 2;
            var ratio = (sg.bpm || masterBpm) / effBpm;
            return dsp.timeStretch(v, ratio, function (q) {
              p(0.7 + q * 0.18, 'Tempo match ' + (idx2 + 1) + '/' + N);
            }).then(function (stretched) {
              throwIfCancelled();
              var stN = 0;
              try { if (masterKey && sg.key) stN = dsp.semitonesBetween(masterKey, sg.key); } catch (e) { stN = 0; }
              stN = Math.max(-6, Math.min(6, Math.round(isFinite(stN) ? stN : 0)));
              if (stN === 0) return trimSeg(stretched, sg, idx2);
              setStage('arrange', 'active', 'Building arrangement — key match ' + (idx2 + 1) + '/' + N);
              return dsp.pitchShift(stretched, stN, function (q) {
                p(0.88 + q * 0.1, 'Key match ' + (idx2 + 1) + '/' + N);
              }).then(function (shifted) {
                throwIfCancelled();
                return trimSeg(isAudioBuffer(shifted) ? shifted : stretched, sg, idx2);
              });
            });
          }
          function trimSeg(v, sg, idx2) {
            var seg = trimToBars(v, sampleRate, masterBpm, CYCLES * BARS_PER_VOCAL + 1);
            vocalSegs.push({ buffer: seg, name: sg.name, index: idx2 });
            p(1, displayName(sg.name) + ' ready ✓');
            return tick();
          }
      });
    });

    return chain.then(function () {
      throwIfCancelled();
      setStage('arrange', 'active', 'Building arrangement — creating beat…');
      onProgress('Creating beat…', 0.58);
      var style = nearestStyle(beats, masterBpm, null);
      if (!style) throw new Error('No beat styles available.');
      var totalBars = INTRO_BARS + CYCLES * N * BARS_PER_VOCAL + OUTRO_BARS;
      return beats.renderBeat(style.id, masterBpm, totalBars, { sampleRate: sampleRate });
    }).then(function (beatBuf) {
      throwIfCancelled();
      if (!isAudioBuffer(beatBuf)) throw new Error('Beat creation returned no audio.');
      onProgress('Creating beat…', 0.65);
      return RM.mashupArrange.buildTimeline({
        vocalSegs: vocalSegs,
        beatBuf: beatBuf,
        masterBpm: masterBpm,
        sampleRate: sampleRate,
        cycles: CYCLES,
        barsPerVocal: BARS_PER_VOCAL,
        xfadeBars: XFADE_BARS,
        introBars: INTRO_BARS,
        outroBars: OUTRO_BARS,
        beatDuckDb: tags.map(function (t) {
          return (/neural/i.test(String(t || '')) && !/neural failed/i.test(String(t || ''))) ? 0 : -2;
        }),
        onProgress: function (label, frac) {
          var lb = String(label || '');
          if (/mixing/i.test(lb)) { setStage('arrange', 'done', 'Building arrangement ✓'); setStage('mix', 'active', 'Mixing — ' + lb); }
          else if (/mastering/i.test(lb)) { setStage('mix', 'done', 'Mixing ✓'); setStage('master', 'active', 'Mastering — ' + lb); }
          else if (/done/i.test(lb)) { setStage('mix', 'done', 'Mixing ✓'); setStage('master', 'done', 'Mastering ✓'); }
          onProgress(lb, 0.65 + (frac || 0) * 0.32);
        },
        token: (RM.mashupStems && typeof RM.mashupStems.makeToken === 'function')
          ? RM.mashupStems.makeToken() : null,
      });
    }).then(function (tl) {
      var buffer = tl && tl.buffer;
      if (!isAudioBuffer(buffer)) throw new Error('Arrangement returned no audio.');
      setStage('master', 'done', 'Mastering ✓');
      return { buffer: buffer, meta: (tl && tl.meta) || {}, engineTags: tags };
    });
  }

  /* ================= create entry ================= */

  function create() {
    var a = A();
    if (!a || st.creating) return;
    var songs = enabledSongs();
    if (songs.length < MIN_SONGS) { a.toast('Pick at least 2 songs first 🎵'); return; }

    stopPreview();
    st.creating = true;
    st.result = null;
    try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (e) {}
    var r = $('v25-result');
    if (r) r.hidden = true;
    var pw = $('v25-progress');
    if (pw) pw.hidden = false;
    var c = $('v25-cancel');
    if (c) c.hidden = false;
    renderStageList();
    allStages('pending');
    setProgress('Analyzing your songs…', 0);
    updateCreateState();

    var onProgress = function (label, frac) { setProgress(label, frac); };
    var done = false;
    var finish = function (res) {
      done = true;
      try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (e) {}
      var buf = res && res.buffer ? res.buffer : (isAudioBuffer(res) ? res : null);
      if (!buf) throw new Error('Mashup build produced no audio.');
      var meta = (res && res.meta) || {};
      var tags = (res && res.engineTags) || songs.map(function (s) { return s.tag || 'smart DSP'; });
      st.result = { buffer: buf, meta: meta, engine: honestEngineLabel(tags) };
      try {
        st.result.meta.name = 'Mashup (' + songs.length + ' songs)';
        st.result.meta.style = 'v25create';
      } catch (e) {}
      st.creating = false;
      if (c) c.hidden = true;
      setProgress('Done', 1);
      var pw2 = $('v25-progress');
      if (pw2) pw2.hidden = true;
      updateCreateState();
      var tag = $('v25-engine');
      if (tag) tag.textContent = '⚙️ ' + st.result.engine;
      var me = $('v25-meta');
      if (me) me.textContent = meta.durationSec ? (meta.durationSec + 's') : '';
      var rr = $('v25-result');
      if (rr) rr.hidden = false;
      var play = $('v25-play');
      if (play) play.textContent = '▶ Preview';
      a.toast('Mashup ready ✨');
    };

    Promise.resolve()
      .then(function () {
        if (songs.length <= 8) {
          // Stages 1/2/4: reuse the real per-song analysis already shown on
          // the cards (or run it now if a card never finished it).
          var pre = Promise.resolve();
          songs.forEach(function (s) {
            pre = pre.then(function () { throwIfCancelled(); return ensureBpmKey(s, function () {}); });
          });
          return pre.then(function () {
            throwIfCancelled();
            setStage('bpm', 'done', 'Smart BPM detect ✓');
            setStage('key', 'done', 'Smart key detect ✓');
            setStage('stems', 'active', 'Separating stems…');
            setStage('arrange', 'pending', buildStageList()[3].sub);
            return buildViaMega(songs, onProgress);
          }).then(function (res) {
            var m = (res && res.meta) || {};
            var tags = [];
            if (res && res.engineTags) {
              if (Array.isArray(res.engineTags)) tags = res.engineTags;
              else for (var k in res.engineTags) tags.push(res.engineTags[k]);
            }
            ['engineTagVocal', 'engineTagInstr', 'engineTagSong1', 'engineTagSong2'].forEach(function (f) {
              if (m[f]) tags.push(m[f]);
            });
            return { buffer: res && res.buffer, meta: m, engineTags: tags };
          });
        }
        // 9–10 songs: extended pipeline — stages 1/2/4 run directly here.
        setStage('bpm', 'active', 'Smart BPM detect…');
        setStage('key', 'active', 'Smart key detect…');
        return analyzeRun(songs, 0.55, onProgress).then(function () {
          setStage('stems', 'done', 'Separating stems ✓');
          setStage('arrange', 'active', 'Building arrangement…');
          return buildExtended(songs, onProgress);
        });
      })
      .then(function (res) { if (!done) finish(res); })
      .catch(function (e) {
        done = true;
        try { if (RM.mashupStems && typeof RM.mashupStems.clearCancel === 'function') RM.mashupStems.clearCancel(); } catch (err) {}
        fail(e);
      });
  }

  /* ================= wiring ================= */

  function wire() {
    if (st._wired) return;
    st._wired = true;
    screenEl();
    var wrap = $('v25-songs');
    if (wrap) wrap.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== wrap && !t.getAttribute) t = t.parentNode;
      if (!t || t === wrap) return;
      var act = t.getAttribute('data-act');
      var id = parseInt(t.getAttribute('data-id'), 10);
      if (act && !isNaN(id)) cardAction(act, id);
    });
    var add = $('v25-add');
    if (add) add.addEventListener('click', addSong);
    var makeB = $('v25-create');
    if (makeB) makeB.addEventListener('click', create);
    var cancelB = $('v25-cancel');
    if (cancelB) cancelB.addEventListener('click', function () {
      try {
        if (RM.mashupStems && typeof RM.mashupStems.requestCancel === 'function')
          RM.mashupStems.requestCancel();
      } catch (e) {}
      setProgress('Cancelling…', 0);
    });
    var playB = $('v25-play');
    if (playB) playB.addEventListener('click', togglePreview);
    var expB = $('v25-export');
    if (expB) expB.addEventListener('click', doExport);
    // base pair of slots so the screen never starts empty
    if (!st.songs.length) {
      st.songs.push({ id: st.nextId++, buffer: null, name: '', fileName: '', enabled: true, bpm: null, key: null, analyzing: false, err: null });
      st.songs.push({ id: st.nextId++, buffer: null, name: '', fileName: '', enabled: true, bpm: null, key: null, analyzing: false, err: null });
    }
    renderSongs();
  }

  // Chain onto RM.app.onShow: leaving the screen always stops preview;
  // a stale pending pick is cleared when the user abandons the flow.
  function wrapOnShow() {
    var a = A();
    if (!a || a.onShow === st._hook) return;
    var prev = a.onShow;
    st._hook = function (name) {
      try { if (typeof prev === 'function') prev(name); } catch (e) {}
      try {
        if (name !== 'v25create') stopPreview();
        if (name !== 'import' && name !== 'v25create' && st.pickId) st.pickId = null;
      } catch (e) {}
    };
    a.onShow = st._hook;
  }

  function ready(attempts) {
    if (RM.app && document.body) {
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
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  RM.v25create = {
    onPicked: onPicked,
    show: function () { var a = A(); screenEl(); if (a) a.show('v25create'); },
    getSongs: function () {
      return st.songs.map(function (s) {
        return { name: s.name, enabled: s.enabled, bpm: s.bpm, key: s.key, hasAudio: !!s.buffer };
      });
    },
    create: create,
    stopPreview: stopPreview,
    // node-test hooks only (browser-harmless)
    _test: {
      formatDuration: formatDuration,
      displayName: displayName,
      keyLabel: keyLabel,
      buildStageList: buildStageList,
      honestEngineLabel: honestEngineLabel,
      MIN_SONGS: MIN_SONGS,
      MAX_SONGS: MAX_SONGS,
    },
  };
  Object.defineProperty(RM.v25create, 'pickTarget', {
    get: function () { return st.pickId; },
    set: function (v) { st.pickId = v ? 1 * v : null; },
    configurable: true,
  });

  // Node unit tests (browser-harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { api: RM.v25create, internals: RM.v25create._test };
    }
  } catch (e) {}
})();
