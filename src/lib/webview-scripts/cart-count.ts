// Cart-count snapshot scripts.
//
// Reads the store's header cart badge from the CURRENT page and posts
// { type: 'CART_COUNT', count: number | null }. Used by WebViewCartSheet to
// snapshot the cart before and after an add-to-cart run and warn when the
// cart delta is short of what was reported added (silent-miss detection).
//
// count === null means "badge not found / unparseable" — callers must treat
// that as unknown and SKIP validation, never warn.
//
// Every selector below was verified against captured fixture HTML
// (tests/fixtures/<store>/search-results-tortillas.html), per the
// don't-guess rule:
//   heb        aria-label="Go to Cart page. 2 items in your cart. $9.93"
//   walmart    aria-label="Cart contains 4 items Total Amount $13.33"
//   aldi       aria-label="View Cart. Items in cart: 6, View cart"
//   wegmans    aria-label="View 2 selected items in my Cart"
//   amazon     <span id="nav-cart-count">4</span>
//   albertsons [data-qa="hdr-crt-txt-plus"] exists but renders its count
//              client-side (empty in the static capture) — BEST EFFORT,
//              needs live verification on a device before trusting it.
//
// NOTE (Stephen): ALDI's cart UI is a side panel, but the COUNT badge above
// lives in the header of every store page, so no cart navigation is needed.

import { ALBERTSONS_FAMILY_IDS, getAlbertsonsCartPageUrl } from './albertsons';
import { MOCK_STORE_URL } from './mockstore';

interface CountExtractor {
  /** querySelector for the badge element. */
  sel: string;
  /** Where the count text lives. */
  from: 'aria' | 'text';
  /** Capture-group-1 regex applied to the source text. Omitted = the text
   *  itself must be a bare integer. */
  re?: string;
}

const EXTRACTORS: Record<string, CountExtractor> = {
  heb: { sel: '[aria-label*="items in your cart"]', from: 'aria', re: '(\\d+)\\s+items? in your cart' },
  walmart: { sel: '[aria-label^="Cart contains"]', from: 'aria', re: 'Cart contains (\\d+) item' },
  aldi: { sel: '[aria-label*="Items in cart:"]', from: 'aria', re: 'Items in cart:\\s*(\\d+)' },
  wegmans: { sel: '[aria-label*="selected items in my Cart"]', from: 'aria', re: '(\\d+) selected item' },
  amazon: { sel: '#nav-cart-count', from: 'text' },
  albertsons: { sel: '[data-qa="hdr-crt-txt-plus"]', from: 'text' },
};

function extractorFor(storeId: string): CountExtractor | null {
  if (EXTRACTORS[storeId]) return EXTRACTORS[storeId];
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return EXTRACTORS.albertsons;
  return null;
}

// ── Cart-PAGE counting (for stores whose header badge is unreliable) ───────────
//
// HEB's header badge is page/UA-dependent: under the app's mobile UA the header
// omits the desktop "N items in your cart" aria-label, and an empty cart has no
// badge at all, so the badge read returns null and validation silently skips.
// Instead, navigate to the store's cart page and count line-item quantities
// there — authoritative and independent of which page we're on.
//
// Selectors verified against tests/fixtures/heb/cart-with-items.html:
//   itemRow                  one per cart line item
//   cartQuantityCounterValue <input value="N"> — the unit qty for that line
const CART_PAGE_URL: Record<string, string> = {
  heb: 'https://www.heb.com/cart',
  walmart: 'https://www.walmart.com/cart',
  wegmans: 'https://www.wegmans.com/cart',
  mockstore: MOCK_STORE_URL + '/cart',   // dev/test only
};

/** The cart-page URL for stores that count via the cart page, else null. */
export function getCartPageUrl(storeId: string): string | null {
  if (CART_PAGE_URL[storeId]) return CART_PAGE_URL[storeId];
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return getAlbertsonsCartPageUrl(storeId);
  return null;
}

export interface CartItem {
  name: string;
  qty: number;
}

