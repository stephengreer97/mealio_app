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

// ── Shared selector constants ──────────────────────────────────────────────
const TILE_SEL = 'div.component--product-tile';
const NAME_SEL = 'h3[data-testid="-baseHeading"]';
const ADD_BTN_SEL = 'button.default-add-button';
const INC_BTN_SEL = 'button.add-button';
const SEARCH_INPUT_SEL = 'input[type="search"], input[placeholder*="earch" i]';

// ── Login check ────────────────────────────────────────────────────────────

// MutationObserver-based so it survives Wegmans's MSAL bootstrap that bounces
// the URL multiple times during page load. The script returns synchronously
// after wiring the observer + setTimeout — if a navigation kills it, the next
// re-injection sets up a new observer with no progress lost.
//
// sessionStorage caches a positive ('in') detection across page bounces so a
// late-killed observer doesn't lose its answer. 'out' is NEVER cached so that
// post-login re-injections after the user signs in always re-check fresh.
const CHECK_LOGIN_SCRIPT = `(function() {
  if (window.__wegmansLoginPosted) return;
  if (window.__wegmansLoginObserver) {
    try { window.__wegmansLoginObserver.disconnect(); } catch(_) {}
    window.__wegmansLoginObserver = null;
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

  // sessionStorage fast-path: if a previous injection within this session
  // already determined logged-in, surface it immediately and skip the rest.
  try {
    var cached = sessionStorage.getItem('mealio_wegmans_login_state');
    if (cached === 'in') {
      window.__wegmansLoginPosted = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'scan_result', isLoggedIn: true, state: 'in', via: 'sessionStorage' }));
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }));
      return;
    }
  } catch(_) {}

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
    // fast-path picks up the answer. Never cache 'out' (would block correct
    // detection after user signs in).
    if (isLoggedIn) {
      try { sessionStorage.setItem('mealio_wegmans_login_state', 'in'); } catch(_) {}
    }
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

  // Watchdog: after 8 seconds, post whatever we have (treat unknown as logged-out).
  setTimeout(function() {
    if (window.__wegmansLoginPosted) return;
    post(readState());
  }, 8000);
})();true;`;

// ── Product extraction ─────────────────────────────────────────────────────

