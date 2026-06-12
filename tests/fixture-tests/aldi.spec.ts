// ALDI fixture tests.
//
// ALDI runs on Instacart's storefront. Login is via a hamburger menu rather
// than a direct profile button — the login-detection script looks for
// "Sign out" / "Account" text in the menu drawer.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- aldi`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('aldi');
const scripts = getStoreScripts('aldi')!;

describe('ALDI CHECK_LOGIN_SCRIPT', () => {
  itWithFixture(
    'logged-in-home.html',
    'detects logged-in via header copy or hamburger-menu state',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 15_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

});

describe('ALDI regression: product already in cart (bubble state)', () => {
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

describe('ALDI regression: stepper already open', () => {
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

describe('ALDI EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product candidate from Instacart-style result grid',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
  );
});
