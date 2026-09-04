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


// ── Search + auto-add (sequential AND parallel-worker) ───────────────────────

// ── Navigate to search (sequential single-WebView path) ──────────────────────

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
    getSearchUrl: (term: string) => MOCK_STORE_URL + '/search?q=' + encodeURIComponent(term),
    // Deterministic DOM, so no hydration race and no page-identity guard: this
    // store is a fixture we serve ourselves. Moved here from cart-count.ts on
    // 2026-09-04 with Amazon Fresh's.
    cartPage: {
      url: MOCK_STORE_URL + '/cart',
      countScript: MOCKSTORE_CART_PAGE_SCRIPT,
    },
  };
}

const MOCKSTORE_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  var lines = [];
  for (var i = 0; i < 20; i++) {
    lines = Array.prototype.slice.call(document.querySelectorAll('.mock-cart-line'));
    if (lines.length > 0 || document.querySelector('#mock-cart-lines[data-count="0"]')) break;
    await wait(150);
  }
  var count = 0, items = [];
  for (var j = 0; j < lines.length; j++) {
    var nmEl = lines[j].querySelector('.mock-cart-name');
    var nm = nmEl ? norm(nmEl.textContent) : '';
    if (!nm) continue;
    var qEl = lines[j].querySelector('.mock-cart-qty');
    var q = parseInt(qEl ? norm(qEl.textContent) : '0', 10);
    if (isNaN(q) || q < 1) q = 1;
    count += q;
    items.push({ name: nm, qty: q });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items }));
})(); true;`;
