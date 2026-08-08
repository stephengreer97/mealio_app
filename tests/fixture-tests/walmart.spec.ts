// Walmart fixture tests.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- walmart`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('walmart');
const scripts = getStoreScripts('walmart')!;

describe('Walmart cart-page snapshot', () => {
  itWithFixture(
    'cart-with-items.html',
    'reads line items (name + qty) from the /cart page',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('walmart')!);
      const result = await runner.waitForMessage('CART_COUNT', 12_000);
      expect(result.items.length).toBe(4);
      expect(result.count).toBeGreaterThanOrEqual(4);
      expect(result.items.every((i: any) => i.name && i.qty >= 1)).toBe(true);
      // Each line's name should be a real product title, not a stray qty/number.
      expect(result.items.some((i: any) => /sour cream/i.test(i.name))).toBe(true);
    },
    // The URL matters now: the script refuses to count anywhere but /cart
    // (MEAL-152). Passing the real cart URL is also just more faithful — this
    // fixture IS that page (captured by page.goto('https://www.walmart.com/cart')
    // per src/lib/fixture-capture-config.ts), and before this the test ran it on
    // about:blank.
    { url: 'https://www.walmart.com/cart' },
  );
});

// MEAL-152. www.walmart.com/cart answers 302 → https://www.walmart.com/, and the
// redirect DISCARDS the path. Measured 2026-08-07, anonymously, under the app's
// mobile UA: 302, Location https://www.walmart.com/, and the followed homepage
// (307,659 bytes, <title>Walmart | Save Money. Live better.</title>) contains
// ZERO occurrences of "quantity-label".
//
// The script then polled its full 5s, found no line items, and posted
// `count: 0` — which callers TRUST, since only `null` means "unknown, skip".
// A confident zero sets cartItemsBeforeRef to [], and diffCartItems([], after)
// attributes the user's entire pre-existing cart to this run.
//
// These tests change only the URL the cart fixture is served from, which is
// exactly the difference the redirect made. Same DOM, same selectors, same 4
// countable items — so anything that moves here is the URL check and nothing
// else.
describe('Walmart cart-page count refuses to count off the cart page (MEAL-152)', () => {
  itWithFixture(
    'cart-with-items.html',
    'posts count:null with a named reason on the homepage the /cart redirect lands on',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('walmart')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      // The bug: this used to be 4 on this DOM and 0 on the real homepage —
      // either way a trusted number read off a page that is not the cart.
      expect(result.count).toBeNull();
      expect(result.reason).toBe('not_cart_page');
      // The reason alone doesn't say WHERE we ended up; the URL does.
      expect(result.url).toBe('https://www.walmart.com/');
      // Never invent items alongside an unknown count — both CART_COUNT handlers
      // key off Array.isArray(msg.items) and would diff against an empty cart.
      expect(result.items).toBeUndefined();
    },
    { url: 'https://www.walmart.com/' },
  );

  // The other direction, and the one that would make this fix a regression:
  // the guard must not refuse pages that ARE the cart. Both injection sites
  // append a `_t=` cache-buster, so a guard that rejected a query string would
  // take every Walmart baseline to null.
  const COUNTS: ReadonlyArray<readonly [string, string]> = [
    ['a cache-buster query, as both injection sites append', 'https://www.walmart.com/cart?_t=1754500000000'],
    ['a trailing slash', 'https://www.walmart.com/cart/'],
    ['a hash fragment', 'https://www.walmart.com/cart#items'],
  ];
  for (const [label, url] of COUNTS) {
    itWithFixture(
      'cart-with-items.html',
      `still counts with ${label}`,
      async (runner) => {
        await runner.inject(buildCartPageCountScript('walmart')!);
        const result = await runner.waitForMessage('CART_COUNT', 12_000);
        expect(result.count).toBeGreaterThanOrEqual(4);
        expect(result.items).toHaveLength(4);
      },
      { url },
    );
  }

  // Exact match, not a prefix: `indexOf('/cart') === 0` would also accept these.
  // Neither is a Walmart page today, so this closes a nit rather than a live
  // hole — but a page that merely starts with the cart path is not the cart, and
  // a trusted count off one is this same bug at a different URL.
  const REFUSES: ReadonlyArray<readonly [string, string]> = [
    ['a deeper path under the cart', 'https://www.walmart.com/cart/checkout'],
    ['a longer path that merely starts with it', 'https://www.walmart.com/cartoons'],
  ];
  for (const [label, url] of REFUSES) {
    itWithFixture(
      'cart-with-items.html',
      `posts count:null on ${label}`,
      async (runner) => {
        await runner.inject(buildCartPageCountScript('walmart')!);
        const result = await runner.waitForMessage('CART_COUNT', 8_000);
        expect(result.count).toBeNull();
        expect(result.reason).toBe('not_cart_page');
        expect(result.url).toBe(url);
      },
      { url },
    );
  }

  itWithFixture(
    'cart-with-items.html',
    'stays silent on an auth interstitial instead of posting a verdict',
    async (runner) => {
      // An auth/SSO bounce is TRANSIENT — both injection sites re-inject on the
      // next load. A verdict here (even count:null) burns the probe's single
      // pending slot on a page that was never the cart, so the script must say
      // nothing and let the landing page decide.
      await runner.inject(buildCartPageCountScript('walmart')!);
      // Silence is the contract, so the only way to observe it is to wait out a
      // window in which a verdict would have arrived. The script returns before
      // its 5s hydration poll on this branch, so 2s is generous.
      await expect(runner.waitForMessage('CART_COUNT', 2_000)).rejects.toThrow();
    },
    { url: 'https://www.walmart.com/account/oauth?code=test' },
  );
});

