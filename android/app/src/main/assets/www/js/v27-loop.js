'use strict';
/* =====================================================================
   RuhMix v27 W3 — loop region controls (REAL loop, not a fake toggle).

   What this module owns:
     - the loop REGION model: {on, inSec, outSec, times}
     - setRegion() from the editor selection (or setFromBars() from a bar
       range), with swap/clamp/min-length validation — never a corrupt range
     - toggle() / applyToPlayer(): pushes the region into the transport
       player's setLoop(on, in, out), which re-points the LIVE
       AudioBufferSourceNode.loop / loopStart / loopEnd mid-playback
       (no restart needed)
     - persistence: region mirrors project.settings.loopRegion (+loop),
       so autosave / crash-recovery carry it
     - renderLooped(): the offline render half of the loop

   LOOP RENDER SPEC (defined, honest): loop ON with a valid region [in,out)
   and N repeats renders
       head[0..in) + region[in..out) repeated N times + tail[out..end)
   i.e. the region's single original occurrence is REPLACED by N back-to-back
   copies. Output length = in + N*(out-in) + (dur-out). N=1 is an identity
   splice (head+region+tail == the source). Export bakes this in when the
   loop is on — the file contains exactly what the toggle promises.

   Playback spec: while loop is ON, the player wraps around [in,out)
   forever (or until toggled off / a new region is set).
   ===================================================================== */
window.RM = window.RM || {};

