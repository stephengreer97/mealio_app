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

import { ALBERTSONS_FAMILY_IDS } from './albertsons';

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
