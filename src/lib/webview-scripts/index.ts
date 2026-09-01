// Store scripts registry — maps storeId → injectable WebView scripts.

import {
  HEB_URL, HEB_LOGIN_URL, HEB_CART_URL,
  CHECK_LOGIN_SCRIPT,
} from './heb';
import { getScripts as getWalmartScripts } from './walmart';
import { getScripts as getAlbertsonsScripts, ALBERTSONS_FAMILY_IDS } from './albertsons';
import { getInstacartScriptsFor, INSTACART_STORE_IDS } from './instacart';
import { getScripts as getAmazonFreshScripts } from './amazon-fresh';
import { getScripts as getWegmansScripts } from './wegmans';
import { getScripts as getMockStoreScripts, MOCK_STORE_ENABLED } from './mockstore';
import { storeConfig, searchUrlFor, isStoreEnabled } from '../automation-config';
import {
  SelectorSurface,
  albertsonsSelectorSurface,
  selectorSurfaceFor,
  withSelectorProbe,
} from '../selector-health';

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
  // ── Parallel product search (optional) ──────────────────────────────────
  // A store that provides BOTH of these opts into the 5-worker parallel pool
  // for the choose-product flow: WebViewCartSheet dispatches each ingredient
  // to a hidden worker WebView loaded at getSearchUrl, injects
  // buildWorkerScript, and collects WORKER_RESULT. Omit them to stay on the
  // sequential single-WebView path.
  /** Direct search-results URL for a term (loads results without typing). */
  getSearchUrl?: (term: string) => string;
  /** Default true: navigations append a `?_t=<ts>` cache-buster. Set false for
   *  stores whose anti-bot flags that synthetic query (ALDI) — navTo then uses
   *  the clean URL + a forced reload() instead. */
  cacheBustNav?: boolean;
}

// ── HEB adapter ──────────────────────────────────────────────────────────────

// A FUNCTION, not a module-level const: the injected scripts interpolate
// selectors from the remote automation config, which loads after this module is
// imported. Building the adapter per call means a config push takes effect on the
// next cart run instead of requiring an app restart.
function getHebScripts(): StoreScripts {
  const cfg = storeConfig('heb');
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
  getSearchUrl: (term) =>
    searchUrlFor('heb', term, 'https://www.heb.com/search?q=' + encodeURIComponent(term)),
  cacheBustNav: cfg.cacheBustNav,
  };
}

// Worker composition lived here: it attached the pre-search and parallel-add
// worker scripts to every adapter at one seam, so that "the probe goes on the
// FINISHED worker" was a property of the registry rather than a rule three call
// sites had to remember (MEAL-31). There are no workers now.

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
  // The login check is the only script left to probe. The workers it also
  // wrapped are gone, and so is every extractor and add script the probe was
  // built to watch for selector drift (MEAL-31) — there are no selectors on a
  // rail, and an assisted store is driven by the user, who can see the page.
  return { ...s, checkLoginScript: withSelectorProbe(surface, s.checkLoginScript) };
}

/** Everything the registry does to a store's raw scripts. */
function finish(surface: SelectorSurface | null, s: StoreScripts): StoreScripts {
  return withSelectorProbes(surface, s);
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
