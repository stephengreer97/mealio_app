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

import { selectorsFor, storeConfig, searchUrlFor } from '../automation-config';

const SELECTOR_KEY = 'aldi';

// Compiled-in selector fallbacks; the remote automation config overrides them so
// an ALDI/Instacart redesign is a config push rather than an App Store release.
// Read only inside a build function — the config loads after module import, so a
// module-scope capture would freeze these fallbacks forever.
const SEL_FALLBACKS = {
  atc: 'button[aria-label^="Add 1 "]',
  inc: 'button[aria-label^="Increment quantity"], button[aria-label^="Increase quantity"]',
  qtyBubble: 'button[aria-label^="Quantity:"]',
  cardLink: 'a[href*="/store/aldi/products/"]',
  menu: '[role="dialog"][aria-label="Main Menu"]',
  hamburger: '[data-testid="hamburger-coachmark-button"], button[aria-label="Main Menu"]',
};

/** Live selectors as interpolatable JS literals (quotes included). */
const sel = () => selectorsFor(SELECTOR_KEY, SEL_FALLBACKS);

function buildCheckLoginScript(): string {
  const s = sel();
  return `(async function() {
  if (window.__aldiLoginCheckActive) return;
  window.__aldiLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    var MENU_SEL = ${s.menu};
    var HAMBURGER_SEL = ${s.hamburger};

    // The logged-in state (user name vs "Sign In"/"Register") is only visible
    // INSIDE the Main Menu dialog, so it must be opened before it can be read.
    function getMenu() {
      var d = document.querySelector(MENU_SEL);
      return (d && d.textContent && d.textContent.length > 5) ? d : null;
    }

    // Open the Main Menu (if not already open) and wait for it to render.
    // Returns the dialog element, or null if it never appeared.
    async function openMenu() {
      var menu = getMenu();
      if (menu) return menu;
      var btn = document.querySelector(HAMBURGER_SEL);
      if (btn) btn.click();
      for (var i = 0; i < 20; i++) {
        menu = getMenu();
        if (menu) return menu;
        await wait(200);
      }
      return null;
    }

    // Close the Main Menu so the modal doesn't block the search flow that follows.
    function closeMenu() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      var menu = document.querySelector(MENU_SEL);
      if (menu) {
        var closeBtn = menu.querySelector('button[aria-label*="close" i], button[aria-label*="dismiss" i]');
        if (closeBtn) closeBtn.click();
      }
    }

    // Positive proof of logged-OUT: the sign-in CTA. Checked FIRST and treated
    // as decisive, so we never falsely claim logged-in while it's still
    // rendering (the menu mounts before its contents populate).
    var SIGNED_OUT_RE = /sign in|log in|register|create account/;
    // Positive proof of logged-IN: personalized menu entries that only exist for
    // a signed-in account (plus the account/sign-out controls when present).
    var SIGNED_IN_RE = /buy it again|saved recipes|sign out|log out|your account|account settings/;

    // Open the menu and decide login state. The menu's contents render AFTER the
    // dialog mounts, so an early read can miss the "Sign in" CTA and look
    // logged-in. So: (a) short-circuit to 'out' the instant the CTA appears
    // (the safe direction), and (b) only trust 'in' once the menu text has
    // STABILIZED (no length change across two ticks) and a logged-in signal is
    // present. Returns 'in' | 'out' | 'unknown'.
    async function evaluateMenu() {
      var menu = await openMenu();
      if (!menu) return 'unknown';
      var lastLen = -1, stableTicks = 0, text = '';
      for (var i = 0; i < 28; i++) {            // up to ~7s
        menu = getMenu() || menu;
        text = (menu.textContent || '').toLowerCase();
        if (SIGNED_OUT_RE.test(text)) return 'out';
        if (text.length === lastLen) {
          if (++stableTicks >= 2) break;        // menu has settled
        } else { stableTicks = 0; lastLen = text.length; }
        await wait(250);
      }
      if (SIGNED_OUT_RE.test(text)) return 'out';
      if (SIGNED_IN_RE.test(text)) return 'in';
      return 'unknown';
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    var verdict = await evaluateMenu();
    // Default-safe: only a positive 'in' counts as logged-in. 'unknown' (the
    // menu never produced a decisive signal) shows the login UI.
    var isLoggedIn = verdict === 'in';

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'check_done', verdict: verdict, isLoggedIn: isLoggedIn
    }));

    if (isLoggedIn) {
      // Close the menu so the upcoming search isn't blocked by the modal.
      closeMenu();
      window.__aldiLoginCheckActive = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }));
      return;
    }

    // Not logged in (or inconclusive) — leave the menu open so the user sees
    // "Sign In" when the webview becomes visible, then post the status. Keep
    // __aldiLoginCheckActive set so a reinject (reinjectLoginCheckOnNav) during
    // the poll is suppressed and can't double-drive the menu.
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));

    // Background poll: every 2s for up to 3 minutes, re-evaluate the menu.
    // Covers SPA logins that finish without a full page reload (where
    // reinjectLoginCheckOnNav never fires). Posts LOGIN_COMPLETE.
    for (var pi = 0; pi < 90; pi++) {
      await wait(2000);
      // Don't fight a sign-in modal: if some OTHER visible dialog is up (the
      // login form), skip this tick rather than yanking the Main Menu open.
      var other = document.querySelector('[role="dialog"][aria-modal="true"]:not([aria-label="Main Menu"])');
      if (other && other.offsetParent !== null) continue;
      if (await evaluateMenu() === 'in') {
        closeMenu();
        window.__aldiLoginCheckActive = false;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_COMPLETE' }));
        return;
      }
    }
    window.__aldiLoginCheckActive = false;
  } catch(e) {
    window.__aldiLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;
}

// ── Product extraction ────────────────────────────────────────────────────────

/**
 * Injected on an ALDI/Instacart search results page.
 * Extracts product candidates from "Add 1 item" buttons.
 * Posts { type: 'SEARCH_RESULT', candidates: [...] }.
 */
function buildExtractProductsScript(): string {
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var ATC_SEL = ${s.atc};
  var QTY_BUBBLE_SEL = ${s.qtyBubble};
  // Product cards contain either an add button OR a quantity bubble.
  // Use product card links to find all products regardless of cart state.
  var CARD_LINK_SEL = ${s.cardLink};

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
}

// ── Add to cart ───────────────────────────────────────────────────────────────

function buildAddToCartScript(
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  const escapedName = JSON.stringify(productName);

  const s = sel();
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
  var ATC_SEL = ${s.atc};
  var INC_SEL = ${s.inc};
  var QTY_BUBBLE_SEL = ${s.qtyBubble};

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

  // Read the in-cart quantity shown on this product's card. Returns a number
  // when the count is legible, 0 when only the "Add 1" button is present, or
  // null when the DOM exposes no counter at all (caller then falls back to a
  // presence check). ALDI surfaces the count as a "Quantity: N" bubble, an
  // "N ct"/"N in cart" bubble, an item-quantity testid, or inside the
  // increment button's aria-label ("Increment quantity, currently N").
  function getCardQty(el) {
    if (!el) return null;
    var q = el.querySelector('[data-testid="item-quantity"], [data-testid*="quantity" i]');
    if (q) { var qt = (q.textContent || '').match(/\\d+/); if (qt) return parseInt(qt[0], 10); }
    var bubble = el.querySelector('button[aria-label^="Quantity:"], button[aria-label$=" ct"], button[aria-label$=" in cart"]');
    if (bubble) { var bm = (bubble.getAttribute('aria-label') || '').match(/(\\d+)/); if (bm) return parseInt(bm[1], 10); }
    var inc = el.querySelector(INC_SEL);
    if (inc) { var im = (inc.getAttribute('aria-label') || '').match(/currently\\s+(\\d+)/i); if (im) return parseInt(im[1], 10); }
    if (el.querySelector(ATC_SEL)) return 0;
    return null;
  }

  // Poll until the card's quantity reaches target. Instacart commits the add
  // over the network, so the count lags the click — bounded poll, not a fixed
  // wait. When the count is unreadable, fall back to "did the item enter the
  // cart at all" (stepper/bubble present). Returns false on timeout so the
  // caller can report an honest failure instead of a hardcoded success.
  async function confirmQty(el, target) {
    for (var ci = 0; ci < 16; ci++) {
      var q = getCardQty(el);
      if (q !== null) { if (q >= target) return true; }
      else if (el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL))) return true;
      await wait(250);
    }
    var qf = getCardQty(el);
    if (qf !== null) return qf >= target;
    return !!(el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL)));
  }

  // Baseline before we touch the cart; add is additive, so the target is
  // whatever was already there plus the requested QTY.
  var beforeQty = getCardQty(card);
  var target = (beforeQty === null ? 0 : beforeQty) + QTY;

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

  var confirmed = await confirmQty(card, target);
  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify(
    confirmed
      ? { type: 'ADD_RESULT', success: true }
      : { type: 'ADD_RESULT', success: false, reason: 'not_confirmed' }
  ));
})();true;`;
}

