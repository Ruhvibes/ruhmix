'use strict';
/* =====================================================================
   RuhMix v29 Worker J2 tests — P2-5 / P2-6 / P2-7 / P2-8 fixes.

   Covers:
     P2-5  §14 Mashup Settings UI on the Create screen:
             - getSettingsUI() declares 6 rows, each with label, options
               and a real engine mapping (mapsTo).
             - setSetting() merges into st.settings and every choice lands
               in the render spec (mastering/effects/vocalFocus/energy/
               transition/length+customMin) — the values the engine consumes.
             - effects=minimal really disables risers; heavy really scales
               reverb; mastering=loud really switches the comp profile.
             - settingsSummary() reports only non-default choices.
             - renderSettings() builds the toggle + (when open) all 6 rows.
             - setSetting() is blocked during a build (P2-7 lock).
             - trimToLength(): over-budget mixes are trimmed from the tail
               with a click-free fade; under-budget mixes pass through
               untouched.
     P2-6  clearStaleResult() toasts with the reason when a finished
           result is dropped; stays silent when there was no result.
     P2-7  selectMode/selectPreset are no-ops (+toast) while creating;
           chips render disabled+dimmed during a build, enabled after.
     P2-8  unified create route:
             - quickAiMashup() lands on the v25 Create screen.
             - Home dashboard has no duplicate "Quick AI Mashup" card.
             - More-grid "Classic Mashup" routes to v25create; no old
               mashup-screen route remains in the More grid or ROUTES.
             - app.js: the #home-mashup button and the "Go to Create"
               dialog both route to v25create now.

   Run:  node tests/test-v29-j2.js   (from ~/workspace/ruhmix)
   ===================================================================== */
const fs = require('fs');
const path = require('path');

/* ---------------- shims (same shape as test-v25-i1.js) ---------------- */
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
const fakeCtx = {
  sampleRate: 22050,
  createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || 22050),
};

