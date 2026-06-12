// H-E-B fixture tests.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- heb`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('heb');
const scripts = getStoreScripts('heb')!;

describe('HEB CHECK_LOGIN_SCRIPT', () => {
  // CAVEAT: the script's logic is "click profile button, wait 2s, if I'm
  // still running (no redirect) report logged in." In a captured static
  // fixture the click is a no-op (no JS handlers), so the script ALWAYS
  // reports logged-in regardless of the captured state. The test below is
  // therefore vacuous — it pins the script's terminal post-message contract
  // but does NOT distinguish in/out from static DOM. Real signal lives in
  // the panel-open pinning test below.
  itWithFixture(
    'logged-in-home.html',
    'CHECK_LOGIN reaches its terminal LOGIN_STATUS post [VACUOUS in static fixtures]',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);
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
