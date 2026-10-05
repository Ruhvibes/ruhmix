'use strict';
/* =====================================================================
   RuhMix — stems.js
   Algorithmic (DSP) stem extraction — BETA, experimental.
   *** NO neural-network claims anywhere: these are classical
   *** signal-processing methods. Every engine card in the UI carries an
   *** honest note that bleed/crosstalk is expected.

   Engines (final names):
     1. "Vocal Cut (DSP)"      — center-channel cancellation (proven).
        Produces: Center (Vocal-ish) + Sides (Instrumental).
     2. "Drum Extract (HPSS)"  — real harmonic-percussive source
        separation: STFT + median filtering along time/frequency axes +
        soft masks. Produces: Drums (Percussive) + Harmonic (Rest).
     3. "Bass Focus"           — low-passed bass band. Produces:
        Bass (<200 Hz) + Upper (>200 Hz).
     4. "Stem Split (Spectral)"— 4-way frequency-band split via parallel
        biquad chains (OfflineAudioContext). Produces: Bass / Low-Mid /
        Presence / Air. NOTE: frequency bands, NOT true instrument isolation.

   All heavy work is chunked/segmented; temp buffers are freed between
   stages. run(engineId, buffer, onProgress) -> Promise<[{name, buffer}]>.
   ===================================================================== */
window.RM = window.RM || {};

