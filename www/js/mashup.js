'use strict';
/* =====================================================================
   RuhMix — mashup.js
   🤖 Auto Mashup pipeline — PURE LOGIC, no UI code.

   What it does: takes two decoded AudioBuffers (Song A = the voice,
   Song B = the beat), isolates Song A's vocals and Song B's instrumental,
   then auto-aligns tempo + musical key, balances loudness, and mixes them
   into one mashup buffer.

   Depends on (must be loaded BEFORE this file):
     - audio-engine.js  -> RM.audio.detectBPM, RM.audio.resampleBuffer,
                           RM.audio.ensureCtx
     - stems.js         -> RM.stems.run('vocalcut', …)  [default provider]
     - mashup-dsp.js    -> RM.mashupDSP  (Worker 1):
                           detectKey, timeStretch, pitchShift,
                           normalizeToRms, semitonesBetween, fadeInOut
   If mashup-dsp.js is missing, build() rejects with a clear
   Error('mashup-dsp.js not loaded') — never half-renders.

   API:
     RM.mashup.setStemsProvider(fn)
         fn(audioBuffer, want, onProgress)   // want: 'vocal' | 'instrumental'
           -> Promise<{ buffer, tag: 'smart DSP' | 'neural stems' }>
         Default provider uses RM.stems.run('vocalcut'): Center = vocal,
         Sides = instrumental, tag 'smart DSP'. A future AI/cloud module
         can swap in a better provider at runtime.
     RM.mashup.resetStemsProvider()  -> back to the built-in DSP provider.
     RM.mashup.build(buf1, buf2, onProgress) -> Promise<{ buffer, meta }>
         Progress labels are professional English. NO autoplay — returns
         the buffer; the caller decides what to play or export.
         meta = { bpm1, bpm2, targetBpm, stretchRatio,
                  key1, key2, semitones,
                  engineTagVocal, engineTagInstr, durationSec }

   Sample rates: the vocal's (Song A) sample rate is the canonical output
   rate; anything else is resampled to it via RM.audio.resampleBuffer.
   Buffer state: build() keeps NO module state between calls — a failed
   build leaves nothing partial behind.

   buildAuto(song1Buffer, styleId, onProgress, onStep) (Worker 3 — Song 1
   + built-in beat) is a method on THIS same RM.mashup namespace, below:
   fully automatic (vocal isolate -> BPM detect -> beat render -> mix),
   NO autoplay, separate path from build() which is left untouched.
   ===================================================================== */
window.RM = window.RM || {};

