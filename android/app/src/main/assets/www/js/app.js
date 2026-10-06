'use strict';
/* =====================================================================
   RuhMix — app.js (part 1)
   Screens/navigation, studio audio path, import, native bridge callbacks.
   ===================================================================== */
window.RM = window.RM || {};

RM.app = (function () {
  const $ = (id) => document.getElementById(id);
  const clamp = RM.audio.clamp;
  const APP = { name: 'RuhMix', versionName: '1.0', versionCode: 26 };
  const VERSION_URL = 'https://raw.githubusercontent.com/Ruhvibes/ruhmix/main/version.json';

  /* ================= i18n ================= */
  const I18N = {
    en: {
      tagline: 'Professional Music & Remix Studio',
      nav_home: 'Home', nav_editor: 'Editor', nav_remix: 'Remix', nav_mixer: 'Mixer', nav_more: 'More',
      new_project: 'New Project', auto_remix: 'Auto Remix', slowed: 'Slowed+Reverb',
      audio_editor: 'Audio Editor', stems: 'Stem Separator', recorder: 'Voice Recorder',
      ai_stems: 'AI Stem Separator',
      equalizer: 'Equalizer', mastering: 'Mastering', recent: 'Recent Projects',
      search: 'Search…', import_title: 'Import Audio', pick_audio: 'Pick Audio',
      editor_title: 'Audio Editor', play: 'Play', pause: 'Pause', stop: 'Stop',
      settings_title: 'Settings', export_title: 'Export', projects_title: 'Projects',
      by: 'By Hasnain Khan',
    },
  };
  let lang = 'en'; // English-only build: language locked to English
  function t(k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; }
  function setLang(l) {
    lang = 'en'; // locked: language selector offers English only
    try { localStorage.setItem('ruhmix.lang', 'en'); } catch (e) {}
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    const sel = $('set-lang'); if (sel) sel.value = lang;
  }

  /* ================= theme ================= */
  function setTheme(mode) {
    document.body.classList.toggle('light', mode === 'light');
    try { localStorage.setItem('ruhmix.theme', mode); } catch (e) {}
    const sel = $('set-theme'); if (sel) sel.value = mode;
  }
  function loadTheme() {
    let m = 'dark';
    try { m = localStorage.getItem('ruhmix.theme') || 'dark'; } catch (e) {}
    setTheme(m);
  }

  /* ================= toast + dialog ================= */
  let toastTimer = 0;
  /* Strip technical noise from an error before showing it to the user —
     no stack traces, no "TypeError:", no [object Object]. */
  function cleanErrMsg(m) {
    let s = String(m || '').split('\n')[0];       // first line only (no stack)
    s = s.replace(/^[A-Za-z$][\w$]*Error:\s*/g, ''); // "TypeError: x" -> "x"
    s = s.replace(/^\[object [^\]]+\]$/, '').trim();  // "[object Object]" -> ""
    if (s.length > 140) s = s.slice(0, 137) + '…';
    return s;
  }
  function toast(msg, ms) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }
  function dialog(title, bodyHTML, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      $('dlg-title').textContent = title;
      $('dlg-body').innerHTML = bodyHTML;
      $('dlg-ok').textContent = okLabel || 'OK';
      const c = $('dlg-cancel');
      c.textContent = cancelLabel || 'Cancel';
      const hasCancel = cancelLabel !== null;
      c.style.display = hasCancel ? '' : 'none';
      const x = $('dlg-x');
      if (x) x.style.display = hasCancel ? '' : 'none';
      const close = (v) => { $('dlg').classList.remove('show'); resolve(v); };
      $('dlg-ok').onclick = () => close(true);
      c.onclick = () => close(false);
      if (x) x.onclick = () => close(false);
      // Backdrop tap dismisses (same as Cancel) — ✕ and backdrop both
      // present, per dialog style guide. Not when cancel is hidden
      // (confirmation-only dialogs must be answered).
      $('dlg').onclick = (ev) => { if (hasCancel && ev.target === $('dlg')) close(false); };
      $('dlg').classList.add('show');
    });
  }

  /* ================= state ================= */
  const state = {
    screen: 'home',
    project: null,
    buffer: null,       // original decoded AudioBuffer (untouched)
    viewBuffer: null,   // op-list rendered buffer (what plays)
    viewGen: 0,         // generation token: stale refreshView renders are discarded
    fileName: '',
    imports: [],        // [{name, buffer, size, type}]
    player: null,       // studio player
    chain: null,        // studio FX chain
    width: null,        // stereo width node set
    fx: null,           // current FX preset object
    redoStack: [],
    waveView: null,
    remix: { style: null, bpm: null },
    stemMix: null,      // stem-pipeline mix buffer (part 2)
    remixBuffer: null,  // preset-flow remix offline render (Round-6 W7 Issue 6: exportable)
    remixBufferName: '',
    slowed: { speed: 0.8, room: 'church', wet: 0.55, decay: 1.8, echo: 0.25, bass: 4, width: 1.2 },
    mastering: { preset: 'clean', ab: 'after', settings: null },
    exportDefaults: { format: 'mp3', bitrate: 192, sampleRate: 44100 },
    lastDelivery: null,
  };
  try {
    const d = JSON.parse(localStorage.getItem('ruhmix.exportDefaults') || 'null');
    if (d) state.exportDefaults = Object.assign(state.exportDefaults, d);
  } catch (e) {}

  function defaultFx() {
    return {
      eq3: [0, 0, 0], eq10: [0,0,0,0,0,0,0,0,0,0], filter: 19000, drive: 0,
      chorus: { on: false, rate: 1.2, depth: 0.004 },
      echo: { on: false, time: 0.375, fb: 0.35, wet: 0.35 },
      reverb: { on: false, room: 'hall', wet: 0.4 },
      comp: { on: true, thr: -18, ratio: 4, atk: 0.01, rel: 0.25 },
      out: 1.0,
      spatial: { mode: 'off', speed: 0.12, depth: 0.7 }, // 8D/3D/16D (fx.js makeSpatial)
    };
  }
  state.fx = defaultFx();

  /* ================= navigation ================= */
  const SCREENS = ['home','import','editor','remix','slowed','mashup','stems','aistem','mixer','fx','master','record','export','projects','settings','more','studio','v25create'];
  function show(name, fromPop) {
    if (!SCREENS.includes(name)) name = 'home';
    const prev = state.screen;
    state.screen = name;
    SCREENS.forEach((s) => {
      const el = $('screen-' + s);
      if (el) el.classList.toggle('active', s === name);
    });
    document.querySelectorAll('.navbtn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-screen') === name);
    });
    const sc = $('screen-' + name);
    if (sc) sc.scrollTop = 0;
    window.scrollTo(0, 0);
    // Back-stack: har screen change ko history me push karo taaki Android
    // back button screens me wapas navigate kare (sirf Home root pe exit
    // dialog aata hai — Java onBackPressed: canGoBack() false tabhi).
    // popstate se aayi navigation dobara push nahi hoti (loop se bacho).
    if (!fromPop && prev !== name) pushNavState(name);
    if (name === 'editor' && state.waveView) state.waveView.invalidate();
    try { if (RM.app.onShow) RM.app.onShow(name); } catch (e) {}
  }

  function pushNavState(name) {
    try {
      const st = history.state;
      if (st && st.screen === name) return; // duplicate push nahi
      const base = String(location.href).split('#')[0];
      history.pushState({ screen: name }, '', base + '#' + name);
    } catch (e) { /* file:// ya purana WebView: history na mile to back=exit dialog (pehle jaisa) */ }
  }

  // Android back (WebView.goBack) -> popstate: dialog khula ho to pehle use
  // band karo, warna pichhli screen dikhao. History position hamesha sync rehti hai.
  function onPopState(e) {
    const dlgEl = $('dlg');
    if (dlgEl && dlgEl.classList.contains('show')) {
      // Dialog ke upar back: history wapas lao + cancel available ho to use dabao
      // (confirmation-only dialog "must be answered" — wahi rehta hai).
      try {
        const base = String(location.href).split('#')[0];
        history.pushState({ screen: state.screen }, '', base + '#' + state.screen);
      } catch (err) {}
      const c = $('dlg-cancel');
      if (c && c.style.display !== 'none') { try { c.click(); } catch (err) {} }
      return;
    }
    const s = e && e.state && e.state.screen;
    show(SCREENS.includes(s) ? s : 'home', true);
  }

  function needAudio() {
    if (!state.buffer) {
      toast('Please import audio first');
      show('import');
      return false;
    }
    return true;
  }

  /* ================= studio audio path ================= */
  // player.insert -> fxChain.input ... fxChain.output -> width -> master
  function ensureStudio() {
    RM.audio.ensureCtx();
    const ctx = RM.audio.ensureCtx();
    if (!state.player) {
      state.player = RM.audio.makePlayer();
      state.player.onended = () => {
        const b = document.getElementById('ed-play');
        if (b) b.textContent = '▶ ' + t('play');
      };
      state.chain = RM.fx.makeChain(ctx);
      state.chain.applyPreset(state.fx);
      // stereo width: M/S matrix (neutral at width=1)
      const W = {};
      W.in = ctx.createGain();
      W.split = ctx.createChannelSplitter(2);
      W.midG = ctx.createGain(); W.midG.gain.value = 0.5;
      W.midG2 = ctx.createGain(); W.midG2.gain.value = 0.5;
      W.sideG = ctx.createGain(); W.sideG.gain.value = 0.5;
      W.sideG2 = ctx.createGain(); W.sideG2.gain.value = -0.5;
      W.merge = ctx.createChannelMerger(2);
      W.split2 = ctx.createChannelSplitter(2);
      W.wGain = ctx.createGain(); W.wGain.gain.value = 1; // width on side
      W.oL1 = ctx.createGain(); W.oL2 = ctx.createGain();
      W.oR1 = ctx.createGain(); W.oR2 = ctx.createGain(); W.oR2.gain.value = -1;
      W.merge2 = ctx.createChannelMerger(2);
      W.out = ctx.createGain();
      W.in.connect(W.split);
      W.split.connect(W.midG, 0); W.split.connect(W.midG2, 1);
      W.midG.connect(W.merge, 0, 0); W.midG2.connect(W.merge, 0, 0);
      W.split.connect(W.sideG, 0); W.split.connect(W.sideG2, 1);
      W.sideG.connect(W.wGain); W.sideG2.connect(W.wGain);
      W.wGain.connect(W.merge, 0, 1);
      W.merge.connect(W.split2);
      W.split2.connect(W.oL1, 0); W.split2.connect(W.oL2, 1);
      W.oL1.connect(W.merge2, 0, 0); W.oL2.connect(W.merge2, 0, 0);
      W.split2.connect(W.oR1, 0); W.split2.connect(W.oR2, 1);
      W.oR1.connect(W.merge2, 0, 1); W.oR2.connect(W.merge2, 0, 1);
      W.merge2.connect(W.out);
      state.width = W;
      // makePlayer default me insert→panner→gain→master jodta hai. Studio me insert
      // FX chain ka entry point hai — dry path yahan disconnect karte hain, warna
      // signal DOUBLE (+6dB) ho jata hai: limiter hamesha engaged rehta (pumping)
      // aur FX wet/dry balance galat ho jata hai. Pan/volume chain ke BAAD lagate
      // hain taaki setPan/setVolume kaam karte rahein (panner→gain→master juda hai).
      state.player.insert.disconnect();
      state.player.insert.connect(state.chain.input);
      state.chain.output.connect(W.in);
      W.out.connect(state.player.panner);
    }
    return state;
  }
  function setWidth(w) {
    ensureStudio();
    const ctx = RM.audio.ensureCtx();
    state.width.wGain.gain.setTargetAtTime(clamp(w, 0, 2), ctx.currentTime, 0.02);
  }
  // Offline stereo-width M/S matrix — ensureStudio wale live matrix jaisa
  // (width=1 → neutral). Export graph me lagta hai taaki "jo suna wahi export ho":
  // pehle export me ye stage missing thi, wide mixes playback se +1.63dB RMS tak
  // alag lagte the.
  function widthMatrix(oc, widthVal) {
    const W = {};
    W.in = oc.createGain();
    W.split = oc.createChannelSplitter(2);
    W.midG = oc.createGain(); W.midG.gain.value = 0.5;
    W.midG2 = oc.createGain(); W.midG2.gain.value = 0.5;
    W.sideG = oc.createGain(); W.sideG.gain.value = 0.5;
    W.sideG2 = oc.createGain(); W.sideG2.gain.value = -0.5;
    W.merge = oc.createChannelMerger(2);
    W.split2 = oc.createChannelSplitter(2);
    W.wGain = oc.createGain(); W.wGain.gain.value = widthVal; // side pe width
    W.oL1 = oc.createGain(); W.oL2 = oc.createGain();
    W.oR1 = oc.createGain(); W.oR2 = oc.createGain(); W.oR2.gain.value = -1;
    W.merge2 = oc.createChannelMerger(2);
    W.out = oc.createGain();
    W.in.connect(W.split);
    W.split.connect(W.midG, 0); W.split.connect(W.midG2, 1);
    W.midG.connect(W.merge, 0, 0); W.midG2.connect(W.merge, 0, 0);
    W.split.connect(W.sideG, 0); W.split.connect(W.sideG2, 1);
    W.sideG.connect(W.wGain); W.sideG2.connect(W.wGain);
    W.wGain.connect(W.merge, 0, 1);
    W.merge.connect(W.split2);
    W.split2.connect(W.oL1, 0); W.split2.connect(W.oL2, 1);
    W.oL1.connect(W.merge2, 0, 0); W.oL2.connect(W.merge2, 0, 0);
    W.split2.connect(W.oR1, 0); W.split2.connect(W.oR2, 1);
    W.oR1.connect(W.merge2, 0, 1); W.oR2.connect(W.merge2, 0, 1);
    W.merge2.connect(W.out);
    return W;
  }
  function applyFxToChain() {
    ensureStudio();
    state.chain.applyPreset(state.fx);
  }

  /* ================= project + audio loading ================= */
  function newProject(name) {
    stopAll();
    state.project = RM.proj.create(name);
    state.buffer = null;
    state.viewBuffer = null;
    state.viewGen++; // purane project ka koi in-flight render/peaks ab stale hai
    state.fileName = '';
    state.redoStack = [];
    if (state.waveView) state.waveView.setBuffer(null, new Float32Array(0));
    RM.proj.markDirty();
    show('import');
  }

  function loadAudioBuffer(buffer, name, audioRef) {
    stopAll();
    if (!state.project) state.project = RM.proj.create(name);
    state.buffer = buffer;
    state.viewBuffer = null;
    state.remixBuffer = null; // purane gaane ka remix render naye audio pe export na ho (Round-6)
    state.remixBufferName = '';
    state.fileName = name || 'audio';
    state.project.audioRef = audioRef || { name: state.fileName, size: 0, type: '', lastModified: 0 };
    state.project.ops = [];
    state.redoStack = [];
    state.cdxFx = null; // naya track -> one-tap highlight reset
    try { document.querySelectorAll('#cdx-fxgrid .cdx-fxcard').forEach((c) => c.classList.remove('on')); } catch (e) {}
    try { if (typeof cdxUpdateNow === 'function') cdxUpdateNow(); } catch (e) {}
    if (state.waveView) state.waveView.setBuffer(null, new Float32Array(0));
    RM.proj.invalidateView(buffer);
    refreshView().then(() => {
      RM.proj.autosave(state.project);
      toast(('Loaded: ') + state.fileName);
      if (state.screen === 'import') show('editor');
      if (RM.app.updateEditorMeta) RM.app.updateEditorMeta();
    }).catch(() => {
      // applyOps reject ho sakta hai (bahut badi file -> createBuffer OOM).
      // Bina catch ke unhandled rejection + "load ho gaya" ka jhootha bharosa.
      toast('Could not prepare audio — the file may be too large', 3500);
    });
  }

  // Re-render view buffer from op-list (cached when ops unchanged).
  // Generation token: rapid undo/redo (or op spam) fires concurrent chunked
  // renders; the LAST-INITIATED render must win, not the last-to-finish.
  function refreshView(onProgress) {
    if (!state.buffer) return Promise.resolve(null);
    const gen = ++state.viewGen;
    return RM.proj.applyOps(state.buffer, state.project.ops, onProgress).then((view) => {
      if (gen !== state.viewGen) return null; // superseded by a newer refresh
      state.viewBuffer = view;
      ensureStudio();
      const wasPlaying = state.player.playing;
      const pos = state.player.position();
      state.player.load(view);
      state.player.setRate(state.project.settings.speed || 1);
      state.player.setVolume(state.project.settings.volume != null ? state.project.settings.volume : 0.9);
      state.player.setPan(state.project.settings.pan || 0);
      if (wasPlaying) state.player.play(Math.min(pos, view.duration - 0.1));
      if (state.waveView) {
        const vgen = gen;
        RM.wave.getPeaks(view, 1200).then((peaks) => {
          // getPeaks async hai: tab tak tez undo/redo se NAYA view aa chuka
          // ho sakta hai. Bina gen-check ke purani peaks naya view overwrite
          // kar deti — waveform galat audio dikhata.
          if (vgen !== state.viewGen) return;
          state.waveView.setBuffer(view, peaks);
          if (RM.app.updateTrimShade) RM.app.updateTrimShade();
        });
      }
      return view;
    });
  }

  function pushOp(op) {
    state.project.ops.push(op);
    state.redoStack = [];
    RM.proj.autosave(state.project);
    return refreshView().catch(() => {
      // Render fail ho gaya (op apply crash / OOM): op ko wapas lo.
      // Root reason: ek fail hua op list me reh jaye to uske baad ki HAR
      // render fail hogi — project permanently "poisoned". Rollback se
      // project usable rehta hai aur user ko saaf message milta hai.
      const i = state.project.ops.lastIndexOf(op);
      if (i !== -1) state.project.ops.splice(i, 1);
      RM.proj.autosave(state.project);
      toast('Could not apply edit', 3000);
      return refreshView().catch(() => null);
    });
  }
  function undoOp() {
    // No project yet (no audio loaded): friendly toast, never a crash.
    const ops = state.project && state.project.ops;
    const op = ops && ops.pop();
    if (!op) { toast('Nothing to undo'); return; }
    state.redoStack.push(op);
    RM.proj.autosave(state.project);
    refreshView().catch(() => {
      toast('Could not apply edit', 3000);
    });
  }
  function redoOp() {
    const op = state.redoStack.pop();
    if (!op) { toast('Nothing to redo'); return; }
    state.project.ops.push(op);
    RM.proj.autosave(state.project);
    refreshView().catch(() => {
      const i = state.project.ops.lastIndexOf(op);
      if (i !== -1) state.project.ops.splice(i, 1);
      RM.proj.autosave(state.project);
      toast('Could not apply edit', 3000);
    });
  }

  function stopAll() {
    // Project/audio switch ya naya load: jo bhi baj raha hai, sab band.
    // Sirf studio player + mixer nahi — stem preview players, mastering
    // preview aur stem-mix preview bhi, warna purana audio bajta rehta hai.
    // (Metronome jaanboojhkar chalta rehta hai — wo independent practice
    // tool hai, uska apna stop button hai. Recording bhi user-action hai.)
    try { if (state.player) state.player.stop(true); } catch (e) {}
    try { if (RM.app.stopMixer) RM.app.stopMixer(); } catch (e) {}
    try { if (RM.app.stopStemPlayers) RM.app.stopStemPlayers(); } catch (e) {}
    try { if (RM.app.stopMstPreview) RM.app.stopMstPreview(); } catch (e) {}
    try { if (RM.remix && RM.remix.stemPipeline) RM.remix.stemPipeline.stopPreview(); } catch (e) {}
  }

  /* ================= import ================= */
  function pickAudio() {
    const nat = RM.audio.native;
    if (nat.method('pickAudio')) {
      try { nat.call('pickAudio'); return; }
      catch (e) { /* fall through to file input */ }
    }
    const inp = $('file-input');
    if (inp) inp.click();
    else toast('File picking is unavailable');
  }

  function fetchFileUrl(url) {
    // file:// URLs from the native cache: fetch() then XHR fallback.
    // XHR fallback hardened: correct 'arraybuffer' casing (capital-B 'arrayBuffer'
    // is an invalid enum value and gets silently ignored -> string response),
    // 30s timeout (hang = 'unreadable', never a silent stall), 0-byte -> empty buffer.
    // file: scheme par fetch() kabhi kaam nahi karta — sirf console error log
    // karke reject hota hai. Isliye file: URLs seedha XHR se lao (no console noise).
    let isFile = false;
    try { isFile = new URL(url, location.href).protocol === 'file:'; } catch (e) {}
    const viaFetch = () => fetch(url).then((r) => {
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      return r.arrayBuffer();
    });
    if (isFile) return fetchViaXhr(url);
    return viaFetch().catch(() => fetchViaXhr(url));
  }
  function fetchViaXhr(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      const timer = setTimeout(() => {
        try { xhr.abort(); } catch (e) {}
        reject(new Error('xhr timeout'));
      }, 30000);
      const settle = (fn, val) => { clearTimeout(timer); fn(val); };
      xhr.onload = () => {
        const good = xhr.status === 0 || xhr.status === 200;
        const resp = xhr.response;
        if (!good) { settle(reject, new Error('xhr ' + xhr.status)); return; }
        if (resp instanceof ArrayBuffer) { settle(resolve, resp); return; }
        if (resp == null) { settle(resolve, new ArrayBuffer(0)); return; } // 0-byte file
        // Last resort: string response (wrong responseType) -> latin-1 bytes.
        // Magic sniff will honestly reject it if the bytes got mangled.
        try {
          const s = String(resp);
          const u8 = new Uint8Array(s.length);
          for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xFF;
          settle(resolve, u8.buffer);
        } catch (e) { settle(reject, e); }
      };
      xhr.onerror = () => settle(reject, new Error('xhr error'));
      xhr.onabort = () => settle(reject, new Error('xhr aborted'));
      try { xhr.send(); } catch (e) { settle(reject, e); }
    });
  }

  /* ---------- hardened import error helpers ---------- */
  function importErr(kind, name) {
    if (window.RH && RH.classifyError) return RH.classifyError(kind, name);
    return { title: 'Import failed', msg: 'Could not import "' + name + '". Try another file.' };
  }
  function importErrBody(c, name) {
    return '<p>' + escapeHtml(c.msg) + '</p><p class="muted">' + escapeHtml(name) + '</p>';
  }
  function safeFileName(p) {
    // Java worker: window.onAudioPicked ab object bhejta hai {ok:[...], failed:[...]};
    // purana array format bhi supported. Naam me parens/Unicode/%20 toote nahi.
    let n = String(p == null ? '' : p);
    const i = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
    if (i >= 0) n = n.slice(i + 1);
    try { n = decodeURIComponent(n); } catch (e) { /* keep raw */ }
    return n || 'audio';
  }

  /* Staged decode fallback: direct -> strip-id3 -> frame-sync slice.
     Har stage ka naam console me log hota hai (diagnostics). */
  function tryDecodeStages(ab, name) {
    const RHh = window.RH || {};
    const candidates = [{ stage: 'direct', buf: ab }];
    if (RHh.stripId3v2) {
      try {
        const stripped = RHh.stripId3v2(ab);
        if (stripped !== ab && stripped && stripped.byteLength > 100) {
          candidates.push({ stage: 'strip-id3', buf: stripped });
        }
      } catch (e) {}
    }
    if (RHh.findFirstMp3Frame) {
      try {
        const off = RHh.findFirstMp3Frame(ab);
        if (off > 0) candidates.push({ stage: 'frame-sync', buf: ab.slice(off) });
      } catch (e) {}
    }
    let p = Promise.reject(new Error('start'));
    candidates.forEach((c) => {
      p = p.catch(() => {
        console.log('[import] decode stage: ' + c.stage + ' — ' + name);
        return RM.audio.decodeArrayBuffer(c.buf);
      });
    });
    return p;
  }

  function decodeAndAdd(ab, name, size, fileUrl) {
    const RHh = window.RH || {};
    // Stage 0: pre-decode sanity gate — fail -> classified dialog, Retry NAHI (sirf OK).
    const pre = RHh.precheckAudio ? RHh.precheckAudio(ab, name) : { ok: true };
    if (!pre.ok) {
      console.log('[import] precheck failed (' + pre.kind + '): ' + name + ' — ' + (pre.detail || ''));
      const c = importErr(pre.kind, name);
      return dialog(c.title, importErrBody(c, name), 'OK', null).then(() => null);
    }
    toast(('Decoding: ') + name);
    return tryDecodeStages(ab, name).then((buf) => {
      state.imports.unshift({ name, buffer: buf, size: size || ab.byteLength, type: '' });
      // Memory edge: har import poora decoded AudioBuffer pakadta hai
      // (10-min stereo ~100MB). List ko cap karo, warna 20-30 import = OOM.
      const MAX_IMPORTS = 12;
      if (state.imports.length > MAX_IMPORTS) {
        const dropped = state.imports.splice(MAX_IMPORTS);
        dropped.forEach((it) => RM.wave.dropPeaks(it.buffer));
        toast('Old imports removed to save memory', 2500);
      }
      renderImportList();
      return buf;
    }).catch(() => {
      const c = importErr('corrupt', name);
      return dialog(c.title, importErrBody(c, name),
        '🔁 Retry',
        'Cancel').then((retry) => {
          if (!retry) return null;
          // Retry: file DOBARA padho — purana (possibly corrupt) buffer reuse NAHI.
          // fileUrl (native copy) ho to fresh bytes fetch karo; file-input fallback
          // me same bytes se retry (wahan dobara padhna possible nahi).
          if (fileUrl) {
            console.log('[import] retry: re-reading bytes for ' + name);
            let refetch = String(fileUrl);
            if (/^https?:/i.test(refetch)) {
              refetch += (refetch.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + Date.now();
            }
            return fetchFileUrl(refetch)
              .then((fresh) => decodeAndAdd(fresh, name, fresh.byteLength, fileUrl))
              .catch(() => {
                const u = importErr('unreadable', name);
                return dialog(u.title, importErrBody(u, name), 'OK', null).then(() => null);
              });
          }
          return decodeAndAdd(ab, name, size, fileUrl);
        });
    });
  }

  // Called by the native shell: window.Android.pickAudio() / importMusic() result.
  // Dono formats: purana string array, aur naya {ok:[file://...], failed:[{name, reason}]}.
  /* ================= Auto Mashup picker interception (Worker 3) =================
     mashup-screen.js sets RM.mashupScreen.pickTarget = 1|2, then routes to the
     import screen via the exact #cdx-pick flow (RM.ux.pickMusic). At the two
     landing points where a picked track would normally enter the editor, the
     decoded AudioBuffer + name is delivered to the mashup slot instead, and
     the user is returned to the mashup screen. */
  function mashupIntercept(buffer, name) {
    const ms = window.RM && RM.mashupScreen;
    if (!ms || !ms.pickTarget || typeof ms.onPicked !== 'function') return false;
    try { ms.onPicked(ms.pickTarget, buffer, name); } catch (e) { console.log('[mashup] onPicked failed', e); }
    return true;
  }

  function handleAudioPicked(paths) {
    if (paths == null) return;
    let okList = [], failedList = [];
    if (Array.isArray(paths)) {
      okList = paths.slice();
    } else if (typeof paths === 'object') {
      if (Array.isArray(paths.ok)) okList = paths.ok.slice();
      else if (paths.ok != null) okList = [paths.ok];
      if (Array.isArray(paths.failed)) failedList = paths.failed.slice();
      else if (paths.failed != null) failedList = [paths.failed];
    } else {
      okList = [paths];
    }
    failedList.forEach((f) => {
      const fname = (f && f.name) ? safeFileName(f.name) : 'file';
      const reason = (f && f.reason) ? String(f.reason) : 'Unknown error';
      toast(('Could not read ') + fname + ': ' + reason, 3500);
    });
    if (!okList.length) {
      if (!failedList.length) toast('Nothing selected');
      return;
    }
    toast(('Loading… (') + okList.length + ')');
    let chain = Promise.resolve();
    okList.forEach((p) => {
      const url = String(p);
      const name = safeFileName(p);
      chain = chain.then(() => fetchFileUrl(url)
        .then((ab) => {
          // Size + magic diagnostic — har import pe. 0 bytes = turant 'unreadable',
          // misleading "Decode failed" KABHI nahi.
          const bytes = ab ? ab.byteLength : 0;
          console.log('[import]', name, bytes + ' bytes');
          if (window.RH && RH.sniffAudioType) {
            try { console.log('[import]', name, 'magic: ' + RH.sniffAudioType(ab)); } catch (e) {}
          }
          if (!bytes) {
            const c = importErr('unreadable', name);
            return dialog(c.title, importErrBody(c, name), 'OK', null).then(() => null);
          }
          return decodeAndAdd(ab, name, bytes, url);
        })
        .catch((err) => {
          console.log('[import] fetch failed for ' + name + ':', err && err.message);
          const c = importErr('unreadable', name);
          return dialog(c.title, importErrBody(c, name), 'OK', null).then(() => null);
        })
        .then((buf) => {
          // Ultra-simple (Hasnain): music picker se single track -> decode hote hi editor
          if (buf && music.directLoad) music.directBuf = { buffer: buf, name: name };
          return buf;
        }));
    });
    chain.then(() => {
      musicPendingClear();
      const d = music.directBuf;
      music.directLoad = false; music.directBuf = null;
      if (d && d.buffer) {
        // Mashup picker: pending pick -> buffer lands in the mashup slot.
        if (mashupIntercept(d.buffer, d.name)) return;
        // Ultra-simple: song tap -> seedha editor (koi "Use" button nahi)
        loadAudioBuffer(d.buffer, d.name, { name: d.name, size: 0, type: '', lastModified: Date.now() });
        return;
      }
      show('import');
    });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtSize(b) {
    if (!b) return '—';
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function renderImportList() {
    const box = $('import-list');
    if (!box) return;
    box.innerHTML = '';
    if (!state.imports.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">🎵</div>${'No audio yet — pick from above'}</div>`;
      return;
    }
    state.imports.forEach((it, idx) => {
      const d = document.createElement('div');
      d.className = 'import-item';
      d.innerHTML = `
        <div class="ii-main">
          <div class="ii-name">${escapeHtml(it.name)}</div>
          <div class="ii-meta">${fmtTime(it.buffer.duration)} • ${it.buffer.sampleRate} Hz • ${it.buffer.numberOfChannels === 2 ? 'Stereo' : 'Mono'} • ${fmtSize(it.size)}</div>
        </div>
        <button class="btn small" data-act="use">${'Use'}</button>
        <button class="btn small ghost" data-act="del">✕</button>`;
      d.querySelector('[data-act="use"]').addEventListener('click', () => {
        // Mashup picker (Files tab): "Use" delivers to the mashup slot.
        if (mashupIntercept(it.buffer, it.name)) return;
        loadAudioBuffer(it.buffer, it.name, { name: it.name, size: it.size, type: it.type, lastModified: Date.now() });
      });
      d.querySelector('[data-act="del"]').addEventListener('click', () => {
        RM.wave.dropPeaks(it.buffer);
        state.imports.splice(idx, 1);
        renderImportList();
      });
      box.appendChild(d);
    });
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================= music library (device MediaStore) =================
     Bridge contract (Java side):
       Android.listMusic()              -> window.onMusicListed(json)
       Android.importMusic(uri)         -> window.onAudioPicked({ok:[...], failed:[...]})
       Android.requestMusicPermission() -> (permission dialog) then re-list
     onMusicListed payload (liberal parse): JSON string ya object —
       {status:'ok', tracks:[{uri,title,artist,durationMs|duration}]} |
       {status:'permission-denied'} | 'permission-denied' | {status:'error', message}
     Bridge na ho to Music tab graceful hide hota hai. */
  const music = { state: 'idle', tracks: [], query: '', pending: null, error: '', directLoad: false, directBuf: null };
  function initImportTabs() {
    const tabF = $('tab-files'), tabM = $('tab-music');
    if (!tabF || !tabM) return;
    const nat = RM.audio.native;
    const hasMusic = nat.method('listMusic');
    tabM.style.display = hasMusic ? '' : 'none';
    if (!hasMusic) { switchImportTab('files'); return; }
    tabF.addEventListener('click', () => switchImportTab('files'));
    tabM.addEventListener('click', () => switchImportTab('music'));
    const sq = $('music-search');
    if (sq) sq.addEventListener('input', () => { music.query = sq.value || ''; renderMusicList(); });
    switchImportTab('music'); // UX-flow Demand 1: Music default tab — list bhi auto-load hoti hai
  }
  function switchImportTab(which) {
    $('tab-files').classList.toggle('active', which === 'files');
    $('tab-music').classList.toggle('active', which === 'music');
    $('pane-files').hidden = which !== 'files';
    $('pane-music').hidden = which !== 'music';
    if (which === 'music' && music.state === 'idle') loadMusic();
  }
  function loadMusic() {
    const nat = RM.audio.native;
    if (!nat.method('listMusic')) return;
    music.state = 'loading'; music.error = '';
    renderMusicList();
    try { nat.call('listMusic'); }
    catch (e) { music.state = 'error'; music.error = 'Could not open the music library.'; renderMusicList(); return; }
    // Safety: Java callback kabhi na aaye to spinner hamesha na ghume.
    setTimeout(() => {
      if (music.state === 'loading') {
        music.state = 'error'; music.error = 'The music library did not respond. Please try again.';
        renderMusicList();
      }
    }, 15000);
  }
  function handleMusicListed(payload) {
    let data = payload;
    if (typeof data === 'string') {
      const t = data.trim();
      if (t === 'permission-denied' || t === 'denied') { music.state = 'denied'; renderMusicList(); return; }
      try { data = JSON.parse(t); }
      catch (e) { music.state = 'error'; music.error = 'Could not read the music library.'; renderMusicList(); return; }
    }
    if (Array.isArray(data)) { music.state = 'ok'; music.tracks = data; renderMusicList(); return; }
    if (data && typeof data === 'object') {
      const st = String(data.status || '').toLowerCase();
      if (st === 'permission-denied' || st === 'denied' || data.permissionDenied) {
        music.state = 'denied';
      } else if (st === 'ok' || Array.isArray(data.tracks)) {
        music.state = 'ok'; music.tracks = Array.isArray(data.tracks) ? data.tracks : [];
      } else {
        music.state = 'error'; music.error = data.message || 'Could not read the music library.';
      }
      renderMusicList(); return;
    }
    music.state = 'error'; music.error = 'Could not read the music library.'; renderMusicList();
  }
  function fmtMusicDur(v) {
    let ms = Number(v);
    if (!isFinite(ms) || ms <= 0) return '—';
    const sec = ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms); // ms vs seconds heuristic
    return fmtTime(sec);
  }
  function renderMusicList() {
    const box = $('music-list');
    if (!box) return;
    box.innerHTML = '';
    const sq = $('music-search');
    if (sq) sq.style.display = (music.state === 'ok' && music.tracks.length) ? '' : 'none';
    if (music.state === 'loading') {
      box.innerHTML = '<div class="empty"><div class="spinner"></div><div>Loading your music…</div></div>';
      return;
    }
    if (music.state === 'denied') {
      const d = document.createElement('div');
      d.className = 'empty';
      d.innerHTML = '<div class="empty-icon">🔒</div><div><b>Permission needed</b></div>' +
        '<div class="muted">RuhMix needs access to your music library to list your songs.</div>';
      const b = document.createElement('button');
      b.className = 'btn primary'; b.textContent = 'Grant Permission';
      b.addEventListener('click', () => {
        try { RM.audio.native.call('requestMusicPermission'); } catch (e) {}
        setTimeout(loadMusic, 1000);
      });
      d.appendChild(b);
      box.appendChild(d);
      return;
    }
    if (music.state === 'error') {
      const d = document.createElement('div');
      d.className = 'empty';
      d.innerHTML = '<div class="empty-icon">⚠️</div><div>' + escapeHtml(music.error || 'Could not read the music library.') + '</div>';
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = 'Retry';
      b.addEventListener('click', loadMusic);
      d.appendChild(b);
      box.appendChild(d);
      return;
    }
    if (music.state === 'ok' && !music.tracks.length) {
      box.innerHTML = '<div class="empty"><div class="empty-icon">🎵</div><div>No music found on this device</div></div>';
      return;
    }
    const q = (music.query || '').toLowerCase().trim();
    const list = music.tracks.filter((t) => {
      if (!q) return true;
      return ((t.title || '') + ' ' + (t.artist || '')).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      box.innerHTML = '<div class="empty"><div class="empty-icon">🔎</div><div>No songs match your search</div></div>';
      return;
    }
    list.forEach((t) => {
      const title = String(t.title || 'Unknown title');
      const artist = String(t.artist || 'Unknown artist');
      const dur = fmtMusicDur(t.durationMs != null ? t.durationMs : t.duration);
      const d = document.createElement('div');
      d.className = 'import-item music-item';
      d.innerHTML = '<div class="ii-main"><div class="ii-name">' + escapeHtml(title) + '</div>' +
        '<div class="ii-meta">' + escapeHtml(artist) + ' • ' + escapeHtml(dur) + '</div></div>';
      if (music.pending === t.uri) d.classList.add('busy');
      d.addEventListener('click', () => importMusicTrack(t, d));
      box.appendChild(d);
    });
  }
  function importMusicTrack(t, rowEl) {
    const nat = RM.audio.native;
    if (!nat.method('importMusic')) { toast('Music import is unavailable'); return; }
    const title = String(t.title || 'song');
    music.pending = t.uri;
    music.directLoad = true; music.directBuf = null; // ultra-simple: song tap -> seedha editor
    if (rowEl) rowEl.classList.add('busy');
    toast(('Loading: ') + title);
    try { nat.call('importMusic', String(t.uri)); }
    catch (e) { music.pending = null; music.directLoad = false; music.directBuf = null; if (rowEl) rowEl.classList.remove('busy'); toast('Could not start import'); return; }
    // Safety: Java callback kabhi na aaye to row hamesha busy na rahe.
    setTimeout(() => {
      if (music.pending === t.uri) { music.pending = null; renderMusicList(); }
    }, 30000);
  }
  function musicPendingClear() {
    if (music.pending == null) return;
    music.pending = null;
    if (music.state === 'ok') renderMusicList();
  }

  /* ================= voice recorder (bridge) ================= */
  const rec = { recording: false, pending: false, startT: 0, timer: 0, path: null, fallback: null };
  function recActive() { return rec.recording || rec.pending; }
  function startRecording() {
    // Double-tap guard: native callback / getUserMedia resolve hone se pehle
    // doosra tap do recorder shuru kar deta tha (browser me mic leak tak).
    if (rec.recording || rec.pending) return;
    const nat = RM.audio.native;
    const name = 'ruhmix-rec-' + Date.now();
    if (nat.method('startRecording')) {
      rec.pending = true;
      nat.call('startRecording', name);
      // Safety: native callback kabhi na aaye to button hamesha ke liye dead na ho.
      setTimeout(() => { if (rec.pending && !rec.recording) rec.pending = false; }, 10000);
      return;
    }
    // Browser fallback: MediaRecorder (honest label)
    if (navigator.mediaDevices && window.MediaRecorder) {
      rec.pending = true;
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        if (!rec.pending) { stream.getTracks().forEach((tr) => tr.stop()); return; } // beech me cancel hua
        rec.pending = false;
        const mr = new MediaRecorder(stream);
        const chunks = [];
        mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        mr.onstop = () => {
          stream.getTracks().forEach((tr) => tr.stop());
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          blob.arrayBuffer().then((ab) => decodeAndAdd(ab, 'Voice Recording (browser).webm', ab.byteLength)
            .then((buf) => { if (buf) toast('Recording added'); }));
          rec.recording = false;
          updateRecUI();
        };
        mr.start();
        rec.fallback = mr;
        rec.recording = true;
        rec.startT = Date.now();
        updateRecUI();
        toast('Recording started (browser)');
      }).catch(() => { rec.pending = false; toast('Mic permission denied', 3000); });
      return;
    }
    toast('Recording unavailable on this device', 3000);
  }
  function stopRecording() {
    rec.pending = false;
    const nat = RM.audio.native;
    if (rec.fallback) { try { rec.fallback.stop(); } catch (e) {} rec.fallback = null; return; }
    if (nat.method('stopRecording')) { nat.call('stopRecording'); return; }
  }
  // Native callbacks (wired as globals below, per shell contract)
  function handleRecordingStarted(path) {
    rec.pending = false;
    rec.recording = true;
    rec.startT = Date.now();
    rec.path = path;
    updateRecUI();
    toast('Recording…');
  }
  function handleRecordingStopped(path) {
    rec.pending = false;
    rec.recording = false;
    updateRecUI();
    const p = path || rec.path;
    if (!p) { toast('Recording file not found', 3000); return; }
    toast('Decoding recording…');
    // NOTE: the shell records in the device's native format (3GP). We decode
    // whatever the device gives us — no false format claims in the UI.
    fetchFileUrl(p).then((ab) => RM.audio.decodeArrayBuffer(ab)).then((buf) => {
      const name = 'Voice Recording ' + new Date().toLocaleString();
      state.imports.unshift({ name, buffer: buf, size: ab.byteLength, type: '' });
      renderImportList();
      if (!state.project) state.project = RM.proj.create(name);
      loadAudioBuffer(buf, name, { name, size: ab.byteLength, type: '', lastModified: Date.now() });
      show('editor');
    }).catch(() => {
      toast('Could not decode the recording — format not supported on this device', 4000);
    });
  }
  function handleRecordingError(msg) {
    rec.pending = false;
    rec.recording = false;
    updateRecUI();
    toast(('Recording error: ') + cleanErrMsg(msg), 3500);
  }
  function updateRecUI() {
    const btn = $('rec-btn');
    const st = $('rec-status');
    if (btn) {
      btn.textContent = rec.recording ? ('■ Stop Recording') : ('● Start Recording');
      btn.classList.toggle('rec-on', rec.recording);
    }
    clearInterval(rec.timer);
    if (rec.recording && st) {
      const tickT = () => { st.textContent = fmtTime((Date.now() - rec.startT) / 1000) + (' — Recording…'); };
      tickT();
      rec.timer = setInterval(tickT, 500);
    } else if (st) {
      st.textContent = 'Ready';
    }
  }

  /* ================= update check ================= */
  function checkUpdate(manual) {
    const box = $('update-status');
    if (box) box.textContent = 'Checking…';
    fetch(VERSION_URL, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then((v) => {
      const remote = +v.versionCode || 0;
      if (remote > APP.versionCode) {
        if (box) box.textContent = '';
        dialog(
          'Update available',
          `<p><b>RuhMix ${escapeHtml(v.versionName || '')}</b> ${'is available.'}</p>` +
          (v.notes ? `<p class="muted">${escapeHtml(v.notes)}</p>` : '') +
          `<p class="muted">${'Download and install to update.'}</p>`,
          'Download',
          'Later'
        ).then((ok) => {
          if (!ok || !v.apkUrl) return;
          const nat = RM.audio.native;
          if (nat.method('downloadApk')) nat.call('downloadApk', v.apkUrl);
          else if (nat.method('openUrl')) nat.call('openUrl', v.apkUrl);
          else window.open(v.apkUrl, '_blank');
        });
      } else {
        if (box) box.textContent = 'You are on the latest version (1.0)';
        if (manual) toast('App is up to date ✓');
      }
    }).catch(() => {
      const msg = 'Check failed — check your internet connection';
      // #update-status Settings screen me hai — More screen se check karne par
      // wo hidden hota hai, to failure par toast dikhao taaki tap be-asar na lage.
      if (box && box.offsetParent) box.textContent = msg;
      else if (manual) toast(msg, 3000);
    });
  }

  // ---- placeholder: part 2/3 continue below ----
  return {
    APP, state, $, toast, dialog, cleanErrMsg, t, setLang, setTheme, loadTheme,
    show, needAudio, ensureStudio, setWidth, widthMatrix, applyFxToChain, defaultFx,
    onPopState, pushNavState,
    newProject, loadAudioBuffer, refreshView, pushOp, undoOp, redoOp, stopAll,
    pickAudio, handleAudioPicked, handleMusicListed, initImportTabs, switchImportTab, decodeAndAdd, fetchFileUrl, renderImportList, fmtTime, fmtSize, escapeHtml, tryDecodeStages,
    startRecording, stopRecording, recActive, handleRecordingStarted, handleRecordingStopped,
    handleRecordingError, updateRecUI,
    checkUpdate,
  };
})();

/* ---- Native shell contract: these globals MUST exist ----
   window.Android.pickAudio()        -> onAudioPicked(pathsArray)
   window.Android.startRecording(name)-> onRecordingStarted(path)
   window.Android.stopRecording()    -> onRecordingStopped(path) / onRecordingError(msg) */
window.onAudioPicked = function (paths) { RM.app.handleAudioPicked(paths); };
window.onMusicListed = function (json) { RM.app.handleMusicListed(json); };
window.onRecordingStarted = function (path) { RM.app.handleRecordingStarted(path); };
window.onRecordingStopped = function (path) { RM.app.handleRecordingStopped(path); };
window.onRecordingError = function (msg) { RM.app.handleRecordingError(msg); };
'use strict';
/* =====================================================================
   RuhMix — app.js (part 2)
   Editor (waveform + ops + transport), Auto Remix, Slowed+Reverb Studio,
   Stem Separator UI.
   ===================================================================== */
Object.assign(RM.app, (function () {
  const A = RM.app;
  const $ = A.$, clamp = RM.audio.clamp;
  const HI = () => false; // English-only build: language locked to English

  /* ============ guarded async ops: friendly English errors + Retry/Cancel ============
     Every async operation (export, remix generate, stem run, decode) runs inside
     this: on failure the user gets a friendly English message + [Retry] [Cancel].
     No generic crash ever — every error is caught. */
  function friendlyErr(e) {
    const m = String((e && e.message) || e || '');
    if (/cancel/i.test(m)) return null; // user-cancelled: not an error
    if (/network|fetch failed|failed to fetch|xhr|internet|offline|ERR_INTERNET/i.test(m))
      return 'Network problem. Check your connection and retry.';
    if (/decode|decoding/i.test(m))
      return 'Could not decode the audio file — the format may be unsupported.';
    if (/memory|allocation|too large|length/i.test(m))
      return 'File too large — ran out of memory. Try a smaller file.';
    if (/not supported/i.test(m))
      return 'This feature is not supported on this device/browser.';
    // Fallback: NEVER show the raw error verbatim — strip stack traces,
    // "XxxError:" prefixes and [object Object] via cleanErrMsg. If nothing
    // readable remains, show a plain generic message instead.
    const c = A.cleanErrMsg(m);
    if (!c) return 'Something went wrong. Please try again.';
    return ('Something went wrong: ') + c;
  }
  // title: dialog title. fn: () => Promise<value>. Resolves {ok, result?, cancelled?}.
  function guarded(title, fn) {
    const attempt = () => Promise.resolve()
      .then(fn)
      .then((result) => ({ ok: true, result }))
      .catch((e) => {
        const msg = friendlyErr(e);
        if (msg === null) return { ok: false, cancelled: true };
        return A.dialog(title,
          `<p>${A.escapeHtml(msg)}</p>`,
          '🔁 Retry',
          'Cancel').then((retry) => {
            if (retry) return attempt();
            return { ok: false, cancelled: true };
          });
      });
    return attempt();
  }

  // Flat (bypass) FX preset — for sources that are already mixed/mastered.
  function flatFx() {
    const f = A.defaultFx();
    f.comp.on = false;
    return f;
  }

  /* ================= editor ================= */
  function selRange() {
    const a = Math.max(0, parseFloat($('ed-sel-a').value) || 0);
    const b = Math.max(0, parseFloat($('ed-sel-b').value) || 0);
    // Selection hamesha CURRENT VIEW ke relative hai (ops view-relative
    // lagte hain). Original buffer ki duration se clamp karne par trim/cut
    // ke baad selection view se bahar nikal jati thi — cut tab chup-chaap
    // kuchh nahi kaatta tha lekin "Cut — selection is in the clipboard"
    // ka daava kar deta tha. View duration se clamp = sahi guard.
    const vb = A.state.viewBuffer || A.state.buffer;
    const dur = vb ? vb.duration : 0;
    return { a: clamp(Math.min(a, b), 0, dur), b: clamp(Math.max(a, b), 0, dur) };
  }
  function updateTrimShade() {
    const v = A.state.waveView;
    if (!v) return;
    const r = selRange();
    v.setTrim(r.b > r.a ? r.a : null, r.b > r.a ? r.b : null);
    v.invalidate();
  }
  // expose for part 1
  A.updateTrimShade = updateTrimShade;

  function updateEditorMeta() {
    const el = $('ed-meta');
    if (!el) return;
    if (!A.state.buffer) { el.textContent = 'No audio'; return; }
    const p = A.state.project;
    const base = `${A.state.fileName} • ${A.fmtTime(A.state.buffer.duration)} • ${A.state.buffer.sampleRate} Hz • ${p.ops.length} edits`;
    el.textContent = base;
  }
  A.updateEditorMeta = updateEditorMeta;

  function initEditor() {
    const cv = $('ed-wave');
    A.state.waveView = RM.wave.createView(cv);
    A.state.waveView.onSeek = (sec) => {
      if (!A.state.viewBuffer) return;
      A.ensureStudio();
      if (A.state.player.playing) A.state.player.play(sec);
      else { A.state.player.offset = sec; A.state.waveView.setPlayhead(sec); A.state.waveView.invalidate(); }
    };
    $('ed-zoom').addEventListener('input', (e) => A.state.waveView.setZoom(+e.target.value));
    $('ed-scroll').addEventListener('input', (e) => A.state.waveView.setScroll(+e.target.value / 100));
    ['ed-sel-a', 'ed-sel-b'].forEach((id) => $(id).addEventListener('input', updateTrimShade));

    $('ed-play').addEventListener('click', () => {
      if (!A.needAudio()) return;
      A.ensureStudio();
      A.applyFxToChain();
      const p = A.state.player;
      if (p.playing) { p.pause(); $('ed-play').textContent = '▶ ' + A.t('play'); }
      else {
        p.setRate(A.state.project.settings.speed || 1);
        if (p.play()) $('ed-play').textContent = '⏸ ' + A.t('pause');
      }
    });
    $('ed-stop').addEventListener('click', () => {
      // No player yet (no audio loaded): graceful no-op, never a crash.
      if (A.state.player) {
        A.state.player.stop();
        A.state.player.offset = 0;
      }
      if (A.state.waveView) A.state.waveView.setPlayhead(0);
      $('ed-play').textContent = '▶ ' + A.t('play');
    });
    A.state.player && (A.state.player.onended = () => {
      const b = $('ed-play'); if (b) b.textContent = '▶ ' + A.t('play');
    });

    $('ed-vol').addEventListener('input', (e) => {
      // Editor tab bottom-nav se bina audio ke bhi khul sakta hai: tab
      // project/player dono null hote hain — TypeError ke bajaye silent no-op.
      if (!A.state.project || !A.state.player) return;
      A.state.project.settings.volume = +e.target.value / 100;
      A.state.player.setVolume(A.state.project.settings.volume);
      $('ed-vol-v').textContent = e.target.value + '%';
      RM.proj.autosave(A.state.project);
    });
    $('ed-pan').addEventListener('input', (e) => {
      if (!A.state.project || !A.state.player) return;
      A.state.project.settings.pan = +e.target.value / 100;
      A.state.player.setPan(A.state.project.settings.pan);
      RM.proj.autosave(A.state.project);
    });
    $('ed-speed').addEventListener('input', (e) => {
      if (!A.state.project || !A.state.player) return;
      const r = +e.target.value / 100;
      A.state.project.settings.speed = r;
      A.state.player.setRate(r);
      $('ed-speed-v').textContent = r.toFixed(2) + '×';
      RM.proj.autosave(A.state.project);
    });
    $('ed-loop').addEventListener('click', (e) => {
      // No project yet (no audio loaded): friendly prompt, never a crash.
      if (!A.needAudio()) return;
      A.ensureStudio();
      const s = A.state.project.settings;
      s.loop = !s.loop;
      const p = A.state.player;
      // setLoop applies to the live source too, so toggling mid-playback
      // takes effect immediately (no restart needed).
      if (s.loop && A.state.viewBuffer) p.setLoop(true, 0, A.state.viewBuffer.duration);
      else p.setLoop(s.loop);
      e.target.classList.toggle('on', s.loop);
      RM.proj.autosave(A.state.project);
    });

    // ops — har op guardOp me: button op render hone tak disabled rehta hai,
    // taaki double-click/rapid-click se duplicate op ya overlapping render na ho.
    $('ed-trim').addEventListener('click', () => guardOp('ed-trim', async () => {
      if (!A.needAudio()) return;
      const r = selRange();
      if (r.b - r.a < 0.05) { A.toast('Make a selection first'); return; }
      await A.pushOp({ t: 'trim', a: r.a, b: r.b });
      updateEditorMeta();
    }));
    $('ed-cut').addEventListener('click', () => guardOp('ed-cut', async () => {
      if (!A.needAudio()) return;
      const r = selRange();
      if (r.b - r.a < 0.05) { A.toast('Make a selection first'); return; }
      const ok = await copyRange(r.a, r.b, null, true);
      if (!ok) return;
      await A.pushOp({ t: 'cut', a: r.a, b: r.b });
      A.toast('Cut — selection is in the clipboard');
      updateEditorMeta();
    }));
    $('ed-delete').addEventListener('click', () => guardOp('ed-delete', async () => {
      if (!A.needAudio()) return;
      const r = selRange();
      if (r.b - r.a < 0.05) { A.toast('Make a selection first'); return; }
      await A.pushOp({ t: 'cut', a: r.a, b: r.b });
      updateEditorMeta();
    }));
    $('ed-copy').addEventListener('click', () => guardOp('ed-copy', async () => {
      if (!A.needAudio()) return;
      const r = selRange();
      if (r.b - r.a < 0.05) { A.toast('Make a selection first'); return; }
      await copyRange(r.a, r.b);
    }));
    $('ed-paste').addEventListener('click', () => guardOp('ed-paste', async () => {
      if (!A.needAudio()) return;
      const cb = RM.proj.getClipboard();
      if (!cb) { A.toast('Clipboard is empty'); return; }
      const at = A.state.player ? A.state.player.position() : 0;
      // _clip snapshot: is paste ke baad copy/cut/split karne par bhi ye
      // paste wahi audio render karega jo paste ke waqt clipboard me tha.
      await A.pushOp({ t: 'paste', at, _clip: cb });
      updateEditorMeta();
    }));
    $('ed-split').addEventListener('click', () => guardOp('ed-split', async () => {
      if (!A.needAudio()) return;
      if (!A.state.viewBuffer) { A.toast('Preparing audio…'); return; }
      const p = A.state.player ? A.state.player.position() : 0;
      const dur = A.state.viewBuffer.duration;
      if (dur - p < 0.1) { A.toast('Cannot split near the end'); return; }
      const ok = await copyRange(p, dur, null, true);
      if (!ok) return;
      await A.pushOp({ t: 'cut', a: p, b: dur });
      A.toast('Split complete — the tail section is in the clipboard');
      updateEditorMeta();
    }));
    $('ed-duplicate').addEventListener('click', () => guardOp('ed-duplicate', async () => {
      if (!A.needAudio()) return;
      if (!A.state.viewBuffer) { A.toast('Preparing audio…'); return; }
      const dur = A.state.viewBuffer.duration;
      if (!(dur > 0.05)) { A.toast('Nothing to duplicate'); return; }
      const clip = await copyRange(0, dur, null, true);
      if (!clip) return;
      await A.pushOp({ t: 'paste', at: dur, _clip: clip });
      A.toast('Duplicated');
      updateEditorMeta();
    }));
    $('ed-fadein').addEventListener('click', () => askFade('fadein'));
    $('ed-fadeout').addEventListener('click', () => askFade('fadeout'));
    $('ed-gain-up').addEventListener('click', () => askGain(1));
    $('ed-gain-dn').addEventListener('click', () => askGain(-1));
    $('ed-reverse').addEventListener('click', () => guardOp('ed-reverse', async () => {
      if (!A.needAudio()) return;
      await A.pushOp({ t: 'reverse' });
      updateEditorMeta();
    }));
    $('ed-undo').addEventListener('click', () => { A.undoOp(); setTimeout(updateEditorMeta, 300); });
    $('ed-redo').addEventListener('click', () => { A.redoOp(); setTimeout(updateEditorMeta, 300); });

    // markers
    $('ed-marker-add').addEventListener('click', () => {
      if (!A.needAudio()) return;
      const t = A.state.player.position();
      const label = 'M' + (A.state.project.settings.markers.length + 1);
      A.state.project.settings.markers.push({ t, label });
      RM.proj.autosave(A.state.project);
      renderMarkers();
    });

    // playhead ticker
    setInterval(() => {
      const v = A.state.waveView;
      if (!v || A.state.screen !== 'editor') return;
      if (A.state.player && A.state.player.playing) {
        v.setPlayhead(A.state.player.position());
        v.draw();
        const tp = $('ed-time');
        if (tp && A.state.viewBuffer) tp.textContent = A.fmtTime(A.state.player.position()) + ' / ' + A.fmtTime(A.state.viewBuffer.duration);
      } else if (v._dirty) v.draw();
    }, 120);
  }

  // Rapid-click guard: jab tak ek op ka async kaam (copy/render) chal raha hai,
  // button disabled rehta hai — ek click = max ek op, overlapping render nahi.
  // Sath me 700ms ka double-tap window: tez op (chhota buffer) microtask me
  // pura ho jata hai — disabled hatne ke baad aane wale turant-dusre click ko
  // bhi ignore karna padta hai, warna 5 tez click = 5 op ban jate hain.
  const opBusyUntil = {};
  function guardOp(id, fn) {
    const b = $(id);
    const now = Date.now();
    if (b && b.disabled) return;
    if (opBusyUntil[id] && now - opBusyUntil[id] < 700) return;
    opBusyUntil[id] = now;
    if (b) b.disabled = true;
    const done = () => { if (b) b.disabled = false; };
    let r;
    try { r = fn(); } catch (e) { done(); throw e; }
    if (r && typeof r.then === 'function') r.then(done, done);
    else done();
  }

  // Fade In/Out: duration dialog -> {t:'fadein'|'fadeout', dur}
  function askFade(kind) {
    if (!A.needAudio()) return;
    const isIn = kind === 'fadein';
    const def = isIn ? 2 : 3;
    A.dialog(isIn ? 'Fade In' : 'Fade Out',
      '<p>Fade duration (seconds):</p>' +
      '<input id="dlg-num" type="number" class="numin" style="width:7em" value="' + def + '" min="0.1" max="60" step="0.1">',
      'Apply', 'Cancel').then((ok) => {
      if (!ok) return;
      let d = parseFloat(($('dlg-num') || {}).value);
      if (!Number.isFinite(d)) d = def;
      d = Math.min(60, Math.max(0.1, d)); // sane range
      guardOp(isIn ? 'ed-fadein' : 'ed-fadeout', async () => {
        await A.pushOp({ t: kind, dur: +d.toFixed(2) });
        updateEditorMeta();
      });
    });
  }

  // Gain: dB dialog -> {t:'gain', db} (sign button ka default hota hai, user badal sakta hai)
  function askGain(sign) {
    if (!A.needAudio()) return;
    A.dialog('Gain',
      '<p>Gain (dB, −24 to +24):</p>' +
      '<input id="dlg-num" type="number" class="numin" style="width:7em" value="' + (sign * 3) + '" min="-24" max="24" step="0.5">',
      'Apply', 'Cancel').then((ok) => {
      if (!ok) return;
      let db = parseFloat(($('dlg-num') || {}).value);
      if (!Number.isFinite(db)) db = sign * 3;
      db = Math.min(24, Math.max(-24, db)); // sane range
      if (Math.abs(db) < 0.01) { A.toast('Gain is 0 dB — nothing to do'); return; }
      guardOp(sign > 0 ? 'ed-gain-up' : 'ed-gain-dn', async () => {
        await A.pushOp({ t: 'gain', db: +db.toFixed(2) });
        updateEditorMeta();
      });
    });
  }

  // Returns the clipboard AudioBuffer on success, null on failure (callers
  // use it to snapshot _clip into paste ops).
  function copyRange(a, b, done, quiet) {
    const src = A.state.viewBuffer;
    if (!src) { A.toast('Preparing audio…'); return Promise.resolve(null); }
    const sr = src.sampleRate;
    const aS = Math.round(a * sr), bS = Math.min(src.length, Math.round(b * sr));
    const len = Math.max(1, bS - aS);
    const ctx = RM.audio.ensureCtx();
    const cb = ctx.createBuffer(src.numberOfChannels, len, sr);
    return RM.audio.runChunked(len, 1 << 18, (x, y) => {
      for (let c = 0; c < cb.numberOfChannels; c++) {
        const s = src.getChannelData(c), d = cb.getChannelData(c);
        for (let i = x; i < y; i++) d[i] = s[aS + i] || 0;
      }
    }).then(() => {
      RM.proj.setClipboard(cb);
      if (!quiet) A.toast('Copied');
      if (done) done();
      return cb;
    });
  }

  function renderMarkers() {
    const box = $('ed-markers');
    if (!box) return;
    const ms = A.state.project ? A.state.project.settings.markers : [];
    box.innerHTML = '';
    if (!ms.length) {
      box.innerHTML = '<div class="empty"><div class="empty-icon">📍</div>No markers yet — tap "＋ Marker" to add one.</div>';
    }
    ms.forEach((m, i) => {
      const d = document.createElement('div');
      d.className = 'marker-row';
      d.innerHTML = `<span>${A.escapeHtml(m.label)} — ${A.fmtTime(m.t)}</span>
        <button class="btn small" data-a="go">${'Go'}</button>
        <button class="btn small ghost" data-a="del">✕</button>`;
      d.querySelector('[data-a="go"]').addEventListener('click', () => {
        A.ensureStudio();
        if (A.state.player.playing) A.state.player.play(m.t);
        else { A.state.player.offset = m.t; A.state.waveView.setPlayhead(m.t); }
      });
      d.querySelector('[data-a="del"]').addEventListener('click', () => {
        ms.splice(i, 1); RM.proj.autosave(A.state.project); renderMarkers();
      });
      box.appendChild(d);
    });
    if (A.state.waveView) A.state.waveView.setMarkers(ms.map((m) => ({ t: m.t, label: m.label })));
  }
  A.renderMarkers = renderMarkers;

  /* ================= auto remix ================= */
  let remixBusy = false; // double-tap guard: heavy generate sirf ek baar
  function initRemix() {
    const grid = $('remix-grid');
    RM.remix.STYLES.forEach((s) => {
      const d = document.createElement('button');
      d.className = 'style-card';
      d.dataset.id = s.id;
      d.innerHTML = `<div class="sc-name">${A.escapeHtml(s.name)}</div><div class="sc-tag">${A.escapeHtml(s.tag)}</div>`;
      d.addEventListener('click', () => selectRemixStyle(s.id));
      grid.appendChild(d);
    });
    $('remix-generate').addEventListener('click', generateRemix);
    // Placeholder until a style is picked (avoids an empty bordered panel).
    if ($('remix-desc') && !$('remix-desc').innerHTML.trim()) {
      $('remix-desc').innerHTML = '<span class="muted">Select a style above to see its details, then tap Generate.</span>';
    }
    const stemPv = $('remix-stem-preview');
    if (stemPv) stemPv.addEventListener('click', toggleStemPreview);
    $('remix-preview').addEventListener('click', () => {
      if (!A.needAudio()) return;
      A.ensureStudio(); A.applyFxToChain();
      const p = A.state.player;
      if (p.playing) p.pause();
      else { const st = A.state.remix.style; const rt = (st === 'custom' && A.state.remix.custom) ? A.state.remix.custom.tempo : (st ? RM.remix.get(st).rate : 1); p.setRate(rt); p.play(0); }
    });
    // custom sliders
    ['c-tempo','c-reverb','c-echo','c-bass'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', () => { if (A.state.remix.style === 'custom') applyCustomRemix(); });
    });
  }
  function selectRemixStyle(id) {
    A.state.remix.style = id;
    document.querySelectorAll('.style-card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
    const s = RM.remix.get(id);
    $('remix-desc').innerHTML = `<b>${A.escapeHtml(s.name)}</b> — ${A.escapeHtml(s.tag)}` +
      (s.note ? `<div class="honest">${A.escapeHtml(s.note)}</div>` : '');
    $('remix-custom').style.display = id === 'custom' ? '' : 'none';
    if (id !== 'custom') {
      RM.remix.applyStyle(id, null, null);
      A.state.fx = JSON.parse(JSON.stringify(RM.remix.get(id).fx));
      A.applyFxToChain();
    } else applyCustomRemix();
  }
  function applyCustomRemix() {
    const tempo = (+$('c-tempo').value) / 100;
    const fx = A.defaultFx();
    fx.echo.on = true; fx.echo.time = 0.375; fx.echo.wet = (+$('c-echo').value) / 100 * 0.6;
    fx.reverb.on = true; fx.reverb.wet = (+$('c-reverb').value) / 100 * 0.7;
    fx.eq3[0] = ((+$('c-bass').value) / 100) * 10 - 2;
    A.state.fx = fx;
    A.state.remix.custom = { tempo, fx };
    A.applyFxToChain();
    $('remix-desc').innerHTML = `<b>Custom</b> — tempo ${(tempo).toFixed(2)}×`;
  }
  function generateRemix() {
    if (!A.needAudio()) return;
    // Double-tap guard: BPM detect + stem pipeline dono heavy hain; do run
    // parallel me status ladta aur CPU double hota.
    if (remixBusy) { A.toast('Generating remix — please wait'); return; }
    remixBusy = true;
    const genBtn = $('remix-generate');
    if (genBtn) genBtn.disabled = true;
    const finishRemix = () => {
      remixBusy = false;
      const g = $('remix-generate');
      if (g) g.disabled = false;
    };
    const id = A.state.remix.style || 'commercial';
    const status = $('remix-status');
    // Part 2: jab stem pack loaded ho (2-4 roles) -> stem-based pipeline; bina stems ke
    // purana preset-flow bilkul waisa hi rahe (koi regression nahi).
    if (RM.stems.packAvailable()) { generateStemRemix(id, status, finishRemix); return; }
    status.innerHTML = `<div class="load-row"><span class="spinner" aria-hidden="true"></span><span id="remix-plabel">Detecting BPM…</span></div>`;
    const setRemixLabel = (t) => { const lb = $('remix-plabel'); if (lb) lb.textContent = t; else status.textContent = t; };
    guarded('Auto Remix', () => RM.audio.detectBPM(A.state.buffer, (p) => {
      setRemixLabel(('Detecting BPM… ') + Math.round(p * 100) + '%');
    }).then((bpm) => {
      A.state.remix.bpm = bpm;
      const s = RM.remix.get(id);
      if (id === 'custom' && A.state.remix.custom) {
        A.state.fx = A.state.remix.custom.fx;
      } else {
        A.state.fx = JSON.parse(JSON.stringify(s.fx));
      }
      // sync echo to detected BPM (quarter note); fall back to 120 on undetectable (silent) input
      const beat = 60 / (bpm || 120);
      if (A.state.fx.echo.on) A.state.fx.echo.time = +(beat * 0.75).toFixed(3);
      A.applyFxToChain();
      A.ensureStudio();
      const rate = (id === 'custom' && A.state.remix.custom) ? A.state.remix.custom.tempo : s.rate;
      // AUTOPLAY FIX: Generate sirf remix taiyaar karta hai (BPM + style FX +
      // tempo) — khud NAHI bajata. Baj raha tha to naya tempo live lag jata
      // hai (setRate seamless hai); ruka tha to ruka rehta hai. Sunne ke liye
      // explicit Preview button hai.
      A.state.player.setRate(rate);
      // Round-6 (W7 Issue 6): preset-flow remix exportable banao — style rate +
      // style FX ke saath offline render, warna export me tempo kho jata hai.
      try {
        const rxBuf = A.state.buffer, rxRate = rate, rxFx = A.state.fx, rxName = s.name;
        // Tail: beat-synced echo can ring past 2.5s (fb=0.4/time=0.75 ->
        // 5.65s) — a fixed tail would chop it inside the remix buffer, and
        // the later export (tail: 0) could never recover it.
        const rxTail = RM.exp.tailForFx(rxFx);
        RM.exp.renderOffline(rxBuf, (oc, srcNode) => {
          const chain = RM.fx.makeChain(oc);
          chain.applyPreset(rxFx);
          srcNode.connect(chain.input);
          return chain.output;
        }, { sampleRate: rxBuf.sampleRate, rate: rxRate, tail: rxTail }).then((rb) => {
          A.state.remixBuffer = rb;
          A.state.remixBufferName = rxName + ' — ' + (A.state.fileName || 'remix');
          try { A.refreshExportSource(); } catch (e) {}
        }).catch(() => {});
      } catch (e) {}
      status.innerHTML = `✓ <b>${A.escapeHtml(s.name)}</b> — BPM ${bpm}, tempo ${rate.toFixed(2)}×` +
        (s.note ? `<div class="honest">${A.escapeHtml(s.note)}</div>` : '') +
        `<div class="hint">Tap <b>Preview</b> to hear it.</div>`;
      A.toast('Remix ready — tap Preview');
    })).then((r) => {
      finishRemix();
      if (!r.ok) status.textContent = r.cancelled
        ? ('Cancelled')
        : ('BPM detection failed');
    });
  }

  // Stem-based pipeline: stems -> per-stem FX -> arrange -> mix -> master.
  function generateStemRemix(id, status, finishRemix) {
    const pack = RM.stems.getStemPack();
    const srcName = pack.source === 'ai' ? ('AI stems') : ('Spectral bands (DSP)');
    A.stopAll();
    RM.remix.stemPipeline.stopPreview();
    status.innerHTML = `<div class="progress"><div class="pbar" id="remix-pbar"></div></div><div id="remix-plabel">${'Starting…'}</div>`;
    const setP = (label, frac) => {
      const bar = $('remix-pbar'), lb = $('remix-plabel');
      if (bar) bar.style.width = Math.round(frac * 100) + '%';
      if (lb) lb.textContent = label;
      status.setAttribute('data-stage', label);
    };
    guarded('Stem Remix', () => {
      const customTempo = (id === 'custom' && A.state.remix.custom) ? A.state.remix.custom.tempo : null;
      const customFx = (id === 'custom' && A.state.remix.custom) ? A.state.remix.custom.fx : null;
      return RM.remix.stemPipeline.generate(id, pack, { customTempo, customFx }, setP).then((res) => {
        A.state.stemMix = res.buffer;
        A.state.remix.bpm = res.bpm;
        // AUTOPLAY FIX: stem remix generate hone pe khud NAHI bajta — sunne
        // ke liye explicit Preview button (toggleStemPreview) hai.
        status.innerHTML = `✓ <b>${A.escapeHtml(res.styleName)}</b> — BPM ${res.bpm}, tempo ${res.rate.toFixed(2)}× — ${'ready'}` +
          `<div class="honest">🎤 ${A.escapeHtml(srcName)} — ${pack.roles.length}-stem pipeline (per-stem FX → arrange → mix → master)</div>` +
          `<div class="hint">Tap <b>Preview</b> to hear it.</div>`;
        A.toast('Stem remix ready — tap Preview');
      });
    }).then((r) => {
      if (finishRemix) finishRemix();
      if (!r.ok) status.innerHTML = r.cancelled
        ? ('Cancelled')
        : ('Stem remix failed');
    });
  }

  // Remix screen badge: stem pack available?
  function updateRemixStemBadge() {
    const el = $('remix-stem-badge');
    if (!el) return;
    if (RM.stems.packAvailable()) {
      const pack = RM.stems.getStemPack();
      const n = pack.source === 'ai' ? ('AI stems (cloud)') : (pack.source === 'hf' ? ('AI stems (Hugging Face — Vocals + Instrumental)') : ('Spectral bands (DSP)'));
      el.innerHTML = `🎤 <b>${pack.roles.length} stems loaded</b> — ${A.escapeHtml(n)}: press Generate to run the stem pipeline.`;
      el.style.display = '';
      const pv = $('remix-stem-preview');
      if (pv) pv.style.display = A.state.stemMix ? '' : 'none';
    } else {
      el.style.display = 'none';
      const pv = $('remix-stem-preview');
      if (pv) pv.style.display = 'none';
    }
  }
  function toggleStemPreview() {
    if (RM.remix.stemPipeline.isPreviewing()) RM.remix.stemPipeline.stopPreview();
    else if (A.state.stemMix) { A.stopAll(); RM.remix.stemPipeline.preview(A.state.stemMix); }
    else A.toast('Generate first');
  }

  /* ================= slowed + reverb studio ================= */
  const SLOWED_PRESETS = [
    { id: 'deep', name: 'Deep Slow', speed: 0.75, room: 'church', wet: 0.6, echo: 0.2, bass: 5, width: 1.2 },
    { id: 'dreamy', name: 'Dreamy', speed: 0.85, room: 'hall', wet: 0.55, echo: 0.35, bass: 2, width: 1.4 },
    { id: 'dark', name: 'Dark', speed: 0.7, room: 'church', wet: 0.65, echo: 0.15, bass: 7, width: 1.0 },
    { id: 'romantic', name: 'Romantic', speed: 0.9, room: 'hall', wet: 0.45, echo: 0.3, bass: 1, width: 1.3 },
    { id: 'lofi', name: 'Lofi', speed: 0.88, room: 'room', wet: 0.35, echo: 0.4, bass: 3, width: 1.1 },
    { id: 'atmo', name: 'Atmospheric', speed: 0.8, room: 'church', wet: 0.7, echo: 0.45, bass: 0, width: 1.5 },
  ];
  function initSlowed() {
    const grid = $('slowed-presets');
    SLOWED_PRESETS.forEach((p) => {
      const d = document.createElement('button');
      d.className = 'style-card';
      d.innerHTML = `<div class="sc-name">${A.escapeHtml(p.name)}</div><div class="sc-tag">${p.speed}×</div>`;
      d.addEventListener('click', () => applySlowedPreset(p, d));
      grid.appendChild(d);
    });
    const bind = (id, key, fmt) => {
      $(id).addEventListener('input', (e) => {
        A.state.slowed[key] = +e.target.value;
        const v = $(id + '-v'); if (v) v.textContent = fmt(+e.target.value);
        applySlowedLive();
      });
    };
    bind('sl-speed', 'speed', (v) => v.toFixed(2) + '×');
    bind('sl-wet', 'wet', (v) => Math.round(v * 100) + '%');
    bind('sl-echo', 'echo', (v) => Math.round(v * 100) + '%');
    bind('sl-bass', 'bass', (v) => (v > 0 ? '+' : '') + v + ' dB');
    bind('sl-width', 'width', (v) => v.toFixed(1));
    $('sl-room').addEventListener('change', (e) => { A.state.slowed.room = e.target.value; applySlowedLive(); });
    $('sl-play').addEventListener('click', () => {
      if (!A.needAudio()) return;
      applySlowedLive();
      A.ensureStudio();
      const p = A.state.player;
      if (p.playing) p.pause(); else p.play(0);
    });
  }
  function applySlowedPreset(p, el) {
    document.querySelectorAll('#slowed-presets .style-card').forEach((c) => c.classList.remove('sel'));
    if (el) el.classList.add('sel');
    Object.assign(A.state.slowed, { speed: p.speed, room: p.room, wet: p.wet, echo: p.echo, bass: p.bass, width: p.width });
    $('sl-speed').value = p.speed; $('sl-speed-v').textContent = p.speed.toFixed(2) + '×';
    $('sl-wet').value = p.wet; $('sl-wet-v').textContent = Math.round(p.wet * 100) + '%';
    $('sl-echo').value = p.echo; $('sl-echo-v').textContent = Math.round(p.echo * 100) + '%';
    $('sl-bass').value = p.bass; $('sl-bass-v').textContent = (p.bass > 0 ? '+' : '') + p.bass + ' dB';
    $('sl-width').value = p.width; $('sl-width-v').textContent = p.width.toFixed(1);
    $('sl-room').value = p.room;
    applySlowedLive();
  }
  function applySlowedLive() {
    const s = A.state.slowed;
    const fx = A.defaultFx();
    fx.eq3[0] = s.bass;
    fx.filter = 16000;
    fx.reverb.on = true; fx.reverb.room = s.room; fx.reverb.wet = s.wet;
    fx.echo.on = s.echo > 0.02; fx.echo.time = 0.45; fx.echo.fb = 0.35; fx.echo.wet = s.echo * 0.6;
    A.state.fx = fx;
    A.applyFxToChain();
    A.setWidth(s.width);
    A.ensureStudio();
    A.state.player.setRate(s.speed);
  }

  /* ================= stems UI ================= */
  let stemPlayers = [];
  let stemBusy = false; // double-tap guard: separation heavy hai, ek hi run
  function initStems() {
    const grid = $('stems-grid');
    RM.stems.ENGINES.forEach((e) => {
      const d = document.createElement('div');
      d.className = 'engine-card';
      d.innerHTML = `
        <div class="ec-name">${A.escapeHtml(e.name)} <span class="beta">BETA</span></div>
        <div class="ec-desc">${A.escapeHtml(e.desc)}</div>
        <div class="honest">${A.escapeHtml(e.note)}</div>
        <button class="btn primary block" data-run="${e.id}">${'Separate'}</button>`;
      d.querySelector('[data-run]').addEventListener('click', () => runStemEngine(e.id));
      grid.appendChild(d);
    });
  }
  function stopStemPlayers() {
    stemPlayers.forEach((p) => { try { p.stop(true); p.dispose(); } catch (e) {} });
    stemPlayers = [];
    try { if (RM.stemDeck) RM.stemDeck.stopAllDecks(); } catch (e) {}
  }
  // Stem role for the shared deck, per DSP engine output name.
  function dspRole(engineId, name) {
    const low = String(name || '').toLowerCase();
    if (engineId === 'vocalcut') return low.indexOf('center') !== -1 ? 'vocal' : 'other';
    if (engineId === 'hpss') return (low.indexOf('drum') !== -1 || low.indexOf('percussive') !== -1) ? 'drums' : 'other';
    if (engineId === 'bass') return low.indexOf('bass') !== -1 ? 'bass' : 'other';
    if (engineId === 'spectral') {
      if (low.indexOf('low-mid') !== -1) return 'lowmid';
      if (low.indexOf('presence') !== -1) return 'presence';
      if (low.indexOf('air') !== -1) return 'air';
      return 'low';
    }
    return 'other';
  }
  function runStemEngine(id) {
    if (!A.needAudio()) return;
    if (stemBusy) { A.toast('Separation is running — please wait'); return; }
    stemBusy = true;
    const runBtns = Array.from(document.querySelectorAll('#stems-grid [data-run]'));
    runBtns.forEach((b) => { b.disabled = true; });
    const status = $('stems-status');
    const results = $('stems-results');
    results.innerHTML = '';
    stopStemPlayers();
    A.stopAll();
    const eng = RM.stems.ENGINES.find((e) => e.id === id);
    status.innerHTML = `<div class="load-row"><span class="spinner" aria-hidden="true"></span><span id="stems-plabel">${A.escapeHtml(eng.name)}…</span></div><div class="progress"><div class="pbar" id="stems-pbar"></div></div>`;
    const t0 = Date.now();
    guarded('Stem Separator', () => RM.stems.run(id, A.state.viewBuffer || A.state.buffer, (p, label) => {
      const bar = $('stems-pbar'), lb = $('stems-plabel');
      if (bar) bar.style.width = Math.round(p * 100) + '%';
      if (lb) lb.textContent = (label || eng.name) + ' ' + Math.round(p * 100) + '%';
    })).then((r) => {
      stemBusy = false;
      runBtns.forEach((b) => { b.disabled = false; });
      if (!r.ok) {
        if (!r.cancelled) status.innerHTML = `<div class="err">${'Failed'}</div>`;
        return;
      }
      const stems = r.result;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      status.innerHTML = `<div class="ok">${'Done'} (${secs}s) — ${stems.length} stems</div><div class="honest">${A.escapeHtml(eng.note)}</div>`;
      const deckBox = document.createElement('div');
      results.appendChild(deckBox);
      try {
        RM.stemDeck.render(deckBox, stems.map((s) => ({
          name: s.name, buffer: s.buffer, role: dspRole(id, s.name), badge: 'DSP',
        })), {
          title: '✂️ ' + eng.name + ' — ' + stems.length + ' outputs',
          experimental: true,
        });
      } catch (e) {
        deckBox.innerHTML = '<div class="err">Could not display the stems.</div>';
      }
      // 4-band spectral split -> honestly-labelled 4-role pack for Auto Remix testing
      if (id === 'spectral' && stems.length === 4) {
        const b = document.createElement('button');
        b.className = 'btn primary block';
        b.style.marginTop = '10px';
        b.textContent = '⚡ Use in Auto Remix (4 bands)';
        b.addEventListener('click', () => {
          try {
            RM.stems.setStemPack({
              source: 'dsp-spectral',
              roles: [
                { role: 'low',     label: stems[0].name + ' (band)', buffer: stems[0].buffer },
                { role: 'lowmid',  label: stems[1].name + ' (band)', buffer: stems[1].buffer },
                { role: 'presence',label: stems[2].name + ' (band)', buffer: stems[2].buffer },
                { role: 'air',     label: stems[3].name + ' (band)', buffer: stems[3].buffer },
              ],
            });
            A.toast('4 bands ready for Auto Remix ✓');
            A.show('remix');
          } catch (e) {
            A.toast(('Failed: ') + A.cleanErrMsg(e.message || e), 3000);
          }
        });
        results.appendChild(b);
        const note = document.createElement('div');
        note.className = 'honest';
        note.textContent = 'Note: these are frequency bands, not true instrument isolation. AI stems (vocal/drums/bass/other) will be used when available.';
        results.appendChild(note);
      }
      A.toast('Stems ready');
    });
  }

  return {
    initEditor, initRemix, initSlowed, initStems, runStemEngine,
    updateEditorMeta, renderMarkers, updateTrimShade, stopStemPlayers,
    SLOWED_PRESETS,
    guarded, friendlyErr, flatFx,
    generateRemix, toggleStemPreview, updateRemixStemBadge,
  };
  })());
'use strict';
/* =====================================================================
   RuhMix — app.js (part 3)
   Multitrack mixer, FX rack, mastering, beat tools, export screen,
   projects, settings, RuhMix Pro, home, init.
   ===================================================================== */
Object.assign(RM.app, (function () {
  const A = RM.app;
  const $ = A.$, clamp = RM.audio.clamp;
  const HI = () => false; // English-only build: language locked to English

  /* ================= multitrack mixer (6 tracks) ================= */
  const mixer = { tracks: [] };
  const MIXER_TRACK_NAMES = ['VOCAL', 'DRUMS', 'BASS', 'OTHER', 'BEAT', 'FX'];
  function initMixer() {
    const box = $('mixer-tracks');
    for (let i = 0; i < MIXER_TRACK_NAMES.length; i++) {
      const tr = { id: i, name: MIXER_TRACK_NAMES[i], buffer: null, player: null, vol: 0.9, pan: 0, mute: false, solo: false };
      mixer.tracks.push(tr);
      const d = document.createElement('div');
      d.className = 'track';
      d.id = 'mx-track-' + i;
      d.innerHTML = `
        <div class="tr-head"><span class="tr-name">${tr.name}</span><span class="tr-src muted"></span></div>
        <div class="tr-row">
          <button class="btn small" data-a="load">${'Load'}</button>
          <button class="btn small" data-a="play">▶</button>
          <button class="btn small tog" data-a="mute">M</button>
          <button class="btn small tog" data-a="solo">S</button>
        </div>
        <div class="tr-row"><label>Vol</label><input type="range" min="0" max="120" value="90" data-a="vol"><span data-a="volv">90%</span></div>
        <div class="tr-row"><label>Pan</label><input type="range" min="-100" max="100" value="0" data-a="pan"><span data-a="panv">C</span></div>`;
      box.appendChild(d);
      wireTrack(d, tr);
    }
    $('mx-play-all').addEventListener('click', () => {
      RM.audio.ensureCtx();
      mixer.tracks.forEach((tr) => {
        if (!tr.buffer) return;
        if (!tr.player) { tr.player = RM.audio.makePlayer(); tr.player.load(tr.buffer); }
        applyTrackMix(tr);
        tr.player.play(0);
      });
      refreshTrackUI();
    });
    $('mx-stop-all').addEventListener('click', stopMixer);
    // v26 (I5): "Export Mix" — offline mixdown (vol/pan/mute/solo) -> export flow.
    $('mx-export-mix').addEventListener('click', () => {
      if (window.RM && RM.v26mixdown) RM.v26mixdown.exportMixerMix();
      else A.toast('Mixdown not ready');
    });
  }
  function stopMixer() {
    mixer.tracks.forEach((tr) => { try { if (tr.player) tr.player.stop(true); } catch (e) {} });
    refreshTrackUI();
  }
  A.stopMixer = stopMixer;
  function applyTrackMix(tr) {
    if (!tr.player) return;
    const anySolo = mixer.tracks.some((x) => x.solo && x.buffer);
    const audible = !tr.mute && (!anySolo || tr.solo);
    tr.player.setVolume(audible ? tr.vol : 0);
    tr.player.setPan(tr.pan);
  }
  function refreshTrackUI() {
    mixer.tracks.forEach((tr) => {
      const d = $('mx-track-' + tr.id);
      if (!d) return;
      d.querySelector('.tr-name').textContent = tr.name;
      d.querySelector('.tr-src').textContent = tr.buffer ? A.fmtTime(tr.buffer.duration) : ('Empty');
      d.querySelector('[data-a="mute"]').classList.toggle('on', tr.mute);
      d.querySelector('[data-a="solo"]').classList.toggle('on', tr.solo);
      d.querySelector('[data-a="play"]').textContent = (tr.player && tr.player.playing) ? '⏸' : '▶';
    });
  }
  function wireTrack(d, tr) {
    const q = (s) => d.querySelector(s);
    q('[data-a="load"]').addEventListener('click', () => showTrackLoadMenu(tr));
    q('[data-a="play"]').addEventListener('click', () => {
      if (!tr.buffer) { A.toast('Load audio into the track first'); return; }
      RM.audio.ensureCtx();
      if (!tr.player) { tr.player = RM.audio.makePlayer(); tr.player.load(tr.buffer); }
      if (tr.player.playing) tr.player.pause();
      else { applyTrackMix(tr); tr.player.play(0); }
      refreshTrackUI();
    });
    q('[data-a="mute"]').addEventListener('click', () => { tr.mute = !tr.mute; mixer.tracks.forEach(applyTrackMix); refreshTrackUI(); });
    q('[data-a="solo"]').addEventListener('click', () => { tr.solo = !tr.solo; mixer.tracks.forEach(applyTrackMix); refreshTrackUI(); });
    q('[data-a="vol"]').addEventListener('input', (e) => {
      tr.vol = +e.target.value / 100;
      q('[data-a="volv"]').textContent = e.target.value + '%';
      applyTrackMix(tr);
    });
    q('[data-a="pan"]').addEventListener('input', (e) => {
      tr.pan = +e.target.value / 100;
      q('[data-a="panv"]').textContent = tr.pan === 0 ? 'C' : (tr.pan < 0 ? 'L' : 'R') + Math.abs(Math.round(tr.pan * 100));
      applyTrackMix(tr);
    });
  }
  function showTrackLoadMenu(tr) {
    const opts = [];
    if (A.state.viewBuffer) opts.push({ label: ('Current project'), buf: A.state.viewBuffer });
    RM.stems.results.forEach((s) => opts.push({ label: 'Stem: ' + s.name, buf: s.buffer }));
    A.state.imports.forEach((it) => opts.push({ label: it.name, buf: it.buffer }));
    if (!opts.length) { A.toast('Nothing to load'); return; }
    const body = opts.map((o, i) => `<button class="btn block listbtn" data-i="${i}">${A.escapeHtml(o.label)}</button>`).join('');
    A.dialog('Load into track', body, null, 'Cancel').then(() => {});
    document.querySelectorAll('#dlg-body .listbtn').forEach((b) => {
      b.addEventListener('click', () => {
        const o = opts[+b.dataset.i];
        tr.buffer = o.buf; tr.name = Array.from(o.label).slice(0, 28).join('');
        if (tr.player) { try { tr.player.dispose(); } catch (e) {} tr.player = null; }
        $('dlg').classList.remove('show');
        refreshTrackUI();
      });
    });
  }
  // Stems/other screens use this to drop a buffer into the mixer.
  // AI stems auto-route to their matching slot (Vocal→0, Drums→1,
  // Bass→2, Other→3, Guitar→4, Piano→5); anything else goes to the
  // first free track.
  function sendToMixer(buffer, name) {
    const low = String(name || '').toLowerCase();
    const SLOT = [['vocal', 0], ['drum', 1], ['bass', 2], ['other', 3], ['guitar', 4], ['piano', 5]];
    let tr = null;
    for (const [kw, idx] of SLOT) {
      if (low.indexOf(kw) !== -1 && mixer.tracks[idx]) { tr = mixer.tracks[idx]; break; }
    }
    if (!tr) tr = mixer.tracks.find((x) => !x.buffer) || mixer.tracks[0];
    tr.buffer = buffer;
    tr.name = Array.from(name || 'Audio').slice(0, 28).join('');
    if (tr.player) { try { tr.player.dispose(); } catch (e) {} tr.player = null; }
    refreshTrackUI();
    A.toast(('Sent to mixer: ') + tr.name);
    return true;
  }
  A.sendToMixer = sendToMixer;

  /* ================= FX rack ================= */
  function initFxRack() {
    const fx = A.state.fx;
    const bind3 = (id, idx) => {
      $(id).addEventListener('input', (e) => {
        fx.eq3[idx] = +e.target.value;
        $(id + '-v').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + ' dB';
        A.applyFxToChain();
      });
    };
    bind3('fx-bass', 0); bind3('fx-mid', 1); bind3('fx-treble', 2);
    // 10-band
    const eq10box = $('fx-eq10');
    RM.fx.EQ10_FREQS.forEach((f, i) => {
      const w = document.createElement('div');
      w.className = 'eq10b';
      const label = f >= 1000 ? (f / 1000) + 'k' : f;
      w.innerHTML = `<input type="range" min="-15" max="15" value="0" data-i="${i}" aria-label="${label} Hz"><span>${label}</span>`;
      w.querySelector('input').addEventListener('input', (e) => {
        fx.eq10[i] = +e.target.value;
        A.applyFxToChain();
      });
      eq10box.appendChild(w);
    });
    const S = (id, fn) => $(id).addEventListener('input', (e) => { fn(+e.target.value); A.applyFxToChain(); });
    const C = (id, fn) => $(id).addEventListener('change', (e) => { fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value); A.applyFxToChain(); });
    S('fx-filter', (v) => { fx.filter = v; $('fx-filter-v').textContent = v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : v + ' Hz'; });
    S('fx-drive', (v) => { fx.drive = v / 100; $('fx-drive-v').textContent = v + '%'; });
    C('fx-chorus-on', (v) => fx.chorus.on = v);
    S('fx-chorus-rate', (v) => fx.chorus.rate = v / 10);
    S('fx-chorus-depth', (v) => fx.chorus.depth = v / 100000);
    C('fx-echo-on', (v) => fx.echo.on = v);
    S('fx-echo-time', (v) => { fx.echo.time = v / 1000; $('fx-echo-time-v').textContent = v + ' ms'; });
    S('fx-echo-fb', (v) => { fx.echo.fb = v / 100; $('fx-echo-fb-v').textContent = v + '%'; });
    S('fx-echo-wet', (v) => { fx.echo.wet = v / 100; $('fx-echo-wet-v').textContent = v + '%'; });
    C('fx-reverb-on', (v) => fx.reverb.on = v);
    C('fx-reverb-room', (v) => fx.reverb.room = v);
    S('fx-reverb-wet', (v) => { fx.reverb.wet = v / 100; $('fx-reverb-wet-v').textContent = v + '%'; });
    C('fx-comp-on', (v) => fx.comp.on = v);
    S('fx-comp-thr', (v) => { fx.comp.thr = v; $('fx-comp-thr-v').textContent = v + ' dB'; });
    S('fx-comp-ratio', (v) => { fx.comp.ratio = v; $('fx-comp-ratio-v').textContent = v + ':1'; });
    S('fx-out', (v) => { fx.out = v / 100; $('fx-out-v').textContent = v + '%'; });
    // 8D/3D/16D/360° spatial — radio behavior: sirf ek mode ek baar me.
    // (Pehle ye toggles unwired the — dead UI. Ab live hain.)
    const spatialModes = ['8d', '3d', '16d', '360'];
    const syncSpatialUI = () => {
      const m = (A.state.fx.spatial && A.state.fx.spatial.mode) || 'off';
      spatialModes.forEach((k) => { const el = $('fx-' + k + '-on'); if (el) el.checked = (m === k); });
    };
    const ensureSpatial = () => A.state.fx.spatial || (A.state.fx.spatial = { mode: 'off', speed: 0.12, depth: 0.7 });
    spatialModes.forEach((k) => {
      C('fx-' + k + '-on', (v) => {
        const sp = ensureSpatial();
        sp.mode = v ? k : (sp.mode === k ? 'off' : sp.mode);
        syncSpatialUI();
      });
      S('fx-' + k + '-speed', (v) => {
        const sp = ensureSpatial();
        sp.speed = Math.min(1, Math.max(0.05, v / 100));
        $('fx-' + k + '-speed-v').textContent = v + '%';
        if (sp.mode === 'off') { sp.mode = k; syncSpatialUI(); } // slider chhua to mode on
      });
      S('fx-' + k + '-depth', (v) => {
        const sp = ensureSpatial();
        sp.depth = v / 100;
        $('fx-' + k + '-depth-v').textContent = v + '%';
        if (sp.mode === 'off') { sp.mode = k; syncSpatialUI(); }
      });
    });
    A.syncSpatialUI = syncSpatialUI;
    // EQ preset quick select
    const sel = $('fx-eqpreset');
    Object.keys(RM.fx.EQ_PRESETS).forEach((k) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = RM.fx.EQ_PRESETS[k].name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      const p = RM.fx.EQ_PRESETS[sel.value];
      if (!p) return;
      fx.eq3 = p.g.slice();
      $('fx-bass').value = p.g[0]; $('fx-bass-v').textContent = (p.g[0] > 0 ? '+' : '') + p.g[0] + ' dB';
      $('fx-mid').value = p.g[1]; $('fx-mid-v').textContent = (p.g[1] > 0 ? '+' : '') + p.g[1] + ' dB';
      $('fx-treble').value = p.g[2]; $('fx-treble-v').textContent = (p.g[2] > 0 ? '+' : '') + p.g[2] + ' dB';
      A.applyFxToChain();
    });
    $('fx-preview').addEventListener('click', () => {
      if (!A.needAudio()) return;
      A.ensureStudio(); A.applyFxToChain();
      const p = A.state.player;
      if (p.playing) p.pause(); else p.play(0);
    });
    $('fx-reset').addEventListener('click', () => {
      A.state.fx = A.defaultFx();
      A.applyFxToChain();
      syncFxUI();
      A.toast('FX reset');
    });
    $('fx-save').addEventListener('click', () => {
      try {
        const saved = JSON.parse(localStorage.getItem('ruhmix.fxpresets') || '{}');
        const name = 'Preset ' + (Object.keys(saved).length + 1);
        saved[name] = A.state.fx;
        localStorage.setItem('ruhmix.fxpresets', JSON.stringify(saved));
        renderFxSaved();
        A.toast(('Saved: ') + name);
      } catch (e) {}
    });
    renderFxSaved();
  }
  function renderFxSaved() {
    const box = $('fx-saved');
    if (!box) return;
    box.innerHTML = '';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ruhmix.fxpresets') || '{}'); } catch (e) {}
    Object.keys(saved).forEach((name) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = name;
      b.addEventListener('click', () => {
        A.state.fx = saved[name];
        A.applyFxToChain(); syncFxUI();
        A.toast(('Applied: ') + name);
      });
      box.appendChild(b);
    });
  }
  function syncFxUI() {
    const fx = A.state.fx;
    $('fx-bass').value = fx.eq3[0]; $('fx-mid').value = fx.eq3[1]; $('fx-treble').value = fx.eq3[2];
    document.querySelectorAll('#fx-eq10 input').forEach((el) => { el.value = fx.eq10[+el.dataset.i] || 0; });
    $('fx-chorus-on').checked = fx.chorus.on;
    $('fx-echo-on').checked = fx.echo.on;
    $('fx-reverb-on').checked = fx.reverb.on;
    $('fx-reverb-room').value = fx.reverb.room;
    $('fx-comp-on').checked = fx.comp.on;
    if (A.syncSpatialUI) A.syncSpatialUI();
  }

  /* ================= mastering ================= */
  const mst = { player: null, chain: null, bypass: null, direct: null, ab: 'after' };
  function initMastering() {
    const sel = $('mst-preset');
    Object.keys(RM.fx.MASTER_PRESETS).forEach((k) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = RM.fx.MASTER_PRESETS[k].label;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      A.state.mastering.preset = sel.value;
      A.state.mastering.settings = Object.assign({}, RM.fx.MASTER_PRESETS[sel.value]);
      syncMstUI();
      applyMstChain();
      RM.proj.autosave(A.state.project || RM.proj.create('x'));
    });
    A.state.mastering.settings = Object.assign({}, RM.fx.MASTER_PRESETS.clean);
    const B = (id, key, fmt) => $(id).addEventListener('input', (e) => {
      A.state.mastering.settings[key] = +e.target.value;
      $(id + '-v').textContent = fmt(+e.target.value);
      applyMstChain();
    });
    B('mst-eqb', 'eqB', (v) => (v > 0 ? '+' : '') + v + ' dB');
    B('mst-eqm', 'eqM', (v) => (v > 0 ? '+' : '') + v + ' dB');
    B('mst-eqt', 'eqT', (v) => (v > 0 ? '+' : '') + v + ' dB');
    B('mst-thr', 'thr', (v) => v + ' dB');
    $('mst-ratio').addEventListener('input', (e) => {
      A.state.mastering.settings.ratio = +e.target.value / 10;
      $('mst-ratio-v').textContent = (+e.target.value / 10).toFixed(1) + ':1';
      applyMstChain();
    });
    $('mst-ab').addEventListener('click', (e) => {
      mst.ab = mst.ab === 'after' ? 'before' : 'after';
      e.target.textContent = mst.ab === 'after' ? ('Hearing: AFTER (mastered)') : ('Hearing: BEFORE (original)');
      applyMstChain();
    });
    $('mst-play').addEventListener('click', () => {
      if (!A.needAudio()) return;
      ensureMst();
      if (mst.player.playing) mst.player.pause();
      else { applyMstChain(); mst.player.play(0); }
    });
    $('mst-normalize').addEventListener('click', () => {
      if (!A.needAudio()) return;
      A.toast('Normalizing…');
      RM.audio.normalizeBuffer(A.state.viewBuffer, 0.71, (p) => {
        $('mst-status').textContent = Math.round(p * 100) + '%';
      }).then(() => {
        $('mst-status').textContent = '✓ Loudness normalized (peak −3 dB)';
        A.refreshView();
      });
    });
  }
  function ensureMst() {
    const ctx = RM.audio.ensureCtx();
    if (!mst.player) {
      mst.player = RM.audio.makePlayer();
      mst.chain = RM.fx.makeMasterChain(ctx, A.state.mastering.settings);
      mst.bypass = ctx.createGain(); // processed path gain
      mst.direct = ctx.createGain(); // dry path gain
      // Internal dry path (insert→panner→gain→master) disconnect — A/B ke liye
      // mst.direct/mst.bypass gains hi kaafi hain; warna "before" mode me double-dry
      // aur "after" mode me dry+processed ek saath bajta (doubling bug).
      mst.player.insert.disconnect();
      mst.player.insert.connect(mst.chain.input);
      mst.chain.output.connect(mst.bypass);
      mst.bypass.connect(RM.audio.masterIn());
      mst.player.insert.connect(mst.direct);
      mst.direct.connect(RM.audio.masterIn());
    }
    if (A.state.viewBuffer && mst.player.buffer !== A.state.viewBuffer) mst.player.load(A.state.viewBuffer);
  }
  function applyMstChain() {
    if (!mst.chain) return;
    const ctx = RM.audio.ensureCtx();
    const t = ctx.currentTime;
    mst.chain.apply(A.state.mastering.settings);
    const after = mst.ab !== 'before';
    mst.bypass.gain.setTargetAtTime(after ? 1 : 0, t, 0.02);
    mst.direct.gain.setTargetAtTime(after ? 0 : 1, t, 0.02);
  }
  // Project switch / naya audio: mastering preview band karo (stopAll se call hota hai).
  function stopMstPreview() {
    try { if (mst.player) mst.player.stop(true); } catch (e) {}
  }
  A.stopMstPreview = stopMstPreview;
  function syncMstUI() {
    const s = A.state.mastering.settings;
    $('mst-eqb').value = s.eqB; $('mst-eqm').value = s.eqM; $('mst-eqt').value = s.eqT;
    const db = (v) => (v > 0 ? '+' : '') + v + ' dB';
    $('mst-eqb-v').textContent = db(s.eqB);
    $('mst-eqm-v').textContent = db(s.eqM);
    $('mst-eqt-v').textContent = db(s.eqT);
    $('mst-thr').value = s.thr; $('mst-thr-v').textContent = s.thr + ' dB';
    $('mst-ratio').value = s.ratio * 10;
    $('mst-ratio-v').textContent = s.ratio.toFixed(1) + ':1';
  }

  /* ================= beat tools (merged into the Editor screen) ================= */
  const tap = { times: [] };
  const metro = { playing: false, bpm: 120, beat: 0, nextTime: 0, timer: null };
  function initBeat() {
    $('tap-btn').addEventListener('click', () => {
      const now = performance.now() / 1000;
      tap.times.push(now);
      if (tap.times.length > 6) tap.times.shift();
      if (now - tap.times[0] > 3) tap.times = [now];
      if (tap.times.length >= 2) {
        const iv = [];
        for (let i = 1; i < tap.times.length; i++) iv.push(tap.times[i] - tap.times[i - 1]);
        const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
        const bpm = clamp(Math.round(60 / avg), 40, 220);
        $('tap-bpm').textContent = bpm + ' BPM';
        metro.bpm = bpm;
        $('metro-bpm').value = bpm;
        $('metro-bpm-v').textContent = bpm;
      }
    });
    $('tap-reset').addEventListener('click', () => { tap.times = []; $('tap-bpm').textContent = '— BPM'; });
    $('metro-bpm').addEventListener('input', (e) => {
      metro.bpm = +e.target.value;
      $('metro-bpm-v').textContent = metro.bpm;
    });
    $('metro-start').addEventListener('click', (e) => {
      RM.audio.ensureCtx();
      if (!metro.playing) {
        metro.playing = true; metro.beat = 0;
        metro.nextTime = RM.audio.ensureCtx().currentTime + 0.06;
        metro.timer = setInterval(metroSchedule, 25);
        e.target.textContent = 'Stop Metronome';
        e.target.classList.add('on');
      } else {
        metro.playing = false;
        clearInterval(metro.timer); metro.timer = null;
        e.target.textContent = 'Start Metronome';
        e.target.classList.remove('on');
      }
    });
  }
  function metroClick(beat, t) {
    const ctx = RM.audio.ensureCtx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = beat === 0 ? 2000 : 1200;
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g); g.connect(RM.audio.masterIn());
    o.onended = () => { try { o.disconnect(); } catch (e) {} try { g.disconnect(); } catch (e2) {} };
    o.start(t); o.stop(t + 0.08);
  }
  function metroSchedule() {
    const ctx = RM.audio.ensureCtx();
    if (metro.nextTime < ctx.currentTime - 0.1) metro.nextTime = ctx.currentTime + 0.06;
    while (metro.nextTime < ctx.currentTime + 0.1) {
      metroClick(metro.beat, metro.nextTime);
      metro.nextTime += 60 / metro.bpm;
      metro.beat = (metro.beat + 1) % 4;
    }
  }

  /* ================= export screen ================= */
  const expToken = { cancelled: false };

  // Export filename sanitize — unicode-safe, deterministic:
  // - Hindi/regional names are preserved: \p{L} letters + \p{M} COMBINING
  //   MARKS (Hindi matras — the old [^\w] turned "song" names into stubs) + \p{N}
  // - keep "_" as well (aligned with Team 4's [^A-Za-z0-9._-])
  // - spaces -> '_' (native saveFile also turns spaces into '_', so the name
  //   the name shown in the toast is exactly the file that gets saved)
  // - strip an existing AUDIO extension (".mp3") so "song.mp3.mp3" can't happen;
  //   known audio extensions only — the ".v2" in "my.song.v2" is not an extension
  // - Array.from slice: never split an emoji surrogate pair in half
  function sanitizeFileBase(name) {
    const raw = String(name || '').trim()
      .replace(/\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|webm|3gp|3g2|wma|aiff|aif)$/i, '');
    const cleaned = raw.replace(/[^\p{L}\p{M}\p{N}\-_ ]+/gu, '').trim().replace(/ +/g, '_');
    const safe = Array.from(cleaned).slice(0, 40).join('').replace(/^_+|_+$/g, '');
    return safe;
  }
  A.sanitizeFileBase = sanitizeFileBase;

  function refreshExportSource() {
    const box = $('exp-sources');
    if (!box) return;
    box.innerHTML = '';
    const opts = [];
    if (A.state.stemMix) opts.push({ kind: 'stemmix', label: ('🎤 Stem Mix — Auto Remix'), get: () => ({ buffer: A.state.stemMix, rate: 1, fx: A.flatFx(), name: 'stem-mix', tail: 0 }) });
    // Round-6 (W7 Issue 6): preset-flow remix bhi exportable — generate time pe offline render hota hai.
    if (A.state.remixBuffer) opts.push({ kind: 'remix', label: ('🎛️ Remix — ') + (A.state.remixBufferName || 'remix'), get: () => ({ buffer: A.state.remixBuffer, rate: 1, fx: A.flatFx(), name: 'remix-' + (A.state.remixBufferName || 'remix'), tail: 0 }) });
    if (A.state.viewBuffer) opts.push({ kind: 'project', label: ('Current project') + ' (' + A.state.fileName + ')', get: () => ({ buffer: A.state.viewBuffer, rate: A.state.project.settings.speed || 1, fx: A.state.fx, name: A.state.fileName, vol: A.state.project.settings.volume, pan: A.state.project.settings.pan }) });
    RM.stems.results.forEach((s) => opts.push({ kind: 'stem', label: 'Stem: ' + s.name, get: () => ({ buffer: s.buffer, rate: 1, fx: A.defaultFx(), name: s.name }) }));
    A.state.imports.forEach((it) => opts.push({ kind: 'import', label: it.name, get: () => ({ buffer: it.buffer, rate: 1, fx: A.defaultFx(), name: it.name }) }));
    // Stem row se "Export" dabane par exportSource {kind:'buffer', buffer, name}
    // set hota hai — use radio me explicit option banao aur select karo.
    // (Pehle radio hamesha index 0 check karta tha -> galat source export hota tha.)
    const es = A.state.exportSource;
    let checkedIdx = 0;
    if (es && es.kind === 'buffer' && es.buffer) {
      // v26 (I5): "Export Mix" (mixer) ka mixdown bhi yahi se aata hai — koi
      // aur source na ho tab bhi explicit option banna chahiye, isliye empty
      // check se PEHLE unshift karo.
      // W5 (mashup-export.js): the mashup hands a finished mix and passes
      // its own fx (flatFx — compressor OFF, so the W3 loudness-matched
      // vocals+beat render exactly as previewed) and tail (0 — no dead-air
      // tail on a finished mix). Callers that don't pass them (stem-deck
      // "Export" buttons) keep the old defaults: defaultFx + 2.5 s tail.
      opts.unshift({ kind: 'explicit', label: ('🎯 Selected: ') + es.name, get: () => ({ buffer: es.buffer, rate: 1, fx: (es.fx || A.defaultFx()), name: es.name, tail: (es.tail !== undefined ? es.tail : undefined) }) });
      checkedIdx = 0;
    } else if (es && typeof es.idx === 'number' && es.idx >= 0 && es.idx < opts.length) {
      checkedIdx = es.idx;
    }
    if (!opts.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">📤</div>${'Load audio first to export'}</div>`;
      return;
    }
    opts.forEach((o, i) => {
      const l = document.createElement('label');
      l.className = 'radio-row';
      l.innerHTML = `<input type="radio" name="expsrc" value="${i}" ${i === checkedIdx ? 'checked' : ''}><span>${A.escapeHtml(o.label)}</span>`;
      box.appendChild(l);
    });
    // User ki pasand yaad rakho taaki screen dobara khulne par wahi selected rahe.
    box.onchange = () => {
      const v = box.querySelector('input[name="expsrc"]:checked');
      A.state.exportSource = { idx: v ? +v.value : 0 };
    };
    A.state._exportOpts = opts;
  }
  A.refreshExportSource = refreshExportSource;

  // Export screen ko Settings me badle gaye defaults se sync karo.
  // (initExport sirf boot par chalta hai; Settings badalne ke baad export
  // screen khulne par purane radio/select dikhte the — restart tak stale.)
  function syncExpDefaults() {
    try {
      $('exp-bitrate').value = A.state.exportDefaults.bitrate;
      $('exp-sr').value = A.state.exportDefaults.sampleRate;
      const fmt = A.state.exportDefaults.format || 'mp3';
      const radio = document.querySelector(`input[name="expfmt"][value="${fmt}"]`);
      if (radio) { radio.checked = true; }
      syncExpFormat();
    } catch (e) {}
  }
  A.syncExpDefaults = syncExpDefaults;
  function initExport() {
    ['exp-format-mp3', 'exp-format-wav', 'exp-format-flac'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', syncExpFormat);
    });
    syncExpFormat();
    syncExpDefaults();
    $('exp-start').addEventListener('click', doExport);
    $('exp-cancel').addEventListener('click', () => {
      expToken.cancelled = true;
      $('exp-status').textContent = 'Cancelling…';
      if (!$('exp-start').disabled && window.RM && RM.ux) { try { RM.ux.onExportFinished(); } catch (e) {} }
    });
    $('exp-share').addEventListener('click', () => {
      if (!A.state.lastDelivery) { A.toast('Export first'); return; }
      const mime = A.state.lastDelivery.mime;
      const r = RM.exp.share(A.state.lastDelivery, mime);
      if (r === 'unavailable') A.toast('Share unavailable on this device', 3000);
    });
  }
  function syncExpFormat() {
    const fmt = document.querySelector('input[name="expfmt"]:checked');
    const f = fmt ? fmt.value : 'mp3';
    $('exp-bitrate-row').style.display = f === 'mp3' ? '' : 'none';
    $('exp-note').textContent =
      f === 'mp3' ? ('MP3 — small file, plays everywhere (lamejs, offline)')
      : f === 'flac' ? ('FLAC — lossless quality, smaller than WAV (offline encoder)')
      : ('WAV — best quality, larger file (16-bit PCM)');
  }
  function setExpStage(label, frac) {
    $('exp-status').textContent = label;
    const bar = $('exp-pbar');
    if (bar) bar.style.width = Math.round((frac || 0) * 100) + '%';
  }
  function doExport() {
    const opts = A.state._exportOpts;
    if (!opts || !opts.length) { A.toast('Nothing to export'); return; }
    // v26 §25: mandatory copyright acknowledgement — no export without it.
    const ackBox = $('exp-copyright-ack');
    if (ackBox && !ackBox.checked) { A.toast('Please tick the copyright notice first'); return; }
    const sel = document.querySelector('input[name="expsrc"]:checked');
    const src = opts[sel ? +sel.value : 0].get();
    const fmtEl = document.querySelector('input[name="expfmt"]:checked');
    const fmt = fmtEl ? fmtEl.value : 'mp3';
    const isMp3 = fmt === 'mp3', isFlac = fmt === 'flac';
    const kbps = +$('exp-bitrate').value;
    const sr = +$('exp-sr').value;
    const normalize = $('exp-normalize').checked;
    const ext = isMp3 ? 'mp3' : isFlac ? 'flac' : 'wav';
    const mime = isMp3 ? 'audio/mpeg' : isFlac ? 'audio/flac' : 'audio/wav';
    const base = sanitizeFileBase(src.name);
    const fileName = base ? base + '.' + ext : RM.exp.defaultName(ext);
    expToken.cancelled = false;
    $('exp-start').disabled = true;
    $('exp-share').style.display = 'none';
    const done = (msg, ok) => {
      $('exp-start').disabled = false;
      setExpStage(msg, ok ? 1 : 0);
      if (ok && window.RM && RM.ux) { try { RM.ux.onExportFinished(); } catch (e) {} }
    };

    const stage = (label, frac) => {
      if (expToken.cancelled) throw new Error('cancelled');
      setExpStage(label, frac);
    };
    // 1. render — Promise.resolve().then() me lapeta: renderOffline/makeChain
    // agar SYNCHRONOUSLY throw kare (bahut badi file -> OfflineAudioContext
    // length limit) to bhi .catch tak pahunche aur Export button dobara
    // enable ho. Bina iske button hamesha disabled rehta (dead UI).
    stage('Preparing…', 0.02);
    let chain, mstChain = null;
    // Effect tail: RM.exp.tailForFx covers reverb IRs plus the echo RT60
    // (shared helper — the remix-buffer render below uses it too).
    const fxp = src.fx || A.defaultFx();
    const tailNeed = RM.exp.tailForFx(fxp);
    Promise.resolve().then(() => RM.exp.renderOffline(src.buffer, (oc, srcNode) => {
      chain = RM.fx.makeChain(oc);
      chain.applyPreset(fxp);
      srcNode.connect(chain.input);
      // Stereo width bhi export me: wahi width value jo user live sun raha hai
      // (A.state.width.wGain). Bina iske wide mixes export me alag lagte the.
      const wVal = (A.state.width && A.state.width.wGain) ? A.state.width.wGain.gain.value : 1;
      const W = A.widthMatrix(oc, wVal);
      chain.output.connect(W.in);
      // Round-6 (W6 P2): export me project volume/pan bhi lagao — jo sunte ho
      // wahi export ho (playback me panner+gain hain, export me the hi nahi).
      let outNode = W.out;
      const xVol = (src.vol != null ? src.vol : 1);
      const xPan = (src.pan || 0);
      if (xVol !== 1 || xPan !== 0) {
        const xg = oc.createGain(); xg.gain.value = xVol;
        W.out.connect(xg);
        if (oc.createStereoPanner) {
          const xp = oc.createStereoPanner();
          xp.pan.value = Math.max(-1, Math.min(1, xPan));
          xg.connect(xp);
          outNode = xp;
        } else { outNode = xg; }
      }
      // v26 (I5): mastering -> export. "Apply to export" toggle (mastering
      // screen) ON: the SAME fx.makeMasterChain graph with the CURRENT mst-*
      // settings becomes the FINAL stage. OFF: unchanged behavior.
      if (window.RM && RM.v26mixdown && RM.v26mixdown.masteringEnabled()) {
        const mc = RM.v26mixdown.applyMasterChainOffline(oc, outNode);
        outNode = mc.out; mstChain = mc.chain;
      }
      return outNode;
    }, { sampleRate: sr, rate: src.rate || 1, tail: (src.tail !== undefined ? src.tail : tailNeed) }))
      .then((rendered) => {
        try { if (chain) chain.dispose(); } catch (e) {}
        try { if (mstChain) mstChain.dispose(); } catch (e) {}
        stage('Rendering… please wait', 0.35);
        const p2 = normalize
          ? RM.audio.normalizeBuffer(rendered, 0.71, (p) => setExpStage(('Normalizing: ') + Math.round(p * 100) + '%', 0.35 + p * 0.1))
          : Promise.resolve(rendered);
        return p2.then(() => {
          // NOTE: normalizeBuffer normalizes IN PLACE and resolves to the peak
          // (a number), NOT the buffer — always use `rendered` here.
          const buf = rendered;
          stage('Encoding…', 0.5);
          if (isFlac) {
            // FLAC: 16-bit PCM -> pure-JS FLAC encoder (offline, lossless)
            return RM.audio.floatToInt16(buf, (p) => setExpStage(('Preparing: ') + Math.round(p * 100) + '%', 0.5 + p * 0.1))
              .then((i16) => {
                stage('Encoding FLAC…', 0.6);
                return RM.exp.encodeFlac(i16, buf.sampleRate,
                  (p, label) => setExpStage('FLAC ' + Math.round(p * 100) + '%', 0.6 + p * 0.3), expToken);
              });
          }
          if (!isMp3) {
            return RM.audio.encodeWavBuffer(buf, (p) => setExpStage(('Encoding: ') + Math.round(p * 100) + '%', 0.5 + p * 0.35))
              .then((ab) => new Blob([ab], { type: mime }));
          }
          // MP3: resample to the chosen sample rate (44100/48000 — both valid MPEG-1), then encode
          return RM.audio.resampleBuffer(buf, sr, (p) => setExpStage(('Resampling: ') + Math.round(p * 100) + '%', 0.5 + p * 0.1))
            .then((rs) => RM.audio.floatToInt16(rs, (p) => setExpStage(('Preparing: ') + Math.round(p * 100) + '%', 0.6 + p * 0.1)))
            .then((i16) => {
              stage('Encoding MP3…', 0.7);
              return RM.exp.encodeMp3(i16, kbps, sr, (p) => setExpStage('MP3 ' + Math.round(p * 100) + '%', 0.7 + p * 0.2), expToken);
            });
        }).then((blob) => {
          stage('Saving…', 0.95);
          return RM.exp.deliver(blob, fileName, mime, (p) => setExpStage(('Saving… ') + Math.round(p * 100) + '%', 0.95));
        }).then((delivery) => {
          delivery.mime = mime;
          A.state.lastDelivery = delivery;
          try {
            A.state.exportDefaults = { format: fmt, bitrate: kbps, sampleRate: sr };
            localStorage.setItem('ruhmix.exportDefaults', JSON.stringify(A.state.exportDefaults));
          } catch (e) {}
          const nat = RM.audio.native;
          if (nat.method('showNotification')) nat.call('showNotification', 'RuhMix', ('Export complete: ') + fileName);
          const viaMusicLib = delivery && delivery.method === 'native-music-library';
          done(('✓ Done: ') + fileName + (viaMusicLib ? ' — saved to Music/RuhMix/' : ''), true);
          $('exp-share').style.display = '';
          A.toast(viaMusicLib ? 'Saved to Music/RuhMix/ — open your music player!' : 'Export complete');
          // Interstitial ad: har 2nd export par (pehle par nahi), max 1 per 5 min.
          // Fail ho to silent skip — export pe koi asar nahi.
          try { if (window.RM && RM.ads) RM.ads.notifyExportDone(); } catch (e) {}
        });
      })
      .catch((e) => {
        if (e && e.message === 'cancelled') { done('Cancelled', false); if (window.RM && RM.ux) { try { RM.ux.onExportFinished(); } catch (ee) {} } return; }
        const msg = A.friendlyErr(e);
        done('Failed', false);
        A.dialog('Export failed',
          `<p>${A.escapeHtml(msg)}</p>`,
          '🔁 Retry',
          'Cancel').then((retry) => { if (retry) doExport(); });
      });
  }

  /* ================= projects screen ================= */
  function initProjects() {
    $('proj-new').addEventListener('click', () => {
      A.dialog('New Project',
        `<input id="dlg-name" class="textin" value="${'My Project'}" maxlength="40" lang="en" autocapitalize="off" autocomplete="off" spellcheck="false">`,
        'Create', 'Cancel').then((ok) => {
          if (!ok) return;
          const name = ($('dlg-name') && $('dlg-name').value.trim()) || ('My Project');
          RM.proj.save(A.state.project || RM.proj.create(name));
          A.newProject(name);
          renderProjects();
        });
    });
    $('proj-search').addEventListener('input', renderProjects);
    renderProjects();
  }

  /* ---- v25 mashup project row actions (I7: wire RM.v25projects) ----
     Mashup rows (settings.mashup.kind === 'mashup') get Rename / Duplicate /
     Continue / Export-again. Regular editor rows keep the old Open + Delete.
     Honest limit: audio BYTES are never stored, so Continue / Export-again
     reuse the in-session mashup result when it's still in memory; otherwise
     they say so plainly instead of crashing or faking it. */
  function isMashupRow(p) {
    try {
      return !!(RM.v25projects && typeof RM.v25projects.isMashup === 'function'
        && RM.v25projects.isMashup(p));
    } catch (e) { return false; }
  }
  function mashupRowMeta(s) {
    const bits = [];
    if (s.songCount) bits.push(s.songCount + (s.songCount === 1 ? ' song' : ' songs'));
    if (s.bpm) bits.push(Math.round(s.bpm) + ' BPM');
    if (s.key) bits.push(s.key);
    if (s.hasQc) bits.push('QC ✓');
    if (s.lastExport) bits.push('exported');
    return bits.length ? bits.join(' • ') : 'Mashup project';
  }
  function currentMashupResult() {
    try {
      return (RM.mashupScreen && typeof RM.mashupScreen.getResult === 'function')
        ? RM.mashupScreen.getResult() : null;
    } catch (e) { return null; }
  }
  // In-session mashup audio (if any) handed to fn({buffer, meta, engine}).
  // Returns true when audio was available (fn ran or a confirm was shown).
  function withProjectAudio(p, verb, fn) {
    const mr = currentMashupResult();
    if (mr && mr.buffer && typeof mr.buffer.getChannelData === 'function') {
      const go = () => fn({ buffer: mr.buffer, meta: mr.meta || {}, engine: mr.engine });
      const resName = (mr.meta && mr.meta.name) || '';
      // Never silently use the wrong audio: confirm when the in-memory
      // result belongs to a different mashup.
      if (!resName || resName === p.name) { go(); return true; }
      A.dialog('Use current audio?',
        `<p>Audio in memory is <b>${A.escapeHtml(resName)}</b> — a different mashup. ${A.escapeHtml(verb)} project <b>${A.escapeHtml(p.name)}</b> with this audio?</p>`,
        'Use this audio', 'Cancel').then((ok) => { if (ok) go(); });
      return true;
    }
    return false;
  }
  function renameMashupProject(p) {
    A.dialog('Rename project',
      `<input id="dlg-name" class="textin" value="${A.escapeHtml(p.name)}" maxlength="60" lang="en" autocapitalize="off" autocomplete="off" spellcheck="false">`,
      'Rename', 'Cancel').then((ok) => {
        if (!ok) return;
        const name = (($('dlg-name') && $('dlg-name').value) || '').trim() || p.name;
        if (RM.v25projects.rename(p.id, name)) {
          A.toast('Project renamed ✓');
          renderProjects(); renderHomeRecent();
        } else {
          A.toast('Rename failed — project not found');
        }
      });
  }
  function duplicateMashupProject(p) {
    const id = RM.v25projects.duplicate(p.id);
    if (id) {
      A.toast('Project duplicated ✓');
      renderProjects(); renderHomeRecent();
    } else {
      A.toast('Duplicate failed — project not found');
    }
  }
  function continueMashupProject(p) {
    const res = RM.v25projects.continueEditing(p.id);
    if (!res) { A.toast('Project not found'); return; }
    const had = withProjectAudio(res.project, 'Continue editing', (a) => {
      if (RM.v25studio && typeof RM.v25studio.open === 'function') {
        RM.v25studio.open({ buffer: a.buffer, meta: a.meta, engineTags: a.engine, songs: [] });
        A.toast('Continuing: ' + res.project.name);
      } else {
        A.toast('Studio is not available in this build');
      }
    });
    if (!had) {
      // Live state was still restored above; the Studio opens empty and the
      // user gets the honest rebuild path instead of a crash.
      A.show('studio');
      A.toast('Audio for this project is not stored on the device. Pick the original songs on the Create screen and rebuild to continue editing.', 6000);
    }
  }
  function exportAgainMashupProject(p) {
    const got = RM.v25projects.exportAgain(p.id);
    if (!got) { A.toast('Project not found'); return; }
    const had = withProjectAudio(got.project, 'Export', (a) => {
      if (RM.v25exportui && typeof RM.v25exportui.show === 'function') {
        RM.v25exportui.show({ buffer: a.buffer, meta: a.meta, name: got.project.name || 'RuhMix-mashup' });
      } else {
        A.toast('Export screen is not available in this build');
      }
    });
    if (!had) {
      A.dialog('Audio unavailable',
        `<p>Audio for <b>${A.escapeHtml(got.project.name)}</b> is not stored on the device, so it can't be re-exported. Rebuild the mashup on the Create screen first.</p>`,
        'Go to Create', 'Cancel').then((ok) => { if (ok) A.show('mashup'); });
    }
  }
  function renderProjects() {
    const box = $('projects-list');
    if (!box) return;
    box.innerHTML = '';
    const q = (($('proj-search') && $('proj-search').value) || '').trim().toLowerCase();
    let arr = RM.proj.list();
    if (q) arr = arr.filter((p) => (p.name || '').toLowerCase().includes(q));
    if (!arr.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">📁</div>${q ? ('No projects found') : ('No saved projects yet')}</div>`;
      return;
    }
    let mash = {};
    try { RM.v25projects.listMashups().forEach((s) => { mash[s.id] = s; }); } catch (e) {}
    arr.forEach((p) => {
      const d = document.createElement('div');
      d.className = 'import-item';
      const dt = new Date(p.updatedAt).toLocaleDateString();
      const ms = mash[p.id];
      if (!ms) {
        d.innerHTML = `
        <div class="ii-main">
          <div class="ii-name">${A.escapeHtml(p.name)}</div>
          <div class="ii-meta">${A.escapeHtml((p.audioRef && p.audioRef.name) || ('No audio'))} • ${p.ops.length} edits • ${dt}</div>
        </div>
        <button class="btn small" data-a="open">${'Open'}</button>
        <button class="btn small ghost" data-a="del">✕</button>`;
        d.querySelector('[data-a="open"]').addEventListener('click', () => openProject(p));
        d.querySelector('[data-a="del"]').addEventListener('click', () => {
          A.dialog('Delete?', `<p>${A.escapeHtml(p.name)}</p>`, 'Delete', 'Cancel')
            .then((ok) => { if (ok) { RM.proj.remove(p.id); renderProjects(); renderHomeRecent(); } });
        });
        box.appendChild(d);
        return;
      }
      d.innerHTML = `
        <div class="ii-main">
          <div class="ii-name">${A.escapeHtml(p.name)} <span class="beta">MASHUP</span></div>
          <div class="ii-meta">${A.escapeHtml(mashupRowMeta(ms))} • ${dt}</div>
          <div class="btn-row" style="margin:6px 0 0">
            <button class="btn small" data-a="rename">✏️ Rename</button>
            <button class="btn small" data-a="dup">⧉ Duplicate</button>
            <button class="btn small" data-a="cont">▶ Continue</button>
            <button class="btn small" data-a="exp">⬇ Export again</button>
          </div>
        </div>
        <button class="btn small ghost" data-a="del">✕</button>`;
      d.querySelector('[data-a="rename"]').addEventListener('click', () => renameMashupProject(p));
      d.querySelector('[data-a="dup"]').addEventListener('click', () => duplicateMashupProject(p));
      d.querySelector('[data-a="cont"]').addEventListener('click', () => continueMashupProject(p));
      d.querySelector('[data-a="exp"]').addEventListener('click', () => exportAgainMashupProject(p));
      d.querySelector('[data-a="del"]').addEventListener('click', () => {
        A.dialog('Delete?', `<p>${A.escapeHtml(p.name)}</p>`, 'Delete', 'Cancel')
          .then((ok) => { if (ok) { RM.v25projects.delete(p.id); renderProjects(); renderHomeRecent(); } });
      });
      box.appendChild(d);
    });
  }
  function openProject(p) {
    A.stopAll();
    A.state.project = p;
    RM.proj.restoreLive(p); // saved FX/slowed/mastering/remix settings wapas live state me
    A.state.buffer = null;
    A.state.viewBuffer = null;
    A.state.viewGen++; // purane project ka koi in-flight render/peaks ab stale hai
    A.state.redoStack = [];
    A.state.fileName = (p.audioRef && p.audioRef.name) || '';
    if (A.state.waveView) A.state.waveView.setBuffer(null, new Float32Array(0));
    RM.proj.autosave(p);
    A.show('import');
    const hint = $('import-hint');
    if (hint && p.audioRef) {
      hint.innerHTML = ('Pick this project\'s audio: <b>') + A.escapeHtml(p.audioRef.name) + '</b>';
      hint.style.display = '';
    }
    A.toast(('Project opened: ') + p.name);
    // Round-6: paste ops' clipboard is in-memory — after a restart, pasted
    // parts won't render on reopen. Tell the user plainly instead of
    // silently changing audio.
    try {
      if (RM.proj.hasPasteOps(p) && !RM.proj.getClipboard()) {
        A.toast('Note: pasted audio could not be restored (clipboard is empty)', 4000);
      }
    } catch (e) {}
  }

  /* ================= settings ================= */
  /* ---- temporary data clearing (shared by Storage + Privacy panels) ---- */
  function clearTempData() {
    const nat = RM.audio.native;
    let nativeCleared = false;
    if (nat.method('clearCache')) { try { nat.call('clearCache'); nativeCleared = true; } catch (e) {} }
    try {
      Object.keys(localStorage).filter((k) => k.indexOf('ruhmix.') === 0 && k !== 'ruhmix.projects.v1').forEach((k) => localStorage.removeItem(k));
    } catch (e) {}
    RM.stems.clear(); // stem results + 4-role pack
    RM.remix.stemPipeline.stopPreview();
    try {
      [A.state.buffer, A.state.viewBuffer, A.state.stemMix].forEach((b) => { if (b && RM.wave) RM.wave.dropPeaks(b); });
    } catch (e) {}
    A.state.stemMix = null;
    A.state.lastDelivery = null;
    updateStorageInfo();
    return nativeCleared;
  }

  function initSettings() {
    $('set-theme').addEventListener('change', (e) => A.setTheme(e.target.value));
    $('set-lang').addEventListener('change', (e) => A.setLang(e.target.value));
    $('set-def-format').value = A.state.exportDefaults.format;
    $('set-def-bitrate').value = String(A.state.exportDefaults.bitrate);
    $('set-def-sr').value = String(A.state.exportDefaults.sampleRate);
    ['set-def-format', 'set-def-bitrate', 'set-def-sr'].forEach((id) => {
      $(id).addEventListener('change', () => {
        A.state.exportDefaults = {
          format: $('set-def-format').value,
          bitrate: +$('set-def-bitrate').value,
          sampleRate: +$('set-def-sr').value,
        };
        try { localStorage.setItem('ruhmix.exportDefaults', JSON.stringify(A.state.exportDefaults)); } catch (e) {}
      });
    });
    $('set-clear-cache').addEventListener('click', () => {
      const nativeCleared = clearTempData();
      A.toast(nativeCleared ? ('Cache cleared') : ('Temporary data cleared'));
    });
    const privClear = $('set-privacy-clear');
    if (privClear) privClear.addEventListener('click', () => {
      A.dialog('Clear temporary files?',
        `<p>${'Stem results, stem-mix preview, peaks cache and temporary app data will be removed. Saved projects stay safe.'}</p>`,
        'Clear', 'Cancel').then((ok) => {
          if (!ok) return;
          clearTempData();
          A.toast('Temporary files cleared ✓');
        });
    });
    $('set-check-update').addEventListener('click', () => A.checkUpdate(true));
    updateStorageInfo();
  }
  function updateStorageInfo() {
    const el = $('storage-info');
    if (!el) return;
    const nat = RM.audio.native;
    let dir = '—';
    if (nat.method('getCacheDir')) { try { dir = nat.call('getCacheDir') || '—'; } catch (e) {} }
    let lsKB = 0;
    try {
      Object.keys(localStorage).forEach((k) => { if (k.indexOf('ruhmix.') === 0) lsKB += (localStorage.getItem(k) || '').length; });
    } catch (e) {}
    el.innerHTML = `<div>Cache: <span class="mono">${A.escapeHtml(String(dir))}</span></div>
      <div>${'App data'}: ~${Math.round(lsKB / 1024)} KB • ${'Projects'}: ${RM.proj.list().length}</div>`;
  }

  /* ================= more screen ================= */
  const MORE_LINKS = [
    ['slowed', '🐌', 'slowed'], ['stems', '🎤', 'stems'], ['aistem', '🧠', null], ['fx', '🎚️', 'equalizer'],
    ['master', '💎', 'mastering'], ['record', '🎙️', 'recorder'],
    ['export', '📤', 'export_title'], ['projects', '📁', null], ['settings', '⚙️', 'settings_title'],
  ];
  function initMore() {
    const grid = $('more-grid');
    MORE_LINKS.forEach(([scr, icon, i18n]) => {
      const label = { slowed: 'Slowed+Reverb Studio', stems: 'Stem Separator', aistem: 'AI Stem Separator', fx: 'FX Rack', master: 'Mastering', record: 'Voice Recorder', export: 'Export', projects: 'Projects', settings: 'Settings' }[scr];
      const b = document.createElement('button');
      b.className = 'home-card';
      b.innerHTML = `<div class="hc-icon">${icon}</div><div class="hc-label">${label}</div>`;
      b.addEventListener('click', () => {
        if (scr === 'aistem') { RM.aiStems.open(); return; }
        A.show(scr);
      });
      grid.appendChild(b);
    });
    $('more-update').addEventListener('click', () => A.checkUpdate(true));
  }

  /* ================= CD-ROMantic home (cdx-*, 2026-10-06) ================= */
  // One-tap effect presets: remix STYLES ke honest DSP recipes reuse karo;
  // jo remix me nahi hain unke liye chhote custom FX recipes.
  const CDX_FX = [
    { id: 'slowed',    emoji: '🐌', name: 'Slowed+Reverb', vibe: 'Deep & dreamy',      style: 'slowed' },
    { id: 'nightcore', emoji: '⚡', name: 'Nightcore',      vibe: 'Fast & euphoric',
      rate: 1.25, fx: { eq3: [2, 1, 4], filter: 19000, drive: 0, chorus: { on: false },
        echo: { on: false }, reverb: { on: true, room: 'hall', wet: 0.25 },
        comp: { on: true, thr: -16, ratio: 4, atk: 0.006, rel: 0.2 }, out: 1.0 } },
    { id: 'spedup',    emoji: '🚀', name: 'Sped Up',        vibe: 'Chipmunk energy',
      rate: 1.45, fx: { eq3: [1, 1, 3], filter: 19000, drive: 0, chorus: { on: false },
        echo: { on: false }, reverb: { on: false, room: 'hall', wet: 0.2 },
        comp: { on: true, thr: -16, ratio: 4, atk: 0.006, rel: 0.2 }, out: 1.0 } },
    { id: 'lofi',      emoji: '🎧', name: 'Lofi',           vibe: 'Dusty & warm',       style: 'lofi' },
    { id: 'vaporwave', emoji: '🌊', name: 'Vaporwave',      vibe: 'Retro neon haze',
      rate: 0.75, fx: { eq3: [1, 2, -2], filter: 9000, drive: 0,
        chorus: { on: true, rate: 1.2, depth: 0.004 },
        echo: { on: true, time: 0.45, fb: 0.38, wet: 0.25 },
        reverb: { on: true, room: 'church', wet: 0.5 },
        comp: { on: true, thr: -14, ratio: 3, atk: 0.01, rel: 0.3 }, out: 0.92 } },
    { id: '8d',        emoji: '🌀', name: '8D Audio',       vibe: 'Spinning in your head', rate: 1.0,
      fx: 'spatial8d', note: 'Use headphones for the full 8D effect.' },
    { id: 'emotional', emoji: '💜', name: 'Emotional',      vibe: 'Soft & heartfelt',   style: 'emotional' },
    { id: 'edm',       emoji: '🔥', name: 'EDM',            vibe: 'Big & energetic',    style: 'edm' },
    { id: 'bassboost', emoji: '🔊', name: 'Bass Boost',     vibe: 'Thumping lows',
      rate: 1.0, fx: { eq3: [7, 2, 0], filter: 19000, drive: 0, chorus: { on: false },
        echo: { on: false }, reverb: { on: false, room: 'hall', wet: 0.2 },
        comp: { on: true, thr: -18, ratio: 5, atk: 0.005, rel: 0.2 }, out: 1.0 } },
    { id: 'echo',      emoji: '🔁', name: 'Echo',           vibe: 'Trippy delays',
      rate: 1.0, fx: { eq3: [0, 0, 1], filter: 19000, drive: 0, chorus: { on: false },
        echo: { on: true, time: 0.375, fb: 0.4, wet: 0.4 },
        reverb: { on: true, room: 'hall', wet: 0.3 },
        comp: { on: true, thr: -14, ratio: 3, atk: 0.01, rel: 0.25 }, out: 1.0 } },
    { id: '360',       emoji: '🔄', name: '360° Audio',     vibe: 'Full circular spin',
      rate: 1.0, fx: 'spatial360',
      note: '360° spatial rotation (HRTF) — best with headphones.' },
  ];
  function applyCdxFx(p) {
    if (!A.needAudio()) return;
    let rate = 1.0, name = p.name;
    if (p.style) {
      // Remix screen ka wahi honest DSP recipe (rate + FX chain).
      const s = RM.remix.get(p.style);
      const fx = JSON.parse(JSON.stringify(s.fx));
      fx.spatial = { mode: 'off', speed: 0.12, depth: 0.7 };
      A.state.fx = fx;
      rate = s.rate;
    } else if (p.fx === 'spatial8d') {
      const fx = A.defaultFx();
      fx.spatial = { mode: '8d', speed: 0.12, depth: 0.85 };
      A.state.fx = fx;
      rate = p.rate;
    } else if (p.fx === 'spatial360') {
      const fx = A.defaultFx();
      fx.spatial = { mode: '360', speed: 0.25, depth: 1 };
      A.state.fx = fx;
      rate = p.rate;
    } else {
      const fx = A.defaultFx();
      const c = JSON.parse(JSON.stringify(p.fx));
      Object.keys(c).forEach((k) => { fx[k] = c[k]; });
      fx.spatial = { mode: 'off', speed: 0.12, depth: 0.7 };
      A.state.fx = fx;
      rate = p.rate;
    }
    A.applyFxToChain();
    if (A.state.player) A.state.player.setRate(rate);
    A.state.cdxFx = p.id;
    document.querySelectorAll('#cdx-fxgrid .cdx-fxcard').forEach((c) => {
      c.classList.toggle('on', c.dataset.id === p.id);
    });
    A.toast('✓ ' + name + (p.note ? ' — ' + p.note : ''));
  }
  const CDX_PRO = [
    ['editor', '🎚️', 'Editor'],
    ['mixer',  '🎧', 'Mixer'],
    ['stems',  '🎤', 'Stems'],
    ['master', '💎', 'Mastering'],
    ['fx',     '🎛️', 'FX Rack'],
    ['record', '🎙️', 'Voice Recorder'],
  ];
  function openCdxPro(scr) {
    if ((scr === 'editor' || scr === 'master') && !A.needAudio()) return;
    A.show(scr);
  }
  /* Now-playing bar: mini waveform (RM.wave reuse) + transport. */
  let cdxWave = null, cdxWaveBuf = null, cdxNowTimer = 0;
  function cdxUpdateNow() {
    const bar = $('cdx-nowbar');
    if (!bar) return;
    const has = !!(A.state && A.state.buffer);
    bar.hidden = !has;
    if (!has) return;
    const buf = A.state.buffer;
    $('cdx-nowbar-name').textContent = A.state.fileName || 'Track';
    const dur = buf.duration || 0;
    const p = A.state.player;
    let pos = 0, playing = false;
    if (p) {
      playing = !!p.playing;
      try { pos = playing ? p.position() : (A.state.waveView ? A.state.waveView.playheadSec : 0) || 0; } catch (e) {}
    }
    if (pos < 0) pos = 0;
    $('cdx-nowbar-time').textContent = A.fmtTime(pos) + ' / ' + A.fmtTime(dur);
    $('cdx-nowbar-play').textContent = playing ? '⏸' : '▶';
    if (cdxWave && RM.wave) {
      if (cdxWaveBuf !== buf) {
        cdxWaveBuf = buf;
        RM.wave.getPeaks(buf, 240).then((peaks) => {
          if (cdxWaveBuf === buf) { cdxWave.setBuffer(buf, peaks); cdxWave.draw(); }
        }).catch(() => {});
      } else {
        cdxWave.setPlayhead(pos);
        cdxWave.draw();
      }
    }
  }
  A.updateNowBar = cdxUpdateNow;
  function cdxInitNow() {
    const canvas = $('cdx-nowbar-wave');
    if (canvas && RM.wave) {
      cdxWave = RM.wave.createView(canvas);
      cdxWave.onSeek = (sec) => {
        if (!A.state || !A.state.player) return;
        A.ensureStudio();
        const pl = A.state.player;
        if (pl.playing) pl.play(sec); else { pl.offset = sec; }
        cdxUpdateNow();
      };
    }
    const playBtn = $('cdx-nowbar-play');
    if (playBtn) playBtn.addEventListener('click', () => {
      if (!A.state || !A.state.buffer) { A.needAudio(); return; }
      A.ensureStudio();
      const pl = A.state.player;
      if (pl.playing) pl.pause(); else pl.play(); // resume from pause offset (editor jaisa) — play(0) hamesha start se bajata tha
      cdxUpdateNow();
    });
    if (!cdxNowTimer) cdxNowTimer = setInterval(cdxUpdateNow, 500);
    cdxUpdateNow();
  }
  function initHome() {
    const fxGrid = $('cdx-fxgrid');
    CDX_FX.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'cdx-fxcard cdx-fx-' + p.id;
      b.dataset.id = p.id;
      b.dataset.label = (p.name + ' ' + p.vibe).toLowerCase();
      b.innerHTML = `<div class="cdx-fx-emoji">${p.emoji}</div><div class="cdx-fx-name">${A.escapeHtml(p.name)}</div><div class="cdx-fx-vibe">${A.escapeHtml(p.vibe)}</div>`;
      // One-tap engine (js/cdx.js): effect apply + preview auto-play (1 tap),
      // toggle-off, highlight, export-safe tempo. Fallback: purana applyCdxFx.
      b.addEventListener('click', () => {
        if (window.RM && RM.cdx && typeof RM.cdx.applyEffect === 'function') RM.cdx.applyEffect(RM.cdx.normalizeId(p.id));
        else applyCdxFx(p);
      });
      fxGrid.appendChild(b);
    });
    const proGrid = $('cdx-protools');
    CDX_PRO.forEach(([scr, icon, label]) => {
      const b = document.createElement('button');
      b.className = 'cdx-procard';
      b.dataset.label = label.toLowerCase();
      b.innerHTML = `<div class="cdx-pro-emoji">${icon}</div><div class="cdx-pro-name">${A.escapeHtml(label)}</div>`;
      b.addEventListener('click', () => openCdxPro(scr));
      proGrid.appendChild(b);
    });
    const shareBtn = $('cdx-share');
    if (shareBtn) shareBtn.addEventListener('click', () => {
      // Phase-2 fix (Worker 8): ux-flow entry taaki exportSource hamesha fresh
      // ho (stale "Selected" source bug) + onExportFinished back-nav sahi chale.
      if (window.RM && RM.ux && RM.ux.openExport) { RM.ux.openExport('home'); return; }
      if (!A.needAudio()) return;
      A.show('export');
    });
    // Auto Mashup home card (Worker 3): direct nav, no audio required.
    const mashBtn = $('home-mashup');
    if (mashBtn) mashBtn.addEventListener('click', () => A.show('mashup'));
    $('home-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#cdx-fxgrid .cdx-fxcard, #cdx-protools .cdx-procard').forEach((c) => {
        c.style.display = !q || (c.dataset.label || '').includes(q) ? '' : 'none';
      });
    });
    $('home-new').addEventListener('click', () => A.newProject());
    cdxInitNow();
    renderHomeRecent();
  }
  function renderHomeRecent() {
    const box = $('home-recent');
    if (!box) return;
    box.innerHTML = '';
    const arr = RM.proj.list().slice(0, 5);
    if (!arr.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">🎵</div>${'No projects yet'}</div>`;
      return;
    }
    arr.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'recent-row';
      b.innerHTML = `<span>${A.escapeHtml(p.name)}</span><span class="muted">${p.ops.length} edits</span>`;
      b.addEventListener('click', () => openProject(p));
      box.appendChild(b);
    });
  }
  A.renderHomeRecent = renderHomeRecent;

  /* ================= init ================= */
  function init() {
    A.onShow = (name) => {
      if (name === 'export') { refreshExportSource(); if (A.syncExpDefaults) A.syncExpDefaults(); const ab = $('exp-copyright-ack'); if (ab) ab.checked = false; /* v26 §25: required fresh each visit */ }
      if (name === 'projects') renderProjects();
      if (name === 'settings') updateStorageInfo();
      if (name === 'home') { renderHomeRecent(); cdxUpdateNow(); }
      if (name === 'remix') A.updateRemixStemBadge();
    };    A.loadTheme();
    A.setLang('en');
    // nav
    document.querySelectorAll('.navbtn').forEach((b) => {
      b.addEventListener('click', () => {
        const s = b.getAttribute('data-screen');
        if ((s === 'editor' || s === 'remix') && !A.state.buffer) { A.needAudio(); return; }
        A.show(s);
      });
    });
    initHome();
    // import
    $('btn-pick').addEventListener('click', A.pickAudio);
    A.initImportTabs();
    $('file-input').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      let ch = Promise.resolve();
      files.forEach((f) => {
        ch = ch.then(() => f.arrayBuffer().then((ab) => decodeAndAdd(ab, f.name, f.size)));
      });
      ch.then(() => { e.target.value = ''; });
    });
    A.renderImportList();
    A.initEditor(); A.initRemix(); A.initSlowed(); A.initStems();
    // mixer / fx / mastering / beat / export / projects / settings / more
    initMixer(); initFxRack(); initMastering(); initBeat();
    initExport(); initProjects(); initSettings(); initMore();
    RM.aiStems.init();
    // AdMob: rewarded + interstitial preload (native bridge ho to; warna silent skip)
    try { if (window.RM && RM.ads) RM.ads.preload(); } catch (e) {}
    // recorder
    $('rec-btn').addEventListener('click', () => {
      if (recBusy()) return;
      A.startRecording();
    });
    A.updateRecUI = A.updateRecUI || function () {};
    // crash recovery
    RM.proj.markDirty();
    if (RM.proj.needsRecovery()) {
      const p = RM.proj.loadAutosave();
      const banner = $('recovery-banner');
      if (p && banner) {
        $('recovery-text').innerHTML = ('Found a previous project: <b>') + A.escapeHtml(p.name) + '</b> — ' + ('Recover it?');
        banner.style.display = '';
        $('recovery-yes').addEventListener('click', () => {
          banner.style.display = 'none';
          openProject(p);
        });
        $('recovery-no').addEventListener('click', () => {
          banner.style.display = 'none';
          RM.proj.discardAutosave();
          RM.proj.markCleanExit();
        });
      }
    } else {
      RM.proj.markCleanExit();
    }
    window.addEventListener('pagehide', () => RM.proj.markCleanExit());
    // ensure audio on first touch (mobile autoplay policy)
    document.addEventListener('pointerdown', () => { try { RM.audio.ensureCtx(); } catch (e) {} }, { once: true });
    // nav back-stack: root entry Home ho taaki back Home pe aakar ruke
    // (uske baad canGoBack()=false -> Java exit dialog "Exit RuhMix?").
    try { history.replaceState({ screen: 'home' }, '', String(location.href).split('#')[0] + '#home'); } catch (e) {}
    window.addEventListener('popstate', (e) => A.onPopState(e));
    A.show('home');
  }
  function recBusy() {
    // part 1 ka rec object exported nahi; recActive() source of truth hai
    // (recording + native-callback/getUserMedia ka pending window dono).
    if (A.recActive && A.recActive()) { A.stopRecording(); return true; }
    return false;
  }

  return {
    initMixer, initFxRack, initMastering, initBeat, initExport, initProjects,
    initSettings, initMore, initHome, init,
    refreshExportSource, renderProjects, openProject, sendToMixer, updateStorageInfo,
    getMixerTracks: () => mixer.tracks,
  };
  })());

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => RM.app.init());
} else {
  RM.app.init();
}
