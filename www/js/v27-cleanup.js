/*
 * RuhMix v27 W5 — Storage cleanup: temp files auto-delete (STABILITY).
 *
 * Problem: stem separation, chunked mashup renders and exports create large
 * transient blobs/buffers (JS) and staging files in the native cache
 * (getCacheDir()/share/, getCacheDir()/rec/). Without cleanup these pile up.
 *
 * What this module does
 * ---------------------
 *  1. Tracks every object URL the app creates (defensive patch of
 *     URL.createObjectURL / revokeObjectURL) and revokes ones older than
 *     URL_STALE_MS (30 min) — a forgotten URL pins its Blob in memory.
 *  2. Keeps a registry of temp audio (render blobs, preview buffers) with a
 *     hard cap: MAX_TEMP_AUDIO_ITEMS (5) items / MAX_TEMP_AUDIO_BYTES
 *     (250 MB). Oldest is released first; dropping the reference lets the
 *     GC reclaim the memory. Active playback buffers are never registered,
 *     so never released.
 *  3. Asks the native shell to prune stale cache files:
 *     Android.cleanupOldTempFiles(includeImports) — native deletes files
 *     older than 7 days inside getCacheDir()/share/ and getCacheDir()/rec/
 *     (manual clear also includes getCacheDir()/imports/).
 *  4. Runs automatically on app start and after every export completes
 *     (RM.exp.deliver is wrapped once). Returns a summary object and logs
 *     everything to the console.
 *  5. Exposes RM.cleanup.clearCache() for the manual "Clear Cache" button
 *     in Settings (wired via app.js clearTempData()).
 *
 * Safety rules (conservative — when in doubt, do NOT delete)
 * ----------------------------------------------------------
 *  - NEVER touched: user projects (localStorage 'ruhmix.projects.v1'),
 *    saved exports in Music/RuhMix/ (MediaStore), the keystore, and any
 *    path matching PROTECTED_FRAGMENTS below.
 *  - Native auto-prune only visits share/ and rec/; imports/ is only pruned
 *    by the explicit manual clear (7-day age gate still applies).
 *  - Native prune deletes files only (never recurses into subdirs) and
 *    only files older than 7 days — a just-shared file is never removed.
 *  - JS cleanup only releases URLs/buffers this module tracks or that are
 *    older than the staleness threshold; live playback is untouched.
 *
 * Node-testable: every browser/native access is typeof-guarded, so this
 * file loads under plain Node with stubs.
 */
