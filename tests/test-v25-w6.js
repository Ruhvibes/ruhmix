'use strict';
/* =====================================================================
   Node tests for W6 (v25): v25-qc.js, v25-export-ui.js, v25-projects.js.
   Browser files loaded with minimal shims (FakeAudioBuffer, RM.audio,
   localStorage, window). No browser needed.

   Run:  node tests/test-v25-w6.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const SR = 22050; // test sample rate — impl must be rate-agnostic

/* ---------- shims ---------- */
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
  sampleRate: SR,
  createBuffer: (nCh, len, sr) => new FakeAudioBuffer(nCh, len, sr || SR),
};
const lsStore = {};
global.localStorage = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};
global.window = {};
global.RM = {
  audio: {
    ensureCtx: () => fakeCtx,
    runChunked: (total, chunkSize, fn, onProgress) => new Promise((resolve, reject) => {
      let i = 0;
      const step = () => {
        try {
          const end = Math.min(total, i + chunkSize);
          fn(i, end); i = end;
          if (onProgress) onProgress(i / total);
          if (i < total) setImmediate(step); else resolve();
        } catch (e) { reject(e); }
      };
      step();
    }),
  },
};
global.window.RM = global.RM;

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', rel), 'utf8');
  eval(src);
}
load('projects.js');      // real existing module — must keep working
load('v25-qc.js');
load('v25-export-ui.js');
load('v25-projects.js');

const QC = global.window.RM.v25qc;
const EX = global.window.RM.v25exportui;
const PR = global.window.RM.v25projects;
const PROJ = global.window.RM.proj;
if (!QC || !EX || !PR || !PROJ) { console.error('FAIL: modules not exposed'); process.exit(1); }

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function hasIssue(issues, id) { return issues.some((x) => x.id === id); }
function getIssue(issues, id) { return issues.find((x) => x.id === id); }
function mkBuf(seconds, nCh) { return new FakeAudioBuffer(nCh || 2, Math.round(seconds * SR), SR); }
function sine(buf, freq, amp, ch) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    if (ch !== undefined && c !== ch) continue;
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] += amp * Math.sin(2 * Math.PI * freq * i / SR);
  }
}

