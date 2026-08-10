// Cart-count snapshot scripts.
//
// Reads the store's header cart badge from the CURRENT page and posts
// { type: 'CART_COUNT', count: number | null }. Used by WebViewCartSheet to
// snapshot the cart before and after an add-to-cart run and warn when the
// cart delta is short of what was reported added (silent-miss detection).
//
// count === null means "unknown" — badge not found / unparseable, or (for the
// cart-PAGE scripts below) the page we landed on was not the cart. Callers must
// treat null as unknown and SKIP validation, never warn. The converse is the
// load-bearing half: any NUMBER is trusted, so a script must never emit one it
// is not sure of. See the page-identity note above cartPathGuardJs (MEAL-152).
//
// Every selector below was verified against captured fixture HTML
// (tests/fixtures/<store>/search-results-tortillas.html), per the
// don't-guess rule:
//   heb        aria-label="Go to Cart page. 2 items in your cart. $9.93"
//   walmart    aria-label="Cart contains 4 items Total Amount $13.33"
//   instacart  aria-label="View Cart. Items in cart: 6, View cart"  (seen on ALDI)
//   wegmans    aria-label="View 2 selected items in my Cart"
//   amazon     <span id="nav-cart-count">4</span>
//   albertsons [data-qa="hdr-crt-txt-plus"] exists but renders its count
//              client-side (empty in the static capture) — BEST EFFORT,
//              needs live verification on a device before trusting it.
//
// NOTE (Stephen): Instacart's cart UI is a side panel, but the COUNT badge
// above lives in the header of every store page, so no cart navigation is
// needed. Both are keyed to the PLATFORM here — every banner in
// INSTACART_TENANTS shares them — rather than to ALDI, which is merely the
// tenant they were first read off.

import { ALBERTSONS_FAMILY_IDS, getAlbertsonsCartPageUrl } from './albertsons';
import { AUTH_REDIRECT_URL_PATTERN } from './auth-urls';
import { cartUrlFor } from '../automation-config';
import { isInstacartStore } from './instacart';
import { MOCK_STORE_URL } from './mockstore';

interface CountExtractor {
  /** querySelector for the badge element. */
  sel: string;
  /** Where the count text lives. */
  from: 'aria' | 'text';
  /** Capture-group-1 regex applied to the source text. Omitted = the text
   *  itself must be a bare integer. */
  re?: string;
}

const EXTRACTORS: Record<string, CountExtractor> = {
  heb: { sel: '[aria-label*="items in your cart"]', from: 'aria', re: '(\\d+)\\s+items? in your cart' },
  walmart: { sel: '[aria-label^="Cart contains"]', from: 'aria', re: 'Cart contains (\\d+) item' },
  // Instacart Storefront renders one header badge for every banner it hosts, so
  // this is keyed to the PLATFORM, not to ALDI (where it was first observed).
  // extractorFor() routes each registered tenant here.
  instacart: { sel: '[aria-label*="Items in cart:"]', from: 'aria', re: 'Items in cart:\\s*(\\d+)' },
  wegmans: { sel: '[aria-label*="selected items in my Cart"]', from: 'aria', re: '(\\d+) selected item' },
  amazon: { sel: '#nav-cart-count', from: 'text' },
  albertsons: { sel: '[data-qa="hdr-crt-txt-plus"]', from: 'text' },
};

function extractorFor(storeId: string): CountExtractor | null {
  if (EXTRACTORS[storeId]) return EXTRACTORS[storeId];
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return EXTRACTORS.albertsons;
  // Platform families before the null: a banner with no entry of its own gets
  // its platform's badge rather than a silent "count unknown", which reads as
  // "skip validation" and takes the whole silent-miss check offline.
  if (isInstacartStore(storeId)) return EXTRACTORS.instacart;
  return null;
}

// ── Cart-PAGE counting (for stores whose header badge is unreliable) ───────────
//
// HEB's header badge is page/UA-dependent: under the app's mobile UA the header
// omits the desktop "N items in your cart" aria-label, and an empty cart has no
// badge at all, so the badge read returns null and validation silently skips.
// Instead, navigate to the store's cart page and count line-item quantities
// there — authoritative and independent of which page we're on.
//
// Selectors verified against tests/fixtures/heb/cart-with-items.html:
//   itemRow                  one per cart line item
//   cartQuantityCounterValue <input value="N"> — the unit qty for that line
//
// READ THIS BEFORE EDITING A URL HERE (MEAL-156). This table is the FALLBACK,
// consulted only when the automation config has no `cartUrl` for the store — and
// BUNDLED_AUTOMATION_CONFIG already carries one for `heb` and for `walmart`
// (schema.ts). Their entries below are therefore shadowed and never resolve:
// editing them to fix an incident changes nothing, which is the same class of
// silent no-op this ticket removed on the guard path. `wegmans` and `mockstore`
// have no bundled config entry, so they do still resolve from here.
//
// The duplication is not removable in this direction — schema.ts cannot import
// from webview-scripts, which imports it — so it is pinned instead:
// cartUrlFromConfig.test.ts asserts that wherever both sources name a store,
// they name the same URL. That turns a silent divergence into a failing suite
// and tells the next editor which of the two they actually need to change.
/** Exported for the drift check in cartUrlFromConfig.test.ts — see the note above. */
export const CART_PAGE_URL: Readonly<Record<string, string>> = {
  heb: 'https://www.heb.com/cart',        // shadowed by BUNDLED_AUTOMATION_CONFIG
  walmart: 'https://www.walmart.com/cart', // shadowed by BUNDLED_AUTOMATION_CONFIG
  wegmans: 'https://www.wegmans.com/cart',
  mockstore: MOCK_STORE_URL + '/cart',   // dev/test only
};

/**
 * Every store id registered in CART_PAGE_URL, derived from the record itself.
 *
 * Exported for tests/unit/webview-scripts/cartPageIdentity.test.ts, which checks
 * that each of these carries the page-identity guard. That check has to iterate
 * the REGISTRY — a list of store ids copied out beside it cannot notice a store
 * added to the registry and not to the list, which is precisely the omission
 * that ships the MEAL-152 defect on a new store.
 */
export const CART_PAGE_URL_STORE_IDS: readonly string[] = Object.keys(CART_PAGE_URL);

/**
 * The cart-page URL for stores that count via the cart page, else null.
 *
 * The bundled table is the FALLBACK, not the answer (MEAL-156). A remote
 * `cartUrl` override wins, because a cart URL is the one piece of this subsystem
 * that a store can invalidate unilaterally and without notice: MEAL-152 was
 * Walmart's /cart starting to 302, MEAL-136 was United's cart host dropping the
 * path. Both were code fixes that a config push could have covered in minutes,
 * and both are exactly the shape of thing that happens again.
 *
 * The override REPOINTS, it does not PROMOTE. A store with no bundled cart URL
 * returns null no matter what config says, because null here is not "no URL
 * known" — it is the branch selector for a different counting strategy. Callers
 * read `!getCartPageUrl(id)` to mean "reach the cart by clicking" (Amazon Fresh
 * traverses /gp/aw/c → /cart/localmarket) or "the cart is a side panel, don't
 * navigate at all" (Instacart). Honouring a cartUrl there would put a store on a
 * navigation path its script was never written for AND leave it unguarded, since
 * those stores have no single pathname to assert — reintroducing the trusted
 * zero MEAL-152 removed, from a config push, on a store nobody was looking at.
 * Adding a store to cart-page counting stays a code change with a guard and a
 * fixture.
 *
 * KNOWN LIMIT — this lever moves PATHS, not HOSTS, in the main WebView.
 * WebViewCartSheet.onLoadEnd gates on `url.includes(s.domain)` before it drains
 * the injection queue, and `domain` is compiled in (webview-scripts/index.ts)
 * with no config field behind it. So an override pointing at a NEW HOST
 * navigates fine and then never gets its count script injected: the probe times
 * out and the run reports no count. Safe, but not a fix. SilentLoginProbe has no
 * such gate and does follow the new host, so a host repoint gets an asymmetric
 * pair — prewarm captures a baseline, the after-probe stalls.
 *
 * MEAL-136 was a host change, so this lever would not have covered it, and the
 * first version of this commit message claimed otherwise. Widening the gate to
 * trust a config-supplied host is deliberately NOT done here: that gate is what
 * decides the app will inject scripts into a page at all, and MEAL-136 exists
 * because its substring test already let a marketing host through once. Making a
 * config push able to authorise injection on an arbitrary host is a security
 * change with a blast radius across 20+ banners, not a cart-URL fix. Tracked
 * separately as MEAL-175.
 */
