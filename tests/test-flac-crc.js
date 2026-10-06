#!/usr/bin/env node
/*
 * RuhMix FLAC encoder verification (pure node, no browser).
 *
 * Regression test for the frame-footer CRC-16 bug (fixed 2026-10-06):
 * the footer CRC covered only the subframes, but RFC 9639 §9.3 requires
 * it to cover the WHOLE frame including the sync code — every frame
 * failed strict decoders' CRC check (33/33 mismatched before the fix).
 *
 * Checks:
 *  A) bitstream parse: every frame's header CRC-8 (RFC 9.2) and frame
 *     CRC-16 over [sync .. padding] (RFC 9.3) must verify;
 *  B) STREAMINFO MD5 must match the encoded PCM samples;
 *  C) if ffmpeg is available: decode round-trip must be bit-exact
 *     (lossless proof), skipped gracefully otherwise.
 *
 * Exit 0 = all pass.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPORT_JS = path.join(__dirname, '..', 'www', 'js', 'export.js');

let pass = 0, fail = 0;
function ok(name, detail) { pass++; console.log('PASS', name, detail ? ' — ' + detail : ''); }
function no(name, detail) { fail++; console.log('FAIL', name, detail ? ' — ' + detail : ''); }

function loadExp() {
  global.window = global; // browser-like: window.RM === RM
  const src = fs.readFileSync(EXPORT_JS, 'utf8');
  new Function('window', src)(global);
  return global.RM.exp;
}

/* ---------- CRC tables (RFC 9639 polynomials) ---------- */
const CRC8_T = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8_T[i] = c;
}
const crc8 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8_T[(c ^ b[i]) & 0xff]; return c; };
function crc16(b, s, e) {
  let c = 0;
  for (let i = s; i < e; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

function BitReader(bytes) {
  let bit = 0;
  const self = {
    bits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) { v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
      return v >>> 0;
    },
    unary() {
      let q = 0;
      for (;;) { if (self.bits(1)) return q; if (++q > 1e7) throw new Error('unary runaway'); }
    },
    utf8num() {
      const b0 = self.bits(8);
      if (b0 < 0x80) return b0;
      let nbytes = 0;
      for (let i = 7; i >= 0; i--) { if (b0 & (1 << i)) nbytes++; else break; }
      let v = b0 & ((1 << (8 - nbytes - 1)) - 1);
      for (let i = 1; i < nbytes; i++) v = (v << 6) | (self.bits(8) & 0x3f);
      return v;
    },
    align() { const r = bit & 7; if (r) bit += 8 - r; },
    bytePos() { return bit >> 3; },
  };
  return self;
}

/* Parse frames; verify header CRC-8 + frame CRC-16. Returns {frames, hdrFails, crcFails, md5}. */
/* (implementation: parseAndVerify, below) */

async function main() {
  const exp = loadExp();

  // 3 s stereo: sines + a transient click train (exercises fixed/verbatim paths).
  const SR = 44100, len = SR * 3;
  const left = new Int16Array(len), right = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const click = (i % 4410) < 8 ? 1 : 0;
    left[i] = Math.round(16000 * Math.sin(2 * Math.PI * 440 * i / SR)) + (click ? 12000 : 0);
    right[i] = Math.round(16000 * Math.sin(2 * Math.PI * 554 * i / SR)) - (click ? 8000 : 0);
  }

  const blob = await exp.encodeFlac({ left, right }, SR);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  ok('flac encoded', bytes.length + ' bytes');

  /* ---- A) frame parse + CRC verification ---- */
  const res = parseAndVerify(bytes);
  ok('frame header CRC-8', res.frames + ' frames, ' + res.hdrFails + ' failures');
  if (res.hdrFails) no('frame header CRC-8 clean', res.hdrFails + ' failures');
  if (res.crcFails) no('frame CRC-16 (RFC 9639 9.3)', res.crcFails + '/' + res.frames + ' frames mismatched');
  else ok('frame CRC-16 (RFC 9639 9.3)', res.frames + ' frames verify');

  /* ---- B) STREAMINFO MD5 matches source PCM ---- */
  const md5 = md5OfInt16(left, right);
  const match = md5.length === res.md5.length && md5.every((v, i) => v === res.md5[i]);
  if (match) ok('streaminfo MD5 matches PCM', '');
  else no('streaminfo MD5 matches PCM', 'mismatch');

  /* ---- C) ffmpeg round-trip bit-exactness (if available) ---- */
  let haveFfmpeg = true;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { haveFfmpeg = false; }
  if (!haveFfmpeg) {
    console.log('SKIP ffmpeg round-trip — ffmpeg not installed');
  } else {
    const tmp = '/tmp/ruhmix-flac-test.flac';
    fs.writeFileSync(tmp, Buffer.from(bytes));
    try {
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
      const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let diff = 0;
      const n = Math.min(len, pcm.byteLength / 4);
      for (let i = 0; i < n; i++) {
        if (dv.getInt16(i * 4, true) !== left[i]) diff++;
        if (dv.getInt16(i * 4 + 2, true) !== right[i]) diff++;
      }
      if (pcm.byteLength === len * 4 && diff === 0) ok('ffmpeg round-trip bit-exact', len + ' samples/ch');
      else no('ffmpeg round-trip bit-exact', `bytes=${pcm.byteLength} expect=${len * 4}, diffs=${diff}`);
    } catch (e) {
      no('ffmpeg round-trip', 'ffmpeg decode failed: ' + String(e.message).slice(0, 200));
    }
    try { fs.unlinkSync(tmp); } catch (e) {}
  }

  console.log(`\n==== FLAC: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
}

/* Full frame parser mirroring the encoder's layout. */
function parseAndVerify(b) {
  const r = BitReader(b);
  r.bits(32); // 'fLaC'
  const last = r.bits(1), type = r.bits(7), mlen = r.bits(24);
  if (type !== 0 || mlen !== 34) throw new Error('bad STREAMINFO');
  const si = new Uint8Array(34);
  for (let i = 0; i < 34; i++) si[i] = r.bits(8);
  const md5 = si.slice(18, 34);
  let frames = 0, hdrFails = 0, crcFails = 0;
  while (r.bytePos() < b.length) {
    const fstart = r.bytePos();
    if (r.bits(15) !== 0x7FFC) throw new Error('bad sync at frame ' + frames + ' (byte ' + fstart + ')');
    r.bits(1); // blocking strategy
    const bsizeCode = r.bits(4);
    r.bits(4); // sample rate
    const chCode = r.bits(4); // channel assignment
    r.bits(3); // sample size
    r.bits(1); // reserved
    r.utf8num(); // frame/sample number
    let n;
    if (bsizeCode === 6) n = r.bits(8) + 1;
    else if (bsizeCode === 7) n = r.bits(16) + 1;
    else throw new Error('unexpected blocksize code ' + bsizeCode + ' at frame ' + frames);
    const hdrCrcPos = r.bytePos();
    const hdrCrc = r.bits(8);
    if (hdrCrc !== crc8(b, fstart, hdrCrcPos)) hdrFails++;
    const nCh = chCode === 1 ? 2 : 1;
    for (let c = 0; c < nCh; c++) {
      if (r.bits(1) !== 0) throw new Error('bad subframe pad');
      const stype = r.bits(6);
      if (r.bits(1) !== 0) throw new Error('wasted-bits flag set');
      if (stype === 1) {
        for (let i = 0; i < n; i++) r.bits(16); // verbatim
      } else if (stype >= 8 && stype <= 12) {
        const order = stype - 8;
        for (let i = 0; i < order; i++) r.bits(16); // warmup
        if (r.bits(2) !== 0) throw new Error('bad rice method');
        const po = r.bits(4);
        const psize = n >> po, nPart = 1 << po;
        for (let p = 0; p < nPart; p++) {
          const s0 = p === 0 ? 0 : p * psize - order;
          const s1 = p === 0 ? psize - order : (p + 1) * psize - order;
          const cnt = s1 - s0;
          const param = r.bits(4);
          if (param === 15) {
            const bps = r.bits(5);
            for (let i = 0; i < cnt; i++) r.bits(bps);
          } else {
            for (let i = 0; i < cnt; i++) { r.unary(); r.bits(param); }
          }
        }
      } else throw new Error('bad subframe type ' + stype + ' at frame ' + frames);
    }
    r.align();
    const crcPos = r.bytePos();
    const got = (r.bits(8) << 8) | r.bits(8);
    // RFC 9639 §9.3: whole frame incl. sync, excl. the CRC itself.
    if (got !== crc16(b, fstart, crcPos)) crcFails++;
    frames++;
  }
  return { frames, hdrFails, crcFails, md5 };
}

/* MD5 over interleaved LE int16 (RFC 9639 §8.2) — compact implementation. */
function md5OfInt16(left, right) {
  const n = left.length;
  const bytes = new Uint8Array(n * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    dv.setInt16(i * 4, left[i], true);
    dv.setInt16(i * 4 + 2, right[i], true);
  }
  return md5(bytes);
}
function md5(bytes) {
  const s = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
             5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
             4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
             6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const rotl = (x, nn) => ((x << nn) | (x >>> (32 - nn))) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const len = bytes.length;
  const withOne = len + 1, padZeros = (56 - (withOne % 64) + 64) % 64, total = withOne + padZeros + 8;
  const bb = new Uint8Array(total);
  bb.set(bytes); bb[len] = 0x80;
  const dv = new DataView(bb.buffer);
  dv.setUint32(total - 8, (len * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor((len * 8) / 4294967296), true);
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, s[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return out;
}

main().catch((e) => { console.error('FATAL', e && e.message); process.exit(2); });
