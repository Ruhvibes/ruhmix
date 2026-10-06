'use strict';
/* =====================================================================
   RuhMix — test-v25-i7-core.js (Worker I7)
   Core tests for the Projects rename/duplicate wiring:
   v25-projects.js (real) + projects.js (real), browser shims only.

   Covers: rename persistence via listMashups, duplicate storage-level
   independence, stored-settings preservation against live editor state
   (the saveKeepSettings root fix), continueEditing live-restore,
   exportAgain plan return, isMashup guards, honest not-found results.

   Run:  node tests/test-v25-i7-core.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const lsStore = {};
global.localStorage = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};
global.window = {};
global.RM = { audio: {} };
global.window.RM = global.RM;
// Simulated LIVE editor state — deliberately different from whatever is
// stored, to prove rename/duplicate don't leak live state into the entry.
global.RM.app = { state: { fx: null, slowed: null, mastering: null, remix: null } };

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', rel), 'utf8');
  eval(src);
}
load('projects.js');
load('v25-projects.js');

const PR = global.window.RM.v25projects;
const PROJ = global.window.RM.proj;
if (!PR || !PROJ) { console.error('FAIL: modules not exposed'); process.exit(1); }

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function setLive(fx, slowed, mastering, remix) {
  global.RM.app.state = { fx: fx, slowed: slowed, mastering: mastering, remix: remix };
}
function clearStore() {
  Object.keys(lsStore).forEach((k) => delete lsStore[k]);
}

function main() {
  console.log('== i7-core: rename persists, list shows new name ==');
  {
    clearStore(); setLive(null, null, null, null);
    const id = PR.saveMashup({ name: 'Old Name', bpm: 128, key: 'Am', arrangementPlan: { songs: 3 } });
    ok(PR.rename(id, 'New Name') === true, 'rename returns true');
    const listed = PR.listMashups();
    ok(listed.length === 1 && listed[0].name === 'New Name', 'listMashups shows the new name',
      JSON.stringify(listed.map((s) => s.name)));
    ok(PROJ.list().some((p) => p.id === id && p.name === 'New Name'), 'RM.proj storage shows new name');
    ok(PR.rename(id, 'x'.repeat(100)) === true && PR.get(id).project.name.length === 60, 'rename clamps to 60 chars');
  }

  console.log('== i7-core: duplicate is an independent stored copy ==');
  {
    clearStore(); setLive(null, null, null, null);
    const id = PR.saveMashup({
      name: 'Orig', bpm: 120,
      arrangementPlan: { songs: 2, slots: [{ name: 'A', startSec: 0 }] },
      fx: { echo: { on: true } },
    });
    const id2 = PR.duplicate(id);
    ok(!!id2 && id2 !== id, 'duplicate returns a new id');
    // Mutate the COPY through the public API and persist it.
    const mutatedPlan = { songs: 2, slots: [{ name: 'CHANGED', startSec: 0 }] };
    PR.saveMashup({ id: id2, name: 'Hacked', arrangementPlan: mutatedPlan, fx: { echo: { on: false } } });
    const orig = PR.get(id);
    ok(orig.project.name === 'Orig', 'original name untouched by copy edit');
    ok(orig.mashup.arrangementPlan.slots[0].name === 'A', 'original arrangementPlan untouched by copy edit');
    ok(orig.mashup.fx.echo.on === true, 'original fx untouched by copy edit');
    const copy = PR.get(id2);
    ok(copy.project.name === 'Hacked' && copy.mashup.arrangementPlan.slots[0].name === 'CHANGED',
      'copy carries its own edits');
    ok(PR.listMashups().length === 2, 'both listed as separate rows');
  }

  console.log('== i7-core: rename/duplicate preserve stored settings (live-state leak fix) ==');
  {
    clearStore();
    setLive({ v: 'first' }, { s: 'first' }, { preset: 'first' }, { style: 'first' });
    const id = PR.saveMashup({ name: 'P', bpm: 100 });
    // Stored settings now == 'first'. Change the LIVE editor state afterwards.
    setLive({ v: 'second' }, { s: 'second' }, { preset: 'second' }, { style: 'second' });
    PR.rename(id, 'P2');
    let stored = PR.get(id).project.settings;
    ok(stored.fx && stored.fx.v === 'first', 'rename keeps stored fx (no live leak)',
      'fx=' + JSON.stringify(stored.fx));
    ok(stored.slowed && stored.slowed.s === 'first', 'rename keeps stored slowed');
    ok(stored.mastering && stored.mastering.preset === 'first', 'rename keeps stored mastering');
    const id2 = PR.duplicate(id);
    stored = PR.get(id2).project.settings;
    ok(stored.fx && stored.fx.v === 'first', 'duplicate keeps ORIGINAL stored fx, not live');
    ok(stored.mastering && stored.mastering.preset === 'first', 'duplicate keeps original mastering');
    ok(global.RM.app.state.fx.v === 'second', 'live editor state untouched by rename/duplicate');
  }

  console.log('== i7-core: continueEditing restores live state + points project ==');
  {
    clearStore();
    setLive({ echo: 1 }, { wet: 2 }, { preset: 'm' }, { style: 'rs' });
    const id = PR.saveMashup({ name: 'CE', bpm: 90, key: 'Dm' });
    setLive(null, null, null, null); // fresh "restart": live state empty
    const ce = PR.continueEditing(id);
    ok(!!ce && ce.project.id === id && ce.mashup.key === 'Dm', 'continueEditing returns project+mashup');
    const st = global.RM.app.state;
    ok(st.fx && st.fx.echo === 1, 'live fx restored');
    ok(st.slowed && st.slowed.wet === 2, 'live slowed restored');
    ok(st.mastering && st.mastering.preset === 'm', 'live mastering restored');
    ok(st.remix && st.remix.style === 'rs', 'live remix style restored');
    ok(st.project && st.project.id === id, 'app state.project points at the continued project');
  }

  console.log('== i7-core: exportAgain / guards / honest not-found ==');
  {
    clearStore(); setLive(null, null, null, null);
    const id = PR.saveMashup({ name: 'EA', bpm: 140, arrangementPlan: { songs: 4 } });
    const ea = PR.exportAgain(id);
    ok(!!ea && ea.mashup.bpm === 140 && ea.mashup.arrangementPlan.songs === 4, 'exportAgain returns saved plan');
    ok(PR.exportAgain('nope') === null, 'exportAgain unknown id -> null (no crash)');
    ok(PR.continueEditing('nope') === null, 'continueEditing unknown id -> null (no crash)');
    ok(PR.rename('nope', 'x') === false, 'rename unknown id -> false');
    ok(PR.duplicate('nope') === null, 'duplicate unknown id -> null');
    ok(PR.delete('nope') === false, 'delete unknown id -> false');
    const regular = PROJ.create('Regular');
    PROJ.save(regular);
    ok(PR.isMashup(PROJ.get(id)) === true, 'isMashup true for mashup project');
    ok(PR.isMashup(regular) === false, 'isMashup false for regular project');
    ok(PR.isMashup(null) === false, 'isMashup false for null');
    ok(PR.rename(regular.id, 'x') === false, 'rename refuses regular (non-mashup) project');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