const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  // Re-injection guard. The cart flow re-injects the inflight script on a
  // same-URL onLoadEnd — REQUIRED for Wegmans' SSO/MSAL reload (which lands in a
  // fresh JS context, so this flag is reset and the script re-runs). But the
  // Wegmans SPA also fires spurious onLoadEnds while THIS run is still polling
  // for results; re-running then posts a DUPLICATE SEARCH_RESULT that the next
  // item consumes → wrong products. The guard no-ops those same-context
  // re-injections; the try/finally clears it on every exit so the next item runs.
  if (window.__wegmansExtractActive) return;
  window.__wegmansExtractActive = true;
  try {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var TILE_SEL = 'div.component--product-tile';
  var NAME_SEL = 'h3[data-testid="-baseHeading"]';

  function getFirstTileName() {
    var el = document.querySelector(TILE_SEL + ' ' + NAME_SEL);
    return el ? (el.textContent || '').trim().replace(/\\s+/g, ' ') : '';
  }

  // Wait for tiles to (a) exist AND (b) differ from the previous search's
  // first-tile name. onLoadEnd fires the moment Wegmans pushes the new URL,
  // but the SPA needs another ~500ms+ to fetch results and re-render tiles.
  // The previous first-tile is stashed in sessionStorage by buildSearchScript
  // (survives the full-page nav, unlike a window var). Without it, the extract
  // grabs whatever tiles are present — sometimes the PREVIOUS search's results.
  var stale = '';
  try { stale = sessionStorage.getItem('__wegStaleTitle') || ''; } catch(_) {}
  var tiles = [];
  var tilesChanged = false;
  var waitedMs = 0;
  for (var poll = 0; poll < 40; poll++) {
    tiles = Array.from(document.querySelectorAll(TILE_SEL)).slice(0, 20);
    var firstName = getFirstTileName();
    var present = tiles.length > 0;
    var differs = !stale || (firstName && firstName !== stale);
    if (present && differs) { tilesChanged = true; break; }
    await wait(200);
    waitedMs += 200;
  }
  // Leave THIS search's first tile behind as the baseline for the NEXT search.
  // buildSearchScript also sets it, but the next extract can race ahead of
  // buildSearchScript (a stray onLoadEnd on the old page pops it early); having
  // the baseline already in place means that early run WAITS for the tiles to
  // change instead of grabbing these (now stale) results.
  try { sessionStorage.setItem('__wegStaleTitle', getFirstTileName()); } catch(_) {}

  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'EXTRACT_DEBUG',
    tilesFound: tiles.length,
    tilesChanged: tilesChanged,
    waitedMs: waitedMs,
    staleTitle: stale,
    firstTileName: getFirstTileName(),
    url: window.location.href,
    bodyTextSample: document.body.innerText.slice(0, 300)
  }));

  if (tiles.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  // Helper: walk up to 8 parent levels looking for a container with an img tag
  function findCard(el) {
    var node = el;
    for (var up = 0; up < 8; up++) {
      if (!node || !node.parentElement) return null;
      node = node.parentElement;
      if (node.querySelector('img')) return node;
    }
    return null;
  }

  // Helper: extract price — try class/data selectors first, fall back to $X.XX regex
  function extractPrice(tile) {
    var priceEl = tile.querySelector('[class*="price"], [data-testid*="price"], [class*="Price"]');
    if (priceEl) {
      var t = priceEl.textContent.trim();
      if (t) return t;
    }
    var m = tile.textContent.match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  var seen = new Set();
  var candidates = [];

  for (var ti = 0; ti < tiles.length; ti++) {
    var tile = tiles[ti];
    var nameEl = tile.querySelector(NAME_SEL);
    var name = nameEl ? nameEl.textContent.trim().replace(/\\s+/g, ' ') : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var card = findCard(nameEl) || tile;
    var imgEl = card.querySelector('img');
    var imageUrl = imgEl ? imgEl.src : null;
    var price = extractPrice(card);

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: false, preferences: null, price: price, isWeightItem: false });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
  } finally { window.__wegmansExtractActive = false; }
})();true;`;

// ── Add to cart ────────────────────────────────────────────────────────────

/**
 * Builds a script that finds a specific product tile by name and adds qty units
 * to the Wegmans cart. Handles fresh, bubble, and stepper states.
 * Posts { type: 'ADD_RESULT', success: bool, reason?: string }.
 */
function buildAddToCartScript(
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  const escapedName = JSON.stringify(productName);

  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var QTY = ${qty};
  var TILE_SEL = 'div.component--product-tile';
  var NAME_SEL = 'h3[data-testid="-baseHeading"]';
  var ADD_BTN_SEL = 'button.default-add-button';
  var INC_BTN_SEL = 'button.add-button';

  // Poll for target product tile instead of fixed wait
  var targetTile = null;
  for (var poll = 0; poll < 20; poll++) {
    var tiles = Array.from(document.querySelectorAll(TILE_SEL));
    for (var ti = 0; ti < tiles.length; ti++) {
      var nameEl = tiles[ti].querySelector(NAME_SEL);
      var name = nameEl ? nameEl.textContent.trim().replace(/\\s+/g, ' ') : null;
      if (name === TARGET_NAME) {
        targetTile = tiles[ti];
        break;
      }
    }
    if (targetTile) break;
    await wait(300);
  }

  if (!targetTile) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  targetTile.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Helper: wait for stepper add-button to appear inside tile
  function waitForIncBtn(maxMs) {
    if (!maxMs) maxMs = 5000;
    return new Promise(function(resolve) {
      var elapsed = 0;
      function poll() {
        var btn = targetTile.querySelector(INC_BTN_SEL);
        if (btn) return resolve(btn);
        elapsed += 100;
        if (elapsed >= maxMs) return resolve(null);
        setTimeout(poll, 100);
      }
      poll();
    });
  }

  // Scroll an element into the *visible* viewport, accounting for Wegmans's
  // sticky header. See buildSearchAndAddScript for rationale.
  async function scrollIntoCenter(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(300);
    var srect = el.getBoundingClientRect();
    var STICKY_HEADER_PX = 100;
    if (srect.top < STICKY_HEADER_PX) {
      window.scrollBy(0, srect.top - STICKY_HEADER_PX - 20);
      await wait(200);
    }
  }

  // Robust click — see buildSearchAndAddScript for rationale. The native
  // btn.click() is only a fallback for when synthetic events throw, NOT an
  // unconditional double-fire (that caused the qty+1 regression).
  function robustClick(btn) {
    try {
      var rect = btn.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var pOpts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, pointerType: 'touch' };
      var mOpts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
      btn.dispatchEvent(new PointerEvent('pointerdown', pOpts));
      btn.dispatchEvent(new MouseEvent('mousedown', mOpts));
      btn.dispatchEvent(new PointerEvent('pointerup', pOpts));
      btn.dispatchEvent(new MouseEvent('mouseup', mOpts));
      btn.dispatchEvent(new MouseEvent('click', mOpts));
    } catch(_) {
      try { btn.click(); } catch(__) {}
    }
  }

  // Helper: click an add-button N times, scrolling into view before each click
  async function clickIncN(btn, n) {
    for (var i = 0; i < n; i++) {
      await scrollIntoCenter(btn);
      await wait(200);
      robustClick(btn);
      await wait(500);
    }
  }

  // State 3: stepper already open — increment button already visible
  var incBtn = targetTile.querySelector(INC_BTN_SEL);
  if (incBtn) {
    await clickIncN(incBtn, QTY);
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
    return;
  }

  var defaultBtn = targetTile.querySelector(ADD_BTN_SEL);
  if (!defaultBtn) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_button' }));
    return;
  }

  // Distinguish "fresh" (SVG only) from "bubble" (shows a cart qty number)
  var isBubble = /\\d/.test(defaultBtn.textContent);
  await scrollIntoCenter(defaultBtn);
  await wait(200);
  robustClick(defaultBtn);

  // State 1: fresh add — first click already added 1 unit
  if (!isBubble) {
    if (QTY === 1) {
      await wait(600);
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
      return;
    }
    incBtn = await waitForIncBtn();
    if (!incBtn) {
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'stepper_not_found' }));
      return;
    }
    await clickIncN(incBtn, QTY - 1);

  // State 2: bubble — click only opened stepper, add all QTY units
  } else {
    incBtn = await waitForIncBtn();
    if (!incBtn) {
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'stepper_not_found' }));
      return;
    }
    await clickIncN(incBtn, QTY);
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
})();true;`;
}

