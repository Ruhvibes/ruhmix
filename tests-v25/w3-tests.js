'use strict';
/* RuhMix v25 W3 tests — run: node tests-v25/w3-tests.js (from ~/workspace/ruhmix) */
global.window = {};
require('../www/js/v25-arrange.js');
var V = global.window.RM.v25arrange;

var pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function fakeBuf(sec, sr, fill) {
  sr = sr || 44100;
  var n = Math.round(sec * sr);
  var ch0 = new Float32Array(n), ch1 = new Float32Array(n);
  for (var i = 0; i < n; i++) { var v = fill(i / sr, i); ch0[i] = v; ch1[i] = v; }
  return { sampleRate: sr, length: n, numberOfChannels: 2,
           getChannelData: function (c) { return c === 0 ? ch0 : ch1; } };
}
function rms(d, a, b) {
  var s = 0, n = 0;
  for (var i = a; i < b && i < d.length; i++) { s += d[i] * d[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}
function centroid(d, sr) { // rough spectral brightness proxy: zero-crossing rate
  var zc = 0;
  for (var i = 1; i < d.length; i++) if ((d[i] >= 0) !== (d[i - 1] >= 0)) zc++;
  return zc / d.length * sr / 2;
}

var songs2 = [
  { name: 'Song A', bpm: 100, key: { key: 'A', mode: 'minor' }, energy: 0.8, bars: 64,
    energyBars: null },
  { name: 'Song B', bpm: 102, key: { key: 'C', mode: 'major' }, energy: 0.45, bars: 64 },
];
songs2[0].energyBars = Array.from({ length: 64 }, function (_, i) {
  var blk = Math.floor(i / 8);
  return i < 8 ? 0.25 : i >= 56 ? 0.2 : (blk % 2 === 0 ? 0.9 : 0.55);
});
var songs5 = [
  { name: 'S1', bpm: 100, key: 'A minor', energy: 0.9, bars: 64 },
  { name: 'S2', bpm: 98, key: 'C major', energy: 0.6, bars: 64 },
  { name: 'S3', bpm: 150, key: 'G major', energy: 0.75, bars: 64 },
  { name: 'S4', bpm: 95, key: 'F major', energy: 0.3, bars: 64 },
  { name: 'S5', bpm: 105, key: 'D minor', energy: 0.5, bars: 64 },
];

console.log('== arrangement adapts (2 vs 5 songs) ==');
var p2 = V.buildArrangement(songs2, { presetId: 'romantic', settings: { length: '3' } });
var p5 = V.buildArrangement(songs5, { presetId: 'edm', settings: { length: '3' } });
ok(p2.sections.length > 0 && p5.sections.length > 0, 'both plans built');
ok(p2.slotBars === 8 && p5.slotBars === 4, 'slotBars adapt (2 songs→8, 5 songs→4)',
   'got ' + p2.slotBars + '/' + p5.slotBars);
ok(p2.sections[0].type === 'intro' && p2.sections[p2.sections.length - 1].type === 'outro',
   'plan opens with intro, closes with outro');
var types2 = p2.sections.map(function (s) { return s.type; });
['intro', 'build', 'rotation', 'chorus', 'break', 'breakdown', 'finalChorus', 'outro']
  .forEach(function (t) { ok(types2.indexOf(t) >= 0, '2-song plan has section: ' + t); });
ok(p2.sections.filter(function (s) { return s.type === 'rotation'; }).length ===
   p2.cycles * 2 * p2.slotBars / p2.slotBars, 'rotation slot count = cycles×N');
var rotSongs = {};
p2.sections.forEach(function (s) { if (s.type === 'rotation') s.vocals.forEach(function (v) { rotSongs[v] = 1; }); });
ok(Object.keys(rotSongs).length === 2, 'rotation alternates singers, not sequential full songs');
var ch = p2.sections.filter(function (s) { return s.type === 'chorus'; })[0];
ok(ch.vocals.indexOf(p2.hooks.strongest) >= 0, 'chorus features strongest detected hook');
var bd = p2.sections.filter(function (s) { return s.type === 'breakdown'; })[0];
ok(bd.vocals[0] === p2.hooks.mellowest, 'breakdown uses mellowest song');
ok(p5.rotationOrder.length === 5, '5-song rotation covers all songs');
ok(JSON.stringify(p2.sections.map(function (s) { return s.type + s.bars; })) !==
   JSON.stringify(p5.sections.map(function (s) { return s.type + s.bars; })),
   '2-song and 5-song plans are structurally different');
ok(p2.rotationOrder[0] === 0, 'rotation starts at Song A');

console.log('== energy adaptation ==');
var pSad = V.buildArrangement(songs2, { presetId: 'sad', settings: { length: '3', energy: 'low' } });
var pEdm = V.buildArrangement(songs2, { presetId: 'edm', settings: { length: '3', energy: 'high' } });
var bdSad = pSad.sections.filter(function (s) { return s.type === 'breakdown'; })[0];
var bdEdm = pEdm.sections.filter(function (s) { return s.type === 'breakdown'; })[0];
ok(bdSad.bars === 8 && bdEdm.bars === 4, 'breakdown longer for low energy (8 vs 4)',
   'got ' + bdSad.bars + '/' + bdEdm.bars);
ok(pSad.spec.tempoShift === 0.92 && pSad.gridBpm < pSad.masterBpm, 'sad preset slows grid ×0.92');
ok(pEdm.spec.risers === true && pSad.spec.risers === false, 'risers on for EDM, off for Sad');

console.log('== 12 presets: pairwise audible diffs ==');
var ids = V.PRESETS.map(function (p) { return p.id; });
ok(ids.length === 12, 'exactly 12 presets', 'got ' + ids.length);
var expect = ['romantic', 'sad', 'lofi', 'slowed', 'sufi', 'chillout', 'edm', 'party', 'acoustic', 'cinematic', 'trending', 'custom'];
expect.forEach(function (id) { ok(ids.indexOf(id) >= 0, 'preset present: ' + id); });
var allDiff = true, diffDetail = '';
for (var a = 0; a < ids.length; a++) for (var b = a + 1; b < ids.length; b++) {
  var d = V.presetDiff(ids[a], ids[b]);
  if (!d.length) { allDiff = false; diffDetail = ids[a] + ' vs ' + ids[b]; }
}
ok(allDiff, 'every preset pair differs in ≥1 audible param', diffDetail);
var vsCustom = ids.filter(function (id) { return id !== 'custom'; })
  .every(function (id) { return V.presetDiff(id, 'custom').length > 0; });
ok(vsCustom, 'every preset differs audibly from Custom');
var slowed = V.getPreset('slowed');
ok(slowed.params.tempoShift === 0.85 && slowed.params.reverbWet === 2.5,
   'Slowed+Reverb = tempo ×0.85 + reverb 2.5×');
var edm = V.getPreset('edm');
ok(edm.params.sidechainDb === 4.5 && edm.params.risers === true, 'EDM = deep sidechain + risers');

console.log('== compatibility scoring ==');
var same = V.scoreCompatibility(songs2[0], songs2[0]);
ok(same.score === 1, 'identical songs score 1.0', 'got ' + same.score);
var rel = V.scoreCompatibility({ bpm: 100, key: 'A minor', energy: 0.5 }, { bpm: 100, key: 'C major', energy: 0.5 });
ok(rel.score >= 0.9, 'relative major/minor scores high', 'got ' + rel.score);
var far = V.scoreCompatibility({ bpm: 100, key: 'C major', energy: 0.5 }, { bpm: 100, key: 'F# major', energy: 0.5 });
ok(far.score < 0.75, 'tritone-apart keys score low', 'got ' + far.score);
var dbl = V.scoreCompatibility({ bpm: 100, key: 'C major', energy: 0.5 }, { bpm: 200, key: 'C major', energy: 0.5 });
ok(dbl.score >= 0.9, 'double-time BPM scores high', 'got ' + dbl.score);
var tempoFar = V.scoreCompatibility({ bpm: 100, key: 'C major', energy: 0.5 }, { bpm: 150, key: 'C major', energy: 0.5 });
ok(tempoFar.score < dbl.score, '50% tempo gap scores worse than double-time');
ok(Array.isArray(rel.reasons) && rel.reasons.length === 3 && rel.reasons.every(function (r) { return typeof r === 'string' && r.length > 10; }),
   'reasons[] has 3 human-readable strings');
var m = V.compatibilityMatrix(songs5);
ok(m.length === 5 && m[0].length === 5 && m[0][0] === 1, '5×5 compat matrix, diagonal 1');

console.log('== settings → engine params ==');
var ms = V.mapSettingsToParams({ length: '4', energy: 'high', vocalFocus: 'high', transition: 'smooth', effects: 'heavy', mastering: 'loud' });
ok(ms.params.lengthMin === 4, 'length 4 min');
var plan4 = V.buildArrangement(songs2, { presetId: 'custom', settings: { length: '4' } });
ok(plan4.totalBars === 100, '4 min @100 BPM → 100 bars', 'got ' + plan4.totalBars);
var specHi = V.presetRenderSpec('custom', { vocalFocus: 'high' });
ok(specHi.vocalBoostDb === 5, 'vocal focus high → +5 dB', 'got ' + specHi.vocalBoostDb);
var specLo = V.presetRenderSpec('custom', { vocalFocus: 'low' });
ok(specLo.vocalBoostDb === 1.5, 'vocal focus low → +1.5 dB', 'got ' + specLo.vocalBoostDb);
var specSm = V.presetRenderSpec('custom', { transition: 'smooth' });
ok(specSm.xfadeBars === 1, 'transition smooth → xfade 1 bar');
var specHv = V.presetRenderSpec('edm', { effects: 'heavy' });
ok(specHv.reverbWet === 1.76 && specHv.delayWet === 1.44, 'effects heavy → reverb ×2.2, delay ×1.8 (edm base 0.8)',
   'got ' + specHv.reverbWet + '/' + specHv.delayWet);
var specMn = V.presetRenderSpec('edm', { effects: 'minimal' });
ok(specMn.reverbWet === 0.24 && specMn.risers === false, 'effects minimal → reverb ×0.3, no risers');
// v29 P2-4: the Custom preset is dry by design — scaling a 0 base stays 0.
var specCustomDry = V.presetRenderSpec('custom', { effects: 'heavy' });
ok(specCustomDry.reverbWet === 0 && specCustomDry.delayWet === 0, 'custom stays dry under any effects setting');
var specLd = V.presetRenderSpec('custom', { mastering: 'loud' });
ok(specLd.mastering.ratio === 3 && specLd.mastering.truePeakCeil === 0.80, 'mastering loud → ratio 3, ceil 0.80');
var specAu = V.presetRenderSpec('edm', { transition: 'auto' });
ok(specAu.xfadeBars === 0.25, 'auto transition follows EDM preset (energetic → 0.25)');
ok(V.getSettingsUI().length === 6, 'getSettingsUI returns 6 settings');
ok(V.getSettingsUI().every(function (s) { return s.mapsTo && s.options.length >= 3; }),
   'every setting has options + mapsTo engine params');
ok(V.PARAM_MAPPING.length === 8, 'PARAM_MAPPING documents 8 mappings');

console.log('== transpose plan ==');
var tp = V.transposePlan('A minor', ['A minor', 'C major', 'F# minor', 'E major']);
ok(tp[0].semitones === 0, 'master reference = 0');
ok(tp[1].semitones === 0, 'C major is relative of A minor → 0', 'got ' + tp[1].semitones);
ok(tp[2].semitones === 3 || tp[2].semitones === -3, 'F# minor → A minor = ±3 semitones', 'got ' + tp[2].semitones);
ok(tp[3].semitones === -4, 'E major → C (relative major of A minor) = −4 semitones', 'got ' + tp[3].semitones);
ok(tp.every(function (t) { return t.reason && t.reason.length > 10; }), 'every entry has a reason string');
var tu = V.getTransposeUI();
ok(tu.masterBpm && tu.semitones, 'getTransposeUI has masterBpm + semitones specs');

console.log('== timeline bridge ==');
var br = V.bridgeToTimeline(pEdm, pEdm.spec);
var to = br.timelineOpts;
ok(to.masterBpm === pEdm.gridBpm && to.cycles === pEdm.cycles && to.barsPerVocal === pEdm.slotBars,
   'timelineOpts carries plan geometry');
ok(to.xfadeBars === 0.25 && to.vocalBoostDb === pEdm.spec.vocalBoostDb, 'timelineOpts carries preset xfade/boost');
ok(br.beatBars === pEdm.totalBars, 'beatBars = plan.totalBars');
ok(br.beatShaping.sectionGain === true && br.beatShaping.risers === true, 'EDM bridge enables section gain + risers');
ok(Array.isArray(br.postChain) && br.postChain.join(',') === 'tone,mastering', 'postChain = tone,mastering');

console.log('== DSP: audible changes ==');
// section gain envelope
var sr = 44100, bpm = 100, barLen = Math.round(240 / bpm * sr);
var beatSec = pEdm.totalBars * 240 / bpm;
var beat = fakeBuf(beatSec, sr, function (t) { return 0.5 * Math.sin(2 * Math.PI * 55 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t); });
V.shapeBeatDynamics(beat, pEdm);
var d0 = beat.getChannelData(0);
function secRms(type) {
  var sec = pEdm.sections.filter(function (s) { return s.type === type; })[0];
  return rms(d0, sec.startBar * barLen, (sec.startBar + sec.bars) * barLen);
}
var rBreak = secRms('breakdown'), rChorus = secRms('chorus'), rIntro = secRms('intro');
ok(rBreak < rIntro * 0.75, 'breakdown (−4 dB) quieter than intro', rBreak.toFixed(3) + ' vs ' + rIntro.toFixed(3));
ok(rChorus > rIntro * 1.05, 'chorus (+1 dB) louder than intro', rChorus.toFixed(3) + ' vs ' + rIntro.toFixed(3));
// risers
var pre = fakeBuf(beatSec, sr, function () { return 0.05; });
var chSec = pEdm.sections.filter(function (s) { return s.type === 'chorus'; })[0];
V.addRisers(pre, pEdm, pEdm.spec, sr);
var riserD = pre.getChannelData(0);
var r0 = (chSec.startBar - 2) * barLen, r1 = chSec.startBar * barLen;
var bedRef = rms(riserD, Math.max(0, r0 - 4 * barLen), r0);          // bed before riser
var firstHalf = rms(riserD, r0, (r0 + r1) / 2);
var secondHalf = rms(riserD, (r0 + r1) / 2, r1);
ok(secondHalf > firstHalf * 1.5, 'riser swells (2nd half louder than 1st)',
   firstHalf.toFixed(4) + ' → ' + secondHalf.toFixed(4));
ok(secondHalf > bedRef * 1.5, 'riser rises above the bed',
   bedRef.toFixed(4) + ' → ' + secondHalf.toFixed(4));
// tone: brightness raises centroid, bass raises low-end
var toneBuf = fakeBuf(10, sr, function (t) { return 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 3000 * t); });
var cBefore = centroid(toneBuf.getChannelData(0), sr);
V.applyPresetTone(toneBuf, { brightness: 2, bassDb: 0 }, sr);
var cAfter = centroid(toneBuf.getChannelData(0), sr);
ok(cAfter > cBefore * 1.02, 'brightness +2 raises spectral centroid', cBefore.toFixed(0) + ' → ' + cAfter.toFixed(0));
var bassBuf = fakeBuf(10, sr, function (t) { return 0.3 * Math.sin(2 * Math.PI * 60 * t); });
var bBefore = rms(bassBuf.getChannelData(0), 0, bassBuf.length);
V.applyPresetTone(bassBuf, { brightness: 0, bassDb: 6 }, sr);
var bAfter = rms(bassBuf.getChannelData(0), 0, bassBuf.length);
ok(bAfter > bBefore * 1.5, 'bass +6 dB raises low-end RMS', bBefore.toFixed(3) + ' → ' + bAfter.toFixed(3));
// mastering caps true peak
var hot = fakeBuf(5, sr, function (t, i) { return (i % 2 ? 1 : -1) * 1.4; });
var st = V.applyMastering(hot, { ratio: 3, thresholdDb: -9, truePeakCeil: 0.80 }, sr);
ok(st.peakBefore > 1.0, 'hot signal detected', 'peakBefore=' + st.peakBefore);
ok(st.peakAfter <= 0.81, 'true peak limited to ceiling 0.80', 'peakAfter=' + st.peakAfter);
ok(st.grDb >= 0, 'gain-reduction stat reported');

console.log('== honesty: no "AI" in user-facing labels ==');
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/../www/js/v25-arrange.js', 'utf8');
var userStrings = [];
V.PRESETS.forEach(function (p) { userStrings.push(p.name, p.tagline, p.description); });
V.getSettingsUI().forEach(function (s) {
  userStrings.push(s.label, s.hint);
  s.options.forEach(function (o) { userStrings.push(o.label, o.hint || ''); });
});
var aiHit = userStrings.filter(function (s) { return /\bAI\b/i.test(s || ''); });
ok(aiHit.length === 0, 'no "AI" in preset/setting labels', JSON.stringify(aiHit.slice(0, 2)));
ok(!/artificial intelligence/i.test(userStrings.join(' ')), 'no "artificial intelligence" in labels');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
