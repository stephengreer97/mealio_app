// Injectable JavaScript strings for H-E-B WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// SELECTORS ARE REMOTE-CONFIGURABLE (see ../automation-config). The literals in
// SEL_FALLBACKS ship in the binary; a config push overrides them without a
// release. Selectors must be read inside a build FUNCTION — the remote config
// arrives after this module is imported, so the script constants that carry
// selectors are functions rather than template-literal consts.

import { selectorsFor, storeConfig } from '../automation-config';

import { buildHebCartQueryFn, hebCartQueryEnabled } from './heb-cart-query';

export const HEB_URL = 'https://www.heb.com';
export const HEB_LOGIN_URL = 'https://www.heb.com/my-account/login';
export const HEB_CART_URL = 'https://www.heb.com/cart';

const SELECTOR_KEY = 'heb';

// Exported for the fixture drift census (MEAL-30), which resolves this table the
// same way the scripts do and counts what each selector matches in every captured
// page. It reads the real table rather than a copy precisely so the two cannot
// disagree about which selectors the store scripts depend on.
export const SEL_FALLBACKS = {
  title: '[data-qe-id="productTitle"]',
  // HEB layers sponsored/pairing carousels over the real results; only genuine
  // result tiles carry data-qe-id="productCard". See __hebFindCards below.
  productCard: '[data-qe-id="productCard"]',
  cardContainer: '[data-qe-id="productCardContainer"]',
  searchGrid: '#search_product_grid',
  legacyCard: '[data-component="product-card"], [data-qe-id="productCard"]',
  searchHeader: '#searchGridHeader',
  // Search UI. HEB opens search in a dialog on mobile, so the input is looked up
  // modal-first with a page-level fallback — a frequent breakage point, hence
  // every step of the chain is configurable.
  searchOpen: 'button[aria-label="Open search"], button[aria-label*="search" i]:not([type="submit"])',
  searchInputModal: 'dialog input[type="search"], [role="dialog"] input[type="search"], .modal input[type="search"], [class*="modal" i] input[type="search"]',
  searchInput: 'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"], input[name="search"], input[name="q"]',
  searchSubmit: 'button[type="submit"], button[aria-label*="Search" i]:not([aria-label*="Open"])',
};

/** Live selectors as interpolatable JS literals (quotes included). */
const sel = () => selectorsFor(SELECTOR_KEY, SEL_FALLBACKS);

/**
 * MEAL-13 flag: read candidates from `__NEXT_DATA__` instead of the DOM.
 *
 * Read through a FUNCTION for the same reason the selectors are (see the module
 * header): the remote config lands after this module is imported, so a
 * module-level const would freeze whatever the bundled default was at import
 * time and a config push could never turn this on.
 *
 * Default false — the DOM extractor is the shipped, known-good path.
 */
const nextDataEnabled = () => storeConfig(SELECTOR_KEY).nextDataSearch === true;
const networkAddEnabled = () => storeConfig(SELECTOR_KEY).networkAdd === true;

// ── Shared: find genuine search-result cards (skip carousels) ──────────────────
//
// HEB's search page layers several "product-card" components on top of the real
// results: a "<term>'s perfect pairings" entity carousel and a two-panel
// sponsored rail. Those use MiniProductCardBody — they carry
// data-component="product-card" but NOT data-qe-id="productCard". For a "Yogurt"
// search the pairings carousel led with "H-E-B Classic Granola", which the old
// selector ([data-component="product-card"], [data-qe-id="productCard"]) grabbed
// in DOM order as the first candidate.
//
// Genuine result tiles are the only ones with data-qe-id="productCard", and they
// live inside the search grid (#search_product_grid / [data-qe-id="productCardContainer"]).
// Select on that id, scoped to the grid, and fall back to the legacy combined
// selector only if the page exposes no productCard ids at all (older DOM variant).
const hebFindCardsFn = () => {
  const s = sel();
  return `
  function __hebFindCards() {
    var grid = document.querySelector(${s.cardContainer})
      || document.querySelector(${s.searchGrid});
    var scope = grid || document;
    var real = Array.prototype.slice.call(scope.querySelectorAll(${s.productCard}));
    if (real.length > 0) return real;
    return Array.prototype.slice.call(scope.querySelectorAll(${s.legacyCard}));
  }
`;
};

// ── Shared: read only FRESH results (skip the previous search's stale cards) ────
//
// HEB is an SPA: an in-page search changes the URL to /search?q=<newterm> and
// fetches results asynchronously, leaving the PREVIOUS search's product cards
// mounted for a beat. A naive "cards.length > 0" poll grabs those stale cards
// immediately (e.g. a "Cilantro" search returning the prior "Hoisin Sauce" page).
//
// HEB echoes the searched query into <h1 id="searchGridHeader">, which only
// updates once the new results render. So gate card-reads on the header matching
// the term in the URL. Falls back to whatever is present after gateMs (so an
// unusual/missing header can't stall the flow) and stops entirely after maxMs.
// Depends on __hebFindCards (interpolate HEB_FIND_CARDS_FN first).
const hebWaitFreshFn = () => {
  const s = sel();
  return `
  function __hebExpectedTerm() {
    try {
      var m = /[?&]q=([^&]*)/.exec(window.location.search || '');
      return m ? decodeURIComponent(m[1].replace(/\\+/g, ' ')) : '';
    } catch (e) { return ''; }
  }
  function __hebNorm(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function __hebHeaderFresh(expectedNorm) {
    if (!expectedNorm) return true; // no q param (e.g. a product page) — nothing to gate on
    var header = document.querySelector(${s.searchHeader});
    var ht = __hebNorm(header ? header.textContent : '');
    return !!ht && ht.indexOf(expectedNorm) !== -1;
  }
  async function __hebFreshCards(waitFn, maxMs, gateMs) {
    var expected = __hebNorm(__hebExpectedTerm());
    var cards = [];
    var waited = 0;
    while (waited < maxMs) {
      var fresh = waited >= gateMs || __hebHeaderFresh(expected);
      cards = __hebFindCards().slice(0, 20);
      if (fresh && cards.length > 0) break;
      await waitFn(200);
      waited += 200;
    }
    return { cards: cards, waitedMs: waited };
  }
`;
};

