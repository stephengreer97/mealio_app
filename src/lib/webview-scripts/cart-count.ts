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
//   instacart  aria-label="View Cart. Items in cart: 6, View cart"  (seen on ALDI)
//   wegmans    aria-label="View 2 selected items in my Cart"
//   amazon     <span id="nav-cart-count">4</span>
//   albertsons [data-qa="hdr-crt-txt-plus"] exists but renders its count
//              client-side (empty in the static capture) — BEST EFFORT,
//              needs live verification on a device before trusting it.
//
// NOTE (Stephen): Instacart's cart UI is a side panel, but the COUNT badge
// above lives in the header of every store page, so no cart navigation is
// needed. Both are keyed to the PLATFORM here — every banner in
// INSTACART_TENANTS shares them — rather than to ALDI, which is merely the
// tenant they were first read off.

import { ALBERTSONS_FAMILY_IDS, getAlbertsonsCartPageUrl } from './albertsons';
import { isInstacartStore } from './instacart';
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
  // Instacart Storefront renders one header badge for every banner it hosts, so
  // this is keyed to the PLATFORM, not to ALDI (where it was first observed).
  // extractorFor() routes each registered tenant here.
  instacart: { sel: '[aria-label*="Items in cart:"]', from: 'aria', re: 'Items in cart:\\s*(\\d+)' },
  wegmans: { sel: '[aria-label*="selected items in my Cart"]', from: 'aria', re: '(\\d+) selected item' },
  amazon: { sel: '#nav-cart-count', from: 'text' },
  albertsons: { sel: '[data-qa="hdr-crt-txt-plus"]', from: 'text' },
};

function extractorFor(storeId: string): CountExtractor | null {
  if (EXTRACTORS[storeId]) return EXTRACTORS[storeId];
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) return EXTRACTORS.albertsons;
  // Platform families before the null: a banner with no entry of its own gets
  // its platform's badge rather than a silent "count unknown", which reads as
  // "skip validation" and takes the whole silent-miss check offline.
  if (isInstacartStore(storeId)) return EXTRACTORS.instacart;
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
  /** Sold-by-weight line (HEB Deli / Fish Market / bulk). qty is 1 (present);
   *  weight carries the lb amount. Reconciled by presence, not discrete count. */
  isWeight?: boolean;
  weight?: number;
}

export interface CartRow {
  name: string;
  qty: number;
  /** true = added by this run (green +), false = already in the cart (grey). */
  added: boolean;
  isWeight?: boolean;
  weight?: number;
}

/**
 * Diff a before/after cart snapshot into display rows for the done screen.
 * The portion of each product that was already in the cart is an "already
 * there" (grey) row; any quantity this run added is an "added" (green +) row.
 * A product whose qty rose yields BOTH a grey row (pre-existing qty) and a
 * green row (added qty). Added rows are listed first. Items that left the cart
 * during the run are omitted.
 */
// Store cart pages sometimes emit product titles with HTML entities left
// literal (e.g. a double-encoded "Chobani&reg;" whose text node is the string
// "Chobani&reg;", not "Chobani®"). Left as-is they show as "&reg;" on the done
// screen AND poison name matching (the entity tokenizes to a spurious "reg"
// word). Decode the common ones plus any numeric entity. No DOM here (this runs
// in RN as well as in-page), so it's a small explicit map.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  reg: '®', trade: '™', copy: '©', deg: '°', hellip: '…',
  mdash: '—', ndash: '–', minus: '−', times: '×', frac12: '½', frac14: '¼', frac34: '¾',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è',
};
export function decodeHtmlEntities(s: string): string {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit !== undefined ? hit : m;
  });
}

