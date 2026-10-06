'use strict';
/* =====================================================================
   RuhMix — stem-deck.js
   SHARED dynamic stem-card deck — the Moises-like results experience.

   render(container, stems, opts):
     stems: [{ name, buffer, role, badge }]   (2, 4 or 6 stems — the deck
              renders exactly as many cards as it is given; it never
              invents stems a backend did not return)
       role: 'vocal' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other'
             | 'low' | 'lowmid' | 'presence' | 'air' (DSP bands)
       badge: short honest tag shown on the card, e.g. 'AI', 'HF', 'DSP'
     opts: { title, honest, showFullInstrumental (default true),
             showToMixer (default true), experimental (default false) }

   Every card: Play (synced deck mix), Volume slider, Pan slider,
   Mute, Solo, Export (individual).

   Playback model: the deck is a tiny synced mixer. Each card owns
   source -> volGain -> panner -> gate(mute/solo) -> deckMaster ->
   destination. Pressing a card's Play adds that stem to the running mix
   (all audible stems stay sample-synced via one shared transport clock);
   pressing again removes it. Mute/Solo/Vol/Pan apply live.
   "Full Instrumental" renders one mix of every NON-vocal stem
   (OfflineAudioContext) with its own preview + export.
   ===================================================================== */
window.RM = window.RM || {};

