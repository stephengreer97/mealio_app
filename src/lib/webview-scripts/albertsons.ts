// Injectable JavaScript strings for Albertsons-family WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// This single file covers ALL Albertsons-platform stores. They share identical
// selectors and behavior — only the domain/URLs differ.
//
// Ported from ~/mealio_ext/content-albertsons-family.js — same verified selectors,
// adapted to the StoreScripts interface used by the store registry.
//
// VERIFIED SELECTORS (confirmed on Albertsons platform 2026-02):
//   Login detection:    span[data-qa="hdr-accnt-nm"]  (text = name OR "Sign in")
//   Search input:       input[type="search"][name="q"]
//   Search open button: button[aria-label="search"]
//   Add to cart button: button[aria-label^="Add 1 unit of"]
//   Collapsed bubble:   button[data-qa="qty-stppr-bbl"]
//   Increment button:   button[data-qa="prdctincrmntr"]
//   Cart URL fallback:  /shop/cart.html

import type { StoreScripts } from './index';

// ── Domain map ──────────────────────────────────────────────────────────────

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
  united:       'unitedsupermarkets.com',
};

export const ALBERTSONS_FAMILY_IDS: string[] = Object.keys(DOMAIN_MAP);

// ── Login check ─────────────────────────────────────────────────────────────

