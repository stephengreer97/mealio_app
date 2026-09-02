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
  };
}