describe('Walmart CHECK_LOGIN_SCRIPT', () => {
  // Run against the drawer-OPEN fixture, not the bare home page. The script
  // clicks the hamburger and reads the resulting drawer; in static captures
  // the click is a no-op (no JS handlers on the captured button), so the
  // drawer has to already be in the DOM for the menu scan to find a greeting.
  itWithFixture(
    'logged-in-menu-drawer-open.html',
    'detects logged-in via "Hi, <name>" greeting in the drawer',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

});

describe('Walmart EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product candidate, excluding sponsored carousel cards',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates.length).toBeGreaterThan(0);
      // Regression: ensure no candidate name looks like a sponsored ad
      // ("Sponsored", "Ad" prefix). Earlier sessions had ad-carousel leakage.
      for (const c of result.candidates) {
        expect(c.productName.toLowerCase()).not.toMatch(/^sponsored\b|^ad\b/);
      }
    },
  );
});

describe('Walmart regression: product already in cart (bubble state)', () => {
  itWithFixture(
    'search-results-product-in-cart.html',
    'completes without crashing when product is already in cart',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    },
  );
});

describe('Walmart regression: stepper already open', () => {
  itWithFixture(
    'search-results-stepper-open.html',
    'script handles a tile with the stepper already visible',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result).toBeDefined();
    },
  );
});

describe('Walmart regression: variant chooser flow', () => {
  itWithFixture(
    'search-results-with-variants.html',
    'handles a tile that needs variant selection (size/flavor) before add',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Cheese', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result).toBeDefined();
    },
  );
});

describe('Walmart buildSearchScript NAV_INTENT contract', () => {
  itWithFixture(
    'logged-in-home.html',
    'posts NAV_INTENT with the canonical search URL before navigating',
    async (runner) => {
      const script = scripts.buildSearchScript('Sour Cream');
      await runner.inject(script);
      const nav = await runner.waitForMessage('NAV_INTENT', 5_000);
      expect(nav.target).toContain('walmart.com');
      expect(nav.target.toLowerCase()).toContain('sour');
    },
  );
});
