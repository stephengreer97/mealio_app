// Deterministic add-to-cart confirmation by watching the store's header cart
// count. After clicking an add/increment control, wait for the badge to tick up
// before reporting success — proof the add actually committed, and it keeps the
// RN side from navigating away and race-cancelling the in-flight cart request.
//
// Returns an injectable JS snippet that defines two globals on the page:
//   __cartCount()                      → current cart count (int), or -1 if unread
//   __waitForCartIncrease(prev, ticks) → resolves true once count > prev (200ms
//                                        ticks, up to `ticks`), or after an 800ms
//                                        settle when the badge is unreadable
//                                        (prev < 0) so a markup change can't hard-fail.
//
// WHERE THIS IS USED, and where it is not: only Amazon Fresh imports this module
// today. H-E-B carries its own inline copies of the same two functions (see
// heb.ts), and MEAL-14 put a rail in front of them that asks H-E-B's cart what is
// actually in it (webview-scripts/heb-cart-query) — per product, not per counter.
// The badge is still there for H-E-B, deliberately: it is what a cart read that
// is blocked, timed out, or oddly-shaped degrades back to, and "we could not
// read the cart" must never be reported as "your items are missing". Stores with
// no cart query of their own have nothing but this.
//
// `selectors` are tried in order; the first element found has its aria-label +
// textContent matched against `reSource` (a RegExp source string, capture group
// 1 = the integer). Not every store has a usable badge — only wire this in for
// stores whose count reflects total quantity (HEB, Amazon, Walmart, Albertsons),
// NOT per-distinct-product counts (ALDI) or flaky ones (Wegmans).
export function buildCartConfirmFn(selectors: string[], reSource: string): string {
  return `
  function __cartCount() {
    var sels = ${JSON.stringify(selectors)};
    for (var s = 0; s < sels.length; s++) {
      var el = null;
      try { el = document.querySelector(sels[s]); } catch (e) {}
      if (!el) continue;
      var txt = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
      var m = txt.match(new RegExp(${JSON.stringify(reSource)}, 'i'));
      if (m) return parseInt(m[1], 10);
    }
    return -1;
  }
  function __cwait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  async function __waitForCartIncrease(prev, ticks) {
    if (prev < 0) { await __cwait(2500); return true; }   // badge unreadable → generous settle (slow networks)
    for (var w = 0; w < ticks; w++) {
      if (__cartCount() > prev) return true;
      await __cwait(200);
    }
    return false;
  }
`;
}
