'use strict';
/* =====================================================================
   RuhMix — v25-projects.js  (W6 §20: mashup project system)
   Module: RM.v25projects

   Extends the EXISTING project system (RM.proj in projects.js — storage,
   serialize/deserialize, autosave, crash recovery all reused, untouched).
   Mashup data lives in `project.settings.mashup`, which survives
   RM.proj.serialize (settings passes through) and deserialize
   (Object.assign keeps extra keys), and is invisible to snapshotLive/
   restoreLive (they only touch fx/slowed/mastering/remix keys).

   Saved mashup fields (§20):
     arrangementPlan, bpm, key, stemsRefs, fx, transitions, automation,
     w3 ({settings, preset}), mastering, audioRef, qcReport, exportInfo.

   Honest limits (documented, not hidden):
     - Audio BYTES are never stored (localStorage is far too small).
       stemsRefs/audioRef are file references {name, size, type,
       lastModified[, role]} so the app can re-attach the same files.
     - "Export again" / "Continue editing" re-render from the saved plan;
       they need the audio files available again.

   API:
     RM.v25projects.saveMashup(data) -> id
       data = {id?, name, arrangementPlan, bpm, key, stemsRefs, fx,
               transitions, automation, w3, mastering, audioRef,
               qcReport, exportInfo, note}
       Creates a new project or updates the existing id.
     RM.v25projects.listMashups() -> [{id, name, updatedAt, bpm, key,
       songCount, hasQc, lastExport}]
     RM.v25projects.get(id) -> {project, mashup} | null
     RM.v25projects.isMashup(p) -> bool          (row rendering helper)
     RM.v25projects.rename(id, name) -> bool      (stored settings preserved)
     RM.v25projects.duplicate(id) -> newId | null (stored settings preserved)
     RM.v25projects.delete(id) -> bool            (reuses RM.proj.remove)
     RM.v25projects.continueEditing(id) -> {project, mashup, liveRestored} | null
       Restores fx/slowed/mastering/remix into RM.app.state via
       RM.proj.restoreLive and points RM.app.state.project at the project.
     RM.v25projects.exportAgain(id) -> {project, mashup} | null
       Returns the saved plan so the caller can re-render the mix and
       hand it to RM.v25exportui.show({buffer, meta, name}).
   ===================================================================== */
window.RM = window.RM || {};

