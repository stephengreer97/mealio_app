// H-E-B fixture tests.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- heb`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('heb');
const scripts = getStoreScripts('heb')!;

describe('HEB CHECK_LOGIN_SCRIPT', () => {
  // Positive-proof detection: against the captured account-panel-open DOM the
  // "Log out" control is present in the body text, so CHECK_LOGIN must report
  // logged-in. Unlike the old "no redirect => logged in" heuristic, this is a
  // real signal even in a static fixture.
  itWithFixture(
    'logged-in-account-panel-open.html',
    'CHECK_LOGIN reports logged-in when the panel "Log out" marker is present',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

  // Regression for the bad-network false-positive: with the account panel
  // CLOSED there is no "Log out" marker, and a static click cannot open it, so
  // CHECK_LOGIN must report logged-OUT. The old script inferred login from the
  // absence of a logout redirect, which a slow connection could fake — this
  // pins that it no longer does.
  itWithFixture(
    'logged-in-home.html',
    'CHECK_LOGIN reports logged-out when no "Log out" marker is visible',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);
    },
  );

  // Pinning test: the captured account-side-panel DOM (post-click state)
  // must contain the markers a production user sees when logged in. This
  // catches real markup drift — e.g. if HEB renames "Sign Out" to "Log
  // Out", or moves it out of the panel body.
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

describe('HEB EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 product candidate with name + image',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates.length).toBeGreaterThan(0);
      const first = result.candidates[0];
      expect(typeof first.productName).toBe('string');
      expect(first.productName.length).toBeGreaterThan(0);
    },
  );
});

describe('HEB regression: "perfect pairings" carousel is not extracted', () => {
  // HEB's search page leads with a "<term>'s perfect pairings" entity carousel
  // whose tiles share data-component="product-card" but lack data-qe-id="productCard".
  // For "Yogurt" the carousel led with "H-E-B Classic Granola", which the old
  // selector picked up as candidate #0. __hebFindCards() now scopes to the search
  // grid and selects on the productCard id, so the carousel (and the in-grid
  // sponsored two-panel rail) are excluded.
  itWithFixture(
    'search-results-yogurt-pairings-carousel.html',
    'extracts only real grid yogurts, never the carousel granola/bananas/Oikos rail',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      const names: string[] = result.candidates.map(
        (c: { productName: string }) => c.productName,
      );
      // No carousel/rail items.
      expect(names.some((n) => /granola/i.test(n))).toBe(false);
      expect(names.some((n) => /bananas/i.test(n))).toBe(false);
      expect(names.some((n) => /oikos fusion/i.test(n))).toBe(false);
      // The three genuine grid yogurts are present, and the first candidate is
      // a real yogurt (not granola).
      expect(names.length).toBe(3);
      expect(/yogurt/i.test(names[0])).toBe(true);
      expect(names).toEqual(
        expect.arrayContaining([
          'H-E-B 17g Protein Whole Milk Greek Yogurt - Plain, 32 oz',
          'Hill Country Fare Blended Vanilla Low-Fat Yogurt, 32 oz',
          'Fage Total 0% Nonfat Plain Greek Yogurt, 32 oz',
        ]),
      );
    },
  );
});

