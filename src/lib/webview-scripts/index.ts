// Store scripts registry — maps storeId → injectable WebView scripts.

import {
  HEB_URL, HEB_LOGIN_URL, HEB_CART_URL,
  CHECK_LOGIN_SCRIPT, EXTRACT_PRODUCTS_SCRIPT,
  buildAddToCartScript as hebBuildATC,
  buildSearchScript as hebBuildSearch,
  buildSearchAndAddScript as hebBuildSearchAndAdd,
} from './heb';
import { getScripts as getWalmartScripts } from './walmart';
import { getScripts as getAlbertsonsScripts, ALBERTSONS_FAMILY_IDS } from './albertsons';
import { getScripts as getAldiScripts } from './aldi';
import { getScripts as getAmazonFreshScripts } from './amazon-fresh';
import { getScripts as getWegmansScripts } from './wegmans';
import { buildExtractWorker } from './worker-search';

export interface StoreScripts {
  storeUrl: string;
  loginUrl: string;
  cartUrl: string;
  domain: string;
  appScheme?: string;
  /** Returns true if the URL is a search results page for this store. */
  isSearchUrl: (url: string) => boolean;
  /** Returns true if the URL indicates a successful login redirect. */
  isLoginSuccessUrl: (url: string) => boolean;
  /** Returns true if the URL is the store's login / sign-in page. During the
   *  login check a logged-in profile click stays on the store, so navigating
   *  here means the user is signed out — the flow shows the login webview
   *  immediately instead of waiting out the login-check timeout. Needed for
   *  stores whose login form lives behind an /authorize URL that the generic
   *  auth-redirect skip would otherwise swallow (HEB → accounts.heb.com).
   *  Defaults to a generic /login|/sign-in matcher when omitted. */
  isLoginPageUrl?: (url: string) => boolean;
  /** When true, re-inject checkLoginScript on every login-step page load that
   *  lands back on the store (not auth/sign-in URLs, which are handled earlier).
   *  Needed for stores whose login detection relies on a background poll that
   *  dies when the page reloads after the user signs in (e.g. Albertsons). */
  reinjectLoginCheckOnNav?: boolean;
  /** Injected to check if the user is logged in. Posts LOGIN_STATUS. */
  checkLoginScript: string;
  /** Injected on search results page. Posts SEARCH_RESULT with candidates. */
  extractProductsScript: string;
  /** Builds script to add a specific product to cart. Posts ADD_RESULT. */
  buildAddToCartScript: (productName: string, preference: { text: string } | null, qty: number) => string;
  /** Builds script to navigate to search results for a term. */
  buildSearchScript: (term: string) => string;
  /** Builds script to search + auto-add if match found. Posts SEARCH_AND_ADD_RESULT. */
  buildSearchAndAddScript: (term: string, qty: number, dropdown: { type: string; selectedText: string; selectedValue: string } | null) => string;
  // ── Parallel product search (optional) ──────────────────────────────────
  // A store that provides BOTH of these opts into the 5-worker parallel pool
  // for the choose-product flow: WebViewCartSheet dispatches each ingredient
  // to a hidden worker WebView loaded at getSearchUrl, injects
  // buildWorkerScript, and collects WORKER_RESULT. Omit them to stay on the
  // sequential single-WebView path.
  /** Direct search-results URL for a term (loads results without typing). */
  getSearchUrl?: (term: string) => string;
  /** Injected JS for one worker; posts WORKER_RESULT with the workerId. */
  buildWorkerScript?: (workerId: number) => string;
  /** Number of concurrent worker WebViews for this store's parallel pool.
   *  Defaults to 5. Lower it for stores with aggressive anti-bot (ALDI: 3). */
  workerCount?: number;
  /** Stagger (ms) between the initial worker dispatches for this store, to
   *  avoid N simultaneous search requests. Defaults to 0 (all at once). */
  workerStaggerMs?: number;
  /** Force the sequential single-WebView search even though getSearchUrl +
   *  buildWorkerScript are present. Used for stores whose anti-bot trips on the
   *  concurrent worker requests (ALDI). The worker scripts stay available for
   *  tests / future re-enable; they just aren't used at runtime. */
  forceSerialSearch?: boolean;
  /** Default true: navigations append a `?_t=<ts>` cache-buster. Set false for
   *  stores whose anti-bot flags that synthetic query (ALDI) — navTo then uses
   *  the clean URL + a forced reload() instead. */
  cacheBustNav?: boolean;
  /** True for SPA storefronts (ALDI/Instacart) whose search changes the URL via
   *  pushState (no reload). Such stores fire onLoadEnd multiple times for ONE
   *  route change while the injected script is still running, so the cart flow
   *  must NOT re-inject the inflight script on a same-URL onLoadEnd (that spawns
   *  a duplicate add-run that over-advances the item index and skips items). */
  spaSearch?: boolean;
}

// ── HEB adapter ──────────────────────────────────────────────────────────────

const hebScripts: StoreScripts = {
  storeUrl: HEB_URL,
  loginUrl: HEB_LOGIN_URL,
  cartUrl: HEB_CART_URL,
  domain: 'heb.com',
  appScheme: 'heb://',
  isSearchUrl: (url) => url.includes('/search'),
  // Do NOT match the OIDC callback — it must complete its redirect chain
  // to set session cookies. onLoadEnd re-injection handles post-login detection.
  isLoginSuccessUrl: () => false,
  // Logged-out profile clicks redirect to accounts.heb.com (an /authorize URL).
  // Recognize it so the login check shows the form immediately.
  isLoginPageUrl: (url) => /accounts\.heb\.com/i.test(url) || /\/my-account\/login/i.test(url),
  // After the user signs in, HEB lands back on www.heb.com. Re-run the login
  // check there so the flow continues on its own. The auth-redirect skip means
  // this only fires once the OIDC chain settles on the store (cookies set), and
  // never on the accounts.heb.com login form, so it can't fight the user.
  reinjectLoginCheckOnNav: true,
  checkLoginScript: CHECK_LOGIN_SCRIPT,
  extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
  buildAddToCartScript: hebBuildATC,
  buildSearchScript: hebBuildSearch,
  buildSearchAndAddScript: hebBuildSearchAndAdd,
  getSearchUrl: (term) => 'https://www.heb.com/search?q=' + encodeURIComponent(term),
  buildWorkerScript: (workerId) => buildExtractWorker(workerId, EXTRACT_PRODUCTS_SCRIPT),
};

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getStoreScripts(storeId: string): StoreScripts | null {
  switch (storeId) {
    case 'heb':            return hebScripts;
    case 'walmart':        return getWalmartScripts();
    case 'aldi':           return getAldiScripts();
    case 'amazon':         return getAmazonFreshScripts();
    case 'wegmans':        return getWegmansScripts();
    default:
      if (ALBERTSONS_FAMILY_IDS.includes(storeId)) {
        return getAlbertsonsScripts(storeId);
      }
      return null;
  }
}