function cartTokens(s: string): string[] {
  return decodeHtmlEntities(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Entity- and punctuation-insensitive normalization for EXACT name comparison.
 *  "McCormick Gourmet, Organic…" and "McCormick Gourmet Organic…" collapse to the
 *  same string so a product reliably matches its own cart row before a loosely
 *  similar sibling can. */
export function normalizeName(s: string): string {
  return decodeHtmlEntities(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
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

export interface ShortAdd {
  name: string;
  /** Units this run actually added to the cart. */
  got: number;
  /** Units that were requested. */
  expected: number;
}

/**
 * Audit added cart quantities against what was requested and return the items
 * that landed SHORT — present in the cart but with fewer units than asked for
 * (e.g. a store per-item cap accepted 2 of 3). Fully-missing items (got 0) are
 * excluded here; they're covered by findUnaddedItems.
 *
 * `addedRows` are the added (green) rows from diffCartItems, whose `qty` is the
 * delta this run added. Each added unit is attributed to a SINGLE audited item
 * via a shared pool — exact-name matches reserved first, then loose matches take
 * whatever remains — so two near-identical product names can't both claim the
 * same row and hide a shortfall. Callers should pass only count-comparable items
 * (skip sold-by-weight lines, which are one row at N lb regardless of poundage).
 */
export function findShortAddedItems(
  addedRows: CartRow[],
  audit: { name: string; expectedQty: number }[],
): ShortAdd[] {
  const pool = addedRows.map((row) => ({ name: row.name, qty: row.qty }));
  const claimQty = (reportedName: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of pool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly ? normalizeName(row.name) === normalizeName(reportedName) : cartNameMatches(row.name, reportedName);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };
  const state = audit.map((a) => ({ name: a.name, expected: Math.max(1, a.expectedQty || 1), got: 0 }));
  // Pass 1 reserves exact-name units for every item; pass 2 lets those still
  // short take remaining loose matches, so a loose match can't steal units an
  // exact match needed.
  state.forEach((s) => { s.got = claimQty(s.name, s.expected, true); });
  state.forEach((s) => { if (s.got < s.expected) s.got += claimQty(s.name, s.expected - s.got, false); });
  return state
    .filter((s) => s.got > 0 && s.got < s.expected)
    .map((s) => ({ name: s.name, got: s.got, expected: s.expected }));
}

/**
 * Units that landed in the cart this run that NO intended item accounts for —
 * over-adds (a product added more times than requested) or an entirely
 * unintended product. A safety net: even if a future bug re-adds something, the
 * cart check surfaces it rather than trusting the run silently.
 *
 * Each intended item claims matching added units first (exact name, then loose,
 * capped at its expected qty); whatever added units remain unclaimed are the
 * overage. Weight lines are presence-based (one row regardless of poundage), so
 * an intended weight item consumes at most one matching weight row.
 */
export function findOverAddedItems(
  addedRows: CartRow[],
  intended: { name: string; expectedQty: number; isWeight?: boolean }[],
): { name: string; qty: number }[] {
  const countPool = addedRows.filter((r) => !r.isWeight).map((r) => ({ name: r.name, qty: r.qty }));
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
  const claim = (name: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of countPool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly ? normalizeName(row.name) === normalizeName(name) : cartNameMatches(row.name, name);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };
  // Weight items consume one matching weight row by presence.
  for (const it of intended.filter((i) => i.isWeight)) {
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, it.name));
    if (w) w.used = true;
  }
  // Count items: exact pass then loose pass, capped at each item's expected qty,
  // so a legitimately-requested unit never counts as overage.
  const need = intended.filter((i) => !i.isWeight).map((i) => ({ name: i.name, left: Math.max(1, i.expectedQty || 1) }));
  need.forEach((n) => { n.left -= claim(n.name, n.left, true); });
  need.forEach((n) => { if (n.left > 0) n.left -= claim(n.name, n.left, false); });
  const over: { name: string; qty: number }[] = [];
  for (const row of countPool) if (row.qty > 0) over.push({ name: row.name, qty: row.qty });
  for (const w of weightPool) if (!w.used) over.push({ name: w.name, qty: 1 });
  return over;
}

export function diffCartItems(beforeRaw: CartItem[], afterRaw: CartItem[]): CartRow[] {
  // Decode HTML entities up front so both the qty matching (by name) and the
  // rendered rows use clean titles ("Chobani®", not "Chobani&reg;").
  const before = beforeRaw.map((it) => ({ ...it, name: decodeHtmlEntities(it.name) }));
  const after = afterRaw.map((it) => ({ ...it, name: decodeHtmlEntities(it.name) }));
  const beforeQty = new Map<string, number>();
  const beforeWeight = new Map<string, number>();
  for (const it of before) {
    beforeQty.set(it.name, (beforeQty.get(it.name) || 0) + it.qty);
    if (it.isWeight && typeof it.weight === 'number') {
      beforeWeight.set(it.name, (beforeWeight.get(it.name) || 0) + it.weight);
    }
  }
  const green: CartRow[] = [];
  const grey: CartRow[] = [];
  for (const it of after) {
    // Sold-by-weight lines carry qty:1 (present/absent), so the qty diff always
    // yields greenQty=0 and mislabels a freshly added/topped-up weight line as
    // "already in cart". Classify by weight instead: a line that's new, or
    // heavier than the before snapshot, was added/increased by this run.
    if (it.isWeight) {
      const bw = beforeWeight.get(it.name) || 0;
      const aw = typeof it.weight === 'number' ? it.weight : 0;
      const added = !beforeWeight.has(it.name) || aw > bw;
      (added ? green : grey).push({ name: it.name, qty: it.qty, added, isWeight: true, weight: it.weight });
      continue;
    }
    const bq = beforeQty.get(it.name) || 0;
    const greyQty = Math.min(bq, it.qty);
    const greenQty = Math.max(it.qty - bq, 0);
    if (greenQty > 0) green.push({ name: it.name, qty: greenQty, added: true, isWeight: it.isWeight, weight: it.weight });
    if (greyQty > 0) grey.push({ name: it.name, qty: greyQty, added: false, isWeight: it.isWeight, weight: it.weight });
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

// Instacart Storefront has NO dedicated cart page — the cart is an in-page side
// panel ([role="dialog"][aria-label="Cart"]) opened from the floating cart
// button. There's no navigation, so unlike HEB (URL) / Amazon (click→navigate)
// this script does the whole thing in one injected pass: open the panel (if
// closed), read each line item, post CART_COUNT, then close the panel so it
// doesn't cover the search bar for the next step. Per line item:
//   • name: the "Increment quantity of <name>" button's aria-label (minus the
//           prefix). Live line items have NO "Remove" button — only the
//           increment/decrement stepper — so the increment button is the anchor.
//   • qty:  the stepper's "Quantity: N" text (walk up from the increment button)
//
// Every selector here is the white-labelled platform's, observed on ALDI (the
// only banner we hold fixtures for). It is shared by every tenant in
// INSTACART_TENANTS because the side panel is Instacart's, not the banner's.
const INSTACART_CART_PANEL_SCRIPT = `(async function() {
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
  // Registry-driven, not `storeId === 'aldi'`. The side panel is a property of
  // Instacart Storefront, so it belongs to every banner on it. Hardcoding one
  // banner meant a second tenant got null from all three of
  // buildInlineCartScript / buildCartPageCountScript / buildOpenCartScript, at
  // which point WebViewCartSheet takes NO cart-probe branch — no before
  // baseline, no after count, no cart breakdown on the done screen, and no
  // error either. Pinned by tests/unit/webview-scripts/instacartAdapter.test.ts.
  if (isInstacartStore(storeId)) return INSTACART_CART_PANEL_SCRIPT;
  return null;
}

const HEB_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  function rowQty(row) {
    var inp = row.querySelector('[data-qe-id="cartQuantityCounterValue"]');
    if (!inp) return 0;
    // Prefer the live .value property; the value ATTRIBUTE is the server-rendered
    // initial qty and goes stale after a client-side increment.
    var v = parseInt(inp.value, 10);
    if (!v || isNaN(v)) {
      var alt = inp.getAttribute('aria-valuenow') || inp.getAttribute('value') || '';
      var m = String(alt).match(/(\\d+)/);
      v = m ? parseInt(m[1], 10) : 0;
    }
    return isNaN(v) ? 0 : v;
  }
  // Sold-by-weight lines have NO cartQuantityCounterValue — instead a
  // itemRowWeighedQuantityDropdown and an a11y "Quantity: N lb" label. Read the
  // weight (lb) so these aren't seen as qty 0 (which made reconcile think the
  // item was missing and re-add it). Returns the weight in lb, or 0 if not a
  // weight line.
  function rowWeightLb(row) {
    if (!row.querySelector('[data-qe-id="itemRowWeighedQuantityDropdown"]')) return 0;
    // Prefer the live select value; fall back to the a11y "Quantity: N lb" text
    // (server-rendered, present even when the select value isn't reflected as an
    // attribute).
    var sel = row.querySelector('[data-qe-id="itemRowWeighedQuantityDropdown"]');
    var w = sel ? parseFloat(sel.value) : NaN;
    if (!w || isNaN(w)) {
      var txt = row.textContent || '';
      var m = txt.match(/Quantity:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*lbs?/i);
      if (m) w = parseFloat(m[1]);
    }
    return (!w || isNaN(w)) ? 0 : w;
  }
  function snapshot() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-qe-id="itemRow"]'));
    var count = 0, items = [];
    for (var j = 0; j < rows.length; j++) {
      var nameEl = rows[j].querySelector('[data-qe-id="itemRowDetailsName"]');
      var nm = nameEl ? norm(nameEl.textContent) : '';
      var wlb = rowWeightLb(rows[j]);
      if (wlb > 0) {
        // Weight line: present in the cart at <wlb> lb. Count it as one unit so
        // the total stays meaningful; carry the weight + flag for reconcile.
        count += 1;
        if (nm) items.push({ name: nm, qty: 1, weight: wlb, isWeight: true });
      } else {
        var q = rowQty(rows[j]);
        count += q;
        if (nm) items.push({ name: nm, qty: q });
      }
    }
    return { count: count, items: items, rows: rows.length };
  }
  // Poll for item rows to render (HEB hydrates the cart client-side).
  var snap = snapshot();
  for (var i = 0; i < 20 && snap.rows === 0; i++) { await wait(200); snap = snapshot(); }
  // Stabilize: a line that was just incremented can briefly read its pre-update
  // qty, so the first read can under-count. Re-read until the total holds steady
  // across two consecutive reads (bounded) before trusting it.
  var stable = 0;
  for (var k = 0; k < 15; k++) {
    await wait(250);
    var next = snapshot();
    if (next.count === snap.count && next.rows === snap.rows) { stable++; snap = next; if (stable >= 2) break; }
    else { stable = 0; snap = next; }
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: snap.count, items: snap.items }));
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
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'alb_cart_start', url: location.href })); } catch (e) {}
  // Poll for cart line items to hydrate.
  var links = [];
  for (var i = 0; i < 25; i++) {
    links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/shop/product-details."]'));
    if (links.length > 0) break;
    await wait(200);
  }
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'alb_cart_poll_done', links: links.length, polls: i, bodyLen: (document.body.innerText || '').length })); } catch (e) {}
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