RM.mashup = (function () {
  /* ---------------- tunables ---------------- */
  var VOCAL_OVER_BED_DB = 3;      // vocal sits +3 dB over the instrumental bed
  var TARGET_RMS = 0.126;         // ≈ -18 dBFS — common mashup headroom target
  var FADE_SEC = 0.8;             // equal-power fade in/out length
  var PEAK_LIMIT = 0.98;          // hard peak limit (clean digital ceiling)
  var GUARD_HIGH = 1.6;           // ratio = bpm1/bpm2; above this, target bpm1/2
  var GUARD_LOW = 0.625;          // below this, target bpm1*2
  var MAX_SEMITONES = 12;         // pitch-shift clamp: one octave max

  var DSP_FNS = ['detectKey', 'timeStretch', 'pitchShift',
                 'normalizeToRms', 'semitonesBetween', 'fadeInOut'];

  /* ---------------- dependency guard ---------------- */
  function checkDeps() {
    if (!RM.audio || typeof RM.audio.detectBPM !== 'function')
      throw new Error('Auto Mashup needs audio-engine.js (RM.audio.detectBPM) — load it before mashup.js.');
    if (typeof RM.audio.resampleBuffer !== 'function')
      throw new Error('Auto Mashup needs audio-engine.js (RM.audio.resampleBuffer) — load it before mashup.js.');
    if (typeof RM.audio.ensureCtx !== 'function')
      throw new Error('Auto Mashup needs audio-engine.js (RM.audio.ensureCtx) — load it before mashup.js.');
    if (!RM.stems || typeof RM.stems.run !== 'function')
      throw new Error('Auto Mashup needs stems.js (RM.stems.run) — load it before mashup.js.');
    var dsp = RM.mashupDSP;
    var ok = !!dsp && DSP_FNS.every(function (f) { return typeof dsp[f] === 'function'; });
    if (!ok) throw new Error('mashup-dsp.js not loaded');
    return dsp;
  }

  function isAudioBuffer(b) {
    return !!(b && typeof b.getChannelData === 'function' &&
              typeof b.sampleRate === 'number' && typeof b.length === 'number' &&
              typeof b.numberOfChannels === 'number');
  }

  /* ---------------- stems provider ---------------- */
  // Built-in default: Vocal Cut (DSP) — Center (vocal-ish) / Sides (instrumental).
  function defaultStemsProvider(audioBuffer, want, onProgress) {
    if (want !== 'vocal' && want !== 'instrumental')
      return Promise.reject(new Error(
        'Unknown isolation target "' + want + '" — expected "vocal" or "instrumental".'));
    if (!isAudioBuffer(audioBuffer))
      return Promise.reject(new Error('Stems provider got an invalid audio buffer.'));
    return RM.stems.run('vocalcut', audioBuffer, onProgress).then(function (stems) {
      if (!Array.isArray(stems) || stems.length < 2 ||
          !isAudioBuffer(stems[0].buffer) || !isAudioBuffer(stems[1].buffer))
        throw new Error('Vocal Cut (DSP) returned an incomplete stem pair.');
      var picked = (want === 'vocal') ? stems[0] : stems[1];
      return { buffer: picked.buffer, tag: 'smart DSP' };
    });
  }

  var stemsProvider = defaultStemsProvider;

  function setStemsProvider(fn) {
    if (typeof fn !== 'function')
      throw new Error('setStemsProvider expects a function(audioBuffer, want, onProgress).');
    stemsProvider = fn;
  }
  function resetStemsProvider() { stemsProvider = defaultStemsProvider; }
  function getStemsProvider() { return stemsProvider; }

  /* ---------------- pure helpers (tempo / key math) ---------------- */
  // Tempo guard: pick a target both sides can meet without an absurd
  // time-stretch. Halving/doubling the BPM keeps the FEEL (double-time /
  // half-time groove) while shrinking the actual stretch ratio.
  //   ratio = bpm1 / bpm2
  //   ratio > 1.6  -> target = bpm1/2 (e.g. 150/90=1.67 -> target 75,
  //                                   stretch = 75/90 = 0.83: beat slightly
  //                                   slowed, vocal feels double-time)
  //   ratio < 0.625 -> target = bpm1*2 (e.g. 80/140=0.57 -> target 160,
  //                                     stretch = 160/140 = 1.14)
  //   else target = bpm1, stretch = ratio (within [0.625, 1.6]).
  function tempoTarget(bpm1, bpm2) {
    if (!isFinite(bpm1) || bpm1 <= 0) bpm1 = 120;
    if (!isFinite(bpm2) || bpm2 <= 0) bpm2 = 120;
    var ratio = bpm1 / bpm2;
    var target = bpm1;
    if (ratio > GUARD_HIGH) target = bpm1 / 2;
    else if (ratio < GUARD_LOW) target = bpm1 * 2;
    return { bpm1: bpm1, bpm2: bpm2, targetBpm: target, stretchRatio: target / bpm2 };
  }

  // Defensive key labelling — Worker 1 may return {key:'C',mode:'major'},
  // a plain string 'C major', or {name:'C major'}. Anything else -> 'Unknown'.
  function keyLabel(k) {
    if (!k) return 'Unknown';
    if (typeof k === 'string') return k;
    if (typeof k.key === 'string') {
      var mode = (typeof k.mode === 'string') ? k.mode.toLowerCase() : '';
      var modeName = (mode === 'minor') ? 'minor' : (mode === 'major') ? 'major' : mode;
      return (k.key + (modeName ? ' ' + modeName : '')).trim() || 'Unknown';
    }
    if (typeof k.name === 'string' && k.name) return k.name;
    return 'Unknown';
  }

  function dbToGain(db) { return Math.pow(10, db / 20); }

  /* ---------------- resample helper ---------------- */
  function toRate(buf, rate) {
    if (buf.sampleRate === rate) return Promise.resolve(buf);
    return RM.audio.resampleBuffer(buf, rate).catch(function (e) {
      throw new Error('Sample-rate conversion failed: ' + (e && e.message ? e.message : e));
    });
  }

  /* ---------------- mixing: vocal over bed ---------------- */
  // Output: stereo, length = min(vocal, bed). Vocal gain = +3 dB over bed.
  // Handles mono/stereo mismatches by reusing channel 0 for extra channels.
  function mixBuffers(vocalBuf, bedBuf) {
    var sr = vocalBuf.sampleRate;
    var len = Math.min(vocalBuf.length, bedBuf.length);
    if (!len || len < 8) throw new Error('Mashup mix is too short — one of the tracks has no audio.');
    var ctx = RM.audio.ensureCtx();
    var mix = ctx.createBuffer(2, len, sr);
    var gain = dbToGain(VOCAL_OVER_BED_DB); // 10^(3/20) ≈ 1.4125
    var chs = [vocalBuf.numberOfChannels, bedBuf.numberOfChannels];
    for (var c = 0; c < 2; c++) {
      var vc = vocalBuf.getChannelData(Math.min(c, chs[0] - 1));
      var bc = bedBuf.getChannelData(Math.min(c, chs[1] - 1));
      var mc = mix.getChannelData(c);
      for (var i = 0; i < len; i++) mc[i] = bc[i] + vc[i] * gain;
    }
    return mix;
  }

  // Hard peak limit at PEAK_LIMIT — nothing above the digital ceiling.
  function hardPeakLimit(buf) {
    var peak = 0;
    var chans = [];
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var d = buf.getChannelData(c);
      chans.push(d);
      for (var i = 0; i < d.length; i++) {
        var a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > PEAK_LIMIT) {
      for (var k = 0; k < chans.length; k++) {
        var dd = chans[k];
        for (var j = 0; j < dd.length; j++) {
          if (dd[j] > PEAK_LIMIT) dd[j] = PEAK_LIMIT;
          else if (dd[j] < -PEAK_LIMIT) dd[j] = -PEAK_LIMIT;
        }
      }
    }
    return peak;
  }

  /* ---------------- the pipeline ---------------- */
  function build(buf1, buf2, onProgress) {
    // checkDeps() throws synchronously inside this async function, so a
    // missing mashup-dsp.js becomes a rejected promise, never a crash.
    var dsp = checkDeps();
    if (!isAudioBuffer(buf1))
      return Promise.reject(new Error('Auto Mashup needs two audio tracks — the first track is missing or invalid.'));
    if (!isAudioBuffer(buf2))
      return Promise.reject(new Error('Auto Mashup needs two audio tracks — the second track is missing or invalid.'));

    var lastFrac = -1;
    var prog = function (label, frac) {
      try {
        if (onProgress) {
          var f = Math.max(0, Math.min(1, frac));
          if (f < lastFrac) f = lastFrac; // never move the bar backwards (FP dips)
          lastFrac = f;
          onProgress(label, f);
        }
      } catch (e) { /* never break the pipeline */ }
    };

    var chain = Promise.resolve();

    /* ---- Stage 1: Detecting tempo… ---- */
    var bpm1 = 120, bpm2 = 120, tempo;
    chain = chain.then(function () {
      prog('Detecting tempo…', 0.01);
      var p1 = RM.audio.detectBPM(buf1, function (q) { prog('Detecting tempo…', 0.01 + q * 0.06); });
      var p2 = RM.audio.detectBPM(buf2, function (q) { prog('Detecting tempo…', 0.07 + q * 0.06); });
      return Promise.all([p1, p2]);
    }).then(function (bpms) {
      tempo = tempoTarget(bpms[0], bpms[1]);
      bpm1 = tempo.bpm1; bpm2 = tempo.bpm2;
      prog('Detecting tempo…', 0.14);
    }).catch(function (e) {
      throw new Error('Tempo detection failed: ' + (e && e.message ? e.message : e));
    });

    /* ---- Stage 2: Isolate vocals (A) + beat (B) ---- */
    var vocalBuf = null, instrBuf = null, tagV = 'smart DSP', tagI = 'smart DSP';
    chain = chain.then(function () {
      prog('Isolating vocals…', 0.16);
      var pv = Promise.resolve().then(function () {
        return stemsProvider(buf1, 'vocal', function (q) { prog('Isolating vocals…', 0.16 + q * 0.14); });
      });
      return pv;
    }).then(function (res) {
      if (!res || !isAudioBuffer(res.buffer))
        throw new Error('The vocals isolation returned no audio.');
      vocalBuf = res.buffer;
      tagV = res.tag || tagV;
      prog('Isolating beat…', 0.30);
      return stemsProvider(buf2, 'instrumental', function (q) { prog('Isolating beat…', 0.30 + q * 0.14); });
    }).then(function (res) {
      if (!res || !isAudioBuffer(res.buffer))
        throw new Error('The beat isolation returned no audio.');
      instrBuf = res.buffer;
      tagI = res.tag || tagI;
      prog('Isolating beat…', 0.44);
    }).catch(function (e) {
      if (/^The vocals isolation|^The beat isolation|^Unknown isolation target/.test(e.message)) throw e;
      throw new Error('Stem isolation failed: ' + (e && e.message ? e.message : e));
    });

    /* ---- Stage 2b: common sample rate (vocal/Song A rate wins) ---- */
    chain = chain.then(function () {
      var sr = buf1.sampleRate;
      return Promise.all([toRate(vocalBuf, sr), toRate(instrBuf, sr)]);
    }).then(function (rs) {
      vocalBuf = rs[0]; instrBuf = rs[1];
    }).catch(function (e) {
      if (/^Sample-rate conversion failed/.test(e.message)) throw e;
      throw new Error('Sample-rate normalization failed: ' + (e && e.message ? e.message : e));
    });

    /* ---- Stage 3: Matching key… (detect on CLEAN buffers, BEFORE stretch) ----
       Key is pitch — unaffected by time-stretching. Detecting it on the
       already-stretched beat is less reliable: WSOLA joins can confuse the
       chromagram on dense/polyphonic material (measured: a D-major beat
       detected as C# minor after a 0.703 stretch). So detect first on the
       clean resampled buffers, stretch after; the semitone shift is still
       applied to the stretched buffer below. */
    var key1 = 'Unknown', key2 = 'Unknown', semitones = 0;
    chain = chain.then(function () {
      prog('Matching key…', 0.46);
      var p1, p2;
      try {
        p1 = dsp.detectKey(vocalBuf);
        p2 = dsp.detectKey(instrBuf);
      } catch (e) { throw new Error('Key matching failed: ' + (e && e.message ? e.message : e)); }
      return Promise.all([Promise.resolve(p1), Promise.resolve(p2)]).then(function (keys) {
        key1 = keyLabel(keys[0]); key2 = keyLabel(keys[1]);
        prog('Matching key…', 0.54);
        if (keys[0] && keys[1]) {
          var st;
          try { st = dsp.semitonesBetween(keys[0], keys[1]); }
          catch (e) { throw new Error('Key matching failed: ' + (e && e.message ? e.message : e)); }
          if (!isFinite(st)) st = 0;
          // Clamp to ±1 octave: beyond that a pitch-shift sounds unnatural,
          // so we cap it instead of producing a chipmunk effect.
          semitones = Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, Math.round(st)));
        }
        prog('Matching key…', 0.58);
      }, function (e) {
        throw new Error('Key matching failed: ' + (e && e.message ? e.message : e));
      });
    });

    /* ---- Stage 4: Matching tempo… (stretch the BEAT, then key-shift) ---- */
    chain = chain.then(function () {
      prog('Matching tempo…', 0.60);
      var p;
      try { p = dsp.timeStretch(instrBuf, tempo.stretchRatio); }
      catch (e) { throw new Error('Tempo matching failed: ' + (e && e.message ? e.message : e)); }
      return Promise.resolve(p).then(function (stretched) {
        if (!isAudioBuffer(stretched)) throw new Error('Tempo matching returned no audio.');
        instrBuf = stretched;
        prog('Matching tempo…', 0.66);
        if (semitones !== 0) {
          var pp;
          try { pp = dsp.pitchShift(instrBuf, semitones); }
          catch (e) { throw new Error('Key matching failed: ' + (e && e.message ? e.message : e)); }
          return Promise.resolve(pp).then(function (shifted) {
            if (isAudioBuffer(shifted)) instrBuf = shifted;
            prog('Matching tempo…', 0.70);
          }, function (e) {
            throw new Error('Key matching failed: ' + (e && e.message ? e.message : e));
          });
        }
        prog('Matching tempo…', 0.70);
      }, function (e) {
        throw new Error('Tempo matching failed: ' + (e && e.message ? e.message : e));
      });
    });

    /* ---- Stage 5: Balancing loudness… (equal RMS) ---- */
    chain = chain.then(function () {
      prog('Balancing loudness…', 0.72);
      var q1, q2;
      try {
        q1 = dsp.normalizeToRms(vocalBuf, TARGET_RMS);
        q2 = dsp.normalizeToRms(instrBuf, TARGET_RMS);
      } catch (e) { throw new Error('Loudness balancing failed: ' + (e && e.message ? e.message : e)); }
      return Promise.all([Promise.resolve(q1), Promise.resolve(q2)]).then(function (n) {
        if (isAudioBuffer(n[0])) vocalBuf = n[0]; // tolerant: allow in-place
        if (isAudioBuffer(n[1])) instrBuf = n[1];
        prog('Balancing loudness…', 0.82);
      }, function (e) {
        throw new Error('Loudness balancing failed: ' + (e && e.message ? e.message : e));
      });
    });

    /* ---- Stage 6: Mixing… ---- */
    var outBuf = null;
    chain = chain.then(function () {
      prog('Mixing…', 0.84);
      var mix = mixBuffers(vocalBuf, instrBuf); // throws meaningfully
      var f;
      try { f = dsp.fadeInOut(mix, FADE_SEC); }
      catch (e) { throw new Error('Mixing failed (fade): ' + (e && e.message ? e.message : e)); }
      return Promise.resolve(f).then(function (faded) {
        if (isAudioBuffer(faded)) mix = faded; // tolerant: allow in-place
        hardPeakLimit(mix);
        outBuf = mix;
        prog('Mixing…', 1);
      }, function (e) {
        throw new Error('Mixing failed (fade): ' + (e && e.message ? e.message : e));
      });
    });

    /* ---- done: no partial state kept ---- */
    return chain.then(function () {
      return {
        buffer: outBuf,
        meta: {
          bpm1: bpm1,
          bpm2: bpm2,
          targetBpm: Math.round(tempo.targetBpm * 10) / 10,
          stretchRatio: Math.round(tempo.stretchRatio * 1000) / 1000,
          key1: key1,
          key2: key2,
          semitones: semitones,
          engineTagVocal: tagV,
          engineTagInstr: tagI,
          durationSec: Math.round(outBuf.duration * 10) / 10,
        },
      };
    });
  }


  /* =====================================================================
     buildAuto: Song 1 + BUILT-IN BEAT (Worker 3).
     Fully automatic — the user does nothing but pick the song (2 taps:
     Song pick -> Auto Mashup):

       1. Song 1's vocals are isolated AUTOMATICALLY (the registered stem
          provider — Smart DSP default; neural when the user configured
          their own HF Space — the same provider build() uses).
       2. Song 1's BPM is detected (RM.audio.detectBPM — reused, never
          duplicated), the nearest beat style is picked (or the explicit
          styleId), and the beat is rendered at EXACTLY the song's BPM.
       3. Strict auto-mix (radio-ready, no mixer needed):
            vocals -> -18 dBFS RMS (0.126)
            beat    -> -18 dBFS RMS (0.126)
            vocals  x 10^(3/20) = 1.4125  (+3 dB: vocals sit above the beat bed)
            sum, equal-power fade in/out (click-free), hard peak limit 0.98
       4. The final buffer is RETURNED. No autoplay — the caller (W2 UI)
          decides about preview/export.

     ±3 BPM TOLERANCE LOGIC: the beat is ALWAYS rendered at the exact
     detected song BPM (renderBeat(styleId, exactBpm, bars)), so there is
     NO tempo mismatch by construction — drums have no pitch, only time
     matters, and the time is identical. Style SELECTION is nearest-BPM:
     Auto mode picks the style whose native BPM is closest to the song's.
     A style's pattern stays musical at any nearby BPM because the
     pattern is time-scaled, never pitch-shifted.

     API: buildAuto(song1Buffer, styleId, onProgress, onStep)
            -> Promise<{ buffer, meta }>
       song1Buffer : decoded AudioBuffer. Null/invalid -> clean rejection.
       styleId     : explicit style id, or null/undefined for Auto.
                     Unknown styleId -> Auto fallback + honest note.
       onProgress  : fn(label, frac 0..1) — same style as build().
       onStep(step, info) : UI step indicator; step is one of
                     'vocals' -> 'beat' -> 'mix' -> 'done'.
                     Every step yields a macrotask first so the browser
                     can paint before the heavy DSP runs.
       meta = { bpm, bpmFallback, bpmNote, styleId, styleName, styleAuto,
                engineTagVocal, durationSec }

     Fallbacks: null song -> graceful reject; BPM detect fail/junk ->
     100 BPM + honest note; unknown styleId -> Auto + note; nearest-BPM
     tie -> hiphop over lofi (AUTO_TIEBREAK).

     Dependencies: audio-engine.js, mashup-dsp.js, stems.js (same as
     build()), PLUS W1's beats.js (RM.Beats.STYLES + renderBeat) — checked
     at CALL time so beats.js may land later. build() never requires it.
     ===================================================================== */
  var AUTO_VOCAL_RMS = 0.126;   // -18 dBFS — vocal reference level
  var AUTO_BEAT_RMS = 0.126;    // -18 dBFS — beat reference level
  var AUTO_VOCAL_BOOST_DB = 3;  // +3 dB: vocals sit above the beat bed
  var AUTO_VOCAL_BOOST = Math.pow(10, AUTO_VOCAL_BOOST_DB / 20); // 1.4125
  var AUTO_LOOP_BARS = 4;       // short loop-perfect render, tiled across
                                // the song — memory sane even for a 10-min
                                // song (a few MB, not 200+)
  var AUTO_BPM_FALLBACK = 100;  // when tempo detection fails
  var AUTO_TIEBREAK = ['hiphop', 'lofi']; // nearest-BPM tie: hiphop first

  function checkBeatDeps() {
    var beats = RM.Beats;
    if (!beats || typeof beats.renderBeat !== 'function' || !beats.STYLES)
      throw new Error('Beat engine not ready — beats.js (RM.Beats.STYLES + renderBeat) must load before buildAuto runs.');
    return beats;
  }

  // Calls onStep(step, info), then yields a macrotask so the browser can
  // paint the step indicator before the heavy DSP runs. Never throws.
  function autoStep(onStepCb, name, info) {
    try {
      if (typeof onStepCb === 'function') onStepCb(name, info);
    } catch (e) { /* UI callback must never break the pipeline */ }
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  // Normalizes RM.Beats.STYLES (object map OR array) to [{id, style}].
  function autoStyleList(styles) {
    var out = [];
    if (Array.isArray(styles)) {
      styles.forEach(function (s, i) {
        if (s) out.push({ id: (s.id != null ? String(s.id) : String(i)), style: s });
      });
    } else if (styles && typeof styles === 'object') {
      Object.keys(styles).forEach(function (k) {
        if (styles[k]) out.push({ id: k, style: styles[k] });
      });
    }
    return out;
  }

  function autoStyleName(entry) {
    if (!entry) return 'Unknown';
    var s = entry.style || {};
    return String(s.name || s.title || entry.id || 'Unknown');
  }

  // Explicit styleId wins (matched against id, s.id, s.name, s.title).
  // Auto: minimum |songBpm - style.bpm|; tie -> AUTO_TIEBREAK order.
  function pickAutoStyle(beats, songBpm, styleId) {
    var list = autoStyleList(beats.STYLES);
    if (!list.length)
      throw new Error('RM.Beats.STYLES is empty — no beat styles to choose from.');
    var want = (styleId != null) ? String(styleId).trim().toLowerCase() : '';
    if (want) {
      for (var i = 0; i < list.length; i++) {
        var s = list[i].style || {};
        var cands = [list[i].id, s.id, s.name, s.title];
        for (var j = 0; j < cands.length; j++) {
          if (cands[j] != null && String(cands[j]).trim().toLowerCase() === want)
            return { entry: list[i], auto: false, note: '' };
        }
      }
      // Unknown styleId -> honest Auto fallback, never a crash.
    }
    var best = null, bestDiff = Infinity, ties = [];
    list.forEach(function (e) {
      var b = Number(e.style && e.style.bpm);
      if (!isFinite(b) || b <= 0) return;
      var d = Math.abs(songBpm - b);
      if (d < bestDiff - 1e-9) { bestDiff = d; best = e; ties = [e]; }
      else if (Math.abs(d - bestDiff) < 1e-9) ties.push(e);
    });
    if (!best) best = list[0]; // degenerate: none had a numeric bpm
    if (ties.length > 1) {
      var tiedIds = {};
      ties.forEach(function (e) { tiedIds[String(e.id).toLowerCase()] = e; });
      for (var k = 0; k < AUTO_TIEBREAK.length; k++) {
        var hit = tiedIds[AUTO_TIEBREAK[k]];
        if (hit) { best = hit; break; }
      }
    }
    var note = want
      ? ('Style "' + styleId + '" not found — picked the nearest style automatically.')
      : '';
    return { entry: best, auto: true, note: note };
  }

  // Renders AUTO_LOOP_BARS at the EXACT song BPM (time-scaled pattern,
  // never pitch-shifted — drums have no pitch to shift), resamples to the
  // song's rate, then tiles sample-exact across the song length. W1's
  // render is loop-perfect (integral bars), so every tile boundary is a
  // downbeat and the join is seamless — no WSOLA needed for the beat.
  function renderBeatTiledAuto(beats, entry, bpm, songLen, sr) {
    return Promise.resolve()
      .then(function () {
        return Promise.resolve(beats.renderBeat(entry.id, bpm, AUTO_LOOP_BARS));
      })
      .then(function (buf) {
        if (!isAudioBuffer(buf))
          throw new Error('Beat render returned no audio.');
        if (buf.sampleRate === sr) return buf;
        return RM.audio.resampleBuffer(buf, sr);
      })
      .then(function (loopBuf) {
        if (!isAudioBuffer(loopBuf) || !loopBuf.length)
          throw new Error('Beat render returned no audio.');
        var period = loopBuf.length; // one loop-perfect period
        var ctx = RM.audio.ensureCtx();
        var out = ctx.createBuffer(2, songLen, sr);
        var nCh = loopBuf.numberOfChannels;
        for (var c = 0; c < 2; c++) {
          var src = loopBuf.getChannelData(Math.min(c, nCh - 1));
          var dst = out.getChannelData(c);
          for (var i = 0; i < songLen; i++) dst[i] = src[i % period];
        }
        return out;
      });
  }

  // Strict auto-mix:
  //   1. vocals -> -18 dBFS RMS (normalizeToRms, peak-limited 0.98)
  //   2. beat    -> -18 dBFS RMS (normalizeToRms, peak-limited 0.98)
  //   3. vocals x 1.4125 (+3 dB over the beat bed)
  //   4. sum, equal-power fade in/out (click-free ends),
  //      hardPeakLimit (the EXISTING limiter) — never clips.
  function autoMixBuffers(dsp, vocalBuf, beatBuf) {
    var sr = vocalBuf.sampleRate;
    var len = Math.min(vocalBuf.length, beatBuf.length);
    if (!len || len < 8)
      throw new Error('Auto-mix is too short — one of the tracks has no audio.');
    var v = dsp.normalizeToRms(vocalBuf, AUTO_VOCAL_RMS);
    var b = dsp.normalizeToRms(beatBuf, AUTO_BEAT_RMS);
    if (!isAudioBuffer(v)) v = vocalBuf; // tolerant: allow in-place
    if (!isAudioBuffer(b)) b = beatBuf;
    var ctx = RM.audio.ensureCtx();
    var mix = ctx.createBuffer(2, len, sr);
    var vc = v.numberOfChannels, bc = b.numberOfChannels;
    for (var c = 0; c < 2; c++) {
      var vd = v.getChannelData(Math.min(c, vc - 1));
      var bd = b.getChannelData(Math.min(c, bc - 1));
      var md = mix.getChannelData(c);
      for (var i = 0; i < len; i++)
        md[i] = bd[i] + vd[i] * AUTO_VOCAL_BOOST;
    }
    dsp.fadeInOut(mix, FADE_SEC);
    hardPeakLimit(mix); // existing limiter: hard ceiling 0.98
    return mix;
  }

  function buildAuto(song1Buffer, styleId, onProgress, onStepCb) {
    var dsp;
    var beats;
    try {
      dsp = checkDeps();      // audio-engine + mashup-dsp + RM.stems (reused)
      beats = checkBeatDeps(); // W1's RM.Beats — buildAuto-only requirement
    } catch (e) {
      return Promise.reject(e);
    }
    if (!isAudioBuffer(song1Buffer))
      return Promise.reject(new Error(
        'Auto Mashup needs a song — the track is missing or invalid. Pick a song first.'));

    var song1 = song1Buffer;
    var songLen = song1.length, sr = song1.sampleRate;

    var lastFrac = -1;
    var prog = function (label, frac) {
      try {
        if (onProgress) {
          var f = Math.max(0, Math.min(1, frac));
          if (f < lastFrac) f = lastFrac; // never move the bar backwards
          lastFrac = f;
          onProgress(label, f);
        }
      } catch (e) { /* never break the pipeline */ }
    };

    var vocalBuf = null, tagV = 'smart DSP';
    var songBpm = AUTO_BPM_FALLBACK, bpmFallback = false, bpmNote = '';
    var picked = null, beatBuf = null, outBuf = null;

    var chain = Promise.resolve();

    /* ---- Step 1: Extracting vocals… (automatic isolation) ---- */
    chain = chain
      .then(function () {
        return autoStep(onStepCb, 'vocals', { label: 'Extracting vocals…' });
      })
      .then(function () {
        prog('Extracting vocals…', 0.01);
        return stemsProvider(song1, 'vocal', function (q) {
          prog('Extracting vocals…', 0.01 + q * 0.33);
        });
      })
      .then(function (res) {
        if (!res || !isAudioBuffer(res.buffer))
          throw new Error('Vocal isolation returned no audio.');
        vocalBuf = res.buffer;
        tagV = res.tag || tagV;
        prog('Extracting vocals…', 0.35);
      })
      .catch(function (e) {
        if (/^Vocal isolation returned no audio\./.test(e.message)) throw e;
        throw new Error('Vocal isolation failed: ' + (e && e.message ? e.message : e));
      });

    /* ---- Step 2: Creating beat… (BPM detect + style + render) ---- */
    chain = chain
      .then(function () {
        return autoStep(onStepCb, 'beat', { label: 'Creating beat…' });
      })
      .then(function () {
        prog('Creating beat…', 0.36);
        return Promise.resolve().then(function () {
          return RM.audio.detectBPM(song1, function (q) {
            prog('Creating beat…', 0.36 + q * 0.12);
          });
        });
      })
      .then(function (detected) {
        var b = Number(detected);
        if (!isFinite(b) || b < 50 || b > 220) {
          // BPM detect failed -> honest fallback, never sold as detected.
          bpmFallback = true;
          songBpm = AUTO_BPM_FALLBACK;
          bpmNote = 'Tempo detection failed — using 100 BPM fallback.';
        } else {
          songBpm = b;
        }
        prog('Creating beat…', 0.50);
      })
      .catch(function () {
        bpmFallback = true;
        songBpm = AUTO_BPM_FALLBACK;
        bpmNote = 'Tempo detection failed — using 100 BPM fallback.';
        prog('Creating beat…', 0.50);
      })
      .then(function () {
        // Nearest-style selection; the beat is ALWAYS rendered at the
        // exact song BPM — no ±3 mismatch possible (see header note).
        picked = pickAutoStyle(beats, songBpm, styleId);
        if (bpmNote && picked.note) bpmNote += ' ' + picked.note;
        else if (picked.note) bpmNote = picked.note;
        return renderBeatTiledAuto(beats, picked.entry, songBpm, songLen, sr);
      })
      .then(function (bb) {
        beatBuf = bb;
        prog('Creating beat…', 0.70);
      });

    /* ---- Step 3: Mixing… (strict auto-mix) ---- */
    chain = chain
      .then(function () {
        return autoStep(onStepCb, 'mix', { label: 'Mixing…' });
      })
      .then(function () {
        prog('Mixing…', 0.72);
        outBuf = autoMixBuffers(dsp, vocalBuf, beatBuf);
        prog('Mixing…', 0.98);
      });

    /* ---- done: return the buffer, NEVER autoplay ---- */
    return chain
      .then(function () {
        return autoStep(onStepCb, 'done', { label: 'Done' });
      })
      .then(function () {
        prog('Done', 1);
        return {
          buffer: outBuf,
          meta: {
            bpm: Math.round(songBpm * 10) / 10,
            bpmFallback: bpmFallback,
            bpmNote: bpmNote,
            styleId: picked.entry.id,
            styleName: autoStyleName(picked.entry),
            styleAuto: picked.auto,
            engineTagVocal: tagV,
            durationSec: Math.round(outBuf.duration * 10) / 10,
          },
        };
      });
  }

  return {
    build: build,
    buildAuto: buildAuto,
    setStemsProvider: setStemsProvider,
    resetStemsProvider: resetStemsProvider,
    getStemsProvider: getStemsProvider,
  };
})();
