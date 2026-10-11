# RuhMix FIXLOG — full audit + fix (2026-10-11)

**Scope:** `www/` + `android/` (package `com.ruhmix.app`). Audio-first audit —
Hasnain: *"Awaz pe jayada focus dena bhai"*.
**Rules honoured:** no fake audio features · DSP never presented as neural AI ·
AI stems untouched (his HuggingFace) · AdMob IDs untouched · offline-first kept ·
no APK built · no signing touched · no secrets committed.

**Mirror discipline:** `android/app/src/main/assets/www/` is a checked-in copy of
`www/` — every `www/js/*.js` fix below was synced to the assets mirror
(`diff -q` verified identical after each sync).

---

## 🐞 Bugs found & fixed

### P0 — Compressor ON/OFF toggle clicked (-13 dBFS jump) — FIXED
- **Symptom:** `test-w3-audio-engine.js` S6b failed — toggling the compressor
  mid-playback produced `clicks=3, maxJump=0.0794` (~-13 dBFS, clearly audible).
- **Root cause (measured, two layers):**
  1. Chrome's `DynamicsCompressor` has **exactly 6.00 ms of pure latency**
     (264 samples @44.1 kHz, 288 @48 kHz — time-based, verified by
     cross-correlation). The old code hard-spliced `compIn→comp` /
     `compIn→compBypass` on toggle; the 6 ms latency difference made every
     splice discontinuous.
  2. After fixing (1) with an 8 ms crossfade, an **intermittent** residual click
     remained (~12 ms after toggle, 3/5 runs). Waveform capture showed the
     cold compressor's output dropping 0.10→0.03 in one sample — the
     freshly-connected comp's **delay line was empty and its detector was
     adapting from zero** while the crossfade was already blending it in.
- **Fix (`www/js/fx.js`, `case 'compOn'`):** both paths now meet the limiter
  through dedicated fade gains (`compFadeA`/`compFadeB`, always wired). Live
  toggle = **15 ms warmup** (comp connects, fades stay put, delay line fills,
  detector settles) **then 8 ms crossfade** + threshold/ratio glide. All live
  automation goes through `cancelScheduledValues(now)` + `setTargetAtTime` so
  rapid ON/OFF/ON stays deterministic. Fresh (pre-render) chains keep direct
  assignment (Round-11 no-fade-in-artifact rule intact). The v36 CPU win is
  preserved: comp edges lazy-disconnect 1 s after an OFF toggle, guarded by
  generation + `fadeA < 1e-6` + `dispose()` (never disconnects a live path).
- **Verified:** isolated toggle 0 clicks (was 4, maxJump 0.2173→0.0174);
  5× chorus+comp stress 0 clicks; 6× comp-only 0 clicks; full S6b sequence
  now passes.

### P1 — Crash-recovery banner never appeared — FIXED
- **Symptom:** `test-undo-persist.js` "crash recovery offered + accepted on
  reload" failed — `needsRecovery()=true` but `#recovery-banner` stayed
  `display:none`.
- **Root cause:** `init()` registered `pagehide → RM.proj.markCleanExit()`.
  `pagehide` fires on **every** unload — reload, app swipe-away, system kill —
  so any dirty autosave was marked "clean" before the next launch could offer
  recovery. Crash recovery only worked if the renderer was hard-killed without
  unload (narrow case); normal "close app with unsaved work" silently lost the
  recovery offer.
- **Fix (two parts):**
  - `www/js/app.js`: removed the blanket `pagehide → markCleanExit()`. Safe
    default now: dirty autosave ⇒ recovery **is** offered.
  - `android/.../MainActivity.java`: the explicit **"Exit RuhMix?"** dialog's
    Exit button now runs
    `evaluateJavascript("…RM.proj.markCleanExit()…")` then finishes after
    200 ms (lets the JS land before the WebView dies). Clean exit is now
    marked **only** on user-confirmed exit — the single source of truth.
- **Verified:** reload with dirty autosave → banner "Found a previous project:
  CrashMe — Recover it?" appears; accept → project reopens with ops intact;
  full `test-undo-persist.js` 19/19 (was 18/19).