RM.stemDeck = (function () {
  const ROLE_META = {
    vocal:    { icon: '🎤', label: 'Vocals' },
    drums:    { icon: '🥁', label: 'Drums' },
    bass:     { icon: '🎸', label: 'Bass' },
    guitar:   { icon: '🎸', label: 'Guitar' },
    piano:    { icon: '🎹', label: 'Piano' },
    other:    { icon: '🎵', label: 'Other' },
    low:      { icon: '🎚️', label: 'Bass (band)' },
    lowmid:   { icon: '🎚️', label: 'Low-Mid (band)' },
    presence: { icon: '🎚️', label: 'Presence (band)' },
    air:      { icon: '🎚️', label: 'Air (band)' },
  };
  function metaFor(role) {
    return ROLE_META[role] || { icon: '🎵', label: String(role || 'Stem') };
  }

  const decks = []; // active decks — stopAllDecks() silences every one
  function stopAllDecks() {
    decks.slice().forEach((d) => { try { d.stop(); } catch (e) {} });
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================= deck ================= */
  function render(container, stems, opts) {
    opts = opts || {};
    const list = (stems || []).filter((s) => s && s.buffer);
    // Dispose a previous deck living in this container.
    try {
      if (container && container._stemDeck) container._stemDeck.dispose();
    } catch (e) {}
    container.innerHTML = '';
    if (!list.length) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">🎵</div>No stems to show.</div>';
      return null;
    }
    let ctx = null;
    try { ctx = RM.audio.ensureCtx(); } catch (e) {
      container.innerHTML = '<div class="err">Web Audio is not available on this device.</div>';
      return null;
    }

    const deck = {
      cards: [], pos: 0, playing: false, t0: 0,
      master: null, instPlayer: null, disposed: false,
    };
    decks.push(deck);
    container._stemDeck = deck;

    deck.master = ctx.createGain();
    deck.master.gain.value = 1;
    // Live deck mixes go through the guarded master chain (limiter + safety
    // clipper), like the studio player — never raw to the DAC. Stacked
    // stems at up to 120% vol would otherwise digitally clip.
    try { deck.master.connect(RM.audio.masterIn()); }
    catch (e) { deck.master.connect(ctx.destination); }

    const head = document.createElement('div');
    head.className = 'deck-head';
    head.innerHTML =
      (opts.title ? `<div class="deck-title">${esc(opts.title)}</div>` : '') +
      (opts.honest ? `<div class="honest">${opts.honest}</div>` : '') +
      (opts.experimental
        ? '<div class="honest">⚗️ <b>Experimental (DSP) — not neural AI.</b> Classical signal processing only; expect bleed between stems.</div>'
        : '');
    container.appendChild(head);

    /* ---- transport helpers ---- */
    function deckNow() { return (ctx.currentTime - deck.t0) % 1e9; }
    function applyGate(c) {
      const anySolo = deck.cards.some((x) => x.solo);
      const audible = !c.mute && (!anySolo || c.solo);
      try { c.gate.gain.setTargetAtTime(audible ? 1 : 0, ctx.currentTime, 0.015); } catch (e) {}
    }
    function refreshGates() { deck.cards.forEach(applyGate); }
    function startCard(c) {
      if (c.playing || deck.disposed) return;
      const off = deck.playing ? deckNow() % c.stem.buffer.duration : deck.pos % c.stem.buffer.duration;
      const src = ctx.createBufferSource();
      src.buffer = c.stem.buffer;
      src.loop = true;
      src.connect(c.vol);
      try { src.start(0, Math.max(0, off)); } catch (e) { try { src.start(0, 0); } catch (e2) {} }
      c.src = src;
      c.playing = true;
      if (!deck.playing) { deck.playing = true; deck.t0 = ctx.currentTime - deck.pos; }
      c.playBtn.textContent = '⏸';
      c.playBtn.classList.add('primary');
      updateStopBtn();
    }
    function pauseCard(c, keepPos) {
      if (!c.playing) return;
      if (!keepPos) deck.pos = deck.playing ? deckNow() % c.stem.buffer.duration : deck.pos;
      try { c.src.stop(0); } catch (e) {}
      try { c.src.disconnect(); } catch (e) {}
      c.src = null;
      c.playing = false;
      c.playBtn.textContent = '▶';
      c.playBtn.classList.remove('primary');
      if (!deck.cards.some((x) => x.playing)) { deck.playing = false; }
      updateStopBtn();
    }

    /* ---- deck-level stop ---- */
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn small ghost';
    stopBtn.style.display = 'none';
    stopBtn.textContent = '⏹ Stop all';
    stopBtn.addEventListener('click', () => deck.stop());
    function updateStopBtn() {
      stopBtn.style.display = deck.cards.some((c) => c.playing) ? '' : 'none';
    }
    deck.stop = function () {
      if (deck.playing && deck.cards.length) {
        try { deck.pos = deckNow() % deck.cards[0].stem.buffer.duration; } catch (e) {}
      }
      deck.cards.forEach((c) => pauseCard(c, true));
      deck.playing = false;
      try { if (deck.stopInst) deck.stopInst(); } catch (e) {}
      updateStopBtn();
    };
    deck.dispose = function () {
      deck.disposed = true;
      deck.stop();
      deck.cards.forEach((c) => {
        try { c.vol.disconnect(); } catch (e) {}
        try { c.pan.disconnect(); } catch (e) {}
        try { c.gate.disconnect(); } catch (e) {}
      });
      try { deck.master.disconnect(); } catch (e) {}
      const i = decks.indexOf(deck);
      if (i >= 0) decks.splice(i, 1);
      if (container && container._stemDeck === deck) container._stemDeck = null;
    };

    /* ---- cards ---- */
    const grid = document.createElement('div');
    grid.className = 'deck-grid';
    container.appendChild(grid);

    list.forEach((s) => {
      const m = metaFor(s.role);
      const card = document.createElement('div');
      card.className = 'stem-card';
      card.innerHTML = `
        <div class="sc-head">
          <span class="sc-icon">${m.icon}</span>
          <div class="sc-titles">
            <div class="sc-name">${esc(s.name || m.label)}${s.badge ? ` <span class="beta">${esc(s.badge)}</span>` : ''}</div>
            <div class="sc-meta muted small">${fmtTime(s.buffer.duration)} • ${s.buffer.sampleRate} Hz</div>
          </div>
        </div>
        <div class="sc-transport">
          <button class="btn small sc-play" title="Play / pause this stem">▶</button>
          <button class="btn small tog sc-mute" title="Mute">M</button>
          <button class="btn small tog sc-solo" title="Solo">S</button>
          <button class="btn small ghost sc-exp" title="Export this stem">📤</button>
        </div>
        <div class="sc-row"><label>Vol</label><input type="range" class="sc-vol" min="0" max="120" value="100"><span class="sc-volv">100%</span></div>
        <div class="sc-row"><label>Pan</label><input type="range" class="sc-pan" min="-100" max="100" value="0"><span class="sc-panv">C</span></div>`;
      grid.appendChild(card);

      const c = {
        stem: s, vol: null, pan: null, gate: null, src: null,
        playing: false, mute: false, solo: false,
        playBtn: card.querySelector('.sc-play'),
      };
      c.vol = ctx.createGain(); c.vol.gain.value = 1;
      c.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      c.gate = ctx.createGain(); c.gate.gain.value = 1;
      if (c.pan) { c.vol.connect(c.pan); c.pan.connect(c.gate); }
      else { c.vol.connect(c.gate); }
      c.gate.connect(deck.master);

      // Stop everything else (studio player, other decks) before our mix starts.
      c.playBtn.addEventListener('click', () => {
        if (c.playing) { pauseCard(c); return; }
        try { if (window.RM && RM.app && RM.app.stopAll) RM.app.stopAll(); } catch (e) {}
        stopAllDecksExcept(deck);
        startCard(c);
      });
      const muteBtn = card.querySelector('.sc-mute');
      muteBtn.addEventListener('click', () => {
        c.mute = !c.mute;
        muteBtn.classList.toggle('on', c.mute);
        refreshGates();
      });
      const soloBtn = card.querySelector('.sc-solo');
      soloBtn.addEventListener('click', () => {
        c.solo = !c.solo;
        soloBtn.classList.toggle('on', c.solo);
        refreshGates();
      });
      const volIn = card.querySelector('.sc-vol');
      const volV = card.querySelector('.sc-volv');
      volIn.addEventListener('input', () => {
        const v = (+volIn.value) / 100;
        volV.textContent = volIn.value + '%';
        try { c.vol.gain.setTargetAtTime(v, ctx.currentTime, 0.02); } catch (e) {}
      });
      const panIn = card.querySelector('.sc-pan');
      const panV = card.querySelector('.sc-panv');
      panIn.addEventListener('input', () => {
        const v = (+panIn.value) / 100;
        panV.textContent = v === 0 ? 'C' : (v < 0 ? 'L' + Math.round(-v * 100) : 'R' + Math.round(v * 100));
        if (c.pan) { try { c.pan.pan.setTargetAtTime(v, ctx.currentTime, 0.02); } catch (e) {} }
      });
      card.querySelector('.sc-exp').addEventListener('click', () => {
        try {
          const A = window.RM && RM.app;
          if (!A) return;
          A.state.exportSource = { kind: 'buffer', buffer: s.buffer, name: s.name || m.label };
          A.show('export');
          if (A.refreshExportSource) A.refreshExportSource();
        } catch (e) {}
      });
      deck.cards.push(c);
    });
    container.appendChild(stopBtn);

    /* ---- Full Instrumental (one tap): mix of every non-vocal stem ---- */
    const nonVocal = deck.cards.filter((c) => (c.stem.role || '') !== 'vocal');
    if (opts.showFullInstrumental !== false && nonVocal.length) {
      const instBox = document.createElement('div');
      instBox.className = 'panel deck-inst';
      instBox.innerHTML = `
        <div class="deck-inst-head">🎸 <b>Full Instrumental</b> <span class="muted small">— everything except vocals, one tap</span></div>
        <div class="btn-row">
          <button class="btn primary" data-a="make">🎸 Make Instrumental</button>
        </div>
        <div class="deck-inst-out" style="display:none">
          <div class="ok" style="margin:6px 0">✓ Instrumental ready</div>
          <div class="btn-row">
            <button class="btn small" data-a="play">▶ Preview</button>
            <button class="btn small ghost" data-a="exp">📤 Export</button>
          </div>
        </div>`;
      container.appendChild(instBox);
      let instBuf = null;
      const outBox = instBox.querySelector('.deck-inst-out');
      const mkBtn = instBox.querySelector('[data-a="make"]');
      const playBtn = instBox.querySelector('[data-a="play"]');
      function stopInst() {
        if (deck.instPlayer) { try { deck.instPlayer.stop(true); } catch (e) {} try { deck.instPlayer.dispose(); } catch (e) {} deck.instPlayer = null; }
        if (playBtn) playBtn.textContent = '▶ Preview';
      }
      deck.stopInst = stopInst;
      mkBtn.addEventListener('click', async () => {
        mkBtn.disabled = true;
        mkBtn.textContent = 'Rendering…';
        try {
          instBuf = await renderInstrumental(nonVocal.map((c) => c.stem));
          outBox.style.display = '';
          stopInst();
        } catch (e) {
          try { if (window.RM && RM.app) RM.app.toast('Could not render the instrumental'); } catch (e2) {}
        }
        mkBtn.disabled = false;
        mkBtn.textContent = '🎸 Make Instrumental';
      });
      playBtn.addEventListener('click', () => {
        if (!instBuf) return;
        if (deck.instPlayer) { stopInst(); return; }
        try { if (window.RM && RM.app && RM.app.stopAll) RM.app.stopAll(); } catch (e) {}
        stopAllDecksExcept(deck);
        deck.stop();
        const p = RM.audio.makePlayer();
        deck.instPlayer = p;
        p.load(instBuf);
        p.play(0);
        playBtn.textContent = '⏸ Preview';
        p.onended = () => { playBtn.textContent = '▶ Preview'; deck.instPlayer = null; };
      });
      instBox.querySelector('[data-a="exp"]').addEventListener('click', () => {
        if (!instBuf) return;
        try {
          const A = window.RM && RM.app;
          A.state.exportSource = { kind: 'buffer', buffer: instBuf, name: 'Full Instrumental' };
          A.show('export');
          if (A.refreshExportSource) A.refreshExportSource();
        } catch (e) {}
      });
    }

    /* ---- Load all into Mixer ---- */
    if (opts.showToMixer !== false) {
      const mixBtn = document.createElement('button');
      mixBtn.className = 'btn primary block';
      mixBtn.style.marginTop = '10px';
      mixBtn.textContent = '🎛️ Load all stems into the Mixer';
      mixBtn.addEventListener('click', () => {
        try {
          const A = window.RM && RM.app;
          deck.cards.forEach((c) => A.sendToMixer(c.stem.buffer, c.stem.name || metaFor(c.stem.role).label));
          A.show('mixer');
        } catch (e) {}
      });
      container.appendChild(mixBtn);
    }
    return deck;
  }

  function stopAllDecksExcept(deck) {
    decks.slice().forEach((d) => { if (d !== deck) { try { d.stop(); } catch (e) {} } });
  }

  /* Mix non-vocal stems at unity into one stereo buffer (offline). */
  async function renderInstrumental(stems) {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const bufs = stems.map((s) => s.buffer).filter(Boolean);
    if (!bufs.length) throw new Error('no stems');
    const sr = bufs[0].sampleRate;
    const len = Math.max.apply(null, bufs.map((b) => b.length));
    const oc = new OC(2, len, sr);
    const out = oc.createGain();
    // Headroom: N stems summed at unity can clip — scale by 1/sqrt(N).
    out.gain.value = 1 / Math.sqrt(bufs.length);
    out.connect(oc.destination);
    bufs.forEach((b) => {
      const src = oc.createBufferSource();
      src.buffer = b;
      src.connect(out);
      src.start(0);
    });
    return oc.startRendering();
  }

  // Node unit tests (browser me harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { api: { render, stopAllDecks }, internals: { metaFor, renderInstrumental } };
    }
  } catch (e) {}

  return { render, stopAllDecks, metaFor };
})();
