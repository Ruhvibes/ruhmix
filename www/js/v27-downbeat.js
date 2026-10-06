'use strict';
/* =====================================================================
   RuhMix — v27-downbeat.js
   W7: REAL downbeat detection — pure on-device DSP, honest confidence.

   Pipeline:
     1. mono mixdown -> onset envelope (positive amplitude differences,
        hop 512 — same family as the existing beat tracker).
     2. beat grid: BPM comes from the EXISTING beat tracker
        (RM.audio.detectBPM) passed in as opts.bpm. When the caller has no
        BPM, a small fractional-lag onset-autocorrelation estimate is used
        instead and the method string says so. Beat PHASE is found by
        comb-aligning the grid to the KICK-BAND (60–150 Hz) onset
        envelope — the low-frequency pulse is the downbeat anchor in the
        vast majority of popular music; with no low-frequency pulse the
        phase is genuinely ambiguous and confidence reports uncertainty.
     3. bar / downbeat phase estimation over the 4 candidate phases of a
        4/4 bar, combining three independent cues:
          (a) low-band energy (60–150 Hz kick/bass, windowed biquad
              bandpass) per beat, grouped by bar phase — the downbeat
              usually carries the strongest kick;
          (b) chord-change likelihood at bar boundaries: 12-bin chroma
              vectors per beat, cosine distance between consecutive bars;
          (c) accent pattern: broadband RMS energy just after each beat —
              the downbeat usually carries the most energy.
     4. honest confidence 0..1 from the winning margin + cue agreement,
        with documented penalties (few bars, 3/4-ish evidence). A cue
        only votes when its spread across phases is significant
        (absolute floor + 15% relative) — flat cues stay silent instead
        of casting random votes.

   Output: { downbeats:[times...], confidence, method, bpm, beatTimes,
             barPhase, bars, uncertain }.
     - uncertain === true when confidence < 0.5. Callers MUST render
       uncertain markers in an "uncertain" style and say "downbeats
       uncertain" in UI text — never render fake confident markers.
     - null is returned when there is no tempo information at all
       (silence / too short / < 2 bars) — never an invented downbeat.
     - 4/4 is assumed. If the kick pattern shows stronger 3-beat
       periodicity, the estimate is still labeled 4/4 but confidence is
       reduced ×0.7 and the method string documents it.
     - Labels are honest everywhere: "estimated downbeat", NEVER
       "AI detected".

   Public API (window.RM.v27downbeat):
     analyze(buffer, opts) -> Promise<analysis|null>   (cached per buffer)
     detectDownbeats(buffer, opts) -> Promise<analysis|null>
     quantizeToDownbeat(timeSec, analysis) -> number    (sync)
     snapTransitionTime(buffer, timeSec, opts) -> Promise<{time, snapped,
        alreadyAligned, confidence}>  — snaps only when confidence ≥ 0.6
     buildDownbeatMarkers(analysis, durSec) -> [{t,color,style}]
     clearCache(buffer?)
   opts: { bpm?, onProgress? } — onProgress(0..1, label).

   All heavy loops run through RM.audio.runChunked so the UI never
   freezes on long tracks. No DOM, no network — Node-testable.
   ===================================================================== */
window.RM = window.RM || {};

