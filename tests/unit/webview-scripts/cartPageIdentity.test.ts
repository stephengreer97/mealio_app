// MEAL-152 — cart-page scripts must not emit a count they aren't sure of.
//
// The defect: www.walmart.com/cart 302s to https://www.walmart.com/, discarding
// the path. The homepage has no [data-testid="quantity-label"], so the count
// script polled, found nothing, and posted `count: 0`. Only `count: null` means
// "unknown, skip validation" — any NUMBER is trusted — so a wrong zero becomes
// an empty before-baseline, and diffCartItems([], after) then attributes the
// user's whole pre-existing cart to this run.
//
// The fixture specs (walmart/heb/wegmans) prove the guard's BEHAVIOUR against
// real captured HTML in a browser. This file pins the two things that hold the
// class together and that no single store's spec can see:
//
//   1. Each guarded store's expected path actually matches its cart URL. Move
//      the URL and forget the path, and the store silently goes uncountable.
//   2. Every cart-page URL store carries the guard at all. A store added to
//      CART_PAGE_URL with no path entry ships the original defect — nothing
//      else in the suite would notice.

import {
  buildCartPageCountScript,
  getCartPageUrl,
  getCartPagePath,
} from '../../../src/lib/webview-scripts/cart-count';

/** Stores that count on a fetched cart URL. Albertsons' family is URL-based too
 *  but builds its URL per banner (getAlbertsonsCartPageUrl) and is not guarded
 *  on this branch — see the report / PR #81. */
const URL_CART_STORES = ['heb', 'walmart', 'wegmans'] as const;

describe('cart-page identity guard (MEAL-152)', () => {
  describe.each(URL_CART_STORES)('%s', (storeId) => {
    it('expects the pathname its own cart URL resolves to', () => {
      const url = getCartPageUrl(storeId);
      expect(url).toBeTruthy();
      // Parse rather than string-compare: this is exactly the drift the guard
      // cannot survive — a cart URL moved to /basket while the guard still
      // demands /cart would turn every baseline for that store into null.
      expect(getCartPagePath(storeId)).toBe(new URL(url!).pathname);
    });

    it('refuses to count on a page that is not the cart', () => {
      const script = buildCartPageCountScript(storeId)!;
      expect(script).toContain("reason: 'not_cart_page'");
      expect(script).toContain('count: null');
      // The guard has to run BEFORE the hydration poll: a script that checked
      // the URL only after polling would still burn 5s per probe, and (worse) a
      // reader would have to trust the ordering rather than see it.
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

  it('gives every URL-cart store a guarded script', () => {
    // The whole point of the ticket: the class, not the one store. A new store
    // wired into CART_PAGE_URL without a CART_PAGE_PATH entry would post a
    // trusted zero on whatever page its cart URL redirects to.
    for (const storeId of URL_CART_STORES) {
      expect(getCartPagePath(storeId)).not.toBeNull();
    }
  });

  it('leaves stores with no cart-page path unguarded rather than guessing one', () => {
    // Amazon Fresh reaches its cart by CLICKING the cart icon and traverses
    // several paths on the way (/gp/aw/c → /cart/localmarket), so there is no
    // single pathname to assert and this guard does not apply to it. Recorded
    // here so "amazon has no path" reads as a decision rather than an omission.
    // The residual risk is real and is written up in the MEAL-152 report: that
    // script still posts count:0 from a page with no line-item cards.
    expect(getCartPagePath('amazon')).toBeNull();
    expect(buildCartPageCountScript('amazon')).not.toContain('not_cart_page');
  });
});
