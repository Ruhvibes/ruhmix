'use strict';
/* =====================================================================
   RuhMix — export.js
   Offline mix render -> MP3 (bundled lamejs, fully offline) or WAV
   (native 16-bit PCM encoder). Honest scope: v1 exports MP3 + WAV only.
   M4A/FLAC export is NOT offered in the UI.

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
    const dur = opts.duration || (rate !== 1 ? buffer.duration / rate : buffer.duration);
    const oc = new OC(2, Math.max(1, Math.ceil(dur * sr)), sr);
    const src = oc.createBufferSource();
    src.buffer = buffer;
    if (rate !== 1) src.playbackRate.value = rate;
    const tail = buildGraph(oc, src) || src;
    tail.connect(oc.destination);
    src.start(0);
    return oc.startRendering();
  }

  function lameAvailable() {
    return (typeof window.lamejs !== 'undefined') && window.lamejs && typeof window.lamejs.Mp3Encoder === 'function';
  }

  // MP3 encode with progress + cancel token {cancelled:false}.
  function encodeMp3(int16, kbps, sampleRate, onProgress, token) {
    return new Promise((resolve, reject) => {
      if (!lameAvailable()) { reject(new Error('MP3 encoder load nahi hua.')); return; }
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
    renderOffline, encodeMp3, lameAvailable,
    blobToBase64, deliver, share,
  };
})();