export interface CartRow {
  name: string;
  qty: number;
  /** true = added by this run (green +), false = already in the cart (grey). */
  added: boolean;
}

/**
 * Diff a before/after cart snapshot into display rows for the done screen.
 * The portion of each product that was already in the cart is an "already
 * there" (grey) row; any quantity this run added is an "added" (green +) row.
 * A product whose qty rose yields BOTH a grey row (pre-existing qty) and a
 * green row (added qty). Added rows are listed first. Items that left the cart
 * during the run are omitted.
 */
function cartTokens(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Lenient match between a store cart title and a product name Mealio added.
 *  True when most of the reported name's tokens appear in the cart name (or
 *  vice versa) — tolerant of weight/size suffixes and minor title differences. */
export function cartNameMatches(cartName: string, reportedName: string): boolean {
  const ct = cartTokens(cartName);
  const rt = cartTokens(reportedName);
  if (rt.length === 0 || ct.length === 0) return false;
  const cset = new Set(ct);
  const overlap = rt.filter((t) => cset.has(t)).length;
  return overlap / rt.length >= 0.6;
}

/**
 * Given the product names Mealio reported as successfully added and the names
 * of the items that ACTUALLY appeared as new in the cart, return the reported
 * names with no matching cart item — i.e. the ones that silently failed to add.
 */
export function findUnaddedItems(reportedAdded: string[], addedCartNames: string[]): string[] {
  return reportedAdded.filter(
    (rn) => !addedCartNames.some((cn) => cartNameMatches(cn, rn)),
  );
}

export function diffCartItems(before: CartItem[], after: CartItem[]): CartRow[] {
  const beforeQty = new Map<string, number>();
  for (const it of before) beforeQty.set(it.name, (beforeQty.get(it.name) || 0) + it.qty);
  const green: CartRow[] = [];
  const grey: CartRow[] = [];
  for (const it of after) {
    const bq = beforeQty.get(it.name) || 0;
    const greyQty = Math.min(bq, it.qty);
    const greenQty = Math.max(it.qty - bq, 0);
    if (greenQty > 0) green.push({ name: it.name, qty: greenQty, added: true });
    if (greyQty > 0) grey.push({ name: it.name, qty: greyQty, added: false });
  }
  return [...green, ...grey];
}

/**
 * Script that reads the store's already-loaded cart page and posts
 * { type: 'CART_COUNT', count, items: [{ name, qty }] }. `count` is the total
 * unit count (silent-miss detection); `items` is the per-line breakdown used to
 * render the done screen (added vs already-in-cart). Caller must navigate to
 * getCartPageUrl(storeId) first and inject this on the cart page's load.
 * Returns null for stores that don't use cart-page counting.
 *
 * count is 0 / items is [] for a genuinely empty cart (no item rows on a loaded
 * /cart page); the caller only reaches this after onLoadEnd confirmed the cart
 * URL and that the page wasn't an anti-bot block, so 0 rows means empty.
 */
export function buildCartPageCountScript(storeId: string): string | null {
  if (storeId === 'heb') return HEB_CART_PAGE_SCRIPT;
  if (storeId === 'walmart') return WALMART_CART_PAGE_SCRIPT;
  if (storeId === 'wegmans') return WEGMANS_CART_PAGE_SCRIPT;
  if (storeId === 'amazon') return AMAZON_CART_PAGE_SCRIPT;
  if (storeId === 'mockstore') return MOCKSTORE_CART_PAGE_SCRIPT;
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return ALBERTSONS_CART_PAGE_SCRIPT;
  return null;
}

