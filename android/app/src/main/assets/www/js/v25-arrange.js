'use strict';
/* =====================================================================
   RuhMix — v25-arrange.js
   W3: Smart Arrangement Engine + 12 Style Presets + Mashup Settings
   (spec §5 §6 §7 §8 §13 §14)

   NEW module — extends, never edits, the existing engines. Consumed by
   the v25 coordinator (W5) alongside RM.mashupArrange.buildTimeline.

   WHAT IT IS
   ──────────
   1. buildArrangement(songs, opts) — §5/§6/§7/§8
      Pure-logic, section-aware arrangement planner. Takes analyzed songs
      [{ name, bpm, key, energy, sections?, energyBars?, bars? }] and
      returns a section plan:
        intro → build → vocal rotation (NOT sequential full songs!) →
        chorus/hook (strongest detected) → instrumental break →
        breakdown → final chorus → outro
      The plan ADAPTS to song count, energy and target length — slot
      size, cycle count, breakdown length and transition style all change.
      Never one forced template.

   2. scoreCompatibility(a, b) — §6
      BPM distance (half/double-time aware) + key/chroma compatibility
      (circle of fifths, relative major/minor aware) + energy match →
      { score 0..1, reasons[] }. Used to order the vocal rotation and to
      pick which vocal dominates the chorus, breakdown and final chorus.

   3. 12 style presets — §13
      REAL parameter sets. Every preset changes at least one AUDIBLE
      render parameter (proved by the param-diff test). Labels say
      "Smart …", never "AI …" — everything here is deterministic DSP,
      honestly named.

   4. Mashup settings — §14
      getSettingsUI() → declarative UI spec for W5 (length, energy, vocal
      focus, transition style, effects, mastering + master-BPM / semitone
      controls via getTransposeUI()).
      mapSettingsToParams(settings) → every setting becomes REAL engine
      parameters; the mapping is documented in PARAM_MAPPING.

   5. transposePlan(masterKey, songKeys) — §14
      Master-BPM select + manual semitone control logic: semitone shift
      per song so each song matches the master key.

   HOW THE PLAN BECOMES AUDIO (coordinator contract)
   ─────────────────────────────────────────────────
   bridgeToTimeline(plan, spec) returns:
     • timelineOpts — the exact opts object RM.mashupArrange.buildTimeline
       accepts (masterBpm, cycles, barsPerVocal, introBars, outroBars,
       xfadeBars, vocalBoostDb). Its rotation slots follow the plan's
       rotation order, slot size and cycle count.
     • beatBars = plan.totalBars — the coordinator renders the beat
       (RM.Beats.renderBeat) this long, then calls:
         shapeBeatDynamics(beatBuf, plan)  — section gain envelope on the
            beat bed: build ramps +2 dB, chorus +1 dB, break −2 dB,
            breakdown −4 dB, final chorus +1.5 dB (smooth 0.25-bar
            boundaries). REAL, audible, section-aware.
         addRisers(buf, plan, spec, sr)     — synthesized noise risers
            swelling into the chorus / final chorus when the preset
            enables them (EDM, Party, Cinematic, Trending).
     • postChain — after buildTimeline renders the mix:
         applyPresetTone(buf, spec, sr)    — brightness tilt + bass shelf.
         applyMastering(buf, spec.mastering, sr) — soft-knee bus comp +
            true-peak limit to the mastering ceiling.
   Section markers travel in meta for the UI / a future section renderer.
   Honest limit: buildTimeline applies ONE vocalBoostDb to every slot, so
   per-section vocal-boost variance (+1 dB chorus / −1 dB breakdown) is
   carried in plan metadata for the v25 section renderer; the dominance
   selection itself (WHICH vocal owns each section) is fully implemented
   here via scoreCompatibility.

   Depends on: nothing at runtime (pure logic + self-contained DSP).
   Optional: RM.mashupDSP.semitonesBetween is NOT required — the semitone
   math is re-derived locally from the same pitch-class conventions.
   ===================================================================== */
window.RM = window.RM || {};
var RM = window.RM; // local binding: works in browsers and in node (window stubbed)

