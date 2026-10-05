'use strict';
/* =====================================================================
   RuhMix — projects.js
   Project state: op-list (non-destructive edits) + settings + audio
   FILE REFERENCE (audio bytes are NOT stored in localStorage — too big).
   Auto-save to localStorage, crash-recovery banner on unclean exit.

   Ops (applied in order by applyOps):
     {t:'trim', a, b}    keep [a,b] seconds
     {t:'cut', a, b}     remove [a,b] seconds
     {t:'paste', at}     insert clipboard at `at` (clipboard is in-memory)
     {t:'fadein', dur}   linear fade-in over dur seconds (from view start)
     {t:'fadeout', dur}  linear fade-out over dur seconds (to view end)
     {t:'gain', db}      multiply view by dB
     {t:'reverse'}        reverse the view
   Live (non-op) params — speed, volume, pan, loop — are settings, not ops.
   ===================================================================== */
window.RM = window.RM || {};

RM.proj = (function () {
  const LS_PROJECTS = 'ruhmix.projects.v1';
  const LS_AUTOSAVE = 'ruhmix.autosave.v1';
  const LS_CLEAN = 'ruhmix.cleanExit.v1';

  let clipboard = null; // AudioBuffer, in-memory only
  const viewCache = new WeakMap(); // buffer -> {sig, view}

  function uid() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  function blankSettings() {
    return {
      speed: 1.0, volume: 0.9, pan: 0, loop: false,
      fx: null,            // RM.fx preset object
      remixStyle: null,
      slowed: null,        // slowed+reverb studio settings
      mastering: null,
      markers: [],         // [{t, label}]
    };
  }

  function create(name) {
    return {
      id: uid(), name: name || 'Untitled Project',
      createdAt: Date.now(), updatedAt: Date.now(),
      audioRef: null,      // {name, size, type, lastModified}
      ops: [],
      settings: blankSettings(),
    };
  }

  function serialize(p) {
    return JSON.stringify({
      id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
      audioRef: p.audioRef, ops: p.ops, settings: p.settings,
    });
  }
  function deserialize(s) {
    try {
      const o = JSON.parse(s);
      if (!o || !o.id) return null;
      o.settings = Object.assign(blankSettings(), o.settings || {});
      o.ops = Array.isArray(o.ops) ? o.ops : [];
      return o;
    } catch (e) { return null; }
  }

  /* ---------- project library ---------- */
  function list() {
    try {
      const raw = localStorage.getItem(LS_PROJECTS);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(deserialize).filter(Boolean) : [];
    } catch (e) { return []; }
  }
  function persistAll(arr) {
    try { localStorage.setItem(LS_PROJECTS, JSON.stringify(arr.map(serialize))); } catch (e) {}
  }
  function save(p) {
    p.updatedAt = Date.now();
    snapshotLive(p);
    const arr = list().filter((x) => x.id !== p.id);
    arr.unshift(p);
    persistAll(arr.slice(0, 30)); // cap library at 30 projects
    autosave(p);
  }
  function remove(id) {
    clearTimeout(_asTimer); // pending autosave me deleted project wapas na aaye
    persistAll(list().filter((x) => x.id !== id));
    try {
      const a = loadAutosave();
      if (a && a.id === id) localStorage.removeItem(LS_AUTOSAVE);
    } catch (e) {}
    // Khula hua project delete ho to uska dangling reference todo — nayi
    // blank identity (nayi id) de do taaki agli autosave/save use "zinda"
    // karke library me wapas na le aaye. Naam/audioRef bache rehte hain.
    try {
      const app = window.RM && RM.app;
      if (app && app.state && app.state.project && app.state.project.id === id) {
        const fresh = create();
        fresh.name = app.state.project.name;
        fresh.audioRef = app.state.project.audioRef || null;
        app.state.project = fresh;
      }
    } catch (e) {}
  }
  function get(id) { return list().find((x) => x.id === id) || null; }

  /* ---------- autosave + crash recovery ---------- */
  let _asTimer = 0;

  // Live studio state (FX chain, slowed+reverb, mastering, remix style) app
  // ke state me rehta hai — project.settings ke andar snapshot karo taaki
  // save ke baad wapas mil sake. Pehle ye fields hamesha null rehte the
  // (koi inhe likhta hi nahi tha) — ab save/autosave dono me capture hote hain.
  function snapshotLive(p) {
    try {
      const app = window.RM && RM.app;
      if (!app || !app.state || !p) return;
      const s = app.state;
      p.settings = p.settings || blankSettings();
      if (s.fx) p.settings.fx = JSON.parse(JSON.stringify(s.fx));
      if (s.slowed) p.settings.slowed = Object.assign({}, s.slowed);
      if (s.mastering) {
        p.settings.mastering = {
          preset: s.mastering.preset || 'clean',
          ab: s.mastering.ab || 'after',
          settings: s.mastering.settings ? Object.assign({}, s.mastering.settings) : null,
        };
      }
      if (s.remix) p.settings.remixStyle = s.remix.style || null;
    } catch (e) {}
  }

  // App team ke liye: openProject() me `RM.proj.restoreLive(p)` call karein
  // taaki project khulne par FX chain / slowed / mastering / remix style
  // wapas lag jayein. Sirf app.state copy hota hai — audio chain agle
  // ensureStudio()/play par khud apply ho jata hai.
  function restoreLive(p) {
    try {
      const app = window.RM && RM.app;
      if (!app || !app.state || !p || !p.settings) return false;
      const s = p.settings, changed = { fx: false, slowed: false, mastering: false, remix: false };
      if (s.fx) { app.state.fx = JSON.parse(JSON.stringify(s.fx)); changed.fx = true; }
      if (s.slowed) { app.state.slowed = Object.assign({}, s.slowed); changed.slowed = true; }
      if (s.mastering) {
        app.state.mastering = {
          preset: s.mastering.preset || 'clean',
          ab: s.mastering.ab || 'after',
          settings: s.mastering.settings ? Object.assign({}, s.mastering.settings) : null,
        };
        changed.mastering = true;
      }
      if (typeof s.remixStyle !== 'undefined') {
        app.state.remix = app.state.remix || {};
        app.state.remix.style = s.remixStyle || null;
        changed.remix = true;
      }
      return changed;
    } catch (e) { return false; }
  }

  function autosave(p) {
    if (!p) return;
    clearTimeout(_asTimer);
    _asTimer = setTimeout(() => {
      try {
        p.updatedAt = Date.now();
        snapshotLive(p);
        localStorage.setItem(LS_AUTOSAVE, serialize(p));
        localStorage.setItem(LS_CLEAN, '0');
      } catch (e) {}
    }, 800);
  }
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(LS_AUTOSAVE);
      return raw ? deserialize(raw) : null;
    } catch (e) { return null; }
  }
  function markCleanExit() { try { localStorage.setItem(LS_CLEAN, '1'); } catch (e) {} }
  function markDirty() { try { localStorage.setItem(LS_CLEAN, '0'); } catch (e) {} }
  function needsRecovery() {
    try {
      const raw = localStorage.getItem(LS_AUTOSAVE);
      if (!raw || localStorage.getItem(LS_CLEAN) === '1') return false;
      if (!deserialize(raw)) {
        // Bhrasht (corrupt) autosave — chup-chaap hata do, warna recovery
        // har launch me "atka" rahega: needsRecovery() true deta rahega
        // lekin banner kabhi nahi aayega (loadAutosave null deta hai).
        try { localStorage.removeItem(LS_AUTOSAVE); } catch (e2) {}
        return false;
      }
      return true;
    } catch (e) { return false; }
  }
  function discardAutosave() { try { localStorage.removeItem(LS_AUTOSAVE); } catch (e) {} }

  /* ---------- op-list rendering (non-destructive) ---------- */
  function sig(ops) { return JSON.stringify(ops); }

  function setClipboard(buf) { clipboard = buf; }
  function getClipboard() { return clipboard; }
  function clearClipboard() { clipboard = null; }

  // Applies ops to a COPY of buffer. Original untouched. Chunked.
  function applyOps(buffer, ops, onProgress) {
    const s = sig(ops);
    const cached = viewCache.get(buffer);
    if (cached && cached.sig === s) return Promise.resolve(cached.view);

    const sr = buffer.sampleRate;
    const nCh = buffer.numberOfChannels;
    // Stage 1: structural ops (trim/cut/paste) -> build segment list
    let segs = [{ buf: buffer, a: 0, b: buffer.length }]; // sample ranges
    const s2s = (sec) => Math.max(0, Math.min(buffer.length, Math.round(sec * sr)));

    const cutRange = (aS, bS) => {
      const out = [];
      segs.forEach((sg) => {
        if (bS <= sg.a || aS >= sg.b) { out.push(sg); return; }
        if (aS > sg.a) out.push({ buf: sg.buf, a: sg.a, b: Math.min(aS, sg.b) });
        if (bS < sg.b) out.push({ buf: sg.buf, a: Math.max(bS, sg.a), b: sg.b });
      });
      segs = out;
    };

    for (const op of ops) {
      if (op.t === 'trim') {
        const aS = s2s(op.a), bS = s2s(op.b);
        segs = [{ buf: buffer, a: aS, b: Math.max(aS + 1, bS) }];
      } else if (op.t === 'cut') {
        cutRange(s2s(op.a), s2s(op.b));
      } else if (op.t === 'paste' && clipboard) {
        const atS = s2s(op.at);
        const out = [];
        let done = false;
        segs.forEach((sg) => {
          if (!done && atS >= sg.a && atS <= sg.b) {
            if (atS > sg.a) out.push({ buf: sg.buf, a: sg.a, b: atS });
            out.push({ buf: clipboard, a: 0, b: clipboard.length });
            if (atS < sg.b) out.push({ buf: sg.buf, a: atS, b: sg.b });
            done = true;
          } else out.push(sg);
        });
        if (!done) out.push({ buf: clipboard, a: 0, b: clipboard.length });
        segs = out;
      }
    }

    let total = 0;
    segs.forEach((sg) => { total += Math.max(0, sg.b - sg.a); });
    total = Math.max(1, total);

    const ctx = RM.audio.ensureCtx();
    const view = ctx.createBuffer(nCh, total, sr);
    // Stage 2: copy segments (chunked)
    const prog = onProgress ? (p) => onProgress(p * 0.7, 'Applying edits…') : null;
    let writePos = 0;
    const copyJobs = segs.map((sg) => {
      const len = Math.max(0, sg.b - sg.a);
      const from = writePos;
      writePos += len;
      if (len <= 0) return Promise.resolve();
      return RM.audio.runChunked(len, 1 << 18, (a, b) => {
        for (let c = 0; c < nCh; c++) {
          const src = sg.buf.getChannelData(Math.min(c, sg.buf.numberOfChannels - 1));
          const dst = view.getChannelData(c);
          for (let i = a; i < b; i++) dst[from + i] = src[sg.a + i] || 0;
        }
      });
    });

    return Promise.all(copyJobs).then(() => {
      // Stage 3: sample ops (fade/gain/reverse), chunked — SEQUENTIAL thunks.
      // Zaroori hai: saare jobs ek hi `view` buffer mutate karte hain aur
      // runChunked chunks ke beech yield karta hai; parallel chalane se
      // fade vs reverse jaisi non-commuting ops galat order me lagti.
      // (Pehle yahan Promises push hote the aur runSeq unhe call karta tha —
      //  `jobs[di++]()` → TypeError, saare sample ops toote hue the.)
      const jobs = [];
      for (const op of ops) {
        if (op.t === 'fadein' || op.t === 'fadeout') {
          const fl = Math.min(view.length, Math.max(1, Math.round((op.dur || 1) * sr)));
          const tt = op.t;
          jobs.push((onP) => RM.audio.runChunked(view.length, 1 << 18, (a, b) => {
            for (let c = 0; c < nCh; c++) {
              const d = view.getChannelData(c);
              for (let i = a; i < b; i++) {
                let g = 1;
                if (tt === 'fadein' && i < fl) g = i / fl;
                if (tt === 'fadeout' && i >= view.length - fl) g = (view.length - 1 - i) / fl;
                d[i] *= g;
              }
            }
          }, onP));
        } else if (op.t === 'gain') {
          const g = Math.pow(10, (op.db || 0) / 20);
          jobs.push((onP) => RM.audio.runChunked(view.length, 1 << 18, (a, b) => {
            for (let c = 0; c < nCh; c++) {
              const d = view.getChannelData(c);
              for (let i = a; i < b; i++) d[i] *= g;
            }
          }, onP));
        } else if (op.t === 'reverse') {
          jobs.push((onP) => RM.audio.runChunked(Math.ceil(view.length / 2), 1 << 17, (a, b) => {
            for (let c = 0; c < nCh; c++) {
              const d = view.getChannelData(c);
              for (let i = a; i < b; i++) {
                const j = view.length - 1 - i;
                if (i < j) { const t = d[i]; d[i] = d[j]; d[j] = t; }
              }
            }
          }, onP));
        }
      }
      const prog2 = onProgress ? (p) => onProgress(0.7 + p * 0.3, 'Finalizing…') : null;
      let di = 0;
      const runSeq = () => {
        if (di >= jobs.length) {
          viewCache.set(buffer, { sig: s, view });
          if (onProgress) onProgress(1, 'Done');
          return view;
        }
        const idx = di++;
        // progress sirf aakhri job par (pehle jaisa irada tha)
        return jobs[idx](idx === jobs.length - 1 ? prog2 : null).then(runSeq);
      };
      return runSeq();
    });
  }

  function invalidateView(buffer) { try { viewCache.delete(buffer); } catch (e) {} }

  return {
    create, list, save, remove, get,
    serialize, deserialize,
    autosave, loadAutosave, markCleanExit, markDirty,
    needsRecovery, discardAutosave,
    snapshotLive, restoreLive,
    applyOps, invalidateView,
    setClipboard, getClipboard, clearClipboard,
    blankSettings,
  };
})();
