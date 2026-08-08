// MEAL-152 — cart-page scripts must not emit a count they aren't sure of.
//
// The defect: www.walmart.com/cart 302s to https://www.walmart.com/, discarding
// the path. The homepage has no [data-testid="quantity-label"], so the count
// script polled, found nothing, and posted `count: 0`. Only `count: null` means
// "unknown, skip validation" — any NUMBER is trusted — so a wrong zero becomes
// an empty before-baseline.
//
// The fixture specs (walmart/heb/wegmans) prove the guard's BEHAVIOUR against
// real captured HTML in a browser. This file pins the two structural facts no
// single store's spec can see:
//
//   1. Each guarded store's expected path really is its cart URL's pathname.
//      Move the URL and forget the path and that store silently goes
//      uncountable — the guard would refuse the real cart page.
//   2. Every store in the CART_PAGE_URL registry carries the guard, save the one
//      documented exemption. This iterates the REGISTRY, not a list beside it:
//      an earlier version of this file walked a hardcoded array of the three
//      store ids while claiming to catch a store added without a guard, and a
//      mutant that added `target: 'https://www.target.com/cart'` to
//      CART_PAGE_URL passed it green.
//
// SCOPE, stated because the obvious phrasing would be false: this is not "every
// store that counts on a cart page is guarded". Two populations sit outside
// CART_PAGE_URL and outside this check —
//   • the 15 Albertsons banners, whose cart URL is built per banner by
//     getAlbertsonsCartPageUrl; guarding that script is PR #81's change, not
//     this branch's.
//   • the Instacart side panel and Amazon Fresh, which have no cart URL at all
//     (a panel with no navigation, and a click-through that traverses several
//     paths). Both are recorded as unguarded in cart-count.ts.

import {
  buildCartPageCountScript,
  getCartPageUrl,
  getCartPagePath,
  isCountedCartSnapshot,
  CART_PAGE_URL_STORE_IDS,
} from '../../../src/lib/webview-scripts/cart-count';

/**
 * Registered cart-URL stores that deliberately carry no guard, with the reason.
 * Anything NOT listed here is expected to be guarded, so adding a store to
 * CART_PAGE_URL without a path entry fails the suite rather than shipping a
 * script that posts a trusted zero on whatever its URL redirects to.
 */
const EXEMPT: Record<string, string> = {
  mockstore: 'dev/test harness on a local server that does not redirect',
};

const GUARDED = CART_PAGE_URL_STORE_IDS.filter((id) => !(id in EXEMPT));

describe('cart-page identity guard (MEAL-152)', () => {
  it('has some guarded stores to check', () => {
    // The lists above are derived, so a refactor that empties CART_PAGE_URL
    // would otherwise make every check below vacuously pass.
    expect(GUARDED.length).toBeGreaterThan(0);
  });

  describe.each(GUARDED)('%s', (storeId) => {
    it('expects the pathname its own cart URL resolves to', () => {
      const url = getCartPageUrl(storeId);
      expect(url).toBeTruthy();
      // Parse rather than string-compare: this is exactly the drift the guard
      // cannot survive — a cart URL moved to /basket while the guard still
      // demands /cart would turn every baseline for that store into null. A
      // store with no path entry at all fails here with null, which is how an
      // unguarded addition to CART_PAGE_URL gets caught.
      expect(getCartPagePath(storeId)).toBe(new URL(url!).pathname);
    });

    it('refuses to count on a page that is not the cart', () => {
      const script = buildCartPageCountScript(storeId)!;
      expect(script).toContain("reason: 'not_cart_page'");
      expect(script).toContain('count: null');
      // The guard has to run BEFORE the hydration poll: a script that checked
      // the URL only after polling would still burn 5s per probe, and a reader
      // would have to trust the ordering rather than see it.
      expect(script.indexOf('not_cart_page')).toBeLessThan(script.indexOf('await wait('));
    });

    it('matches the cart path exactly, not as a prefix', () => {
      // `indexOf(path) === 0` accepts /cart/checkout and /cartoons. The
      // behavioural half of this lives in the fixture specs; here it is pinned
      // as an inequality so a refactor to a prefix test fails loudly.
      const script = buildCartPageCountScript(storeId)!;
      expect(script).toContain(`__path !== ${JSON.stringify(getCartPagePath(storeId))}`);
    });
  });

  describe.each(Object.keys(EXEMPT))('%s (exempt)', (storeId) => {
    it('is registered as an exemption rather than silently unguarded', () => {
      // Asserting the exemption is real keeps the list honest in both
      // directions: if mockstore ever gains a guard, this fails and the entry
      // above has to go, rather than lingering as a false excuse.
      expect(CART_PAGE_URL_STORE_IDS).toContain(storeId);
      expect(getCartPagePath(storeId)).toBeNull();
      expect(buildCartPageCountScript(storeId)).not.toContain('not_cart_page');
    });
  });

  // The same 0-vs-null rule the guard enforces, pointing the other way.
  //
  // WebViewCartSheet's prewarmed-baseline fast path asks "did the probe count
  // anything?" before consuming a cached snapshot. Written as `if (cart.count)`
  // that silently discards every EMPTY cart — the most common baseline there is
  // — and the whole suite stays green, because that call site has no harness
  // (MEAL-158). The predicate carries the rule so the slip is not expressible
  // there, and these four cases are what make it a rule rather than a name.
  describe('isCountedCartSnapshot — zero is a baseline, null is not', () => {
    it('accepts an empty cart (count 0)', () => {
      // The mutant killer: `!!snapshot.count` fails exactly here.
      expect(isCountedCartSnapshot({ count: 0 })).toBe(true);
    });

    it('accepts a counted cart', () => {
      expect(isCountedCartSnapshot({ count: 4 })).toBe(true);
    });

    it('rejects an unknown count', () => {
      // What the page-identity guard posts when it refuses. Taking this as a
      // baseline is what forfeits the run's own before-probe.
      expect(isCountedCartSnapshot({ count: null })).toBe(false);
    });

    it('rejects a missing snapshot', () => {
      expect(isCountedCartSnapshot(null)).toBe(false);
      expect(isCountedCartSnapshot(undefined)).toBe(false);
    });
  });

  it('leaves stores with no cart-page URL unguarded rather than guessing a path', () => {
    // Amazon Fresh reaches its cart by CLICKING the cart icon and traverses
    // several paths on the way (/gp/aw/c → /cart/localmarket), so there is no
    // single pathname to assert and this guard does not apply to it. Recorded
    // here so "amazon has no path" reads as a decision rather than an omission.
    // The residual risk is real and is written up in cart-count.ts: that script
    // still posts count:0 from a page with no line-item cards.
    expect(CART_PAGE_URL_STORE_IDS).not.toContain('amazon');
    expect(getCartPagePath('amazon')).toBeNull();
    expect(buildCartPageCountScript('amazon')).not.toContain('not_cart_page');
  });
});
