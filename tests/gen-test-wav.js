#!/usr/bin/env node
/* Generate a small PCM WAV (sine sweep) for Puppeteer import tests. */
'use strict';
const fs = require('fs');
const path = process.argv[2] || '/tmp/recent-test-song.wav';
const secs = parseFloat(process.argv[3] || '3');
const sr = 44100;
const n = Math.floor(secs * sr);
const data = Buffer.alloc(44 + n * 4);
data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8);
data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28);
data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
data.write('data', 36); data.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) {
  const t = i / sr;
  const f = 220 + (440 * i) / n; // sweep 220 -> 660 Hz
  const s = Math.round(12000 * Math.sin(2 * Math.PI * f * t));
  data.writeInt16LE(s, 44 + i * 4);
  data.writeInt16LE(s, 44 + i * 4 + 2);
}
fs.writeFileSync(path, data);
console.log('wrote', path, secs + 's');
