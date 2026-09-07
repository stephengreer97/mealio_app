// Injectable JavaScript strings for Instacart Storefront WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// WHAT THIS FILE IS
// Instacart white-labels one storefront app to many grocery banners. This module
// is that platform's adapter, parameterized by an InstacartTenant — the banner's
// origin, its /store/{slug}/ path segment, and its cookie domain. It began life
// as aldi.ts (ALDI moved onto the platform in its Q1 2026 relaunch) and was
// generalised in place, so every injected script below is the exact text that
// drove ALDI before the extraction.
//
// HOW MANY STOREFRONTS HAVE ACTUALLY RUN THROUGH IT: one.
// ALDI is the only tenant in INSTACART_TENANTS and the only banner we hold
// captured HTML for. MEAL-20 records that aldi.us, delivery.publix.com and
// shop.sprouts.com return 200 for the same /store/{slug}/s?k= route, but a
// matching URL contract is not a matching DOM. Nothing here is verified against
// a second banner, and the selectors below are ALDI observations — treat them as
// the platform's *likely* shape, not its confirmed one, until someone captures
// fixtures for another storefront (see tests/fixtures/README.md).
//
// DOM reference (observed on ALDI, 2026):
//   Store URL:          {origin}/store/{slug}/storefront
//   Search URL:         {origin}/store/{slug}/s?k={term} (Instacart pattern; /search was retired)
//   Add to cart button: button[aria-label^="Add 1 "] (name in aria-label)
//   Product card link:  a[href*="/store/{slug}/products/"]
//   Increment button:   button[aria-label^="Increment quantity"]
//   Decrement button:   button[aria-label^="Decrement quantity"]
//   Cart quantity:      [data-testid="item-quantity"] or similar counter element
//
import type { StoreScripts } from './index';
import { storeConfig, searchUrlFor } from '../automation-config';

// ── Tenant model ──────────────────────────────────────────────────────────────

/**
 * One grocery banner running on Instacart Storefront.
 *
 * An entry here buys you the injected scripts and nothing else — the store is
 * not yet selectable, automatable, or capturable. See the checklist above
 * INSTACART_TENANTS for the registrations a banner actually needs.
 */
export interface InstacartTenant {
  /** Store id from constants/stores.ts. Doubles as the automation-config key,
   *  so each banner is kill-switched and tuned on its own from a config push. */
  storeId: string;
  /** Origin with scheme, no trailing slash. e.g. 'https://www.aldi.us' */
  origin: string;
  /** The banner's path segment in /store/{slug}/…. e.g. 'aldi' */
  slug: string;
  /** Cookie / navigation domain, used to recognise this banner's URLs. */
  domain: string;
  /** Compiled-in default for the one runtime knob left. Remote config overrides it. */
  cacheBustNav?: boolean;
  /**
   * Has this banner been MEASURED end to end, or is it only plumbed?
   *
   * Until now being in this map meant "this works", and the fixture guard in
   * instacartAdapter.test.ts enforced it. That left nowhere to put a banner we
   * can open a WebView at but have not proven, which is exactly the state a new
   * tenant is in before anyone has an account on it -- and being able to open
   * the WebView is how you GET the account.
   *
   * `proven: true`  the four MEAL-220 measurements pass and fixtures exist.
   * `proven: false` the origin and slug are confirmed and the scripts will run,
   *                 but whether the storefront answers the same persisted
   *                 queries is unknown. Not offered to anyone: a pending tenant
   *                 must be absent from BUNDLED_STORES and from the server
   *                 catalog, which is what actually keeps it off the picker.
   */
  proven?: boolean;
}

/** The `{origin}/store/{slug}/s?k=` prefix every search URL is built from. */
function searchPrefix(t: InstacartTenant): string {
  return `${t.origin}/store/${t.slug}/s?k=`;
}

/** Name of the window guard that stops a re-injected login check from
 *  double-driving the Main Menu. Per-tenant so two banners in one WebView
 *  session cannot share (and clobber) one flag. */