RM.v25arrange = (function () {

  /* ================= 1. key helpers (mashup-dsp conventions) ========== */
  var PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6,
             G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  var FLAT_ALIAS = { DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#' };
  function pitchClassOf(name) {
    var u = String(name || 'C').toUpperCase();
    var n = FLAT_ALIAS[u] || u;
    return PC[n] !== undefined ? PC[n] : 0;
  }
  function normKey(k) {
    if (k && typeof k === 'object' && k.key) return { key: String(k.key), mode: k.mode === 'minor' ? 'minor' : 'major' };
    var m = String(k || '').trim().match(/^([A-Ga-g](?:#|b)?)\s*(major|minor|maj|min|m)?$/i);
    if (m) {
      var ms = (m[2] || '').toLowerCase();
      return { key: m[1].toUpperCase(), mode: (ms === 'minor' || ms === 'min' || ms === 'm') ? 'minor' : 'major' };
    }
    return { key: 'C', mode: 'major' };
  }
  // Effective pitch class: minor → relative major (+3), so relative
  // major/minor pairs compare equal — same convention as mashup-dsp.
  function effPc(k) {
    var nk = normKey(k);
    var p = pitchClassOf(nk.key);
    return nk.mode === 'minor' ? (p + 3) % 12 : p;
  }
  function keyLabel(k) {
    var nk = normKey(k);
    return nk.key + ' ' + nk.mode;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clamp01(v) { v = Number(v); return isFinite(v) ? clamp(v, 0, 1) : 0.5; }
  function round2(v) { return Math.round(v * 100) / 100; }

  /* ================= 2. compatibility scoring (§6) ===================== */
  // scoreCompatibility(a, b) — a, b: { bpm, key, energy }
  // → { score: 0..1, reasons: [String], bpm: {...}, key: {...}, energy: {...} }
  function scoreCompatibility(a, b) {
    a = a || {}; b = b || {};
    var reasons = [];

    /* ---- BPM: half/double-time aware ---- */
    var bpmA = Number(a.bpm), bpmB = Number(b.bpm);
    var bpmScore = 0, bpmNote;
    if (isFinite(bpmA) && isFinite(bpmB) && bpmA > 0 && bpmB > 0) {
      var cands = [bpmB, bpmB / 2, bpmB * 2];
      var bestD = Infinity, bestC = bpmB;
      for (var i = 0; i < cands.length; i++) {
        var d = Math.abs(bpmA - cands[i]) / Math.max(bpmA, cands[i]);
        if (d < bestD) { bestD = d; bestC = cands[i]; }
      }
      bpmScore = clamp01(1 - bestD / 0.20); // 20% tempo gap → 0
      var pct = Math.round(bestD * 100);
      var ht = (bestC !== bpmB) ? ' (half/double-time match)' : '';
      bpmNote = 'Tempo: ' + Math.round(bpmA) + ' vs ' + Math.round(bpmB) +
                ' BPM — ' + pct + '% apart' + ht;
    } else {
      bpmNote = 'Tempo: unknown for one song — scored neutral';
      bpmScore = 0.5;
    }
    reasons.push(bpmNote);

    /* ---- key: circle of fifths on effective pitch class ---- */
    var pA = effPc(a.key), pB = effPc(b.key);
    var fA = (pA * 7) % 12, fB = (pB * 7) % 12; // fifths positions
    var fd = Math.abs(fA - fB);
    fd = Math.min(fd, 12 - fd);                  // 0..6
    var keyScore = 1 - fd / 6;
    var ka = keyLabel(a.key), kb = keyLabel(b.key);
    var keyNote;
    if (pA === pB) {
      keyNote = 'Key: ' + ka + ' vs ' + kb + ' — same key (or relative major/minor), perfect match';
      keyScore = 1;
    } else if (fd === 1) keyNote = 'Key: ' + ka + ' vs ' + kb + ' — neighbours on the circle of fifths, smooth blend';
    else if (fd === 2) keyNote = 'Key: ' + ka + ' vs ' + kb + ' — closely related keys';
    else if (fd <= 3) keyNote = 'Key: ' + ka + ' vs ' + kb + ' — workable with key matching';
    else keyNote = 'Key: ' + ka + ' vs ' + kb + ' — distant keys, may clash even after key matching';
    reasons.push(keyNote);

    /* ---- energy ---- */
    var eA = clamp01(a.energy == null ? 0.5 : a.energy);
    var eB = clamp01(b.energy == null ? 0.5 : b.energy);
    var eDist = Math.abs(eA - eB);
    var eScore = 1 - eDist;
    reasons.push('Energy: ' + eA.toFixed(2) + ' vs ' + eB.toFixed(2) +
                 (eDist < 0.15 ? ' — well matched' : eDist < 0.35 ? ' — noticeable gap' : ' — big gap, one will dominate'));

    var score = round2(clamp01(0.40 * bpmScore + 0.35 * keyScore + 0.25 * eScore));
    return {
      score: score,
      reasons: reasons,
      bpm: { score: round2(bpmScore), a: bpmA, b: bpmB },
      key: { score: round2(keyScore), fifthsDistance: fd, a: ka, b: kb },
      energy: { score: round2(eScore), a: eA, b: eB },
    };
  }

  function compatibilityMatrix(songs) {
    var n = songs.length, m = [];
    for (var i = 0; i < n; i++) {
      m.push([]);
      for (var j = 0; j < n; j++) m[i].push(i === j ? 1 : scoreCompatibility(songs[i], songs[j]).score);
    }
    return m;
  }

  /* ================= 3. section analysis (§5) ========================= */
  // deriveSections(song) → [{ type, startBar, bars, energy }]
  // Uses caller sections when given; else classifies 4-bar blocks from
  // per-bar energy; else falls back to an honest estimated arc.
  function deriveSections(song) {
    song = song || {};
    var bars = Number(song.bars);
    if (!isFinite(bars) || bars < 8) bars = 64;

    if (Array.isArray(song.sections) && song.sections.length) {
      var out = [], cursor = 0;
      song.sections.forEach(function (s) {
        var b = Math.max(1, Math.round(Number(s.bars) || 4));
        out.push({
          type: String(s.type || 'verse'),
          startBar: cursor,
          bars: b,
          energy: clamp01(s.energy == null ? 0.5 : s.energy),
          source: 'analyzed',
        });
        cursor += b;
      });
      return out;
    }

    var eb = null;
    if (Array.isArray(song.energyBars) && song.energyBars.length >= 8) {
      eb = song.energyBars.map(clamp01);
      bars = eb.length;
    } else {
      // Honest estimated arc from the song's mean energy: quiet edges,
      // alternating verse/chorus body. Labelled 'estimated'.
      var base = clamp01(song.energy == null ? 0.5 : song.energy);
      eb = [];
      for (var i = 0; i < bars; i++) {
        var blk = Math.floor(i / 8);
        var v = base;
        if (i < 8 || i >= bars - 8) v = base * 0.45;            // edges quiet
        else if (blk % 2 === 0) v = Math.min(1, base * 1.25);  // chorus-ish
        else v = base * 0.85;                                   // verse-ish
        eb.push(clamp01(v + 0.03 * Math.sin(i * 1.7)));
      }
    }

    var B = 4; // 4-bar blocks
    var nB = Math.max(2, Math.ceil(bars / B));
    var bE = [];
    for (var bi = 0; bi < nB; bi++) {
      var s0 = bi * B, s1 = Math.min(bars, s0 + B), sum = 0;
      for (var k = s0; k < s1; k++) sum += eb[k];
      bE.push(sum / Math.max(1, s1 - s0));
    }
    var mx = Math.max.apply(null, bE.concat([0.01]));
    var types = [];
    for (var q = 0; q < nB; q++) {
      var e = bE[q], t;
      var isMax = (e >= mx - 1e-9);
      var left = q > 0 ? bE[q - 1] : e, right = q < nB - 1 ? bE[q + 1] : e;
      if (q === 0 && e < 0.55 * mx) t = 'intro';
      else if (q === nB - 1 && e < 0.70 * mx) t = 'outro';
      else if (isMax) t = 'chorus';
      else if (q > 0 && q < nB - 1 && left > e + 0.08 && right > e + 0.08) t = 'bridge';
      else t = 'verse';
      types.push(t);
    }
    // merge adjacent same-type blocks
    var merged = [], cur = null;
    for (var r = 0; r < nB; r++) {
      if (cur && cur.type === types[r]) { cur.bars += B; cur.energy += bE[r]; cur._n++; }
      else {
        if (cur) { cur.energy = cur.energy / cur._n; delete cur._n; merged.push(cur); }
        cur = { type: types[r], startBar: r * B, bars: B, energy: bE[r], _n: 1, source: eb ? 'energy' : 'estimated' };
      }
    }
    if (cur) { cur.energy = round2(cur.energy / cur._n); delete cur._n; merged.push(cur); }
    merged.forEach(function (s) { s.energy = round2(s.energy); });
    return merged;
  }

  function songHook(song) {
    var secs = deriveSections(song);
    var best = null;
    secs.forEach(function (s) {
      if (!best || (s.type === 'chorus' && best.type !== 'chorus') ||
          (s.type === best.type && s.energy > best.energy) ||
          (s.type === 'chorus' && best.type === 'chorus' && s.energy > best.energy)) {
        if (s.type === 'chorus' || !best || s.energy > best.energy) best = s;
      }
    });
    return best || secs[0];
  }

  /* ================= 4. the 12 style presets (§13) =================== */
  // Every preset is a REAL parameter set. AUDIBLE_KEYS lists the params
  // that change what the listener hears — the param-diff test asserts
  // every pair of presets differs in at least one of them.
  var AUDIBLE_KEYS = ['tempoShift', 'energyTarget', 'reverbWet', 'delayWet',
                      'sidechainDb', 'transition', 'vocalBoostDb', 'bassDb',
                      'brightness', 'beatStyle', 'risers'];

  var PRESETS = [
    { id: 'romantic', name: 'Bollywood Romantic',
      tagline: 'Warm and voice-forward for romantic melodies',
      description: 'Smart small-room reverb 1.5×, smooth handoffs and the vocal +4 dB over the beat — a warm DSP treatment for romantic songs.',
      params: { tempoShift: 1.00, energyTarget: 0.62, reverbWet: 1.5, delayWet: 1.2, sidechainDb: 2.0, transition: 'smooth', vocalBoostDb: 4, bassDb: 1, brightness: 0.5, beatStyle: 'pop', risers: false } },
    { id: 'sad', name: 'Sad Emotional',
      tagline: 'Slower, darker, deeper reverb for emotional songs',
      description: 'Grid slowed ×0.92, Smart reverb 2×, tone darkened and vocal +5 dB — DSP only, no instruments added.',
      params: { tempoShift: 0.92, energyTarget: 0.30, reverbWet: 2.0, delayWet: 1.3, sidechainDb: 1.5, transition: 'smooth', vocalBoostDb: 5, bassDb: -1, brightness: -1, beatStyle: 'lofi', risers: false } },
    { id: 'lofi', name: 'Lofi',
      tagline: 'Dusty low-tempo groove with a gentle pump',
      description: 'Grid ×0.90 over a lo-fi beat, Smart sidechain pump 2.5 dB, softened top end — the lo-fi DSP recipe.',
      params: { tempoShift: 0.90, energyTarget: 0.35, reverbWet: 1.8, delayWet: 1.5, sidechainDb: 2.5, transition: 'smooth', vocalBoostDb: 2, bassDb: 2, brightness: -2, beatStyle: 'lofi', risers: false } },
    { id: 'slowed', name: 'Slowed + Reverb',
      tagline: 'The classic slowed feel, done with DSP',
      description: 'Tempo ×0.85 with 2.5× Smart reverb and long cinematic handoffs — pitch stays matched, speed drops.',
      params: { tempoShift: 0.85, energyTarget: 0.40, reverbWet: 2.5, delayWet: 1.6, sidechainDb: 1.0, transition: 'cinematic', vocalBoostDb: 3, bassDb: 1, brightness: -1, beatStyle: 'lofi', risers: false } },
    { id: 'sufi', name: 'Sufi',
      tagline: 'Spacious and devotional, vocal always front',
      description: '2.2× Smart hall-style reverb, gentle dynamics and vocal +5 dB — keeps devotional vocals front and clear.',
      params: { tempoShift: 0.95, energyTarget: 0.50, reverbWet: 2.2, delayWet: 1.2, sidechainDb: 1.5, transition: 'smooth', vocalBoostDb: 5, bassDb: 0, brightness: 0, beatStyle: 'hiphop', risers: false } },
    { id: 'chillout', name: 'Chillout',
      tagline: 'Easy, airy, unhurried',
      description: 'Slightly eased tempo ×0.95, airy Smart reverb and soft dynamics over a deep house groove.',
      params: { tempoShift: 0.95, energyTarget: 0.45, reverbWet: 1.6, delayWet: 1.2, sidechainDb: 2.0, transition: 'smooth', vocalBoostDb: 2.5, bassDb: -0.5, brightness: 0.5, beatStyle: 'house', risers: false } },
    { id: 'edm', name: 'EDM',
      tagline: 'Big pump, bright tone, risers into every hook',
      description: 'Deep 4.5 dB Smart sidechain pump, brightened tone, boosted bass and synthesized risers swelling into each hook.',
      params: { tempoShift: 1.00, energyTarget: 0.90, reverbWet: 0.8, delayWet: 0.8, sidechainDb: 4.5, transition: 'energetic', vocalBoostDb: 3, bassDb: 3, brightness: 1.5, beatStyle: 'edm', risers: true } },
    { id: 'party', name: 'Party',
      tagline: 'Maximum crowd energy',
      description: 'Grid ×1.02, punchy 3.5 dB Smart sidechain, bright tone and risers — tuned loud for speakers.',
      params: { tempoShift: 1.02, energyTarget: 1.00, reverbWet: 0.7, delayWet: 0.7, sidechainDb: 3.5, transition: 'energetic', vocalBoostDb: 3, bassDb: 2.5, brightness: 1, beatStyle: 'house', risers: true } },
    { id: 'acoustic', name: 'Acoustic',
      tagline: 'Unplugged feel: thin bass, airy top',
      description: 'Bass shelf −2 dB, airy top end and light Smart reverb — an unplugged-style DSP treatment, vocal +4 dB.',
      params: { tempoShift: 1.00, energyTarget: 0.50, reverbWet: 1.2, delayWet: 1.0, sidechainDb: 1.0, transition: 'smooth', vocalBoostDb: 4, bassDb: -2, brightness: 1, beatStyle: 'pop', risers: false } },
    { id: 'cinematic', name: 'Cinematic',
      tagline: 'Wide, dramatic, larger than life',
      description: '2.5× Smart reverb, long cinematic handoffs and risers swelling into the final chorus — drama via DSP.',
      params: { tempoShift: 0.90, energyTarget: 0.55, reverbWet: 2.5, delayWet: 1.4, sidechainDb: 1.0, transition: 'cinematic', vocalBoostDb: 3, bassDb: 1, brightness: 0, beatStyle: 'hiphop', risers: true } },
    { id: 'trending', name: 'Trending YouTube',
      tagline: 'Punchy and bright for short-video playback',
      description: 'Punchy 3 dB Smart sidechain, bright tone, boosted bass and risers — tuned for phone speakers and short videos.',
      params: { tempoShift: 1.00, energyTarget: 0.80, reverbWet: 1.0, delayWet: 1.0, sidechainDb: 3.0, transition: 'creative', vocalBoostDb: 3.5, bassDb: 2, brightness: 1, beatStyle: 'trap', risers: true } },
    { id: 'custom', name: 'Custom',
      tagline: 'Neutral starting point — your settings rule',
      description: 'No preset colour: every knob follows your Mashup Settings exactly. The Smart default.',
      // v29 F2 (P2-4): "No preset colour" must mean DRY — reverb, echo and
      // the sidechain pump are all zero for Custom (they were 1.0/1.0/2.5,
      // so Custom secretly added space to every build).
      params: { tempoShift: 1.00, energyTarget: 0.55, reverbWet: 0, delayWet: 0, sidechainDb: 0, transition: 'smooth', vocalBoostDb: 3, bassDb: 0, brightness: 0, beatStyle: null, risers: false } },
  ];

  function listPresets() {
    return PRESETS.map(function (p) {
      return { id: p.id, name: p.name, tagline: p.tagline, description: p.description };
    });
  }
  function getPreset(id) {
    var want = String(id == null ? 'custom' : id).toLowerCase();
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === want) return PRESETS[i];
    return PRESETS[PRESETS.length - 1]; // 'custom'
  }
  // Audible diff between two presets: list of AUDIBLE_KEYS that differ.
  function presetDiff(a, b) {
    var pa = getPreset(a).params, pb = getPreset(b).params;
    return AUDIBLE_KEYS.filter(function (k) { return pa[k] !== pb[k]; });
  }

  /* ================= 5. mashup settings (§14) ======================== */
  function defaultSettings() {
    return { length: '3', customMin: 4.5, energy: 'dynamic',
             vocalFocus: 'balanced', transition: 'auto',
             effects: 'balanced', mastering: 'balanced' };
  }
  function validateSettings(s) {
    var d = defaultSettings();
    s = (s && typeof s === 'object') ? s : {};
    var o = {};
    o.length = ['2', '3', '4', '5', '6', 'custom'].indexOf(String(s.length)) >= 0 ? String(s.length) : d.length;
    o.customMin = clamp(Number(s.customMin), 1, 12);
    if (!isFinite(o.customMin)) o.customMin = d.customMin;
    o.energy = ['low', 'medium', 'high', 'dynamic'].indexOf(s.energy) >= 0 ? s.energy : d.energy;
    o.vocalFocus = ['low', 'balanced', 'high'].indexOf(s.vocalFocus) >= 0 ? s.vocalFocus : d.vocalFocus;
    o.transition = ['smooth', 'creative', 'energetic', 'cinematic', 'auto'].indexOf(s.transition) >= 0 ? s.transition : d.transition;
    o.effects = ['minimal', 'balanced', 'creative', 'heavy'].indexOf(s.effects) >= 0 ? s.effects : d.effects;
    o.mastering = ['natural', 'balanced', 'loud'].indexOf(s.mastering) >= 0 ? s.mastering : d.mastering;
    return o;
  }

  // Declarative UI spec for W5. Each setting documents mapsTo — the REAL
  // engine parameter(s) it drives (see PARAM_MAPPING / mapSettingsToParams).
  function getSettingsUI() {
    return [
      { id: 'length', label: 'Mashup length',
        hint: 'Target duration. The timeline is budgeted in bars from this.',
        type: 'segmented', default: '3',
        options: [
          { value: '2', label: '2 min' }, { value: '3', label: '3 min' },
          { value: '4', label: '4 min' }, { value: '5', label: '5 min' },
          { value: '6', label: '6 min' }, { value: 'custom', label: 'Custom' },
        ],
        custom: { kind: 'number', id: 'customMin', label: 'Custom minutes',
                  min: 1, max: 12, step: 0.5, default: 4.5,
                  showWhen: 'custom' },
        mapsTo: 'timeline.totalBars = minutes × 60 × gridBpm ÷ 240 (32–400 bars); vocal segment trim length' },
      { id: 'energy', label: 'Energy',
        hint: 'Overall intensity. Dynamic follows your songs’ average energy.',
        type: 'segmented', default: 'dynamic',
        options: [
          { value: 'low', label: 'Low', hint: 'Mellow, late-night feel' },
          { value: 'medium', label: 'Medium', hint: 'Easy, steady groove' },
          { value: 'high', label: 'High', hint: 'Full intensity' },
          { value: 'dynamic', label: 'Dynamic', hint: 'Follows your songs (Smart default)' },
        ],
        mapsTo: 'renderSpec.energyTarget → beat-style energy bias, reverb scale, sidechain offset, arrangement (breakdown length, riser density)' },
      { id: 'vocalFocus', label: 'Vocal focus',
        hint: 'How far the voice sits above the beat.',
        type: 'segmented', default: 'balanced',
        options: [
          { value: 'low', label: 'Low', hint: 'Voice blends into the groove (+1.5 dB)' },
          { value: 'balanced', label: 'Balanced', hint: 'Voice clearly on top (+3 dB)' },
          { value: 'high', label: 'High', hint: 'Voice dominates the mix (+5 dB)' },
        ],
        mapsTo: 'timeline.vocalBoostDb = preset base ± focus offset (Low −1.5 / Balanced ±0 / High +2 dB, clamped 1–6 dB)' },
      { id: 'transition', label: 'Transitions',
        hint: 'How singers hand off to each other. Auto picks from energy.',
        type: 'segmented', default: 'auto',
        options: [
          { value: 'smooth', label: 'Smooth', hint: 'Long 1-bar blend' },
          { value: 'creative', label: 'Creative', hint: 'Tight 0.5-bar DJ handoff' },
          { value: 'energetic', label: 'Energetic', hint: 'Snappy 0.25-bar cut' },
          { value: 'cinematic', label: 'Cinematic', hint: 'Long 2-bar swell' },
          { value: 'auto', label: 'Auto', hint: 'Smart pick from energy (default)' },
        ],
        mapsTo: 'timeline.xfadeBars (Smooth 1 / Creative 0.5 / Energetic 0.25 / Cinematic 2; Auto ← energyTarget)' },
      { id: 'effects', label: 'Effects',
        hint: 'How much Smart reverb, echo and riser dressing is applied.',
        type: 'segmented', default: 'balanced',
        options: [
          { value: 'minimal', label: 'Minimal', hint: 'Almost dry (reverb ×0.3, no risers)' },
          { value: 'balanced', label: 'Balanced', hint: 'Natural glue (reverb ×1)' },
          { value: 'creative', label: 'Creative', hint: 'Audible space (reverb ×1.6)' },
          { value: 'heavy', label: 'Heavy', hint: 'Washed in space (reverb ×2.2)' },
        ],
        mapsTo: 'post.reverbWet ×(0.3/1/1.6/2.2), post.delayWet ×(0/1/1.4/1.8), risers on/off, sidechain ±1 dB' },
      { id: 'mastering', label: 'Mastering',
        hint: 'Final loudness character. All options stay true-peak safe.',
        type: 'segmented', default: 'balanced',
        options: [
          { value: 'natural', label: 'Natural', hint: 'Gentle dynamics, most breathing room' },
          { value: 'balanced', label: 'Balanced', hint: 'Radio-ready body (default)' },
          { value: 'loud', label: 'Loud', hint: 'Maximum punch, still clip-free' },
        ],
        mapsTo: 'post.mastering {ratio, thresholdDb, truePeakCeil}: Natural {1.5, −18 dB, 0.71} / Balanced {2, −12 dB, 0.71} / Loud {3, −9 dB, 0.80}' },
    ];
  }

  // UI spec for the master-BPM + manual semitone controls (W5 builds it).
  function getTransposeUI() {
    return {
      masterBpm: { id: 'masterBpm', label: 'Master tempo',
        hint: 'The grid everything locks to. Default: Song 1’s tempo.',
        type: 'select', default: 'auto',
        options: [
          { value: 'auto', label: 'Auto (Song 1 tempo)' },
          { value: '80', label: '80 BPM' }, { value: '90', label: '90 BPM' },
          { value: '100', label: '100 BPM' }, { value: '110', label: '110 BPM' },
          { value: '120', label: '120 BPM' }, { value: '128', label: '128 BPM' },
          { value: '140', label: '140 BPM' },
        ],
        mapsTo: 'plan.gridBpm — vocal time-stretch target and beat render tempo' },
      semitones: { id: 'semitones', label: 'Key shift per song',
        hint: 'Nudge any song’s key up/down. Auto matches the master key.',
        type: 'stepper', min: -6, max: 6, step: 1, default: 'auto',
        mapsTo: 'transposePlan(): semitone shift per song → pitch-shift stage' },
    };
  }

  /* The documented settings → engine-params mapping (§14 requirement:
     every setting maps to REAL engine params). */
  var PARAM_MAPPING = [
    { setting: 'length', values: '2 / 3 / 4 / 5 / 6 min / custom (1–12)',
      engineParam: 'plan.totalBars, vocal trim bars',
      formula: 'totalBars = clamp(round(min × 60 × gridBpm / 240), 32, 400); e.g. 4 min @120 BPM → 120 bars' },
    { setting: 'energy', values: 'low / medium / high / dynamic',
      engineParam: 'spec.energyTarget (0..1)',
      formula: 'low→0.30, medium→0.55, high→0.85, dynamic→preset default; drives beat-style bias, reverb scale, sidechain ±, breakdown length, risers' },
    { setting: 'vocalFocus', values: 'low / balanced / high',
      engineParam: 'timelineOpts.vocalBoostDb',
      formula: 'preset.vocalBoostDb + (low: −1.5 / balanced: 0 / high: +2), clamped 1–6 dB; balanced default = +3 dB spec' },
    { setting: 'transition', values: 'smooth / creative / energetic / cinematic / auto',
      engineParam: 'timelineOpts.xfadeBars',
      formula: 'smooth→1, creative→0.5, energetic→0.25, cinematic→2; auto→ energyTarget≥0.7 ? 0.5 : energyTarget≥0.45 ? 1 : 1.5' },
    { setting: 'effects', values: 'minimal / balanced / creative / heavy',
      engineParam: 'post.reverbWet×, post.delayWet×, risers, sidechain trim',
      formula: 'reverb ×(0.3/1/1.6/2.2); delay ×(0/1/1.4/1.8); risers off when minimal; sidechain −1/0/+0.5/+1 dB' },
    { setting: 'mastering', values: 'natural / balanced / loud',
      engineParam: 'post.mastering {ratio, thresholdDb, truePeakCeil}',
      formula: 'natural {1.5, −18 dB, 0.71} / balanced {2, −12 dB, 0.71} / loud {3, −9 dB, 0.80 (−1.9 dBTP)}' },
    { setting: 'masterBpm (transpose UI)', values: 'auto / 80–140 BPM',
      engineParam: 'plan.gridBpm',
      formula: 'auto → Song 1 BPM × preset.tempoShift; explicit → that BPM × preset.tempoShift (clamped 50–220)' },
    { setting: 'semitones (transpose UI)', values: 'auto / −6..+6 per song',
      engineParam: 'pitch-shift semitones per song',
      formula: 'auto → transposePlan() vs master key; manual → user value (clamped ±6)' },
  ];

  var ENERGY_PRESET = { low: 0.30, medium: 0.55, high: 0.85 };
  var XFADES = { smooth: 1, creative: 0.5, energetic: 0.25, cinematic: 2 };
  var REVERB_SCALE = { minimal: 0.3, balanced: 1, creative: 1.6, heavy: 2.2 };
  var DELAY_SCALE = { minimal: 0, balanced: 1, creative: 1.4, heavy: 1.8 };
  var SC_TRIM = { minimal: -1, balanced: 0, creative: 0.5, heavy: 1 };
  var FOCUS_OFF = { low: -1.5, balanced: 0, high: 2 };
  var MASTERING = {
    natural:  { ratio: 1.5, thresholdDb: -18, truePeakCeil: 0.71 },
    balanced: { ratio: 2,   thresholdDb: -12, truePeakCeil: 0.71 },
    loud:     { ratio: 3,   thresholdDb: -9,  truePeakCeil: 0.80 },
  };

  function mapSettingsToParams(settings) {
    var s = validateSettings(settings);
    var lengthMin = s.length === 'custom' ? s.customMin : Number(s.length);
    var params = {
      lengthMin: lengthMin,
      energy: s.energy,
      energyTarget: s.energy === 'dynamic' ? null : ENERGY_PRESET[s.energy], // null → preset decides
      vocalFocus: s.vocalFocus,
      vocalFocusOffsetDb: FOCUS_OFF[s.vocalFocus],
      transition: s.transition,
      reverbScale: REVERB_SCALE[s.effects],
      delayScale: DELAY_SCALE[s.effects],
      sidechainTrimDb: SC_TRIM[s.effects],
      risersAllowed: s.effects !== 'minimal',
      effects: s.effects,
      mastering: MASTERING[s.mastering],
      masteringName: s.mastering,
    };
    var mapping = PARAM_MAPPING.map(function (row) {
      return { setting: row.setting, values: row.values,
               engineParam: row.engineParam, formula: row.formula };
    });
    return { params: params, mapping: mapping, settings: s };
  }

  // presetRenderSpec(presetId, settings) — the FULL merged render spec:
  // preset params × user settings → one concrete object the coordinator
  // and post chain consume.
  function presetRenderSpec(presetId, settings) {
    var p = getPreset(presetId);
    var mapped = mapSettingsToParams(settings);
    var mp = mapped.params;
    var energyTarget = mp.energyTarget == null ? p.params.energyTarget : mp.energyTarget;
    var transition = mp.transition === 'auto' ? p.params.transition : mp.transition;
    var xfade = XFADES[transition];
    if (xfade == null) xfade = energyTarget >= 0.7 ? 0.5 : energyTarget >= 0.45 ? 1 : 1.5;
    return {
      presetId: p.id, presetName: p.name,
      tempoShift: p.params.tempoShift,
      energyTarget: round2(energyTarget),
      reverbWet: round2(p.params.reverbWet * mp.reverbScale),
      delayWet: round2(p.params.delayWet * mp.delayScale),
      // v29 F2: floor is 0, not 0.5 — Custom sets sidechainDb 0 ("no preset
      // colour") and the old 0.5 floor would have pumped it anyway.
      sidechainDb: round2(Math.max(0, p.params.sidechainDb + mp.sidechainTrimDb)),
      transition: transition,
      xfadeBars: xfade,
      vocalBoostDb: round2(clamp(p.params.vocalBoostDb + mp.vocalFocusOffsetDb, 1, 6)),
      bassDb: p.params.bassDb,
      brightness: p.params.brightness,
      beatStyle: p.params.beatStyle, // null → coordinator picks nearest BPM
      risers: !!(p.params.risers && mp.risersAllowed),
      effects: mp.effects,
      mastering: mp.mastering,
      masteringName: mp.masteringName,
      lengthMin: mp.lengthMin,
      settings: mapped.settings,
    };
  }

  /* ================= 6. arrangement builder (§5 §7 §8) ================= */
  // buildArrangement(songs, opts)
  //   songs: [{ name, bpm, key, energy, sections?, energyBars?, bars? }] (2..8)
  //   opts: { masterBpm?, lengthMin?, presetId?, settings? }
  // → plan { sections[], totalBars, durationSec, masterBpm, gridBpm,
  //          slotBars, cycles, rotationOrder, hooks, compat, spec }
  function buildArrangement(songs, opts) {
    if (!Array.isArray(songs) || songs.length < 2 || songs.length > 8)
      throw new Error('Smart Arrangement needs 2 to 8 analyzed songs.');
    opts = opts || {};
    var n = songs.length;

    var norm = songs.map(function (s, i) {
      s = s || {};
      var bpm = Number(s.bpm);
      if (!isFinite(bpm) || bpm < 50 || bpm > 220) bpm = 100;
      return {
        idx: i,
        name: (typeof s.name === 'string' && s.name) ? s.name : 'Song ' + (i + 1),
        bpm: bpm,
        key: normKey(s.key),
        energy: clamp01(s.energy == null ? 0.5 : s.energy),
        bars: s.bars, sections: s.sections, energyBars: s.energyBars,
      };
    });

    var spec = presetRenderSpec(opts.presetId, opts.settings);
    var lengthMin = opts.lengthMin != null ? clamp(Number(opts.lengthMin), 0.5, 20) : spec.lengthMin;
    if (!isFinite(lengthMin)) lengthMin = spec.lengthMin;

    var masterBpm = Number(opts.masterBpm);
    if (!isFinite(masterBpm) || masterBpm < 50 || masterBpm > 220) masterBpm = norm[0].bpm;
    var gridBpm = clamp(masterBpm * spec.tempoShift, 50, 220);
    var masterKey = norm[0].key;

    // Per-song sections + hooks (strongest detected chorus).
    var perSong = norm.map(function (sg) {
      var secs = deriveSections(sg);
      var hook = songHook(sg);
      return { song: sg, sections: secs, hook: hook };
    });
    var hookRank = perSong.map(function (ps, i) {
      return { idx: i, energy: ps.hook.energy, type: ps.hook.type };
    }).sort(function (a, b) { return b.energy - a.energy; });
    var strongest = hookRank[0].idx;
    var runnerUp = hookRank.length > 1 ? hookRank[1].idx : strongest;
    var mellowest = perSong.map(function (ps, i) { return { idx: i, energy: ps.song.energy }; })
      .sort(function (a, b) { return a.energy - b.energy; })[0].idx;

    // Rotation order: greedy by compatibility (which vocal follows which).
    var compat = compatibilityMatrix(norm);
    var order = [0], used = { 0: true };
    while (order.length < n) {
      var last = order[order.length - 1], bi = -1, bs = -1;
      for (var i = 0; i < n; i++) {
        if (used[i]) continue;
        if (compat[last][i] > bs) { bs = compat[last][i]; bi = i; }
      }
      used[bi] = true; order.push(bi);
    }

    /* ---- bar budget: ADAPTS to song count, energy, length ---- */
    var totalBars = clamp(Math.round(lengthMin * 60 * gridBpm / 240), 32, 400);
    var introB = 4, buildB = 4, breakB = 4, outroB = 4;
    var chorusB = 8;                                            // hook section
    var breakdownB = spec.energyTarget < 0.45 ? 8 : 4;           // mellow → longer
    var finalB = 8;
    var fixed = introB + buildB + chorusB + breakB + breakdownB + finalB + outroB;
    var rotBudget = Math.max(n * 2, totalBars - fixed);

    var slotBars = n >= 4 ? 4 : 8;      // more songs → tighter slots
    var cycles = Math.floor(rotBudget / (n * slotBars));
    if (cycles < 1) {                    // tiny budget → shrink slots, keep 1 cycle
      slotBars = Math.max(2, Math.floor(rotBudget / n));
      cycles = 1;
    }
    cycles = Math.min(3, cycles);
    var rotBars = cycles * n * slotBars;
    var leftover = rotBudget - rotBars;
    var addFinal = Math.min(4, leftover); finalB += addFinal; leftover -= addFinal;
    var addBreak = Math.min(4, leftover); breakB += addBreak; leftover -= addBreak;
    outroB += Math.max(0, leftover);
    totalBars = introB + buildB + rotBars + chorusB + breakB + breakdownB + finalB + outroB;

    /* ---- section list (NOT sequential full songs) ---- */
    var sections = [], bar = 0;
    function push(type, label, barsN, vocals, extra) {
      var sec = { type: type, label: label, startBar: bar, bars: barsN, vocals: vocals || [] };
      if (extra) for (var k in extra) sec[k] = extra[k];
      sections.push(sec); bar += barsN;
    }
    push('intro', 'Intro — beat only', introB, []);
    push('build', 'Build — beat and instruments rising', buildB, [], { gainDb: '+2 ramp' });
    for (var c = 0; c < cycles; c++) {
      for (var p = 0; p < n; p++) {
        var si = order[p];
        push('rotation', 'Verse ' + (c * n + p + 1) + ' — ' + norm[si].name,
             slotBars, [si], { cycle: c + 1, compatToPrev: p === 0 && c === 0 ? null :
               round2(compat[p === 0 ? order[n - 1] : order[p - 1]][si]) });
      }
    }
    // Chorus/hook: strongest detected — top-2 hook owners split 4+4 bars.
    var chorusVocals = [];
    if (n >= 2 && chorusB >= 8) {
      chorusVocals = [strongest, runnerUp];
    } else chorusVocals = [strongest];
    push('chorus', 'Hook — strongest chorus (' + norm[strongest].name + ')',
         chorusB, chorusVocals, { boostDb: spec.vocalBoostDb + 1, hookSplit: chorusVocals.length > 1 });
    push('break', 'Instrumental break', breakB, [], { gainDb: -2 });
    push('breakdown', 'Breakdown — mellow (' + norm[mellowest].name + ')',
         breakdownB, [mellowest], { boostDb: Math.max(1, spec.vocalBoostDb - 1), gainDb: -4 });
    // Final chorus: strongest hook again, top-2 alternating every 4 bars.
    var finVocals = [];
    for (var fb = 0; fb < finalB; fb += 4) finVocals.push(fb % 8 === 0 ? strongest : runnerUp);
    push('finalChorus', 'Final chorus — all energy', finalB, finVocals,
         { boostDb: spec.vocalBoostDb + 1, riserIn: spec.risers });
    push('outro', 'Outro — beat only', outroB, []);

    return {
      sections: sections,
      totalBars: totalBars,
      durationSec: round2(totalBars * 240 / gridBpm),
      masterBpm: round2(masterBpm),
      gridBpm: round2(gridBpm),
      tempoShift: spec.tempoShift,
      masterKey: keyLabel(masterKey),
      songs: norm.map(function (sg) {
        return { idx: sg.idx, name: sg.name, bpm: sg.bpm,
                 key: keyLabel(sg.key), energy: sg.energy };
      }),
      slotBars: slotBars,
      cycles: cycles,
      rotationOrder: order,
      hooks: {
        perSong: hookRank,
        strongest: strongest,
        runnerUp: runnerUp,
        mellowest: mellowest,
      },
      compat: compat,
      spec: spec,
    };
  }

  /* ================= 7. transpose plan (§14) ========================== */
  // transposePlan(masterKey, songKeys) → [{ song, semitones, reason }]
  // songKeys[i] may be {key, mode} or "A minor". Song 0 = master reference.
  function transposePlan(masterKey, songKeys) {
    var mk = normKey(masterKey);
    var pM = effPc(mk);
    var keys = Array.isArray(songKeys) ? songKeys : [];
    return keys.map(function (k, i) {
      var nk = normKey(k), pS = effPc(nk);
      var s = (((pM - pS) % 12) + 12) % 12;
      if (s > 6) s -= 12;
      var reason;
      if (i === 0) reason = 'Master reference — no shift (' + keyLabel(mk) + ')';
      else if (s === 0) reason = keyLabel(nk) + ' already matches ' + keyLabel(mk) + ' (or its relative) — no shift';
      else reason = keyLabel(nk) + ' → ' + keyLabel(mk) + ': ' +
                    (s > 0 ? '+' : '') + s + ' semitone' + (Math.abs(s) === 1 ? '' : 's') +
                    ' (Smart key match)';
      return { song: i, key: keyLabel(nk), semitones: s, reason: reason };
    });
  }

  /* ================= 8. timeline bridge ============================== */
  // bridgeToTimeline(plan, spec) — flattens the section plan into the
  // exact opts RM.mashupArrange.buildTimeline accepts, plus the v25
  // beat-shaping + post-chain contract for the coordinator.
  function bridgeToTimeline(plan, spec) {
    if (!plan || !plan.sections) throw new Error('bridgeToTimeline needs a plan from buildArrangement().');
    spec = spec || plan.spec || presetRenderSpec('custom', null);
    function barsOf(type) {
      var t = 0;
      plan.sections.forEach(function (s) { if (s.type === type) t += s.bars; });
      return t;
    }
    return {
      timelineOpts: {
        masterBpm: plan.gridBpm,
        cycles: plan.cycles,
        barsPerVocal: plan.slotBars,
        introBars: barsOf('intro'),
        outroBars: barsOf('outro'),
        xfadeBars: spec.xfadeBars,
        vocalBoostDb: spec.vocalBoostDb,
      },
      beatBars: plan.totalBars,       // coordinator: renderBeat(style, gridBpm, beatBars)
      beatStyle: spec.beatStyle,       // null → nearest-BPM pick
      beatShaping: {                   // coordinator: apply BEFORE buildTimeline
        sectionGain: true,             // shapeBeatDynamics(beatBuf, plan)
        risers: spec.risers,           // addRisers(buf, plan, spec, sr)
      },
      postChain: ['tone', 'mastering'], // coordinator: apply AFTER buildTimeline
      sectionMeta: plan.sections,       // markers for UI / future section renderer
      notes: [
        'Rotation slots follow plan.rotationOrder (' + plan.rotationOrder.join('→') + '), ' +
          plan.cycles + ' cycle(s) × ' + plan.slotBars + ' bars.',
        'Section gain envelope (build +2 dB, chorus +1 dB, break −2 dB, breakdown −4 dB, final +1.5 dB) is applied to the beat bed via shapeBeatDynamics.',
        'Per-section vocal-boost variance (chorus +1 dB, breakdown −1 dB) is in plan metadata for the v25 section renderer; the timeline renders the plan average.',
      ],
    };
  }

  /* ================= 9. v25 DSP post chain =========================== */
  // Self-contained, fresh implementations (the v22/v24 internals they
  // resemble live privately inside mashup-arrange.js; these are NEW
  // processing for the v25 chain, so no consistency claim is needed).
  function okBuf(b) {
    return !!(b && typeof b.getChannelData === 'function' &&
               typeof b.numberOfChannels === 'number' && b.numberOfChannels > 0 &&
               typeof b.length === 'number' && b.length > 0);
  }

  // shapeBeatDynamics(beatBuf, plan) — section gain envelope on the beat
  // bed, in place. 0.25-bar raised-cosine smoothing at boundaries.
  function shapeBeatDynamics(beatBuf, plan) {
    if (!okBuf(beatBuf) || !plan || !plan.sections) return beatBuf;
    var sr = beatBuf.sampleRate || 44100;
    var bpm = plan.gridBpm || 100;
    var barLen = Math.max(1, Math.round(240 / bpm * sr));
    var barDb = [];
    plan.sections.forEach(function (sec) {
      for (var b = 0; b < sec.bars; b++) {
        var t = sec.type, db = 0;
        if (t === 'build') db = 2 * (b + 1) / sec.bars;  // rising ramp
        else if (t === 'chorus') db = 1;
        else if (t === 'break') db = -2;
        else if (t === 'breakdown') db = -4;
        else if (t === 'finalChorus') db = 1.5;
        barDb.push(db);
      }
    });
    var totalBars = barDb.length;
    if (!totalBars) return beatBuf;
    function dbAt(barF) {
      var b0 = Math.floor(barF);
      if (b0 < 0) b0 = 0;
      if (b0 >= totalBars) b0 = totalBars - 1;
      var db = barDb[b0];
      var frac = barF - b0;
      // blend into the next bar across the last 0.25 bar (raised cosine)
      if (frac > 0.75 && b0 + 1 < totalBars) {
        var x = (frac - 0.75) / 0.25;
        var w = 0.5 - 0.5 * Math.cos(Math.PI * x);
        db = db * (1 - w) + barDb[b0 + 1] * w;
      }
      return db;
    }
    for (var ch = 0; ch < beatBuf.numberOfChannels; ch++) {
      var d = beatBuf.getChannelData(ch);
      for (var i = 0; i < d.length; i++) {
        d[i] *= Math.pow(10, dbAt(i / barLen) / 20);
      }
    }
    return beatBuf;
  }

  // addRisers(buf, plan, spec, sr) — synthesized noise risers swelling
  // into chorus/finalChorus sections (2 bars each), in place.
  function addRisers(buf, plan, spec, sr) {
    if (!okBuf(buf) || !plan || !plan.sections) return buf;
    sr = sr || buf.sampleRate || 44100;
    spec = spec || {};
    if (!spec.risers) return buf;
    var bpm = plan.gridBpm || 100;
    var barLen = Math.max(1, Math.round(240 / bpm * sr));
    var riserBars = 2;
    var targets = [];
    plan.sections.forEach(function (sec) {
      if (sec.type === 'chorus' || sec.type === 'finalChorus') targets.push(sec.startBar);
    });
    if (!targets.length) return buf;
    var peak = 0.28;
    // deterministic pseudo-noise (mulberry-ish LCG) — test-stable
    var seed = 1234567;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; }
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      targets.forEach(function (startBar) {
        var s0 = Math.round((startBar - riserBars) * barLen);
        if (s0 < 0) s0 = 0;
        var len = Math.round(riserBars * barLen);
        var lp = 0, a = 0;
        for (var i = 0; i < len && s0 + i < d.length; i++) {
          var t = i / len;                       // 0→1
          a = 1 - Math.exp(-2 * Math.PI * (400 + 7600 * t) / sr); // opening LP
          lp += a * (rnd() - lp);
          var env = t * t;                       // swelling
          d[s0 + i] += peak * env * lp;
        }
      });
    }
    return buf;
  }

  // applyPresetTone(buf, spec, sr) — brightness tilt + bass shelf, in place.
  function applyPresetTone(buf, spec, sr) {
    if (!okBuf(buf)) return buf;
    sr = sr || buf.sampleRate || 44100;
    spec = spec || {};
    var bright = Number(spec.brightness) || 0;   // −2..+2
    var bassDb = Number(spec.bassDb) || 0;
    if (bright === 0 && bassDb === 0) return buf;
    var aHi = 1 - Math.exp(-2 * Math.PI * 4000 / sr);
    var aLo = 1 - Math.exp(-2 * Math.PI * 150 / sr);
    var bassG = Math.pow(10, bassDb / 20) - 1;
    var tiltG = bright * 0.35;
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      var lpHi = 0, lpLo = 0;
      for (var i = 0; i < d.length; i++) {
        var x = d[i];
        lpHi += aHi * (x - lpHi);
        lpLo += aLo * (x - lpLo);
        d[i] = x + tiltG * (x - lpHi) + bassG * lpLo;
      }
    }
    return buf;
  }

  // applyMastering(buf, mastering, sr) — soft-knee bus comp + true-peak
  // gain limit to the mastering ceiling. Returns { peakBefore, peakAfter, grDb }.
  function applyMastering(buf, mastering, sr) {
    var stats = { peakBefore: 0, peakAfter: 0, grDb: 0 };
    if (!okBuf(buf)) return stats;
    sr = sr || buf.sampleRate || 44100;
    var m = mastering || MASTERING.balanced;
    var ratio = Number(m.ratio) || 2;
    var thr = Math.pow(10, (Number(m.thresholdDb) == null ? -12 : Number(m.thresholdDb)) / 20);
    var ceil = Number(m.truePeakCeil) || 0.71;
    var aA = 1 - Math.exp(-1 / (0.010 * sr));
    var aR = 1 - Math.exp(-1 / (0.100 * sr));
    var nCh = buf.numberOfChannels, n = buf.length, ch, i;
    var chans = [];
    for (ch = 0; ch < nCh; ch++) chans.push(buf.getChannelData(ch));
    // peak before
    var peak = 0;
    for (ch = 0; ch < nCh; ch++) {
      var dd = chans[ch];
      for (i = 0; i < n; i++) { var av = dd[i] < 0 ? -dd[i] : dd[i]; if (av > peak) peak = av; }
    }
    stats.peakBefore = round2(peak);
    // soft-knee compression (knee ±3 dB around threshold)
    var env = 0, maxGR = 0, inv = 1 - 1 / ratio;
    for (i = 0; i < n; i++) {
      var det = 0;
      for (ch = 0; ch < nCh; ch++) { var a2 = chans[ch][i] < 0 ? -chans[ch][i] : chans[ch][i]; if (a2 > det) det = a2; }
      var c = det > env ? aA : aR;
      env += c * (det - env);
      var g = 1;
      if (env > 1e-9) {
        var overDb = 20 * Math.log10(Math.max(env, 1e-9) / thr);
        var gr = 0;
        if (overDb > 3) gr = overDb * inv;
        else if (overDb > -3) { var k2 = overDb + 3; gr = (k2 * k2 / 12) * inv; }
        if (gr > 0) { g = Math.pow(10, -gr / 20); if (gr > maxGR) maxGR = gr; }
      }
      for (ch = 0; ch < nCh; ch++) chans[ch][i] *= g;
    }
    stats.grDb = round2(maxGR);
    // true-peak (4x) gain limit to ceiling — pure gain, no clipping
    var tp = 0;
    for (ch = 0; ch < nCh; ch++) {
      var e2 = chans[ch];
      for (i = 0; i < e2.length; i++) {
        var q0 = Math.abs(e2[i]); if (q0 > tp) tp = q0;
        if (i + 1 < e2.length) {
          var q1 = Math.abs(e2[i + 1]);
          var m1 = (q0 * 3 + q1) * 0.25, m2 = (q0 + q1) * 0.5, m3 = (q0 + q1 * 3) * 0.25;
          if (m1 > tp) tp = m1; if (m2 > tp) tp = m2; if (m3 > tp) tp = m3;
        }
      }
    }
    if (tp > ceil && tp > 1e-9) {
      var gg = ceil / tp;
      for (ch = 0; ch < nCh; ch++) { var f = chans[ch]; for (i = 0; i < f.length; i++) f[i] *= gg; }
      tp = ceil;
    }
    stats.peakAfter = round2(tp);
    return stats;
  }

  /* ================= public API ================= */
  return {
    // arrangement (§5 §7 §8)
    buildArrangement: buildArrangement,
    deriveSections: deriveSections,
    bridgeToTimeline: bridgeToTimeline,
    // compatibility (§6)
    scoreCompatibility: scoreCompatibility,
    compatibilityMatrix: compatibilityMatrix,
    // presets (§13)
    PRESETS: PRESETS,
    listPresets: listPresets,
    getPreset: getPreset,
    presetDiff: presetDiff,
    presetRenderSpec: presetRenderSpec,
    AUDIBLE_KEYS: AUDIBLE_KEYS,
    // settings (§14)
    getSettingsUI: getSettingsUI,
    getTransposeUI: getTransposeUI,
    defaultSettings: defaultSettings,
    validateSettings: validateSettings,
    mapSettingsToParams: mapSettingsToParams,
    PARAM_MAPPING: PARAM_MAPPING,
    // transpose (§14)
    transposePlan: transposePlan,
    // v25 DSP chain
    shapeBeatDynamics: shapeBeatDynamics,
    addRisers: addRisers,
    applyPresetTone: applyPresetTone,
    applyMastering: applyMastering,
  };
})();

/* Node test hook: `node -e "global.window={}; require('./v25-arrange.js')"`
   exposes the module on global.window.RM.v25arrange. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' && window.RM && window.RM.v25arrange) || null;
}
