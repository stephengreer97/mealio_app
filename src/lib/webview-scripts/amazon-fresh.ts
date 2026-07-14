// Injectable JavaScript strings for Amazon Fresh WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// Ported from ~/mealio_ext/content-amazon-fresh.js — same selectors and logic,
// adapted to the StoreScripts interface used by the store registry.
//
// Amazon Fresh has two completely different card layouts:
//   TYPE A — Storefront carousel  (e.g. /fmc/storefront/fresh)
//   TYPE B — Search results       (e.g. /s?k=...&i=amazonfresh)
// Both types use lazy rendering that requires polling for elements.

import { buildExtractWorker } from './worker-search';
import { buildCartConfirmFn } from './cart-confirm';

const AMAZON_URL = 'https://www.amazon.com/fresh';
const AMAZON_LOGIN_URL = 'https://www.amazon.com/ap/signin';
const AMAZON_CART_URL = 'https://www.amazon.com/cart';
const AMAZON_DOMAIN = 'amazon.com';

// ── Login check ─────────────────────────────────────────────────────────────

const CHECK_LOGIN_SCRIPT = `(async function() {
  if (window.__amazonLoginCheckActive) return;
  window.__amazonLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    await wait(1500);

    // True positive login detection using DOM structure.
    // When logged in, the greeting element has class "nav-greeting-recognized"
    // and contains a child <a id="nav-greeting-name"> with the user's name.
    var greetingEl = document.getElementById('nav-logobar-greeting');
    var isRecognized = greetingEl && greetingEl.classList.contains('nav-greeting-recognized');
    var nameLink = document.getElementById('nav-greeting-name');

    var isLoggedIn = !!(isRecognized && nameLink);

    window.__amazonLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  } catch(e) {
    window.__amazonLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;

// ── Product extraction ──────────────────────────────────────────────────────

// Detects Amazon Fresh's "no results … in Amazon Fresh" empty-state, which shows
// for EVERY search when the account has no Fresh store / serviceable delivery
// address selected. Injected into the extract + search-and-add scripts so RN can
// tell this apart from a genuine per-item miss or an anti-bot block. The distinct
// phrase (not just 0 products) also guards against a broken selector reading as
// "no store".
const FRESH_EMPTY_STATE_FN = `
  function __freshSlotText() {
    try {
      var slot = document.querySelector('.s-main-slot, .s-search-results, #search') || document.body;
      return (slot.textContent || '').replace(/\\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }
  function __freshEmptyState() {
    try {
      var t = __freshSlotText();
      // Fresh's own no-results empty-state (shown for EVERY search when no store /
      // serviceable address is selected)…
      if (/no results for[\\s\\S]{0,160}amazon fresh/i.test(t)) return true;
      // …or a prompt to pick a Fresh store / delivery address.
      if (/(select|choose|change|enter)[\\s\\S]{0,40}(store|address|zip|location)/i.test(t)
          && /(amazon fresh|fresh store|delivery)/i.test(t)) return true;
      return false;
    } catch (e) { return false; }
  }
`;

const EXTRACT_PRODUCTS_SCRIPT = `(async function() {
${FRESH_EMPTY_STATE_FN}
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  // --- Selectors ---
  // Type A: Storefront carousel
  var CARD_A = '[data-csa-c-item-type="asin"]';
  var NAME_A = '.a-truncate-full.a-offscreen';
  // Type B: Search results
  var CARD_B = '[data-component-type="s-search-result"]';
  var NAME_B = 'h2';

  // --- Helpers ---
  function isGarbageName(text) {
    if (/^\\$[\\d]/.test(text)) return true;
    if (/^estimated/i.test(text)) return true;
    if (/Overall Pick|Amazon.s Choice/i.test(text)) return true;
    if (/out of.*stars/i.test(text)) return true;
    if (/SNAP EBT/i.test(text)) return true;
    if (/^[\\d$.,\\s/()%]+(?:off|each|lb|oz|ounce|count|fl)/i.test(text)) return true;
    if (/Positively reviewed|Purchased often|Returned infrequently/i.test(text)) return true;
    if (/^See all details$/i.test(text)) return true;
    if (/^Quantity not updated/i.test(text)) return true;
    return false;
  }
  function getNameB(card) {
    // Pick the product-title h2, skipping the quick-shop widget's status h2
    // (e.g. "Quantity not updated" inside .ax-qs__error) which would otherwise
    // be read as the brand and prepended to the real name.
    var h2 = null, __h2s = card.querySelectorAll('h2');
    for (var __hi = 0; __hi < __h2s.length; __hi++) {
      if (__h2s[__hi].closest('.ax-qs__error, .qs-atc-plus, [class*="qs-widget"]')) continue;
      h2 = __h2s[__hi]; break;
    }
    if (!h2 && __h2s.length) h2 = __h2s[0];
    var brandText = h2 ? h2.textContent.trim() : '';
    // 1. h2 aria-label has the full product name on desktop
    if (h2) {
      var ariaLabel = h2.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim().length > 0) {
        return ariaLabel.trim().replace(/\\s+/g, ' ').replace(/^Sponsored Ad - /i, '');
      }
    }
    // 2. On mobile, h2 is just brand. Find product title via ASIN links (filtered).
    var asin = card.getAttribute('data-asin');
    if (asin) {
      var productLinks = card.querySelectorAll('a[href*="' + asin + '"]');
      var bestTitle = '';
      for (var pi = 0; pi < productLinks.length; pi++) {
        if (productLinks[pi].querySelector('img')) continue;
        var pText = productLinks[pi].textContent.trim().replace(/\\s+/g, ' ');
        if (pText.toLowerCase() === brandText.toLowerCase()) continue;
        if (isGarbageName(pText)) continue;
        if (pText.length > bestTitle.length) bestTitle = pText;
      }
      if (bestTitle.length > 0) {
        var cleaned = bestTitle.replace(/^Sponsored Ad - /i, '');
        if (brandText.length > 0 && !cleaned.toLowerCase().startsWith(brandText.toLowerCase())) {
          cleaned = brandText + ', ' + cleaned;
        }
        return cleaned;
      }
    }
    // 3. Fallback: wrapping link text
    if (h2) {
      var link = h2.closest('a');
      if (link) {
        var t = link.textContent.trim().replace(/\\s+/g, ' ');
        if (t.length > 0) return t.replace(/^Sponsored Ad - /i, '');
      }
      // Fallback: combine h2 + next sibling spans
      var parts = [h2.textContent.trim()];
      var sib = h2.nextElementSibling;
      while (sib && !sib.querySelector('.a-price') && !sib.textContent.match(/out of.*stars/i)) {
        var st = sib.textContent.trim();
        if (st.length > 0) parts.push(st);
        sib = sib.nextElementSibling;
      }
      var combined = parts.join(', ').replace(/\\s+/g, ' ');
      if (combined.length > 0) return combined.replace(/^Sponsored Ad - /i, '');
    }
    // 4. Fallback: span.a-text-normal inside a link
    var spanLink = card.querySelector('a.a-link-normal span.a-text-normal');
    if (spanLink) {
      var t2 = spanLink.textContent.trim().replace(/\\s+/g, ' ');
      if (t2.length > 0) return t2.replace(/^Sponsored Ad - /i, '');
    }
    return null;
  }
  function findCard(cards, name) {
    for (var i = 0; i < cards.length; i++) {
      var isB = cards[i].matches(CARD_B);
      var cardName = null;
      if (isB) {
        cardName = getNameB(cards[i]);
      } else {
        var el = cards[i].querySelector(NAME_A);
        if (el) cardName = el.textContent.trim().replace(/\\s+/g, ' ');
      }
      if (cardName && cardName === name) return cards[i];
    }
    return null;
  }

  function extractPrice(card) {
    var priceEl = card.querySelector('.a-price .a-offscreen, .a-price-whole, [data-a-color="price"] .a-offscreen');
    if (priceEl) {
      var raw = priceEl.textContent.trim();
      var m = raw.match(/\\$?([\\d,]+\\.?\\d*)/);
      if (m) return m[0].startsWith('$') ? m[0] : '$' + m[1];
    }
    return null;
  }

  // On search pages, only use CARD_B (actual search results) to avoid
  // picking up carousel cards ("Customers frequently viewed") that use CARD_A.
  var isSearchPage = window.location.pathname.startsWith('/s');
  var cardSelector = isSearchPage ? CARD_B : CARD_B + ', ' + CARD_A;

  // Poll for cards to render (Amazon lazy-loads).
  // Wait for first card, then give extra time for more to appear.
  var cards = [];
  for (var poll = 0; poll < 20; poll++) {
    cards = Array.from(document.querySelectorAll(cardSelector));
    if (cards.length > 0) break;
    await wait(300);
  }
  if (cards.length > 0 && cards.length < 8) {
    await wait(1000);
    cards = Array.from(document.querySelectorAll(cardSelector));
  }

  // Debug logging — also log DOM structure of first card for button detection
  var firstCardDebug = null;
  if (cards.length > 0) {
    var fc = cards[0];
    var buttons = Array.from(fc.querySelectorAll('button, input[type="submit"]'));
    var btnInfo = buttons.map(function(b) {
      return { tag: b.tagName, text: b.textContent.trim().slice(0, 40), ariaLabel: b.getAttribute('aria-label'), cls: b.className.slice(0, 60) };
    });
    var spans = Array.from(fc.querySelectorAll('span[data-action], fieldset, [data-a-component]'));
    var spanInfo = spans.map(function(s) {
      return { tag: s.tagName, dataAction: s.getAttribute('data-action'), cls: s.className.slice(0, 60), text: s.textContent.trim().slice(0, 30) };
    });
    var h2El = fc.querySelector('h2');
    var linkWrap = h2El ? h2El.closest('a') : null;
    var cardAsin = fc.getAttribute('data-asin');
    var asinLinkTexts = [];
    if (cardAsin) {
      var asLinks = Array.from(fc.querySelectorAll('a[href*="' + cardAsin + '"]'));
      asinLinkTexts = asLinks.map(function(a) {
        var hasImg = a.querySelector('img') ? '[IMG] ' : '';
        return hasImg + a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 100);
      });
    }
    firstCardDebug = {
      buttons: btnInfo,
      actionSpans: spanInfo,
      h2Text: h2El ? h2El.textContent.trim().slice(0, 40) : null,
      h2AriaLabel: h2El ? h2El.getAttribute('aria-label') : null,
      linkWrapText: linkWrap ? linkWrap.textContent.trim().slice(0, 80) : null,
      dataAsin: cardAsin,
      asinLinks: asinLinkTexts,
      cardHTML: fc.outerHTML.slice(0, 500)
    };
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'EXTRACT_DEBUG',
    cardsFound: cards.length,
    isSearchPage: isSearchPage,
    url: window.location.href,
    firstCardDebug: firstCardDebug
  }));

  if (cards.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [], storeUnavailable: __freshEmptyState() }));
    return;
  }

  var seen = new Set();
  var candidates = [];

  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var isB = card.matches(CARD_B);
    var name = null;

    if (isB) {
      name = getNameB(card);
    } else {
      var el = card.querySelector(NAME_A);
      if (el) {
        name = el.textContent.trim().replace(/\\s+/g, ' ');
      }
    }

    if (!name || name.length === 0) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'EXTRACT_DEBUG', step: 'skipped_card', idx: ci, isB: isB,
        hasH2: !!card.querySelector('h2'),
        snippet: card.textContent.trim().slice(0, 80),
        outerStart: card.outerHTML.slice(0, 150)
      }));
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    var imgEl = card.querySelector('img');
    var imageUrl = imgEl ? imgEl.src : null;

    var cardText = card.textContent || '';
    var outOfStock = /out.of.stock|temporarily unavailable|currently unavailable|unavailable/i.test(cardText)
      || !!card.querySelector('[aria-label*="unavailable" i], [aria-label*="out of stock" i], [class*="unavailable"], [class*="out-of-stock"]');

    var price = extractPrice(card);

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: null, price: price, isWeightItem: false });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;

