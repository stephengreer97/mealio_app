// Injectable JavaScript strings for Walmart WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// Ported from ~/mealio_ext/content-walmart.js — same selectors and logic,
// adapted to the StoreScripts interface used by the store registry.

import type { StoreScripts } from './index';

const WALMART_URL = 'https://www.walmart.com/grocery';
const WALMART_LOGIN_URL = 'https://www.walmart.com/account/login';
const WALMART_CART_URL = 'https://www.walmart.com/cart';
const WALMART_DOMAIN = 'walmart.com';

// ── Shared selector constants (used in multiple scripts) ────────────────────
const CARD_SEL = '[data-automation-id="product"], [data-item-id]';
const TITLE_SEL = '[data-automation-id="product-title"], [data-automation-id="name"]';

// ── Login check ─────────────────────────────────────────────────────────────

// Click-based detection: open the hamburger menu and read the slide-out
// drawer's structure. Logged-out shows a "Sign in or create account" button
// (we click it, which navigates to /account/login; onLoadEnd then transitions
// the WebViewCartSheet to step='login'). Logged-in shows a "Hi, <name>" greeting.
// We post heavy LOGIN_DEBUG payloads so we can iterate on selectors as we test.
const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__walmartLoginCheckActive) return;
  window.__walmartLoginCheckActive = true;
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function post(type, data) {
    try {
      var payload = { type: type };
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } catch (_) {}
  }
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function summarize(el, max) {
    if (!el) return null;
    return {
      tag: el.tagName,
      aria: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      id: el.id || null,
      cls: (el.getAttribute('class') || '').slice(0, 120),
      dataTestId: el.getAttribute('data-testid'),
      href: el.getAttribute('href'),
      text: (el.textContent || '').trim().slice(0, max || 80)
    };
  }
  try {
    post('LOGIN_DEBUG', { step: 'start', url: window.location.href, ua: navigator.userAgent.slice(0, 120) });

    // ── 1. Find and click hamburger ──────────────────────────────────────
    // Walmart's mobile site renders the SPA shell late — poll up to ~4s.
    var hamburger = null;
    var hamburgerSelectors = [
      'button[aria-label*="department" i]',
      'button[aria-label="Menu"]',
      'button[aria-label*="menu" i]',
      'button[data-testid*="menu" i]',
      'button[id*="menu" i]',
      'header button[aria-haspopup]',
      'header [role="button"][aria-label*="menu" i]'
    ];
    for (var pi = 0; pi < 20; pi++) {
      for (var si = 0; si < hamburgerSelectors.length; si++) {
        var found = document.querySelector(hamburgerSelectors[si]);
        if (found && isVisible(found)) { hamburger = found; break; }
      }
      if (hamburger) break;
      await wait(200);
    }

    if (!hamburger) {
      // Dump candidate header buttons so we can adjust selectors next iteration.
      var headerBtns = Array.from(document.querySelectorAll('header button, header a, nav button, [class*="header" i] button'))
        .slice(0, 30).map(function(b) { return summarize(b, 60); });
      post('LOGIN_DEBUG', { step: 'no_hamburger', headerBtns: headerBtns });
      window.__walmartLoginCheckActive = false;
      post('LOGIN_STATUS', { isLoggedIn: false });
      return;
    }

    post('LOGIN_DEBUG', { step: 'hamburger_found', el: summarize(hamburger, 60) });
    hamburger.click();
    await wait(1500);

    // ── 2. Locate the opened menu container ──────────────────────────────
    var menuSelectors = [
      '[role="dialog"][aria-hidden="false"]',
      '[role="dialog"]',
      'aside[aria-hidden="false"]',
      'aside',
      '[role="menu"]',
      '[class*="drawer" i]:not([aria-hidden="true"])',
      '[class*="sidebar" i]:not([aria-hidden="true"])',
      'nav[aria-label*="menu" i]'
    ];
    var menu = null;
    for (var msi = 0; msi < menuSelectors.length; msi++) {
      var m = document.querySelector(menuSelectors[msi]);
      if (m && isVisible(m)) { menu = m; break; }
    }

    var scope = menu || document.body;
    var menuText = (scope.innerText || '').slice(0, 1500);
    var interactive = Array.from(scope.querySelectorAll('button, a'))
      .filter(isVisible).slice(0, 50);
    var buttonsDump = interactive.map(function(b) { return summarize(b, 100); });

    post('LOGIN_DEBUG', {
      step: 'menu_opened',
      menuFound: !!menu,
      menuSelector: menu ? menu.tagName + (menu.getAttribute('class') ? '.' + menu.getAttribute('class').slice(0, 60) : '') : null,
      menuTextSample: menuText,
      buttonCount: interactive.length,
      buttons: buttonsDump
    });

    // ── 3. Look for the two indicators ───────────────────────────────────
    var signInEl = null;
    for (var bi = 0; bi < interactive.length; bi++) {
      var bt = (interactive[bi].textContent || '').trim();
      if (/sign in or create account/i.test(bt)) { signInEl = interactive[bi]; break; }
    }
    var hasGreeting = /Hi,\\s*\\S/.test(menuText);

    post('LOGIN_DEBUG', {
      step: 'menu_scan',
      signInFound: !!signInEl,
      signInText: signInEl ? (signInEl.textContent || '').trim().slice(0, 80) : null,
      hasGreeting: hasGreeting
    });

    // ── 4. Decide ────────────────────────────────────────────────────────
    if (!signInEl && hasGreeting) {
      // Logged in — close menu and report.
      document.body.click();
      await wait(200);
      window.__walmartLoginCheckActive = false;
      post('LOGIN_STATUS', { isLoggedIn: true });
      return;
    }

    if (signInEl && !hasGreeting) {
      // Not logged in — click sign-in. Walmart navigates to /account/login,
      // killing this script; onLoadEnd catches the login URL and shows it.
      post('LOGIN_DEBUG', { step: 'clicking_signin' });
      signInEl.click();
      window.__walmartLoginCheckActive = false;
      post('LOGIN_STATUS', { isLoggedIn: false });
      return;
    }

    // Ambiguous (both or neither) — default to not logged in so we surface
    // a login attempt rather than silently failing.
    post('LOGIN_DEBUG', { step: 'ambiguous_default_logged_out', signInFound: !!signInEl, hasGreeting: hasGreeting });
    window.__walmartLoginCheckActive = false;
    post('LOGIN_STATUS', { isLoggedIn: false });
  } catch(e) {
    window.__walmartLoginCheckActive = false;
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) })); } catch (_) {}
  }
})();true;`;

// ── Product extraction ──────────────────────────────────────────────────────

// Pulls up to 8 product candidates from a Walmart search-results page.
// Linear: wait for URL → wait for cards → walk each card → post.
// Heavy step-named logging via type: 'EXTRACT_LOG'.
const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function log(step, extra) {
    var p = { type: 'EXTRACT_LOG', step: step };
    if (extra) for (var k in extra) p[k] = extra[k];
    try { window.ReactNativeWebView.postMessage(JSON.stringify(p)); } catch (_) {}
  }
  function noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', noKbd, true);

  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';
  var ADD_BTN_SEL = '[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]';
  var INC_BTN_SEL = '[data-testid="quantity-stepper-inc-button"]';
  var ITEM_STACK_ATTR = 'item-stack';

  // 1. Wait until the URL carries a ?q= search term.
  function getQ() {
    var m = window.location.href.match(/[?&]q=([^&]+)/);
    return m ? decodeURIComponent(m[1].replace(/\\+/g, ' ')) : null;
  }
  var searchTerm = getQ();
  for (var i = 0; i < 25 && !searchTerm; i++) { await wait(200); searchTerm = getQ(); }
  log('start', { url: window.location.href, searchTerm: searchTerm });

  // 2. A card is a real search result only if it lives inside
  //    data-testid="item-stack". Sponsored ads (sba-container) and
  //    "Explore related items" (carousel-container) match the same product
  //    markup but are NOT real results and must be skipped.
  function isInSearchResults(card) {
    var n = card;
    for (var d = 0; d < 15 && n && n !== document.body; d++) {
      if (n.getAttribute && n.getAttribute('data-testid') === ITEM_STACK_ATTR) return true;
      n = n.parentElement;
    }
    return false;
  }

  // 3. Poll for cards (Walmart's grid hydrates async after document load).
  var cards = [];
  for (var poll = 0; poll < 30; poll++) {
    var all = Array.from(document.querySelectorAll(CARD_SEL));
    cards = all.filter(isInSearchResults).slice(0, 20);
    if (cards.length > 0) {
      log('cards_ready', { pollIdx: poll, totalMatched: all.length, kept: cards.length });
      break;
    }
    await wait(200);
  }
  if (cards.length === 0) {
    log('no_cards', { url: window.location.href });
    document.removeEventListener('focusin', noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  // 4. Helpers operating on a single card.
  function getCartQty(card) {
    // The stepper increment button's aria-label format is:
    //   "Increase quantity <name>, Current Quantity N"
    // No stepper at all → not yet in cart → 0.
    var btn = card.querySelector(INC_BTN_SEL);
    if (!btn) return 0;
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/Current Quantity\\s+(\\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }
  function extractPrice(card) {
    var priceEl = card.querySelector('[data-automation-id*="price" i], [class*="price" i]');
    if (priceEl) { var m = priceEl.textContent.match(/\\$[\\d]+\\.\\d{2}/); if (m) return m[0]; }
    var m2 = card.textContent.match(/\\$[\\d]+\\.\\d{2}/);
    return m2 ? m2[0] : null;
  }
  function hasOptionsBtn(card) {
    var els = Array.from(card.querySelectorAll('a, button'));
    for (var i = 0; i < els.length; i++) {
      var ar = els[i].getAttribute('aria-label') || '';
      var t = els[i].textContent.trim().toLowerCase();
      if (/Options/i.test(ar) || t === 'options') return true;
    }
    return false;
  }
  function extractCandidate(card) {
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name) return null;
    var addBtn = card.querySelector(ADD_BTN_SEL);
    var incBtn = card.querySelector(INC_BTN_SEL);
    var alreadyInCart = !!incBtn;
    var options = !addBtn && !incBtn ? hasOptionsBtn(card) : false;
    // outOfStock: no way to add it directly. (Options items go through PDP,
    // so we surface them separately rather than calling them OOS.)
    var oos = !addBtn && !incBtn && !options;
    var imgEl = card.querySelector('img');
    return {
      productName: name,
      imageUrl: imgEl ? imgEl.src : null,
      outOfStock: oos,
      preferences: null,
      price: extractPrice(card),
      hasOptions: options,
      alreadyInCart: alreadyInCart,
      cartQty: alreadyInCart ? getCartQty(card) : 0
    };
  }

  // 5. Build candidates, dedupe by name, cap at 8.
  var seen = new Set();
  var candidates = [];
  for (var ci = 0; ci < cards.length; ci++) {
    var c = extractCandidate(cards[ci]);
    if (!c || seen.has(c.productName)) continue;
    seen.add(c.productName);
    candidates.push(c);
    log('candidate', {
      idx: candidates.length - 1,
      name: c.productName.slice(0, 80),
      outOfStock: c.outOfStock, hasOptions: c.hasOptions,
      alreadyInCart: c.alreadyInCart, cartQty: c.cartQty, price: c.price
    });
    if (candidates.length >= 8) break;
  }

  log('done', { candidateCount: candidates.length });
  document.removeEventListener('focusin', noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;

// ── Add to cart ─────────────────────────────────────────────────────────────

// Adds a specific named product to the cart QTY times. Used after the user
// has picked a product from the review list. Linear single-click-per-qty
// with verification via the stepper aria-label "Current Quantity N".
function buildAddToCartScript(
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  var escapedName = JSON.stringify(productName);

  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function log(step, extra) {
    var p = { type: 'ADD_LOG', step: step };
    if (extra) for (var k in extra) p[k] = extra[k];
    try { window.ReactNativeWebView.postMessage(JSON.stringify(p)); } catch (_) {}
  }
  function noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', noKbd, true);

  var TARGET_NAME = ${escapedName};
  var QTY = ${qty};
  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';
  var ADD_BTN_SEL = '[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]';
  var INC_BTN_SEL = '[data-testid="quantity-stepper-inc-button"]';

  log('start', { target: TARGET_NAME, qty: QTY, url: window.location.href });

  function isInSearchResults(card) {
    var n = card;
    for (var d = 0; d < 15 && n && n !== document.body; d++) {
      if (n.getAttribute && n.getAttribute('data-testid') === 'item-stack') return true;
      n = n.parentElement;
    }
    return false;
  }

  // Locate the card whose title === TARGET_NAME (within item-stack only).
  var targetCard = null;
  for (var poll = 0; poll < 30 && !targetCard; poll++) {
    var all = Array.from(document.querySelectorAll(CARD_SEL)).filter(isInSearchResults);
    for (var ci = 0; ci < all.length; ci++) {
      var el = all[ci].querySelector(TITLE_SEL);
      if (el && el.textContent.trim() === TARGET_NAME) { targetCard = all[ci]; break; }
    }
    if (!targetCard) await wait(200);
  }
  if (!targetCard) {
    log('card_not_found', { target: TARGET_NAME });
    document.removeEventListener('focusin', noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }
  log('card_found', {});

  // Read the in-cart qty from the stepper's aria-label "Current Quantity N".
  // 0 = no stepper at all (item not yet in cart). NOTE: this is updated
  // optimistically by Walmart's UI before the server confirms — do NOT rely
  // on it alone as the success signal.
  function getQty() {
    var btn = targetCard.querySelector(INC_BTN_SEL);
    if (!btn) return 0;
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/Current Quantity\\s+(\\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }
  // Read the cart-header total dollar amount. The header button's aria-label
  // is "Cart contains N item Total Amount $X.XX" and the dollar amount is
  // server-authoritative — Walmart only updates it after the API commits the
  // add. This is the signal that survives Walmart's optimistic UI revert.
  function getCartTotal() {
    var btn = document.querySelector('button[aria-label*="Cart contains" i]');
    if (!btn) return null;
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/\\$([\\d,]+(?:\\.\\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }
  // Click target = stepper '+' if already in cart, else the "Add to cart" button.
  function getClickTarget() {
    var inc = targetCard.querySelector(INC_BTN_SEL);
    if (inc) return { btn: inc, mode: 'inc' };
    var add = targetCard.querySelector(ADD_BTN_SEL);
    if (add) return { btn: add, mode: 'add' };
    return { btn: null, mode: null };
  }

  // Single click + ~1s verification. Success = cart-header total went up.
  // We still read the stepper qty for diagnostic logs; mismatch between
  // "stepper went up but total didn't" is the smoking gun for an optimistic
  // UI revert (Walmart's per-card UI updated instantly, server rejected).
  async function clickOnce(iter) {
    var t = getClickTarget();
    var preQty = getQty();
    var preTotal = getCartTotal();
    if (!t.btn) { log('no_click_target', { iter: iter, preQty: preQty, preTotal: preTotal }); return false; }
    if (t.btn.disabled || t.btn.getAttribute('aria-disabled') === 'true') {
      log('btn_disabled', { iter: iter, preQty: preQty, preTotal: preTotal });
      return false;
    }
    log('pre_click', { iter: iter, mode: t.mode, preQty: preQty, preTotal: preTotal, btnAria: t.btn.getAttribute('aria-label') });
    t.btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    t.btn.click();
    await wait(1000);
    var postQty = getQty();
    var postTotal = getCartTotal();
    var stepperUp = postQty >= preQty + 1;
    var totalUp = preTotal !== null && postTotal !== null && postTotal > preTotal;
    var ok = totalUp;
    log('post_click', {
      iter: iter, preQty: preQty, postQty: postQty,
      preTotal: preTotal, postTotal: postTotal,
      stepperUp: stepperUp, totalUp: totalUp, success: ok
    });
    return ok;
  }

  var added = 0;
  for (var i = 0; i < QTY; i++) {
    var ok = await clickOnce(i);
    if (ok) added++;
    else break;
  }

  log('done', { added: added, requested: QTY });
  document.removeEventListener('focusin', noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'ADD_RESULT',
    success: added === QTY,
    reason: added === 0 ? 'click_failed' : (added < QTY ? 'partial' : undefined)
  }));
})();true;`;
}