RM.v27downbeat = (function () {
  var clamp = RM.audio.clamp;
  var chunked = RM.audio.runChunked;

  var HOP = 512;
  var LOW_F0 = 105, LOW_Q = 0.75;      // bandpass covering ~60–150 Hz
  var KICK_WIN_SEC = 0.18;             // low-band window after each beat
  var FLUX_WIN_SEC = 0.09;             // onset window after each beat
  var CONF_THRESH = 0.5;               // below -> "uncertain"
  var SNAP_THRESH = 0.6;               // transition snap gate
  var MIN_BEATS = 8;                   // need ≥ 2 bars of 4/4

  /* ================= radix-2 FFT (iterative, in-place) ================= */
  function fft(re, im) {
    var n = re.length, i, j, bit, t, len, k, ang, wr, wi, cwr, cwi, a, b, vr, vi, nwr;
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (len = 2; len <= n; len <<= 1) {
      ang = -2 * Math.PI / len; wr = Math.cos(ang); wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        cwr = 1; cwi = 0;
        for (k = 0; k < len / 2; k++) {
          a = i + k; b = i + k + len / 2;
          vr = re[b] * cwr - im[b] * cwi; vi = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
        }
      }
    }
  }
  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  /* ================= tiny helpers ================= */
  function monoOf(buffer) {
    var n = buffer.length, sr = buffer.sampleRate;
    var c0 = buffer.getChannelData(0);
    var c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    var mono = new Float32Array(n);
    if (c1) { for (var i = 0; i < n; i++) mono[i] = (c0[i] + c1[i]) * 0.5; }
    else mono.set(c0);
    return mono;
  }

  // RBJ bandpass (constant 0 dB peak gain), stateful per call window.
  function bandpassRMS(x, sr, f0, Q) {
    var w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0);
    var alpha = Math.sin(w0) / (2 * Q);
    var b0 = alpha, b1 = 0, b2 = -alpha;
    var a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0, sum = 0, n = x.length;
    for (var i = 0; i < n; i++) {
      var y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      sum += y * y;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }

  function prog(opts, f, label) {
    if (opts && typeof opts.onProgress === 'function') {
      try { opts.onProgress(clamp(f, 0, 1), label); } catch (e) {}
    }
  }

  /* ================= onset envelope (chunked) ================= */
  // Positive amplitude differences on a mono mixdown, hop 512.
  // Progress is mapped into [p0, p1] so callers can stage multiple envelopes.
  function onsetEnvelope(sig, sr, opts, p0, p1) {
    var frames = Math.max(8, Math.floor(sig.length / HOP));
    var env = new Float32Array(frames);
    var prev = 0;
    p0 = (p0 == null ? 0 : p0); p1 = (p1 == null ? 0.25 : p1);
    return chunked(frames, 256, function (a, b) {
      for (var i = a; i < b; i++) {
        var sum = 0, off = i * HOP;
        for (var n = 0; n < HOP && off + n < sig.length; n++) {
          var x = Math.abs(sig[off + n]);
          sum += Math.max(0, x - prev);
          prev = x;
        }
        env[i] = sum;
      }
    }, function (p) { prog(opts, p0 + p * (p1 - p0), 'Downbeat: onset envelope'); }).then(function () {
      return env;
    });
  }

  /* ================= bandpassed signal (chunked) ================= */
  // Full-signal RBJ bandpass (state carried across chunks) — feeds the
  // kick-band onset envelope used for beat-phase alignment.
  function bandpassSignal(x, sr, f0, Q, opts) {
    var w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0);
    var alpha = Math.sin(w0) / (2 * Q);
    var b0 = alpha, b2 = -alpha;
    var a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    var out = new Float32Array(x.length);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return chunked(x.length, 1 << 18, function (a, b) {
      for (var i = a; i < b; i++) {
        // y = (b0*x + b1*x1 + b2*x2 − a1*y1 − a2*y2)/a0, with b1 = 0.
        var y = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
        out[i] = y;
      }
    }, function (p) { prog(opts, 0.2 + p * 0.15, 'Downbeat: low-band filter'); }).then(function () {
      return out;
    });
  }

  /* ================= BPM estimate (fallback) ================= */
  // BPM estimate (fallback). Onset autocorrelation over FRACTIONAL lags
  // (linear-interpolated envelope) covering 60..200 BPM, octave
  // disambiguation, parabolic interpolation. Fractional lags matter:
  // integer-lag autocorrelation is biased toward sub-harmonics when the
  // true period is not a whole number of frames (e.g. 120 BPM @ 22050 Hz
  // = 21.53 frames — integer lag 43 scores better than 21/22).
  // Used ONLY when the caller did not pass opts.bpm — the existing beat
  // tracker's output is the preferred input and the method string
  // records which was used.
  // Peak-preserving "interpolation": linear interpolation smears peaks
  // when a lag's fractional part is near 0.5, biasing autocorrelation
  // toward sub-harmonics. Max-pooling never attenuates an onset.
  function envAt(env, x) {
    var i0 = Math.floor(x);
    var a = (i0 >= 0 && i0 < env.length) ? env[i0] : 0;
    var b = (i0 + 1 >= 0 && i0 + 1 < env.length) ? env[i0 + 1] : 0;
    return a > b ? a : b;
  }
  function estimateBpm(env, sr) {
    var frames = env.length;
    var r0 = 0, i;
    for (i = 0; i < frames; i++) r0 += env[i] * env[i];
    if (!isFinite(r0) || r0 === 0) return 0;
    var minLag = (60 / 200) * sr / HOP, maxLag = Math.min(frames - 1, (60 / 60) * sr / HOP);
    var bestLag = minLag, bestR = -1;
    for (var lag = minLag; lag <= maxLag; lag += 0.25) {
      var r = 0;
      for (i = 0; i + lag < frames; i++) r += env[i] * envAt(env, i + lag);
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    // Octave disambiguation: half-lag (double tempo) wins ties at 90%.
    var halfLag = bestLag / 2, rh = 0;
    if (halfLag >= minLag) {
      for (i = 0; i + halfLag < frames; i++) rh += env[i] * envAt(env, i + halfLag);
      if (rh > 0.9 * bestR) { bestLag = halfLag; bestR = rh; }
    }
    var bpm = clamp(Math.round((60 / bestLag) * sr / HOP), 60, 200);
    return bpm;
  }

  /* ================= beat phase alignment ================= */
  // Comb-align the beat grid to the onset envelope: try every integer
  // frame offset inside one beat period, score = onset energy at beat
  // positions (with ±1 frame local-max pooling for robustness).
  function alignPhase(env, sr, beatSec) {
    var beatFrames = beatSec * sr / HOP;
    var maxOff = Math.max(1, Math.round(beatFrames));
    var nBeats = Math.floor((env.length - maxOff) / beatFrames);
    if (nBeats < 4) return 0;
    var bestOff = 0, bestScore = -1;
    for (var off = 0; off < maxOff; off++) {
      var s = 0;
      for (var k = 0; k < nBeats; k++) {
        var f = off + Math.round(k * beatFrames);
        var m = env[f] || 0;
        if (f > 0 && env[f - 1] > m) m = env[f - 1];
        if (f + 1 < env.length && env[f + 1] > m) m = env[f + 1];
        s += m;
      }
      if (s > bestScore) { bestScore = s; bestOff = off; }
    }
    return (bestOff * HOP) / sr;
  }

  /* ================= per-beat features (chunked) ================= */
  // For every beat: kick-band RMS, 12-bin chroma, post-beat accent
  // (broadband RMS — the downbeat usually carries the most energy).
  function beatFeatures(mono, env, sr, beats, opts) {
    var nB = beats.length;
    var kick = new Float64Array(nB), flux = new Float64Array(nB);
    var chroma = new Array(nB);
    var beatSec = nB > 1 ? beats[1] - beats[0] : 0.5;
    var kickWin = Math.min(Math.round(KICK_WIN_SEC * sr), Math.max(64, Math.round(beatSec * sr * 0.5)));
    var accentWin = Math.min(Math.round(FLUX_WIN_SEC * sr), Math.max(64, Math.round(beatSec * sr * 0.25)));
    var chromaWin = Math.min(4096, Math.max(1024, Math.round(beatSec * sr)));
    var chromaN = Math.max(2048, nextPow2(chromaWin));
    var hann = new Float32Array(chromaWin);
    for (var h = 0; h < chromaWin; h++) hann[h] = 0.5 * (1 - Math.cos(2 * Math.PI * h / chromaWin));
    var re = new Float64Array(chromaN), im = new Float64Array(chromaN);

    return chunked(nB, 16, function (a, b) {
      for (var bi = a; bi < b; bi++) {
        var bs = Math.round(beats[bi] * sr);
        // (a) low-band kick energy: windowed biquad bandpass RMS
        var kl = Math.min(kickWin, mono.length - bs);
        if (kl > 64) {
          var win = mono.subarray(bs, bs + kl);
          kick[bi] = bandpassRMS(win, sr, LOW_F0, LOW_Q);
        }
        // (b) chroma vector, 55 Hz..~2 kHz
        var cl = Math.min(chromaWin, mono.length - bs);
        var cv = new Float64Array(12);
        if (cl > 256) {
          for (var i = 0; i < chromaN; i++) { re[i] = 0; im[i] = 0; }
          for (i = 0; i < cl; i++) re[i] = mono[bs + i] * hann[i];
          fft(re, im);
          var tot = 0;
          for (var k = 1; k < chromaN / 2; k++) {
            var f = k * sr / chromaN;
            if (f < 55 || f > 2093) continue;
            var pc = (Math.round(12 * Math.log(f / 440) / Math.LN2) + 9) % 12;
            pc = (pc + 12) % 12;
            var mag = re[k] * re[k] + im[k] * im[k];
            cv[pc] += mag; tot += mag;
          }
          if (tot > 0) for (var p2 = 0; p2 < 12; p2++) cv[p2] /= tot;
        }
        chroma[bi] = cv;
        // (c) accent: broadband RMS energy just after the beat — the
        // downbeat usually carries the most energy (kick + bass + crash).
        var as = Math.round(beats[bi] * sr);
        var al = Math.min(accentWin, mono.length - as), acc = 0;
        for (var q = 0; q < al; q++) { var v = mono[as + q]; acc += v * v; }
        flux[bi] = al > 0 ? Math.sqrt(acc / al) : 0;
      }
    }, function (p) { prog(opts, 0.5 + p * 0.4, 'Downbeat: beat features'); }).then(function () {
      return { kick: kick, chroma: chroma, flux: flux };
    });
  }

  /* ================= phase scoring ================= */
  function cosineDist(a, b) {
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < 12; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // A cue is "active" (carries information) only if its peak clears an
  // absolute floor AND its spread across the 4 phases exceeds 15% of its
  // peak — flat cues (noise, four-on-the-floor kick on every beat, tiny
  // random chroma wiggles) contribute nothing instead of random votes.
  function normalizeCue(v, absFloor) {
    var mx = -1e18, mn = 1e18, i;
    for (i = 0; i < v.length; i++) { if (v[i] > mx) mx = v[i]; if (v[i] < mn) mn = v[i]; }
    if (!(mx > (absFloor || 0)) || (mx - mn) / mx < 0.15) return null; // inactive
    var out = [];
    for (i = 0; i < v.length; i++) out.push((v[i] - mn) / (mx - mn));
    return out;
  }

  function scorePhases(nBeats, feat) {
    var kickRaw = [0, 0, 0, 0], fluxRaw = [0, 0, 0, 0];
    var kickN = [0, 0, 0, 0], fluxN = [0, 0, 0, 0];
    var i, p;
    for (i = 0; i < nBeats; i++) {
      p = i % 4;
      kickRaw[p] += feat.kick[i]; kickN[p]++;
      fluxRaw[p] += feat.flux[i]; fluxN[p]++;
    }
    for (p = 0; p < 4; p++) {
      kickRaw[p] /= Math.max(1, kickN[p]);
      fluxRaw[p] /= Math.max(1, fluxN[p]);
    }
    // chord-change likelihood at bar boundaries: for bar phase p, mean
    // chroma distance between each bar's first beat and the beat before it.
    // A phase only votes when it has ≥ 2 measured boundaries, and the cue
    // needs ≥ 3 voting phases — missing data must not cast random votes.
    // Cosine distances below 0.08 are harmonic noise, not chord changes.
    var qIdx = [], qVals = [];
    for (p = 0; p < 4; p++) {
      var sum = 0, cnt = 0;
      for (var bs = p; bs < nBeats; bs += 4) {
        if (bs === 0) continue;
        sum += cosineDist(feat.chroma[bs], feat.chroma[bs - 1]); cnt++;
      }
      if (cnt >= 2) { qIdx.push(p); qVals.push(sum / cnt); }
    }
    var chroma = null;
    if (qIdx.length >= 3) {
      var qn = normalizeCue(qVals, 0.08);
      if (qn) {
        chroma = [0.5, 0.5, 0.5, 0.5]; // non-voting phases stay neutral
        for (var qi = 0; qi < qIdx.length; qi++) chroma[qIdx[qi]] = qn[qi];
      }
    }
    var kick = normalizeCue(kickRaw, 1e-4), flux = normalizeCue(fluxRaw, 1e-9);
    var cues = [
      { name: 'kick', w: 0.45, v: kick },
      { name: 'chroma', w: 0.30, v: chroma },
      { name: 'flux', w: 0.25, v: flux },
    ].filter(function (c) { return !!c.v; });
    var wSum = 0, k;
    for (k = 0; k < cues.length; k++) wSum += cues[k].w;
    var score = [0, 0, 0, 0];
    if (wSum > 0) {
      for (k = 0; k < cues.length; k++)
        for (p = 0; p < 4; p++) score[p] += (cues[k].w / wSum) * cues[k].v[p];
    }
    return { score: score, cues: cues, bars: Math.floor(nBeats / 4) };
  }

  // 3/4-ish evidence: kick pattern with stronger 3-beat than 4-beat
  // periodicity. Still labeled 4/4 (documented), confidence reduced.
  function waltzEvidence(feat, nBeats) {
    function grouped(mod) {
      var g = [], n = [], i, p;
      for (p = 0; p < mod; p++) { g.push(0); n.push(0); }
      for (i = 0; i < nBeats; i++) { p = i % mod; g[p] += feat.kick[i]; n[p]++; }
      for (p = 0; p < mod; p++) g[p] /= Math.max(1, n[p]);
      g.sort(function (x, y) { return y - x; });
      return g[0] > 0 ? (g[0] - g[1]) / g[0] : 0;
    }
    var m3 = grouped(3), m4 = grouped(4);
    return m3 > 0.35 && m3 > 1.4 * m4;
  }

  /* ================= main entry ================= */
  function detectDownbeats(buffer, opts) {
    opts = opts || {};
    if (!buffer || typeof buffer.getChannelData !== 'function' ||
        !(buffer.length > 0) || !(buffer.duration > 1.2)) {
      return Promise.resolve(null); // too short — honest null
    }
    var sr = buffer.sampleRate;
    var mono = monoOf(buffer);
    var bpmFromTracker = (typeof opts.bpm === 'number' && isFinite(opts.bpm) &&
      opts.bpm >= 50 && opts.bpm <= 220) ? opts.bpm : 0;
    prog(opts, 0.02, 'Downbeat: reading audio');
    return onsetEnvelope(mono, sr, opts, 0, 0.2).then(function (env) {
      return bandpassSignal(mono, sr, LOW_F0, LOW_Q, opts).then(function (lowSig) {
        return onsetEnvelope(lowSig, sr, opts, 0.35, 0.5).then(function (lowEnv) {
          return { env: env, lowEnv: lowEnv };
        });
      });
    }).then(function (envs) {
      var env = envs.env, lowEnv = envs.lowEnv;
      var bpm = bpmFromTracker, bpmSource;
      if (bpm > 0) { bpmSource = 'existing beat tracker'; }
      else {
        bpm = estimateBpm(env, sr);
        bpmSource = 'internal onset estimate';
        if (!(bpm > 0)) return null; // silence / no tempo info — honest null
      }
      var beatSec = 60 / bpm;
      // Beat PHASE comes from the kick-band (60–150 Hz) onset envelope:
      // the downbeat anchor is the low-frequency pulse in the vast
      // majority of popular music. With no low-frequency pulse the phase
      // is genuinely ambiguous and the confidence machinery below
      // reports uncertainty instead of false confidence.
      var phase = alignPhase(lowEnv, sr, beatSec);
      var beats = [];
      for (var t = phase; t < buffer.duration - 0.05; t += beatSec) beats.push(t);
      if (beats.length < MIN_BEATS) return null; // < 2 bars — honest null
      prog(opts, 0.55, 'Downbeat: beat grid (' + beats.length + ' beats)');
      return beatFeatures(mono, env, sr, beats, opts).then(function (feat) {
        var scored = scorePhases(beats.length, feat);
        prog(opts, 0.9, 'Downbeat: scoring bar phases');
        if (!scored.cues.length) {
          return {
            downbeats: [], confidence: 0, uncertain: true, bpm: bpm,
            beatTimes: beats, barPhase: -1, bars: scored.bars,
            method: 'Estimated downbeat: no rhythmic or harmonic cue carried ' +
              'information (flat kick/chroma/flux) — downbeats uncertain.',
          };
        }
        var order = [0, 1, 2, 3].sort(function (x, y) { return scored.score[y] - scored.score[x]; });
        var best = order[0], second = order[1];
        var margin = (scored.score[best] - scored.score[second]) / (scored.score[best] + 1e-9);
        var votes = 0, k;
        for (k = 0; k < scored.cues.length; k++) {
          var v = scored.cues[k].v, am = 0;
          for (var p = 1; p < 4; p++) if (v[p] > v[am]) am = p;
          if (am === best) votes++;
        }
        var agree = votes / scored.cues.length;
        var conf = 0.65 * margin + 0.35 * agree;
        var notes = [];
        if (scored.bars < 4) { conf *= 0.85; notes.push('fewer than 4 bars'); }
        if (waltzEvidence(feat, beats.length)) {
          conf *= 0.7;
          notes.push('possible 3/4 feel — labeled 4/4 with reduced confidence');
        }
        conf = clamp(conf, 0, 0.95);
        var downbeats = [];
        for (var i = best; i < beats.length; i += 4) downbeats.push(+beats[i].toFixed(3));
        var cueNames = scored.cues.map(function (c) { return c.name; }).join('+');
        var method = 'Estimated downbeat (onset + beat grid ' + bpm + ' BPM from ' +
          bpmSource + ' + low-band kick energy + chroma change + flux accent [' +
          cueNames + ']; 4/4 assumed' +
          (notes.length ? '; ' + notes.join('; ') : '') + '.';
        prog(opts, 1, 'Downbeat: done');
        var detail = {
          scores: scored.score.map(function (s) { return +s.toFixed(3); }),
          margin: +margin.toFixed(3),
          agree: +agree.toFixed(3),
          cues: scored.cues.map(function (c) {
            var am = 0;
            for (var p = 1; p < 4; p++) if (c.v[p] > c.v[am]) am = p;
            return { name: c.name, values: c.v.map(function (x) { return +x.toFixed(3); }), vote: am };
          }),
        };
        return {
          downbeats: downbeats,
          confidence: +conf.toFixed(3),
          uncertain: conf < CONF_THRESH,
          method: method,
          bpm: bpm,
          beatTimes: beats.map(function (x) { return +x.toFixed(3); }),
          barPhase: best,
          bars: scored.bars,
          detail: detail, // per-cue votes/scores — transparency for UI + tests
        };
      });
    });
  }

  /* ================= cache + public helpers ================= */
  var cache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  var noCache = {};

  function analyze(buffer, opts) {
    if (!buffer) return Promise.resolve(null);
    var key = cache ? buffer : noCache;
    var hit = cache ? cache.get(buffer) : noCache.v;
    if (hit) return hit;
    var p = detectDownbeats(buffer, opts).catch(function () { return null; });
    if (cache) cache.set(buffer, p); else noCache.v = p;
    // A failed/empty analysis must not poison later retries: drop nulls.
    p.then(function (an) {
      if (!an && cache) { try { cache.delete(buffer); } catch (e) {} }
      else if (!an) { noCache.v = null; }
    });
    return p;
  }

  function clearCache(buffer) {
    try {
      if (cache) { if (buffer) cache.delete(buffer); }
      else noCache.v = null;
    } catch (e) {}
  }

  // Nearest estimated downbeat to t (sync, pure). Returns t unchanged
  // when there is no usable analysis — never invents a snap target.
  function quantizeToDownbeat(t, analysis) {
    if (!analysis || !analysis.downbeats || !analysis.downbeats.length ||
        !(t >= 0)) return t;
    var best = analysis.downbeats[0], bd = Math.abs(best - t);
    for (var i = 1; i < analysis.downbeats.length; i++) {
      var d = Math.abs(analysis.downbeats[i] - t);
      if (d < bd) { bd = d; best = analysis.downbeats[i]; }
    }
    return best;
  }

  // Transition hook: snap a transition start time to the nearest
  // ESTIMATED downbeat, but ONLY when the estimate is trustworthy
  // (confidence ≥ 0.6). Otherwise the original time passes through
  // untouched — a wrong snap is worse than no snap.
  function shouldSnap(analysis) {
    return !!(analysis && analysis.downbeats && analysis.downbeats.length &&
               analysis.confidence >= SNAP_THRESH);
  }

  function snapTransitionTime(buffer, t, opts) {
    opts = opts || {};
    return analyze(buffer, opts).then(function (an) {
      var conf = an ? an.confidence : 0;
      if (!shouldSnap(an)) {
        return { time: t, snapped: false, alreadyAligned: false, confidence: +conf.toFixed(3) };
      }
      var q = quantizeToDownbeat(t, an);
      if (Math.abs(q - t) < 0.002) {
        return { time: t, snapped: false, alreadyAligned: true, confidence: +conf.toFixed(3) };
      }
      return { time: q, snapped: true, alreadyAligned: false, confidence: +conf.toFixed(3) };
    });
  }

  // Waveform marker tier: confident downbeats get a solid orange tick;
  // uncertain ones (confidence < 0.5) get style:'uncertain' so the
  // renderer draws them dashed/dim, and the UI must print
  // "downbeats uncertain" next to them.
  function buildDownbeatMarkers(analysis, durSec) {
    var mk = [];
    if (!analysis || !analysis.downbeats || !analysis.downbeats.length) return mk;
    var unc = analysis.confidence < CONF_THRESH;
    for (var i = 0; i < analysis.downbeats.length; i++) {
      var t = analysis.downbeats[i];
      if (!(t >= 0) || (durSec > 0 && t > durSec)) continue;
      mk.push({ t: t, color: unc ? '#c98f4e' : '#ff9f43', style: unc ? 'uncertain' : 'downbeat' });
    }
    return mk;
  }

  return {
    analyze: analyze,
    detectDownbeats: detectDownbeats,
    quantizeToDownbeat: quantizeToDownbeat,
    shouldSnap: shouldSnap,
    snapTransitionTime: snapTransitionTime,
    buildDownbeatMarkers: buildDownbeatMarkers,
    clearCache: clearCache,
    CONF_THRESH: CONF_THRESH,
    SNAP_THRESH: SNAP_THRESH,
    _internals: { estimateBpm: estimateBpm, alignPhase: alignPhase, normalizeCue: normalizeCue, scorePhases: scorePhases },
  };
})();
