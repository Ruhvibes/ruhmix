'use strict';
/* =====================================================================
   RuhMix w26 Worker I1 tests — run: node tests/test-v25-i1.js
   (from ~/workspace/ruhmix)

   Covers:
     1. Style presets: every preset AUDIBLY changes the output — all 66
        pairs of the 12 presets differ through applyPresetPost (no no-ops).
     2. presetBuildOpts maps beatStyle -> mega styleId ('custom' -> null).
     3. Honest null display: detectBPM/detectKey null -> song.bpm/key null
        -> card shows "BPM —" / "Key —".
     4. Mode selector routes to the correct engine (resolveEngine matrix).
     5. Nav mapping: Create tab -> v25 Create screen; old mashup screen
        still reachable from the Home dashboard.
     6. Orphan audit: zero orphans -> #bottomnav hidden; any orphan ->
        #bottomnav stays visible.
   ===================================================================== */

/* ---------------- shims ---------------- */
class FakeAudioBuffer {
  constructor(nCh, len, sr) {
    this.numberOfChannels = nCh;
    this.length = Math.max(0, len | 0);
    this.sampleRate = sr;
    this.duration = this.length / sr;
    this._ch = [];
    for (let c = 0; c < nCh; c++) this._ch.push(new Float32Array(this.length));
  }
  getChannelData(c) { return this._ch[c]; }
}

function fakeEl(tag) {
  const kids = [];
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: kids,
    className: '', id: '', textContent: '', innerHTML: '',
    hidden: false, disabled: false, style: {},
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return (k in this._attrs) ? this._attrs[k] : null; },
    appendChild(c) { kids.push(c); return c; },
    insertBefore(c, ref) { const i = kids.indexOf(ref); if (i < 0) kids.push(c); else kids.splice(i, 0, c); return c; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _all() { const out = []; (function walk(e) { out.push(e); e.children.forEach(walk); })(el); return out; },
    querySelector(sel) {
      let m = /^\[data-go="([^"]+)"\]$/.exec(sel);
      if (m) return this._all().find((e) => e.getAttribute('data-go') === m[1]) || null;
      m = /^\[data-stage="([^"]+)"\]$/.exec(sel);
      if (m) return this._all().find((e) => e.getAttribute('data-stage') === m[1]) || null;
      m = /^\.([\w-]+)$/.exec(sel);
      if (m) return this._all().find((e) => (e.className || '').split(' ').includes(m[1])) || null;
      return null;
    },
    querySelectorAll(sel) {
      const all = this._all();
      if (sel === '.hc-label') return all.filter((e) => (e.className || '').split(' ').includes('hc-label'));
      if (sel === '.v25-tab') return all.filter((e) => (e.className || '').split(' ').includes('v25-tab'));
      if (sel === '[data-act="aud"]') return all.filter((e) => e.getAttribute('data-act') === 'aud');
      return [];
    },
    getContext() { return null; },
    scrollIntoView() {},
  };
  return el;
}

// Minimal document. getElementById walks registered subtrees like the
// real DOM (renderHome appends #v25-dash into #screen-home dynamically).
function makeDocument(extra) {
  const registry = Object.assign({}, extra);
  const body = fakeEl('body');
  return {
    readyState: 'complete',
    body,
    getElementById(id) {
      for (const k of Object.keys(registry)) {
        const found = registry[k]._all().find((e) => e.id === id);
        if (found) return found;
      }
      return null;
    },
    createElement(tag) { return fakeEl(tag); },
    querySelector() { return null; },
    addEventListener() {},
  };
}

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function rmsDiff(a, b) {
  const d0 = a.getChannelData(0), d1 = b.getChannelData(0);
  const n = Math.min(d0.length, d1.length);
  let s = 0;
  for (let i = 0; i < n; i++) { const v = d0[i] - d1[i]; s += v * v; }
  return Math.sqrt(s / Math.max(1, n));
}