function loginFlag(t: InstacartTenant): string {
  return `__${t.storeId}LoginCheckActive`;
}

// The login check lived here: 200 lines that opened the hamburger menu and
// matched its text against a signed-in / signed-out word list per tenant.
//
// Deleted 2026-09-04. The storefront's own GraphQL answers who is signed in and
// which shop they are in, and the rail asks it (aldi-network.ts). Reading a
// menu was always a guess at a fact the API states.

// cart as the judge of what landed. Nothing has called a worker since
// 2026-09-01 — this removes the code that was still sitting there.
//
// searchPrefix STAYS. It is not worker code: it builds the search URL the
// assisted route hands the user to finish by hand. menuExclusion went with the
// login check that was its only caller.

/** Returns the Instacart search-results URL for a query on this tenant. */
export function getInstacartSearchUrl(t: InstacartTenant, query: string): string {
  return searchPrefix(t) + encodeURIComponent(query);
}

// ── Tenant registry ───────────────────────────────────────────────────────────

/**
 * Every banner we drive on Instacart Storefront, keyed by storeId.
 *
 * ADDING ONE needs no new SCRIPT code — that is what the tenant seam bought —
 * but it is more than an entry here. The full checklist, in the order a missing
 * step bites:
 *
 *   1. `WEBVIEW_STORE_IDS` and `STORES` in src/constants/stores.ts. Without the
 *      first, isWebViewStore() is false and the store is never automated;
 *      without the second it does not appear in the picker at all. A tenant
 *      registered only here is unreachable — the most silent miss on the list.
 *   2. An entry here — origin, slug, domain, and any knob whose default differs.
 *   3. OPTIONAL: a `stores.<storeId>` entry in BUNDLED_AUTOMATION_CONFIG
 *      (schema.ts), for the per-banner kill switch and any knob whose default
 *      differs.
 *   4. Nothing for search, cart or sign-in: the RAIL does all three, and
 *      getNetworkRail dispatches on this registry via isInstacartStore(), so a
 *      tenant gets them for free.
 *
 * What a new banner still owes is EVIDENCE. The rail's request shapes were read
 * off ALDI's own storefront, and the scripts carry a USD price regex and English
 * copy. Confirm them against the banner before calling it supported: a tenant
 * entry buys you the plumbing, not the proof.
 */
export const INSTACART_TENANTS: Record<string, InstacartTenant> = {
  aldi: {
    storeId: 'aldi',
    origin: 'https://www.aldi.us',
    slug: 'aldi',
    domain: 'aldi.us',
    cacheBustNav: false,
    proven: true,
  },

  // ── PENDING: plumbed so a WebView can be opened, not yet proven ────────────
  //
  // Every origin and slug below is MEASURED, not guessed: each answers 200 on
  // `/store/{slug}/` and serves the Instacart Storefront app (2026-09-06). That
  // is the only one of MEAL-220's four checks that can be done without an
  // account.
  //
  // WHAT IS UNKNOWN is whether these storefronts answer the same PERSISTED
  // QUERIES. The rail carries no query text, only an operation name and a
  // sha256 hash harvested at runtime, so a banner can serve an identical URL
  // and still have nothing the rail can call. `no_hash` is already a
  // first-class failure reason for precisely this.
  //
  // THEY ARE NOT OFFERED TO ANYONE. A store reaches the picker only when the
  // SERVER CATALOG names it, and none of these has a row. Being here means the
  // scripts exist so that, once a row is added, the WebView opens at the
  // storefront and somebody can sign in -- which is the step that unblocks
  // every remaining measurement.
  publix: {
    storeId: 'publix',
    origin: 'https://delivery.publix.com',
    slug: 'publix',
    domain: 'delivery.publix.com',
    cacheBustNav: false,
    proven: false,
  },
  sprouts: {
    storeId: 'sprouts',
    origin: 'https://shop.sprouts.com',
    // `sprouts`, NOT `sprouts-farmers-market`. The longer form 404s.
    slug: 'sprouts',
    domain: 'shop.sprouts.com',
    cacheBustNav: false,
    proven: false,
  },
  the_fresh_market: {
    storeId: 'the_fresh_market',
    origin: 'https://shop.thefreshmarket.com',
    slug: 'the-fresh-market',
    domain: 'shop.thefreshmarket.com',
    cacheBustNav: false,
    proven: false,
  },
  costco_sameday: {
    storeId: 'costco_sameday',
    origin: 'https://sameday.costco.com',
    slug: 'costco',
    domain: 'sameday.costco.com',
    cacheBustNav: false,
    // CARRIES A RISK THE OTHERS DO NOT: Costco Same-Day is membership-gated, so
    // a session can be signed in and still be refused a cart. Check that first
    // on this banner rather than last.
    proven: false,
  },
};

