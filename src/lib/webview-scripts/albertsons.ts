// Where the fifteen Albertsons banners live, and nothing else.
//
// One file covers the whole family: they run one storefront platform, and only
// the domain differs. Everything Mealio does at any of them it does over the
// network, in albertsons-network.ts.
//
// The DOM half is gone (2026-09-04): the selector table, and 511 lines of login
// check that read the account menu's rendered name, watched for the sign-in
// popup and latched a verdict per JS context. The platform answers /userinfo.
import type { StoreScripts } from './index';
import { storeConfig } from '../automation-config';

// Every Albertsons banner runs the same storefront platform, so one config entry
// tunes all 15 brands together.
const SELECTOR_KEY = 'albertsons';

const DOMAIN_MAP: Record<string, string> = {
  albertsons:   'albertsons.com',
  safeway:      'safeway.com',
  vons:         'vons.com',
  jewel_osco:   'jewelosco.com',
  shaws:        'shaws.com',
  acme:         'acmemarkets.com',
  tom_thumb:    'tomthumb.com',
  randalls:     'randalls.com',
  pavilions:    'pavilions.com',
  star_market:  'starmarket.com',
  haggen:       'haggen.com',
  carrs:        'carrsqc.com',
  kings:        'kingsfoodmarkets.com',
  balduccis:    'balduccis.com',
  // NOT unitedsupermarkets.com (MEAL-136). That host is the banner's Squarespace
  // MARKETING site: it 301s to https://shopunitedsupermarkets.com **discarding
  // the path**, which then 301s to www, so every URL we built for this banner —
  // /erums/cart, /shop/search-results.html — landed on a marketing home page.
  // No cart, no product tiles, no selectors, and nothing that failed loudly.
  // shopunitedsupermarkets.com is the storefront: /erums/cart and
  // /shop/search-results.html both return 200 off the same istio-envoy platform
  // that serves the other 14 banners. Pinned by tests/unit/webview-scripts/
  // url-builders.test.ts — a path-discarding redirect is invisible at runtime,
  // so the host is only ever as right as the test that names it.
  //
  // The platform agrees, and we already had it on disk: the captured fixture
  // tests/fixtures/albertsons/logged-in-home.html:158 carries the storefront's
  // own `trustedBannerDomains` list, which names shopunitedsupermarkets.com and
  // does NOT name unitedsupermarkets.com.
  united:       'shopunitedsupermarkets.com',
};

export const ALBERTSONS_FAMILY_IDS: string[] = Object.keys(DOMAIN_MAP);

/** The cart's path on every Albertsons banner — a separate Angular app from the
 *  /shop storefront. Platform-uniform (MEAL-15: endpoint paths need no
 *  per-banner configuration; only the host list does). Exported so the cart-page
 *  count script can check it still IS the path it landed on. */
export const ALBERTSONS_CART_PATH = '/erums/cart';

/** Cart page URL for a given Albertsons-family brand.
 *
 *  The `|| 'albertsons.com'` fallback below is UNREACHABLE, and stays only
 *  because unreachable is cheaper than a throw here. It is not, as it might
 *  read, a guard against a stale persisted storeId: every caller gates on
 *  ALBERTSONS_FAMILY_IDS first (cart-count.ts getCartPageUrl, and index.ts
 *  getStoreScripts for the getScripts twin of this fallback), and that list IS
 *  `Object.keys(DOMAIN_MAP)` — so an id that would need the fallback never gets
 *  this far. A stale id gets `null` from those gates and the ordinary
 *  unsupported-store UI, which is the behaviour we want anyway.
 *
 *  Two tests hold the invariant, one for each way it could break, and both live in
 *  tests/unit/webview-scripts/url-builders.test.ts:
 *    • "has a verified cart URL for every banner in the family" — catches a
 *      DOMAIN_MAP row added without a curl-verified host.
 *    • "has scripts for every store the app says runs the WebView engine" —
 *      iterates WEBVIEW_STORE_IDS, the hand-maintained list a new banner actually
 *      gets added to, and catches the opposite mistake: a banner in the app's store
 *      list with no DOMAIN_MAP row, which is what would silently take a fallback.
 *
 *  An earlier version of this note credited tests/unit/generatedScripts.test.ts with
 *  the second invariant. It does not hold it: that file's `STORES` is a hand-written
 *  seven-entry array local to the test, not src/constants/stores.ts, so the app's
 *  real store list was unguarded. Corrected rather than left, because a comment
 *  naming coverage that does not exist is how the next reader gets misled. */
export function getAlbertsonsCartPageUrl(storeId: string): string {
  // Unreachable fallback — see the note above.
  const domain = DOMAIN_MAP[storeId] || 'albertsons.com';
  return `https://www.${domain}${ALBERTSONS_CART_PATH}`;
}

