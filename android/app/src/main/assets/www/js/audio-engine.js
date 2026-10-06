'use strict';
/* =====================================================================
   RuhMix — audio-engine.js
   Web Audio core: context + master graph, DSP helpers (impulse response,
   BPM detect, waveform peaks, WAV encode), chunked processing helpers,
   transport player, and the guarded Android native bridge wrapper.
   No DOM access at load time. All heavy DSP is chunked so the UI thread
   never blocks; temp buffers are nulled after use.
   ===================================================================== */
window.RM = window.RM || {};

RM.audio = (function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let ctx = null;
  let master = null, analyser = null, limiter = null;
  let liteIRCap = 2.2; // seconds; reverb IR cap (mono IR => cheap convolution)

  /* ---------- context & master graph ---------- */
  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API not supported on this device.');
      ctx = new AC();
      buildMaster();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Master chain: everything flows master -> analyser -> limiter -> clipper
  // -> destination. The limiter is a hard-knee brickwall-style compressor
  // (20:1, zero knee): with stacked EQ boosts (+15dB/band), wet FX sends and
  // multi-track mixer sums, a soft limiter can still let peaks past 0dBFS
  // (digital clipping at the DAC).
  // The clipper is the TRUE ceiling and is load-bearing, not decoration.
  // MEASURED (Chrome 154, OfflineAudioContext, 2026-10): a
  // DynamicsCompressor alone is NOT a true brickwall, even at 20:1/zero
  // knee — it lifts everything below threshold by +0.85 dB (sine AND
  // music-like signals) and lets attack transients overshoot (+18 dB in ->
  // +0.71 dBFS out). A knee sweep (0..30) proved no knee setting fixes both
  // at once (soft knees that remove the lift let +14 dB through instead).
  // The WaveShaper clipper below leaves audio under ±0.98 untouched (float
  // rounding only, ≤1e-6, inaudible) and clamps the absolute ceiling to
  // 0.9952 (-0.04 dBFS) no matter what feeds it.
  // Never wire sources directly to destination.
  function buildMaster() {
    master = ctx.createGain();
    master.gain.value = 1.0;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    const clipper = createSafetyClipper(ctx);
    master.connect(analyser);
    analyser.connect(limiter);
    limiter.connect(clipper);
    clipper.connect(ctx.destination);
  }

  function masterIn() { ensureCtx(); return master; }
  function setMasterVolume(v) { // v: 0..1
    ensureCtx();
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(clamp(v, 0, 1), t, 0.015); // click-free
  }
  function getAnalyser() { ensureCtx(); return analyser; }
  function sampleRate() { ensureCtx(); return ctx.sampleRate; }

  /* ---------- safety clipper (the true ceiling) ---------- */
  // Identity for |x| <= 0.98, smooth tanh ceiling above it. Max output is
  // 0.98 + 0.02*tanh(1) = 0.9952 (-0.04 dBFS); WaveShaper clamps inputs
  // beyond ±1 to the endpoint values, so the absolute ceiling holds no
  // matter how hot the input is. Derivative is continuous at ±0.98
  // (tanh'(0) = 1), so the transition is click-free.
  function safetyClipperCurve() {
    const n = 1024, curve = new Float32Array(n), T = 0.98, R = 1 - T;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const ax = Math.abs(x);
      curve[i] = ax <= T ? x : Math.sign(x) * (T + R * Math.tanh((ax - T) / R));
    }
    return curve;
  }
  // Works with any BaseAudioContext (realtime or OfflineAudioContext).
  function createSafetyClipper(c) {
    const w = c.createWaveShaper();
    w.curve = safetyClipperCurve();
    w.oversample = 'none';
    return w;
  }

  /* ---------- chunked processing ---------- */
  // Runs fn(start, end) over [0, total) in slices of chunkSize, yielding to
  // the UI thread between slices. Resolves when done. onProgress(0..1).
  function runChunked(total, chunkSize, fn, onProgress) {
    return new Promise((resolve, reject) => {
      let i = 0;
      const step = () => {
        try {
          const end = Math.min(total, i + chunkSize);
          fn(i, end);
          i = end;
          if (onProgress) onProgress(i / total);
          if (i < total) setTimeout(step, 0);
          else resolve();
        } catch (e) { reject(e); }
      };
      step();
    });
  }

  /* ---------- impulse response (mono, capped) ---------- */
  // Mono IR: ConvolverNode upmixes to stereo automatically. A long stereo IR
  // is the #1 cause of stutter on budget phones; mono + cap keeps it cheap.
  function buildImpulse(durSec, decayPow) {
    ensureCtx();
    const dur = Math.min(Math.max(0.1, durSec || 1.8), liteIRCap);
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * dur));
    const ir = ctx.createBuffer(1, len, sr);
    const d = ir.getChannelData(0);
    const pw = decayPow || 2.5;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, pw);
    }
    return ir;
  }

  /* ---------- waveform peaks (chunked) ---------- */
  function computePeaks(buffer, cols, onProgress) {
    cols = Math.max(64, Math.min(4096, cols || 800));
    const peaks = new Float32Array(cols);
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const per = Math.max(1, Math.floor(buffer.length / cols));
    return runChunked(cols, 64, (a, b) => {
      for (let c = a; c < b; c++) {
        let sum = 0, n = 0;
        const off = c * per;
        for (let i = 0; i < per && off + i < buffer.length; i += 16) {
          sum += Math.abs(ch0[off + i]) + (ch1 ? Math.abs(ch1[off + i]) : 0);
          n++;
        }
        peaks[c] = clamp((sum / Math.max(1, n)) * (ch1 ? 1.6 : 3.2), 0, 1);
      }
    }, onProgress).then(() => peaks);
  }

  /* ---------- BPM detect (own implementation, onset-energy based) ---------- */
  // Mono mixdown of first 60s -> hop-512 onset envelope (sum of positive
  // amplitude differences) -> autocorrelation over integer lags covering
  // 60..200 BPM -> parabolic interpolation around the best lag for sub-BPM
  // accuracy. Env computation is chunked to keep UI smooth.
  // HONESTY (w26): returns null on digital silence (zero onset energy) —
  // callers must handle null (v25-create shows "BPM —"; the mega/swap/
  // classic engines fall back to 100 BPM internally and say so).
  function detectBPM(buffer, onProgress) {
    const sr = buffer.sampleRate;
    const len = Math.floor(Math.min(buffer.duration, 60) * sr);
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const hop = 512;
    const frames = Math.max(8, Math.floor(len / hop));
    const env = new Float32Array(frames);
    // prev MUST persist across chunks: resetting it per chunk injects a
    // phantom onset spike at every chunk boundary (~3s), biasing BPM.
    let prev = 0;
    return runChunked(frames, 256, (a, b) => {
      for (let i = a; i < b; i++) {
        let sum = 0;
        const off = i * hop;
        for (let n = 0; n < hop && off + n < len; n++) {
          const x = Math.abs((ch0[off + n] + ch1[off + n]) * 0.5);
          sum += Math.max(0, x - prev);
          prev = x;
        }
        env[i] = sum;
      }
    }, onProgress ? (p) => onProgress(p * 0.9) : null).then(() => {
      let r0 = 0;
      for (let i = 0; i < frames; i++) r0 += env[i] * env[i];
      // w26: digital silence (or pure DC) carries no tempo information —
      // report null instead of inventing 120 BPM.
      if (!isFinite(r0) || r0 === 0) { if (onProgress) onProgress(1); return null; }
      const minLag = Math.max(1, Math.round((60 / 200) * sr / hop));
      const maxLag = Math.min(frames - 1, Math.round((60 / 60) * sr / hop));
      const Rs = new Float64Array(maxLag + 2);
      let bestLag = minLag, bestR = -1;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let r = 0;
        for (let i = 0; i + lag < frames; i++) r += env[i] * env[i + lag];
        Rs[lag] = r;
        if (r > bestR) { bestR = r; bestLag = lag; }
      }
      // Octave disambiguation (Round-6, W7): half-lag (double tempo) ka
      // correlation agar best ke 90% ke andar hai to tez tempo chuno —
      // click/hat-sparse material me autocorrelation 2x lag pe tie/jeet
      // jata hai (128->64, 150->75 measured).
      const halfLag = Math.round(bestLag / 2);
      if (halfLag >= minLag && Rs[halfLag] > 0.9 * bestR) { bestLag = halfLag; bestR = Rs[halfLag]; }
      // Parabolic interpolation around the peak lag (sub-hop accuracy)
      let refined = bestLag;
      if (bestLag > minLag && bestLag < maxLag) {
        const y0 = Rs[bestLag - 1], y1 = Rs[bestLag], y2 = Rs[bestLag + 1];
        const denom = y0 - 2 * y1 + y2;
        if (denom < -1e-12) refined = bestLag + 0.5 * (y0 - y2) / denom;
      }
      const bpm = clamp(Math.round((60 / refined) * sr / hop), 60, 200);
      if (onProgress) onProgress(1);
      return bpm;
    });
  }

  /* ---------- decode / encode ---------- */
  function decodeArrayBuffer(ab) {
    ensureCtx();
    return ctx.decodeAudioData(ab.slice(0));
  }

  // 16-bit PCM stereo WAV. Chunked to avoid blocking on long mixes.
  // opts: {dither: true} — TPDF dither when reducing 32-bit float to 16-bit.
  function encodeWavBuffer(buf, onProgress, opts) {
    const sr = buf.sampleRate, len = buf.length;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const dv = new DataView(new ArrayBuffer(44 + len * 4));
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + len * 4, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, len * 4, true);
    const dRng = (opts && opts.dither) ? mulberry32(0xD17E) : null;
    return runChunked(len, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        dv.setInt16(44 + i * 4, quant16(ch0[i], dRng), true);
        dv.setInt16(44 + i * 4 + 2, quant16(ch1[i], dRng), true);
      }
    }, onProgress).then(() => dv.buffer);
  }

  // Deterministic PRNG (mulberry32) for TPDF dither: a fixed seed per call
  // keeps chunked conversion reproducible across runs while the noise stays
  // decorrelated sample-to-sample. (No crypto needed — this is audio dither.)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Float (-1..1) -> int16 sample. opts.dither: TPDF dither (±1 LSB,
  // triangular) + round instead of plain truncation — audibly cleaner fades
  // and reverb tails when reducing 32-bit float to 16-bit. Default off
  // (callers opt in) so non-export paths keep their exact old behavior.
  function quant16(x, dRng) {
    const c = clamp(x, -1, 1);
    if (!dRng) return Math.trunc(c * 0x7FFF);
    const tpdf = (dRng() + dRng() - 1); // triangular in [-1, 1) LSB
    const v = Math.round(c * 32768 + tpdf);
    return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  }

  // Float -> Int16 (for lamejs), chunked. Returns {left, right} Int16Arrays.
  // opts: {dither: true} — TPDF dither when reducing bit depth (export).
  function floatToInt16(buf, onProgress, opts) {
    const len = buf.length;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const left = new Int16Array(len), right = new Int16Array(len);
    const dRng = (opts && opts.dither) ? mulberry32(0xD17E) : null;
    return runChunked(len, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        left[i] = quant16(ch0[i], dRng);
        right[i] = quant16(ch1[i], dRng);
      }
    }, onProgress).then(() => ({ left, right }));
  }

  // Linear-interp resample to targetRate (needed when source SR != 44100 for
  // MP3), chunked. Returns a new AudioBuffer.
  function resampleBuffer(buf, targetRate, onProgress) {
    if (buf.sampleRate === targetRate) return Promise.resolve(buf);
    ensureCtx();
    const ratio = buf.sampleRate / targetRate;
    const newLen = Math.max(1, Math.floor(buf.length / ratio));
    const out = ctx.createBuffer(buf.numberOfChannels, newLen, targetRate);
    const jobs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c), dst = out.getChannelData(c);
      jobs.push(runChunked(newLen, 1 << 18, (a, b) => {
        // Cubic Hermite interpolation (linear se behtar): linear me 44.1k->48k pe
        // -3.44dB @15kHz dulling aur imaging artifacts the (HPSS return path live hai).
        for (let i = a; i < b; i++) {
          const p = i * ratio;
          const i0 = Math.floor(p), f = p - i0;
          const s0 = src[Math.max(0, i0 - 1)] || 0, s1 = src[i0] || 0;
          const s2 = src[Math.min(buf.length - 1, i0 + 1)] || 0, s3 = src[Math.min(buf.length - 1, i0 + 2)] || 0;
          const c1 = 0.5 * (s2 - s0), c2 = s0 - 2.5 * s1 + 2 * s2 - 0.5 * s3, c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
          dst[i] = ((c3 * f + c2) * f + c1) * f + s1;
        }
      }));
    }
    return Promise.all(jobs).then(() => {
      if (onProgress) onProgress(1);
      return out;
    });
  }

  function arrayBufferToBase64(ab, onProgress) {
    const bytes = new Uint8Array(ab);
    const chunks = [];
    return runChunked(bytes.length, 0x8000, (a, b) => {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(a, b)));
    }, onProgress).then(() => btoa(chunks.join('')));
  }

  // Peak-normalize an AudioBuffer in place (chunked). Returns peak found.
  function normalizeBuffer(buf, target, onProgress) {
    target = target || 0.95;
    let peak = 0;
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    return runChunked(buf.length, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++)
        for (let c = 0; c < chs.length; c++) {
          const v = Math.abs(chs[c][i]);
          if (v > peak) peak = v;
        }
    }, onProgress ? (p) => onProgress(p * 0.5) : null).then(() => {
      if (peak < 1e-6) { if (onProgress) onProgress(1); return 0; }
      const g = target / peak;
      return runChunked(buf.length, 1 << 18, (a, b) => {
        for (let i = a; i < b; i++)
          for (let c = 0; c < chs.length; c++) chs[c][i] *= g;
      }, onProgress ? (p) => onProgress(0.5 + p * 0.5) : null).then(() => peak);
    });
  }

  /* ---------- transport player ---------- */
  // A reusable one-shot player: source -> panner -> gain -> insertPoint.
  // insertPoint is the node the caller wires into their FX chain.
  function makePlayer() {
    ensureCtx();
    const FADE_TC = 0.008;  // click-free envelope time constant (start/stop)
    const FADE_STOP = 0.08; // source stopped this long after the fade begins
    const p = {
      buffer: null, src: null, env: null, panner: null, gain: null,
      playing: false, startCtxTime: 0, offset: 0, rate: 1,
      loop: false, loopStart: 0, loopEnd: 0,
      onended: null, _token: 0, _vol: 1, _pan: 0,
      insert: null, // connect this into your chain
    };
    p.panner = ctx.createStereoPanner();
    p.gain = ctx.createGain();
    p.insert = ctx.createGain(); // entry point for caller's FX chain
    p.insert.connect(p.panner);
    p.panner.connect(p.gain);
    p.gain.connect(master);
    p.load = (buffer) => {
      p.stop(true); p.buffer = buffer; p.offset = 0;
      // Loop-range refresh: if loop is ON and a new (shorter/longer) buffer
      // arrives, the old loopEnd goes stale — the audio wraps at the buffer
      // duration but position() keeps counting to the old loopEnd (playhead
      // drift). With no custom region the loop covers the whole buffer.
      // v27 W3: a custom loop region (set via setLoop) is KEPT and clamped
      // to the new buffer instead of being silently reset to whole-buffer.
      if (p.loop && buffer) {
        if (p.loopEnd > p.loopStart) {
          p.loopStart = clamp(p.loopStart, 0, buffer.duration);
          p.loopEnd = clamp(p.loopEnd, p.loopStart, buffer.duration);
          if (!(p.loopEnd > p.loopStart)) { p.loopStart = 0; p.loopEnd = buffer.duration; }
        } else { p.loopStart = 0; p.loopEnd = buffer.duration; }
      }
    };
    p.play = (fromSec) => {
      if (!p.buffer) return false;
      p.stop(true);
      p.src = ctx.createBufferSource();
      p.src.buffer = p.buffer;
      p.src.playbackRate.value = p.rate;
      // Re-apply stored live params: a renderer's setTargetAtTime automation
      // can be dropped when no source is active (e.g. slider moved long after
      // stop). Re-applying here is click-free — the env node is at 0 and
      // ramps up over FADE_TC, so the direct assignment is inaudible.
      p.gain.gain.value = p._vol;
      p.panner.pan.value = p._pan;
      const t0 = clamp(fromSec != null ? fromSec : p.offset, 0, p.buffer.duration);
      const token = ++p._token;
      p.src._token = token;
      p.src.onended = () => {
        const s = p.src, e = p.env;
        if (s && s._token === token) {
          p.playing = false; p.offset = 0;
          try { s.disconnect(); } catch (e2) {}
          try { if (e) e.disconnect(); } catch (e2) {}
          if (p.src === s) { p.src = null; p.env = null; }
          if (p.onended) p.onended();
        }
      };
      // Per-source envelope: starting/stopping a buffer mid-waveform at full
      // gain is an audible click. The env node ramps 0->1 on start; stop()
      // ramps it back down before stopping the source. Kept per-source (not
      // on the shared gain) so a rapid seek becomes a clean crossfade.
      p.env = ctx.createGain();
      p.env.gain.value = 0;
      const tNow = ctx.currentTime;
      p.env.gain.setTargetAtTime(1, tNow, FADE_TC);
      if (p.loop && p.loopEnd > p.loopStart) {
        p.src.loop = true; p.src.loopStart = p.loopStart; p.src.loopEnd = p.loopEnd;
        p.src.connect(p.env);
        p.env.connect(p.insert);
        p.src.start(tNow, t0);
      } else {
        p.src.connect(p.env);
        p.env.connect(p.insert);
        p.src.start(tNow, t0, Math.max(0.05, p.buffer.duration - t0));
      }
      p.playing = true;
      p.offset = t0;
      p.startCtxTime = tNow;
      return true;
    };
    p.pause = () => {
      if (!p.playing) return;
      p.offset = p.position();
      p.stop(true);
    };
    p.stop = (silent) => {
      p._token++;
      const s = p.src, e = p.env;
      p.src = null; p.env = null;
      p.playing = false;
      if (s) {
        try { s.onended = null; } catch (e2) {}
        try {
          const t = ctx.currentTime;
          if (e) e.gain.setTargetAtTime(0.0001, t, FADE_TC);
          s.stop(t + FADE_STOP);
          setTimeout(() => {
            try { s.disconnect(); } catch (e2) {}
            try { if (e) e.disconnect(); } catch (e2) {}
          }, 160);
        } catch (e2) {
          try { s.stop(); } catch (e3) {}
          try { s.disconnect(); } catch (e3) {}
          try { if (e) e.disconnect(); } catch (e3) {}
        }
      }
      if (!silent && p.onended) p.onended();
    };
    p.position = () => {
      if (!p.playing || !p.buffer) return clamp(p.offset, 0, p.buffer ? p.buffer.duration : 0);
      let pos = p.offset + (ctx.currentTime - p.startCtxTime) * p.rate;
      if (p.loop && p.loopEnd > p.loopStart) {
        pos = p.loopStart + ((pos - p.loopStart) % Math.max(0.01, p.loopEnd - p.loopStart));
      }
      return clamp(pos, 0, p.buffer.duration);
    };
    p.setRate = (r) => {
      r = clamp(r, 0.25, 4);
      // Snapshot position BEFORE changing rate: position() assumes the
      // current rate held since startCtxTime, so a mid-playback rate change
      // without a snapshot makes pause()/playhead jump.
      if (p.playing) { p.offset = p.position(); p.startCtxTime = ctx.currentTime; }
      p.rate = r;
      if (p.src) p.src.playbackRate.setTargetAtTime(p.rate, ctx.currentTime, 0.01);
    };
    p.setVolume = (v) => {
      p._vol = clamp(v, 0, 1.5);
      p.gain.gain.setTargetAtTime(p._vol, ctx.currentTime, 0.01);
    };
    p.setPan = (pan) => {
      p._pan = clamp(pan, -1, 1);
      p.panner.pan.setTargetAtTime(p._pan, ctx.currentTime, 0.01);
    };
    // Live loop toggle: works mid-playback too (AudioBufferSourceNode.loop /
    // loopStart / loopEnd may be changed at any time). Just flipping p.loop
    // leaves a playing source unlooped until the next play() — this applies
    // it to the live source immediately.
    p.setLoop = (on, start, end) => {
      p.loop = !!on;
      if (start != null) p.loopStart = Math.max(0, start);
      if (end != null) p.loopEnd = Math.max(0, end);
      if (p.src) {
        p.src.loop = p.loop;
        if (p.loop && p.loopEnd > p.loopStart) {
          p.src.loopStart = p.loopStart;
          p.src.loopEnd = p.loopEnd;
        }
      }
    };
    p.dispose = () => {
      p.stop(true);
      [p.insert, p.panner, p.gain].forEach(n => { try { n.disconnect(); } catch (e) {} });
      p.buffer = null;
    };
    return p;
  }

  /* ---------- guarded native bridge ---------- */
  const native = {
    has: () => (typeof window.Android !== 'undefined' && window.Android !== null),
    method: (name) => native.has() && typeof window.Android[name] === 'function',
    call: (name, ...args) => {
      if (!native.method(name)) return null;
      try { return window.Android[name](...args); }
      catch (e) { return null; }
    },
  };

  return {
    clamp,
    ensureCtx, masterIn, setMasterVolume, getAnalyser, sampleRate,
    setLiteIRCap: (s) => { liteIRCap = s; },
    runChunked, buildImpulse, computePeaks, detectBPM,
    decodeArrayBuffer, encodeWavBuffer, floatToInt16, resampleBuffer,
    arrayBufferToBase64, normalizeBuffer,
    createSafetyClipper,
    makePlayer, native,
  };
})();