async function main() {
  /* ============ v25-create: presets ============ */
  global.window = {};
  const shown = [];
  // RM.app BEFORE requiring the modules so their boot() paths run.
  global.window.RM = {
    app: {
      show(name) { shown.push(name); },
      onShow: null,
      toast() {},
      cleanErrMsg(e) { return String((e && e.message) || e); },
    },
    audio: {},
    mashupDSP: {},
  };
  global.document = makeDocument({});
  // v25-shell.js uses bare `RM` (browser global semantics: window.RM is
  // visible as RM). Mirror that in node.
  global.RM = global.window.RM;
  require('../www/js/v25-arrange.js');
  require('../www/js/v25-create.js');
  const createMod = require('../www/js/v25-create.js');
  const T = createMod.internals;
  const VA = global.window.RM.v25arrange;

  console.log('== presets: list ==');
  const presets = T.listPresets();
  ok(Array.isArray(presets) && presets.length === 12, '12 style presets listed', 'got ' + presets.length);
  ok(presets.some((p) => p.id === 'custom'), 'custom preset present');

  console.log('== presets: build opts mapping ==');
  const edmOpts = T.presetBuildOpts('edm');
  ok(edmOpts && edmOpts.styleId === 'edm', "edm -> mega styleId 'edm'", JSON.stringify(edmOpts && edmOpts.styleId));
  const customOpts = T.presetBuildOpts('custom');
  ok(customOpts && customOpts.styleId === null, 'custom -> mega styleId null (auto)', String(customOpts && customOpts.styleId));
  const sadOpts = T.presetBuildOpts('sad');
  ok(sadOpts && sadOpts.xfadeBars === 1, 'sad -> xfadeBars 1 (smooth)', String(sadOpts && sadOpts.xfadeBars));
  ok(sadOpts && sadOpts.vocalBoostDb === 5, 'sad -> vocalBoostDb 5', String(sadOpts && sadOpts.vocalBoostDb));
  ok(sadOpts && Math.abs(sadOpts.tempoShift - 0.92) < 1e-9, 'sad -> tempoShift 0.92', String(sadOpts && sadOpts.tempoShift));

  console.log('== presets: every pair audibly differs (render test) ==');
  const SR = 22050;
  function synthBuf() {
    const sec = 4, n = Math.round(sec * SR);
    const ch = [new Float32Array(n), new Float32Array(n)];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      // hot, dynamic stereo mix — peaks exceed the mastering ceilings so
      // every mastering variant bites
      const v = 0.55 * Math.sin(2 * Math.PI * 55 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t))
              + 0.30 * Math.sin(2 * Math.PI * 440 * t)
              + 0.25 * Math.sin(2 * Math.PI * 5200 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * t))
              + 0.12 * rnd();
      ch[0][i] = v; ch[1][i] = v * 0.9;
    }
    return { sampleRate: SR, length: n, numberOfChannels: 2, getChannelData: (c) => ch[c] };
  }
  // riser plan placed inside the test buffer so riser presets really fire
  const riserPlan = { gridBpm: 120, sections: [{ type: 'finalChorus', startBar: 2, bars: 8 }] };
  const rendered = {};
  for (const p of presets) {
    const buf = synthBuf();
    const spec = VA.presetRenderSpec(p.id, null);
    T.applyPresetPost(buf, spec, riserPlan, 120);
    rendered[p.id] = buf;
  }
  let minDiff = Infinity, minPair = '';
  for (let i = 0; i < presets.length; i++) {
    for (let j = i + 1; j < presets.length; j++) {
      const d = rmsDiff(rendered[presets[i].id], rendered[presets[j].id]);
      if (d < minDiff) { minDiff = d; minPair = presets[i].id + ' vs ' + presets[j].id; }
    }
  }
  ok(minDiff > 1e-6, 'all 66 preset pairs differ (min RMS diff ' + minDiff.toExponential(2) + ' = ' + minPair + ')');
  const sufiCustom = rmsDiff(rendered['sufi'], rendered['custom']);
  ok(sufiCustom > 1e-6, 'tricky pair sufi vs custom differs (RMS ' + sufiCustom.toExponential(2) + ')');

  console.log('== riser plans ==');
  const mp = T.riserPlanForMega({ bpm1: 100, songs: 4, cycles: 2 });
  ok(mp && mp.gridBpm === 100 && mp.sections[0].startBar === 4 + (2 * 4 - 1) * 8,
     'mega riser plan: final chorus start bar', JSON.stringify(mp && mp.sections[0]));
  const ep = T.riserPlanForExtended(128, 9);
  ok(ep && ep.gridBpm === 128 && ep.sections[0].type === 'finalChorus', 'extended riser plan sane');

  /* ============ honest null display ============ */
  console.log('== null BPM/key display ==');
  ok(T.keyLabel(null) === '—', "keyLabel(null) === '—'");
  ok(T.cardBpmText({ bpm: null, analyzing: false }) === '♪ BPM —', 'null bpm -> "♪ BPM —"');
  ok(T.cardKeyText({ key: null, analyzing: false }) === '𝄞 Key —', 'null key -> "𝄞 Key —"');
  ok(T.cardBpmText({ bpm: 128.5, analyzing: false }) === '♪ 128.5 BPM', 'real bpm still shown');

  // analyzeSong with detectors returning null (the w26 honest contract)
  global.window.RM.audio.detectBPM = () => Promise.resolve(null);
  global.window.RM.mashupDSP.detectKey = () => Promise.resolve(null);
  const song = { id: 7, buffer: new FakeAudioBuffer(2, 44100, 44100), name: 'silence', fileName: 'silence.wav',
                 enabled: true, bpm: null, key: null, analyzing: false, err: null };
  T.analyzeSong(song);
  await new Promise((r) => setTimeout(r, 50));
  ok(song.bpm === null && song.key === null, 'null detections stay null on the song',
     'bpm=' + song.bpm + ' key=' + JSON.stringify(song.key));
  ok(T.cardBpmText(song) === '♪ BPM —' && T.cardKeyText(song) === '𝄞 Key —',
     'silence song card renders "BPM —" / "Key —"');

  /* ============ mode routing ============ */
  console.log('== mode routing ==');
  const R = T.resolveEngine;
  ok(R('classic', 2).engine === 'classic', 'classic + 2 songs -> RM.mashup.build');
  ok(R('classic', 3).engine === null, 'classic + 3 songs -> rejected (honest hint)');
  ok(R('classic', 1).engine === null, 'classic + 1 song -> rejected');
  ok(R('swap', 2).engine === 'swap', 'swap + 2 songs -> RM.mashupSwap.build');
  ok(R('swap', 3).engine === null, 'swap + 3 songs -> rejected');
  ok(R('mega', 2).engine === 'mega', 'mega + 2 songs -> RM.mashupMega.build');
  ok(R('mega', 8).engine === 'mega', 'mega + 8 songs -> RM.mashupMega.build');
  ok(R('mega', 9).engine === 'extended', 'mega + 9 songs -> extended pipeline');
  ok(R('mega', 10).engine === 'extended', 'mega + 10 songs -> extended pipeline');
  ok(R('mega', 1).engine === null, 'mega + 1 song -> rejected');
  ok(R('mega', 11).engine === null, 'mega + 11 songs -> rejected');
  ok(R('classic', 3).reason.indexOf('exactly 2') >= 0, 'rejection reason names the contract');

  /* ============ v25-shell: nav mapping + orphan audit ============ */
  console.log('== nav mapping ==');
  const homeEl = fakeEl('section'); homeEl.id = 'screen-home';
  const moreGrid = fakeEl('div'); moreGrid.id = 'more-grid';
  const bottomnav = fakeEl('nav'); bottomnav.id = 'bottomnav';
  // app.js's 9 built-in More cards (MORE_LINKS labels)
  const BUILTIN_LABELS = ['Slowed+Reverb Studio', 'Stem Separator', 'AI Stem Separator',
    'FX Rack', 'Mastering', 'Voice Recorder', 'Export', 'Projects', 'Settings'];
  for (const lb of BUILTIN_LABELS) {
    const b = fakeEl('button'); b.className = 'home-card';
    const ic = fakeEl('div'); ic.className = 'hc-icon'; ic.textContent = '•';
    const tx = fakeEl('div'); tx.className = 'hc-label'; tx.textContent = lb;
    b.appendChild(ic); b.appendChild(tx);
    moreGrid.appendChild(b);
  }
  global.document = makeDocument({ 'screen-home': homeEl, 'more-grid': moreGrid, 'bottomnav': bottomnav });
  require('../www/js/v25-shell.js');
  const SH = global.window.RM.v25shell;

  const createTab = SH.TABS.find((t) => t.id === 'create');
  ok(createTab && createTab.screen === 'v25create', 'Create tab maps to the v25 Create screen');
  // go('create') with the real module loaded -> delegates to RM.v25create.show()
  shown.length = 0;
  SH.go('create');
  ok(shown[shown.length - 1] === 'v25create', "go('create') reaches the v25 Create screen", 'got ' + shown[shown.length - 1]);
  // old mashup screen still reachable from the Home dashboard
  shown.length = 0;
  SH.quickAiMashup();
  ok(shown[shown.length - 1] === 'mashup', "Quick AI Mashup still opens the old mashup screen");

  console.log('== orphan audit ==');
  const orphans = SH.auditAndHideOldNav();
  ok(Array.isArray(orphans) && orphans.length === 0, 'zero orphaned screens', 'orphans: ' + orphans.join(','));
  ok(bottomnav.style.display === 'none', '#bottomnav hidden when zero orphans');
  for (const s of ['mashup', 'editor', 'remix', 'mixer']) {
    ok(!!moreGrid.querySelector('[data-go="' + s + '"]'), 'More grid has a "' + s + '" destination');
  }
  ok(!!homeEl.querySelector('[data-go="more"]'), 'Home dashboard has a More Tools card');
  ok(!!homeEl.querySelector('[data-go="import"]'), 'Home dashboard keeps the Import card');

  // negative: drop a More-grid-only destination -> audit fails -> nav stays
  const moreGrid2 = fakeEl('div'); moreGrid2.id = 'more-grid';
  const NEG_LABELS = BUILTIN_LABELS.filter((lb) => lb !== 'Export'); // 'Export' card missing
  for (const lb of NEG_LABELS) {
    const b = fakeEl('button'); b.className = 'home-card';
    const tx = fakeEl('div'); tx.className = 'hc-label'; tx.textContent = lb;
    b.appendChild(tx); moreGrid2.appendChild(b);
  }
  const bottomnav2 = fakeEl('nav'); bottomnav2.id = 'bottomnav';
  const homeEl2 = fakeEl('section'); homeEl2.id = 'screen-home';
  global.document = makeDocument({ 'screen-home': homeEl2, 'more-grid': moreGrid2, 'bottomnav': bottomnav2 });
  delete require.cache[require.resolve('../www/js/v25-shell.js')];
  require('../www/js/v25-shell.js');
  const SH2 = global.window.RM.v25shell;
  const orphans2 = SH2.orphanScreens();
  ok(orphans2.indexOf('export') >= 0, 'missing Export card detected as orphan', 'orphans: ' + orphans2.join(','));
  SH2.auditAndHideOldNav();
  ok(bottomnav2.style.display !== 'none', '#bottomnav stays visible when orphans exist');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
