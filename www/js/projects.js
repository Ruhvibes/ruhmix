'use strict';
/* =====================================================================
   RuhMix — projects.js
   Project state: op-list (non-destructive edits) + settings + audio
   FILE REFERENCE (audio bytes are NOT stored in localStorage — too big).
   Auto-save to localStorage, crash-recovery banner on unclean exit.

   Ops (applied in order by applyOps):
     {t:'trim', a, b}    keep [a,b] seconds of the CURRENT VIEW
     {t:'cut', a, b}     remove [a,b] seconds of the CURRENT VIEW
     {t:'paste', at}     insert clipboard at `at` seconds of the CURRENT VIEW
                         (clipboard is in-memory)
     {t:'fadein', dur}   linear fade-in over dur seconds (from view start)
     {t:'fadeout', dur}  linear fade-out over dur seconds (to view end)
     {t:'gain', db}      multiply view by dB
     {t:'reverse'}        reverse the view
   Structural-op coordinates (a/b/at) are ALWAYS in the current view's
   seconds — i.e. relative to the result of all preceding ops, exactly
   what the user sees on screen. (Round-6 fix: pehle ye original-buffer
   coordinates me lagte the — trim/cut ke baad cut/paste galat jagah ya
   be-asar hota tha.) deserialize() har op validate karta hai: null,
   unknown type ya non-numeric fields wale ops chup-chaap drop hote hain
   taaki ek bhrasht op poora project na duboye.
   Live (non-op) params — speed, volume, pan, loop — are settings, not ops.
   ===================================================================== */
window.RM = window.RM || {};

