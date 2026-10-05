'use strict';
/* =====================================================================
   RuhMix — remix.js
   Auto Remix: BPM detection + 11 style presets. Each style is an honest
   DSP recipe — an FX-chain preset plus arrangement params (tempo shift,
   etc.). No neural-network claims: styles are curated DSP chains.
   "Generate" (wired in app.js) = detect BPM -> apply style -> preview.
   ===================================================================== */
window.RM = window.RM || {};

RM.remix = (function () {
  // rate: playbackRate multiplier. HONEST NOTE used in UI: slowing down also
  // lowers pitch — tempo and pitch are linked in Web Audio (no independent
  // pitch-shift in v1).
  const PITCH_NOTE = 'Pitch changes with tempo (independent pitch-shift is not in v1).';

  const STYLES = [
    { id: 'commercial', name: 'Commercial',
      tag: 'Radio-ready polish',
      rate: 1.00,
      fx: { eq3: [-1, 1, 4], filter: 19000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: true, room: 'hall', wet: 0.22 },
            comp: { on: true, thr: -16, ratio: 4, atk: 0.006, rel: 0.2 }, out: 1.05 } },
    { id: 'lofi', name: 'Lofi',
      tag: 'Dusty & warm',
      rate: 0.92,
      fx: { eq3: [2, 1, -6], filter: 4200, drive: 0.25,
            chorus: { on: false }, echo: { on: true, time: 0.42, fb: 0.35, wet: 0.25 },
            reverb: { on: true, room: 'room', wet: 0.3 },
            comp: { on: true, thr: -14, ratio: 2.5, atk: 0.015, rel: 0.35 }, out: 0.81 } },
    { id: 'slowed', name: 'Slowed+Reverb',
      tag: 'Deep & dreamy',
      rate: 0.80,
      fx: { eq3: [4, 1, -2], filter: 12000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: true, room: 'church', wet: 0.55 },
            comp: { on: true, thr: -14, ratio: 3, atk: 0.01, rel: 0.3 }, out: 0.92 },
      note: PITCH_NOTE },
    { id: 'emotional', name: 'Emotional',
      tag: 'Soft & heartfelt',
      rate: 0.90,
      fx: { eq3: [2, 2, -1], filter: 16000, drive: 0,
            chorus: { on: false }, echo: { on: true, time: 0.5, fb: 0.3, wet: 0.18 },
            reverb: { on: true, room: 'hall', wet: 0.45 },
            comp: { on: true, thr: -12, ratio: 2.5, atk: 0.012, rel: 0.35 }, out: 1.0 },
      note: PITCH_NOTE },
    { id: 'edm', name: 'EDM',
      tag: 'Big & energetic',
      rate: 1.04,
      fx: { eq3: [3, 0, 4], filter: 19000, drive: 0.12,
            chorus: { on: false }, echo: { on: true, time: 0.28, fb: 0.35, wet: 0.3 },
            reverb: { on: true, room: 'hall', wet: 0.3 },
            comp: { on: true, thr: -18, ratio: 5, atk: 0.004, rel: 0.18 }, out: 0.96 } },
    { id: 'trap', name: 'Trap',
      tag: 'Heavy 808 feel',
      rate: 0.96,
      fx: { eq3: [7, 1, 1], filter: 18000, drive: 0.15,
            chorus: { on: false }, echo: { on: true, time: 0.33, fb: 0.4, wet: 0.28 },
            reverb: { on: true, room: 'room', wet: 0.25 },
            comp: { on: true, thr: -16, ratio: 4, atk: 0.005, rel: 0.2 }, out: 0.90 } },
    { id: 'synthwave', name: 'Synthwave',
      tag: 'Retro neon',
      rate: 1.00,
      fx: { eq3: [1, 3, 2], filter: 19000, drive: 0.08,
            chorus: { on: true, rate: 1.4, depth: 0.005 },
            echo: { on: true, time: 0.375, fb: 0.38, wet: 0.32 },
            reverb: { on: true, room: 'hall', wet: 0.35 },
            comp: { on: true, thr: -15, ratio: 3.5, atk: 0.008, rel: 0.22 }, out: 0.92 } },
    { id: 'acoustic', name: 'Acoustic',
      tag: 'Natural & clean',
      rate: 1.00,
      fx: { eq3: [0, 1, 1], filter: 19000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: true, room: 'room', wet: 0.25 },
            comp: { on: true, thr: -12, ratio: 2, atk: 0.015, rel: 0.4 }, out: 1.0 } },
    { id: 'sufi', name: 'Sufi',
      tag: 'Soulful & spacious',
      rate: 0.95,
      fx: { eq3: [3, 2, -1], filter: 15000, drive: 0,
            chorus: { on: false }, echo: { on: true, time: 0.55, fb: 0.32, wet: 0.22 },
            reverb: { on: true, room: 'church', wet: 0.5 },
            comp: { on: true, thr: -13, ratio: 2.5, atk: 0.012, rel: 0.35 }, out: 1.0 },
      note: PITCH_NOTE },
    { id: 'vocalfocus', name: 'Vocal Focus',
      tag: 'Voice forward',
      rate: 1.00,
      // MEASURED 2026-10 (signal-level): eq3 [-2,4,3] + out 1.05 drove hot
      // sustained tones into the chain limiter -> -21dB THD (eq flat: -80dB).
      // [-2,3,2] still tickled it (-26dB); [-2,2,2] + out 1.0 sits safely
      // below the limiter knee -> -59dB THD, inaudible, while keeping a
      // clear vocal-forward tilt (-2 bass / +2 presence+air).
      fx: { eq3: [-2, 2, 2], filter: 19000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: true, room: 'room', wet: 0.2 },
            comp: { on: true, thr: -16, ratio: 4, atk: 0.005, rel: 0.18 }, out: 1.0 },
      note: 'Presence EQ brings vocals forward. For stronger separation, try "Vocal Cut (DSP)" in Stems.' },
    { id: 'custom', name: 'Custom',
      tag: 'Manual',
      rate: 1.00, custom: true,
      fx: { eq3: [0, 0, 0], filter: 19000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: false, room: 'hall', wet: 0.3 },
            comp: { on: true, thr: -14, ratio: 3, atk: 0.01, rel: 0.25 }, out: 1.0 } },
  ];

  function get(id) { return STYLES.find((s) => s.id === id) || STYLES[0]; }

  // Applies a style to a live chain + player. Returns a summary for the UI.
  function applyStyle(id, chain, player, customFx) {
    const s = get(id);
    const fx = (id === 'custom' && customFx) ? customFx : s.fx;
    if (chain) chain.applyPreset(fx);
    if (player) player.setRate(s.rate);
    return {
      id: s.id, name: s.name, tag: s.tag,
      rate: s.rate, note: s.note || null,
    };
  }

  /* =====================================================================
     Stem-based Auto Remix pipeline (Part 2).
     Used ONLY when a 4-role stem pack is available (RM.stems.packAvailable()):
       Analyze (BPM/beat, existing detector) -> 4 stems as separate tracks
       -> BPM/beat sync (style rate + echo synced to beat) -> Arrange
       (intro/build/outro sections) -> per-stem FX (vocal: reverb, drums:
       compression, bass: low-boost — style-aware) -> Transitions
       (crossfades at section boundaries) -> Mix -> Master -> Preview.
     Without a stem pack the classic single-track preset flow above is used
     unchanged (no regression).
     ===================================================================== */
  const stemPipeline = (function () {
    const MASTER_BY_STYLE = { edm: 'loud', trap: 'loud', lofi: 'lofi', acoustic: 'clean' };

    // Per-role FX: base FX chain + role overrides. Unknown/band roles get the
    // pure style chain. baseFx is the style's fx, or the user's custom fx for
    // the 'custom' style (opts.customFx) so Custom sliders apply in stem mode.
    function roleFx(baseFx, role, bpm) {
      const fx = JSON.parse(JSON.stringify(baseFx));
      const beat = 60 / (bpm || 120);
      if (fx.echo.on) fx.echo.time = +(beat * 0.75).toFixed(3); // beat-synced echo
      if (role === 'vocal') {
        fx.reverb.on = true;
        fx.reverb.wet = Math.min(0.85, (fx.reverb.wet || 0.3) + 0.18);
        fx.eq3 = [fx.eq3[0] - 1, fx.eq3[1] + 2, fx.eq3[2] + 1]; // presence lift
      } else if (role === 'drums') {
        fx.comp.on = true;
        fx.comp.thr = Math.min(fx.comp.thr, -14);
        fx.comp.ratio = Math.max(fx.comp.ratio, 4);
        fx.reverb.wet = Math.max(0, (fx.reverb.wet || 0) - 0.12); // drums stay dry-ish
      } else if (role === 'bass') {
        fx.eq3 = [fx.eq3[0] + 4, fx.eq3[1], fx.eq3[2] - 1];
        fx.reverb.on = false; fx.echo.on = false; // keep low end tight
      }
      return fx;
    }

    // Arrangement: per-role section gains [intro, main, outro].
    function arrangeGains(role) {
      if (role === 'vocal') return [0.55, 1.0, 0.45];
      if (role === 'drums') return [0.35, 1.0, 0.55];
      if (role === 'bass')  return [0.75, 1.0, 0.65];
      return [0.7, 1.0, 0.6]; // 'other' + band roles
    }

    // styleId + pack -> Promise<{buffer, bpm, rate, styleId, styleName}>.
    // onProgress(labelHi, frac).
    function generate(styleId, pack, opts, onProgress) {
      opts = opts || {};
      const style = get(styleId);
      const roles = (pack && pack.roles ? pack.roles : []).filter((r) => r && r.buffer);
      if (roles.length < 2) return Promise.reject(new Error('At least 2 stems are needed — the pack is incomplete.'));
      const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OC) return Promise.reject(new Error('OfflineAudioContext not supported.'));
      const prog = (label, frac) => { try { if (onProgress) onProgress(label, frac); } catch (e) {} };
      prog('Detecting BPM…', 0.02);

      const sr = roles[0].buffer.sampleRate;
      // resample roles to a common sample rate if needed
      const prep = roles.map((r) => {
        if (r.buffer.sampleRate === sr) return Promise.resolve(r.buffer);
        return RM.audio.resampleBuffer(r.buffer, sr);
      });
      return Promise.all(prep).then((bufs) => {
        const rb = roles.map((r, i) => ({ role: r.role, label: r.label, buffer: bufs[i] }));
        const bpmP = opts.bpm ? Promise.resolve(opts.bpm)
          : RM.audio.detectBPM(rb[0].buffer, (p) => prog('Detecting BPM…', 0.02 + p * 0.12));
        return bpmP.then((bpm) => {
          prog('Preparing stems…', 0.16);
          const rate = (styleId === 'custom' && opts.customTempo) ? opts.customTempo : style.rate;
          // Custom style: honour the user's Custom-slider FX in stem mode too
          // (app.js passes opts.customFx; falls back to the flat default).
          const baseFx = (styleId === 'custom' && opts.customFx) ? opts.customFx : style.fx;
          const beat = 60 / bpm;
          const maxDur = Math.max.apply(null, rb.map((r) => r.buffer.duration));
          const D = maxDur / rate; // musical duration at style rate
          const tail = 2.5; // reverb tail
          const oc = new OC(2, Math.max(1, Math.ceil((D + tail) * sr)), sr);
          const mixBus = oc.createGain();
          const master = RM.fx.makeMasterChain(oc, RM.fx.MASTER_PRESETS[MASTER_BY_STYLE[styleId] || 'clean']);
          mixBus.connect(master.input);
          master.output.connect(oc.destination);

          // arrangement sections (fractions of D) + transition crossfades
          const secs = [[0, 0.25 * D], [0.25 * D, 0.8 * D], [0.8 * D, D]];
          const xf = Math.min(2 * beat, 0.08 * D);
          const chains = [];
          rb.forEach((r, ri) => {
            prog('Preparing stems…', 0.16 + 0.10 * (ri / rb.length));
            const src = oc.createBufferSource();
            src.buffer = r.buffer;
            src.playbackRate.value = rate; // BPM/beat sync via style rate
            const chain = RM.fx.makeChain(oc);
            chain.applyPreset(roleFx(baseFx, r.role, bpm));
            chains.push(chain);
            const g = oc.createGain(); // arrangement gain
            const lv = arrangeGains(r.role);
            g.gain.setValueAtTime(Math.max(0.0001, lv[0]), 0);
            for (let si = 1; si < 3; si++) {
              const t = secs[si][0];
              g.gain.setValueAtTime(Math.max(0.0001, lv[si - 1]), Math.max(0, t - xf));
              g.gain.linearRampToValueAtTime(Math.max(0.0001, lv[si]), t); // transition
            }
            // Outro fade: must start at/after the last section event
            // (t = 0.8*D = secs[2][0]); scheduling it earlier throws
            // InvalidStateError on short mixes (D < 15s).
            const outT = Math.max(secs[2][0], D - 3);
            g.gain.setValueAtTime(Math.max(0.0001, lv[2]), outT);
            g.gain.linearRampToValueAtTime(0.0001, D); // outro fade
            src.connect(g);
            g.connect(chain.input);
            chain.output.connect(mixBus);
            src.start(0);
          });
          prog('Mixing…', 0.30);
          return oc.startRendering().then((rendered) => {
            prog('Mastering…', 0.95);
            chains.forEach((c) => { try { c.dispose(); } catch (e) {} });
            try { master.dispose(); } catch (e) {}
            prog('Done ✓', 1);
            return { buffer: rendered, bpm, rate, styleId: style.id, styleName: style.name };
          });
        });
      });
    }

    // One-shot preview player for the stem mix (separate from studio player).
    let previewPlayer = null;
    function preview(buffer) {
      stopPreview();
      RM.audio.ensureCtx();
      previewPlayer = RM.audio.makePlayer();
      previewPlayer.load(buffer);
      previewPlayer.play(0);
    }
    function stopPreview() {
      if (previewPlayer) {
        try { previewPlayer.stop(true); previewPlayer.dispose(); } catch (e) {}
        previewPlayer = null;
      }
    }
    function isPreviewing() { return !!(previewPlayer && previewPlayer.playing); }

    return { generate, preview, stopPreview, isPreviewing };
  })();

  return { STYLES, get, applyStyle, PITCH_NOTE, stemPipeline };
})();
