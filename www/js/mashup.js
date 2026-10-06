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

    /* ---- Stage 3: Matching tempo… (stretch the BEAT to the target) ---- */
    chain = chain.then(function () {
      prog('Matching tempo…', 0.46);
      var p;
      try { p = dsp.timeStretch(instrBuf, tempo.stretchRatio); }
      catch (e) { throw new Error('Tempo matching failed: ' + (e && e.message ? e.message : e)); }
      return Promise.resolve(p).then(function (stretched) {
        if (!isAudioBuffer(stretched)) throw new Error('Tempo matching returned no audio.');
        instrBuf = stretched;
        prog('Matching tempo…', 0.58);
      }, function (e) {
        throw new Error('Tempo matching failed: ' + (e && e.message ? e.message : e));
      });
    });

    /* ---- Stage 4: Matching key… ---- */
    var key1 = 'Unknown', key2 = 'Unknown', semitones = 0;
    chain = chain.then(function () {
      prog('Matching key…', 0.60);
      var p1, p2;
      try {
        p1 = dsp.detectKey(vocalBuf);
        p2 = dsp.detectKey(instrBuf);
      } catch (e) { throw new Error('Key matching failed: ' + (e && e.message ? e.message : e)); }
      return Promise.all([Promise.resolve(p1), Promise.resolve(p2)]).then(function (keys) {
        key1 = keyLabel(keys[0]); key2 = keyLabel(keys[1]);
        prog('Matching key…', 0.66);
        if (keys[0] && keys[1]) {
          var st;
          try { st = dsp.semitonesBetween(keys[0], keys[1]); }
          catch (e) { throw new Error('Key matching failed: ' + (e && e.message ? e.message : e)); }
          if (!isFinite(st)) st = 0;
          // Clamp to ±1 octave: beyond that a pitch-shift sounds unnatural,
          // so we cap it instead of producing a chipmunk effect.
          semitones = Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, Math.round(st)));
        }
        if (semitones !== 0) {
          var pp;
          try { pp = dsp.pitchShift(instrBuf, semitones); }
          catch (e) { throw new Error('Key matching failed: ' + (e && e.message ? e.message : e)); }
          return Promise.resolve(pp).then(function (shifted) {
            if (isAudioBuffer(shifted)) instrBuf = shifted;
            prog('Matching key…', 0.70);
          }, function (e) {
            throw new Error('Key matching failed: ' + (e && e.message ? e.message : e));
          });
        }
        prog('Matching key…', 0.70);
      }, function (e) {
        throw new Error('Key matching failed: ' + (e && e.message ? e.message : e));
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

  return {
    build: build,
    setStemsProvider: setStemsProvider,
    resetStemsProvider: resetStemsProvider,
    getStemsProvider: getStemsProvider,
  };
})();
