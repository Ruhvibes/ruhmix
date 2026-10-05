# Round-6 Coordinator — pending queue (2026-10-05 ~20:45 IST)

## APPLIED (syntax OK, all `node --check` pass)
1. fx.js: driveCurve 1+amount*40 → 1+amount*5 (W5)
2. fx.js: applyPreset comp guard `if (p.comp.on !== false)` (W5) — flatFx bypass ab sach me bypass
3. fx.js: **P1 W6 — echo/reverb OFF guard** (`if (p.echo.on)` / `if (p.reverb.on)` before setting wet). Default chain me sneak hall reverb + echo (+8.73dB RMS) tha, UI OFF dikhta tha. AB FIXED.
4. audio-engine.js: BPM octave disambiguation 128→64, 150→75 (W7-1)
5. remix.js: arrangement gain pre-FX (tail gating fix, W7-2); loudness trims lofi 0.81 / slowed 0.92 / edm 0.96 / trap 0.90 / synthwave 0.92 (W7-7); vocalfocus preset (W5); generate() 4-stem → ≥2 roles (W7-9)
6. stems.js: setStemPack clear-FIRST on fail (W7-4) + roles ≥2 relax (W7-9)
7. app.js: stemmix export tail:0 + doExport tail passthrough (W7-3); remix export source (remixBuffer, W7-6); preview custom tempo (W7-5); preset-flow offline remix render (W7-6); remixBuffer null on new audio (W7-6); project vol/pan in export graph **P2 W6**; normalize 0.95→0.9441 (exactly −0.5dB, P3 W6); remix badge `${pack.roles.length} stems` + hf source label
8. projects.js: deserialize plain objects (W3); hasPasteOps export (W3); snapshotLive/restoreLive remixCustom (W7-8); W1 ke 4 fixes (W1 ne khud kiye)

## WAITING: W4 (network torture, owns hf-stems.js + ai-stems.js + ads.js) — still running
After W4 completes, apply:
- **ai-stems.js**: W2 ka adGating race patch (exact patch W2 ki report me hai — transcript summary se lena)
- **hf-stems.js** `finishHf()`: 2-stem pack registration (W7-9):
```js
// Round-6 (W7 Issue 9): HF ke 2 stems ko stem pack me register karo taaki
// Auto Remix stem pipeline use kare (pehle silently preset flow chalta tha).
try {
  RM.stems.setStemPack({ source: 'hf', roles: stems.map((s, i) => ({
    role: i === 0 ? 'vocal' : 'other', label: s.name, buffer: s.buffer })) });
} catch (e) { /* pack optional — preset flow fallback rehta hai */ }
```
(labels = ['Vocal (HF)', 'Instrumental (HF)'] — index 0 vocal, 1 other)

## THEN: build + verify
1. Full re-verify: Puppeteer 0 pageerrors, suites green
2. versionCode 6, versionName "1.0" (public me "V2" kahin nahi)
3. apksigner verify → `gh release upload v1 --clobber` → version.json → 6
4. Binary-identical download check
5. Final report: Auto Remix alag section + numbers table + phone-only tests

## Design decisions (unchanged)
- Mastering A/B loudness diff by design (loudness part of mastering)
- W5 synthwave vocal DC residual: torture-hot stems only, inaudible — untouched
- lame.min.js lazy-load: evaluate pending
- P2 product call: export = WYSIWYG (vol/pan included) — implemented
