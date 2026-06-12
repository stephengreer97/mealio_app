// Injectable JavaScript strings for ALDI WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// ALDI now runs on the Instacart platform. DOM reference:
//   Store URL:          https://www.aldi.us/store/aldi/storefront
//   Search URL:         https://www.aldi.us/store/aldi/s?k={term} (Instacart pattern; /search was retired)
//   Add to cart button: button[aria-label^="Add 1 "] (name in aria-label)
//   Product card link:  a[href*="/store/aldi/products/"]
//   Increment button:   button[aria-label^="Increment quantity"]
//   Decrement button:   button[aria-label^="Decrement quantity"]
//   Cart quantity:      [data-testid="item-quantity"] or similar counter element

const ALDI_URL       = 'https://www.aldi.us';
const ALDI_LOGIN_URL = 'https://www.aldi.us';  // Instacart storefront — login via hamburger menu
const ALDI_CART_URL  = 'https://www.aldi.us';
const ALDI_DOMAIN    = 'aldi.us';

// ── Login check ───────────────────────────────────────────────────────────────

const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__aldiLoginCheckActive) return;
  window.__aldiLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // Poll for the Main Menu dialog to appear (up to 4s, usually < 1s).
    var menuDialog = null;
    for (var mi = 0; mi < 20; mi++) {
      menuDialog = document.querySelector('[role="dialog"][aria-label="Main Menu"]');
      if (menuDialog && menuDialog.textContent.length > 5) break;
      menuDialog = null;
      await wait(200);
    }
    var menuText = menuDialog ? menuDialog.textContent.toLowerCase() : '';
    var hasSignOut = menuText.includes('sign out') || menuText.includes('log out');
    var hasSignIn = menuText.includes('sign in') || menuText.includes('log in') || menuText.includes('register');
    // Logged in = menu exists and no longer shows sign-in prompt.
    var isLoggedIn = !!menuDialog && !hasSignIn;

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'check_done',
      menuFound: !!menuDialog, hasSignOut: hasSignOut, hasSignIn: hasSignIn, isLoggedIn: isLoggedIn
    }));

    // If not logged in, open the hamburger menu so the user sees "Sign In"
    // when the webview becomes visible.
    if (!isLoggedIn) {
      var menuBtn = document.querySelector('[data-testid="hamburger-coachmark-button"], button[aria-label="Main Menu"]');
      if (menuBtn) menuBtn.click();
    }

    window.__aldiLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  } catch(e) {
    window.__aldiLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ────────────────────────────────────────────────────────

/**
 * Injected on an ALDI/Instacart search results page.
 * Extracts product candidates from "Add 1 item" buttons.
 * Posts { type: 'SEARCH_RESULT', candidates: [...] }.
 */
const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var ATC_SEL = 'button[aria-label^="Add 1 "]';
  var QTY_BUBBLE_SEL = 'button[aria-label^="Quantity:"]';
  // Product cards contain either an add button OR a quantity bubble.
  // Use product card links to find all products regardless of cart state.
  var CARD_LINK_SEL = 'a[href*="/store/aldi/products/"]';

  // Stale detection: capture current first product link text.
  function getFirstLinkName() {
    var links = document.querySelectorAll(CARD_LINK_SEL);
    for (var li = 0; li < links.length; li++) {
      var t = links[li].textContent.trim();
      if (t.length > 5) return t.slice(0, 80);
    }
    return null;
  }
  var staleName = getFirstLinkName();

  // Poll for fresh products (up to 10s).
  var productLinks = [];
  for (var poll = 0; poll < 50; poll++) {
    productLinks = Array.from(document.querySelectorAll(CARD_LINK_SEL));
    if (productLinks.length > 0) {
      var currentName = getFirstLinkName();
      if (!staleName || currentName !== staleName) break;
    }
    await wait(200);
  }

  if (productLinks.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 30) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var text = card.textContent || '';
    var m = text.match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  function getProductName(card) {
    // Try "Add 1" button aria-label first (clean product name).
    var addBtn = card.querySelector(ATC_SEL);
    if (addBtn) {
      var m = (addBtn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
      if (m) return m[1].trim();
    }
    // Try image alt text (usually clean product name).
    var img = card.querySelector('img[alt]');
    if (img) {
      var alt = img.getAttribute('alt').trim();
      if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) return alt;
    }
    // Fall back to URL slug: /store/aldi/products/12345-product-name-size
    var link = card.querySelector(CARD_LINK_SEL);
    if (link) {
      var href = link.getAttribute('href') || '';
      var slugMatch = href.match(/\\/products\\/\\d+-(.+)/);
      if (slugMatch) {
        // Convert slug to title: "happy-harvest-crushed-tomatoes-28-oz" → "Happy Harvest Crushed Tomatoes 28 Oz"
        return slugMatch[1].split('-').map(function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
    }
    return null;
  }

  var seen = new Set();
  var candidates = [];

  // Iterate over product card links to find ALL products (including those already in cart).
  for (var pi = 0; pi < productLinks.length && pi < 20; pi++) {
    var card = findCard(productLinks[pi]);
    if (!card) continue;
    var name = getProductName(card);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector(ATC_SEL);
    var outOfStock = addBtn ? (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true') : false;
    var imgEl = card.querySelector('img');
    var imageUrl = imgEl ? (imgEl.src || imgEl.getAttribute('srcset')?.split(' ')[0] || null) : null;
    var price = extractPrice(card);

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: null, price: price });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;

// ── Add to cart ───────────────────────────────────────────────────────────────

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
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var QTY = ${qty};
  var ATC_SEL = 'button[aria-label^="Add 1 "]';
  var INC_SEL = 'button[aria-label^="Increment quantity"], button[aria-label^="Increase quantity"]';
  var QTY_BUBBLE_SEL = 'button[aria-label^="Quantity:"], button[aria-label$=" ct"], button[aria-label$=" in cart"]';

  // Find the add button for this product.
  var btns = Array.from(document.querySelectorAll(ATC_SEL));
  var targetBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var ariaLabel = btns[i].getAttribute('aria-label') || '';
    var nameMatch = ariaLabel.match(/^Add 1 (?:item|ct)\\s+(.+)/i);
    if (nameMatch && nameMatch[1].trim() === TARGET_NAME) {
      targetBtn = btns[i];
      break;
    }
  }

  if (!targetBtn) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  // Find the product card container for increment buttons.
  var card = targetBtn.parentElement;
  for (var depth = 0; depth < 10 && card; depth++) {
    if (card.querySelector('img') && card.textContent.length > 30) break;
    card = card.parentElement;
  }

  // Click add button first time.
  targetBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
  await wait(200);
  targetBtn.click();
  await wait(1000);
  var quantityAdded = 1;

  // Increment for remaining qty.
  while (quantityAdded < QTY) {
    var incrBtn = card ? card.querySelector(INC_SEL) : null;
    if (!incrBtn) break;
    incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(200);
    incrBtn.click();
    await wait(500);
    quantityAdded++;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: true }));
})();true;`;
}

// ── Search navigation ─────────────────────────────────────────────────────────

function buildSearchScript(term: string): string {
  const escaped = JSON.stringify(term);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};
  var ATC_SEL = 'button[aria-label^="Add 1 "]';

  // Capture stale product name for freshness detection.
  function getFirstName() {
    var b = document.querySelector(ATC_SEL);
    if (!b) return null;
    var m = (b.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
    return m ? m[1].trim() : null;
  }
  var staleName = getFirstName();

  // The search input (#search-bar-input) is hidden until the search area is clicked.
  // Click the "Ask or search anything" label/span to open it.
  var trigger = document.querySelector('label[class*="e-6xs547"], span[class*="e-1olf6x2"]');
  if (!trigger) {
    // Broader fallback: click anything containing "search anything".
    var allEls = document.querySelectorAll('label, span, div');
    for (var ti = 0; ti < allEls.length; ti++) {
      if (/ask or search/i.test(allEls[ti].textContent) && allEls[ti].textContent.length < 60) {
        trigger = allEls[ti];
        break;
      }
    }
  }
  if (trigger) {
    trigger.click();
    await wait(500);
  }

  // Now find the search input (should be visible after clicking trigger).
  var searchInput = document.getElementById('search-bar-input')
    || document.querySelector('input[aria-label="Search"]')
    || document.querySelector('input[placeholder*="search" i]');

  if (!searchInput) {
    // Last resort: URL navigation.
    window.location.href = 'https://www.aldi.us/store/aldi/s?k=' + encodeURIComponent(term);
    return;
  }

  // Focus and type the search term.
  searchInput.focus();
  await wait(100);

  var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  var setter = nativeSetter ? nativeSetter.set : null;
  if (setter) {
    setter.call(searchInput, '');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(50);
    setter.call(searchInput, term);
  } else {
    searchInput.value = term;
  }
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(300);

  // Submit with Enter.
  var form = searchInput.closest('form');
  if (form) {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  ['keydown', 'keypress', 'keyup'].forEach(function(type) {
    searchInput.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
  });

  // Wait for fresh results (stale detection, up to 10s).
  for (var pi = 0; pi < 50; pi++) {
    await wait(200);
    var currentName = getFirstName();
    if (currentName && currentName !== staleName) break;
    // If products disappeared (SPA transition), wait for new ones.
    if (pi > 15 && document.querySelectorAll(ATC_SEL).length === 0) {
      for (var wi = 0; wi < 30; wi++) {
        await wait(200);
        if (document.querySelectorAll(ATC_SEL).length > 0) break;
      }
      break;
    }
  }
})();true;`;
}

