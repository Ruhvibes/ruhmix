'use strict';
/* =====================================================================
   RuhMix — waveform.js
   Canvas waveform renderer: precomputed peaks (chunked, cached),
   zoom + scroll, playhead, trim region, markers. Redraws are throttled
   and cheap — peaks are computed once per buffer.
   ===================================================================== */
window.RM = window.RM || {};

RM.wave = (function () {
  const clamp = RM.audio.clamp;

  // peaksCache: WeakMap<AudioBuffer, Float32Array>
  const peaksCache = new WeakMap();

  function getPeaks(buffer, cols, onProgress) {
    const cached = peaksCache.get(buffer);
    if (cached && cached.length >= cols) return Promise.resolve(cached);
    return RM.audio.computePeaks(buffer, cols || 1200, onProgress).then((peaks) => {
      peaksCache.set(buffer, peaks);
      return peaks;
    });
  }
  function dropPeaks(buffer) { try { peaksCache.delete(buffer); } catch (e) {} }

  // View state per canvas instance
  function createView(canvas) {
    const view = {
      canvas, ctx2d: canvas.getContext('2d'),
      buffer: null, peaks: new Float32Array(0),
      zoom: 1,            // 1 = whole buffer fits
      scroll: 0,          // 0..1 fraction of (zoomedLen - viewLen)
      playheadSec: -1,
      trim: null,         // {a, b} seconds — shaded region
      markers: [],        // [{t, label, color}]
      onSeek: null,       // fn(seconds)
      _raf: 0, _dirty: true,
    };

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(50, Math.floor(r.width * dpr));
      const h = Math.max(40, Math.floor(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    view.setBuffer = (buffer, peaks) => {
      view.buffer = buffer;
      view.peaks = peaks || new Float32Array(0);
      view.zoom = 1; view.scroll = 0; view.playheadSec = -1;
      view.trim = null; view.markers = [];
      view._dirty = true;
    };

    // Visible window in seconds
    view.window = () => {
      if (!view.buffer) return { a: 0, b: 0 };
      const dur = view.buffer.duration;
      const winLen = dur / view.zoom;
      const maxScroll = Math.max(0, dur - winLen);
      const a = clamp(view.scroll, 0, 1) * maxScroll;
      return { a, b: a + winLen };
    };

    view.setZoom = (z) => { view.zoom = clamp(z, 1, 64); view._dirty = true; };
    view.setScroll = (s) => { view.scroll = clamp(s, 0, 1); view._dirty = true; };
    view.setPlayhead = (sec) => { view.playheadSec = sec; view._dirty = true; };
    view.setTrim = (a, b) => { view.trim = (a != null && b != null) ? { a, b } : null; view._dirty = true; };
    view.setMarkers = (m) => { view.markers = m || []; view._dirty = true; };

    view.draw = () => {
      resize();
      const g = view.ctx2d, W = canvas.width, H = canvas.height;
      g.clearRect(0, 0, W, H);
      // background
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#101426'); bg.addColorStop(1, '#0a0d1a');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      if (!view.buffer || !view.peaks.length) {
        g.fillStyle = '#5b6b8c'; g.font = `${Math.max(11, H * 0.16)}px sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('Load audio', W / 2, H / 2);
        return;
      }
      const { a: wA, b: wB } = view.window();
      const dur = view.buffer.duration;
      const n = view.peaks.length;
      const colW = W / n;
      // trim shade
      if (view.trim) {
        const x1 = ((view.trim.a - wA) / (wB - wA)) * W;
        const x2 = ((view.trim.b - wA) / (wB - wA)) * W;
        g.fillStyle = 'rgba(41,182,246,0.14)';
        g.fillRect(Math.max(0, x1), 0, Math.min(W, x2) - Math.max(0, x1), H);
      }
      // peaks — only draw columns inside the window
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#29b6f6'); grad.addColorStop(0.5, '#7c5cff'); grad.addColorStop(1, '#b537f2');
      g.fillStyle = grad;
      const c0 = Math.max(0, Math.floor((wA / dur) * n));
      const c1 = Math.min(n - 1, Math.ceil((wB / dur) * n));
      for (let c = c0; c <= c1; c++) {
        const tC = ((c + 0.5) / n) * dur;
        const x = ((tC - wA) / (wB - wA)) * W;
        const h = Math.max(1, view.peaks[c] * H * 0.94);
        const bw = Math.max(1, (W / (c1 - c0 + 1)) * 0.7);
        g.fillRect(x - bw / 2, (H - h) / 2, bw, h);
      }
      // markers (v27: style:'uncertain' markers render dashed + dim —
      // the downbeat estimate was not confident, never fake it solid)
      view.markers.forEach((m) => {
        if (m.t < wA || m.t > wB) return;
        const x = ((m.t - wA) / (wB - wA)) * W;
        if (m.style === 'uncertain') {
          g.save();
          g.globalAlpha = 0.55;
          g.strokeStyle = m.color || '#c98f4e';
          g.lineWidth = 2;
          g.setLineDash([5, 4]);
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H * 0.28); g.stroke();
          g.restore();
        } else {
          g.fillStyle = m.color || '#ffd54a';
          g.fillRect(x - 1, 0, 2, H * 0.28);
        }
      });
      // playhead
      if (view.playheadSec >= 0 && view.playheadSec >= wA && view.playheadSec <= wB) {
        const x = ((view.playheadSec - wA) / (wB - wA)) * W;
        g.fillStyle = '#ff4d6d';
        g.fillRect(x - 1, 0, 2.5, H);
      }
      view._dirty = false;
    };

    view.invalidate = () => { view._dirty = true; };

    // click / tap -> seek
    canvas.addEventListener('pointerdown', (e) => {
      if (!view.buffer || !view.onSeek) return;
      const r = canvas.getBoundingClientRect();
      const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
      const { a: wA, b: wB } = view.window();
      view.onSeek(wA + fx * (wB - wA));
    });

    return view;
  }

  return { createView, getPeaks, dropPeaks };
})();
