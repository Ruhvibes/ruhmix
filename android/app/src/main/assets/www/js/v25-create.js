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
    mode: 'mega',       // w26: 'classic' | 'swap' | 'mega'
    presetId: 'custom', // w26: style preset id (RM.v25arrange; 'custom' = Smart default)
    settings: null,     // w29 P2-5: §14 Mashup Settings (null = defaults); merged into every render spec
    settingsOpen: false,// w29 P2-5: settings panel collapsed by default
    lengthTouched: false, // w29 P2-5: true once the user explicitly sets a length (trim cap only then)
    audSrc: null,       // w26: per-song audition source
    audId: null,        // w26: song id currently auditioning
    _po: null,          // w26: preset build opts for the in-flight create
    _extPlan: null,     // w26: riser plan for the extended pipeline
    _bridge: null,      // w26: mashupIntercept pick bridge { id, orig }
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

  /* ================= w26: mode routing (pure, node-testable) ========== */
  // Classic / Vocal Swap are 2-song engines; Mega covers 2–8 songs; 9–10
  // songs always use the extended pipeline (same real public functions).
  var MODES = [
    { id: 'classic', label: '🎤 Classic',
      hint: '2 songs — vocals over the auto-matched beat (RM.mashup.build)' },
    { id: 'swap', label: '🔄 Vocal Swap',
      hint: '2 songs — singers alternate every 8 bars (RM.mashupSwap.build)' },
    { id: 'mega', label: '🎹 Mega Mix',
      hint: '2–8 songs — vocals rotate over an auto-matched beat (RM.mashupMega.build)' },
  ];

  function resolveEngine(mode, enabledCount) {
    var n = Number(enabledCount) || 0;
    if (mode === 'classic' || mode === 'swap') {
      if (n === 2) return { engine: mode, reason: '' };
      return { engine: null,
               reason: (mode === 'classic' ? 'Classic' : 'Vocal Swap') +
                       ' needs exactly 2 enabled songs — enable/disable songs or switch to Mega Mix.' };
    }
    if (n >= 2 && n <= 8) return { engine: 'mega', reason: '' };
    if (n >= 9 && n <= MAX_SONGS) return { engine: 'extended', reason: '' };
    return { engine: null, reason: 'Pick at least 2 songs to create a mashup.' };
  }

  /* ================= w26: style presets (pure, node-testable) ========= */
  // presetRenderSpec(presetId, default settings) gives the full merged
  // render spec. Mapping onto the real engines:
  //   pre-build:  mega opts.styleId = spec.beatStyle (null → auto pick);
  //               the mega/duet engines take NO other preset opts, so the
  //               remaining headline params are applied post-build;
  //               extended pipeline: xfadeBars, vocalBoostDb, tempoShift
  //               (masterBpm scaled pre-build — real).
  //   post-build: REAL audible DSP — tempoShift via WSOLA time-stretch of
  //               the mixdown (mega/duet; extended already did it pre-build),
  //               sidechainDb as a beat-grid-synced pump at the exact dB
  //               depth, preset tone (brightness/bass), Schroeder reverb +
  //               echo (reverbWet/delayWet), risers, mastering LAST (so the
  //               output stays true-peak safe).
  //               vocalBoostDb is a MIX-TIME param (needs the separated
  //               vocal + beat): real in the extended pipeline, engine
  //               default in mega/duet — never faked post-build.
  //               Every preset differs from every other in at least one
  //               post dimension (render-tested, no no-ops).
  function presetSpec(presetId) {
    var va = RM.v25arrange;
    if (!va || typeof va.presetRenderSpec !== 'function') return null;
    // w29 P2-5: the §14 settings are merged here (was always null, so
    // mastering/effects/vocal focus were stuck on defaults). Every
    // consumer of presetSpec/presetBuildOpts now sees the user's choices.
    try { return va.presetRenderSpec(presetId, getSettings()); } catch (e) { return null; }
  }

  function presetBuildOpts(presetId) {
    var spec = presetSpec(presetId);
    if (!spec) return null;
    return {
      spec: spec,
      styleId: spec.beatStyle || null,
      xfadeBars: spec.xfadeBars,
      vocalBoostDb: spec.vocalBoostDb,
      tempoShift: spec.tempoShift,
      sidechainDb: spec.sidechainDb, // v29 F2: plumbed into the post-chain pump
    };
  }

  function listPresets() {
    var va = RM.v25arrange;
    if (va && typeof va.listPresets === 'function') {
      try { var l = va.listPresets(); if (Array.isArray(l) && l.length) return l; } catch (e) {}
    }
    return [];
  }

  function presetById(id) {
    var va = RM.v25arrange;
    if (va && typeof va.getPreset === 'function') {
      try { return va.getPreset(id); } catch (e) {}
    }
    return null;
  }

  // Schroeder-style reverb: 4 parallel feedback combs + 2 series allpasses.
  // Pure JS (no AudioContext) so node tests can run it too. wet: 0..1.
  function schroederReverb(d, sr, wet) {
    if (!(wet > 0) || !d || !d.length) return;
    function delayLine(ms) {
      return { buf: new Float32Array(Math.max(2, Math.round(ms * sr / 1000))), idx: 0 };
    }
    var combs = [29.7, 37.1, 41.1, 43.7].map(function (ms) {
      var c = delayLine(ms); c.fb = 0.82; return c;
    });
    var aps = [5.0, 1.7].map(function (ms) {
      var a = delayLine(ms); a.g = 0.5; return a;
    });
    var len = d.length, i, j;
    var wetBuf = new Float32Array(len);
    for (i = 0; i < len; i++) {
      var x = d[i], acc = 0, c, a;
      for (j = 0; j < combs.length; j++) {
        c = combs[j];
        var co = c.buf[c.idx];
        acc += co;
        c.buf[c.idx] = x + co * c.fb;
        c.idx = (c.idx + 1) % c.buf.length;
      }
      acc *= 0.25;
      for (j = 0; j < aps.length; j++) {
        a = aps[j];
        var ao = a.buf[a.idx];
        var y = -a.g * acc + ao;
        a.buf[a.idx] = acc + a.g * ao;
        acc = y;
        a.idx = (a.idx + 1) % a.buf.length;
      }
      wetBuf[i] = acc;
    }
    var peak = 0;
    for (i = 0; i < len; i++) { var av = Math.abs(wetBuf[i]); if (av > peak) peak = av; }
    var g = peak > 1e-6 ? Math.min(1, 0.9 / peak) : 0;
    var dry = 1 - Math.min(0.6, wet);
    for (i = 0; i < len; i++) d[i] = d[i] * dry + wetBuf[i] * g * wet;
  }

  // Feedback echo on the dotted-eighth of the grid tempo. wet: 0..1.
  function feedbackEcho(d, sr, wet, bpm) {
    if (!(wet > 0) || !d || !d.length) return;
    var beat = 60 / ((isFinite(bpm) && bpm > 0) ? bpm : 100);
    var n = Math.max(2, Math.round(beat * 0.75 * sr));
    var dl = new Float32Array(n), idx = 0, fb = 0.32;
    var dryG = 1 - Math.min(0.5, wet);
    for (var i = 0; i < d.length; i++) {
      var x = d[i];
      var e = dl[idx];
      dl[idx] = x + e * fb;
      d[i] = x * dryG + e * wet;
      idx = (idx + 1) % n;
    }
  }

  function applyPresetSpace(buf, spec, sr, gridBpm) {
    if (!isAudioBuffer(buf) || !spec) return buf;
    sr = sr || buf.sampleRate || 44100;
    var rWet = Math.max(0, Math.min(1, 0.16 * (Number(spec.reverbWet) || 0)));
    var dWet = Math.max(0, Math.min(1, 0.14 * (Number(spec.delayWet) || 0)));
    if (rWet <= 0 && dWet <= 0) return buf;
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var dch = buf.getChannelData(ch);
      if (rWet > 0) schroederReverb(dch, sr, rWet);
      if (dWet > 0) feedbackEcho(dch, sr, dWet, gridBpm);
    }
    return buf;
  }

  // applyPresetPost(buf, spec, riserPlan, gridBpm) — the preset post-chain:
  // tone → space (reverb/echo) → risers → mastering LAST (so the output
  // stays true-peak safe). In place; returns buf. Pure DSP, node-testable.
  function applyPresetPost(buf, spec, riserPlan, gridBpm) {
    var va = RM.v25arrange;
    if (!isAudioBuffer(buf) || !spec || !va) return buf;
    var sr = buf.sampleRate || 44100;
    try {
      if (typeof va.applyPresetTone === 'function') va.applyPresetTone(buf, spec, sr);
      applyPresetSpace(buf, spec, sr, gridBpm);
      if (riserPlan && typeof va.addRisers === 'function') va.addRisers(buf, riserPlan, spec, sr);
      if (typeof va.applyMastering === 'function') va.applyMastering(buf, spec.mastering, sr);
    } catch (e) {}
    return buf;
  }

  // Riser placement from each engine's known arrangement structure.
  // v29 F2 (P1-3): mega's meta.songs is an ARRAY of per-song objects, not a
  // number — Number(array) is NaN, so the old code always fell back to n=2
  // and a 5-song build put the riser at bar 28 instead of bar 76. Read the
  // real count from meta.songCount (mashup-mega.js), with the array length
  // and the legacy numeric form as fallbacks.
  function riserPlanForMega(meta) {
    try {
      var m = meta || {};
      var bpm = Number(m.bpm1) || 100;
      var n = Math.max(2, Math.min(8,
        Number(m.songCount) ||
        (Array.isArray(m.songs) ? m.songs.length : 0) ||
        Number(m.songs) || 2));
      var cycles = Math.max(1, Math.min(4, Number(m.cycles) || 2));
      // mega layout: 4-bar intro + cycles*n 8-bar vocal slots + 4-bar outro;
      // the final chorus is the last vocal slot.
      var startBar = 4 + (cycles * n - 1) * 8;
      return { gridBpm: bpm, sections: [{ type: 'finalChorus', startBar: startBar, bars: 8 }] };
    } catch (e) { return null; }
  }
  // v29 F2 (P1-2): duet (Classic / Vocal Swap) riser plan. The duet engines
  // return a finished stereo mixdown, so the plan is derived from the REAL
  // buffer: totalBars from duration × gridBpm, riser swelling into the
  // final 8 bars. Never null for a real buffer (addRisers still no-ops
  // when the preset has risers: false).
  function riserPlanForDuet(buf, gridBpm) {
    try {
      if (!isAudioBuffer(buf)) return null;
      var bpm = Number(gridBpm);
      if (!(bpm > 0)) bpm = 100;
      var dur = Number(buf.duration) || 0;
      if (!(dur > 0) && buf.length && buf.sampleRate) dur = buf.length / buf.sampleRate;
      if (!(dur > 0)) return null;
      var totalBars = Math.max(8, Math.round(dur * bpm / 240));
      var startBar = Math.max(0, totalBars - 8);
      return { gridBpm: bpm, sections: [{ type: 'finalChorus', startBar: startBar, bars: 8 }] };
    } catch (e) { return null; }
  }
  // v29 F2 (P1-1): preset tempo multiplier as REAL WSOLA time-stretch of
  // the mixdown (pitch preserved) — the mega/duet engines take no tempo
  // opt, so "Slowed + Reverb ×0.85" is applied here. tempoShift < 1 slows
  // the grid → stretch ratio = 1/tempoShift. Resolves to the ORIGINAL buf
  // when no stretch is needed or the stretch engine is unavailable — never
  // rejects, so a preset can never kill a good build.
  function applyPresetTempo(buf, tempoShift, onProgress) {
    return Promise.resolve().then(function () {
      var ts = Number(tempoShift);
      if (!isAudioBuffer(buf) || !isFinite(ts) || ts <= 0 || Math.abs(ts - 1) < 1e-9) return buf;
      var ratio = 1 / ts;
      if (!(ratio >= 0.5 && ratio <= 2.0)) return buf; // outside the engine's sane range
      var dsp = (typeof RM !== 'undefined' && RM.mashupDSP) || null;
      if (!dsp || typeof dsp.timeStretch !== 'function') return buf;
      return dsp.timeStretch(buf, ratio, function (q) {
        if (typeof onProgress === 'function') {
          try { onProgress(q, 'Applying style tempo…'); } catch (e) {}
        }
      }).then(function (out) {
        return (out && isAudioBuffer(out)) ? out : buf;
      }, function () { return buf; });
    });
  }
  // v29 F2 (P1-1): preset sidechain depth as a REAL beat-grid-synced pump
  // at the exact dB depth. The mix-time sidechain (vocal-envelope duck of
  // the beat, fixed −3 dB inside buildTimeline) cannot be re-parameterized
  // without touching the engines, so the post-chain renders the advertised
  // pump directly on the grid: gain ducks to 10^(−db/20) on every beat and
  // releases ~96% by the next beat. In place; depth ≤ 0 is a no-op (this is
  // what keeps Custom dry).
  function applyPresetPump(buf, sidechainDb, gridBpm) {
    if (!isAudioBuffer(buf)) return buf;
    var db = Number(sidechainDb);
    if (!(db > 0)) return buf;
    var bpm = Number(gridBpm);
    if (!(bpm > 0)) return buf;
    var sr = buf.sampleRate || 44100;
    var beatLen = Math.max(1, Math.round(60 / bpm * sr));
    var tau = Math.max(1, 0.30 * beatLen);
    var minG = Math.pow(10, -db / 20);
    var range = 1 - minG;
    // one beat of envelope, reused for every beat and channel
    var env = new Float32Array(beatLen);
    for (var t = 0; t < beatLen; t++) {
      env[t] = minG + range * (1 - Math.exp(-t / tau));
    }
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < d.length; i++) {
        d[i] *= env[i % beatLen];
      }
    }
    return buf;
  }
  function riserPlanForExtended(masterBpm, songCount) {
    var n = Math.max(2, Math.min(10, Number(songCount) || 2));
    // extended pipeline: 4-bar intro + 2 cycles of 8-bar vocal slots.
    var startBar = 4 + (2 * n - 1) * 8;
    return { gridBpm: masterBpm, sections: [{ type: 'finalChorus', startBar: startBar, bars: 8 }] };
  }

  /* ---- card text (pure — the "BPM —"/"Key —" honest display) ---- */
  function cardBpmText(song) {
    if (!song) return '♪ BPM —';
    if (song.analyzing) return '♪ Analyzing…';
    return '♪ ' + (song.bpm ? song.bpm + ' BPM' : 'BPM —');
  }
  function cardKeyText(song) {
    if (!song) return '𝄞 Key —';
    if (song.analyzing) return '𝄞 Analyzing…';
    return '𝄞 ' + (song.key ? keyLabel(song.key) : 'Key —');
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
      '  <div class="v25-row-label" style="font-size:11px;font-weight:700;color:#8f8fa3;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.5px;">Mashup mode</div>' +
      '  <div id="v25-modes" class="v25-chips"></div>' +
      '  <div id="v25-mode-note" class="muted small"></div>' +
      '  <div class="v25-row-label" style="font-size:11px;font-weight:700;color:#8f8fa3;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.5px;">Style preset <span class="muted small" style="text-transform:none;letter-spacing:0;">— Smart DSP colour</span></div>' +
      '  <div id="v25-presets" class="v25-chips"></div>' +
      '  <div id="v25-preset-desc" class="muted small"></div>' +
      '  <div id="v25-settings" class="v25-settings"></div>' +
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
      bpm.textContent = cardBpmText(song);
      var key = document.createElement('div');
      key.className = 'small';
      key.textContent = cardKeyText(song);
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
    // w26: per-song audition — real AudioBufferSourceNode; stops the
    // mashup preview and any other card's playback.
    bar.appendChild(mkBtn(st.audId === song.id ? '⏸ Stop' : '▶ Play', 'aud', 'Play/pause this song', !song.buffer));
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
    // w26: validation follows the selected mode's engine contract.
    var route = resolveEngine(st.mode, n);
    var ok = !!route.engine && !st.creating;
    b.disabled = !ok;
    if (hint) {
      hint.hidden = ok;
      if (!ok && !st.creating) hint.textContent = route.reason || 'Pick at least 2 songs to create a mashup.';
    }
    var mn = $('v25-mode-note');
    if (mn) {
      mn.textContent = st.mode === 'mega'
        ? (n > 8 ? '9–10 songs use the extended pipeline (same Smart engines).'
                 : '2–8 songs · vocals rotate over an auto-matched beat.')
        : st.mode === 'swap' ? '2 songs · singers alternate every 8 bars.'
        : '2 songs · vocals over the auto-matched beat.';
    }
  }

  /* ================= w26: mode + preset chips ================= */

  function chipStyle(active) {
    return 'padding:7px 12px;border-radius:16px;border:1px solid ' +
      (active ? '#00e676' : '#3a3a44') + ';background:' +
      (active ? 'rgba(0,230,118,.14)' : '#1b1b21') + ';color:' +
      (active ? '#7CFC98' : '#cfcfda') +
      ';font-size:12px;margin:0 6px 8px 0;cursor:pointer;';
  }

  function renderModeChips() {
    var wrap = $('v25-modes');
    if (!wrap) return;
    wrap.innerHTML = '';
    MODES.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.label;
      b.title = m.hint;
      b.setAttribute('style', chipStyle(st.mode === m.id));
      b.setAttribute('data-mode', m.id);
      // w29 P2-7: locked + dimmed while a build is in flight.
      b.disabled = st.creating;
      if (st.creating) b.style.opacity = '0.45';
      b.addEventListener('click', function () { selectMode(m.id); });
      wrap.appendChild(b);
    });
  }

  function renderPresetChips() {
    var wrap = $('v25-presets');
    if (!wrap) return;
    wrap.innerHTML = '';
    var list = listPresets();
    var desc = $('v25-preset-desc');
    if (!list.length) {
      wrap.style.display = 'none';
      if (desc) desc.textContent = '';
      return;
    }
    wrap.style.display = '';
    list.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.name;
      b.title = p.tagline || p.name;
      b.setAttribute('style', chipStyle(st.presetId === p.id));
      b.setAttribute('data-preset', p.id);
      // w29 P2-7: locked + dimmed while a build is in flight.
      b.disabled = st.creating;
      if (st.creating) b.style.opacity = '0.45';
      b.addEventListener('click', function () { selectPreset(p.id); });
      wrap.appendChild(b);
    });
    var cur = presetById(st.presetId);
    if (desc) desc.textContent = cur ? (cur.description || cur.tagline || '') : '';
  }

  // Switching mode/preset/settings clears a stale result — otherwise
  // Preview/Export would act on a mashup built with different settings.
  // w29 P2-6: when a finished result is dropped, say why instead of
  // silently wiping the user's Preview/Export.
  function clearStaleResult() {
    var had = !!st.result;
    stopPreview();
    stopAudition();
    st.result = null;
    var r = $('v25-result');
    if (r) r.hidden = true;
    if (had) {
      var a = A();
      if (a) a.toast('Previous mashup cleared — settings changed. Tap Create Mashup to rebuild.');
    }
  }

  function selectMode(id) {
    var found = false;
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) found = true;
    if (!found || st.mode === id) return;
    // w29 P2-7: chips lock while a build is in flight.
    if (st.creating) {
      var a = A();
      if (a) a.toast('Still building — wait for the mashup to finish.');
      return;
    }
    st.mode = id;
    clearStaleResult();
    renderModeChips();
    updateCreateState();
  }

  function selectPreset(id) {
    if (st.presetId === id) return;
    // w29 P2-7: chips lock while a build is in flight — a mid-build tap
    // would change st.presetId and hide the result panel the build is
    // about to show.
    if (st.creating) {
      var a0 = A();
      if (a0) a0.toast('Still building — wait for the mashup to finish.');
      return;
    }
    st.presetId = id;
    clearStaleResult();
    renderPresetChips();
    updateCreateState();
  }

  /* ============ w29 P2-5: §14 Mashup Settings on the Create screen ============
     The §14 settings surface (v25-arrange.js getSettingsUI) rendered here.
     Every row maps to REAL engine params via presetRenderSpec(presetId,
     st.settings) — see the per-row notes. Nothing decorative. */
  function getSettings() { return st.settings; }

  function setSetting(id, value) {
    var a = A();
    // w29 P2-7: settings lock during a build, like the mode/preset chips.
    if (st.creating) {
      if (a) a.toast('Still building — wait for the mashup to finish.');
      return false;
    }
    var va = RM.v25arrange;
    if (!va || typeof va.validateSettings !== 'function') return false;
    var cur = va.validateSettings(st.settings);
    cur[id] = value;
    if (id === 'length') st.lengthTouched = true;
    st.settings = va.validateSettings(cur);
    clearStaleResult(); // w29 P2-6: toasts when a finished result is dropped
    renderSettings();
    updateCreateState();
    return true;
  }

  // One-line summary of non-default choices (pure, node-testable).
  function settingsSummary(cur) {
    var va = RM.v25arrange;
    if (!va || typeof va.defaultSettings !== 'function') return '';
    cur = va.validateSettings(cur);
    var d = va.defaultSettings();
    var names = { length: 'Length', energy: 'Energy', vocalFocus: 'Vocal focus',
                  transition: 'Transitions', effects: 'Effects', mastering: 'Mastering' };
    var bits = [];
    ['length', 'energy', 'vocalFocus', 'transition', 'effects', 'mastering'].forEach(function (k) {
      if (String(cur[k]) !== String(d[k])) {
        var v = cur[k];
        if (k === 'length') v = (v === 'custom') ? cur.customMin + ' min' : v + ' min';
        bits.push(names[k] + ': ' + v);
      }
    });
    return bits.length ? 'Active: ' + bits.join(' • ') : '';
  }

  function settingsRow(row, cur) {
    var wrap = document.createElement('div');
    wrap.className = 'v25-set-row';
    wrap.setAttribute('style', 'margin:10px 0;');
    var lab = document.createElement('div');
    lab.setAttribute('style', 'font-size:12px;font-weight:700;color:#cfcfda;margin-bottom:2px;');
    lab.textContent = row.label;
    var hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = row.hint || '';
    wrap.appendChild(lab);
    wrap.appendChild(hint);
    var opts = document.createElement('div');
    opts.setAttribute('style', 'margin-top:5px;');
    (row.options || []).forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.title = o.hint || o.label;
      b.setAttribute('style', chipStyle(String(cur[row.id]) === String(o.value)));
      b.disabled = st.creating;
      if (st.creating) b.style.opacity = '0.45';
      b.addEventListener('click', function () { setSetting(row.id, o.value); });
      opts.appendChild(b);
    });
    wrap.appendChild(opts);
    // length=custom → the minutes number input from the UI spec.
    if (row.custom && String(cur[row.id]) === String(row.custom.showWhen)) {
      var c = row.custom;
      var clab = document.createElement('label');
      clab.className = 'muted small';
      clab.setAttribute('style', 'display:block;margin-top:6px;');
      clab.textContent = c.label + ' (' + c.min + '–' + c.max + '): ';
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.min = c.min; inp.max = c.max; inp.step = c.step;
      inp.value = cur[c.id];
      inp.disabled = st.creating;
      inp.setAttribute('style', 'width:70px;background:#1b1b21;color:#cfcfda;border:1px solid #3a3a44;border-radius:8px;padding:5px 8px;');
      inp.addEventListener('change', function () { setSetting(c.id, Number(inp.value)); });
      clab.appendChild(inp);
      wrap.appendChild(clab);
    }
    return wrap;
  }

  function renderSettings() {
    var host = $('v25-settings');
    if (!host) return;
    var va = RM.v25arrange;
    host.innerHTML = '';
    if (!va || typeof va.getSettingsUI !== 'function') { host.style.display = 'none'; return; }
    host.style.display = '';
    var cur = va.validateSettings(st.settings);
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'btn small v25-set-toggle';
    head.textContent = (st.settingsOpen ? '▾ ' : '▸ ') + '⚙️ Mashup Settings';
    head.title = 'Length, energy, vocal focus, transitions, effects, mastering — real DSP controls';
    head.disabled = st.creating;
    head.addEventListener('click', function () { st.settingsOpen = !st.settingsOpen; renderSettings(); });
    host.appendChild(head);
    var sum = settingsSummary(cur);
    if (sum) {
      var s = document.createElement('div');
      s.className = 'muted small v25-set-sum';
      s.setAttribute('style', 'margin:4px 0 0;');
      s.textContent = sum;
      host.appendChild(s);
    }
    if (!st.settingsOpen) return;
    va.getSettingsUI().forEach(function (row) { host.appendChild(settingsRow(row, cur)); });
  }

  // trimToLength(buf, gridBpm, lengthMin) — the §14 length setting as a
  // REAL cap. The arrangement engines take no bar budget, so a finished
  // mix longer than the user's chosen budget is trimmed from the tail
  // (outro first) with a 50 ms fade to avoid a click. A mix already at
  // or under budget is returned untouched. Pure DSP, node-testable.
  function trimToLength(buf, gridBpm, lengthMin) {
    if (!isAudioBuffer(buf)) return buf;
    var bpm = Number(gridBpm), min = Number(lengthMin);
    if (!isFinite(bpm) || bpm <= 0 || !isFinite(min) || min <= 0) return buf;
    // §14 formula: totalBars = clamp(round(min × 60 × gridBpm / 240), 32, 400)
    var targetBars = Math.max(32, Math.min(400, Math.round(min * 60 * bpm / 240)));
    var sr = buf.sampleRate || 44100;
    var barLen = Math.max(1, Math.round(240 / bpm * sr));
    var targetLen = targetBars * barLen;
    if (targetLen >= buf.length) return buf;
    var ctx = null;
    try { ctx = RM.audio.ensureCtx(); } catch (e) { ctx = null; }
    if (!ctx || typeof ctx.createBuffer !== 'function') return buf;
    var out;
    try { out = ctx.createBuffer(buf.numberOfChannels, targetLen, buf.sampleRate); }
    catch (e) { return buf; }
    var fade = Math.min(targetLen, Math.max(1, Math.round(0.05 * sr)));
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var src = buf.getChannelData(ch), dst = out.getChannelData(ch);
      dst.set(src.subarray(0, targetLen));
      for (var i = 0; i < fade; i++) dst[targetLen - 1 - i] *= i / fade;
    }
    return out;
  }

  /* ================= w26: per-song audition ================= */
  // Real AudioBufferSourceNode per card. Only one audition plays at a
  // time: starting one stops the mashup preview and any other card.
  function stopAudition() {
    if (st.audSrc) {
      try { st.audSrc.onended = null; st.audSrc.stop(); } catch (e) {}
      try { st.audSrc.disconnect(); } catch (e) {}
      st.audSrc = null;
    }
    if (st.audId != null) {
      st.audId = null;
      refreshAudButtons();
    }
  }

  function refreshAudButtons() {
    var wrap = $('v25-songs');
    if (!wrap || typeof wrap.querySelectorAll !== 'function') return;
    var btns = wrap.querySelectorAll('[data-act="aud"]');
    for (var i = 0; i < btns.length; i++) {
      var id = parseInt(btns[i].getAttribute('data-id'), 10);
      btns[i].textContent = (id === st.audId) ? '⏸ Stop' : '▶ Play';
    }
  }

  function auditionSong(id) {
    var a = A();
    var song = getSong(id);
    if (!song || !isAudioBuffer(song.buffer)) {
      if (a) a.toast('Pick this song first 🎵');
      return;
    }
    if (st.audId === id) { stopAudition(); return; } // user tap -> stop
    stopPreview();  // never overlap with the mashup preview
    stopAudition(); // never overlap with another card
    try {
      var ctx = RM.audio.ensureCtx();
      var src = ctx.createBufferSource();
      src.buffer = song.buffer;
      src.connect(RM.audio.masterIn());
      src.onended = function () {
        if (st.audSrc === src) { st.audSrc = null; st.audId = null; refreshAudButtons(); }
      };
      st.audSrc = src;
      st.audId = id;
      src.start();
      refreshAudButtons();
    } catch (e) {
      stopAudition();
      if (a) a.toast((a.cleanErrMsg && a.cleanErrMsg(e)) || 'Could not play this song.');
    }
  }

  /* ================= w26: pick bridge ================= */
  // app.js's mashupIntercept only knows RM.mashupScreen.pickTarget, so a
  // pick armed from THIS screen would otherwise land in the editor. We
  // temporarily forward RM.mashupScreen.onPicked to our own onPicked and
  // restore it the moment the pick resolves or is abandoned. The forwarder
  // defers to the original handler when our pick is no longer pending, so
  // the old screen's flow is never hijacked.
  function armPickBridge(id) {
    var ms = RM.mashupScreen;
    if (!ms || typeof ms.onPicked !== 'function') return;
    disarmPickBridge();
    var orig = ms.onPicked;
    st._bridge = { id: id, orig: orig };
    ms.onPicked = function (slot, buffer, name) {
      var cur = st._bridge;
      disarmPickBridge();
      if (cur && st.pickId === cur.id && getSong(cur.id)) {
        onPicked(cur.id, buffer, name);
      } else if (cur && typeof cur.orig === 'function') {
        cur.orig.call(ms, slot, buffer, name);
      }
    };
    try { ms.pickTarget = 900 + id; } catch (e) {}
  }

  function disarmPickBridge() {
    var b = st._bridge;
    st._bridge = null;
    if (!b) return;
    var ms = RM.mashupScreen;
    if (ms) {
      try { if (typeof b.orig === 'function') ms.onPicked = b.orig; } catch (e) {}
      try { if (ms.pickTarget > 900) ms.pickTarget = 0; } catch (e) {}
    }
  }

  // v29 F1: pick abandon ke saare exit path — bridge + app-side flag dono disarm.
  function cancelPick() {
    st.pickId = null;
    st._viaNative = false;
    disarmPickBridge();
    try { if (RM.app && typeof RM.app.disarmMashupPick === 'function') RM.app.disarmMashupPick(); } catch (e) {}
  }

  /* ================= pick flow (exact #cdx-pick path) ================= */

  function requestPick(id) {
    var a = A();
    if (!a) return;
    stopPreview();
    stopAudition();
    st.pickId = id;
    armPickBridge(id); // w26: route app.js's mashupIntercept to our onPicked
    st._viaNative = false;
    try {
      if (RM.app && typeof RM.app.pickAudio === 'function') {
        // v29 F1: direct routing arm karo — decode hote hi buffer mashupIntercept
        // -> bridge -> onPicked me land karega, user Create screen pe hi rahega.
        if (typeof RM.app.armMashupPick === 'function') RM.app.armMashupPick();
        st._viaNative = true;
        RM.app.pickAudio(); // DIRECT: native system picker
      } else if (RM.ux && typeof RM.ux.pickMusic === 'function') {
        RM.ux.pickMusic(); // legacy fallback: old import screen; "Use" delivers via bridge
      } else {
        a.show('import'); // legacy fallback: bridge stays armed for "Use"
      }
    } catch (e) { cancelPick(); return; }
    a.toast('Pick a song 🎵');
  }

  // Called by the coordinator's app.js interception with the decoded
  // AudioBuffer + file name. Name = file name (no invented artist names).
  function onPicked(id, buffer, name) {
    var a = A();
    disarmPickBridge(); // w26: pick resolved — restore the old screen's handler
    st._viaNative = false;
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
    else if (act === 'aud') { auditionSong(id); }
    else if (act === 'remove') {
      if (st.songs.length <= MIN_SONGS) return;
      stopPreview();
      stopAudition();
      if (st.pickId === id) { cancelPick(); } // v29 F1: pending pick bhi disarm
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
    stopAudition(); // w26: never overlap with a per-song audition
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
    // w29 P2-7: unlock the mode/preset chips + settings on failure too.
    renderModeChips();
    renderPresetChips();
    renderSettings();
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

  function buildViaMega(songs, onProgress, po) {
    if (!RM.mashupMega || typeof RM.mashupMega.build !== 'function') {
      return Promise.reject(new Error('Mashup engine not ready — update the app and retry.'));
    }
    var list = songs.map(function (s) { return { buffer: s.buffer, name: s.name }; });
    var token = (RM.mashupStems && typeof RM.mashupStems.makeToken === 'function')
      ? RM.mashupStems.makeToken() : null;
    // v29 F2: preset → real mega opts. styleId changes the beat pattern
    // audibly; cycles stays at the engine default. The engine takes NO
    // other preset opts — tempoShift / sidechainDb are applied post-build
    // in finish() (applyPresetTempo / applyPresetPump); vocalBoostDb is a
    // mix-time param the engine fixes internally (never faked post-build).
    var megaOpts = { token: token };
    if (po && po.styleId) megaOpts.styleId = po.styleId;
    return RM.mashupMega.build(list, megaOpts,
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

  /* ---- w26: Classic (RM.mashup.build) + Vocal Swap (RM.mashupSwap.build).
         2-song engines: no opts, no onStep — the stage UI is driven from
         progress fractions so it never sits static.
         v29 F2 (P1-2): takes the preset build opts (po) for the record —
         the duet engines accept no opts, so the preset params land in the
         post-chain (finish()): tempoShift via WSOLA stretch, sidechainDb
         via the grid pump, risers via riserPlanForDuet (never null). ---- */

  function buildDuet(which, songs, onProgress, po) {
    var isSwap = which === 'swap';
    var mod = isSwap ? RM.mashupSwap : RM.mashup;
    if (!mod || typeof mod.build !== 'function') {
      return Promise.reject(new Error('Mashup engine not ready — update the app and retry.'));
    }
    var token = (isSwap && RM.mashupStems && typeof RM.mashupStems.makeToken === 'function')
      ? RM.mashupStems.makeToken() : null;
    function prog(label, frac) {
      var f = Number(frac) || 0;
      // Honest stage mapping of what these engines really do:
      // isolate vocals → tempo/key match → mix → master.
      var lb = String(label || '');
      if (f < 0.45) {
        setStage('bpm', 'active', 'Smart BPM detect');
        setStage('key', 'active', 'Smart key detect');
        setStage('stems', 'active', 'Separating stems — ' + lb);
      } else if (f < 0.85) {
        setStage('bpm', 'done', 'Smart BPM detect ✓');
        setStage('key', 'done', 'Smart key detect ✓');
        setStage('stems', 'done', 'Separating stems ✓');
        setStage('arrange', 'active', 'Building arrangement — ' + lb);
      } else {
        setStage('arrange', 'done', 'Building arrangement ✓');
        setStage('mix', 'active', 'Mixing — ' + lb);
      }
      onProgress(lb, f);
    }
    var p = isSwap
      ? mod.build(songs[0].buffer, songs[1].buffer, prog, token)
      : mod.build(songs[0].buffer, songs[1].buffer, prog);
    return Promise.resolve(p).then(function (res) {
      setStage('mix', 'done', 'Mixing ✓');
      setStage('master', 'done', 'Mastering ✓');
      var m = (res && res.meta) || {};
      var tags = [];
      ['engineTagVocal', 'engineTagInstr', 'engineTagSong1', 'engineTagSong2'].forEach(function (f2) {
        if (m[f2]) tags.push(m[f2]);
      });
      var et = res && res.engineTags;
      if (et && typeof et === 'object' && !Array.isArray(et)) {
        for (var k in et) if (Object.prototype.hasOwnProperty.call(et, k) && et[k]) tags.push(et[k]);
      }
      var gridBpm = Number(m.bpm1) || Number(m.targetBpm) || 100;
      return { buffer: res && res.buffer, meta: m, engineTags: tags,
               duet: which, gridBpm: gridBpm };
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

  function buildExtended(songs, onProgress, po) {
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
    // w26: preset → real extended-pipeline opts (defaults = previous behaviour).
    var BPM_FALLBACK = 100, CYCLES = 2, BARS_PER_VOCAL = 8, XFADE_BARS = 0.5, INTRO_BARS = 4, OUTRO_BARS = 4;
    var xfade = (po && isFinite(Number(po.xfadeBars))) ? Number(po.xfadeBars) : XFADE_BARS;
    var vBoost = (po && isFinite(Number(po.vocalBoostDb))) ? Number(po.vocalBoostDb) : 3;
    var tempoShift = (po && isFinite(Number(po.tempoShift)) && Number(po.tempoShift) > 0)
      ? Number(po.tempoShift) : 1;
    var styleId = (po && po.styleId) || null;
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
            // w26: preset tempoShift scales the master grid (clamped 50–220).
            var grid = (song.bpm || BPM_FALLBACK) * tempoShift;
            masterBpm = Math.max(50, Math.min(220, grid));
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
      var style = nearestStyle(beats, masterBpm, styleId);
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
        xfadeBars: xfade,          // w26: preset crossfade style
        vocalBoostDb: vBoost,      // w26: preset vocal focus
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
      // w26: riser plan for the preset post-chain (known arrangement).
      st._extPlan = riserPlanForExtended(masterBpm, N);
      return { buffer: buffer, meta: (tl && tl.meta) || {}, engineTags: tags };
    });
  }

  /* ================= create entry ================= */

  function create() {
    var a = A();
    if (!a || st.creating) return;
    var songs = enabledSongs();
    // w26: the engine is chosen by the mode selector — Classic/Swap are
    // 2-song engines, Mega covers 2–8, 9–10 always use the extended pipeline.
    var route = resolveEngine(st.mode, songs.length);
    if (!route.engine) { a.toast(route.reason || 'Pick at least 2 songs first 🎵'); return; }

    stopPreview();
    stopAudition();
    st.creating = true;
    st.result = null;
    st._po = null;
    st._extPlan = null;
    // w29 P2-7: lock the mode/preset chips + settings while building.
    renderModeChips();
    renderPresetChips();
    renderSettings();
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
      // v29 F2: style preset post-chain — real audible DSP. Pre-build, only
      // styleId reaches the mega engine and only xfade/vocalBoost/tempoShift
      // reach the extended pipeline, so the remaining headline params are
      // applied here, post-build, with REAL DSP:
      //   tempoShift  → WSOLA time-stretch of the mixdown (ratio 1/tempoShift,
      //                 pitch preserved; extended already did it pre-build),
      //   sidechainDb → beat-grid-synced pump at the exact dB depth,
      //   then tone → space (reverb/echo) → risers → mastering LAST, so the
      //   output stays true-peak safe. Riser placement only where the
      //   arrangement structure is known (duet: derived from the real
      //   buffer — never null). vocalBoostDb is a MIX-TIME param (needs the
      //   separated vocal + beat): real in the extended pipeline, engine
      //   default in mega/duet — NOT faked post-build. Runs after a paint
      //   so the UI never looks dead during processing.
      var po = st._po || presetBuildOpts(st.presetId);
      var spec = (po && po.spec) || null;
      var finalize = function (fbuf) {
        // w29 P2-5: §14 length cap — only when the user explicitly set a
        // length. Trims an over-budget mix from the tail (outro first).
        if (st.lengthTouched && po && po.spec) {
          try { fbuf = trimToLength(fbuf, gridBpm, po.spec.lengthMin); } catch (e) {}
        }
        var tags = (res && res.engineTags) || songs.map(function (s) { return s.tag || 'smart DSP'; });
        st.result = { buffer: fbuf, meta: meta, engine: honestEngineLabel(tags) };
        try {
          var nm;
          if (route.engine === 'classic') nm = 'Classic Mashup (' + displayName(songs[0].name) + ' × ' + displayName(songs[1].name) + ')';
          else if (route.engine === 'swap') nm = 'Vocal Swap (' + displayName(songs[0].name) + ' × ' + displayName(songs[1].name) + ')';
          else if (route.engine === 'mega') nm = 'Mega Mashup (' + songs.length + ' songs)';
          else nm = 'Mashup (' + songs.length + ' songs)';
          st.result.meta.name = nm;
          st.result.meta.style = 'v25create';
          st.result.meta.mode = route.engine;
        } catch (e) {}
        st.creating = false;
        if (c) c.hidden = true;
        setProgress('Done', 1);
        var pw2 = $('v25-progress');
        if (pw2) pw2.hidden = true;
        // w29 P2-7: unlock the mode/preset chips + settings.
        renderModeChips();
        renderPresetChips();
        renderSettings();
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
      if (!spec) {
        finalize(buf);
        return;
      }
      setProgress('Applying style preset (' + spec.presetName + ')…', 1);
      setTimeout(function () {
        // Extended pipeline already scaled masterBpm pre-build; mega/duet
        // get the tempo here. The effective shift is measured from the
        // buffer lengths afterwards, so a skipped/failed stretch can never
        // misplace the risers or the pump grid.
        var tempoPreBuilt = (route.engine === 'extended');
        var tShift = Number(spec.tempoShift) || 1;
        var chain = Promise.resolve(buf);
        if (!tempoPreBuilt) {
          chain = chain.then(function (b) {
            return applyPresetTempo(b, tShift, function (q, label) {
              setProgress(label || 'Applying style tempo…', q);
            });
          });
        }
        chain.then(function (sb) {
          var fbuf = (sb && isAudioBuffer(sb)) ? sb : buf;
          var effShift = 1;
          try {
            if (buf.length > 0 && fbuf.length > 0) {
              var r = buf.length / fbuf.length;
              if (isFinite(r) && r > 0) effShift = r;
            }
          } catch (e0) {}
          var plan = null, effBpm = 100;
          try {
            if (res && res.duet) {
              effBpm = (Number(res.gridBpm) || 100) * (tempoPreBuilt ? 1 : effShift);
              plan = riserPlanForDuet(fbuf, effBpm); // v29 F2: duet plan, never null
            } else if (st._extPlan) {
              plan = st._extPlan;
              effBpm = Number(plan.gridBpm) || 100; // already tempo-shifted pre-build
            } else if (meta && meta.style === 'mega') {
              var preBpm = Number(meta.bpm1) || 100;
              effBpm = preBpm * (tempoPreBuilt ? 1 : effShift);
              plan = riserPlanForMega(meta);
              if (plan) plan.gridBpm = effBpm; // bars got longer/shorter with the stretch
            }
          } catch (e) {}
          if (!(effBpm > 0)) effBpm = 100;
          try {
            fbuf = applyPresetPump(fbuf, spec.sidechainDb, effBpm);
            fbuf = applyPresetPost(fbuf, spec, plan, effBpm);
            try {
              meta.preset = spec.presetName;
              if (fbuf && isFinite(fbuf.duration)) meta.durationSec = Math.round(fbuf.duration * 10) / 10;
            } catch (e2) {}
          } catch (e3) {}
          finalize(fbuf);
        }).then(null, function () { finalize(buf); });
      }, 30);
    };

    Promise.resolve()
      .then(function () {
        // v29 F2: preset params → real build opts (mega styleId; extended
        // xfade/vocalBoost/tempoShift pre-build; duet engines take no opts
        // — their preset params land in the finish() post-chain).
        var po = presetBuildOpts(st.presetId);
        st._po = po;
        if (route.engine === 'classic' || route.engine === 'swap') {
          return buildDuet(route.engine, songs, onProgress, po);
        }
        if (route.engine === 'extended') {
          // 9–10 songs: extended pipeline — stages 1/2/4 run directly here.
          setStage('bpm', 'active', 'Smart BPM detect…');
          setStage('key', 'active', 'Smart key detect…');
          return analyzeRun(songs, 0.55, onProgress).then(function () {
            setStage('stems', 'done', 'Separating stems ✓');
            setStage('arrange', 'active', 'Building arrangement…');
            return buildExtended(songs, onProgress, po);
          });
        }
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
          return buildViaMega(songs, onProgress, po);
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
    renderModeChips();    // w26
    renderPresetChips();  // w26
    renderSettings();     // w29 P2-5
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
        if (name !== 'v25create') { stopPreview(); stopAudition(); }
        // v29 F1: native-path pick kabhi import screen pe nahi jata (decode ->
        // intercept -> slot, user Create pe rehta hai). Import pe jaana = flow
        // abandon -> disarm. Legacy fallback (import screen + "Use") me bridge
        // armed rehna chahiye, isliye wahan exemption barkarar.
        if (name !== 'v25create' && (name !== 'import' || st._viaNative) && st.pickId) {
          cancelPick(); // w26: abandoned pick — restore old screen's handler
        }
      } catch (e) {}
    };
    a.onShow = st._hook;
  }

  function ready(attempts) {
    if (RM.app && document.body) {
      wire();
      wrapOnShow();
      // v29 F1: cancel/permission-deny/decode-fail pe app.js isi hook se bridge disarm karwata hai.
      try { if (typeof RM.app.setPickCancelHook === 'function') RM.app.setPickCancelHook(cancelPick); } catch (e) {}
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
      // w26
      MODES: MODES,
      resolveEngine: resolveEngine,
      cardBpmText: cardBpmText,
      cardKeyText: cardKeyText,
      presetSpec: presetSpec,
      presetBuildOpts: presetBuildOpts,
      listPresets: listPresets,
      applyPresetSpace: applyPresetSpace,
      applyPresetPost: applyPresetPost,
      riserPlanForMega: riserPlanForMega,
      riserPlanForExtended: riserPlanForExtended,
      // v29 F2
      applyPresetTempo: applyPresetTempo,
      applyPresetPump: applyPresetPump,
      riserPlanForDuet: riserPlanForDuet,
      analyzeSong: analyzeSong,
      // w29 (P2-5/P2-6/P2-7)
      getSettings: getSettings,
      setSetting: setSetting,
      settingsSummary: settingsSummary,
      renderSettings: renderSettings,
      trimToLength: trimToLength,
      selectMode: selectMode,
      selectPreset: selectPreset,
      clearStaleResult: clearStaleResult,
      renderModeChips: renderModeChips,
      renderPresetChips: renderPresetChips,
      _setCreating: function (v) { st.creating = !!v; },
      _setSettingsOpen: function (v) { st.settingsOpen = !!v; },
      _setResult: function (buf) { st.result = buf ? { buffer: buf } : null; },
      _getState: function () { return { mode: st.mode, presetId: st.presetId, creating: st.creating, settings: st.settings }; },
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