RM.v25projects = (function () {
  var FIELDS = ['arrangementPlan', 'bpm', 'key', 'stemsRefs', 'fx',
    'transitions', 'automation', 'w3', 'mastering', 'audioRef',
    'qcReport', 'exportInfo', 'note'];

  function uid() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function needProj() {
    if (!window.RM || !RM.proj) throw new Error('RM.proj (projects.js) not loaded.');
    return RM.proj;
  }
  function blankMashup() {
    return {
      kind: 'mashup', savedAt: 0,
      arrangementPlan: null, bpm: null, key: null,
      stemsRefs: [], fx: null, transitions: [], automation: [],
      w3: null, mastering: null, audioRef: null,
      qcReport: null, exportInfo: null, note: '',
    };
  }
  function mashupOf(p) {
    return (p && p.settings && p.settings.mashup && p.settings.mashup.kind === 'mashup')
      ? p.settings.mashup : null;
  }
  function songCountOf(m) {
    if (!m) return 0;
    var ap = m.arrangementPlan;
    if (ap && typeof ap.songs === 'number') return ap.songs;
    if (Array.isArray(m.stemsRefs) && m.stemsRefs.length) {
      var names = {};
      m.stemsRefs.forEach(function (s) { if (s && s.name) names[s.name] = 1; });
      return Object.keys(names).length;
    }
    return 0;
  }

  function isMashup(p) { return !!mashupOf(p); }

  // P.save() snapshots the LIVE editor state (fx/slowed/mastering/remix)
  // into settings — correct when saving the open project, but WRONG for
  // rename/duplicate, which operate on a non-live library entry: a blind
  // P.save would clobber that entry's stored settings with whatever the
  // editor happens to hold right now. Neutralize the live snapshot for
  // this one save (synchronous — state is restored before we return).
  function saveKeepSettings(p) {
    var P = needProj();
    var app = (window.RM && RM.app) || null;
    var st = app && app.state;
    var hold = null;
    if (st) {
      hold = { fx: st.fx, slowed: st.slowed, mastering: st.mastering, remix: st.remix };
      st.fx = null; st.slowed = null; st.mastering = null; st.remix = null;
    }
    try {
      P.save(p);
    } finally {
      if (st && hold) {
        st.fx = hold.fx; st.slowed = hold.slowed;
        st.mastering = hold.mastering; st.remix = hold.remix;
      }
    }
  }

  function saveMashup(data) {
    var P = needProj();
    data = data || {};
    var p = data.id ? P.get(data.id) : null;
    if (!p) p = P.create(data.name || 'Mashup Project');
    else if (data.name) p.name = String(data.name).slice(0, 60);
    p.settings = p.settings || {};
    var m = mashupOf(p) || blankMashup();
    FIELDS.forEach(function (k) {
      if (data[k] !== undefined) {
        try { m[k] = JSON.parse(JSON.stringify(data[k])); }
        catch (e) { m[k] = data[k]; }
      }
    });
    m.kind = 'mashup';
    m.savedAt = Date.now();
    p.settings.mashup = m;
    if (data.audioRef !== undefined) p.audioRef = data.audioRef;
    P.save(p); // reuse: updatedAt, snapshotLive, persist, autosave
    return p.id;
  }

  function summary(p) {
    var m = mashupOf(p);
    return {
      id: p.id, name: p.name, updatedAt: p.updatedAt,
      bpm: m.bpm, key: m.key, songCount: songCountOf(m),
      hasQc: !!(m.qcReport && m.qcReport.summary),
      lastExport: (m.exportInfo && m.exportInfo.fileName) || null,
    };
  }

  function listMashups() {
    var P = needProj();
    return P.list().filter(function (p) { return !!mashupOf(p); }).map(summary);
  }

  function get(id) {
    var P = needProj();
    var p = P.get(id);
    var m = mashupOf(p);
    return m ? { project: p, mashup: m } : null;
  }

  function rename(id, name) {
    var P = needProj();
    var p = P.get(id);
    if (!p || !mashupOf(p)) return false;
    p.name = String(name || p.name).slice(0, 60);
    saveKeepSettings(p); // don't let the live editor state leak into this entry
    return true;
  }

  function duplicate(id) {
    var P = needProj();
    var p = P.get(id);
    if (!p || !mashupOf(p)) return null;
    var copy;
    try { copy = JSON.parse(JSON.stringify(p)); } catch (e) { return null; }
    copy.id = uid();
    copy.name = (p.name || 'Mashup Project') + ' (copy)';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    if (copy.settings && copy.settings.mashup) copy.settings.mashup.savedAt = Date.now();
    saveKeepSettings(copy); // the copy keeps the ORIGINAL's stored settings
    return copy.id;
  }

  function del(id) {
    var P = needProj();
    var p = P.get(id);
    if (!p || !mashupOf(p)) return false;
    P.remove(id); // reuse: also clears autosave + dangling open reference
    return true;
  }

  // Point the live app at this project and restore its studio state.
  function continueEditing(id) {
    var P = needProj();
    var got = get(id);
    if (!got) return null;
    var liveRestored = null;
    try { liveRestored = P.restoreLive(got.project); } catch (e) { liveRestored = null; }
    try {
      var A = window.RM && RM.app;
      if (A && A.state) A.state.project = got.project;
    } catch (e) {}
    return { project: got.project, mashup: got.mashup, liveRestored: liveRestored };
  }

  // Re-export: hand the saved plan back; the caller re-renders the mix
  // (audio bytes are not stored) and shows RM.v25exportui.
  function exportAgain(id) {
    var got = get(id);
    if (!got) return null;
    return { project: got.project, mashup: got.mashup };
  }

  return {
    saveMashup: saveMashup,
    listMashups: listMashups,
    get: get,
    isMashup: isMashup,
    rename: rename,
    duplicate: duplicate,
    delete: del,
    continueEditing: continueEditing,
    exportAgain: exportAgain,
    FIELDS: FIELDS,
  };
})();