RM.stems = (function () {
  const clamp = RM.audio.clamp;
  const HONEST = 'Experimental DSP-based separation — some bleed is possible (no neural network).';

  const ENGINES = [
    { id: 'vocalcut', name: 'Vocal Cut (DSP)',
      desc: 'Center-channel cancellation — separates the center (vocals) from the sides (instrumental).',
      note: HONEST },
    { id: 'hpss', name: 'Drum Extract (HPSS)',
      desc: 'Harmonic-percussive separation — separates transients (drums) from the tonal part.',
      note: HONEST + ' Processing may take some time.' },
    { id: 'bass', name: 'Bass Focus',
      desc: 'Low-passed bass band extraction.',
      note: HONEST },
    { id: 'spectral', name: 'Stem Split (Spectral)',
      desc: '4-way frequency-band split.',
      note: 'These are frequency bands — not true instrument isolation. Experimental DSP.' },
  ];

  /* ================= FFT (iterative radix-2, in-place) ================= */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const vr = re[b] * cwr - im[b] * cwi;
          const vi = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = nwr;
        }
      }
    }
  }
  function ifft(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }
  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
    return w;
  }

  function stft(x, N, hop, win) {
    const frames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
    const bins = N / 2 + 1;
    const reS = new Float32Array(frames * bins);
    const imS = new Float32Array(frames * bins);
    const mag = new Float32Array(frames * bins);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let n = 0; n < N; n++) { re[n] = (off + n < x.length ? x[off + n] : 0) * win[n]; im[n] = 0; }
      fft(re, im);
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        const a = re[b], c = im[b];
        reS[base + b] = a; imS[base + b] = c;
        mag[base + b] = Math.sqrt(a * a + c * c);
      }
    }
    return { reS, imS, mag, frames, bins };
  }

  function istft(reS, imS, frames, bins, N, hop, outLen, win) {
    const out = new Float32Array(outLen);
    const wsum = new Float32Array(outLen);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let f = 0; f < frames; f++) {
      const base = f * bins;
      for (let b = 0; b < bins; b++) { re[b] = reS[base + b]; im[b] = imS[base + b]; }
      for (let b = bins; b < N; b++) { re[b] = re[N - b]; im[b] = -im[N - b]; } // hermitian
      ifft(re, im);
      const off = f * hop;
      const lim = Math.min(N, outLen - off);
      for (let n = 0; n < lim; n++) {
        out[off + n] += re[n] * win[n];
        wsum[off + n] += win[n];
      }
    }
    for (let i = 0; i < outLen; i++) out[i] /= (wsum[i] > 1e-8 ? wsum[i] : 1);
    return out;
  }

  function medianOfSorted(tmp, n) {
    const s = tmp.subarray(0, n).sort();
    const m = n >> 1;
    return (n & 1) ? s[m] : (s[m - 1] + s[m]) * 0.5;
  }
  // Median filter along the TIME axis (enhances harmonic/tonal content)
  function medfiltTime(mag, frames, bins, winSize) {
    const out = new Float32Array(mag.length);
    const half = winSize >> 1;
    const tmp = new Float32Array(winSize);
    for (let b = 0; b < bins; b++) {
      for (let f = 0; f < frames; f++) {
        let n = 0;
        for (let k = -half; k <= half; k++) {
          const ff = f + k < 0 ? 0 : (f + k >= frames ? frames - 1 : f + k);
          tmp[n++] = mag[ff * bins + b];
        }
        out[f * bins + b] = medianOfSorted(tmp, n);
      }
    }
    return out;
  }
  // Median filter along the FREQUENCY axis (enhances percussive content)
  function medfiltFreq(mag, frames, bins, winSize) {
    const out = new Float32Array(mag.length);
    const half = winSize >> 1;
    const tmp = new Float32Array(winSize);
    for (let f = 0; f < frames; f++) {
      const base = f * bins;
      for (let b = 0; b < bins; b++) {
        let n = 0;
        for (let k = -half; k <= half; k++) {
          const bb = b + k < 0 ? 0 : (b + k >= bins ? bins - 1 : b + k);
          tmp[n++] = mag[base + bb];
        }
        out[base + b] = medianOfSorted(tmp, n);
      }
    }
    return out;
  }

  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  /* ================= engine: Vocal Cut (DSP) ================= */
  // center = (L+R)/2 ; sides = L-center, R-center. Chunked sample math.
  function vocalCut(buffer, onProgress) {
    const len = buffer.length;
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const ctx = RM.audio.ensureCtx();
    const center = ctx.createBuffer(2, len, buffer.sampleRate);
    const sides = ctx.createBuffer(2, len, buffer.sampleRate);
    const cL = center.getChannelData(0), cR = center.getChannelData(1);
    const sL = sides.getChannelData(0), sR = sides.getChannelData(1);
    return RM.audio.runChunked(len, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        const c = (ch0[i] + ch1[i]) * 0.5;
        cL[i] = c; cR[i] = c;
        sL[i] = ch0[i] - c; sR[i] = ch1[i] - c;
      }
    }, onProgress).then(() => [
      { name: 'Center (Vocal-ish)', buffer: center },
      { name: 'Sides (Instrumental)', buffer: sides },
    ]);
  }

  // HPSS masks in small batches with UI yields between them, so one 30 s
  // segment never blocks the main thread for a full second on a phone.
  async function hpssMasks(mag, frames, bins, reS, imS) {
    const H = new Float32Array(mag.length);
    const P = new Float32Array(mag.length);
    const tmp = new Float32Array(13);
    const HW = 6; // median window 13
    for (let b0 = 0; b0 < bins; b0 += 64) {
      const b1 = Math.min(bins, b0 + 64);
      for (let b = b0; b < b1; b++) {
        for (let f = 0; f < frames; f++) {
          let n = 0;
          for (let k = -HW; k <= HW; k++) {
            const ff = f + k < 0 ? 0 : (f + k >= frames ? frames - 1 : f + k);
            tmp[n++] = mag[ff * bins + b];
          }
          H[f * bins + b] = medianOfSorted(tmp, n);
        }
      }
      await yieldUI();
    }
    for (let f0 = 0; f0 < frames; f0 += 32) {
      const f1 = Math.min(frames, f0 + 32);
      for (let f = f0; f < f1; f++) {
        const base = f * bins;
        for (let b = 0; b < bins; b++) {
          let n = 0;
          for (let k = -HW; k <= HW; k++) {
            const bb = b + k < 0 ? 0 : (b + k >= bins ? bins - 1 : b + k);
            tmp[n++] = mag[base + bb];
          }
          P[base + b] = medianOfSorted(tmp, n);
        }
      }
      await yieldUI();
    }
    for (let i0 = 0; i0 < mag.length; i0 += (1 << 18)) {
      const i1 = Math.min(mag.length, i0 + (1 << 18));
      for (let i = i0; i < i1; i++) {
        const h = H[i], p = P[i];
        const mP = (p * p) / (h * h + p * p + 1e-10);
        reS[i] *= mP; imS[i] *= mP;
      }
      await yieldUI();
    }
  }

  /* ================= engine: Drum Extract (HPSS) ================= */
  // Genuine harmonic-percussive separation on a 22050 Hz mono downmix,
  // processed in 30 s segments to bound memory. Returns stereo stems.
  function hpss(buffer, onProgress) {
    const sr = buffer.sampleRate;
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const ctx = RM.audio.ensureCtx();
    const N = 2048, HOP = 512, WIN = hannWindow(N);
    const ANA_SR = 22050;
    // 1) mono downmix + resample to 22050 (chunked)
    // Anti-alias: 22050Hz downsample se pehle ~10kHz one-pole LP — bina iske
    // 12-20kHz content 2-10kHz me fold hota hai (phantom tones, mask corrupt).
    // NOTE: lpY chunk boundaries pe reset NAHI hota (warna phantom spikes).
    const mono = ctx.createBuffer(1, buffer.length, sr);
    const md = mono.getChannelData(0);
    let lpY = 0;
    const lpA = 1 - Math.exp(-2 * Math.PI * 10000 / sr);
    return RM.audio.runChunked(buffer.length, 1 << 18, (a, b) => {
      for (let i = a; i < b; i++) {
        const m = (ch0[i] + ch1[i]) * 0.5;
        lpY += lpA * (m - lpY);
        md[i] = lpY;
      }
    }, onProgress ? (p) => onProgress(p * 0.08, 'Downmix…') : null)
    .then(() => RM.audio.resampleBuffer(mono, ANA_SR))
    .then((low) => {
      const x = low.getChannelData(0);
      const segLen = Math.floor(ANA_SR * 30);
      const nSeg = Math.max(1, Math.ceil(x.length / segLen));
      const perc = new Float32Array(x.length);
      const harm = new Float32Array(x.length);
      // 50 ms overlap between consecutive segments: the join gets a linear
      // crossfade instead of a hard cut, so no click/pop at 30 s boundaries.
      const XF = Math.floor(ANA_SR * 0.05);
      let done = 0;
      const stepSeg = async () => {
        if (done >= nSeg) {
          // resample back to original rate, stereo-ize
          const mk = (data) => {
            const m = ctx.createBuffer(1, data.length, ANA_SR);
            m.getChannelData(0).set(data);
            return RM.audio.resampleBuffer(m, sr).then((rs) => {
              const st = ctx.createBuffer(2, rs.length, sr);
              const rd = rs.getChannelData(0);
              st.getChannelData(0).set(rd); st.getChannelData(1).set(rd);
              return st;
            });
          };
          if (onProgress) onProgress(0.92, 'Finalize…');
          const pBuf = await mk(perc);
          const hBuf = await mk(harm);
          return [
            { name: 'Drums (Percussive)', buffer: pBuf },
            { name: 'Harmonic (Rest)', buffer: hBuf },
          ];
        }
        const s0 = done * segLen;
        const s1 = Math.min(x.length, s0 + segLen);
        const ext0 = done > 0 ? s0 - XF : s0; // overlap previous tail
        const seg = x.subarray(ext0, s1);
        const head = done > 0 ? XF : 0;       // percSeg[head] == output[s0]
        if (onProgress) onProgress(0.08 + 0.8 * (done / nSeg), `HPSS segment ${done + 1}/${nSeg}…`);
        await yieldUI();
        const { reS, imS, mag, frames, bins } = stft(seg, N, HOP, WIN);
        await hpssMasks(mag, frames, bins, reS, imS);
        const percSeg = istft(reS, imS, frames, bins, N, HOP, seg.length, WIN);
        if (done > 0) {
          // Crossfade the overlapped tail with what the previous segment wrote.
          for (let j = 0; j < XF; j++) {
            const idx = s0 - XF + j;
            const t = j / XF;
            const pv = perc[idx] * (1 - t) + percSeg[j] * t;
            perc[idx] = pv;
            harm[idx] = x[idx] - pv; // perc + harm stays exactly the original
          }
        }
        for (let i = 0; i < s1 - s0; i++) {
          const idx = s0 + i;
          const pv = percSeg[head + i];
          perc[idx] = pv;
          harm[idx] = x[idx] - pv;
        }
        done++;
        return stepSeg();
      };
      return stepSeg();
    });
  }

  /* ================= offline filter renders ================= */
  function offlineRender(buffer, buildFn) {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OC(2, buffer.length, buffer.sampleRate);
    const src = oc.createBufferSource();
    src.buffer = buffer;
    buildFn(oc, src).connect(oc.destination);
    src.start(0);
    return oc.startRendering();
  }
  function lp(oc, freq) { const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq; return f; }
  function hp(oc, freq) { const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = freq; return f; }

  /* ================= engine: Bass Focus ================= */
  function bassFocus(buffer, onProgress) {
    if (onProgress) onProgress(0.05, 'Bass render…');
    return offlineRender(buffer, (oc, src) => {
      const a = lp(oc, 200), b = lp(oc, 200); // 24 dB/oct
      src.connect(a); a.connect(b); return b;
    }).then((bassBuf) => {
      if (onProgress) onProgress(0.55, 'Upper render…');
      return offlineRender(buffer, (oc, src) => {
        const h = hp(oc, 200); src.connect(h); return h;
      }).then((upperBuf) => {
        if (onProgress) onProgress(1, 'Done');
        return [
          { name: 'Bass (<200 Hz)', buffer: bassBuf },
          { name: 'Upper (>200 Hz)', buffer: upperBuf },
        ];
      });
    });
  }

  /* ================= engine: Stem Split (Spectral) ================= */
  function spectralSplit(buffer, onProgress) {
    const bands = [
      { name: 'Bass',    build: (oc, src) => { const a = lp(oc, 250), b = lp(oc, 250); src.connect(a); a.connect(b); return b; } },
      { name: 'Low-Mid', build: (oc, src) => { const h = hp(oc, 250), l = lp(oc, 2000); src.connect(h); h.connect(l); return l; } },
      { name: 'Presence',build: (oc, src) => { const h = hp(oc, 2000), l = lp(oc, 6000); src.connect(h); h.connect(l); return l; } },
      { name: 'Air',     build: (oc, src) => { const h = hp(oc, 6000); src.connect(h); return h; } },
    ];
    const out = [];
    let i = 0;
    const step = () => {
      if (i >= bands.length) { if (onProgress) onProgress(1, 'Done'); return Promise.resolve(out); }
      if (onProgress) onProgress(i / bands.length, `${bands[i].name} render…`);
      return offlineRender(buffer, bands[i].build).then((buf) => {
        out.push({ name: bands[i].name, buffer: buf });
        i++;
        return step();
      });
    };
    return step();
  }

  /* ================= public API ================= */
  const results = []; // last extraction: [{name, buffer, engine}]

  /* ---- stem pack registry ----
     A "stem pack" is 2–6 audio roles that Auto Remix can consume as
     separate tracks. 4-role: AI/cloud separation ('vocal', 'drums',
     'bass', 'other'); 6-role: htdemucs_6s via the user's own HF Space
     (adds 'guitar', 'piano'); DSP spectral bands ('low','lowmid',
     'presence','air') — labelled honestly, never passed off as
     instrument isolation.
     2-role: Hugging Face free AI (Vocals + Instrumental).
     A future cloud/AI module registers its stems via setStemPack(). */
  let stemPack = null; // {source:'ai'|'hf'|'dsp-spectral', createdAt, roles:[{role,label,buffer}]}
  function setStemPack(pack) {
    // Fail-safe (Round-6 W7 Issue 4): validate se PEHLE purana pack hatao —
    // warna failed registration ke baad Auto Remix stale stems par chalta rahega.
    stemPack = null;
    if (!pack || !Array.isArray(pack.roles) || pack.roles.length < 2)
      throw new Error('A stem pack needs at least 2 roles.');
    pack.roles.forEach((r, i) => {
      if (!r || !r.buffer || !r.buffer.getChannelData) throw new Error(`Role ${i + 1} has no audio buffer.`);
    });
    stemPack = {
      source: pack.source || 'ai',
      createdAt: Date.now(),
      roles: pack.roles.map((r) => ({ role: r.role || ('stem' + (pack.roles.indexOf(r) + 1)), label: r.label || r.role || 'Stem', buffer: r.buffer })),
    };
    return stemPack;
  }
  function getStemPack() { return stemPack; }
  function packAvailable() {
    return !!(stemPack && stemPack.roles.length >= 2 &&
      stemPack.roles.every((r) => r.buffer && r.buffer.getChannelData));
  }
  function clearStemPack() { stemPack = null; }

  function run(engineId, buffer, onProgress) {
    results.length = 0;
    let p;
    if (engineId === 'vocalcut') p = vocalCut(buffer, onProgress);
    else if (engineId === 'hpss') p = hpss(buffer, onProgress);
    else if (engineId === 'bass') p = bassFocus(buffer, onProgress);
    else if (engineId === 'spectral') p = spectralSplit(buffer, onProgress);
    else return Promise.reject(new Error('Unknown engine: ' + engineId));
    return p.then((stems) => {
      stems.forEach((s) => results.push({ name: s.name, buffer: s.buffer, engine: engineId }));
      return results.slice();
    });
  }

  function clear() {
    results.forEach((s) => { s.buffer = null; });
    results.length = 0;
    clearStemPack();
  }

  return { ENGINES, run, results, clear, setStemPack, getStemPack, packAvailable, clearStemPack };
})();
