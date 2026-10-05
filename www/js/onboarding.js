'use strict';
/* =====================================================================
   RuhMix — onboarding.js
   First-run onboarding (4 swipe slides) + "What's New" dialog.
   - Onboarding shows only once (localStorage flag 'ruhmix.introSeen').
   - "What's New" shows once per versionCode upgrade
     (flag 'ruhmix.lastSeenVersion').
   - Future releases: add entries to WHAT_IS_NEW keyed by versionCode.
   ===================================================================== */
window.RM = window.RM || {};

RM.onboard = (function () {
  const INTRO_SEEN_KEY = 'ruhmix.introSeen';
  const LAST_VER_KEY = 'ruhmix.lastSeenVersion';

  /* ---------------- onboarding slides ---------------- */
  const SLIDES = [
    {
      icon: '🎵',
      headline: 'Import Your Music',
      text: 'Pick any song from your music library or files in just two taps.',
    },
    {
      icon: '🎚️',
      headline: 'Edit Like a Pro',
      text: 'Cut, trim, fade, reverse and fine-tune every part of your audio.',
    },
    {
      icon: '✨',
      headline: 'Remix in One Tap',
      text: 'Auto Remix styles, Slowed+Reverb and 8D / 3D / 16D spatial audio.',
    },
    {
      icon: '📤',
      headline: 'Export & Share',
      text: 'Save in MP3, WAV or FLAC — then share your track anywhere.',
    },
  ];

  /* ---------------- "What's New" content ----------------
     Add one array per released versionCode (newest key last). */
  const WHAT_IS_NEW = {
    12: [
      'First-run tour: a quick guided intro when you open the app',
      'Simple bottom-tab navigation — every feature one tap away',
      'Pick Music in 2 taps straight from your music library',
      'Quick access to your recent files right on the Home screen',
      '8D, 3D and 16D audio effects, now one tap away',
      'Export button on every screen, no more hunting around',
      'New Music library tab with search',
      'Smoother, faster playback with no stutter',
    ],
  };

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  /* ================= onboarding overlay ================= */
  let obIndex = 0;
  let obDone = null;

  function buildOnboarding() {
    let ov = document.getElementById('ob-ov');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'ob-ov';
    ov.innerHTML =
      '<div class="ob-skip-wrap"><button class="btn ghost ob-skip" id="ob-skip">Skip</button></div>' +
      '<div class="ob-track" id="ob-track"></div>' +
      '<div class="ob-dots" id="ob-dots"></div>' +
      '<div class="ob-foot"><button class="btn primary big ob-cta" id="ob-cta">Next</button></div>';
    document.body.appendChild(ov);

    const track = ov.querySelector('#ob-track');
    SLIDES.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'ob-slide';
      d.innerHTML =
        '<div class="ob-logo-wrap">' +
        (i === 0 ? '<img src="logo.png" alt="RuhMix" class="ob-logo"><div class="ob-brand">RuhMix</div><div class="ob-by">By Hasnain Khan</div>' : '') +
        '</div>' +
        '<div class="ob-icon">' + s.icon + '</div>' +
        '<h2 class="ob-head">' + esc(s.headline) + '</h2>' +
        '<p class="ob-desc">' + esc(s.text) + '</p>';
      track.appendChild(d);
    });

    const dots = ov.querySelector('#ob-dots');
    SLIDES.forEach((_, i) => {
      const b = document.createElement('button');
      b.className = 'ob-dot';
      b.setAttribute('aria-label', 'Go to slide ' + (i + 1));
      b.addEventListener('click', () => obGo(i));
      dots.appendChild(b);
    });

    // swipe support (touch)
    let startX = null;
    ov.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
    }, { passive: true });
    ov.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (dx < -40 && obIndex < SLIDES.length - 1) obGo(obIndex + 1);
      else if (dx > 40 && obIndex > 0) obGo(obIndex - 1);
    }, { passive: true });

    ov.querySelector('#ob-skip').addEventListener('click', () => finishOnboarding());
    ov.querySelector('#ob-cta').addEventListener('click', () => {
      if (obIndex < SLIDES.length - 1) obGo(obIndex + 1);
      else finishOnboarding();
    });
    return ov;
  }

  function obGo(i) {
    obIndex = i;
    const ov = document.getElementById('ob-ov');
    ov.querySelector('#ob-track').style.transform =
      'translateX(-' + (i * 100) + '%)';
    ov.querySelectorAll('.ob-dot').forEach((d, j) => {
      d.classList.toggle('active', j === i);
    });
    ov.querySelector('#ob-cta').textContent =
      (i === SLIDES.length - 1) ? 'Get Started' : 'Next';
  }

  function finishOnboarding() {
    const ov = document.getElementById('ob-ov');
    if (ov) ov.classList.remove('show');
    const cb = obDone;
    obDone = null;
    if (cb) cb();
  }

  function showOnboarding(done) {
    obIndex = 0;
    obDone = done;
    const ov = buildOnboarding();
    obGo(0);
    ov.classList.add('show');
  }

  /* ================= "What's New" overlay ================= */
  function showWhatsNew(code, done) {
    const entries = WHAT_IS_NEW[code];
    if (!entries || !entries.length) { if (done) done(); return; }
    let ov = document.getElementById('wn-ov');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.id = 'wn-ov';
    ov.innerHTML =
      '<div class="wn-card">' +
        '<div class="wn-kicker">RuhMix • By Hasnain Khan</div>' +
        '<h2 class="wn-title">What\'s New in RuhMix</h2>' +
        '<ul class="wn-list">' +
        entries.map((e) => '<li>' + esc(e) + '</li>').join('') +
        '</ul>' +
        '<button class="btn primary big wn-cta" id="wn-gotit">Got it</button>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => {
      ov.classList.remove('show');
      setTimeout(() => ov.remove(), 250);
      if (done) done();
    };
    ov.querySelector('#wn-gotit').addEventListener('click', close);
    requestAnimationFrame(() => ov.classList.add('show'));
  }

  /* ================= entry point ================= */
  function init(opts) {
    const code = (opts && opts.versionCode) || 0;
    let seen = null, lastV = 0;
    try {
      seen = localStorage.getItem(INTRO_SEEN_KEY);
      lastV = +(localStorage.getItem(LAST_VER_KEY) || 0);
    } catch (e) {}

    const stamp = () => {
      try { localStorage.setItem(LAST_VER_KEY, String(code)); } catch (e) {}
    };

    if (!seen) {
      // first run: show onboarding, then stamp the baseline (no what's-new
      // for a fresh install — the user already met every feature above)
      showOnboarding(() => {
        try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch (e) {}
        stamp();
      });
      return;
    }
    // upgrade: show "What's New" once per versionCode
    if (lastV && code && lastV < code) {
      showWhatsNew(code, stamp);
    } else {
      stamp();
    }
  }

  function replayIntro() {
    showOnboarding(() => {
      try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch (e) {}
    });
  }

  return { init, replayIntro, showOnboarding, showWhatsNew, SLIDES, WHAT_IS_NEW };
})();
