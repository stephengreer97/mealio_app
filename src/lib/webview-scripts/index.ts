// Store scripts registry — maps storeId → injectable WebView scripts.

import { getScripts as getHebScripts } from './heb';
import { getScripts as getWalmartScripts } from './walmart';
import { getScripts as getAlbertsonsScripts, ALBERTSONS_FAMILY_IDS } from './albertsons';
import { getInstacartScriptsFor, INSTACART_STORE_IDS } from './instacart';
import { getScripts as getWegmansScripts } from './wegmans';
import { getScripts as getMockStoreScripts, MOCK_STORE_ENABLED } from './mockstore';
import { isStoreEnabled } from '../automation-config';

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
  /**
   * Injected to check if the user is signed in. Posts LOGIN_STATUS.
   *
   * OPTIONAL, and absent on every store that has a network rail: there, the
   * rail's own session probe is the answer, and a second opinion read off the
   * page is how a signed-in user gets shown a sign-in wall.
   *
   * Nothing in production carries one any more: Amazon Fresh was the last, and
   * it was dropped with the store on 2026-09-04. The mock store keeps one
   * because it is a fixture we serve ourselves.
   */
  checkLoginScript?: string;
  /**
   * Where to send the USER to finish a term by hand.
   *
   * A destination, not a scraper. Nothing of ours reads this page — the assisted
   * route navigates here and the person takes over — which is why it outlived
   * every selector in the build. A store without one lands the user on the
   * storefront and leaves them to type.
   */
  getSearchUrl?: (term: string) => string;
  /** Default true: navigations append a `?_t=<ts>` cache-buster. Set false for
   *  stores whose anti-bot flags that synthetic query (ALDI) — navTo then uses
   *  the clean URL + a forced reload() instead. */
  cacheBustNav?: boolean;
  /**
   * HOW THIS STORE READS ITS OWN CART, for a store that has to read a page to
   * do it.
   *
   * Absent on every store with a rail, which asks the store's API instead and
   * needs no page at all. Present on exactly one: the mock store, a dev fixture
   * we serve ourselves. It used to be a table of six in cart-count.ts, which
   * every store imports, and four of those six entries had been unreachable
   * since their rails shipped.
   *
   * `url` navigates there; `countScript` then posts the CART_COUNT.
   *
   * `openScript` — click your way to the cart, for a store whose cart URL is
   * unreliable — went with Amazon Fresh on 2026-09-04. It was the only store
   * that ever had one.
   */
  cartPage?: {
    url: string;
    countScript: string;
  };
}

// Worker composition lived here, and the selector-health probe that wrapped
// every script it produced. Both are gone: there are no workers, and there are
// no selectors to watch drift.

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
    return instacart;
  }

  switch (storeId) {
    case 'heb':     return getHebScripts();
    case 'walmart': return getWalmartScripts();
    case 'wegmans': return getWegmansScripts();
    // Dev/e2e only: the deterministic mock store for Maestro. Returns null in
    // production (flag unset) so it can never be reached even if a meal carries it.
    case 'mockstore':      return MOCK_STORE_ENABLED ? getMockStoreScripts() : null;
    default:
      if (ALBERTSONS_FAMILY_IDS.includes(storeId)) {
        return getAlbertsonsScripts(storeId);
      }
      return null;
  }
}
