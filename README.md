# RuhMix — Professional Music & Remix Studio

**By Hasnain Khan**

RuhMix is a professional music & remix studio for Android — 100% free, fully offline. Import your songs, edit, remix, separate stems, add studio-grade effects, and export MP3/WAV.

## ✨ Features (16 screens)

- **Home** — recent projects, quick actions
- **Import** — MP3 / WAV / M4A / FLAC from your device
- **Editor** — trim, cut, split, copy/paste, fade in/out, gain, reverse, loop, markers, undo/redo, zoomable waveform
- **Auto Remix** — 11 style presets (Commercial, Lofi, Slowed+Reverb, Emotional, EDM, Trap, Synthwave, Acoustic, Sufi, Vocal Focus, Custom) with BPM detection
- **Slowed+Reverb Studio** — dedicated slowed presets (note: slowing also lowers pitch — tempo & pitch are linked in v1)
- **Stem Separator (Beta)** — honest DSP-based separation: Vocal Cut (center cancellation), Drum Extract (real HPSS), Bass Focus, 4-band Spectral Split. Experimental — bleed expected, no neural-network claims
- **Multitrack Mixer** — 5 tracks with volume / pan / mute / solo
- **FX Rack** — 3-band EQ + 10-band EQ, lowpass filter, soft drive, chorus, echo, convolution reverb, compressor, limiter — all click-free
- **Mastering** — 5 mastering presets + peak normalization
- **Voice Recorder** — mic recording via native bridge (device format, e.g. 3GP — decoded honestly)
- **Beat Tools** — tap tempo, metronome
- **Export** — MP3 (lamejs, 128–320 kbps, fully offline) or 16-bit WAV, cancel between stages, share via system sheet
- **Projects** — non-destructive op-list editing, autosave, crash recovery
- **Settings** — in-app update check (never removed), cache clear, Hindi/English, dark theme

## 📥 Download

**RuhMix 1.0 (APK):** https://github.com/Ruhvibes/ruhmix/releases/download/v1/RuhMix.apk

Open the link in Chrome on your phone → download → install.

## 🔧 Tech

- Web app (`www/`) — HTML/CSS/JS, Web Audio API, bundled lamejs (offline MP3)
- Android shell (`android/`) — WebView + native bridges: audio picker, mic recorder (MediaRecorder), file save/share, APK update download
- Package: `com.ruhmix.app` · versionName `1.0` · minSdk 26
- Signed with my persistent release keystore

## 🔄 Updates

The app checks `version.json` for new releases (Settings → Check for update).

## ⚠️ Honest limitations (v1)

- Stem separation is **Beta DSP** — frequency/center-channel methods, not neural AI; bleed/crosstalk expected
- Slowed playback lowers **pitch together with tempo** (no independent pitch-shift in v1)
- Recording uses the device's native format (3GP on most phones)
- Export is **MP3 + WAV only** — no M4A/FLAC export in v1

---
© Hasnain Khan — RuhMix 1.0
