'use strict';
/* =====================================================================
   RuhMix — export.js
   Offline mix render -> MP3 (bundled lamejs, fully offline), WAV
   (native 16-bit PCM encoder), or FLAC (pure-JS encoder in this file:
   16-bit, fixed predictor + Rice coding, RFC 9639 — fully offline).
   Honest scope: MP3 + WAV + FLAC. M4A/AAC export is NOT offered:
   browsers cannot AAC-encode offline without native code, so no M4A
   option is shown in the UI (no "coming soon" claims either).

   Stages: preparing -> rendering -> encoding -> saving. Cancel works
   between stages and during encoding; the native offline render itself
   is one shot (UI says "Rendering… please wait" during it).

   Delivery: tries Android.saveWav (WAV) / Android.saveFile (any), else
   falls back to a browser download. Share uses Android.shareFile(path,
   mime) when the native side saved the file, with graceful fallbacks.
   ===================================================================== */
window.RM = window.RM || {};

RM.exp = (function () {
  const BITRATES = [128, 192, 256, 320];
  const SAMPLE_RATES = [44100, 48000];

  function defaultName(ext) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `ruhmix-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
  }

  // Render a buffer through a caller-built graph, offline.
  // buildGraph(oc, srcNode) must return the node to connect to destination.
  function renderOffline(buffer, buildGraph, opts) {
    opts = opts || {};
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) return Promise.reject(new Error('OfflineAudioContext not supported.'));
    const sr = opts.sampleRate || buffer.sampleRate;
    // If the source is played at a different rate (e.g. slowed+reverb),
    // the offline render must be longer/shorter to hold the whole take.
    const rate = opts.rate || 1;
    // Effect tails (convolver reverb IR up to ~2.2s, echo repeats) ring past
    // the last source sample — without a tail allowance the export chops
    // them off mid-decay. Default +2.5s; opts.tail overrides (0 disables).
    // An explicit opts.duration is used as-is (caller owns the full length).
    let dur = opts.duration || (rate !== 1 ? buffer.duration / rate : buffer.duration);
    if (!opts.duration) {
      const tail = opts.tail === undefined ? 2.5 : Math.max(0, opts.tail);
      dur += tail;
    }
    const oc = new OC(2, Math.max(1, Math.ceil(dur * sr)), sr);
    const src = oc.createBufferSource();
    src.buffer = buffer;
    if (rate !== 1) src.playbackRate.value = rate;
    const tailNode = buildGraph(oc, src) || src;
    tailNode.connect(oc.destination);
    src.start(0);
    return oc.startRendering();
  }

  function lameAvailable() {
    return (typeof window.lamejs !== 'undefined') && window.lamejs && typeof window.lamejs.Mp3Encoder === 'function';
  }

  // MP3 encode with progress + cancel token {cancelled:false}.
  function encodeMp3(int16, kbps, sampleRate, onProgress, token) {
    return new Promise((resolve, reject) => {
      if (!lameAvailable()) { reject(new Error('MP3 encoder failed to load.')); return; }
      let enc;
      try { enc = new lamejs.Mp3Encoder(2, sampleRate, kbps); }
      catch (e) { reject(e); return; }
      const total = int16.left.length;
      const chunk = 1152 * 32;
      const parts = [];
      let i = 0;
      const step = () => {
        try {
          if (token && token.cancelled) { reject(new Error('cancelled')); return; }
          const end = Math.min(total, i + chunk);
          const d = enc.encodeBuffer(int16.left.subarray(i, end), int16.right.subarray(i, end));
          if (d && d.length) parts.push(new Uint8Array(d.buffer ? d : d));
          i = end;
          if (onProgress) onProgress(i / total);
          if (i < total) setTimeout(step, 0);
          else {
            const f = enc.flush();
            if (f && f.length) parts.push(new Uint8Array(f.buffer ? f : f));
            resolve(new Blob(parts, { type: 'audio/mpeg' }));
          }
        } catch (e) { reject(e); }
      };
      step();
    });
  }

  function blobToBase64(blob, onProgress) {
    return blob.arrayBuffer().then((ab) => RM.audio.arrayBufferToBase64(ab, onProgress));
  }

  /* ================= FLAC encoder (pure JS, offline) =====================
     Honest scope: 16-bit, mono/stereo independent, fixed blocksize 4096,
     fixed predictor orders 0..4 (or verbatim), partitioned Rice coding.
     No LPC, no mid-side decorrelation — still 100% valid lossless FLAC
     (RFC 9639). Typical compression 30-55% on music.
     ===================================================================== */

  // --- compact MD5 (public-domain algorithm), streaming-capable ---
  function md5Create() {
    const s = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
               5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
               4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
               6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const buf = [];
    let len = 0;
    const M = new Uint32Array(16);
    function block(off, dv) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, s[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    return {
      update(bytes) { // Uint8Array
        for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]);
        len += bytes.length;
      },
      digest() {
        const msgLen = len;
        const withOne = msgLen + 1;
        const padZeros = (56 - (withOne % 64) + 64) % 64;
        const total = withOne + padZeros + 8;
        const b = new Uint8Array(total);
        for (let i = 0; i < buf.length; i++) b[i] = buf[i];
        b[msgLen] = 0x80;
        const dv = new DataView(b.buffer);
        const bitLen = msgLen * 8;
        dv.setUint32(total - 8, bitLen >>> 0, true);
        dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);
        for (let off = 0; off < total; off += 64) block(off, dv);
        const out = new Uint8Array(16);
        const odv = new DataView(out.buffer);
        odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
        odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
        return out;
      },
    };
  }

  // --- CRC tables ---
  const CRC8_T = new Uint8Array(256);
  (function () {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
      CRC8_T[i] = c;
    }
  })();
  function crc8(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = CRC8_T[(c ^ bytes[i]) & 0xff]; return c; }
  function crc16(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i] << 8;
      for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  }

  // --- bit writer ---
  function BitWriter() {
    const bytes = [];
    let acc = 0, nbits = 0, count = 0;
    return {
      bits(n, v) {
        v >>>= 0;
        while (n > 0) {
          if (nbits === 8) { bytes.push(acc); acc = 0; nbits = 0; count++; }
          const take = Math.min(8 - nbits, n);
          const shift = n - take;
          acc = (acc << take) | ((v >>> shift) & ((1 << take) - 1));
          nbits += take; n -= take;
          v &= shift >= 31 ? 0 : (1 << shift) - 1;
        }
      },
      sbits(n, v) { this.bits(n, v < 0 ? v + Math.pow(2, n) : v); },
      unary(q) { for (let i = 0; i < q; i++) this.bits(1, 0); this.bits(1, 1); },
      flushByte() {
        if (nbits === 8) { bytes.push(acc); acc = 0; nbits = 0; count++; }
        else if (nbits > 0) { bytes.push(acc << (8 - nbits)); acc = 0; nbits = 0; count++; }
      },
      utf8(n) {
        n = Math.floor(n);
        if (n < 128) { this.bits(8, n); return; }
        // standard UTF-8 (FLAC uses the same variable-length coding)
        const tail = [];
        let x = n;
        tail.unshift(0x80 | (x % 64)); x = Math.floor(x / 64);
        while (x >= 32) { tail.unshift(0x80 | (x % 64)); x = Math.floor(x / 64); }
        const L = tail.length + 1;
        this.bits(8, (((0xff << (8 - L)) & 0xff) | x) & 0xff);
        for (let i = 0; i < tail.length; i++) this.bits(8, tail[i]);
      },
      padToByte() { if (nbits > 0) this.bits(8 - nbits, 0); this.flushByte(); },
      bytePos() { this.flushByte(); return count; },
      bytesSince(pos) { return bytes.slice(pos); },
      finish() {
        this.flushByte();
        return new Uint8Array(bytes);
      },
    };
  }

  // Fixed predictor residual for order 0..4 (RFC 9639 §9.2.5).
  function fixedResiduals(x, n, order) {
    const r = new Int32Array(n - order);
    for (let i = order; i < n; i++) {
      let p = 0;
      if (order === 1) p = x[i - 1];
      else if (order === 2) p = 2 * x[i - 1] - x[i - 2];
      else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
      else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
      r[i - order] = x[i] - p;
    }
    return r;
  }
  const zigzag = (v) => ((v << 1) ^ (v >> 31)) >>> 0;

  // Best Rice param + bit cost for zigzag residuals u[start..end).
  function riceCost(u, start, end) {
    let best = null;
    for (let k = 0; k <= 14; k++) {
      let b = 0;
      for (let i = start; i < end; i++) b += (u[i] >>> k) + 1 + k;
      if (!best || b < best.bits) best = { k, bits: b, escape: false };
    }
    let maxAbs = 0;
    for (let i = start; i < end; i++) { const v = u[i] >> 1; const a = v < 0 ? -v : v; if (a > maxAbs) maxAbs = a; }
    // NOTE: u holds zigzag; recover approx max |residual| via u>>1 (works for both signs)
    let bps = 1;
    while (bps < 31 && maxAbs >= (1 << (bps - 1))) bps++;
    const escBits = 5 + (end - start) * bps;
    if (escBits < best.bits) best = { k: -1, bits: escBits, escape: true, bps };
    return best;
  }

  // Encode one subframe (16-bit samples, blockSize n). Returns via writer.
  function writeSubframe(w, x, n) {
    // candidates: fixed orders 0..4 + verbatim
    let best = null;
    const cands = [];
    for (let order = 0; order <= 4; order++) {
      if (order >= n) break;
      const r = fixedResiduals(x, n, order);
      const u = new Uint32Array(r.length);
      for (let i = 0; i < r.length; i++) u[i] = zigzag(r[i]);
      cands.push({ order, r, u });
    }
    for (const c of cands) {
      const order = c.order;
      const nRes = c.u.length;
      let bestPo = 0, bestBits = Infinity, partInfo = null;
      for (let po = 0; po <= 3; po++) {
        const nPart = 1 << po;
        // keep partitions exact: blocksize must be divisible by nPart
        // (avoids ambiguous remainder handling in the last partition)
        if (n % nPart !== 0) continue;
        const psize = n >> po;
        if (psize <= order || nPart > nRes) continue;
        let bits = 8 + order * 16 + 6; // subframe hdr + warmup + rice method/order
        const infos = [];
        let ok = true;
        for (let p = 0; p < nPart; p++) {
          const s0 = p === 0 ? 0 : p * psize - order;
          const s1 = p === 0 ? psize - order : (p + 1) * psize - order;
          if (s1 <= s0) { ok = false; break; }
          const rc = riceCost(c.u, s0, s1);
          bits += 4 + rc.bits; // rice param field + codes
          infos.push({ s0, s1, rc });
        }
        if (!ok) continue;
        if (bits < bestBits) { bestBits = bits; bestPo = po; partInfo = infos; }
      }
      const total = bestBits;
      if (!best || total < best.bits) best = { order, bits: total, po: bestPo, infos: partInfo, r: c.r, u: c.u };
    }
    // verbatim candidate
    const verbBits = 8 + n * 16;
    if (!best || verbBits < best.bits) best = { order: -1, bits: verbBits };
    // --- write ---
    w.bits(1, 0);
    if (best.order === -1) {
      w.bits(6, 1); // verbatim
      w.bits(1, 0); // no wasted bits
      for (let i = 0; i < n; i++) w.sbits(16, x[i]);
      return;
    }
    w.bits(6, 8 + best.order); // fixed predictor
    w.bits(1, 0); // no wasted bits
    for (let i = 0; i < best.order; i++) w.sbits(16, x[i]);
    w.bits(2, 0); // Rice, 4-bit params
    w.bits(4, best.po);
    const psize = n >> best.po;
    for (let p = 0; p < best.infos.length; p++) {
      const { s0, s1, rc } = best.infos[p];
      if (rc.escape) {
        w.bits(4, 15);
        w.bits(5, rc.bps);
        for (let i = s0; i < s1; i++) {
          // recover signed residual from zigzag
          const uu = best.u[i];
          const v = (uu >>> 1) ^ (-(uu & 1));
          w.sbits(rc.bps, v);
        }
      } else {
        w.bits(4, rc.k);
        const mask = rc.k === 0 ? 0 : (1 << rc.k) - 1;
        for (let i = s0; i < s1; i++) {
          const uu = best.u[i];
          w.unary(uu >>> rc.k);
          if (rc.k) w.bits(rc.k, uu & mask);
        }
      }
    }
  }

  function writeFrame(w, frameNo, xL, xR, n, sampleRate) {
    const channels = xR ? 2 : 1;
    const hdrPos = w.bytePos(); // flush + capture position BEFORE header
    w.bits(15, 0x7FFC); // sync
    w.bits(1, 0);       // fixed blocksize
    if (n <= 256) w.bits(4, 6); else w.bits(4, 7);
    w.bits(4, 0);       // sample rate: from STREAMINFO
    w.bits(4, channels === 2 ? 1 : 0);
    w.bits(3, 4);       // 16 bits per sample
    w.bits(1, 0);
    w.utf8(frameNo);
    if (n <= 256) w.bits(8, n - 1); else w.bits(16, n - 1);
    w.flushByte(); // make the pending header byte visible to bytesSince
    w.bits(8, crc8(w.bytesSince(hdrPos)));
    const framePos = w.bytePos();
    writeSubframe(w, xL, n);
    if (xR) writeSubframe(w, xR, n);
    w.padToByte();
    const frameBytes = w.bytesSince(framePos);
    w.bits(16, crc16(frameBytes));
  }

  // int16: {left: Int16Array, right: Int16Array|null}. Returns Promise<Blob>.
  function encodeFlac(int16, sampleRate, onProgress, token) {
    return new Promise((resolve, reject) => {
      try {
        const total = int16.left.length;
        if (!total) { reject(new Error('No audio to encode.')); return; }
        const channels = int16.right ? 2 : 1;
        const md5 = md5Create();
        // pass 1: MD5 over interleaved LE signed samples (RFC 9639 §8.2)
        const CH = 1 << 18;
        let p1 = 0;
        const md5Step = () => {
          try {
            if (token && token.cancelled) { reject(new Error('cancelled')); return; }
            const end = Math.min(total, p1 + CH);
            const nb = (end - p1) * channels * 2;
            const bb = new Uint8Array(nb);
            const dv = new DataView(bb.buffer);
            for (let i = p1; i < end; i++) {
              const o = (i - p1) * channels * 2;
              dv.setInt16(o, int16.left[i], true);
              if (int16.right) dv.setInt16(o + 2, int16.right[i], true);
            }
            md5.update(bb);
            p1 = end;
            if (onProgress) onProgress(0.05 + 0.15 * (p1 / total), 'md5');
            if (p1 < total) setTimeout(md5Step, 0);
            else encodeStep();
          } catch (e) { reject(e); }
        };
        const encodeStep = () => {
          try {
            const digest = md5.digest();
            const w = new BitWriter();
            // 'fLaC'
            w.bits(8, 0x66); w.bits(8, 0x4c); w.bits(8, 0x61); w.bits(8, 0x43);
            // STREAMINFO (last block)
            w.bits(1, 1); w.bits(7, 0); w.bits(24, 34);
            const BLOCK = 4096;
            w.bits(16, BLOCK); w.bits(16, BLOCK);
            w.bits(24, 0); w.bits(24, 0); // min/max frame size unknown
            w.bits(20, sampleRate);
            w.bits(3, channels - 1);
            w.bits(5, 15); // 16 bps
            w.bits(4, Math.floor(total / 4294967296));
            w.bits(32, total >>> 0);
            for (let i = 0; i < 16; i++) w.bits(8, digest[i]);
            // pass 2: frames
            const nFrames = Math.ceil(total / BLOCK);
            let f = 0;
            const frameStep = () => {
              try {
                if (token && token.cancelled) { reject(new Error('cancelled')); return; }
                const s0 = f * BLOCK;
                const n = Math.min(BLOCK, total - s0);
                const xL = int16.left.subarray(s0, s0 + n);
                const xR = int16.right ? int16.right.subarray(s0, s0 + n) : null;
                writeFrame(w, f, xL, xR, n, sampleRate);
                f++;
                if (onProgress) onProgress(0.2 + 0.8 * (f / nFrames), 'frame');
                if (f < nFrames) setTimeout(frameStep, 0);
                else resolve(new Blob([w.finish()], { type: 'audio/flac' }));
              } catch (e) { reject(e); }
            };
            frameStep();
          } catch (e) { reject(e); }
        };
        md5Step();
      } catch (e) { reject(e); }
    });
  }

  // Deliver bytes to the device. Returns {method, name}.
  function deliver(blob, fileName, mime, onProgress) {
    const nat = RM.audio.native;
    // 1) WAV via the classic bridge (RemixLab-compatible shells)
    if (mime === 'audio/wav' && nat.method('saveWav')) {
      return blobToBase64(blob, onProgress).then((b64) => {
        nat.call('saveWav', b64, fileName);
        return { method: 'native-saveWav', name: fileName, path: null };
      });
    }
    // 2) Generic native saver (if the shell provides one)
    if (nat.method('saveFile')) {
      return blobToBase64(blob, onProgress).then((b64) => {
        const r = nat.call('saveFile', b64, fileName, mime);
        return { method: 'native-saveFile', name: fileName, path: (typeof r === 'string' ? r : null) };
      });
    }
    // 3) Browser download fallback (desktop testing / DownloadListener shells)
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      resolve({ method: 'download', name: fileName, path: null });
    });
  }

  // Share the last delivered file.
  function share(delivery, mime) {
    const nat = RM.audio.native;
    if (delivery && delivery.path && nat.method('shareFile')) {
      nat.call('shareFile', delivery.path, mime);
      return 'native';
    }
    if (delivery && delivery.method === 'native-saveWav' && nat.method('shareAudioFile')) {
      nat.call('shareAudioFile', delivery.name); // compat with older shells
      return 'native-compat';
    }
    if (delivery && delivery.name && nat.method('shareFile') && nat.method('getCacheDir')) {
      // Ask shell to share from cache by name — best effort.
      const dir = nat.call('getCacheDir');
      if (dir) { nat.call('shareFile', dir + '/' + delivery.name, mime); return 'native-cache'; }
    }
    return 'unavailable';
  }

  return {
    BITRATES, SAMPLE_RATES, defaultName,
    renderOffline, encodeMp3, lameAvailable, encodeFlac,
    blobToBase64, deliver, share,
  };
})();