/**
 * Trim a saved product name to its first 5 words for the manual-mode search URL.
 *
 * THE ORIGINAL REASON FOR THIS IS NOT TRUE. MEAL-208 measured it on the device,
 * twice, against both paths — the pgmsearch operation the rail uses and the
 * rendered /shop/search-results.html page — and Albertsons never once refused a
 * long query and never once returned zero for one:
 *
 *   13-word real title   200, appCode [GR200#A-CT: 200] [PP: 200] [SD200],
 *                        4 results, the exact product first
 *   22 words / 124 chars 200, 1 result
 *   341 words / 2000 ch  200, 1 result
 *   ~2500+ characters    431 then 414 from the gateway — a URL-length limit,
 *                        nothing to do with the search
 *
 * The rendered page agreed tile for tile. So there is no word limit and no
 * character limit to protect against here, and the size suffix this comment
 * claimed was fatal ("Signature SELECT Rice Basmati - 32 Oz", 7 words) returns
 * 32 matches with that product on top.
 *
 * AND THE CONTROL, because "never returned zero" is worth nothing without it:
 * this search cannot return zero. "zzqxwvtplkj" answers with 2 products,
 * "purple monkey dishwasher scaffolding tuesday" with 495. The engine always
 * falls back to something. So an empty result is not a failure mode at
 * Albertsons at any query length — its only failure mode is the HTTP 200 with
 * primaryProducts.appCode 400 from MEAL-207, and not one of those appeared in
 * roughly sixty requests across the sweep, at any length.
 *
 * WHAT THE TRUNCATION STILL DOES. Its only remaining consumer is
 * `getSearchUrl`, and `getSearchUrl`'s only consumer is manual mode — the
 * hand-over where a person is shown the store's own search page and adds the
 * item themselves. The network rail (albertsons-network.ts) sends the full term
 * and always has, so nothing about automated matching passes through here.
 *
 * That makes 5 a readability choice for a human, not a store limit, and the
 * trade runs the other way from what the comment assumed: a full title finds
 * the exact item when the store stocks it and almost nothing when it does not
 * (measured: "PERDUE SIMPLY SMART ORGANIC Gluten Free Breaded Chicken Breast
 * Tenders - 22 Oz" -> 1 loosely-related tile, vs 8 tiles at 5 words). Whether a
 * person handed a search box wants the exact name or a broader one is Stephen's
 * call, so the behaviour is left exactly as it shipped and only the reasoning
 * is corrected.
 */
export function albertsonsSearchQuery(name: string): string {
  return (name || '').trim().split(/\s+/).slice(0, 5).join(' ');
}
// The login check lived here: 420 lines that read the account menu's rendered
// name, watched for a sign-in popup, and latched a verdict per JS context.
//
// Deleted 2026-09-04. This platform answers /userinfo, and the rail asks it
// (albertsons-network.ts). A DOM check could only ever be a second opinion on
// a question already answered, and the two disagreeing is how a signed-in user
// gets shown a sign-in wall.

// ── Search navigation ───────────────────────────────────────────────────────


// ── Search and add ──────────────────────────────────────────────────────────


// ── Export ───────────────────────────────────────────────────────────────────

export function getScripts(storeId: string): StoreScripts {
  // Unreachable fallback, for the same reason and held by the same two tests as
  // the one on getAlbertsonsCartPageUrl — see that note. index.ts only routes
  // here for ids in ALBERTSONS_FAMILY_IDS, i.e. keys of DOMAIN_MAP.
  const domain = DOMAIN_MAP[storeId] || 'albertsons.com';
  const storeOrigin = `https://www.${domain}`;
  // Read under the shared 'albertsons' key: every banner runs one storefront
  // platform, so one config entry tunes all 15. URLs stay derived from the
  // storeId — a per-banner URL override would need 15 entries to say one thing.
  const cfg = storeConfig(SELECTOR_KEY);

  return {
    storeUrl: storeOrigin,
    // Same origin, so the session cookies apply; served as a tiny text file, so
    // the storefront's own bundles never run. See railUrl in StoreScripts.
    railUrl: `${storeOrigin}/robots.txt`,
    loginUrl: storeOrigin,
    // MEAL-151: was `/shop/cart.html`, which 404s while `/erums/cart` returns 200
    // — spot-checked live on albertsons.com, safeway.com and vons.com. Not all
    // fifteen were probed; the path is uniform across the family (pinned by
    // url-builders.test.ts), so there is no reason to expect the rest to differ,
    // but the comment should say what was measured rather than what follows. This is not a dead
    // constant: `cartUrl` has exactly one consumer, the Linking.openURL that opens
    // the user's cart in the real app (WebViewCartSheet), so every tap of that
    // button landed on a 404 page.
    //
    // ALBERTSONS_CART_PATH rather than another literal, because it is the same
    // path the cart-count probe already navigates to and MEAL-136 already proved
    // uniform across the family. Two copies of a path is how one of them goes
    // stale without the other noticing.
    cartUrl: `${storeOrigin}${ALBERTSONS_CART_PATH}`,
    domain: domain,
    isSearchUrl: (url: string) => url.includes(domain) && url.includes('/shop/search-results.html'),
    // Albertsons login is a popup on the same page — login success is detected via
    // LOGIN_COMPLETE message from the background poll, not via URL change.
    isLoginSuccessUrl: () => false,
    // The page reloads after sign-in, which kills the JS context the session
    // probe is running in. Re-inject on each post-login store load so it
    // re-runs and sees the now-signed-in state.
    reinjectLoginCheckOnNav: true,
    getSearchUrl: (term: string) => `${storeOrigin}/shop/search-results.html?q=` + encodeURIComponent(albertsonsSearchQuery(term)),
    cacheBustNav: cfg.cacheBustNav,
  };
}
