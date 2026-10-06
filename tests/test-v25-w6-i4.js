'use strict';
/* =====================================================================
   Node tests for v26 Worker I4: QC overlay wiring + builder metas + §25.

   Covers:
     1. sendToExport routes through RM.v25exportui.show(buffer, meta, opts)
        (positional), with the v23 filename scheme intact.
     2. Fallback: without the overlay module, sendToExport uses the classic
        export-screen handoff (nothing lost).
     3. All 11 QC scans execute on a mega-style builder meta (0 skips).
     4. Skip reasons are reported (never silent) on a meta-less export.
     5. §25: the mandatory checkbox gate blocks export when unchecked.
     6. RM.v25qc.slotMeta geometry (what the builders feed QC).
     7. parseKey accepts the builders' "C major" / "A minor" labels.
     8. Classic export screen: §25 checkbox present + gated in app.js.
     9. Full path: sendToExport opens the overlay; checkbox starts unchecked.

   Run:  node tests/test-v25-w6-i4.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const SR = 22050;

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
// Minimal fake DOM — enough for v25-export-ui show()/hide()/runQc().
function mkEl() {
  const el = {
    style: {},
    _html: '',
    _text: '',
    checked: false,
    disabled: false,
    children: [],
    setAttribute() {},
    appendChild(c) { el.children.push(c); return c; },
    addEventListener() {},
    querySelector() { return mkEl(); },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
  Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = String(v); } });
  return el;
}
global.document = { createElement: () => mkEl(), body: mkEl() };

const appShowCalls = [];
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
  app: {
    state: {},
    show: (name) => { appShowCalls.push(name); return true; },
    toast: () => {},
  },
};
global.window.RM = global.RM;

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', rel), 'utf8');
  eval(src);
}
load('v25-qc.js');
load('v25-export-ui.js');
load('mashup-export.js');

const QC = global.window.RM.v25qc;
const EX = global.window.RM.v25exportui;
const MX = global.window.RM.mashupExport;
if (!QC || !EX || !MX) { console.error('FAIL: modules not exposed'); process.exit(1); }

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function mkBuf(seconds, nCh) { return new FakeAudioBuffer(nCh || 2, Math.round(seconds * SR), SR); }
function sine(buf, freq, amp) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] += amp * Math.sin(2 * Math.PI * freq * i / SR);
  }
}
// A realistic mega-builder meta, as mashup-mega.js now produces it.
function megaMeta() {
  const sm = QC.slotMeta(8, 4, 8, 2, ['Song A', 'Song B', 'Song C', 'Song D']);
  return {
    masterBpm: 120,
    masterKey: 'Am',
    songs: [
      { name: 'Song A', bpm: 120, key: 'Am' },
      { name: 'Song B', bpm: 126, key: 'C', stretched: true },
      { name: 'Song C', bpm: 118, key: 'G major', stretched: true },
      { name: 'Song D', bpm: 130, key: 'Unknown', stretched: true },
    ],
    vocalSlots: sm.vocalSlots,
    boundariesSec: sm.boundariesSec,
    xfadeBars: 0.5,
    style: 'mega',
  };
}

async function main() {
  console.log('== I4: sendToExport routes through the overlay ==');
  {
    const buf = mkBuf(4); sine(buf, 440, 0.3);
    const meta = megaMeta();
    let showArgs = null;
    const realShow = EX.show;
    EX.show = function (a, b, c) { showArgs = [a, b, c]; return true; };
    let ret = false;
    try { ret = MX.sendToExport(buf, meta); } finally { EX.show = realShow; }
    ok(ret === true, 'sendToExport returns true via overlay');
    ok(showArgs && showArgs[0] === buf, 'overlay receives the buffer positionally');
    ok(showArgs && showArgs[1] === meta, 'overlay receives the meta positionally');
    ok(showArgs && showArgs[2] && /mega-4songs/.test(showArgs[2].name),
      'v23 filename intact (RuhMix-mashup-mega-4songs)', showArgs && showArgs[2] && showArgs[2].name);
    ok(appShowCalls.length === 0, 'classic screen NOT shown when overlay present');
  }

  console.log('== I4: fallback to classic screen when overlay missing ==');
  {
    const buf = mkBuf(4); sine(buf, 440, 0.3);
    const saved = global.window.RM.v25exportui;
    delete global.window.RM.v25exportui;
    appShowCalls.length = 0;
    let ret = false;
    try { ret = MX.sendToExport(buf, { style: 'swap' }); }
    finally { global.window.RM.v25exportui = saved; }
    ok(ret === true, 'sendToExport returns true via fallback');
    ok(appShowCalls[0] === 'export', 'fallback navigates to the classic export screen');
    const es = global.window.RM.app.state.exportSource;
    ok(es && es.kind === 'buffer' && es.buffer === buf, 'fallback sets exportSource (nothing lost)');
    ok(es && /mashup-swap/.test(es.name), 'fallback keeps the v23 filename', es && es.name);
  }

  console.log('== I4: all 11 scans run on a mega builder meta ==');
  {
    const buf = mkBuf(40); sine(buf, 440, 0.25); sine(buf, 90, 0.15);
    const r = await QC.runCheck(buf, megaMeta());
    ok(Array.isArray(r.skips), 'result carries a skips array');
    ok(r.skips.length === 0, 'zero skips on a full mega meta — all 11 scans ran',
      JSON.stringify(r.skips));
    ok(typeof r.measurements.truePeak === 'number', 'clipping scan ran (truePeak measured)');
    ok(typeof r.measurements.lrCorr === 'number', 'phase scan ran');
    ok(typeof r.measurements.bassShare === 'number', 'bass scan ran');
    ok(typeof r.measurements.harshShare === 'number', 'harshness scan ran');
    ok(Array.isArray(r.measurements.barRmsDb), 'volume-jump scan ran');
    ok(typeof r.measurements.driftMs === 'number', 'timing-drift scan ran (masterBpm present)');
    ok(r.summary && typeof r.summary.errors === 'number', 'summary present');
  }

  console.log('== I4: skip reasons reported, never silent ==');
  {
    const buf = mkBuf(10); sine(buf, 440, 0.25);
    const r = await QC.runCheck(buf, {});
    const ids = r.skips.map((s) => s.id);
    ['bpm-mismatch', 'key-mismatch', 'vocal-overlap', 'click', 'timing-drift'].forEach((id) => {
      ok(ids.indexOf(id) >= 0, 'skip reported for: ' + id);
    });
    ok(r.skips.every((s) => typeof s.reason === 'string' && s.reason.length > 8),
      'every skip carries a human reason');
    // The buffer-only scans still ran even with an empty meta.
    ok(typeof r.measurements.truePeak === 'number', 'clipping still runs without meta');
    ok(typeof r.measurements.bassShare === 'number', 'bass still runs without meta');
    // Classic/auto style meta: no boundaries -> click scan reports its skip.
    const r2 = await QC.runCheck(buf, {
      masterBpm: 100,
      songs: [{ name: 'Song 1', bpm: 100, key: null }],
      vocalSlots: [{ songIdx: 0, name: 'Song 1', startSec: 0, endSec: buf.duration }],
      boundariesSec: [],
    });
    const ids2 = r2.skips.map((s) => s.id);
    ok(ids2.indexOf('click') >= 0, 'click scan honestly skipped for classic/auto (no slot transitions)');
    ok(ids2.indexOf('bpm-mismatch') < 0, 'bpm scan RUNS for classic/auto meta');
    ok(ids2.indexOf('vocal-overlap') < 0, 'overlap scan RUNS for classic/auto meta');
    ok(ids2.indexOf('key-mismatch') >= 0, 'key scan skipped when no master key (auto build)');
  }

  console.log('== I4: §25 mandatory checkbox gate ==');
  {
    EX._t.setCrAck(false);
    ok(EX._t.crChecked() === false, 'checkbox starts unchecked');
    ok(EX._t.guardCopyright() === false, '§25: export BLOCKED when checkbox unchecked');
    EX._t.setCrAck(true);
    ok(EX._t.guardCopyright() === true, '§25: export allowed once checkbox ticked');
    EX._t.resetCrAck();
    ok(EX._t.crChecked() === false, '§25: acknowledgement resets per session');
    ok(EX.NOTICE_1.indexOf('legally authorized') >= 0, '§25 notice text verbatim (1)');
    ok(EX.NOTICE_2.indexOf('does NOT give you copyright ownership') >= 0, '§25 notice text verbatim (2)');
  }

  console.log('== I4: slotMeta geometry (builder -> QC contract) ==');
  {
    const sm = QC.slotMeta(4, 4, 8, 2, ['Song 1', 'Song 2']);
    ok(sm.vocalSlots.length === 4, 'swap: 4 vocal slots');
    ok(sm.vocalSlots[0].songIdx === 0 && sm.vocalSlots[1].songIdx === 1 &&
       sm.vocalSlots[2].songIdx === 0 && sm.vocalSlots[3].songIdx === 1,
      'swap: rotation 0,1,0,1');
    ok(sm.vocalSlots[0].startSec === 8 && sm.vocalSlots[0].endSec === 24,
      'swap: slot 0 spans 8s..24s (bars 4..12 @2s/bar)');
    ok(sm.vocalSlots[3].endSec === 72, 'swap: last slot ends at 72s (bar 36)');
    ok(sm.boundariesSec.length === 5, 'swap: 5 boundaries (intro + 3 inter-slot + outro)');
    ok(sm.boundariesSec[0] === 8 && sm.boundariesSec[4] === 72, 'swap: boundaries 8s..72s');
    const mm = QC.slotMeta(8, 4, 8, 2, ['A', 'B', 'C', 'D']);
    ok(mm.vocalSlots.length === 8 && mm.vocalSlots[7].songIdx === 3, 'mega: 8 slots, rotation wraps');
  }

  console.log('== I4: parseKey accepts builder key labels ==');
  {
    ok(QC._t.parseKey('A minor') === QC._t.parseKey('Am'), 'parseKey: "A minor" == "Am"');
    ok(QC._t.parseKey('C major') === QC._t.parseKey('C'), 'parseKey: "C major" == "C"');
    ok(QC._t.keyDistance('A minor', 'C') === 0, 'keyDistance: relative minor is no clash');
    ok(QC._t.keyDistance('F#', 'C') > 2, 'keyDistance: distant keys still clash');
    ok(QC._t.parseKey('Unknown') === null, 'parseKey: "Unknown" -> null (no false clash)');
  }

  console.log('== I4: classic export screen §25 wiring ==');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'www', 'index.html'), 'utf8');
    ok(html.indexOf('id="exp-copyright-ack"') >= 0, 'classic screen has the §25 checkbox');
    ok(html.indexOf('Creating a mashup does NOT give you copyright ownership') >= 0,
      'classic §25 notice is verbatim');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'app.js'), 'utf8');
    ok(/exp-copyright-ack/.test(appJs) && /tick the copyright notice first/.test(appJs),
      'app.js gates exp-start on the §25 checkbox');
    const exUi = fs.readFileSync(path.join(__dirname, '..', 'www', 'js', 'v25-export-ui.js'), 'utf8');
    ok(/data-x="cr-box"/.test(exUi), 'overlay has the mandatory §25 checkbox');
    ok(/exportPipeline\(current\.buffer, fmt, null, function \(f, label\) \{ setBar\(f, label\); \}, expToken, xopts\)/.test(exUi),
      'overlay export uses bitrate/sample-rate overrides');
  }

  console.log('== I4: full path — sendToExport opens the overlay, §25 unchecked ==');
  {
    EX._t.setCrAck(true); // prove show() resets it
    const buf = mkBuf(6); sine(buf, 440, 0.25);
    const sm = QC.slotMeta(4, 4, 8, 2.4, ['Song 1', 'Song 2']);
    MX.sendToExport(buf, {
      style: 'swap', masterBpm: 100,
      songs: [{ name: 'Song 1', bpm: 100, key: 'C major' }, { name: 'Song 2', bpm: 104, key: 'G major', stretched: true }],
      vocalSlots: sm.vocalSlots, boundariesSec: sm.boundariesSec, xfadeBars: 0.5,
    });
    ok(EX.isOpen() === true, 'overlay opens from sendToExport');
    ok(EX._t.crChecked() === false, '§25 checkbox starts UNCHECKED on open (export disabled)');
    ok(EX._t.guardCopyright() === false, 'export blocked until the user ticks §25');
    // Simulate the user ticking the box, then QC finishing in the background.
    EX._t.setCrAck(true);
    ok(EX._t.guardCopyright() === true, 'export unblocked after ticking §25');
    EX.hide();
    ok(EX.isOpen() === false, 'overlay closes cleanly');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