// Mock store /cart (dev/test only). Each line is .mock-cart-line[data-name] with
// a .mock-cart-name and .mock-cart-qty. Deterministic DOM, so no hydration race.
const MOCKSTORE_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  var lines = [];
  for (var i = 0; i < 20; i++) {
    lines = Array.prototype.slice.call(document.querySelectorAll('.mock-cart-line'));
    if (lines.length > 0 || document.querySelector('#mock-cart-lines[data-count="0"]')) break;
    await wait(150);
  }
  var count = 0, items = [];
  for (var j = 0; j < lines.length; j++) {
    var nmEl = lines[j].querySelector('.mock-cart-name');
    var nm = nmEl ? norm(nmEl.textContent) : '';
    if (!nm) continue;
    var qEl = lines[j].querySelector('.mock-cart-qty');
    var q = parseInt(qEl ? norm(qEl.textContent) : '0', 10);
    if (isNaN(q) || q < 1) q = 1;
    count += q;
    items.push({ name: nm, qty: q });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items }));
})(); true;`;

// Wegmans /cart line items: each item's stepper "Add" button carries both the
// name and the current qty in its aria-label —
//   "Add 1 ea to 2 ea of <name> in the cart"
// The page is mostly recommendation tiles whose buttons say "... of <name> to
// cart" (NOT "in the cart"), so the "in the cart" + "to N ea" pattern cleanly
// isolates real cart lines. The Remove button ("Remove 1 ea from N ea of ...")
// matches "from N ea", not "to N ea", so each line yields exactly one match.
// Verified against tests/fixtures/wegmans/cart-with-items.html (1 item, qty 2).
const WEGMANS_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function norm(s){return (s||'').trim().replace(/\\s+/g,' ');}
  var ITEM_RE = /to (\\d+) ea of (.+?) in the cart/i;
  // Poll for cart line items (each increment button names item + current qty).
  var btns = [];
  for (var i=0;i<25;i++){
    btns = Array.prototype.slice.call(document.querySelectorAll('[aria-label*="in the cart"]'))
      .filter(function(b){ return ITEM_RE.test(b.getAttribute('aria-label')||''); });
    if (btns.length>0) break;
    await wait(200);
  }
  var count=0, items=[], seen={};
  for (var j=0;j<btns.length;j++){
    var m = (btns[j].getAttribute('aria-label')||'').match(ITEM_RE);
    if (!m) continue;
    var qty = parseInt(m[1],10); if (isNaN(qty)||qty<1) qty=1;
    var name = norm(m[2]);
    if (!name || seen[name]) continue;
    seen[name]=true;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type:'CART_COUNT', count: count, items: items }));
})(); true;`;

