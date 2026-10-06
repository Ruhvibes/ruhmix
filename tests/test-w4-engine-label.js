#!/usr/bin/env node
'use strict';
/* =====================================================================
   W4 — mashup engine-label honesty (REAL code from www/js/mashup-screen.js).
   The screen builds `engineLabel` from the per-call provider tags
   (m.engineTagVocal / m.engineTagInstr). Known tags:
     'smart DSP'                  (default DSP provider)
     'neural stems'               (user HF Space, neural path)
     'smart DSP (neural failed)'  (neural attempted, fell back to DSP)
   This test extracts the ACTUAL label-computation block from
   mashup-screen.js (anchored on `var engineLabel =`) and evaluates it
   for every tag combination. A fallback-to-DSP result must NEVER be
   labelled neural.
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'mashup-screen.js'), 'utf8');

// Anchor: the engineLabel block inside make(). Extract verbatim so the
// test always runs the SHIPPED logic, not a copy.
const anchor = "var tagV = m.engineTagVocal || '', tagI = m.engineTagInstr || '';";
const i0 = code.indexOf(anchor);
if (i0 < 0) { console.error('FAIL: anchor not found in mashup-screen.js'); process.exit(2); }
const i1 = code.indexOf('};', code.indexOf("ms.result = {", i0));
const block = code.slice(i0, i1).split('\n')
  .filter((ln) => /tagV|tagI|engineLabel|neural/.test(ln) && !/^\s*engine:/.test(ln))
  .join('\n');
console.log('--- extracted block under test ---');
console.log(block);
console.log('----------------------------------');

function labelFor(tagV, tagI) {
  const m = { engineTagVocal: tagV, engineTagInstr: tagI };
  // eslint-disable-next-line no-eval
  const fn = new Function('m', block + '\nreturn engineLabel;');
  return fn(m);
}

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const DSP = 'smart DSP', NEU = 'neural stems', FB = 'smart DSP (neural failed)';

console.log('== engine label honesty ==');
const cases = [
  // [tagV, tagI, expectedLabel]
  [DSP, DSP, 'Smart DSP engine'],
  [NEU, NEU, 'Neural stems engine'],
  [NEU, DSP, 'Smart DSP + neural stems'],
  [DSP, NEU, 'Smart DSP + neural stems'],
  [FB, FB, 'Smart DSP engine (neural unavailable)'],   // both fell back: MUST say Smart DSP
  [FB, DSP, 'Smart DSP engine (neural unavailable)'],  // vocal fell back
  [DSP, FB, 'Smart DSP engine (neural unavailable)'],  // instr fell back
  [FB, NEU, 'Smart DSP + neural stems'],               // mixed: one true neural, one DSP
  ['', '', 'Smart DSP engine'],                        // missing tags -> honest default
];
for (const [tv, ti, want] of cases) {
  const got = labelFor(tv, ti);
  ok(got === want, `tags (${JSON.stringify(tv)}, ${JSON.stringify(ti)}) -> ${JSON.stringify(want)}`, 'got ' + JSON.stringify(got));
}

console.log('== dishonesty scan ==');
// The label must never claim neural when NO tag is a real neural success.
const dishonest = [];
for (const tv of [DSP, FB, '']) for (const ti of [DSP, FB, '']) {
  const lab = labelFor(tv, ti);
  if (/neural/i.test(lab) && !/unavailable/i.test(lab)) dishonest.push(`(${tv}|${ti}) -> ${lab}`);
}
ok(dishonest.length === 0, 'no DSP-only/fallback combo labelled neural', dishonest.join('; '));

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) console.log('FAILED:', fails.join(' | '));
process.exit(fail ? 1 : 0);
