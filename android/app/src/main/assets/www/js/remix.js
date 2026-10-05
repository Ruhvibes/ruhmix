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
  const PITCH_NOTE = 'Note: speed badalne se pitch bhi badalti hai — tempo aur pitch linked hain (v1).';

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
            comp: { on: true, thr: -14, ratio: 2.5, atk: 0.015, rel: 0.35 }, out: 1.0 } },
    { id: 'slowed', name: 'Slowed+Reverb',
      tag: 'Deep & dreamy',
      rate: 0.80,
      fx: { eq3: [4, 1, -2], filter: 12000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: true, room: 'church', wet: 0.55 },
            comp: { on: true, thr: -14, ratio: 3, atk: 0.01, rel: 0.3 }, out: 1.0 },
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
            comp: { on: true, thr: -18, ratio: 5, atk: 0.004, rel: 0.18 }, out: 1.1 } },
    { id: 'trap', name: 'Trap',
      tag: 'Heavy 808 feel',
      rate: 0.96,
      fx: { eq3: [7, 1, 1], filter: 18000, drive: 0.15,
            chorus: { on: false }, echo: { on: true, time: 0.33, fb: 0.4, wet: 0.28 },
            reverb: { on: true, room: 'room', wet: 0.25 },
            comp: { on: true, thr: -16, ratio: 4, atk: 0.005, rel: 0.2 }, out: 1.05 } },
    { id: 'synthwave', name: 'Synthwave',
      tag: 'Retro neon',
      rate: 1.00,
      fx: { eq3: [1, 3, 2], filter: 19000, drive: 0.08,
            chorus: { on: true, rate: 1.4, depth: 0.005 },
            echo: { on: true, time: 0.375, fb: 0.38, wet: 0.32 },
            reverb: { on: true, room: 'hall', wet: 0.35 },
            comp: { on: true, thr: -15, ratio: 3.5, atk: 0.008, rel: 0.22 }, out: 1.05 } },
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
      fx: { eq3: [-2, 4, 3], filter: 19000, drive: 0,
            chorus: { on: false }, echo: { on: false },
            reverb: { on: true, room: 'room', wet: 0.2 },
            comp: { on: true, thr: -16, ratio: 4, atk: 0.005, rel: 0.18 }, out: 1.05 },
      note: 'Presence EQ se vocal aage aata hai. Stronger separation ke liye Stems me "Vocal Cut (DSP)" dekhein.' },
    { id: 'custom', name: 'Custom',
      tag: 'Apne haath se',
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

  return { STYLES, get, applyStyle, PITCH_NOTE };
})();