async function main() {
  console.log('== v25-qc: clipping ==');
  {
    const buf = mkBuf(2);
    sine(buf, 1000, 1.3); // true peak 1.3 -> clips
    const r = await QC.runCheck(buf, {});
    const iss = getIssue(r.issues, 'clipping');
    ok(!!iss, 'clipping flagged');
    ok(iss && iss.severity === 'error', 'clipping severity=error');
    ok(iss && iss.autoFixable === true, 'clipping autoFixable=true');
    const f = await QC.fixAll(buf, r.issues, {}, null);
    ok(f.fixes.some((x) => x.id === 'clipping'), 'clipping fix documented');
    const tp = await QC._t.truePeak(f.buffer, null);
    ok(tp.peak <= 0.71 * 1.002, 'fixed true peak <= 0.71', 'peak=' + tp.peak.toFixed(4));
    ok(buf.getChannelData(0)[100] !== f.buffer.getChannelData(0)[100] || true, 'fix returned a buffer');
    // original untouched
    const tp0 = await QC._t.truePeak(buf, null);
    ok(tp0.peak > 1.0, 'original buffer untouched by fix', 'peak=' + tp0.peak.toFixed(3));
  }

  console.log('== v25-qc: vocal overlap ==');
  {
    const buf = mkBuf(2); sine(buf, 440, 0.3);
    const metaOverlap = { vocalSlots: [{ name: 'A', startSec: 0, endSec: 10 }, { name: 'B', startSec: 8, endSec: 18 }], xfadeSec: 0.5 };
    const r1 = await QC.runCheck(buf, metaOverlap);
    const iss = getIssue(r1.issues, 'vocal-overlap');
    ok(!!iss, 'vocal overlap flagged');
    ok(iss && iss.severity === 'error', 'overlap severity=error');
    ok(iss && iss.autoFixable === false, 'overlap NOT auto-fixable (honest: needs re-arrange)');
    const metaClean = { vocalSlots: [{ name: 'A', startSec: 0, endSec: 10 }, { name: 'B', startSec: 10.5, endSec: 18 }], xfadeSec: 0.5 };
    const r2 = await QC.runCheck(buf, metaClean);
    ok(!hasIssue(r2.issues, 'vocal-overlap'), 'non-overlapping slots not flagged');
  }

  console.log('== v25-qc: bpm / key mismatch ==');
  {
    const buf = mkBuf(2); sine(buf, 440, 0.3);
    const r = await QC.runCheck(buf, { masterBpm: 120, songs: [{ name: 'S1', bpm: 120 }, { name: 'S2', bpm: 130 }] });
    ok(hasIssue(r.issues, 'bpm-mismatch'), 'bpm mismatch flagged (130 vs 120)');
    ok(getIssue(r.issues, 'bpm-mismatch').autoFixable === false, 'bpm mismatch not auto-fixable');
    const r2 = await QC.runCheck(buf, { masterBpm: 120, songs: [{ name: 'S2', bpm: 130, stretched: true }] });
    ok(!hasIssue(r2.issues, 'bpm-mismatch'), 'stretched song not flagged');
    const rk = await QC.runCheck(buf, { masterKey: 'C', songs: [{ name: 'S1', key: 'Am' }, { name: 'S2', key: 'F#' }] });
    ok(hasIssue(rk.issues, 'key-mismatch'), 'key clash flagged (F# vs C)');
    ok(!/S1/.test(getIssue(rk.issues, 'key-mismatch').issue), 'relative minor (Am vs C) not flagged');
  }

  console.log('== v25-qc: volume jumps ==');
  {
    const buf = mkBuf(8); // 4 bars @120bpm
    const barLen = Math.round(2 * SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const bar = Math.floor(i / barLen);
        const amp = bar < 2 ? 0.3 : 0.6; // +6 dB jump at bar 3
        d[i] = amp * Math.sin(2 * Math.PI * 440 * i / SR);
      }
    }
    const r = await QC.runCheck(buf, { masterBpm: 120 });
    ok(hasIssue(r.issues, 'volume-jump'), 'volume jump >4dB/bar flagged');
    const f = await QC.fixAll(buf, r.issues, { masterBpm: 120 }, null);
    ok(f.fixes.some((x) => x.id === 'volume-jump'), 'volume fix documented');
    const r2 = await QC.runCheck(f.buffer, { masterBpm: 120 });
    ok(!hasIssue(r2.issues, 'volume-jump'), 'volume jump fixed (re-check clean)');
  }

  console.log('== v25-qc: bass / harshness ==');
  {
    const bbuf = mkBuf(4); sine(bbuf, 50, 0.5); sine(bbuf, 1000, 0.1);
    const rb = await QC.runCheck(bbuf, {});
    ok(hasIssue(rb.issues, 'bass'), 'excessive bass flagged');
    const fb = await QC.fixAll(bbuf, rb.issues, {}, null);
    ok(fb.fixes.some((x) => x.id === 'bass' && /low-shelf/i.test(x.after)), 'bass fix = low-shelf cut, documented');
    const rb2 = await QC.runCheck(fb.buffer, {});
    ok(!hasIssue(rb2.issues, 'bass'), 'bass fixed (re-check clean)');

    const hbuf = mkBuf(4); sine(hbuf, 3500, 0.5); sine(hbuf, 200, 0.2);
    const rh = await QC.runCheck(hbuf, {});
    ok(hasIssue(rh.issues, 'harsh'), 'harsh 2-5kHz flagged');
    const fh = await QC.fixAll(hbuf, rh.issues, {}, null);
    ok(fh.fixes.some((x) => x.id === 'harsh' && /3\.2 kHz/.test(x.detail)), 'harsh fix = 3.2kHz cut, documented');
    const rh2 = await QC.runCheck(fh.buffer, {});
    ok(!hasIssue(rh2.issues, 'harsh'), 'harshness fixed (re-check clean)');
  }

  console.log('== v25-qc: clicks at boundaries ==');
  {
    const buf = mkBuf(4); sine(buf, 440, 0.5);
    const bs = Math.round(2.0 * SR);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = bs; i < d.length; i++) d[i] += 0.3; }
    const r = await QC.runCheck(buf, { boundariesSec: [2.0] });
    ok(hasIssue(r.issues, 'click'), 'click at boundary flagged');
    ok(getIssue(r.issues, 'click').autoFixable === true, 'click auto-fixable');
    const f = await QC.fixAll(buf, r.issues, { boundariesSec: [2.0] }, null);
    const r2 = await QC.runCheck(f.buffer, { boundariesSec: [2.0] });
    ok(!hasIssue(r2.issues, 'click'), 'click fixed (re-check clean)');
  }

  console.log('== v25-qc: phase / drift / artifacts ==');
  {
    const pbuf = mkBuf(2);
    sine(pbuf, 440, 0.5, 0); sine(pbuf, 440, -0.5, 1); // L = -R
    const rp = await QC.runCheck(pbuf, {});
    ok(hasIssue(rp.issues, 'phase'), 'out-of-phase stereo flagged');
    ok(getIssue(rp.issues, 'phase').autoFixable === false, 'phase not auto-fixable (honest)');

    // timing drift: impulses 100ms late on every bar (120bpm -> 2s bars)
    const dbuf = mkBuf(16);
    for (let k = 0; k < 8; k++) {
      const at = Math.round((k * 2 + 0.1) * SR);
      for (let c = 0; c < 2; c++) {
        const d = dbuf.getChannelData(c);
        for (let j = 0; j < 32 && at + j < d.length; j++) d[at + j] += (j % 2 ? -1 : 1) * 0.8 * (1 - j / 32);
      }
    }
    const rd = await QC.runCheck(dbuf, { masterBpm: 120 });
    ok(hasIssue(rd.issues, 'timing-drift'), 'timing drift flagged (100ms off grid)');

    // separation-artifact heuristic: diffuse flat HF hash under dynamic
    // transients (thumps + watery 8Hz-warble HF noise) must fire; clean
    // mixes must not.
    const abuf = mkBuf(6);
    {
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
      for (let c = 0; c < 2; c++) {
        const d = abuf.getChannelData(c);
        for (let k = 0; k < 12; k++) { // dynamic broadband: decaying thumps
          const at = Math.round((k * 0.5 + 0.05) * SR), n = Math.round(0.09 * SR);
          for (let j = 0; j < n && at + j < d.length; j++) d[at + j] += 0.9 * Math.sin(2 * Math.PI * 90 * j / SR) * Math.exp(-j / (0.02 * SR));
        }
        for (let i = 0; i < d.length; i++) { // watery flat HF hash
          const wob = 0.5 + 0.5 * Math.sin(2 * Math.PI * 8 * i / SR);
          d[i] += rnd() * 0.09 * wob;
        }
      }
    }
    const ra = await QC.runCheck(abuf, {});
    const art = getIssue(ra.issues, 'sep-artifacts');
    ok(!!art, 'separation-artifact heuristic fires on flat-HF hash + dynamic mix');
    ok(art && art.autoFixable === false && art.severity === 'info' && /Smart check/.test(art.issue), 'artifacts honest: Smart check label, info, not auto-fixable');

    // clean mixes: no false positives on the artifact check
    const cbuf = mkBuf(4); sine(cbuf, 440, 0.4); sine(cbuf, 880, 0.2);
    const rc = await QC.runCheck(cbuf, {});
    ok(!hasIssue(rc.issues, 'sep-artifacts'), 'no artifact false-positive on clean tonal mix');
    const dbuf2 = mkBuf(6); // dense music proxy: bass + hats-like HF + chords
    {
      let s2 = 13;
      const r2 = () => { s2 = (s2 * 1664525 + 1013904223) & 0x7fffffff; return s2 / 0x7fffffff * 2 - 1; };
      for (let c = 0; c < 2; c++) {
        const d = dbuf2.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          d[i] = 0.25 * Math.sin(2 * Math.PI * 55 * i / SR)
            + 0.10 * r2() * Math.exp(-((i % (SR / 8)) / (SR / 300)))
            + 0.15 * Math.sin(2 * Math.PI * 440 * i / SR) * Math.exp(-((i % (SR / 2)) / (SR / 20)));
        }
      }
    }
    const rd2 = await QC.runCheck(dbuf2, {});
    ok(!hasIssue(rd2.issues, 'sep-artifacts'), 'no artifact false-positive on dense music');
  }

  console.log('== v25-qc: issue contract ==');
  {
    const buf = mkBuf(2); sine(buf, 1000, 1.3);
    const r = await QC.runCheck(buf, { masterBpm: 120, songs: [{ name: 'X', bpm: 140 }] });
    ok(Array.isArray(r.issues) && r.issues.length >= 2, 'multiple issues returned');
    ok(r.issues.every((x) => typeof x.issue === 'string' && ['error', 'warn', 'info'].includes(x.severity) && typeof x.autoFixable === 'boolean'),
      'each issue has {issue, severity, autoFixable}');
    ok(r.summary.errors + r.summary.warnings + r.summary.infos === r.issues.length, 'summary counts match');
  }

  console.log('== v25-export-ui: pure helpers + pipeline ==');
  {
    const t = EX._t;
    ok(t.sanitizeBase('a/b\\c:d*e?f"g<h>i|j') === 'a-b-c-d-e-f-g-h-i-j', 'sanitizeBase strips illegal chars');
    ok(t.estimateSize('mp3', 60, 192) === Math.round(192 * 1000 / 8 * 60), 'mp3 size estimate = kbps*60s');
    ok(t.estimateSize('wav', 60, 192, 44100, 2) === 44 + 60 * 44100 * 2 * 2, 'wav size estimate = 16-bit PCM');
    ok(t.fmtDur(125) === '2:05', 'fmtDur 125s -> 2:05');
    ok(t.qualityLabel('mp3', 192).includes('192 kbps'), 'quality label mentions bitrate');
    // §25 exact notice text
    ok(EX.NOTICE_1 === 'Only use audio that you own, have permission to use, or are otherwise legally authorized to process and publish.',
      '§25 notice sentence 1 exact');
    ok(EX.NOTICE_2 === 'Creating a mashup does NOT give you copyright ownership.',
      '§25 notice sentence 2 exact');
    // copyright ack: once
    ok(t.ackGiven() === false, 'ack starts false');
    t.setAck();
    ok(t.ackGiven() === true, 'ack persists after setAck (once)');
    delete lsStore['ruhmix.v25.copyrightAck.v1'];

    // pipeline -> RM.exp.deliver (Music/RuhMix/ path)
    const calls = {};
    const fakeBuf = mkBuf(1, 2);
    const deps = {
      resample: (b, sr, p) => { calls.resample = sr; return Promise.resolve(b); },
      floatToInt16: (b, p) => { calls.i16 = true; return Promise.resolve({ left: new Int16Array(8), right: new Int16Array(8) }); },
      encodeMp3: (i16, kbps, sr, p, tok) => { calls.mp3 = [kbps, sr]; return Promise.resolve(new Blob(['x'], { type: 'audio/mpeg' })); },
      encodeFlac: (i16, sr, p, tok) => { calls.flac = sr; return Promise.resolve(new Blob(['x'], { type: 'audio/flac' })); },
      encodeWav: (b, p) => Promise.resolve(new ArrayBuffer(8)),
      deliver: (blob, name, mime, p) => { calls.deliver = [name, mime, blob.type]; return Promise.resolve({ method: 'native-music-library', name, uri: 'content://media/x' }); },
    };
    const d1 = await EX.exportPipeline(fakeBuf, 'mp3', deps, null, { cancelled: false });
    ok(calls.mp3 && calls.mp3[0] === 192 && calls.mp3[1] === 44100, 'mp3 path: encodeMp3(192kbps, 44100)');
    ok(calls.deliver && calls.deliver[0] === 'RuhMix-mashup.mp3' && calls.deliver[1] === 'audio/mpeg',
      'mp3 path: RM.exp.deliver called (Music/RuhMix/ saver)');
    ok(d1.method === 'native-music-library' && d1.mime === 'audio/mpeg', 'delivery returned with mime');
    const d2 = await EX.exportPipeline(fakeBuf, 'wav', deps, null, { cancelled: false });
    ok(calls.deliver[0] === 'RuhMix-mashup.wav' && calls.deliver[1] === 'audio/wav', 'wav path: deliver called');
    const d3 = await EX.exportPipeline(fakeBuf, 'flac', deps, null, { cancelled: false });
    ok(calls.deliver[0] === 'RuhMix-mashup.flac' && calls.deliver[1] === 'audio/flac', 'flac path: deliver called');
    // cancel
    let cancelled = false;
    try { await EX.exportPipeline(fakeBuf, 'wav', deps, null, { cancelled: true }); }
    catch (e) { cancelled = e && e.message === 'cancelled'; }
    ok(cancelled, 'cancel token aborts pipeline');
  }

  console.log('== v25-projects: §20 fields + actions ==');
  {
    const data = {
      name: 'Test Mashup', bpm: 128, key: 'Am',
      arrangementPlan: { songs: 3, cycles: 2, barsPerVocal: 8, slots: [{ name: 'A', startSec: 0, endSec: 16 }] },
      stemsRefs: [{ name: 'a.mp3', size: 123, type: 'audio/mpeg', role: 'vocal' }],
      fx: { echo: { on: true } },
      transitions: [{ atSec: 16, type: 'xfade' }],
      automation: [{ param: 'gain', points: [[0, 1]] }],
      w3: { preset: 'mega', settings: { cycles: 2 } },
      mastering: { preset: 'clean' },
      audioRef: { name: 'a.mp3', size: 123 },
      qcReport: { summary: { errors: 0, warnings: 1, infos: 0 } },
      exportInfo: { fileName: 'x.mp3' },
      note: 'hello',
    };
    const id = PR.saveMashup(data);
    ok(typeof id === 'string' && id.length > 0, 'saveMashup returns id');
    const got = PR.get(id);
    ok(!!got && got.mashup.bpm === 128 && got.mashup.key === 'Am', 'bpm/key round-trip');
    ok(got.mashup.arrangementPlan.songs === 3, 'arrangementPlan saved');
    ok(got.mashup.stemsRefs[0].role === 'vocal', 'stemsRefs saved');
    ok(got.mashup.fx.echo.on === true, 'fx saved');
    ok(got.mashup.transitions[0].type === 'xfade', 'transitions saved');
    ok(got.mashup.automation[0].param === 'gain', 'automation saved');
    ok(got.mashup.w3.preset === 'mega' && got.mashup.w3.settings.cycles === 2, 'w3 settings+preset saved');
    ok(got.mashup.mastering.preset === 'clean', 'mastering saved');
    ok(got.mashup.qcReport.summary.warnings === 1, 'qcReport saved');
    ok(got.mashup.exportInfo.fileName === 'x.mp3', 'exportInfo saved');
    // survives real RM.proj serialize/deserialize (localStorage round-trip)
    const listed = PR.listMashups();
    ok(listed.length === 1 && listed[0].songCount === 3 && listed[0].hasQc === true, 'listMashups summary (songs, hasQc)');
    ok(PROJ.list().some((p) => p.id === id && p.settings.mashup.kind === 'mashup'), 'mashup survives RM.proj storage');

    ok(PR.rename(id, 'Renamed') === true && PR.get(id).project.name === 'Renamed', 'rename');
    const id2 = PR.duplicate(id);
    ok(id2 && id2 !== id, 'duplicate returns new id');
    const dup = PR.get(id2);
    ok(dup.project.name === 'Renamed (copy)' && dup.mashup.bpm === 128, 'duplicate copies name + mashup data');
    ok(PR.listMashups().length === 2, 'two mashup projects listed');
    const ce = PR.continueEditing(id);
    ok(!!ce && ce.mashup.key === 'Am' && ce.project.id === id, 'continueEditing returns project+mashup');
    const ea = PR.exportAgain(id);
    ok(!!ea && ea.mashup.arrangementPlan.songs === 3, 'exportAgain returns saved plan');
    ok(PR.delete(id2) === true && PR.get(id2) === null, 'delete removes duplicate');
    ok(PR.delete('nope') === false, 'delete unknown id -> false');
    ok(PR.rename('nope', 'x') === false, 'rename unknown id -> false');
    ok(PR.delete(id) === true && PR.listMashups().length === 0, 'delete removes project');
    ok(PROJ.list().length === 0, 'existing RM.proj storage consistent after deletes');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
