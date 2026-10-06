'use strict';
/* =====================================================================
   RuhMix — ads.js
   AdMob (rewarded video + interstitial) — native bridge ke through.
   HASNAIN — AD UNIT IDs:
     Teenon IDs neeche real hain (tumhara AdMob):
       App ID (AndroidManifest): ca-app-pub-1457912071506893~1344547777
       Rewarded:                ca-app-pub-1457912071506893/7359291783
       Interstitial:            ca-app-pub-1457912071506893/7618222790
     NOTE: naye ad units ko live ads dikhane me ~1 ghanta lag sakta hai —
     tab tak test ads ya blank dikhe to ghabrana mat.
   Rules (Hasnain ke faisle):
     * Rewarded (30-sec video): AI Stem Separation se PEHLE — "1 ad dekho,
       1 gaana AI se separate karo". Reward mile tabhi separation start.
       Ad fail/skip ho to separation NAHI chalegi (graceful message).
       Koi frequency cap nahi (user ki marzi).
     * Interstitial: export complete hone ke BAAD, har 2nd export par
       (pehle export par nahi). Max 1 per 5 minute.
     * Ads fail ho to app KABHI crash/block nahi hogi — ad load fail =
       feature bina ad ke chalegi (rewarded gate par graceful message ke
       saath), console me log.
   ===================================================================== */
window.RM = window.RM || {};
RM.ads = (function () {
  const ADMOB_CONFIG = {
    // Teenon IDs Hasnain ke REAL AdMob units hain.
    // NOTE: naye ad units ko live ads dikhane me ~1 ghanta lag sakta hai —
    // tab tak test ads ya blank dikhe to ghabrana mat.
    rewarded: 'ca-app-pub-1457912071506893/7359291783',
    interstitial: 'ca-app-pub-1457912071506893/7618222790',
  };
  const LS_EXPORTS = 'rmx_ad_exports';      // successful export count
  const LS_LAST_INT = 'rmx_ad_last_int';    // last interstitial timestamp
  const INTERSTITIAL_MIN_GAP_MS = 5 * 60 * 1000;  // max 1 per 5 min
  const HI = () => false; // English-only build: language locked to English
  const T = (hi, en) => en; // English-only build
  function native() {
    try { return (window.Android && typeof window.Android === 'object') ? window.Android : null; }
    catch (e) { return null; }
  }
  let rewardedWaiters = [];
  /** Native se callback: RM.ads._onRewarded('earned' | 'closed' | 'failed') */
  function _onRewarded(result) {
    const ws = rewardedWaiters;
    rewardedWaiters = [];
    ws.forEach((w) => { try { w(result); } catch (e) {} });
  }
  /**
   * Rewarded video ad dikhao. Promise<boolean> — true = reward earned
   * (separation aage badh sakti hai), false = fail/skip (graceful message).
   * Kabhi reject nahi hota, kabhi hang nahi hota (25s safety timeout).
   */
  function showRewarded() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (earned) => {
        if (done) return;
        done = true;
        resolve(!!earned);
      };
      const nat = native();
      if (!nat || typeof nat.showRewarded !== 'function') {
        finish(false);
        return;
      }
      const to = setTimeout(() => {
        // safety: native callback na aaye to hang nahi hona chahiye
        const idx = rewardedWaiters.indexOf(onRes);
        if (idx >= 0) rewardedWaiters.splice(idx, 1);
        finish(false);
      }, 25000);
      const onRes = (result) => {
        clearTimeout(to);
        finish(result === 'earned');
      };
      rewardedWaiters.push(onRes);
      try {
        nat.showRewarded(ADMOB_CONFIG.rewarded);
      } catch (e) {
        clearTimeout(to);
        const idx = rewardedWaiters.indexOf(onRes);
        if (idx >= 0) rewardedWaiters.splice(idx, 1);
        finish(false);
      }
    });
  }
  function getExportCount() {
    try { return parseInt(localStorage.getItem(LS_EXPORTS) || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  /**
   * Export complete hone par call karo. Har 2nd export par interstitial
   * (pehle par nahi), max 1 per 5 min. Fail ho to chupchaap skip + log.
   */
  function notifyExportDone() {
    let n = 0;
    try {
      n = getExportCount() + 1;
      localStorage.setItem(LS_EXPORTS, String(n));
    } catch (e) { n = 1; }
    if (n < 2 || n % 2 !== 0) return;  // pehle export par nahi; har 2nd par
    let last = 0;
    try { last = parseInt(localStorage.getItem(LS_LAST_INT) || '0', 10) || 0; } catch (e) {}
    if (Date.now() - last < INTERSTITIAL_MIN_GAP_MS) {
      return;
    }
    const nat = native();
    if (!nat || typeof nat.showInterstitial !== 'function') {
      return;
    }
    try {
      nat.showInterstitial(ADMOB_CONFIG.interstitial);
      try { localStorage.setItem(LS_LAST_INT, String(Date.now())); } catch (e) {}
    } catch (e) {
    }
  }
  /** App start par native side me ads preload karo (taaki dikhane me der na lage). */
  function preload() {
    const nat = native();
    if (!nat || typeof nat.preloadAds !== 'function') return;
    try { nat.preloadAds(ADMOB_CONFIG.rewarded, ADMOB_CONFIG.interstitial); }
    catch (e) { /* ad preload failure is silent — ads are never blocking */ }
  }
  function rewardedSkippedMessage() {
    return T('', '🎬 The ad could not play or was skipped. Watching the ad is required for AI Separation (it pays for the server). Check your internet and try again — or try the "Beta (DSP)" no-server option.');
  }
  return {
    ADMOB_CONFIG,
    showRewarded,
    notifyExportDone,
    preload,
    rewardedSkippedMessage,
    _onRewarded,  // native callback — app code isko directly call na kare
  };
})();
