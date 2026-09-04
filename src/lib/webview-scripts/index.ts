// Store scripts registry — maps storeId → injectable WebView scripts.

import { getScripts as getHebScripts } from './heb';
import { getScripts as getWalmartScripts } from './walmart';
import { getScripts as getAlbertsonsScripts, ALBERTSONS_FAMILY_IDS } from './albertsons';
import { getInstacartScriptsFor, INSTACART_STORE_IDS } from './instacart';
import { getScripts as getWegmansScripts } from './wegmans';
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
  // checkLoginScript lived here: a page-reading answer to "who is signed in".
  //
  // Nothing provides one. Amazon Fresh carried the last real store's on
  // 2026-09-04 and the mock store's went with the store itself. Every store is
  // answered by its rail's session probe, which asks the store rather than its
  // markup.
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
  // cartPage lived here: navigate to the cart and count what is rendered.
  //
  // Nothing provides one either. Every store reads its cart with a request now,
  // through NetworkRail.cartRead — no navigation, and an answer that can be
  // checked. This was a table of six in cart-count.ts before it was a per-store
  // field, and four of those six had been unreachable since their rails shipped.
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
    default:
      if (ALBERTSONS_FAMILY_IDS.includes(storeId)) {
        return getAlbertsonsScripts(storeId);
      }
      return null;
  }
}