// ── Search navigation ──────────────────────────────────────────────────────

/**
 * Builds a script that navigates the WebView to Wegmans's search results page
 * via direct URL navigation. The SPA detached-overlay approach was unreliable:
 * sometimes the form submit succeeded and the SPA navigated, sometimes it
 * silently failed and killed the script context. Direct URL nav is slower
 * (full page reload + MSAL bootstrap) but always works.
 *
 * Posts NAV_INTENT so onLoadEnd's queue consumption only happens for the new
 * URL (filtering out spurious events for the page we're leaving).
 */
function buildSearchScript(term: string): string {
  const escaped = JSON.stringify(term);
  return `(function() {
  // Wegmans's SPA lowercases the query value in the canonical URL — match
  // that so WebViewCartSheet's NAV_INTENT comparison succeeds.
  var expectedUrl = 'https://www.wegmans.com/shop/search?query=' + encodeURIComponent(${escaped}.toLowerCase());
  try {
    // Stash the CURRENT first product tile so the extract on the next page can
    // wait until results actually change (avoids reading the previous search's
    // tiles before Wegmans' SPA re-renders). sessionStorage survives the full nav.
    var t = document.querySelector('div.component--product-tile h3[data-testid="-baseHeading"]');
    var firstName = t ? (t.textContent || '').trim().replace(/\\s+/g, ' ') : '';
    try { sessionStorage.setItem('__wegStaleTitle', firstName); } catch(_) {}
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'NAV_INTENT', target: expectedUrl }));
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_DEBUG', step: 'url_nav', url: expectedUrl, staleTitle: firstName }));
  } catch(_) {}
  window.location.href = expectedUrl;
})();true;`;
}

