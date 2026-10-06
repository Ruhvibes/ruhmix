'use strict';
/* =====================================================================
   RuhMix — mashup-mega.js  (W2: mega pipeline core — 2..8 song mashup)

   Exposes window.RM.mashupMega.build(songs, opts, onProgress, onStep)
     -> Promise<{ buffer, meta, engineTags }>

   songs : [{ buffer: AudioBuffer, name }] (2..8, sequential processing)
   opts  : { token, styleId? }
   onProgress(label, frac 0..1) — same style as RM.mashup.build
   onStep(name, info)           — 'vocals' | 'beat' | 'arrange' | 'done'

   Pipeline (SEQUENTIAL — one song at a time, memory sane):
     1. Per song: separate vocals (mashup-stems provider) -> release the
        ORIGINAL song buffer immediately (null assign) -> detect key on
        the CLEAN vocal -> detect BPM (song 1 = master BPM) -> stretch
        other songs' vocals to the master grid + key-match (pitch-shift)
        -> trim to the bars the arrangement actually needs
        (cycles*barsPerVocal + 1 slack) -> throwIfCancelled + yield.
     2. Beat: nearest style to master BPM, rendered across the full
        arrangement (intro 4 + cycles*N*8 + outro 4 bars, cycles = 2).
     3. Arrangement: RM.mashupArrange.buildTimeline (W3 owns it — this
        file only CALLS it, defensively).

   Reuses (never reinvents):
     - RM.mashupStems.provider (or RM.mashup.getStemsProvider()) for
       vocal separation — honest per-song engine tags come from it:
       'neural stems' | 'smart DSP' | 'smart DSP (neural failed)'.
       Quota flag RM.mashupStems.quotaExhausted() is checked
       defensively (typeof) — W5 adds it; until then it is skipped.
     - RM.mashupDSP.detectKey / timeStretch / pitchShift /
       semitonesBetween (W1).
     - RM.audio.detectBPM + RM.audio.resampleBuffer (audio-engine.js).
     - RM.Beats.renderBeat + RM.Beats.STYLES (beats.js).

   Tempo math (verified empirically against timeStretch: output length
   = input length * ratio, so slowing 120->90 BPM needs ratio 120/90):
     ratio = songBpm / effBpm, where effBpm is locked to the master grid
     (masterBpm, or masterBpm*2 / masterBpm/2 when the raw ratio would
     exceed WSOLA's sane range — the half/double-time guard keeps every
     segment ON the beat instead of drifting after the 0.5..2 clamp).

   Key order (W7 lesson, copied from mashup.js): detect key on the
   CLEAN vocal buffers BEFORE time-stretching — WSOLA joins can confuse
   the chromagram on stretched material.

   HONESTY: engine label is 'Neural stems engine' only when every song
   really came back tagged 'neural stems'; 'Smart DSP engine' when none
   did; 'Neural + Smart DSP mix' otherwise. Any '(neural failed)' tag
   adds the ' (neural unavailable)' suffix. Never the reverse.

   No autoplay. Errors are friendly (mashupErrText pattern); a
   {kind:'cancelled'} is rethrown untouched so the UI shows 'Cancelled.'.
   ===================================================================== */
window.RM = window.RM || {};