export function getCartPageUrl(storeId: string): string | null {
  const bundled = bundledCartPageUrl(storeId);
  if (!bundled) return null;
  return cartUrlFor(storeId, bundled);
}

/** What this build ships for a store, before any remote override. */
function bundledCartPageUrl(storeId: string): string | null {
  if (CART_PAGE_URL[storeId]) return CART_PAGE_URL[storeId];
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return getAlbertsonsCartPageUrl(storeId);
  return null;
}

/**
 * Did this cart snapshot actually COUNT something — i.e. is it usable as a
 * baseline?
 *
 * ZERO IS A BASELINE. An empty cart is the most common one there is, and a
 * `count: 0` read off a page the script confirmed is the cart is a fact. Only
 * `null` means "unknown". This module exists because a redirect made those two
 * indistinguishable, so the test must never be written as truthiness:
 * `if (cart.count)` silently discards every empty cart — the same 0-vs-null
 * confusion, pointing the other way.
 *
 * Named, exported and pinned rather than inlined at its call site
 * (WebViewCartSheet's prewarmed-baseline fast path) because that call site has
 * no test harness today — MEAL-158 covers building one — and a predicate can be
 * pinned on its own in the meantime. The point is not indirection; it is that
 * `isCountedCartSnapshot(cart)` cannot be misread the way `cart.count` can.
 */
export function isCountedCartSnapshot(
  snapshot: { count: number | null } | null | undefined,
): boolean {
  return typeof snapshot?.count === 'number';
}

// ── Page identity for cart-page counting (MEAL-152) ──────────────────────────
//
// Navigating to a cart URL is not the same as ARRIVING on the cart page.
// www.walmart.com/cart answers 302 → https://www.walmart.com/ — the redirect
// DISCARDS the path — and the homepage carries no [data-testid="quantity-label"]
// at all. The count script polled its full 5s, found zero line items, and posted
// `count: 0`.
//
// That zero is the defect, not the missing selector. `count: null` is the
// protocol's "unknown — skip validation"; ANY number is taken as authoritative.
// So a wrong zero is a CONFIDENT WRONG ANSWER.
//
// What it produces depends on ONE UNMEASURED THING, so read the premise before
// the conclusion.
//
// IF the redirect is symmetric within a run — both probes bounce — then before
// is `0 / []`, after is `0 / []`, and diffCartItems([], []) is []. That empty
// array is truthy at cart-reconcile.ts:814 (`if (rows)`), so findUnaddedItems
// has no added rows to match against and every item the run really did add comes
// back as `missing`. The done screen prints (WebViewCartSheet.tsx ~:2874)
//
//     "N items may not have been added (…). Please double-check your cart."
//
// about groceries that are sitting in the cart: a positive false claim, which is
// the reporting side of Stephen's second principle even though nothing was
// mis-added.
//
// SYMMETRY IS ASSUMED, NOT MEASURED. The 302 was observed once, anonymously,
// while the app only ever probes logged in. A `/cart` that bounces an empty cart
// but serves a full one gives the asymmetric pair instead — before `0 / []`,
// after real items — and then diffCartItems attributes the user's whole cart to
// this run and the over-add copy fires (~:2756): "N items added that Mealio
// didn't intend". That is reachable, and it is the narrative 56917aa opened
// with.
//
// What does NOT make it unreachable is the after-probe's gate. An earlier
// version of this comment claimed that; it is wrong in the very world this
// paragraph describes. The gate is `hasBaseline: cartCountBeforeRef.current !=
// null` (WebViewCartSheet.tsx :1558, :4444) and the defect's baseline is 0, not
// null — `0 != null` is true, so the after-probe runs. Only the guard below
// closes that gate, by making the unknown case actually null.
//
// One more surface, named because it is NOT dormant. The after-probe is at least
// gated on a baseline; the parallel-add reconcile probe
// (triggerCartProbe('reconcile'), from finishParallelAdd) is not, so with no
// baseline it diffs against an empty cartItemsBeforeRef. That path is not
// HEB-only — an earlier version of this comment said so and it is false. It
// needs getSearchUrl + buildWorkerScript + !forceSerialSearch
// (WebViewCartSheet.tsx :2041), which HEB, WALMART, Amazon Fresh and the
// Albertsons family all satisfy; only ALDI and Wegmans force serial. So it is
// live on the one store whose redirect is actually demonstrated.
//
// After the guard it degrades safely there too: a refusal carries no `items`, so
// `rows` stays null and the reconcile falls back to worker reports rather than
// diffing against nothing. The residual needs the same asymmetric pair as above,
// and it is pre-existing either way — a before-probe that merely times out
// leaves the identical empty ref — so it stays with MEAL-47 rather than growing
// this change.
//
// Either way the fix is the same and the reason is the same: a wrong answer is
// worse than no answer.
//
// So: a script that cannot tell it is on the cart page reports null.
//
// Shape borrowed deliberately from the Albertsons guard in PR #81
// (fix/meal-136-united-domain), which is the same defect found on a different
// store — a host whose 301 dropped the path. Same two cases, handled the same
// way, because consistency across stores is worth more here than local
// elegance:
//
//   • An auth/SSO interstitial is TRANSIENT. Post nothing and let the landing
//     page decide: a verdict here would burn the probe's single pending slot on
//     a page that was never the cart, and the probe timeouts already cover
//     silence.
//
//     SILENCE IS ONLY SAFE BECAUSE OF WHAT THE TWO INJECTION SITES DO, and they
//     do different things — an earlier draft of this comment said "both
//     re-inject on the next load", which was true of one of them:
//       – WebViewCartSheet.onLoadEnd re-injects the count script on a later load
//         (~line 2353). It also refuses to inject anything on an auth
//         interstitial in the first place (~line 2242), so this branch is in
//         fact unreachable from there.
//       – SilentLoginProbe.onLoadEnd used to inject ONCE per cart capture and
//         latch, which made silence here terminal: no answer AND no retry, i.e.
//         a 15s stall and no baseline. MEAL-189 changed it to re-inject on each
//         load until something posts (bounded), so silence is now recoverable
//         there too. The interstitial skip is still worth keeping — an
//         interstitial is never the cart, so injecting there only spends a retry
//         — but this branch no longer DEPENDS on it.
//     So the invariant to preserve is "silence must be recoverable by someone",
//     and both injection sites now satisfy it.
//   • Anything else is TERMINAL — nothing further is loading. Post
//     `count: null` with a named reason, so the run degrades to "unknown"
//     instead of "empty" and the log says WHY. Both CART_COUNT handlers print
//     `reason=`/`url=`; neither stores them, so those log lines are the whole
//     audit trail and without them this is indistinguishable from a selector
//     miss.
//
// What it does NOT do: invent a count, or refuse a real cart page. The only
// conversion is trusted-zero → honest-unknown.