function fakeEl(tag) {
  const kids = [];
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: kids,
    className: '', id: '', textContent: '', innerHTML: '',
    hidden: false, disabled: false, style: {}, value: '',
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
function buttonsOf(el) { return el._all().filter((e) => e.tagName === 'BUTTON'); }

async function main() {
  /* ============ module load ============ */
  global.window = {};
  const shown = [], toasts = [];
  global.window.RM = {
    app: {
      show(name) { shown.push(name); },
      onShow: null,
      toast(m) { toasts.push(String(m)); },
      cleanErrMsg(e) { return String((e && e.message) || e); },
    },
    audio: { ensureCtx: () => fakeCtx },
    mashupDSP: {},
  };
  global.RM = global.window.RM;
  const reg = {};
  for (const id of ['v25-settings', 'v25-modes', 'v25-presets', 'v25-preset-desc',
                    'v25-result', 'v25-play', 'v25-songs', 'v25-create',
                    'v25-hint', 'v25-mode-note', 'v25-count', 'v25-add',
                    'v25-memwarn']) {
    const e = fakeEl('div'); e.id = id; reg[id] = e;
  }
  global.document = makeDocument(reg);
  require('../www/js/v25-arrange.js');
  const createMod = require('../www/js/v25-create.js');
  const T = createMod.internals;
  const VA = global.window.RM.v25arrange;

  /* ============ P2-5: §14 settings UI spec ============ */
  console.log('== P2-5: settings UI spec ==');
  const ui = VA.getSettingsUI();
  ok(Array.isArray(ui) && ui.length === 6, 'getSettingsUI declares 6 rows', 'got ' + (ui && ui.length));
  const ids = ui.map((r) => r.id).sort().join(',');
  ok(ids === 'effects,energy,length,mastering,transition,vocalFocus',
     'the 6 §14 settings are present', ids);
  let specOk = true, specWhy = '';
  for (const r of ui) {
    if (!r.label || !Array.isArray(r.options) || !r.options.length || !r.mapsTo) {
      specOk = false; specWhy = r.id; break;
    }
  }
  ok(specOk, 'every row has label + options + a real engine mapping (mapsTo)', specWhy);
  const lenRow = ui.find((r) => r.id === 'length');
  ok(!!(lenRow && lenRow.custom && lenRow.custom.id === 'customMin'),
     'length row carries the custom-minutes sub-control');

  /* ============ P2-5: settings -> render spec plumbing ============ */
  console.log('== P2-5: settings plumbed into the render spec ==');
  ok(T.getSettings() === null, 'settings start null (= defaults)');
  let spec = T.presetSpec('edm');
  ok(spec && spec.masteringName === 'balanced' && spec.effects === 'balanced',
     'defaults: mastering balanced, effects balanced', JSON.stringify(spec && { m: spec.masteringName, e: spec.effects }));
  ok(T.setSetting('mastering', 'loud') === true, 'setSetting(mastering, loud) accepted');
  spec = T.presetSpec('edm');
  ok(spec.masteringName === 'loud' && spec.mastering.ratio === 3 && spec.mastering.thresholdDb === -9,
     'mastering=loud reaches the spec (ratio 3, thresh -9 dB)',
     JSON.stringify({ n: spec.masteringName, r: spec.mastering && spec.mastering.ratio }));
  T.setSetting('effects', 'heavy');
  spec = T.presetSpec('edm');
  ok(Math.abs(spec.reverbWet - 1.76) < 1e-9 && Math.abs(spec.delayWet - 1.44) < 1e-9,
     'effects=heavy scales reverb x2.2 / delay x1.8', 'reverbWet=' + spec.reverbWet + ' delayWet=' + spec.delayWet);
  ok(spec.risers === true, 'edm risers still allowed under heavy effects');
  T.setSetting('effects', 'minimal');
  spec = T.presetSpec('edm');
  ok(spec.risers === false, 'effects=minimal really disables risers');
  ok(Math.abs(spec.sidechainDb - Math.max(0.5, 4.5 - 1)) < 1e-9,
     'effects=minimal trims sidechain -1 dB', 'sidechainDb=' + spec.sidechainDb);
  T.setSetting('effects', 'balanced');
  T.setSetting('vocalFocus', 'high');
  spec = T.presetSpec('edm');
  ok(spec.vocalBoostDb === 5, 'vocalFocus=high: vocalBoostDb = base 3 + 2', String(spec.vocalBoostDb));
  T.setSetting('vocalFocus', 'low');
  spec = T.presetSpec('edm');
  ok(spec.vocalBoostDb === 1.5, 'vocalFocus=low: vocalBoostDb = base 3 - 1.5', String(spec.vocalBoostDb));
  T.setSetting('vocalFocus', 'balanced');
  T.setSetting('energy', 'low');
  spec = T.presetSpec('edm');
  ok(spec.energyTarget === 0.30, 'energy=low: energyTarget 0.30', String(spec.energyTarget));
  T.setSetting('energy', 'dynamic');
  T.setSetting('transition', 'cinematic');
  spec = T.presetSpec('edm');
  ok(spec.xfadeBars === 2 && spec.transition === 'cinematic',
     'transition=cinematic: xfadeBars 2', 'xfadeBars=' + spec.xfadeBars);
  T.setSetting('transition', 'auto');
  T.setSetting('length', 'custom');
  T.setSetting('customMin', 2);
  spec = T.presetSpec('edm');
  ok(spec.lengthMin === 2, 'length=custom + customMin=2: lengthMin 2', String(spec.lengthMin));
  // presetBuildOpts (the engine handoff) sees the same spec
  const po = T.presetBuildOpts('edm');
  ok(po && po.spec && po.spec.masteringName === 'loud' && po.spec.lengthMin === 2,
     'presetBuildOpts carries settings into the engine handoff');
  ok(po.xfadeBars === spec.xfadeBars && po.vocalBoostDb === spec.vocalBoostDb,
     'presetBuildOpts xfade/vocalBoost follow the spec');

  console.log('== P2-5: settings summary ==');
  ok(T.settingsSummary(VA.defaultSettings()) === '', 'summary empty for defaults');
  const sum = T.settingsSummary(T.getSettings());
  ok(/Mastering: loud/i.test(sum) && /Length: 2 min/i.test(sum),
     'summary lists non-default choices only', sum);
  // reset to defaults for later tests
  for (const [k, v] of [['mastering', 'balanced'], ['effects', 'balanced'],
                        ['vocalFocus', 'balanced'], ['energy', 'dynamic'],
                        ['transition', 'auto'], ['length', '3']]) T.setSetting(k, v);
  ok(T.settingsSummary(T.getSettings()) === '', 'summary empty after reset');

  console.log('== P2-5: settings panel DOM ==');
  const host = reg['v25-settings'];
  // NOTE: the fake DOM's innerHTML='' does not drop children (real DOM
  // does), so reset the child list before each render under test.
  host.children.length = 0;
  T._setSettingsOpen(false);
  T.renderSettings();
  const kidsClosed = host.children.slice();
  ok(kidsClosed.length === 1 && kidsClosed[0].tagName === 'BUTTON' &&
     /Mashup Settings/.test(kidsClosed[0].textContent),
     'collapsed: single toggle button');
  host.children.length = 0;
  T._setSettingsOpen(true);
  T.renderSettings();
  const rows = host._all().filter((e) => e.className === 'v25-set-row');
  ok(rows.length === 6, 'open: all 6 settings rows rendered', 'got ' + rows.length);
  const optButtons = buttonsOf(host).filter((b) => b !== host.children[0]);
  ok(optButtons.length >= 6 * 3, 'every row has its segmented option buttons', 'got ' + optButtons.length);
  T._setSettingsOpen(false);

  console.log('== P2-5: trimToLength (real length cap) ==');
  const SR = 22050, BPM = 100;
  const longBuf = new FakeAudioBuffer(2, Math.round(200 * SR), SR); // 200 s
  for (let c = 0; c < 2; c++) { const d = longBuf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.5; }
  const barLen = Math.round(240 / BPM * SR); // 52920
  const trimmed = T.trimToLength(longBuf, BPM, 1); // budget: clamp(25,32,400)=32 bars
  ok(trimmed !== longBuf && trimmed.length === 32 * barLen,
     'over-budget mix trimmed to the bar budget', 'len=' + trimmed.length + ' want=' + 32 * barLen);
  let kept = true;
  const td = trimmed.getChannelData(0), sd = longBuf.getChannelData(0);
  for (let i = 0; i < trimmed.length - Math.round(0.05 * SR) - 1; i += 997) {
    if (Math.abs(td[i] - sd[i]) > 1e-9) { kept = false; break; }
  }
  ok(kept, 'audio before the cut is byte-identical');
  ok(Math.abs(td[trimmed.length - 1]) < 1e-9, '50 ms fade lands at ~0 (no click)');
  const shortBuf = new FakeAudioBuffer(2, Math.round(60 * SR), SR); // 60 s < 3-min budget
  ok(T.trimToLength(shortBuf, BPM, 3) === shortBuf, 'under-budget mix passes through untouched');
  ok(T.trimToLength(longBuf, null, 1) === longBuf, 'invalid BPM: untouched');
  ok(T.trimToLength(null, BPM, 1) === null, 'null buffer: null');

  console.log('== P2-5/P2-7: setSetting blocked during a build ==');
  toasts.length = 0;
  T._setCreating(true);
  ok(T.setSetting('mastering', 'loud') === false, 'setSetting returns false while creating');
  ok(T.getSettings().mastering === 'balanced', 'settings unchanged while creating');
  ok(toasts.length === 1 && /still building/i.test(toasts[0]), 'honest toast while creating', toasts[0]);
  T._setCreating(false);

  /* ============ P2-6: stale-result toast ============ */
  console.log('== P2-6: stale result clears with a reason ==');
  const resEl = reg['v25-result'];
  resEl.hidden = false;
  T._setResult(longBuf);
  toasts.length = 0;
  T.clearStaleResult();
  ok(resEl.hidden === true, 'result panel hidden');
  ok(toasts.length === 1 && /cleared/i.test(toasts[0]) && /create/i.test(toasts[0]),
     'toast explains why Preview/Export vanished', toasts[0]);
  toasts.length = 0;
  T.clearStaleResult(); // no result -> must stay silent
  ok(toasts.length === 0, 'no toast when there was nothing to clear');

  /* ============ P2-7: chips lock during a build ============ */
  console.log('== P2-7: mode/preset chips lock while creating ==');
  toasts.length = 0;
  const st0 = T._getState();
  T._setCreating(true);
  T.selectMode('swap');
  T.selectPreset('edm');
  const st1 = T._getState();
  ok(st1.mode === st0.mode && st1.presetId === st0.presetId,
     'mode/preset unchanged while creating', JSON.stringify({ mode: st1.mode, preset: st1.presetId }));
  ok(toasts.length === 2 && toasts.every((t) => /still building/i.test(t)),
     'both blocked taps toast honestly');
  T.renderModeChips();
  T.renderPresetChips();
  reg['v25-modes'].children.length = 0;   // fake-DOM reset (see note above)
  reg['v25-presets'].children.length = 0;
  T.renderModeChips();
  T.renderPresetChips();
  const modeBtns = buttonsOf(reg['v25-modes']);
  const presetBtns = buttonsOf(reg['v25-presets']);
  ok(modeBtns.length === 3 && modeBtns.every((b) => b.disabled === true),
     'mode chips render disabled during a build');
  ok(presetBtns.length === 12 && presetBtns.every((b) => b.disabled === true),
     'preset chips render disabled during a build', 'got ' + presetBtns.length);
  T._setCreating(false);
  reg['v25-modes'].children.length = 0;
  reg['v25-presets'].children.length = 0;
  T.renderModeChips();
  T.renderPresetChips();
  ok(buttonsOf(reg['v25-modes']).every((b) => b.disabled === false),
     'mode chips re-enabled after the build');
  // and they work again
  T.selectMode('swap');
  ok(T._getState().mode === 'swap', 'selectMode works when idle');
  T.selectMode('mega');
  T.selectPreset('edm');
  ok(T._getState().presetId === 'edm', 'selectPreset works when idle');
  T.selectPreset('custom');

  /* ============ P2-8: unified create route ============ */
  console.log('== P2-8: one create route ==');
  const homeEl = fakeEl('section'); homeEl.id = 'screen-home';
  const moreGrid = fakeEl('div'); moreGrid.id = 'more-grid';
  const bottomnav = fakeEl('nav'); bottomnav.id = 'bottomnav';
  const BUILTIN_LABELS = ['Slowed+Reverb Studio', 'Stem Separator', 'AI Stem Separator',
    'FX Rack', 'Mastering', 'Voice Recorder', 'Export', 'Projects', 'Settings'];
  for (const lb of BUILTIN_LABELS) {
    const b = fakeEl('button'); b.className = 'home-card';
    const tx = fakeEl('div'); tx.className = 'hc-label'; tx.textContent = lb;
    b.appendChild(tx); moreGrid.appendChild(b);
  }
  global.document = makeDocument({ 'screen-home': homeEl, 'more-grid': moreGrid, 'bottomnav': bottomnav });
  require('../www/js/v25-shell.js');
  const SH = global.window.RM.v25shell;

  shown.length = 0;
  SH.quickAiMashup();
  ok(shown[shown.length - 1] === 'v25create', 'quickAiMashup redirects to the v25 Create screen',
     'got ' + shown[shown.length - 1]);
  const dashIds = homeEl._all().map((e) => e.id);
  ok(dashIds.indexOf('v25-c-create') >= 0, 'Home keeps the single Create New Mashup card');
  ok(dashIds.indexOf('v25-c-quick') < 0, 'no duplicate Quick AI Mashup card on Home');
  ok(!SH.ROUTES.some((r) => r.screen === 'mashup'), 'ROUTES has no old mashup-screen destination');
  SH.augmentMore();
  ok(!!moreGrid.querySelector('[data-go="v25create"]'),
     'More-grid "Classic Mashup" routes to v25create');
  ok(!moreGrid.querySelector('[data-go="mashup"]'), 'no old mashup-screen route in the More grid');
  const classicCard = moreGrid.querySelector('[data-go="v25create"]');
  const classicLabel = classicCard._all().find((e) => (e.className || '').split(' ').includes('hc-label'));
  ok(classicLabel && classicLabel.textContent === 'Classic Mashup', 'More-grid card keeps its familiar label');
  const orphans = SH.orphanScreens();
  ok(orphans.length === 0, 'orphan audit still clean', 'orphans: ' + orphans.join(','));

  // static: app.js routes
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'app.js'), 'utf8');
  const appLines = appJs.split('\n');
  const mashBtnLine = appLines.find((l) => l.indexOf('mashBtn.addEventListener') >= 0);
  ok(!!mashBtnLine && /v25create/.test(mashBtnLine),
     '#home-mashup button routes to v25create', (mashBtnLine || '').trim().slice(0, 120));
  const goCreateLine = appJs.split('\n').find((l) => l.indexOf('Go to Create') >= 0);
  ok(!!goCreateLine && /v25create/.test(goCreateLine),
     '"Go to Create" dialog routes to v25create', (goCreateLine || '').trim().slice(0, 120));
  ok(!/\.show\('mashup'\)/.test(appJs),
     'no UI route in app.js still opens the old mashup screen');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