// ── Search + auto-add ─────────────────────────────────────────────────────────

function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
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
  var ATC_SEL = 'button[aria-label^="Add 1 "]';
  var INC_SEL = 'button[aria-label^="Increment quantity"], button[aria-label^="Increase quantity"]';
  var QTY_BUBBLE_SEL = 'button[aria-label^="Quantity:"]';
  var CARD_LINK_SEL = 'a[href*="/store/aldi/products/"]';

  // Stale detection using card links (works for products in cart too).
  function getFirstLinkName() {
    var links = document.querySelectorAll(CARD_LINK_SEL);
    for (var li = 0; li < links.length; li++) {
      var t = links[li].textContent.trim();
      if (t.length > 5) return t.slice(0, 80);
    }
    return null;
  }
  var staleName = getFirstLinkName();

  // Open search, type term, submit.
  var trigger = document.querySelector('label[class*="e-6xs547"], span[class*="e-1olf6x2"]');
  if (!trigger) {
    var allEls = document.querySelectorAll('label, span, div');
    for (var ti = 0; ti < allEls.length; ti++) {
      if (/ask or search/i.test(allEls[ti].textContent) && allEls[ti].textContent.length < 60) {
        trigger = allEls[ti];
        break;
      }
    }
  }
  if (trigger) { trigger.click(); await wait(500); }

  var searchInput = document.getElementById('search-bar-input')
    || document.querySelector('input[aria-label="Search"]')
    || document.querySelector('input[placeholder*="search" i]');

  if (searchInput) {
    searchInput.focus();
    await wait(100);
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    var setter = nativeSetter ? nativeSetter.set : null;
    if (setter) {
      setter.call(searchInput, '');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(50);
      setter.call(searchInput, SEARCH_TERM);
    } else {
      searchInput.value = SEARCH_TERM;
    }
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
    var form = searchInput.closest('form');
    if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    ['keydown', 'keypress', 'keyup'].forEach(function(type) {
      searchInput.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
  } else {
    window.location.href = 'https://www.aldi.us/store/aldi/s?k=' + encodeURIComponent(SEARCH_TERM);
  }

  // Wait for fresh search results (stale detection via card links, up to 10s).
  var productLinks = [];
  for (var poll = 0; poll < 50; poll++) {
    productLinks = Array.from(document.querySelectorAll(CARD_LINK_SEL));
    if (productLinks.length > 0) {
      var currentName = getFirstLinkName();
      if (!staleName || currentName !== staleName) break;
    }
    await wait(200);
  }

  if (productLinks.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: [] }));
    return;
  }

  // Score and find best match.
  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground']);
  var COMMON = new Set(['the','and','or','of','a','an','in','on','at','to','for','with']);

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

  function scoreOne(nf, nt) {
    if (nf === nt) return 100;
    var wt = nt.split(' ').filter(Boolean), wf = new Set(nf.split(' ').filter(Boolean));
    var critTarget = wt.filter(function(w) { return CRITICAL.has(w); });
    var critFound = [];
    wf.forEach(function(w) { if (CRITICAL.has(w)) critFound.push(w); });
    // Penalize missing critical words instead of hard-rejecting.
    // ALDI has limited selection — "Organic Broccoli" should still match "Broccoli Crowns".
    var critPenalty = 0;
    for (var i = 0; i < critTarget.length; i++) { if (!wf.has(critTarget[i])) critPenalty += 15; }
    for (var j = 0; j < critFound.length; j++) {
      var inTarget = false;
      for (var k = 0; k < critTarget.length; k++) { if (critTarget[k] === critFound[j]) { inTarget = true; break; } }
      if (!inTarget) critPenalty += 15;
    }
    var matching = wt.filter(function(w) { return wf.has(w); });
    var pct = matching.length / wt.length;
    if (pct < 0.3) return -1;
    var extra = [];
    wf.forEach(function(w) {
      if (!new Set(wt).has(w) && !COMMON.has(w)) extra.push(w);
    });
    var score = Math.round(pct * 100) - (extra.length * 5) - critPenalty;
    return Math.max(0, score);
  }

  function scoreMatch(found, target) {
    var s1 = scoreOne(normDiacritic(found), normDiacritic(target));
    var s2 = scoreOne(normStrip(found), normStrip(target));
    return Math.max(s1, s2);
  }

  function findCard(btn) {
    var node = btn.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 30) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var m = (card.textContent || '').match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  function getProductName(card) {
    var addBtn = card.querySelector(ATC_SEL);
    if (addBtn) {
      var m = (addBtn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
      if (m) return m[1].trim();
    }
    var img = card.querySelector('img[alt]');
    if (img) {
      var alt = img.getAttribute('alt').trim();
      if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) return alt;
    }
    var link = card.querySelector(CARD_LINK_SEL);
    if (link) {
      var href = link.getAttribute('href') || '';
      var slugMatch = href.match(/\\/products\\/\\d+-(.+)/);
      if (slugMatch) {
        return slugMatch[1].split('-').map(function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
    }
    return null;
  }

  var seen = new Set();
  var candidates = [];
  var bestCard = null, bestName = null, bestScore = -1;

  for (var pi = 0; pi < productLinks.length && pi < 20; pi++) {
    var card = findCard(productLinks[pi]);
    if (!card) continue;
    var name = getProductName(card);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector(ATC_SEL);
    var oos = addBtn ? (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true') : false;
    var imgEl = card.querySelector('img');

    candidates.push({
      productName: name,
      imageUrl: imgEl ? (imgEl.src || null) : null,
      outOfStock: oos,
      preferences: null,
      price: extractPrice(card)
    });

    if (!oos) {
      var sc = scoreMatch(name, SEARCH_TERM);
      if (sc > bestScore) {
        bestScore = sc;
        bestName = name;
        bestCard = card;
      }
    }
    if (candidates.length >= 8) break;
  }

  var MIN_SCORE = 30;
  if (!bestName || bestScore < MIN_SCORE || !bestCard) {
    var hasExactOos = candidates.some(function(c) { return scoreMatch(c.productName, SEARCH_TERM) >= MIN_SCORE && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  try {
    // Find the add button or qty bubble on the matched card.
    var addBtn2 = bestCard.querySelector(ATC_SEL);
    var quantityAdded = 0;

    if (addBtn2) {
      // Product not yet in cart — click add.
      addBtn2.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      addBtn2.click();
      await wait(1000);
      quantityAdded = 1;
    } else {
      // Product already in cart — increment button should be visible.
      // Only click qty bubble if increment isn't directly available (collapsed stepper).
      var initIncr = bestCard.querySelector(INC_SEL);
      if (!initIncr) {
        var initBubble = bestCard.querySelector(QTY_BUBBLE_SEL);
        if (initBubble) {
          initBubble.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(200);
          initBubble.click();
          await wait(500);
        }
      }
    }

    // Increment for remaining qty.
    while (quantityAdded < QTY) {
      var incrBtn = bestCard ? bestCard.querySelector(INC_SEL) : null;
      if (!incrBtn) break;
      incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      incrBtn.click();
      await wait(500);
      quantityAdded++;
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'error', candidates: candidates }));
  }
})();true;`;
}

// ── Parallel worker support ───────────────────────────────────────────────────
//
// Mirrors the Wegmans 5-worker pool (see wegmans.ts buildWegmansWorkerScript
// and useParallelSearchPool): each hidden worker WebView loads a search URL
// from getAldiSearchUrl, and this injected script extracts up to 8 product
// candidates and posts WORKER_RESULT with the baked-in workerId. Unlike the
// sequential EXTRACT_PRODUCTS_SCRIPT, every dispatch is a fresh page load,
// so no stale-tile detection is needed.

const ALDI_WORKER_EXTRACT_BODY = `(function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function dbg(obj) {
    try {
      obj.type = 'WORKER_DEBUG'; obj.workerId = WORKER_ID;
      window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } catch(_) {}
  }

  var CARD_LINK_SEL = 'a[href*="/store/aldi/products/"]';
  var ATC_SEL = 'button[aria-label^="Add 1 "]';

  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 30) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var text = card.textContent || '';
    var m = text.match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  function getProductName(card) {
    var addBtn = card.querySelector(ATC_SEL);
    if (addBtn) {
      var m = (addBtn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
      if (m) return m[1].trim();
    }
    var img = card.querySelector('img[alt]');
    if (img) {
      var alt = img.getAttribute('alt').trim();
      if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) return alt;
    }
    var link = card.querySelector(CARD_LINK_SEL);
    if (link) {
      var href = link.getAttribute('href') || '';
      var slugMatch = href.match(/\\/products\\/\\d+-(.+)/);
      if (slugMatch) {
        return slugMatch[1].split('-').map(function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
    }
    return null;
  }

  // Query comes from the search URL (/store/aldi/s?k=...). No query means a
  // warmup/initial load — stay silent so the pool doesn't record a result.
  var query = '';
  try {
    var sp = new URLSearchParams(window.location.search);
    query = sp.get('k') || '';
  } catch(_) {}
  if (!query) {
    dbg({ step: 'warmup_load', url: window.location.href });
    return;
  }

  (async function() {
    dbg({ step: 'extract_start', query: query, url: window.location.href });

    var productLinks = [];
    var waitedMs = 0;
    for (var poll = 0; poll < 50; poll++) {
      productLinks = Array.from(document.querySelectorAll(CARD_LINK_SEL));
      if (productLinks.length > 0) break;
      await wait(200);
      waitedMs += 200;
    }

    var seen = new Set();
    var candidates = [];
    for (var pi = 0; pi < productLinks.length && candidates.length < 8; pi++) {
      var card = findCard(productLinks[pi]);
      if (!card) continue;
      var name = getProductName(card);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      var addBtn = card.querySelector(ATC_SEL);
      var outOfStock = addBtn ? (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true') : false;
      var imgEl = card.querySelector('img');
      candidates.push({
        productName: name,
        imageUrl: imgEl ? imgEl.src : null,
        outOfStock: outOfStock,
        preferences: null,
        price: extractPrice(card),
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
export function buildAldiWorkerScript(workerId: number): string {
  return 'var WORKER_ID = ' + workerId + ';\n' + ALDI_WORKER_EXTRACT_BODY;
}

/** Returns the ALDI (Instacart) search URL for a given query. */
export function getAldiSearchUrl(query: string): string {
  return 'https://www.aldi.us/store/aldi/s?k=' + encodeURIComponent(query);
}

// ── Public interface ──────────────────────────────────────────────────────────

export function getScripts() {
  return {
    storeUrl: ALDI_URL,
    loginUrl: ALDI_LOGIN_URL,
    cartUrl: ALDI_CART_URL,
    domain: ALDI_DOMAIN,
    isSearchUrl: function(url: string) {
      // Instacart search bar is available on any store page, not just /search.
      // Returning true skips the storefront reload and injects search directly.
      return url.includes('aldi.us/store/');
    },
    isLoginSuccessUrl: function() { return false; },
    checkLoginScript: CHECK_LOGIN_SCRIPT,
    extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
    buildAddToCartScript: buildAddToCartScript,
    buildSearchScript: buildSearchScript,
    buildSearchAndAddScript: buildSearchAndAddScript,
  };
}