/**
 * Store ids whose cart-page script carries the identity guard.
 *
 * A SET OF IDS, NOT A TABLE OF PATHS (MEAL-156). The expected path used to be
 * written out beside each id, which made it a second source of truth for the
 * same fact: repointing `cartUrl` from remote config then moved the URL and left
 * the guard demanding the old path, so every load answered `not_cart_page` and
 * the store went permanently uncountable. Safe — null is "unknown" — but it
 * would have made the config lever useless on the exact incident it exists for.
 * The path is now DERIVED from whichever URL is actually in force, so the two
 * cannot drift by construction.
 *
 * The Albertsons banners are guarded too, by their own script; they are absent
 * here because membership is tested via ALBERTSONS_FAMILY_IDS rather than
 * enumerated. `mockstore` and `amazon` are the documented exemptions.
 */
const GUARDED_CART_STORE_IDS = new Set(['heb', 'walmart', 'wegmans']);

/**
 * The pathname a cart URL must settle on, canonically encoded, else null.
 *
 * Hand-parsed rather than `new URL(...)`: this value is spliced into injected
 * JavaScript, and Hermes' URL is a partial polyfill whose behaviour has moved
 * between React Native versions. A regex is deterministic on every engine. The
 * tests keep `new URL().pathname` as their oracle precisely so the check is an
 * independent implementation rather than a restatement of this one.
 *
 * NULL IS THE SAFE ANSWER and every rejection below prefers it. A null path
 * makes buildCartPageCountScript refuse to build a script at all, so the store
 * reports no count; a WRONG path makes the guard admit a page that is not the
 * cart, and the count it then posts is trusted. That asymmetry — `count: null`
 * is "unknown, skip validation" while any number is believed — is the whole
 * reason MEAL-152's guard exists, so this function fails closed four ways:
 *
 *   • No parseable authority. `^https://` does NOT imply a host: merge.ts
 *     accepts `https:///cart`, `https://`, `https://?q=1` and `https://#frag`,
 *     all of which have nothing between the slashes for `[^/?#]+` to match.
 *   • The site root. An override naming a bare origin emits a guard of `"/"`,
 *     which the STORE HOMEPAGE satisfies; the homepage carries no line items, so
 *     the script counts zero and posts it as fact — the exact trusted zero of
 *     MEAL-152, through the config lever meant to fix it. This rule covers the
 *     demonstrated MEAL-152 landing page and the bare-origin typo, and it is a
 *     SPECIAL CASE, NOT A CLOSURE: any non-cart path a store actually serves
 *     does the same thing. `/grocery` is not hypothetical — it is Walmart's own
 *     `storeUrl` in this codebase, and a guard of `/grocery` counts zero on it.
 *     Refusing that class needs positive evidence of cart-ness before a number
 *     is posted, not a longer denylist. Tracked as MEAL-184.
 *   • Dot segments. The browser resolves `/cart/../checkout` to `/checkout`
 *     before `location.pathname` is read, so the literal could never match.
 *   • A malformed percent-escape, which decodeURIComponent throws on.
 *
 * Otherwise the path is canonicalised to the form `location.pathname` reports:
 * that property is ALWAYS percent-encoded, so an override of `/my cart` or
 * `/café` compared raw would never match its own page and the store would go
 * quietly uncountable — a config push that appears to work and does nothing,
 * which is the failure this ticket exists to remove rather than relocate.
 *
 * IT ENCODES WHAT IS ILLEGAL AND NEVER DECODES. The obvious spelling —
 * `encodeURI(decodeURIComponent(path))` — was written here first and is wrong,
 * because THE CANONICALISER IS ON ONLY ONE SIDE OF AN EQUALITY TEST: the guard
 * compares this literal against raw `location.pathname`, so any transform we
 * perform that the browser does not is a permanent mismatch. `encodeURI` does
 * not escape `; , / ? : @ & = + $ #`, so a round trip unescapes exactly those
 * and hands back a path no page can report — `/ca%3Frt` became `/ca?rt` while
 * Chromium still says `/ca%3Frt`. It also normalises escape case, and `%c3%a9`
 * is what plenty of tools emit. Both directions are safe (a mismatch refuses)
 * and both are the silent no-op this ticket exists to remove.
 *
 * Encoding only the characters that cannot appear leaves every `%XX` byte-exact
 * in whatever case it arrived, so it is identity on already-encoded input. The
 * `u` flag is load-bearing: without it the class matches UTF-16 code units and
 * `encodeURIComponent` throws on the lone surrogate of an astral character.
 * `%2e` is folded into the dot-segment test rather than decoded, because WHATWG
 * treats the encoded form as a dot segment too.
 *
 * Trailing slashes are stripped because the guard strips them from
 * `location.pathname` before comparing; an expected `/cart/` would otherwise
 * never match a real `/cart`.
 */
function cartPathnameOf(url: string): string | null {
  const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
  if (!m) return null;
  let path = m[1] || '/';
  while (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
  if (path === '/') return null;
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return null;
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path)) return null;
  try {
    return path.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@%/]/gu, encodeURIComponent);
  } catch {
    return null;
  }
}

/**
 * The pathname a store's cart page must be on to be counted, else null.
 *
 * Derived from the effective (possibly remote-overridden) cart URL, so a config
 * push repoints the navigation and the guard together or not at all.
 */
export function getCartPagePath(storeId: string): string | null {
  const guarded = GUARDED_CART_STORE_IDS.has(storeId) || ALBERTSONS_FAMILY_IDS.includes(storeId);
  if (!guarded) return null;
  const url = getCartPageUrl(storeId);
  return url ? cartPathnameOf(url) : null;
}

/**
 * Injectable prologue asserting the page really is `cartPath` before counting.
 *
 * EXACT path match, modulo a trailing slash — not a prefix. A prefix test also
 * accepts sub-paths, so /cart/checkout and /cartoons would count. Query strings
 * and hash fragments are deliberately unaffected: they aren't part of
 * location.pathname, so the `_t=` cache-buster both injection sites append to
 * the cart URL still counts, as does /cart#items. That ordering also settles
 * precedence — /cart?next=/sso/authorize IS the cart even though its query
 * matches the auth-redirect pattern, because the pattern is only consulted once
 * the path has already failed.
 */
function cartPathGuardJs(cartPath: string): string {
  return `
  var __path = location.pathname;
  while (__path.length > 1 && __path.charAt(__path.length - 1) === '/') __path = __path.slice(0, -1);
  if (__path !== ${JSON.stringify(cartPath)}) {
    if (new RegExp(${JSON.stringify(AUTH_REDIRECT_URL_PATTERN)}).test(location.href)) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: location.href
    }));
    return;
  }
`;
}

export interface CartItem {
  name: string;
  qty: number;
  /** Sold-by-weight line (HEB Deli / Fish Market / bulk). qty is 1 (present);
   *  weight carries the lb amount. Reconciled by presence, not discrete count. */
  isWeight?: boolean;
  weight?: number;
}

export interface CartRow {
  name: string;
  qty: number;
  /** true = added by this run (green +), false = already in the cart (grey). */
  added: boolean;
  isWeight?: boolean;
  weight?: number;
}

/**
 * Diff a before/after cart snapshot into display rows for the done screen.
 * The portion of each product that was already in the cart is an "already
 * there" (grey) row; any quantity this run added is an "added" (green +) row.
 * A product whose qty rose yields BOTH a grey row (pre-existing qty) and a
 * green row (added qty). Added rows are listed first. Items that left the cart
 * during the run are omitted.
 */
