import { storeConfig, searchUrlFor } from '../automation-config';
// Injectable JavaScript strings for Amazon Fresh WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// Ported from ~/mealio_ext/content-amazon-fresh.js — same selectors and logic,
// adapted to the StoreScripts interface used by the store registry.
//
// Amazon Fresh has two completely different card layouts:
//   TYPE A — Storefront carousel  (e.g. /fmc/storefront/fresh)
//   TYPE B — Search results       (e.g. /s?k=...&i=amazonfresh)
// Both types use lazy rendering that requires polling for elements.


const AMAZON_URL = 'https://www.amazon.com/fresh';
const AMAZON_LOGIN_URL = 'https://www.amazon.com/ap/signin';
const AMAZON_CART_URL = 'https://www.amazon.com/cart';
const AMAZON_DOMAIN = 'amazon.com';

// ── Login check ─────────────────────────────────────────────────────────────


const SELECTOR_KEY = 'amazon';

// Compiled-in selector fallbacks; the remote automation config overrides them so
// an Amazon Fresh redesign is a config push rather than an App Store release.
// Amazon serves TWO distinct search-result layouts (the Fresh "qs-widget" cards
// and the generic search-result cards), so most selectors come in A/B pairs and
// both must be configurable. Read only inside a build function.
// Exported for the fixture drift census (MEAL-30) — see the note on heb.ts's copy.
export const SEL_FALLBACKS = {
  cardA: '[data-csa-c-item-type="asin"]',
  nameA: '.a-truncate-full.a-offscreen',
  atcWrapperA: '.qs-atc-plus',
  addBtnA: 'button[aria-label^="Add to Cart,"]',
  stepperA: '[id^="qs-widget-stepper-"]',
  qtyDisplayA: '.qs-widget-dropdown-flex-wrapper button[aria-label^="Current quantity"]',
  incBtnA: '.qs-widget-increment-button-flex-wrapper input[aria-label^="Add "]',
  cardB: '[data-component-type="s-search-result"]',
  nameB: 'h2',
  atcContainerB: 'span[data-action="fresh-add-to-cart"]',
  stepperB: 'fieldset[data-a-component="stepper"]',
  qtyDisplayB: 'span[data-a-selector="value"]',
  incBtnB: 'button[data-action="a-stepper-increment"]',
  atcBtnBMobile: 'button[aria-label="Add to cart"]',
  incBtnBMobile: 'span[data-action="qs-widget-increment-decl"]',
};


function buildCheckLoginScript(): string {
  return `(async function() {
  if (window.__amazonLoginCheckActive) return;
  window.__amazonLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    await wait(1500);

    // True positive login detection using DOM structure.
    // When logged in, the greeting element has class "nav-greeting-recognized"
    // and contains a child <a id="nav-greeting-name"> with the user's name.
    var greetingEl = document.getElementById('nav-logobar-greeting');
    var isRecognized = greetingEl && greetingEl.classList.contains('nav-greeting-recognized');
    var nameLink = document.getElementById('nav-greeting-name');

    var isLoggedIn = !!(isRecognized && nameLink);

    window.__amazonLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  } catch(e) {
    window.__amazonLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;
}

// ── Product extraction ──────────────────────────────────────────────────────



// ── Add to cart ──────────────────────────────────────────────────────────────


// ── Search navigation ────────────────────────────────────────────────────────


// ── Search + auto-add ────────────────────────────────────────────────────────


// ── Export ────────────────────────────────────────────────────────────────────

export function getScripts() {
  const cfg = storeConfig(SELECTOR_KEY);
  return {
    storeUrl: cfg.storeUrl ?? AMAZON_URL,
    loginUrl: cfg.loginUrl ?? AMAZON_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? AMAZON_CART_URL,
    // The Amazon Shopping app's URL-carrying scheme opens the cart inside the app.
    // handleOpenCart tries this first, then falls back to the https cartUrl in the
    // browser if the app isn't installed. (Bare amazon:// / amzn:// don't work.)
    appScheme: 'com.amazon.mobile.shopping.web://amazon.com/gp/cart/view.html',
    domain: AMAZON_DOMAIN,
    isSearchUrl: (url: string) => url.includes('/s?') && url.includes('amazon.com'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('amazon.com') && !url.includes('/ap/') && !url.includes('/ax/') && !url.includes('openid.'),
    checkLoginScript: buildCheckLoginScript(),
    getSearchUrl: (term: string) =>
      searchUrlFor(SELECTOR_KEY, term,
        'https://www.amazon.com/s?k=' + encodeURIComponent(term) + '&i=amazonfresh'),
    cacheBustNav: cfg.cacheBustNav,
  };
}