// ── Search navigation ─────────────────────────────────────────────────────────

function buildSearchScript(term: string): string {
  const escaped = JSON.stringify(term);
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};
  var ATC_SEL = ${s.atc};

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
  var ATC_SEL = ${s.atc};
  var INC_SEL = ${s.inc};
  var QTY_BUBBLE_SEL = ${s.qtyBubble};
  var CARD_LINK_SEL = ${s.cardLink};

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

  // Read the in-cart quantity on a card (see buildAddToCartScript for the DOM
  // shapes ALDI uses). Number when legible, 0 when only "Add 1" is present,
  // null when no counter is exposed.
  function getCardQty(el) {
    if (!el) return null;
    var q = el.querySelector('[data-testid="item-quantity"], [data-testid*="quantity" i]');
    if (q) { var qt = (q.textContent || '').match(/\\d+/); if (qt) return parseInt(qt[0], 10); }
    var bubble = el.querySelector('button[aria-label^="Quantity:"], button[aria-label$=" ct"], button[aria-label$=" in cart"]');
    if (bubble) { var bm = (bubble.getAttribute('aria-label') || '').match(/(\\d+)/); if (bm) return parseInt(bm[1], 10); }
    var inc = el.querySelector(INC_SEL);
    if (inc) { var im = (inc.getAttribute('aria-label') || '').match(/currently\\s+(\\d+)/i); if (im) return parseInt(im[1], 10); }
    if (el.querySelector(ATC_SEL)) return 0;
    return null;
  }

  // Bounded poll for the cart to reflect the add over the network; presence
  // fallback when the count is unreadable. False on timeout → honest failure.
  async function confirmQty(el, target) {
    for (var ci = 0; ci < 16; ci++) {
      var q = getCardQty(el);
      if (q !== null) { if (q >= target) return true; }
      else if (el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL))) return true;
      await wait(250);
    }
    var qf = getCardQty(el);
    if (qf !== null) return qf >= target;
    return !!(el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL)));
  }

  try {
    // Baseline before we touch the cart; the add is additive.
    var beforeQty = getCardQty(bestCard);
    var target = (beforeQty === null ? 0 : beforeQty) + QTY;

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

    var confirmed = await confirmQty(bestCard, target);
    document.removeEventListener('focusin', __noKbd, true);
    if (confirmed) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
    } else {
      // Same shape as the not-found/low-confidence failures above, so an add
      // that never committed routes into the Review picker like other search
      // stores instead of reporting a false success.
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'not_confirmed', candidates: candidates }));
    }
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
// sequential buildExtractProductsScript(), every dispatch is a fresh page load,
// so no stale-tile detection is needed.

