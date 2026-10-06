'use strict';
/* =====================================================================
   RuhMix — v27-sections.js (v27 W2: smart section detection)

   Content-aware section detection for the mashup arrangement path.
   Pure DSP heuristics — NO neural models, NO "AI chorus detection".

   Algorithm (detectSections(audioBuffer, bpm)):
     1. Downmix to mono. Guard: empty / silent / <8 bars → honest fallback.
     2. Per-2-bar blocks: RMS energy, spectral centroid, vocal-activity
        (energy ratio in 300–3400 Hz + spectral flatness as voicing proxy),
        onset density (coarse spectral-flux peaks). FFTs are capped per
        block so this stays cheap on phones.
     3. Robust min-max normalisation across blocks, 3-block moving-average
        smoothing.
     4. Change-point detection: weighted L2 distance of feature deltas
        between adjacent blocks; boundaries = local maxima above
        median + 2·MAD, minimum section length 8 bars (merge short ones).
     5. Honest labels: 'high-energy' / 'vocal-forward' / 'breakdown' /
        'build' / 'unknown', each with a confidence in 0..1 and a plain
        display string. NEVER "AI detected chorus" — strings say
        "Likely hook (high energy + vocal)" etc.

   suggestArrangement(detection) orders the detected sections into the
   canonical intro → build → hook → breakdown → hook → outro plan the
   arrangement engine can consume, and degrades gracefully: when
   detection is uncertain it returns { fallback: true } with an honest
   note saying the 8-bar grid is used instead.

   Consumer wiring (ONE integration point): mashup-mega.js runs
   detectSections on each separated vocal before trimToBars and starts
   the vocal slot at the detected hook (hookStartBar) when its confidence
   is ≥ HOOK_CONF_THRESHOLD — the detected hook becomes the preferred
   vocal-slot source.

   Node-testable: no DOM / AudioContext dependencies. Load with the
   same FakeAudioBuffer shim as test-mashup-dsp-node.js.
   ===================================================================== */
window.RM = window.RM || {};

