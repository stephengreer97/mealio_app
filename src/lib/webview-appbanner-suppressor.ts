// App-install interstitial / "get the app" nudge suppression for store WebViews.
//
// Several grocery mobile-web sites show an app-install nudge (banner, bottom
// sheet, or full modal) that has nothing to do with anti-bot/WAF — it's normal
// mobile-web UX — but it overlays the page and blocks Mealio's cart automation.
// Walmart is the confirmed case: a frequency-capped nudge system stored in
// `localStorage.appBannerHistory` (types wifi/sticky/bottomSheet/dbQr); the
// `bottomSheet` modal fires once its per-customer count is still low. Albertsons
// shows a similar prompt.
//
// Two layers, both injected as injectedJavaScriptBeforeContentLoaded (before the
// store's own JS runs) via buildBeforeContentScript():
//   1. GENERIC, SAFE remover — a bounded MutationObserver + timed sweeps that
//      removes only elements that are BOTH overlay-positioned AND clearly an
//      app-install nudge (explicit "get the app / open in app" phrasing, or an
//      app-store link next to app wording). Gated tightly to avoid nuking real
//      modals (login, choose-store) — those never contain app-store links or
//      "get the app" copy. This is the future-proofing: if any store adds a
//      nudge later, this catches it with no store-specific work.
//   2. STORE-SPECIFIC pre-seed — where we know the store's own suppression
//      mechanism, seed it so the nudge never renders in the first place (cheaper
//      + more reliable than removing after paint). Walmart: pre-fill
//      appBannerHistory with maxed display counts so its own frequency cap skips
//      every nudge type.
//
// Applied to every real store (Walmart / Wegmans / ALDI / Albertsons-family /
// HEB / Amazon). Only the mock store is excluded.

import { WEBVIEW_FINGERPRINT_SHIM } from './webview-fingerprint-shim';

// Stores that should NOT get the suppressor (test fixture, not a real storefront).
const SUPPRESSOR_EXCLUDED = new Set(['mockstore']);

// ── Generic remover ─────────────────────────────────────────────────────────
// `${DBG}` is replaced with the RN-side __DEV__ boolean so the [nudge-kill] log
// only ships in dev builds.
const genericRemover = (dbg: boolean) => `(function () {
  var DBG = ${dbg ? 'true' : 'false'};
  var STORE_LINK = /apps\\.apple\\.com|itunes\\.apple\\.com|play\\.google\\.com/i;
  var APP_PHRASE = /get the app|open in (the )?app|shop (in|on) the app|download (our|the) app|view in (the )?app|use the app|better (in|on) the app|continue (in|on) (the )?(browser|web|mobile web)/i;
  function overlayish(el) {
    try {
      var s = getComputedStyle(el);
      var z = parseInt(s.zIndex) || 0;
      return s.position === 'fixed' || s.position === 'sticky' || z >= 900
        || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
    } catch (e) { return false; }
  }
  function isNudge(el) {
    try {
      var text = (el.innerText || '');
      if (!text || text.length > 800) return false; // banners are small; never nuke big containers
      if (APP_PHRASE.test(text)) return true;
      return STORE_LINK.test(el.innerHTML || '') && /\\bapp\\b/i.test(text);
    } catch (e) { return false; }
  }
  function restoreScroll() {
    try {
      [document.documentElement, document.body].forEach(function (n) {
        if (n && n.style && (n.style.overflow === 'hidden' || n.style.position === 'fixed')) {
          n.style.overflow = ''; n.style.position = '';
        }
      });
    } catch (e) {}
  }
  var SEL = '[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="banner" i],[class*="nudge" i],[class*="drawer" i],[class*="sheet" i],[class*="interstitial" i],[class*="smartbanner" i],[class*="appBanner" i],[id*="banner" i],[id*="app-" i]';
  function sweep() {
    try {
      var nodes = document.querySelectorAll(SEL);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (overlayish(el) && isNudge(el)) {
          var desc = el.tagName + '.' + String(el.className || '').slice(0, 40);
          try { el.remove(); } catch (e) { try { el.style.display = 'none'; } catch (e2) {} }
          restoreScroll();
          if (DBG) { try { console.log('[nudge-kill] removed ' + desc); } catch (e) {} }
        }
      }
    } catch (e) {}
  }
  // Immediate + timed sweeps (nudges often appear a beat after load).
  [0, 800, 2000, 4000, 8000].forEach(function (ms) { setTimeout(sweep, ms); });
  // And a bounded observer for dynamically-inserted nudges.
  try {
    var pending = null;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; sweep(); }, 200);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 30000);
  } catch (e) {}
})();
true;`;

// ── Store-specific pre-seeds ────────────────────────────────────────────────
// Walmart: pre-fill appBannerHistory so its own frequency cap treats every nudge
// type as already-shown-to-the-max, and bump the gep callout counter. Format
// mirrors what Walmart itself writes (captured live 2026-07-12).
const WALMART_SEED = `(function () {
  try {
    var now = Math.floor(Date.now() / 1000);
    var capped = { lastDisplayedEpochTimestamp: now, countOfNudgeDisplayedForCustomer: 99 };
    localStorage.setItem('appBannerHistory', JSON.stringify({
      wifi: capped, sticky: capped, bottomSheet: capped, dbQr: capped
    }));
    localStorage.setItem('gep-callout-nudge-display-count', '99');
  } catch (e) {}
})();
true;`;

const STORE_SEEDS: Record<string, string> = {
  walmart: WALMART_SEED,
};

/**
 * The full injectedJavaScriptBeforeContentLoaded payload for a store WebView:
 * the fingerprint shim (always) + the app-banner suppressor (for eligible
 * stores) + any store-specific nudge pre-seed. Returns just the shim for
 * excluded stores (the mock store).
 */
export function buildBeforeContentScript(storeId: string): string {
  const parts = [WEBVIEW_FINGERPRINT_SHIM];
  if (storeId && !SUPPRESSOR_EXCLUDED.has(storeId)) {
    const seed = STORE_SEEDS[storeId];
    if (seed) parts.push(seed);
    parts.push(genericRemover(typeof __DEV__ !== 'undefined' && __DEV__));
  }
  return parts.join('\n');
}
