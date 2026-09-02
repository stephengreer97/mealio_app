// Injectable JavaScript strings for Wegmans WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// Ported from ~/mealio_ext/content-wegmans.js — same selectors and logic,
// adapted to the StoreScripts interface used by the store registry.
//
// DOM reference (from extension):
//   Search input:    input[type="search"]  (or input[placeholder*="Search" i])
//   Product tile:    div.component--product-tile
//   Product name:    h3[data-testid="-baseHeading"]
//   Add / increment: button.default-add-button  (click once per unit)
//   Stepper button:  button.add-button  (appears after first add)
//   Qty display:     output.tw\:sr-only  ("Quantity of X is N")
//
// Login detection:
//   Logged in:  button.component--site-header-desktop-sign-in-greeting-button
//               has a span starting with "Hello,"

import type { StoreScripts } from './index';

const WEGMANS_URL = 'https://www.wegmans.com';
const WEGMANS_LOGIN_URL = 'https://www.wegmans.com';
const WEGMANS_CART_URL = 'https://www.wegmans.com/cart';
const WEGMANS_DOMAIN = 'wegmans.com';

//      injection's answer is better evidence than anything on this page.
//   3. Inconclusive AND no cached positive resolves to signed OUT, explicitly.
//      An unknown state must show the user a login wall, never a silent
//      signed-out run.
//   4. 'out' is still never written (that would defeat the post-sign-in
//      re-check), but a negative verdict now REMOVES a cached positive, so a
//      verdict we have just disproved cannot answer for anything later.
import { selectorsFor, storeConfig, searchUrlFor } from '../automation-config';

const SELECTOR_KEY = 'wegmans';

// Compiled-in selector fallbacks; the remote automation config overrides them so
// a Wegmans redesign is a config push rather than an App Store release. Read only
// inside a build function — the config loads after module import.
// Exported for the fixture drift census (MEAL-30) — see the note on heb.ts's copy.
export const SEL_FALLBACKS = {
  tile: 'div.component--product-tile',
  name: 'h3[data-testid="-baseHeading"]',
  addBtn: 'button.default-add-button',
  incBtn: 'button.add-button',
  searchInput: 'input[type="search"], input[placeholder*="earch" i]',
};

/** Live selectors as interpolatable JS literals (quotes included). */
const sel = () => selectorsFor(SELECTOR_KEY, SEL_FALLBACKS);

