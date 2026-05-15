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

const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__walmartLoginCheckActive) return;
  window.__walmartLoginCheckActive = true;
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // Scan for positive login indicators (text or html elements).
    await wait(1500);
    var headerButtons = Array.from(document.querySelectorAll('header button, header a, nav button, nav a, [class*="header" i] button, [class*="header" i] a'));
    var btnDebug = headerButtons.slice(0, 20).map(function(b) {
      return { tag: b.tagName, aria: b.getAttribute('aria-label'), href: b.getAttribute('href'), text: b.textContent.trim().slice(0, 40), id: b.id || null };
    });

    // Look for positive logged-in indicators: "Hi, [Name]", "My account", "Reorder", etc.
    var isLoggedIn = false;
    var headerText = (document.querySelector('header') || document.body).innerText.slice(0, 2000).toLowerCase();
    var hasHiName = /hi,\s*\w/.test(headerText);
    var hasAccount = headerText.includes('my account') || headerText.includes('my items') || headerText.includes('reorder');
    if (hasHiName || hasAccount) isLoggedIn = true;

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'mobile_scan',
      headerButtons: btnDebug,
      hasHiName: hasHiName, hasAccount: hasAccount, isLoggedIn: isLoggedIn,
      headerTextSample: headerText.slice(0, 300)
    }));

    window.__walmartLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  } catch(e) {
    window.__walmartLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ──────────────────────────────────────────────────────

const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';

  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 8 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 50) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var priceEl = card.querySelector('[data-automation-id*="price" i], [class*="price" i]');
    if (priceEl) { var m = priceEl.textContent.match(/\\$[\\d]+\\.\\d{2}/); if (m) return m[0]; }
    var m2 = card.textContent.match(/\\$[\\d]+\\.\\d{2}/);
    return m2 ? m2[0] : null;
  }

  var cards = [];
  for (var poll = 0; poll < 20; poll++) {
    cards = Array.from(document.querySelectorAll(CARD_SEL)).slice(0, 20);
    if (cards.length > 0) break;
    await wait(300);
  }

  // Debug logging: report what we found on the page
  var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'EXTRACT_DEBUG',
    btnsFound: btns.length,
    firstBtns: btns.slice(0, 15).map(function(b) {
      return { tag: b.tagName, aria: b.getAttribute('aria-label'), text: b.textContent.trim().slice(0, 40) };
    }),
    cardsFound: cards.length,
    url: window.location.href,
    bodyTextSample: document.body.innerText.slice(0, 300)
  }));

  if (cards.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
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

    var addBtn = card.querySelector('[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]');
    var btnText = addBtn ? addBtn.textContent.trim() : '';
    var outOfStock = !addBtn || addBtn.disabled
      || addBtn.getAttribute('aria-disabled') === 'true'
      || /out of stock|notify me|unavailable/i.test(btnText);

    // Check for "Options" button — product needs PDP navigation
    var hasOptions = false;
    if (!addBtn) {
      var allInteractives = Array.from(card.querySelectorAll('a, button'));
      var optionsEl = allInteractives.find(function(el) {
        var ariaLabel = el.getAttribute('aria-label') || '';
        var text = el.textContent.trim().toLowerCase();
        return ariaLabel.includes('Options') || text === 'options';
      });
      if (optionsEl) hasOptions = true;
    }

    // Image: try card first, then walk up from button to find a broader container
    var imgEl = card.querySelector('img');
    if (!imgEl && addBtn) {
      var broader = findCard(addBtn);
      if (broader) imgEl = broader.querySelector('img');
    }
    var imageUrl = imgEl ? imgEl.src : null;

    // Price: try structured selectors, fall back to regex on card text
    var price = extractPrice(card);

    candidates.push({
      productName: name,
      imageUrl: imageUrl,
      outOfStock: outOfStock,
      preferences: null,
      price: price,
      hasOptions: hasOptions
    });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;

// ── Add to cart ─────────────────────────────────────────────────────────────

function buildAddToCartScript(
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  var escapedName = JSON.stringify(productName);

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
  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';

  var targetCard = null;
  for (var poll = 0; poll < 20; poll++) {
    var cards = Array.from(document.querySelectorAll(CARD_SEL));
    for (var ci = 0; ci < cards.length; ci++) {
      var el = cards[ci].querySelector(TITLE_SEL);
      if (el && el.textContent.trim() === TARGET_NAME) {
        targetCard = cards[ci];
        break;
      }
    }
    if (targetCard) break;
    await wait(300);
  }

  if (!targetCard) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  var addBtn = targetCard.querySelector('[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]');

  if (!addBtn) {
    // Check for incrementer (product already in cart)
    var incrementerButton = targetCard.querySelector('button i[data-testid="quantity-stepper-inc-icon"]');
    if (incrementerButton) addBtn = incrementerButton.closest('button');

    if (!addBtn) {
      // Try expanding quantity button
      var quantityButton = targetCard.querySelector('button[data-testid="quantity-in-cart"]');
      if (quantityButton) {
        quantityButton.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        quantityButton.click();
        await wait(300);
        var incEl = targetCard.querySelector('button i[data-testid="quantity-stepper-inc-icon"]');
        if (incEl) addBtn = incEl.closest('button');
      }
    }
  }

  if (!addBtn) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'no_button' }));
    return;
  }

  var btnText = addBtn.textContent.trim();
  if (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true'
      || /out of stock|notify me|unavailable/i.test(btnText)) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'out_of_stock' }));
    return;
  }

  var actuallyClicked = 0;

  for (var i = 0; i < QTY; i++) {
    var buttonToClick = addBtn;

    if (i > 0) {
      // After first click, wait for incrementer to appear
      var incrementButton = null;
      for (var attempt = 0; attempt < 15; attempt++) {
        var incIcon = targetCard.querySelector('button i[data-testid="quantity-stepper-inc-icon"]');
        if (incIcon) {
          incrementButton = incIcon.closest('button');
          break;
        }
        // Also check page-level (drawer may appear)
        var pageIncIcon = document.querySelector('button i[data-testid="quantity-stepper-inc-icon"]');
        if (pageIncIcon) {
          incrementButton = pageIncIcon.closest('button');
          break;
        }
        await wait(100);
      }

      if (!incrementButton) break;
      buttonToClick = incrementButton;
    }

    if (buttonToClick.disabled || buttonToClick.getAttribute('aria-disabled') === 'true') break;
    buttonToClick.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    buttonToClick.click();
    actuallyClicked++;
    await wait(300);
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'ADD_RESULT',
    success: actuallyClicked === QTY,
    reason: actuallyClicked === 0 ? 'click_failed' : undefined
  }));
})();true;`;
}

// ── Search navigation ───────────────────────────────────────────────────────

function buildSearchScript(term: string): string {
  var escaped = JSON.stringify(term);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  // Poll for the search input — the SPA may still be hydrating
  var input = null;
  for (var elapsed = 0; elapsed < 10000; elapsed += 200) {
    input = document.querySelector('[data-automation-id="search-input"], input[type="search"], input[aria-label*="Search"]');
    if (input) break;
    await wait(200);
  }

  if (!input) {
    document.removeEventListener('focusin', __noKbd, true);
    return;
  }

  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
  setter.call(input, term);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);

  var startUrl = window.location.href;

  var searchBtn = document.querySelector('[data-automation-id="search-submit"], button[aria-label*="Search"]');
  if (searchBtn) {
    searchBtn.click();
  } else {
    var form = input.closest('form');
    if (form) {
      form.submit();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // Wait for URL change (up to 4 seconds)
  for (var i = 0; i < 40; i++) {
    if (window.location.href !== startUrl) break;
    await wait(100);
  }

  document.removeEventListener('focusin', __noKbd, true);
})();true;`;
}