// ── Add to cart ──────────────────────────────────────────────────────────────

function buildAddToCartScript(
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  var escapedName = JSON.stringify(productName);

  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
${buildCartConfirmFn(['#nav-cart-count'], '(\\d+)')}
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var QTY = ${qty};

  // --- Selectors ---
  var CARD_A = '[data-csa-c-item-type="asin"]';
  var NAME_A = '.a-truncate-full.a-offscreen';
  var ATC_WRAPPER_A = '.qs-atc-plus';
  var ADD_BTN_A = 'button[aria-label^="Add to Cart,"]';
  var STEPPER_A = '[id^="qs-widget-stepper-"]';
  var QTY_DISPLAY_A = '.qs-widget-dropdown-flex-wrapper button[aria-label^="Current quantity"]';
  var INC_BTN_A = '.qs-widget-increment-button-flex-wrapper input[aria-label^="Add "]';

  var CARD_B = '[data-component-type="s-search-result"]';
  var ATC_CONTAINER_B = 'span[data-action="fresh-add-to-cart"]';
  var STEPPER_B = 'fieldset[data-a-component="stepper"]';
  var QTY_DISPLAY_B = 'span[data-a-selector="value"]';
  var INC_BTN_B = 'button[data-action="a-stepper-increment"]';
  // Mobile selectors (different DOM structure from desktop)
  var ATC_BTN_B_MOBILE = 'button[aria-label="Add to cart"]';
  var INC_BTN_B_MOBILE = 'span[data-action="qs-widget-increment-decl"]';

  function isGarbageName(text) {
    if (/^\\$[\\d]/.test(text)) return true;
    if (/^estimated/i.test(text)) return true;
    if (/Overall Pick|Amazon.s Choice/i.test(text)) return true;
    if (/out of.*stars/i.test(text)) return true;
    if (/SNAP EBT/i.test(text)) return true;
    if (/^[\\d$.,\\s/()%]+(?:off|each|lb|oz|ounce|count|fl)/i.test(text)) return true;
    if (/Positively reviewed|Purchased often|Returned infrequently/i.test(text)) return true;
    if (/^See all details$/i.test(text)) return true;
    if (/^Quantity not updated/i.test(text)) return true;
    return false;
  }
  function getCardName(card) {
    if (card.matches(CARD_B)) {
      // Pick the product-title h2, skipping the quick-shop widget's status h2
      // (e.g. "Quantity not updated" inside .ax-qs__error) which would otherwise
      // be read as the brand and prepended to the real name.
      var h2 = null, __h2s = card.querySelectorAll('h2');
      for (var __hi = 0; __hi < __h2s.length; __hi++) {
        if (__h2s[__hi].closest('.ax-qs__error, .qs-atc-plus, [class*="qs-widget"]')) continue;
        h2 = __h2s[__hi]; break;
      }
      if (!h2 && __h2s.length) h2 = __h2s[0];
      var brandText = h2 ? h2.textContent.trim() : '';
      // 1. aria-label has full name on desktop
      if (h2) {
        var ariaLabel = h2.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim().length > 0) {
          return ariaLabel.trim().replace(/\\s+/g, ' ').replace(/^Sponsored Ad - /i, '');
        }
      }
      // 2. On mobile, h2 is just brand — find product title via ASIN links (filtered)
      var asin = card.getAttribute('data-asin');
      if (asin) {
        var productLinks = card.querySelectorAll('a[href*="' + asin + '"]');
        var bestTitle = '';
        for (var pi = 0; pi < productLinks.length; pi++) {
          if (productLinks[pi].querySelector('img')) continue;
          var pText = productLinks[pi].textContent.trim().replace(/\\s+/g, ' ');
          if (pText.toLowerCase() === brandText.toLowerCase()) continue;
          if (isGarbageName(pText)) continue;
          if (pText.length > bestTitle.length) bestTitle = pText;
        }
        if (bestTitle.length > 0) {
          var cleaned = bestTitle.replace(/^Sponsored Ad - /i, '');
          if (brandText.length > 0 && !cleaned.toLowerCase().startsWith(brandText.toLowerCase())) {
            cleaned = brandText + ', ' + cleaned;
          }
          return cleaned;
        }
      }
      // 3. Fallback: wrapping link text
      if (h2) {
        var link = h2.closest('a');
        if (link) {
          var t = link.textContent.trim().replace(/\\s+/g, ' ');
          if (t.length > 0) return t.replace(/^Sponsored Ad - /i, '');
        }
        // Fallback: combine h2 + next sibling text
        var parts = [h2.textContent.trim()];
        var sib = h2.nextElementSibling;
        while (sib && !sib.querySelector('.a-price') && !sib.textContent.match(/out of.*stars/i)) {
          var st = sib.textContent.trim();
          if (st.length > 0) parts.push(st);
          sib = sib.nextElementSibling;
        }
        return parts.join(', ').replace(/\\s+/g, ' ').replace(/^Sponsored Ad - /i, '');
      }
      return null;
    }
    var el = card.querySelector(NAME_A);
    if (!el) return null;
    return el.textContent.trim().replace(/\\s+/g, ' ');
  }

  function getQtyFromCard(card) {
    if (card.matches(CARD_B)) {
      // Desktop ATC container
      var atcContainer = card.querySelector(ATC_CONTAINER_B);
      if (atcContainer && !atcContainer.classList.contains('aok-hidden')) return 0;
      // Mobile ATC button
      var mobileAtc = card.querySelector(ATC_BTN_B_MOBILE);
      if (mobileAtc && !mobileAtc.closest('.aok-hidden')) return 0;
      var faceout = card.querySelector('.atc-faceout-container');
      if (faceout && faceout.hasAttribute('data-steppervalue')) {
        var sv = parseInt(faceout.getAttribute('data-steppervalue'), 10);
        if (!isNaN(sv)) return sv;
      }
      var stepper = card.querySelector(STEPPER_B);
      if (stepper) {
        var valueEl = stepper.querySelector(QTY_DISPLAY_B);
        if (valueEl) {
          var val = parseInt(valueEl.textContent.trim(), 10);
          if (!isNaN(val)) return val;
        }
      }
      if (atcContainer && atcContainer.classList.contains('aok-hidden')) return 1;
      return 0;
    }
    // Type A
    var stepperA = card.querySelector(STEPPER_A);
    if (!stepperA || stepperA.classList.contains('aok-hidden')) return 0;
    var qtyBtn = card.querySelector(QTY_DISPLAY_A);
    if (!qtyBtn) return 0;
    var m = (qtyBtn.getAttribute('aria-label') || '').match(/Current quantity (\\d+)/);
    return m ? parseInt(m[1]) : 0;
  }

  async function waitForQtyToChange(card, prevQty, maxMs) {
    maxMs = maxMs || 6000;
    var poll = 100;
    for (var el = 0; el < maxMs; el += poll) {
      if (getQtyFromCard(card) !== prevQty) return true;
      await wait(poll);
    }
    return false;
  }

  async function waitForAddButtonB(card, maxMs) {
    maxMs = maxMs || 8000;
    card.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(300);
    var poll = 100;
    for (var el = 0; el < maxMs; el += poll) {
      // Desktop: span[data-action="fresh-add-to-cart"]
      var btn = card.querySelector(ATC_CONTAINER_B);
      if (btn && !btn.classList.contains('aok-hidden')) return btn;
      // Mobile: button[aria-label="Add to cart"]
      var mobileBtn = card.querySelector(ATC_BTN_B_MOBILE);
      if (mobileBtn) return mobileBtn;
      // New qs-widget layout — the "+" button (shared between initial-add and
      // stepper-increment). The card may hold two with the same aria-label;
      // prefer one that isn't aok-hidden and isn't visibly collapsed, but
      // fall back to the first match to preserve previously-working behavior.
      var plusBtns = card.querySelectorAll('button[aria-label^="Add to Cart. Click to change"]');
      for (var pi = 0; pi < plusBtns.length; pi++) {
        var p = plusBtns[pi];
        if (p.classList && p.classList.contains('aok-hidden')) continue;
        var rect = p.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return p;
      }
      if (plusBtns.length > 0) return plusBtns[0];
      await wait(poll);
    }
    return null;
  }

  function readNewLayoutQty(c) {
    // Primary: button[aria-label="Add to Cart"] with numeric text (qty display).
    var qtyBtn = c.querySelector('button[aria-label="Add to Cart"]');
    if (qtyBtn) {
      var n = parseInt(qtyBtn.textContent.trim(), 10);
      if (!isNaN(n)) return n;
    }
    // Fallback: qs-widget-button-decl span whose text content is a numeric
    // qty (this span is the visual qty display in the stepper UI).
    var spans = c.querySelectorAll('span[data-action="qs-widget-button-decl"]');
    for (var i = 0; i < spans.length; i++) {
      var txt = (spans[i].textContent || '').trim();
      if (/^\\d+$/.test(txt)) {
        var m = parseInt(txt, 10);
        if (!isNaN(m)) return m;
      }
    }
    return 0;
  }

  // For weight-based items (meat, produce) Amazon Fresh opens a bottom-sheet
  // modal after the "+" click asking for quantity, then requires clicking
  // "Add to Cart" inside the modal to commit. Regular items skip the modal.
  // baselineQty is the qty observed before the triggering click — the early
  // exit fires only when the click already moved the counter, not just because
  // the item already had qty in cart.
  async function confirmWeightModal(card, maxMs, baselineQty) {
    maxMs = maxMs || 2500;
    baselineQty = baselineQty || 0;
    var poll = 100;

    function modalIsVisible(elx) {
      if (!elx || elx.offsetParent === null) return false;
      if (elx.classList && elx.classList.contains('aok-hidden')) return false;
      var rect = elx.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // Give the modal a beat to render.
    await wait(300);

    var diagnosticEmitted = false;
    for (var el = 0; el < maxMs; el += poll) {
      // Item was added directly — qty advanced past the pre-click baseline.
      if (getQtyFromCard(card) > baselineQty) return false;
      if (readNewLayoutQty(card) > baselineQty) return false;

      // ── Strategy 1: any visible button with class containing "qs-widget-summary-atc"
      var qsBtns = Array.from(document.querySelectorAll('[class*="qs-widget-summary-atc"]')).filter(modalIsVisible);

      // ── Strategy 2: locate a "Select quantity" header, walk up to its modal container,
      //    then find the primary action button inside.
      var selQtyEl = null;
      var labeled = document.querySelectorAll('h1, h2, h3, h4, legend, span, div, p');
      for (var li = 0; li < labeled.length; li++) {
        var lEl = labeled[li];
        var lTxt = (lEl.textContent || '').trim();
        if (/^select quantity/i.test(lTxt) && lTxt.length < 60 && modalIsVisible(lEl)) {
          selQtyEl = lEl;
          break;
        }
      }
      var modalContainer = null;
      if (selQtyEl) {
        var anc = selQtyEl;
        for (var d = 0; d < 12 && anc && anc !== document.body; d++) {
          anc = anc.parentElement;
          if (!anc) break;
          if (anc.querySelector('button, input[type="submit"]')) {
            // walk one more level up to be sure we have the whole sheet
            modalContainer = anc.parentElement && anc.parentElement.querySelector('button')
              ? anc.parentElement : anc;
            break;
          }
        }
      }

      // ── Strategy 3: visible button/input with text "Add to Cart" or "Update Cart"
      //    that is NOT inside the source card (those are the "+" buttons we already clicked).
      var allCtrls = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      var addCartCtrls = allCtrls.filter(function(b) {
        if (!modalIsVisible(b)) return false;
        if (card.contains(b)) return false;
        var t = (b.textContent || b.value || '').trim().toLowerCase();
        return t === 'add to cart' || t === 'update cart' || t === 'add to cart!';
      });

      if (!diagnosticEmitted) {
        diagnosticEmitted = true;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'MODAL_DEBUG',
          phase: 'scan',
          qsBtnsCount: qsBtns.length,
          qsBtnsSample: qsBtns.slice(0, 3).map(function(b) {
            return { tag: b.tagName, text: (b.textContent || '').trim().slice(0, 40), cls: (b.className || '').slice(0, 100), aria: b.getAttribute('aria-label'), dataAction: b.getAttribute('data-action') };
          }),
          selQtyFound: !!selQtyEl,
          modalContainerTag: modalContainer ? modalContainer.tagName : null,
          modalContainerCls: modalContainer ? (modalContainer.className || '').slice(0, 100) : null,
          addCartCount: addCartCtrls.length,
          addCartSample: addCartCtrls.slice(0, 5).map(function(b) {
            return { tag: b.tagName, text: (b.textContent || b.value || '').trim().slice(0, 40), cls: (b.className || '').slice(0, 100), aria: b.getAttribute('aria-label'), dataAction: b.getAttribute('data-action'), parentCls: (b.parentElement && b.parentElement.className || '').slice(0, 80) };
          })
        }));
      }

      // Click priority: qs-class first (most specific), then modal-container primary, then text-match.
      var target = null;
      var via = null;
      if (qsBtns.length > 0) { target = qsBtns[0]; via = 'qs-class'; }
      if (!target && modalContainer) {
        var inModal = Array.from(modalContainer.querySelectorAll('button, input[type="submit"]')).filter(modalIsVisible);
        var primary = inModal.find(function(b) {
          var t = (b.textContent || b.value || '').trim().toLowerCase();
          return t === 'add to cart' || t === 'update cart';
        });
        if (primary) { target = primary; via = 'modal-text'; }
        else if (inModal.length > 0) { target = inModal[inModal.length - 1]; via = 'modal-last'; }
      }
      if (!target && addCartCtrls.length > 0) {
        target = addCartCtrls[0];
        via = 'doc-text';
      }

      if (target) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'MODAL_DEBUG', action: 'click', via: via,
          text: (target.textContent || target.value || '').trim().slice(0, 40),
          cls: (target.className || '').slice(0, 100)
        }));
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(150);
        target.click();
        await wait(1200);
        return true;
      }
      await wait(poll);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MODAL_DEBUG', phase: 'timeout' }));
    return false;
  }

  async function waitForIncButton(card, maxMs) {
    maxMs = maxMs || 10000;
    var poll = 100;
    function incIsRendered(elx) {
      if (!elx) return false;
      if (elx.classList && elx.classList.contains('aok-hidden')) return false;
      var rect = elx.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    for (var el = 0; el < maxMs; el += poll) {
      var btn = null;
      if (card.matches(CARD_B)) {
        // Desktop: fieldset stepper
        var stepper = card.querySelector(STEPPER_B);
        btn = stepper ? stepper.querySelector(INC_BTN_B) : null;
        // Mobile / new layout: qs-widget-increment-decl wraps the actual
        // clickable (an <input type="submit"> with aria-label="Add"). Clicking
        // the wrapper <span> doesn't always trigger Amazon's declarative
        // handler, so dig in for the input. Prefer a rendered widget but fall
        // back to the first match to preserve prior behavior.
        if (!btn) {
          var incWidgets = card.querySelectorAll(INC_BTN_B_MOBILE);
          var chosen = null;
          for (var iw = 0; iw < incWidgets.length; iw++) {
            if (incIsRendered(incWidgets[iw])) { chosen = incWidgets[iw]; break; }
          }
          if (!chosen && incWidgets.length > 0) chosen = incWidgets[0];
          if (chosen) {
            btn = chosen.querySelector('input[type="submit"], button, input[aria-label]') || chosen;
          }
        }
        // Final fallback: the "+" button with aria-label "Add to Cart. Click
        // to change current quantity". Prefer a rendered one, fall back to
        // first match.
        if (!btn) {
          var plusBtns = card.querySelectorAll('button[aria-label^="Add to Cart. Click to change"]');
          for (var pi = 0; pi < plusBtns.length; pi++) {
            if (incIsRendered(plusBtns[pi])) { btn = plusBtns[pi]; break; }
          }
          if (!btn && plusBtns.length > 0) btn = plusBtns[0];
        }
      } else {
        var stepperA = card.querySelector(STEPPER_A);
        if (stepperA && !stepperA.classList.contains('aok-hidden')) {
          btn = card.querySelector(INC_BTN_A);
        }
      }
      if (btn) return btn;
      await wait(poll);
    }
    return null;
  }

  // On search pages, only use CARD_B to avoid carousel cards.
  var isSearchPage = window.location.pathname.startsWith('/s');
  var cardSelector = isSearchPage ? CARD_B : CARD_B + ', ' + CARD_A;

  // Poll for cards to render (Amazon lazy-loads).
  // Wait for first card, then give extra time for more to appear.
  var allCards = [];
  for (var poll = 0; poll < 20; poll++) {
    allCards = Array.from(document.querySelectorAll(cardSelector));
    if (allCards.length > 0) break;
    await wait(300);
  }
  if (allCards.length > 0 && allCards.length < 8) {
    await wait(1000);
    allCards = Array.from(document.querySelectorAll(cardSelector));
  }

  // Find target card by exact name match
  var targetCard = null;
  for (var ci = 0; ci < allCards.length; ci++) {
    var name = getCardName(allCards[ci]);
    if (name === TARGET_NAME) { targetCard = allCards[ci]; break; }
  }

  if (!targetCard) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  // Snapshot the header cart count before adding — success is gated on it
  // actually ticking up (deterministic commit), not just on a click landing.
  var __cartBefore = __cartCount();

  // ── Type B: Search results ────────────────────────────────────────────────
  if (targetCard.matches(CARD_B)) {
    var addBtn = await waitForAddButtonB(targetCard);
    if (!addBtn) {
      var cardText = targetCard.textContent || '';
      var oos = /out.of.stock|temporarily unavailable|currently unavailable|unavailable/i.test(cardText)
        || !!targetCard.querySelector('[aria-label*="unavailable" i], [aria-label*="out of stock" i]');
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: oos ? 'out_of_stock' : 'no_button' }));
      return;
    }
    var preAddQty = Math.max(getQtyFromCard(targetCard), readNewLayoutQty(targetCard));
    var __qtyBtn = targetCard.querySelector('button[aria-label="Add to Cart"]');
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'CART_DEBUG',
      where: 'addToCart',
      preAddQty: preAddQty,
      qty: QTY,
      legacyQty: getQtyFromCard(targetCard),
      newLayoutQty: readNewLayoutQty(targetCard),
      qtyBtnPresent: !!__qtyBtn,
      qtyBtnText: __qtyBtn ? __qtyBtn.textContent.trim().slice(0, 20) : null,
      addBtnFound: !!addBtn,
      addBtnAria: addBtn ? addBtn.getAttribute('aria-label') : null,
      addBtnTag: addBtn ? addBtn.tagName : null,
    }));
    // When the cart already has this item, the addBtn opens a modal whose qty
    // selector pre-selects the current qty (commit = no-op). Skip straight to
    // QTY increments instead. When cart is empty, fall back to the original
    // flow: one addBtn (which adds 1) then QTY-1 increments.
    var startQi = 1;
    if (preAddQty === 0) {
      addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      addBtn.click();
      await wait(800);
      await confirmWeightModal(targetCard, 1500, preAddQty);
    } else {
      startQi = 0;
    }
    for (var qi = startQi; qi < QTY; qi++) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOOP_ITER', qi: qi, where: 'addToCart' }));
      var preIncQty = Math.max(getQtyFromCard(targetCard), readNewLayoutQty(targetCard));
      var incBtn = await waitForIncButton(targetCard, 5000);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'WAIT_INC', qi: qi, foundIncBtn: !!incBtn, where: 'addToCart' }));
      if (!incBtn) break;
      // Diagnostic: which element are we about to click and what's its context?
      var __parent = incBtn.parentElement;
      var __wrapper = incBtn.closest('[data-action]');
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'INC_DEBUG',
        qi: qi,
        preIncQty: preIncQty,
        tag: incBtn.tagName,
        aria: incBtn.getAttribute('aria-label'),
        cls: (incBtn.className || '').slice(0, 100),
        text: (incBtn.textContent || incBtn.value || '').trim().slice(0, 30),
        parentTag: __parent ? __parent.tagName : null,
        parentCls: __parent ? (__parent.className || '').slice(0, 80) : null,
        wrapperDataAction: __wrapper ? __wrapper.getAttribute('data-action') : null,
        wrapperCls: __wrapper ? (__wrapper.className || '').slice(0, 80) : null,
      }));
      incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      incBtn.click();
      await wait(800);
      await confirmWeightModal(targetCard, 1500, preIncQty);
      // Diagnostic: did the click advance qty or did it land us in a modal?
      var __postIncQty = Math.max(getQtyFromCard(targetCard), readNewLayoutQty(targetCard));
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'INC_RESULT',
        qi: qi,
        preIncQty: preIncQty,
        postIncQty: __postIncQty,
        advanced: __postIncQty > preIncQty,
      }));
    }
    var __committedB = await __waitForCartIncrease(__cartBefore, 50);
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify(__committedB
      ? { type: 'ADD_RESULT', success: true }
      : { type: 'ADD_RESULT', success: false, reason: 'cart_not_incremented' }));
    return;
  }

  // ── Type A: Storefront carousel ───────────────────────────────────────────
  var currentQty = getQtyFromCard(targetCard);
  var quantityAdded = 0;

  if (currentQty === 0) {
    var addBtnA = null;
    var wrappers = targetCard.querySelectorAll(ATC_WRAPPER_A);
    for (var wi = 0; wi < wrappers.length; wi++) {
      if (!wrappers[wi].classList.contains('aok-hidden')) {
        addBtnA = wrappers[wi].querySelector(ADD_BTN_A);
        if (addBtnA) break;
      }
    }
    if (!addBtnA) addBtnA = targetCard.querySelector(ADD_BTN_A);

    if (!addBtnA) {
      var cardText = targetCard.textContent || '';
      var oos = /out.of.stock|temporarily unavailable|currently unavailable|unavailable/i.test(cardText)
        || !!targetCard.querySelector('[aria-label*="unavailable" i], [aria-label*="out of stock" i]');
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: oos ? 'out_of_stock' : 'no_button' }));
      return;
    }

    var qtyBefore = getQtyFromCard(targetCard);
    addBtnA.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(200);
    addBtnA.click();
    await waitForQtyToChange(targetCard, qtyBefore);
    quantityAdded = 1;
  }

  while (quantityAdded < QTY) {
    var incBtn = await waitForIncButton(targetCard);
    if (!incBtn) break;
    var qtyBefore2 = getQtyFromCard(targetCard);
    incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(200);
    incBtn.click();
    await waitForQtyToChange(targetCard, qtyBefore2);
    quantityAdded++;
  }

  var __committedA = await __waitForCartIncrease(__cartBefore, 50);
  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify(__committedA
    ? { type: 'ADD_RESULT', success: true }
    : { type: 'ADD_RESULT', success: false, reason: 'cart_not_incremented' }));
})();true;`;
}

// ── Search navigation ────────────────────────────────────────────────────────

function buildSearchScript(term: string): string {
  var cleanTerm = term.replace(/^Sponsored Ad - /i, '');
  var escapedTerm = JSON.stringify(cleanTerm);
  return `(async function() {
  var term = ${escapedTerm};
  var url = 'https://www.amazon.com/s?k=' + encodeURIComponent(term) + '&i=amazonfresh';
  window.location.href = url;
})();true;`;
}

// ── Search + auto-add ────────────────────────────────────────────────────────

function buildSearchAndAddScript(
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
): string {
  var cleanSearchTerm = searchTerm.replace(/^Sponsored Ad - /i, '');
  var escapedTerm = JSON.stringify(cleanSearchTerm);
  return `(async function() {
  // Run guard: Amazon SERPs fire onLoadEnd multiple times for the same URL, and
  // the sheet re-injects the inflight script on a same-URL fire (SSO-bootstrap
  // recovery). Without this, the add runs twice in one page context — double-
  // adding the item AND consuming the next item's result slot. A real page
  // reload makes a fresh JS context (flag clears, the add runs normally); a
  // spurious duplicate onLoadEnd sees the flag set and no-ops.
  if (window.__mealioFreshAddBusy) return;
  window.__mealioFreshAddBusy = true;

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
${buildCartConfirmFn(['#nav-cart-count'], '(\\d+)')}
${FRESH_EMPTY_STATE_FN}
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};

  // --- Selectors ---
  var CARD_A = '[data-csa-c-item-type="asin"]';
  var NAME_A = '.a-truncate-full.a-offscreen';
  var ATC_WRAPPER_A = '.qs-atc-plus';
  var ADD_BTN_A = 'button[aria-label^="Add to Cart,"]';
  var STEPPER_A = '[id^="qs-widget-stepper-"]';
  var QTY_DISPLAY_A = '.qs-widget-dropdown-flex-wrapper button[aria-label^="Current quantity"]';
  var INC_BTN_A = '.qs-widget-increment-button-flex-wrapper input[aria-label^="Add "]';

  var CARD_B = '[data-component-type="s-search-result"]';
  var ATC_CONTAINER_B = 'span[data-action="fresh-add-to-cart"]';
  var STEPPER_B = 'fieldset[data-a-component="stepper"]';
  var QTY_DISPLAY_B = 'span[data-a-selector="value"]';
  var INC_BTN_B = 'button[data-action="a-stepper-increment"]';
  // Mobile selectors (different DOM structure from desktop)
  var ATC_BTN_B_MOBILE = 'button[aria-label="Add to cart"]';
  var INC_BTN_B_MOBILE = 'span[data-action="qs-widget-increment-decl"]';

  // --- CRITICAL_WORDS scoring (matches HEB pattern) ---
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

  function isGarbageName(text) {
    if (/^\\$[\\d]/.test(text)) return true;
    if (/^estimated/i.test(text)) return true;
    if (/Overall Pick|Amazon.s Choice/i.test(text)) return true;
    if (/out of.*stars/i.test(text)) return true;
    if (/SNAP EBT/i.test(text)) return true;
    if (/^[\\d$.,\\s/()%]+(?:off|each|lb|oz|ounce|count|fl)/i.test(text)) return true;
    if (/Positively reviewed|Purchased often|Returned infrequently/i.test(text)) return true;
    if (/^See all details$/i.test(text)) return true;
    if (/^Quantity not updated/i.test(text)) return true;
    return false;
  }
  function getCardName(card) {
    if (card.matches(CARD_B)) {
      // Pick the product-title h2, skipping the quick-shop widget's status h2
      // (e.g. "Quantity not updated" inside .ax-qs__error) which would otherwise
      // be read as the brand and prepended to the real name.
      var h2 = null, __h2s = card.querySelectorAll('h2');
      for (var __hi = 0; __hi < __h2s.length; __hi++) {
        if (__h2s[__hi].closest('.ax-qs__error, .qs-atc-plus, [class*="qs-widget"]')) continue;
        h2 = __h2s[__hi]; break;
      }
      if (!h2 && __h2s.length) h2 = __h2s[0];
      var brandText = h2 ? h2.textContent.trim() : '';
      // 1. aria-label has full name on desktop
      if (h2) {
        var ariaLabel = h2.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim().length > 0) {
          return ariaLabel.trim().replace(/\\s+/g, ' ').replace(/^Sponsored Ad - /i, '');
        }
      }
      // 2. On mobile, h2 is just brand — find product title via ASIN links (filtered)
      var asin = card.getAttribute('data-asin');
      if (asin) {
        var productLinks = card.querySelectorAll('a[href*="' + asin + '"]');
        var bestTitle = '';
        for (var pi = 0; pi < productLinks.length; pi++) {
          if (productLinks[pi].querySelector('img')) continue;
          var pText = productLinks[pi].textContent.trim().replace(/\\s+/g, ' ');
          if (pText.toLowerCase() === brandText.toLowerCase()) continue;
          if (isGarbageName(pText)) continue;
          if (pText.length > bestTitle.length) bestTitle = pText;
        }
        if (bestTitle.length > 0) {
          var cleaned = bestTitle.replace(/^Sponsored Ad - /i, '');
          if (brandText.length > 0 && !cleaned.toLowerCase().startsWith(brandText.toLowerCase())) {
            cleaned = brandText + ', ' + cleaned;
          }
          return cleaned;
        }
      }
      // 3. Fallback: wrapping link text
      if (h2) {
        var link = h2.closest('a');
        if (link) {
          var t = link.textContent.trim().replace(/\\s+/g, ' ');
          if (t.length > 0) return t.replace(/^Sponsored Ad - /i, '');
        }
        // Fallback: combine h2 + next sibling text
        var parts = [h2.textContent.trim()];
        var sib = h2.nextElementSibling;
        while (sib && !sib.querySelector('.a-price') && !sib.textContent.match(/out of.*stars/i)) {
          var st = sib.textContent.trim();
          if (st.length > 0) parts.push(st);
          sib = sib.nextElementSibling;
        }
        return parts.join(', ').replace(/\\s+/g, ' ').replace(/^Sponsored Ad - /i, '');
      }
      return null;
    }
    var el = card.querySelector(NAME_A);
    if (!el) return null;
    return el.textContent.trim().replace(/\\s+/g, ' ');
  }

  function getQtyFromCard(card) {
    if (card.matches(CARD_B)) {
      // Desktop ATC container
      var atcContainer = card.querySelector(ATC_CONTAINER_B);
      if (atcContainer && !atcContainer.classList.contains('aok-hidden')) return 0;
      // Mobile ATC button
      var mobileAtc = card.querySelector(ATC_BTN_B_MOBILE);
      if (mobileAtc && !mobileAtc.closest('.aok-hidden')) return 0;
      var faceout = card.querySelector('.atc-faceout-container');
      if (faceout && faceout.hasAttribute('data-steppervalue')) {
        var sv = parseInt(faceout.getAttribute('data-steppervalue'), 10);
        if (!isNaN(sv)) return sv;
      }
      var stepper = card.querySelector(STEPPER_B);
      if (stepper) {
        var valueEl = stepper.querySelector(QTY_DISPLAY_B);
        if (valueEl) {
          var val = parseInt(valueEl.textContent.trim(), 10);
          if (!isNaN(val)) return val;
        }
      }
      if (atcContainer && atcContainer.classList.contains('aok-hidden')) return 1;
      return 0;
    }
    // Type A
    var stepperA = card.querySelector(STEPPER_A);
    if (!stepperA || stepperA.classList.contains('aok-hidden')) return 0;
    var qtyBtn = card.querySelector(QTY_DISPLAY_A);
    if (!qtyBtn) return 0;
    var m2 = (qtyBtn.getAttribute('aria-label') || '').match(/Current quantity (\\d+)/);
    return m2 ? parseInt(m2[1]) : 0;
  }

  async function waitForQtyToChange(card, prevQty, maxMs) {
    maxMs = maxMs || 6000;
    var poll = 100;
    for (var el = 0; el < maxMs; el += poll) {
      if (getQtyFromCard(card) !== prevQty) return true;
      await wait(poll);
    }
    return false;
  }

  async function waitForAddButtonB(card, maxMs) {
    maxMs = maxMs || 8000;
    card.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(300);
    var poll = 100;
    for (var el = 0; el < maxMs; el += poll) {
      // Desktop: span[data-action="fresh-add-to-cart"]
      var btn = card.querySelector(ATC_CONTAINER_B);
      if (btn && !btn.classList.contains('aok-hidden')) return btn;
      // Mobile: button[aria-label="Add to cart"]
      var mobileBtn = card.querySelector(ATC_BTN_B_MOBILE);
      if (mobileBtn) return mobileBtn;
      // New qs-widget layout — the "+" button (shared between initial-add and
      // stepper-increment). The card may hold two with the same aria-label;
      // prefer one that isn't aok-hidden and isn't visibly collapsed, but
      // fall back to the first match to preserve previously-working behavior.
      var plusBtns = card.querySelectorAll('button[aria-label^="Add to Cart. Click to change"]');
      for (var pi = 0; pi < plusBtns.length; pi++) {
        var p = plusBtns[pi];
        if (p.classList && p.classList.contains('aok-hidden')) continue;
        var rect = p.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return p;
      }
      if (plusBtns.length > 0) return plusBtns[0];
      await wait(poll);
    }
    return null;
  }

  function readNewLayoutQty(c) {
    // Primary: button[aria-label="Add to Cart"] with numeric text (qty display).
    var qtyBtn = c.querySelector('button[aria-label="Add to Cart"]');
    if (qtyBtn) {
      var n = parseInt(qtyBtn.textContent.trim(), 10);
      if (!isNaN(n)) return n;
    }
    // Fallback: qs-widget-button-decl span whose text content is a numeric
    // qty (this span is the visual qty display in the stepper UI).
    var spans = c.querySelectorAll('span[data-action="qs-widget-button-decl"]');
    for (var i = 0; i < spans.length; i++) {
      var txt = (spans[i].textContent || '').trim();
      if (/^\\d+$/.test(txt)) {
        var m = parseInt(txt, 10);
        if (!isNaN(m)) return m;
      }
    }
    return 0;
  }

  // For weight-based items (meat, produce) Amazon Fresh opens a bottom-sheet
  // modal after the "+" click asking for quantity, then requires clicking
  // "Add to Cart" inside the modal to commit. Regular items skip the modal.
  // baselineQty is the qty observed before the triggering click — the early
  // exit fires only when the click already moved the counter, not just because
  // the item already had qty in cart.
  async function confirmWeightModal(card, maxMs, baselineQty) {
    maxMs = maxMs || 2500;
    baselineQty = baselineQty || 0;
    var poll = 100;

    function modalIsVisible(elx) {
      if (!elx || elx.offsetParent === null) return false;
      if (elx.classList && elx.classList.contains('aok-hidden')) return false;
      var rect = elx.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // Give the modal a beat to render.
    await wait(300);

    var diagnosticEmitted = false;
    for (var el = 0; el < maxMs; el += poll) {
      // Item was added directly — qty advanced past the pre-click baseline.
      if (getQtyFromCard(card) > baselineQty) return false;
      if (readNewLayoutQty(card) > baselineQty) return false;

      // ── Strategy 1: any visible button with class containing "qs-widget-summary-atc"
      var qsBtns = Array.from(document.querySelectorAll('[class*="qs-widget-summary-atc"]')).filter(modalIsVisible);

      // ── Strategy 2: locate a "Select quantity" header, walk up to its modal container,
      //    then find the primary action button inside.
      var selQtyEl = null;
      var labeled = document.querySelectorAll('h1, h2, h3, h4, legend, span, div, p');
      for (var li = 0; li < labeled.length; li++) {
        var lEl = labeled[li];
        var lTxt = (lEl.textContent || '').trim();
        if (/^select quantity/i.test(lTxt) && lTxt.length < 60 && modalIsVisible(lEl)) {
          selQtyEl = lEl;
          break;
        }
      }
      var modalContainer = null;
      if (selQtyEl) {
        var anc = selQtyEl;
        for (var d = 0; d < 12 && anc && anc !== document.body; d++) {
          anc = anc.parentElement;
          if (!anc) break;
          if (anc.querySelector('button, input[type="submit"]')) {
            // walk one more level up to be sure we have the whole sheet
            modalContainer = anc.parentElement && anc.parentElement.querySelector('button')
              ? anc.parentElement : anc;
            break;
          }
        }
      }

      // ── Strategy 3: visible button/input with text "Add to Cart" or "Update Cart"
      //    that is NOT inside the source card (those are the "+" buttons we already clicked).
      var allCtrls = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      var addCartCtrls = allCtrls.filter(function(b) {
        if (!modalIsVisible(b)) return false;
        if (card.contains(b)) return false;
        var t = (b.textContent || b.value || '').trim().toLowerCase();
        return t === 'add to cart' || t === 'update cart' || t === 'add to cart!';
      });

      if (!diagnosticEmitted) {
        diagnosticEmitted = true;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'MODAL_DEBUG',
          phase: 'scan',
          qsBtnsCount: qsBtns.length,
          qsBtnsSample: qsBtns.slice(0, 3).map(function(b) {
            return { tag: b.tagName, text: (b.textContent || '').trim().slice(0, 40), cls: (b.className || '').slice(0, 100), aria: b.getAttribute('aria-label'), dataAction: b.getAttribute('data-action') };
          }),
          selQtyFound: !!selQtyEl,
          modalContainerTag: modalContainer ? modalContainer.tagName : null,
          modalContainerCls: modalContainer ? (modalContainer.className || '').slice(0, 100) : null,
          addCartCount: addCartCtrls.length,
          addCartSample: addCartCtrls.slice(0, 5).map(function(b) {
            return { tag: b.tagName, text: (b.textContent || b.value || '').trim().slice(0, 40), cls: (b.className || '').slice(0, 100), aria: b.getAttribute('aria-label'), dataAction: b.getAttribute('data-action'), parentCls: (b.parentElement && b.parentElement.className || '').slice(0, 80) };
          })
        }));
      }

      // Click priority: qs-class first (most specific), then modal-container primary, then text-match.
      var target = null;
      var via = null;
      if (qsBtns.length > 0) { target = qsBtns[0]; via = 'qs-class'; }
      if (!target && modalContainer) {
        var inModal = Array.from(modalContainer.querySelectorAll('button, input[type="submit"]')).filter(modalIsVisible);
        var primary = inModal.find(function(b) {
          var t = (b.textContent || b.value || '').trim().toLowerCase();
          return t === 'add to cart' || t === 'update cart';
        });
        if (primary) { target = primary; via = 'modal-text'; }
        else if (inModal.length > 0) { target = inModal[inModal.length - 1]; via = 'modal-last'; }
      }
      if (!target && addCartCtrls.length > 0) {
        target = addCartCtrls[0];
        via = 'doc-text';
      }

      if (target) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'MODAL_DEBUG', action: 'click', via: via,
          text: (target.textContent || target.value || '').trim().slice(0, 40),
          cls: (target.className || '').slice(0, 100)
        }));
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(150);
        target.click();
        await wait(1200);
        return true;
      }
      await wait(poll);
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MODAL_DEBUG', phase: 'timeout' }));
    return false;
  }

  async function waitForIncButton(card, maxMs) {
    maxMs = maxMs || 10000;
    var poll = 100;
    function incIsRendered(elx) {
      if (!elx) return false;
      if (elx.classList && elx.classList.contains('aok-hidden')) return false;
      var rect = elx.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    for (var el = 0; el < maxMs; el += poll) {
      var btn = null;
      if (card.matches(CARD_B)) {
        // Desktop: fieldset stepper
        var stepper = card.querySelector(STEPPER_B);
        btn = stepper ? stepper.querySelector(INC_BTN_B) : null;
        // Mobile / new layout: qs-widget-increment-decl wraps the actual
        // clickable (an <input type="submit"> with aria-label="Add"). Clicking
        // the wrapper <span> doesn't always trigger Amazon's declarative
        // handler, so dig in for the input. Prefer a rendered widget but fall
        // back to the first match to preserve prior behavior.
        if (!btn) {
          var incWidgets = card.querySelectorAll(INC_BTN_B_MOBILE);
          var chosen = null;
          for (var iw = 0; iw < incWidgets.length; iw++) {
            if (incIsRendered(incWidgets[iw])) { chosen = incWidgets[iw]; break; }
          }
          if (!chosen && incWidgets.length > 0) chosen = incWidgets[0];
          if (chosen) {
            btn = chosen.querySelector('input[type="submit"], button, input[aria-label]') || chosen;
          }
        }
        // Final fallback: the "+" button with aria-label "Add to Cart. Click
        // to change current quantity". Prefer a rendered one, fall back to
        // first match.
        if (!btn) {
          var plusBtns = card.querySelectorAll('button[aria-label^="Add to Cart. Click to change"]');
          for (var pi = 0; pi < plusBtns.length; pi++) {
            if (incIsRendered(plusBtns[pi])) { btn = plusBtns[pi]; break; }
          }
          if (!btn && plusBtns.length > 0) btn = plusBtns[0];
        }
      } else {
        var stepperA = card.querySelector(STEPPER_A);
        if (stepperA && !stepperA.classList.contains('aok-hidden')) {
          btn = card.querySelector(INC_BTN_A);
        }
      }
      if (btn) return btn;
      await wait(poll);
    }
    return null;
  }

  // On search pages, only use CARD_B to avoid carousel cards.
  var isSearchPage = window.location.pathname.startsWith('/s');
  var cardSelector = isSearchPage ? CARD_B : CARD_B + ', ' + CARD_A;

  // Poll for cards to render (Amazon lazy-loads).
  // Wait for first card, then give extra time for more to appear.
  var allCards = [];
  for (var poll = 0; poll < 20; poll++) {
    allCards = Array.from(document.querySelectorAll(cardSelector));
    if (allCards.length > 0) break;
    await wait(300);
  }
  if (allCards.length > 0 && allCards.length < 8) {
    await wait(1000);
    allCards = Array.from(document.querySelectorAll(cardSelector));
  }

  var candidates = [];
  var seen = new Set();
  var bestCard = null, bestName = null;

  for (var ci = 0; ci < allCards.length; ci++) {
    var card = allCards[ci];
    var name = getCardName(card);
    if (!name || name.length === 0 || seen.has(name)) continue;
    seen.add(name);

    var cardText = card.textContent || '';
    var oos = /out.of.stock|temporarily unavailable|currently unavailable|unavailable/i.test(cardText)
      || !!card.querySelector('[aria-label*="unavailable" i], [aria-label*="out of stock" i], [class*="unavailable"], [class*="out-of-stock"]');

    var imgEl = card.querySelector('img');
    candidates.push({ productName: name, imageUrl: imgEl ? imgEl.src : null, outOfStock: oos, preferences: null, price: null, isWeightItem: false });

    if (!bestName && scoreMatch(SEARCH_TERM, name) === 100 && !oos) {
      bestCard = card;
      bestName = name;
    }
    if (candidates.length >= 8) break;
  }

  if (!bestCard || !bestName) {
    // Log first card's DOM structure for debugging name extraction
    var debugCard = allCards[0];
    var debugInfo = null;
    if (debugCard) {
      var dh2 = debugCard.querySelector('h2');
      var dLink = dh2 ? dh2.closest('a') : null;
      var dParent = dh2 ? dh2.parentElement : null;
      var dSiblings = [];
      if (dParent) {
        for (var si = 0; si < dParent.children.length; si++) {
          var sch = dParent.children[si];
          dSiblings.push({ tag: sch.tagName, cls: sch.className.slice(0, 40), text: sch.textContent.trim().slice(0, 50) });
        }
      }
      debugInfo = {
        h2Text: dh2 ? dh2.textContent.trim().slice(0, 40) : null,
        h2AriaLabel: dh2 ? dh2.getAttribute('aria-label') : null,
        linkText: dLink ? dLink.textContent.trim().slice(0, 60) : null,
        parentTag: dParent ? dParent.tagName : null,
        parentCls: dParent ? dParent.className.slice(0, 60) : null,
        parentChildCount: dParent ? dParent.children.length : 0,
        siblings: dSiblings
      };
    }
    var hasExactOos = candidates.some(function(c) { return scoreMatch(SEARCH_TERM, c.productName) === 100 && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates, storeUnavailable: __freshEmptyState(), nameDebug: debugInfo }));
    return;
  }

  // Header cart count before adding — success is gated on it ticking up.
  var __cartBefore = __cartCount();

  try {
    // ── Type B: Search results ──────────────────────────────────────────────
    if (bestCard.matches(CARD_B)) {
      var addBtn = await waitForAddButtonB(bestCard);
      if (!addBtn) {
        // Log button DOM structure for debugging
        var allBtns = Array.from(bestCard.querySelectorAll('button, input[type="submit"], [role="button"]'));
        var btnDebug = allBtns.map(function(b) {
          return { tag: b.tagName, text: b.textContent.trim().slice(0, 40), ariaLabel: b.getAttribute('aria-label'), cls: b.className.slice(0, 50), dataAction: b.getAttribute('data-action') };
        });
        var atcSpans = Array.from(bestCard.querySelectorAll('[data-action]'));
        var spanDebug = atcSpans.map(function(s) {
          return { tag: s.tagName, dataAction: s.getAttribute('data-action'), cls: s.className.slice(0, 50), hidden: s.classList.contains('aok-hidden'), text: s.textContent.trim().slice(0, 30) };
        });
        var ct = bestCard.textContent || '';
        var oosB = /out.of.stock|temporarily unavailable|currently unavailable|unavailable/i.test(ct);
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: oosB ? 'out_of_stock' : 'no_button', candidates: candidates, btnDebug: btnDebug, spanDebug: spanDebug, bestName: bestName }));
        return;
      }
      var preAddQty = Math.max(getQtyFromCard(bestCard), readNewLayoutQty(bestCard));
      var __qtyBtn = bestCard.querySelector('button[aria-label="Add to Cart"]');
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'CART_DEBUG',
        where: 'searchAndAdd',
        preAddQty: preAddQty,
        qty: QTY,
        legacyQty: getQtyFromCard(bestCard),
        newLayoutQty: readNewLayoutQty(bestCard),
        qtyBtnPresent: !!__qtyBtn,
        qtyBtnText: __qtyBtn ? __qtyBtn.textContent.trim().slice(0, 20) : null,
        addBtnFound: !!addBtn,
        addBtnAria: addBtn ? addBtn.getAttribute('aria-label') : null,
        addBtnTag: addBtn ? addBtn.tagName : null,
      }));
      // When the cart already has this item, the addBtn opens a modal whose
      // qty selector pre-selects the current qty (commit = no-op). Skip
      // straight to QTY increments. When cart is empty, fall back to the
      // original flow: one addBtn (adds 1) then QTY-1 increments.
      var startQi = 1;
      if (preAddQty === 0) {
        addBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(200);
        addBtn.click();
        await wait(800);
        await confirmWeightModal(bestCard, 1500, preAddQty);
      } else {
        startQi = 0;
      }
      for (var qi = startQi; qi < QTY; qi++) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOOP_ITER', qi: qi, where: 'searchAndAdd' }));
        var preIncQty = Math.max(getQtyFromCard(bestCard), readNewLayoutQty(bestCard));
        var incBtn = await waitForIncButton(bestCard, 5000);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'WAIT_INC', qi: qi, foundIncBtn: !!incBtn, where: 'searchAndAdd' }));
        if (!incBtn) break;
        // Diagnostic: which element are we about to click and what's its context?
        var __parent = incBtn.parentElement;
        var __wrapper = incBtn.closest('[data-action]');
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'INC_DEBUG',
          qi: qi,
          preIncQty: preIncQty,
          tag: incBtn.tagName,
          aria: incBtn.getAttribute('aria-label'),
          cls: (incBtn.className || '').slice(0, 100),
          text: (incBtn.textContent || incBtn.value || '').trim().slice(0, 30),
          parentTag: __parent ? __parent.tagName : null,
          parentCls: __parent ? (__parent.className || '').slice(0, 80) : null,
          wrapperDataAction: __wrapper ? __wrapper.getAttribute('data-action') : null,
          wrapperCls: __wrapper ? (__wrapper.className || '').slice(0, 80) : null,
        }));
        incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(200);
        incBtn.click();
        await wait(800);
        await confirmWeightModal(bestCard, 1500, preIncQty);
        // Diagnostic: did the click advance qty or did it land us in a modal?
        var __postIncQty = Math.max(getQtyFromCard(bestCard), readNewLayoutQty(bestCard));
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'INC_RESULT',
          qi: qi,
          preIncQty: preIncQty,
          postIncQty: __postIncQty,
          advanced: __postIncQty > preIncQty,
        }));
      }
      var __committedB = await __waitForCartIncrease(__cartBefore, 50);
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify(__committedB
        ? { type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }
        : { type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'cart_not_incremented', productName: bestName, candidates: candidates }));
      return;
    }

    // ── Type A: Storefront carousel ─────────────────────────────────────────
    var currentQty = getQtyFromCard(bestCard);
    var quantityAdded = 0;

    if (currentQty === 0) {
      var addBtnA = null;
      var wrappers = bestCard.querySelectorAll(ATC_WRAPPER_A);
      for (var wi = 0; wi < wrappers.length; wi++) {
        if (!wrappers[wi].classList.contains('aok-hidden')) {
          addBtnA = wrappers[wi].querySelector(ADD_BTN_A);
          if (addBtnA) break;
        }
      }
      if (!addBtnA) addBtnA = bestCard.querySelector(ADD_BTN_A);

      if (!addBtnA) {
        var ct2 = bestCard.textContent || '';
        var oosA = /out.of.stock|temporarily unavailable|currently unavailable|unavailable/i.test(ct2);
        document.removeEventListener('focusin', __noKbd, true);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: oosA ? 'out_of_stock' : 'no_button', candidates: candidates }));
        return;
      }

      var qtyBefore = getQtyFromCard(bestCard);
      addBtnA.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      addBtnA.click();
      await waitForQtyToChange(bestCard, qtyBefore);
      quantityAdded = 1;
    }

    while (quantityAdded < QTY) {
      var incBtn = await waitForIncButton(bestCard);
      if (!incBtn) break;
      var qtyBefore3 = getQtyFromCard(bestCard);
      incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      incBtn.click();
      await waitForQtyToChange(bestCard, qtyBefore3);
      quantityAdded++;
    }

    var __committedA = await __waitForCartIncrease(__cartBefore, 50);
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify(__committedA
      ? { type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }
      : { type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'cart_not_incremented', productName: bestName, candidates: candidates }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates, storeUnavailable: __freshEmptyState() }));
  }
})();true;`;
}

// ── Export ────────────────────────────────────────────────────────────────────

export function getScripts() {
  return {
    storeUrl: AMAZON_URL,
    loginUrl: AMAZON_LOGIN_URL,
    cartUrl: AMAZON_CART_URL,
    // The Amazon Shopping app's URL-carrying scheme opens the cart inside the app.
    // handleOpenCart tries this first, then falls back to the https cartUrl in the
    // browser if the app isn't installed. (Bare amazon:// / amzn:// don't work.)
    appScheme: 'com.amazon.mobile.shopping.web://amazon.com/gp/cart/view.html',
    domain: AMAZON_DOMAIN,
    isSearchUrl: (url: string) => url.includes('/s?') && url.includes('amazon.com'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('amazon.com') && !url.includes('/ap/') && !url.includes('/ax/') && !url.includes('openid.'),
    checkLoginScript: CHECK_LOGIN_SCRIPT,
    extractProductsScript: EXTRACT_PRODUCTS_SCRIPT,
    buildAddToCartScript,
    buildSearchScript,
    buildSearchAndAddScript,
    getSearchUrl: (term: string) => 'https://www.amazon.com/s?k=' + encodeURIComponent(term) + '&i=amazonfresh',
    buildWorkerScript: (workerId: number) => buildExtractWorker(workerId, EXTRACT_PRODUCTS_SCRIPT),
  };
}