function buildCheckLoginScript(domain: string): string {
  return `(async function() {
  if (window.__albLoginCheckActive) return;
  window.__albLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // Poll for the profile button (up to 3s, usually < 1s).
    var profileBtn = null;
    for (var pi = 0; pi < 15; pi++) {
      var candidates = document.querySelectorAll('button[aria-label*="account" i], button[aria-label*="profile" i], a[aria-label*="account" i]');
      for (var ci = 0; ci < candidates.length; ci++) {
        var aria = (candidates[ci].getAttribute('aria-label') || '').toLowerCase();
        if (!aria.includes('close')) { profileBtn = candidates[ci]; break; }
      }
      if (profileBtn) break;
      await wait(200);
    }
    if (!profileBtn) {
      var headerEls = Array.from(document.querySelectorAll('header button, header a, nav button, nav a, [role="banner"] button, [role="banner"] a'));
      for (var hi = 0; hi < headerEls.length; hi++) {
        var el = headerEls[hi];
        var aria = (el.getAttribute('aria-label') || '').toLowerCase();
        var txt = (el.textContent || '').trim().toLowerCase();
        if (aria.includes('close')) continue;
        if (aria.includes('account') || aria.includes('profile') || txt === 'sign in' || txt === 'account') {
          profileBtn = el;
          break;
        }
      }
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'profile_btn',
      found: !!profileBtn,
      ariaLabel: profileBtn ? profileBtn.getAttribute('aria-label') : null,
      text: profileBtn ? profileBtn.textContent.trim().slice(0, 40) : null
    }));

    if (!profileBtn) {
      window.__albLoginCheckActive = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));
      return;
    }

    // Click the profile icon. Two outcomes:
    // Logged in: side panel opens with "Sign Out" option
    // Not logged in: sign-in form/page appears
    profileBtn.click();
    await wait(1500);

    // Check if body text contains "sign out" — only appears in the logged-in panel.
    var bodyText = document.body.innerText.slice(0, 8000).toLowerCase();
    var isLoggedIn = bodyText.includes('sign out') || bodyText.includes('log out');

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'after_click',
      isLoggedIn: isLoggedIn
    }));

    if (isLoggedIn) {
      // Close the side panel and proceed.
      document.body.click();
      await wait(300);
      window.__albLoginCheckActive = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }));
      return;
    }

    // Not logged in — post status so the webview becomes visible,
    // then poll in the background for login completion.
    window.__albLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));

    // Background poll: check every 2s for up to 3 minutes.
    // When user completes login, the page updates and "sign out" appears.
    for (var pi = 0; pi < 90; pi++) {
      await wait(2000);
      var pollText = document.body.innerText.slice(0, 8000).toLowerCase();
      if (pollText.includes('sign out') || pollText.includes('log out')) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_COMPLETE' }));
        return;
      }
    }
  } catch(e) {
    window.__albLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;
}

// ── Product extraction ──────────────────────────────────────────────────────

function buildExtractProductsScript(): string {
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var ATC_SEL = 'button[aria-label^="Add 1 unit of"]';

  // Poll for ATC buttons to appear (up to 6s).
  var btns = [];
  for (var poll = 0; poll < 20; poll++) {
    btns = Array.from(document.querySelectorAll(ATC_SEL));
    if (btns.length > 0) break;
    await wait(300);
  }

  if (btns.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  // Helper: walk up from an element to find the product card container.
  // Albertsons wraps each product in a parent that contains the image, price, and ATC button.
  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 8 && node; depth++) {
      // A card should have an img and some text content beyond just the button.
      if (node.querySelector('img') && node.textContent.length > 50) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Helper: extract price from a card element.
  function extractPrice(card) {
    if (!card) return null;
    // Try specific selectors first.
    var priceEl = card.querySelector('[class*="price" i], [data-qa*="price" i]');
    if (priceEl) {
      var m = priceEl.textContent.match(/\\$[\\d]+\\.\\d{2}/);
      if (m) return m[0];
    }
    // Fallback: find first $X.XX pattern in the card's text.
    var cardText = card.textContent || '';
    var m2 = cardText.match(/\\$[\\d]+\\.\\d{2}/);
    return m2 ? m2[0] : null;
  }

  var seen = new Set();
  var candidates = [];

  for (var bi = 0; bi < btns.length && bi < 20; bi++) {
    var btn = btns[bi];
    var ariaLabel = btn.getAttribute('aria-label') || '';
    var nameMatch = ariaLabel.match(/^Add 1 unit of (.+)/i);
    if (!nameMatch) continue;
    var name = nameMatch[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var outOfStock = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    var card = findCard(btn);
    var imageUrl = null;
    var price = null;

    if (card) {
      var imgEl = card.querySelector('img');
      imageUrl = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || null) : null;
      price = extractPrice(card);
    }

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: null, price: price });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;
}

// ── Add to cart ──────────────────────────────────────────────────────────────

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
  var ATC_SEL = 'button[aria-label^="Add 1 unit of"]';
  var BUBBLE_SEL = 'button[data-qa="qty-stppr-bbl"]';
  var INCREMENT_SEL = 'button[data-qa="prdctincrmntr"]';

  function normalizeForScoring(s) {
    return s.toLowerCase().replace(/[^\\w\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
  }

  function scoreProductName(foundName, targetName) {
    var found = normalizeForScoring(foundName);
    var target = normalizeForScoring(targetName);
    if (found === target) return 100;
    var targetWords = target.split(' ').filter(Boolean);
    var foundWords = found.split(' ').filter(Boolean);
    var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
    var matchPct = matchCount / targetWords.length;
    if (matchPct < 0.7) return -1;
    var extraCount = foundWords.filter(function(w) { return targetWords.indexOf(w) === -1; }).length;
    return Math.round(matchPct * 100) - (extraCount * 10);
  }

  // Find the collapsed bubble button for a product already in cart.
  function findBubbleForProduct(productName) {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allBubbles.length; i++) {
      var btn = allBubbles[i];
      var al = btn.getAttribute('aria-label') || '';
      var extracted = null;
      var m1 = al.match(/collapsed[,:]?\\s*\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)\\s+in\\s+cart/i);
      if (m1) { extracted = m1[1]; }
      else {
        var m2 = al.match(/\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)(?:\\s+in\\s+cart|\\s*\\.|$)/i);
        if (m2) extracted = m2[1];
      }
      if (!extracted) continue;
      var cleaned = extracted
        .replace(/,?\\s*\\$[\\d.,]+\\s*(per\\s+\\w+|each|\\/\\s*\\w+)\\b.*/i, '')
        .replace(/,?\\s*\\d+\\s+for\\s+\\$[\\d.,]+.*/i, '')
        .trim();
      var score = -1;
      if (/\\.{3}|\\u2026/.test(cleaned)) {
        var parts = cleaned.split(/\\.{3}|\\u2026/).map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 3; });
        var targetLower = productName.toLowerCase();
        var allPartsMatch = parts.length > 0 && parts.every(function(p) { return targetLower.indexOf(p.toLowerCase()) !== -1; });
        score = allPartsMatch ? 95 : -1;
      } else {
        var targetWords = normalizeForScoring(productName).split(' ').filter(Boolean);
        var foundWords = normalizeForScoring(cleaned).split(' ').filter(Boolean);
        var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
        var matchPct = matchCount / targetWords.length;
        score = matchPct < 0.7 ? -1 : Math.round(matchPct * 100);
      }
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    return best;
  }

  // Find the expanded increment button for a product.
  function findIncrementForProduct(productName) {
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allInc.length; i++) {
      var btn = allInc[i];
      var al = btn.getAttribute('aria-label') || '';
      var m = al.match(/^Increase Quantity \\d+ unit[^\\s]* of (.+)/i);
      if (!m) continue;
      var score = scoreProductName(m[1], productName);
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    if (!best && allInc.length === 1) return allInc[0];
    return best;
  }

  // Poll for the increment button with re-expand support.
  function pollForIncrement(productName) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      var POLL_MS = 150;
      var MAX_MS = 5000;
      function tick() {
        if (elapsed >= MAX_MS) { resolve(null); return; }
        var incBtn = findIncrementForProduct(productName);
        if (incBtn) { resolve(incBtn); return; }
        var bubble = findBubbleForProduct(productName);
        if (bubble) {
          bubble.scrollIntoView({ behavior: 'instant', block: 'center' });
          bubble.click();
        }
        elapsed += POLL_MS;
        setTimeout(tick, POLL_MS);
      }
      tick();
    });
  }

  // Read current cart qty from bubble/increment aria-labels.
  function getCartQty() {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    for (var i = 0; i < allBubbles.length; i++) {
      var al = allBubbles[i].getAttribute('aria-label') || '';
      var qm = al.match(/(\\d+)\\s*unit/i);
      if (qm) return parseInt(qm[1], 10);
    }
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    for (var i = 0; i < allInc.length; i++) {
      var al = allInc[i].getAttribute('aria-label') || '';
      var qm = al.match(/Quantity\\s+(\\d+)/i);
      if (qm) return parseInt(qm[1], 10);
    }
    return 0;
  }

  // Poll until cart qty increases (up to 5s).
  function waitForQtyChange(prevQty) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        if (elapsed >= 5000) { resolve(false); return; }
        var current = getCartQty();
        if (current > prevQty) { resolve(true); return; }
        elapsed += 200;
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  // Poll for ATC buttons to appear (up to 6s).
  var allAtcBtns = [];
  for (var poll = 0; poll < 20; poll++) {
    allAtcBtns = Array.from(document.querySelectorAll(ATC_SEL));
    if (allAtcBtns.length > 0) break;
    await wait(300);
  }
  var bestAtcBtn = null, bestAtcScore = -1;
  for (var i = 0; i < allAtcBtns.length; i++) {
    var btn = allAtcBtns[i];
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/^Add 1 unit of (.+)/i);
    if (!m) continue;
    var score = scoreProductName(m[1], TARGET_NAME);
    if (score > bestAtcScore && score >= 100) { bestAtcScore = score; bestAtcBtn = btn; }
    if (bestAtcScore === 100) break;
  }

  // Check for pre-existing qty (product already in cart)
  var preExistingBubble = findBubbleForProduct(TARGET_NAME);
  var preExistingIncrement = !preExistingBubble ? findIncrementForProduct(TARGET_NAME) : null;

  // Poll if nothing found yet
  if (!preExistingBubble && !preExistingIncrement && !bestAtcBtn) {
    for (var attempt = 0; attempt < 8 && !preExistingBubble && !preExistingIncrement && !bestAtcBtn; attempt++) {
      await wait(500);
      var freshBtns = Array.from(document.querySelectorAll(ATC_SEL));
      for (var fi = 0; fi < freshBtns.length; fi++) {
        var fal = freshBtns[fi].getAttribute('aria-label') || '';
        var fm = fal.match(/^Add 1 unit of (.+)/i);
        if (!fm) continue;
        var fs = scoreProductName(fm[1], TARGET_NAME);
        if (fs > bestAtcScore && fs >= 100) { bestAtcScore = fs; bestAtcBtn = freshBtns[fi]; }
        if (bestAtcScore === 100) break;
      }
      preExistingBubble = findBubbleForProduct(TARGET_NAME);
      preExistingIncrement = !preExistingBubble ? findIncrementForProduct(TARGET_NAME) : null;
    }
  }

  // If ATC found but no bubble yet, wait for cart state overlay
  if (bestAtcBtn && !preExistingBubble && !preExistingIncrement) {
    for (var wa = 0; wa < 3 && !preExistingBubble && !preExistingIncrement; wa++) {
      await wait(400);
      preExistingBubble = findBubbleForProduct(TARGET_NAME);
      preExistingIncrement = !preExistingBubble ? findIncrementForProduct(TARGET_NAME) : null;
    }
  }

  var usePreExisting = !!(preExistingBubble || preExistingIncrement);
  var stepperAlreadyOpen = !!preExistingIncrement && !preExistingBubble;

  if (!usePreExisting && !bestAtcBtn) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  var actuallyClicked = 0;

  if (usePreExisting) {
    if (stepperAlreadyOpen) {
      for (var i = 0; i < QTY; i++) {
        var qtyBefore = getCartQty();
        var incBtn = i === 0 ? preExistingIncrement : await pollForIncrement(TARGET_NAME);
        if (!incBtn) break;
        incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        incBtn.click();
        var confirmed = await waitForQtyChange(qtyBefore);
        if (confirmed) actuallyClicked++;
      }
    } else {
      preExistingBubble.scrollIntoView({ behavior: 'instant', block: 'center' });
      preExistingBubble.click();
      await wait(600);
      for (var i = 0; i < QTY; i++) {
        var qtyBefore = getCartQty();
        var incBtn = await pollForIncrement(TARGET_NAME);
        if (!incBtn) break;
        incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        incBtn.click();
        var confirmed = await waitForQtyChange(qtyBefore);
        if (confirmed) actuallyClicked++;
      }
    }
  } else {
    // Normal path: ATC adds first unit, increment handles the rest.
    for (var i = 0; i < QTY; i++) {
      var qtyBefore = getCartQty();
      var buttonToClick;
      if (i === 0) {
        buttonToClick = bestAtcBtn;
      } else {
        buttonToClick = await pollForIncrement(TARGET_NAME);
        if (!buttonToClick) {
          var freshAtc = Array.from(document.querySelectorAll(ATC_SEL));
          for (var fa = 0; fa < freshAtc.length; fa++) {
            var faLabel = freshAtc[fa].getAttribute('aria-label') || '';
            var faMatch = faLabel.match(/^Add 1 unit of (.+)/i);
            if (faMatch && faMatch[1].trim() === TARGET_NAME) { buttonToClick = freshAtc[fa]; break; }
          }
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ADD_DEBUG', step: 'increment_' + i,
          foundIncrement: !!buttonToClick, qtyBefore: qtyBefore
        }));
        if (!buttonToClick) break;
      }
      if (buttonToClick.disabled || buttonToClick.getAttribute('aria-disabled') === 'true') break;
      buttonToClick.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      buttonToClick.click();
      var confirmed = await waitForQtyChange(qtyBefore);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'ADD_DEBUG', step: 'click_confirmed_' + i,
        confirmed: confirmed, qtyBefore: qtyBefore, qtyAfter: getCartQty()
      }));
      if (confirmed) actuallyClicked++;
    }
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'ADD_RESULT',
    success: actuallyClicked >= 1,
    reason: actuallyClicked === 0 ? 'not_found' : undefined
  }));
})();true;`;
}