// ── Search and add ──────────────────────────────────────────────────────────

function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
): string {
  var escapedTerm = JSON.stringify(searchTerm);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  var CARD_SEL = '${CARD_SEL}';
  var TITLE_SEL = '${TITLE_SEL}';

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

  var cards = [];
  for (var poll = 0; poll < 20; poll++) {
    cards = Array.from(document.querySelectorAll(CARD_SEL)).slice(0, 20);
    if (cards.length > 0) break;
    await wait(300);
  }
  var candidates = [];
  var seen = new Set();
  var bestCard = null, bestBtn = null, bestName = null;

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var nameEl = card.querySelector(TITLE_SEL);
    var name = nameEl ? nameEl.textContent.trim() : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector('[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]');
    var btnText = addBtn ? addBtn.textContent.trim() : '';
    var oos = !addBtn || addBtn.disabled
      || addBtn.getAttribute('aria-disabled') === 'true'
      || /out of stock|notify me|unavailable/i.test(btnText);

    // Check for Options button (needs PDP, skip for auto-add)
    var hasOptions = false;
    if (!addBtn) {
      var allInteractives = Array.from(card.querySelectorAll('a, button'));
      var optionsEl = allInteractives.find(function(el) {
        var ariaLabel = el.getAttribute('aria-label') || '';
        var text = el.textContent.trim().toLowerCase();
        return ariaLabel.includes('Options') || text === 'options';
      });
      if (optionsEl) hasOptions = true;
    }

    var imgEl = card.querySelector('img');
    candidates.push({
      productName: name,
      imageUrl: imgEl ? imgEl.src : null,
      outOfStock: oos,
      preferences: null,
      price: null,
      hasOptions: hasOptions
    });

    // Only auto-add products with a direct ATC button (skip Options products)
    if (!bestName && scoreMatch(SEARCH_TERM, name) === 100 && !oos && !hasOptions) {
      bestCard = card; bestBtn = addBtn; bestName = name;
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

  try {
    bestBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(100);
    bestBtn.click();

    // No preference modal for Walmart — standard add flow.
    await wait(600);

    // For qty > 1: after first click, wait for incrementer to appear then click it.
    for (var j = 1; j < QTY; j++) {
      var incrementButton = null;
      for (var attempt = 0; attempt < 15; attempt++) {
        var incIcon = bestCard.querySelector('button i[data-testid="quantity-stepper-inc-icon"]');
        if (incIcon) {
          incrementButton = incIcon.closest('button');
          break;
        }
        var pageIncIcon = document.querySelector('button i[data-testid="quantity-stepper-inc-icon"]');
        if (pageIncIcon) {
          incrementButton = pageIncIcon.closest('button');
          break;
        }
        await wait(100);
      }
      if (!incrementButton) break;
      if (incrementButton.disabled || incrementButton.getAttribute('aria-disabled') === 'true') break;
      incrementButton.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      incrementButton.click();
      if (j < QTY - 1) await wait(300);
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates }));
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