// ── Shared: read candidates out of __NEXT_DATA__ (MEAL-13) ────────────────────
//
// HEB is a Next.js app and ships the server-rendered search result set as JSON in
// <script id="__NEXT_DATA__">. The list lives at
//
//   props.pageProps.layout.visualComponents[]  → the entry with
//   __typename === 'SearchGridV2' (id 'searchGridV2:<uuid>')  → .items[]
//
// and on a search page that grid is the ONLY visual component: the "perfect
// pairings" entity carousel and the sponsored two-panel rail that both render
// data-component="product-card" in the DOM are client-fetched and appear nowhere
// in this payload. So the contamination __hebFindCards() exists to filter out
// cannot happen here — verified against every committed search fixture.
//
// WHAT THIS IS NOT: a replacement for the DOM. Four verified ways the payload is
// not usable, each of which returns a reason and sends the caller back to
// __hebFindCards():
//
//   1. ABSENT. Trimmed fixtures (and, presumably, some real renders) carry no
//      __NEXT_DATA__ at all.
//   2. STALE. __NEXT_DATA__ is the payload of the page's INITIAL server render and
//      is NOT rewritten by an in-page SPA search. HEB runs with spaSearch: true, so
//      after a client-side search the JSON still describes the PREVIOUS query while
//      the DOM shows the current one. tests/fixtures/heb/search-results-out-of-
//      stock.html is exactly this: the DOM is a "HEB season chicken thighs for
//      fajitas" page whose __NEXT_DATA__ still says searchTerm "seasonal". We
//      therefore require the payload's own search term to match the term in the
//      URL, and treat any mismatch as stale.
//   3. UNVERIFIABLE. No q in the URL means nothing independent to check the
//      payload's own search term against, so it goes unused (see the gate below).
//   4. EMPTY. A grid with zero items is indistinguishable from a payload we failed
//      to understand, so it is not trusted over a DOM read.
//
// A fifth, THREW, is handled at the call site rather than here: every field read
// below assumes the shapes documented in docs/heb-next-data-search-payload.md, and
// "HEB changed the payload" is precisely the risk this fallback exists for. A
// TypeError from an unexpected shape must land on the DOM path like any other
// failure, not kill the injected script and strand the run on its search timeout.
//
// Depends on __hebExpectedTerm/__hebNorm (interpolate HEB_WAIT_FRESH_FN first).
// Reads no selectors: the payload is addressed by JSON path and the gate reads the
// URL, so there is nothing here for a selector push to steer.
const hebNextDataFn = () => {
  return `
  function __hebNextDataGrid(nd) {
    var vcs = nd && nd.props && nd.props.pageProps && nd.props.pageProps.layout
      && nd.props.pageProps.layout.visualComponents;
    if (!vcs || !vcs.length) return null;
    for (var i = 0; i < vcs.length; i++) {
      var c = vcs[i];
      if (!c) continue;
      // Match on __typename, with the id prefix as a second signal in case the
      // GraphQL typename is renamed but the component id keeps its shape.
      if (c.__typename === 'SearchGridV2') return c;
      if (typeof c.id === 'string' && c.id.indexOf('searchGridV2:') === 0) return c;
    }
    return null;
  }

  /** A non-empty string, or null — so a malformed field reads as absent. */
  function __hebNextDataStr(v) {
    return (typeof v === 'string' && v) ? v : null;
  }

  // The name HEB's own ProductTitle component renders: the decoded display name,
  // plus the SKU's customer-friendly size when the name doesn't already end with
  // it. decodedDisplayName usually carries the size ("H-E-B Regular Sour Cream,
  // 16 oz") but for each-priced produce it does not ("Fresh Large Hass Avocado"
  // + size "Each" → the card reads "Fresh Large Hass Avocado, Each"). Getting
  // this exactly right is not cosmetic: scoreMatch needs === 100 and the add
  // scripts locate the card by comparing this string to the tile's title text.
  //
  // Each name field is checked for TYPE, not just falsiness. A non-string here
  // (an object, a number) is the payload not being what we think it is, and a
  // candidate whose productName isn't a string is worse than no candidate at all:
  // scoreMatch and the add scripts both call string methods on it, and the DOM
  // path can never produce one. Treat it as absent and let the next field — or,
  // if none is a string, the DOM — answer.
  function __hebNextDataName(item, sku) {
    var name = __hebNextDataStr(item.decodedDisplayName)
      || __hebNextDataStr(item.fullDisplayName)
      || __hebNextDataStr(item.displayName);
    if (!name) return null;
    // Same type discipline for the size: appending a non-string would put
    // "[object Object]" in the middle of a product name.
    var size = __hebNextDataStr(sku && sku.customerFriendlySize);
    if (size && name.slice(-size.length) !== size) name = name + ', ' + size;
    return name;
  }

  // The card's <img> requests the first carousel rendition at 360px; reproduce that
  // exact URL so a JSON candidate is byte-identical to a DOM one — pinned by the
  // DOM-vs-JSON fixture test.
  //
  // The MEDIUM fallback below is for the 7-of-336 fixture items that carry no
  // carousel renditions, and is NOT verified against a card: all 7 sit either in a
  // fixture whose DOM shows a different search or past the 8-candidate cap, so what
  // HEB's own <img> uses for them is unknown. It is a different URL form (a
  // prd-medium .jpg), so treat it as "an image of this product", not "the card's
  // image"; imageUrl is display-only and never matched on.
  function __hebNextDataImage(item) {
    var car = item.carouselImageUrls;
    if (car && car.length > 0 && typeof car[0] === 'string') return car[0] + '?hei=360&wid=360';
    var imgs = item.productImageUrls || [];
    for (var i = 0; i < imgs.length; i++) { if (imgs[i] && imgs[i].size === 'MEDIUM') return imgs[i].url || null; }
    return imgs.length > 0 ? (imgs[0].url || null) : null;
  }

  // Prices are quoted per shopping context (ONLINE vs CURBSIDE, which differ by a
  // few percent). The card shows the one for the session's own context, so pick by
  // shoppingContext ("CURBSIDE_DELIVERY" → "CURBSIDE") and fall back to ONLINE.
  // salePrice is what the tile displays; listPrice is the struck-through original.
  function __hebNextDataPrice(item, sku) {
    var cps = (sku && sku.contextPrices) || [];
    if (!cps.length) return null;
    var want = String(item.shoppingContext || '').split('_')[0];
    var pick = null;
    for (var i = 0; i < cps.length; i++) { if (cps[i] && cps[i].context === want) { pick = cps[i]; break; } }
    if (!pick) for (var j = 0; j < cps.length; j++) { if (cps[j] && cps[j].context === 'ONLINE') { pick = cps[j]; break; } }
    if (!pick) pick = cps[0];
    var p = pick && (pick.salePrice || pick.listPrice);
    var f = p && p.formattedAmount;
    return (typeof f === 'string' && /\\d/.test(f)) ? f : null;
  }

  // Returns { candidates, why, gridItems }. candidates is null unless the payload was
  // present, understood, for THIS search, and non-empty; "why" names the failure so
  // the funnel can tell "HEB changed the JSON" from "the store has no match". It is
  // deliberately NOT called "reason" — that name belongs to add-result reasons,
  // which are required to have a telemetry code each (the taxonomy guard in
  // tests/unit/automationTelemetry.test.ts scans these scripts for them).
  function __hebNextDataCandidates(limit) {
    var el = document.getElementById('__NEXT_DATA__');
    if (!el) return { candidates: null, why: 'no_next_data' };
    var nd = null;
    try { nd = JSON.parse(el.textContent || 'null'); } catch (e) { return { candidates: null, why: 'parse_error' }; }
    if (!nd) return { candidates: null, why: 'parse_error' };

    var grid = __hebNextDataGrid(nd);
    if (!grid) return { candidates: null, why: 'no_grid' };

    // Freshness gate — see notes 2 and 3 in the header comment. The ONLY accepted
    // signal is the term in the URL: it changes the instant an SPA search starts,
    // which is exactly when the payload goes stale, and it is set by us (or by
    // HEB's own pushState) rather than read out of the page we are judging.
    //
    // The echoed <h1> is deliberately NOT a fallback here, though the DOM path
    // gates on it. The DOM path POLLS the h1 until it matches the URL term, so the
    // h1 is checked against an independent statement of what was searched. With no
    // q there is no such statement, and h1-vs-payload is not one: during an SPA
    // search both lag TOGETHER — the h1 still shows the previous term because the
    // new results have not rendered, and the previous term is exactly what the
    // payload contains. They agree, and both are wrong. (Demonstrated: the
    // out-of-stock fixture with no q and its h1 rewritten to "seasonal" happily
    // served the previous search's Morton Season-All.) So a q-less render — a
    // path-style searchUrlTemplate push, say, since that field rides the same
    // config channel as this flag — declines and uses the DOM.
    //
    // This is deliberately an equality test, not a contains: if HEB relaxes or
    // spell-corrects the query, its searchTerm won't equal ours and we fall back
    // to the DOM. Losing the fast path is fine; serving another search is not.
    var expected = __hebNorm(__hebExpectedTerm());
    var embedded = __hebNorm(
      (nd.props && nd.props.pageProps && nd.props.pageProps.searchTerm)
      || (nd.query && nd.query.q) || ''
    );
    if (!expected) return { candidates: null, why: 'unverifiable', embeddedTerm: embedded };
    if (embedded !== expected) {
      return { candidates: null, why: 'stale', embeddedTerm: embedded, expectedTerm: expected };
    }

    var items = grid.items || [];
    var out = [];
    var seen = new Set();
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || (it.__typename && it.__typename !== 'Product')) continue;
      var sku = (it.SKUs || [])[0] || null;
      var name = __hebNextDataName(it, sku);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      var wopts = [];
      var wsi = (sku && sku.weightSelectionIncrements) || [];
      for (var w = 0; w < wsi.length; w++) {
        var wv = parseFloat(wsi[w]);
        if (wv > 0) wopts.push(wv);
      }

      var prefs = null;
      var ppl = it.purchasePreferenceList;
      if (ppl && ppl.purchasePreferences && ppl.purchasePreferences.length > 0) {
        prefs = [];
        for (var p = 0; p < ppl.purchasePreferences.length; p++) {
          var t = ppl.purchasePreferences[p] && ppl.purchasePreferences[p].text;
          // Same {text, value} pair the DOM path builds from a modal row label —
          // the add scripts match a row by comparing against .text.
          if (t) prefs.push({ text: String(t).trim(), value: String(t).trim() });
        }
        if (prefs.length === 0) prefs = null;
      }

      out.push({
        productName: name,
        imageUrl: __hebNextDataImage(it),
        // inventoryState is the payload's own stock verdict; the DOM equivalent is
        // the Add button reading "Out of stock"/"Notify me".
        outOfStock: !!(it.inventory && it.inventory.inventoryState !== 'IN_STOCK'),
        preferences: prefs,
        price: __hebNextDataPrice(it, sku),
        isWeightItem: wopts.length > 0,
        weightOptions: wopts,
        // MEAL-14 wants these addressable; only this path can supply them (the
        // card markup carries no id), so they are optional on the candidate.
        productId: it.id != null ? String(it.id) : null,
        skuId: sku && sku.id != null ? String(sku.id) : null,
      });
      if (limit > 0 && out.length >= limit) break;
    }

    if (out.length === 0) return { candidates: null, why: 'empty', gridItems: items.length };
    return { candidates: out, why: 'ok', gridItems: items.length };
  }
`;
};

// ── Login check ───────────────────────────────────────────────────────────────

/**
 * Injected on HEB page load. Posts { type: 'LOGIN_STATUS', isLoggedIn: bool }.
 */
