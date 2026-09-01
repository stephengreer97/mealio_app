// Injectable JavaScript strings for Walmart WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// Ported from ~/mealio_ext/content-walmart.js — same selectors and logic,
// adapted to the StoreScripts interface used by the store registry.

import type { StoreScripts } from './index';
import { storeConfig, searchUrlFor } from '../automation-config';

const WALMART_URL = 'https://www.walmart.com/grocery';
const WALMART_LOGIN_URL = 'https://www.walmart.com/account/login';
const WALMART_CART_URL = 'https://www.walmart.com/cart';
const WALMART_DOMAIN = 'walmart.com';

const SELECTOR_KEY = 'walmart';

// ── Shared selectors ────────────────────────────────────────────────────────
// Compiled-in fallbacks; the live values come from the remote automation config
// so a Walmart redesign is a config push rather than an App Store release. Must
// be read INSIDE a build function — the remote config lands after module import,
// so a module-scope capture would freeze these fallbacks forever. That is why the
// script constants below are functions rather than template-literal consts.
// Exported for the fixture drift census (MEAL-30) — see the note on heb.ts's copy.
export const SEL_FALLBACKS = {
  card: '[data-automation-id="product"], [data-item-id]',
  title: '[data-automation-id="product-title"], [data-automation-id="name"]',
  addBtn: '[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]',
  incBtn: '[data-testid="quantity-stepper-inc-button"]',
};


// ── Login check ─────────────────────────────────────────────────────────────

