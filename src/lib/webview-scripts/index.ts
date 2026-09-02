// Store scripts registry — maps storeId → injectable WebView scripts.

import {
  HEB_URL, HEB_LOGIN_URL, HEB_CART_URL,
  CHECK_LOGIN_SCRIPT, buildExtractProductsScript as hebBuildExtract,
  buildAddToCartScript as hebBuildATC,
  buildSearchScript as hebBuildSearch,
  buildSearchAndAddScript as hebBuildSearchAndAdd,
} from './heb';
import { getScripts as getWalmartScripts } from './walmart';
import { getScripts as getAlbertsonsScripts, ALBERTSONS_FAMILY_IDS } from './albertsons';
import { getInstacartScriptsFor, INSTACART_STORE_IDS } from './instacart';
import { getScripts as getAmazonFreshScripts } from './amazon-fresh';
import { getScripts as getWegmansScripts } from './wegmans';
import { getScripts as getMockStoreScripts, MOCK_STORE_ENABLED } from './mockstore';
import { buildExtractWorker, buildPresearchWorker, buildSearchAndAddWorker } from './worker-search';
import { storeConfig, searchUrlFor, isStoreEnabled } from '../automation-config';
import {
  SelectorSurface,
  albertsonsSelectorSurface,
  selectorSurfaceFor,
  withSelectorProbe,
} from '../selector-health';