export const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__hebLoginCheckActive) return;
  window.__hebLoginCheckActive = true;
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // Poll for the profile button (up to ~10s on a slow network, usually < 1s).
    // The page itself may not have rendered yet on a bad connection, so we wait
    // for the button rather than giving up early and reporting logged-out.
    var profileBtn = null;
    for (var pi = 0; pi < 50; pi++) {
      profileBtn = document.querySelector('button[aria-label*="account" i]')
        || document.querySelector('button[aria-label*="profile" i]');
      if (profileBtn) break;
      await wait(200);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'profile_btn',
      found: !!profileBtn,
      ariaLabel: profileBtn ? profileBtn.getAttribute('aria-label') : null
    }));

    if (!profileBtn) {
      window.__hebLoginCheckActive = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));
      return;
    }

    // Click the profile icon. Two outcomes:
    // Logged in: stays on heb.com and opens an in-page account panel that
    //   contains a "Log out" control.
    // Not logged in: navigates to accounts.heb.com (kills this script;
    //   onLoadEnd fallback in WebViewCartSheet detects the login page).
    profileBtn.click();

    // Require POSITIVE proof of login: poll for the panel's "Log out" / "Sign
    // out" control to appear (up to ~3s). NEVER infer login from the absence of
    // a redirect — a slow network can stall the logged-out redirect past our
    // wait and make a signed-out session look signed-in. If the marker never
    // appears we report logged-out and the user is shown the login webview.
    // Collect visible text INCLUDING one level of shadow DOM — HEB's account
    // panel may render inside a web component whose text document.body.innerText
    // does not see (which would make a logged-in panel look logged-out).
    function deepText() {
      var out = document.body.innerText || '';
      var hosts = document.querySelectorAll('*');
      for (var hi = 0; hi < hosts.length; hi++) {
        var sr = hosts[hi].shadowRoot;
        if (sr) { try { out += ' ' + (sr.textContent || ''); } catch (e) {} }
      }
      return out;
    }
    var LOGGED_IN_RE = /log ?out|sign ?out/;
    var loggedIn = false;
    var lastText = '';
    for (var ci = 0; ci < 40; ci++) {           // up to ~8s for the panel to render
      await wait(200);
      lastText = deepText().toLowerCase();
      if (LOGGED_IN_RE.test(lastText)) { loggedIn = true; break; }
    }

    if (!loggedIn) {
      // Diagnostic: dump what the panel actually rendered so we can pick a
      // reliable logged-in marker when the default one misses.
      var shadowHosts = 0;
      var allEls = document.querySelectorAll('*');
      for (var si = 0; si < allEls.length; si++) { if (allEls[si].shadowRoot) shadowHosts++; }
      var panels = Array.prototype.slice.call(
        document.querySelectorAll('[role="dialog"], aside, [class*="drawer" i], [class*="panel" i], [class*="account" i]'), 0, 6
      ).map(function(d) {
        return { tag: d.tagName, cls: (d.getAttribute('class') || '').slice(0, 60), text: (d.innerText || '').trim().slice(0, 220) };
      });
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'LOGIN_DEBUG', step: 'panel_miss',
        shadowHosts: shadowHosts,
        textSample: lastText.slice(0, 1500),
        panels: panels
      }));
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'panel_check', loggedIn: loggedIn }));

    // Close any panel that opened, then report the proven state.
    document.body.click();
    await wait(200);
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: loggedIn }));
  } catch(e) {
    window.__hebLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ────────────────────────────────────────────────────────

/**
 * Injected after navigating to a HEB search results page.
 * Extracts product candidates and reads preference options for applicable products.
 * Posts { type: 'SEARCH_RESULT', candidates: [...], source: 'next_data' | 'dom' }.
 *
 * Two extractors, one output shape. With `nextDataSearch` pushed on, the embedded
 * __NEXT_DATA__ payload is read first (MEAL-13) and the DOM scrape runs only if
 * that payload is absent, unparseable, stale, unverifiable, empty, or of a shape
 * that made the reader throw. `source` rides on every SEARCH_RESULT so the two can
 * be compared in telemetry before the DOM path goes.
 */
export function buildExtractProductsScript(): string {
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Suppress mobile keyboard throughout — any input that receives focus gets inputmode="none".
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);
${hebFindCardsFn()}
${hebWaitFreshFn()}
${hebNextDataFn()}
  // MEAL-13 fast path: the search result set is already in the page as JSON, so
  // when the flag is on there is nothing to poll for and no carousel to filter.
  // Any reason it can't be trusted falls through to the DOM extractor below.
  if (${nextDataEnabled()}) {
    // A throw is just another fallback reason. The reader walks a payload shape we
    // do not control, so an unexpected one (e.g. a repeated ?q=, which Next.js
    // parses to an ARRAY that __hebNorm's .toLowerCase() cannot take) must not
    // escape: an uncaught error here posts NOTHING — no debug, no SEARCH_RESULT —
    // and the item dies on the engine's search timeout instead of falling back.
    var __nd;
    try {
      __nd = __hebNextDataCandidates(8);
    } catch (e) {
      __nd = { candidates: null, why: 'threw', error: String(e && e.message || e) };
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'EXTRACT_DEBUG', step: 'next_data', ndReason: __nd.why,
      count: __nd.candidates ? __nd.candidates.length : 0, gridItems: __nd.gridItems || 0,
      embeddedTerm: __nd.embeddedTerm, expectedTerm: __nd.expectedTerm,
      ndError: __nd.error, url: window.location.href
    }));
    if (__nd.candidates) {
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'SEARCH_RESULT', candidates: __nd.candidates, source: 'next_data'
      }));
      return;
    }
  }

  // Poll for the product grid instead of a single 800ms check. A warm webview
  // (sequential flow) paints cards almost immediately, but a freshly-mounted
  // worker webview (parallel flow) needs several seconds on its first load to
  // bootstrap HEB's SPA before the grid renders — a one-shot 800ms wait read
  // an empty page and reported 0. Poll up to ~14s; return as soon as cards for
  // the SEARCHED TERM appear (header gate), so we never read the previous
  // search's stale cards and the warm case stays fast. Past gateMs (8s) we
  // accept whatever is present so an unusual header can't stall the flow.
  var __fresh = await __hebFreshCards(wait, 14000, 8000);
  var cards = __fresh.cards;
  var waitedMs = __fresh.waitedMs;
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'poll_done', url: window.location.href, cardCount: cards.length, waitedMs: waitedMs }));

  var TITLE_SEL = ${s.title};

  if (cards.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [], source: 'dom' }));
    return;
  }

  var seen = new Set();
  var candidates = [];

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector('button[data-qe-id="addToCart"]');
    var btnText = addBtn ? addBtn.textContent.trim() : '';
    var outOfStock = /out of stock|notify me|unavailable/i.test(btnText);
    var hasPopup = addBtn ? addBtn.getAttribute('aria-haspopup') === 'true' : false;
    var hasAnyDropdown = addBtn ? (!!addBtn.getAttribute('aria-haspopup') && addBtn.getAttribute('aria-haspopup') !== 'false') : false;
    // Sold-by-weight items expose a native <select name="addByWeight"> whose
    // options are the buyable weights (lb). This is the reliable signal (the old
    // name/", lb" heuristic missed bulk items like "… Bulk Coffee, lb"). Read the
    // real weight options so the chooser/add can use the product's own increment.
    var weightSelect = card.querySelector('select[name="addByWeight"]');
    var weightOptions = weightSelect ? Array.from(weightSelect.options).map(function(o) { return parseFloat(o.value); }).filter(function(v) { return v > 0; }) : [];
    var isWeightItem = weightOptions.length > 0 || (/H-E-B (Deli|Fish Market)/i.test(name) && (hasAnyDropdown || /, lb$/i.test(name)));
    var imgEl = card.querySelector('img');
    var imageUrl = imgEl ? imgEl.src : null;
    var priceEl = card.querySelector('[data-qe-id="productPrice"]')
      || card.querySelector('[data-testid*="price" i]')
      || card.querySelector('[class*="ProductPrice" i]')
      || card.querySelector('[class*="product-price" i]');
    if (ci === 0) {
      var dbg = {
        cardHtml: card.innerHTML.slice(0, 800),
        priceElFound: !!priceEl,
        priceElHtml: priceEl ? priceEl.outerHTML.slice(0, 400) : null,
        addBtnFound: !!addBtn,
        ariaHasPopup: addBtn ? addBtn.getAttribute('aria-haspopup') : null,
        hasPopup: hasPopup,
        outOfStock: outOfStock,
        addBtnHtml: addBtn ? addBtn.outerHTML.slice(0, 400) : null,
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PRICE_DEBUG', dbg: dbg }));
    }
    var price = null;
    if (priceEl) {
      var strikeEl = priceEl.querySelector('[data-testid="strike-through-price"]');
      if (strikeEl) {
        // Sale price: find the leaf span after the strikethrough that contains a $ amount.
        var saleSource = strikeEl.nextElementSibling || strikeEl.parentElement;
        if (saleSource) {
          var saleSpans = Array.from(saleSource.querySelectorAll('span'));
          var saleLeaf = saleSpans.find(function(s) { return /\\$\\d/.test(s.textContent) && !s.querySelector('span'); });
          price = saleLeaf ? saleLeaf.textContent.trim() : (saleSource.textContent.match(/\\$[\\d.]+/) || [])[0] || null;
        }
      } else {
        // Regular price: find the leaf span that starts with a $ amount (excludes unit "each", per-oz spans).
        var allSpans = Array.from(priceEl.querySelectorAll('span'));
        var leafPrice = allSpans.find(function(s) { return /^\\s*\\$\\d/.test(s.textContent) && !s.querySelector('span'); });
        if (leafPrice) {
          price = leafPrice.textContent.trim();
        } else {
          price = (priceEl.textContent.match(/\\$[\\d.]+/) || [])[0] || null;
        }
      }
    }
    if (price) {
      price = price.split('(')[0].trim();
      if (!price || !/\\d/.test(price)) price = null;
    }

    var preferences = null;
    // The preference probe. Clicking Add here does NOT add anything — it opens
    // the store's preference dialog purely to read the option rows, then closes
    // it — and it is the only way this page yields a preference list, so an item
    // that is not probed reaches Choose Products with preferences:null and shows
    // the user no selection at all (MEAL-180).
    //
    // Four gates, and the diagnostics below have to tell them apart:
    //   hasPopup            the Add button says it opens a dialog. Read off
    //                       aria-haspopup, which is set on hydration — a card
    //                       probed too early reads false and is skipped.
    //   !outOfStock         nothing to choose a preference for.
    //   addBtn              no button, nothing to click.
    //   candidates.length<11 the cap, and it counts ACCEPTED candidates rather
    //                       than probes performed. At <5 that was the bug: the
    //                       seven pre-packaged deli cards ahead of the Custom
    //                       Sliced turkey had no dialog to open and cost nothing,
    //                       but they still spent the whole budget, so the one
    //                       probeable card on the page was skipped and reached
    //                       Choose Products with preferences:null. The extract
    //                       loop stops at 8 candidates, so 11 is above the
    //                       ceiling — every card with a dialog now gets probed.
    if (hasPopup && !outOfStock && addBtn && candidates.length < 11) {
      try {
        // ci (card index in DOM order) and candidatesLen are what separate
        // "outside the cap" from "the button had not hydrated" after the fact.
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'clicking_add', name: name, ci: ci, candidatesLen: candidates.length }));
        addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        addBtn.click();

        // Poll for a dialog that actually contains preference rows (ignores unrelated dialogs like video.js modals).
        var modal = null;
        var rows = [];
        for (var mi = 0; mi < 40; mi++) {
          // Check dedicated containers first
          var prefContainer = document.querySelector('[data-qe-id="preferencesRowContainer"]');
          if (!prefContainer) { var fs = document.querySelector('fieldset[aria-live="polite"]'); if (fs) prefContainer = fs.parentElement || fs; }
          if (prefContainer) {
            var prefRows = Array.from(prefContainer.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
            if (prefRows.length > 0) { modal = prefContainer; rows = prefRows; break; }
          }
          // Search all dialogs for one containing preference rows
          var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="presentation"]')).filter(function(d) { return d.getAttribute('aria-label') !== 'Search'; });
          for (var di = 0; di < dialogs.length; di++) {
            var dRows = Array.from(dialogs[di].querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
            if (dRows.length > 0) { modal = dialogs[di]; rows = dRows; break; }
          }
          if (modal) break;
          await wait(100);
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'modal_found', name: name, found: !!modal, modalTag: modal ? (modal.getAttribute('data-qe-id') || modal.getAttribute('role') || modal.tagName) : null }));
        if (modal) {
          var opts = [];
          for (var ri = 0; ri < rows.length; ri++) {
            var row = rows[ri];
            var label = row.querySelector('label, [class*="preferenceName"]');
            var labelText = label ? label.textContent.trim() : null;
            if (labelText) opts.push({ text: labelText, value: labelText });
          }
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'rows_found', name: name, rowCount: rows.length, opts: opts, modalHtml: rows.length === 0 ? modal.innerHTML.substring(0, 2000) : null }));
          if (opts.length > 0) preferences = opts;

          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
          var closeBtn = modal.querySelector('button[aria-label*="close" i]');
          if (closeBtn) closeBtn.click();
          await wait(400);
        }
      } catch(e) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'error', name: name, err: String(e) }));
      }
    } else {
      // Every unprobed card reports why, and ci says where it sat — that pair is
      // what identified the cap as the cause of MEAL-180 rather than a hydration
      // race. Now that the cap sits above the 8-candidate ceiling, hasPopup:false
      // should be the only reason a card appears here. At most 8 lines per search.
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PREF_DEBUG', step: 'skipped', name: name, ci: ci, hasPopup: hasPopup, outOfStock: outOfStock, hasAddBtn: !!addBtn, candidatesLen: candidates.length }));
    }

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: preferences, price: price, isWeightItem: isWeightItem, weightOptions: weightOptions });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates, source: 'dom' }));
})();true;`;
}

// ── Add to cart ───────────────────────────────────────────────────────────────

/**
 * Builds a script that adds a specific product to the HEB cart.
 * The script finds the product card by exact name, handles preferences, and clicks add N times.
 * Posts { type: 'ADD_RESULT', success: bool, reason?: string }.
 */
export function buildAddToCartScript(
  productName: string,
  preference: { text: string } | null,
  qty: number,
  targetWeightLb?: number | null,
): string {
  const escapedName = JSON.stringify(productName);
  const escapedPref = preference ? JSON.stringify(preference) : 'null';
  const s = sel();
  const weightTarget = (targetWeightLb != null && !Number.isNaN(targetWeightLb)) ? targetWeightLb : 'NaN';

  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Suppress mobile keyboard for the entire add-to-cart operation.
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var PREFERENCE = ${escapedPref};
  var QTY = ${qty};
  // Remembered buy-weight (lb) for a sold-by-weight item; handleWeightDropdown
  // selects the option closest to it. NaN = no weight target (normal item).
  var __WEIGHT_TARGET = ${weightTarget};

  // Handles fresh fish/meat items where Add to Cart opens a weight picker.
  // 1 qty = 0.25 lbs. Tries native <select> then ARIA [role="listbox"].
  async function handleWeightDropdown(qty, scope) {
    // HEB "add by weight" items use a native <select name="addByWeight"> whose
    // options ARE the buyable weights (value + "N lb" text; option value 0 is the
    // "Select a Weight" placeholder). Increments differ per product (0.5 lb for
    // bulk coffee, 1 lb for others), so select the qty-th REAL option rather than
    // assuming a fixed lb-per-qty. Setting the value and firing change adds the
    // item — there is no separate confirm. Scope to the target card / a picker
    // modal our click opened, never a sibling card's dropdown (which would add an
    // unrelated product).
    // A remembered weight rides in as DROPDOWN { type:'weight', selectedValue:lb }
    // on the combined search-and-add path. Prefer the option closest to that
    // absolute weight (the store's increments can differ/change); otherwise fall
    // back to the qty-th option. (typeof-guarded so this same helper is valid in
    // buildAddToCartScript, which has no DROPDOWN var.)
    var __targetLb = (typeof DROPDOWN !== 'undefined' && DROPDOWN && DROPDOWN.type === 'weight')
      ? parseFloat(DROPDOWN.selectedValue)
      : (typeof __WEIGHT_TARGET !== 'undefined' ? __WEIGHT_TARGET : NaN);
    function __closestOpt(opts, target) {
      var best = opts[0], bestD = Infinity;
      for (var i = 0; i < opts.length; i++) {
        var raw = opts[i].value != null && opts[i].value !== '' ? opts[i].value : opts[i].textContent;
        var d = Math.abs(parseFloat(raw) - target);
        if (d < bestD) { bestD = d; best = opts[i]; }
      }
      return best;
    }
    function pickIn(root) {
      var sel = root.querySelector('select[name="addByWeight"]');
      if (sel) {
        var real = Array.from(sel.options).filter(function(o) { return parseFloat(o.value) > 0; });
        if (real.length > 0) {
          var pick = !isNaN(__targetLb) ? __closestOpt(real, __targetLb) : real[Math.min(Math.max(1, qty), real.length) - 1];
          sel.value = pick.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      var listbox = root.querySelector('[role="listbox"]');
      if (listbox) {
        var lbOpts = Array.from(listbox.querySelectorAll('[role="option"]')).filter(function(o) { return /\\blbs?\\b/i.test(o.textContent); });
        if (lbOpts.length > 0) {
          var lbPick = !isNaN(__targetLb) ? __closestOpt(lbOpts, __targetLb) : lbOpts[Math.min(Math.max(1, qty), lbOpts.length) - 1];
          lbPick.click();
          return true;
        }
      }
      return false;
    }
    var handledRoot = null;
    if (scope && pickIn(scope)) handledRoot = scope;
    if (!handledRoot) {
      var dialog = document.querySelector('[role="dialog"]:not([aria-label="Search"]), [role="presentation"]:not([aria-label="Search"])');
      if (dialog && (!scope || !scope.contains(dialog)) && pickIn(dialog)) handledRoot = dialog;
    }
    if (!handledRoot) return false;
    await wait(400);
    var confirmBtn = handledRoot.querySelector('button[data-qe-id="cartQuantityTrigger"]') || document.querySelector('button[data-qe-id="cartQuantityTrigger"]');
    if (confirmBtn) { confirmBtn.click(); await wait(400); }
    return true;
  }

  var TITLE_SEL = ${s.title};
  // The in-page twin of cart-count's normalizeName: lowercase, every run of
  // non-alphanumerics to one space, trimmed. No entity decoding — textContent has
  // already decoded them, which is the one thing normalizeName has to do itself.
  // (hebWaitFreshFn carries the same function as __hebNorm for the freshness gate,
  // but it is not interpolated into this script — hence the separate name.)
  function __hebNormTitle(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
${hebFindCardsFn()}
  // MEAL-14 cart-query rail (see webview-scripts/heb-cart-query). Off by default;
  // when on it decides the normal add path below and the DOM signals stay as the
  // fallback for every way a cart read can fail.
  var __HEB_CART_RAIL = ${hebCartQueryEnabled() ? 'true' : 'false'};
${buildHebCartQueryFn()}
  var __cartTarget = null;
  var __cartQueryBefore = null;
  var __cartConf = null;

  // Product-specific add confirmation: HEB relabels a card's own Add button to
  // "N added" once the item is in the cart. Unlike the shared header badge, this
  // can't be nudged by a sibling worker's add, so it is the reliable success
  // signal. Returns 0 while the button still reads "Add to Cart".
  function __cardAddedQty(card) {
    var b = card && card.querySelector('button[data-qe-id="addToCart"]');
    var m = (b ? (b.textContent || '') : '').match(/(\\d+)\\s*added/i);
    return m ? parseInt(m[1], 10) : 0;
  }
  async function __waitCardAdded(card, target, ticks) {
    for (var w = 0; w < ticks; w++) { if (__cardAddedQty(card) >= target) return true; await wait(200); }
    return false;
  }

  await wait(800);

  var cards = __hebFindCards();
  var targetCard = null;
  for (var ci = 0; ci < cards.length; ci++) {
    var el = cards[ci].querySelector(TITLE_SEL);
    if (el && el.textContent.trim() === TARGET_NAME) {
      targetCard = cards[ci];
      break;
    }
  }
  // Second pass, punctuation- and case-insensitive — the same normalization
  // cart-count's normalizeName applies before it compares two titles, so this is
  // still an EXACT match, not a lenient one.
  //
  // It exists because TARGET_NAME does not always come from a search page. On the
  // MEAL-119 top-up it is a cart row's own title, and everything else that
  // compares those two sources normalizes first (cart-reconcile does not even
  // offer a raw pass in front of its presence matching). A hyphen, an ampersand or
  // a stray double space between the cart's rendering of a name and the search
  // page's would end the press as ADD_RESULT not_found — the user is told, but
  // they are told the top-up they asked for failed.
  //
  // Deliberately stops short of cartNameMatches' 0.6 token overlap: this
  // comparison decides WHICH PRODUCT to buy, and a lenient match here would buy
  // the wrong thing rather than merely report the right thing wrongly. Same-tokens
  // normalization cannot reach a different product; a token subset can.
  if (!targetCard) {
    var TARGET_NORM = __hebNormTitle(TARGET_NAME);
    for (var cj = 0; cj < cards.length; cj++) {
      var el2 = cards[cj].querySelector(TITLE_SEL);
      if (el2 && TARGET_NORM && __hebNormTitle(el2.textContent) === TARGET_NORM) {
        targetCard = cards[cj];
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '1_title_normalized', target: TARGET_NAME, matched: el2.textContent.trim() }));
        break;
      }
    }
  }

  if (!targetCard) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  var addBtn = targetCard.querySelector('button[data-qe-id="addToCart"]');
  if (!addBtn) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_button' }));
    return;
  }

  var hasPopup = addBtn.getAttribute('aria-haspopup') === 'true';
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '1_btn', hasPopup: hasPopup, hasPref: !!PREFERENCE, qty: QTY, name: TARGET_NAME }));

  // MEAL-14 baseline, issued here — after the target is known, before any branch
  // below clicks anything, so whatever it returns is a true "before" for every
  // path. Awaited lazily (__cartBaseline) so the round trip overlaps the scroll
  // and modal-polling those paths already spend, rather than adding to them.
  if (__HEB_CART_RAIL) __cartTarget = __hebTargetFromCard(targetCard, TARGET_NAME);
  // Logged because confirm.skuId comes from the matched CART line, so it is
  // not evidence this card-side lookup ran (MEAL-139).
  if (__cartTarget) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'cart_query_target', productId: __cartTarget.productId, skuId: __cartTarget.skuId }));
  var __cartBeforeP = __cartTarget ? __hebCartRead(6000) : null;
  async function __cartBaseline() {
    if (__cartBeforeP && !__cartQueryBefore) __cartQueryBefore = await __cartBeforeP;
    return __cartQueryBefore;
  }

  if (hasPopup && PREFERENCE) {
    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    // Settle the baseline BEFORE the first click. Issuing the read early is only
    // safe if its response lands first: a read still in flight when the store
    // commits our add would come back already counting it, and the cross-check
    // would then read an unchanged line and call a successful add missing.
    await __cartBaseline();
    addBtn.click();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '2_atc_clicked' }));

    // Pick the container that actually HOLDS preference rows, not the first one
    // that matches (MEAL-181).
    //
    // H-E-B leaves earlier dialogs in the DOM. Measured on a device 2026-08-29:
    // two [role="dialog"] elements, identical class
    // (ModalContainers_modalContent__o_tcp), and the rows lived in the SECOND —
    // so document.querySelector handed back a stale shell, scoping found nothing
    // inside it, and the add died as no_row with every class name on the page
    // unchanged. Nothing was renamed; we were looking in the wrong box. That is
    // easy to reach here because spaSearch means the whole run happens in one
    // document, so modals accumulate.
    var modal = null, anyContainer = null;
    for (var mi = 0; mi < 15; mi++) {
      var cands = Array.prototype.slice.call(document.querySelectorAll('[data-qe-id="preferencesRowContainer"],fieldset[aria-live="polite"],[role="dialog"]:not([aria-label="Search"]),[role="presentation"]:not([aria-label="Search"])'));
      for (var ci = 0; ci < cands.length; ci++) {
        var cand = cands[ci].tagName === 'FIELDSET' ? (cands[ci].parentElement || cands[ci]) : cands[ci];
        // Last match wins among equals: a freshly opened modal is appended after
        // the stale one, so the newest is the one the user is looking at.
        if (cand.querySelector('[class*="preferenceContainer"]')) modal = cand;
        anyContainer = cand;
      }
      if (modal) break;
      await wait(150);
    }
    // Fall back to SOME container so a genuinely unfamiliar layout still reports
    // no_row, which names the rows, rather than no_modal, which blames the shell.
    if (!modal) modal = anyContainer;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '3_modal', found: !!modal }));

    if (!modal) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_modal' }));
      return;
    }

    // Poll for preference rows (modal shell may render before rows appear)
    var rows = [];
    for (var pri = 0; pri < 20; pri++) {
      rows = Array.from(modal.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
      if (rows.length > 0) break;
      await wait(100);
    }
    // MEAL-181. When rowCount is 0 the run dies as no_row, and a bare count
    // cannot separate a renamed class from a wrongly-scoped modal, which are
    // opposite fixes. So a zero reports what it looked at and what the document
    // actually holds. Failing branch only, class names only, so the bridge
    // carries a few hundred bytes rather than a DOM.
    // MEAL-181. A bare rowCount of 0 cannot separate a renamed class from a
    // wrongly-scoped container, and those have opposite fixes — chasing the
    // first cost this ticket its whole first pass. So a zero says which box it
    // looked in and whether the rows exist elsewhere. Failing branch only.
    var __dbg = { type: 'ADD_DEBUG', step: '4_rows', rowCount: rows.length };
    if (rows.length === 0) {
      try {
        var __row = document.querySelector('[class*="preferenceContainer"]');
        __dbg.modalClass = String(modal.className || '').slice(0, 60);
        __dbg.dialogCount = document.querySelectorAll('[role="dialog"]:not([aria-label="Search"]),[role="presentation"]:not([aria-label="Search"])').length;
        __dbg.rowExistsElsewhere = !!__row;
        __dbg.modalContainsRow = !!__row && modal.contains(__row);
      } catch (e) { __dbg.probeErr = String(e).slice(0, 60); }
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(__dbg));

    // Find matching preference row (fall back to first row)
    var targetRow = null;
    for (var ri = 0; ri < rows.length; ri++) {
      var lbl = rows[ri].querySelector('label, [class*="preferenceName"]');
      if (lbl && lbl.textContent.trim() === PREFERENCE.text) { targetRow = rows[ri]; break; }
    }
    if (!targetRow && rows.length > 0) targetRow = rows[0];
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '5_targetRow', found: !!targetRow }));

    if (!targetRow) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_row' }));
      return;
    }

    var alreadyInCart = !!targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
    // Track a real commit (the increment control is present) so we don't report
    // success when the trigger click silently no-ops. alreadyInCart already has it.
    var prefCommitted = alreadyInCart;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '6_alreadyInCart', alreadyInCart: alreadyInCart }));

    if (alreadyInCart) {
      // Already in cart — increment for all QTY units
      for (var j = 0; j < QTY; j++) {
        var incr = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '7_incr_already', j: j, found: !!incr }));
        if (incr) { incr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr.click(); await wait(300); }
      }
    } else {
      // Click the row's trigger button to add first unit
      var triggerBtn = targetRow.querySelector('button[data-qe-id="cartQuantityTrigger"], button[data-testid="preference-quantity-trigger"]');
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '7_trigger', found: !!triggerBtn, triggerHtml: triggerBtn ? triggerBtn.outerHTML.slice(0, 200) : null }));
      if (!triggerBtn) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_trigger' }));
        return;
      }
      triggerBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      triggerBtn.click();
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '8_trigger_clicked' }));

      // Poll for increment button — confirms HEB committed the add
      var addConfirmed = false;
      for (var ci = 0; ci < 20; ci++) {
        if (targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')) { addConfirmed = true; break; }
        await wait(200);
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '9_add_confirmed', addConfirmed: addConfirmed }));
      prefCommitted = addConfirmed;

      // Click increment for remaining units
      for (var j = 1; j < QTY; j++) {
        var incr = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '10_incr', j: j, found: !!incr }));
        if (incr) { incr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr.click(); await wait(300); }
      }
    }

    // Dismiss modal
    await wait(300);
    document.body.click();
    await wait(300);

    // Gate success on a real commit. The preference path used to fall through to
    // the unconditional success below even when the trigger click never took.
    if (!prefCommitted) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'cart_not_incremented' }));
      return;
    }
  } else if (!hasPopup) {
    // Commit confirmation. PRIMARY signal: the card's own "N added" label, which
    // is product-specific and can't be tripped by an unrelated add. FALLBACK: the
    // shared header cart badge ("N items"), for layouts without the per-card
    // label. No optimistic pass — an unreadable badge is treated as "not
    // confirmed", not success (the end-of-run cart snapshot is the safety net).
    // Holding here until confirmed also stops the RN side navigating (and
    // race-cancelling the add) before it lands.
    function cartCount() {
      var el = document.querySelector('[data-qe-id="headerCartButtonDesktop"], [data-testid="cart-link"]');
      var a = el ? (el.getAttribute('aria-label') || '') : '';
      var m = a.match(/(\\d+)\\s*items?/i);
      return m ? parseInt(m[1], 10) : -1;
    }
    async function waitForCartIncrease(prev, maxTicks) {
      if (prev < 0) return false;   // badge unreadable → cannot confirm (strict, no optimistic pass)
      for (var w = 0; w < maxTicks; w++) {
        if (cartCount() > prev) return true;
        await wait(200);
      }
      return false;
    }

    var cartBefore = cartCount();
    var cardBefore = __cardAddedQty(targetCard);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '2_preclick', cartBefore: cartBefore, cardBefore: cardBefore, visible: addBtn.offsetParent !== null, disabled: addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true' }));

    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    await __cartBaseline();
    addBtn.click();
    await wait(400);

    // Weight dropdown (fresh fish/meat sold by lb) intercepts before any cart change.
    if (await handleWeightDropdown(QTY, targetCard)) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
      return;
    }

    // MEAL-14: the cart's own answer decides when we could get one. Only when it
    // is 'unknown' — a read we could not perform — do we spend the DOM budget:
    // per-card label first (~8s), then the shared badge as a short fallback.
    var committed = null;
    if (__cartTarget) {
      __cartConf = await __hebCartConfirmAdd(__cartTarget, __cartQueryBefore, {});
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: 'cart_query_confirm', state: __cartConf.state, why: __cartConf.reason, sku: __cartConf.skuId, product: __cartConf.productId, detail: __cartConf.detail || null, status: (__cartConf.status == null) ? null : __cartConf.status, code: __cartConf.code || null, loc: __cartConf.loc || null, errN: (__cartConf.errN == null) ? null : __cartConf.errN, block: __cartConf.block || null }));
      if (__cartConf.state === 'landed') committed = true;
      else if (__cartConf.state === 'missing') {
        // A 'missing' verdict used to end the matter, which threw away
        // __waitCardAdded — the per-card label this file calls the reliable
        // success signal, because a sibling worker's add cannot nudge it. So the
        // rail replaced a product-specific DOM signal with a cart read and then
        // discarded the corroboration that would catch the cart read being wrong
        // (a lost session answering about a different cart, or a second line under
        // another preference id).
        //
        // Costs nothing on a true miss: the label will not show added either.
        var cardSays = await __waitCardAdded(targetCard, cardBefore + 1, 40);
        if (!cardSays) {
          committed = false;
        } else {
          // Two independent product-specific signals disagree. The label is a
          // positive observation, so the add commits — but the cart has NOT
          // confirmed it, and the verdict is downgraded so nothing counts this as
          // cart-backed. Reported either way, because a run that keeps landing
          // here means the cart read is unreliable and the flag should go off.
          committed = true;
          __cartConf = __hebCartContradicted(__cartConf, 'contradicted_by_card');
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: 'cart_query_contradicted', sku: __cartConf.skuId, product: __cartConf.productId }));
        }
      }
    }
    if (committed === null) {
      committed = await __waitCardAdded(targetCard, cardBefore + 1, 40);
      if (!committed) committed = await waitForCartIncrease(cartBefore, 12);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: '3_postclick', cardAfter: __cardAddedQty(targetCard), cartAfter: cartCount(), committed: committed }));
    if (!committed) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: (__cartConf && __cartConf.state === 'missing') ? 'cart_absent' : 'cart_not_incremented', confirm: __cartConf }));
      return;
    }

    // Remaining units: same button is the "add 1 more" incrementer; confirm each
    // via the per-card label (badge fallback) so a dropped click is caught.
    for (var j = 1; j < QTY; j++) {
      var prevCard = __cardAddedQty(targetCard);
      var prevBadge = cartCount();
      var btn = targetCard.querySelector('button[data-qe-id="addToCart"]');
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') break;
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      btn.click();
      if (!(await __waitCardAdded(targetCard, prevCard + 1, 30))) await waitForCartIncrease(prevBadge, 12);
    }
  } else {
    // hasPopup but no recorded preference (e.g. a review pick sourced from a
    // parallel worker, which doesn't capture preferences). Click, then handle
    // whichever popup appears: a weight dropdown, or a preference modal we
    // default to the FIRST option for — mirroring the recorded-preference path's
    // rows[0] fallback — so the add lands instead of failing pref_required.
    addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    await __cartBaseline();   // ordered before the click — see the branch above
    addBtn.click();
    await wait(700);
    if (await handleWeightDropdown(QTY, targetCard)) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
      return;
    }

    // Preference modal with no recorded choice → default to its first row.
    var dfModal = null;
    for (var dfi = 0; dfi < 15; dfi++) {
      dfModal = document.querySelector('[data-qe-id="preferencesRowContainer"]');
      if (!dfModal) { var dfFs = document.querySelector('fieldset[aria-live="polite"]'); if (dfFs) dfModal = dfFs.parentElement || dfFs; }
      if (!dfModal) dfModal = document.querySelector('[role="dialog"]:not([aria-label="Search"]),[role="presentation"]:not([aria-label="Search"])');
      if (dfModal) break;
      await wait(150);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: 'df_modal', found: !!dfModal }));
    if (!dfModal) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'pref_required' }));
      return;
    }
    var dfRows = [];
    for (var dfr = 0; dfr < 20; dfr++) {
      dfRows = Array.from(dfModal.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
      if (dfRows.length > 0) break;
      await wait(100);
    }
    var dfRow = dfRows.length > 0 ? dfRows[0] : null;
    if (!dfRow) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_row' }));
      return;
    }
    var dfCommitted = !!dfRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
    if (!dfCommitted) {
      var dfTrigger = dfRow.querySelector('button[data-qe-id="cartQuantityTrigger"], button[data-testid="preference-quantity-trigger"]');
      if (!dfTrigger) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_trigger' }));
        return;
      }
      dfTrigger.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      dfTrigger.click();
      for (var dfc = 0; dfc < 20; dfc++) {
        if (dfRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')) { dfCommitted = true; break; }
        await wait(200);
      }
    }
    // Remaining units via the row's increment button.
    for (var dfj = 1; dfj < QTY && dfCommitted; dfj++) {
      var dfIncr = dfRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
      if (dfIncr) { dfIncr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); dfIncr.click(); await wait(300); }
    }
    await wait(300);
    document.body.click();
    await wait(300);
    window.ReactNativeWebView.postMessage(JSON.stringify(dfCommitted
      ? { type: 'ADD_RESULT', success: true }
      : { type: 'ADD_RESULT', success: false, reason: 'cart_not_incremented' }));
    return;
  }

  // MEAL-14: the preference paths above confirm off a modal row's own increment
  // control — product-specific, not the shared badge, so it is not the guess this
  // ticket set out to replace and it stays the decision. But the cart can still
  // contradict it, and a contradiction is a fact: cross-check once here so those
  // paths also report per-item, and downgrade success only on 'missing'. Skipped
  // when the branch above already asked (__cartConf set).
  if (__cartTarget && !__cartConf) {
    __cartConf = await __hebCartConfirmAdd(__cartTarget, await __cartBaseline(), { tries: 3 });
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: 'cart_query_crosscheck', state: __cartConf.state, why: __cartConf.reason, sku: __cartConf.skuId, product: __cartConf.productId, detail: __cartConf.detail || null, status: (__cartConf.status == null) ? null : __cartConf.status, code: __cartConf.code || null, loc: __cartConf.loc || null, errN: (__cartConf.errN == null) ? null : __cartConf.errN, block: __cartConf.block || null }));
    if (__cartConf.state === 'missing') {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'cart_absent', confirm: __cartConf }));
      return;
    }
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true, confirm: __cartConf }));
})();true;`;
}