function buildAldiWorkerExtractBody(): string {
  const s = sel();
  return `(function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function dbg(obj) {
    try {
      obj.type = 'WORKER_DEBUG'; obj.workerId = WORKER_ID;
      window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } catch(_) {}
  }

  var CARD_LINK_SEL = ${s.cardLink};
  var ATC_SEL = ${s.atc};

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
}

/** Returns injectedJavaScript for a single worker. The workerId is baked in. */
export function buildAldiWorkerScript(workerId: number): string {
  return 'var WORKER_ID = ' + workerId + ';\n' + buildAldiWorkerExtractBody();
}

/** Returns the ALDI (Instacart) search URL for a given query. */
export function getAldiSearchUrl(query: string): string {
  return 'https://www.aldi.us/store/aldi/s?k=' + encodeURIComponent(query);
}

// ── Public interface ──────────────────────────────────────────────────────────

export function getScripts() {
  const cfg = storeConfig(SELECTOR_KEY);
  return {
    storeUrl: cfg.storeUrl ?? ALDI_URL,
    loginUrl: cfg.loginUrl ?? ALDI_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? ALDI_CART_URL,
    domain: ALDI_DOMAIN,
    isSearchUrl: function(url: string) {
      // Instacart search bar is available on any store page, not just /search.
      // Returning true skips the storefront reload and injects search directly.
      return url.includes('aldi.us/store/');
    },
    isLoginSuccessUrl: function() { return false; },
    // Instacart reloads the storefront after sign-in. Re-run the login check on
    // that nav so an already-completed login is detected (the background poll in
    // buildCheckLoginScript() is the fallback for SPA logins with no full reload).
    reinjectLoginCheckOnNav: true,
    checkLoginScript: buildCheckLoginScript(),
    extractProductsScript: buildExtractProductsScript(),
    buildAddToCartScript: buildAddToCartScript,
    buildSearchScript: buildSearchScript,
    buildSearchAndAddScript: buildSearchAndAddScript,
    getSearchUrl: (term: string) => searchUrlFor(SELECTOR_KEY, term, getAldiSearchUrl(term)),
    buildWorkerScript: buildAldiWorkerScript,
    // ALDI (Instacart) anti-bot 403s on concurrent worker requests — confirmed
    // 2026-06-17 that 5 parallel workers still 403 even with the cache-buster
    // removed, so concurrency itself is a trigger. Run searches SERIALLY.
    // workerCount / stagger are kept for if/when the parallel path is retried.
    // Remotely tunable: if ALDI ever stops 403-ing concurrent searches we can
    // re-enable the parallel path with a config push instead of a release.
    forceSerialSearch: cfg.forceSerialSearch ?? true,
    workerCount: cfg.workerCount ?? 3,
    workerStaggerMs: cfg.workerStaggerMs ?? 400,
    // The anti-bot 403s on the `?_t=` cache-buster query (it lands right on the
    // blocked storefront request). Navigate to the clean URL instead.
    cacheBustNav: cfg.cacheBustNav ?? false,
    // Instacart SPA: search is a pushState route change (no reload), so the same
    // search page fires onLoadEnd multiple times while the add script is still
    // running. Suppress inflight re-injection so we don't double-add / skip items.
    spaSearch: true,
  };
}
