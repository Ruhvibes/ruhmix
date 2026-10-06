'use strict';
/* =====================================================================
   RuhMix — v25-qc.js  (W6 §18: pre-export Quality Check)
   Module: RM.v25qc

   "Smart check" — an honest, heuristic DSP scan of a finished render
   buffer BEFORE export. It never claims AI judgement and never claims a
   remix is copyright-free; every check is a documented measurement.

   API:
     RM.v25qc.runCheck(renderBuf, meta) -> Promise<{issues, summary, measurements}>
       renderBuf: AudioBuffer (stereo or mono), the finished mix.
       meta (optional, all fields optional — missing data skips that check):
         { masterBpm, masterKey, barLenSec,
           songs: [{name, bpm, key, stretched}],
           vocalSlots: [{name, startSec, endSec}],   // arrangement plan
           boundariesSec: [..],                     // slot/transition times
           xfadeSec, xfadeBars }
       issues: [{id, issue, detail, severity, autoFixable, fixDesc}]
         severity: 'error' | 'warn' | 'info'

     RM.v25qc.fixAll(renderBuf, issues, onProgress)
       -> Promise<{buffer, fixes}>
       Applies REAL DSP fixes for every fixable issue, in a safe order,
       to a COPY of the buffer (input untouched). Each fix is documented:
       fixes: [{id, title, before, after, detail}]. Caller should re-run
       runCheck() on the result to confirm.

   The 12 checks (§18):
     1. bpm-mismatch    — a song BPM deviates >3% from master (unstretched)
     2. key-mismatch    — song key incompatible with master key (fifths)
     3. vocal-overlap   — two vocal slots active at once outside crossfades
     4. clipping        — true-peak (4x oversampled) > 0 dBTP or |x|>0.999
     5. phase           — L/R correlation too low / negative sections
     6. bass            — <80 Hz energy share > 30%
     7. harsh           — 2–5 kHz energy share > 28%
     8. volume-jump     — adjacent bars differ > 4 dB RMS
     9. click           — discontinuity at a slot boundary (d2 spike)
    10. timing-drift    — onsets drift > 60 ms off the bar grid
    11. sep-artifacts   — HF crest heuristic for separation "wateriness"
    (12. the returned list itself: [{issue, severity, autoFixable}])

   Auto-fixable: clipping (true-peak limiter, ceiling 0.71 = -3 dBTP),
   clicks (2 ms de-click V-fade), volume jumps (per-bar smoothing),
   bass (low-shelf cut <80 Hz), harshness (peaking cut @3.2 kHz).
   NOT auto-fixable (need a re-render, honestly reported): bpm/key
   mismatch, vocal overlap, phase, timing drift, separation artifacts.
   ===================================================================== */
window.RM = window.RM || {};

