// Mock-store WebView adapter — drives the deterministic fake storefront served
// by tests/mock-store/server.js. Lets Maestro exercise the full add-to-cart
// orchestration (login → search → choose → add → cart-count confirm → snapshot →
// reconcile → skip → parallel) without a real store. Registered as store id
// `mockstore` and surfaced in the store list ONLY in dev/test builds.
//
// The mock DOM is ours, so these selectors are stable (no real-store drift):
//   <body data-logged-in="true">                       login state
//   .mock-product[data-name][data-price][data-oos]      a search result tile
//     button[data-qe="add"][data-name][data-failadd]    its add button
//   #mock-cart-count                                     header cart badge total
//   .mock-cart-line[data-name] .mock-cart-qty           a cart line on /cart

import { buildExtractWorker } from './worker-search';

// The mock store is hosted standalone on Vercel (repo: mealio_mock_store) so the
// WebView loads a real remote https site. Point at the deployment via
// EXPO_PUBLIC_MOCK_STORE_URL (set in the ios-simulator EAS profile / a local .env).
export const MOCK_STORE_URL = process.env.EXPO_PUBLIC_MOCK_STORE_URL || 'https://mealiomockstore.vercel.app';

// Host (for the StoreScripts.domain match), derived from the URL.
const MOCK_STORE_HOST = MOCK_STORE_URL.replace(/^https?:\/\//, '').split('/')[0];

// Available only in dev and the dedicated e2e build (EXPO_PUBLIC_E2E=1). The
// production build never sets the flag, so the mock store is excluded there.
export const MOCK_STORE_ENABLED =
  (typeof __DEV__ !== 'undefined' && __DEV__) || process.env.EXPO_PUBLIC_E2E === '1';

// ── Login ──────────────────────────────────────────────────────────────────
const CHECK_LOGIN_SCRIPT = `(function() {
  var li = !!(document.body && document.body.getAttribute('data-logged-in') === 'true');
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: li }));
})(); true;`;

// ── Extract candidates ───────────────────────────────────────────────────────
const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var cards = [];
  for (var i = 0; i < 20; i++) {
    cards = Array.prototype.slice.call(document.querySelectorAll('.mock-product'));
    if (cards.length > 0 || document.querySelector('.mock-no-results')) break;
    await wait(150);
  }
  var candidates = cards.map(function(c) {
    return {
      productName: c.getAttribute('data-name') || '',
      price: c.getAttribute('data-price') || '',
      outOfStock: c.getAttribute('data-oos') === 'true',
      preferences: null,
    };
  });
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})(); true;`;

// ── Helpers shared by the add scripts ────────────────────────────────────────
const ADD_HELPERS = `
  function __wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __cartCount() { var el = document.getElementById('mock-cart-count'); return el ? parseInt(el.textContent || '-1', 10) : -1; }
  async function __waitForCartIncrease(prev, ticks) {
    if (prev < 0) { await __wait(1200); return true; }
    for (var w = 0; w < ticks; w++) { if (__cartCount() > prev) return true; await __wait(150); }
    return false;
  }
  function __findCard(name) {
    var cs = document.querySelectorAll('.mock-product');
    for (var i = 0; i < cs.length; i++) { if (cs[i].getAttribute('data-name') === name) return cs[i]; }
    return null;
  }
  async function __clickAddQty(card, qty) {
    var btn = card.querySelector('button[data-qe="add"]');
    if (!btn) return { ok: false, reason: 'no_button' };
    var before = __cartCount();
    for (var j = 0; j < qty; j++) { btn.click(); await __wait(250); }
    var ok = await __waitForCartIncrease(before, 40);
    return { ok: ok, reason: ok ? null : 'cart_not_incremented' };
  }