RM.proj = (function () {
  const LS_PROJECTS = 'ruhmix.projects.v1';
  const LS_AUTOSAVE = 'ruhmix.autosave.v1';
  const LS_CLEAN = 'ruhmix.cleanExit.v1';

  let clipboard = null; // AudioBuffer, in-memory only
  // Har clipboard change par badhta hai. applyOps ka viewCache sirf op-sig
  // par key karta tha — clipboard BADALNE par (copy A -> paste -> undo ->
  // copy B -> paste) sig same rehta aur PURANA (stale) view wapas milta tha.
  // clipGen ko sig me jodna is stale-cache ka root fix hai.
  let clipGen = 0;
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
      // Round-6 (W3): kabhi plain objects bhi aa sakte hain (hand-edit) —
      // sirf JSON strings expect karne par poori library silently khaali dikhti thi.
      const o = typeof s === 'string' ? JSON.parse(s) : s;
      if (!o || !o.id) return null;
      o.settings = Object.assign(blankSettings(), o.settings || {});
      o.ops = sanitizeOps(o.ops);
      return o;
    } catch (e) { return null; }
  }

  // Op validation (root fix — Round-6 fuzz): bhrasht/hand-edited save me
  // null entries, unknown op types ya non-numeric fields applyOps ko gira
  // dete the (TypeError / NaN-length buffer -> har render fail -> project
  // "poisoned"). Yahan sakhti se saaf karo: kharab op drop, project khule.
  const OP_FIELDS = {
    trim: ['a', 'b'], cut: ['a', 'b'], paste: ['at'],
    fadein: ['dur'], fadeout: ['dur'], gain: ['db'], reverse: [],
  };
  function sanitizeOps(ops) {
    if (!Array.isArray(ops)) return [];
    const out = [];
    for (const op of ops) {
      if (!op || typeof op !== 'object' || typeof op.t !== 'string') continue;
      const fields = OP_FIELDS[op.t];
      if (!fields) continue; // unknown op type — purana/haath se bigda data
      const clean = { t: op.t };
      let ok = true;
      for (const f of fields) {
        const v = Number(op[f]);
        if (!Number.isFinite(v)) { ok = false; break; }
        clean[f] = v;
      }
      if (ok) out.push(clean);
    }
    return out;
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
      // Round-6 (W7 Issue 8): Custom ke tempo/sliders bhi save karo, warna
      // reopen par custom settings kho jati thin.
      if (s.remix && s.remix.custom) p.settings.remixCustom = JSON.parse(JSON.stringify(s.remix.custom));
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
        // Round-6 (W7 Issue 8): Custom settings restore.
        if (s.remixCustom) app.state.remix.custom = JSON.parse(JSON.stringify(s.remixCustom));
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

  function setClipboard(buf) { clipboard = buf; clipGen++; }
  function getClipboard() { return clipboard; }
  function clearClipboard() { clipboard = null; clipGen++; }
  // Round-6: paste ops ka clipboard in-memory hai — app restart ke baad
  // reopen par paste ops render nahi honge (clipboard khaali). openProject
  // me isko check karke user ko Hindi me batana chahiye (silent audio
  // change na ho). hasPasteOps(p): project me paste ops hain ya nahi.
  function hasPasteOps(p) {
    try { return !!(p && Array.isArray(p.ops) && p.ops.some((o) => o && o.t === 'paste')); }
    catch (e) { return false; }
  }

  // Applies ops to a COPY of buffer. Original untouched. Chunked.
  function applyOps(buffer, ops, onProgress) {
    const s = sig(ops) + '|clip' + clipGen;
    const cached = viewCache.get(buffer);
    if (cached && cached.sig === s) return Promise.resolve(cached.view);

    const sr = buffer.sampleRate;
    const nCh = buffer.numberOfChannels;
    // Stage 1: structural ops (trim/cut/paste) -> build segment list.
    // ROOT FIX (Round-6): op coordinates hamesha CURRENT VIEW ke hote hain
    // (pichhle ops ka result — wahi jo user screen par dekhta hai), original
    // buffer ke nahi. Pehle trim ke baad cut/paste original coords me lagta
    // tha: galat jagah kat-ta ya bilkul be-asar hota tha. Ulte (a>b) range
    // ab swap hote hain — pehle ulta cut beech ka hissa DUPLICATE kar deta
    // tha. Segments internally source-buffer coordinates me rehte hain.
    let segs = [{ buf: buffer, a: 0, b: buffer.length }]; // sample ranges
    const sanNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const s2s = (sec) => Math.round(sanNum(sec) * sr); // view seconds -> view samples
    const viewLen = () => { let t = 0; for (const sg of segs) t += Math.max(0, sg.b - sg.a); return t; };
    // View-relative [aS, bS) ko source segments me kaato. Clamp + normalize;
    // engine kabhi crash ya duplicate nahi karega.
    const sliceView = (aS, bS) => {
      const total = viewLen();
      aS = Math.max(0, Math.min(total, Math.round(aS)));
      bS = Math.max(0, Math.min(total, Math.round(bS)));
      if (bS < aS) { const tmp = aS; aS = bS; bS = tmp; }
      const out = [];
      let pos = 0;
      for (const sg of segs) {
        const len = Math.max(0, sg.b - sg.a);
        const s0 = pos, s1 = pos + len;
        pos = s1;
        const ia = Math.max(aS, s0), ib = Math.min(bS, s1);
        if (ib > ia) out.push({ buf: sg.buf, a: sg.a + (ia - s0), b: sg.a + (ib - s0) });
      }
      return out;
    };

    for (const op of ops) {
      if (!op || typeof op !== 'object' || typeof op.t !== 'string') continue; // bhrasht entry skip
      if (op.t === 'trim') {
        segs = sliceView(s2s(op.a), s2s(op.b));
      } else if (op.t === 'cut') {
        const total = viewLen(); // sliceView se pehle — segs abhi purane hain
        const aS = s2s(op.a), bS = s2s(op.b);
        const lo = Math.min(aS, bS), hi = Math.max(aS, bS);
        segs = sliceView(0, lo).concat(sliceView(hi, total));
      } else if (op.t === 'paste' && clipboard) {
        const total = viewLen(); // sliceView se pehle
        const atS = s2s(op.at);
        segs = sliceView(0, atS)
          .concat([{ buf: clipboard, a: 0, b: clipboard.length }])
          .concat(sliceView(atS, total));
      }
      // unknown op types: ignore (deserialize inhe pehle hi drop karta hai)
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
        if (!op || typeof op !== 'object' || typeof op.t !== 'string') continue;
        if (op.t === 'fadein' || op.t === 'fadeout') {
          const durN = sanNum(op.dur);
          const fl = Math.min(view.length, Math.max(1, Math.round((durN || 1) * sr)));
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
          const g = Math.pow(10, (sanNum(op.db)) / 20);
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
    setClipboard, getClipboard, clearClipboard, hasPasteOps,
    blankSettings,
  };
})();
