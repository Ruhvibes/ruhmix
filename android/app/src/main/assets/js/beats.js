'use strict';
/* =====================================================================
   RuhMix — beats.js
   W1: Beat synthesis engine — 100% SYNTHESIZED drum patterns.

   No audio files, no samples, no network. Every drum hit is built from
   oscillators + filtered noise inside an OfflineAudioContext:
     kick   = sine osc with pitch drop (150 -> 50 Hz) + click transient
     k808   = hard 808-style kick: sine 60 -> 40 Hz, long decay, soft attack
     snare  = noise burst (bandpass) + 200 Hz body
     rim    = light rimshot: short bright noise ping (lofi)
     clap   = 3 quick noise bursts + short tail
     chat   = closed hat: highpassed noise, short envelope
     ohat   = open hat: highpassed noise, long envelope
     perc   = filtered noise blip (shaker / conga-ish, per-style frequency)

   Exposes window.RM.Beats:
     RM.Beats.STYLES
         [{ id, name, bpm, desc }, ...] — 8 styles, names in English.
     RM.Beats.getStyle(styleId) -> { id, name, bpm, desc }
         Throws Error('unknown beat style: <id>') on bad id.
     RM.Beats.getPattern(styleId)
         -> { kick, k808, snare, rim, clap, chat, ohat, perc }
         Each value is a 16-element array (one bar, 16th-note grid);
         entries are velocities 0..1 (0 = no hit). Deep copy — safe to
         read for UI/pipeline, mutating it changes nothing.
     RM.Beats.stepDuration(bpm) -> seconds
         Exact 16th-note step length: 60 / bpm / 4.
     RM.Beats.renderBeat(styleId, bpm, bars, opts) -> Promise<AudioBuffer>
         Renders a loop-perfect stereo beat.
           styleId : one of STYLES[].id
           bpm     : beats per minute; falsy -> style default
           bars    : bar count; falsy/invalid -> 4
           opts    : { sampleRate (default 48000),
                       swing      (default = style swing),
                       humanize   (default true: +/-15% velocity +
                                   micro timing jitter) }
         No dependencies on mashup.js or any other module — standalone.
         UI/pipeline/export are other workers' jobs; this only returns
         the buffer. NO autoplay — the caller decides what to play.

   Human feel: every hit gets +/-15% velocity variation and a few ms of
   timing jitter; swung styles (hiphop/lofi/drill) delay offbeat 16ths by
   swing * stepDur (MPC-style). Nothing robotic.

   Loop-perfect: every envelope is truncated so it reaches ~0 (-80 dB)
   at or before the buffer end — no reverb tail is ever rendered (dry).
   Wrapping the buffer plays click-free at bar boundaries.

   BPM accuracy: step timing uses stepDur = 60/bpm/4 exactly; the total
   loop length is bars*16*stepDur, i.e. an exact whole number of beats.

   Sample rate: all timing is in seconds, so 44100 and 48000 both work;
   buffer length = ceil(sampleRate * totalDur).
   ===================================================================== */
window.RM = window.RM || {};

