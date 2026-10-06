'use strict';
/* =====================================================================
   RuhMix — v25-export-ui.js  (W6 §19 + §25: Export screen)
   Module: RM.v25exportui

   "Your Mashup Is Ready" — a standalone export screen rendered as an
   overlay (no edits to app.js/index.html needed). Shows duration, BPM,
   key, song count, estimated file size, format and quality; runs the
   v25 "Smart check" (RM.v25qc) pre-export with a "Fix Issues" button;
   exports via the EXISTING export.js pipeline:

     encode:  RM.audio.resampleBuffer -> RM.audio.floatToInt16 ->
              RM.exp.encodeMp3 / RM.exp.encodeFlac / RM.audio.encodeWavBuffer
     save:    RM.exp.deliver(blob, fileName, mime)   // Music/RuhMix/
              via MediaStore — the v22 path, untouched.
     share:   RM.exp.share(delivery, mime)

   §25 COPYRIGHT NOTICE: before ANY export or share, a notice is shown:
     "Only use audio that you own, have permission to use, or are
      otherwise legally authorized to process and publish."
     "Creating a mashup does NOT give you copyright ownership."
   The user must tick an acknowledgement checkbox once (persisted in
   localStorage). Nothing here claims a remix is copyright-free.

   API:
     RM.v25exportui.show(opts)
       opts = { buffer?, render?, meta?, name?, project?, onClose? }
       - buffer: finished AudioBuffer (from the mashup builder), OR
       - render(onProgress) -> Promise<AudioBuffer>: builds the mix with
         progress shown on the screen's progress bar.
       - meta: { masterBpm, masterKey, songs|songCount, ... } (also fed
         to QC as the arrangement meta)
       - name: base filename (sanitized; extension added per format)
       - project: mashup project data for "Save Project"
         (passed to RM.v25projects.saveMashup if present)
     RM.v25exportui.hide()
     RM.v25exportui.isOpen()
     RM.v25exportui.exportPipeline(buffer, fmt, deps, onProgress, token)
       DOM-free pipeline used by the screen AND by node tests.
       deps defaults to {resample, floatToInt16, encodeMp3, encodeFlac,
       encodeWav, deliver} wired from RM.audio / RM.exp.
   ===================================================================== */
window.RM = window.RM || {};

