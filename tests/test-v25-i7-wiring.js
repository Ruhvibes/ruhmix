'use strict';
/* =====================================================================
   RuhMix — test-v25-i7-wiring.js (Worker I7)
   Wiring tests: loads the REAL www/js/app.js with a fake DOM and drives
   the REAL renderProjects(). Simulates clicks on the per-row
   Rename / Duplicate / Continue / Export-again / Delete buttons of
   mashup project rows and asserts end-to-end behaviour with the REAL
   RM.v25projects module underneath (mocked only at the edges:
   RM.mashupScreen, RM.v25studio, RM.v25exportui, A.dialog/toast/show).

   Run:  node tests/test-v25-i7-wiring.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

/* ---------- fake DOM ---------- */
function makeButton() {
  return {
    _handlers: {},
    style: {},
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    click() { (this._handlers.click || []).slice().forEach((fn) => fn()); },
  };
}
function makeDiv() {
  const el = {
    className: '', _html: '', children: [], _btns: {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector(sel) {
      const m = /data-a="([a-z]+)"/.exec(sel || '');
      return (m && this._btns[m[1]]) || null;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this.children = []; // real DOM: setting innerHTML clears children
      this._btns = {};
      const re = /data-a="([a-z]+)"/g;
      let m;
      while ((m = re.exec(this._html))) this._btns[m[1]] = makeButton();
    },
  });
  return el;
}
const domIds = {};
const box = makeDiv(); // persistent #projects-list across renders
domIds['projects-list'] = box;
domIds['proj-search'] = { value: '', addEventListener() {} };
domIds['home-recent'] = null;
const dlgInput = { value: 'Renamed Via UI' };
domIds['dlg-name'] = dlgInput;

global.window = {};
global.document = {
  readyState: 'loading', // so app.js registers DOMContentLoaded instead of init()
  _listeners: {},
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  getElementById(id) { return (id in domIds) ? domIds[id] : null; },
  createElement() { return makeDiv(); },
  querySelectorAll() { return []; },
  body: { appendChild() {}, classList: { add() {} } },
};
global.localStorage = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
Object.defineProperty(global, 'navigator', { value: { userAgent: 'node' }, configurable: true });
global.RM = { audio: { clamp: (v, a, b) => Math.min(b, Math.max(a, v)) } };
global.window.RM = global.RM;

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', rel), 'utf8');
  eval(src);
}
load('projects.js');
load('v25-projects.js');
load('app.js');

const APP = global.window.RM.app;
const PR = global.window.RM.v25projects;
const PROJ = global.window.RM.proj;
if (!APP || !PR || !PROJ || typeof APP.renderProjects !== 'function') {
  console.error('FAIL: app.js did not expose renderProjects');
  process.exit(1);
}

/* ---------- edge mocks (recorded) ---------- */
const dialogs = [];
let dialogAnswer = true;
const toasts = [];
const shown = [];
const studioOpened = [];
const exportShown = [];
APP.dialog = (title, body, okL, cancelL) => {
  dialogs.push({ title: title, body: String(body), okL: okL, cancelL: cancelL });
  return Promise.resolve(dialogAnswer);
};
APP.toast = (msg) => { toasts.push(String(msg)); };
APP.show = (name) => { shown.push(name); };
// In-session mashup result (mocked "Create screen" state)
let sessionResult = null;
global.RM.mashupScreen = { getResult: () => sessionResult };
global.RM.v25studio = { open: (opts) => { studioOpened.push(opts); } };
global.RM.v25exportui = { show: (opts) => { exportShown.push(opts); } };