RM.mashupMega = (function () {

  var CYCLES = 2;
  var BARS_PER_VOCAL = 8;
  var XFADE_BARS = 0.5; // v23: tight DJ handoff (0.25-bar out + 0.25-bar in) — snappier than a full-bar dip, still click-free
  var INTRO_BARS = 4;
  var OUTRO_BARS = 4;
  var BPM_FALLBACK = 100;
  var AUTO_TIEBREAK = ['hiphop', 'lofi']; // same preference as mashup.js

  /* ---------------- small helpers ---------------- */

  function isAudioBuffer(b) {
    return !!(b && typeof b.getChannelData === 'function' && b.length > 0 &&
              b.sampleRate > 0);
  }

  // Macrotask yield — keeps the progress UI painting during long loops.
  function tick() {
    return new Promise(function (res) { setTimeout(res, 0); });
  }

  function prog(onProgress, label, frac) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(label, Math.max(0, Math.min(1, frac))); } catch (e) {}
  }

  function step(onStep, name, info) {
    try { if (typeof onStep === 'function') onStep(name, info); } catch (e) {}
  }

  // Cooperative cancel — mirrors mashup.js's throwIfCancelled.
  function throwIfCancelled() {
    try {
      if (RM.mashupStems &&
          typeof RM.mashupStems.isCancelRequested === 'function' &&
          RM.mashupStems.isCancelRequested()) throw { kind: 'cancelled' };
    } catch (e) {
      if (e && e.kind === 'cancelled') throw e;
    }
  }

  // Friendly error text — same pattern as mashup.js's mashupErrText.
  function megaErrText(e) {
    var k = e && e.kind;
    if (k === 'cancelled') return 'Cancelled.';
    if (k === 'timeout') return 'The AI server took too long (timeout). Try a shorter song or try again.';
    if (k === 'connect') return 'Cannot reach the AI server. Check your internet connection.';
    if (k === 'quota') return 'The free AI daily limit seems over (~6-10 songs/day). Try again tomorrow.';
    if (k === 'asleep') return 'The AI server is waking up. Wait a minute and try again.';
    if (k === 'server') return 'The AI server returned an error. Please try again in a bit.';
    if (k === 'empty' || k === 'decode' || k === 'process') return 'Vocal isolation failed on this song. Try another song.';
    if (k === 'nocfg' || k === 'nopath') return 'AI server not configured.';
    if (e instanceof Error) return e.message || 'Something went wrong.';
    var s = String((e && e.message) || e || 'Something went wrong.');
    return s === '[object Object]' ? 'Something went wrong.' : s;
  }

  /* ---------------- dependency resolution ---------------- */

  function dep(name, obj, fn) {
    if (!obj || (fn && typeof obj[fn] !== 'function')) {
      throw new Error('Mega Mashup needs ' + name + ' — load order broken. Please update the app.');
    }
    return obj;
  }

  function stemsProvider() {
    // Prefer the live provider registered on RM.mashup (mashup-stems.js
    // registers its neural/DSP provider there); fall back to the raw
    // mashup-stems provider.
    try {
      if (RM.mashup && typeof RM.mashup.getStemsProvider === 'function') {
        var p = RM.mashup.getStemsProvider();
        if (typeof p === 'function') return p;
      }
    } catch (e) {}
    if (RM.mashupStems && typeof RM.mashupStems.provider === 'function') {
      return RM.mashupStems.provider;
    }
    throw new Error('Mega Mashup needs mashup-stems.js (vocal separation) — load order broken.');
  }

  // W5's quota flag — defensive: absent until W5 lands.
  function quotaExhausted() {
    try {
      if (RM.mashupStems && typeof RM.mashupStems.quotaExhausted === 'function') {
        return RM.mashupStems.quotaExhausted() === true;
      }
    } catch (e) {}
    return false;
  }

  /* ---------------- beat style: nearest BPM ---------------- */

  function pickNearestStyle(beats, masterBpm, styleId) {
    var list = beats.STYLES || [];
    if (!list.length) throw new Error('RM.Beats.STYLES is empty — no beat styles to choose from.');
    var want = (styleId != null) ? String(styleId).trim().toLowerCase() : '';
    if (want) {
      for (var i = 0; i < list.length; i++) {
        var s = list[i] || {};
        if (String(s.id || '').toLowerCase() === want ||
            String(s.name || '').toLowerCase() === want) return s;
      }
    }
    var best = null, bestDiff = Infinity, ties = [];
    list.forEach(function (s) {
      var b = Number(s && s.bpm);
      if (!isFinite(b) || b <= 0) return;
      var d = Math.abs(masterBpm - b);
      if (d < bestDiff - 1e-9) { bestDiff = d; best = s; ties = [s]; }
      else if (Math.abs(d - bestDiff) < 1e-9) ties.push(s);
    });
    if (!best) best = list[0];
    if (ties.length > 1) {
      var byId = {};
      ties.forEach(function (s) { byId[String(s.id).toLowerCase()] = s; });
      for (var k = 0; k < AUTO_TIEBREAK.length; k++) {
        if (byId[AUTO_TIEBREAK[k]]) { best = byId[AUTO_TIEBREAK[k]]; break; }
      }
    }
    return best;
  }

  /* ---------------- vocal trimming (memory) ----------------
     The arrangement plays each vocal for CYCLES * BARS_PER_VOCAL bars;
     keeping whole 4-minute vocals for 8 songs would blow phone memory,
     so each stretched/key-matched vocal is trimmed to what the timeline
     needs (+1 bar slack). Silent tail padding if the vocal is shorter. */
  function trimToBars(vocal, sampleRate, bpm, bars) {
    var needLen = Math.max(1, Math.round(bars * (240 / bpm) * sampleRate));
    if (vocal.length <= needLen) return vocal;
    var ctx = RM.audio.ensureCtx();
    var out = ctx.createBuffer(vocal.numberOfChannels, needLen, sampleRate);
    for (var c = 0; c < vocal.numberOfChannels; c++) {
      out.getChannelData(c).set(vocal.getChannelData(c).subarray(0, needLen));
    }
    return out;
  }

  // v26: detectKey() returns {key, mode} — QC parseKey() wants "C"/"Am".
  function qcKeyStr(k) {
    if (!k || typeof k.key !== 'string' || !k.key) return null;
    return k.key + (/minor/i.test(String(k.mode || '')) ? 'm' : '');
  }

  /* ================= the pipeline ================= */

  async function build(songs, opts, onProgress, onStep) {
    opts = opts || {};
    var token = opts.token;

    dep('audio-engine.js (RM.audio)', RM.audio);
    dep('audio-engine.js (RM.audio.detectBPM)', RM.audio, 'detectBPM');
    var dsp = dep('mashup-dsp.js (RM.mashupDSP)', RM.mashupDSP);
    ['detectKey', 'timeStretch', 'pitchShift', 'semitonesBetween'].forEach(function (f) {
      dep('mashup-dsp.js (RM.mashupDSP.' + f + ')', dsp, f);
    });
    var beats = dep('beats.js (RM.Beats)', RM.Beats);
    dep('beats.js (RM.Beats.renderBeat)', beats, 'renderBeat');
    var separate = stemsProvider();

    if (!Array.isArray(songs) || songs.length < 2 || songs.length > 8) {
      throw new Error('Mega Mashup needs 2 to 8 songs.');
    }
    var N = songs.length;
    // v23: honor opts.cycles (clamped 1..4, default 2) — the rotation repeats
    // each vocal this many times for a longer mix. The UI does not expose it;
    // callers/tests may request a shorter (1) or longer (3-4) arrangement.
    var cycles = 2;
    if (opts && isFinite(Number(opts.cycles))) {
      cycles = Math.max(1, Math.min(4, Math.round(Number(opts.cycles))));
    }
    // Normalize entries: {buffer, name} (also accept a bare AudioBuffer).
    var entries = songs.map(function (s, i) {
      var buf = (s && s.buffer && isAudioBuffer(s.buffer)) ? s.buffer
              : (isAudioBuffer(s) ? s : null);
      if (!buf) throw new Error('Song ' + (i + 1) + ' has no audio. Please pick the songs again.');
      var name = (s && typeof s.name === 'string' && s.name) ? s.name : ('Song ' + (i + 1));
      return { buffer: buf, name: name };
    });

    var VOCAL_BUDGET = 0.55; // per-song loop owns 0..0.55 of progress
    var vocalSegs = [];
    var perSongTags = [];
    var engineTags = [];
    var masterBpm = BPM_FALLBACK, masterKey = null, sampleRate = 0;
    var qcSongs = []; // v26: per-song QC meta {name, bpm, key, stretched}

    /* ---- Step 1: per-song vocal pipeline (SEQUENTIAL) ---- */
    for (var i = 0; i < N; i++) {
      throwIfCancelled();
      var entry = entries[i];
      var songLabel = 'Song ' + (i + 1) + '/' + N;
      step(onStep, 'vocals', { song: i + 1, total: N, name: entry.name });
      var base = (i / N) * VOCAL_BUDGET;
      var span = VOCAL_BUDGET / N;

      // Quota: label honestly when the neural quota is spent (W5 flag).
      var quota = quotaExhausted();
      var sepLabel = quota
        ? songLabel + ': Smart DSP (neural quota finished)'
        : songLabel + ': separating vocals…';
      if (quota && engineTags.indexOf('dsp-quota') < 0) engineTags.push('dsp-quota');
      prog(onProgress, sepLabel, base);

      var sep;
      try {
        sep = await separate(entry.buffer, 'vocal', function (q) {
          prog(onProgress, sepLabel, base + q * span * 0.62);
        });
      } catch (e) {
        if (e && e.kind === 'cancelled') throw e; // UI shows 'Cancelled.'
        throw new Error('Vocal isolation failed (' + entry.name + '): ' + megaErrText(e));
      }
      if (!sep || !isAudioBuffer(sep.buffer)) {
        throw new Error('Vocal isolation returned no audio (' + entry.name + ').');
      }
      perSongTags.push(sep.tag || 'smart DSP');
      prog(onProgress, sepLabel, base + span * 0.62);

      // Release the ORIGINAL song buffer immediately — only the vocal lives on.
      // Both the pipeline's own reference AND the caller's wrapper are
      // nulled so the big original really becomes garbage (memory!).
      var vocal = sep.buffer;
      sep = null;
      entry.buffer = null;
      entries[i] = { buffer: null, name: entry.name };
      try {
        if (songs[i] && typeof songs[i] === 'object' && 'buffer' in songs[i]) {
          songs[i].buffer = null;
        }
      } catch (e) {}

      // Sample-rate unification (cheap insurance; songs are usually equal).
      if (i === 0) {
        sampleRate = vocal.sampleRate;
      } else if (vocal.sampleRate !== sampleRate &&
                 RM.audio && typeof RM.audio.resampleBuffer === 'function') {
        vocal = await RM.audio.resampleBuffer(vocal, sampleRate);
      }
      throwIfCancelled();
      await tick();

      // Key detect on the CLEAN vocal (before any stretch — chromagram
      // reads stretched audio less reliably).
      var keyRes = null;
      try {
        keyRes = await dsp.detectKey(vocal, function (q) {
          prog(onProgress, songLabel + ': matching key…', base + span * 0.62 + q * span * 0.04);
        });
      } catch (e) { keyRes = null; }

      // BPM detect; song 1's BPM is the master grid.
      var bpm = BPM_FALLBACK;
      try {
        var det = await RM.audio.detectBPM(vocal, function (q) {
          prog(onProgress, songLabel + ': detecting tempo…', base + span * 0.66 + q * span * 0.04);
        });
        var b = Number(det);
        if (isFinite(b) && b >= 50 && b <= 220) bpm = b;
      } catch (e) { bpm = BPM_FALLBACK; }
      throwIfCancelled();
      await tick();

      if (i === 0) {
        masterBpm = bpm;
        masterKey = keyRes;
      } else {
        // Tempo: stretch to the master grid. Half/double-time guard keeps
        // extreme BPM gaps ON the beat instead of drifting after the
        // WSOLA 0.5..2 clamp.
        var raw = bpm / masterBpm;
        var effBpm = masterBpm;
        if (raw > 1.6) effBpm = masterBpm * 2;
        else if (raw < 0.625) effBpm = masterBpm / 2;
        var ratio = bpm / effBpm;
        try {
          vocal = await dsp.timeStretch(vocal, ratio, function (q) {
            prog(onProgress, songLabel + ': matching tempo…', base + span * 0.70 + q * span * 0.18);
          });
        } catch (e) {
          throw new Error('Tempo matching failed (' + entry.name + '): ' + megaErrText(e));
        }
        if (!isAudioBuffer(vocal)) throw new Error('Tempo matching returned no audio (' + entry.name + ').');
        throwIfCancelled();

        // Key match: pitch-shift this vocal onto the master key.
        var st = 0;
        try {
          if (masterKey && keyRes) st = dsp.semitonesBetween(masterKey, keyRes);
        } catch (e) { st = 0; }
        if (!isFinite(st)) st = 0;
        st = Math.max(-6, Math.min(6, Math.round(st))); // pitchShift clamps ±6
        if (st !== 0) {
          try {
            var shifted = await dsp.pitchShift(vocal, st, function (q) {
              prog(onProgress, songLabel + ': matching key…', base + span * 0.88 + q * span * 0.10);
            });
            if (isAudioBuffer(shifted)) vocal = shifted;
          } catch (e) {
            throw new Error('Key matching failed (' + entry.name + '): ' + megaErrText(e));
          }
          throwIfCancelled();
        }
      }

      // v26: QC meta — songs 2..N are stretched onto the master grid (the
      // bpm-mismatch scan skips stretched songs); song 1 IS the master.
      qcSongs.push({ name: entry.name, bpm: Math.round(bpm * 100) / 100, key: qcKeyStr(keyRes), stretched: i > 0 });
      // Trim to the bars the arrangement needs (memory: 8 full vocals
      // would be ~700 MB on a phone; trimmed segments are ~15 MB each).
      vocal = trimToBars(vocal, sampleRate, masterBpm, cycles * BARS_PER_VOCAL + 1);
      vocalSegs.push({ buffer: vocal, name: entry.name, index: i });
      prog(onProgress, songLabel + ': ready ✓', base + span);
      throwIfCancelled();
      await tick(); // let the UI paint between songs
    }

    /* ---- Step 2: beat across the full arrangement ---- */
    throwIfCancelled();
    step(onStep, 'beat', { bpm: Math.round(masterBpm) });
    prog(onProgress, 'Creating beat…', VOCAL_BUDGET);
    var style = pickNearestStyle(beats, masterBpm, opts.styleId);
    var totalBars = INTRO_BARS + cycles * N * BARS_PER_VOCAL + OUTRO_BARS;
    var beatBuf;
    try {
      beatBuf = await beats.renderBeat(style.id, masterBpm, totalBars, { sampleRate: sampleRate });
    } catch (e) {
      throw new Error('Beat creation failed: ' + megaErrText(e));
    }
    if (!isAudioBuffer(beatBuf)) throw new Error('Beat creation returned no audio.');
    prog(onProgress, 'Creating beat…', 0.65);
    throwIfCancelled();
    await tick();

    /* ---- Step 3: arrangement (W3 owns RM.mashupArrange) ---- */
    if (!RM.mashupArrange || typeof RM.mashupArrange.buildTimeline !== 'function') {
      throw new Error('Mega arrangement is not ready yet — please update the app and try again.');
    }
    step(onStep, 'arrange', { songs: N });
    var tl;
    try {
      tl = await RM.mashupArrange.buildTimeline({
        vocalSegs: vocalSegs,
        beatBuf: beatBuf,
        masterBpm: masterBpm,
        sampleRate: sampleRate,
        cycles: cycles,
        barsPerVocal: BARS_PER_VOCAL,
        xfadeBars: XFADE_BARS,
        introBars: INTRO_BARS,
        outroBars: OUTRO_BARS,
        // v24 W4 R3: DSP vocalcut stems are full-center mixes — duck the
        // beat -2 dB under any non-neural song's slots so the embedded
        // kick stops fighting the synth beat. Clean neural vocals: no duck.
        beatDuckDb: perSongTags.map(function (t) {
          return String(t || '') === 'neural stems' ? 0 : -2;
        }),
        onProgress: function (label, frac) {
          prog(onProgress, label || 'Arranging…', 0.65 + (frac || 0) * 0.30);
        },
        token: token
      });
    } catch (e) {
      if (e && e.kind === 'cancelled') throw e;
      throw new Error('Arrangement failed: ' + megaErrText(e));
    }
    var buffer = tl && tl.buffer;
    if (!isAudioBuffer(buffer)) throw new Error('Arrangement returned no audio.');
    prog(onProgress, 'Arranging…', 0.95);
    throwIfCancelled();
    await tick();

    /* ---- Step 4: honest engine label ---- */
    var neuralCount = perSongTags.filter(function (t) { return t === 'neural stems'; }).length;
    var anyFailed = perSongTags.some(function (t) {
      return /neural failed|neural unavailable/i.test(String(t || ''));
    });
    var engineLabel;
    if (neuralCount === N) engineLabel = 'Neural stems engine';
    else if (neuralCount === 0) engineLabel = 'Smart DSP engine';
    else engineLabel = 'Neural + Smart DSP mix';
    if (anyFailed) engineLabel += ' (neural unavailable)';
    engineTags.push(engineLabel);

    // v26: QC arrangement meta — bar-aligned slot geometry shared with
    // mashup-arrange.js (slot g plays song g%N after the 4-bar intro).
    var qcArr = (window.RM && RM.v25qc && typeof RM.v25qc.slotMeta === 'function')
      ? RM.v25qc.slotMeta(cycles * N, INTRO_BARS, BARS_PER_VOCAL, 240 / masterBpm,
                          vocalSegs.map(function (v) { return v.name; }))
      : { vocalSlots: [], boundariesSec: [] };

    var meta = {
      bpm1: Math.round(masterBpm * 100) / 100,
      targetBpm: Math.round(masterBpm * 100) / 100,
      songs: qcSongs, // v26: ARRAY of {name,bpm,key,stretched} for the QC scans (count = qcSongs.length)
      songCount: N,   // v26: the old number, kept for the export filename
      masterBpm: Math.round(masterBpm * 100) / 100,
      masterKey: qcKeyStr(masterKey),
      xfadeBars: XFADE_BARS, // v26: real crossfade length for the overlap scan
      vocalSlots: qcArr.vocalSlots,
      boundariesSec: qcArr.boundariesSec,
      cycles: cycles,
      totalBars: totalBars,
      vocalOrder: Array.from({ length: cycles * N }, function (_, k) { return k % N; }),
      durationSec: buffer.duration,
      style: 'mega',
      beatStyle: style.id,
      vocalTags: perSongTags.slice() // per-song honesty for the UI
    };

    step(onStep, 'done', { songs: N });
    prog(onProgress, 'Done', 1);
    return { buffer: buffer, meta: meta, engineTags: engineTags };
  }

  /* ---------------- exports ---------------- */

  // Node unit tests (browser-harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { build: build },
        internals: { pickNearestStyle: pickNearestStyle, trimToBars: trimToBars,
                     megaErrText: megaErrText, throwIfCancelled: throwIfCancelled }
      };
    }
  } catch (e) {}

  return { build: build };

})();