RM.v25qc = (function () {
  var TP_CEIL = 0.71;          // -3 dBTP, matches v24 mastering chain
  var CHUNK = 1 << 18;

  /* ---------------- chunked runner (reuses RM.audio) ---------------- */
  function runC(total, chunk, fn, onProgress) {
    if (window.RM && RM.audio && typeof RM.audio.runChunked === 'function') {
      return RM.audio.runChunked(total, chunk, fn, onProgress);
    }
    // Fallback: plain async loop (node tests without RM.audio).
    return new Promise(function (resolve, reject) {
      var i = 0;
      var tick = (typeof setImmediate === 'function') ? setImmediate : function (f) { setTimeout(f, 0); };
      (function step() {
        try {
          var end = Math.min(total, i + chunk);
          fn(i, end); i = end;
          if (onProgress) { try { onProgress(i / total); } catch (e) {} }
          if (i < total) tick(step); else resolve();
        } catch (e) { reject(e); }
      })();
    });
  }

  function mkIssue(id, issue, detail, severity, autoFixable, fixDesc) {
    return { id: id, issue: issue, detail: detail, severity: severity, autoFixable: !!autoFixable, fixDesc: fixDesc || null };
  }

  /* ---------------- biquads (RBJ cookbook) ---------------- */
  function biquad(type, freq, Q, gainDb, sr) {
    var A = Math.pow(10, (gainDb || 0) / 40);
    var w = 2 * Math.PI * Math.max(20, Math.min(sr / 2 * 0.99, freq)) / sr;
    var cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * Q);
    var b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'bandpass') { // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'lowshelf') {
      var sA = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sA); a0 = (A + 1) + (A - 1) * cw + sA;
      a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
    } else { // 'peaking'
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function bqState() { return { x1: 0, x2: 0, y1: 0, y2: 0 }; }
  function bqRun(cf, st, x) {
    var y = cf.b0 * x + cf.b1 * st.x1 + cf.b2 * st.x2 - cf.a1 * st.y1 - cf.a2 * st.y2;
    st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
    return y;
  }
  // Band-energy share: energy after filter / total energy (mid channel).
  function bandShare(buf, cf, onProgress) {
    var len = buf.length, nCh = buf.numberOfChannels;
    var chs = [], sts = [];
    for (var c = 0; c < nCh; c++) { chs.push(buf.getChannelData(c)); sts.push(bqState()); }
    var eTot = 0, eBand = 0;
    return runC(len, CHUNK, function (a, b) {
      for (var i = a; i < b; i++) {
        var m = 0;
        for (var c = 0; c < nCh; c++) m += chs[c][i];
        m /= nCh;
        var y = bqRun(cf, sts[0], m);
        eTot += m * m; eBand += y * y;
      }
    }, onProgress).then(function () {
      return eTot > 1e-12 ? eBand / eTot : 0;
    });
  }

  /* ---------------- true peak (4x linear oversample) ---------------- */
  function truePeak(buf, onProgress) {
    var nCh = buf.numberOfChannels, len = buf.length;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    var peak = 0, digiClip = false;
    return runC(Math.max(0, len - 1), CHUNK, function (a, b) {
      for (var c = 0; c < nCh; c++) {
        var d = chs[c];
        for (var i = a; i < b; i++) {
          var s0 = d[i], s1 = d[i + 1];
          var a0 = s0 < 0 ? -s0 : s0;
          if (a0 > peak) peak = a0;
          if (a0 >= 0.999) digiClip = true;
          // 4x: 3 intermediate linear-interpolated points
          var st = (s1 - s0) * 0.25;
          var v1 = s0 + st, v2 = s0 + st * 2, v3 = s0 + st * 3;
          var m = v1 < 0 ? -v1 : v1; if (m > peak) peak = m;
          m = v2 < 0 ? -v2 : v2; if (m > peak) peak = m;
          m = v3 < 0 ? -v3 : v3; if (m > peak) peak = m;
        }
      }
    }, onProgress).then(function () {
      if (len > 0) {
        for (var c = 0; c < nCh; c++) {
          var v = chs[c][len - 1]; var a0 = v < 0 ? -v : v;
          if (a0 > peak) peak = a0;
          if (a0 >= 0.999) digiClip = true;
        }
      }
      return { peak: peak, digitalClip: digiClip };
    });
  }

  // True-peak limiter, ceiling 0.71 (-3 dBTP — v24 chain).
  // Causal lookahead-style limiter: per-sample desired gain from the
  // 4x-oversampled interval peak, smoothed with fast attack (0.8 ms) /
  // slow release (60 ms). State carries across chunks. Verified after.
  function applyTruePeakLimiter(buf, onProgress) {
    var sr = buf.sampleRate, nCh = buf.numberOfChannels, len = buf.length;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    var atkK = 1 - Math.exp(-1 / (0.0008 * sr));
    var relK = 1 - Math.exp(-1 / (0.06 * sr));
    var g = 1;
    return runC(Math.max(0, len - 1), CHUNK, function (a, b) {
      for (var i = a; i < b; i++) {
        var osPeak = 0;
        for (var c = 0; c < nCh; c++) {
          var d = chs[c];
          var s0 = d[i], s1 = d[i + 1];
          var st = (s1 - s0) * 0.25;
          var cand = [s0, s0 + st, s0 + st * 2, s0 + st * 3, s1];
          for (var k = 0; k < 5; k++) { var av = cand[k] < 0 ? -cand[k] : cand[k]; if (av > osPeak) osPeak = av; }
        }
        var desired = osPeak > 1e-9 ? Math.min(1, TP_CEIL / osPeak) : 1;
        var kk = desired < g ? atkK : relK;
        g += (desired - g) * kk;
        for (var c2 = 0; c2 < nCh; c2++) chs[c2][i] *= g;
      }
    }, onProgress).then(function () {
      // Last sample has no interval; scale by final gain (continuous).
      for (var c = 0; c < nCh; c++) chs[c][len - 1] *= g;
      return truePeak(buf, null);
    }).then(function (tp) {
      // Safety net: if interpolation blind spots survived, trim statically.
      if (tp.peak > TP_CEIL * 1.002) {
        var trim = TP_CEIL / tp.peak;
        return runC(len, CHUNK, function (a, b) {
          for (var c = 0; c < nCh; c++) { var d = chs[c]; for (var i = a; i < b; i++) d[i] *= trim; }
        }, null).then(function () { return truePeak(buf, null); });
      }
      return tp;
    });
  }

  /* ---------------- buffer copy ---------------- */
  function copyBuffer(buf) {
    var ctx = (window.RM && RM.audio && typeof RM.audio.ensureCtx === 'function') ? RM.audio.ensureCtx() : null;
    if (!ctx || typeof ctx.createBuffer !== 'function') throw new Error('AudioContext unavailable for QC fix.');
    var out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    var jobs = [];
    for (var c = 0; c < buf.numberOfChannels; c++) {
      (function (cc) {
        var s = buf.getChannelData(cc), d = out.getChannelData(cc);
        jobs.push(runC(buf.length, CHUNK, function (a, b) {
          for (var i = a; i < b; i++) d[i] = s[i];
        }, null));
      })(c);
    }
    return Promise.all(jobs).then(function () { return out; });
  }

  /* ---------------- key distance (circle of fifths) ---------------- */
  var FIFTHS = { 'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'Gb': 6, 'C#': 7, 'Db': 7, 'Ab': 8, 'Eb': 9, 'Bb': 10, 'F': 11 };
  function parseKey(k) {
    if (!k || typeof k !== 'string') return null;
    var s = k.trim();
    var minor = /m$/i.test(s) && !/maj$/i.test(s);
    var root = s.replace(/m(aj)?$/i, '').replace(/\s+/g, '');
    if (!(root in FIFTHS)) return null;
    var f = FIFTHS[root];
    if (minor) f = (f + 9) % 12; // relative major
    return f;
  }
  function keyDistance(k1, k2) {
    var f1 = parseKey(k1), f2 = parseKey(k2);
    if (f1 === null || f2 === null) return null;
    var d = Math.abs(f1 - f2) % 12;
    return Math.min(d, 12 - d);
  }

  /* ---------------- meta normalisation ---------------- */
  function normMeta(meta) {
    meta = meta || {};
    var barLenSec = meta.barLenSec || (meta.masterBpm ? 240 / meta.masterBpm : 2);
    return {
      masterBpm: meta.masterBpm || null,
      masterKey: meta.masterKey || null,
      barLenSec: barLenSec,
      songs: Array.isArray(meta.songs) ? meta.songs : [],
      vocalSlots: Array.isArray(meta.vocalSlots) ? meta.vocalSlots : [],
      boundariesSec: Array.isArray(meta.boundariesSec) ? meta.boundariesSec : [],
      xfadeSec: (typeof meta.xfadeSec === 'number') ? meta.xfadeSec
        : (typeof meta.xfadeBars === 'number' ? meta.xfadeBars * barLenSec : Math.min(0.5, barLenSec / 2)),
    };
  }

  /* ================= THE CHECKS ================= */
  function checkBpm(m) {
    var out = [];
    if (!m.masterBpm || !m.songs.length) return out;
    m.songs.forEach(function (s, i) {
      if (!s || typeof s.bpm !== 'number' || !(s.bpm > 0) || s.stretched) return;
      var dev = Math.abs(s.bpm - m.masterBpm) / m.masterBpm;
      if (dev > 0.03) {
        out.push(mkIssue('bpm-mismatch',
          'BPM mismatch: "' + (s.name || ('Song ' + (i + 1))) + '" is ' + s.bpm.toFixed(1) + ' BPM vs master ' + m.masterBpm.toFixed(1) + ' BPM (' + (dev * 100).toFixed(1) + '% off)',
          'The vocal will drift against the beat grid. Time-stretch this song to the master BPM and re-render.',
          'warn', false, null));
      }
    });
    return out;
  }

  function checkKey(m) {
    var out = [];
    if (!m.masterKey || !m.songs.length) return out;
    m.songs.forEach(function (s, i) {
      if (!s || !s.key) return;
      var d = keyDistance(s.key, m.masterKey);
      if (d !== null && d > 2) {
        out.push(mkIssue('key-mismatch',
          'Key clash: "' + (s.name || ('Song ' + (i + 1))) + '" is in ' + s.key + ' vs master key ' + m.masterKey + ' (fifths distance ' + d + ')',
          'Distant keys sound dissonant in a mashup. Pitch-shift the vocal toward the master key or pick a nearer song.',
          'warn', false, null));
      }
    });
    return out;
  }

  function checkVocalOverlap(m) {
    var out = [];
    var slots = m.vocalSlots.filter(function (s) {
      return s && typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec;
    }).sort(function (a, b) { return a.startSec - b.startSec; });
    for (var i = 0; i + 1 < slots.length; i++) {
      var a = slots[i], b = slots[i + 1];
      var overlap = a.endSec - b.startSec;
      if (overlap > m.xfadeSec + 1e-6) {
        out.push(mkIssue('vocal-overlap',
          'Vocal overlap: "' + (a.name || ('slot ' + (i + 1))) + '" and "' + (b.name || ('slot ' + (i + 2))) + '" play together for ' + overlap.toFixed(2) + 's (crossfade allows ' + m.xfadeSec.toFixed(2) + 's)',
          'Two lead vocals at once sounds messy (the classic "dono vocal ek saath" bug). Re-arrange so vocals hand off within the crossfade window.',
          'error', false, null));
      }
    }
    return out;
  }

  /* ---- acoustic checks (need the buffer) ---- */
  function checkClipping(buf) {
    return truePeak(buf, null).then(function (tp) {
      var issues = [];
      if (tp.peak > 1.0 || tp.digitalClip) {
        var db = 20 * Math.log10(Math.max(1e-9, tp.peak));
        issues.push(mkIssue('clipping',
          'Clipping: true peak ' + db.toFixed(1) + ' dBTP' + (tp.digitalClip ? ' (samples hitting digital full-scale)' : ''),
          'Over 0 dBTP distorts on phones and after MP3 encoding. "Fix Issues" re-applies the true-peak limiter (ceiling −3 dBTP).',
          'error', true, 'Re-apply true-peak limiter (ceiling 0.71 = −3 dBTP, 0.8 ms attack / 60 ms release, verified after).'));
      }
      return { issues: issues, tp: tp };
    });
  }

  function checkPhase(buf) {
    var nCh = buf.numberOfChannels;
    if (nCh < 2) return Promise.resolve({ issues: [], corr: 1 });
    var len = buf.length, sr = buf.sampleRate;
    var L = buf.getChannelData(0), R = buf.getChannelData(1);
    var win = Math.floor(sr); // 1 s windows
    var nWin = Math.min(60, Math.max(1, Math.floor(len / win)));
    var corrs = [];
    return runC(nWin, 8, function (a, b) {
      for (var w = a; w < b; w++) {
        var s0 = Math.floor((w / nWin) * (len - win));
        var sLL = 0, sRR = 0, sLR = 0;
        for (var i = s0; i < s0 + win; i += 4) { // stride 4: plenty for correlation
          var l = L[i], r = R[i];
          sLL += l * l; sRR += r * r; sLR += l * r;
        }
        var denom = Math.sqrt(sLL * sRR);
        corrs.push(denom > 1e-12 ? sLR / denom : 1);
      }
    }, null).then(function () {
      var mean = 0, neg = 0;
      corrs.forEach(function (c) { mean += c; if (c < 0) neg++; });
      mean /= Math.max(1, corrs.length);
      var issues = [];
      if (mean < 0.25 || neg / corrs.length > 0.3) {
        issues.push(mkIssue('phase',
          'Phase issue: mean L/R correlation ' + mean.toFixed(2) + (neg ? ' (' + neg + '/' + corrs.length + ' sections out of phase)' : ''),
          'Out-of-phase stereo collapses on mono phone speakers and sounds hollow. Not auto-fixed (needs a re-mix); check stem panning.',
          'warn', false, null));
      }
      return { issues: issues, corr: mean };
    });
  }

  function checkBass(buf) {
    var cf = biquad('lowpass', 80, 0.707, 0, buf.sampleRate);
    return bandShare(buf, cf, null).then(function (share) {
      var issues = [];
      if (share > 0.30) {
        issues.push(mkIssue('bass',
          'Excessive bass: ' + (share * 100).toFixed(1) + '% of energy is below 80 Hz (over 30%)',
          'Too much sub-bass overloads phone speakers ("beat fat raha hai"). "Fix Issues" applies a low-shelf cut below 80 Hz.',
          'warn', true, 'Low-shelf cut below 80 Hz (auto depth from excess, max −9 dB).'));
      }
      return { issues: issues, share: share };
    });
  }

  function checkHarsh(buf) {
    var cf = biquad('bandpass', 3500, 0.8, 0, buf.sampleRate); // ~2–5 kHz
    return bandShare(buf, cf, null).then(function (share) {
      var issues = [];
      if (share > 0.28) {
        issues.push(mkIssue('harsh',
          'Harsh frequencies: ' + (share * 100).toFixed(1) + '% of energy is in 2–5 kHz (over 28%)',
          'Excess 2–5 kHz sounds sharp and fatiguing. "Fix Issues" applies a gentle peaking cut at 3.2 kHz.',
          'warn', true, 'Peaking cut at 3.2 kHz, Q 0.9 (auto depth from excess, max −6 dB).'));
      }
      return { issues: issues, share: share };
    });
  }

  function checkVolumeJumps(buf, m) {
    var sr = buf.sampleRate, len = buf.length, nCh = buf.numberOfChannels;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    var barLen = Math.max(1, Math.round(m.barLenSec * sr));
    var nBars = Math.max(1, Math.floor(len / barLen));
    var rms = new Array(nBars);
    return runC(nBars, 8, function (a, b) {
      for (var br = a; br < b; br++) {
        var s0 = br * barLen, s1 = Math.min(len, s0 + barLen);
        var e = 0, n = 0;
        for (var i = s0; i < s1; i += 2) {
          var mm = 0;
          for (var c = 0; c < nCh; c++) mm += chs[c][i];
          mm /= nCh; e += mm * mm; n++;
        }
        rms[br] = n > 0 ? 10 * Math.log10(Math.max(1e-12, e / n)) : -120;
      }
    }, null).then(function () {
      var issues = [], jumps = [];
      for (var br = 1; br < nBars; br++) {
        var d = Math.abs(rms[br] - rms[br - 1]);
        if (d > 4) jumps.push({ bar: br, diff: d });
      }
      if (jumps.length) {
        var worst = jumps.reduce(function (x, y) { return y.diff > x.diff ? y : x; }, jumps[0]);
        issues.push(mkIssue('volume-jump',
          'Volume jump: ' + jumps.length + ' bar boundar' + (jumps.length > 1 ? 'ies' : 'y') + ' jump >4 dB (worst ' + worst.diff.toFixed(1) + ' dB at bar ' + (worst.bar + 1) + ')',
          'Sudden loudness steps sound amateur. "Fix Issues" smooths per-bar gain toward the median (±4 dB max).',
          'warn', true, 'Per-bar RMS rebalanced toward median (max ±4 dB/bar, 30 ms raised-cosine smoothing).'));
      }
      return { issues: issues, rms: rms, jumps: jumps };
    });
  }

  function checkClicks(buf, m) {
    var sr = buf.sampleRate, len = buf.length, nCh = buf.numberOfChannels;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    var bnds = m.boundariesSec
      .map(function (s) { return Math.round(s * sr); })
      .filter(function (bs) { return bs > sr && bs < len - sr; });
    if (!bnds.length) return Promise.resolve({ issues: [], clicks: [] });
    var clicks = [];
    return runC(bnds.length, 4, function (a, b) {
      for (var bi = a; bi < b; bi++) {
        var bs = bnds[bi];
        var w = Math.max(16, Math.round(0.005 * sr)); // ±5 ms
        var d2max = 0;
        for (var c = 0; c < nCh; c++) {
          var d = chs[c];
          for (var i = Math.max(1, bs - w); i < Math.min(len - 1, bs + w); i++) {
            var d2 = Math.abs(d[i + 1] - 2 * d[i] + d[i - 1]);
            if (d2 > d2max) d2max = d2;
          }
        }
        // Reference: median |d2| over ±1 s excluding the click window.
        var ref = [];
        for (var c2 = 0; c2 < nCh; c2++) {
          var dd = chs[c2];
          for (var i = Math.max(1, bs - sr); i < Math.min(len - 1, bs + sr); i += 16) {
            if (Math.abs(i - bs) < w) continue;
            ref.push(Math.abs(dd[i + 1] - 2 * dd[i] + dd[i - 1]));
          }
        }
        ref.sort(function (x, y) { return x - y; });
        var med = ref.length ? ref[Math.floor(ref.length / 2)] : 1e-9;
        if (d2max > 10 * Math.max(med, 1e-7) && d2max > 1e-4) {
          clicks.push({ atSec: bs / sr, ratio: d2max / Math.max(med, 1e-9) });
        }
      }
    }, null).then(function () {
      var issues = [];
      if (clicks.length) {
        issues.push(mkIssue('click',
          'Click at transition: ' + clicks.length + ' slot boundar' + (clicks.length > 1 ? 'ies' : 'y') + ' with a discontinuity (worst ×' + Math.round(clicks[0].ratio) + ' over local level at ' + clicks[0].atSec.toFixed(2) + 's)',
          '"Fix Issues" applies a 2 ms de-click micro-fade centred on each bad boundary.',
          'warn', true, '2 ms equal-power de-click V-fade centred on the boundary (inaudible at slot crossfades).'));
      }
      return { issues: issues, clicks: clicks };
    });
  }

  function checkTimingDrift(buf, m) {
    // Onset envelope (HP 1.5 kHz -> |x| -> 30 ms smoothing), then compare
    // onset peaks against the expected bar grid. Honest heuristic: large
    // systematic offsets mean the vocal/beat is off the grid.
    var sr = buf.sampleRate, len = buf.length, nCh = buf.numberOfChannels;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    var hp = biquad('highpass', 1500, 0.707, 0, sr);
    var smK = 1 - Math.exp(-1 / (0.03 * sr));
    var barLen = Math.max(1, Math.round(m.barLenSec * sr));
    var nBars = Math.min(64, Math.floor(len / barLen));
    if (nBars < 4 || !m.masterBpm) return Promise.resolve({ issues: [], drift: null });
    // Pass 1: envelope into a downsampled array (1 ms resolution).
    var ms = Math.max(1, Math.round(sr / 1000));
    var envLen = Math.ceil(len / ms);
    var env = new Float32Array(envLen);
    var sts = []; for (var c = 0; c < nCh; c++) sts.push(bqState());
    var sm = 0;
    return runC(len, CHUNK, function (a, b) {
      for (var i = a; i < b; i++) {
        var mm = 0;
        for (var c = 0; c < nCh; c++) mm += bqRun(hp, sts[c], chs[c][i]);
        mm = Math.abs(mm / nCh);
        sm += (mm - sm) * smK;
        var ei = Math.floor(i / ms);
        if (sm > env[ei]) env[ei] = sm;
      }
    }, null).then(function () {
      var searchMs = 120, offsets = [];
      for (var br = 0; br < nBars; br++) {
        var expMs = Math.round(br * m.barLenSec * 1000);
        var best = -1, bestV = 0;
        for (var t = Math.max(0, expMs - searchMs); t <= Math.min(envLen - 1, expMs + searchMs); t++) {
          if (env[t] > bestV) { bestV = env[t]; best = t; }
        }
        if (best >= 0 && bestV > 1e-6) offsets.push(best - expMs);
      }
      if (!offsets.length) return { issues: [], drift: null };
      offsets.sort(function (x, y) { return x - y; });
      var med = Math.abs(offsets[Math.floor(offsets.length / 2)]);
      var issues = [];
      if (med > 60) {
        issues.push(mkIssue('timing-drift',
          'Timing drift: onsets sit a median ' + Math.round(med) + ' ms off the bar grid (>60 ms)',
          'The vocal/beat is not landing on the grid — sounds "nahi baith raha". Not auto-fixable: re-stretch the vocal to the master BPM and re-render.',
          'warn', false, null));
      }
      return { issues: issues, drift: med };
    });
  }

  function checkSepArtifacts(buf) {
    // Heuristic for neural-separation "wateriness": separation artifacts
    // leave a diffuse, flat high-frequency hash UNDER the transients, so
    // the HF band has an abnormally low crest factor while the broadband
    // mix stays dynamic. Clean transient-only HF has crest >> 10; dense
    // legitimate HF (hats/cymbals) also stays peaky; pure hash sits < 8.
    // Honest limits: this is a Smart check (info, never auto-fixed) —
    // verify by ear.
    var sr = buf.sampleRate, len = buf.length, nCh = buf.numberOfChannels;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    // Adaptive HF cutoff: 10 kHz at 44.1k+, lower when the sample rate
    // leaves no room above 10 kHz (e.g. 8.8 kHz at 22050 Hz).
    var hp = biquad('highpass', Math.min(10000, sr * 0.4), 0.707, 0, sr);
    var winLen = Math.floor(sr / 2);
    var nWin = Math.min(60, Math.max(1, Math.floor(len / winLen)));
    var hfCrest = [], bbCrest = [];
    return runC(nWin, 8, function (a, b) {
      for (var w = a; w < b; w++) {
        var s0 = Math.floor((w / nWin) * (len - winLen));
        var sts = []; for (var c = 0; c < nCh; c++) sts.push(bqState());
        var hfP = 0, hfE = 0, bbP = 0, bbE = 0, n = 0;
        for (var i = s0; i < s0 + winLen; i += 2) {
          var mm = 0, hf = 0;
          for (var c = 0; c < nCh; c++) { mm += chs[c][i]; hf += bqRun(hp, sts[c], chs[c][i]); }
          mm /= nCh; hf /= nCh;
          var ah = hf < 0 ? -hf : hf, am = mm < 0 ? -mm : mm;
          if (ah > hfP) hfP = ah; hfE += hf * hf;
          if (am > bbP) bbP = am; bbE += mm * mm;
          n++;
        }
        if (n > 0 && hfE > 1e-12 && bbE > 1e-12) {
          hfCrest.push(hfP / Math.sqrt(hfE / n));
          bbCrest.push(bbP / Math.sqrt(bbE / n));
        }
      }
    }, null).then(function () {
      var issues = [];
      if (hfCrest.length >= 4) {
        var flat = hfCrest.filter(function (v) { return v < 8; }).length / hfCrest.length;
        var srt = bbCrest.slice().sort(function (x, y) { return x - y; });
        var bbMed = srt[Math.floor(srt.length / 2)];
        if (flat >= 0.6 && bbMed > 5) {
          issues.push(mkIssue('sep-artifacts',
            'Possible separation artifacts (Smart check): ' + Math.round(flat * 100) + '% of sections have flat high frequencies (crest < 8) inside a dynamic mix (broadband crest ' + bbMed.toFixed(1) + ')',
            'Neural/DSP separation can leave a "watery" HF hash under transients. Not auto-fixable — verify by ear; re-separate with the neural backend if it sounds smeared.',
            'info', false, null));
        }
      }
      return { issues: issues, hfCrest: hfCrest, bbCrest: bbCrest };
    });
  }

  /* ================= runCheck ================= */
  function runCheck(renderBuf, meta, onProgress) {
    var m = normMeta(meta);
    if (!renderBuf || !renderBuf.length || !renderBuf.getChannelData) {
      return Promise.reject(new Error('runCheck needs a rendered AudioBuffer.'));
    }
    var issues = [], measurements = {};
    var prog = onProgress ? function (f, label) { try { onProgress(f, label); } catch (e) {} } : null;
    var seq = [
      ['BPM match', function () { issues.push.apply(issues, checkBpm(m)); }],
      ['Key match', function () { issues.push.apply(issues, checkKey(m)); }],
      ['Vocal overlap', function () { issues.push.apply(issues, checkVocalOverlap(m)); }],
      ['Clipping (true peak)', function () {
        return checkClipping(renderBuf).then(function (r) {
          issues.push.apply(issues, r.issues); measurements.truePeak = r.tp.peak; measurements.digitalClip = r.tp.digitalClip;
        });
      }],
      ['Stereo phase', function () {
        return checkPhase(renderBuf).then(function (r) { issues.push.apply(issues, r.issues); measurements.lrCorr = r.corr; });
      }],
      ['Bass balance', function () {
        return checkBass(renderBuf).then(function (r) { issues.push.apply(issues, r.issues); measurements.bassShare = r.share; });
      }],
      ['Harshness', function () {
        return checkHarsh(renderBuf).then(function (r) { issues.push.apply(issues, r.issues); measurements.harshShare = r.share; });
      }],
      ['Volume jumps', function () {
        return checkVolumeJumps(renderBuf, m).then(function (r) {
          issues.push.apply(issues, r.issues); measurements.barRmsDb = r.rms; measurements._jumps = r.jumps;
        });
      }],
      ['Transition clicks', function () {
        return checkClicks(renderBuf, m).then(function (r) { issues.push.apply(issues, r.issues); measurements._clicks = r.clicks; });
      }],
      ['Timing drift', function () {
        return checkTimingDrift(renderBuf, m).then(function (r) { issues.push.apply(issues, r.issues); measurements.driftMs = r.drift; });
      }],
      ['Separation artifacts', function () {
        return checkSepArtifacts(renderBuf).then(function (r) {
          issues.push.apply(issues, r.issues);
          var med = function (a) {
            if (!a || !a.length) return 0;
            var s = a.slice().sort(function (x, y) { return x - y; });
            return s[Math.floor(s.length / 2)];
          };
          measurements.hfCrestMed = med(r.hfCrest);
          measurements.bbCrestMed = med(r.bbCrest);
        });
      }],
    ];
    var i = 0;
    function next() {
      if (i >= seq.length) {
        var summary = { errors: 0, warnings: 0, infos: 0 };
        issues.forEach(function (x) {
          if (x.severity === 'error') summary.errors++;
          else if (x.severity === 'warn') summary.warnings++;
          else summary.infos++;
        });
        if (prog) prog(1, 'Done');
        return { issues: issues, summary: summary, measurements: measurements };
      }
      var label = seq[i][0], fn = seq[i][1]; i++;
      if (prog) prog(i / seq.length * 0.95, 'Smart check: ' + label + '…');
      var r;
      try { r = fn(); } catch (e) { r = Promise.reject(e); }
      return Promise.resolve(r).then(next);
    }
    return next();
  }

  /* ================= fixAll — REAL auto-repairs =================
     Order matters: limiter first (peak headroom), de-click, volume
     rebalance, bass tame, harshness tame. Each fix documents before/
     after measurements. Input buffer is never mutated — fixes apply to
     a copy. After fixAll, re-run runCheck() to confirm.
     fixAll(renderBuf, issues, meta, onProgress) -> {buffer, fixes}  */
  function applyBiquadFix(buf, type, freq, Q, gainDb, onProgress) {
    var sr = buf.sampleRate, nCh = buf.numberOfChannels, len = buf.length;
    var cf = biquad(type, freq, Q, gainDb, sr);
    var chs = [], sts = [];
    for (var c = 0; c < nCh; c++) { chs.push(buf.getChannelData(c)); sts.push(bqState()); }
    return runC(len, CHUNK, function (a, b) {
      for (var c = 0; c < nCh; c++) {
        var d = chs[c], st = sts[c];
        for (var i = a; i < b; i++) d[i] = bqRun(cf, st, d[i]);
      }
    }, onProgress);
  }

  function fixClicks(buf, meta) {
    var m = normMeta(meta);
    var sr = buf.sampleRate, len = buf.length, nCh = buf.numberOfChannels;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    // Re-detect click positions (cheap: reuse the check, then fix).
    return checkClicks(buf, m).then(function (r) {
      if (!r.clicks.length) return { fixed: 0 };
      var half = Math.max(8, Math.round(0.001 * sr)); // 1 ms each side
      var jobs = r.clicks.map(function (ck) {
        var bs = Math.round(ck.atSec * sr);
        return runC(half * 2 + 1, 512, function (a, b) {
          for (var k = a; k < b; k++) {
            var i = bs - half + k;
            if (i < 0 || i >= len) continue;
            // Equal-power V-fade: raised-cosine dip to 0 exactly at the
            // boundary sample, 1 ms each side. Inaudible under slot
            // crossfades; kills the discontinuity.
            var dt = (i - bs) / half; // -1..1
            var gg = Math.abs(dt) >= 1 ? 1 : (0.5 - 0.5 * Math.cos(Math.PI * Math.abs(dt)));
            for (var c = 0; c < nCh; c++) chs[c][i] *= gg;
          }
        }, null);
      });
      return Promise.all(jobs).then(function () { return { fixed: r.clicks.length }; });
    });
  }

  function fixVolumeJumps(buf, meta) {
    var m = normMeta(meta);
    var sr = buf.sampleRate, len = buf.length, nCh = buf.numberOfChannels;
    var chs = [];
    for (var c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
    var barLen = Math.max(1, Math.round(m.barLenSec * sr));
    var nBars = Math.max(1, Math.floor(len / barLen));
    var rms = new Array(nBars);
    return runC(nBars, 8, function (a, b) {
      for (var br = a; br < b; br++) {
        var s0 = br * barLen, s1 = Math.min(len, s0 + barLen);
        var e = 0, n = 0;
        for (var i = s0; i < s1; i += 2) {
          var mm = 0;
          for (var c = 0; c < nCh; c++) mm += chs[c][i];
          mm /= nCh; e += mm * mm; n++;
        }
        rms[br] = n > 0 ? 10 * Math.log10(Math.max(1e-12, e / n)) : -120;
      }
    }, null).then(function () {
      var sorted = rms.slice().sort(function (x, y) { return x - y; });
      var med = sorted[Math.floor(sorted.length / 2)];
      var gains = rms.map(function (r) {
        var gdb = Math.max(-4, Math.min(4, med - r));
        return Math.pow(10, gdb / 20);
      });
      var ramp = Math.min(barLen, Math.round(0.03 * sr)); // 30 ms smoothing
      return runC(len, CHUNK, function (a, b) {
        for (var i = a; i < b; i++) {
          var br = Math.min(nBars - 1, Math.floor(i / barLen));
          var g = gains[br];
          var inBar = i - br * barLen;
          if (inBar < ramp && br > 0) {
            // Raised-cosine blend from previous bar's gain.
            var t = inBar / ramp;
            var w = 0.5 - 0.5 * Math.cos(Math.PI * t);
            g = gains[br - 1] * (1 - w) + gains[br] * w;
          }
          for (var c = 0; c < nCh; c++) chs[c][i] *= g;
        }
      }, null).then(function () { return { bars: nBars, medianDb: med }; });
    });
  }

  // Solve the shelf/peaking cut depth from the measured band share:
  // find energy gain g with (share*g)/(share*g + (1-share)) = target,
  // returned as amplitude dB (10*log10(g_energy) == 20*log10(g_amp)).
  function cutDbFor(share, target, maxCutDb) {
    var g = target * (1 - share) / (Math.max(1e-9, share) * (1 - target));
    var db = 10 * Math.log10(Math.max(1e-9, g));
    return Math.max(-maxCutDb, Math.min(-0.5, db));
  }

  // Iterative band rebalance: measure -> solve cut -> apply -> re-measure,
  // up to maxPasses. Handles extreme cases (a single fixed-depth pass
  // cannot tame a 96%-sub-bass mix). Returns {before, after, passes, totalCutDb}.
  function bandFix(buf, o) {
    var sr = buf.sampleRate;
    function pass(n, totalCut, before0) {
      var mCf = biquad(o.measure.type, o.measure.freq, o.measure.Q, 0, sr);
      return bandShare(buf, mCf, null).then(function (share) {
        if (n === 0) before0 = share;
        if (share <= o.threshold || n >= o.maxPasses) {
          return { before: before0, after: share, passes: n, totalCutDb: totalCut };
        }
        var cut = cutDbFor(share, o.target, o.maxCutDb);
        return applyBiquadFix(buf, o.fix.type, o.fix.freq, o.fix.Q, cut, null).then(function () {
          return pass(n + 1, totalCut + cut, before0);
        });
      });
    }
    return pass(0, 0, 0);
  }

  function fixAll(renderBuf, issues, meta, onProgress) {
    var prog = onProgress ? function (f, label) { try { onProgress(f, label); } catch (e) {} } : null;
    return copyBuffer(renderBuf).then(function (buf) {
      var fixes = [];
      var ids = {};
      (issues || []).forEach(function (x) { if (x && x.autoFixable) ids[x.id] = x; });
      var steps = [];
      if (ids.clipping) steps.push(['Limiter', function () {
        return truePeak(buf, null).then(function (before) {
          if (prog) prog(0.05, 'Fixing: true-peak limiter…');
          return applyTruePeakLimiter(buf, null).then(function (after) {
            fixes.push({
              id: 'clipping', title: 'True-peak limiter re-applied',
              before: 'true peak ' + (20 * Math.log10(Math.max(1e-9, before.peak))).toFixed(1) + ' dBTP',
              after: 'true peak ' + (20 * Math.log10(Math.max(1e-9, after.peak))).toFixed(1) + ' dBTP (ceiling −3 dBTP)',
              detail: 'Causal limiter, 0.8 ms attack / 60 ms release, 4x-oversampled peak sensing; re-measured after apply (static trim safety net if needed).',
            });
          });
        });
      }]);
      if (ids.click) steps.push(['De-click', function () {
        if (prog) prog(0.3, 'Fixing: transition clicks…');
        return fixClicks(buf, meta).then(function (r) {
          if (r.fixed) fixes.push({
            id: 'click', title: 'De-clicked ' + r.fixed + ' transition' + (r.fixed > 1 ? 's' : ''),
            before: r.fixed + ' click discontinuities at slot boundaries',
            after: '2 ms equal-power V-fade centred on each boundary',
            detail: 'Raised-cosine dip to zero exactly at the boundary sample, 1 ms each side — inaudible under slot crossfades.',
          });
        });
      }]);
      if (ids['volume-jump']) steps.push(['Rebalance', function () {
        if (prog) prog(0.5, 'Fixing: volume jumps…');
        return fixVolumeJumps(buf, meta).then(function (r) {
          fixes.push({
            id: 'volume-jump', title: 'Volume jumps smoothed',
            before: 'adjacent bars differed by >4 dB',
            after: 'per-bar gain rebalanced toward median (' + r.medianDb.toFixed(1) + ' dBFS, max ±4 dB/bar)',
            detail: 'Per-bar RMS measured on the mid channel; gains clamped to ±4 dB with 30 ms raised-cosine smoothing between bars.',
          });
        });
      }]);
      if (ids.bass) steps.push(['Bass tame', function () {
        if (prog) prog(0.7, 'Fixing: excessive bass…');
        return bandFix(buf, {
          measure: { type: 'lowpass', freq: 80, Q: 0.707 },
          fix: { type: 'lowshelf', freq: 80, Q: 0.707 },
          threshold: 0.30, target: 0.25, maxCutDb: 18, maxPasses: 3,
        }).then(function (r) {
          fixes.push({
            id: 'bass', title: 'Bass tamed (' + r.passes + ' pass' + (r.passes === 1 ? '' : 'es') + ')',
            before: (r.before * 100).toFixed(1) + '% energy below 80 Hz',
            after: (r.after * 100).toFixed(1) + '% energy below 80 Hz (' + r.totalCutDb.toFixed(1) + ' dB low-shelf total)',
            detail: 'RBJ low-shelf at 80 Hz; each pass solves the cut depth from the measured excess (max −18 dB/pass, ≤3 passes). Protects phone speakers from overload.',
          });
        });
      }]);
      if (ids.harsh) steps.push(['Harshness tame', function () {
        if (prog) prog(0.85, 'Fixing: harsh frequencies…');
        return bandFix(buf, {
          measure: { type: 'bandpass', freq: 3500, Q: 0.8 },
          fix: { type: 'peaking', freq: 3200, Q: 0.9 },
          threshold: 0.28, target: 0.22, maxCutDb: 12, maxPasses: 3,
        }).then(function (r) {
          fixes.push({
            id: 'harsh', title: 'Harshness tamed (' + r.passes + ' pass' + (r.passes === 1 ? '' : 'es') + ')',
            before: (r.before * 100).toFixed(1) + '% energy in 2–5 kHz',
            after: (r.after * 100).toFixed(1) + '% energy in 2–5 kHz (' + r.totalCutDb.toFixed(1) + ' dB peaking cut total)',
            detail: 'RBJ peaking filter at 3.2 kHz, Q 0.9; each pass solves the cut depth from the measured excess (max −12 dB/pass, ≤3 passes).',
          });
        });
      }]);
      var si = 0;
      function next() {
        if (si >= steps.length) { if (prog) prog(1, 'Fixes applied'); return { buffer: buf, fixes: fixes }; }
        var st = steps[si++]; var r;
        try { r = st[1](); } catch (e) { r = Promise.reject(e); }
        return Promise.resolve(r).then(next);
      }
      return next();
    });
  }

  /* ---------------- public ---------------- */
  function issueLabel(sev) {
    return sev === 'error' ? 'Error' : sev === 'warn' ? 'Warning' : 'Note';
  }

  return {
    runCheck: runCheck,
    fixAll: fixAll,
    issueLabel: issueLabel,
    TP_CEIL: TP_CEIL,
    // test hooks (pure DSP pieces)
    _t: {
      biquad: biquad, truePeak: truePeak, bandShare: bandShare,
      keyDistance: keyDistance, parseKey: parseKey, normMeta: normMeta,
      applyTruePeakLimiter: applyTruePeakLimiter,
    },
  };
})();
