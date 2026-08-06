// ALDI fixture tests.
//
// ALDI runs on Instacart's storefront, driven by the shared adapter in
// src/lib/webview-scripts/instacart.ts. Login is via a hamburger menu rather
// than a direct profile button — the login-detection script looks for
// "Sign out" / "Account" text in the menu drawer.
//
// ALDI is the ONLY Instacart tenant with captured fixtures, so this file is
// also the only behavioural coverage that adapter has. A second banner needs
// its own captures and its own copy of this matrix — see the tenant registry
// comment in instacart.ts.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- aldi`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildInlineCartScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('aldi');
const scripts = getStoreScripts('aldi')!;

describe('ALDI CHECK_LOGIN_SCRIPT', () => {
  itWithFixture(
    'logged-in-home.html',
    'detects logged-in via the open Main Menu (personalized entries)',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 15_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

  itWithFixture(
    'logged-in-home.html',
    'reports logged-OUT when the menu shows a Sign In CTA',
    async (runner) => {
      // Turn the real Main Menu into a signed-out one by injecting the CTA.
      await runner.page.evaluate(() => {
        const menu = document.querySelector('[role="dialog"][aria-label="Main Menu"]')!;
        const a = document.createElement('a');
        a.textContent = 'Sign in';
        const r = document.createElement('a');
        r.textContent = 'Register';
        menu.appendChild(a);
        menu.appendChild(r);
      });
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 15_000);
      expect(status.isLoggedIn).toBe(false);
    },
  );

  itWithFixture(
    'logged-in-home.html',
    'does NOT false-positive when the Sign In CTA renders late (race)',
    async (runner) => {
      // Reproduce the live bug: the menu mounts as a skeleton (no signed-in
      // tokens), and the "Sign in/Register" CTA paints a beat later. The old
      // absence-based check read the skeleton and wrongly returned logged-in.
      await runner.page.evaluate(() => {
        const menu = document.querySelector('[role="dialog"][aria-label="Main Menu"]')!;
        menu.textContent = 'Loading menu';
        setTimeout(() => {
          const a = document.createElement('a');
          a.textContent = 'Sign in';
          const r = document.createElement('a');
          r.textContent = 'Register';
          menu.appendChild(a);
          menu.appendChild(r);
        }, 300);
      });
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 15_000);
      expect(status.isLoggedIn).toBe(false);
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

describe('ALDI cart side-panel snapshot', () => {
  itWithFixture(
    'cart-with-items.html',
    'reads line items (name + qty) from the open Cart panel',
    async (runner) => {
      await runner.inject(buildInlineCartScript('aldi')!);
      const result = await runner.waitForMessage('CART_COUNT', 12_000);
      expect(result.count).toBe(6);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBe(6);
      const names = result.items.map((i: any) => i.name);
      expect(names).toContain('Organic Broccoli');
      expect(names).toContain('Happy Harvest Crushed Tomatoes');
      // Every line carries a positive qty.
      expect(result.items.every((i: any) => typeof i.qty === 'number' && i.qty >= 1)).toBe(true);
    },
  );
});

describe('ALDI EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product candidate from Instacart-style result grid',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      // ALDI's extract waits for a stale→fresh transition (the SPA replaces old
      // results in place). A static fixture never transitions, so the script
      // polls its full ~10s budget (50 × 200ms) before falling through and
      // extracting — leaving the old 12s timeout almost no headroom, which
      // flaked under the full parallel jest run. Give it room (cf. HEB's 14s).
      const result = await runner.waitForMessage('SEARCH_RESULT', 25_000);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
  );
});

describe('ALDI parallel worker script (Phase G rollout)', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'worker extracts candidates and posts WORKER_RESULT with its workerId',
    async (runner) => {
      await runner.inject(scripts.buildWorkerScript!(3));
      const result = await runner.waitForMessage('WORKER_RESULT', 12_000);
      expect(result.workerId).toBe(3);
      expect(result.query).toBe('tortillas');
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].productName).toBeTruthy();
    },
    // The worker reads its query from the search URL — mimic the real one.
    { url: 'https://www.aldi.us/store/aldi/s?k=tortillas' },
  );

  itWithFixture(
    'logged-in-home.html',
    'worker stays silent on a warmup load (no ?k= query)',
    async (runner) => {
      await runner.inject(scripts.buildWorkerScript!(0));
      await expect(runner.waitForMessage('WORKER_RESULT', 3_000)).rejects.toThrow();
    },
    { url: 'https://www.aldi.us' },
  );
});
