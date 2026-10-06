'use strict';
/* =====================================================================
   RuhMix — v26-vocal.js (worker I6)
   🎤 Vocal Chain panel + 7-band EQ UI for the Studio screen.

   WHAT IT DOES (all real DSP, "Smart" = on-device, never AI):
     - De-ess, harsh-tame, air/EQ, compression via RM.v25mix.processVocal
       (real dynamic 4–8 kHz / 2–5 kHz dips, 70 Hz HP, 3:1 comp).
     - 7-band vocal EQ via RM.fx.eq7 (real biquads, buffer domain).
     - Reverb send (generated-IR convolver) + delay send (echo taps).
     - Sidechain ducking toggle: the REAL ducking recurrence from the
       mashup render (10 ms attack / 250 ms release envelope, 2 s peak
       tracker, squared, max −3 dB) applied to the instrumental under the
       processed vocal. OFF = skipped entirely.
     - "Apply to vocal" targets the Studio's vocal audio:
         * if stem lanes were extracted → the vocals stem lane (true
           isolated vocal), rebuilt with the instrumental lane;
         * else → the Studio's vocal sections of the mix (delta approach:
           only the *change* from vocal processing is added, so the dry
           stereo image is preserved).
       The result commits through the Studio bridge (replaceCurrent), so
       it is audible in Studio preview and present in export.
     - Undo: uses window.__v26pushUndo/__v26undo when another v26 worker
       created them; otherwise this file's own mini-stack (published under
       the same names so later workers can share it).

   HONEST LABELS: "Smart DSP" everywhere; no "AI" claims. The "Air" vocal
   knob from the brief IS the 7-band EQ's Air slider (14 kHz highshelf) —
   one parameter, one slider, no duplicates.

   Node-testable: pure DSP via the module.exports hook at the bottom.
   ===================================================================== */