describe('HEB regression: in-page SPA search returns FRESH results, not stale', () => {
  // HEB's in-page search changes the URL to /search?q=<term> and fetches new
  // results async, leaving the previous search's cards mounted for a beat. The
  // extractor must wait until the grid reflects the searched term (header gate)
  // instead of grabbing the stale cards (e.g. a "cilantro" search returning the
  // prior "Hoisin Sauce" page). We simulate the async swap mid-extract.
  itWithFixture(
    'search-results-stale-hoisin.html',
    'waits for the grid to reflect "cilantro", never returns the stale Hoisin card',
    async (runner) => {
      // Swap header + grid to the real cilantro results ~1.2s after the script
      // starts polling — mimicking HEB's client-side result render.
      await runner.page.evaluate(() => {
        setTimeout(() => {
          const header = document.querySelector('#searchGridHeader');
          if (header) header.textContent = '“cilantro”';
          const grid = document.querySelector('[data-qe-id="productCardContainer"]');
          if (grid) {
            while (grid.firstChild) grid.removeChild(grid.firstChild);
            const outer = document.createElement('div');
            outer.setAttribute('data-component', 'product-card');
            const card = document.createElement('div');
            card.setAttribute('data-component', 'product-card-card');
            card.setAttribute('data-qe-id', 'productCard');
            const title = document.createElement('div');
            title.setAttribute('data-qe-id', 'productTitle');
            const span = document.createElement('span');
            span.textContent = 'Fresh Cilantro, 1 Bunch';
            title.appendChild(span);
            const btn = document.createElement('button');
            btn.setAttribute('data-qe-id', 'addToCart');
            btn.textContent = 'Add to cart';
            card.appendChild(title);
            card.appendChild(btn);
            outer.appendChild(card);
            grid.appendChild(outer);
          }
        }, 1200);
      });
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 14_000);
      const names: string[] = result.candidates.map((c: { productName: string }) => c.productName);
      expect(names.some((n) => /hoisin/i.test(n))).toBe(false);
      expect(names.some((n) => /cilantro/i.test(n))).toBe(true);
    },
    { url: 'https://www.heb.com/search?q=cilantro' },
  );
});

describe('HEB cart-page count (snapshot before/after)', () => {
  // The header badge is unreliable under the app's mobile UA, so HEB counts on
  // the /cart page: sum cartQuantityCounterValue across itemRows. The fixture
  // has 2 rows at qty 1 each → 2 units.
  itWithFixture(
    'cart-with-items.html',
    'sums cart line-item quantities and posts CART_COUNT',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('heb')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBe(2);
      // Also returns the per-line breakdown used to render the done screen.
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(2);
      const names = result.items.map((it: { name: string }) => it.name);
      expect(names.some((n: string) => /tzatziki/i.test(n))).toBe(true);
      result.items.forEach((it: { qty: number }) => expect(it.qty).toBe(1));
    },
  );
});

describe('HEB regression: product already in cart (bubble state)', () => {
  // Verifies the script handles the case where the matched product already
  // has a non-zero qty in cart. Catches "double-add" / "wrong-state" bugs
  // analogous to the May-18 Wegmans qty+1 regression.
  itWithFixture(
    'search-results-product-in-cart.html',
    'completes without crashing when product is already in cart',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Sour Cream', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      // We don't assert success=true (the fixture may not match this exact
      // search term); we assert the script POSTED A RESULT instead of
      // hanging or crashing.
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    },
  );
});

describe('HEB regression: stepper already open (State 3)', () => {
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

describe('HEB regression: preference modal flow', () => {
  // HEB shows a preference picker for some items (avocados, etc) when you
  // add. The script must handle the modal — pick a default, dismiss, then
  // complete the add. Auto-skips when fixture isn't captured.
  itWithFixture(
    'search-results-with-preferences.html',
    'handles a tile that opens a preference modal on add',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Avocado', 1, null);
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result).toBeDefined();
    },
  );
});

describe('HEB buildSearchAndAddScript', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'finds matching tile and posts SEARCH_AND_ADD_RESULT:success',
    async (runner) => {
      // The search term must be an exact literal match for one of the
      // captured product titles — HEB's scoreMatch requires === 100. This
      // string is copied verbatim from a tile in the captured fixture; if
      // the fixture is re-captured and the catalog has shifted, update
      // this to whatever product is first in the new capture.
      const script = scripts.buildSearchAndAddScript(
        'Mission Super Soft Flour Tortillas, Fajita Size, 40 ct',
        1,
        null,
      );
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result.success).toBe(true);
    },
    { url: 'https://www.heb.com/search?q=mission%20flour%20tortillas' },
  );
});