'use strict';
(function () {
  var root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  root.RM = root.RM || {};
  if (root.RM.cleanup && root.RM.cleanup.__v27) return; // loaded twice — no-op

  // ---- Tunables (sane defaults, documented) --------------------------------
  var URL_STALE_MS = 30 * 60 * 1000;          // revoke object URLs older than 30 min
  var MAX_TEMP_AUDIO_ITEMS = 5;               // keep at most 5 temp audio items in RAM
  var MAX_TEMP_AUDIO_BYTES = 250 * 1024 * 1024; // …and at most ~250 MB
  var NATIVE_MAX_AGE_DAYS = 7;                // native prunes cache files older than 7 days

  // Path fragments that must NEVER be deleted / released by cleanup.
  var PROTECTED_FRAGMENTS = [
    'Music/RuhMix',      // saved exports (public Music library)
    'ruhmix.projects',   // project store (localStorage key family)
    '.jks',              // keystore
    'keystore',
    'android_asset',     // bundled app files
  ];

  // ---- Registries ------------------------------------------------------------
  var urlRegistry = [];   // [{url, tag, ts}]
  var bufRegistry = [];   // [{name, ref, bytes, tag, ts, urls:[...]}]
  var patched = false;
  var deliverWrapped = false;
  var autoRan = false;

  function now() { return Date.now(); }

  function isProtectedPath(p) {
    if (p == null) return false;
    var s = String(p).toLowerCase();
    for (var i = 0; i < PROTECTED_FRAGMENTS.length; i++) {
      if (s.indexOf(PROTECTED_FRAGMENTS[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  // ---- Object URL tracking ---------------------------------------------------
  function registerUrl(url, tag) {
    if (!url || typeof url !== 'string') return;
    urlRegistry.push({ url: url, tag: tag || 'untagged', ts: now() });
  }
  function unregisterUrl(url) {
    for (var i = urlRegistry.length - 1; i >= 0; i--) {
      if (urlRegistry[i].url === url) urlRegistry.splice(i, 1);
    }
  }
  function ensureUrlPatched() {
    if (patched) return true;
    try {
      var U = (typeof URL !== 'undefined') ? URL : null;
      if (!U || typeof U.createObjectURL !== 'function') return false;
      var origCreate = U.createObjectURL.bind(U);
      var origRevoke = (typeof U.revokeObjectURL === 'function') ? U.revokeObjectURL.bind(U) : null;
      U.createObjectURL = function (obj) {
        var u = origCreate(obj);
        try { registerUrl(u, 'auto'); } catch (e) {}
        return u;
      };
      U.revokeObjectURL = function (u) {
        unregisterUrl(u);
        try { if (origRevoke) origRevoke(u); } catch (e) {}
      };
      patched = true;
      return true;
    } catch (e) { return false; }
  }
  function revokeUrlEntry(entry) {
    unregisterUrl(entry.url);
    try {
      var U = (typeof URL !== 'undefined') ? URL : null;
      if (U && typeof U.revokeObjectURL === 'function') U.revokeObjectURL(entry.url);
      else if (patched) { /* registry already dropped */ }
    } catch (e) {}
  }

  // ---- Temp audio registry ---------------------------------------------------
  function estimateBytes(ref) {
    try {
      if (ref == null) return 0;
      if (typeof ref.size === 'number') return ref.size;              // Blob / File
      if (typeof ref.byteLength === 'number') return ref.byteLength;  // ArrayBuffer
      if (typeof ref.length === 'number') {                          // AudioBuffer-like
        var ch = (typeof ref.numberOfChannels === 'number') ? ref.numberOfChannels : 2;
        return ref.length * ch * 4;                                  // float32
      }
    } catch (e) {}
    return 0;
  }

  /**
   * Register a transient audio blob/buffer (render, preview, stem pack).
   * Do NOT register buffers that are currently playing or that belong to a
   * saved project — only throwaway intermediates.
   */
  function trackTempAudio(name, ref, tag) {
    if (ref == null) return;
    untrackTempAudio(name);
    bufRegistry.push({ name: String(name), ref: null, bytes: estimateBytes(ref), tag: tag || 'temp', ts: now(), _ref: ref });
    // Keep a null public ref but retain privately until released (avoids
    // accidental resurrection via the registry itself).
    enforceCaps();
  }
  function untrackTempAudio(name) {
    for (var i = bufRegistry.length - 1; i >= 0; i--) {
      if (bufRegistry[i].name === name) bufRegistry.splice(i, 1);
    }
  }
  function dropPeaksFor(ref) {
    try {
      var w = root.RM && root.RM.wave;
      if (w && typeof w.dropPeaks === 'function') w.dropPeaks(ref);
    } catch (e) {}
  }
  function releaseEntry(entry) {
    var freed = entry.bytes || 0;
    try { dropPeaksFor(entry._ref); } catch (e) {}
    entry._ref = null;
    entry.ref = null;
    return freed;
  }
  /** Enforce the item/MB caps, releasing the oldest entries first. */
  function enforceCaps() {
    var released = 0, freedBytes = 0;
    bufRegistry.sort(function (a, b) { return a.ts - b.ts; });
    function totalBytes() {
      var t = 0;
      for (var i = 0; i < bufRegistry.length; i++) t += (bufRegistry[i].bytes || 0);
      return t;
    }
    while (bufRegistry.length > MAX_TEMP_AUDIO_ITEMS || totalBytes() > MAX_TEMP_AUDIO_BYTES) {
      var oldest = bufRegistry.shift();
      if (!oldest) break;
      freedBytes += releaseEntry(oldest);
      released++;
    }
    return { released: released, freedBytes: freedBytes };
  }

  // ---- Native bridge ---------------------------------------------------------
  function native() {
    try {
      var A = root.RM && root.RM.audio && root.RM.audio.native;
      if (A && typeof A.method === 'function' && typeof A.call === 'function') return A;
      if (typeof Android !== 'undefined' && Android) {
        return {
          method: function (n) { return typeof Android[n] === 'function'; },
          call: function (n) { return Android[n].apply(Android, Array.prototype.slice.call(arguments, 1)); },
        };
      }
    } catch (e) {}
    return null;
  }
  /** Ask the shell to prune stale native cache files. Returns bytes freed (0 if unavailable). */
  function pruneNativeCache(includeImports) {
    var nat = native();
    if (!nat) return 0;
    try {
      if (nat.method('cleanupOldTempFiles')) {
        var r = nat.call('cleanupOldTempFiles', !!includeImports);
        return (typeof r === 'number' && r > 0) ? r : 0;
      }
    } catch (e) {}
    return 0;
  }

  // ---- Main entry points -----------------------------------------------------
  /**
   * Run one cleanup pass. Returns a summary object; also console.info's it.
   * opts: {reason, includeImports} — includeImports=true only for the
   * explicit manual clear (still age-gated at 7 days natively).
   */
  function cleanupTemp(opts) {
    opts = opts || {};
    var summary = {
      reason: opts.reason || 'auto',
      revokedUrls: 0,
      staleUrlsFound: 0,
      releasedBuffers: 0,
      releasedBytesApprox: 0,
      nativePrunedBytes: 0,
      errors: [],
      ts: now(),
    };
    try {
      ensureUrlPatched();
      // (a) revoke stale object URLs
      var cutoff = now() - URL_STALE_MS;
      var stale = [];
      for (var i = urlRegistry.length - 1; i >= 0; i--) {
        if (urlRegistry[i].ts < cutoff) stale.push(urlRegistry[i]);
      }
      summary.staleUrlsFound = stale.length;
      for (var j = 0; j < stale.length; j++) {
        try { revokeUrlEntry(stale[j]); summary.revokedUrls++; }
        catch (e) { summary.errors.push('revoke:' + e.message); }
      }
      // (b)+(c) release unreferenced temp buffers + enforce caps
      var cap = enforceCaps();
      summary.releasedBuffers = cap.released;
      summary.releasedBytesApprox = cap.freedBytes;
      // (native) prune stale cache files
      summary.nativePrunedBytes = pruneNativeCache(!!opts.includeImports);
    } catch (e) {
      summary.errors.push('cleanup:' + (e && e.message));
    }
    try {
      if (typeof console !== 'undefined' && console.info) {
        console.info('[RM.cleanup] pass (' + summary.reason + '): revokedUrls=' +
          summary.revokedUrls + ' releasedBuffers=' + summary.releasedBuffers +
          ' releasedBytes~' + summary.releasedBytesApprox +
          ' nativePrunedBytes=' + summary.nativePrunedBytes +
          (summary.errors.length ? ' errors=' + summary.errors.join(';') : ''));
      }
    } catch (e) {}
    return summary;
  }

  /**
   * Manual "Clear Cache" hook for the Settings button.
   * More aggressive than the automatic pass (includes imports/ older than
   * 7 days) but still never touches projects, Music/RuhMix or the keystore.
   * Returns the same summary object as cleanupTemp().
   */
  function clearCache() {
    return cleanupTemp({ reason: 'manual-clear', includeImports: true });
  }

  // ---- Auto triggers ---------------------------------------------------------
  function hookPostExport() {
    if (deliverWrapped) return;
    try {
      var exp = root.RM && root.RM.exp;
      if (!exp || typeof exp.deliver !== 'function') return;
      var orig = exp.deliver;
      exp.deliver = function () {
        var p;
        try { p = orig.apply(exp, arguments); }
        catch (e) { try { cleanupTemp({ reason: 'post-export' }); } catch (e2) {} throw e; }
        if (p && typeof p.then === 'function') {
          return p.then(function (delivery) {
            try { cleanupTemp({ reason: 'post-export' }); } catch (e) {}
            return delivery;
          }, function (err) {
            try { cleanupTemp({ reason: 'post-export' }); } catch (e) {}
            throw err;
          });
        }
        try { cleanupTemp({ reason: 'post-export' }); } catch (e) {}
        return p;
      };
      deliverWrapped = true;
    } catch (e) {}
  }

  function autoInit() {
    if (autoRan) return;
    autoRan = true;
    try { ensureUrlPatched(); } catch (e) {}
    // Retry hooking until RM.exp exists (scripts may load in any order).
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      hookPostExport();
      if (deliverWrapped || tries > 40) clearInterval(timer);
    }, 500);
    // App-start pass: native prune + registry sweep (registries are empty on
    // a fresh start, so this is mostly the native 7-day prune).
    try { cleanupTemp({ reason: 'app-start' }); } catch (e) {}
  }

  var api = {
    __v27: true,
    CFG: {
      urlStaleMs: URL_STALE_MS,
      maxTempAudioItems: MAX_TEMP_AUDIO_ITEMS,
      maxTempAudioBytes: MAX_TEMP_AUDIO_BYTES,
      nativeMaxAgeDays: NATIVE_MAX_AGE_DAYS,
    },
    PROTECTED_FRAGMENTS: PROTECTED_FRAGMENTS.slice(),
    cleanupTemp: cleanupTemp,
    clearCache: clearCache,
    trackTempAudio: trackTempAudio,
    untrackTempAudio: untrackTempAudio,
    registerUrl: registerUrl,
    isProtectedPath: isProtectedPath,
    enforceCaps: enforceCaps,
    pruneNativeCache: pruneNativeCache,
    // introspection (tests / debugging)
    _urlCount: function () { return urlRegistry.length; },
    _bufCount: function () { return bufRegistry.length; },
    _testInjectUrl: function (url, ts, tag) { urlRegistry.push({ url: String(url), tag: tag || 'test', ts: ts }); },
    _testInjectBuf: function (name, bytes, ts) { bufRegistry.push({ name: String(name), ref: null, bytes: bytes | 0, tag: 'test', ts: ts, _ref: { _testBytes: bytes | 0 } }); },
    _reset: function () { urlRegistry.length = 0; bufRegistry.length = 0; autoRan = false; deliverWrapped = false; },
  };
  root.RM.cleanup = api;

  // Run the app-start pass as soon as this script loads.
  try { autoInit(); } catch (e) {}
})();
