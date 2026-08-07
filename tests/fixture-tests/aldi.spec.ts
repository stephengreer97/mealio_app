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

/*
 * ON THE BUDGETS IN THIS FILE AND WHY THEY ARE 30s (MEAL-113).
 *
 * These two waits are the slowest in the suite, and they are BIMODAL. Measured on
 * an idle machine (14 Gi free), three runs each, back to back:
 *
 *   already-in-cart   15711 / 15707 / 19297 ms   (and 19291 ms inside a full run)
 *   stepper-open      14770 / 11232 / 11228 ms
 *
 * A fast mode and a slow mode about 3.6s apart, the same step that Albertsons'
 * collapsed-bubble wait and HEB's logged-out CHECK_LOGIN show. Fast and slow occur
 * back to back on an unloaded box, so the slow mode is not contention and cannot be
 * tuned away by running less at once.
 *
 * Against the previous 20s budget the slow mode sat at 96% (already-in-cart) and
 * 74% (stepper-open). 96% is not a margin. It matters more than it looks, because
 * the project rule now reads a `Timed out … postMessage` failure as starvation
 * rather than a defect: with 700ms of headroom, a genuine slowdown in the ALDI add
 * path would emit exactly the signature we have agreed to dismiss. So the budget is
 * 30s — the slow mode is 64% of it — and the tests below now assert what the script
 * DECIDED, so a regression that still answers in time fails on the answer.
 */
describe('ALDI regression: product already in cart (bubble state)', () => {
  itWithFixture(
    'search-results-product-in-cart.html',
    'asks instead of guessing when the term is generic, with both tiles still matched',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 30_000);

      // `success: false` is the RIGHT answer, and pinning it is the point.
      //
      // The reason is now `low_confidence`, not `not_confirmed`, and the difference
      // is the whole of MEAL-121. This search term is the generic ingredient
      // "Sour Cream"; the tiles are "Friendly Farms Sour Cream". Those are not the
      // same product name, so the script no longer picks one and tries to add it —
      // it hands both back as candidates and the user chooses. It used to buy the
      // best scorer above 30 out of 100, which is how a brand nobody asked for
      // ended up in a cart unattended.
      //
      // This is the same rule HEB, Walmart, Wegmans, Amazon Fresh and Albertsons
      // already follow. It works on a REPEAT run because the search term is then
      // the product name the user chose earlier, so it matches exactly; on a first
      // run with a generic ingredient, asking is the correct outcome.
      expect(result.success).toBe(false);
      expect(result.reason).toBe('low_confidence');

      // And it must still have SEEN the products. This is the drift-sensitive
      // half: if Instacart's tile markup moves, candidates goes empty and this
      // fails, which is the whole reason the fixture is committed.
      expect(Array.isArray(result.candidates)).toBe(true);
      const names: string[] = result.candidates.map((c: { productName: string }) => c.productName);
      expect(names).toContain('Friendly Farms Sour Cream');
      expect(names).toContain('Friendly Farms Light Sour Cream');
    },
    { testTimeoutMs: 45_000 },
  );
});

describe('ALDI regression: stepper already open', () => {
  itWithFixture(
    'search-results-stepper-open.html',
    'adds via the already-open stepper when the term names the product exactly',
    async (runner) => {
      // The term is the FULL tile name, which is what a repeat run sends: the
      // product the user chose earlier is remembered and searched for by name.
      // Under MEAL-121's exact gate that is the only kind of term that may add
      // anything, so this is the test proving the gate is not simply "reject
      // everything" — the add path still works when the match is real.
      const script = scripts.buildSearchAndAddScript('Friendly Farms Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 30_000);

      // With the stepper already open the script can drive it and confirm, so
      // unlike the bubble fixture above this one SHOULD succeed — and name the
      // tile it matched. `expect(result).toBeDefined()` could not fail.
      expect(result.success).toBe(true);
      expect(result.productName).toBe('Friendly Farms Sour Cream');
    },
    { testTimeoutMs: 45_000 },
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