### P2 — README claims stale — FIXED
- "MP3 + WAV only, no FLAC export" — wrong: pure-JS FLAC encoder exists and
  the Export screen offers MP3/WAV/**FLAC**. Updated to MP3 + WAV + FLAC.
- "Multitrack Mixer — 5 tracks" — wrong: code builds **6** tracks
  (Vocal / Drums / Bass / Other / Beat / FX). Updated.

---

## 🔬 Investigated — NOT bugs (documented so nobody "fixes" them)

### Reverb "too quiet" (S1b failure) — by design, test recalibrated
- `ConvolverNode.normalize` defaults to `true`: our synthetic noise-decay IRs
  are **energy-normalized** (tail RMS tracks input RMS). Measured: sustained
  chord → tail −21 dB below dry, decaying naturally; Round-6 measured +7.45 dB
  RMS from sneak-on reverb — clearly audible, and it **cannot blow up/clip**
  (the whole app's wet-gain tuning assumes this).
- Setting `normalize=false` would make tails ~73× hotter (+37 dB) and clip
  everything — the tuning would break. **Do not "fix".**
- The S1b test's impulse-tail expectation (>0.02) was miscalibrated for this
  design (an impulse carries almost no energy). Test now verifies reverb-ON
  with a sustained faded tone: signal changes (Δ>0.05) + real decaying tail
  after the source stops. OFF==flat bypass proofs unchanged.

### S7b timing assertions — test reworked
- Old: "convolver costs >10% when enabled" + absolute `flat<2000 ms` budget.
  Wrong on both counts: modern Chrome uses partitioned-FFT convolution
  (2.2 s IR adds ~ms on 20 s audio — negligible **by design**), and the ms
  budget is environment-specific (slow VMs exceed it with the flat chain).
- New: flat chain keeps ≥2× realtime headroom anywhere; enabling
  reverb/spatial never causes pathological blowup (<3–4×). Idle-CPU
  true-bypass is proven by S7a's bypass-state checks, not timing.

### W6c versionCode desync (app.js=52, build.gradle=52, version.json=50) — mid-cycle, untouched
- `version.json` tracks the **live** release (50). Working tree is mid-cycle
  toward the next build (52). Syncing `version.json`→52 now would be wrong:
  users on the live 50 APK would be offered an "update" whose download is
  still the old 50 APK (infinite update prompt). **Syncs to 52 when the 52
  APK is actually uploaded to GitHub releases.** No user impact today.

---

## ✅ Audit results (no fake features found)

- **BPM detect:** real onset-energy implementation; returns `null` (never
  invented) when undetectable; UI shows "BPM —". Octave-disambiguated.
- **Key detect:** real FFT chroma + Krumhansl-Schmuckler profiles; `null` on
  silence/too-short. Used by mashup key-align (real `pitchShift`).
- **11 Auto Remix styles:** all genuinely distinct DSP (rate/EQ/filter/drive/
  chorus/echo/reverb-room+wet/comp/out-gain). Slowed styles honestly note
  "pitch changes with tempo".
- **FX rack:** 3-band + 10-band EQ, lowpass, drive, chorus, echo, convolution
  reverb, comp, limiter, 8D/3D/16D/360° spatial — every control maps to a real
  `chain.set()` case (audited all call sites; `reverbDecay` case is dead code
  with no UI bound — harmless). OFF = true bypass (physically disconnected).
- **Speed:** editor 0.5–2× (real `playbackRate`); slowed presets 0.7–0.9×.
- **Mixer:** 6 tracks, vol/pan/mute/solo all real, mixdown export real.
- **Undo/redo:** editor op-list (non-destructive, poisoned-render rollback) +
  Studio command stack (cap 50, byte-identical restore). Autosave sane.
- **Export contains the edits:** acceptance test 19/20 proves pitch-shift,
  vocal −6 dB, transitions and duration changes are IN the exported MP3.
- **Tap tempo / metronome:** real inter-tap measurement; scheduled clicks.
- **Mastering:** 5 real presets (EQ+comp+makeup), peak normalization real.
- **Recorder:** native bridge → honest browser-MediaRecorder fallback → clear
  errors. No format lies (3GP decoded as-is).
- **Stems DSP Beta:** labelled "Beta (DSP) — not neural AI" everywhere; no
  neural claims. AI/HF paths untouched.
- **§25 copyright gate** on export intact (acceptance test 20/20).

---

## 🧪 Test results (headless Chrome, 2026-10-11)

| Suite | Result |
|---|---|
| Page load smoke (mobile viewport) | **0** console errors, **0** pageerrors, 0 failed requests |
| `test-w3-audio-engine.js` (signal-level: bypass/tail/clip/WYSIWYG/SR/click/stutter) | **29/29 PASS** (was 26/29) |
| `test-export-round11.js` (9 screens' export buttons, WAV/FLAC/MP3 128–320, size order) | **19/19 PASS** |
| `test-v27-export.js` (dither, true-peak, limiter ceiling, warnings, one-tap fixes) | **25/25 PASS** |
| `test-undo-persist.js` (undo/redo, autosave, crash recovery, corruption) | **19/19 PASS** (was 18/19) |
| `test-w7-nav-system.js` (16 screens, back-stack, landscape, exit dialog) | **11/12** (1 = W6c version desync, mid-cycle — see above) |
| `test-v25-v26-acceptance.js` (20-step: import→BPM/key→stems→mashup→studio→pitch→export-MP3-with-edits→§25 gate) | **20/20 PASS** |
| `node --check` all `www/js/*.js` | all pass |

---

## ➕ Features added
**None.** Per the limited-creative-freedom rule for audio: fixed and polished
only. (The comp crossfade + warmup is a correctness fix, not a feature.)

## 📌 Needs Hasnain's phone / ears (cannot verify headless)
1. **Audio quality verdict** — the comp-toggle click fix and everything else
   are signal-verified, but "awaz kaisi lag rahi hai" (reverb character, remix
   musicality, any stutter on his device) needs his ears.
2. **Exit-dialog flow** — the Java `markCleanExit` hook + 200 ms delayed
   finish needs one on-phone check: Exit → relaunch with unsaved work →
   **no** recovery nag; swipe-away with unsaved work → recovery **offered**.
3. **Release** — versionCode **52** is staged in code (`app.js` + `build.gradle`);
   when he ships the 52 APK → upload to `releases/download/v1` →
   `version.json` → 52 (all three synced). **Do not bump version.json before
   the APK is live** (infinite-update-prompt hazard, see W6c note).
4. Real-device checks still pending from before: AdMob banner (account
   approval pending), mic recording decode (3GP), in-app update download.

## 🗂 Files changed
- `www/js/fx.js` (+ assets mirror): comp crossfade + warmup + lazy disconnect
- `www/js/app.js` (+ assets mirror): removed `pagehide→markCleanExit`
- `android/app/src/main/java/com/ruhmix/app/MainActivity.java`: Exit dialog → `markCleanExit()` + 200 ms delayed finish
- `tests/test-w3-audio-engine.js`: S1b recalibrated (energy-normalized reverb), S7b reworked (no pathological blowup)
- `README.md`: FLAC export + 6-track mixer corrections
- `www/js/app.js` / `android/app/build.gradle`: **not** bumped (stays 52 staged; versionName stays "1.0")
