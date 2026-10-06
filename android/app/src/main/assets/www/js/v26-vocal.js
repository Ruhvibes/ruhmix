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
     Second-stage "glue" compressor after processVocal's fixed 3:1@−18 dB
     stage. Amount 0–100 → threshold −34…−18 dB, ratio 1.5:1…6:1, so high
     amounts still bite on what the first stage left behind. */
  function compressMono(x, sr, amount) {
    var a = clamp(amount, 0, 100) / 100;
    if (a <= 0) { // knob at 0 = true bypass
      var cp = new Float32Array(x.length); cp.set(x);
      return { out: cp, maxGrDb: 0 };
    }
    var thrDb = -34 + 16 * a, ratio = 1.5 + 4.5 * a;
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
    // Proper (causal) convolution: y[i] = sum_j x[i-j] * ir[j].
    // Node-test fallback for short buffers; the browser path uses a real
    // OfflineAudioContext convolver instead.
    var n = x.length, m = ir.length, y = new Float32Array(n), i, j;
    for (i = 0; i < n; i++) {
      var s = 0, jmax = Math.min(m, i + 1);
      for (j = 0; j < jmax; j++) s += x[i - j] * ir[j];
      y[i] = s;
    }
    return y;
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

  /* ================= vocal chain (pure, async for reverb) =================
     opts: { deess:0-100, harsh:0-100, comp:0-100, eq7:{bandId:db},
             reverb:0-100, delay:0-100 }
     Input: mono Float32Array. Returns { proc, rev, dly, meta } where
       proc = processed dry vocal, rev/dly = wet send signals (mono). */
  function processVocalChain(x, sr, opts) {
    opts = opts || {};
    if (!RM.v25mix || typeof RM.v25mix.processVocal !== 'function')
      return Promise.reject(new Error('vocal engine (v25mix) not loaded'));
    if (!RM.fx || !RM.fx.eq7)
      return Promise.reject(new Error('EQ engine (fx.eq7) not loaded'));
    var meta = { deessDips: 0, deessMaxDb: 0, harshDips: 0, harshMaxDb: 0, compGrDb: 0 };
    // processVocal needs an AudioBuffer-like; wrap the mono signal.
    var inBuf = shimBuffer(2, x.length, sr);
    inBuf.getChannelData(0).set(x);
    inBuf.getChannelData(1).set(x);
    var deess = clamp(opts.deess || 0, 0, 100);
    var harsh = clamp(opts.harsh || 0, 0, 100);
    var pv = RM.v25mix.processVocal(inBuf, {
      deess: deess > 0 ? { maxDipDb: deess / 100 * 10, thrFactor: 0.4 } : { maxDipDb: 0, thrFactor: 10 },
      harsh: harsh > 0 ? { maxDipDb: harsh / 100 * 6, thrFactor: 0.5 } : { maxDipDb: 0, thrFactor: 10 },
    });
    meta.deessDips = pv.meta.deess.dips; meta.deessMaxDb = pv.meta.deess.maxDipDb;
    meta.harshDips = pv.meta.harshTame.dips; meta.harshMaxDb = pv.meta.harshTame.maxDipDb;
    var proc = new Float32Array(x.length);
    proc.set(pv.buffer.getChannelData(0).subarray(0, x.length));
    // 7-band EQ (buffer domain, real biquads) on the processed vocal.
    var eqTmp = shimBuffer(1, proc.length, sr);
    eqTmp.getChannelData(0).set(proc);
    var eqOut = RM.fx.eq7.applyToBuffer(eqTmp, opts.eq7 || {});
    proc.set(eqOut.getChannelData(0).subarray(0, proc.length));
    // Compressor amount knob.
    var comp = clamp(opts.comp || 0, 0, 100);
    if (comp > 0) {
      var cr = compressMono(proc, sr, comp);
      proc = cr.out; meta.compGrDb = Math.round(cr.maxGrDb * 10) / 10;
    }
    // Sends (wet only; dry stays in proc).
    var revAmt = clamp(opts.reverb || 0, 0, 100) / 100 * 0.5;
    var dlyAmt = clamp(opts.delay || 0, 0, 100) / 100 * 0.45;
    var revP = revAmt > 0 ? reverbWet(proc, sr, revAmt, 1.6, 2.4)
                          : Promise.resolve(new Float32Array(proc.length));
    var dly = dlyAmt > 0 ? delaySend(proc, sr, dlyAmt, 0.375, 0.35, 4)
                         : new Float32Array(proc.length);
    return revP.then(function (rev) {
      return { proc: proc, rev: rev, dly: dly, meta: meta };
    });
  }

  /* ---- sections path: process the Studio's vocal sections of the mix.
     Delta approach: only the *change* from vocal processing (plus sends)
     is added to the untouched dry stereo mix, so the stereo image of the
     beat survives. Sidechain ON ducks the dry mix under the vocal. ---- */
  function applyToSections(mix, ranges, opts) {
    var sr = mix.sampleRate, nCh = mix.numberOfChannels;
    var out = dupBuf(mix);
    var report = { kind: 'sections', ranges: 0, deessDips: 0, deessMaxDb: 0, compGrDb: 0, duck: !!opts.duck };
    var chain = Promise.resolve();
    ranges.forEach(function (r) {
      chain = chain.then(function () {
        var a = clamp(Math.round(r.aSec * sr), 0, mix.length);
        var b = clamp(Math.round(r.bSec * sr), 0, mix.length);
        if (b - a < 64) return null;
        var slice = allocBuf(nCh, b - a, sr);
        var ch, i;
        for (ch = 0; ch < nCh; ch++)
          slice.getChannelData(ch).set(mix.getChannelData(ch).subarray(a, b));
        var mono = monoMean(slice);
        return processVocalChain(mono, sr, opts).then(function (vc) {
          var n = b - a;
          var duck = opts.duck ? duckGains(vc.proc, sr, 3) : null;
          var edge = Math.min(Math.round(0.008 * sr), Math.floor(n / 4));
          for (i = 0; i < n; i++) {
            var f = 1;
            if (edge > 0) {
              if (i < edge) f = 0.5 - 0.5 * Math.cos(Math.PI * i / edge);
              else if (i >= n - edge) f = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / edge);
            }
            var add = (vc.proc[i] - mono[i] + vc.rev[i] + vc.dly[i]) * f;
            for (ch = 0; ch < nCh; ch++) {
              var d = out.getChannelData(ch);
              if (duck) {
                var g = 1 - (1 - duck[i]) * f;
                d[a + i] = d[a + i] * g + add;
              } else {
                d[a + i] = d[a + i] + add;
              }
            }
          }
          report.ranges++;
          report.deessDips += vc.meta.deessDips;
          if (vc.meta.deessMaxDb > report.deessMaxDb) report.deessMaxDb = vc.meta.deessMaxDb;
          if (vc.meta.compGrDb > report.compGrDb) report.compGrDb = vc.meta.compGrDb;
          return null;
        });
      });
    });
    return chain.then(function () { return { buffer: out, report: report }; });
  }

  /* ---- stems path: the vocals stem lane is the true isolated vocal.
     Process it, optionally duck the instrumental lane under it, rebuild
     the lane mix honouring mute/solo/gainDb like the Studio's own
     lane commit (vocals + instrumental form the exact partition). ---- */
  function applyToStems(stems, laneUI, opts) {
    var sr = stems.vocals.sampleRate;
    var n = Math.min(stems.vocals.length, stems.instrumental.length);
    function laneGain(id) {
      var u = (laneUI && laneUI[id]) || {};
      if (u.mute) return 0;
      var anySolo = (laneUI && ((laneUI.vocals && laneUI.vocals.solo) || (laneUI.instrumental && laneUI.instrumental.solo)));
      if (anySolo && !u.solo) return 0;
      return dbToLin(u.gainDb || 0);
    }
    var vocMono = monoMean(stems.vocals).subarray(0, n);
    var monoCopy = new Float32Array(n); monoCopy.set(vocMono);
    return processVocalChain(monoCopy, sr, opts).then(function (vc) {
      var nCh = Math.max(stems.vocals.numberOfChannels, stems.instrumental.numberOfChannels, 2);
      var vocOut = allocBuf(nCh, n, sr), ch, i;
      for (ch = 0; ch < nCh; ch++) {
        var vd = vocOut.getChannelData(ch);
        for (i = 0; i < n; i++) vd[i] = vc.proc[i] + vc.rev[i] + vc.dly[i];
      }
      var insOut = allocBuf(nCh, n, sr);
      for (ch = 0; ch < nCh; ch++) {
        var sd = stems.instrumental.getChannelData(Math.min(ch, stems.instrumental.numberOfChannels - 1));
        insOut.getChannelData(ch).set(sd.subarray(0, n));
      }
      if (opts.duck) insOut = applyDuck(insOut, duckGains(vc.proc, sr, 3));
      var gv = laneGain('vocals'), gi = laneGain('instrumental');
      for (ch = 0; ch < nCh; ch++) {
        var vch = vocOut.getChannelData(ch), ich = insOut.getChannelData(ch);
        for (i = 0; i < n; i++) ich[i] = ich[i] * gi + vch[i] * gv;
      }
      softLimit(insOut, 0.71);
      return {
        buffer: insOut,
        report: {
          kind: 'stems', ranges: 1, deessDips: vc.meta.deessDips,
          deessMaxDb: vc.meta.deessMaxDb, compGrDb: vc.meta.compGrDb, duck: !!opts.duck,
        },
      };
    });
  }

  /* ================= undo =================
     Uses window.__v26pushUndo / window.__v26undo when another v26 worker
     created them (I2/I3); otherwise this file's own mini-stack, published
     under the same names for later workers. Contract:
       __v26pushUndo(label, undoFn) — push; __v26undo() — pop & run. */
  var undoStack = [];
  function miniPushUndo(label, undoFn) {
    undoStack.push({ label: label, fn: undoFn });
    if (undoStack.length > 8) undoStack.shift();
    refreshUndoBtn();
  }
  function miniUndo() {
    var e = undoStack.pop();
    refreshUndoBtn();
    if (e) { try { e.fn(); } catch (err) { /* honest: nothing to roll back to */ } return true; }
    return false;
  }
  var pushUndoFn, undoFn;
  if (typeof global.__v26pushUndo === 'function') {
    pushUndoFn = global.__v26pushUndo;
    undoFn = (typeof global.__v26undo === 'function') ? global.__v26undo : miniUndo;
  } else {
    pushUndoFn = miniPushUndo; undoFn = miniUndo;
    global.__v26pushUndo = miniPushUndo;
    global.__v26undo = miniUndo;
  }
  function refreshUndoBtn() {
    if (typeof document === 'undefined') return;
    var b = document.getElementById('v26v-undo');
    if (b) { b.disabled = undoStack.length === 0; b.textContent = '↩ Undo' + (undoStack.length ? ' (' + undoStack.length + ')' : ''); }
  }

  /* ================= Studio bridge ================= */
  function studio() { return (RM.v25studio && RM.v25studio.getMixBuffer) ? RM.v25studio : null; }
  function detectTarget() {
    var S = studio();
    if (!S) return { type: 'none', why: 'Studio not ready' };
    var mix = S.getMixBuffer();
    if (!mix || !mix.getChannelData) return { type: 'none', why: 'Load a mashup in Studio first' };
    var stems = S.getStems ? S.getStems() : null;
    if (stems && stems.vocals && typeof stems.vocals.getChannelData === 'function')
      return { type: 'stems', why: 'vocals stem lane' };
    var ranges = S.getSectionRanges ? S.getSectionRanges() : [];
    var vocal = ranges.filter(function (r) { return r.kind === 'vocal'; });
    if (vocal.length) return { type: 'sections', ranges: vocal, why: vocal.length + ' vocal section(s)' };
    return { type: 'none', why: 'No vocal sections — extract stems first' };
  }

  /* ================= UI ================= */
  var KNOBS = [
    { id: 'deess',  label: 'De-ess',     min: 0, max: 100, val: 50, unit: '%', hint: 'Dynamic 4–8 kHz sibilance dip' },
    { id: 'harsh',  label: 'Harsh tame', min: 0, max: 100, val: 40, unit: '%', hint: 'Dynamic 2–5 kHz resonance cut' },
    { id: 'comp',   label: 'Compressor', min: 0, max: 100, val: 35, unit: '%', hint: 'Glue compressor, −34…−18 dB thr, 1.5–6:1' },
    { id: 'reverb', label: 'Reverb send', min: 0, max: 100, val: 25, unit: '%', hint: 'Generated-IR convolver send' },
    { id: 'delay',  label: 'Delay send', min: 0, max: 100, val: 15, unit: '%', hint: '0.375 s echo taps send' },
  ];
  function readOpts() {
    var o = { duck: false, eq7: {} };
    if (typeof document === 'undefined') return o;
    KNOBS.forEach(function (k) {
      var el = document.getElementById('v26v-' + k.id);
      o[k.id] = el ? clamp(+el.value || 0, k.min, k.max) : k.val;
    });
    (RM.fx.eq7.BANDS || []).forEach(function (b) {
      var el = document.getElementById('v26v-eq-' + b.id);
      o.eq7[b.id] = el ? clamp(+el.value || 0, -12, 12) : 0;
    });
    var dk = document.getElementById('v26v-duck');
    o.duck = !!(dk && dk.checked);
    return o;
  }
  function fmtReport(r) {
    var bits = [];
    bits.push(r.kind === 'stems' ? 'vocals stem lane' : r.ranges + ' vocal section(s)');
    bits.push('de-ess ' + r.deessDips + ' dips (−' + r.deessMaxDb + ' dB max)');
    if (r.compGrDb > 0) bits.push('comp GR ' + r.compGrDb + ' dB');
    bits.push('sidechain ' + (r.duck ? 'ON' : 'OFF'));
    return 'Applied to ' + bits.join(' · ');
  }
  function setStatus(msg) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('v26v-status');
    if (el) el.textContent = msg;
  }
  function setBusy(b, msg) {
    if (typeof document === 'undefined') return;
    var btn = document.getElementById('v26v-apply');
    if (btn) btn.disabled = b;
    setStatus(msg || '');
  }

  function onApply() {
    var S = studio();
    if (!S) { setStatus('Studio not ready yet.'); return; }
    var mix = S.getMixBuffer();
    if (!mix) { setStatus('Load a mashup in Studio first 🎵'); return; }
    var target = detectTarget();
    if (target.type === 'none') { setStatus(target.why + '.'); return; }
    var o = readOpts();
    setBusy(true, 'Processing vocal (' + target.why + ')…');
    var prev = dupBuf(mix);
    var done;
    if (target.type === 'stems') {
      var laneUI = S.getLaneUI ? S.getLaneUI() : {};
      done = applyToStems(S.getStems(), laneUI || {}, o);
    } else {
      done = applyToSections(mix, target.ranges, o);
    }
    done.then(function (res) {
      pushUndoFn('Vocal chain', function () { S.commitMixBuffer(prev, 'Undo: vocal chain'); });
      S.commitMixBuffer(res.buffer, 'Vocal chain applied ✓');
      setBusy(false, fmtReport(res.report) + '.');
      refreshTarget();
    }).catch(function (e) {
      setBusy(false, 'Failed: ' + (e && e.message ? e.message : e));
    });
  }

  function refreshTarget() {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('v26v-target');
    if (!el) return; // panel not in the DOM — nothing to refresh
    el.textContent = detectTarget().why;
  }

  /* ---- target-label poll: lifecycle-managed (v29 J3 P2-4).
     The old setInterval(refreshTarget, 2000) ran forever from first inject,
     even when the Studio screen was never opened. Now the timer arms when
     the Studio screen is shown and stops (clearInterval) when the user
     leaves it, via the same RM.app.onShow chaining pattern v25-studio.js
     uses; each tick also self-clears as a backstop if the screen is hidden
     (e.g. the hook was clobbered before it could re-assert). */
  var refreshTimer = null;
  function studioVisible() {
    if (typeof document === 'undefined') return false;
    var scr = document.getElementById('screen-studio');
    if (scr && scr.classList) return scr.classList.contains('active');
    var p = document.getElementById('v26-vocal-panel');
    return !!(p && p.offsetParent !== null);
  }
  function armRefresh() {
    if (refreshTimer || typeof document === 'undefined') return;
    refreshTimer = setInterval(function () {
      if (!studioVisible()) { disarmRefresh(); return; } // v29 J3 P2-4: hidden -> stop
      refreshTarget();
    }, 2000);
  }
  function disarmRefresh() {
    if (refreshTimer) { try { clearInterval(refreshTimer); } catch (e) {} refreshTimer = null; }
  }
  function hookScreenLifecycle(attempts) {
    if (typeof document === 'undefined') return;
    var a = (typeof RM !== 'undefined' && RM.app) || null;
    if (!a) {
      // RM.app not ready yet — retry briefly.
      if (attempts > 0) setTimeout(function () { hookScreenLifecycle(attempts - 1); }, 500);
      return;
    }
    if (!V._screenHook) {
      // Install exactly once and never re-wrap: v25-studio.js wraps AROUND
      // this hook with its own retries (same chaining pattern), so
      // re-wrapping after v25 would cycle the chain (H -> stHook -> H...).
      // Script order is app.js < v25-studio.js < v26-vocal.js and app.js
      // init() assigns A.onShow before our boot listener runs, so `prev`
      // below is app.js's real handler — chained, never dropped.
      var prev = a.onShow;
      V._screenHook = function (name) {
        try { if (typeof prev === 'function') prev(name); } catch (e) {}
        try {
          if (name === 'studio') { refreshTarget(); armRefresh(); }
          else disarmRefresh(); // v29 J3 P2-4: leaving Studio stops the 2s poll
        } catch (e2) {}
      };
      a.onShow = V._screenHook;
    }
    // Deep link / restored state: Studio already visible — arm now.
    try { if (studioVisible()) { refreshTarget(); armRefresh(); } } catch (e) {}
  }

  function sliderRow(id, label, min, max, step, val, unit, hint) {
    return '<div class="row"><label style="flex:1" title="' + hint + '">' + label +
      ' <input type="range" id="' + id + '" min="' + min + '" max="' + max +
      '" step="' + step + '" value="' + val + '" aria-label="' + label + '">' +
      ' <span id="' + id + '-v">' + val + unit + '</span></label></div>';
  }
  function panelHTML() {
    var h = '<div class="panel" id="v26-vocal-panel">' +
      '<h4>🎤 Vocal Chain <span class="beta">Smart DSP</span></h4>' +
      '<div class="muted small">Real on-device vocal processing — "Smart" DSP, not AI. ' +
      'Target: <b id="v26v-target">…</b></div>';
    KNOBS.forEach(function (k) {
      h += sliderRow('v26v-' + k.id, k.label, k.min, k.max, 1, k.val, k.unit, k.hint);
    });
    h += '<h5 style="margin:8px 0 2px">7-band Vocal EQ <span class="muted small">−12…+12 dB</span></h5>';
    (RM.fx.eq7.BANDS || []).forEach(function (b) {
      h += sliderRow('v26v-eq-' + b.id, b.label + ' <span class="muted small">' + b.freq + ' Hz</span>',
        -12, 12, 0.5, 0, ' dB', b.type + ' @ ' + b.freq + ' Hz');
    });
    h += '<div class="row"><label title="Duck the instrumental under the vocal (real envelope follower, max −3 dB)">' +
      '<input type="checkbox" id="v26v-duck" checked> Sidechain ducking <span class="muted small">instrumental −3 dB max under vocal</span></label></div>';
    h += '<div class="btn-row">' +
      '<button class="btn primary" id="v26v-apply">✨ Apply to vocal</button>' +
      '<button class="btn" id="v26v-undo" disabled>↩ Undo</button>' +
      '<button class="btn ghost" id="v26v-reset">Reset</button></div>' +
      '<div class="muted small" id="v26v-status" style="margin-top:6px"></div>' +
      '</div>';
    return h;
  }
  function wirePanel() {
    if (typeof document === 'undefined') return;
    KNOBS.forEach(function (k) {
      var el = document.getElementById('v26v-' + k.id);
      if (el) el.addEventListener('input', function () {
        var v = document.getElementById('v26v-' + k.id + '-v');
        if (v) v.textContent = el.value + k.unit;
      });
    });
    (RM.fx.eq7.BANDS || []).forEach(function (b) {
      var el = document.getElementById('v26v-eq-' + b.id);
      if (el) el.addEventListener('input', function () {
        var v = document.getElementById('v26v-eq-' + b.id + '-v');
        if (v) v.textContent = (+el.value).toFixed(1) + ' dB';
      });
    });
    var ap = document.getElementById('v26v-apply');
    if (ap) ap.addEventListener('click', onApply);
    var un = document.getElementById('v26v-undo');
    if (un) un.addEventListener('click', function () { undoFn(); refreshTarget(); });
    var rs = document.getElementById('v26v-reset');
    if (rs) rs.addEventListener('click', function () {
      KNOBS.forEach(function (k) {
        var el = document.getElementById('v26v-' + k.id);
        if (el) { el.value = k.val; el.dispatchEvent(new Event('input')); }
      });
      (RM.fx.eq7.BANDS || []).forEach(function (b) {
        var el = document.getElementById('v26v-eq-' + b.id);
        if (el) { el.value = 0; el.dispatchEvent(new Event('input')); }
      });
      var dk = document.getElementById('v26v-duck');
      if (dk) dk.checked = true;
      setStatus('Knobs reset.');
    });
  }
  // Inject the panel into the Studio screen (which v25-studio.js renders
  // dynamically — there is no static #screen-studio in index.html).
  function injectPanel(attempts) {
    if (typeof document === 'undefined') return;
    if (document.getElementById('v26-vocal-panel')) return;
    var anchor = document.getElementById('stu-commit-lanes');
    var hostPanel = anchor && anchor.closest ? anchor.closest('.panel') : null;
    var host = hostPanel || document.getElementById('stu-main');
    if (!host) {
      if (attempts > 0) setTimeout(function () { injectPanel(attempts - 1); }, 300);
      return;
    }
    var tmp = document.createElement('div');
    tmp.innerHTML = panelHTML();
    var panel = tmp.firstChild;
    if (hostPanel && hostPanel.nextSibling) hostPanel.parentNode.insertBefore(panel, hostPanel.nextSibling);
    else if (hostPanel) hostPanel.parentNode.appendChild(panel);
    else host.appendChild(panel);
    wirePanel();
    refreshTarget();
    // v29 J3 P2-4: no more forever-interval — the poll arms when the Studio
    // screen is shown and clearIntervals when the user leaves it. (The first
    // tick self-clears if Studio is currently hidden.)
    hookScreenLifecycle(20);
    armRefresh();
  }
  function boot() {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', function () { injectPanel(40); });
    else injectPanel(40);
  }

  V.KNOBS = KNOBS;
  V._armRefresh = armRefresh; // v29 J3 P2-4 test hooks
  V._disarmRefresh = disarmRefresh;
  V._hookLifecycle = hookScreenLifecycle;
  V._timerActive = function () { return refreshTimer !== null; };
  V._studioVisible = studioVisible;
  V.detectTarget = detectTarget;
  V.readOpts = readOpts;
  V.apply = onApply;
  V.undo = function () { return undoFn(); };
  V._panelHTML = panelHTML;
  RM.v26vocal = V;
  boot();

  /* ================= node test hook (browser-harmless) ================= */
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        api: { processVocalChain: processVocalChain, applyToSections: applyToSections, applyToStems: applyToStems },
        internals: {
          shimBuffer: shimBuffer, allocBuf: allocBuf, dupBuf: dupBuf, monoMean: monoMean,
          dbToLin: dbToLin, clamp: clamp, maxAbsArr: maxAbsArr, rmsArr: rmsArr,
          bandEnergy: bandEnergy, crestFactor: crestFactor,
          compressMono: compressMono, makeReverbIR: makeReverbIR,
          naiveConvolve: naiveConvolve, reverbWet: reverbWet, delaySend: delaySend,
          duckGains: duckGains, applyDuck: applyDuck, softLimit: softLimit,
          KNOBS: KNOBS,
        },
      };
    }
  } catch (e) { /* browser */ }
})(typeof window !== 'undefined' ? window : globalThis);
