#!/usr/bin/env node
/*
 * RuhMix edit-op engine verification (signal-level, real code).
 *
 * Drives headless Chrome (Puppeteer + chrome-headless-shell) to load
 * ~/workspace/ruhmix/www/index.html via file://, builds a synthetic
 * stereo AudioBuffer in the page, calls RM.proj.applyOps(buffer, ops)
 * and measures the output samples against expected values.
 *
 * Exit code: 0 if every test passes, 1 otherwise.
 * Prints one PASS/FAIL line per test.
 */
'use strict';
const path = require('path');
const puppeteer = require('/tmp/smoke/node_modules/puppeteer');

const EXE = '/home/hatch/.cache/puppeteer/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell';
const INDEX = 'file:///home/hatch/workspace/ruhmix/www/index.html';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('[pageerror]', e.message); });
  await page.goto(INDEX, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    'window.RM && window.RM.proj && typeof window.RM.proj.applyOps === "function" && window.RM.audio && typeof window.RM.audio.ensureCtx === "function"',
    { timeout: 60000 }
  );

  const results = await page.evaluate(async () => {
    const out = [];
    const add = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });

    const ctx = RM.audio.ensureCtx();
    const sr = ctx.sampleRate;
    const DUR = 10;
    const N = Math.floor(sr * DUR);

    // Synthetic stereo buffer: left 440Hz, right 660Hz, amplitude 0.5.
    // Marker bursts (880Hz @0.4 for 0.15s at 3s and 7s, left channel) so
    // regions are identifiable even where the base sine phase repeats.
    const buf = ctx.createBuffer(2, N, sr);
    {
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < N; i++) {
        const t = i / sr;
        L[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
        R[i] = 0.5 * Math.sin(2 * Math.PI * 660 * t);
        if ((t >= 3 && t < 3.15) || (t >= 7 && t < 7.15)) {
          L[i] += 0.4 * Math.sin(2 * Math.PI * 880 * t);
        }
      }
    }
    const inL = new Float32Array(N), inR = new Float32Array(N);
    inL.set(buf.getChannelData(0)); inR.set(buf.getChannelData(1));

    const sec = (s) => Math.round(s * sr);
    const maxDiff2 = (a, aOff, b, bOff, len) => {
      let m = 0;
      for (let i = 0; i < len; i++) { const d = Math.abs(a[aOff + i] - b[bOff + i]); if (d > m) m = d; }
      return m;
    };
    const ch = (b) => [b.getChannelData(0), b.getChannelData(1)];
    const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

    try {
      // 1. trim {a:2,b:5}
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'trim', a: 2, b: 5 }]);
        const [l, rr] = ch(r);
        const d = Math.max(maxDiff2(l, 0, inL, sec(2), sec(3)), maxDiff2(rr, 0, inR, sec(2), sec(3)));
        add('1. trim {a:2,b:5} → 3s exact, content == input[2..5]', r.length === sec(3) && d === 0,
          `len=${r.length}/${sec(3)} maxDiff=${d}`);
      }

      // 2. cut {a:2,b:5}
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'cut', a: 2, b: 5 }]);
        const [l, rr] = ch(r);
        const d1 = Math.max(maxDiff2(l, 0, inL, 0, sec(2)), maxDiff2(rr, 0, inR, 0, sec(2)));
        const d2 = Math.max(maxDiff2(l, sec(2), inL, sec(5), sec(5)), maxDiff2(rr, sec(2), inR, sec(5), sec(5)));
        add('2. cut {a:2,b:5} → 7s, [0..2]==in[0..2], [2..7]==in[5..10]', r.length === sec(7) && d1 === 0 && d2 === 0,
          `len=${r.length}/${sec(7)} d1=${d1} d2=${d2}`);
      }

      // 3. cut with a>b (reversed) — must NOT duplicate
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'cut', a: 5, b: 2 }]);
        const [l, rr] = ch(r);
        const d1 = Math.max(maxDiff2(l, 0, inL, 0, sec(2)), maxDiff2(rr, 0, inR, 0, sec(2)));
        const d2 = Math.max(maxDiff2(l, sec(2), inL, sec(5), sec(5)), maxDiff2(rr, sec(2), inR, sec(5), sec(5)));
        add('3. cut {a:5,b:2} reversed → same as cut {a:2,b:5}, no duplication',
          r.length === sec(7) && d1 === 0 && d2 === 0, `len=${r.length}/${sec(7)} d1=${d1} d2=${d2}`);
      }

      // 4. trim then cut — cut applies to TRIMMED view (view-relative coords)
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'trim', a: 2, b: 5 }, { t: 'cut', a: 1, b: 2 }]);
        const [l, rr] = ch(r);
        const d1 = Math.max(maxDiff2(l, 0, inL, sec(2), sec(1)), maxDiff2(rr, 0, inR, sec(2), sec(1)));
        const d2 = Math.max(maxDiff2(l, sec(1), inL, sec(4), sec(1)), maxDiff2(rr, sec(1), inR, sec(4), sec(1)));
        add('4. trim[2..5]+cut[1..2] view-relative → 2s = in[2..3]+in[4..5]',
          r.length === sec(2) && d1 === 0 && d2 === 0, `len=${r.length}/${sec(2)} d1=${d1} d2=${d2}`);
      }

      // 5. paste at 3s using RM.proj clipboard (as app.js sets it)
      {
        const CL = 1;
        const clip = ctx.createBuffer(2, Math.floor(sr * CL), sr);
        {
          const L = clip.getChannelData(0), R = clip.getChannelData(1);
          for (let i = 0; i < clip.length; i++) {
            const t = i / sr;
            L[i] = 0.4 * Math.sin(2 * Math.PI * 990 * t);
            R[i] = -0.4 * Math.sin(2 * Math.PI * 990 * t);
          }
        }
        const clipL = new Float32Array(clip.length); clipL.set(clip.getChannelData(0));
        const clipR = new Float32Array(clip.length); clipR.set(clip.getChannelData(1));
        RM.proj.setClipboard(clip);
        const r = await RM.proj.applyOps(buf, [{ t: 'paste', at: 3 }]);
        RM.proj.clearClipboard();
        const [l, rr] = ch(r);
        const e1 = Math.max(maxDiff2(l, 0, inL, 0, sec(3)), maxDiff2(rr, 0, inR, 0, sec(3)));
        const e2 = Math.max(maxDiff2(l, sec(3), clipL, 0, clip.length), maxDiff2(rr, sec(3), clipR, 0, clip.length));
        const e3 = Math.max(maxDiff2(l, sec(4), inL, sec(3), sec(7)), maxDiff2(rr, sec(4), inR, sec(3), sec(7)));
        add('5. paste@3s → 11s, clipboard samples in [3..4), neighbours intact',
          r.length === sec(11) && e1 === 0 && e2 === 0 && e3 === 0,
          `len=${r.length}/${sec(11)} pre=${e1} paste=${e2} post=${e3}`);
      }

      // 6. fadein {dur:2}
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'fadein', dur: 2 }]);
        const [l] = ch(r);
        const fl = sec(2);
        const startOk = l[0] === 0;
        const endOk = Math.abs(l[fl] - inL[fl]) < 1e-7;
        // linearity: find a sample near 1s with large |in| to avoid zero-crossings
        let li = -1;
        for (let i = sec(1) - 50; i < sec(1) + 50; i++) { if (Math.abs(inL[i]) > 0.3) { li = i; break; } }
        const lin = Math.abs((l[li] / inL[li]) - (li / fl)) < 1e-6;
        // no click at fade end: step across boundary small
        let maxStep = 0;
        for (let i = fl - 5; i < fl + 5; i++) { const s = Math.abs(l[i + 1] - l[i]); if (s > maxStep) maxStep = s; }
        add('6. fadein {dur:2}: sample[0]==0, sample[2s] full, linear, no boundary click',
          r.length === N && startOk && endOk && lin && maxStep < 0.05,
          `start=${l[0]} endErr=${Math.abs(l[fl] - inL[fl])} linErr=${Math.abs((l[li] / inL[li]) - (li / fl))} maxStep=${maxStep.toFixed(5)}`);
      }

      // 7. fadeout {dur:2}
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'fadeout', dur: 2 }]);
        const [l] = ch(r);
        const fl = sec(2);
        const endOk = l[N - 1] === 0;
        const startOk = Math.abs(l[N - fl] - inL[N - fl]) < 1e-6;
        let li = -1;
        for (let i = sec(9) - 50; i < sec(9) + 50; i++) { if (Math.abs(inL[i]) > 0.3) { li = i; break; } }
        const expect = (N - 1 - li) / fl;
        const lin = Math.abs((l[li] / inL[li]) - expect) < 1e-6;
        add('7. fadeout {dur:2}: last==0, pre-fade full, linear',
          r.length === N && endOk && startOk && lin,
          `last=${l[N - 1]} preFadeErr=${Math.abs(l[N - fl] - inL[N - fl])} linErr=${Math.abs((l[li] / inL[li]) - expect)}`);
      }

      // 8. gain
      {
        const r6 = await RM.proj.applyOps(buf, [{ t: 'gain', db: 6 }]);
        const [l6] = ch(r6);
        const ratio6 = rms(l6) / rms(inL);
        const rM = await RM.proj.applyOps(buf, [{ t: 'gain', db: -6 }]);
        const [lM] = ch(rM);
        const ratioM = rms(lM) / rms(inL);
        const r0 = await RM.proj.applyOps(buf, [{ t: 'gain', db: 0 }]);
        const [l0, rr0] = ch(r0);
        const d0 = Math.max(maxDiff2(l0, 0, inL, 0, N), maxDiff2(rr0, 0, inR, 0, N));
        add('8. gain +6dB→2.0, -6dB→0.5, 0dB→bit-identical',
          Math.abs(ratio6 - 2.0) < 0.01 && Math.abs(ratioM - 0.5) < 0.01 && d0 === 0,
          `+6dB ratio=${ratio6.toFixed(5)} -6dB ratio=${ratioM.toFixed(5)} 0dB diff=${d0}`);
      }

      // 9. reverse
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'reverse' }]);
        const [l, rr] = ch(r);
        let d = 0;
        for (let i = 0; i < N; i++) {
          const d1 = Math.abs(l[i] - inL[N - 1 - i]);
          const d2 = Math.abs(rr[i] - inR[N - 1 - i]);
          if (d1 > d) d = d1; if (d2 > d) d = d2;
        }
        const r2 = await RM.proj.applyOps(r, [{ t: 'reverse' }]);
        const [l2, rr2] = ch(r2);
        const d2r = Math.max(maxDiff2(l2, 0, inL, 0, N), maxDiff2(rr2, 0, inR, 0, N));
        add('9. reverse exact, double-reverse == original bit-exact',
          r.length === N && d === 0 && d2r === 0, `revDiff=${d} dblDiff=${d2r}`);
      }

      // 10. combined: trim+cut+fadein+gain+reverse
      {
        const ops = [
          { t: 'trim', a: 1, b: 9 },   // 8s: in[1..9)
          { t: 'cut', a: 2, b: 4 },    // view-relative: 6s = in[1..3) + in[5..9)
          { t: 'fadein', dur: 1 },
          { t: 'gain', db: 6 },
          { t: 'reverse' },
        ];
        const r = await RM.proj.applyOps(buf, ops);
        const [l, rr] = ch(r);
        // expected: build segment concat, apply fadein+gain (float64), reverse
        const fl = sec(1);
        const dbGain = Math.pow(10, 6 / 20); // engine uses dB, not exactly x2
        const segA = [inL.subarray(sec(1), sec(3)), inL.subarray(sec(5), sec(9))];
        const segB = [inR.subarray(sec(1), sec(3)), inR.subarray(sec(5), sec(9))];
        const concat = (segs, tot) => { const o = new Float64Array(tot); let p = 0; for (const s of segs) { for (let i = 0; i < s.length; i++) o[p++] = s[i]; } return o; };
        const eL = concat(segA, sec(6)), eR = concat(segB, sec(6));
        for (let i = 0; i < sec(6); i++) {
          const g = i < fl ? i / fl : 1;
          eL[i] *= g * dbGain; eR[i] *= g * dbGain;
        }
        let d = 0;
        for (let i = 0; i < sec(6); i++) {
          const d1 = Math.abs(l[i] - eL[sec(6) - 1 - i]);
          const d2 = Math.abs(rr[i] - eR[sec(6) - 1 - i]);
          if (d1 > d) d = d1; if (d2 > d) d = d2;
        }
        add('10. combined trim+cut+fadein+gain+reverse → 6s, sane, matches expected',
          r.length === sec(6) && d < 1e-6, `len=${r.length}/${sec(6)} maxDiff=${d.toExponential(2)}`);
      }

      // 11. corrupt ops — skipped gracefully, no crash
      {
        const ops = [null, { t: 'bogus' }, { a: 'x' }, 5, 'str', { t: 'cut' }, { t: 'gain', db: 'abc' }];
        const r = await RM.proj.applyOps(buf, ops);
        const [l, rr] = ch(r);
        const d = Math.max(maxDiff2(l, 0, inL, 0, N), maxDiff2(rr, 0, inR, 0, N));
        add('11. corrupt ops (null/bogus/non-numeric) → skipped, no crash, bit-identical',
          r.length === N && d === 0, `len=${r.length}/${N} diff=${d}`);
      }

      // 12. empty selection cut
      {
        const r = await RM.proj.applyOps(buf, [{ t: 'cut', a: 3, b: 3 }]);
        const [l, rr] = ch(r);
        const d = Math.max(maxDiff2(l, 0, inL, 0, N), maxDiff2(rr, 0, inR, 0, N));
        add('12. cut {a:3,b:3} empty selection → no-op, length unchanged',
          r.length === N && d === 0, `len=${r.length}/${N} diff=${d}`);
      }
    } catch (e) {
      add('HARNESS', false, 'exception: ' + (e && e.stack || e));
    }
    return out;
  });

  let fails = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    if (!r.pass) fails++;
  }
  console.log('---');
  console.log(fails === 0 ? `ALL ${results.length} TESTS PASSED` : `${fails}/${results.length} TESTS FAILED`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
