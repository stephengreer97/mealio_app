// Amazon Fresh fixture tests.
//
// Amazon Fresh uses Amazon's standard storefront DOM but filtered to the
// "amazonfresh" merchant. Login detection reads the #nav-link-accountList
// element: "Hello, <name>" when logged in, "Hello, Sign in" when out.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- amazon-fresh`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('amazon-fresh');
const scripts = getStoreScripts('amazon')!;

describe('Amazon Fresh cart-page count (expanded Fresh cart)', () => {
  // The expanded Fresh cart renders each line item as a div.sc-list-item
  // carrying data-quantity (the unit qty) and holding a "Delete <name>" button
  // (the product name). Quantities come straight from each card's authoritative
  // data-quantity. Fixture: Perdue Portions x2, Daisy x2, Mission x1, Perdue
  // Harvestland x2 = 7 units, 4 items.
  itWithFixture(
    'cart-fresh-full.html',
    'sums per-item quantities and posts CART_COUNT with names',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('amazon')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBe(7);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(4);
      const byMatch = (re: RegExp) =>
        result.items.find((it: { name: string }) => re.test(it.name));
      expect(byMatch(/daisy/i)?.qty).toBe(2);
      expect(byMatch(/mission/i)?.qty).toBe(1);
      expect(byMatch(/perdue perfect portions/i)?.qty).toBe(2);
      expect(byMatch(/harvestland/i)?.qty).toBe(2);
    },
  );
});

describe('Amazon Fresh CHECK_LOGIN_SCRIPT', () => {
  itWithFixture(
    'logged-in-home.html',
    'detects logged-in via #nav-link-accountList "Hello, <name>"',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

});

describe('Amazon Fresh regression: product already in cart (bubble state)', () => {
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

describe('Amazon Fresh regression: stepper already open', () => {
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

describe('Amazon Fresh regression: "Quantity not updated" status h2', () => {
  // When a prior qty update failed, Amazon injects a "Quantity not updated"
  // status h2 (inside .ax-qs__error) that precedes the product title in the
  // DOM. The name extractor must skip it and read the real title, never
  // prepending "Quantity not updated" to the product name.
  itWithFixture(
    'search-results-qty-error.html',
    'extracts the real product name, not the "Quantity not updated" status',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(result.candidates.length).toBeGreaterThan(0);
      const name = result.candidates[0].productName as string;
      expect(name).not.toMatch(/quantity not updated/i);
      expect(name).toMatch(/colavita/i);
      expect(name).toMatch(/italian crushed tomatoes/i);
    },
  );
});

describe('Amazon Fresh EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product from search-result cards',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
  );
});