RM.v27loop = (function () {
  var S = { on: false, inSec: 0, outSec: 0, times: 2 }; // the loop region model
  var MIN_LEN = 0.05; // regions shorter than this are not real loops
  var MAX_TIMES = 8;

  function r2(x) { return Math.round(x * 100) / 100; }
  function num(x) { var n = Number(x); return Number.isFinite(n) ? n : NaN; }

  function fmtTime(s) {
    s = Math.max(0, num(s));
    if (!Number.isFinite(s)) s = 0;
    var m = Math.floor(s / 60), sec = s - m * 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
  }

  // Is this region state usable against a track duration?
  function validRegion(st, dur) {
    if (!st) return false;
    var i = num(st.inSec), o = num(st.outSec);
    if (!Number.isFinite(i) || !Number.isFinite(o)) return false;
    if (o - i < MIN_LEN) return false;
    if (i < 0 || o < 0) return false;
    if (dur > 0 && o > dur + 1e-6) return false;
    return true;
  }

  function writeSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    settings.loop = S.on;
    settings.loopRegion = { inSec: r2(S.inSec), outSec: r2(S.outSec), times: S.times };
  }

  // Set the region from seconds (usually the editor selection). Inverted
  // ranges are swapped, everything is clamped to [0,dur], sub-0.05s regions
  // are rejected. Returns true on success, false when there is no usable
  // selection (caller shows the "make a selection" hint).
  function setRegion(a, b, settings, dur) {
    var x = num(a), y = num(b), d = num(dur);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(d > 0)) return false;
    if (y < x) { var t = x; x = y; y = t; }
    x = Math.min(Math.max(x, 0), d);
    y = Math.min(Math.max(y, 0), d);
    if (y - x < MIN_LEN) return false;
    S.inSec = x; S.outSec = y;
    writeSettings(settings);
    return true;
  }

  // Set the region from a bar range: bars [barA,barB) at barSec seconds/bar.
  function setFromBars(barA, barB, barSec, settings, dur) {
    barSec = num(barSec);
    if (!(barSec > 0)) return false;
    return setRegion(num(barA) * barSec, num(barB) * barSec, settings, dur);
  }

  function setTimes(n, settings) {
    n = Math.round(num(n));
    if (!Number.isFinite(n)) return S.times;
    S.times = Math.min(MAX_TIMES, Math.max(1, n));
    writeSettings(settings);
    return S.times;
  }

  function clear(settings) {
    S.on = false; S.inSec = 0; S.outSec = 0;
    writeSettings(settings);
  }

  // Restore the module state from project settings (fresh launch, project
  // open, crash recovery). Legacy saves that only have settings.loop (no
  // loopRegion) fall back to the whole track — the pre-v27 behavior.
  function syncFromSettings(settings, dur) {
    var lr = settings && settings.loopRegion;
    S.on = !!(settings && settings.loop);
    S.times = 2;
    if (lr && Number.isFinite(num(lr.inSec)) && Number.isFinite(num(lr.outSec))) {
      S.inSec = Math.max(0, num(lr.inSec));
      S.outSec = Math.max(S.inSec, num(lr.outSec));
      var t = Math.round(num(lr.times));
      if (Number.isFinite(t)) S.times = Math.min(MAX_TIMES, Math.max(1, t));
    } else { S.inSec = 0; S.outSec = 0; }
    if (dur > 0) {
      S.inSec = Math.min(S.inSec, dur);
      S.outSec = Math.min(S.outSec, dur);
      if (S.on && S.outSec - S.inSec < MIN_LEN) { S.inSec = 0; S.outSec = dur; }
    }
    return validRegion(S, dur || 0);
  }

  // Flip the loop. Turning ON with no valid region falls back to the whole
  // track (pre-v27 behavior); with no audio at all it stays off.
  // Returns the new on/off state.
  function toggle(player, settings, dur) {
    S.on = !S.on;
    if (S.on && !validRegion(S, dur || 0)) {
      if (dur > 0) { S.inSec = 0; S.outSec = dur; }
      else { S.on = false; writeSettings(settings); return false; }
    }
    writeSettings(settings);
    applyToPlayer(player);
    return S.on;
  }

  // Push the region into the live transport player. Mid-playback safe:
  // player.setLoop() re-points the running source node's loopStart/loopEnd
  // immediately, no restart needed.
  function applyToPlayer(player) {
    if (!player || typeof player.setLoop !== 'function') return false;
    if (S.on && S.outSec > S.inSec) player.setLoop(true, S.inSec, S.outSec);
    else player.setLoop(false);
    return true;
  }

  function regionLabel() {
    if (!(S.outSec > S.inSec)) return '';
    return fmtTime(S.inSec) + ' – ' + fmtTime(S.outSec) + ' ×' + S.times;
  }

  // Export-time spec: null unless the loop is ON with a valid region.
  function exportSpec(settings, dur) {
    void settings;
    if (!S.on || !validRegion(S, dur || 0)) return null;
    var d = num(dur);
    return {
      inSec: Math.min(Math.max(S.inSec, 0), d),
      outSec: Math.min(Math.max(S.outSec, 0), d),
      times: S.times,
    };
  }

  // Pure offline render per the LOOP RENDER SPEC above.
  // makeBuf(nCh, len, sr) creates the output buffer — the app passes
  // RM.audio.ensureCtx().createBuffer, tests pass a fake. Returns the new
  // buffer, or null when the region is invalid / allocation fails.
  function renderLooped(makeBuf, src, inSec, outSec, times) {
    if (!src || typeof src.getChannelData !== 'function') return null;
    var sr = src.sampleRate, nCh = src.numberOfChannels, len = src.length;
    if (!(sr > 0) || !(nCh > 0) || !(len > 0)) return null;
    var i0 = Math.round(num(inSec) * sr), i1 = Math.round(num(outSec) * sr);
    if (!Number.isFinite(i0) || !Number.isFinite(i1)) return null;
    i0 = Math.min(Math.max(i0, 0), len);
    i1 = Math.min(Math.max(i1, 0), len);
    if (i1 - i0 < Math.max(1, Math.round(MIN_LEN * sr))) return null;
    times = Math.round(num(times));
    if (!Number.isFinite(times)) times = 1;
    times = Math.min(MAX_TIMES, Math.max(1, times));
    var total = i0 + times * (i1 - i0) + (len - i1);
    var out = null;
    try { out = makeBuf(nCh, total, sr); } catch (e) { out = null; }
    if (!out) return null;
    var pos = 0;
    function blit(s0, n) {
      if (n <= 0) return;
      for (var c = 0; c < nCh; c++) {
        var srcCh = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
        out.getChannelData(c).set(srcCh.subarray(s0, s0 + n), pos);
      }
      pos += n;
    }
    blit(0, i0);                          // head
    for (var k = 0; k < times; k++) blit(i0, i1 - i0); // region × N
    blit(i1, len - i1);                    // tail
    return out;
  }

  var api = {
    state: function () { return S; },
    setRegion: setRegion, setFromBars: setFromBars, setTimes: setTimes,
    clear: clear, toggle: toggle, applyToPlayer: applyToPlayer,
    syncFromSettings: syncFromSettings, regionLabel: regionLabel,
    exportSpec: exportSpec, renderLooped: renderLooped,
    fmtTime: fmtTime, validRegion: validRegion,
  };

  // Node unit-test hook (browser-harmless).
  try {
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
  } catch (e) {}

  return api;
})();
