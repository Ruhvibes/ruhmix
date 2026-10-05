'use strict';
/* =====================================================================
   RuhMix — import-hardening.js
   Pure, dependency-free audio-import helpers used by the hardened decode
   pipeline in js/app.js.

   - No DOM access at load (safe before document is ready).
   - Node-requireable: `const RH = require('./import-hardening.js')`.
   Browser: exposed as window.RH.
   ===================================================================== */
(function () {

  var MAX_IMPORT_BYTES = 150 * 1024 * 1024; // 150 MB decode ceiling
  var FRAME_SCAN_BYTES = 64 * 1024;         // first-64KB MP3 frame hunt

  function toU8(ab) {
    if (ab instanceof Uint8Array) return ab;
    if (typeof ArrayBuffer !== 'undefined' && ab instanceof ArrayBuffer) return new Uint8Array(ab);
    if (ab && ab.buffer instanceof ArrayBuffer) {
      return new Uint8Array(ab.buffer, ab.byteOffset || 0, ab.byteLength);
    }
    return new Uint8Array(0);
  }

  function isId3v2(u8) {
    return u8.length >= 3 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33; // 'ID3'
  }

  /* Byte offset where an ID3v2 tag ends (header 10 + synchsafe payload size),
     or 0 when no valid ID3v2 header is present. */
  function id3v2End(u8) {
    if (u8.length < 10 || !isId3v2(u8)) return 0;
    var size = 0;
    for (var i = 6; i < 10; i++) {
      if (u8[i] & 0x80) return 0; // not a synchsafe integer -> not a real tag
      size = (size << 7) | u8[i];
    }
    var end = 10 + size;
    if (size <= 0 || end >= u8.length) return 0;
    return end;
  }

  /* Magic-byte sniffing. Returns 'mp3' | 'wav' | 'm4a' | 'flac' | 'unknown'. */
  function sniffAudioType(ab) {
    var u8 = toU8(ab);
    var n = u8.length;
    if (n >= 3 && isId3v2(u8)) return 'mp3';                        // ID3v2 tag
    if (n >= 2 && u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0) return 'mp3'; // 0xFFE0 frame sync
    if (n >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && // 'RIFF'
        u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45) return 'wav'; // 'WAVE'
    if (n >= 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return 'm4a'; // '....ftyp'
    if (n >= 4 && u8[0] === 0x66 && u8[1] === 0x4C && u8[2] === 0x61 && u8[3] === 0x43) return 'flac'; // 'fLaC'
    return 'unknown';
  }

  /* Skip a leading ID3v2 header, returning a fresh ArrayBuffer. The original
     buffer is returned untouched when no valid ID3v2 header is found. */
  function stripId3v2(ab) {
    var u8 = toU8(ab);
    var end = id3v2End(u8);
    if (!end) return ab;
    var cut = new Uint8Array(u8.slice(end)); // copy -> exact-length buffer (Node Buffer.slice shares a pooled buffer)
    return cut.buffer;
  }

  /* Offset of the first MP3 frame sync (0xFFE?) after any ID3v2 header,
     scanning the first 64 KB. Returns -1 when no sync is found. */
  function findFirstMp3Frame(ab) {
    var u8 = toU8(ab);
    var start = id3v2End(u8);
    var end = Math.min(u8.length - 1, start + FRAME_SCAN_BYTES);
    for (var i = start; i < end; i++) {
      if (u8[i] === 0xFF && (u8[i + 1] & 0xE0) === 0xE0) return i;
    }
    return -1;
  }

  /* Cheap pre-decode sanity gate. Never throws. */
  function precheckAudio(ab, name) {
    var len = 0;
    try { len = ab ? (ab.byteLength != null ? ab.byteLength : toU8(ab).length) : 0; }
    catch (e) { len = 0; }
    if (!ab || len < 100) {
      return { ok: false, kind: 'empty', detail: String(len) + ' bytes' };
    }
    if (len > MAX_IMPORT_BYTES) {
      return { ok: false, kind: 'too-large', detail: (len / 1048576).toFixed(1) + ' MB (limit 150 MB)' };
    }
    var t = sniffAudioType(ab);
    if (t === 'unknown') {
      return { ok: false, kind: 'unsupported-type', detail: 'magic bytes not recognised; supported: MP3, WAV, M4A, FLAC' };
    }
    return { ok: true };
  }

  /* Professional English user-facing error copy for each failure kind. */
  function classifyError(kind, name) {
    var n = String(name == null || name === '' ? 'file' : name);
    switch (String(kind)) {
      case 'unreadable':
        return {
          title: 'Could not read the file',
          msg: 'Could not read the file "' + n + '". It may have been moved, deleted, or blocked. Please try again or choose another file.'
        };
      case 'empty':
        return {
          title: 'Empty file',
          msg: 'The file "' + n + '" is empty and contains no audio. Please choose a valid audio file.'
        };
      case 'too-large':
        return {
          title: 'File too large',
          msg: 'The file "' + n + '" is too large to decode on this device (over 150 MB). Please use a smaller file.'
        };
      case 'unsupported-type':
        return {
          title: 'Unsupported file type',
          msg: 'The file "' + n + '" does not look like a supported audio file. Supported formats: MP3, WAV, M4A, FLAC.'
        };
      case 'corrupt':
      default:
        return {
          title: 'Could not decode the audio',
          msg: 'The file "' + n + '" couldn\'t be decoded — it may be corrupted. Try another file.'
        };
    }
  }

  /* Documented decode-fallback order: direct -> ID3-stripped -> frame-sync slice. */
  function decodeStages() {
    return ['direct', 'strip-id3', 'frame-sync'];
  }

  var RH = {
    sniffAudioType: sniffAudioType,
    stripId3v2: stripId3v2,
    findFirstMp3Frame: findFirstMp3Frame,
    precheckAudio: precheckAudio,
    classifyError: classifyError,
    decodeStages: decodeStages,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES
  };

  if (typeof window !== 'undefined' && window) window.RH = RH;
  if (typeof module !== 'undefined' && module.exports) module.exports = RH;
})();