/**
 * Injected on a HEB search results page for ingredients that already have a searchTerm.
 * Scores candidates against the searchTerm, finds the best in-stock match (no popup/preferences),
 * adds it to cart immediately, and posts SEARCH_AND_ADD_RESULT.
 * On failure, posts { success: false, reason, candidates } so the item can go to review.
 */
export function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  dropdown: { type: string; selectedText: string; selectedValue: string } | null = null,
): string {
  const escapedTerm = JSON.stringify(searchTerm);
  const escapedDropdown = dropdown ? JSON.stringify(dropdown) : 'null';
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  var DROPDOWN = ${escapedDropdown};
  // Parallel-add worker mode: the pool injects ONE fixed script per worker, so
  // each item's term/qty/preference ride in the URL hash (#mealio=<json>). When
  // present, override the baked-in defaults. No hash → sequential flow, unchanged.
  try {
    if (location.hash && location.hash.indexOf('#mealio=') === 0) {
      var __mq = JSON.parse(decodeURIComponent(location.hash.slice(8)));
      if (__mq) {
        if (typeof __mq.term === 'string') SEARCH_TERM = __mq.term;
        if (typeof __mq.qty === 'number') QTY = __mq.qty;
        if (__mq.dropdown !== undefined) DROPDOWN = __mq.dropdown;
      }
    }
  } catch (e) {}
  // Cart-badge confirmation (mirrors buildAddToCartScript): gate success on the
  // header cart count actually rising, so each (parallel) worker only reports
  // success when its add truly committed. Unreadable badge → not confirmed; the
  // reconcile pass re-reads the real cart, so a false negative is recovered.
  //
  // MEAL-14: when __HEB_CART_RAIL is on this is the FALLBACK, not the decision —
  // the cart query below answers per product, which the shared badge cannot (a
  // sibling worker's add moves it, as the wait-flush hack at the bottom of this
  // script attests). It stays in the binary because a cart read we cannot perform
  // must degrade to the rail that shipped, not to "everything failed".
  var __HEB_CART_RAIL = ${hebCartQueryEnabled() ? 'true' : 'false'};
${buildHebCartQueryFn()}
  function __cartCount() {
    var el = document.querySelector('[data-qe-id="headerCartButtonDesktop"], [data-testid="cart-link"]');
    var a = el ? (el.getAttribute('aria-label') || '') : '';
    var m = a.match(/(\\d+)\\s*items?/i);
    return m ? parseInt(m[1], 10) : -1;
  }
  async function __waitForCartIncrease(prev, ticks) {
    if (prev < 0) return false;   // badge unreadable → cannot confirm; reconcile re-reads the real cart
    for (var w = 0; w < ticks; w++) { if (__cartCount() > prev) return true; await wait(200); }
    return false;
  }
  var __cartBefore = -1;
  var TITLE_SEL = ${s.title};
${hebFindCardsFn()}
${hebWaitFreshFn()}

  async function handleWeightDropdown(qty, scope) {
    // HEB "add by weight" items use a native <select name="addByWeight"> whose
    // options ARE the buyable weights (value + "N lb" text; option value 0 is the
    // "Select a Weight" placeholder). Increments differ per product (0.5 lb for
    // bulk coffee, 1 lb for others), so select the qty-th REAL option rather than
    // assuming a fixed lb-per-qty. Setting the value and firing change adds the
    // item — there is no separate confirm. Scope to the target card / a picker
    // modal our click opened, never a sibling card's dropdown (which would add an
    // unrelated product).
    // A remembered weight rides in as DROPDOWN { type:'weight', selectedValue:lb }
    // on the combined search-and-add path. Prefer the option closest to that
    // absolute weight (the store's increments can differ/change); otherwise fall
    // back to the qty-th option. (typeof-guarded so this same helper is valid in
    // buildAddToCartScript, which has no DROPDOWN var.)
    var __targetLb = (typeof DROPDOWN !== 'undefined' && DROPDOWN && DROPDOWN.type === 'weight')
      ? parseFloat(DROPDOWN.selectedValue)
      : (typeof __WEIGHT_TARGET !== 'undefined' ? __WEIGHT_TARGET : NaN);
    function __closestOpt(opts, target) {
      var best = opts[0], bestD = Infinity;
      for (var i = 0; i < opts.length; i++) {
        var raw = opts[i].value != null && opts[i].value !== '' ? opts[i].value : opts[i].textContent;
        var d = Math.abs(parseFloat(raw) - target);
        if (d < bestD) { bestD = d; best = opts[i]; }
      }
      return best;
    }
    function pickIn(root) {
      var sel = root.querySelector('select[name="addByWeight"]');
      if (sel) {
        var real = Array.from(sel.options).filter(function(o) { return parseFloat(o.value) > 0; });
        if (real.length > 0) {
          var pick = !isNaN(__targetLb) ? __closestOpt(real, __targetLb) : real[Math.min(Math.max(1, qty), real.length) - 1];
          sel.value = pick.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      var listbox = root.querySelector('[role="listbox"]');
      if (listbox) {
        var lbOpts = Array.from(listbox.querySelectorAll('[role="option"]')).filter(function(o) { return /\\blbs?\\b/i.test(o.textContent); });
        if (lbOpts.length > 0) {
          var lbPick = !isNaN(__targetLb) ? __closestOpt(lbOpts, __targetLb) : lbOpts[Math.min(Math.max(1, qty), lbOpts.length) - 1];
          lbPick.click();
          return true;
        }
      }
      return false;
    }
    var handledRoot = null;
    if (scope && pickIn(scope)) handledRoot = scope;
    if (!handledRoot) {
      var dialog = document.querySelector('[role="dialog"]:not([aria-label="Search"]), [role="presentation"]:not([aria-label="Search"])');
      if (dialog && (!scope || !scope.contains(dialog)) && pickIn(dialog)) handledRoot = dialog;
    }
    if (!handledRoot) return false;
    await wait(400);
    var confirmBtn = handledRoot.querySelector('button[data-qe-id="cartQuantityTrigger"]') || document.querySelector('button[data-qe-id="cartQuantityTrigger"]');
    if (confirmBtn) { confirmBtn.click(); await wait(400); }
    return true;
  }

  await wait(800);

  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground',
    'grassfed','cagefree','freerange']);
  // MEAL-160: two-words-on-one-label, one-word-on-the-next. The critical-word
  // check is a token membership test, so 'lowfat' as a lone entry both failed to
  // fire for the natural query spelling ("low fat" tokenises to two non-critical
  // words) and punished the RIGHT product when it did fire (no hyphenated label
  // can contain it). Collapsed on both sides so the entry means the concept, not
  // one spelling of it. Longest first — 'cage free' and 'free range' share a
  // word. Same rule as CRITICAL_PHRASES in _scoring.ts.
  // "Cage Free Range Eggs" is a real label and the two concepts SHARE the word
  // 'free'. A plain left-to-right pass collapses 'cage free' first, eats it, and
  // leaves 'cagefree range' - so a "free range" request vetoed the exact product
  // it wanted. The three-word rule runs first and gives both their own token.
  var CRITICAL_PHRASES = [[/\\bcage free range\\b/g,'cagefree freerange'],
    [/\\bcage free\\b/g,'cagefree'],[/\\bfree range\\b/g,'freerange'],
    [/\\bgrass fed\\b/g,'grassfed'],[/\\blow fat\\b/g,'lowfat'],[/\\bnon fat\\b/g,'nonfat']];
  var CANONICAL_TOKENS = new Set(['cagefree','freerange','grassfed','lowfat','nonfat']);
  function collapseCriticalPhrases(s) {
    var out = s;
    for (var ci = 0; ci < CRITICAL_PHRASES.length; ci++) {
      out = out.replace(CRITICAL_PHRASES[ci][0], CRITICAL_PHRASES[ci][1]);
    }
    return out;
  }
  // Dual normalization to handle stores that mangle ñ/é/etc. inconsistently
  // across renderings (Walmart strips ñ entirely on certain queries; others
  // may NFD-decompose). Score both ways and take the better.
  function normDiacritic(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function normStrip(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^\\x00-\\x7f]/g, '').replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\\s+/g, ' ').trim();
  }
  function scoreOne(rawA, rawB) {
    var na = collapseCriticalPhrases(rawA), nb = collapseCriticalPhrases(rawB);
    if (na === nb) return 100;
    var wa = na.split(' ').filter(Boolean), sb = new Set(nb.split(' ').filter(Boolean));
    for (var i = 0; i < wa.length; i++) { if (CRITICAL.has(wa[i]) && !sb.has(wa[i])) return 0; }
    // Weighted: a collapsed token stands for two words, so counting it once
    // would shrink both sides of the fraction and raise the 70% bar. Same rule
    // as tokenWeight in _scoring.ts.
    var total = 0, matched = 0;
    for (var wi = 0; wi < wa.length; wi++) {
      var tw = CANONICAL_TOKENS.has(wa[wi]) ? 2 : 1;
      total += tw;
      if (sb.has(wa[wi])) matched += tw;
    }
    var p = matched / total;
    if (p < 0.7) return 0;
    return Math.min(99, Math.round(p * 100));
  }
  function scoreMatch(a, b) {
    var s1 = scoreOne(normDiacritic(a), normDiacritic(b));
    var s2 = scoreOne(normStrip(a), normStrip(b));
    return Math.max(s1, s2);
  }

  // Wait for results matching the searched term before scoring — otherwise an
  // in-page SPA search reads the previous search's cards still on the page and
  // either mis-adds or falsely reports "couldn't match".
  var cards = (await __hebFreshCards(wait, 14000, 8000)).cards;
  var candidates = [];
  var seen = new Set();
  var bestCard = null, bestBtn = null, bestName = null, bestIsWeight = false;
  var bestHasPopup = false;

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    var addBtn = card.querySelector('button[data-qe-id="addToCart"]');
    var btnText = addBtn ? addBtn.textContent.trim() : '';
    var oos = /out of stock|notify me|unavailable/i.test(btnText);
    var hasPopup = addBtn ? (!!addBtn.getAttribute('aria-haspopup') && addBtn.getAttribute('aria-haspopup') !== 'false') : false;
    var weightSel = card.querySelector('select[name="addByWeight"]');
    var weightOptions = weightSel ? Array.from(weightSel.options).map(function(o) { return parseFloat(o.value); }).filter(function(v) { return v > 0; }) : [];
    var isWt = weightOptions.length > 0 || (/H-E-B (Deli|Fish Market)/i.test(name) && (hasPopup || /, lb$/i.test(name)));
    var imgEl = card.querySelector('img');
    candidates.push({ productName: name, imageUrl: imgEl ? imgEl.src : null, outOfStock: oos, preferences: null, price: null, isWeightItem: isWt, weightOptions: weightOptions });
    // Accept hasPopup products when a saved dropdown preference is available
    if (!bestName && scoreMatch(SEARCH_TERM, name) === 100 && !oos && (!hasPopup || DROPDOWN)) {
      bestCard = card; bestBtn = addBtn; bestName = name; bestHasPopup = hasPopup; bestIsWeight = isWt;
    }
    if (candidates.length >= 8) break;
  }

  if (!bestName || !bestBtn) {
    var hasExactOos = candidates.some(function(c) { return scoreMatch(SEARCH_TERM, c.productName) === 100 && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '0_best_found', bestName: bestName, bestHasPopup: bestHasPopup, hasDropdown: !!DROPDOWN, qty: QTY }));

  // Sold-by-weight item with NO remembered weight: don't guess a poundage — bubble
  // the weight options up so the review UI can prompt once (then it's remembered).
  // A weight choice arrives as DROPDOWN { type:'weight' }; absent that, prompt.
  var __bestWeightSel = bestCard.querySelector('select[name="addByWeight"]');
  if (__bestWeightSel && !(DROPDOWN && DROPDOWN.type === 'weight')) {
    var __wopts = Array.from(__bestWeightSel.options).map(function(o) { return parseFloat(o.value); }).filter(function(v) { return v > 0; });
    if (__wopts.length > 0) {
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'needs_weight',
        candidates: [{ productName: bestName, imageUrl: null, outOfStock: false, preferences: null, price: null, isWeightItem: true, weightOptions: __wopts }],
      }));
      return;
    }
  }

  var __cartTarget = null;
  var __cartQueryBefore = null;
  var __cartConf = null;

  try {
    __cartBefore = __cartCount();
    // MEAL-14 baseline. Issued BEFORE the click (so it cannot see our own add)
    // but awaited AFTER the scroll, so its round trip overlaps work this script
    // already does — the before-read costs the run almost nothing in wall clock.
    // One read per add, not two: the after-read doubles as the poll.
    if (__HEB_CART_RAIL) __cartTarget = __hebTargetFromCard(bestCard, bestName);
    // Logged because confirm.skuId comes from the matched CART line, so it is
    // not evidence this card-side lookup ran (MEAL-139).
    if (__cartTarget) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'cart_query_target', productId: __cartTarget.productId, skuId: __cartTarget.skuId }));
    var __cartBeforeP = __cartTarget ? __hebCartRead(6000) : null;
    bestBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    if (__cartBeforeP) __cartQueryBefore = await __cartBeforeP;

    // How many units of THIS product the cart already holds, read BEFORE the
    // click (MEAL-185).
    //
    // The card's button label reads "N added", and N is the product's
    // CART-ABSOLUTE quantity — it counts units this run never touched. The
    // multi-quantity loop below used it as though it were a run-relative
    // counter, so a product already sitting in the cart stopped the loop early:
    // with one unit already there and QTY 2, the first click took the label to
    // "2 added", the guard prevQty >= QTY was satisfied, and the second unit
    // was never clicked. One unit added, every check agreeing it worked.
    //
    // Baselining here makes the loop relative, which is what the SERIAL script
    // has always been (buildAddToCartScript just runs for j = 1; j < QTY).
    // That asymmetry is why this only ever bit the parallel path, and why the
    // under-added item then fell through to the serial top-up and got fixed
    // there — slowly, one item at a time, hiding the defect behind a retry.
    var __cardAddedQty = function() {
      var b = bestCard.querySelector('button[data-qe-id="addToCart"]');
      var m = (b ? (b.textContent || '') : '').match(/(\\d+)\\s*added/i);
      return m ? parseInt(m[1], 10) : 0;
    };
    var __qtyBase = __cardAddedQty();
    // EXTRACT_DEBUG, not DEBUG: the worker wrappers forward only EXTRACT_DEBUG /
    // WORKER_DEBUG and swallow the add script's other diagnostics, so a DEBUG line
    // here would be invisible on the PARALLEL path — the one this defect lives on.
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: '0_qty_baseline', base: __qtyBase, want: QTY, name: bestName }));

    // ── Add by asking the store, instead of clicking (MEAL-200) ─────────────
    //
    // Measured working on a real cart: 333 ms against ~1.8 s just to load the
    // page this script is running in. Everything it needs is already computed
    // above — the product id and sku from the card, and the cart baseline.
    //
    // QUANTITY IS CART-ABSOLUTE. addItemToCartV2 SETS the line rather than
    // incrementing it, so this sends __qtyBase + QTY for exactly the reason the
    // click loop below targets __qtyBase + QTY (MEAL-185): sending QTY alone
    // would REDUCE a line the cart already holds more of.
    //
    // DECLINES for weight-priced and preference-bearing items. Both work — both
    // were measured — but a weight line cannot be UNDONE: quantity 0 errors,
    // weight 0 is accepted without removing, and the storefront has no
    // remove-item operation. A count line can be set back to 0. Shipping a path
    // whose over-adds are permanent is not something the cart rules allow, so
    // those items keep clicking until there is a way back.
    //
    // Any doubt at all falls through to the click path below: a missing id, a
    // response that is not the Cart arm, a thrown request. Nothing is skipped on
    // a maybe.
    var __netAdded = false;
    // bestIsWeight, not the presence of a weight <select>. The extractor above
    // calls an item sold-by-weight when it has weight options OR it is a Deli /
    // Fish Market line ending in ", lb" — a deli card with neither a select nor a
    // popup satisfies that and would have slipped through a select-only gate,
    // which is exactly the product whose over-add cannot be undone.
    if (${networkAddEnabled()} && __cartTarget && __cartTarget.productId && __cartTarget.skuId
        && !bestHasPopup && !bestIsWeight && !__bestWeightSel) {
      try {
        // The baseline comes from the CART, not from the card's label.
        //
        // The click path can baseline off the label because clicking increments
        // from whatever the page shows. This request SETS an absolute quantity,
        // so the number it needs is how many the CART holds — and the label is
        // the one thing known to lie about that: it reads 0 while unhydrated
        // (MEAL-187), which would set the line DOWN to the requested count and
        // report success, the exact silent under-add MEAL-185 fixed.
        //
        // No usable cart read means no baseline, so the request is not sent and
        // the click path runs. Declining is free; guessing is not.
        var __netBase = null;
        try {
          var __netMatch = (__cartQueryBefore && __cartQueryBefore.ok)
            ? __hebCartMatch(__cartQueryBefore.lines, __cartTarget) : null;
          if (__cartQueryBefore && __cartQueryBefore.ok) {
            // __hebCartMatch SUMS every line for this product — one product can
            // hold several, keyed by preference — while the request sets ONE
            // line. With 2 lines of 1 each the sum is 2, the write would set the
            // line it picks to 2 + QTY, the other line keeps its 1, and the cart
            // ends up over. There is no way to say which line to set, so a
            // multi-line product is not ours to write.
            if (__netMatch && __netMatch.lineCount > 1) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'EXTRACT_DEBUG', step: 'cart_query_net_add',
                declined: 'multiple_cart_lines', lines: __netMatch.lineCount, name: bestName,
              }));
              throw new Error('no_cart_baseline');
            }
            // A weight line counts 1 per line by construction, so its qty is not a
            // unit count and adding QTY to it means nothing.
            if (__netMatch && __netMatch.isWeight) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'EXTRACT_DEBUG', step: 'cart_query_net_add',
                declined: 'cart_line_is_weight', name: bestName,
              }));
              throw new Error('no_cart_baseline');
            }
            __netBase = __netMatch ? __netMatch.qty : 0;
          }
        } catch (e) {
          if (String(e).indexOf('no_cart_baseline') >= 0) throw e;
          __netBase = null;
        }
        if (__netBase == null) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'EXTRACT_DEBUG', step: 'cart_query_net_add', declined: 'no_cart_baseline',
            name: bestName,
          }));
          throw new Error('no_cart_baseline');
        }
        var __netVars = {
          productId: String(__cartTarget.productId),
          skuId: String(__cartTarget.skuId),
          quantity: __netBase + QTY,
        };
        var __netRes = await __hebCartAdd(__netVars, 8000);
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'EXTRACT_DEBUG', step: 'cart_query_net_add', name: bestName,
          productId: __netVars.productId, skuId: __netVars.skuId,
          cartBase: __netBase, labelBase: __qtyBase, want: QTY, sent: __netVars.quantity,
          arm: __netRes.arm, status: __netRes.status, reason: __netRes.reason,
          errMsg: __netRes.message, ms: __netRes.ms,
        }));
        __netAdded = !!__netRes.added;
        // ── An unresolved write is not a failed write ────────────────────────
        //
        // timeout, network and unparseable all mean we do not know whether the
        // store applied the set. Falling straight through to the click path
        // would add the item a SECOND time, and it would report success while
        // doing it: the click loop baselines off a label captured before the
        // write, so the write's own effect satisfies its exit condition and the
        // confirmation then sees a quantity that moved.
        //
        // So re-read the cart and let it decide. This is the one place where
        // "we could not tell" has to become "we looked again".
        if (!__netAdded && (__netRes.reason === 'timeout' || __netRes.reason === 'network'
            || __netRes.reason === 'unparseable' || __netRes.reason === 'http')) {
          var __reread = await __hebCartRead(6000);
          var __rm = (__reread && __reread.ok) ? __hebCartMatch(__reread.lines, __cartTarget) : null;
          var __nowQty = __rm ? __rm.qty : (__reread && __reread.ok ? 0 : null);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'EXTRACT_DEBUG', step: 'cart_query_net_reread', name: bestName,
            reason: __netRes.reason, base: __netBase, want: QTY, now: __nowQty,
          }));
          if (__nowQty != null && __nowQty >= __netVars.quantity) {
            // The set landed after all.
            __netAdded = true;
          } else if (__nowQty != null) {
            // It did not. The click path is safe to run, but ONLY against a
            // baseline as fresh as this read — the label is older than the write.
            __qtyBase = __nowQty;
          } else {
            // Cart unreadable and the write unresolved. Clicking now could double
            // it, so refuse the item rather than risk an add nobody asked for.
            document.removeEventListener('focusin', __noKbd, true);
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'write_unresolved',
              productName: bestName, candidates: candidates, via: 'network' }));
            return;
          }
        }
      } catch (e) {
        // Includes the deliberate no-baseline bail above. Every exit from this
        // block leaves __netAdded false, so the click path below runs unchanged.
        if (String(e).indexOf('no_cart_baseline') < 0) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'EXTRACT_DEBUG', step: 'cart_query_net_add', threw: String(e).slice(0, 120),
          }));
        }
      }
    }
    if (__netAdded) {
      // Confirmed by the SAME cart read the click path uses, so a network add and
      // a clicked add are reported through one rail and cannot disagree about
      // what "landed" means.
      var __netConf = await __hebCartConfirmAdd(__cartTarget, __cartQueryBefore, {});
      document.removeEventListener('focusin', __noKbd, true);
      // Three outcomes, and only ONE of them is a failure.
      //
      // 'missing' is the cart answering and not showing the item — real evidence,
      // real failure. 'unknown' is the cart not answering at all, and the click
      // path treats that as "not evidence" for exactly this reason. Reporting it
      // as cart_not_incremented would claim a reading nobody took, about an item
      // the store's own success arm says it added. The arm is the evidence here;
      // the run's after-probe still gets the last word.
      var __netFailed = !!(__netConf && __netConf.state === 'missing');
      window.ReactNativeWebView.postMessage(JSON.stringify(
        __netFailed
          ? { type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'cart_absent',
              productName: bestName, candidates: candidates, confirm: __netConf, via: 'network' }
          : { type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName,
              confirm: __netConf, via: 'network' }));
      return;
    }

    bestBtn.click();

    if (bestHasPopup && DROPDOWN) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '1_clicked_addBtn', bestName: bestName, dropdown: DROPDOWN }));
      // Open preference modal — fixed wait matches the extension
      await wait(500);
      var modal = null;
      modal = document.querySelector('[role="dialog"]:not([aria-label="Search"]),[role="presentation"]:not([aria-label="Search"])');
      if (!modal) modal = document.querySelector('[data-qe-id="preferencesRowContainer"]');
      if (!modal) { var pfs = document.querySelector('fieldset[aria-live="polite"]'); if (pfs) modal = pfs.parentElement || pfs; }
      if (!modal) {
        var allModals = document.querySelectorAll('[class*="Popover"], [class*="Modal"]');
        for (var moi = 0; moi < allModals.length; moi++) { if (allModals[moi].getAttribute('aria-label') !== 'Search') { modal = allModals[moi]; break; } }
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '2_modal_search', found: !!modal, modalSel: modal ? (modal.getAttribute('data-qe-id') || modal.getAttribute('role') || modal.tagName) : null }));
      if (!modal) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_modal', candidates: candidates }));
        return;
      }
      // Poll for preference rows to appear (up to 20×100ms = 2s, matching the extension)
      var rows = [];
      for (var pri = 0; pri < 20; pri++) {
        rows = Array.from(modal.querySelectorAll('[class*="preferenceContainer"]')).filter(function(r) { return r.tagName !== 'LABEL'; });
        if (rows.length > 0) break;
        await wait(100);
      }
      var rowLabels = rows.map(function(r) { var l = r.querySelector('label, [class*="preferenceName"]'); return l ? l.textContent.trim() : '(no label)'; });
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '3_preference_rows', rowCount: rows.length, rowLabels: rowLabels, lookingFor: DROPDOWN.selectedText }));
      var targetRow = null;
      for (var ri = 0; ri < rows.length; ri++) {
        var lbl = rows[ri].querySelector('label, [class*="preferenceName"]');
        var lt = lbl ? lbl.textContent.trim() : '';
        if (lt === DROPDOWN.selectedText || lt === DROPDOWN.selectedValue) { targetRow = rows[ri]; break; }
      }
      if (!targetRow && rows.length > 0) targetRow = rows[0];
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '4_target_row', found: !!targetRow, usedFallback: !targetRow }));
      if (!targetRow) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_modal', candidates: candidates }));
        return;
      }
      await wait(200);
      // If item is already in cart (increment button present), use it directly
      var alreadyInCart = !!targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
      var triggerBtn = alreadyInCart ? null : targetRow.querySelector('button[data-qe-id="cartQuantityTrigger"], button[data-testid="preference-quantity-trigger"]');
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '5_trigger_btn', alreadyInCart: alreadyInCart, found: !!(triggerBtn || alreadyInCart) }));
      if (!triggerBtn && !alreadyInCart) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_modal', candidates: candidates }));
        return;
      }
      if (alreadyInCart) {
        // Already in cart — click increment for each unit of QTY
        for (var j = 0; j < QTY; j++) {
          var incr2 = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
          if (incr2) { incr2.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr2.click(); await wait(300); }
        }
      } else {
        triggerBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        triggerBtn.click();
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '6_trigger_clicked' }));
        // Poll for increment button — confirms HEB committed the add
        var addConfirmed = false;
        for (var ci2 = 0; ci2 < 20; ci2++) {
          if (targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')) { addConfirmed = true; break; }
          await wait(200);
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '6b_add_confirmed', addConfirmed: addConfirmed }));
        // For qty > 1, click increment for remaining quantities
        for (var j = 1; j < QTY; j++) {
          var incr = targetRow.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]');
          if (incr) { incr.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(100); incr.click(); await wait(300); }
        }
      }
      // Dismiss modal — click outside (document.body) to close without canceling the add.
      // Avoid clicking the modal's close button (it can cancel the add) or Escape (same risk).
      document.body.click();
      await wait(400);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG', step: '7_modal_dismissed' }));
    } else {
      // No preference modal — standard add (may include weight-select items like Fish Market by lb)
      await wait(600);
      if (await handleWeightDropdown(QTY, bestCard)) {
        // Weight select handled — nothing more to do
      } else if (QTY > 1) {
        // Multi-quantity: confirm each unit via the card button label, which reads
        // "N added" — the quantity for THIS product, unaffected by sibling workers
        // touching the shared header cart badge. Confirm the first unit, then click
        // "add 1 more" for each remaining unit, waiting for the label to tick up
        // each time (with one retry) so a dropped click is caught instead of
        // silently under-adding. (qty 1 needs none of this — the cart-increase gate
        // below confirms the single unit.)
        //
        // EVERY TARGET HERE IS RELATIVE TO __qtyBase, the label read before the
        // first click (MEAL-185). The label is cart-absolute: it counts units
        // this run never added. Written against QTY directly, a product already
        // in the cart satisfied the loop's exit before the loop had added
        // anything past the first click.
        var __waitAddedQty = async function(target, ticks) {
          for (var w = 0; w < ticks; w++) { if (__cardAddedQty() >= target) return true; await wait(200); }
          return false;
        };
        var __qtyGoal = __qtyBase + QTY;
        await __waitAddedQty(__qtyBase + 1, 15);   // let the first unit's label settle (~3s max)
        for (var j = 1; j < QTY; j++) {
          var prevQty = __cardAddedQty();
          if (prevQty >= __qtyGoal) break;
          var incrBtn = bestCard.querySelector('button[data-qe-id="cartQuantityCounterIncrement"]')
                     || bestCard.querySelector('button[data-qe-id="addToCart"]');
          if (!incrBtn || incrBtn.disabled || incrBtn.getAttribute('aria-disabled') === 'true') break;
          incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incrBtn.click();
          if (!(await __waitAddedQty(prevQty + 1, 30))) { incrBtn.click(); await __waitAddedQty(prevQty + 1, 25); }
        }
      }
    }

    // MEAL-14: ask the cart. 'landed' and 'missing' are both facts from the
    // store's own answer, so either settles the item — and 'missing' names the
    // product instead of leaving a count short. 'unknown' means we could not read
    // the cart (blocked, non-200, odd shape, timeout, or no baseline), which is
    // NOT evidence of absence: fall through to the badge rail exactly as before.
    var __committed = null;
    if (__cartTarget) {
      __cartConf = await __hebCartConfirmAdd(__cartTarget, __cartQueryBefore, {});
      // EXTRACT_DEBUG, not DEBUG: the worker wrapper re-tags this type and the
      // main-WebView handler logs it, so the rail is visible on both rails.
      // MEAL-16: 'block' says which wall a 'blocked' read hit — Imperva by
      // fingerprint, or a bare 401/403 that is only CONSISTENT with the H-E-B
      // session having died (see HebCartBlockCause; 'status' and 'detail' are
      // beside it because the label alone does not settle that one). code/loc
      // say whether the gateway validated the document we actually sent, and
      // errN says how many errors 'detail' is ONE of — the field whose absence
      // hid the union bug in errors[1…] for six runs.
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'cart_query_confirm', state: __cartConf.state, why: __cartConf.reason, sku: __cartConf.skuId, product: __cartConf.productId, detail: __cartConf.detail || null, status: (__cartConf.status == null) ? null : __cartConf.status, code: __cartConf.code || null, loc: __cartConf.loc || null, errN: (__cartConf.errN == null) ? null : __cartConf.errN, block: __cartConf.block || null }));
      if (__cartConf.state === 'landed') __committed = true;
      else if (__cartConf.state === 'missing') __committed = false;
    }
    if (__committed === null) __committed = await __waitForCartIncrease(__cartBefore, 50);
    // Parallel-worker mode: the badge can tick up from a SIBLING worker's add,
    // so __committed may pass while our OWN cart POST is still in flight. The
    // pool re-navigates this worker the instant we post the result, which would
    // cancel that request. Give it a beat to flush first. (The sequential flow
    // has the RN-side navigation buffer, so it skips this.)
    // MEAL-14 skips that flush when the CART itself already lists our line: the
    // request cannot still be in flight if the server has recorded it, so the
    // rail hands back ~450ms per parallel add rather than costing any.
    var __cartProved = !!(__cartConf && __cartConf.state === 'landed');
    if (__committed && !__cartProved && location.hash && location.hash.indexOf('#mealio=') === 0) await wait(450);
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify(__committed
      ? { type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName, confirm: __cartConf }
      : { type: 'SEARCH_AND_ADD_RESULT', success: false, reason: (__cartConf && __cartConf.state === 'missing') ? 'cart_absent' : 'cart_not_incremented', productName: bestName, candidates: candidates, confirm: __cartConf }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates }));
  }
})();true;`;
}

/**
 * Injected on the HEB homepage (or any HEB page).
 * Clicks the search icon if needed, types the term, and submits — navigating to search results.
 * The WebView will fire onNavigationStateChange once the /search URL loads.
 */
export function buildSearchScript(term: string): string {
  const escaped = JSON.stringify(term);
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};

  // Suppress mobile keyboard — set inputmode="none" on any input that gets focused,
  // including inputs opened by HEB's own JS when the search dialog appears.
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  // If already on a search page, the search input is directly in the header — no icon click needed.
  var alreadyOnResults = window.location.href.includes('/search');

  if (!alreadyOnResults) {
    // Open the search dialog by clicking the search icon button.
    var openBtn = document.querySelector(${s.searchOpen});
    if (openBtn) { openBtn.click(); await wait(400); }
  }

  // Find the search input — prefer dialog/modal input first, then fall back to page-level.
  var input = document.querySelector(${s.searchInputModal});
  if (!input) {
    input = document.querySelector(${s.searchInput});
  }

  if (!input) { return; }

  // Set value programmatically via the native setter — no focus() call so the
  // mobile keyboard never appears.
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
  setter.call(input, term);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(100);

  var submit = null;
  if (input.parentElement) submit = input.parentElement.querySelector('button[type="submit"]');
  if (!submit) {
    var container = input.closest('form') || input.closest('[role="search"]') || input.closest('div');
    if (container) submit = container.querySelector(${s.searchSubmit});
  }
  if (submit) {
    submit.click();
  } else {
    var form = input.closest('form');
    if (form) {
      form.submit();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  document.removeEventListener('focusin', __noKbd, true);
})();true;`;
}