// ── Search and auto-add ────────────────────────────────────────────────────

/**
 * Builds a script that searches for a term using the Wegmans search bar,
 * scores candidates against the search term, and auto-adds the best match.
 * Handles fresh, bubble, and stepper button states.
 * Posts { type: 'SEARCH_AND_ADD_RESULT', success: bool, productName?, candidates? }.
 */
function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null = null,
): string {
  const escapedTerm = JSON.stringify(searchTerm);
  return `(async function() {
  // Idempotency guard: WebViewCartSheet may re-inject this script when an
  // onLoadEnd fires for the same URL while we're still in-flight (e.g.
  // Wegmans MSAL bootstrap reloads the page mid-script). If we're still
  // running in the same JS context, no-op the duplicate. A real page reload
  // wipes window state, so the new context proceeds normally.
  if (window.__wegmansAddInflight) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_DEBUG', step: 'duplicate_injection_skipped' })); } catch(_) {}
    return;
  }
  window.__wegmansAddInflight = true;

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  var TILE_SEL = 'div.component--product-tile';
  var NAME_SEL = 'h3[data-testid="-baseHeading"]';
  var ADD_BTN_SEL = 'button.default-add-button';
  var INC_BTN_SEL = 'button.add-button';
  var SEARCH_INPUT_SEL = 'input[type="search"], input[placeholder*="earch" i]';

  // ── Helper: get product name from tile ─────────────────────────────────
  function getNameFromTile(tile) {
    var h3 = tile.querySelector(NAME_SEL);
    if (!h3) return null;
    var text = h3.textContent.trim().replace(/\\s+/g, ' ');
    return text.length > 0 ? text : null;
  }

  // ── Scoring (CRITICAL_WORDS matching, same as HEB) ─────────────────────
  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground']);
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
  function scoreOne(na, nb) {
    if (na === nb) return 100;
    var wa = na.split(' ').filter(Boolean), sb = new Set(nb.split(' ').filter(Boolean));
    for (var i = 0; i < wa.length; i++) { if (CRITICAL.has(wa[i]) && !sb.has(wa[i])) return 0; }
    var m = wa.filter(function(w) { return sb.has(w); }).length;
    var p = m / wa.length;
    if (p < 0.7) return 0;
    return Math.min(99, Math.round(p * 100));
  }
  function scoreMatch(a, b) {
    var s1 = scoreOne(normDiacritic(a), normDiacritic(b));
    var s2 = scoreOne(normStrip(a), normStrip(b));
    return Math.max(s1, s2);
  }

  // ── Tile pickup ────────────────────────────────────────────────────────
  // buildSearchScript already navigated to /shop/search?query=<term> and the
  // page has just finished loading (this script runs from onLoadEnd). All we
  // need to do here is wait for product tiles, find the best match for
  // SEARCH_TERM, and add it to cart.
  function dbg(payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: 'ADD_DEBUG' }, payload))); } catch(_) {}
  }

  var tiles = [];
  var waitedMs = 0;
  for (var poll = 0; poll < 40; poll++) {
    tiles = Array.from(document.querySelectorAll(TILE_SEL)).slice(0, 8);
    if (tiles.length > 0) break;
    await wait(200);
    waitedMs += 200;
  }
  dbg({ step: 'tiles_found', count: tiles.length, waitedMs: waitedMs, url: window.location.href });

  // Page-bootstrap buffer — tiles being in the DOM doesn't mean Wegmans's
  // cart subsystem is ready. Without this wait, clicks register as React
  // events (UI updates locally to qty=1, qty=2) but the cart-add API is
  // rejected and the qty visually reverts to 0. ~2s is the empirical
  // minimum for the cart session/CSRF token to be in place.
  if (tiles.length > 0) {
    dbg({ step: 'cart_bootstrap_wait', ms: 2000 });
    await wait(2000);
  }

  // ── Gather candidates and find best match ─────────────────────────────
  var candidates = [];
  var seen = new Set();
  var bestTile = null, bestName = null;

  for (var ti = 0; ti < tiles.length; ti++) {
    var tile = tiles[ti];
    var name = getNameFromTile(tile);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    var imgEl = tile.querySelector('img');
    candidates.push({ productName: name, imageUrl: imgEl ? imgEl.src : null, outOfStock: false, preferences: null, price: null, isWeightItem: false });
    if (!bestName && scoreMatch(SEARCH_TERM, name) === 100) {
      bestTile = tile; bestName = name;
    }
  }

  if (!bestName || !bestTile) {
    var reason = candidates.length === 0 ? 'no_results' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  // ── Add to cart from the matched tile ──────────────────────────────────
  // ADD_DEBUG snapshots are posted at every state change so we can diagnose
  // a "success but cart unchanged" failure from the log alone.
  function dbgAdd(payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: 'ADD_DEBUG' }, payload))); } catch(_) {}
  }
  function snapshotBtn(label, btn) {
    if (!btn) { dbgAdd({ step: label, found: false }); return null; }
    var rect = btn.getBoundingClientRect();
    var aria = btn.getAttribute('aria-label') || null;
    return {
      step: label,
      found: true,
      tag: btn.tagName,
      cls: (btn.className || '').slice(0, 80),
      text: (btn.textContent || '').trim().slice(0, 60),
      ariaLabel: aria,
      disabled: btn.disabled || false,
      visible: rect.width > 0 && rect.height > 0,
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      innerHtml: (btn.innerHTML || '').slice(0, 120),
    };
  }
  function dbgBtn(label, btn) { dbgAdd(snapshotBtn(label, btn) || { step: label, found: false }); }

  // Robust click — dispatches the full pointer event sequence (pointerdown,
  // mousedown, pointerup, mouseup, click) with proper coordinates. React's
  // synthetic event system on mobile WebView listens for pointer events,
  // and bare .click() often doesn't trigger the handler. Falls back to
  // element.click() if any event constructor isn't available.
  // Scroll an element into the *visible* viewport, accounting for Wegmans's
  // sticky header. scrollIntoView({block:'center'}) alone leaves the button
  // partially behind the header (rect y came back as -36 in earlier runs).
  async function scrollIntoCenter(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(300);
    var rect = el.getBoundingClientRect();
    // Wegmans's sticky header is ~80px on mobile. If the element top is in
    // that zone, scroll up so the element is fully below the header.
    var STICKY_HEADER_PX = 100;
    if (rect.top < STICKY_HEADER_PX) {
      window.scrollBy(0, rect.top - STICKY_HEADER_PX - 20);
      await wait(200);
    }
  }

  function robustClick(btn) {
    // Re-read the rect right before dispatching so coordinates are accurate
    // even if a previous step caused a reflow.
    //
    // CRITICAL: only ONE click should fire onClick per call. Earlier this
    // function called btn.click() unconditionally AFTER dispatching a
    // synthetic 'click' event — that made every robustClick() trigger
    // Wegmans's onClick handler twice (qty=1 → cart got qty=2, etc.).
    // Native btn.click() is now only a fallback for when synthetic events
    // throw (rare — only on environments missing PointerEvent constructor).
    try {
      var rect = btn.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var pOpts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, pointerType: 'touch' };
      var mOpts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
      btn.dispatchEvent(new PointerEvent('pointerdown', pOpts));
      btn.dispatchEvent(new MouseEvent('mousedown', mOpts));
      btn.dispatchEvent(new PointerEvent('pointerup', pOpts));
      btn.dispatchEvent(new MouseEvent('mouseup', mOpts));
      btn.dispatchEvent(new MouseEvent('click', mOpts));
    } catch(_) {
      try { btn.click(); } catch(__) {}
    }
  }

  try {

    // Helper: wait for stepper add-button inside tile
    function waitForIncBtn(targetTile, maxMs) {
      if (!maxMs) maxMs = 5000;
      return new Promise(function(resolve) {
        var el2 = 0;
        function poll2() {
          var btn = targetTile.querySelector(INC_BTN_SEL);
          if (btn) return resolve(btn);
          el2 += 100;
          if (el2 >= maxMs) return resolve(null);
          setTimeout(poll2, 100);
        }
        poll2();
      });
    }

    // Helper: click increment button N times, logging before/after state.
    // Each click needs settle time after: Wegmans's cart API is async, and
    // clicking + again before the server response can race the optimistic-
    // update reconciliation and visually reset qty to 0.
    //
    // NOTE: no retry-on-aria-unchanged. The + button's aria-label is a
    // static "Add 1 of X to cart" description that doesn't change between
    // clicks even when the cart qty does — retrying on that signal caused
    // double-adds (qty+N bugs). Trust the click; the 700ms buffer is
    // enough for the cart API to commit between clicks.
    async function clickIncN(btn, n) {
      for (var i = 0; i < n; i++) {
        await scrollIntoCenter(btn);
        var beforeAria = btn.getAttribute('aria-label');
        dbgAdd({ step: 'inc_pre_click', i: i + 1, of: n, ariaLabel: beforeAria });
        await wait(200);
        robustClick(btn);
        await wait(700);
        var afterAria = btn.getAttribute('aria-label');
        dbgAdd({ step: 'inc_post_click', i: i + 1, of: n, ariaLabel: afterAria });
      }
    }

    dbgAdd({ step: 'add_phase_start', qty: QTY, bestName: bestName });

    // State 3: stepper already open
    var incBtn = bestTile.querySelector(INC_BTN_SEL);
    if (incBtn) {
      dbgBtn('state3_stepper_open_incBtn', incBtn);
      await clickIncN(incBtn, QTY);
      await wait(300);  // final settle before next ingredient
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
      return;
    }

    var defaultBtn = bestTile.querySelector(ADD_BTN_SEL);
    if (!defaultBtn) {
      // No default-add-button — log all buttons in the tile so we can find
      // the correct selector on mobile.
      var allButtons = Array.from(bestTile.querySelectorAll('button')).slice(0, 8);
      dbgAdd({
        step: 'no_default_btn_dump',
        tileButtonCount: allButtons.length,
        buttons: allButtons.map(function(b) { return snapshotBtn('btn', b); }),
      });
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_button', candidates: candidates }));
      return;
    }

    // Scroll the BUTTON into view (not the tile) — the tile is tall enough
    // that scrolling it to center can leave the button hidden behind the
    // sticky header. Earlier runs reported rect y=-36 (off-screen).
    await scrollIntoCenter(defaultBtn);
    await wait(200);
    dbgBtn('default_btn_pre_click', defaultBtn);

    // Distinguish fresh (SVG only) from bubble (shows cart qty number).
    // textContent on the button itself — NOT aria-label, which contains
    // "Quantity of X is N" and would always include a digit.
    var btnText = (defaultBtn.textContent || '').trim();
    var isBubble = /\\d/.test(btnText);
    dbgAdd({ step: 'state_decision', isBubble: isBubble, btnText: btnText.slice(0, 40), qty: QTY });

    robustClick(defaultBtn);
    // Settle after first click — Wegmans's cart API is async; the server
    // needs to commit qty=1 before any subsequent click can succeed.
    await wait(700);
    dbgBtn('default_btn_post_click', defaultBtn);

    // State 1: fresh add — first click already added 1 unit
    if (!isBubble) {
      if (QTY === 1) {
        // Verify state changed — defaultBtn should now show a digit (became a bubble).
        var verifyText = ((bestTile.querySelector(ADD_BTN_SEL) || {}).textContent || '').trim();
        var verifyHasDigit = /\\d/.test(verifyText);
        dbgAdd({ step: 'state1_fresh_qty1_verify', postText: verifyText.slice(0, 40), hasDigit: verifyHasDigit });

        // If the click didn't register (button didn't transition to bubble),
        // retry once after scrolling.
        if (!verifyHasDigit) {
          var retryBtn = bestTile.querySelector(ADD_BTN_SEL);
          if (retryBtn) {
            dbgAdd({ step: 'state1_retry_attempt' });
            await scrollIntoCenter(retryBtn);
            await wait(200);
            robustClick(retryBtn);
            await wait(700);
            var retryText = ((bestTile.querySelector(ADD_BTN_SEL) || {}).textContent || '').trim();
            dbgAdd({ step: 'state1_retry_verify', postText: retryText.slice(0, 40), hasDigit: /\\d/.test(retryText) });
          }
        }
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
        return;
      }
      // QTY > 1 fresh-add — verify the first click actually transitioned the
      // button. If not, retry once (same logic as the QTY===1 branch).
      var afterFirstClickText = ((bestTile.querySelector(ADD_BTN_SEL) || {}).textContent || '').trim();
      var firstClickHasDigit = /\\d/.test(afterFirstClickText);
      dbgAdd({ step: 'state1_fresh_qtyN_first_verify', postText: afterFirstClickText.slice(0, 40), hasDigit: firstClickHasDigit, qty: QTY });
      if (!firstClickHasDigit) {
        var retryBtn = bestTile.querySelector(ADD_BTN_SEL);
        if (retryBtn) {
          dbgAdd({ step: 'state1_fresh_qtyN_first_retry' });
          await scrollIntoCenter(retryBtn);
          await wait(200);
          robustClick(retryBtn);
          await wait(700);
        }
      }
      incBtn = await waitForIncBtn(bestTile);
      dbgBtn('state1_fresh_post_first_incBtn', incBtn);
      if (!incBtn) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'stepper_not_found', candidates: candidates }));
        return;
      }
      await clickIncN(incBtn, QTY - 1);
      // Final settle so the last increment commits before this script ends.
      await wait(300);

    // State 2: bubble — click only opened stepper, need all QTY units
    } else {
      incBtn = await waitForIncBtn(bestTile);
      dbgBtn('state2_bubble_incBtn', incBtn);
      if (!incBtn) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'stepper_not_found', candidates: candidates }));
        return;
      }
      await clickIncN(incBtn, QTY);
      // Final settle so the last increment commits before this script ends.
      await wait(800);
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates }));
  }
})();true;`;
}

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