RM.v27sections = (function () {
  /* ---------------- tunables ---------------- */
  var FFT_SIZE = 2048;
  var HOP = 1024;
  var MAX_WIN_PER_BLOCK = 24;    // cap: cheap on phones
  var BLOCK_BARS = 2;            // feature resolution: one feature row per 2 bars
  var MIN_SECTION_BARS = 8;      // minimum section length
  var MIN_BARS_TOTAL = 8;        // below this → honest fallback
  var VOCAL_LO = 300, VOCAL_HI = 3400; // vocal-activity band (Hz)
  var HOOK_CONF_THRESHOLD = 0.6; // min confidence to trust the hook

  /* ---------------- honest labels ---------------- */
  // These are the ONLY section label strings. They must never claim
  // neural/AI chorus detection.
  var LABELS = {
    'high-energy': 'Likely hook (high energy + vocal)',
    'vocal-forward': 'Vocal-forward passage (DSP heuristic)',
    'breakdown': 'Breakdown (low energy)',
    'build': 'Build-up (rising energy)',
    'unknown': 'Unlabeled section (mixed signals)'
  };
  var ALLOWED_LABELS = Object.keys(LABELS);

  function labelText(label) { return LABELS[label] || LABELS['unknown']; }
  function clamp01(v) { v = Number(v); return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mad(a, med) {
    med = (med == null) ? median(a) : med;
    return median(a.map(function (v) { return Math.abs(v - med); }));
  }
  // Robust scale with a range fallback: MAD is exactly 0 whenever more
  // than half the values are identical (common with steppy features),
  // which would otherwise collapse every normalised feature to 0.5.
  function scaleOf(col) {
    var m = median(col), md = mad(col, m);
    var s = 1.4826 * md;
    if (!(s > 1e-12)) {
      var lo = Infinity, hi = -Infinity, i;
      for (i = 0; i < col.length; i++) {
        if (col[i] < lo) lo = col[i];
        if (col[i] > hi) hi = col[i];
      }
      s = (hi - lo) / 2;
      if (!(s > 1e-12)) s = 1; // constant column
    }
    return { med: m, scale: s };
  }
  // Min-max normalisation to 0..1 (linear — crisp contrast for change
  // points); columns whose range is below `floor` are treated as
  // constant (0.5) so measurement noise is never amplified to full
  // scale. Floors are absolute feature units.
  function minMaxNorm(col, floor) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < col.length; i++) {
      if (col[i] < lo) lo = col[i];
      if (col[i] > hi) hi = col[i];
    }
    floor = isFinite(Number(floor)) ? Number(floor) : 1e-12;
    if (!((hi - lo) > floor)) return col.map(function () { return 0.5; });
    return col.map(function (v) { return (v - lo) / (hi - lo); });
  }
  // Voicing proxy from raw spectral flatness (absolute mapping, not
  // min-maxed — tiny 1e-4 differences between tonal signals must not
  // blow up to full scale). Tonal ≈ 1, noisy ≈ 0.
  function voicingOf(flatness) {
    return 1 / (1 + Math.exp((flatness - 0.2) / 0.08));
  }

  /* ---------------- FFT (radix-2, in-place) ---------------- */
  function fft(re, im) {
    var n = re.length, j = 0, i, k, m;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (m = 2; m <= n; m <<= 1) {
      var ang = -2 * Math.PI / m;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      var half = m >> 1;
      for (k = 0; k < n; k += m) {
        var cur_r = 1, cur_i = 0;
        for (j = 0; j < half; j++) {
          var a = k + j, b = k + j + half;
          var xr = re[b] * cur_r - im[b] * cur_i;
          var xi = re[b] * cur_i + im[b] * cur_r;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var nr = cur_r * wr - cur_i * wi;
          cur_i = cur_r * wi + cur_i * wr;
          cur_r = nr;
        }
      }
    }
  }

  var _hann = null;
  function hann(n) {
    if (_hann && _hann.length === n) return _hann;
    _hann = new Float64Array(n);
    for (var i = 0; i < n; i++) _hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
    return _hann;
  }

  /* ---------------- per-block feature extraction ---------------- */
  // Returns { energy, centroid, vocalBand, flatness, onsetDensity }.
  // mono: Float32/Float64Array, start..end sample range, sr.
  function blockFeatures(mono, start, end, sr) {
    var len = end - start;
    if (len <= 0) return null;
    var i, s, acc = 0;
    for (i = start; i < end; i++) { s = mono[i]; acc += s * s; }
    var energy = Math.sqrt(acc / len);

    var win = hann(FFT_SIZE);
    var re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
    var binHz = sr / FFT_SIZE, half = FFT_SIZE / 2;
    var nWin = Math.max(1, Math.floor((len - FFT_SIZE) / HOP) + 1);
    var stride = Math.max(1, Math.ceil(nWin / MAX_WIN_PER_BLOCK));
    var prevMag = null, fluxVals = [], fluxCount = 0;
    var centSum = 0, bandSum = 0, flatSum = 0, totSum = 0, wCount = 0;
    var loBin = Math.max(1, Math.floor(VOCAL_LO / binHz));
    var hiBin = Math.min(half - 1, Math.ceil(VOCAL_HI / binHz));

    for (var w = 0; w < nWin; w += stride) {
      var off = start + w * HOP;
      if (off + FFT_SIZE > end) break;
      for (i = 0; i < FFT_SIZE; i++) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      var mag = new Float64Array(half);
      var cNum = 0, cDen = 0, band = 0, tot = 0, logSum = 0;
      for (i = 1; i < half; i++) {
        var p = re[i] * re[i] + im[i] * im[i];
        mag[i] = Math.sqrt(p);
        tot += p; cNum += (i * binHz) * p; cDen += p;
        if (i >= loBin && i <= hiBin) band += p;
        logSum += Math.log(p + 1e-12);
      }
      var nb = half - 1;
      if (cDen > 1e-18) {
        centSum += cNum / cDen;
        bandSum += band / tot;
        var geo = Math.exp(logSum / nb), ari = tot / nb;
        flatSum += ari > 1e-18 ? geo / ari : 1; // 1 = max flatness
        totSum += 1; wCount++;
      }
      if (prevMag) {
        var fl = 0;
        for (i = 1; i < half; i++) { var d = mag[i] - prevMag[i]; if (d > 0) fl += d; }
        fluxVals.push(fl); fluxCount++;
      }
      prevMag = mag;
    }
    if (!wCount) return { energy: energy, centroid: 0, vocalBand: 0, flatness: 1, onsetDensity: 0 };

    var onsetDensity = 0;
    if (fluxCount) {
      var fMed = median(fluxVals);
      var hits = 0;
      for (i = 0; i < fluxVals.length; i++) if (fluxVals[i] > 1.5 * (fMed + 1e-9)) hits++;
      onsetDensity = hits / fluxCount;
    }
    return {
      energy: energy,
      centroid: centSum / wCount,
      vocalBand: bandSum / wCount,
      flatness: flatSum / wCount,   // 0..1; low = harmonic/voiced
      onsetDensity: onsetDensity
    };
  }

  /* ---------------- detection ---------------- */
  function fallback(note) {
    return {
      fallback: true,
      note: note || 'Section detection uncertain — using 8-bar grid.',
      sections: [],
      meanConf: 0
    };
  }

  function detectSections(audioBuffer, bpm) {
    try {
      if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function' ||
          !isFinite(audioBuffer.length) || audioBuffer.length < 64) {
        return fallback('No audio to analyze — using 8-bar grid.');
      }
      var sr = Number(audioBuffer.sampleRate);
      bpm = Number(bpm);
      if (!isFinite(sr) || sr <= 0 || !isFinite(bpm) || bpm < 50 || bpm > 240) {
        return fallback('Tempo unknown or invalid — using 8-bar grid.');
      }
      var barLen = Math.round(240 / bpm * sr);       // 4 beats per bar
      var totalBars = Math.floor(audioBuffer.length / barLen);
      if (totalBars < MIN_BARS_TOTAL) {
        return fallback('Audio shorter than 8 bars — using 8-bar grid.');
      }
      var nCh = Math.max(1, audioBuffer.numberOfChannels || 1);
      var mono = new Float64Array(audioBuffer.length);
      var ch0 = audioBuffer.getChannelData(0);
      var c, i;
      if (nCh === 1) { for (i = 0; i < mono.length; i++) mono[i] = ch0[i]; }
      else {
        for (i = 0; i < mono.length; i++) mono[i] = 0;
        for (c = 0; c < nCh; c++) {
          var d = audioBuffer.getChannelData(c);
          for (i = 0; i < mono.length; i++) mono[i] += d[i] / nCh;
        }
      }
      // Global silence check.
      var acc = 0;
      for (i = 0; i < mono.length; i += 16) { var v = mono[i]; acc += v * v; }
      if (Math.sqrt(acc / Math.ceil(mono.length / 16)) < 1e-5) {
        return fallback('Audio is silent — using 8-bar grid.');
      }

      var nBlocks = Math.floor(totalBars / BLOCK_BARS);
      var feats = [];
      for (var b = 0; b < nBlocks; b++) {
        var f = blockFeatures(mono, b * BLOCK_BARS * barLen, (b + 1) * BLOCK_BARS * barLen, sr);
        if (f) feats.push(f);
      }
      if (feats.length < 4) return fallback('Too few analysis blocks — using 8-bar grid.');

      /* -- normalisation of each feature across blocks (min-max) -- */
      // Range floors (absolute units): energy RMS, centroid Hz,
      // vocal-band ratio, onset density.
      var FLOORS = { energy: 0.005, centroid: 30, vocalBand: 0.03, onsetDensity: 0.05 };
      var keys = ['energy', 'centroid', 'vocalBand', 'onsetDensity'];
      var norms = {};
      keys.forEach(function (k) {
        norms[k] = minMaxNorm(feats.map(function (f) { return f[k]; }), FLOORS[k]);
      });
      norms.voicing = feats.map(function (f) { return voicingOf(f.flatness); });
      // Composite vocal-activity feature: band energy × voicing.
      var vocalAct = norms.vocalBand.map(function (bnd, j) {
        return 0.55 * bnd + 0.45 * norms.voicing[j];
      });
      // Feature vector per block (0..1): [energy, centroid, vocalAct, onset]
      var vec = feats.map(function (_, j) {
        return [norms.energy[j], norms.centroid[j], vocalAct[j], norms.onsetDensity[j]];
      });
      /* -- 3-block moving-average smoothing -- */
      function smooth(col) {
        return col.map(function (_, j) {
          var s = 0, n = 0;
          for (var k = -1; k <= 1; k++) {
            var jj = j + k;
            if (jj >= 0 && jj < col.length) { s += col[jj]; n++; }
          }
          return s / n;
        });
      }
      var vecS = vec[0].map(function (_, dim) {
        return smooth(vec.map(function (r) { return r[dim]; }));
      });
      vecS = vecS[0].map(function (_, j) {
        return vecS.map(function (col) { return col[j]; });
      });

      /* -- change-point detection on feature deltas -- */
      var W = [0.45, 0.15, 0.25, 0.15]; // energy, centroid, vocalAct, onset
      var deltas = [];
      for (i = 0; i < vecS.length - 1; i++) {
        var d2 = 0;
        for (var q = 0; q < 4; q++) {
          var dd = vecS[i + 1][q] - vecS[i][q];
          d2 += W[q] * dd * dd;
        }
        deltas.push(Math.sqrt(d2));
      }
      var dMed = median(deltas), dMad = mad(deltas, dMed);
      var thresh = dMed + 2 * (1.4826 * dMad);
      if (thresh < 0.05) thresh = 0.05; // don't over-segment flat music

      var minBlocks = Math.max(2, Math.round(MIN_SECTION_BARS / BLOCK_BARS));
      // Boundaries: runs of consecutive above-threshold deltas are one
      // smeared transition (smoothing spreads a step over ~3 blocks) —
      // the boundary sits at the run's CENTER, not at the argmax (the
      // argmax is tilted by measurement noise and lands a block off).
      // A 5% relative margin (not strict `>`) because a degenerate MAD
      // can make the threshold sit inside the peak plateau.
      var bounds = [];
      var ri = 0;
      while (ri < deltas.length) {
        if (deltas[ri] >= thresh * 0.95) {
          var rj = ri;
          while (rj + 1 < deltas.length && deltas[rj + 1] >= thresh * 0.95) rj++;
          var midIdx = Math.floor((ri + rj) / 2);
          bounds.push({ at: midIdx + 1, strength: deltas[midIdx] });
          ri = rj + 1;
        } else ri++;
      }
      bounds.sort(function (a, b) { return b.strength - a.strength; });
      var accepted = [];
      bounds.forEach(function (bd) {
        var okB = accepted.every(function (a) { return Math.abs(a - bd.at) >= minBlocks; });
        if (okB) accepted.push(bd.at);
      });
      accepted.sort(function (a, b) { return a - b; });
      // Merge trailing short tail / short sections into the more similar neighbour.
      var edges = [0].concat(accepted, [vecS.length]);
      var segs = [];
      for (i = 0; i < edges.length - 1; i++) {
        segs.push({
          b0: edges[i], b1: edges[i + 1],
          boundStrength: i === 0 ? 1 : (function () {
            for (var k = 0; k < bounds.length; k++) if (bounds[k].at === edges[i]) return bounds[k].strength / Math.max(1e-9, thresh);
            return 0.5;
          })()
        });
      }
      for (i = segs.length - 1; i >= 0 && segs.length > 1; i--) {
        if ((segs[i].b1 - segs[i].b0) >= minBlocks) continue;
        // merge into the neighbour with the closer mean energy
        var eMean = mean(vecS.slice(segs[i].b0, segs[i].b1).map(function (r) { return r[0]; }));
        var prevI = i - 1, nextI = i + 1;
        var pickPrev = false;
        if (prevI >= 0 && nextI < segs.length) {
          var eP = mean(vecS.slice(segs[prevI].b0, segs[prevI].b1).map(function (r) { return r[0]; }));
          var eN = mean(vecS.slice(segs[nextI].b0, segs[nextI].b1).map(function (r) { return r[0]; }));
          pickPrev = Math.abs(eMean - eP) <= Math.abs(eMean - eN);
        } else pickPrev = prevI >= 0;
        if (pickPrev) {
          segs[prevI].b1 = segs[i].b1; segs.splice(i, 1);
        } else {
          segs[nextI].b0 = segs[i].b0; segs.splice(i, 1);
        }
      }
      if (!segs.length) return fallback('No stable sections found — using 8-bar grid.');

      /* -- honest labelling from robust z-scores -- */
      var allE = vecS.map(function (r) { return r[0]; });
      var allV = vecS.map(function (r) { return r[2]; });
      var sE = scaleOf(allE), sV = scaleOf(allV);
      var medE = sE.med, madE = sE.scale;
      var medV = sV.med, madV = sV.scale;

      var sections = segs.map(function (sg) {
        var rows = vecS.slice(sg.b0, sg.b1);
        var e = mean(rows.map(function (r) { return r[0]; }));
        var vv = mean(rows.map(function (r) { return r[2]; }));
        var zE = (e - medE) / madE, zV = (vv - medV) / madV;
        // rising-energy trend check for 'build'
        var firstHalf = rows.slice(0, Math.ceil(rows.length / 2));
        var lastHalf = rows.slice(Math.ceil(rows.length / 2));
        var trend = 0;
        if (firstHalf.length && lastHalf.length) {
          var ef = mean(firstHalf.map(function (r) { return r[0]; }));
          var el = mean(lastHalf.map(function (r) { return r[0]; }));
          trend = ef > 1e-9 ? (el - ef) / ef : 0;
        }
        var label, conf;
        if (zE > 0.5 && zV > 0.25) {
          label = 'high-energy';
          conf = clamp01(0.35 + 0.35 * Math.min(2, zE) / 2 + 0.30 * Math.min(2, Math.max(0, zV)) / 2);
        } else if (zV > 0.5) {
          label = 'vocal-forward';
          conf = clamp01(0.35 + 0.45 * Math.min(2, zV) / 2);
        } else if (zE < -0.75) {
          label = 'breakdown';
          conf = clamp01(0.35 + 0.45 * Math.min(2, -zE) / 2);
        } else if (trend > 0.15) {
          label = 'build';
          conf = clamp01(0.40 + 0.35 * Math.min(1, trend));
        } else {
          label = 'unknown';
          conf = 0.30;
        }
        // boundary strength modulates: a weak boundary caps confidence.
        conf = clamp01(conf * (0.6 + 0.4 * Math.min(1.5, sg.boundStrength) / 1.5));
        return {
          startBar: sg.b0 * BLOCK_BARS,
          bars: (sg.b1 - sg.b0) * BLOCK_BARS,
          label: label,
          labelText: labelText(label),
          confidence: Math.round(conf * 100) / 100,
          energy: Math.round(e * 100) / 100,
          vocalAct: Math.round(vv * 100) / 100,
          source: 'dsp-heuristic'
        };
      });

      var meanConf = sections.length
        ? mean(sections.map(function (s) { return s.confidence; }))
        : 0;
      if (meanConf < 0.35) {
        return fallback('Section labels too uncertain (mean confidence ' +
          Math.round(meanConf * 100) + '%) — using 8-bar grid.');
      }
      return {
        fallback: false,
        note: 'Content-aware sections: per-2-bar energy/vocal-activity ' +
              'analysis (DSP heuristic — not AI chorus detection).',
        sections: sections,
        meanConf: Math.round(meanConf * 100) / 100,
        bars: totalBars,
        blockBars: BLOCK_BARS
      };
    } catch (e) {
      return fallback('Section analysis failed — using 8-bar grid.');
    }
  }

  /* ---------------- hook preference ---------------- */
  // Preferred vocal-slot source: the highest-confidence 'high-energy'
  // section whose confidence ≥ threshold. Returns the start BAR, or -1.
  function hookStartBar(sections, threshold) {
    threshold = isFinite(Number(threshold)) ? Number(threshold) : HOOK_CONF_THRESHOLD;
    if (!Array.isArray(sections) || !sections.length) return -1;
    var best = null;
    sections.forEach(function (s) {
      if (s && s.label === 'high-energy' && Number(s.confidence) >= threshold) {
        if (!best || Number(s.confidence) > Number(best.confidence) ||
            (s.confidence === best.confidence && s.startBar < best.startBar)) {
          best = s;
        }
      }
    });
    return best ? Math.max(0, Math.round(Number(best.startBar))) : -1;
  }

  /* ---------------- arrangement plan ---------------- */
  // Orders detected sections into the canonical intro → build → hook →
  // breakdown → hook → outro plan the arrangement engine can consume.
  function suggestArrangement(detection) {
    if (!detection || detection.fallback ||
        !Array.isArray(detection.sections) || !detection.sections.length) {
      return {
        fallback: true,
        plan: [],
        source: '8-bar-grid',
        note: (detection && detection.note ? detection.note + ' ' : '') +
              'Section detection uncertain — using 8-bar grid.'
      };
    }
    var secs = detection.sections.slice().sort(function (a, b) { return a.startBar - b.startBar; });
    var hooks = secs.filter(function (s) { return s.label === 'high-energy'; })
                    .sort(function (a, b) { return b.confidence - a.confidence; });
    var builds = secs.filter(function (s) { return s.label === 'build'; });
    var breaks = secs.filter(function (s) { return s.label === 'breakdown'; });
    var hook = hooks.length ? hooks[0] : null;
    var plan = [];
    function entry(role, s) {
      return {
        role: role,
        startBar: s.startBar,
        bars: s.bars,
        label: s.label,
        labelText: s.labelText,
        confidence: s.confidence,
        source: 'dsp-heuristic'
      };
    }
    // intro: earliest low-energy section, or the first section
    var intro = secs.filter(function (s) { return s.label === 'breakdown' || s.label === 'unknown'; })[0] || secs[0];
    plan.push(entry('intro', intro));
    if (builds.length) plan.push(entry('build', builds[0]));
    if (hook) {
      plan.push(entry('hook', hook));
      if (breaks.length) plan.push(entry('breakdown', breaks[0]));
      plan.push(entry('hook-reprise', hook));
    }
    // outro: last section if it differs from the hook
    var outro = secs[secs.length - 1];
    if (!hook || outro.startBar !== hook.startBar) plan.push(entry('outro', outro));
    return {
      fallback: false,
      plan: plan,
      source: 'dsp-heuristic',
      note: 'DSP heuristic arrangement — sections found by energy/vocal-activity ' +
            'change detection, not AI chorus detection. ' +
            (hooks.length ? ('Preferred hook: bar ' + hook.startBar + ' (' + hook.labelText + ', confidence ' + hook.confidence + ').')
                          : 'No confident high-energy passage — hook role omitted.')
    };
  }

  /* ---------------- exports ---------------- */
  return {
    detectSections: detectSections,
    suggestArrangement: suggestArrangement,
    hookStartBar: hookStartBar,
    labelText: labelText,
    HOOK_CONF_THRESHOLD: HOOK_CONF_THRESHOLD,
    BLOCK_BARS: BLOCK_BARS,
    MIN_SECTION_BARS: MIN_SECTION_BARS,
    internals: {
      fft: fft,
      blockFeatures: blockFeatures,
      median: median,
      mad: mad
    }
  };
})();

/* Node export (browser-harmless). */
try {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RM.v27sections;
  }
} catch (e) {}
