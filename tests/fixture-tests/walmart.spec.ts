// Walmart fixture tests.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- walmart`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('walmart');
const scripts = getStoreScripts('walmart')!;

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
