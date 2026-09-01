// Injectable JavaScript strings for H-E-B WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// SELECTORS ARE REMOTE-CONFIGURABLE (see ../automation-config). The literals in
// SEL_FALLBACKS ship in the binary; a config push overrides them without a
// release. Selectors must be read inside a build FUNCTION — the remote config
// arrives after this module is imported, so the script constants that carry
// selectors are functions rather than template-literal consts.


import { buildHebCartQueryFn, hebCartQueryEnabled } from './heb-cart-query';

export const HEB_URL = 'https://www.heb.com';
export const HEB_LOGIN_URL = 'https://www.heb.com/my-account/login';
export const HEB_CART_URL = 'https://www.heb.com/cart';

// same way the scripts do and counts what each selector matches in every captured
// page. It reads the real table rather than a copy precisely so the two cannot
// disagree about which selectors the store scripts depend on.
export const SEL_FALLBACKS = {
  title: '[data-qe-id="productTitle"]',
  // HEB layers sponsored/pairing carousels over the real results; only genuine
  // result tiles carry data-qe-id="productCard". See __hebFindCards below.
  productCard: '[data-qe-id="productCard"]',
  cardContainer: '[data-qe-id="productCardContainer"]',
  searchGrid: '#search_product_grid',
  legacyCard: '[data-component="product-card"], [data-qe-id="productCard"]',
  searchHeader: '#searchGridHeader',
  // Search UI. HEB opens search in a dialog on mobile, so the input is looked up
  // modal-first with a page-level fallback — a frequent breakage point, hence
  // every step of the chain is configurable.
  searchOpen: 'button[aria-label="Open search"], button[aria-label*="search" i]:not([type="submit"])',
  searchInputModal: 'dialog input[type="search"], [role="dialog"] input[type="search"], .modal input[type="search"], [class*="modal" i] input[type="search"]',
  searchInput: 'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"], input[name="search"], input[name="q"]',
  searchSubmit: 'button[type="submit"], button[aria-label*="Search" i]:not([aria-label*="Open"])',
};






// ── Login check ───────────────────────────────────────────────────────────────

/**
 * Injected on HEB page load. Posts { type: 'LOGIN_STATUS', isLoggedIn: bool }.
 */
export const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__hebLoginCheckActive) return;
  window.__hebLoginCheckActive = true;
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // Poll for the profile button (up to ~10s on a slow network, usually < 1s).
    // The page itself may not have rendered yet on a bad connection, so we wait
    // for the button rather than giving up early and reporting logged-out.
    var profileBtn = null;
    for (var pi = 0; pi < 50; pi++) {
      profileBtn = document.querySelector('button[aria-label*="account" i]')
        || document.querySelector('button[aria-label*="profile" i]');
      if (profileBtn) break;
      await wait(200);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'profile_btn',
      found: !!profileBtn,
      ariaLabel: profileBtn ? profileBtn.getAttribute('aria-label') : null
    }));

    if (!profileBtn) {
      window.__hebLoginCheckActive = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));
      return;
    }

    // Click the profile icon. Two outcomes:
    // Logged in: stays on heb.com and opens an in-page account panel that
    //   contains a "Log out" control.
    // Not logged in: navigates to accounts.heb.com (kills this script;
    //   onLoadEnd fallback in WebViewCartSheet detects the login page).
    profileBtn.click();

    // Require POSITIVE proof of login: poll for the panel's "Log out" / "Sign
    // out" control to appear (up to ~3s). NEVER infer login from the absence of
    // a redirect — a slow network can stall the logged-out redirect past our
    // wait and make a signed-out session look signed-in. If the marker never
    // appears we report logged-out and the user is shown the login webview.
    // Collect visible text INCLUDING one level of shadow DOM — HEB's account
    // panel may render inside a web component whose text document.body.innerText
    // does not see (which would make a logged-in panel look logged-out).
    function deepText() {
      var out = document.body.innerText || '';
      var hosts = document.querySelectorAll('*');
      for (var hi = 0; hi < hosts.length; hi++) {
        var sr = hosts[hi].shadowRoot;
        if (sr) { try { out += ' ' + (sr.textContent || ''); } catch (e) {} }
      }
      return out;
    }
    var LOGGED_IN_RE = /log ?out|sign ?out/;
    var loggedIn = false;
    var lastText = '';
    for (var ci = 0; ci < 40; ci++) {           // up to ~8s for the panel to render
      await wait(200);
      lastText = deepText().toLowerCase();
      if (LOGGED_IN_RE.test(lastText)) { loggedIn = true; break; }
    }

    if (!loggedIn) {
      // Diagnostic: dump what the panel actually rendered so we can pick a
      // reliable logged-in marker when the default one misses.
      var shadowHosts = 0;
      var allEls = document.querySelectorAll('*');
      for (var si = 0; si < allEls.length; si++) { if (allEls[si].shadowRoot) shadowHosts++; }
      var panels = Array.prototype.slice.call(
        document.querySelectorAll('[role="dialog"], aside, [class*="drawer" i], [class*="panel" i], [class*="account" i]'), 0, 6
      ).map(function(d) {
        return { tag: d.tagName, cls: (d.getAttribute('class') || '').slice(0, 60), text: (d.innerText || '').trim().slice(0, 220) };
      });
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'LOGIN_DEBUG', step: 'panel_miss',
        shadowHosts: shadowHosts,
        textSample: lastText.slice(0, 1500),
        panels: panels
      }));
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'panel_check', loggedIn: loggedIn }));

    // Close any panel that opened, then report the proven state.
    document.body.click();
    await wait(200);
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: loggedIn }));
  } catch(e) {
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ────────────────────────────────────────────────────────

// The DOM builders lived below: the results-page extractor, the add-to-cart
// click script, the fused search-and-add, and the in-page search that drove
// H-E-B's own header search box. Roughly 1,400 lines of selectors and waits.
//
// Deleted 2026-09-01. H-E-B is a rail store: it searches and adds by asking
// the store's API from a signed-in WebView (heb-network-search.ts), which is
// both faster and checkable. What is left here is what a rail still needs —
// the URLs, the login check, and the selector fallbacks that check uses.