// Store cart pages sometimes emit product titles with HTML entities left
// literal (e.g. a double-encoded "Chobani&reg;" whose text node is the string
// "Chobani&reg;", not "Chobani®"). Left as-is they show as "&reg;" on the done
// screen AND poison name matching (the entity tokenizes to a spurious "reg"
// word). Decode the common ones plus any numeric entity. No DOM here (this runs
// in RN as well as in-page), so it's a small explicit map.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  reg: '®', trade: '™', copy: '©', deg: '°', hellip: '…',
  mdash: '—', ndash: '–', minus: '−', times: '×', frac12: '½', frac14: '¼', frac34: '¾',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è',
};
export function decodeHtmlEntities(s: string): string {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit !== undefined ? hit : m;
  });
}

function cartTokens(s: string): string[] {
  return decodeHtmlEntities(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Entity- and punctuation-insensitive normalization for EXACT name comparison.
 *  "McCormick Gourmet, Organic…" and "McCormick Gourmet Organic…" collapse to the
 *  same string so a product reliably matches its own cart row before a loosely
 *  similar sibling can. */
export function normalizeName(s: string): string {
  return decodeHtmlEntities(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Lenient match between a store cart title and a product name Mealio added.
 *  True when most of the reported name's tokens appear in the cart name (or
 *  vice versa) — tolerant of weight/size suffixes and minor title differences. */
export function cartNameMatches(cartName: string, reportedName: string): boolean {
  const ct = cartTokens(cartName);
  const rt = cartTokens(reportedName);
  if (rt.length === 0 || ct.length === 0) return false;
  const cset = new Set(ct);
  const overlap = rt.filter((t) => cset.has(t)).length;
  return overlap / rt.length >= 0.6;
}

/**
 * Given the product names Mealio reported as successfully added and the names
 * of the items that ACTUALLY appeared as new in the cart, return the reported
 * names with no matching cart item — i.e. the ones that silently failed to add.
 */
export function findUnaddedItems(reportedAdded: string[], addedCartNames: string[]): string[] {
  return reportedAdded.filter(
    (rn) => !addedCartNames.some((cn) => cartNameMatches(cn, rn)),
  );
}

export interface ShortAdd {
  name: string;
  /** Units this run actually added to the cart. */
  got: number;
  /** Units that were requested. */
  expected: number;
}

/**
 * Audit added cart quantities against what was requested and return the items
 * that landed SHORT — present in the cart but with fewer units than asked for
 * (e.g. a store per-item cap accepted 2 of 3). Fully-missing items (got 0) are
 * excluded here; they're covered by findUnaddedItems.
 *
 * `addedRows` are the added (green) rows from diffCartItems, whose `qty` is the
 * delta this run added. Each added unit is attributed to a SINGLE audited item
 * via a shared pool — exact-name matches reserved first, then loose matches take
 * whatever remains — so two near-identical product names can't both claim the
 * same row and hide a shortfall.
 *
 * Sold-by-weight rows are dropped from the pool, not left to the caller. This is
 * a UNIT-COUNT comparison and a weight line carries no unit count: diffCartItems
 * emits it as qty 1 whatever the poundage, so counting it as "1 unit" is a made-up
 * number. Filtering here rather than at the call site because the two sides of
 * the comparison have to agree about which rows exist, and only this function
 * knows it is counting units — auditCartAfterRun filtered the ITEM side only
 * (`!a.isWeight`) and still handed over every row, so a stepper-weight deli line
 * was reported as `short: got 1, expected 3` by this pool AND as `over: qty 1` by
 * splitCartLeftover, which cannot claim a weight row for a count item. One
 * physical line, two contradictory findings about it. See findOverAddedItems,
 * which has always split the pools internally for the same reason.
 */
export function findShortAddedItems(
  addedRows: CartRow[],
  audit: { name: string; expectedQty: number }[],
): ShortAdd[] {
  const pool = addedRows.filter((row) => !row.isWeight).map((row) => ({ name: row.name, qty: row.qty }));
  const claimQty = (reportedName: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of pool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly ? normalizeName(row.name) === normalizeName(reportedName) : cartNameMatches(row.name, reportedName);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };
  const state = audit.map((a) => ({ name: a.name, expected: Math.max(1, a.expectedQty || 1), got: 0 }));
  // Pass 1 reserves exact-name units for every item; pass 2 lets those still
  // short take remaining loose matches, so a loose match can't steal units an
  // exact match needed.
  state.forEach((s) => { s.got = claimQty(s.name, s.expected, true); });
  state.forEach((s) => { if (s.got < s.expected) s.got += claimQty(s.name, s.expected - s.got, false); });
  return state
    .filter((s) => s.got > 0 && s.got < s.expected)
    .map((s) => ({ name: s.name, got: s.got, expected: s.expected }));
}

/**
 * Units that landed in the cart this run that NO intended item accounts for —
 * over-adds (a product added more times than requested) or an entirely
 * unintended product. A safety net: even if a future bug re-adds something, the
 * cart check surfaces it rather than trusting the run silently.
 *
 * Each intended item claims matching added units first (exact name, then loose,
 * capped at its expected qty); whatever added units remain unclaimed are the
 * overage. Weight lines are presence-based (one row regardless of poundage), so
 * an intended weight item consumes at most one matching weight row.
 */
export function findOverAddedItems(
  addedRows: CartRow[],
  intended: { name: string; expectedQty: number; isWeight?: boolean }[],
): { name: string; qty: number }[] {
  const countPool = addedRows.filter((r) => !r.isWeight).map((r) => ({ name: r.name, qty: r.qty }));
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
  const claim = (name: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of countPool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly ? normalizeName(row.name) === normalizeName(name) : cartNameMatches(row.name, name);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };
  // Weight items consume one matching weight row by presence.
  for (const it of intended.filter((i) => i.isWeight)) {
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, it.name));
    if (w) w.used = true;
  }
  // Count items: exact pass then loose pass, capped at each item's expected qty,
  // so a legitimately-requested unit never counts as overage.
  const need = intended.filter((i) => !i.isWeight).map((i) => ({ name: i.name, left: Math.max(1, i.expectedQty || 1) }));
  need.forEach((n) => { n.left -= claim(n.name, n.left, true); });
  need.forEach((n) => { if (n.left > 0) n.left -= claim(n.name, n.left, false); });
  const over: { name: string; qty: number }[] = [];
  for (const row of countPool) if (row.qty > 0) over.push({ name: row.name, qty: row.qty });
  for (const w of weightPool) if (!w.used) over.push({ name: w.name, qty: 1 });
  return over;
}

export function diffCartItems(beforeRaw: CartItem[], afterRaw: CartItem[]): CartRow[] {
  // Decode HTML entities up front so both the qty matching (by name) and the
  // rendered rows use clean titles ("Chobani®", not "Chobani&reg;").
  const before = beforeRaw.map((it) => ({ ...it, name: decodeHtmlEntities(it.name) }));
  const after = afterRaw.map((it) => ({ ...it, name: decodeHtmlEntities(it.name) }));
  const beforeQty = new Map<string, number>();
  const beforeWeight = new Map<string, number>();
  for (const it of before) {
    beforeQty.set(it.name, (beforeQty.get(it.name) || 0) + it.qty);
    if (it.isWeight && typeof it.weight === 'number') {
      beforeWeight.set(it.name, (beforeWeight.get(it.name) || 0) + it.weight);
    }
  }
  const green: CartRow[] = [];
  const grey: CartRow[] = [];
  for (const it of after) {
    // Sold-by-weight lines carry qty:1 (present/absent), so the qty diff always
    // yields greenQty=0 and mislabels a freshly added/topped-up weight line as
    // "already in cart". Classify by weight instead: a line that's new, or
    // heavier than the before snapshot, was added/increased by this run.
    if (it.isWeight) {
      const bw = beforeWeight.get(it.name) || 0;
      const aw = typeof it.weight === 'number' ? it.weight : 0;
      const added = !beforeWeight.has(it.name) || aw > bw;
      (added ? green : grey).push({ name: it.name, qty: it.qty, added, isWeight: true, weight: it.weight });
      continue;
    }
    const bq = beforeQty.get(it.name) || 0;
    const greyQty = Math.min(bq, it.qty);
    const greenQty = Math.max(it.qty - bq, 0);
    if (greenQty > 0) green.push({ name: it.name, qty: greenQty, added: true, isWeight: it.isWeight, weight: it.weight });
    if (greyQty > 0) grey.push({ name: it.name, qty: greyQty, added: false, isWeight: it.isWeight, weight: it.weight });
  }
  return [...green, ...grey];
}

/**
 * Script that reads the store's already-loaded cart page and posts
 * { type: 'CART_COUNT', count, items: [{ name, qty }] }. `count` is the total
 * unit count (silent-miss detection); `items` is the per-line breakdown used to
 * render the done screen (added vs already-in-cart). Caller must navigate to
 * getCartPageUrl(storeId) first and inject this on the cart page's load.
 * Returns null for stores that don't use cart-page counting.
 *
 * count is 0 / items is [] for a genuinely empty cart — no item rows on a page
 * the script has CONFIRMED is the cart.
 *
 * That confirmation is the script's own (cartPathGuardJs), not the caller's.
 * This comment used to credit onLoadEnd with "confirmed the cart URL"; onLoadEnd
 * tests `url.includes(store.domain)` and nothing more, so every page on the
 * store's domain — its homepage included — passed. MEAL-152: a script that
 * cannot tell it is on the cart page posts `count: null, reason:
 * 'not_cart_page'` and no items. Not yet true of every store here; see the
 * per-script notes.
 */
export function buildCartPageCountScript(storeId: string): string | null {
  // Guarded stores are built PER CALL, not read from a module constant
  // (MEAL-156). The expected path comes from the cart URL in force right now, so
  // a remote `cartUrl` push repoints the navigation and the guard together. A
  // module-level constant would have frozen the guard at the bundled path at
  // import time and made every post-push load answer `not_cart_page`.
  //
  // If the guard path cannot be derived, the store is not counted at all rather
  // than counted unguarded: a malformed override must not silently downgrade a
  // store to the trusted-zero behaviour MEAL-152 removed.
  //
  // This branch is REACHABLE from a config push, and an earlier revision of this
  // comment claimed the opposite — that `^https://` in merge.ts closed every
  // route to it. It does not: `https://` is not a URL with a host, so
  // `https:///cart`, `https://`, `https://?q=1` and `https://#frag` are all
  // accepted by merge and all fail to parse here. A bare origin and a dot-segment
  // path reach it too. Substituting `build(cartPath ?? '/')` here turns every one
  // of those into a script guarded on `"/"`, which the store HOMEPAGE satisfies —
  // a trusted zero. Pinned in cartUrlFromConfig.test.ts under "overrides that
  // must be refused".
  const guarded = (build: (cartPath: string) => string): string | null => {
    const cartPath = getCartPagePath(storeId);
    return cartPath ? build(cartPath) : null;
  };
  if (storeId === 'heb') return guarded(HEB_CART_PAGE_SCRIPT);
  if (storeId === 'walmart') return guarded(WALMART_CART_PAGE_SCRIPT);
  if (storeId === 'wegmans') return guarded(WEGMANS_CART_PAGE_SCRIPT);
  if (storeId === 'amazon') return AMAZON_CART_PAGE_SCRIPT;
  if (storeId === 'mockstore') return MOCKSTORE_CART_PAGE_SCRIPT;
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return guarded(ALBERTSONS_CART_PAGE_SCRIPT);
  return null;
}

// Mock store /cart (dev/test only). Each line is .mock-cart-line[data-name] with
// a .mock-cart-name and .mock-cart-qty. Deterministic DOM, so no hydration race.
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

// Wegmans /cart line items: each item's stepper "Add" button carries both the
// name and the current qty in its aria-label —
//   "Add 1 ea to 2 ea of <name> in the cart"
// The page is mostly recommendation tiles whose buttons say "... of <name> to
// cart" (NOT "in the cart"), so the "in the cart" + "to N ea" pattern cleanly
// isolates real cart lines. The Remove button ("Remove 1 ea from N ea of ...")
// matches "from N ea", not "to N ea", so each line yields exactly one match.
// Verified against tests/fixtures/wegmans/cart-with-items.html (1 item, qty 2).
//
// No redirect has been observed on www.wegmans.com/cart (200, 0 redirects,
// measured anonymously on 2026-08-07 under the app's mobile UA). The guard is
// here because the FAILURE MODE is the same as Walmart's regardless of the
// cause: this script's "cart is empty" and "we are not on the cart" are the
// same zero, so any future redirect — or an expired session bounced to a sign-in
// wall — reads as an empty cart. See the note above cartPathGuardJs.
const WEGMANS_CART_PAGE_SCRIPT = (cartPath: string) => `(async function() {
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function norm(s){return (s||'').trim().replace(/\\s+/g,' ');}
${cartPathGuardJs(cartPath)}
  var ITEM_RE = /to (\\d+) ea of (.+?) in the cart/i;
  // Poll for cart line items (each increment button names item + current qty).
  var btns = [];
  for (var i=0;i<25;i++){
    btns = Array.prototype.slice.call(document.querySelectorAll('[aria-label*="in the cart"]'))
      .filter(function(b){ return ITEM_RE.test(b.getAttribute('aria-label')||''); });
    if (btns.length>0) break;
    await wait(200);
  }
  var count=0, items=[], seen={};
  for (var j=0;j<btns.length;j++){
    var m = (btns[j].getAttribute('aria-label')||'').match(ITEM_RE);
    if (!m) continue;
    var qty = parseInt(m[1],10); if (isNaN(qty)||qty<1) qty=1;
    var name = norm(m[2]);
    if (!name || seen[name]) continue;
    seen[name]=true;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type:'CART_COUNT', count: count, items: items }));
})(); true;`;

// Walmart /cart line items: each adjustable item has a [data-testid="quantity-label"]
// (the qty number) and a [data-testid="productName"] (the title). There's no
// shared per-row testid, so anchor on the quantity-label (only real in-cart items
// have a stepper — recommendation/OOS carousels don't) and walk up to the
// item-scoped product name. The single-productName guard avoids over-shooting to
// an ancestor that spans multiple items.
// Verified against tests/fixtures/walmart/cart-with-items.html (4 items).
//
// The page-identity guard is why MEAL-152 exists: www.walmart.com/cart 302s to
// the homepage, discarding the path, and the homepage has no quantity-label —
// so without it this script posts a trusted `count: 0`. See the note above
// cartPathGuardJs.
const WALMART_CART_PAGE_SCRIPT = (cartPath: string) => `(async function() {
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function norm(s){return (s||'').trim().replace(/\\s+/g,' ');}
${cartPathGuardJs(cartPath)}
  // Poll for line items (each has a quantity-label) to hydrate.
  var labels = [];
  for (var i=0;i<25;i++){
    labels = Array.prototype.slice.call(document.querySelectorAll('[data-testid="quantity-label"]'));
    if (labels.length>0) break;
    await wait(200);
  }
  function nameFor(label){
    var node = label;
    for (var d=0; d<10 && node; d++){
      var all = node.querySelectorAll ? node.querySelectorAll('[data-testid="productName"]') : [];
      if (all.length === 1) return norm(all[0].textContent);
      if (all.length > 1) return '';   // overshot — ancestor spans multiple items
      node = node.parentElement;
    }
    return '';
  }
  var count=0, items=[], seen={};
  for (var j=0;j<labels.length;j++){
    var qty = parseInt(norm(labels[j].textContent), 10);
    if (isNaN(qty) || qty < 1) qty = 1;
    var name = nameFor(labels[j]);
    if (!name || seen[name]) continue;
    seen[name] = true;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type:'CART_COUNT', count: count, items: items }));
})(); true;`;

// Amazon Fresh has no reliable direct cart URL: tapping the cart icon lands on
// the "cart of carts" page, from which the Amazon Fresh cart must be expanded
// before its line items render. This script handles BOTH pages:
//   • Expanded Fresh cart: each line item is a div.sc-list-item[data-quantity]
//     carrying the unit qty, holding a "Delete <name>" button (the product
//     name). The page renders responsive duplicates, so dedupe by data-itemid.
//   • Cart-of-carts: no line-item cards yet — click the Amazon Fresh expand
//     link (href contains cart_expand_link_fresh / /cart/localmarket) ONCE to
//     navigate to the expanded cart, after which onLoadEnd re-injects this
//     script.
// Verified against tests/fixtures/amazon-fresh/cart-fresh-full.html (Perdue
// Portions x2, Daisy x2, Mission x1, Perdue Harvestland x2 = 7) and the
// collapsed cart-with-items.html (0 cards, expand link present).
//
// NOT GUARDED, RECORDED (MEAL-152). This script has the same shape as the one
// the ticket is about: with no line-item cards and no expand link it falls
// through and posts `count: 0`, which callers trust. The path guard the other
// cart-page scripts use does not fit — Amazon is reached by CLICKING the cart
// icon and legitimately traverses several paths on the way (/gp/aw/c →
// /cart/localmarket → whatever the expand link resolves to), so there is no
// single pathname to assert, and a loose "looks cart-ish" test would be a guess.
// The honest guard needs a positive signal for "this IS the Amazon cart, and it
// is empty", which needs a captured empty-Fresh-cart fixture we do not hold.
// Written up for Stephen rather than guessed at.
const AMAZON_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  function lineItemCards() {
    return Array.prototype.slice.call(
      document.querySelectorAll('div.sc-list-item[data-quantity]')
    );
  }
  // Poll for the expanded Fresh cart's line-item cards to render.
  var cards = [];
  for (var i = 0; i < 25; i++) {
    cards = lineItemCards();
    if (cards.length > 0) break;
    await wait(200);
  }
  // No line items: we're on the cart-of-carts page. Expand the Fresh cart once
  // (guard against navigation loops), then let onLoadEnd re-inject this script.
  if (cards.length === 0) {
    var expand = document.querySelector(
      'a[href*="cart_expand_link_fresh"], a[href*="/cart/localmarket"]'
    );
    if (expand && !window.__mealioFreshExpanded) {
      window.__mealioFreshExpanded = true;
      var href = expand.getAttribute('href') || '';
      try { expand.click(); } catch (e) {}
      // Fall back to a hard navigation if the click didn't move us.
      if (href) { window.location.href = href; }
      return;
    }
  }
  var count = 0;
  var items = [];
  var seen = {};
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var id = card.getAttribute('data-itemid') || ('idx' + c);
    if (seen[id]) continue;
    seen[id] = true;
    var del = card.querySelector('[aria-label^="Delete "]');
    var al = del ? (del.getAttribute('aria-label') || '') : '';
    var name = norm(al.replace(/^Delete\\s+/i, ''));
    if (!name) continue;
    var qty = parseInt(card.getAttribute('data-quantity'), 10);
    if (!qty || isNaN(qty)) qty = 1;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  // Report the URL we actually counted on so the sheet can cache it and hit the
  // expanded Fresh cart directly for the after-snapshot (skipping the cart-icon
  // → cart-of-carts → expand-link hops).
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items, url: location.href }));
})(); true;`;

// Amazon Fresh cart icon: a#nav-button-cart (href /gp/aw/c?ref_=navm_hdr_cart)
// wraps the #nav-cart-count badge and sits in the header of every store page.
// Verified against tests/fixtures/amazon-fresh/search-results-tortillas.html.
const AMAZON_OPEN_CART_SCRIPT = `(function() {
  var icon = document.querySelector('#nav-button-cart')
    || document.querySelector('a[href*="navm_hdr_cart"]');
  if (!icon) {
    var badge = document.querySelector('#nav-cart-count');
    if (badge && badge.closest) icon = badge.closest('a');
  }
  if (icon) {
    var href = icon.getAttribute('href') || '';
    try { icon.click(); } catch (e) {}
    if (href) { window.location.href = href; }
  }
})(); true;`;

/**
 * Some stores have no reliable direct cart URL (e.g. Amazon Fresh gates direct
 * /cart loads). For those, this returns a script that CLICKS the in-page cart
 * icon to navigate to the cart, after which the cart-page count script is
 * injected on the resulting page load. Returns null for URL-based stores.
 */
export function buildOpenCartScript(storeId: string): string | null {
  if (storeId === 'amazon') return AMAZON_OPEN_CART_SCRIPT;
  return null;
}

// Instacart Storefront has NO dedicated cart page — the cart is an in-page side
// panel ([role="dialog"][aria-label="Cart"]) opened from the floating cart
// button. There's no navigation, so unlike HEB (URL) / Amazon (click→navigate)
// this script does the whole thing in one injected pass: open the panel (if
// closed), read each line item, post CART_COUNT, then close the panel so it
// doesn't cover the search bar for the next step. Per line item:
//   • name: the "Increment quantity of <name>" button's aria-label (minus the
//           prefix). Live line items have NO "Remove" button — only the
//           increment/decrement stepper — so the increment button is the anchor.
//   • qty:  the stepper's "Quantity: N" text (walk up from the increment button)
//
// Every selector here is the white-labelled platform's, observed on ALDI (the
// only banner we hold fixtures for). It is shared by every tenant in
// INSTACART_TENANTS because the side panel is Instacart's, not the banner's.
//
// NOT GUARDED, RECORDED (MEAL-152). There is no navigation and therefore no URL
// to check, but the same trusted-zero exists in a different form: if the opener
// is missing or the panel never renders its rows, the poll expires and this
// posts `count: 0` — "your cart is empty" and "the panel did not open" are the
// same number. The fix is a positive open-signal (the panel dialog present with
// its own empty-state), which needs a captured empty-panel fixture we do not
// hold. Written up for Stephen rather than guessed at.
const INSTACART_CART_PANEL_SCRIPT = `(async function() {
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function norm(s){return (s||'').trim().replace(/\\s+/g,' ');}

  // The cart opener: floating button, or the header "View Cart. Items in cart: N"
  // button (same element the header-badge count reads).
  var OPEN_SEL = '[data-testid="floating-cart-button"], button[aria-label^="View Cart"], button[aria-label*="Items in cart"]';
  // Each cart line item carries an "Increment quantity of <name>" button. Scope
  // detection to the dialog/overlay that contains them so we don't pick up the
  // increment buttons on search-result tiles (products already in the cart).
  var INC_SEL = 'button[aria-label^="Increment quantity of "]';

  // The opened cart's aria-label may differ from the empty placeholder's exact
  // "Cart", so don't match on label — find the FIRST [role=dialog] that actually
  // contains item rows (increment buttons).
  function cartItemBtns(){
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i=0;i<dialogs.length;i++){
      var b = dialogs[i].querySelectorAll(INC_SEL);
      if (b.length>0) return Array.prototype.slice.call(b);
    }
    return [];
  }

  // Detect FIRST (so we don't click an already-open panel shut). Only click the
  // opener when no populated cart is visible.
  var incBtns = cartItemBtns();
  if (incBtns.length === 0) {
    var opener = document.querySelector(OPEN_SEL);
    if (opener) { try { opener.click(); } catch(e){} }
  }
  // Poll for the panel's line items to render (up to ~6s).
  for (var j=0;j<30 && incBtns.length===0;j++){
    await wait(200);
    incBtns = cartItemBtns();
  }

  // Stepper qty for a row: walk up from the increment button to the container
  // that shows "Quantity: N" (bounded so we don't capture the whole panel / the
  // package descriptor like "(1 ct)" in the product name).
  function qtyForRow(btn){
    var node = btn;
    for (var d=0; d<5 && node; d++){
      var m = (node.textContent || '').match(/quantity:\\s*(\\d+)/i);
      if (m) return parseInt(m[1],10) || 1;
      node = node.parentElement;
    }
    return 1;
  }

  var count = 0, items = [], seen = {};
  for (var k=0;k<incBtns.length;k++){
    var name = norm((incBtns[k].getAttribute('aria-label')||'').replace(/^Increment quantity of\\s+/i,''));
    if (!name || seen[name]) continue;
    seen[name] = true;
    var qty = qtyForRow(incBtns[k]);
    count += qty;
    items.push({ name: name, qty: qty });
  }

  // Close the panel so it doesn't block the next search.
  try {
    var closeBtn = document.querySelector('[data-testid="cart-close-button"]');
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true}));
  } catch(e){}

  window.ReactNativeWebView.postMessage(JSON.stringify({ type:'CART_COUNT', count: count, items: items }));
})(); true;`;

/**
 * Stores whose cart is an in-page side panel (no dedicated URL, no navigation):
 * returns a single self-contained script that opens the panel, counts line
 * items, posts CART_COUNT { count, items:[{name,qty}] }, and closes the panel.
 * Inject it DIRECTLY (not via the nav/onLoadEnd chain). Null for other stores.
 */
export function buildInlineCartScript(storeId: string): string | null {
  // Registry-driven, not `storeId === 'aldi'`. The side panel is a property of
  // Instacart Storefront, so it belongs to every banner on it. Hardcoding one
  // banner meant a second tenant got null from all three of
  // buildInlineCartScript / buildCartPageCountScript / buildOpenCartScript, at
  // which point WebViewCartSheet takes NO cart-probe branch — no before
  // baseline, no after count, no cart breakdown on the done screen, and no
  // error either. Pinned by tests/unit/webview-scripts/instacartAdapter.test.ts.
  if (isInstacartStore(storeId)) return INSTACART_CART_PANEL_SCRIPT;
  return null;
}

// No redirect has been observed on www.heb.com/cart (200, 0 redirects, measured
// anonymously on 2026-08-07 under the app's mobile UA), so the guard below is
// a no-op on today's HEB.
//
// It is here because this snapshot is what the done screen's added-vs-already-
// there diff is computed against, and because HEB is one of the four families on
// the parallel-add path, whose reconcile probe diffs against this baseline
// WITHOUT checking that one was captured.
//
// One thing this comment claimed and had to withdraw, left visible because it is
// a link a reader would otherwise re-derive: this snapshot is NOT what the MEAL-14
// cart-query rail reads. That rail takes its own per-add baseline in-page via
// __hebCartRead (heb.ts ~:855, ~:1379) and never touches this one.
//
// See the note above cartPathGuardJs.
const HEB_CART_PAGE_SCRIPT = (cartPath: string) => `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
${cartPathGuardJs(cartPath)}
  function rowQty(row) {
    var inp = row.querySelector('[data-qe-id="cartQuantityCounterValue"]');
    if (!inp) return 0;
    // Prefer the live .value property; the value ATTRIBUTE is the server-rendered
    // initial qty and goes stale after a client-side increment.
    var v = parseInt(inp.value, 10);
    if (!v || isNaN(v)) {
      var alt = inp.getAttribute('aria-valuenow') || inp.getAttribute('value') || '';
      var m = String(alt).match(/(\\d+)/);
      v = m ? parseInt(m[1], 10) : 0;
    }
    return isNaN(v) ? 0 : v;
  }
  // Sold-by-weight lines have NO cartQuantityCounterValue — instead a
  // itemRowWeighedQuantityDropdown and an a11y "Quantity: N lb" label. Read the
  // weight (lb) so these aren't seen as qty 0 (which made reconcile think the
  // item was missing and re-add it). Returns the weight in lb, or 0 if not a
  // weight line.
  function rowWeightLb(row) {
    if (!row.querySelector('[data-qe-id="itemRowWeighedQuantityDropdown"]')) return 0;
    // Prefer the live select value; fall back to the a11y "Quantity: N lb" text
    // (server-rendered, present even when the select value isn't reflected as an
    // attribute).
    var sel = row.querySelector('[data-qe-id="itemRowWeighedQuantityDropdown"]');
    var w = sel ? parseFloat(sel.value) : NaN;
    if (!w || isNaN(w)) {
      var txt = row.textContent || '';
      var m = txt.match(/Quantity:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*lbs?/i);
      if (m) w = parseFloat(m[1]);
    }
    return (!w || isNaN(w)) ? 0 : w;
  }
  function snapshot() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-qe-id="itemRow"]'));
    var count = 0, items = [];
    for (var j = 0; j < rows.length; j++) {
      var nameEl = rows[j].querySelector('[data-qe-id="itemRowDetailsName"]');
      var nm = nameEl ? norm(nameEl.textContent) : '';
      var wlb = rowWeightLb(rows[j]);
      if (wlb > 0) {
        // Weight line: present in the cart at <wlb> lb. Count it as one unit so
        // the total stays meaningful; carry the weight + flag for reconcile.
        count += 1;
        if (nm) items.push({ name: nm, qty: 1, weight: wlb, isWeight: true });
      } else {
        var q = rowQty(rows[j]);
        count += q;
        if (nm) items.push({ name: nm, qty: q });
      }
    }
    return { count: count, items: items, rows: rows.length };
  }
  // Poll for item rows to render (HEB hydrates the cart client-side).
  var snap = snapshot();
  for (var i = 0; i < 20 && snap.rows === 0; i++) { await wait(200); snap = snapshot(); }
  // Stabilize: a line that was just incremented can briefly read its pre-update
  // qty, so the first read can under-count. Re-read until the total holds steady
  // across two consecutive reads (bounded) before trusting it.
  var stable = 0;
  for (var k = 0; k < 15; k++) {
    await wait(250);
    var next = snapshot();
    if (next.count === snap.count && next.rows === snap.rows) { stable++; snap = next; if (stable >= 2) break; }
    else { stable = 0; snap = next; }
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: snap.count, items: snap.items }));
})(); true;`;

// Albertsons family /erums/cart (Angular app). Each line item is an
// <app-cart-item> holding a.product-name (name + product id in the href) and a
// quantity stepper whose decrease-button id encodes the qty (fcdecBtn<pid>-<qty>),
// mirrored by the visible .stepper-qty text. The page renders each item twice
// (responsive desktop/mobile), so dedupe by product id. Verified against
// tests/fixtures/albertsons/cart-with-items.html (Basmati x2, Hunt's x1).
//
// WHY THIS SCRIPT CHECKS THE URL IT LANDED ON (MEAL-136).
//
// A wrong host in DOMAIN_MAP is invisible at runtime. United Supermarkets was
// pointed at its Squarespace marketing site, which 301s to the storefront apex
// DISCARDING the path — so we navigated to /erums/cart and got a marketing home
// page. This script then polled its full 5s, found zero product links, and
// posted `count: 0`.
//
// That is the whole reason the bug survived: `count: 0` is not a selector miss.
// It is a CONFIDENT WRONG ANSWER. `count: null` means "unknown, skip
// validation"; a number is trusted, so a zero flows into the before/after
// snapshot and cart reconciliation concludes the cart is empty. A silent-miss
// detector that reports "nothing was in the cart" for every run on a banner is
// worse than one that reports nothing at all.
//
// So: refuse to count on a page that is not the cart. Two cases, and they want
// opposite handling — the same split buildCheckLoginScript already makes:
//
//   • An auth/SSO interstitial is TRANSIENT. Albertsons bounces the storefront
//     through …/sso/authorize?code=… and back. Post no verdict at all and let
//     the landing page decide, exactly as the login check does — a verdict here
//     would burn the probe's single pending slot on a page that was never the
//     cart.
//
//     This branch is a BACKSTOP, not the primary defence, and an earlier version
//     of this comment had that wrong. It said both injection sites re-inject on
//     the next load. WebViewCartSheet does; SilentLoginProbe LATCHES on its first
//     injection, so relying on a re-inject there would have cost the probe its
//     one shot and left the run with no baseline at all (MEAL-152 found this and
//     added the same auth skip that branch already had for login). Neither site
//     injects on an interstitial now, so reaching this branch means something
//     upstream missed — which is exactly when a silent no-verdict is right.
//   • Anything else is TERMINAL — nothing further is loading, which is the
//     redirected-marketing-page case. Post `count: null` with a named reason so
//     the run degrades to "unknown" instead of "empty", and the reason lands in
//     the log where a wrong host is legible as a wrong host. Both CART_COUNT
//     handlers print `reason=`/`url=` for exactly that — WebViewCartSheet's
//     onMessage and SilentLoginProbe's. Neither stores them (the cached baseline
//     keeps only count/items/url), so those two log lines are the whole audit
//     trail; a handler that printed the count alone would make this reason
//     indistinguishable from a selector miss and the guard pointless.
//
// Note what this does NOT do: it never invents a count and never blocks a real
// cart page. The failure it converts is trusted-zero → honest-unknown, and the
// probe timeouts in WebViewCartSheet/SilentLoginProbe already cover silence.
//
// The check needs no per-banner configuration — ALBERTSONS_CART_PATH is uniform
// across all 15 banners, which is the MEAL-15 finding restated: paths generalise,
// hosts do not. The path is nevertheless passed in rather than read from that
// constant (MEAL-156), so that a remote `cartUrl` override for one banner moves
// that banner's guard with it; absent an override it derives back to exactly
// ALBERTSONS_CART_PATH, via getAlbertsonsCartPageUrl.
//
// This was the only guarded script when it was written, and the sentence here
// said the others had "no reported defect of this kind". They did. MEAL-152
// measured `https://www.walmart.com/cart` 302ing to the homepage — the same
// trusted zero, on a bigger store — and HEB and Wegmans had the identical shape
// with no redirect to trigger it yet. All three now carry the guard via
// cartPathGuardJs(); this script keeps its own copy because it predates the
// shared helper and its path comes from the banner registry.
const ALBERTSONS_CART_PAGE_SCRIPT = (cartPath: string) => `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'alb_cart_start', url: location.href })); } catch (e) {}

  // Did we actually land on the cart? See the note above.
  //
  // EXACT path match, modulo a trailing slash — not a prefix. A prefix test also
  // accepts sub-paths, so /erums/cart/checkout and /erums/cartoons would COUNT.
  // Neither exists on the platform today (both 404, while the real sibling
  // /erums/checkout is 200 and correctly rejected), so this closes a nit rather
  // than a live hole — but "starts with the cart path" is not the thing we mean.
  //
  // Query strings and hash fragments are deliberately unaffected: they are not
  // part of location.pathname, so /erums/cart?_t=… (the cache-buster both
  // injection sites append) and /erums/cart#items still count. That also fixes
  // the precedence between the two checks — /erums/cart?next=/sso/authorize is
  // the CART, even though its query matches the auth-redirect pattern, and the
  // path wins because we only consult that pattern once the path has failed.
  var __path = location.pathname;
  while (__path.length > 1 && __path.charAt(__path.length - 1) === '/') __path = __path.slice(0, -1);
  if (__path !== ${JSON.stringify(cartPath)}) {
    if (new RegExp(${JSON.stringify(AUTH_REDIRECT_URL_PATTERN)}).test(location.href)) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'alb_cart_skip_auth_redirect', url: location.href })); } catch (e) {}
      return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: location.href
    }));
    return;
  }

  // Poll for cart line items to hydrate.
  var links = [];
  for (var i = 0; i < 25; i++) {
    links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/shop/product-details."]'));
    if (links.length > 0) break;
    await wait(200);
  }
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'alb_cart_poll_done', links: links.length, polls: i, bodyLen: (document.body.innerText || '').length })); } catch (e) {}
  var count = 0;
  var items = [];
  var seen = {};
  for (var j = 0; j < links.length; j++) {
    var link = links[j];
    var href = link.getAttribute('href') || '';
    var pm = href.match(/product-details\\.(\\d+)\\.html/);
    if (!pm) continue;
    var pid = pm[1];
    if (seen[pid]) continue;
    var name = norm(link.textContent) || norm(link.getAttribute('aria-label'));
    if (!name) continue;
    // qty: prefer the visible stepper text, else parse the decrease-button id suffix.
    var qty = 0;
    // Real qty lives in the cart-qty display text ("N - click to specify a
    // quantity"). Do NOT use the stepper button id suffix (fcdecBtn<pid>-N) —
    // that N is the row index, not the quantity.
    var qEls = document.querySelectorAll(
      '[id^="cartQty' + pid + '"], [id="normal' + pid + '"], [id^="rounded-cartQty' + pid + '"]'
    );
    for (var qi = 0; qi < qEls.length; qi++) {
      var qmt = (qEls[qi].textContent || '').match(/\\d+/);
      if (qmt) { qty = parseInt(qmt[0], 10); break; }
    }
    if (!qty) qty = 1;
    seen[pid] = true;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items }));
})(); true;`;

/**
 * Returns an injectable script that posts CART_COUNT for this store, or null
 * when the store has no verified badge extractor (callers skip snapshots).
 * Polls up to 3s for the badge so a just-updated header can settle.
 */
export function buildCartCountScript(storeId: string): string | null {
  const ex = extractorFor(storeId);
  if (!ex) return null;
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var SEL = ${JSON.stringify(ex.sel)};
  var FROM = ${JSON.stringify(ex.from)};
  var RE = ${ex.re ? JSON.stringify(ex.re) : 'null'};
  var el = null;
  for (var i = 0; i < 15; i++) {
    el = document.querySelector(SEL);
    if (el) break;
    await wait(200);
  }
  var count = null;
  if (el) {
    var src = FROM === 'aria' ? (el.getAttribute('aria-label') || '') : (el.textContent || '');
    if (RE) {
      var m = src.match(new RegExp(RE));
      if (m) count = parseInt(m[1], 10);
    } else {
      var m2 = src.trim().match(/^(\\d+)$/);
      if (m2) count = parseInt(m2[1], 10);
    }
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count }));
})(); true;`;
}
