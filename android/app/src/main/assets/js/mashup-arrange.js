'use strict';
/* =====================================================================
   RuhMix — mashup-arrange.js
   Rotation arrangement + pro polish (v23 — Worker 3).

   Builds the multi-song rotation timeline:
     intro (beat only, 4 bars)
       → cycles × [each vocal 8 bars, 1-bar equal-power crossfade
          between vocals]
       → outro (beat only, 4 bars)
   with the beat tiled underneath the whole time for cohesion.

   Crossfade design (fixed 8-bar grid — the codebase has no downbeat
   detection, so the grid is the spec): slots sit back-to-back, 8 bars
   each — the crossfade NEVER adds time. At every slot boundary the
   crossfade is `xfadeBars` long (caller-configurable; swap and mega pass
   0.5 — v23's tight DJ handoff, 0.25-bar equal-power fade-out + 0.25-bar
   equal-power fade-in — and the code default is 1 bar, 0.5 + 0.5),
   realised as an equal-power fade-out (outgoing vocal) + equal-power
   fade-in (incoming vocal) using the sin/cos equal-power curve family
   of mashup-dsp.js's fadeInOut. Gains hit exact zeros at the boundary —
   click-free. (A true overlapping crossfade is mathematically
   incompatible with the fixed cycles×(N×8)-bar duration: overlapping
   shifts content earlier and shrinks the timeline by one bar per
   transition.)

   Pro polish — the SAME DSP math as mashup.js v22 proMixAuto. Those
   internals are NOT exported on RM.mashup, so they are re-implemented
   here as consistent copies (same constants, same formulas — never a
   divergent duplicate):
     • balance: beat → −18 dBFS RMS; vocals → beat_achieved × 1.4125
       (exactly +3 dB over the bed — the v21 spec), re-locked after glue
     • sidechain: vocal envelope ducks the beat up to −3 dB (10 ms
       attack / 250 ms release, 2 s self-calibrating peak-hold —
       subtle, never pumping). Implemented as the fused equivalent of
       v22's proEnvelope + proDuckCurve (identical recurrence, one
       pass — avoids a full-length gain array on long timelines).
     • vocal glue: small-room reverb (15% wet) + subtle dotted-8th
       feedback delay, applied to the placed rotation so reverb tails
       cross the transitions — then the +3 dB balance is re-locked
     • master: gentle 2:1 bus compression (slow 30 ms attack) → 30 Hz
       high-pass → v24 true-peak limiter (0.71 = -3 dBTP) — loud and clean
     • arrangement fades: 1-bar fade-in, 2-bar fade-out (v22 shape)

   Duration (samples) = (introBars + cycles × N × barsPerVocal +
   outroBars) × barLen,  barLen = round(240 / masterBpm × sampleRate).

   API:
     RM.mashupArrange.buildTimeline(o) → Promise<{ buffer, meta }>
       o = { vocalSegs: [{ buffer: AudioBuffer, name } | AudioBuffer],
             beatBuf: AudioBuffer,
             masterBpm, sampleRate,
             cycles = 2, barsPerVocal = 8, xfadeBars = 1,
             introBars = 4, outroBars = 4, vocalBoostDb = 3,
             beatDuckDb = [0, -2],  // v24 W4 R3: per-song beat duck (dB)
             onProgress(label, frac), token }
       Also accepts the positional form
       buildTimeline(vocalSegs, beatBuf, opts) with opts aliases
       bpm/sr/segBars (defensive — sibling workers).
       token: optional cancel token — a function returning truthy when
         cancelled, or { isCancelled() } / { throwIfCancelled() } /
         { cancelled: true }. RM.mashupStems.isCancelRequested() is
         honoured too (the v21 cooperative-cancel contract).
       Resolves { buffer: stereo AudioBuffer, meta }. Rejects with a
       friendly Error, or { kind: 'cancelled' } on cancel.
       NO autoplay — it only builds the buffer; the caller decides what
       to play or export.

   Bar-by-bar assembly with macrotask yields (every vocal ≈ 8 bars, and
   inside the long sidechain pass), monotonic onProgress, and
   throwIfCancelled() at every phase boundary.

   Depends on (load BEFORE this file):
     - audio-engine.js → RM.audio.ensureCtx, RM.audio.resampleBuffer
     - mashup-dsp.js   → RM.mashupDSP.normalizeToRms, RM.mashupDSP.rms
   ===================================================================== */
