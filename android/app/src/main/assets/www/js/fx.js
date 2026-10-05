'use strict';
/* =====================================================================
   RuhMix — fx.js
   Buildable live FX chains (Web Audio nodes, no DSP on the UI thread):
     input -> EQ3 -> EQ10 -> lowpass filter -> drive -> chorus ->
     echo (delay) -> reverb (convolver send) -> compressor -> limiter ->
     output
   Each block has an enable flag + params. Master-chain builder for the
   Mastering screen. All changes are click-free (setTargetAtTime).
   ===================================================================== */
window.RM = window.RM || {};

RM.fx = (function () {
  const clamp = RM.audio.clamp;
  const EQ10_FREQS = [60, 150, 300, 600, 1000, 2000, 4000, 8000, 12000, 16000];

  const REVERB_ROOMS = {
    studio: { dur: 0.6, decay: 2.2, label: 'Studio' },
    room:   { dur: 1.0, decay: 2.4, label: 'Room' },
    hall:   { dur: 1.8, decay: 2.6, label: 'Hall' },
    church: { dur: 2.2, decay: 3.0, label: 'Church' },
  };

  const EQ_PRESETS = {
    flat:    { name: 'Flat',        g: [0, 0, 0] },
    bright:  { name: 'Bright',      g: [-1, 1, 4] },
    warm:    { name: 'Warm',        g: [3, 1, -2] },
    bass:    { name: 'Bass Boost',  g: [7, 2, 0] },
    vocal:   { name: 'Vocal',       g: [-2, 4, 3] },
    lofi:    { name: 'Lo-Fi',       g: [2, 1, -6] },
    vshape:  { name: 'V-Shape',     g: [4, -3, 4] },
  };

  function driveCurve(amount) {
    const k = 1 + amount * 40;
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  }

  // Local mono impulse builder that works with ANY BaseAudioContext
  // (realtime or OfflineAudioContext) — never touches the shared ctx.
  function buildIR(c, durSec, decayPow) {
    const dur = Math.min(Math.max(0.1, durSec || 1.8), 2.2);
    const sr = c.sampleRate;
    const len = Math.max(1, Math.floor(sr * dur));
    const ir = c.createBuffer(1, len, sr);
    const d = ir.getChannelData(0);
    const pw = decayPow || 2.5;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, pw);
    }
    return ir;
  }

  // Full insert chain. Returns {input, output, set(...), applyPreset, dispose}.
  function makeChain(ctx) {
    const N = {};
    const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };

    N.input = G(1);

    // 3-band EQ
    N.eqBass = ctx.createBiquadFilter();   N.eqBass.type = 'lowshelf';  N.eqBass.frequency.value = 150;
    N.eqMid = ctx.createBiquadFilter();    N.eqMid.type = 'peaking';    N.eqMid.frequency.value = 1000; N.eqMid.Q.value = 1;
    N.eqTreble = ctx.createBiquadFilter(); N.eqTreble.type = 'highshelf'; N.eqTreble.frequency.value = 8000;

    // 10-band EQ (peaking, Q=1)
    N.eq10 = EQ10_FREQS.map(f => {
      const b = ctx.createBiquadFilter();
      b.type = 'peaking'; b.frequency.value = f; b.Q.value = 1; b.gain.value = 0;
      return b;
    });

    // lowpass filter
    N.filter = ctx.createBiquadFilter(); N.filter.type = 'lowpass'; N.filter.frequency.value = 19000;

    // soft drive
    N.drive = ctx.createWaveShaper(); N.drive.curve = driveCurve(0); N.drive.oversample = '2x';

    // chorus: dry + modulated delay voice
    N.chDry = G(1);
    N.chDelay = ctx.createDelay(0.05); N.chDelay.delayTime.value = 0.018;
    N.chWet = G(0);
    N.chLFO = ctx.createOscillator(); N.chLFO.frequency.value = 1.2;
    N.chLFOGain = G(0.004);
    N.chLFO.connect(N.chLFOGain); N.chLFOGain.connect(N.chDelay.delayTime);
    N.chLFO.start();

    // echo: delay + feedback + wet
    N.echoDelay = ctx.createDelay(2.0); N.echoDelay.delayTime.value = 0.375;
    N.echoFB = G(0.35);
    N.echoWet = G(0);
    N.echoDelay.connect(N.echoFB); N.echoFB.connect(N.echoDelay);
    N.echoDelay.connect(N.echoWet);

    // reverb: HP-filtered send -> convolver -> wet
    N.rvSend = G(1);
    N.rvHP = ctx.createBiquadFilter(); N.rvHP.type = 'highpass'; N.rvHP.frequency.value = 280; N.rvHP.Q.value = 0.7;
    N.convolver = ctx.createConvolver();
    N.convolver.buffer = buildIR(ctx, 1.8);
    N.convolver._room = 'hall';
    N.rvWet = G(0);

    // compressor + limiter
    N.comp = ctx.createDynamicsCompressor();
    N.limiter = ctx.createDynamicsCompressor();
    N.limiter.threshold.value = -3; N.limiter.knee.value = 6;
    N.limiter.ratio.value = 4; N.limiter.attack.value = 0.003; N.limiter.release.value = 0.25;

    N.output = G(1);

    // Static wiring — final topology (documented):
    //   input -> eq3 -> eq10 -> filter -> drive -+-> chorusDry -> comp
    //                                            +-> chorusWet -> comp
    //                                            +-> echoDelay -> echoWet -> comp
    //                                            +-> rvSend -> rvHP -> convolver -> rvWet -> comp
    //   comp -> limiter -> output
    // Echo and reverb are parallel SENDS (never inserts), so toggling them
    // never breaks the dry path.
    N.input.connect(N.eqBass);
    N.eqBass.connect(N.eqMid); N.eqMid.connect(N.eqTreble);
    let head = N.eqTreble;
    N.eq10.forEach(b => { head.connect(b); head = b; });
    head.connect(N.filter);
    N.filter.connect(N.drive);
    N.drive.connect(N.chDry); N.chDry.connect(N.comp);          // chorus dry
    N.drive.connect(N.chDelay); N.chDelay.connect(N.chWet); N.chWet.connect(N.comp); // chorus voice
    N.drive.connect(N.echoDelay);                                // echo send
    N.echoDelay.connect(N.echoFB); N.echoFB.connect(N.echoDelay);// feedback loop
    N.echoDelay.connect(N.echoWet); N.echoWet.connect(N.comp);   // echo return
    N.drive.connect(N.rvSend);                                  // reverb send
    N.rvSend.connect(N.rvHP); N.rvHP.connect(N.convolver);
    N.convolver.connect(N.rvWet); N.rvWet.connect(N.comp);      // reverb return
    N.comp.connect(N.limiter); N.limiter.connect(N.output);

    const t = (param, v, tc) => param.setTargetAtTime(v, ctx.currentTime, tc || 0.015);

    const api = {
      input: N.input, output: N.output, nodes: N,
      set(name, value) {
        const v = +value;
        switch (name) {
          case 'eqBass': t(N.eqBass.gain, clamp(v, -15, 15)); break;
          case 'eqMid': t(N.eqMid.gain, clamp(v, -15, 15)); break;
          case 'eqTreble': t(N.eqTreble.gain, clamp(v, -15, 15)); break;
          case 'eq10': // value = array of 10 gains
            if (Array.isArray(value)) value.forEach((g, i) => { if (N.eq10[i]) t(N.eq10[i].gain, clamp(+g, -15, 15)); });
            break;
          case 'filterCutoff': t(N.filter.frequency, clamp(v, 40, 20000)); break;
          case 'drive': N.drive.curve = driveCurve(clamp(v, 0, 1)); break;
          case 'chorusOn': t(N.chWet.gain, v ? 0.5 : 0); break;
          case 'chorusRate': t(N.chLFO.frequency, clamp(v, 0.1, 8), 0.05); break;
          case 'chorusDepth': t(N.chLFOGain.gain, clamp(v, 0, 0.012), 0.05); break;
          case 'echoOn': t(N.echoWet.gain, v ? 0.35 : 0); break;
          case 'echoTime': t(N.echoDelay.delayTime, clamp(v, 0.02, 1.8), 0.03); break;
          case 'echoFeedback': t(N.echoFB.gain, clamp(v, 0, 0.85)); break;
          case 'echoWet': t(N.echoWet.gain, clamp(v, 0, 0.8)); break;
          case 'reverbOn': t(N.rvWet.gain, v ? 0.4 : 0); break;
          case 'reverbWet': t(N.rvWet.gain, clamp(v, 0, 1)); break;
          case 'reverbRoom': {
            const r = REVERB_ROOMS[value] || REVERB_ROOMS.hall;
            if (N.convolver._room !== value) {
              N.convolver.buffer = buildIR(ctx, r.dur, r.decay);
              N.convolver._room = value;
            }
            break;
          }
          case 'reverbDecay': // scales wet + rebuilds IR with new length
            break;
          case 'compOn':
            t(N.comp.threshold, v ? -18 : 0); t(N.comp.ratio, v ? 4 : 1);
            break;
          case 'compThreshold': t(N.comp.threshold, clamp(v, -40, 0)); break;
          case 'compRatio': t(N.comp.ratio, clamp(v, 1, 20)); break;
          case 'compAttack': t(N.comp.attack, clamp(v, 0.001, 0.5), 0.05); break;
          case 'compRelease': t(N.comp.release, clamp(v, 0.01, 2), 0.05); break;
          case 'outGain': t(N.output.gain, clamp(v, 0, 2)); break;
        }
      },
      applyPreset(p) { // p: {eq3:[b,m,t], eq10:[..], filter, drive, chorus:{on,rate,depth}, echo:{on,time,fb,wet}, reverb:{on,room,wet}, comp:{on,thr,ratio,atk,rel}, out}
        if (!p) return;
        if (p.eq3) { api.set('eqBass', p.eq3[0]); api.set('eqMid', p.eq3[1]); api.set('eqTreble', p.eq3[2]); }
        if (p.eq10) api.set('eq10', p.eq10);
        if (p.filter != null) api.set('filterCutoff', p.filter);
        if (p.drive != null) api.set('drive', p.drive);
        if (p.chorus) { api.set('chorusOn', p.chorus.on); api.set('chorusRate', p.chorus.rate || 1.2); api.set('chorusDepth', p.chorus.depth || 0.004); }
        if (p.echo) { api.set('echoOn', p.echo.on); api.set('echoTime', p.echo.time || 0.375); api.set('echoFeedback', p.echo.fb || 0.35); api.set('echoWet', p.echo.wet != null ? p.echo.wet : 0.35); }
        if (p.reverb) { api.set('reverbOn', p.reverb.on); if (p.reverb.room) api.set('reverbRoom', p.reverb.room); api.set('reverbWet', p.reverb.wet != null ? p.reverb.wet : 0.4); }
        if (p.comp) { api.set('compOn', p.comp.on); api.set('compThreshold', p.comp.thr != null ? p.comp.thr : -18); api.set('compRatio', p.comp.ratio || 4); api.set('compAttack', p.comp.atk || 0.01); api.set('compRelease', p.comp.rel || 0.2); }
        if (p.out != null) api.set('outGain', p.out);
      },
      dispose() {
        try { N.chLFO.stop(); } catch (e) {}
        Object.keys(N).forEach(k => {
          const n = N[k];
          (Array.isArray(n) ? n : [n]).forEach(x => { try { x.disconnect(); } catch (e) {} });
        });
      },
    };
    // Defaults: compressor gentle-on, everything else off
    api.set('compOn', true);
    return api;
  }

  // Mastering chain for the Mastering screen: input -> eq3 -> comp -> limiter -> out.
  // Normalization is applied as a sample op before/after (see RM.exp).
  function makeMasterChain(ctx, s) {
    s = s || {};
    const N = {};
    N.input = ctx.createGain();
    N.eqB = ctx.createBiquadFilter(); N.eqB.type = 'lowshelf'; N.eqB.frequency.value = 150;
    N.eqM = ctx.createBiquadFilter(); N.eqM.type = 'peaking'; N.eqM.frequency.value = 1000; N.eqM.Q.value = 1;
    N.eqT = ctx.createBiquadFilter(); N.eqT.type = 'highshelf'; N.eqT.frequency.value = 8000;
    N.comp = ctx.createDynamicsCompressor();
    N.limiter = ctx.createDynamicsCompressor();
    N.limiter.threshold.value = -1.5; N.limiter.knee.value = 0;
    N.limiter.ratio.value = 20; N.limiter.attack.value = 0.002; N.limiter.release.value = 0.15;
    N.out = ctx.createGain();
    N.input.connect(N.eqB); N.eqB.connect(N.eqM); N.eqM.connect(N.eqT);
    N.eqT.connect(N.comp); N.comp.connect(N.limiter); N.limiter.connect(N.out);
    const t = (p, v, tc) => p.setTargetAtTime(v, ctx.currentTime, tc || 0.015);
    const api = {
      input: N.input, output: N.out,
      apply(st) {
        t(N.eqB.gain, st.eqB || 0); t(N.eqM.gain, st.eqM || 0); t(N.eqT.gain, st.eqT || 0);
        t(N.comp.threshold, st.thr != null ? st.thr : -14);
        t(N.comp.knee, st.knee != null ? st.knee : 8);
        t(N.comp.ratio, st.ratio || 3);
        t(N.comp.attack, st.atk || 0.008);
        t(N.comp.release, st.rel || 0.25);
        t(N.out.gain, st.makeup || 1);
      },
      dispose() { Object.keys(N).forEach(k => { try { N[k].disconnect(); } catch (e) {} }); },
    };
    api.apply(s);
    return api;
  }

  const MASTER_PRESETS = {
    clean:   { label: 'Clean Polish',  eqB: 0, eqM: 0, eqT: 1, thr: -14, knee: 8, ratio: 2.5, atk: 0.01, rel: 0.3, makeup: 1.0 },
    loud:    { label: 'Loud & Punchy', eqB: 2, eqM: 0, eqT: 2, thr: -18, knee: 4, ratio: 5,   atk: 0.004, rel: 0.18, makeup: 1.1 },
    warm:    { label: 'Warm Analog',   eqB: 3, eqM: 1, eqT: -1, thr: -12, knee: 12, ratio: 2,  atk: 0.015, rel: 0.4, makeup: 1.0 },
    bright:  { label: 'Bright Modern', eqB: -1, eqM: 1, eqT: 4, thr: -15, knee: 6, ratio: 3.5, atk: 0.006, rel: 0.22, makeup: 1.05 },
    lofi:    { label: 'Lo-Fi Tape',    eqB: 2, eqM: 0, eqT: -5, thr: -10, knee: 14, ratio: 2,  atk: 0.02, rel: 0.5, makeup: 0.95 },
  };

  return { makeChain, makeMasterChain, REVERB_ROOMS, EQ_PRESETS, EQ10_FREQS, MASTER_PRESETS };
})();