class FakeAudioBuffer {
  constructor() { this.numberOfChannels = 2; this.length = 100; this.sampleRate = 22050; this.duration = 1; }
  getChannelData() { return new Float32Array(100); }
}

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function resetMocks() {
  dialogs.length = 0; toasts.length = 0; shown.length = 0;
  studioOpened.length = 0; exportShown.length = 0;
  dialogAnswer = true; sessionResult = null;
  Object.keys(global.localStorage._s).forEach((k) => delete global.localStorage._s[k]);
}
const tick = () => new Promise((r) => setImmediate(r));
function mashupRows() { return box.children.filter((c) => c._html.indexOf('data-a="dup"') !== -1); }
function regularRows() { return box.children.filter((c) => c._html.indexOf('data-a="open"') !== -1); }
function btn(row, a) {
  const b = row.querySelector('[data-a="' + a + '"]');
  if (!b) throw new Error('button data-a="' + a + '" missing in row');
  return b;
}
function seedMashup(name, extra) {
  return PR.saveMashup(Object.assign({
    name: name, bpm: 128, key: 'Am',
    arrangementPlan: { songs: 3 },
    stemsRefs: [{ name: 'a.mp3', size: 1, type: 'audio/mpeg' }],
  }, extra || {}));
}

async function main() {
  console.log('== i7-wiring: mashup rows get 4 action buttons; regular rows unchanged ==');
  {
    resetMocks();
    const mid = seedMashup('Wired Mashup');
    const reg = PROJ.create('Regular Project');
    PROJ.save(reg);
    APP.renderProjects();
    const mrows = mashupRows();
    ok(mrows.length === 1, 'one mashup row rendered');
    const html = mrows[0]._html;
    ok(['rename', 'dup', 'cont', 'exp', 'del'].every((a) => html.indexOf('data-a="' + a + '"') !== -1),
      'mashup row has Rename/Duplicate/Continue/Export-again/Delete');
    ok(html.indexOf('data-a="open"') === -1, 'mashup row has no editor Open button');
    ok(html.indexOf('3 songs') !== -1 && html.indexOf('128 BPM') !== -1 && html.indexOf('Am') !== -1,
      'mashup row meta shows songs/BPM/key');
    const rrows = regularRows();
    ok(rrows.length === 1, 'regular row still rendered');
    ok(rrows[0]._html.indexOf('data-a="open"') !== -1 && rrows[0]._html.indexOf('data-a="rename"') !== -1,
      'regular row has Open+Rename+Delete (v29 J4-3: rename for all project types)');
    void mid;
  }

  console.log('== i7-wiring: Rename button end-to-end ==');
  {
    resetMocks();
    const mid = seedMashup('Rename Me');
    APP.renderProjects();
    dlgInput.value = 'Renamed Via UI';
    btn(mashupRows()[0], 'rename').click();
    await tick(); await tick();
    ok(dialogs.length === 1 && dialogs[0].title === 'Rename project', 'rename opens prompt dialog');
    ok(PR.get(mid).project.name === 'Renamed Via UI', 'rename persisted via RM.v25projects.rename');
    ok(PR.listMashups()[0].name === 'Renamed Via UI', 'list shows the new name after re-render');
    ok(mashupRows()[0]._html.indexOf('Renamed Via UI') !== -1, 're-rendered row shows new name');
    ok(toasts.some((t) => /renamed/i.test(t)), 'confirmation toast shown');
  }

  console.log('== i7-wiring: Rename cancelled keeps old name ==');
  {
    resetMocks();
    const mid = seedMashup('Keep Me');
    APP.renderProjects();
    dialogAnswer = false;
    btn(mashupRows()[0], 'rename').click();
    await tick(); await tick();
    ok(PR.get(mid).project.name === 'Keep Me', 'cancel leaves the name untouched');
  }

  console.log('== i7-wiring: Duplicate button adds an independent row ==');
  {
    resetMocks();
    const mid = seedMashup('Dupe Me');
    APP.renderProjects();
    ok(mashupRows().length === 1, 'one row before duplicate');
    btn(mashupRows()[0], 'dup').click();
    ok(mashupRows().length === 2, 'duplicate appears as a new row');
    ok(mashupRows().some((r) => r._html.indexOf('Dupe Me (copy)') !== -1), 'copy row labelled "(copy)"');
    ok(toasts.some((t) => /duplicated/i.test(t)), 'confirmation toast shown');
    void mid;
  }

  console.log('== i7-wiring: Continue loads in-session audio into Studio ==');
  {
    resetMocks();
    const mid = seedMashup('Mashup A x B');
    const buf = new FakeAudioBuffer();
    // In-memory result belongs to a DIFFERENT mashup -> must confirm, never silent.
    sessionResult = { buffer: buf, meta: { name: 'Something Else' }, engine: 'Smart DSP' };
    APP.renderProjects();
    btn(mashupRows()[0], 'cont').click();
    await tick();
    ok(dialogs.length === 1 && dialogs[0].title === 'Use current audio?', 'mismatch asks for confirmation (no silent wrong audio)');
    await tick(); await tick();
    ok(studioOpened.length === 1 && studioOpened[0].buffer === buf, 'Studio opened with the audio buffer');
    ok(studioOpened[0].meta && studioOpened[0].meta.name === 'Something Else', 'Studio opened with result meta');
    ok(toasts.some((t) => /Continuing: Mashup A x B/.test(t)), 'continuing toast names the project');
    void mid;
  }

  console.log('== i7-wiring: Continue with matching audio skips the confirm ==');
  {
    resetMocks();
    seedMashup('Same Name');
    const buf = new FakeAudioBuffer();
    sessionResult = { buffer: buf, meta: { name: 'Same Name' }, engine: 'Smart DSP' };
    APP.renderProjects();
    btn(mashupRows()[0], 'cont').click();
    await tick(); await tick();
    ok(dialogs.length === 0, 'no confirm dialog when audio matches the project');
    ok(studioOpened.length === 1 && studioOpened[0].buffer === buf, 'Studio opened directly');
  }

  console.log('== i7-wiring: Continue with missing audio -> honest message, no crash ==');
  {
    resetMocks();
    seedMashup('No Audio Project');
    sessionResult = null; // e.g. fresh app start: bytes were never stored
    APP.renderProjects();
    let crashed = false;
    try { btn(mashupRows()[0], 'cont').click(); await tick(); await tick(); }
    catch (e) { crashed = true; }
    ok(!crashed, 'no crash when audio is unavailable');
    ok(shown.indexOf('studio') !== -1, 'navigates to the Studio screen');
    ok(toasts.some((t) => /not stored on the device/.test(t)), 'honest toast explains audio is not stored');
    ok(studioOpened.length === 0, 'Studio.open NOT called with fake audio');
  }

  console.log('== i7-wiring: Export again produces the export flow ==');
  {
    resetMocks();
    seedMashup('Export Me');
    const buf = new FakeAudioBuffer();
    sessionResult = { buffer: buf, meta: { name: 'Export Me' }, engine: 'Smart DSP' };
    APP.renderProjects();
    btn(mashupRows()[0], 'exp').click();
    await tick(); await tick();
    ok(exportShown.length === 1, 'export UI shown exactly once');
    ok(exportShown[0].buffer === buf, 'export UI receives the real audio buffer');
    ok(exportShown[0].name === 'Export Me', 'export UI receives the project name');
  }

  console.log('== i7-wiring: Export again with missing audio -> honest dialog, no crash ==');
  {
    resetMocks();
    seedMashup('Gone Quiet');
    sessionResult = null;
    APP.renderProjects();
    let crashed = false;
    try { btn(mashupRows()[0], 'exp').click(); await tick(); await tick(); }
    catch (e) { crashed = true; }
    ok(!crashed, 'no crash when audio is unavailable');
    ok(exportShown.length === 0, 'export UI NOT shown with fake audio');
    const d = dialogs[dialogs.length - 1];
    ok(d && d.title === 'Audio unavailable' && /not stored on the device/.test(d.body),
      'honest "Audio unavailable" dialog explains the limit');
    ok(d && d.okL === 'Go to Create', 'dialog offers the rebuild path');
  }

  console.log('== i7-wiring: Delete on a mashup row removes it ==');
  {
    resetMocks();
    const mid = seedMashup('Delete Me');
    APP.renderProjects();
    ok(mashupRows().length === 1, 'row present before delete');
    btn(mashupRows()[0], 'del').click();
    await tick(); await tick();
    ok(dialogs.length === 1 && dialogs[0].title === 'Delete?', 'delete asks for confirmation');
    ok(PR.get(mid) === null, 'project removed via RM.v25projects.delete');
    ok(mashupRows().length === 0, 'row gone after re-render');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
