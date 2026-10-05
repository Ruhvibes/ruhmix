'use strict';
/* =====================================================================
   RuhMix — recent.js
   Recent files quick access (Home screen).
   A quick-open list of recently imported/opened audio files, persisted in
   localStorage. This is NOT the projects system: recent = quick access to
   source files, projects = saved editing work. They never mix.
   ===================================================================== */
window.RM = window.RM || {};

(function () {
  var RM = window.RM;
  function A() { return RM.app || null; }
  function $(id) { return document.getElementById(id); }

  var KEY = 'ruhmix.recentFiles';
  var MAX = 8;

  // Re-open race guard: double-tap on a row must not fire two decodes.
  var opening = {};

  function valid(e) {
    return e && typeof e.name === 'string' && typeof e.url === 'string' && e.url;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(valid).slice(0, MAX) : [];
    } catch (e) { return []; }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); }
    catch (e) { /* storage full/blocked: list just won't persist */ }
  }

  /* Add (or bump to top) an entry. Only files with a cached path can be
     re-opened later, so entries without a url are skipped. */
  function track(name, url, duration, size) {
    if (!url) return;
    var list = load().filter(function (e) { return e.url !== String(url); });
    list.unshift({
      name: String(name || 'audio'),
      url: String(url),
      duration: Number(duration) || 0,
      size: Number(size) || 0,
      at: Date.now(),
    });
    save(list);
    render();
  }

  function remove(url) {
    save(load().filter(function (e) { return e.url !== String(url); }));
    render();
  }

  function clear() {
    save([]);
    render();
  }

  function list() { return load(); }

  function render() {
    var box = $('recent-files');
    if (!box) return;
    var a = A();
    var clearBtn = $('recent-files-clear');
    var entries = load();
    box.innerHTML = '';
    if (clearBtn) clearBtn.style.display = entries.length ? '' : 'none';
    if (!entries.length) {
      box.innerHTML = '<div class="empty"><div class="empty-icon">🕘</div>' +
        '<div>No recent files yet — pick a song to get started</div></div>';
      return;
    }
    entries.forEach(function (e) {
      var b = document.createElement('button');
      b.className = 'recent-row recent-file';
      b.setAttribute('data-url', e.url);
      var dur = (a && a.fmtTime) ? a.fmtTime(e.duration) : '—';
      var nm = (a && a.escapeHtml) ? a.escapeHtml(e.name) : String(e.name);
      b.innerHTML = '<span class="rf-play">▶</span>' +
        '<span class="rf-main"><span class="rf-name">' + nm + '</span>' +
        '<span class="rf-meta muted">' + dur + '</span></span>';
      b.addEventListener('click', function () { open(e, b); });
      box.appendChild(b);
    });
  }

  /* Re-open a recent file straight into the Editor — no picker.
     Cached file gone (user deleted it, cache cleared) -> graceful
     English message + the stale entry is dropped. */
  function open(entry, rowEl) {
    var a = A();
    if (!a) return;
    if (opening[entry.url]) return;
    opening[entry.url] = true;
    if (rowEl) rowEl.classList.add('busy');
    if (a.toast) a.toast('Loading: ' + entry.name);
    var done = function () {
      delete opening[entry.url];
      if (rowEl) rowEl.classList.remove('busy');
    };
    var onMissing = function () {
      done();
      remove(entry.url); // stale entry hatao
      if (a.toast) a.toast('File no longer available', 3500);
    };
    try {
      a.fetchFileUrl(entry.url).then(function (ab) {
        var bytes = ab ? ab.byteLength : 0;
        if (!bytes) { onMissing(); return null; }
        return a.decodeAndAdd(ab, entry.name, bytes, entry.url);
      }).then(function (buf) {
        done();
        if (!buf) return; // decode failed: decodeAndAdd already told the user
        a.loadAudioBuffer(buf, entry.name, {
          name: entry.name, size: entry.size || 0, type: '', lastModified: Date.now(),
        });
        a.show('editor');
      }).catch(function () { onMissing(); });
    } catch (e) { onMissing(); }
  }

  function init() {
    var cb = $('recent-files-clear');
    if (cb && !cb._recentWired) {
      cb._recentWired = true;
      cb.addEventListener('click', function (ev) {
        ev.stopPropagation();
        clear();
        var a = A();
        if (a && a.toast) a.toast('Recent files cleared');
      });
    }
    render();
  }

  RM.recent = {
    init: init,
    render: render,
    track: track,
    remove: remove,
    clear: clear,
    list: list,
  };
})();