// Click-based detection: open the hamburger menu and read the slide-out
// drawer's structure. Logged-out shows a "Sign in or create account" button
// (we click it, which navigates to /account/login; onLoadEnd then transitions
// the WebViewCartSheet to step='login'). Logged-in shows a "Hi, <name>" greeting.
// We post heavy LOGIN_DEBUG payloads so we can iterate on selectors as we test.
const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__walmartLoginCheckActive) return;
  window.__walmartLoginCheckActive = true;
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function post(type, data) {
    try {
      var payload = { type: type };
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } catch (_) {}
  }
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function summarize(el, max) {
    if (!el) return null;
    return {
      tag: el.tagName,
      aria: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      id: el.id || null,
      cls: (el.getAttribute('class') || '').slice(0, 120),
      dataTestId: el.getAttribute('data-testid'),
      href: el.getAttribute('href'),
      text: (el.textContent || '').trim().slice(0, max || 80)
    };
  }
  try {
    post('LOGIN_DEBUG', { step: 'start', url: window.location.href, ua: navigator.userAgent.slice(0, 120) });

    // ── 1. Find and click hamburger ──────────────────────────────────────
    // Walmart's mobile site renders the SPA shell late — poll up to ~4s.
    var hamburger = null;
    var hamburgerSelectors = [
      'button[aria-label*="department" i]',
      'button[aria-label="Menu"]',
      'button[aria-label*="menu" i]',
      'button[data-testid*="menu" i]',
      'button[id*="menu" i]',
      'header button[aria-haspopup]',
      'header [role="button"][aria-label*="menu" i]'
    ];
    for (var pi = 0; pi < 20; pi++) {
      for (var si = 0; si < hamburgerSelectors.length; si++) {
        var found = document.querySelector(hamburgerSelectors[si]);
        if (found && isVisible(found)) { hamburger = found; break; }
      }
      if (hamburger) break;
      await wait(200);
    }

    if (!hamburger) {
      // Dump candidate header buttons so we can adjust selectors next iteration.
      var headerBtns = Array.from(document.querySelectorAll('header button, header a, nav button, [class*="header" i] button'))
        .slice(0, 30).map(function(b) { return summarize(b, 60); });
      post('LOGIN_DEBUG', { step: 'no_hamburger', headerBtns: headerBtns });
      window.__walmartLoginCheckActive = false;
      post('LOGIN_STATUS', { isLoggedIn: false });
      return;
    }

    post('LOGIN_DEBUG', { step: 'hamburger_found', el: summarize(hamburger, 60) });
    hamburger.click();
    await wait(1500);

    // ── 2. Locate the opened menu container ──────────────────────────────
    var menuSelectors = [
      '[role="dialog"][aria-hidden="false"]',
      '[role="dialog"]',
      'aside[aria-hidden="false"]',
      'aside',
      '[role="menu"]',
      '[class*="drawer" i]:not([aria-hidden="true"])',
      '[class*="sidebar" i]:not([aria-hidden="true"])',
      'nav[aria-label*="menu" i]'
    ];
    var menu = null;
    for (var msi = 0; msi < menuSelectors.length; msi++) {
      var m = document.querySelector(menuSelectors[msi]);
      if (m && isVisible(m)) { menu = m; break; }
    }

    var scope = menu || document.body;
    var menuText = (scope.innerText || '').slice(0, 1500);
    var interactive = Array.from(scope.querySelectorAll('button, a'))
      .filter(isVisible).slice(0, 50);
    var buttonsDump = interactive.map(function(b) { return summarize(b, 100); });

    post('LOGIN_DEBUG', {
      step: 'menu_opened',
      menuFound: !!menu,
      menuSelector: menu ? menu.tagName + (menu.getAttribute('class') ? '.' + menu.getAttribute('class').slice(0, 60) : '') : null,
      menuTextSample: menuText,
      buttonCount: interactive.length,
      buttons: buttonsDump
    });

    // ── 3. Look for the two indicators ───────────────────────────────────
    var signInEl = null;
    for (var bi = 0; bi < interactive.length; bi++) {
      var bt = (interactive[bi].textContent || '').trim();
      if (/sign in or create account/i.test(bt)) { signInEl = interactive[bi]; break; }
    }
    var hasGreeting = /Hi,\\s*\\S/.test(menuText);

    post('LOGIN_DEBUG', {
      step: 'menu_scan',
      signInFound: !!signInEl,
      signInText: signInEl ? (signInEl.textContent || '').trim().slice(0, 80) : null,
      hasGreeting: hasGreeting
    });

    // ── 4. Decide ────────────────────────────────────────────────────────
    if (!signInEl && hasGreeting) {
      // Logged in — close menu and report.
      document.body.click();
      await wait(200);
      window.__walmartLoginCheckActive = false;
      post('LOGIN_STATUS', { isLoggedIn: true });
      return;
    }

    if (signInEl && !hasGreeting) {
      // Not logged in — click sign-in. Walmart navigates to /account/login,
      // killing this script; onLoadEnd catches the login URL and shows it.
      post('LOGIN_DEBUG', { step: 'clicking_signin' });
      signInEl.click();
      window.__walmartLoginCheckActive = false;
      post('LOGIN_STATUS', { isLoggedIn: false });
      return;
    }

    // Ambiguous (both or neither) — default to not logged in so we surface
    // a login attempt rather than silently failing.
    post('LOGIN_DEBUG', { step: 'ambiguous_default_logged_out', signInFound: !!signInEl, hasGreeting: hasGreeting });
    window.__walmartLoginCheckActive = false;
    post('LOGIN_STATUS', { isLoggedIn: false });
  } catch(e) {
    window.__walmartLoginCheckActive = false;
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) })); } catch (_) {}
  }
})();true;`;

// ── Product extraction ──────────────────────────────────────────────────────


// ── Add to cart ─────────────────────────────────────────────────────────────


// ── Search navigation ───────────────────────────────────────────────────────


// ── Search and add ──────────────────────────────────────────────────────────


// ── Export ───────────────────────────────────────────────────────────────────

export function getScripts(): StoreScripts {
  const cfg = storeConfig(SELECTOR_KEY);
  const fallbackSearchUrl = (term: string) =>
    'https://www.walmart.com/search?q=' + encodeURIComponent(term);

  return {
    storeUrl: cfg.storeUrl ?? WALMART_URL,
    loginUrl: cfg.loginUrl ?? WALMART_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? WALMART_CART_URL,
    domain: WALMART_DOMAIN,
    isSearchUrl: (url: string) => url.includes('walmart.com/search'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('walmart.com') && !url.includes('/account/login') && !url.includes('/sign-in'),
    checkLoginScript: CHECK_LOGIN_SCRIPT,
    getSearchUrl: (term: string) => searchUrlFor(SELECTOR_KEY, term, fallbackSearchUrl(term)),
    cacheBustNav: cfg.cacheBustNav,
  };
}
