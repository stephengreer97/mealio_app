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

const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__wegmansLoginCheckActive) return;
  window.__wegmansLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));
    var isLoggedIn = false;

    // Desktop: look for greeting button with "Hello, Name".
    for (var i = 0; i < 20; i++) {
      var greetingBtn = document.querySelector(
        'button.component--site-header-desktop-sign-in-greeting-button'
      );
      if (greetingBtn) {
        var spans = greetingBtn.querySelectorAll('span');
        for (var si = 0; si < spans.length; si++) {
          if (spans[si].textContent.trim().indexOf('Hello,') === 0) {
            isLoggedIn = true;
            break;
          }
        }
        if (isLoggedIn) break;
      }
      var navSpans = document.querySelectorAll('nav span');
      for (var ni = 0; ni < navSpans.length; ni++) {
        if (navSpans[ni].textContent.trim().indexOf('Hello,') === 0) {
          isLoggedIn = true;
          break;
        }
      }
      if (isLoggedIn) break;
      await wait(100);
    }

    // Log header elements for mobile debugging.
    var headerButtons = Array.from(document.querySelectorAll('header button, header a, nav button, nav a, [class*="header" i] button, [class*="header" i] a'));
    var btnDebug = headerButtons.slice(0, 15).map(function(b) {
      return { tag: b.tagName, aria: b.getAttribute('aria-label'), href: b.getAttribute('href'), cls: (b.className || '').slice(0, 60), text: b.textContent.trim().slice(0, 40) };
    });
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'scan_result', isLoggedIn: isLoggedIn, greetingFound: !!document.querySelector('button.component--site-header-desktop-sign-in-greeting-button'), headerButtons: btnDebug }));

    window.__wegmansLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  } catch(e) {
    window.__wegmansLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ─────────────────────────────────────────────────────

const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var TILE_SEL = 'div.component--product-tile';
  var NAME_SEL = 'h3[data-testid="-baseHeading"]';

  // Poll for product tiles instead of fixed wait
  var tiles = [];
  for (var poll = 0; poll < 20; poll++) {
    tiles = Array.from(document.querySelectorAll(TILE_SEL)).slice(0, 20);
    if (tiles.length > 0) break;
    await wait(300);
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'EXTRACT_DEBUG',
    tilesFound: tiles.length,
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

  // Helper: click an add-button N times
  function clickIncN(btn, n) {
    return new Promise(function(resolve) {
      var i = 0;
      function next() {
        if (i >= n) return resolve();
        wait(300).then(function() {
          btn.click();
          return wait(500);
        }).then(function() {
          i++;
          next();
        });
      }
      next();
    });
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
  await wait(200);
  defaultBtn.click();

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
 * Builds a script that types a search term into the Wegmans search bar and
 * submits it, navigating to search results. Wegmans is SPA-style so
 * this uses the in-page search input rather than a URL navigation.
 */
function buildSearchScript(term: string): string {
  const escaped = JSON.stringify(term);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var term = ${escaped};
  var SEARCH_INPUT_SEL = 'input[type="search"], input[placeholder*="earch" i]';

  // Poll for the search input — the SPA may still be hydrating
  var searchInput = null;
  for (var elapsed = 0; elapsed < 10000; elapsed += 200) {
    searchInput = document.querySelector(SEARCH_INPUT_SEL);
    if (searchInput) break;
    await wait(200);
  }
  if (!searchInput) {
    document.removeEventListener('focusin', __noKbd, true);
    return;
  }

  // Set value via native setter so React bindings fire
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  var nativeSetter = setter ? setter.set : null;
  if (nativeSetter) {
    nativeSetter.call(searchInput, '');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(50);
    nativeSetter.call(searchInput, term);
  } else {
    searchInput.value = term;
  }
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));

  await wait(50);

  // Submit — requestSubmit() is most reliable for React/Next.js forms
  var form = searchInput.closest('form');
  if (form) {
    try {
      form.requestSubmit();
    } catch(_) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  } else {
    ['keydown', 'keypress', 'keyup'].forEach(function(type) {
      searchInput.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
  }

  document.removeEventListener('focusin', __noKbd, true);
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
  function scoreMatch(a, b) {
    function n(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim(); }
    var na = n(a), nb = n(b);
    if (na === nb) return 100;
    var wa = na.split(' ').filter(Boolean), sb = new Set(nb.split(' ').filter(Boolean));
    for (var i = 0; i < wa.length; i++) { if (CRITICAL.has(wa[i]) && !sb.has(wa[i])) return 0; }
    var m = wa.filter(function(w) { return sb.has(w); }).length;
    var p = m / wa.length;
    if (p < 0.7) return 0;
    return Math.min(99, Math.round(p * 100));
  }

  // ── Search using the search bar (SPA style) ───────────────────────────
  var staleTitle = getNameFromTile(document.querySelector(TILE_SEL) || document.createElement('div'));

  var searchInput = null;
  for (var elapsed = 0; elapsed < 10000; elapsed += 200) {
    searchInput = document.querySelector(SEARCH_INPUT_SEL);
    if (searchInput) break;
    await wait(200);
  }
  if (!searchInput) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: [] }));
    return;
  }

  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  var nativeSetter = setter ? setter.set : null;
  if (nativeSetter) {
    nativeSetter.call(searchInput, SEARCH_TERM);
  } else {
    searchInput.value = SEARCH_TERM;
  }
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(50);

  var form = searchInput.closest('form');
  if (form) {
    try { form.requestSubmit(); } catch(_) { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
  } else {
    ['keydown', 'keypress', 'keyup'].forEach(function(type) {
      searchInput.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
  }

  // Wait for fresh products to replace stale results
  var POLL = 50;
  for (var we = 0; we < 8000; we += POLL) {
    var firstTile = document.querySelector(TILE_SEL);
    if (firstTile) {
      var currentTitle = getNameFromTile(firstTile);
      if (!staleTitle || currentTitle !== staleTitle) break;
    }
    await wait(POLL);
  }

  // Poll for product tiles after search results load
  var tiles = [];
  for (var poll = 0; poll < 20; poll++) {
    tiles = Array.from(document.querySelectorAll(TILE_SEL)).slice(0, 8);
    if (tiles.length > 0) break;
    await wait(300);
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
  try {
    bestTile.scrollIntoView({ behavior: 'instant', block: 'center' });

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

    // Helper: click increment button N times
    function clickIncN(btn, n) {
      return new Promise(function(resolve) {
        var idx = 0;
        function next() {
          if (idx >= n) return resolve();
          wait(300).then(function() {
            btn.click();
            return wait(500);
          }).then(function() {
            idx++;
            next();
          });
        }
        next();
      });
    }

    // State 3: stepper already open
    var incBtn = bestTile.querySelector(INC_BTN_SEL);
    if (incBtn) {
      await clickIncN(incBtn, QTY);
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
      return;
    }

    var defaultBtn = bestTile.querySelector(ADD_BTN_SEL);
    if (!defaultBtn) {
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_button', candidates: candidates }));
      return;
    }

    // Distinguish fresh (SVG only) from bubble (shows cart qty number)
    var isBubble = /\\d/.test(defaultBtn.textContent);
    await wait(200);
    defaultBtn.click();

    // State 1: fresh add — first click already added 1 unit
    if (!isBubble) {
      if (QTY === 1) {
        await wait(600);
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
        return;
      }
      incBtn = await waitForIncBtn(bestTile);
      if (!incBtn) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'stepper_not_found', candidates: candidates }));
        return;
      }
      await clickIncN(incBtn, QTY - 1);

    // State 2: bubble — click only opened stepper, need all QTY units
    } else {
      incBtn = await waitForIncBtn(bestTile);
      if (!incBtn) {
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'stepper_not_found', candidates: candidates }));
        return;
      }
      await clickIncN(incBtn, QTY);
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates }));
  }
})();true;`;
}

// ── Export ──────────────────────────────────────────────────────────────────

export function getScripts(): StoreScripts {
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
  };
}