RM.Beats = (function () {

  /* ---------------- style catalogue ---------------- */
  var STYLES = [
    { id: 'hiphop', name: 'Hip-Hop',     bpm: 90,  desc: 'Boom-bap groove with swung hats' },
    { id: 'trap',   name: 'Trap',        bpm: 140, desc: 'Rolling hats, hard 808 kick, snare on 3' },
    { id: 'edm',    name: 'EDM',         bpm: 128, desc: 'Four-on-the-floor energy with offbeat hats' },
    { id: 'house',  name: 'House',       bpm: 124, desc: 'Deep four-floor groove, open offbeat hats' },
    { id: 'lofi',   name: 'Lo-Fi',       bpm: 80,  desc: 'Soft jazzy swing with dusty rim shots' },
    { id: 'drill',  name: 'Drill',       bpm: 140, desc: 'Sliding 808s with a triplet hat bounce' },
    { id: 'pop',    name: 'Pop',         bpm: 100, desc: 'Clean radio groove, 8th-note hats' },
    { id: 'dnb',    name: 'Drum & Bass', bpm: 174, desc: 'Fast syncopated breakbeat' }
  ];

  /* ---------------- per-style timbre ----------------
     swing: fraction of stepDur added to offbeat (odd) 16ths.
     kick*: pitch-drop kick shaping. k808Dur: 808 decay seconds.
     snareFreq: snare noise bandpass Hz. ohatDur: open-hat seconds.
     percFreq: percussion blip bandpass Hz. kickGain: kick level trim. */
  var TIMBRE = {
    hiphop: { swing: 0.30, kickStart: 150, kickEnd: 50, kickDur: 0.30, kickGain: 1.00,
              snareFreq: 1800, ohatDur: 0.35, percFreq: 5200 },
    trap:   { swing: 0.00, k808Dur: 0.70, snareFreq: 1900, ohatDur: 0.30, percFreq: 6000 },
    edm:    { swing: 0.00, kickStart: 160, kickEnd: 45, kickDur: 0.35, kickGain: 1.00,
              snareFreq: 2000, ohatDur: 0.35, percFreq: 6500 },
    house:  { swing: 0.00, kickStart: 150, kickEnd: 50, kickDur: 0.30, kickGain: 1.00,
              snareFreq: 1800, ohatDur: 0.35, percFreq: 900 },
    lofi:   { swing: 0.32, kickStart: 120, kickEnd: 60, kickDur: 0.35, kickGain: 0.85,
              snareFreq: 1600, ohatDur: 0.40, percFreq: 4000 },
    drill:  { swing: 0.25, k808Dur: 0.90, snareFreq: 1900, ohatDur: 0.30, percFreq: 5500 },
    pop:    { swing: 0.00, kickStart: 140, kickEnd: 55, kickDur: 0.25, kickGain: 0.95,
              snareFreq: 1800, ohatDur: 0.30, percFreq: 5200 },
    dnb:    { swing: 0.00, kickStart: 170, kickEnd: 50, kickDur: 0.25, kickGain: 1.00,
              snareFreq: 2400, ohatDur: 0.25, percFreq: 6000 }
  };

  /* ---------------- original 16-step patterns ----------------
     One bar = 16 sixteenth steps. Values are velocities 0..1.
     Step indices: 0,4,8,12 = quarter-note beats 1,2,3,4.
     Every array is exactly 16 entries — renderBeat validates this. */
  var Z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  var PATTERNS = {
    /* hiphop — boom-bap: kick on 1 and the "& of 3" (step 10) + ghosts,
       snare on 2 & 4, swung 8th hats, open hat pickup at bar end. */
    hiphop: {
      kick:  [1, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 1, 0, 0, 0, 0.35, 0],
      k808:  Z,
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      rim:   Z,
      clap:  Z,
      chat:  [0.7, 0, 0.55, 0, 0.7, 0, 0.55, 0, 0.7, 0, 0.55, 0, 0.7, 0, 0.55, 0.5],
      ohat:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0.3]
    },
    /* trap — hard 808 kicks with ghosts, snare on 3 (step 8) layered
       with clap, rolling 16th hats with a 32nd-feel roll at bar end. */
    trap: {
      kick:  Z,
      k808:  [0.95, 0, 0, 0.5, 0, 0, 0.7, 0, 0, 0, 0.85, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      rim:   Z,
      clap:  [0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0],
      chat:  [0.65, 0.4, 0.55, 0.4, 0.65, 0.4, 0.55, 0.4,
              0.65, 0.4, 0.55, 0.4, 0.7, 0.7, 0.85, 1],
      ohat:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0]
    },
    /* edm — four-on-the-floor kick, offbeat closed+open hats,
       clap on 2 & 4. */
    edm: {
      kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      k808:  Z,
      snare: Z,
      rim:   Z,
      clap:  [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
      chat:  [0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0],
      ohat:  [0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35]
    },
    /* house — four-floor kick, open hats offbeat, light 16th closed
       hats, clap + snare layer on 2 & 4, conga-ish blips. */
    house: {
      kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      k808:  Z,
      snare: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0],
      rim:   Z,
      clap:  [0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0],
      chat:  [0.45, 0.3, 0.4, 0.3, 0.45, 0.3, 0.4, 0.3,
              0.45, 0.3, 0.4, 0.3, 0.45, 0.3, 0.4, 0.3],
      ohat:  [0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.55]
    },
    /* lofi — soft kick with jazzy ghosts, light rim on 2 & 4,
       swung sparse hats, open hat at bar end. */
    lofi: {
      kick:  [0.8, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0.6, 0, 0, 0, 0, 0],
      k808:  Z,
      snare: Z,
      rim:   [0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0, 0, 0.75, 0, 0, 0],
      clap:  Z,
      chat:  [0.5, 0, 0.4, 0, 0.5, 0, 0.4, 0,
              0.5, 0, 0.4, 0.35, 0.5, 0, 0.45, 0],
      ohat:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4],
      perc:  [0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0.3, 0, 0]
    },
    /* drill — sliding-feel 808s, snare on 3, triplet-bounce hats
       (dotted-8th-ish placement against the 16th grid). */
    drill: {
      kick:  Z,
      k808:  [0.95, 0, 0, 0.6, 0, 0, 0.75, 0, 0.9, 0, 0.6, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      rim:   Z,
      clap:  [0, 0, 0, 0, 0, 0, 0, 0, 0.65, 0, 0, 0, 0, 0, 0, 0],
      chat:  [0.85, 0, 0, 0.55, 0, 0, 0.75, 0,
              0.85, 0, 0, 0.55, 0, 0, 0.75, 0.9],
      ohat:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0]
    },
    /* pop — clean soft four-floor kick, snare+clap on 2 & 4,
       steady 8th hats. */
    pop: {
      kick:  [0.85, 0, 0, 0, 0.85, 0, 0, 0, 0.85, 0, 0, 0, 0.85, 0, 0, 0],
      k808:  Z,
      snare: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
      rim:   Z,
      clap:  [0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0],
      chat:  [0.55, 0, 0.45, 0, 0.55, 0, 0.45, 0,
              0.55, 0, 0.45, 0, 0.55, 0, 0.45, 0],
      ohat:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0]
    },
    /* dnb — fast breakbeat feel: syncopated kicks, snare on 2 & 4
       with a ghost at bar end, driving 16th hats. */
    dnb: {
      kick:  [0.9, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0.8, 0, 0, 0, 0, 0],
      k808:  Z,
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.3],
      rim:   Z,
      clap:  Z,
      chat:  [0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35,
              0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35],
      ohat:  [0, 0, 0.55, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0],
      perc:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 0, 0]
    }
  };

  var INST_KEYS = ['kick', 'k808', 'snare', 'rim', 'clap', 'chat', 'ohat', 'perc'];

  /* ---------------- public: catalogue ---------------- */

  function getStyle(styleId) {
    for (var i = 0; i < STYLES.length; i++) {
      if (STYLES[i].id === styleId) return STYLES[i];
    }
    throw new Error('RM.Beats: unknown beat style "' + styleId + '"');
  }

  function getPattern(styleId) {
    getStyle(styleId); // validates id
    var src = PATTERNS[styleId];
    var out = {};
    for (var k = 0; k < INST_KEYS.length; k++) {
      out[INST_KEYS[k]] = src[INST_KEYS[k]].slice();
    }
    return out;
  }

  function stepDuration(bpm) {
    return 60 / bpm / 4;
  }

  /* ---------------- synth helpers ---------------- */

  // Shared white-noise buffer, long enough for any tail near the loop end.
  function makeNoise(ctx, durSec) {
    var len = Math.max(1, Math.ceil(ctx.sampleRate * durSec));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function noiseSrc(ctx, noiseBuf, t, playDur, remain) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var maxOff = Math.max(0, noiseBuf.duration - playDur - 0.05);
    var off = maxOff > 0 ? Math.random() * maxOff : 0;
    s.start(t, off, Math.min(playDur, Math.max(0.01, remain)) + 0.05);
    return s;
  }

  // Click-free gain envelope: tiny linear attack, exponential decay to
  // -80 dB exactly at t+dur. `dur` is pre-truncated to the loop end.
  function env(g, t, peak, dur, attack) {
    attack = attack || 0.002;
    if (dur < attack + 0.005) dur = attack + 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function panNode(ctx, out, pan) {
    if (!pan || !ctx.createStereoPanner) return out;
    var p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(out);
    return p;
  }

  /* ---- instruments: each gets (ctx, out, noiseBuf, t, vel, tim, remain)
         `tim` = TIMBRE[styleId], `remain` = totalDur - t (loop-end guard) ---- */

  function iKick(ctx, out, noiseBuf, t, vel, tim, remain) {
    var dur = Math.min(tim.kickDur, remain);
    if (dur <= 0.01 || vel <= 0) return;
    var v = vel * tim.kickGain;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(Math.max(20, tim.kickStart), t);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, tim.kickEnd), t + Math.min(0.09, dur * 0.5));
    var g = ctx.createGain();
    env(g, t, v, dur, 0.002);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + dur + 0.02);
    // click transient — beater attack
    var click = noiseSrc(ctx, noiseBuf, t, 0.02, remain);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    var cg = ctx.createGain();
    env(cg, t, v * 0.45, Math.min(0.015, dur), 0.001);
    click.connect(hp); hp.connect(cg); cg.connect(out);
  }

  function iKick808(ctx, out, noiseBuf, t, vel, tim, remain) {
    var dur = Math.min(tim.k808Dur || 0.7, remain);
    if (dur <= 0.01 || vel <= 0) return;
    // fundamental: soft attack (no click), 60 -> 40 Hz glide
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(60, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + Math.min(0.25, dur * 0.6));
    var g = ctx.createGain();
    env(g, t, vel, dur, 0.006);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + dur + 0.02);
    // faint 2nd harmonic for phone-speaker presence
    var osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(120, t);
    osc2.frequency.exponentialRampToValueAtTime(80, t + Math.min(0.25, dur * 0.6));
    var g2 = ctx.createGain();
    env(g2, t, vel * 0.22, dur * 0.7, 0.006);
    osc2.connect(g2); g2.connect(out);
    osc2.start(t); osc2.stop(t + dur + 0.02);
  }

  function iSnare(ctx, out, noiseBuf, t, vel, tim, remain) {
    var dur = Math.min(0.16, remain);
    if (dur <= 0.01 || vel <= 0) return;
    var n = noiseSrc(ctx, noiseBuf, t, 0.2, remain);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = tim.snareFreq; bp.Q.value = 0.9;
    var ng = ctx.createGain();
    env(ng, t, vel * 0.8, dur, 0.001);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    // 200 Hz body
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, t);
    var bg = ctx.createGain();
    env(bg, t, vel * 0.55, Math.min(0.10, dur), 0.001);
    osc.connect(bg); bg.connect(out);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  function iRim(ctx, out, noiseBuf, t, vel, tim, remain) {
    var dur = Math.min(0.035, remain);
    if (dur <= 0.01 || vel <= 0) return;
    var n = noiseSrc(ctx, noiseBuf, t, 0.05, remain);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 2;
    var ng = ctx.createGain();
    env(ng, t, vel * 0.8, dur, 0.001);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, t);
    var og = ctx.createGain();
    env(og, t, vel * 0.3, Math.min(0.02, dur), 0.001);
    osc.connect(og); og.connect(out);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  function iClap(ctx, out, noiseBuf, t, vel, tim, remain) {
    if (vel <= 0 || remain <= 0.01) return;
    var gaps = [0, 0.011, 0.023];
    var gains = [0.5, 0.4, 0.6];
    for (var i = 0; i < 3; i++) {
      var bt = t + gaps[i];
      var bRemain = remain - gaps[i];
      if (bRemain <= 0.01) continue;
      var n = noiseSrc(ctx, noiseBuf, bt, 0.05, bRemain);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.5;
      var g = ctx.createGain();
      env(g, bt, vel * gains[i], Math.min(0.03, bRemain), 0.001);
      n.connect(bp); bp.connect(g); g.connect(out);
    }
    // tail
    var tail = noiseSrc(ctx, noiseBuf, t + 0.023, 0.2, remain - 0.023);
    var tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass'; tbp.frequency.value = 1300; tbp.Q.value = 1.5;
    var tg = ctx.createGain();
    env(tg, t + 0.023, vel * 0.5, Math.min(0.18, Math.max(0.01, remain - 0.023)), 0.002);
    tail.connect(tbp); tbp.connect(tg); tg.connect(out);
  }

  function iHat(ctx, out, noiseBuf, t, vel, tim, remain, open) {
    var dur = Math.min(open ? tim.ohatDur : 0.04, remain);
    if (dur <= 0.01 || vel <= 0) return;
    var n = noiseSrc(ctx, noiseBuf, t, dur + 0.05, remain);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = open ? 7500 : 8000;
    var g = ctx.createGain();
    env(g, t, vel * 0.5, dur, 0.001);
    n.connect(hp); hp.connect(g); g.connect(out);
  }

  function iPerc(ctx, out, noiseBuf, t, vel, tim, remain) {
    var dur = Math.min(0.07, remain);
    if (dur <= 0.01 || vel <= 0) return;
    var n = noiseSrc(ctx, noiseBuf, t, 0.1, remain);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = tim.percFreq; bp.Q.value = 6;
    var g = ctx.createGain();
    env(g, t, vel * 0.45, dur, 0.001);
    n.connect(bp); bp.connect(g); g.connect(out);
  }

  /* ---------------- main render ---------------- */

  function renderBeat(styleId, bpm, bars, opts) {
    opts = opts || {};
    var st = getStyle(styleId);
    var pat = PATTERNS[styleId];
    var tim = TIMBRE[styleId];

    // Validate every pattern array is exactly one bar of 16 steps.
    for (var k = 0; k < INST_KEYS.length; k++) {
      var a = pat[INST_KEYS[k]];
      if (!a || a.length !== 16) {
        throw new Error('RM.Beats: pattern "' + INST_KEYS[k] + '" for style "' +
                        styleId + '" must have exactly 16 steps');
      }
    }

    bpm = (typeof bpm === 'number' && bpm > 0) ? bpm : st.bpm;
    bars = Math.max(1, Math.floor(bars) || 4);
    var swing = (typeof opts.swing === 'number') ? opts.swing : tim.swing;
    var humanize = opts.humanize !== false;
    var sr = opts.sampleRate || 48000;

    var stepDur = stepDuration(bpm);          // EXACT: 60/bpm/4
    var totalSteps = bars * 16;
    var totalDur = totalSteps * stepDur;      // exact whole beats -> seamless loop

    var ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(sr * totalDur)), sr);
    var master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    var noiseBuf = makeNoise(ctx, totalDur + 1);

    // subtle stereo: hats/perc slightly off-center, kick/snare/clap centered
    var busKick  = master;
    var busSnare = master;
    var busHatL  = panNode(ctx, master, -0.18);
    var busHatR  = panNode(ctx, master, 0.18);
    var busPerc  = panNode(ctx, master, -0.25);

    for (var b = 0; b < bars; b++) {
      for (var s = 0; s < 16; s++) {
        var t = (b * 16 + s) * stepDur;
        if (s % 2 === 1) t += swing * stepDur;      // swing delays offbeat 16ths
        if (humanize) {
          t += (Math.random() * 2 - 1) * (swing > 0 ? 0.0025 : 0.0012);
          if (t < 0) t = 0;
        }
        var remain = totalDur - t;                  // loop-end guard
        if (remain <= 0.008) continue;              // nothing may cross the loop edge

        var hv = function (base) {                  // +/-15% velocity human feel
          if (!(base > 0)) return 0;
          return humanize ? base * (1 + (Math.random() * 2 - 1) * 0.15) : base;
        };
        var hatBus = (s % 4 === 2) ? busHatR : busHatL;

        iKick (ctx, busKick,  noiseBuf, t, hv(pat.kick[s]),  tim, remain);
        iKick808(ctx, busKick, noiseBuf, t, hv(pat.k808[s]),  tim, remain);
        iSnare(ctx, busSnare, noiseBuf, t, hv(pat.snare[s]), tim, remain);
        iRim  (ctx, busSnare, noiseBuf, t, hv(pat.rim[s]),   tim, remain);
        iClap (ctx, busSnare, noiseBuf, t, hv(pat.clap[s]),  tim, remain);
        iHat  (ctx, hatBus,   noiseBuf, t, hv(pat.chat[s]),  tim, remain, false);
        iHat  (ctx, busHatR,  noiseBuf, t, hv(pat.ohat[s]),  tim, remain, true);
        iPerc (ctx, busPerc,  noiseBuf, t, hv(pat.perc[s]),  tim, remain);
      }
    }

    return ctx.startRendering().then(function (buf) {
      return peakLimit(buf, 0.95);
    });
  }

  // Normalize peak to `target` (punchy, consistent loudness, never clips).
  function peakLimit(buf, target) {
    var peak = 0;
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < d.length; i++) {
        var a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak < 0.05 || peak > 1.5) {
      // silence guard / sanity: only fix genuine overshoot
      if (peak <= target || peak < 0.05) return buf;
    }
    var scale = target / peak;
    for (var c2 = 0; c2 < buf.numberOfChannels; c2++) {
      var d2 = buf.getChannelData(c2);
      for (var i2 = 0; i2 < d2.length; i2++) d2[i2] *= scale;
    }
    return buf;
  }

  /* ---------------- exports ---------------- */
  return {
    STYLES: STYLES,
    getStyle: getStyle,
    getPattern: getPattern,
    stepDuration: stepDuration,
    renderBeat: renderBeat
  };

})();