window.RM = window.RM || {};

RM.mashupArrange = (function () {
  /* ---- tunables: identical to mashup.js v22 — do not drift ---- */
  var TARGET_RMS = 0.126;          // ≈ −18 dBFS — beat reference level
  var DUCK_MAX_DB = 3;            // sidechain depth
  var DUCK_ATTACK_SEC = 0.010;
  var DUCK_RELEASE_SEC = 0.250;
  var DUCK_PEAKHOLD_SEC = 2.0;    // slow peak tracker: self-calibrating
  var VERB_WET = 0.15;            // 15% wet small-room
  var DELAY_WET = 0.12;           // subtle dotted-8th delay
  var DELAY_FB = 0.28;
  var DELAY_LP_HZ = 2800;         // darkens repeats: sits behind vocal
  var COMP_RATIO = 2;             // gentle 2:1 bus compression
  var COMP_THRESH_DB = -12;
  var COMP_ATTACK_SEC = 0.030;    // slow attack: transients breathe
  var COMP_RELEASE_SEC = 0.200;
  var VOCAL_IN_SEC = 0.5;         // rotation entry fade (v22 shape)
  var VOCAL_OUT_SEC = 0.8;        // rotation exit fade (v22 shape)
  var MAX_TOTAL_MIN = 20;         // sanity cap on the rendered timeline

  /* ---------------- dependency guard ---------------- */
  function checkDeps() {
    if (!RM.audio || typeof RM.audio.ensureCtx !== 'function')
      throw new Error('Rotation needs audio-engine.js (RM.audio.ensureCtx) — load it before mashup-arrange.js.');
    if (typeof RM.audio.resampleBuffer !== 'function')
      throw new Error('Rotation needs audio-engine.js (RM.audio.resampleBuffer) — load it before mashup-arrange.js.');
    var dsp = RM.mashupDSP;
    if (!dsp || typeof dsp.normalizeToRms !== 'function' || typeof dsp.rms !== 'function')
      throw new Error('mashup-dsp.js not loaded (needs normalizeToRms + rms) — load it before mashup-arrange.js.');
    return dsp;
  }

  function isAudioBuffer(b) {
    return !!(b && typeof b.getChannelData === 'function' &&
              typeof b.sampleRate === 'number' && typeof b.length === 'number' &&
              typeof b.numberOfChannels === 'number');
  }

  function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }

  /* ---------------- cooperative cancel (v21 contract) ----------------
     mashup.js throws { kind: 'cancelled' } when
     RM.mashupStems.isCancelRequested() is true — same here. o.token is
     an extra, defensive cancel source (function | {isCancelled()} |
     {throwIfCancelled()} | {cancelled:true}). A broken token never
     breaks the pipeline. */
  function throwIfCancelled(token) {
    var cancelled = false;
    try {
      if (token) {
        if (typeof token === 'function') cancelled = !!token();
        else if (typeof token.isCancelled === 'function') cancelled = !!token.isCancelled();
        else if (typeof token.throwIfCancelled === 'function') token.throwIfCancelled();
        else if (token.cancelled === true) cancelled = true;
      }
      if (!cancelled && RM.mashupStems &&
          typeof RM.mashupStems.isCancelRequested === 'function' &&
          RM.mashupStems.isCancelRequested()) cancelled = true;
    } catch (e) {
      if (e && e.kind === 'cancelled') throw e;
    }
    if (cancelled) throw { kind: 'cancelled' };
  }

  /* =====================================================================
     Pro-polish DSP — consistent copies of mashup.js v22 internals
     (roomWet ← proRoomWet, delayWet ← proDelayWet,
     busCompress ← proBusCompress, softPeakLimit (v24 soft tanh, -1 dBTP),
     linFade ← proFade,
     rmsArr ← proRmsArr). Same constants, same formulas.
     The sidechain in the pipeline is the fused equivalent of v22's
     proEnvelope + proDuckCurve (identical recurrence, single pass).
     ===================================================================== */
  function rmsArr(d) {
    var s = 0;
    for (var i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, d.length));
  }

  // Small-room glue reverb (wet only): 4 early-reflection taps + 2
  // feedback combs. O(n), no convolution — short small room, not a hall.
  function roomWet(x, sr) {
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
  function delayWet(x, sr, delaySec) {
    var n = x.length;
    var D = Math.max(1, Math.round(delaySec * sr));
    var line = new Float32Array(D);
    var wet = new Float32Array(n);
    var p = 0, lpS = 0;
    var a = 1 - Math.exp(-2 * Math.PI * DELAY_LP_HZ / sr);
    for (var i = 0; i < n; i++) {
      var dOut = line[p];
      wet[i] = dOut;
      var fb = x[i] + DELAY_FB * dOut;
      lpS += a * (fb - lpS);
      line[p] = lpS;
      p++;
      if (p >= D) p = 0;
    }
    return wet;
  }

  // Gentle feedforward bus compressor, in-place on stereo channel arrays.
  // Detector follows the louder channel; slow attack lets transients through.
  function busCompress(chL, chR, sr) {
    var n = chL.length;
    var thr = Math.pow(10, COMP_THRESH_DB / 20);
    var aA = 1 - Math.exp(-1 / (COMP_ATTACK_SEC * sr));
    var aR = 1 - Math.exp(-1 / (COMP_RELEASE_SEC * sr));
    var env = 0;
    var inv = 1 - 1 / COMP_RATIO; // 0.5 for 2:1
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

  // v24: 1st-order 30 Hz high-pass on the summed mix BEFORE the soft limiter.
  function highPass30(d, sr) {
    var rc = 1 / (2 * Math.PI * 30), dt = 1 / sr, a = rc / (rc + dt), y = 0, p = 0, x;
    for (var i = 0; i < d.length; i++) { x = d[i]; y = a * (y + x - p); p = x; d[i] = y; }
  }

  // Linear fade on d[start .. start+len): dirIn=true fades 0→1, else 1→0.
  function linFade(d, start, len, dirIn) {
    var n = d.length;
    var L = Math.max(0, Math.min(len, n - start));
    for (var i = 0; i < L; i++) {
      var f = (i + 1) / len;
      d[start + i] *= dirIn ? f : (1 - f);
    }
  }

  /* ---------------- argument normalisation ----------------
     Contract form: buildTimeline(o).
     Defensive positional form: buildTimeline(vocalSegs, beatBuf, opts)
     with opts aliases bpm/sr/segBars (sibling workers). Entries may be
     { buffer, name } or raw AudioBuffers. */
  function normalizeArgs(a, b, c) {
    var o;
    if (a && typeof a === 'object' && !Array.isArray(a) &&
        (a.vocalSegs !== undefined || a.beatBuf !== undefined)) {
      o = a;
    } else {
      var opts = (c && typeof c === 'object') ? c : {};
      o = {
        vocalSegs: a,
        beatBuf: b,
        masterBpm: (opts.masterBpm != null ? opts.masterBpm : opts.bpm),
        sampleRate: (opts.sampleRate != null ? opts.sampleRate : opts.sr),
        cycles: opts.cycles,
        barsPerVocal: (opts.barsPerVocal != null ? opts.barsPerVocal : opts.segBars),
        xfadeBars: opts.xfadeBars,
        introBars: opts.introBars,
        outroBars: opts.outroBars,
        vocalBoostDb: opts.vocalBoostDb,
        onProgress: opts.onProgress,
        token: (opts.token !== undefined ? opts.token : null),
      };
    }
    return o;
  }

  /* ---------------- the arrangement ---------------- */
  function buildTimeline(a, b, c) {
    var dsp;
    try { dsp = checkDeps(); } catch (e) { return Promise.reject(e); }
    var o = normalizeArgs(a, b, c) || {};
    var token = o.token;

    function bad(msg) { return Promise.reject(new Error(msg)); }

    /* ---- friendly validation (sync → clean rejections) ---- */
    var rawSegs = o.vocalSegs;
    if (!Array.isArray(rawSegs) || rawSegs.length === 0)
      return bad('Add at least 2 songs to build the rotation.');
    var N = rawSegs.length;
    var segBufs = [];
    for (var si = 0; si < N; si++) {
      var entry = rawSegs[si];
      var ebuf = (entry && isAudioBuffer(entry.buffer)) ? entry.buffer :
                 (isAudioBuffer(entry) ? entry : null);
      var ename = (entry && typeof entry.name === 'string' && entry.name) ?
                  entry.name : 'Song ' + (si + 1);
      if (!ebuf)
        return bad('"' + ename + '" has no audio — please pick the songs again.');
      segBufs.push(ebuf);
    }
    if (!isAudioBuffer(o.beatBuf))
      return bad('The beat track is missing or invalid.');
    var bpm = Number(o.masterBpm);
    if (!isFinite(bpm) || bpm < 50 || bpm > 220)
      return bad('Tempo looks invalid (' + o.masterBpm + ' BPM) — could not build the rotation.');
    var sr = Number(o.sampleRate);
    if (!isFinite(sr) || sr <= 0) sr = o.beatBuf.sampleRate; // defensive fallback
    function intOpt(v, dflt, min) {
      var n = (v == null) ? dflt : Math.round(Number(v));
      if (!isFinite(n)) n = dflt;
      return Math.max(min, n);
    }
    var cycles = intOpt(o.cycles, 2, 1);
    var barsPerVocal = intOpt(o.barsPerVocal, 8, 1);
    var introBars = intOpt(o.introBars, 4, 0);
    var outroBars = intOpt(o.outroBars, 4, 0);
    var xfadeBars = (o.xfadeBars == null) ? 1 : Math.max(0, Number(o.xfadeBars) || 0);
    var boostDb = Number(o.vocalBoostDb);
    if (!isFinite(boostDb)) boostDb = 3; // v21/v22 spec: +3 dB
    var vocalBoost = Math.pow(10, boostDb / 20); // 1.4125 at +3 dB

    /* v24 W4 R3: per-song beat duck for DSP-fallback vocals (dB per song
       index, 0 = no duck). DSP vocalcut stems are full-center mixes
       (vocal+kick+bass+snare); dipping the beat ~-2 dB under those slots
       keeps the embedded kick from fighting the synth beat — clash down,
       clarity up. Gain automation only: applied to the BEAT, never the
       vocal. Callers pass e.g. [0, -2, 0] when song 2's vocal is DSP. */
    var duckDbArr = Array.isArray(o.beatDuckDb) ? o.beatDuckDb : [];
    var duckGainSong = [];
    for (var di = 0; di < N; di++) {
      var ddb = Number(duckDbArr[di]);
      duckGainSong.push(isFinite(ddb) && ddb < 0 ? Math.pow(10, ddb / 20) : 1);
    }
    var anyDuck = duckGainSong.some(function (x) { return x !== 1; });

    /* ---- geometry: fixed 8-bar grid, bar-aligned boundaries ----
       total = intro + cycles×N×barsPerVocal + outro bars.
       The crossfade (xfadeBars, default 1) = half its length as an
       equal-power fade-out + half as an equal-power fade-in at each slot
       boundary — it overlaps the boundary but never moves it, so xfades
       add no time. */
    var barLen = Math.max(1, Math.round((240 / bpm) * sr)); // samples/bar
    var slotLen = barsPerVocal * barLen;                    // samples/vocal
    var G = cycles * N;                                     // total vocal slots
    var introLen = introBars * barLen;
    var vocalLen = G * slotLen;
    var outroLen = outroBars * barLen;
    var totalLen = introLen + vocalLen + outroLen;
    if (!(totalLen > 0) || totalLen < 8)
      return bad('The rotation is too short — nothing to render.');
    if (totalLen > Math.round(sr * 60 * MAX_TOTAL_MIN))
      return bad('The rotation is too long (over ' + MAX_TOTAL_MIN + ' min) — use fewer songs or cycles.');

    var halfX = Math.round((xfadeBars * barLen) / 2);
    if (halfX <= 0) halfX = Math.max(1, Math.round(0.005 * sr)); // micro-fade: never a hard cut
    halfX = Math.max(1, Math.min(halfX, Math.floor(slotLen / 2)));
    var HALF_PI = Math.PI / 2;

    var lastFrac = -1;
    var prog = function (label, frac) {
      try {
        if (typeof o.onProgress === 'function') {
          var f = Math.max(0, Math.min(1, frac));
          if (f < lastFrac) f = lastFrac; // the bar never moves backwards
          lastFrac = f;
          o.onProgress(label, f);
        }
      } catch (e) { /* UI callback must never break the pipeline */ }
    };

    var ctx = RM.audio.ensureCtx();
    function toRate(buf) {
      if (buf.sampleRate === sr) return Promise.resolve(buf);
      return RM.audio.resampleBuffer(buf, sr).then(function (rb) {
        if (!isAudioBuffer(rb)) throw new Error('Sample-rate conversion failed.');
        return rb;
      });
    }

    var beatRs = null, segRs = [];
    var normSegs = [];   // vocal segs, resampled + normalised to vocalTarget
    var beatTrack = null; // tiled beat → ducked → becomes the mix buffer
    var vocalTrack = null;
    var vocalTarget = TARGET_RMS;

    /* Place vocal slot g (0-based) into its bar-aligned slot. Writes are
       disjoint — no accumulation needed. Content is truncated / zero-
       padded to exactly slotLen. */
    function placeVocal(g) {
      var seg = normSegs[g % N];
      var slotStart = introLen + g * slotLen;
      var nCh = seg.numberOfChannels;
      var inN = Math.min(Math.round(VOCAL_IN_SEC * sr), slotLen);
      var outN = Math.min(Math.round(VOCAL_OUT_SEC * sr), slotLen);
      for (var ch = 0; ch < 2; ch++) {
        var src = seg.getChannelData(Math.min(ch, nCh - 1));
        var dst = vocalTrack.getChannelData(ch);
        var srcLen = src.length;
        for (var i = 0; i < slotLen; i++) {
          var v = i < srcLen ? src[i] : 0;
          var f = 1;
          if (g > 0 && i < halfX) {
            f = Math.sin(HALF_PI * (i + 1) / halfX); // xfade leg: eq-power in
          } else if (g === 0 && i < inN) {
            f = (i + 1) / inN;                        // rotation entry (v22)
          }
          if (g < G - 1 && i >= slotLen - halfX) {
            var k = i - (slotLen - halfX);
            var fo = Math.cos(HALF_PI * (k + 1) / halfX); // xfade leg: eq-power out
            if (fo < f) f = fo;
          } else if (g === G - 1 && i >= slotLen - outN) {
            var k2 = slotLen - 1 - i;
            var fo2 = (k2 + 1) / outN;                // rotation exit (v22)
            if (fo2 < f) f = fo2;
          }
          dst[slotStart + i] = v * f;
        }
      }
    }

    function placeNext(g) {
      throwIfCancelled(token);
      placeVocal(g);
      prog('Placing vocals…', 0.23 + 0.32 * ((g + 1) / G));
      if (g + 1 < G) return tick().then(function () { return placeNext(g + 1); });
      return null;
    }

    var chain = Promise.resolve();

    /* ---- 1. resample inputs to the canonical rate ---- */
    chain = chain.then(function () {
      throwIfCancelled(token);
      prog('Preparing timeline…', 0.02);
      return tick();
    }).then(function () {
      var jobs = [toRate(o.beatBuf)];
      for (var i = 0; i < N; i++) jobs.push(toRate(segBufs[i]));
      return Promise.all(jobs);
    }).then(function (rs) {
      beatRs = rs[0];
      segRs = rs.slice(1);
      segBufs = null;
    });

    /* ---- 2. beat bed: tile across the whole timeline, then balance.
       v21 spec: beat → −18 dBFS; vocal target = beat_achieved × boost. */
    chain = chain.then(function () {
      throwIfCancelled(token);
      prog('Laying down the beat…', 0.06);
      return tick();
    }).then(function () {
      beatTrack = ctx.createBuffer(2, totalLen, sr);
      var period = beatRs.length;
      if (!period) throw new Error('The beat track is empty.');
      var nCh = beatRs.numberOfChannels;
      var src0 = beatRs.getChannelData(0);
      var src1 = beatRs.getChannelData(Math.min(1, nCh - 1));
      var d0 = beatTrack.getChannelData(0), d1 = beatTrack.getChannelData(1);
      for (var i = 0; i < totalLen; i++) {
        var j = i % period;
        d0[i] = src0[j];
        d1[i] = src1[j];
      }
      beatRs = null;
      throwIfCancelled(token);
      beatTrack = dsp.normalizeToRms(beatTrack, TARGET_RMS);
      if (!isAudioBuffer(beatTrack)) throw new Error('Beat balancing failed.');
      var bRms = (typeof dsp.rms === 'function') ? dsp.rms(beatTrack) : 0;
      vocalTarget = bRms > 1e-9 ? bRms * vocalBoost : TARGET_RMS;
      prog('Laying down the beat…', 0.15);
      return tick();
    });

    /* ---- 3. normalise each vocal seg to the +3 dB target ---- */
    chain = chain.then(function () {
      throwIfCancelled(token);
      prog('Balancing vocals…', 0.17);
      return tick();
    }).then(function () {
      for (var i = 0; i < N; i++) {
        throwIfCancelled(token);
        var nb = dsp.normalizeToRms(segRs[i], vocalTarget);
        normSegs.push(isAudioBuffer(nb) ? nb : segRs[i]); // tolerant: in-place
        prog('Balancing vocals…', 0.17 + 0.05 * ((i + 1) / N));
      }
      segRs = null;
      return tick();
    });

    /* ---- 4. place vocals bar-by-bar (yield every vocal ≈ 8 bars) ---- */
    chain = chain.then(function () {
      throwIfCancelled(token);
      vocalTrack = ctx.createBuffer(2, totalLen, sr); // zeros
      prog('Placing vocals…', 0.23);
      return tick();
    }).then(function () {
      return placeNext(0);
    });

    /* ---- 5. vocal glue (v22): dotted-8th delay + small-room reverb per
       channel, then re-lock the +3 dB balance (wet energy shifts it).
       v24 W4 R2: glue is computed PER SLOT, not over the whole track.
       The reverb/delay wet tails (~1 s) used to smear across every
       handoff so briefly BOTH singers were audible ("dono vocal ek
       saath"). Each slot now gets a fresh delay line + reverb state, so
       tails live and die INSIDE their own slot and never leak into the
       next singer's entrance. Pro feel is intact — every slot still gets
       its full dotted-8th + small-room glue. The LAST slot keeps the
       outro in its segment so its tail still rings naturally into the
       beat-only outro. */
    chain = chain.then(function () {
      throwIfCancelled(token);
      prog('Gluing vocals…', 0.57);
      return tick();
    }).then(function () {
      var delaySec = 45 / bpm; // dotted 8th — same as v22
      for (var c = 0; c < 2; c++) {
        throwIfCancelled(token);
        var dry = vocalTrack.getChannelData(c);
        var wetD = new Float32Array(dry.length); // delay wet (per-slot)
        var wetR = new Float32Array(dry.length); // reverb wet (per-slot)
        for (var g = 0; g < G; g++) {
          throwIfCancelled(token);
          var sStart = introLen + g * slotLen;
          // Last slot owns the outro too — its tail rings out naturally.
          var sEnd = (g === G - 1) ? dry.length : introLen + (g + 1) * slotLen;
          var segLen = sEnd - sStart;
          if (segLen > 0) {
            var seg = new Float32Array(segLen);
            seg.set(dry.subarray(sStart, sEnd));
            // Fresh delay/reverb state per slot: tails cannot cross the
            // boundary — they are generated and consumed inside the slot.
            var dW = delayWet(seg, sr, delaySec);
            var rW = roomWet(seg, sr);
            var rDry = rmsArr(seg) || 1;
            var gD = DELAY_WET * (rDry / (rmsArr(dW) || 1));
            var gR = VERB_WET * (rDry / (rmsArr(rW) || 1));
            for (var i = 0; i < segLen; i++) {
              wetD[sStart + i] += gD * dW[i];
              wetR[sStart + i] += gR * rW[i];
            }
            dW = null;
            rW = null;
            seg = null;
          }
          prog('Gluing vocals…', 0.57 + 0.05 * (c + (g + 1) / G));
        }
        for (var j = 0; j < dry.length; j++)
          dry[j] = dry[j] + wetD[j] + wetR[j];
        wetD = null;
        wetR = null;
        prog('Gluing vocals…', 0.57 + 0.05 * (c + 1));
      }
      throwIfCancelled(token);
      vocalTrack = dsp.normalizeToRms(vocalTrack, vocalTarget); // re-lock +3 dB
      if (!isAudioBuffer(vocalTrack)) throw new Error('Vocal glue failed.');
      prog('Gluing vocals…', 0.68);
      return tick();
    });

    /* ---- 6. sidechain + sum.
       The duck gain is the fused equivalent of v22's proEnvelope +
       proDuckCurve (identical recurrence, single pass): the vocal mono
       envelope (10 ms attack / 250 ms release) is peak-normalised by a
       slow 2 s peak tracker, squared (subtle, never pumping), and ducks
       the beat up to −3 dB. The vocal track is summed into the beat
       buffer, which becomes the mix — one less full-length buffer. */
    chain = chain.then(function () {
      throwIfCancelled(token);
      prog('Mixing…', 0.70);
      return tick();
    }).then(function () {
      var v0 = vocalTrack.getChannelData(0), v1 = vocalTrack.getChannelData(1);
      var b0 = beatTrack.getChannelData(0), b1 = beatTrack.getChannelData(1);
      var aA = 1 - Math.exp(-1 / (DUCK_ATTACK_SEC * sr));
      var aR = 1 - Math.exp(-1 / (DUCK_RELEASE_SEC * sr));
      var relPk = 1 - Math.exp(-1 / (DUCK_PEAKHOLD_SEC * sr));
      var duckLin = Math.pow(10, -DUCK_MAX_DB / 20); // 0.708
      var e = 0, pk = 0;
      var i = 0;
      var CHUNK = 1 << 18; // yield inside the long pass too
      function duckChunk() {
        throwIfCancelled(token);
        var end = Math.min(totalLen, i + CHUNK);
        for (; i < end; i++) {
          var av = (v0[i] + v1[i]) * 0.5;
          av = av < 0 ? -av : av;
          var cc = av > e ? aA : aR;
          e += cc * (av - e);
          if (e > pk) pk = e;
          else pk += relPk * (e - pk);
          var amt = pk > 1e-6 ? e / pk : 0;
          if (amt > 1) amt = 1;
          amt = amt * amt;
          var gg = 1 - (1 - duckLin) * amt;
          // v24 W4 R3: DSP-fallback slot duck — beat only, never the vocal.
          var dg = 1;
          if (anyDuck && i >= introLen && i < introLen + vocalLen) {
            dg = duckGainSong[(((i - introLen) / slotLen) | 0) % N] || 1;
          }
          b0[i] = b0[i] * gg * dg + v0[i];
          b1[i] = b1[i] * gg * dg + v1[i];
        }
        prog('Mixing…', 0.70 + 0.10 * (i / totalLen));
        if (i < totalLen) return tick().then(duckChunk);
        return null;
      }
      return duckChunk();
    }).then(function () {
      vocalTrack = null; // summed in — the beat buffer is now the mix
      prog('Mixing…', 0.81);
      return tick();
    });

    /* ---- 7. arrangement fades: 1-bar in, 2-bar out (v22 shape) ---- */
    chain = chain.then(function () {
      throwIfCancelled(token);
      var md0 = beatTrack.getChannelData(0), md1 = beatTrack.getChannelData(1);
      linFade(md0, 0, Math.min(barLen, totalLen), true);
      linFade(md1, 0, Math.min(barLen, totalLen), true);
      linFade(md0, Math.max(0, totalLen - 2 * barLen), Math.min(2 * barLen, totalLen), false);
      linFade(md1, Math.max(0, totalLen - 2 * barLen), Math.min(2 * barLen, totalLen), false);
      prog('Arranging…', 0.86);
      return tick();
    });

    /* ---- 8. master: gentle 2:1 bus compression → 30 Hz HP → true-peak limit 0.71 ---- */
    chain = chain.then(function () {
      throwIfCancelled(token);
      prog('Mastering…', 0.90);
      return tick();
    }).then(function () {
      busCompress(beatTrack.getChannelData(0), beatTrack.getChannelData(1), sr);
      throwIfCancelled(token);
      prog('Mastering…', 0.96);
      return tick();
    }).then(function () {
      highPass30(beatTrack.getChannelData(0), sr); // v24: 30 Hz HP before limiter
      highPass30(beatTrack.getChannelData(1), sr);
      softPeakLimit(beatTrack); // v24: true-peak gain limiter, TP_CEIL 0.71 (-3 dBTP)
      var outBuf = beatTrack;
      beatTrack = null;
      prog('Done', 1);
      return {
        buffer: outBuf,
        meta: {
          masterBpm: Math.round(bpm * 10) / 10,
          sampleRate: sr,
          songs: N,
          cycles: cycles,
          barsPerVocal: barsPerVocal,
          xfadeBars: xfadeBars,
          introBars: introBars,
          outroBars: outroBars,
          totalBars: introBars + G * barsPerVocal + outroBars,
          durationSec: Math.round((totalLen / sr) * 10) / 10,
        },
      };
    });

    return chain;
  }

  return {
    buildTimeline: buildTimeline,
  };
})();