// Walmart /cart line items: each adjustable item has a [data-testid="quantity-label"]
// (the qty number) and a [data-testid="productName"] (the title). There's no
// shared per-row testid, so anchor on the quantity-label (only real in-cart items
// have a stepper — recommendation/OOS carousels don't) and walk up to the
// item-scoped product name. The single-productName guard avoids over-shooting to
// an ancestor that spans multiple items.
// Verified against tests/fixtures/walmart/cart-with-items.html (4 items).
const WALMART_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function norm(s){return (s||'').trim().replace(/\\s+/g,' ');}
  // Poll for line items (each has a quantity-label) to hydrate.
  var labels = [];
  for (var i=0;i<25;i++){
    labels = Array.prototype.slice.call(document.querySelectorAll('[data-testid="quantity-label"]'));
    if (labels.length>0) break;
    await wait(200);
  }
  function nameFor(label){
    var node = label;
    for (var d=0; d<10 && node; d++){
      var all = node.querySelectorAll ? node.querySelectorAll('[data-testid="productName"]') : [];
      if (all.length === 1) return norm(all[0].textContent);
      if (all.length > 1) return '';   // overshot — ancestor spans multiple items
      node = node.parentElement;
    }
    return '';
  }
  var count=0, items=[], seen={};
  for (var j=0;j<labels.length;j++){
    var qty = parseInt(norm(labels[j].textContent), 10);
    if (isNaN(qty) || qty < 1) qty = 1;
    var name = nameFor(labels[j]);
    if (!name || seen[name]) continue;
    seen[name] = true;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type:'CART_COUNT', count: count, items: items }));
})(); true;`;

// Amazon Fresh has no reliable direct cart URL: tapping the cart icon lands on
// the "cart of carts" page, from which the Amazon Fresh cart must be expanded
// before its line items render. This script handles BOTH pages:
//   • Expanded Fresh cart: each line item is a div.sc-list-item[data-quantity]
//     carrying the unit qty, holding a "Delete <name>" button (the product
//     name). The page renders responsive duplicates, so dedupe by data-itemid.
//   • Cart-of-carts: no line-item cards yet — click the Amazon Fresh expand
//     link (href contains cart_expand_link_fresh / /cart/localmarket) ONCE to
//     navigate to the expanded cart, after which onLoadEnd re-injects this
//     script.
// Verified against tests/fixtures/amazon-fresh/cart-fresh-full.html (Perdue
// Portions x2, Daisy x2, Mission x1, Perdue Harvestland x2 = 7) and the
// collapsed cart-with-items.html (0 cards, expand link present).
const AMAZON_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  function lineItemCards() {
    return Array.prototype.slice.call(
      document.querySelectorAll('div.sc-list-item[data-quantity]')
    );
  }
  // Poll for the expanded Fresh cart's line-item cards to render.
  var cards = [];
  for (var i = 0; i < 25; i++) {
    cards = lineItemCards();
    if (cards.length > 0) break;
    await wait(200);
  }
  // No line items: we're on the cart-of-carts page. Expand the Fresh cart once
  // (guard against navigation loops), then let onLoadEnd re-inject this script.
  if (cards.length === 0) {
    var expand = document.querySelector(
      'a[href*="cart_expand_link_fresh"], a[href*="/cart/localmarket"]'
    );
    if (expand && !window.__mealioFreshExpanded) {
      window.__mealioFreshExpanded = true;
      var href = expand.getAttribute('href') || '';
      try { expand.click(); } catch (e) {}
      // Fall back to a hard navigation if the click didn't move us.
      if (href) { window.location.href = href; }
      return;
    }
  }
  var count = 0;
  var items = [];
  var seen = {};
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var id = card.getAttribute('data-itemid') || ('idx' + c);
    if (seen[id]) continue;
    seen[id] = true;
    var del = card.querySelector('[aria-label^="Delete "]');
    var al = del ? (del.getAttribute('aria-label') || '') : '';
    var name = norm(al.replace(/^Delete\\s+/i, ''));
    if (!name) continue;
    var qty = parseInt(card.getAttribute('data-quantity'), 10);
    if (!qty || isNaN(qty)) qty = 1;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  // Report the URL we actually counted on so the sheet can cache it and hit the
  // expanded Fresh cart directly for the after-snapshot (skipping the cart-icon
  // → cart-of-carts → expand-link hops).
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items, url: location.href }));
})(); true;`;

// Amazon Fresh cart icon: a#nav-button-cart (href /gp/aw/c?ref_=navm_hdr_cart)
// wraps the #nav-cart-count badge and sits in the header of every store page.
// Verified against tests/fixtures/amazon-fresh/search-results-tortillas.html.
const AMAZON_OPEN_CART_SCRIPT = `(function() {
  var icon = document.querySelector('#nav-button-cart')
    || document.querySelector('a[href*="navm_hdr_cart"]');
  if (!icon) {
    var badge = document.querySelector('#nav-cart-count');
    if (badge && badge.closest) icon = badge.closest('a');
  }
  if (icon) {
    var href = icon.getAttribute('href') || '';
    try { icon.click(); } catch (e) {}
    if (href) { window.location.href = href; }
  }
})(); true;`;

/**
 * Some stores have no reliable direct cart URL (e.g. Amazon Fresh gates direct
 * /cart loads). For those, this returns a script that CLICKS the in-page cart
 * icon to navigate to the cart, after which the cart-page count script is
 * injected on the resulting page load. Returns null for URL-based stores.
 */
export function buildOpenCartScript(storeId: string): string | null {
  if (storeId === 'amazon') return AMAZON_OPEN_CART_SCRIPT;
  return null;
}

