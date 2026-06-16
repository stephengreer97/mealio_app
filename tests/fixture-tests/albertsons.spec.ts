// Albertsons family fixture tests (representative store: acme).
//
// The same scripts run against Safeway, Vons, Jewel-Osco, etc — they share
// selectors. We capture once for acme; rerun for other family members only
// if a specific store's DOM diverges.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- albertsons`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('albertsons');
// 'acme' is one of the Albertsons family IDs; getStoreScripts dispatches
// based on the family list inside webview-scripts/index.ts.
const scripts = getStoreScripts('acme')!;

describe('Albertsons cart-page count (snapshot before/after)', () => {
  // Counts on /erums/cart: dedupe by product id (the page renders each item
  // twice for responsive layouts), qty from the stepper id / .stepper-qty.
  // Fixture has Basmati x2 + Hunt's x1 → 3 units, 2 distinct items.
  itWithFixture(
    'cart-with-items.html',
    'sums cart line-item quantities (deduped) and posts CART_COUNT',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('acme')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBe(3);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(2);
      const byName = Object.fromEntries(
        result.items.map((it: { name: string; qty: number }) => [it.name, it.qty]),
      );
      const basmati = Object.keys(byName).find((n) => /basmati/i.test(n));
      const hunts = Object.keys(byName).find((n) => /hunt/i.test(n));
      expect(basmati && byName[basmati]).toBe(2);
      expect(hunts && byName[hunts]).toBe(1);
    },
  );
});

describe('Albertsons family CHECK_LOGIN_SCRIPT', () => {
  // CAVEAT: the script clicks the profile button then scans document.body
  // for "sign out" / "log out". The click is a no-op in static fixtures
  // (no JS handlers), so any unrelated "sign out" text in the captured
  // page (footer, hidden menus, inline JS strings) makes this pass
  // vacuously. Real signal lives in the panel-open pinning test below.
  itWithFixture(
    'logged-in-home.html',
    'CHECK_LOGIN reaches its terminal LOGIN_STATUS post [VACUOUS in static fixtures]',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

  // Pinning test: the captured account-panel DOM must contain "Sign Out"
  // / "Log Out" text. Catches real markup drift even if the production-
  // script test passes vacuously.
  itWithFixture(
    'logged-in-account-panel-open.html',
    'captured account-panel DOM contains "Sign Out" marker',
    async (runner) => {
      const bodyText = await runner.page.evaluate(() =>
        (document.body.innerText || '').toLowerCase(),
      );
      expect(bodyText).toMatch(/sign out|log out/);
    },
  );
});

describe('Albertsons family regression: product already in cart (bubble state)', () => {
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

describe('Albertsons family regression: stepper already open', () => {
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

describe('Albertsons family EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product candidate',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
  );
});
