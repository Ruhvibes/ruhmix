#!/usr/bin/env node
/*
 * RuhMix import-hardening.js verification (Node, real code).
 *
 * Loads ~/workspace/ruhmix/www/js/import-hardening.js via require()
 * (it ships a module.exports guard); falls back to the `vm` module with a
 * browser-like sandbox if require() does not expose the API.
 *
 * Drives the real helpers against real fixture files in
 * /tmp/ruhmix-import-tests/ (built with ffmpeg, see fixtures table below).
 *
 * Exit code: 0 if every test passes, 1 otherwise.
 * Prints one PASS/FAIL line per test.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = '/home/hatch/workspace/ruhmix/www/js/import-hardening.js';
const DIR = '/tmp/ruhmix-import-tests';

const NEED = ['sniffAudioType', 'stripId3v2', 'findFirstMp3Frame', 'precheckAudio', 'classifyError'];

function loadRH() {
  let m = null;
  try { m = require(SRC); } catch (e) { m = null; }
  if (m && NEED.every((f) => typeof m[f] === 'function')) return { RH: m, via: 'require' };
  // vm fallback: browser-only file -> fake a window
  const code = fs.readFileSync(SRC, 'utf8');
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  sandbox.ArrayBuffer = ArrayBuffer;
  sandbox.Uint8Array = Uint8Array;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'import-hardening.js' });
  const RH = sandbox.RH;
  if (RH && NEED.every((f) => typeof RH[f] === 'function')) return { RH, via: 'vm-sandbox' };
  throw new Error('could not load import-hardening API (tried require + vm)');
}

const results = [];
const add = (name, pass, detail) =>
  results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });

const read = (n) => fs.readFileSync(path.join(DIR, n));
const DEVANAGARI = /[ऀ-ॿ]/; // U+0900..U+097F

(function main() {
  let RH, via;
  try {
    ({ RH, via } = loadRH());
    add('0. loader: import-hardening.js exposes full API', true, 'via ' + via);
  } catch (e) {
    add('0. loader: import-hardening.js exposes full API', false, e && e.message);
    return finish();
  }

  const F = {};
  for (const n of ['normal-128k.mp3', 'id3v24.mp3', 'bad-header.mp3', 'weird-name(128k).mp3',
                   'मेरा गाना.mp3', 'corrupt.mp3', 'empty.mp3', 'truncated.mp3', 'notaudio.txt']) {
    try { F[n] = read(n); }
    catch (e) { add('fixture read: ' + n, false, e.message); return finish(); }
  }

  /* ---------- sniffAudioType ---------- */
  try {
    const cases = [
      ['normal-128k.mp3', 'mp3'],
      ['id3v24.mp3', 'mp3'],
      ['truncated.mp3', 'mp3'],
      ['weird-name(128k).mp3', 'mp3'],
      ['मेरा गाना.mp3', 'mp3'],
      ['bad-header.mp3', 'unknown'], // 5KB garbage up front
      ['corrupt.mp3', 'unknown'],
      ['empty.mp3', 'unknown'],
      ['notaudio.txt', 'unknown'],
    ];
    for (const [n, want] of cases) {
      const got = RH.sniffAudioType(F[n]);
      add(`sniffAudioType(${n}) === '${want}'`, got === want, `got '${got}'`);
    }
  } catch (e) { add('sniffAudioType harness', false, e && e.stack); }

  /* ---------- stripId3v2 ----------
     KNOWN ISSUE (reported, not fixed here): under Node, passing a Buffer
     makes stripId3v2 silently no-op — Buffer.slice() returns a *view* and
     `.buffer` is the original pooled ArrayBuffer, so the tag is never
     dropped. Browser path (ArrayBuffer -> Uint8Array.slice copies) is fine. */
  try {
    const stripped = Buffer.from(RH.stripId3v2(F['id3v24.mp3']));
    const noTag = stripped[0] !== 0x49 || stripped[1] !== 0x44 || stripped[2] !== 0x33;
    const frameSync = stripped[0] === 0xFF && (stripped[1] & 0xE0) === 0xE0;
    add('stripId3v2(id3v24) shrinks + drops ID3 + keeps audio',
      stripped.length < F['id3v24.mp3'].length && noTag && frameSync,
      `in=${F['id3v24.mp3'].length} out=${stripped.length} first3=${stripped.slice(0,3).toString('hex')}`);

    const back = RH.stripId3v2(F['normal-128k.mp3']);
    const unchanged = back === F['normal-128k.mp3'] ||
      (Buffer.from(back).length === F['normal-128k.mp3'].length &&
       Buffer.from(back).equals(F['normal-128k.mp3']));
    add('stripId3v2(normal-128k) unchanged (no tag)', unchanged,
      `in=${F['normal-128k.mp3'].length} out=${Buffer.from(back).length}`);
  } catch (e) { add('stripId3v2 harness', false, e && e.stack); }

  /* ---------- findFirstMp3Frame ---------- */
  try {
    const offBad = RH.findFirstMp3Frame(F['bad-header.mp3']);
    const bBad = Buffer.from(F['bad-header.mp3']);
    add('findFirstMp3Frame(bad-header) finds offset > 0',
      Number.isInteger(offBad) && offBad > 0 && offBad <= 5200 && bBad[offBad] === 0xFF,
      `offset=${offBad}`);

    const offNorm = RH.findFirstMp3Frame(F['normal-128k.mp3']);
    add('findFirstMp3Frame(normal-128k) is 0 (tagless, frame at start)',
      offNorm === 0, `offset=${offNorm}`);

    const offTag = RH.findFirstMp3Frame(F['id3v24.mp3']);
    const bTag = Buffer.from(F['id3v24.mp3']);
    add('findFirstMp3Frame(id3v24) skips ID3v2 to first frame',
      Number.isInteger(offTag) && offTag > 0 && offTag < 8192 && bTag[offTag] === 0xFF,
      `offset=${offTag}`);

    const offCorrupt = RH.findFirstMp3Frame(F['corrupt.mp3']);
    const bCor = Buffer.from(F['corrupt.mp3']);
    // Frame sync is a 2-byte heuristic; random data may contain a
    // sync-shaped pair. Document the contract: -1, or a real sync-shaped offset.
    const corOk = offCorrupt === -1 ||
      (Number.isInteger(offCorrupt) && offCorrupt >= 0 &&
       bCor[offCorrupt] === 0xFF && (bCor[offCorrupt + 1] & 0xE0) === 0xE0);
    add('findFirstMp3Frame(corrupt) returns -1 or a sync-shaped offset', corOk,
      `offset=${offCorrupt}`);
  } catch (e) { add('findFirstMp3Frame harness', false, e && e.stack); }

  /* ---------- precheckAudio ---------- */
  try {
    const rEmpty = RH.precheckAudio(F['empty.mp3'], 'empty.mp3');
    add("precheckAudio(empty.mp3) → kind 'empty'",
      rEmpty && rEmpty.ok === false && rEmpty.kind === 'empty', JSON.stringify(rEmpty));

    const rCorrupt = RH.precheckAudio(F['corrupt.mp3'], 'corrupt.mp3');
    add("precheckAudio(corrupt.mp3) → kind 'unsupported-type'",
      rCorrupt && rCorrupt.ok === false && rCorrupt.kind === 'unsupported-type', JSON.stringify(rCorrupt));

    // NOTE: files < 100 bytes hit the 'empty' gate (documented in precheckAudio),
    // so a tiny text file classifies as 'empty', not 'unsupported-type'.
    const rTxt = RH.precheckAudio(F['notaudio.txt'], 'notaudio.txt');
    add("precheckAudio(notaudio.txt, 85B) → kind 'empty' (<100B gate)",
      rTxt && rTxt.ok === false && rTxt.kind === 'empty', JSON.stringify(rTxt));

    const rBig = RH.precheckAudio({ byteLength: 200 * 1024 * 1024 }, 'big.mp3');
    add("precheckAudio(200MB) → kind 'too-large'",
      rBig && rBig.ok === false && rBig.kind === 'too-large', JSON.stringify(rBig));

    const rOk = RH.precheckAudio(F['normal-128k.mp3'], 'normal-128k.mp3');
    add('precheckAudio(normal-128k.mp3) → ok', rOk && rOk.ok === true, JSON.stringify(rOk));

    const rNull = RH.precheckAudio(null, 'x.mp3');
    add('precheckAudio(null) never throws → kind empty',
      rNull && rNull.ok === false && rNull.kind === 'empty', JSON.stringify(rNull));
  } catch (e) { add('precheckAudio harness', false, e && e.stack); }

  /* ---------- classifyError ---------- */
  try {
    for (const kind of ['unreadable', 'empty', 'too-large', 'unsupported-type', 'corrupt', 'bogus-kind']) {
      const c = RH.classifyError(kind, 'My Song.mp3');
      const okShape = c && typeof c.title === 'string' && c.title.trim().length > 0 &&
        typeof c.msg === 'string' && c.msg.trim().length > 10;
      const noDeva = okShape && !DEVANAGARI.test(c.title) && !DEVANAGARI.test(c.msg);
      const hasName = okShape && c.msg.includes('My Song.mp3');
      add(`classifyError('${kind}') → professional English title+msg, no Devanagari`,
        okShape && noDeva && hasName,
        okShape ? `title="${c.title}" msgLen=${c.msg.length}` : 'bad shape: ' + JSON.stringify(c));
    }
    const dflt = RH.classifyError(null, null);
    add('classifyError(null,null) defaults gracefully',
      dflt && dflt.title && dflt.msg && !DEVANAGARI.test(dflt.title + dflt.msg),
      `title="${dflt && dflt.title}"`);
  } catch (e) { add('classifyError harness', false, e && e.stack); }

  /* ---------- module metadata sanity ---------- */
  try {
    const stages = typeof RH.decodeStages === 'function' ? RH.decodeStages() : null;
    add('decodeStages() documents fallback order',
      Array.isArray(stages) && stages.join(',') === 'direct,strip-id3,frame-sync',
      JSON.stringify(stages));
    add('MAX_IMPORT_BYTES is 150MB',
      RH.MAX_IMPORT_BYTES === 150 * 1024 * 1024, String(RH.MAX_IMPORT_BYTES));
  } catch (e) { add('metadata harness', false, e && e.stack); }

  finish();

  function finish() {
    let fails = 0;
    for (const r of results) {
      console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
      if (!r.pass) fails++;
    }
    console.log('---');
    console.log(fails === 0 ? `ALL ${results.length} TESTS PASSED` : `${fails}/${results.length} TESTS FAILED`);
    process.exit(fails === 0 ? 0 : 1);
  }
})();