// ── Search navigation ───────────────────────────────────────────────────────

function buildSearchScript(term: string): string {
  var escaped = JSON.stringify(term);
  // SPA search:
  //   1. Snapshot URL + first card title BEFORE submitting (so we can detect
  //      when the page has actually transitioned to the new search).
  //   2. Type into Walmart's search bar and click the submit button.
  //      Submission is client-side: no full document reload, no rate-limited
  //      retries by Walmart's edge.
  //   3. Poll until URL contains ?q=<term> AND the first card title differs
  //      from the snapshot (= fresh search results rendered).
  //   4. Post EXTRACT_NOW so WebViewCartSheet can inject the next queued
  //      script (extract or search+add) against the fresh DOM.
  //   5. If we can't find the input OR URL never updates, fall back to
  //      direct URL navigation. onLoadEnd handles that path normally.
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function log(step, extra) {
    var p = { type: 'SEARCH_LOG', step: step };
    if (extra) for (var k in extra) p[k] = extra[k];
    try { window.ReactNativeWebView.postMessage(JSON.stringify(p)); } catch (_) {}
  }
  function noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', noKbd, true);

  var term = ${escaped};
  var encoded = encodeURIComponent(term);
  var targetUrl = 'https://www.walmart.com/search?q=' + encoded;
  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';
  var ITEM_STACK_ATTR = 'item-stack';

  log('start', { term: term, from: window.location.href, to: targetUrl });

  // Declare nav intent so any stale onLoadEnd for the old URL gets dropped.
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'NAV_INTENT', target: targetUrl, term: term }));
  } catch (_) {}

  // 1. Snapshot pre-submit state. We treat the search as "fresh" when first
  //    card title differs from this snapshot (or appears where there was none).
  function getFirstCardTitle() {
    var all = Array.from(document.querySelectorAll(CARD_SEL));
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var inStack = false;
      for (var d = 0; d < 15 && n && n !== document.body; d++) {
        if (n.getAttribute && n.getAttribute('data-testid') === ITEM_STACK_ATTR) { inStack = true; break; }
        n = n.parentElement;
      }
      if (!inStack) continue;
      var el = all[i].querySelector(TITLE_SEL);
      if (el) return el.textContent.trim();
    }
    return null;
  }
  var preFirstCard = getFirstCardTitle();
  log('pre_submit_state', { preFirstCard: preFirstCard, url: window.location.href });

  // 2. Find search input (up to 6s — Walmart's SPA may still be hydrating).
  var input = null;
  for (var elapsed = 0; elapsed < 6000 && !input; elapsed += 200) {
    input = document.querySelector('[data-automation-id="search-input"], input[type="search"], input[aria-label*="Search"]');
    if (!input) await wait(200);
  }
  if (!input) {
    log('no_input_falling_back_to_url_nav', {});
    document.removeEventListener('focusin', noKbd, true);
    window.location.href = targetUrl;
    return;
  }

  // 3. DIAGNOSTIC: Log all submit-candidate elements on the page so we can
  //    see what Walmart's actual submit element looks like vs what we're
  //    clicking.
  function summarizeEl(el) {
    if (!el) return null;
    return {
      tag: el.tagName,
      type: el.getAttribute('type'),
      aria: el.getAttribute('aria-label'),
      dataAutoId: el.getAttribute('data-automation-id'),
      dataTestId: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      id: el.id || null,
      cls: (el.getAttribute('class') || '').slice(0, 80),
      visible: el.offsetParent !== null
    };
  }
  var submitCandidates = Array.from(document.querySelectorAll(
    '[data-automation-id="search-submit"],' +
    'button[aria-label*="Search" i],' +
    'button[type="submit"],' +
    '[role="button"][aria-label*="Search" i]'
  )).slice(0, 10).map(summarizeEl);
  var inputForm = input.closest('form');
  log('submit_candidates', {
    inputSummary: summarizeEl(input),
    inputFormAction: inputForm ? inputForm.getAttribute('action') : null,
    submitCandidates: submitCandidates
  });

  // 4. Type the term.
  function urlMatches() {
    var m = window.location.href.match(/[?&]q=([^&]+)/);
    if (!m) return false;
    var q = decodeURIComponent(m[1].replace(/\\+/g, ' '));
    return q.toLowerCase() === term.toLowerCase();
  }
  try {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(50);
    setter.call(input, term);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(120);
  } catch (e) {
    log('typing_error_falling_back_to_url_nav', { err: String(e) });
    document.removeEventListener('focusin', noKbd, true);
    window.location.href = targetUrl;
    return;
  }

  // 5. Try submit methods in sequence: each method runs, then we wait up to
  //    ~1s checking if the URL has updated. First method that moves the URL
  //    wins. Total budget: ~4s for the three methods. If none works, hard
  //    fall back to direct URL navigation.
  async function waitForUrl(maxMs) {
    var steps = Math.floor(maxMs / 200);
    for (var p = 0; p < steps; p++) {
      await wait(200);
      var now = window.location.href;
      log('url_poll', { phase: p, url: now, matches: urlMatches() });
      if (urlMatches()) return true;
    }
    return false;
  }

  // Walmart's search bar exposes TWO buttons in the same container:
  //   1. "Clear search field text" — type="reset", clears the input
  //   2. "Search" — actually submits
  // querySelector's contains-match ([aria-label*="Search" i]) catches BOTH
  // because "Clear search field text" contains the word "search". We must
  // pick the real submit and never the reset button.
  function findSearchSubmitBtn() {
    var byId = document.querySelector('[data-automation-id="search-submit"]');
    if (byId) return byId;
    var cands = document.querySelectorAll('button[aria-label*="Search" i]');
    for (var bi = 0; bi < cands.length; bi++) {
      var c = cands[bi];
      if (c.getAttribute('type') === 'reset') continue;
      var lbl = (c.getAttribute('aria-label') || '').toLowerCase();
      if (lbl.indexOf('clear') !== -1) continue;
      if (lbl.indexOf('close') !== -1) continue;
      if (lbl.indexOf('open') !== -1) continue;
      return c;
    }
    return null;
  }

  var submitMethods = [
    {
      name: 'submit_button',
      run: function() {
        var btn = findSearchSubmitBtn();
        if (!btn) return false;
        log('try_submit_method', { name: 'submit_button', btn: summarizeEl(btn) });
        btn.click();
        return true;
      }
    },
    {
      name: 'form_submit',
      run: function() {
        var f = input.closest('form');
        if (!f) return false;
        log('try_submit_method', { name: 'form_submit', action: f.getAttribute('action') });
        f.submit();
        return true;
      }
    },
    {
      name: 'enter_key',
      run: function() {
        log('try_submit_method', { name: 'enter_key' });
        input.focus();
        ['keydown', 'keypress', 'keyup'].forEach(function(type) {
          input.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
          }));
        });
        return true;
      }
    }
  ];

  var urlOk = false;
  var workingMethod = null;
  for (var mi = 0; mi < submitMethods.length && !urlOk; mi++) {
    var ran = submitMethods[mi].run();
    if (!ran) { log('skip_submit_method', { name: submitMethods[mi].name, reason: 'no_target' }); continue; }
    // Quick wait per method (~1s) so all three fit in the 4s budget.
    if (await waitForUrl(1300)) {
      urlOk = true;
      workingMethod = submitMethods[mi].name;
      log('url_matched_via', { method: workingMethod });
    } else {
      log('method_did_not_navigate', { name: submitMethods[mi].name });
    }
  }

  if (!urlOk) {
    log('all_submit_methods_failed_falling_back_to_url_nav', { url: window.location.href });
    document.removeEventListener('focusin', noKbd, true);
    window.location.href = targetUrl;
    return;
  }

  // 6. URL matched — verify cards are fresh before handing off. Up to ~2s.
  var cardsOk = false;
  for (var c = 0; c < 10; c++) {
    await wait(200);
    var currentFirst = getFirstCardTitle();
    if (currentFirst !== null && currentFirst !== preFirstCard) {
      cardsOk = true;
      log('cards_fresh', { pollIdx: c, firstCard: currentFirst.slice(0, 80) });
      break;
    }
  }
  if (!cardsOk) log('cards_never_changed_signal_anyway', { preFirstCard: preFirstCard });

  document.removeEventListener('focusin', noKbd, true);
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_NOW', term: term })); } catch (_) {}
})();true;`;
}

// ── Search and add ──────────────────────────────────────────────────────────

// Searches for a product by name, picks the exact match, and adds it. Used
// when the user has already chosen a product for this ingredient (item.searchTerm).
// Linear single-click-per-qty with verification via the stepper aria-label.
function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
): string {
  var escapedTerm = JSON.stringify(searchTerm);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function log(step, extra) {
    var p = { type: 'SEARCH_ADD_LOG', step: step };
    if (extra) for (var k in extra) p[k] = extra[k];
    try { window.ReactNativeWebView.postMessage(JSON.stringify(p)); } catch (_) {}
  }
  function noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';
  var ADD_BTN_SEL = '[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]';
  var INC_BTN_SEL = '[data-testid="quantity-stepper-inc-button"]';

  function getQ() {
    var m = window.location.href.match(/[?&]q=([^&]+)/);
    return m ? decodeURIComponent(m[1].replace(/\\+/g, ' ')) : null;
  }

  // 1. Wait for the URL to carry our search term.
  var urlTerm = getQ();
  for (var i = 0; i < 25 && !urlTerm; i++) { await wait(200); urlTerm = getQ(); }
  log('start', { searchTerm: SEARCH_TERM, urlTerm: urlTerm, url: window.location.href });

  function isInSearchResults(card) {
    var n = card;
    for (var d = 0; d < 15 && n && n !== document.body; d++) {
      if (n.getAttribute && n.getAttribute('data-testid') === 'item-stack') return true;
      n = n.parentElement;
    }
    return false;
  }

  // 2. Poll for cards inside item-stack.
  var cards = [];
  for (var poll = 0; poll < 30; poll++) {
    var all = Array.from(document.querySelectorAll(CARD_SEL));
    cards = all.filter(isInSearchResults).slice(0, 20);
    if (cards.length > 0) { log('cards_ready', { pollIdx: poll, totalMatched: all.length, kept: cards.length }); break; }
    await wait(200);
  }
  if (cards.length === 0) {
    log('no_cards', {});
    document.removeEventListener('focusin', noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: [] }));
    return;
  }

  // 3. Score matcher. 100 = exact tokens; 0 if a CRITICAL token is missing.
  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground']);
  // Normalize for comparison. Two forms to handle Walmart's inconsistent ñ
  // rendering — sometimes "Jalapeño", sometimes "Jalapeo" (ñ dropped) on the
  // same product card depending on search context:
  //   1. NFD-strip-diacritics: "Jalapeño" → "Jalapeno". Handles Café→Cafe etc.
  //   2. Drop non-ASCII entirely: "Jalapeño" → "Jalapeo". Matches Walmart's
  //      mangled rendering of the same product.
  // We score both ways and take the higher score.
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
  function hasOptionsBtn(card) {
    var els = Array.from(card.querySelectorAll('a, button'));
    for (var i = 0; i < els.length; i++) {
      var ar = els[i].getAttribute('aria-label') || '';
      var t = els[i].textContent.trim().toLowerCase();
      if (/Options/i.test(ar) || t === 'options') return true;
    }
    return false;
  }

  // 4. Walk candidates, dedupe by name. Pick best as score=100 + addable.
  var candidates = [];
  var seen = new Set();
  var bestCard = null, bestName = null;

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector(ADD_BTN_SEL);
    var incBtn = card.querySelector(INC_BTN_SEL);
    var alreadyInCart = !!incBtn;
    var hasOptions = (!addBtn && !incBtn) ? hasOptionsBtn(card) : false;
    var oos = !addBtn && !incBtn && !hasOptions;

    var imgEl = card.querySelector('img');
    candidates.push({
      productName: name,
      imageUrl: imgEl ? imgEl.src : null,
      outOfStock: oos,
      preferences: null,
      price: null,
      hasOptions: hasOptions
    });

    if (!bestCard && scoreMatch(SEARCH_TERM, name) === 100 && !oos && !hasOptions) {
      bestCard = card;
      bestName = name;
      log('best_picked', { name: name.slice(0, 80), alreadyInCart: alreadyInCart });
    }
    if (candidates.length >= 8) break;
  }

  if (!bestCard) {
    var hasExactOos = candidates.some(function(c) { return scoreMatch(SEARCH_TERM, c.productName) === 100 && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    log('no_best', { reason: reason, candidateCount: candidates.length });
    document.removeEventListener('focusin', noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  // 5. Click + verify. Re-query inc/add buttons fresh each iteration since
  //    Walmart re-renders the card between clicks (Add to cart → stepper).
  //    Success signal = cart-HEADER total went up (server-authoritative).
  //    The per-card stepper is OPTIMISTIC: Walmart updates it instantly on
  //    click then reverts later if the server-side add fails, which fooled
  //    earlier verification into reporting silent failures as success.
  function getQty() {
    var btn = bestCard.querySelector(INC_BTN_SEL);
    if (!btn) return 0;
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/Current Quantity\\s+(\\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }
  function getCartTotal() {
    var btn = document.querySelector('button[aria-label*="Cart contains" i]');
    if (!btn) return null;
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/\\$([\\d,]+(?:\\.\\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }
  function getTarget() {
    var inc = bestCard.querySelector(INC_BTN_SEL);
    if (inc) return { btn: inc, mode: 'inc' };
    var add = bestCard.querySelector(ADD_BTN_SEL);
    if (add) return { btn: add, mode: 'add' };
    return { btn: null, mode: null };
  }

  async function clickOnce(iter) {
    var t = getTarget();
    var preQty = getQty();
    var preTotal = getCartTotal();
    if (!t.btn) { log('no_target', { iter: iter, preQty: preQty, preTotal: preTotal }); return false; }
    if (t.btn.disabled || t.btn.getAttribute('aria-disabled') === 'true') {
      log('btn_disabled', { iter: iter, preQty: preQty, preTotal: preTotal });
      return false;
    }
    log('pre_click', { iter: iter, mode: t.mode, preQty: preQty, preTotal: preTotal, btnAria: t.btn.getAttribute('aria-label') });
    t.btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    t.btn.click();
    await wait(1000);
    var postQty = getQty();
    var postTotal = getCartTotal();
    var stepperUp = postQty >= preQty + 1;
    var totalUp = preTotal !== null && postTotal !== null && postTotal > preTotal;
    var ok = totalUp;
    log('post_click', {
      iter: iter, preQty: preQty, postQty: postQty,
      preTotal: preTotal, postTotal: postTotal,
      stepperUp: stepperUp, totalUp: totalUp, success: ok
    });
    return ok;
  }

  var added = 0;
  for (var k = 0; k < QTY; k++) {
    var ok = await clickOnce(k);
    if (ok) added++;
    else break;
  }

  log('done', { added: added, requested: QTY, bestName: bestName });
  document.removeEventListener('focusin', noKbd, true);
  if (added > 0) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'SEARCH_AND_ADD_RESULT',
      success: added === QTY,
      productName: bestName,
      reason: added < QTY ? 'partial' : undefined
    }));
  } else {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'SEARCH_AND_ADD_RESULT',
      success: false,
      reason: 'click_failed',
      productName: bestName,
      candidates: candidates
    }));
  }
})();true;`;
}

// ── Export ───────────────────────────────────────────────────────────────────

export function getScripts(): StoreScripts {
  return {
    storeUrl: WALMART_URL,
    loginUrl: WALMART_LOGIN_URL,
    cartUrl: WALMART_CART_URL,
    domain: WALMART_DOMAIN,
    isSearchUrl: (url: string) => url.includes('walmart.com/search'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('walmart.com') && !url.includes('/account/login') && !url.includes('/sign-in'),
    checkLoginScript: CHECK_LOGIN_SCRIPT,
    extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
    buildAddToCartScript,
    buildSearchScript,
    buildSearchAndAddScript,
  };
}