function buildCheckLoginScript(): string {
  return `(function() {
  if (window.__wegmansLoginPosted) return;
  if (window.__wegmansLoginObserver) {
    try { window.__wegmansLoginObserver.disconnect(); } catch(_) {}
    window.__wegmansLoginObserver = null;
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

  // NOTE: the sessionStorage read used to sit HERE, ahead of detection. It is
  // now in the watchdog below, reached only when the greeting button never
  // appeared. See the header comment: as a fast path it answered "logged in"
  // against a header that read "Sign In", and no re-scan could ever correct it.
  // Do not move it back up.

  // The greeting button covers both states:
  //   Logged out: button text === "Sign In"
  //   Logged in:  button text starts with "Hello,"
  function readState() {
    var btn = document.querySelector(
      'button.component--site-header-desktop-sign-in-greeting-button, ' +
      'button[class*="sign-in-greeting-button"], ' +
      'button[aria-label="Account"]'
    );
    if (btn) {
      var text = (btn.textContent || '').trim();
      if (text.indexOf('Hello,') === 0) return { state: 'in', via: 'btn_hello', text: text };
      if (text === 'Sign In') return { state: 'out', via: 'btn_signin', text: text };
      return { state: 'unknown', via: 'btn_other', text: text };
    }
    // Fallback: any header/nav span starting with "Hello," (covers re-skinned mobile).
    var spans = document.querySelectorAll('header span, nav span');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].textContent.trim().indexOf('Hello,') === 0) {
        return { state: 'in', via: 'fallback_span' };
      }
    }
    return { state: 'unknown', via: 'no_btn' };
  }

  function post(result) {
    if (window.__wegmansLoginPosted) return;
    window.__wegmansLoginPosted = true;
    if (window.__wegmansLoginObserver) {
      try { window.__wegmansLoginObserver.disconnect(); } catch(_) {}
      window.__wegmansLoginObserver = null;
    }
    var isLoggedIn = result.state === 'in';
    // Cache positive detection BEFORE postMessage so that even if a navigation
    // kills this script before RN receives the message, the next injection's
    // inconclusive fallback picks up the answer. Never cache 'out' (would block
    // correct detection after the user signs in) — but a negative verdict does
    // CLEAR a cached positive, so a verdict we have just disproved cannot
    // outlive the run that disproved it.
    try {
      if (isLoggedIn) {
        sessionStorage.setItem('mealio_wegmans_login_state', 'in');
      } else {
        sessionStorage.removeItem('mealio_wegmans_login_state');
      }
    } catch(_) {}
    var headerButtons = Array.from(document.querySelectorAll('header button, header a, nav button, nav a, [class*="header" i] button, [class*="header" i] a'));
    var btnDebug = headerButtons.slice(0, 15).map(function(b) {
      return { tag: b.tagName, aria: b.getAttribute('aria-label'), href: b.getAttribute('href'), cls: (b.className || '').slice(0, 60), text: b.textContent.trim().slice(0, 40) };
    });
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG',
      step: 'scan_result',
      isLoggedIn: isLoggedIn,
      state: result.state,
      via: result.via,
      btnText: result.text || null,
      headerButtons: btnDebug,
    }));
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  }

  // Fast path: button may already be rendered.
  var r0 = readState();
  if (r0.state !== 'unknown') { post(r0); return; }

  // Observer path: fire as soon as React renders the button.
  var observer = new MutationObserver(function() {
    var r = readState();
    if (r.state !== 'unknown') post(r);
  });
  window.__wegmansLoginObserver = observer;
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Watchdog: after 8 seconds, post whatever we have.
  setTimeout(function() {
    if (window.__wegmansLoginPosted) return;
    var r = readState();
    if (r.state !== 'unknown') { post(r); return; }

    // Detection is INCONCLUSIVE — eight seconds of observing and this page has
    // no readable greeting button at all. That is the MSAL landing page before
    // its header hydrates. ONLY here do we defer to what an earlier injection in
    // this session concluded, because the alternative is posting a false that
    // SilentLoginProbe latches for good. A header we CAN read always wins over
    // the cache; a header we cannot read is the one case where the cache is
    // better evidence than anything on this page.
    try {
      if (sessionStorage.getItem('mealio_wegmans_login_state') === 'in') {
        post({ state: 'in', via: 'sessionStorage' });
        return;
      }
    } catch(_) {}

    // Inconclusive and nothing cached. Resolve to signed OUT, deliberately:
    // that shows the user a login wall, where a false positive would run every
    // search and every add against a signed-out session and fail silently.
    post({ state: 'out', via: 'inconclusive_fail_closed' });
  }, 8000);
})();true;`;
}

// ── Product extraction ─────────────────────────────────────────────────────


// ── Add to cart ────────────────────────────────────────────────────────────


// ── Search navigation ──────────────────────────────────────────────────────


// ── Search and auto-add ────────────────────────────────────────────────────


// ── Parallel worker support (Wegmans-specific) ─────────────────────────────
//
// Hidden worker WebViews are navigated to /shop/search?query=<term> URLs and
// run this script as `injectedJavaScript`. It runs on every page load:
//
//   - On the warmup load (no `query` param, e.g. www.wegmans.com), do nothing.
//   - On a search page, wait for product tiles to render, extract up to 8
//     candidates, and post WORKER_RESULT with the workerId and term.
//
// Each worker is instantiated with its workerId baked into the script body.

