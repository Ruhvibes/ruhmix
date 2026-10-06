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
  var MIX_GAIN_VOCAL_OVER_BED_DB = 3;   // active singer +3 dB over bed
  var GUARD_HIGH = 1.6;           // ratio = bpm1/bpm2; above this, target bpm1/2
  var GUARD_LOW = 0.625;          // below this, target bpm1*2
  var MAX_SEMITONES = 12;         // pitch-shift clamp: one octave max

  var DSP_FNS = ['detectKey', 'timeStretch', 'pitchShift',
                 'normalizeToRms', 'semitonesBetween', 'fadeInOut'];
  // NOTE: dsp.rms is used opportunistically (typeof-guarded) for the v21
  // +3 dB balance fix — not in DSP_FNS so older stubs keep working.

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
  // Returns { bpm1, bpm2, targetBpm, stretchRatio } where stretchRatio is the
  // timeStretch ratio (output/input duration): ratio = bpm2/target, because
  // ratio > 1 = longer output (slower tempo). Guarded so the beat never
  // stretches absurdly far from its native tempo:
  //   ratio > 1.6  -> target = bpm1/2 (e.g. 140/80=1.75 -> target 70,
  //                                     stretch = 80/70 = 1.14)
  //   ratio < 0.625 -> target = bpm1*2 (e.g. 80/140=0.57 -> target 160,
  //                                     stretch = 140/160 = 0.875)
  //   else target = bpm1, stretch = bpm2/bpm1 (within [0.625, 1.6]).
  function tempoTarget(bpm1, bpm2) {
    if (!isFinite(bpm1) || bpm1 <= 0) bpm1 = 120;
    if (!isFinite(bpm2) || bpm2 <= 0) bpm2 = 120;
    var ratio = bpm1 / bpm2;
    var target = bpm1;
    if (ratio > GUARD_HIGH) target = bpm1 / 2;
    else if (ratio < GUARD_LOW) target = bpm1 * 2;
    // v23 FIX (was inverted: target/bpm2 stretched the beat the WRONG way —
    // e.g. 128 BPM beat -> 90 target used 0.703 giving 182 BPM instead of 90).
    return { bpm1: bpm1, bpm2: bpm2, targetBpm: target, stretchRatio: bpm2 / target };
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

  // True-peak gain limiter (v24: replaces hardPeakLimit). Measures the true
  // peak at 4x oversampling, then applies one pure gain — never clips, never
  // flat-tops, no waveshaping. The ceiling is a TRUE peak, so post-MP3 decode
  // stays under -1 dBTP. Drop-in, same signature.
  var TP_CEIL = 0.71; // -3 dBTP true-peak ceiling -> post-MP3 decode stays under -1 dBTP
  function truePeak4x(d) {
    var peak = 0, i, a, b, m1, m2, m3;
    for (i = 0; i < d.length; i++) {
      a = Math.abs(d[i]); if (a > peak) peak = a;
      if (i + 1 < d.length) {
        b = Math.abs(d[i + 1]);
        m1 = (a * 3 + b) * 0.25; if (m1 > peak) peak = m1;
        m2 = (a + b) * 0.5;      if (m2 > peak) peak = m2;
        m3 = (a + b * 3) * 0.25; if (m3 > peak) peak = m3;
      }
    }
    return peak;
  }
  function softPeakLimit(buf) {
    var peak = 0, c, d, i, tp;
    for (c = 0; c < buf.numberOfChannels; c++) {
      d = buf.getChannelData(c);
      tp = truePeak4x(d); if (tp > peak) peak = tp;
    }
    if (peak <= TP_CEIL) return peak;
    var g = TP_CEIL / peak;
    for (c = 0; c < buf.numberOfChannels; c++) {
      d = buf.getChannelData(c);
      for (i = 0; i < d.length; i++) d[i] *= g;
    }
    return peak; // pre-limit true peak (mirrors old signature)
  }

  // v24: 1st-order 30 Hz high-pass — runs on the summed mix BEFORE the
  // soft limiter. Removes sub-bass (<40 Hz: ~25% of mix energy) that bottoms
  // out phone speakers, without touching musical bass (>=50 Hz: <1 dB).
  function highPass30(d, sr) {
    var rc = 1 / (2 * Math.PI * 30), dt = 1 / sr, a = rc / (rc + dt), y = 0, p = 0, x;
    for (var i = 0; i < d.length; i++) { x = d[i]; y = a * (y + x - p); p = x; d[i] = y; }
  }

  /* =====================================================================
     v22 PRO MIX — radio-ready auto mashup (DSP mixing techniques only,
     never labeled "AI"):
       1. Arrangement: 4-bar beat intro (no vocals) -> vocals -> 4-bar
          beat outro. No abrupt start; smooth fades everywhere.
       2. Sidechain ducking: a vocal envelope follower ducks the beat up
          to -3 dB while the vocal sings (10 ms attack / 250 ms release —
          subtle, never pumping).
       3. Vocal glue: small-room reverb (15% wet) + subtle dotted-8th
          feedback delay on the vocals so they sit IN the beat.
       4. Master polish: gentle 2:1 bus compression (slow 30 ms attack)
          -> 30 Hz high-pass -> v24 true-peak limiter (0.71 = -3 dBTP).
          Loud and clean, never harsh.
       5. Pro transitions: 1-bar mix fade-in, 2-bar outro fade-out,
          0.5 s vocal entry / 0.8 s vocal exit fades — click-free.
     ===================================================================== */
  var PRO_INTRO_BARS = 4;
  var PRO_OUTRO_BARS = 4;
  var PRO_DUCK_MAX_DB = 3;
  var PRO_DUCK_ATTACK_SEC = 0.010;
  var PRO_DUCK_RELEASE_SEC = 0.250;
  var PRO_DUCK_PEAKHOLD_SEC = 2.0;   // slow peak tracker: self-calibrating
  var PRO_VERB_WET = 0.15;           // 15% wet small-room
  var PRO_DELAY_WET = 0.12;          // subtle delay
  var PRO_DELAY_FB = 0.28;
  var PRO_DELAY_LP_HZ = 2800;        // darkens repeats: sits behind vocal
  var PRO_COMP_RATIO = 2;            // gentle 2:1
  var PRO_COMP_THRESH_DB = -12;
  var PRO_COMP_ATTACK_SEC = 0.030;   // slow attack: transients breathe
  var PRO_COMP_RELEASE_SEC = 0.200;
  var PRO_VOCAL_IN_SEC = 0.5;
  var PRO_VOCAL_OUT_SEC = 0.8;

  // Peak envelope follower with independent attack/release. Returns Float32Array.
  function proEnvelope(x, sr, attackSec, releaseSec) {
    var n = x.length;
    var env = new Float32Array(n);
    var aA = 1 - Math.exp(-1 / (Math.max(1e-4, attackSec) * sr));
    var aR = 1 - Math.exp(-1 / (Math.max(1e-4, releaseSec) * sr));
    var e = 0;
    for (var i = 0; i < n; i++) {
      var v = x[i] < 0 ? -x[i] : x[i];
      var c = v > e ? aA : aR;
      e += c * (v - e);
      env[i] = e;
    }
    return env;
  }

  // Small-room glue reverb (wet only): 4 early-reflection taps + 2 feedback
  // combs. O(n), no convolution — tuned short (small room, not a hall).
  function proRoomWet(x, sr) {
    var n = x.length;
    var erD = [0.013, 0.023, 0.037, 0.053].map(function (t) {
      return Math.max(1, Math.round(t * sr));
    });
    var erG = [0.42, 0.31, 0.22, 0.15];
    var cD = [Math.max(1, Math.round(0.067 * sr)), Math.max(1, Math.round(0.089 * sr))];
    var cFb = [0.55, 0.50];
    var cBuf = [new Float32Array(cD[0]), new Float32Array(cD[1])];
    var cPos = [0, 0];
    var wet = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var xi = x[i];
      var er = 0;
      for (var t = 0; t < 4; t++) {
        var j = i - erD[t];
        if (j >= 0) er += erG[t] * x[j];
      }
      var late = 0;
      for (var k = 0; k < 2; k++) {
        var D = cD[k], p = cPos[k], buf = cBuf[k];
        var y = xi + cFb[k] * buf[p];
        buf[p] = y;
        cPos[k] = (p + 1) % D;
        late += y;
      }
      wet[i] = er * 0.5 + late * 0.25;
    }
    return wet;
  }

  // Subtle feedback delay (wet only) with a darkened feedback loop so
  // repeats sit behind the vocal instead of competing with it.
  function proDelayWet(x, sr, delaySec) {
    var n = x.length;
    var D = Math.max(1, Math.round(delaySec * sr));
    var line = new Float32Array(D);
    var wet = new Float32Array(n);
    var p = 0, lpS = 0;
    var a = 1 - Math.exp(-2 * Math.PI * PRO_DELAY_LP_HZ / sr);
    for (var i = 0; i < n; i++) {
      var dOut = line[p];
      wet[i] = dOut;
      var fb = x[i] + PRO_DELAY_FB * dOut;
      lpS += a * (fb - lpS);
      line[p] = lpS;
      p++;
      if (p >= D) p = 0;
    }
    return wet;
  }

  function proRmsArr(d) {
    var s = 0;
    for (var i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, d.length));
  }

  // Sidechain gain curve for the beat: 1 (no vocal) -> 10^(-3/20) (full
  // vocal). Envelope is peak-normalized by a slow (2 s) peak tracker so the
  // ducking self-calibrates to the vocal level; the squared curve keeps it
  // subtle rather than pumping.
  function proDuckCurve(vocalMono, sr) {
    var n = vocalMono.length;
    var env = proEnvelope(vocalMono, sr, PRO_DUCK_ATTACK_SEC, PRO_DUCK_RELEASE_SEC);
    var gain = new Float32Array(n);
    var pk = 0;
    var relPk = 1 - Math.exp(-1 / (PRO_DUCK_PEAKHOLD_SEC * sr));
    var duckLin = Math.pow(10, -PRO_DUCK_MAX_DB / 20); // 0.708
    for (var i = 0; i < n; i++) {
      var e = env[i];
      if (e > pk) pk = e;
      else pk += relPk * (e - pk);
      var amt = pk > 1e-6 ? e / pk : 0;
      if (amt > 1) amt = 1;
      amt = amt * amt;
      gain[i] = 1 - (1 - duckLin) * amt;
    }
    return gain;
  }

  // Gentle feedforward bus compressor, in-place on stereo channel arrays.
  // Detector follows the louder channel; slow attack lets transients through.
  function proBusCompress(chL, chR, sr) {
    var n = chL.length;
    var thr = Math.pow(10, PRO_COMP_THRESH_DB / 20);
    var aA = 1 - Math.exp(-1 / (PRO_COMP_ATTACK_SEC * sr));
    var aR = 1 - Math.exp(-1 / (PRO_COMP_RELEASE_SEC * sr));
    var env = 0;
    var inv = 1 - 1 / PRO_COMP_RATIO; // 0.5 for 2:1
    for (var i = 0; i < n; i++) {
      var aL = chL[i] < 0 ? -chL[i] : chL[i];
      var aR = chR[i] < 0 ? -chR[i] : chR[i];
      var det = aL > aR ? aL : aR;
      var c = det > env ? aA : aR;
      env += c * (det - env);
      var g = 1;
      if (env > thr && env > 1e-9) {
        var overDb = 20 * Math.log10(env / thr);
        g = Math.pow(10, -(overDb * inv) / 20);
      }
      chL[i] *= g;
      chR[i] *= g;
    }
  }

  // Linear fade on d[start .. start+len): dirIn=true fades 0->1, else 1->0.
  function proFade(d, start, len, dirIn) {
    var n = d.length;
    var L = Math.max(0, Math.min(len, n - start));
    for (var i = 0; i < L; i++) {
      var f = (i + 1) / len;
      d[start + i] *= dirIn ? f : (1 - f);
    }
  }

  // v22 PRO auto-mix. Replaces the flat autoMixBuffers for buildAuto:
  // arrangement (4-bar intro/outro) + sidechain ducking + vocal glue
  // (reverb+delay) + gentle bus compression + existing hard limiter.
  // Same +3 dB vocal-over-bed spec as v21 (re-locked after the glue stage).
  // Returns Promise<AudioBuffer>. Yields between phases (v21 pattern).
  function proMixAuto(dsp, vocalBuf, beatBufLong, songLen, introLen, outroLen, songBpm, onTick) {
    var sr = vocalBuf.sampleRate;
    var totalLen = introLen + songLen + outroLen;
    if (!totalLen || totalLen < 8)
      return Promise.reject(new Error('Auto-mix is too short — one of the tracks has no audio.'));
    function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }
    var b, v, vTarget, vocalTrack, mix;
    var barLen = Math.max(1, Math.round((240 / songBpm) * sr)); // 1 bar in samples
    return Promise.resolve()
      .then(function () {
        // 1. Balance (v21 spec): beat -> -18 dBFS; vocal -> beat_achieved x 1.4125.
        throwIfCancelled();
        b = dsp.normalizeToRms(beatBufLong, AUTO_BEAT_RMS);
        var bRms = (typeof dsp.rms === 'function') ? dsp.rms(b) : 0;
        vTarget = bRms > 1e-9 ? bRms * AUTO_VOCAL_BOOST : AUTO_VOCAL_RMS;
        v = dsp.normalizeToRms(vocalBuf, vTarget);
        if (!isAudioBuffer(v)) v = vocalBuf;
        if (!isAudioBuffer(b)) b = beatBufLong;
        if (typeof onTick === 'function') { try { onTick(0.74); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 2. Vocal glue: subtle dotted-8th delay + small-room reverb, then
        // re-lock the +3 dB spec (wet energy would otherwise shift it).
        throwIfCancelled();
        var delaySec = 45 / songBpm; // dotted 8th
        var vCh = v.numberOfChannels;
        for (var c = 0; c < vCh; c++) {
          var dry = v.getChannelData(c);
          var dWet = proDelayWet(dry, sr, delaySec);
          var rWet = proRoomWet(dry, sr);
          var rDry = proRmsArr(dry) || 1;
          var rD = proRmsArr(dWet) || 1, rR = proRmsArr(rWet) || 1;
          var gD = PRO_DELAY_WET * (rDry / rD), gR = PRO_VERB_WET * (rDry / rR);
          for (var i = 0; i < dry.length; i++)
            dry[i] = dry[i] + gD * dWet[i] + gR * rWet[i];
        }
        v = dsp.normalizeToRms(v, vTarget);
        if (!isAudioBuffer(v)) v = vocalBuf;
        if (typeof onTick === 'function') { try { onTick(0.80); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 3. Timeline: vocal track starts after the 4-bar beat intro, with
        // smooth entry/exit fades (no hard vocal cuts).
        throwIfCancelled();
        var ctx = RM.audio.ensureCtx();
        vocalTrack = ctx.createBuffer(2, totalLen, sr);
        mix = ctx.createBuffer(2, totalLen, sr);
        var vCh = v.numberOfChannels;
        var inN = Math.max(1, Math.min(Math.round(PRO_VOCAL_IN_SEC * sr), songLen));
        var outN = Math.max(1, Math.min(Math.round(PRO_VOCAL_OUT_SEC * sr), songLen));
        for (var c = 0; c < 2; c++) {
          var vd = v.getChannelData(Math.min(c, vCh - 1));
          var td = vocalTrack.getChannelData(c);
          for (var i = 0; i < songLen; i++) {
            var f = 1;
            if (i < inN) f = (i + 1) / inN;
            var ri = songLen - 1 - i;
            if (ri < outN && (ri + 1) / outN < f) f = (ri + 1) / outN;
            td[introLen + i] = vd[i] * f;
          }
        }
        if (typeof onTick === 'function') { try { onTick(0.85); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 4. Sidechain: vocal envelope ducks the beat up to -3 dB.
        throwIfCancelled();
        var t0 = vocalTrack.getChannelData(0), t1 = vocalTrack.getChannelData(1);
        var mono = new Float32Array(totalLen);
        for (var i = 0; i < totalLen; i++) mono[i] = (t0[i] + t1[i]) * 0.5;
        var curve = proDuckCurve(mono, sr);
        var bCh = b.numberOfChannels;
        for (var c = 0; c < 2; c++) {
          var bd = b.getChannelData(Math.min(c, bCh - 1));
          var n = Math.min(bd.length, totalLen);
          for (var j = 0; j < n; j++) bd[j] *= curve[j];
        }
        if (typeof onTick === 'function') { try { onTick(0.89); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 5. Sum + arrangement fades (1-bar in, 2-bar outro out).
        throwIfCancelled();
        var bCh = b.numberOfChannels;
        for (var c = 0; c < 2; c++) {
          var bd = b.getChannelData(Math.min(c, bCh - 1));
          var td = vocalTrack.getChannelData(c);
          var md = mix.getChannelData(c);
          for (var i = 0; i < totalLen; i++) md[i] = bd[i] + td[i];
          proFade(md, 0, Math.min(barLen, totalLen), true);
          proFade(md, Math.max(0, totalLen - 2 * barLen), Math.min(2 * barLen, totalLen), false);
        }
        if (typeof onTick === 'function') { try { onTick(0.93); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 6. Master: gentle 2:1 bus compression, 30 Hz high-pass, then the
        // v24 soft limiter (TP_CEIL 0.79 = -2 dBFS sample ceiling: MP3 decode never hits 0 dBFS).
        throwIfCancelled();
        proBusCompress(mix.getChannelData(0), mix.getChannelData(1), sr);
        highPass30(mix.getChannelData(0), sr);
        highPass30(mix.getChannelData(1), sr);
        softPeakLimit(mix);
        return mix;
      });
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
        // v21 ROOT FIX (same root cause as autoMixBuffers): the bed often
        // can't reach TARGET_RMS (peak cap on high-crest audio), which left
        // vocals hotter than the intended +3 dB. Normalize the vocal to the
        // bed's ACHIEVED rms — mixBuffers() adds the +3 dB vocal lift.
        q2 = dsp.normalizeToRms(instrBuf, TARGET_RMS);
        var bedRms = (typeof dsp.rms === 'function') ? dsp.rms(q2) : 0;
        q1 = dsp.normalizeToRms(vocalBuf, bedRms > 1e-9 ? bedRms : TARGET_RMS);
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
        highPass30(mix.getChannelData(0), mix.sampleRate);
        if (mix.numberOfChannels > 1) highPass30(mix.getChannelData(1), mix.sampleRate);
        softPeakLimit(mix); // v24: true-peak gain limiter, TP_CEIL 0.71 (-3 dBTP)
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
       3. v22 PRO mix (radio-ready, no mixer needed — DSP techniques only):
            arrangement: 4-bar beat intro (no vocals) -> vocals ->
            4-bar beat outro, smooth fades everywhere;
            sidechain: vocal envelope ducks the beat up to -3 dB
            (subtle, never pumping);
            vocal glue: small-room reverb (15% wet) + subtle dotted-8th
            delay so vocals sit IN the beat;
            master: gentle 2:1 bus compression (slow attack) -> 30 Hz
            high-pass -> v24 true-peak limit (0.71 = -3 dBTP). Loud and clean.
            Balance spec kept: vocals -> beat_achieved_RMS x 1.4125
            (exactly +3 dB over the bed, re-locked after the glue stage).
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

  // v21: user-friendly text for provider {kind} rejections (hf-stems throws
  // plain {kind} objects, not Errors — stringifying them gave users
  // "Vocal isolation failed: [object Object]").
  function mashupErrText(e) {
    var k = e && e.kind;
    if (k === 'cancelled') return 'Cancelled.';
    if (k === 'timeout') return 'The AI server took too long (timeout). Try a shorter song or try again.';
    if (k === 'connect') return 'Cannot reach the AI server. Check your internet connection.';
    if (k === 'quota') return 'The free AI daily limit seems over (~6-10 songs/day). Try again tomorrow.';
    if (k === 'asleep') return 'The AI server is waking up. Wait a minute and try again.';
    if (k === 'server') return 'The AI server returned an error. Please try again in a bit.';
    if (k === 'empty' || k === 'decode' || k === 'process') return 'AI vocal isolation failed on this song. Try another song.';
    if (k === 'nocfg' || k === 'nopath') return 'AI server not configured.';
    if (e instanceof Error) return e.message || 'Something went wrong.';
    var s = String((e && e.message) || e || 'Something went wrong.');
    return s === '[object Object]' ? 'Something went wrong.' : s;
  }

  // v21: cooperative cancel — throws {kind:'cancelled'} if the user tapped
  // the mashup Cancel button. Called at every pipeline stage boundary.
  function throwIfCancelled() {
    try {
      if (RM.mashupStems && typeof RM.mashupStems.isCancelRequested === 'function' &&
          RM.mashupStems.isCancelRequested()) throw { kind: 'cancelled' };
    } catch (e) {
      if (e && e.kind === 'cancelled') throw e;
    }
  }
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
  // song's rate, then tiles sample-exact across totalLen. W1's
  // render is loop-perfect (integral bars), so every tile boundary is a
  // downbeat and the join is seamless — no WSOLA needed for the beat.
  // totalLen covers the v22 arrangement: 4-bar intro + song + 4-bar outro.
  function renderBeatTiledAuto(beats, entry, bpm, totalLen, sr) {
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
        var out = ctx.createBuffer(2, totalLen, sr);
        var nCh = loopBuf.numberOfChannels;
        for (var c = 0; c < 2; c++) {
          var src = loopBuf.getChannelData(Math.min(c, nCh - 1));
          var dst = out.getChannelData(c);
          for (var i = 0; i < totalLen; i++) dst[i] = src[i % period];
        }
        return out;
      });
  }

  // Strict auto-mix:
  //   1. beat    -> -18 dBFS RMS (normalizeToRms, peak-limited 0.98)
  //   2. vocals -> beat_achieved_RMS x 1.4125 (exactly +3 dB over the bed)
  //   3. sum, equal-power fade in/out (click-free ends),
  //      highPass30 then softPeakLimit (the v24 soft tanh limiter, -1 dBTP)
  //      — never clips.
  //   v21 ROOT FIX: high-crest beats can never reach -18 dBFS — the peak cap
  //   in normalizeToRms pins them at -18.6…-24.9 dBFS, which used to leave
  //   vocals up to +10 dB too hot. The vocal now tracks the beat's ACHIEVED
  //   rms, so the +3 dB balance holds for every style, always.
  //   v21 (W4 MINOR): yields to the browser between phases — the old fully-
  //   sync version froze the progress UI ~1-2 s on phone. Math is identical,
  //   only macrotask yields are interleaved. Returns Promise<AudioBuffer>.

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
    var introLen = 0, outroLen = 0; // v22 arrangement: set in the beat step

    var chain = Promise.resolve();

    /* ---- Step 1: Extracting vocals… (automatic isolation) ---- */
    chain = chain
      .then(function () {
        throwIfCancelled();
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
        // v21: user Cancel must propagate as-is (not wrapped as a failure).
        if (e && e.kind === 'cancelled') throw e;
        if (e && e.message && /^Vocal isolation returned no audio\./.test(e.message)) throw e;
        // v21: {kind} rejections are mapped to friendly text — never
        // "[object Object]" to the user.
        throw new Error('Vocal isolation failed: ' + mashupErrText(e));
      });

    /* ---- Step 2: Creating beat… (BPM detect + style + render) ---- */
    chain = chain
      .then(function () {
        // v21: belt & suspenders — a null vocal must never reach the mixer.
        throwIfCancelled();
        if (!vocalBuf || !isAudioBuffer(vocalBuf))
          throw new Error('Vocal isolation failed: no vocal audio to mix.');
        return autoStep(onStepCb, 'beat', { label: 'Creating beat…' });
      })
      .then(function () {
        prog('Creating beat…', 0.36);
        return Promise.resolve().then(function () {
          return RM.audio.detectBPM(song1, function (q) {
            prog('Creating beat…', 0.36 + q * 0.12);
          });
        }).catch(function () {
          // v21 ROOT FIX: this catch used to sit on the WHOLE chain, so it
          // swallowed step-1 vocal failures and continued with vocalBuf=null
          // (→ cryptic TypeError + lying step indicator). It is now scoped
          // to the detectBPM promise ONLY — tempo-detection failure is the
          // only thing that gets the 100 BPM fallback.
          bpmFallback = true;
          songBpm = AUTO_BPM_FALLBACK;
          bpmNote = 'Tempo detection failed — using 100 BPM fallback.';
          prog('Creating beat…', 0.50);
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
      .then(function () {
        // Nearest-style selection; the beat is ALWAYS rendered at the
        // exact song BPM — no ±3 mismatch possible (see header note).
        // v22: render across the full arrangement (4-bar intro + song +
        // 4-bar outro) — the tiling is loop-perfect so joins are seamless.
        throwIfCancelled();
        picked = pickAutoStyle(beats, songBpm, styleId);
        if (bpmNote && picked.note) bpmNote += ' ' + picked.note;
        else if (picked.note) bpmNote = picked.note;
        var barLen = Math.max(1, Math.round((240 / songBpm) * sr));
        introLen = PRO_INTRO_BARS * barLen;
        outroLen = PRO_OUTRO_BARS * barLen;
        return renderBeatTiledAuto(beats, picked.entry, songBpm, introLen + songLen + outroLen, sr);
      })
      .then(function (bb) {
        beatBuf = bb;
        prog('Creating beat…', 0.70);
      });

    /* ---- Step 3: Mixing… (v22 PRO mix) ---- */
    chain = chain
      .then(function () {
        throwIfCancelled();
        return autoStep(onStepCb, 'mix', { label: 'Mixing…' });
      })
      .then(function () {
        prog('Mixing…', 0.72);
        // v22: proMixAuto — arrangement + sidechain + glue + bus comp.
        // autoMixBuffers (flat mix) is retired for buildAuto.
        return proMixAuto(dsp, vocalBuf, beatBuf, songLen, introLen, outroLen, songBpm, function (f) {
          prog('Mixing…', 0.72 + f * 0.26);
        });
      })
      .then(function (mixed) {
        outBuf = mixed;
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
            proMix: true, // v22: arrangement + sidechain + glue + bus comp (DSP)
            introBars: PRO_INTRO_BARS,
            outroBars: PRO_OUTRO_BARS,
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
