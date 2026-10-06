'use strict';
/* =====================================================================
   RuhMix — mashup-swap.js  (W4 — Vocal Swap, v23)
   "🔄 Vocal Swap" — DJ duet style: kabhi Song 1 ka vocal, kabhi Song 2 ka.

   Takes two decoded AudioBuffers and builds one mashup where the singers
   take turns over a single consistent built-in beat:
     4-bar beat intro -> 8 bars Song 1 -> 1-bar xfade -> 8 bars Song 2
     -> repeat (2 cycles) -> 4-bar beat outro.

   Pipeline (pure logic, no UI, NO autoplay — returns the buffer):
     1. Isolate vocals from BOTH songs with the registered stem provider
        (RM.mashup.getStemsProvider() — the same smart/neural provider the
        Auto Mashup uses; neural when the user configured their own HF
        Space, Smart DSP default). Engine tags are collected honestly —
        DSP output is NEVER labelled AI/neural.
     2. Master BPM = Song 1's BPM (RM.audio.detectBPM, reused, honest
        100 BPM fallback). Both vocals are WSOLA time-stretched onto the
        master grid and Song 2's vocal is pitch-matched to Song 1's key
        (chroma + Krumhansl via mashup-dsp, detected on the CLEAN buffers
        before stretching — same root-cause ordering as mashup.js).
     3. Beat = built-in auto style (nearest style BPM to the master BPM),
        rendered at EXACTLY the master BPM and tiled sample-exact across
        the full 40-bar arrangement — loop-perfect, no bleed.
     4. Timeline = RM.mashupArrange.buildTimeline() (W3's module). If it
        is missing/not loaded yet, a built-in fallback does the same
        arrangement: intro 4 + alternate 8-bar segments with a 1-bar
        equal-power crossfade + outro 4, cycles=2. The arrange module also
        owns the pro polish (sidechain/glue/comp/limiter); the fallback
        keeps the hard requirements — +3 dB vocal-over-bed balance (v21
        spec), arrangement fades, hard peak limit 0.98.
     5. Cancel: throwIfCancelled() between stages; a user cancel always
        rethrows {kind:'cancelled'} — never wrapped, never DSP-fallbacked.

   API:
     RM.mashupSwap.build(buf1, buf2, onProgress, token)
       -> Promise<{ buffer, meta, engineTags }>
       buf1, buf2 : decoded AudioBuffers (Song 1 = the master clock).
       onProgress : fn(label, frac 0..1) — same convention as RM.mashup.
       token      : optional cancel source. Accepted shapes:
                      - null/undefined (falls back to RM.mashupStems flag)
                      - function            — called as throwIfCancelled()
                      - { throwIfCancelled() }
                      - { cancelled: true } / { isCancelled() }
                    A cancel always surfaces as {kind:'cancelled'}.
       meta = { bpm1, bpm2, targetBpm, style:'swap', styleId, styleName,
                stretchRatio2, key1, key2, semitones, bpmFallback, bpmNote,
                segBars, cycles, engineTags, arrangeBy, durationSec }
       engineTags = { song1: tag, song2: tag } — honest provider tags.

   Dependencies (loaded before this file, checked at call time):
     - audio-engine.js -> RM.audio.detectBPM / resampleBuffer / ensureCtx
     - mashup-dsp.js   -> RM.mashupDSP (timeStretch, pitchShift, detectKey,
                         semitonesBetween, normalizeToRms, rms, fadeInOut)
     - beats.js        -> RM.Beats (STYLES + renderBeat)
     - mashup.js       -> RM.mashup.getStemsProvider (registered smart/
                         neural provider; local DSP vocalcut fallback if
                         mashup.js is absent)
   Friendly errors only — provider {kind} rejections are mapped to text,
   never "[object Object]". No new permissions: everything is on-device
   DSP except the optional user-configured HF neural path (provider-owned).
   ===================================================================== */
window.RM = window.RM || {};