// ALDI (Instacart) has NO dedicated cart page — the cart is an in-page side
// panel ([role="dialog"][aria-label="Cart"]) opened from the floating cart
// button. There's no navigation, so unlike HEB (URL) / Amazon (click→navigate)
// this script does the whole thing in one injected pass: open the panel (if
// closed), read each line item, post CART_COUNT, then close the panel so it
// doesn't cover the search bar for the next step. Per line item:
//   • name: the "Increment quantity of <name>" button's aria-label (minus the
//           prefix). Live ALDI line items have NO "Remove" button — only the
//           increment/decrement stepper — so the increment button is the anchor.
//   • qty:  the stepper's "Quantity: N" text (walk up from the increment button)
const ALDI_CART_PANEL_SCRIPT = `(async function() {
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function norm(s){return (s||'').trim().replace(/\\s+/g,' ');}

  // The cart opener: floating button, or the header "View Cart. Items in cart: N"
  // button (same element the header-badge count reads).
  var OPEN_SEL = '[data-testid="floating-cart-button"], button[aria-label^="View Cart"], button[aria-label*="Items in cart"]';
  // Each cart line item carries an "Increment quantity of <name>" button. Scope
  // detection to the dialog/overlay that contains them so we don't pick up the
  // increment buttons on search-result tiles (products already in the cart).
  var INC_SEL = 'button[aria-label^="Increment quantity of "]';

  // The opened cart's aria-label may differ from the empty placeholder's exact
  // "Cart", so don't match on label — find the FIRST [role=dialog] that actually
  // contains item rows (increment buttons).
  function cartItemBtns(){
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i=0;i<dialogs.length;i++){
      var b = dialogs[i].querySelectorAll(INC_SEL);
      if (b.length>0) return Array.prototype.slice.call(b);
    }
    return [];
  }

  // Detect FIRST (so we don't click an already-open panel shut). Only click the
  // opener when no populated cart is visible.
  var incBtns = cartItemBtns();
  if (incBtns.length === 0) {
    var opener = document.querySelector(OPEN_SEL);
    if (opener) { try { opener.click(); } catch(e){} }
  }
  // Poll for the panel's line items to render (up to ~6s).
  for (var j=0;j<30 && incBtns.length===0;j++){
    await wait(200);
    incBtns = cartItemBtns();
  }

  // Stepper qty for a row: walk up from the increment button to the container
  // that shows "Quantity: N" (bounded so we don't capture the whole panel / the
  // package descriptor like "(1 ct)" in the product name).
  function qtyForRow(btn){
    var node = btn;
    for (var d=0; d<5 && node; d++){
      var m = (node.textContent || '').match(/quantity:\\s*(\\d+)/i);
      if (m) return parseInt(m[1],10) || 1;
      node = node.parentElement;
    }
    return 1;
  }

  var count = 0, items = [], seen = {};
  for (var k=0;k<incBtns.length;k++){
    var name = norm((incBtns[k].getAttribute('aria-label')||'').replace(/^Increment quantity of\\s+/i,''));
    if (!name || seen[name]) continue;
    seen[name] = true;
    var qty = qtyForRow(incBtns[k]);
    count += qty;
    items.push({ name: name, qty: qty });
  }

  // Close the panel so it doesn't block the next search.
  try {
    var closeBtn = document.querySelector('[data-testid="cart-close-button"]');
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true}));
  } catch(e){}

  window.ReactNativeWebView.postMessage(JSON.stringify({ type:'CART_COUNT', count: count, items: items }));
})(); true;`;

/**
 * Stores whose cart is an in-page side panel (no dedicated URL, no navigation):
 * returns a single self-contained script that opens the panel, counts line
 * items, posts CART_COUNT { count, items:[{name,qty}] }, and closes the panel.
 * Inject it DIRECTLY (not via the nav/onLoadEnd chain). Null for other stores.
 */
export function buildInlineCartScript(storeId: string): string | null {
  if (storeId === 'aldi') return ALDI_CART_PANEL_SCRIPT;
  return null;
}