function buildWegmansWorkerExtractBody(): string {
  const s = sel();
  return `
(function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function dbg(payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: 'WORKER_DEBUG', workerId: WORKER_ID }, payload))); } catch(_) {}
  }
  function getNameFromTile(tile) {
    var h3 = tile.querySelector('h3[data-testid="-baseHeading"]');
    if (!h3) return null;
    var t = (h3.textContent || '').trim().replace(/\\s+/g, ' ');
    return t.length > 0 ? t : null;
  }
  function findCard(el) {
    var node = el;
    for (var up = 0; up < 8; up++) {
      if (!node || !node.parentElement) return null;
      node = node.parentElement;
      if (node.querySelector('img')) return node;
    }
    return null;
  }
  function extractPrice(card) {
    var priceEl = card.querySelector('[class*="price"], [data-testid*="price"], [class*="Price"]');
    if (priceEl) {
      var t = priceEl.textContent.trim();
      if (t) return t;
    }
    var m = card.textContent.match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  // Extract query from URL. Skip if this is a warmup load (no query).
  var query = '';
  try {
    var sp = new URLSearchParams(window.location.search);
    query = sp.get('query') || '';
  } catch(_) {}
  if (!query) {
    dbg({ step: 'warmup_load', url: window.location.href });
    return;
  }

  // Async extraction
  (async function() {
    dbg({ step: 'extract_start', query: query, url: window.location.href });

    // Poll for tiles. First page load on a worker has MSAL bootstrap so allow
    // up to 12s; subsequent loads on the same worker are faster.
    var TILE_SEL = ${s.tile};
    var tiles = [];
    var waitedMs = 0;
    for (var poll = 0; poll < 60; poll++) {
      tiles = Array.from(document.querySelectorAll(TILE_SEL)).slice(0, 20);
      if (tiles.length > 0) break;
      await wait(200);
      waitedMs += 200;
    }

    if (tiles.length === 0) {
      dbg({ step: 'no_tiles', waitedMs: waitedMs });
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'WORKER_RESULT', workerId: WORKER_ID, query: query, candidates: [],
      }));
      return;
    }

    var seen = new Set();
    var candidates = [];
    for (var ti = 0; ti < tiles.length && candidates.length < 8; ti++) {
      var tile = tiles[ti];
      var name = getNameFromTile(tile);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      var card = findCard(tile.querySelector('h3[data-testid="-baseHeading"]')) || tile;
      var imgEl = card.querySelector('img');
      candidates.push({
        productName: name,
        imageUrl: imgEl ? imgEl.src : null,
        outOfStock: false,
        preferences: null,
        price: extractPrice(card),
        isWeightItem: false,
      });
    }

    dbg({ step: 'extract_done', waitedMs: waitedMs, candidateCount: candidates.length, firstName: candidates[0] ? candidates[0].productName : null });
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'WORKER_RESULT', workerId: WORKER_ID, query: query, candidates: candidates,
    }));
  })();
})();
true;
`;
}

/** Returns injectedJavaScript for a single worker. The workerId is baked in. */
export function buildWegmansWorkerScript(workerId: number): string {
  return 'var WORKER_ID = ' + workerId + ';\n' + buildWegmansWorkerExtractBody();
}

/** Returns the Wegmans warmup URL for a worker (loads homepage to bootstrap MSAL). */
export function getWegmansWarmupUrl(): string {
  return WEGMANS_URL;
}

/** Returns the Wegmans search URL for a given query. */
export function getWegmansSearchUrl(query: string): string {
  return 'https://www.wegmans.com/shop/search?query=' + encodeURIComponent(query);
}

// ── Export ──────────────────────────────────────────────────────────────────

export function getScripts(): StoreScripts {
  const cfg = storeConfig(SELECTOR_KEY);
  return {
    storeUrl: cfg.storeUrl ?? WEGMANS_URL,
    loginUrl: cfg.loginUrl ?? WEGMANS_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? WEGMANS_CART_URL,
    domain: WEGMANS_DOMAIN,
    isSearchUrl: (url: string) => url.includes('wegmans.com/search') || url.includes('wegmans.com/shop'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('wegmans.com') && !url.includes('/sign-in') && !url.includes('/login'),
    checkLoginScript: buildCheckLoginScript(),
    // Wegmans ships its own purpose-built worker (MSAL bootstrap handling),
    // exposed here so the parallel pool is driven uniformly off StoreScripts.
    getSearchUrl: (term: string) => searchUrlFor(SELECTOR_KEY, term, getWegmansSearchUrl(term)),
    cacheBustNav: cfg.cacheBustNav ?? false,
  };
}