RM.mashupSwap = (function () {
  /* ---------------- tunables ---------------- */
  var SWAP_INTRO_BARS = 4;
  var SWAP_OUTRO_BARS = 4;
  var SWAP_SEG_BARS = 8;    // each singer's turn
  var SWAP_XFADE_BARS = 0.5;  // v23: tight DJ handoff (0.25-bar out + 0.25-bar in) — equal-power, click-free
  var SWAP_CYCLES = 2;      // S1 -> S2 -> S1 -> S2
  var BEAT_LOOP_BARS = 4;   // rendered once, then tiled sample-exact
  var VOCAL_OVER_BED_DB = 3;         // v21 spec: active singer +3 dB
  var VOCAL_BOOST = Math.pow(10, VOCAL_OVER_BED_DB / 20); // 1.4125
  var BED_RMS = 0.126;               // ≈ -18 dBFS beat reference
  var PEAK_LIMIT = 0.98;             // hard ceiling, never clips
  var BPM_FALLBACK = 100;            // honest fallback when detection fails
  var MAX_SEMITONES = 6;             // pitch-shift clamp (natural vocals)

  /* ---------------- small guards ---------------- */
  function isAudioBuffer(b) {
    return !!(b && typeof b.getChannelData === 'function' &&
              typeof b.sampleRate === 'number' && typeof b.length === 'number' &&
              typeof b.numberOfChannels === 'number');
  }

  function checkDeps() {
    if (!RM.audio || typeof RM.audio.detectBPM !== 'function')
      throw new Error('Vocal Swap needs audio-engine.js (RM.audio.detectBPM) — load it before mashup-swap.js.');
    if (typeof RM.audio.resampleBuffer !== 'function')
      throw new Error('Vocal Swap needs audio-engine.js (RM.audio.resampleBuffer) — load it before mashup-swap.js.');
    if (typeof RM.audio.ensureCtx !== 'function')
      throw new Error('Vocal Swap needs audio-engine.js (RM.audio.ensureCtx) — load it before mashup-swap.js.');
    var dsp = RM.mashupDSP;
    var fns = ['detectKey', 'timeStretch', 'pitchShift',
               'normalizeToRms', 'semitonesBetween', 'fadeInOut'];
    var ok = !!dsp && fns.every(function (f) { return typeof dsp[f] === 'function'; });
    if (!ok) throw new Error('Vocal Swap needs mashup-dsp.js — load it before mashup-swap.js.');
    if (!RM.Beats || typeof RM.Beats.renderBeat !== 'function' || !RM.Beats.STYLES)
      throw new Error('Vocal Swap needs beats.js (RM.Beats.STYLES + renderBeat) — load it before mashup-swap.js.');
    return dsp;
  }

  /* ---------------- stem provider ---------------- */
  // Preferred: the registered smart/neural provider (mashup-stems.js
  // registered it via RM.mashup.setStemsProvider). Fallback: local
  // vocalcut DSP copy (mashup.js's defaultStemsProvider shape) so swap
  // works even if mashup.js is absent.
  function resolveProvider() {
    try {
      if (RM.mashup && typeof RM.mashup.getStemsProvider === 'function') {
        var p = RM.mashup.getStemsProvider();
        if (typeof p === 'function') return p;
      }
    } catch (e) { /* fall through to local DSP */ }
    return function localDspProvider(audioBuffer, want, onProgress) {
      var w = want === 'instrumental' ? 'instrumental' : 'vocal';
      return RM.stems.run('vocalcut', audioBuffer, onProgress).then(function (stems) {
        var list = Array.isArray(stems) ? stems : [];
        var re = w === 'vocal' ? /center/i : /sides/i;
        var hit = list.find(function (s) { return re.test(String((s && s.name) || '')); }) ||
          list[w === 'vocal' ? 0 : 1];
        if (!hit || !isAudioBuffer(hit.buffer))
          throw new Error('Vocal Cut (DSP) returned no usable stem.');
        return { buffer: hit.buffer, tag: 'smart DSP' };
      });
    };
  }

  /* ---------------- cancel ---------------- */
  function throwIfCancelled(token) {
    // Explicit token shapes first.
    if (typeof token === 'function') { token(); }           // throws on cancel
    else if (token && typeof token.throwIfCancelled === 'function') { token.throwIfCancelled(); }
    else if (token && (token.cancelled === true ||
                       (typeof token.isCancelled === 'function' && token.isCancelled()))) {
      throw { kind: 'cancelled' };
    }
    // The mashup UI Cancel button flag (same as RM.mashup's pipeline).
    try {
      if (RM.mashupStems && typeof RM.mashupStems.isCancelRequested === 'function' &&
          RM.mashupStems.isCancelRequested()) throw { kind: 'cancelled' };
    } catch (e) {
      if (e && e.kind === 'cancelled') throw e;
    }
  }

  /* ---------------- friendly errors ---------------- */
  // v21 pattern (mashup.js): provider {kind} objects are never stringified.
  function kindText(e) {
    var k = e && e.kind;
    if (k === 'cancelled') return 'Cancelled.';
    if (k === 'timeout') return 'The AI server took too long (timeout). Try a shorter song or try again.';
    if (k === 'connect') return 'Cannot reach the AI server. Check your internet connection.';
    if (k === 'quota') return 'The free AI daily limit seems over (~6-10 songs/day). Try again tomorrow.';
    if (k === 'asleep') return 'The AI server is waking up. Wait a minute and try again.';
    if (k === 'server') return 'The AI server returned an error. Please try again in a bit.';
    if (k === 'empty' || k === 'decode' || k === 'process')
      return 'Vocal isolation failed on this song. Try another song.';
    if (k === 'nocfg' || k === 'nopath') return 'AI server not configured.';
    if (e instanceof Error) return e.message || 'Something went wrong.';
    var s = String((e && e.message) || e || 'Something went wrong.');
    return s === '[object Object]' ? 'Something went wrong.' : s;
  }

  function keyLabel(k) {
    if (!k) return 'Unknown';
    if (typeof k === 'string') return k;
    if (typeof k.key === 'string') {
      var m = String(k.mode || '').toLowerCase();
      var mn = m === 'minor' ? 'minor' : m === 'major' ? 'major' : m;
      return (k.key + (mn ? ' ' + mn : '')).trim() || 'Unknown';
    }
    if (typeof k.name === 'string' && k.name) return k.name;
    return 'Unknown';
  }

  /* ---------------- auto beat style (nearest BPM) ---------------- */
  // Same selection rule as mashup.js's pickAutoStyle (nearest native BPM);
  // the beat is ALWAYS rendered at the exact master BPM, so time cannot
  // drift — style choice is only about the groove.
  function pickAutoStyle(beats, bpm) {
    var styles = beats.STYLES;
    var list = [];
    if (Array.isArray(styles)) {
      styles.forEach(function (s, i) {
        if (s) list.push({ id: s.id != null ? String(s.id) : String(i), style: s });
      });
    } else if (styles && typeof styles === 'object') {
      Object.keys(styles).forEach(function (k) {
        if (styles[k]) list.push({ id: k, style: styles[k] });
      });
    }
    if (!list.length) throw new Error('RM.Beats.STYLES is empty — no beat styles to choose from.');
    var best = list[0], bestDiff = Infinity;
    list.forEach(function (e) {
      var b = Number(e.style && e.style.bpm);
      if (!isFinite(b) || b <= 0) return;
      var d = Math.abs(bpm - b);
      if (d < bestDiff) { bestDiff = d; best = e; }
    });
    var s = best.style || {};
    return { id: best.id, name: String(s.name || s.title || best.id) };
  }

  // Render a short loop-perfect period at the exact BPM, then tile it
  // sample-exact across totalLen (mashup.js renderBeatTiledAuto pattern —
  // every tile boundary is a downbeat, joins are seamless, no WSOLA).
  function renderBeatTiled(beats, entry, bpm, totalLen, sr) {
    return Promise.resolve()
      .then(function () { return beats.renderBeat(entry.id, bpm, BEAT_LOOP_BARS, { sampleRate: sr }); })
      .then(function (buf) {
        if (!isAudioBuffer(buf)) throw new Error('Beat render returned no audio.');
        var loop = buf;
        if (buf.sampleRate !== sr) return RM.audio.resampleBuffer(buf, sr);
        return loop;
      })
      .then(function (loopBuf) {
        if (!isAudioBuffer(loopBuf) || !loopBuf.length)
          throw new Error('Beat render returned no audio.');
        var period = loopBuf.length;
        var nCh = loopBuf.numberOfChannels;
        var ctx = RM.audio.ensureCtx();
        var out = ctx.createBuffer(2, totalLen, sr);
        for (var c = 0; c < 2; c++) {
          var src = loopBuf.getChannelData(Math.min(c, nCh - 1));
          var dst = out.getChannelData(c);
          for (var i = 0; i < totalLen; i++) dst[i] = src[i % period];
        }
        return out;
      });
  }

  /* ---------------- built-in fallback timeline ---------------- */
  // Used ONLY when RM.mashupArrange.buildTimeline() is missing. Same
  // arrangement the spec asks for: intro 4 + alternate 8-bar segments
  // with a 1-bar equal-power crossfade + outro 4, cycles=2. Balance keeps
  // the v21 spec (active singer +3 dB over the beat, re-locked on the
  // beat's ACHIEVED rms), arrangement fades, hard peak limit 0.98.
  // Pro polish (sidechain/glue/comp) belongs to the arrange module.
  function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }

  // Copy `len` samples from src starting at `offset`, looping the source
  // when it is shorter than the needed excerpt (voices never run dry).
  function excerptLooped(src, offset, len) {
    var nCh = src.numberOfChannels, sLen = src.length;
    var out = [];
    for (var c = 0; c < nCh; c++) {
      var s = src.getChannelData(c), d = new Float32Array(len);
      if (sLen > 0) {
        var o = ((offset % sLen) + sLen) % sLen;
        for (var i = 0; i < len; i++) d[i] = s[(o + i) % sLen];
      }
      out.push(d);
    }
    return out;
  }

  function hardPeakLimit(buf) {
    var chans = [];
    for (var c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    var peak = 0;
    chans.forEach(function (d) {
      for (var i = 0; i < d.length; i++) {
        var a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    });
    if (peak > PEAK_LIMIT) {
      chans.forEach(function (d) {
        for (var j = 0; j < d.length; j++) {
          if (d[j] > PEAK_LIMIT) d[j] = PEAK_LIMIT;
          else if (d[j] < -PEAK_LIMIT) d[j] = -PEAK_LIMIT;
        }
      });
    }
  }

  function fallbackTimeline(dsp, vocalSegs, beatBuf, bpm, sr, onTick) {
    var barLen = Math.max(1, Math.round((240 / bpm) * sr));
    var segLen = barLen * SWAP_SEG_BARS;
    var xLen = Math.max(1, Math.min(barLen * SWAP_XFADE_BARS, segLen));
    var introLen = barLen * SWAP_INTRO_BARS;
    var outroLen = barLen * SWAP_OUTRO_BARS;
    var bodyBars = SWAP_SEG_BARS * SWAP_CYCLES * 2;
    var totalLen = introLen + bodyBars * barLen + outroLen;
    var ctx = RM.audio.ensureCtx();
    var halfPi = Math.PI / 2;
    var vocalTrack = null, beat = null, mix = null;

    return Promise.resolve()
      .then(function () {
        // 1. Balance (v21 spec): beat -> -18 dBFS; combined vocal track
        //    -> beat_achieved_RMS x 1.4125 (exactly +3 dB over the bed).
        beat = dsp.normalizeToRms(beatBuf, BED_RMS);
        if (!isAudioBuffer(beat)) beat = beatBuf;
        vocalTrack = ctx.createBuffer(2, totalLen, sr);
        // 2. Lay the alternating singer segments with equal-power xfades.
        var order = [];
        for (var cy = 0; cy < SWAP_CYCLES; cy++) { order.push(0); order.push(1); }
        for (var s = 0; s < order.length; s++) {
          var which = order[s];
          var start = introLen + s * segLen;
          var chEx = excerptLooped(vocalSegs[which], Math.floor(s / 2) * segLen, segLen);
          for (var c = 0; c < 2; c++) {
            var td = vocalTrack.getChannelData(c);
            var ex = chEx[Math.min(c, chEx.length - 1)];
            if (s === 0) {
              for (var i = 0; i < segLen; i++) td[start + i] += ex[i];
            } else {
              // 1-bar equal-power crossfade over the singer boundary.
              for (var n = 0; n < xLen; n++) {
                var wIn = Math.sin(halfPi * n / xLen);
                var wOut = Math.cos(halfPi * n / xLen);
                td[start + n] = td[start + n] * wOut + ex[n] * wIn;
              }
              for (var m = xLen; m < segLen; m++) td[start + m] += ex[m];
            }
          }
        }
        if (typeof onTick === 'function') { try { onTick(0.85); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 3. Re-lock the +3 dB balance on the finished vocal track.
        var bedRms = (typeof dsp.rms === 'function') ? dsp.rms(beat) : 0;
        var v = dsp.normalizeToRms(vocalTrack, bedRms > 1e-9 ? bedRms * VOCAL_BOOST : BED_RMS);
        if (isAudioBuffer(v)) vocalTrack = v;
        if (typeof onTick === 'function') { try { onTick(0.90); } catch (e) {} }
        return tick();
      })
      .then(function () {
        // 4. Sum + arrangement fades (1-bar in, 2-bar outro out), limiter.
        mix = ctx.createBuffer(2, totalLen, sr);
        var bCh = beat.numberOfChannels;
        var inN = Math.min(barLen, totalLen);
        var outN = Math.min(2 * barLen, totalLen);
        for (var c = 0; c < 2; c++) {
          var bd = beat.getChannelData(Math.min(c, bCh - 1));
          var vd = vocalTrack.getChannelData(c);
          var md = mix.getChannelData(c);
          var n = Math.min(bd.length, totalLen);
          for (var i = 0; i < n; i++) md[i] = bd[i] + vd[i];
          for (var f = 0; f < inN; f++) md[f] *= Math.sin(halfPi * f / inN);
          for (var g = 0; g < outN; g++) {
            var idx = totalLen - 1 - g;
            md[idx] *= Math.sin(halfPi * g / outN);
          }
          md[0] = 0; md[totalLen - 1] = 0; // exact zeros: click-free edges
        }
        hardPeakLimit(mix);
        if (typeof onTick === 'function') { try { onTick(0.97); } catch (e) {} }
        return tick();
      })
      .then(function () { return mix; });
  }

  /* ---------------- the pipeline ---------------- */
  function build(buf1, buf2, onProgress, token) {
    var dsp;
    var beats;
    try {
      dsp = checkDeps();
      if (!RM.Beats || typeof RM.Beats.renderBeat !== 'function')
        throw new Error('Beat engine not ready.');
      beats = RM.Beats;
    } catch (e) {
      return Promise.reject(e);
    }
    var stemsProvider = resolveProvider();

    if (!isAudioBuffer(buf1))
      return Promise.reject(new Error('Vocal Swap needs two songs — the first song is missing or invalid.'));
    if (!isAudioBuffer(buf2))
      return Promise.reject(new Error('Vocal Swap needs two songs — the second song is missing or invalid.'));

    var sr = buf1.sampleRate;
    var lastFrac = -1;
    function prog(label, frac) {
      try {
        if (onProgress) {
          var f = Math.max(0, Math.min(1, frac));
          if (f < lastFrac) f = lastFrac; // the bar never moves backwards
          lastFrac = f;
          onProgress(label, f);
        }
      } catch (e) { /* never break the pipeline */ }
    }

    var tag1 = 'smart DSP', tag2 = 'smart DSP';
    var vocal1 = null, vocal2 = null;
    var bpm1 = BPM_FALLBACK, bpm2 = BPM_FALLBACK;
    var bpmFallback = false, bpmNote = '';
    var key1 = 'Unknown', key2 = 'Unknown', semitones = 0;
    var picked = null, beatBuf = null, outBuf = null;
    var arrangeBy = 'built-in fallback';

    function stage(name, frac) {
      throwIfCancelled(token);
      prog(name, frac);
      return Promise.resolve().then(function () {
        return new Promise(function (res) { setTimeout(res, 0); }); // let the UI paint
      });
    }

    var chain = Promise.resolve();

    /* ---- Stage 1: isolate vocals from BOTH songs ---- */
    chain = chain
      .then(function () { return stage('Extracting vocals (Song 1)…', 0.01); })
      .then(function () {
        return stemsProvider(buf1, 'vocal', function (q) {
          prog('Extracting vocals (Song 1)…', 0.01 + q * 0.16);
        });
      })
      .then(function (res) {
        if (!res || !isAudioBuffer(res.buffer))
          throw new Error('Vocal isolation (Song 1) returned no audio.');
        vocal1 = res.buffer; tag1 = res.tag || tag1;
        prog('Extracting vocals (Song 1)…', 0.17);
        return stage('Extracting vocals (Song 2)…', 0.18);
      })
      .then(function () {
        return stemsProvider(buf2, 'vocal', function (q) {
          prog('Extracting vocals (Song 2)…', 0.18 + q * 0.16);
        });
      })
      .then(function (res) {
        if (!res || !isAudioBuffer(res.buffer))
          throw new Error('Vocal isolation (Song 2) returned no audio.');
        vocal2 = res.buffer; tag2 = res.tag || tag2;
        prog('Extracting vocals (Song 2)…', 0.34);
      })
      .catch(function (e) {
        if (e && e.kind === 'cancelled') throw e; // never wrap a cancel
        if (e instanceof Error &&
            /Vocal isolation \(Song [12]\) returned no audio/.test(e.message)) throw e;
        throw new Error('Vocal isolation failed: ' + kindText(e));
      });

    /* ---- Stage 1b: common sample rate (Song 1 wins) ---- */
    chain = chain.then(function () {
      var jobs = [vocal1, vocal2].map(function (v) {
        return (v.sampleRate === sr) ? v : RM.audio.resampleBuffer(v, sr);
      });
      return Promise.all(jobs);
    }).then(function (rs) {
      if (isAudioBuffer(rs[0])) vocal1 = rs[0];
      if (isAudioBuffer(rs[1])) vocal2 = rs[1];
    }).catch(function (e) {
      throw new Error('Sample-rate normalization failed: ' + kindText(e));
    });

    /* ---- Stage 2: tempo — master BPM = Song 1's BPM ---- */
    chain = chain
      .then(function () { return stage('Detecting tempo…', 0.36); })
      .then(function () {
        var p1 = RM.audio.detectBPM(buf1, function (q) { prog('Detecting tempo…', 0.36 + q * 0.07); });
        var p2 = RM.audio.detectBPM(buf2, function (q) { prog('Detecting tempo…', 0.43 + q * 0.07); });
        return Promise.all([p1, p2]);
      })
      .then(function (bpms) {
        var b1 = Number(bpms[0]), b2 = Number(bpms[1]);
        if (isFinite(b1) && b1 >= 50 && b1 <= 220) bpm1 = b1;
        else { bpmFallback = true; bpmNote = 'Tempo detection failed — using 100 BPM fallback.'; }
        if (isFinite(b2) && b2 >= 50 && b2 <= 220) bpm2 = b2;
        prog('Detecting tempo…', 0.50);
      })
      .catch(function (e) {
        if (e && e.kind === 'cancelled') throw e;
        bpmFallback = true;
        bpmNote = 'Tempo detection failed — using 100 BPM fallback.';
        prog('Detecting tempo…', 0.50);
      });

    /* ---- Stage 3: key match (on CLEAN vocals, BEFORE stretching) ----
       Key is pitch — stretching first would let WSOLA joins confuse the
       chromagram (mashup.js stage-3 root cause). Song 2's vocal is shifted
       onto Song 1's key; Song 1 stays the master. */
    chain = chain
      .then(function () { return stage('Matching key…', 0.51); })
      .then(function () {
        var p1 = dsp.detectKey(vocal1);
        var p2 = dsp.detectKey(vocal2);
        return Promise.all([Promise.resolve(p1), Promise.resolve(p2)]);
      })
      .then(function (keys) {
        key1 = keyLabel(keys[0]); key2 = keyLabel(keys[1]);
        var st = 0;
        try { st = dsp.semitonesBetween(keys[0], keys[1]); } catch (e) { st = 0; }
        if (!isFinite(st)) st = 0;
        semitones = Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, Math.round(st)));
        prog('Matching key…', 0.58);
      })
      .catch(function (e) {
        if (e && e.kind === 'cancelled') throw e;
        throw new Error('Key matching failed: ' + kindText(e));
      });

    /* ---- Stage 4: tempo match (stretch Song 2's vocal, then key-shift) ---- */
    var stretchRatio2 = 1;
    chain = chain
      .then(function () { return stage('Matching tempo…', 0.60); })
      .then(function () {
        stretchRatio2 = bpm1 / bpm2; // timeStretch clamps to [0.5, 2.0]
        var p = dsp.timeStretch(vocal2, stretchRatio2, function (q) {
          prog('Matching tempo…', 0.60 + q * 0.07);
        });
        return Promise.resolve(p);
      })
      .then(function (stretched) {
        if (isAudioBuffer(stretched)) vocal2 = stretched;
        prog('Matching tempo…', 0.67);
        if (semitones !== 0) {
          var pp = dsp.pitchShift(vocal2, semitones, function (q) {
            prog('Matching tempo…', 0.67 + q * 0.05);
          });
          return Promise.resolve(pp).then(function (shifted) {
            if (isAudioBuffer(shifted)) vocal2 = shifted;
          });
        }
      })
      .then(function () { prog('Matching tempo…', 0.72); })
      .catch(function (e) {
        if (e && e.kind === 'cancelled') throw e;
        throw new Error('Tempo matching failed: ' + kindText(e));
      });

    /* ---- Stage 5: built-in beat at the master BPM ---- */
    chain = chain
      .then(function () { return stage('Creating beat…', 0.73); })
      .then(function () {
        picked = pickAutoStyle(beats, bpm1);
        var barLen = Math.max(1, Math.round((240 / bpm1) * sr));
        var totalBars = SWAP_INTRO_BARS + SWAP_SEG_BARS * SWAP_CYCLES * 2 + SWAP_OUTRO_BARS;
        var totalLen = totalBars * barLen;
        prog('Creating beat…', 0.75);
        return renderBeatTiled(beats, picked, bpm1, totalLen, sr);
      })
      .then(function (bb) {
        beatBuf = bb;
        prog('Creating beat…', 0.80);
      })
      .catch(function (e) {
        if (e && e.kind === 'cancelled') throw e;
        throw new Error('Beat creation failed: ' + kindText(e));
      });

    /* ---- Stage 6: timeline — arrange module, or built-in fallback ---- */
    chain = chain
      .then(function () { return stage('Arranging vocals…', 0.81); })
      .then(function () {
        var vocalSegs = [vocal1, vocal2]; // stretched + key-matched, at sr
        var useArrange = RM.mashupArrange &&
          typeof RM.mashupArrange.buildTimeline === 'function';
        if (useArrange) {
          arrangeBy = 'RM.mashupArrange.buildTimeline';
          var opts = {
            bpm: bpm1, sr: sr,
            introBars: SWAP_INTRO_BARS, outroBars: SWAP_OUTRO_BARS,
            segBars: SWAP_SEG_BARS, xfadeBars: SWAP_XFADE_BARS,
            cycles: SWAP_CYCLES, vocalBoostDb: VOCAL_OVER_BED_DB,
            onProgress: function (label, frac) { prog('Arranging vocals…', 0.81 + (frac || 0) * 0.17); },
            token: token,
          };
          var r;
          try {
            r = RM.mashupArrange.buildTimeline(vocalSegs, beatBuf, opts);
          } catch (e) {
            if (e && e.kind === 'cancelled') throw e;
            throw new Error('Vocal arrangement failed: ' + kindText(e));
          }
          return Promise.resolve(r).then(function (res) {
            var b = isAudioBuffer(res) ? res :
              (res && isAudioBuffer(res.buffer) ? res.buffer : null);
            if (!b || !b.length)
              throw new Error('Vocal arrangement failed: the arrange module returned no audio.');
            return b;
          });
        }
        // Defensive fallback — the arrange module is not loaded (yet).
        arrangeBy = 'built-in fallback';
        return fallbackTimeline(dsp, vocalSegs, beatBuf, bpm1, sr, function (q) {
          prog('Arranging vocals…', q); // q already 0.85..0.97 inside the fallback
        });
      })
      .then(function (mixed) {
        outBuf = mixed;
        prog('Arranging vocals…', 0.98);
      })
      .catch(function (e) {
        if (e && e.kind === 'cancelled') throw e;
        if (e instanceof Error && /^Vocal arrangement failed/.test(e.message)) throw e;
        throw new Error('Vocal arrangement failed: ' + kindText(e));
      });

    /* ---- done: return the buffer — NEVER autoplay ---- */
    return chain.then(function () {
      throwIfCancelled(token);
      prog('Done', 1);
      return {
        buffer: outBuf,
        engineTags: { song1: tag1, song2: tag2 }, // honest provider tags
        meta: {
          bpm1: Math.round(bpm1 * 10) / 10,
          bpm2: Math.round(bpm2 * 10) / 10,
          targetBpm: Math.round(bpm1 * 10) / 10, // master = Song 1's BPM
          style: 'swap',
          styleId: picked && picked.id,
          styleName: picked && picked.name,
          stretchRatio2: Math.round(stretchRatio2 * 1000) / 1000,
          key1: key1,
          key2: key2,
          semitones: semitones,
          bpmFallback: bpmFallback,
          bpmNote: bpmNote,
          segBars: SWAP_SEG_BARS,
          xfadeBars: SWAP_XFADE_BARS,
          cycles: SWAP_CYCLES,
          introBars: SWAP_INTRO_BARS,
          outroBars: SWAP_OUTRO_BARS,
          arrangeBy: arrangeBy,
          engineTagSong1: tag1,
          engineTagSong2: tag2,
          // v23: explicit alternation + spec visibility for UI/tests
          swapOrder: [0, 1, 0, 1],
          vocalBoostDb: VOCAL_OVER_BED_DB,
          durationSec: Math.round(outBuf.duration * 10) / 10,
        },
      };
    });
  }

  return {
    build: build, // RM.mashupSwap.build(buf1, buf2, onProgress, token)
  };
})();

// Node unit tests (browser-harmless).
try {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { api: { build: RM.mashupSwap.build } };
  }
} catch (e) {}