RM.v25exportui = (function () {
  var LS_ACK = 'ruhmix.v25.copyrightAck.v1';
  var LS_DEF = 'ruhmix.exportDefaults';
  var overlay = null;
  var current = null;   // {buffer, meta, name, project, onClose}
  var lastDelivery = null;
  var expToken = { cancelled: false };
  // v26: §25 copyright acknowledgement is MANDATORY per export session —
  // the checkbox starts unchecked on every show(); export/share stay
  // disabled until the user ticks it. Module-level so node tests can
  // exercise the real gate without a DOM.
  var crAcked = false;
  function crChecked() { return crAcked; }
  function setCrAck(v) { crAcked = !!v; }
  function resetCrAck() { crAcked = false; }
  function guardCopyright() {
    if (crChecked()) return true;
    toast('Please tick the copyright notice above first');
    return false;
  }

  /* ---------------- pure helpers (tested) ---------------- */
  function sanitizeBase(name) {
    var s = String(name || 'RuhMix-mashup');
    s = s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
    s = s.replace(/^\.+/, '').replace(/\.+$/, '');
    return s.slice(0, 80) || 'RuhMix-mashup';
  }
  function fmtLabel(fmt) {
    return fmt === 'mp3' ? 'MP3' : fmt === 'wav' ? 'WAV' : 'FLAC';
  }
  function qualityLabel(fmt, kbps) {
    if (fmt === 'mp3') return 'MP3 · ' + kbps + ' kbps · Good quality, small file';
    if (fmt === 'wav') return 'WAV · 16-bit PCM · Best quality, larger file';
    return 'FLAC · Lossless · Best quality, smaller than WAV';
  }
  function estimateSize(fmt, seconds, kbps, sampleRate, channels) {
    seconds = Math.max(0, seconds || 0);
    if (fmt === 'mp3') return Math.round((kbps * 1000 / 8) * seconds);
    var sr = sampleRate || 44100, ch = channels || 2;
    var wav = 44 + Math.round(seconds * sr * ch * 2);
    if (fmt === 'wav') return wav;
    return Math.round(wav * 0.55); // FLAC estimate: ~55% of WAV
  }
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function getDefaults() {
    var d = { format: 'mp3', bitrate: 192, sampleRate: 44100 };
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_DEF) : null;
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.bitrate) d.bitrate = o.bitrate;
        if (o && o.sampleRate) d.sampleRate = o.sampleRate;
        if (o && o.format) d.format = o.format;
      }
    } catch (e) {}
    return d;
  }
  function ackGiven() {
    try { return (typeof localStorage !== 'undefined') && localStorage.getItem(LS_ACK) === '1'; }
    catch (e) { return false; }
  }
  function setAck() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_ACK, '1'); } catch (e) {}
  }
  function songCount(meta) {
    meta = meta || {};
    if (typeof meta.songs === 'number' && meta.songs > 0) return meta.songs;
    if (typeof meta.songCount === 'number' && meta.songCount > 0) return meta.songCount;
    if (Array.isArray(meta.songs)) return meta.songs.length;
    if (Array.isArray(meta.vocalSlots)) {
      var names = {};
      meta.vocalSlots.forEach(function (s) { if (s && s.name) names[s.name] = 1; });
      var n = Object.keys(names).length;
      if (n) return n;
    }
    return 0;
  }

  /* ---------------- DOM-free export pipeline ---------------- */
  function defaultDeps() {
    return {
      resample: function (b, sr, p) { return RM.audio.resampleBuffer(b, sr, p); },
      floatToInt16: function (b, p) { return RM.audio.floatToInt16(b, p); },
      encodeMp3: function (i16, kbps, sr, p, t) { return RM.exp.encodeMp3(i16, kbps, sr, p, t); },
      encodeFlac: function (i16, sr, p, t) { return RM.exp.encodeFlac(i16, sr, p, t); },
      encodeWav: function (b, p) { return RM.audio.encodeWavBuffer(b, p); },
      deliver: function (blob, name, mime, p) { return RM.exp.deliver(blob, name, mime, p); },
    };
  }

  // buffer -> encoded blob -> RM.exp.deliver (Music/RuhMix/). Returns
  // Promise<delivery>. Stages reported via onProgress(frac, label).
  // xopts (v26, optional): { kbps, sampleRate } from the overlay's selectors —
  // overrides the stored defaults so nothing the classic screen offered is lost.
  function exportPipeline(buffer, fmt, deps, onProgress, token, xopts) {
    deps = deps || defaultDeps();
    token = token || { cancelled: false };
    var prog = function (f, label) { try { if (onProgress) onProgress(f, label); } catch (e) {} };
    var def = getDefaults();
    var kbps = (xopts && xopts.kbps) || def.bitrate;
    var sr = (xopts && xopts.sampleRate) || def.sampleRate;
    var mime = fmt === 'mp3' ? 'audio/mpeg' : fmt === 'wav' ? 'audio/wav' : 'audio/flac';
    var cancelled = function () { return token.cancelled; };
    // Pass-through guard: throws when cancelled, otherwise forwards the value
    // (a bare `.then(failIfCancelled)` would swallow the pipeline value).
    var passIfAlive = function (v) { if (cancelled()) throw new Error('cancelled'); return v; };

    var encodeP;
    if (fmt === 'mp3') {
      prog(0.02, 'Resampling…');
      encodeP = Promise.resolve()
        .then(passIfAlive)
        .then(function () { return deps.resample(buffer, sr, function (p) { prog(0.02 + p * 0.15, 'Resampling… ' + Math.round(p * 100) + '%'); }); })
        .then(passIfAlive)
        .then(function (rs) { return deps.floatToInt16(rs, function (p) { prog(0.17 + p * 0.1, 'Preparing… ' + Math.round(p * 100) + '%'); }); })
        .then(passIfAlive)
        .then(function (i16) {
          prog(0.27, 'Encoding MP3…');
          return deps.encodeMp3(i16, kbps, sr, function (p) { prog(0.27 + p * 0.55, 'Encoding MP3… ' + Math.round(p * 100) + '%'); }, token);
        });
    } else if (fmt === 'flac') {
      prog(0.02, 'Resampling…');
      encodeP = Promise.resolve()
        .then(passIfAlive)
        .then(function () { return deps.resample(buffer, sr, function (p) { prog(0.02 + p * 0.13, 'Resampling… ' + Math.round(p * 100) + '%'); }); })
        .then(passIfAlive)
        .then(function (rs) { return deps.floatToInt16(rs, function (p) { prog(0.15 + p * 0.1, 'Preparing… ' + Math.round(p * 100) + '%'); }); })
        .then(passIfAlive)
        .then(function (i16) {
          prog(0.25, 'Encoding FLAC…');
          return deps.encodeFlac(i16, sr, function (p) { prog(0.25 + p * 0.57, 'Encoding FLAC… ' + Math.round(p * 100) + '%'); }, token);
        });
    } else {
      prog(0.05, 'Encoding WAV…');
      encodeP = Promise.resolve()
        .then(passIfAlive)
        .then(function () { return deps.encodeWav(buffer, function (p) { prog(0.05 + p * 0.77, 'Encoding WAV… ' + Math.round(p * 100) + '%'); }); })
        .then(function (ab) { return new Blob([ab], { type: mime }); });
    }

    return encodeP
      .then(passIfAlive)
      .then(function (blob) {
        prog(0.9, 'Saving…');
        var fileName = sanitizeBase(current && current.name) + '.' + fmt;
        return deps.deliver(blob, fileName, mime, function (p) { prog(0.9 + p * 0.1, 'Saving… ' + Math.round(p * 100) + '%'); })
          .then(function (delivery) {
            delivery = delivery || {};
            delivery.mime = mime;
            delivery.fileName = fileName;
            prog(1, 'Done');
            return delivery;
          });
      });
  }

  /* ---------------- overlay screen ---------------- */
  function css() {
    return 'position:fixed;inset:0;z-index:9999;background:rgba(8,10,12,.97);' +
      'display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
  }
  function cardCss() {
    return 'width:100%;max-width:520px;max-height:92vh;overflow-y:auto;background:#14181c;' +
      'border:1px solid #2a3138;border-radius:16px;padding:20px;color:#eef2f5;' +
      'font-family:system-ui,-apple-system,sans-serif;box-sizing:border-box;';
  }
  function btnCss(primary) {
    return 'flex:1;min-width:140px;padding:12px 10px;border-radius:10px;border:' +
      (primary ? 'none' : '1px solid #3a434c') + ';font-size:15px;font-weight:700;cursor:pointer;' +
      'background:' + (primary ? '#1db954' : '#222a31') + ';color:' + (primary ? '#06130b' : '#eef2f5') + ';';
  }
  function el(tag, style, html) {
    var d = document.createElement(tag);
    if (style) d.setAttribute('style', style);
    if (html != null) d.innerHTML = html;
    return d;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    try {
      var A = window.RM && RM.app;
      if (A && typeof A.toast === 'function') { A.toast(msg); return; }
    } catch (e) {}
    try { if (window.MuseToast) window.MuseToast(msg); } catch (e2) {}
  }

  function setBar(frac, label) {
    if (!overlay) return;
    var bar = overlay.querySelector('[data-x="pbar"]');
    var lab = overlay.querySelector('[data-x="plabel"]');
    if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (lab && label != null) lab.textContent = label;
  }

  function metaRows() {
    var meta = (current && current.meta) || {};
    var buf = current && current.buffer;
    var dur = buf ? buf.duration : 0;
    var bpm = meta.masterBpm || meta.bpm || '—';
    var key = meta.masterKey || meta.key || '—';
    var n = songCount(meta);
    var def = uiFmt || getDefaults(); // v26: estimate follows the overlay's selectors
    var rows = [
      ['Duration', fmtDur(dur)],
      ['Tempo', typeof bpm === 'number' ? Math.round(bpm * 10) / 10 + ' BPM' : esc(bpm)],
      ['Key', esc(key)],
      ['Songs', n ? String(n) : '—'],
      ['File size (est.)', esc(fmtBytes(estimateSize(def.format, dur, def.bitrate, buf ? buf.sampleRate : 44100, buf ? buf.numberOfChannels : 2))) + ' · ' + fmtLabel(def.format)],
      ['Quality', esc(qualityLabel(def.format, def.bitrate))],
    ];
    return rows.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;padding:7px 2px;border-bottom:1px solid #222a31;font-size:14px;">' +
        '<span style="color:#9aa7b2;">' + r[0] + '</span>' +
        '<span style="font-weight:700;">' + r[1] + '</span></div>';
    }).join('');
  }

  function qcPanelHtml() {
    return '<div style="margin-top:14px;border:1px solid #2a3138;border-radius:12px;padding:12px;background:#10141a;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
      '<div style="font-weight:800;font-size:15px;">🔍 Smart Check <span style="font-weight:400;color:#9aa7b2;font-size:12px;">pre-export quality scan</span></div>' +
      '<button data-x="qc-rerun" style="background:#222a31;color:#eef2f5;border:1px solid #3a434c;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer;">↻ Re-run</button>' +
      '</div>' +
      '<div data-x="qc-status" style="color:#9aa7b2;font-size:13px;">Preparing…</div>' +
      '<div data-x="qc-list" style="margin-top:6px;"></div>' +
      '<div data-x="qc-skips" style="margin-top:2px;"></div>' +
      '<button data-x="qc-fix" style="display:none;margin-top:8px;width:100%;padding:10px;border-radius:10px;border:none;background:#f5a623;color:#1a1206;font-size:14px;font-weight:800;cursor:pointer;">🔧 Fix Issues</button>' +
      '<div data-x="qc-fixes" style="margin-top:6px;font-size:13px;color:#b8e6c3;"></div>' +
      '</div>';
  }

  function renderQcIssues(box, listBox, fixBtn, result) {    var issues = result.issues || [];
    var s = result.summary || { errors: 0, warnings: 0, infos: 0 };
    if (!issues.length) {
      box.innerHTML = '<span style="color:#1db954;font-weight:700;">✓ All clear — no issues found.</span>';
      listBox.innerHTML = '';
      fixBtn.style.display = 'none';
      return;
    }
    box.innerHTML = '<span style="font-weight:700;color:' + (s.errors ? '#ff6b6b' : '#f5a623') + ';">' +
      s.errors + ' error(s), ' + s.warnings + ' warning(s)' + (s.infos ? ', ' + s.infos + ' note(s)' : '') + '</span>';
    listBox.innerHTML = issues.map(function (x) {
      var col = x.severity === 'error' ? '#ff6b6b' : x.severity === 'warn' ? '#f5a623' : '#7cc7ff';
      var badge = x.autoFixable
        ? '<span style="background:#1db95422;color:#1db954;border:1px solid #1db95466;border-radius:6px;padding:1px 6px;font-size:11px;margin-left:6px;">auto-fixable</span>'
        : '<span style="background:#ffffff10;color:#9aa7b2;border:1px solid #3a434c;border-radius:6px;padding:1px 6px;font-size:11px;margin-left:6px;">manual</span>';
      return '<div style="border-left:3px solid ' + col + ';padding:6px 8px;margin:6px 0;background:#ffffff06;border-radius:0 8px 8px 0;">' +
        '<div style="font-size:13.5px;font-weight:700;color:' + col + ';">' + esc(x.issue) + badge + '</div>' +
        (x.detail ? '<div style="font-size:12.5px;color:#9aa7b2;margin-top:2px;">' + esc(x.detail) + '</div>' : '') +
        '</div>';
    }).join('');
    fixBtn.style.display = issues.some(function (x) { return x.autoFixable; }) ? '' : 'none';
  }

  // v26: skipped checks are shown honestly ("skipped: <reason>") — never
  // silently skipped. Rendered into the [data-x="qc-skips"] container.
  var SKIP_LABELS = {
    'bpm-mismatch': 'BPM match', 'key-mismatch': 'Key match',
    'vocal-overlap': 'Vocal overlap', 'click': 'Transition clicks',
    'timing-drift': 'Timing drift',
  };
  function renderQcSkips(skipsBox, result) {
    if (!skipsBox) return;
    var skips = (result && result.skips) || [];
    if (!skips.length) { skipsBox.innerHTML = ''; return; }
    skipsBox.innerHTML =
      '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #2a3138;">' +
      '<div style="font-size:12px;color:#9aa7b2;font-weight:700;margin-bottom:4px;">⏭ Skipped checks (not enough info to run — shown, never hidden)</div>' +
      skips.map(function (s) {
        var lbl = SKIP_LABELS[s.id] || s.id;
        return '<div style="font-size:12.5px;color:#9aa7b2;margin:3px 0;">• <b>' + esc(lbl) +
          '</b> — skipped: ' + esc(s.reason) + '</div>';
      }).join('') + '</div>';
  }

  function runQc() {
    if (!overlay || !current || !current.buffer) return;
    var box = overlay.querySelector('[data-x="qc-status"]');
    var listBox = overlay.querySelector('[data-x="qc-list"]');
    var fixBtn = overlay.querySelector('[data-x="qc-fix"]');
    var fixesBox = overlay.querySelector('[data-x="qc-fixes"]');
    if (fixesBox) fixesBox.innerHTML = '';
    if (!window.RM || !RM.v25qc) {
      box.innerHTML = '<span style="color:#9aa7b2;">Smart check unavailable (v25-qc.js not loaded).</span>';
      return;
    }
    box.textContent = 'Scanning…';
    listBox.innerHTML = '';
    fixBtn.style.display = 'none';
    var qcToken = { cancelled: false };
    overlay._qcToken = qcToken;
    RM.v25qc.runCheck(current.buffer, current.meta || {}, function (f, label) {
      if (overlay && overlay._qcToken === qcToken) box.textContent = label || ('Scanning… ' + Math.round(f * 100) + '%');
    }).then(function (result) {
      if (!overlay || overlay._qcToken !== qcToken) return;
      current.qc = result;
      renderQcIssues(box, listBox, fixBtn, result);
      renderQcSkips(overlay.querySelector('[data-x="qc-skips"]'), result);
    }).catch(function (e) {
      if (!overlay || overlay._qcToken !== qcToken) return;
      box.innerHTML = '<span style="color:#ff6b6b;">Check failed: ' + esc(e && e.message) + '</span>';
    });
  }

  function fixQcIssues() {
    if (!overlay || !current || !current.buffer || !current.qc) return;
    var box = overlay.querySelector('[data-x="qc-status"]');
    var fixBtn = overlay.querySelector('[data-x="qc-fix"]');
    var fixesBox = overlay.querySelector('[data-x="qc-fixes"]');
    fixBtn.disabled = true;
    box.textContent = 'Fixing…';
    RM.v25qc.fixAll(current.buffer, current.qc.issues, current.meta || {}, function (f, label) {
      box.textContent = label || ('Fixing… ' + Math.round(f * 100) + '%');
    }).then(function (r) {
      if (!overlay) return;
      current.buffer = r.buffer; // QC-fixed buffer becomes the export source
      if (fixesBox) {
        fixesBox.innerHTML = '<div style="font-weight:700;margin-bottom:4px;">✓ Applied ' + r.fixes.length + ' fix(es):</div>' +
          r.fixes.map(function (fx) {
            return '<div style="margin:3px 0;">• <b>' + esc(fx.title) + '</b><br>' +
              '<span style="color:#9aa7b2;">before: ' + esc(fx.before) + '<br>after: ' + esc(fx.after) + '</span></div>';
          }).join('');
      }
      toast('Fixes applied — re-checking');
      runQc(); // re-run to confirm
    }).catch(function (e) {
      if (!overlay) return;
      box.innerHTML = '<span style="color:#ff6b6b;">Fix failed: ' + esc(e && e.message) + '</span>';
      fixBtn.disabled = false;
    });
  }

  /* ---------------- §25 copyright notice ---------------- */
  var NOTICE_1 = 'Only use audio that you own, have permission to use, or are otherwise legally authorized to process and publish.';
  var NOTICE_2 = 'Creating a mashup does NOT give you copyright ownership.';
  function ensureAck(cb) {
    if (ackGiven()) { cb(true); return; }
    // Modal notice with a mandatory acknowledgement checkbox (once).
    var back = el('div', 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;');
    var card = el('div', 'background:#14181c;border:1px solid #2a3138;border-radius:14px;padding:20px;max-width:440px;color:#eef2f5;font-family:system-ui,-apple-system,sans-serif;');
    card.innerHTML =
      '<div style="font-size:17px;font-weight:800;margin-bottom:10px;">⚖️ Copyright Notice</div>' +
      '<p style="font-size:14px;line-height:1.5;color:#cfd8e0;">' + esc(NOTICE_1) + '</p>' +
      '<p style="font-size:14px;line-height:1.5;color:#cfd8e0;font-weight:700;">' + esc(NOTICE_2) + '</p>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13.5px;margin:12px 0;cursor:pointer;">' +
      '<input type="checkbox" data-x="ack-box" style="margin-top:3px;width:18px;height:18px;">' +
      '<span>I understand — I will only export and share audio I am legally authorized to use.</span></label>' +
      '<div style="display:flex;gap:10px;">' +
      '<button data-x="ack-ok" disabled style="flex:1;padding:11px;border-radius:10px;border:none;background:#1db954;color:#06130b;font-size:15px;font-weight:800;opacity:.45;cursor:not-allowed;">I Understand</button>' +
      '<button data-x="ack-cancel" style="flex:1;padding:11px;border-radius:10px;border:1px solid #3a434c;background:#222a31;color:#eef2f5;font-size:15px;font-weight:700;cursor:pointer;">Cancel</button>' +
      '</div>';
    back.appendChild(card);
    document.body.appendChild(back);
    var box = card.querySelector('[data-x="ack-box"]');
    var okB = card.querySelector('[data-x="ack-ok"]');
    var done = function (v) { try { document.body.removeChild(back); } catch (e) {} cb(v); };
    box.addEventListener('change', function () {
      okB.disabled = !box.checked;
      okB.style.opacity = box.checked ? '1' : '.45';
      okB.style.cursor = box.checked ? 'pointer' : 'not-allowed';
    });
    okB.addEventListener('click', function () { if (box.checked) { setAck(); done(true); } });
    card.querySelector('[data-x="ack-cancel"]').addEventListener('click', function () { done(false); });
  }

  /* ---------------- export / share / save ---------------- */
  // v26: read the overlay's bitrate / sample-rate selectors (the classic
  // screen's options — nothing lost). Persists the choice so the classic
  // export screen and this overlay stay in sync.
  function uiExportOpts(fmt) {
    if (!uiFmt) uiFmt = getDefaults();
    uiFmt.format = fmt;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_DEF, JSON.stringify(uiFmt)); } catch (e) {}
    return { kbps: uiFmt.bitrate, sampleRate: uiFmt.sampleRate };
  }

  function doExport(fmt) {
    if (!guardCopyright()) return; // §25: mandatory checkbox, per session
    if (!current || !current.buffer) { toast('Nothing to export'); return; }
    if (!overlay) return;
    var xopts = uiExportOpts(fmt);
    expToken = { cancelled: false };
    setBar(0, 'Starting…');
    var statusEl = overlay.querySelector('[data-x="status"]');
    var cancelBtn = overlay.querySelector('[data-x="cancel"]');
    if (cancelBtn) cancelBtn.style.display = '';
    var setStatus = function (t, isErr) {
      if (statusEl) { statusEl.textContent = t; statusEl.style.color = isErr ? '#ff6b6b' : '#9aa7b2'; }
    };
    exportPipeline(current.buffer, fmt, null, function (f, label) { setBar(f, label); }, expToken, xopts)
      .then(function (delivery) {
        lastDelivery = delivery;
        if (cancelBtn) cancelBtn.style.display = 'none';
        var viaLib = delivery && delivery.method === 'native-music-library';
        setStatus('✓ Done: ' + delivery.fileName + (viaLib ? ' — saved to Music/RuhMix/' : ''), false);
        setBar(1, 'Done');
        toast(viaLib ? 'Saved to Music/RuhMix/ — open your music player!' : 'Export complete');
        var shareBtn = overlay.querySelector('[data-x="share"]');
        if (shareBtn) shareBtn.style.display = '';
        try { if (window.RM && RM.ads) RM.ads.notifyExportDone(); } catch (e) {}
      })
      .catch(function (e) {
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (e && e.message === 'cancelled') { setStatus('Cancelled', false); setBar(0, 'Cancelled'); return; }
        setStatus('Export failed: ' + (e && e.message), true);
      });
  }

  function doShare() {
    if (!guardCopyright()) return; // §25: mandatory checkbox, per session
    if (!lastDelivery) { toast('Export first, then share'); return; }
    try {
      var r = RM.exp.share(lastDelivery, lastDelivery.mime);
      if (r === 'unavailable') toast('Share unavailable on this device');
    } catch (e) { toast('Share failed'); }
  }

  function doSaveProject() {
    try {
      if (!window.RM || !RM.v25projects) { toast('Project saving unavailable'); return; }
      var meta = (current && current.meta) || {};
      var data = {
        name: (current && current.name) || 'Mashup Project',
        bpm: meta.masterBpm || meta.bpm || null,
        key: meta.masterKey || meta.key || null,
        arrangementPlan: meta.arrangementPlan || meta.plan || null,
        qcReport: current.qc ? { summary: current.qc.summary, issues: current.qc.issues } : null,
        exportInfo: lastDelivery ? { fileName: lastDelivery.fileName, mime: lastDelivery.mime, method: lastDelivery.method } : null,
      };
      if (current && current.project && typeof current.project === 'object') {
        Object.keys(current.project).forEach(function (k) { if (data[k] === undefined || data[k] === null) data[k] = current.project[k]; });
      }
      var id = RM.v25projects.saveMashup(data);
      toast(id ? '✓ Project saved' : 'Save failed');
    } catch (e) { toast('Save failed'); }
  }

  /* ---------------- show / hide ---------------- */
  // v26: per-session export options, seeded from stored defaults at show().
  var uiFmt = null;

  // v26: §25 copyright notice — verbatim text + mandatory checkbox.
  function copyrightHtml() {
    return '<div style="margin-top:14px;border:1px solid #2a3138;border-radius:12px;padding:12px;background:#10141a;">' +
      '<div style="font-weight:800;font-size:14px;margin-bottom:6px;">⚖️ Copyright Notice</div>' +
      '<p style="font-size:13px;line-height:1.5;color:#cfd8e0;margin:0 0 6px;">' + esc(NOTICE_1) + '</p>' +
      '<p style="font-size:13px;line-height:1.5;color:#cfd8e0;font-weight:700;margin:0 0 8px;">' + esc(NOTICE_2) + '</p>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13.5px;cursor:pointer;">' +
      '<input type="checkbox" data-x="cr-box" style="margin-top:3px;width:18px;height:18px;flex-shrink:0;">' +
      '<span>I understand — I will only export and share audio I am legally authorized to use.</span></label>' +
      '</div>';
  }

  // v26: bitrate + sample-rate selectors — the classic export screen's
  // options, so nothing is lost by routing through this overlay.
  function fmtOptsHtml() {
    var def = uiFmt || getDefaults();
    function selOpts(vals, cur) {
      return vals.map(function (v) {
        return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + v + '</option>';
      }).join('');
    }
    var selCss = 'background:#222a31;color:#eef2f5;border:1px solid #3a434c;border-radius:8px;padding:6px 8px;';
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;align-items:center;">' +
      '<label data-x="br-row" style="font-size:13px;color:#9aa7b2;' + (def.format === 'mp3' ? '' : 'display:none;') + '">Bitrate ' +
      '<select data-x="bitrate" style="' + selCss + '">' + selOpts([128, 192, 256, 320], def.bitrate) + '</select> kbps</label>' +
      '<label style="font-size:13px;color:#9aa7b2;">Sample rate ' +
      '<select data-x="sr" style="' + selCss + '">' + selOpts([44100, 48000], def.sampleRate) + '</select> Hz</label>' +
      '</div>';
  }

  function refreshMeta() {
    if (!overlay) return;
    var box = overlay.querySelector('[data-x="meta"]');
    if (box) box.innerHTML = metaRows();
    try {
      var def = uiFmt || getDefaults();
      var brRow = overlay.querySelector('[data-x="br-row"]');
      if (brRow) brRow.style.display = def.format === 'mp3' ? '' : 'none';
    } catch (e) {}
  }

  function show(a, b, c) {
    var opts;
    // v26: positional form show(buffer, meta, opts) — used by
    // RM.mashupExport.sendToExport (the mashup export choke point).
    // The object form show({buffer, meta, name, ...}) keeps working.
    if (a && typeof a === 'object' && typeof a.getChannelData === 'function' && typeof a.duration === 'number') {
      opts = (c && typeof c === 'object') ? c : {};
      opts.buffer = a;
      if (b && typeof b === 'object') opts.meta = b;
    } else {
      opts = a || {};
    }
    opts = opts || {};
    hide();
    resetCrAck(); // §25: checkbox starts unchecked on every show()
    uiFmt = getDefaults();
    current = {
      buffer: opts.buffer || null,
      meta: opts.meta || {},
      name: sanitizeBase(opts.name || 'RuhMix-mashup'),
      project: opts.project || null,
      onClose: opts.onClose || null,
      qc: null,
    };
    lastDelivery = null;

    overlay = el('div', css());
    var card = el('div', cardCss());
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;">' +
      '<div style="font-size:20px;font-weight:800;">🎉 Your Mashup Is Ready</div>' +
      '<button data-x="close" style="background:none;border:none;color:#9aa7b2;font-size:22px;cursor:pointer;">✕</button>' +
      '</div>' +
      '<div data-x="meta" style="margin:12px 0 4px;">' + metaRows() + '</div>' +
      qcPanelHtml() +
      copyrightHtml() +
      '<div style="margin:16px 0 6px;background:#222a31;border-radius:10px;height:10px;overflow:hidden;">' +
      '<div data-x="pbar" style="height:100%;width:0%;background:#1db954;border-radius:10px;transition:width .2s;"></div></div>' +
      '<div data-x="plabel" style="font-size:13px;color:#9aa7b2;min-height:18px;margin-bottom:4px;"></div>' +
      '<div data-x="status" style="font-size:13px;color:#9aa7b2;min-height:18px;margin-bottom:10px;"></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;">' +
      '<button data-x="mp3" style="' + btnCss(true) + '">⬇ Export MP3</button>' +
      '<button data-x="wav" style="' + btnCss(false) + '">⬇ Export WAV</button>' +
      '<button data-x="flac" style="' + btnCss(false) + '">⬇ Export FLAC</button>' +
      '</div>' +
      fmtOptsHtml() +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;">' +
      '<button data-x="save" style="' + btnCss(false) + '">💾 Save Project</button>' +
      '<button data-x="share" style="display:none;' + btnCss(false) + '">📤 Share</button>' +
      '<button data-x="cancel" style="display:none;' + btnCss(false) + '">✕ Cancel</button>' +
      '</div>' +
      '<div style="margin-top:12px;font-size:11.5px;color:#6b7683;line-height:1.5;">Exports save to <b>Music/RuhMix/</b> on your device. A mashup is a creative remix — it does not give you copyright ownership.</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    card.querySelector('[data-x="close"]').addEventListener('click', hide);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
    card.querySelector('[data-x="mp3"]').addEventListener('click', function () { doExport('mp3'); });
    card.querySelector('[data-x="wav"]').addEventListener('click', function () { doExport('wav'); });
    card.querySelector('[data-x="flac"]').addEventListener('click', function () { doExport('flac'); });
    card.querySelector('[data-x="save"]').addEventListener('click', doSaveProject);
    card.querySelector('[data-x="share"]').addEventListener('click', doShare);
    card.querySelector('[data-x="cancel"]').addEventListener('click', function () {
      expToken.cancelled = true;
      var s = overlay.querySelector('[data-x="status"]');
      if (s) s.textContent = 'Cancelling…';
    });
    card.querySelector('[data-x="qc-rerun"]').addEventListener('click', runQc);
    card.querySelector('[data-x="qc-fix"]').addEventListener('click', fixQcIssues);

    // v26 §25: mandatory per-session checkbox — export buttons stay
    // disabled until it is ticked.
    var crBox = card.querySelector('[data-x="cr-box"]');
    var expBtns = ['mp3', 'wav', 'flac'].map(function (k) { return card.querySelector('[data-x="' + k + '"]'); });
    function syncCr() {
      var on = !!(crBox && crBox.checked);
      setCrAck(on);
      expBtns.forEach(function (btn) {
        if (!btn) return;
        btn.disabled = !on;
        btn.style.opacity = on ? '1' : '.45';
        btn.style.cursor = on ? 'pointer' : 'not-allowed';
      });
    }
    if (crBox) crBox.addEventListener('change', syncCr);
    syncCr();

    // v26: bitrate / sample-rate selectors feed the estimate + the export.
    var brSel = card.querySelector('[data-x="bitrate"]');
    var srSel = card.querySelector('[data-x="sr"]');
    if (brSel) brSel.addEventListener('change', function () {
      if (uiFmt && +brSel.value) uiFmt.bitrate = +brSel.value;
      refreshMeta();
    });
    if (srSel) srSel.addEventListener('change', function () {
      if (uiFmt && +srSel.value) uiFmt.sampleRate = +srSel.value;
      refreshMeta();
    });

    var finishShow = function () {
      if (!current.buffer) {
        var s = overlay.querySelector('[data-x="status"]');
        if (s) { s.textContent = 'No audio yet'; s.style.color = '#ff6b6b'; }
        return;
      }
      runQc();
    };

    if (!current.buffer && typeof opts.render === 'function') {
      setBar(0, 'Rendering mashup…');
      var renderToken = { cancelled: false };
      overlay._renderToken = renderToken;
      Promise.resolve()
        .then(function () {
          return opts.render(function (f, label) {
            if (overlay && overlay._renderToken === renderToken) setBar(f, label || 'Rendering…');
          });
        })
        .then(function (buf) {
          if (!overlay || overlay._renderToken !== renderToken) return;
          current.buffer = buf;
          setBar(1, 'Render complete');
          runQc();
        })
        .catch(function (e) {
          if (!overlay || overlay._renderToken !== renderToken) return;
          var s = overlay.querySelector('[data-x="status"]');
          if (s) { s.textContent = 'Render failed: ' + (e && e.message); s.style.color = '#ff6b6b'; }
        });
      return true;
    }
    finishShow();
    return true;
  }

  function hide() {
    if (overlay && overlay._qcToken) overlay._qcToken.cancelled = true;
    if (overlay) { try { document.body.removeChild(overlay); } catch (e) {} }
    overlay = null;
    expToken.cancelled = true;
    var cb = current && current.onClose;
    current = null;
    lastDelivery = null;
    if (cb) { try { cb(); } catch (e) {} }
  }

  return {
    show: show,
    hide: hide,
    isOpen: function () { return !!overlay; },
    exportPipeline: exportPipeline,
    ensureCopyrightAck: ensureAck,
    NOTICE_1: NOTICE_1,
    NOTICE_2: NOTICE_2,
    _t: {
      sanitizeBase: sanitizeBase, fmtLabel: fmtLabel, qualityLabel: qualityLabel,
      estimateSize: estimateSize, fmtBytes: fmtBytes, fmtDur: fmtDur,
      getDefaults: getDefaults, ackGiven: ackGiven, setAck: setAck,
      songCount: songCount,
      // v26: §25 mandatory-checkbox gate (module-level, DOM-free)
      crChecked: crChecked, setCrAck: setCrAck, resetCrAck: resetCrAck,
      guardCopyright: guardCopyright,
    },
  };
})();