// ── Search navigation ───────────────────────────────────────────────────────

function buildSearchScript(domain: string) {
  return function (term: string): string {
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

  // Click the search icon button to reveal/focus the input
  var openBtn = document.querySelector('button[aria-label="search"]');
  if (openBtn) { openBtn.click(); await wait(300); }

  // Find search input
  var input = document.querySelector('input[type="search"][name="q"]');
  if (!input) {
    input = document.querySelector('input[type="search"], input[name="q"], input[placeholder*="search" i]');
  }

  if (!input) {
    document.removeEventListener('focusin', __noKbd, true);
    return;
  }

  // Set value via native setter to avoid triggering the mobile keyboard
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
  setter.call(input, term);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(100);

  // Submit via Enter key
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true
  }));
  input.dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true
  }));

  // Wait for URL change (up to 3 seconds)
  var startUrl = window.location.href;
  for (var i = 0; i < 30; i++) {
    if (window.location.href !== startUrl) break;
    await wait(100);
  }

  document.removeEventListener('focusin', __noKbd, true);
})();true;`;
  };
}

// ── Search and add ──────────────────────────────────────────────────────────

function buildSearchAndAddScriptFn(
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
  var ATC_SEL = 'button[aria-label^="Add 1 unit of"]';
  var BUBBLE_SEL = 'button[data-qa="qty-stppr-bbl"]';
  var INCREMENT_SEL = 'button[data-qa="prdctincrmntr"]';

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

  function normalizeForScoring(s) {
    return s.toLowerCase().replace(/[^\\w\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
  }

  function scoreProductName(foundName, targetName) {
    var found = normalizeForScoring(foundName);
    var target = normalizeForScoring(targetName);
    if (found === target) return 100;
    var targetWords = target.split(' ').filter(Boolean);
    var foundWords = found.split(' ').filter(Boolean);
    var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
    var matchPct = matchCount / targetWords.length;
    if (matchPct < 0.7) return -1;
    var extraCount = foundWords.filter(function(w) { return targetWords.indexOf(w) === -1; }).length;
    return Math.round(matchPct * 100) - (extraCount * 10);
  }

  function findBubbleForProduct(productName) {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allBubbles.length; i++) {
      var btn = allBubbles[i];
      var al = btn.getAttribute('aria-label') || '';
      var extracted = null;
      var m1 = al.match(/collapsed[,:]?\\s*\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)\\s+in\\s+cart/i);
      if (m1) { extracted = m1[1]; }
      else {
        var m2 = al.match(/\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)(?:\\s+in\\s+cart|\\s*\\.|$)/i);
        if (m2) extracted = m2[1];
      }
      if (!extracted) continue;
      var cleaned = extracted
        .replace(/,?\\s*\\$[\\d.,]+\\s*(per\\s+\\w+|each|\\/\\s*\\w+)\\b.*/i, '')
        .replace(/,?\\s*\\d+\\s+for\\s+\\$[\\d.,]+.*/i, '')
        .trim();
      var score = -1;
      if (/\\.{3}|\\u2026/.test(cleaned)) {
        var parts = cleaned.split(/\\.{3}|\\u2026/).map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 3; });
        var targetLower = productName.toLowerCase();
        var allPartsMatch = parts.length > 0 && parts.every(function(p) { return targetLower.indexOf(p.toLowerCase()) !== -1; });
        score = allPartsMatch ? 95 : -1;
      } else {
        var targetWords = normalizeForScoring(productName).split(' ').filter(Boolean);
        var foundWords = normalizeForScoring(cleaned).split(' ').filter(Boolean);
        var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
        var matchPct = matchCount / targetWords.length;
        score = matchPct < 0.7 ? -1 : Math.round(matchPct * 100);
      }
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    return best;
  }

  function findIncrementForProduct(productName) {
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allInc.length; i++) {
      var btn = allInc[i];
      var al = btn.getAttribute('aria-label') || '';
      var m = al.match(/^Increase Quantity \\d+ unit[^\\s]* of (.+)/i);
      if (!m) continue;
      var score = scoreProductName(m[1], productName);
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    if (!best && allInc.length === 1) return allInc[0];
    return best;
  }

  function pollForIncrement(productName) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      var POLL_MS = 150;
      var MAX_MS = 5000;
      function tick() {
        if (elapsed >= MAX_MS) { resolve(null); return; }
        var incBtn = findIncrementForProduct(productName);
        if (incBtn) { resolve(incBtn); return; }
        var bubble = findBubbleForProduct(productName);
        if (bubble) {
          bubble.scrollIntoView({ behavior: 'instant', block: 'center' });
          bubble.click();
        }
        elapsed += POLL_MS;
        setTimeout(tick, POLL_MS);
      }
      tick();
    });
  }

  // Read the current cart qty for a product by inspecting bubble/increment aria-labels.
  function getCartQty() {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    for (var i = 0; i < allBubbles.length; i++) {
      var al = allBubbles[i].getAttribute('aria-label') || '';
      var qm = al.match(/(\\d+)\\s*unit/i);
      if (qm) return parseInt(qm[1], 10);
    }
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    for (var i = 0; i < allInc.length; i++) {
      var al = allInc[i].getAttribute('aria-label') || '';
      var qm = al.match(/Quantity\\s+(\\d+)/i);
      if (qm) return parseInt(qm[1], 10);
    }
    return 0;
  }

  // After clicking ATC or increment, poll until the cart qty changes (up to 5s).
  function waitForQtyChange(prevQty) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        if (elapsed >= 5000) { resolve(false); return; }
        var current = getCartQty();
        if (current > prevQty) { resolve(true); return; }
        elapsed += 200;
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  // Poll for ATC buttons to appear (up to 6s).
  var allAtcBtns = [];
  for (var poll = 0; poll < 20; poll++) {
    allAtcBtns = Array.from(document.querySelectorAll(ATC_SEL)).slice(0, 20);
    if (allAtcBtns.length > 0) break;
    await wait(300);
  }

  // Find ATC buttons and score against search term
  var candidates = [];
  var seen = new Set();
  var bestAtcBtn = null, bestAtcScore = -1, bestName = null;

  for (var bi = 0; bi < allAtcBtns.length; bi++) {
    var btn = allAtcBtns[bi];
    var al = btn.getAttribute('aria-label') || '';
    var atcMatch = al.match(/^Add 1 unit of (.+)/i);
    if (!atcMatch) continue;
    var name = atcMatch[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var oos = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    var card = btn.closest('li, article, [class*="ProductCard"], [class*="product-card"]');
    var imgEl = card ? card.querySelector('img') : null;

    candidates.push({
      productName: name,
      imageUrl: imgEl ? imgEl.src : null,
      outOfStock: oos,
      preferences: null,
      price: null
    });

    if (!bestName && scoreMatch(SEARCH_TERM, name) === 100 && !oos) {
      bestAtcBtn = btn; bestAtcScore = 100; bestName = name;
    }
    if (candidates.length >= 8) break;
  }

  if (!bestName || !bestAtcBtn) {
    var hasExactOos = candidates.some(function(c) { return scoreMatch(SEARCH_TERM, c.productName) === 100 && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  try {
    // Check for pre-existing qty (product already in cart)
    var preExistingBubble = findBubbleForProduct(bestName);
    var preExistingIncrement = !preExistingBubble ? findIncrementForProduct(bestName) : null;

    // Wait for cart state overlay if ATC found
    if (!preExistingBubble && !preExistingIncrement) {
      for (var wa = 0; wa < 3 && !preExistingBubble && !preExistingIncrement; wa++) {
        await wait(400);
        preExistingBubble = findBubbleForProduct(bestName);
        preExistingIncrement = !preExistingBubble ? findIncrementForProduct(bestName) : null;
      }
    }

    var usePreExisting = !!(preExistingBubble || preExistingIncrement);
    var stepperAlreadyOpen = !!preExistingIncrement && !preExistingBubble;
    var actuallyClicked = 0;

    if (usePreExisting) {
      if (stepperAlreadyOpen) {
        for (var i = 0; i < QTY; i++) {
          var qtyBefore = getCartQty();
          var incBtn = i === 0 ? preExistingIncrement : await pollForIncrement(bestName);
          if (!incBtn) break;
          incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incBtn.click();
          var confirmed = await waitForQtyChange(qtyBefore);
          if (confirmed) actuallyClicked++;
        }
      } else {
        preExistingBubble.scrollIntoView({ behavior: 'instant', block: 'center' });
        preExistingBubble.click();
        await wait(600);
        for (var i = 0; i < QTY; i++) {
          var qtyBefore = getCartQty();
          var incBtn = await pollForIncrement(bestName);
          if (!incBtn) break;
          incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incBtn.click();
          var confirmed = await waitForQtyChange(qtyBefore);
          if (confirmed) actuallyClicked++;
        }
      }
    } else {
      // Normal path: ATC adds first unit, increment handles the rest.
      // After each click, poll until the cart qty increases before continuing.
      for (var i = 0; i < QTY; i++) {
        var qtyBefore = getCartQty();
        var buttonToClick;
        if (i === 0) {
          buttonToClick = bestAtcBtn;
        } else {
          // Try increment (handles bubble→stepper), fall back to re-clicking ATC
          buttonToClick = await pollForIncrement(bestName);
          if (!buttonToClick) {
            var freshAtc = Array.from(document.querySelectorAll(ATC_SEL));
            for (var fa = 0; fa < freshAtc.length; fa++) {
              var faLabel = freshAtc[fa].getAttribute('aria-label') || '';
              var faMatch = faLabel.match(/^Add 1 unit of (.+)/i);
              if (faMatch && faMatch[1].trim() === bestName) { buttonToClick = freshAtc[fa]; break; }
            }
          }
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'ADD_DEBUG', step: 'increment_' + i,
            foundIncrement: !!buttonToClick,
            qtyBefore: qtyBefore
          }));
          if (!buttonToClick) break;
        }
        if (buttonToClick.disabled || buttonToClick.getAttribute('aria-disabled') === 'true') break;
        buttonToClick.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        buttonToClick.click();
        // Wait for the cart to confirm the add (qty increases) before proceeding.
        var confirmed = await waitForQtyChange(qtyBefore);
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ADD_DEBUG', step: 'click_confirmed_' + i,
          confirmed: confirmed, qtyBefore: qtyBefore, qtyAfter: getCartQty()
        }));
        if (confirmed) actuallyClicked++;
      }
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: actuallyClicked >= 1, productName: bestName, actuallyClicked: actuallyClicked, qty: QTY }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates }));
  }
})();true;`;
}

// ── Export ───────────────────────────────────────────────────────────────────

export function getScripts(storeId: string): StoreScripts {
  const domain = DOMAIN_MAP[storeId] || 'albertsons.com';
  const storeOrigin = `https://www.${domain}`;

  return {
    storeUrl: storeOrigin,
    loginUrl: storeOrigin,
    cartUrl: `${storeOrigin}/shop/cart.html`,
    domain: domain,
    isSearchUrl: (url: string) => url.includes(domain) && url.includes('/shop/search-results.html'),
    // Albertsons login is a popup on the same page — login success is detected via
    // LOGIN_COMPLETE message from the background poll, not via URL change.
    isLoginSuccessUrl: () => false,
    checkLoginScript: buildCheckLoginScript(domain),
    extractProductsScript: buildExtractProductsScript(),
    buildAddToCartScript: buildAddToCartScript,
    buildSearchScript: buildSearchScript(domain),
    buildSearchAndAddScript: buildSearchAndAddScriptFn,
  };
}