const HEB_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  // Poll briefly for item rows to render (HEB hydrates the cart client-side).
  var rows = [];
  for (var i = 0; i < 20; i++) {
    rows = Array.prototype.slice.call(document.querySelectorAll('[data-qe-id="itemRow"]'));
    if (rows.length > 0) break;
    await wait(200);
  }
  var count = 0;
  var items = [];
  for (var j = 0; j < rows.length; j++) {
    var inp = rows[j].querySelector('[data-qe-id="cartQuantityCounterValue"]');
    var raw = inp ? (inp.value || inp.getAttribute('value') || '0') : '0';
    var v = parseInt(raw, 10);
    if (isNaN(v)) v = 0;
    count += v;
    var nameEl = rows[j].querySelector('[data-qe-id="itemRowDetailsName"]');
    var nm = nameEl ? (nameEl.textContent || '').trim().replace(/\\s+/g, ' ') : '';
    if (nm) items.push({ name: nm, qty: v });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items }));
})(); true;`;

// Albertsons family /erums/cart (Angular app). Each line item is an
// <app-cart-item> holding a.product-name (name + product id in the href) and a
// quantity stepper whose decrease-button id encodes the qty (fcdecBtn<pid>-<qty>),
// mirrored by the visible .stepper-qty text. The page renders each item twice
// (responsive desktop/mobile), so dedupe by product id. Verified against
// tests/fixtures/albertsons/cart-with-items.html (Basmati x2, Hunt's x1).
const ALBERTSONS_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  // Poll for cart line items to hydrate.
  var links = [];
  for (var i = 0; i < 25; i++) {
    links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/shop/product-details."]'));
    if (links.length > 0) break;
    await wait(200);
  }
  var count = 0;
  var items = [];
  var seen = {};
  for (var j = 0; j < links.length; j++) {
    var link = links[j];
    var href = link.getAttribute('href') || '';
    var pm = href.match(/product-details\\.(\\d+)\\.html/);
    if (!pm) continue;
    var pid = pm[1];
    if (seen[pid]) continue;
    var name = norm(link.textContent) || norm(link.getAttribute('aria-label'));
    if (!name) continue;
    // qty: prefer the visible stepper text, else parse the decrease-button id suffix.
    var qty = 0;
    // Real qty lives in the cart-qty display text ("N - click to specify a
    // quantity"). Do NOT use the stepper button id suffix (fcdecBtn<pid>-N) —
    // that N is the row index, not the quantity.
    var qEls = document.querySelectorAll(
      '[id^="cartQty' + pid + '"], [id="normal' + pid + '"], [id^="rounded-cartQty' + pid + '"]'
    );
    for (var qi = 0; qi < qEls.length; qi++) {
      var qmt = (qEls[qi].textContent || '').match(/\\d+/);
      if (qmt) { qty = parseInt(qmt[0], 10); break; }
    }
    if (!qty) qty = 1;
    seen[pid] = true;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items }));
})(); true;`;

/**
 * Returns an injectable script that posts CART_COUNT for this store, or null
 * when the store has no verified badge extractor (callers skip snapshots).
 * Polls up to 3s for the badge so a just-updated header can settle.
 */
export function buildCartCountScript(storeId: string): string | null {
  const ex = extractorFor(storeId);
  if (!ex) return null;
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var SEL = ${JSON.stringify(ex.sel)};
  var FROM = ${JSON.stringify(ex.from)};
  var RE = ${ex.re ? JSON.stringify(ex.re) : 'null'};
  var el = null;
  for (var i = 0; i < 15; i++) {
    el = document.querySelector(SEL);
    if (el) break;
    await wait(200);
  }
  var count = null;
  if (el) {
    var src = FROM === 'aria' ? (el.getAttribute('aria-label') || '') : (el.textContent || '');
    if (RE) {
      var m = src.match(new RegExp(RE));
      if (m) count = parseInt(m[1], 10);
    } else {
      var m2 = src.trim().match(/^(\\d+)$/);
      if (m2) count = parseInt(m2[1], 10);
    }
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count }));
})(); true;`;
}