/** Banners measured end to end. The rest are plumbed, not supported. */
export const PROVEN_INSTACART_STORE_IDS: string[] =
  Object.values(INSTACART_TENANTS).filter((t) => t.proven).map((t) => t.storeId);

/** Store ids served by this adapter. Snapshotted at module load. */
export const INSTACART_STORE_IDS: string[] = Object.keys(INSTACART_TENANTS);

/** True when this store runs on Instacart Storefront.
 *
 *  Read LIVE off the registry rather than off the INSTACART_STORE_IDS snapshot,
 *  so anything dispatching on "is this the Instacart platform?" — cart probing
 *  in cart-count.ts especially — picks up a tenant the moment it is registered.
 *  This is the predicate to reach for when the answer is about the PLATFORM
 *  (a side-panel cart, a shared header badge) rather than about one banner. */
export function isInstacartStore(storeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(INSTACART_TENANTS, storeId);
}

// ── Public interface ──────────────────────────────────────────────────────────

export function getInstacartScripts(t: InstacartTenant): StoreScripts {
  // Per-banner config key: unlike the Albertsons family (one shared entry for 15
  // brands), Instacart banners are separate retailers whose selectors can drift
  // apart, so each is tuned and kill-switched on its own.
  const cfg = storeConfig(t.storeId);
  return {
    storeUrl: cfg.storeUrl ?? t.origin,
    // THE QUIET PAGE. The rail asks this tenant's own GraphQL endpoint and reads
    // no DOM, so the storefront is pure cost: its bundles share the renderer
    // with our requests, which on Albertsons was measured as a 1-second timer
    // firing 12 seconds late. robots.txt has no JavaScript of its own.
    //
    // Same origin as the store, which is not optional — the session is a cookie
    // on this origin and a rail on another host would have none of it.
    railUrl: (cfg.storeUrl ?? t.origin) + '/robots.txt',
    loginUrl: cfg.loginUrl ?? t.origin,  // login is via the hamburger menu, not a page
    cartUrl: cfg.cartUrl ?? t.origin,    // no dedicated cart page; it's a side panel
    domain: t.domain,
    isSearchUrl: function(url: string) {
      // Instacart search bar is available on any store page, not just /search.
      // Returning true skips the storefront reload and injects search directly.
      return url.includes(t.domain + '/store/');
    },
    isLoginSuccessUrl: function() { return false; },
    // Instacart reloads the storefront after sign-in. Re-run the session probe
    // on that nav so an already-completed login is detected.
    reinjectLoginCheckOnNav: true,
    getSearchUrl: (term: string) =>
      searchUrlFor(t.storeId, term, getInstacartSearchUrl(t, term)),
    cacheBustNav: cfg.cacheBustNav ?? t.cacheBustNav ?? false,
  };
}

/** Scripts for a storeId served by this adapter, or null if it isn't one. */
export function getInstacartScriptsFor(storeId: string): StoreScripts | null {
  const t = INSTACART_TENANTS[storeId];
  return t ? getInstacartScripts(t) : null;
}