export interface StoreScripts {
  storeUrl: string;
  /**
   * A QUIET page on the same origin, for stores that have a network rail.
   *
   * The rail makes plain HTTPS calls. The only thing it needs from a WebView is
   * the origin's cookies -- it reads no DOM, clicks nothing, and does not care
   * what is on screen. Parking it on the full storefront homepage means those
   * calls share a renderer with the site's own Angular + Next + advertising +
   * bot-defence bundles.
   *
   * MEASURED 2026-09-02 from inside the injected script, on the homepage:
   *   worstTickMs 47269   a 1-second interval firing 47 SECONDS late
   *   vis 'visible'       screen on, app foreground, not display sleep
   * while the requests themselves, when they got to run, took 288-758ms.
   *
   * So the rail is not slow; it is queued behind somebody else's page. This is
   * the same origin -- same cookies, same session -- with none of that.
   */
  railUrl?: string;
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
  buildAddToCartScript: (productName: string, preference: { text: string } | null, qty: number, targetWeightLb?: number | null) => string;
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
  // ── The other two pools' worker scripts ─────────────────────────────────
  // These are `buildPresearchWorker` / `buildSearchAndAddWorker` already applied
  // to this store's own scripts. They exist as FIELDS, rather than being composed
  // at the call site in WebViewCartSheet the way they used to be, because
  // composition order is load-bearing and having it happen in two places is what
  // let the two of them silently diverge (MEAL-31).
  //
  // The wrappers emit their own IIFE and interpolate the store script AFTER it.
  // Composing at the call site meant wrapping an ALREADY-PROBED script, which put
  // the probe's postMessage hook on TOP of the wrapper's — and the wrapper
  // swallows what it does not name, so every sample from the pre-search and
  // parallel-add pools was discarded in the page. On the four stores those pools
  // serve that is the add path, i.e. where addBtn / incBtn / stepperA live.
  //
  // Built here from the UNPROBED script, so the probe is prepended to the
  // finished worker and its hook sits underneath the wrapper's. See
  // withSelectorProbes, and the registry-driven ordering tests in
  // tests/unit/selectorHealth.test.ts — which now compose exactly this way.
  /** One pre-search parking worker's script. Posts WORKER_RESULT in two phases. */
  buildPresearchWorkerScript?: (workerId: number) => string;
  /** One parallel-add worker's script. Posts WORKER_RESULT with the add verdict. */
  buildAddWorkerScript?: (workerId: number) => string;
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

// A FUNCTION, not a module-level const: the injected scripts interpolate
// selectors from the remote automation config, which loads after this module is
// imported. Building the adapter per call means a config push takes effect on the
// next cart run instead of requiring an app restart.
function getHebScripts(): StoreScripts {
  const cfg = storeConfig('heb');
  const extract = hebBuildExtract();
  return {
  storeUrl: cfg.storeUrl ?? HEB_URL,
  loginUrl: cfg.loginUrl ?? HEB_LOGIN_URL,
  cartUrl: cfg.cartUrl ?? HEB_CART_URL,
  domain: 'heb.com',
  // Opens the My H-E-B app (com.heb.myheb). HEB exposes no cart-specific deep
  // link, so this lands on the app's home — still better than the website. The
  // 'heb://' scheme was wrong (copied the Kroger-family naming; HEB isn't Kroger).
  appScheme: 'myheb://',
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
  extractProductsScript: extract,
  buildAddToCartScript: hebBuildATC,
  buildSearchScript: hebBuildSearch,
  buildSearchAndAddScript: hebBuildSearchAndAdd,
  getSearchUrl: (term) =>
    searchUrlFor('heb', term, 'https://www.heb.com/search?q=' + encodeURIComponent(term)),
  buildWorkerScript: (workerId) => buildExtractWorker(workerId, extract),
  workerCount: cfg.workerCount,
  workerStaggerMs: cfg.workerStaggerMs,
  forceSerialSearch: cfg.forceSerialSearch,
  cacheBustNav: cfg.cacheBustNav,
  spaSearch: cfg.spaSearch,
  };
}

// ── Worker composition ───────────────────────────────────────────────────────

/**
 * Attach the pre-search and parallel-add worker scripts.
 *
 * These used to be composed in WebViewCartSheet, from the scripts it had already
 * been handed. That is what broke MEAL-31: the scripts it had were probed, and
 * the wrappers put their own IIFE FIRST, so the composed worker read
 * `wrapper(probe + body)` — the probe's hook on top of the wrapper's rather than
 * underneath it, which is the one arrangement the wrapper's swallow discards. The
 * parallel-SEARCH worker was unaffected only because its adapter happens to
 * compose it before the probe is applied.
 *
 * Composing all of them at this one seam is what makes "the probe goes on the
 * FINISHED worker" a property of the registry instead of a rule three call sites
 * have to remember. See StoreScripts.buildPresearchWorkerScript.
 */
function attachWorkerScripts(s: StoreScripts): StoreScripts {
  return {
    ...s,
    buildPresearchWorkerScript: (workerId: number) =>
      buildPresearchWorker(workerId, s.extractProductsScript),
    // Placeholder params: one fixed search-and-add script is built per worker and
    // the real term/qty/preference arrive in the page URL's #mealio hash at
    // runtime. Only stores whose buildSearchAndAddScript reads that hash support
    // parallel add; the others are gated out by beginSearchFlow, not here.
    buildAddWorkerScript: (workerId: number) =>
      buildSearchAndAddWorker(workerId, s.buildSearchAndAddScript('', 1, null)),
  };
}

// ── Selector health (MEAL-31) ────────────────────────────────────────────────

/**
 * Prepend the selector probe to every script this adapter hands the WebView.
 *
 * Done HERE, at the one seam every store's scripts pass through, rather than in
 * each of the six adapters: a store added later is measured without anyone
 * remembering to opt it in, and there is a single place to read to know what is
 * instrumented. The prefix is a no-op only for a script that interpolates none of
 * the store's configured selectors — which today is the mock store, and Amazon
 * Fresh's search-navigation script. The other five stores' search-navigation
 * scripts DO name a selector or two and so do carry a probe (~1.3 KB); they
 * navigate away immediately and the probe dies with the page, so it samples
 * nothing and costs only the injected bytes.
 *
 * PREPENDED, not appended, and that is load-bearing rather than stylistic — see
 * the module header of selector-health.ts. The parallel-pool wrappers install
 * postMessage overrides that swallow messages they do not recognise, and running
 * first is what puts the probe's hook UNDER them, next to the native bridge.
 * That only holds if what is wrapped is the FINISHED worker, which is why
 * attachWorkerScripts runs before this and not after.
 *
 * The builder fields are wrapped lazily so a script is only scanned when it is
 * actually built. Nothing here can throw: withSelectorProbe returns the original
 * script on any failure.
 */
function withSelectorProbes(surface: SelectorSurface | null, s: StoreScripts): StoreScripts {
  if (!surface) return s;
  const wrap = (script: string) => withSelectorProbe(surface, script);
  const wrapWorker = (build: ((workerId: number) => string) | undefined) =>
    build ? (workerId: number) => wrap(build(workerId)) : undefined;
  return {
    ...s,
    checkLoginScript: wrap(s.checkLoginScript),
    extractProductsScript: wrap(s.extractProductsScript),
    buildAddToCartScript: (name, pref, qty, weight) => wrap(s.buildAddToCartScript(name, pref, qty, weight)),
    buildSearchScript: (term) => wrap(s.buildSearchScript(term)),
    buildSearchAndAddScript: (term, qty, dd) => wrap(s.buildSearchAndAddScript(term, qty, dd)),
    buildWorkerScript: wrapWorker(s.buildWorkerScript),
    buildPresearchWorkerScript: wrapWorker(s.buildPresearchWorkerScript),
    buildAddWorkerScript: wrapWorker(s.buildAddWorkerScript),
  };
}

/** Everything the registry does to a store's raw scripts, in the order it
 *  matters: compose the workers, THEN probe the finished text. */
function finish(surface: SelectorSurface | null, s: StoreScripts): StoreScripts {
  return withSelectorProbes(surface, attachWorkerScripts(s));
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getStoreScripts(storeId: string): StoreScripts | null {
  // Remote kill switch. Returning null makes the cart engine treat the store as
  // unsupported (the same path as an unknown storeId), which surfaces the normal
  // "store unavailable" UI. This is the escape hatch for a storefront that has
  // changed so much our scripts would do harm rather than nothing — it disables a
  // single store in minutes instead of waiting on App Store review.
  //
  // The Albertsons family shares one config entry, so the switch is checked
  // against that shared key rather than each of the 15 banner ids.
  const configKey = ALBERTSONS_FAMILY_IDS.includes(storeId) ? 'albertsons' : storeId;
  if (!isStoreEnabled(configKey)) return null;

  // Instacart Storefront banners (ALDI, and any future tenant) are served by one
  // parameterized adapter, so a new banner is a registry entry rather than a case
  // here. Each keeps its own config key — unlike the Albertsons family, these are
  // separate retailers whose selectors can drift apart.
  if (INSTACART_STORE_IDS.includes(storeId)) {
    const instacart = getInstacartScriptsFor(storeId);
    return instacart && finish(selectorSurfaceFor(storeId), instacart);
  }

  switch (storeId) {
    case 'heb':     return finish(selectorSurfaceFor(storeId), getHebScripts());
    case 'walmart': return finish(selectorSurfaceFor(storeId), getWalmartScripts());
    case 'amazon':  return finish(selectorSurfaceFor(storeId), getAmazonFreshScripts());
    case 'wegmans': return finish(selectorSurfaceFor(storeId), getWegmansScripts());
    // Dev/e2e only: the deterministic mock store for Maestro. Returns null in
    // production (flag unset) so it can never be reached even if a meal carries it.
    // Deliberately unprobed: it has no automation-config selector table, and a
    // deterministic fixture store has no drift to catch.
    case 'mockstore':      return MOCK_STORE_ENABLED ? finish(null, getMockStoreScripts()) : null;
    default:
      if (ALBERTSONS_FAMILY_IDS.includes(storeId)) {
        // One selector table serves all 15 banners, so the surface is the shared
        // 'albertsons' one whichever banner is running — the same key the kill
        // switch above is checked against.
        return finish(albertsonsSelectorSurface(), getAlbertsonsScripts(storeId));
      }
      return null;
  }
}
