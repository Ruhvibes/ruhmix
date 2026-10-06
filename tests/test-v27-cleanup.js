#!/usr/bin/env node
/*
 * RuhMix v27 W5 — storage cleanup (temp files auto-delete) tests.
 * Pure Node with stubbed browser/native globals; no puppeteer needed.
 *
 * T1: module exposes RM.cleanup API (cleanupTemp, clearCache, trackTempAudio, isProtectedPath)
 * T2: stale object URLs are detected and revoked
 * T3: fresh object URLs are NOT revoked
 * T4: temp-audio item cap enforced (oldest released first)
 * T5: temp-audio byte cap enforced (250 MB)
 * T6: protected paths are never touched (Music/RuhMix, projects, keystore)
 * T7: cleanupTemp returns a summary and logs it
 * T8: clearCache() runs the manual pass with includeImports
 * T9: native prune is consulted (bytes reported), absent bridge = 0 and no throw
 * T10: export completion triggers a post-export cleanup pass (deliver wrapped)
 * T11: track/untrack round-trip + double cleanup is safe (idempotent)
 *
 * Exit 0 = all pass.
 */
'use strict';

let pass = 0, fail = 0;
function ok(name, detail) { pass++; console.log('PASS', name, detail ? ' — ' + detail : ''); }
function no(name, detail) { fail++; console.log('FAIL', name, detail ? ' — ' + detail : ''); }
function eq(name, a, b) {
  if (a === b) ok(name, String(a));
  else no(name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

// ---- Stubs (installed BEFORE the module loads) ----
const revoked = [];
let urlSeq = 0;
globalThis.URL = {
  createObjectURL: function () { urlSeq++; return 'blob:test:' + urlSeq; },
  revokeObjectURL: function (u) { revoked.push(u); },
};
const logLines = [];
const realInfo = console.info;
console.info = function () { logLines.push(Array.prototype.join.call(arguments, ' ')); };
let nativeFreed = 0;
let nativeIncludeImports = null;
globalThis.RM = {
  audio: {
    native: {
      method: function (n) { return n === 'cleanupOldTempFiles'; },
      call: function (n, includeImports) { nativeIncludeImports = includeImports; return nativeFreed; },
    },
  },
  wave: { dropPeaks: function () {} },
  exp: {
    deliver: function () { return Promise.resolve({ method: 'test', name: 'x.mp3' }); },
  },
};

require('/home/hatch/workspace/ruhmix/www/js/v27-cleanup.js');
const C = globalThis.RM.cleanup;

async function main() {
  // T1: API surface
  ['cleanupTemp', 'clearCache', 'trackTempAudio', 'untrackTempAudio',
   'isProtectedPath', 'enforceCaps', 'pruneNativeCache'].forEach((fn) => {
    eq('T1 api exposes ' + fn, typeof C[fn], 'function');
  });

  // T2: stale URL revoked
  C._reset(); revoked.length = 0; logLines.length = 0;
  const staleTs = Date.now() - (31 * 60 * 1000); // 31 min old > 30 min threshold
  C._testInjectUrl('blob:test:stale1', staleTs, 'test');
  const s2 = C.cleanupTemp({ reason: 't2' });
  eq('T2 stale url revoked count', s2.revokedUrls, 1);
  eq('T2 stale url passed to revokeObjectURL', revoked.indexOf('blob:test:stale1') !== -1, true);
  eq('T2 registry drained', C._urlCount(), 0);

  // T3: fresh URL untouched
  C._reset(); revoked.length = 0;
  C._testInjectUrl('blob:test:fresh1', Date.now(), 'test');
  const s3 = C.cleanupTemp({ reason: 't3' });
  eq('T3 fresh url not revoked', s3.revokedUrls, 0);
  eq('T3 fresh url still registered', C._urlCount(), 1);

  // T4: item cap — keep last 5, release oldest first
  C._reset();
  const base = Date.now() - 10000;
  for (let i = 0; i < 7; i++) C._testInjectBuf('buf' + i, 1024, base + i * 1000);
  const cap4 = C.enforceCaps();
  eq('T4 released oldest-first count', cap4.released, 2);
  eq('T4 registry at cap', C._bufCount(), C.CFG.maxTempAudioItems);

  // T5: byte cap — 250 MB
  C._reset();
  const big = 200 * 1024 * 1024;
  C._testInjectBuf('bigA', big, Date.now() - 2000);
  C._testInjectBuf('bigB', big, Date.now() - 1000); // total 400MB > 250MB
  const cap5 = C.enforceCaps();
  eq('T5 byte cap released one', cap5.released, 1);
  eq('T5 byte cap registry size', C._bufCount(), 1);

  // T6: protected paths never touched
  eq('T6 protects Music/RuhMix', C.isProtectedPath('/storage/emulated/0/Music/RuhMix/mix.mp3'), true);
  eq('T6 protects projects key', C.isProtectedPath('ruhmix.projects.v1'), true);
  eq('T6 protects keystore', C.isProtectedPath('/data/data/com.ruhmix.app/ruhvibes.jks'), true);
  eq('T6 protects keystore dir', C.isProtectedPath('/workspace/keystore/x'), true);
  eq('T6 allows temp share path', C.isProtectedPath('/data/data/com.ruhmix.app/cache/share/tmp.mp3'), false);
  eq('T6 null safe', C.isProtectedPath(null), false);

  // T7: summary shape + logging
  C._reset(); logLines.length = 0;
  const s7 = C.cleanupTemp({ reason: 't7' });
  ['revokedUrls', 'releasedBuffers', 'releasedBytesApprox', 'nativePrunedBytes', 'errors', 'reason', 'ts']
    .forEach((k) => eq('T7 summary has ' + k, (k in s7), true));
  eq('T7 summary reason', s7.reason, 't7');
  eq('T7 logged to console', logLines.some((l) => l.indexOf('[RM.cleanup]') !== -1 && l.indexOf('t7') !== -1), true);

  // T8: manual clearCache → includeImports=true passed to native
  C._reset(); nativeFreed = 4096; nativeIncludeImports = null; logLines.length = 0;
  const s8 = C.clearCache();
  eq('T8 clearCache native got includeImports=true', nativeIncludeImports, true);
  eq('T8 clearCache reports native bytes', s8.nativePrunedBytes, 4096);
  eq('T8 clearCache reason', s8.reason, 'manual-clear');

  // T9: missing native bridge → 0, no throw
  C._reset();
  const savedNative = globalThis.RM.audio.native;
  globalThis.RM.audio.native = { method: function () { return false; }, call: function () { throw new Error('nope'); } };
  let threw = false, s9 = null;
  try { s9 = C.cleanupTemp({ reason: 't9' }); } catch (e) { threw = true; }
  eq('T9 no throw without bridge', threw, false);
  eq('T9 native bytes 0', s9 && s9.nativePrunedBytes, 0);
  globalThis.RM.audio.native = savedNative;

  // T10: deliver wrapped → post-export cleanup runs after export resolves
  logLines.length = 0;
  await new Promise((r) => setTimeout(r, 800)); // let the hook interval wrap RM.exp.deliver
  await globalThis.RM.exp.deliver('blob', 'f.mp3', 'audio/mpeg');
  await new Promise((r) => setTimeout(r, 50));
  eq('T10 post-export cleanup ran', logLines.some((l) => l.indexOf('post-export') !== -1), true);

  // T11: track/untrack round-trip, idempotent double cleanup
  C._reset();
  C.trackTempAudio('tmp1', { size: 5000 }, 'test');
  eq('T11 tracked', C._bufCount(), 1);
  C.untrackTempAudio('tmp1');
  eq('T11 untracked', C._bufCount(), 0);
  let ok2 = true;
  try { C.cleanupTemp(); C.cleanupTemp(); } catch (e) { ok2 = false; }
  eq('T11 double cleanup safe', ok2, true);

  console.info = realInfo;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.info = realInfo; console.error('HARNESS ERROR', e); process.exit(1); });