const WEGMANS_WORKER_EXTRACT_BODY = `
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
    var TILE_SEL = 'div.component--product-tile';
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

/** Returns injectedJavaScript for a single worker. The workerId is baked in. */
export function buildWegmansWorkerScript(workerId: number): string {
  return 'var WORKER_ID = ' + workerId + ';\n' + WEGMANS_WORKER_EXTRACT_BODY;
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
  // TEMP(bundle-check): proves the serial build is live. If the cart log shows
  // `parallel= true` but NOT this line, the running bundle is stale → reload.
  console.log('[wegmans] getScripts BUILD-MARKER v2 — forceSerialSearch:true workerCount:2');
  return {
    storeUrl: WEGMANS_URL,
    loginUrl: WEGMANS_LOGIN_URL,
    cartUrl: WEGMANS_CART_URL,
    domain: WEGMANS_DOMAIN,
    isSearchUrl: (url: string) => url.includes('wegmans.com/search') || url.includes('wegmans.com/shop'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('wegmans.com') && !url.includes('/sign-in') && !url.includes('/login'),
    checkLoginScript: CHECK_LOGIN_SCRIPT,
    extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
    buildAddToCartScript,
    buildSearchScript,
    buildSearchAndAddScript,
    // Wegmans ships its own purpose-built worker (MSAL bootstrap handling),
    // exposed here so the parallel pool is driven uniformly off StoreScripts.
    getSearchUrl: getWegmansSearchUrl,
    buildWorkerScript: buildWegmansWorkerScript,
    // Wegmans WAF 403s the concurrent worker searches — even 2 staggered workers
    // still blocked — so run searches SERIALLY (like ALDI). Also drop the `?_t=`
    // cache-buster on main-webview navs. workerCount/stagger are kept for if/when
    // the parallel path is retried. NOTE: no `spaSearch` — Wegmans relies on the
    // SSO/MSAL inflight re-injection.
    forceSerialSearch: true,
    cacheBustNav: false,
    workerCount: 2,
    workerStaggerMs: 400,
  };
}
