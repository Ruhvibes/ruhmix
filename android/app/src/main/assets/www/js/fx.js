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

  // Physical-bypass delay after switching spatial OFF (or away from 360°).
  // The wet/dry gains glide with tc=0.3, so they need ~4 time constants to
  // settle (e^-4 = 1.8% residual). Disconnecting earlier (400ms = 26%
  // residual) rebalances dry/wet mid-glide -> audible click (measured:
  // 0.074 jump on a 0.2 signal). 1200ms makes the switch inaudible; the
  // extra 0.8s of fading convolver is not idle load, just transition.
  const SPATIAL_BYPASS_DELAY_MS = 1200;

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

  /* ================= 8D / 3D / 16D spatial auto-pan =====================
     Real DSP (koi fake nahi):
       input -> dry ----------------------+------------------> output
                +-> mono-sum -> pan(LFO) -> wet +
                +-> pan -> rvSend -> convolver -> rvWet +   (space feel)
                +-> dly(LFO2) -> dlyWet +                   (16D width)
     - Sirf AMPLITUDE panning (StereoPannerNode, equal-power): koi phase
       trick nahi, isliye mono sum (L+R) me signal kabhi gayab nahi hota.
       dry+wet hamesha 1 rehta hai -> mono sum [1.0, 1.414] ke andar.
     - Panner ko TRUE MONO (1ch) feed hota hai: Chrome ka StereoPannerNode
       stereo input pe textbook curve nahi deta (measured: ~2x hot,
       unpredictable). Mono input pe bilkul textbook hai.
     - LFO kabhi stop nahi hota (click-free); enable/disable depth/wet
       gains ko glide karta hai (tc 0.3) -> abrupt pan jump nahi.
     - Slider changes dezippered hain (setTargetAtTime, tc 0.03).
     - Kisi bhi BaseAudioContext (realtime/offline) me chalta hai -> export
       render me effect pura sunai deta hai (oscillator offline bhi chalta hai).
     ===================================================================== */
  const SPATIAL_MODES = {
    off:  { speed: 0.12, depth: 0,    wet: 0,    reverb: 0,    delayWet: 0    },
    '8d': { speed: 0.12, depth: 0.85, wet: 0.90, reverb: 0.30, delayWet: 0    },
    '3d': { speed: 0.07, depth: 0.45, wet: 0.55, reverb: 0.15, delayWet: 0    },
    '16d':{ speed: 0.50, depth: 1.00, wet: 1.00, reverb: 0.20, delayWet: 0.20 },
    '360':{ speed: 0.25, depth: 1.00, wet: 1.00, reverb: 0,    delayWet: 0    },
  };

  /* ============ 360° spatial rotation (HRTF) =====================
     Real DSP: a PannerNode (panningModel='HRTF') orbits the listener on a
     full 0→360° circle — X = r·sin(θ), Z = r·cos(θ) — driven by two
     same-frequency oscillators 90° apart (cosine via createPeriodicWave,
     since OscillatorType has no 'cosine'). The phase-locked pair keeps the
     orbit a perfect circle even while the speed changes.
     - True-mono feed into the panner (same reason as makeSpatial): an HRTF
       panner sums a stereo feed unpredictably; 1-channel is textbook.
     - HRTF is amplitude/phase filtering, so a mono sum (L+R) never cancels
       the signal — mono-safe.
     - LFOs never stop (click-free); enable/disable and slider changes are
       dezippered via setTargetAtTime. The master gate keeps this branch
       fully silent unless mode '360' is active (no double-dry against the
       StereoPanner path in makeSpatial).
     - Runs on any BaseAudioContext (realtime/offline) -> renders in export.
     Honest: plain Web Audio HRTF panning — no AI involved.
     ===================================================================== */
  function makeSpatial360(ctx) {
    const N = {};
    const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    // Dezipper: tc === 0 means a FRESH chain — direct .value jump, no glide
    // (a glide here would fade the effect in over the first render second).
    const t = (param, v, tc) => {
      if (tc === 0) {
        try { param.cancelScheduledValues(0); } catch (e) {}
        param.value = v;
      } else param.setTargetAtTime(v, ctx.currentTime, tc == null ? 0.03 : tc);
    };

    N.input = G(1);
    N.dry = G(1);
    N.wet = G(0);
    N.gate = G(0); // master enable: 1 only while active
    N.output = G(1);
    // True-mono downmix (splitter -> 0.5+0.5 -> 1ch merger).
    N.split = ctx.createChannelSplitter(2);
    N.sumL = G(0.5); N.sumR = G(0.5);
    N.mono = ctx.createChannelMerger(1);
    // HRTF orbit: listener at origin, source on the unit circle (ear level).
    N.panner = ctx.createPanner();
    N.panner.panningModel = 'HRTF';
    N.panner.distanceModel = 'inverse';
    N.panner.refDistance = 1;
    N.panner.maxDistance = 10000;
    N.panner.rolloffFactor = 0; // constant distance -> no distance gain wobble
    N.lfoX = ctx.createOscillator(); // sine -> positionX
    N.lfoZ = ctx.createOscillator(); // cosine -> positionZ (90° apart)
    N.lfoZ.setPeriodicWave(ctx.createPeriodicWave(
      new Float32Array([0, 1]), new Float32Array([0, 0])));
    N.radX = G(1); N.radZ = G(1); // orbit radius
    N.lfoX.connect(N.radX); N.radX.connect(N.panner.positionX);
    N.lfoZ.connect(N.radZ); N.radZ.connect(N.panner.positionZ);
    N.lfoX.frequency.value = 0.25; N.lfoZ.frequency.value = 0.25;
    N.lfoX.start(); N.lfoZ.start(); // starts front-center: sin=0, cos=1

    N.input.connect(N.dry); N.dry.connect(N.gate);
    N.input.connect(N.split);
    N.split.connect(N.sumL, 0); N.split.connect(N.sumR, 1);
    N.sumL.connect(N.mono, 0, 0); N.sumR.connect(N.mono, 0, 0);
    N.mono.connect(N.panner); N.panner.connect(N.wet); N.wet.connect(N.gate);
    N.gate.connect(N.output);

    const st = { on: false, speed: 0.25, depth: 1 };
    function apply(tc) {
      const k = clamp(st.depth, 0, 1); // depth = orbit intensity vs dry
      t(N.lfoX.frequency, clamp(st.speed, 0.05, 1), tc);
      t(N.lfoZ.frequency, clamp(st.speed, 0.05, 1), tc);
      t(N.dry.gain, 1 - k, tc);
      t(N.wet.gain, k, tc);
      t(N.gate.gain, st.on ? 1 : 0, tc);
    }
    const api = {
      input: N.input, output: N.output, nodes: N,
      // Enable/disable: gate glides (tc 0.3) — no abrupt orbit jump, no click.
      setOn(on, immediate) { st.on = !!on; apply(immediate ? 0 : 0.3); },
      // Same speed semantics as makeSpatial: 0.05–1 Hz, slow cinematic ↔ fast spin.
      setSpeed(hz, immediate) { st.speed = clamp(+hz || 0.25, 0.05, 1); apply(immediate ? 0 : 0.03); },
      setDepth(d, immediate) { st.depth = clamp(+d || 0, 0, 1); apply(immediate ? 0 : 0.03); },
      getSettings() { return { on: st.on, speed: +st.speed.toFixed(3), depth: +st.depth.toFixed(3) }; },
      dispose() {
        try { N.lfoX.stop(); } catch (e) {}
        try { N.lfoZ.stop(); } catch (e) {}
        Object.keys(N).forEach((k) => { try { N[k].disconnect(); } catch (e) {} });
      },
    };
    apply(0);
    return api;
  }

  function makeSpatial(ctx) {
    const N = {};
    const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    // dezipper: har param change setTargetAtTime se (tc default 0.03).
    // tc === 0 matlab FRESH chain (abhi kuch render/play nahi hua): seedha
    // .value jump — setTargetAtTime yahan export ke pehle second me fade-in
    // jaisa artifact dega (construction ke no-op events bhi cancel).
    const t = (param, v, tc) => {
      if (tc === 0) {
        try { param.cancelScheduledValues(0); } catch (e) {}
        param.value = v;
      } else param.setTargetAtTime(v, ctx.currentTime, tc == null ? 0.03 : tc);
    };

    N.input = G(1);
    N.dry = G(1);
    // Wet voice: pehle TRUE MONO (1ch) downmix, phir panner. Wajah (measured,
    // Chrome): StereoPannerNode stereo input pe textbook equal-power NAHI
    // deta — dono channels sum karke pan karta hai (~2x hot, unpredictable
    // matrix). 1-channel mono input pe bilkul textbook hai (pan=0 -> 0.707,
    // pan=+-1 -> hard). Isliye splitter -> 0.5+0.5 -> ChannelMerger(1).
    N.split = ctx.createChannelSplitter(2);
    N.sumL = G(0.5); N.sumR = G(0.5);
    N.mono = ctx.createChannelMerger(1); // 1-channel output
    N.pan = ctx.createStereoPanner(); N.pan.pan.value = 0;
    N.wet = G(0);
    // LFO -> depth -> pan.pan (depth 0 = centered, transparent)
    N.lfo = ctx.createOscillator(); N.lfo.type = 'sine'; N.lfo.frequency.value = 0.12;
    N.depth = G(0);
    N.lfo.connect(N.depth); N.depth.connect(N.pan.pan);
    N.lfo.start();
    // space: post-pan reverb send (halki, 1.0s mono IR)
    N.rvSend = G(0);
    N.rv = ctx.createConvolver(); N.rv.buffer = buildIR(ctx, 1.0);
    N.rvWet = G(0);
    N.pan.connect(N.rvSend); N.rvSend.connect(N.rv); N.rv.connect(N.rvWet);
    // 16D width: halka modulated delay — mono-compat ke liye bahut subtle
    // (±2.5ms, wet 0.2): zyada depth mono sum me comb-filter dips deta hai.
    N.dly = ctx.createDelay(0.05); N.dly.delayTime.value = 0.012;
    N.dlyWet = G(0);
    N.lfo2 = ctx.createOscillator(); N.lfo2.type = 'sine'; N.lfo2.frequency.value = 0.5;
    N.lfo2g = G(0.0025);
    N.lfo2.connect(N.lfo2g); N.lfo2g.connect(N.dly.delayTime); N.lfo2.start();
    // 360° branch: HRTF circular-orbit sub-chain (makeSpatial360) — active
    // only in mode '360'; its master gate is 0 in every other mode, so the
    // dry signal can never double against this StereoPanner path.
    // NOTE: N.output = G(1) ke BAAD wire karo — pehle connect karne se
    // undefined pe connect hota hai (Overload resolution failed) aur pura
    // makeChain/ensureStudio toot jata hai (koi audio load nahi hota).
    N.s360 = makeSpatial360(ctx);

    N.output = G(1);
    N.s360.output.connect(N.output);
    N.input.connect(N.s360.input);
    N.input.connect(N.dry); N.dry.connect(N.output);
    N.input.connect(N.split);
    N.split.connect(N.sumL, 0); N.split.connect(N.sumR, 1);
    N.sumL.connect(N.mono, 0, 0); N.sumR.connect(N.mono, 0, 0);
    N.mono.connect(N.pan); N.pan.connect(N.wet); N.wet.connect(N.output);
    N.rvWet.connect(N.output);
    N.input.connect(N.dly); N.dly.connect(N.dlyWet); N.dlyWet.connect(N.output);

    const st = { mode: 'off', speed: 0.12, depth: 1 };
    // Idle true-bypass for the 360° HRTF branch: mode '360' ke alawa iska
    // input physically disconnected rehta hai. gate=0 se output silent to
    // tha hi, lekin HRTF panner har sample process karta rehta tha (stutter
    // rule: convolver/FX off me bilkul idle hone chahiye). Disconnect
    // SPATIAL_BYPASS_DELAY_MS delayed + gen-guarded hai taaki gate glide
    // (tc 0.3) pehle output ko ~0 pe la sake — jaldi disconnect wet/dry
    // rebalance ko beech-glide me kaat ke click dega.
    let s360Starved = false, s360Gen = 0;
    function setS360Starved(starved) {
      starved = !!starved;
      if (starved === s360Starved) return;
      s360Starved = starved;
      if (starved) { try { N.input.disconnect(N.s360.input); } catch (e) {} }
      else { try { N.input.connect(N.s360.input); } catch (e) {} }
    }
    function targets() {
      const m = SPATIAL_MODES[st.mode] || SPATIAL_MODES.off;
      const k = clamp(st.depth, 0, 1); // depth slider = intensity
      const is360 = st.mode === '360';
      return {
        freq: clamp(st.speed, 0.05, 1),
        depth: m.depth * k,
        // '360' mode: the HRTF branch carries the whole signal (own dry/wet);
        // this StereoPanner path goes fully silent so nothing doubles.
        wet: is360 ? 0 : m.wet * k,
        dry: is360 ? 0 : 1 - m.wet * k,
        rvSend: is360 ? 0 : (m.reverb > 0 ? 1 : 0),
        rvWet: is360 ? 0 : m.reverb * k,
        dlyWet: is360 ? 0 : m.delayWet * k,
        s360: is360,
      };
    }
    // glide: enable/disable dheere (tc 0.3), sliders tez-dezippered (tc 0.03)
    function apply(tc) {
      const tg = targets();
      t(N.lfo.frequency, tg.freq, tc); t(N.lfo2.frequency, tg.freq, tc);
      t(N.depth.gain, tg.depth, tc);
      t(N.wet.gain, tg.wet, tc); t(N.dry.gain, tg.dry, tc);
      t(N.rvSend.gain, tg.rvSend, tc); t(N.rvWet.gain, tg.rvWet, tc);
      t(N.dlyWet.gain, tg.dlyWet, tc);
      // 360° branch tracks the SAME speed/depth controls (existing sliders),
      // gate opens only in '360' mode — everything dezippered, click-free.
      const imm = tc === 0;
      N.s360.setSpeed(tg.freq, imm);
      N.s360.setDepth(st.depth, imm);
      N.s360.setOn(tg.s360, imm);
      // 360° branch input: sirf '360' mode me wired; baaki modes me
      // SPATIAL_BYPASS_DELAY_MS baad physically disconnect (gate glide ke
      // baad, click-free).
      const g360 = ++s360Gen;
      if (tg.s360) setS360Starved(false);
      else setTimeout(() => { if (g360 === s360Gen) setS360Starved(true); }, SPATIAL_BYPASS_DELAY_MS);
    }
    const api = {
      input: N.input, output: N.output, nodes: N,
      // Mode badlo -> us mode ke default speed/depth, glide ke saath.
      // (Preset restore iske baad setSpeed/setDepth call karta hai.)
      // immediate=true: fresh chain (export/offline) — glide nahi, seedha
      // jump, warna render ke pehle ~1s me effect fade-in hota hai.
      setMode(mode, immediate) {
        st.mode = SPATIAL_MODES[mode] ? mode : 'off';
        const m = SPATIAL_MODES[st.mode];
        st.speed = m.speed; st.depth = 1;
        apply(immediate ? 0 : 0.3);
      },
      // Outer true-bypass support: jab makeChain spatial ko bypass karta hai
      // (mode 'off'), iska internal convolver (1.0s IR) silence pe bhi FFT
      // chalata rehta — is edge ko disconnect karne se wo bilkul idle hota hai.
      setConvolverStarved(starved) {
        starved = !!starved;
        if (starved === !!api._convStarved) return;
        api._convStarved = starved;
        if (starved) { try { N.pan.disconnect(N.rvSend); } catch (e) {} }
        else { try { N.pan.connect(N.rvSend); } catch (e) {} }
      },
      setSpeed(hz, immediate) { st.speed = clamp(+hz || 0.12, 0.05, 1); apply(immediate ? 0 : 0.03); },
      setDepth(d, immediate) { st.depth = clamp(+d || 0, 0, 1); apply(immediate ? 0 : 0.03); },
      getSettings() { return { mode: st.mode, speed: +st.speed.toFixed(3), depth: +st.depth.toFixed(3) }; },
      // Test hook: true jab 360° branch ka input physically disconnected hai.
      isS360Starved() { return s360Starved; },
      dispose() {
        s360Gen++; // pending starve timer dead chain ko dobara wire na kare
        try { N.lfo.stop(); } catch (e) {}
        try { N.lfo2.stop(); } catch (e) {}
        try { N.s360.dispose(); } catch (e) {} // HRTF branch LFOs first
        Object.keys(N).forEach((k) => {
          if (k === 's360') return; // API object, not a node (disposed above)
          try { N[k].disconnect(); } catch (e) {}
        });
      },
    };
    apply(0.03);
    return api;
  }

  function driveCurve(amount) {
    // Cache: slider drags call set('drive') per input event — rebuilding the
    // Float32Array every tick is GC churn during playback. Quantize to 1%.
    const key = Math.round(clamp(amount, 0, 1) * 100);
    if (driveCurve._cache && driveCurve._cache.key === key) return driveCurve._cache.curve;
    const n = 256, curve = new Float32Array(n);
    if (key <= 0) {
      // Transparent at 0: pehle tanh(kx)/tanh(k) with k=1 small-signal gain
      // +2.37dB deta tha aur THD add karta tha — default chain hamesha colored thi.
      for (let i = 0; i < n; i++) curve[i] = (i / (n - 1)) * 2 - 1;
    } else {
      const k = 1 + (key / 100) * 5;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);
      }
    }
    driveCurve._cache = { key, curve };
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
    N.filter.Q.value = 0.707; // Butterworth: Q=1 (default) 15.5kHz pe +0.73dB bump deta tha "flat" chain me

    // soft drive
    // Round-6 (W6-verify): oversample '2x'/'4x' Chromium me LINEAR curve pe bhi
    // transparent nahi hai (measured: maxDiff 0.765 @2x, 0.5 @4x, 0 @none) —
    // drive=0 pe chain colored ho jati thi. Anti-aliasing ka koi measured
    // fayda bhi nahi mila (drive=0.5 pe hfRatio same). Isliye hamesha 'none'.
    N.drive = ctx.createWaveShaper(); N.drive.curve = driveCurve(0); N.drive.oversample = 'none';

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

    // compressor + brickwall limiter (safety: stacked EQ boosts of +15dB/band
    // plus wet FX sends can otherwise push peaks past 0dBFS — a soft 4:1
    // limiter still lets overshoot through; 20:1 with zero knee cannot, in
    // steady state). NOTE (measured 2026-10): the DynamicsCompressor alone
    // still overshoots ~+0.7 dB on attack transients and lifts sub-threshold
    // audio +0.85 dB in Chrome, so the safety clipper below is the TRUE
    // ceiling: chain.output can never exceed 0 dBFS, even with outGain at max.
    N.comp = ctx.createDynamicsCompressor();
    N.limiter = ctx.createDynamicsCompressor();
    N.limiter.threshold.value = -1.5; N.limiter.knee.value = 0;
    N.limiter.ratio.value = 20; N.limiter.attack.value = 0.002; N.limiter.release.value = 0.15;

    N.output = G(1);
    N.clip = RM.audio.createSafetyClipper(ctx); // absolute final node

    // 8D/3D/16D/360° spatial: limiter ke BAAD (comp/limiter kaam kar chuke
    // hain, pan ke baad dynamics nahi badalte), output se pehle. Mode 'off'
    // me poora sub-graph bypass hota hai (true bypass, neeche) — sirf dry=1
    // passthrough rakhne se uska convolver (1.0s IR) bekaar me chalta rehta.
    N.spatial = makeSpatial(ctx);
    // (limiter routing yahan nahi — true-bypass block me neeche hoti hai)

    // Static wiring — final topology (documented):
    //   input -> eq3 -> eq10 -> filter -> drive -+-> chorusDry -> comp
    //                                            +-> chorusWet -> comp
    //                                            +-> echoDelay -> echoWet -> comp
    //                                            +-> rvSend -> rvHP -> convolver -> rvWet -> comp
    //   comp -> limiter -> output
    // Echo and reverb are parallel SENDS (never inserts), so toggling them
    // never breaks the dry path.
    // Spatial (8D/3D/16D/360°): limiter -> spatial.input ... spatial.output -> output
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
    // reverb send chain: drive -> rvSend -> rvHP ->[GATE]-> convolver -> rvWet -> comp.
    // GATE (rvHP -> convolver) is connected ON DEMAND by set('reverbOn') —
    // the convolver (~79k taps @44.1k) must not convolve every sample while
    // reverb is OFF (pehle sirf wet gain 0 hota tha, convolver chalta rehta tha).
    N.drive.connect(N.rvSend); N.rvSend.connect(N.rvHP);
    N.convolver.connect(N.rvWet); N.rvWet.connect(N.comp);      // reverb return
    N.comp.connect(N.limiter);
    // NOTE: limiter ka SINGLE outgoing edge hamesha exactly ek jagah jata hai —
    // spatial on  -> limiter -> spatial.input ... spatial.output -> output
    // spatial off -> limiter -> output (direct). Dono ek saath jude to
    // signal DOUBLE (+6dB) ho jayega; setSpatialBypass() isko guard karta hai.
    N.output.connect(N.clip); // clipper is the chain's output: 0 dBFS ceiling

    // ---- true bypass: idle heavy nodes cost ~nothing ----
    // Convolvers are by far the heaviest nodes in the graph. Before this,
    // both convolvers (1.8s main reverb + 1.0s spatial) processed the FULL
    // signal at all times — even with reverb OFF and spatial mode 'off'
    // (only wet gains were zeroed). On budget phones that idle convolution
    // is the #1 stutter source. Now:
    //  - reverb OFF  -> rvHP->convolver edge physically disconnected
    //    (convolver input-less; drive->rvSend->rvHP biquad sirf sasta HP hai)
    //  - spatial 'off' -> limiter->output wired directly, the whole spatial
    //    sub-graph (splitter/merger/pan/2nd convolver/delay/LFOs) skipped
    let reverbBypassed = true;   // matches rvWet = 0 initial
    let spatialBypassed = true;  // matches spatial mode 'off' initial
    let spatialGen = 0;          // guards the delayed off->bypass switch
    N.spatial.output.connect(N.output);
    N.limiter.connect(N.output); // spatial bypassed by default (mode 'off')
    function setSpatialBypass(off) {
      if (off === spatialBypassed) return;
      spatialBypassed = off;
      try { N.limiter.disconnect(); } catch (e) {}
      if (off) { N.limiter.connect(N.output); N.spatial.setConvolverStarved(true); }
      else { N.spatial.setConvolverStarved(false); N.limiter.connect(N.spatial.input); }
    }
    // Default: bypassed + starved (mode 'off')
    N.spatial.setConvolverStarved(true);

    // Round-11: fresh chain (abhi construct hui hai, kuch render/play nahi
    // hua) pe pehla applyPreset/set SEEDHA values lagata hai — glide nahi.
    // Wajah (measured): constructor ka api.set('compOn', true) threshold ko
    // setTargetAtTime(-18, t=0) se glide karta tha; usi t=0 pe applyPreset ka
    // compOff (target 0) ya koi aur preset value glide hota tha. Glide
    // intrinsic default (-24dB) se shuru hota hai, jo compressing territory
    // se guzarta hai -> HAR offline render/export ke pehle ~50-100ms me
    // partial-compression fade-in artifact. Fresh chain pe direct assignment
    // me ye artifact zero hai; live slider changes (fresh=false) ab bhi
    // click-free glide karte hain.
    let fresh = true;
    const t = (param, v, tc) => {
      if (fresh) {
        try { param.cancelScheduledValues(0); } catch (e) {}
        param.value = v;
      } else param.setTargetAtTime(v, ctx.currentTime, tc || 0.015);
    };

    const api = {
      input: N.input, output: N.clip, nodes: N,
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
          case 'reverbOn': {
            const on = !!v;
            // True bypass: OFF pe rvHP->convolver edge disconnect — convolver
            // (~79k taps) input-less rehta hai, idle me full signal convolve
            // nahi karta. Gain glide reverb tail ko click-free band karta hai.
            if (on && reverbBypassed) { N.rvHP.connect(N.convolver); reverbBypassed = false; }
            else if (!on && !reverbBypassed) { try { N.rvHP.disconnect(N.convolver); } catch (e) {} reverbBypassed = true; }
            t(N.rvWet.gain, on ? 0.4 : 0);
            break;
          }
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
          case 'spatialMode': { // string! v (number) nahi
            const m = String(value);
            const gen = ++spatialGen;
            N.spatial.setMode(m, fresh);
            if (m === 'off') {
              // Pehle wet gains glide se ~0 pe (tc 0.3, click-free), phir
              // physical bypass — SPATIAL_BYPASS_DELAY_MS (=4 time constants)
              // ke baad, warna beech-glide disconnect dry/wet rebalance kaat
              // ke click dega. (fresh chain pe setMode immediate tha, isliye
              // yahan koi tail nahi.)
              setTimeout(() => { if (gen === spatialGen) setSpatialBypass(true); }, SPATIAL_BYPASS_DELAY_MS);
            } else setSpatialBypass(false);
            break;
          }
          case 'spatialSpeed': N.spatial.setSpeed(v, fresh); break;
          case 'spatialDepth': N.spatial.setDepth(v, fresh); break;
        }
      },
      applyPreset(p) { // p: {eq3:[b,m,t], eq10:[..], filter, drive, chorus:{on,rate,depth}, echo:{on,time,fb,wet}, reverb:{on,room,wet}, comp:{on,thr,ratio,atk,rel}, out}
        if (!p) return;
        if (p.eq3) { api.set('eqBass', p.eq3[0]); api.set('eqMid', p.eq3[1]); api.set('eqTreble', p.eq3[2]); }
        if (p.eq10) api.set('eq10', p.eq10);
        if (p.filter != null) api.set('filterCutoff', p.filter);
        if (p.drive != null) api.set('drive', p.drive);
        if (p.chorus) { api.set('chorusOn', p.chorus.on); api.set('chorusRate', p.chorus.rate || 1.2); api.set('chorusDepth', p.chorus.depth || 0.004); }
        if (p.echo) {
          api.set('echoOn', p.echo.on);
          api.set('echoTime', p.echo.time || 0.375);
          api.set('echoFeedback', p.echo.fb || 0.35);
          // Round-6 (W6): echoOn(false) ke baad echoWet set karne se OFF toot jata tha —
          // default chain me echo sneak-ON tha (wet 0.35) jabki UI me OFF dikhta tha.
          if (p.echo.on) api.set('echoWet', p.echo.wet != null ? p.echo.wet : 0.35);
        }
        if (p.reverb) {
          api.set('reverbOn', p.reverb.on);
          if (p.reverb.room) api.set('reverbRoom', p.reverb.room);
          // Round-6 (W6): reverbOn(false) ke baad reverbWet set karne se OFF toot jata tha —
          // default chain me hall reverb sneak-ON tha (wet 0.4, +7.45dB RMS) jabki UI OFF tha.
          if (p.reverb.on) api.set('reverbWet', p.reverb.wet != null ? p.reverb.wet : 0.4);
        }
        if (p.comp) {
          api.set('compOn', p.comp.on);
          // Round-6 (W5): compOn(false) ke baad threshold/ratio set karne se
          // bypass toot jata tha (flatFx "bypass" asal me compress karta tha).
          if (p.comp.on !== false) {
            api.set('compThreshold', p.comp.thr != null ? p.comp.thr : -18);
            api.set('compRatio', p.comp.ratio || 4);
            api.set('compAttack', p.comp.atk || 0.01);
            api.set('compRelease', p.comp.rel || 0.2);
          }
        }
        if (p.out != null) api.set('outGain', p.out);
        // 8D/3D/16D: preset me save/restore (plain JSON -> projects/autosave me apne aap)
        if (p.spatial) {
          if (p.spatial.mode) api.set('spatialMode', p.spatial.mode);
          if (p.spatial.speed != null) api.set('spatialSpeed', p.spatial.speed);
          if (p.spatial.depth != null) api.set('spatialDepth', p.spatial.depth);
        }
        fresh = false; // pehla (pre-render) preset lag gaya: ab se live changes glide karenge
      },
      getSpatial() { return N.spatial.getSettings(); },
      getBypass() { return { reverb: reverbBypassed, spatial: spatialBypassed }; },
      dispose() {
        spatialGen++; // pending off->bypass timer dead chain ko dobara wire na kare
        try { N.spatial.dispose(); } catch (e) {} // pehle: iske LFOs stop hon
        try { N.chLFO.stop(); } catch (e) {}
        Object.keys(N).forEach(k => {
          if (k === 'spatial') return; // api object hai, node nahi (upar dispose ho chuka)
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
    N.clip = RM.audio.createSafetyClipper(ctx); // absolute final node: 0 dBFS ceiling
    N.input.connect(N.eqB); N.eqB.connect(N.eqM); N.eqM.connect(N.eqT);
    N.eqT.connect(N.comp); N.comp.connect(N.limiter); N.limiter.connect(N.out);
    N.out.connect(N.clip);
    // Round-11: fresh chain pe pehla apply() seedha values lagata hai (koi
    // glide nahi) — warna har offline render ke shuru me params intrinsic
    // defaults se glide hote (comp threshold -24dB se), jo pehle ~50-100ms
    // me partial-compression fade-in deta hai. Live apply() ab bhi glide karta hai.
    let freshM = true;
    const t = (p, v, tc) => {
      if (freshM) {
        try { p.cancelScheduledValues(0); } catch (e) {}
        p.value = v;
      } else p.setTargetAtTime(v, ctx.currentTime, tc || 0.015);
    };
    const api = {
      input: N.input, output: N.clip,
      apply(st) {
        t(N.eqB.gain, st.eqB || 0); t(N.eqM.gain, st.eqM || 0); t(N.eqT.gain, st.eqT || 0);
        t(N.comp.threshold, st.thr != null ? st.thr : -14);
        t(N.comp.knee, st.knee != null ? st.knee : 8);
        t(N.comp.ratio, st.ratio || 3);
        t(N.comp.attack, st.atk || 0.008);
        t(N.comp.release, st.rel || 0.25);
        t(N.out.gain, st.makeup || 1);
        freshM = false; // pehla (pre-render) apply ho gaya: ab se live changes glide karenge
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

  /* ============ 7-band vocal EQ (v26 I6 — additive, nothing above touched) ==
     RM.fx.eq7 — seven real biquads (RBJ cookbook, buffer- or node-domain):
       Sub (lowshelf 60 Hz) · Bass (peaking 150 Hz) · Low Mid (peaking 400 Hz)
       Mid (peaking 1 kHz) · High Mid (peaking 2.5 kHz) · Treble (highshelf 8 kHz)
       Air (highshelf 14 kHz).
     - eq7.applyToBuffer(buffer, gains): pure buffer-domain render; returns a
       NEW AudioBuffer (input untouched). gains = {sub:db,…} or 7 numbers in
       band order. Bands at |gain| < 0.05 dB are skipped (bit-exact bypass).
     - eq7.makeChain(ctx): live Web Audio chain (input -> 7 biquads -> output)
       with click-free setGains().
     ===================================================================== */
  const EQ7_BANDS = [
    { id: 'sub',     label: 'Sub',      type: 'lowshelf',  freq: 60,    q: 0.7 },
    { id: 'bass',    label: 'Bass',     type: 'peaking',   freq: 150,   q: 1.0 },
    { id: 'lowmid',  label: 'Low Mid',  type: 'peaking',   freq: 400,   q: 1.0 },
    { id: 'mid',     label: 'Mid',      type: 'peaking',   freq: 1000,  q: 1.0 },
    { id: 'highmid', label: 'High Mid', type: 'peaking',   freq: 2500,  q: 1.0 },
    { id: 'treble',  label: 'Treble',   type: 'highshelf', freq: 8000,  q: 0.7 },
    { id: 'air',     label: 'Air',      type: 'highshelf', freq: 14000, q: 0.7 },
  ];

  function eq7Coeffs(bandId, gainDb, sr) {
    let band = null;
    for (let i = 0; i < EQ7_BANDS.length; i++)
      if (EQ7_BANDS[i].id === bandId) { band = EQ7_BANDS[i]; break; }
    if (!band) throw new Error('eq7: unknown band ' + bandId);
    const w0 = 2 * Math.PI * band.freq / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2, alpha;
    if (band.type === 'peaking') {
      alpha = sw / (2 * band.q);
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    } else if (band.type === 'lowshelf') {
      alpha = sw / 2 * Math.sqrt(2);
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
      a0 = (A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
    } else { // highshelf
      alpha = sw / 2 * Math.sqrt(2);
      b0 = A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
      a0 = (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function eq7FilterInPlace(d, c) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      d[i] = y;
    }
  }

  function eq7NormGains(gains) {
    const g = {};
    for (let i = 0; i < EQ7_BANDS.length; i++) {
      const id = EQ7_BANDS[i].id;
      let v = 0;
      if (Array.isArray(gains)) v = +gains[i] || 0;
      else if (gains && typeof gains === 'object') v = +gains[id] || 0;
      g[id] = Math.max(-24, Math.min(24, v));
    }
    return g;
  }

  function eq7Alloc(nCh, len, sr) {
    try {
      if (RM.audio && typeof RM.audio.ensureCtx === 'function') {
        const ctx = RM.audio.ensureCtx();
        if (ctx && typeof ctx.createBuffer === 'function')
          return ctx.createBuffer(nCh, Math.max(1, len), sr);
      }
    } catch (e) { /* fall through to shim */ }
    const chans = [];
    for (let c = 0; c < nCh; c++) chans.push(new Float32Array(Math.max(1, len)));
    return {
      numberOfChannels: nCh, length: Math.max(1, len), sampleRate: sr,
      duration: Math.max(1, len) / sr,
      getChannelData: function (c) { return chans[c]; },
    };
  }

  function applyEq7ToBuffer(buffer, gains) {
    if (!buffer || typeof buffer.getChannelData !== 'function')
      throw new Error('eq7.applyToBuffer needs an audio buffer.');
    const g = eq7NormGains(gains);
    const sr = buffer.sampleRate, nCh = buffer.numberOfChannels;
    const out = eq7Alloc(nCh, buffer.length, sr);
    const active = [];
    for (let i = 0; i < EQ7_BANDS.length; i++) {
      const id = EQ7_BANDS[i].id;
      if (Math.abs(g[id]) >= 0.05) active.push({ id: id, c: eq7Coeffs(id, g[id], sr) });
    }
    for (let ch = 0; ch < nCh; ch++) {
      const d = out.getChannelData(ch);
      d.set(buffer.getChannelData(ch).subarray(0, d.length));
      for (let k = 0; k < active.length; k++) eq7FilterInPlace(d, active[k].c);
    }
    return out;
  }

  // Live Web Audio 7-band chain: input -> 7 Biquads -> output.
  function makeEq7Chain(ctx, gains) {
    const g0 = eq7NormGains(gains);
    const input = ctx.createGain(), output = ctx.createGain();
    const nodes = EQ7_BANDS.map(function (b) {
      const f = ctx.createBiquadFilter();
      f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q;
      f.gain.value = g0[b.id];
      return f;
    });
    input.connect(nodes[0]);
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(output);
    return {
      input: input, output: output, bands: nodes,
      setGains: function (g, tc) {
        const gg = eq7NormGains(g), t = tc || 0.03, now = ctx.currentTime;
        for (let i = 0; i < nodes.length; i++)
          nodes[i].gain.setTargetAtTime(gg[EQ7_BANDS[i].id], now, t);
      },
      dispose: function () {
        try { input.disconnect(); } catch (e) {}
        nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
        try { output.disconnect(); } catch (e) {}
      },
    };
  }

  const EQ7 = {
    BANDS: EQ7_BANDS,
    coeffs: eq7Coeffs,
    applyToBuffer: applyEq7ToBuffer,
    makeChain: makeEq7Chain,
  };

  return { makeChain, makeMasterChain, makeSpatial, makeSpatial360, SPATIAL_MODES, REVERB_ROOMS, EQ_PRESETS, EQ10_FREQS, MASTER_PRESETS, eq7: EQ7 };
})();