window.RM = window.RM || {};
(function (global) {
  'use strict';
  var RM = global.RM || (global.RM = {});
  var V = {}; // public namespace RM.v26vocal

  /* ================= tiny utils (pure) ================= */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dbToLin(db) { return Math.pow(10, db / 20); }
  function shimBuffer(nCh, len, sr) {
    var chans = [], c;
    for (c = 0; c < nCh; c++) chans.push(new Float32Array(Math.max(1, len)));
    return {
      numberOfChannels: nCh, length: Math.max(1, len), sampleRate: sr,
      duration: Math.max(1, len) / sr,
      getChannelData: function (ch) { return chans[ch]; },
    };
  }
  function allocBuf(nCh, len, sr) {
    try {
      if (RM.audio && typeof RM.audio.ensureCtx === 'function') {
        var ctx = RM.audio.ensureCtx();
        if (ctx && typeof ctx.createBuffer === 'function')
          return ctx.createBuffer(nCh, Math.max(1, len), sr);
      }
    } catch (e) { /* fall through */ }
    return shimBuffer(nCh, len, sr);
  }
  function dupBuf(b) {
    var o = allocBuf(b.numberOfChannels, b.length, b.sampleRate), ch;
    for (ch = 0; ch < b.numberOfChannels; ch++)
      o.getChannelData(ch).set(b.getChannelData(ch));
    return o;
  }
  function monoMean(b) {
    var n = b.length, nCh = b.numberOfChannels, out = new Float32Array(n), ch, i;
    for (ch = 0; ch < nCh; ch++) {
      var d = b.getChannelData(ch);
      for (i = 0; i < n; i++) out[i] += d[i];
    }
    for (i = 0; i < n; i++) out[i] /= nCh;
    return out;
  }
  function maxAbsArr(x) {
    var m = 0, i;
    for (i = 0; i < x.length; i++) { var a = x[i] < 0 ? -x[i] : x[i]; if (a > m) m = a; }
    return m;
  }
  function rmsArr(x) {
    var s = 0, i;
    for (i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, x.length));
  }
  // Goertzel-ish band energy: correlate with sine/cosine at band centre.
  function bandEnergy(x, sr, f0, f1) {
    var fc = Math.sqrt(f0 * f1), n = x.length, i;
    var sr_ = 0, si_ = 0;
    for (i = 0; i < n; i++) {
      var ph = 2 * Math.PI * fc * i / sr;
      sr_ += x[i] * Math.cos(ph); si_ += x[i] * Math.sin(ph);
    }
    return Math.sqrt(sr_ * sr_ + si_ * si_) / n;
  }
  function crestFactor(x) {
    var r = rmsArr(x);
    return r > 1e-9 ? maxAbsArr(x) / r : 0;
  }

  /* ================= feedforward peak compressor (pure) =================
     Same family as the v25 mix/master chain: peak envelope follower,
     threshold/ratio gain computer. Amount 0–100 → threshold −30…−6 dB,
     ratio 1.5:1…6:1. */
  function compressMono(x, sr, amount) {
    var a = clamp(amount, 0, 100) / 100;
    var thrDb = -30 + 24 * a, ratio = 1.5 + 4.5 * a;
    var attackSec = 0.010, releaseSec = 0.100;
    var thr = dbToLin(thrDb);
    var aA = 1 - Math.exp(-1 / (attackSec * sr));
    var aR = 1 - Math.exp(-1 / (releaseSec * sr));
    var inv = 1 - 1 / ratio;
    var out = new Float32Array(x.length), env = 0, maxGr = 0, i;
    for (i = 0; i < x.length; i++) {
      var v = x[i] < 0 ? -x[i] : x[i];
      var c = v > env ? aA : aR;
      env += c * (v - env);
      var g = 1;
      if (env > thr && env > 1e-9) {
        var gr = 20 * Math.log10(env / thr) * inv;
        if (gr > maxGr) maxGr = gr;
        g = dbToLin(-gr);
      }
      out[i] = x[i] * g;
    }
    return { out: out, maxGrDb: maxGr };
  }

  /* ================= reverb send (pure IR + convolver) ================= */
  function makeReverbIR(sr, durSec, decayPow) {
    var len = Math.max(1, Math.floor(sr * durSec));
    var ir = new Float32Array(len), i;
    for (i = 0; i < len; i++) {
      var t = i / len;
      ir[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayPow);
    }
    return ir;
  }
  function naiveConvolve(x, ir) {
    var n = x.length, m = ir.length, y = new Float32Array(n), i, j;
    for (i = 0; i < n; i++) {
      var s = 0, kmax = Math.min(m, n - i);
      for (j = 0; j < kmax; j++) s += x[i + j] * ir[j];
      y[i] = s;
    }
    return y;
  }
  function irBuffer(ir, sr) {
    var OC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    var oc = new OC(1, ir.length, sr);
    oc.createBuffer(1, ir.length, sr).getChannelData(0).set(ir);
    return { oc: oc, buf: oc.createBuffer(1, ir.length, sr) };
  }
  // Wet reverb tail for a mono signal. Browser: real convolver in an
  // OfflineAudioContext. Node (no OfflineAudioContext): naive convolution
  // (test path — short buffers only).
  function reverbWet(x, sr, wet, irSec, decayPow) {
    var ir = makeReverbIR(sr, irSec || 1.6, decayPow || 2.4);
    function scale(y) {
      for (var i = 0; i < y.length; i++) y[i] *= wet;
      return y;
    }
    var OC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (typeof OC === 'function' && typeof document !== 'undefined') {
      return new Promise(function (res, rej) {
        try {
          var oc = new OC(1, x.length, sr);
          var xb = oc.createBuffer(1, x.length, sr);
          xb.getChannelData(0).set(x);
          var ib = oc.createBuffer(1, ir.length, sr);
          ib.getChannelData(0).set(ir);
          var src = oc.createBufferSource(); src.buffer = xb;
          var cv = oc.createConvolver(); cv.buffer = ib;
          src.connect(cv); cv.connect(oc.destination);
          src.start(0);
          oc.startRendering().then(function (rb) {
            res(scale(rb.getChannelData(0)));
          }, rej);
        } catch (e) { rej(e); }
      });
    }
    return Promise.resolve(scale(naiveConvolve(x, ir)));
  }

  /* ================= delay send (pure) =================
     Echo taps: delaySec spacing, geometric feedback decay. */
  function delaySend(x, sr, wet, delaySec, feedback, taps) {
    var D = Math.max(1, Math.round((delaySec || 0.375) * sr));
    var fb = feedback == null ? 0.35 : feedback;
    var T = taps || 4, n = x.length;
    var out = new Float32Array(n), t, i;
    for (t = 1; t <= T; t++) {
      var off = D * t, g = wet * Math.pow(fb, t - 1);
      if (off >= n) break;
      for (i = off; i < n; i++) out[i] += x[i - off] * g;
    }
    return out;
  }

  /* ================= sidechain duck (pure) =================
     The REAL mashup-render recurrence (mashup-arrange.js): vocal mono
     envelope, 10 ms attack / 250 ms release, 2 s peak tracker,
     peak-normalised, squared (subtle, never pumping), max −3 dB. */
  function duckGains(vocalMono, sr, maxDuckDb) {
    var md = maxDuckDb == null ? 3 : maxDuckDb;
    var aA = 1 - Math.exp(-1 / (0.010 * sr));
    var aR = 1 - Math.exp(-1 / (0.250 * sr));
    var relPk = 1 - Math.exp(-1 / (2.0 * sr));
    var duckLin = Math.pow(10, -md / 20);
    var g = new Float32Array(vocalMono.length), e = 0, pk = 0, i;
    for (i = 0; i < g.length; i++) {
      var av = vocalMono[i] < 0 ? -vocalMono[i] : vocalMono[i];
      var c = av > e ? aA : aR;
      e += c * (av - e);
      if (e > pk) pk = e; else pk += relPk * (e - pk);
      var amt = pk > 1e-6 ? e / pk : 0;
      if (amt > 1) amt = 1;
      amt *= amt;
      g[i] = 1 - (1 - duckLin) * amt;
    }
    return g;
  }
  function applyDuck(buf, gains) {
    var out = dupBuf(buf), nCh = out.numberOfChannels, ch, i;
    var n = Math.min(out.length, gains.length);
    for (ch = 0; ch < nCh; ch++) {
      var d = out.getChannelData(ch);
      for (i = 0; i < n; i++) d[i] *= gains[i];
    }
    return out;
  }
  function softLimit(buf, ceiling) {
    ceiling = ceiling || 0.71;
    var peak = 0, ch, i, d;
    for (ch = 0; ch < buf.numberOfChannels; ch++) {
      d = buf.getChannelData(ch);
      for (i = 0; i < d.length; i++) { var a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    if (peak > ceiling) {
      var g = ceiling / peak;
      for (ch = 0; ch < buf.numberOfChannels; ch++) {
        d = buf.getChannelData(ch);
        for (i = 0; i < d.length; i++) d[i] *= g;
      }
    }
    return buf;
  }