`;

// ── Add-to-cart (review/choose flow) ─────────────────────────────────────────
function buildAddToCartScript(productName: string, _preference: { text: string } | null, qty: number): string {
  return `(async function() {
  ${ADD_HELPERS}
  var TARGET = ${JSON.stringify(productName)};
  var QTY = ${qty};
  var card = null;
  for (var i = 0; i < 20; i++) { card = __findCard(TARGET); if (card) break; await __wait(150); }
  if (!card) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' })); return; }
  var r = await __clickAddQty(card, QTY);
  window.ReactNativeWebView.postMessage(JSON.stringify(r.ok
    ? { type: 'ADD_RESULT', success: true, productName: TARGET }
    : { type: 'ADD_RESULT', success: false, reason: r.reason, productName: TARGET }));
})(); true;`;
}

// ── Search + auto-add (sequential AND parallel-worker) ───────────────────────
function buildSearchAndAddScript(
  term: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
): string {
  return `(async function() {
  ${ADD_HELPERS}
  var TERM = ${JSON.stringify(term)};
  var QTY = ${qty};
  // Worker mode: term/qty ride in the URL hash (#mealio=<json>), server-invisible.
  if (location.hash && location.hash.indexOf('#mealio=') === 0) {
    try { var mq = JSON.parse(decodeURIComponent(location.hash.slice(8))); if (mq.term) TERM = mq.term; if (typeof mq.qty === 'number') QTY = mq.qty; } catch (e) {}
  }
  var cards = [];
  for (var i = 0; i < 25; i++) {
    cards = Array.prototype.slice.call(document.querySelectorAll('.mock-product'));
    if (cards.length > 0 || document.querySelector('.mock-no-results')) break;
    await __wait(150);
  }
  var candidates = cards.map(function(c) {
    return { productName: c.getAttribute('data-name') || '', price: c.getAttribute('data-price') || '', outOfStock: c.getAttribute('data-oos') === 'true', preferences: null };
  });
  var card = __findCard(TERM);   // exact match → auto-add; else hand back candidates
  if (!card) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: candidates.length ? 'low_confidence' : 'no_results', candidates: candidates })); return; }
  var r = await __clickAddQty(card, QTY);
  // Settle so the add request flushes before the pool re-navigates this worker.
  if (r.ok && location.hash && location.hash.indexOf('#mealio=') === 0) await __wait(300);
  window.ReactNativeWebView.postMessage(JSON.stringify(r.ok
    ? { type: 'SEARCH_AND_ADD_RESULT', success: true, productName: TERM }
    : { type: 'SEARCH_AND_ADD_RESULT', success: false, reason: r.reason, productName: TERM, candidates: candidates }));
})(); true;`;
}

// ── Navigate to search (sequential single-WebView path) ──────────────────────
function buildSearchScript(term: string): string {
  return `(function() { window.location.href = ${JSON.stringify(MOCK_STORE_URL + '/search?q=')} + encodeURIComponent(${JSON.stringify(term)}); })(); true;`;
}

export function getScripts() {
  return {
    storeUrl: MOCK_STORE_URL + '/',
    loginUrl: MOCK_STORE_URL + '/login',
    cartUrl: MOCK_STORE_URL + '/cart',
    domain: MOCK_STORE_HOST,
    isSearchUrl: (url: string) => url.includes('/search'),
    isLoginSuccessUrl: () => false,
    // Logged-out store pages 302 to /login; recognize it so the flow shows the
    // login webview, and re-run the check after sign-in lands back on the store.
    isLoginPageUrl: (url: string) => url.includes('/login'),
    reinjectLoginCheckOnNav: true,
    checkLoginScript: CHECK_LOGIN_SCRIPT,
    extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
    buildAddToCartScript,
    buildSearchScript,
    buildSearchAndAddScript,
    getSearchUrl: (term: string) => MOCK_STORE_URL + '/search?q=' + encodeURIComponent(term),
    buildWorkerScript: (workerId: number) => buildExtractWorker(workerId, EXTRACT_PRODUCTS_SCRIPT),
  };
}
