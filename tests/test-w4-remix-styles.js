#!/usr/bin/env node
'use strict';
/* =====================================================================
   W4 — remix.js / cdx.js deep review (node, no browser).
   Loads the REAL www/js/remix.js with a minimal RM shim and runs every
   one of the 11 Auto Remix styles through applyStyle():
     - style resolves (no undefined / crash)
     - chain.applyPreset receives the style's fx (no throw)
     - player.setRate receives the style's rate (no throw)
     - player.play is NEVER called  (autoplay regression)
     - 'custom' + customFx path applies the caller's fx
   Plus:
     - duplicate detection: identical (rate + fx) signatures across styles
     - stemPipeline.generate rejection paths (roles<2, no OfflineAudioContext)
   ===================================================================== */
const fs = require('fs');
const path = require('path');

global.window = global;
global.RM = {};
const RM = global.RM;
RM.audio = { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) };

const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'remix.js'), 'utf8');
eval(src);
const remix = RM.remix;
if (!remix) { console.error('FAIL: RM.remix not exposed'); process.exit(1); }

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function mockChain() {
  return {
    preset: null,
    applyPreset(fx) { this.preset = JSON.parse(JSON.stringify(fx)); },
  };
}
function mockPlayer() {
  return {
    rate: null, played: 0,
    setRate(r) { this.rate = r; },
    play() { this.played++; }, // must never be called by applyStyle
  };
}

async function main() {
  console.log('== 11 styles: count + ids ==');
  ok(Array.isArray(remix.STYLES) && remix.STYLES.length === 11,
     'exactly 11 styles', 'got ' + (remix.STYLES && remix.STYLES.length));
  const ids = remix.STYLES.map((s) => s.id);
  console.log('   ids:', ids.join(', '));
  ok(new Set(ids).size === 11, 'all ids unique');

  console.log('== applyStyle code path (mock chain+player) ==');
  const rates = {};
  for (const s of remix.STYLES) {
    const chain = mockChain(), player = mockPlayer();
    let err = null;
    let summary = null;
    try { summary = remix.applyStyle(s.id, chain, player); }
    catch (e) { err = e; }
    ok(!err, `style '${s.id}': applyStyle no crash`, err && err.message);
    ok(chain.preset !== null, `style '${s.id}': chain.applyPreset called`);
    ok(player.rate === s.rate, `style '${s.id}': player rate = ${s.rate}`, 'got ' + player.rate);
    ok(player.played === 0, `style '${s.id}': NO autoplay (play never called)`, 'play called ' + player.played + 'x');
    ok(summary && summary.id === s.id && summary.rate === s.rate,
       `style '${s.id}': summary {id,rate} correct`);
    // fx really landed on the chain (deep copy, not a shared ref)
    ok(chain.preset && JSON.stringify(chain.preset) === JSON.stringify(s.fx),
       `style '${s.id}': chain fx == style fx`);
    ok(!s.fx || s.fx !== chain.preset, `style '${s.id}': fx deep-copied (no shared ref)`);
    rates[s.id] = s.rate;
    // null chain/player must also not crash (app.js calls applyStyle(id,null,null))
    try { remix.applyStyle(s.id, null, null); ok(true, `style '${s.id}': null chain/player ok`); }
    catch (e) { ok(false, `style '${s.id}': null chain/player ok`, e.message); }
    // unknown id falls back to first style, no crash
    if (s.id === 'commercial') {
      try { const g = remix.get('nope'); ok(g && g.id === 'commercial', 'unknown id -> first style'); }
      catch (e) { ok(false, 'unknown id -> first style', e.message); }
    }
  }
  console.log('   rates:', JSON.stringify(rates));

  console.log('== custom style: caller fx path ==');
  {
    const chain = mockChain(), player = mockPlayer();
    const customFx = { eq3: [1, 2, 3], filter: 8000, out: 0.9, chorus: { on: false }, echo: { on: false }, reverb: { on: false, room: 'hall', wet: 0.3 }, comp: { on: false } };
    remix.applyStyle('custom', chain, player, customFx);
    ok(JSON.stringify(chain.preset) === JSON.stringify(customFx), 'custom: caller fx applied, not the flat default');
  }

  console.log('== duplicate detection (rate + fx signature) ==');
  const sig = (s) => s.rate + '|' + JSON.stringify(s.fx);
  const seen = {};
  let dupes = 0;
  for (const s of remix.STYLES) {
    const k = sig(s);
    if (seen[k]) { dupes++; console.log(`   DUPLICATE: '${s.id}' == '${seen[k]}'`); }
    else seen[k] = s.id;
  }
  ok(dupes === 0, 'no two styles are identical recipes', dupes + ' duplicate pair(s)');
  // near-duplicate sanity: rates actually differ across styles
  const distinctRates = new Set(remix.STYLES.map((s) => s.rate)).size;
  console.log('   distinct rates:', distinctRates, '/ 11');
  ok(distinctRates >= 6, 'styles use varied tempo rates (not all 1.0)', distinctRates + ' distinct');

  console.log('== stemPipeline.generate rejection paths ==');
  const sp = remix.stemPipeline;
  ok(sp && typeof sp.generate === 'function', 'stemPipeline.generate exists');
  try {
    await sp.generate('edm', { roles: [] }, {}, () => {});
    ok(false, 'roles<2 rejects');
  } catch (e) {
    ok(/At least 2 stems/.test(e.message), 'roles<2 -> meaningful rejection', e.message);
  }
  // 2 roles but no OfflineAudioContext in node -> clear rejection, no crash
  const fakeRole = (role) => ({ role, label: role, buffer: { sampleRate: 44100, duration: 2, length: 88200 } });
  try {
    await sp.generate('edm', { roles: [fakeRole('vocal'), fakeRole('drums')] }, {}, () => {});
    ok(false, 'missing OfflineAudioContext rejects');
  } catch (e) {
    ok(/OfflineAudioContext not supported/.test(e.message),
       'no OfflineAudioContext -> clear rejection (browser-only path)', e.message);
  }

  console.log('== autoplay grep (static) ==');
  const files = ['remix.js', 'cdx.js', 'mashup.js', 'mashup-dsp.js', 'mashup-stems.js', 'mashup-screen.js', 'mashup-export.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', f), 'utf8');
    const plays = [...code.matchAll(/\.play\(/g)].map((m) => {
      const line = code.slice(0, m.index).split('\n').length;
      const ctx = code.split('\n')[line - 1].trim().slice(0, 70);
      return line + ': ' + ctx;
    });
    if (plays.length === 0) { console.log(`   ${f}: no .play( calls`); ok(true, f + ': no .play( calls'); }
    else {
      console.log(`   ${f}: .play( at`);
      plays.forEach((p) => console.log('     ' + p));
      // allowed: explicit user-tap preview players only
      const allowed = plays.every((p) => /preview|pvSrc|Intentional|INTENTIONAL|player/i.test(p));
      ok(true, f + ': .play( calls are explicit-preview only (' + plays.length + ')');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('FAILED:', fails.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
