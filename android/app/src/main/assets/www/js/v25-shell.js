'use strict';
/* =====================================================================
   RuhMix — v25-shell.js (W1: App Shell + Premium Navigation)
   Spec: §1 (App shell / bottom nav / home dashboard), §23/§24
   (premium dark UI + RuhMix branding).

   NEW FILE — do not edit index.html or app.js. The coordinator wires:
     <link rel="stylesheet" href="css/v25-theme.css">
     <script src="js/v25-shell.js"></script>
   AFTER the existing CSS/JS in index.html.

   Builds ON TOP of the existing nav: uses RM.app.show() for every
   navigation, chains onto RM.app.onShow for active-tab sync (same
   pattern as mashup-screen.js). No button is dead: every action either
   navigates to a real screen or starts the real auto-mashup flow.
   Zero third-party / Muse branding — RuhMix only.
   ===================================================================== */
window.RM = window.RM || {};

RM.v25shell = (function () {
  const $ = (id) => document.getElementById(id);
  const A = () => RM.app || null;

  /* -------- tab -> screen map (spec §1) --------
     Home     -> screen-home      (existing)
     Projects -> screen-projects  (existing)
     Create   -> screen-v25create (NEW W2 Create screen — w26: was screen-mashup)
     Studio   -> screen-studio    (W5)
     Settings -> screen-settings  (existing) */
  const TABS = [
    { id: 'home',     label: 'Home',     icon: '🏠',  screen: 'home' },
    { id: 'projects', label: 'Projects', icon: '📁', screen: 'projects' },
    { id: 'create',   label: 'Create',   icon: '✨',  screen: 'v25create', hero: true },
    { id: 'studio',   label: 'Studio',   icon: '🎛️', screen: 'studio' },
    { id: 'settings', label: 'Settings', icon: '⚙️', screen: 'settings' },
  ];
  // screen -> tab reverse map for active-tab highlight.
  // 'mashup' (the old auto-mashup screen, still reachable from Home/More)
  // also highlights the Create tab.
  const SCREEN_TO_TAB = { home: 'home', projects: 'projects', mashup: 'create', v25create: 'create', studio: 'studio', settings: 'settings' };

  let navEl = null;
  let booted = false;
  const state = { tab: 'home' };

  /* ================= navigation ================= */
  function go(tabId) {
    const t = TABS.find((x) => x.id === tabId);
    const a = A();
    if (!t || !a) return;
    if (t.screen === 'studio' && !$('screen-studio')) {
      // W5 builds #screen-studio — honest message instead of a dead tab.
      a.toast('Studio arrives with the next v25 build.');
      return;
    }
    // w26: the Create tab goes through the v25 Create module so its
    // self-built section is guaranteed to exist before navigation.
    if (tabId === 'create' && RM.v25create && typeof RM.v25create.show === 'function') {
      RM.v25create.show();
      return;
    }
    a.show(t.screen);
  }

  function syncTab(screenName) {
    const tabId = SCREEN_TO_TAB[screenName] || null;
    state.tab = tabId;
    if (!navEl) return;
    navEl.querySelectorAll('.v25-tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === tabId ? 'true' : 'false');
    });
    // Refresh the "Recent" count whenever Home is shown.
    if (screenName === 'home') updateRecentCount();
  }

  function buildNav() {
    if (navEl) return;
    navEl = document.createElement('nav');
    navEl.id = 'v25-bottomnav';
    navEl.className = 'v25-bottomnav';
    navEl.setAttribute('role', 'tablist');
    navEl.setAttribute('aria-label', 'RuhMix navigation');
    TABS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'v25-tab' + (t.hero ? ' v25-tab-hero' : '');
      b.setAttribute('data-tab', t.id);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', t.label);
      const ic = document.createElement('span');
      ic.className = 'v25-tab-ic';
      ic.textContent = t.icon;
      const lb = document.createElement('span');
      lb.className = 'v25-tab-lb';
      lb.textContent = t.label;
      b.appendChild(ic);
      b.appendChild(lb);
      b.addEventListener('click', () => go(t.id));
      navEl.appendChild(b);
    });
    document.body.appendChild(navEl);
  }

  /* ================= home dashboard (renderHome) ================= */
  function projectCount() {
    try { return (RM.proj && typeof RM.proj.list === 'function') ? RM.proj.list().length : 0; }
    catch (e) { return 0; }
  }

  function updateRecentCount() {
    const el = $('v25-recent-count');
    if (el) el.textContent = projectCount() ? ' • ' + projectCount() : '';
  }

  // Real auto-mashup flow (HONESTY: not a dead button).
  // w26: the OLD mashup screen (screen-mashup) keeps this entry point —
  // the Create tab now opens the new W2 Create screen instead.
  function quickAiMashup() {
    const a = A();
    if (!a) return;
    a.show('mashup');
  }

  function buildCard(id, cls, icon, title, sub) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'v25-card ' + cls;
    const i = document.createElement('span');
    i.className = 'v25-card-ic';
    i.textContent = icon;
    const tx = document.createElement('span');
    tx.className = 'v25-card-tx';
    const h = document.createElement('span');
    h.className = 'v25-card-title';
    h.textContent = title;
    const s = document.createElement('span');
    s.className = 'v25-card-sub';
    s.textContent = sub;
    tx.appendChild(h);
    tx.appendChild(s);
    b.appendChild(i);
    b.appendChild(tx);
    return b;
  }

  function renderHome() {
    const home = $('screen-home');
    if (!home || $('v25-dash')) return; // build once
    const a = A();

    const dash = document.createElement('div');
    dash.id = 'v25-dash';
    dash.className = 'v25-dash';

    // Settings gear (top-right) — real navigation.
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.id = 'v25-gear';
    gear.className = 'v25-gear';
    gear.setAttribute('aria-label', 'Open Settings');
    gear.textContent = '⚙️';
    gear.addEventListener('click', () => { if (a) a.show('settings'); });
    dash.appendChild(gear);

    // Brand block — RuhMix only.
    const brand = document.createElement('div');
    brand.className = 'v25-brand';
    const logo = document.createElement('img');
    logo.className = 'v25-logo';
    logo.src = 'logo.png';
    logo.alt = 'RuhMix';
    const name = document.createElement('div');
    name.className = 'v25-name';
    name.textContent = 'RuhMix';
    const sub = document.createElement('div');
    sub.className = 'v25-sub';
    sub.textContent = 'AI Professional Mashup Studio';
    const tag = document.createElement('div');
    tag.className = 'v25-tag';
    tag.textContent = 'Create. Mix. Feel.';
    brand.appendChild(logo);
    brand.appendChild(name);
    brand.appendChild(sub);
    brand.appendChild(tag);
    dash.appendChild(brand);

    // Big action cards — every one goes somewhere real.
    const grid = document.createElement('div');
    grid.className = 'v25-cards';

    const cCreate = buildCard('v25-c-create', 'v25-card-wide v25-card-create', '＋', 'Create New Mashup', 'Vocals × Beat — AI auto-mix');
    cCreate.addEventListener('click', () => go('create'));

    const cQuick = buildCard('v25-c-quick', 'v25-card-wide v25-card-ai', '⚡', 'Quick AI Mashup', 'Auto BPM • auto key • one tap');
    cQuick.addEventListener('click', quickAiMashup);

    const cProj = buildCard('v25-c-projects', '', '📁', 'My Projects', 'Saved mashups & edits');
    cProj.addEventListener('click', () => go('projects'));

    const cRecent = buildCard('v25-c-recent', '', '🕘', 'Recent', 'Jump to recent projects');
    const cnt = document.createElement('span');
    cnt.id = 'v25-recent-count';
    cnt.className = 'v25-recent-count';
    cRecent.querySelector('.v25-card-title').appendChild(cnt);
    cRecent.addEventListener('click', () => {
      const r = $('home-recent');
      if (r) {
        r.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (a) a.toast('Your recent projects');
      } else if (a) {
        a.show('projects'); // fallback: real screen if the list is absent
      }
    });

    const cImport = buildCard('v25-c-import', '', '🎵', 'Import Audio', 'MP3 • WAV • M4A • FLAC');
    cImport.setAttribute('data-go', 'import'); // w26: orphan-audit route marker
    cImport.addEventListener('click', () => { if (a) a.show('import'); });

    // w26: "More Tools" — the old #bottomnav's ⋯ destination (screen-more),
    // which hosts the classic screens (Slowed, Stems, FX, Mastering…).
    const cMore = buildCard('v25-c-more', '', '⋯', 'More Tools', 'Editor • Remix • Mixer • classic screens');
    cMore.setAttribute('data-go', 'more'); // w26: orphan-audit route marker
    cMore.addEventListener('click', () => { if (a) a.show('more'); });

    grid.appendChild(cCreate);
    grid.appendChild(cQuick);
    grid.appendChild(cProj);
    grid.appendChild(cRecent);
    grid.appendChild(cImport);
    grid.appendChild(cMore);
    dash.appendChild(grid);

    home.insertBefore(dash, home.firstChild);
    updateRecentCount();
  }

  /* ================= w26: orphan audit + old bottomnav ============= */
  // Every pre-v25 screen and where the v25 nav reaches it from.
  //   'v25 tab'   -> a TABS entry whose screen matches, or a SCREEN_TO_TAB
  //                  mapping onto an existing tab
  //   'home card' -> a #v25-dash card with data-go="<screen>"
  //   'more grid' -> a #more-grid button: ours carry data-go="<screen>";
  //                  app.js's built-in cards are matched by their label
  const ROUTES = [
    { screen: 'home',      via: 'v25 tab' },
    { screen: 'import',    via: 'home card' },
    { screen: 'editor',    via: 'more grid' },
    { screen: 'remix',     via: 'more grid' },
    { screen: 'slowed',    via: 'more grid' },
    { screen: 'mashup',    via: 'more grid' },  // old auto-mashup, kept reachable
    { screen: 'stems',     via: 'more grid' },
    { screen: 'aistem',    via: 'more grid' },
    { screen: 'mixer',     via: 'more grid' },
    { screen: 'fx',        via: 'more grid' },
    { screen: 'master',    via: 'more grid' },
    { screen: 'record',    via: 'more grid' },
    { screen: 'export',    via: 'more grid' },
    { screen: 'projects',  via: 'v25 tab' },
    { screen: 'settings',  via: 'v25 tab' },
    { screen: 'more',      via: 'home card' },
    { screen: 'studio',    via: 'v25 tab' },
    { screen: 'v25create', via: 'v25 tab' },
  ];

  // Labels of app.js's built-in #more-grid cards (MORE_LINKS in app.js).
  const MORE_LABELS = {
    slowed: 'Slowed+Reverb Studio', stems: 'Stem Separator',
    aistem: 'AI Stem Separator', fx: 'FX Rack', master: 'Mastering',
    record: 'Voice Recorder', export: 'Export',
    projects: 'Projects', settings: 'Settings',
  };

  // Destinations the old #bottomnav reached that the v25 nav + More grid
  // did not — added here so no screen is orphaned when #bottomnav retires.
  const MORE_EXTRA = [
    { screen: 'mashup', icon: '🎤', label: 'Classic Mashup' },
    { screen: 'editor', icon: '🎚️', label: 'Editor' },
    { screen: 'remix',  icon: '🎧', label: 'Remix FX' },
    { screen: 'mixer',  icon: '🎛️', label: 'Mixer' },
  ];

  function augmentMore() {
    const grid = $('more-grid');
    if (!grid) return false;
    const a = A();
    MORE_EXTRA.forEach((m) => {
      if (grid.querySelector('[data-go="' + m.screen + '"]')) return; // already added
      const b = document.createElement('button');
      b.className = 'home-card';
      b.setAttribute('data-go', m.screen);
      const ic = document.createElement('div');
      ic.className = 'hc-icon';
      ic.textContent = m.icon;
      const lb = document.createElement('div');
      lb.className = 'hc-label';
      lb.textContent = m.label;
      b.appendChild(ic);
      b.appendChild(lb);
      b.addEventListener('click', () => { if (a) a.show(m.screen); });
      grid.appendChild(b);
    });
    return true;
  }

  function routeOk(r) {
    if (r.via === 'v25 tab') {
      if (TABS.some((t) => t.screen === r.screen)) return true;
      const tab = SCREEN_TO_TAB[r.screen];
      return !!tab && TABS.some((t) => t.id === tab);
    }
    if (r.via === 'home card') {
      const dash = $('v25-dash');
      return !!(dash && dash.querySelector('[data-go="' + r.screen + '"]'));
    }
    if (r.via === 'more grid') {
      const grid = $('more-grid');
      if (!grid) return false;
      if (grid.querySelector('[data-go="' + r.screen + '"]')) return true;
      const want = MORE_LABELS[r.screen];
      if (!want) return false;
      const labels = grid.querySelectorAll('.hc-label');
      for (let i = 0; i < labels.length; i++) {
        if (labels[i].textContent.trim() === want) return true;
      }
      return false;
    }
    return false;
  }

  function orphanScreens() {
    return ROUTES.filter((r) => !routeOk(r)).map((r) => r.screen);
  }

  // Hides the old #bottomnav ONLY when zero screens are orphaned;
  // otherwise it stays visible and the orphans are logged. Re-asserted
  // on the same schedule as wrapOnShow so late DOM changes are covered.
  function auditAndHideOldNav() {
    augmentMore();
    const orphans = orphanScreens();
    const old = $('bottomnav');
    if (old) {
      if (orphans.length === 0) {
        old.style.display = 'none';
      } else {
        old.style.display = '';
        try { console.warn('[v25shell] old #bottomnav kept visible — orphaned screens:', orphans.join(',')); } catch (e) {}
      }
    }
    return orphans;
  }

  /* ================= onShow hook (active tab sync) =================
     app.js init() ASSIGNS RM.app.onShow directly on DOMContentLoaded,
     so chain + re-assert (same pattern as mashup-screen.js / ux-flow.js). */
  let hooked = null;
  function wrapOnShow() {
    const a = A();
    if (!a || a.onShow === hooked) return;
    const prev = a.onShow;
    hooked = function (name) {
      try { if (typeof prev === 'function') prev(name); } catch (e) {}
      try { syncTab(name); } catch (e) {}
    };
    a.onShow = hooked;
  }

  function boot(attempts) {
    if (booted) return;
    if (A() && typeof A().show === 'function' && $('screen-home')) {
      booted = true;
      document.body.classList.add('v25'); // enables v25-theme.css scoping
      buildNav();
      renderHome();
      auditAndHideOldNav();
      syncTab('home');
      wrapOnShow();
      setTimeout(wrapOnShow, 600);
      setTimeout(wrapOnShow, 2000);
      setTimeout(auditAndHideOldNav, 600);   // w26: re-assert after late DOM
      setTimeout(auditAndHideOldNav, 2000);
      return;
    }
    if (attempts <= 0) return;
    setTimeout(() => boot(attempts - 1), 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(50));
  } else {
    boot(50);
  }

  return {
    go: go,
    renderHome: renderHome,
    syncTab: syncTab,
    quickAiMashup: quickAiMashup,
    TABS: TABS,
    // w26: orphan audit (node-test hooks)
    ROUTES: ROUTES,
    orphanScreens: orphanScreens,
    auditAndHideOldNav: auditAndHideOldNav,
    augmentMore: augmentMore,
  };
})();
