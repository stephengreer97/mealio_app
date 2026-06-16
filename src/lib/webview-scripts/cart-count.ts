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
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return ALBERTSONS_CART_PAGE_SCRIPT;
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
    var qEl = document.querySelector('[id^="check' + pid + '-"]');
    if (qEl) { var qmt = (qEl.textContent || '').match(/\\d+/); if (qmt) qty = parseInt(qmt[0], 10); }
    if (!qty) {
      var dec = document.querySelector('[id^="fcdecBtn' + pid + '-"]');
      if (dec) { var dm = dec.id.match(/-(\\d+)$/); if (dm) qty = parseInt(dm[1], 10); }
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
