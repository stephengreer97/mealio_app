// Wegmans fixture tests.
//
// **Strategy**: each test starts by checking if its fixture file exists.
// If it doesn't (the user hasn't run `npm run capture -- wegmans` yet),
// the test is skipped with a clear message. That way the full test surface
// ships but doesn't fail on a fresh clone — the user activates each test
// by capturing the corresponding fixture.
//
// The synthetic-tile fixture IS committed and used by the regression specs
// that don't need full DOM fidelity (e.g. the double-click test).

import { loadFixture } from '../fixture-runners/runScript';
import { getScripts } from '../../src/lib/webview-scripts/wegmans';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { fxPath, itWithFixture } = storeFixtures('wegmans');
const fx = fxPath;
const scripts = getScripts();

describe('Wegmans cart-page snapshot', () => {
  itWithFixture(
    'cart-with-items.html',
    'reads line items (name + qty) from the /cart page, ignoring recommendation tiles',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('wegmans')!);
      const result = await runner.waitForMessage('CART_COUNT', 12_000);
      // Fixture cart has one real line: Mission tortillas x2 (the rest of the
      // page is ~70 recommendation tiles, which must NOT be counted).
      expect(result.items.length).toBe(1);
      expect(result.count).toBe(2);
      expect(result.items[0].name).toMatch(/Mission Super Soft Flour Tortillas/i);
      expect(result.items[0].qty).toBe(2);
    },
  );
});

describe('Wegmans CHECK_LOGIN_SCRIPT', () => {
  itWithFixture(
    'logged-in-home.html',
    'detects logged-in via "Hello, <name>" greeting',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);
    },
  );

});

describe('Wegmans EXTRACT_PRODUCTS_SCRIPT', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'extracts ≥1 candidate with productName + imageUrl',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 12_000);
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates.length).toBeGreaterThan(0);
      const first = result.candidates[0];
      expect(typeof first.productName).toBe('string');
      expect(first.productName.length).toBeGreaterThan(0);
      // imageUrl can be null for some weight-priced items, but should be
      // present for the typical case.
      expect(first).toHaveProperty('imageUrl');
    },
  );
});

describe('Wegmans buildSearchScript', () => {
  it('emits NAV_INTENT with a lowercased canonical URL', async () => {
    const runner = await loadFixture(fx('_synthetic-tile.html'));
    try {
      const script = scripts.buildSearchScript('Wegmans Sour Cream');
      await runner.inject(script);
      const nav = await runner.waitForMessage('NAV_INTENT', 5_000);
      expect(nav.target).toBe(
        'https://www.wegmans.com/shop/search?query=wegmans%20sour%20cream',
      );
    } finally {
      await runner.close();
    }
  });
});

describe('Wegmans buildSearchAndAddScript', () => {
  itWithFixture(
    'search-results-tortillas.html',
    'finds matching tile and posts SEARCH_AND_ADD_RESULT:success',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript(
        'La Banderita Burrito Grande Flour Tortillas, Extra Large',
        1,
        null,
      );
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result.success).toBe(true);
      expect(result.productName).toMatch(/La Banderita/);
    },
    { url: 'https://www.wegmans.com/shop/search?query=la%20banderita%20burrito%20grande%20flour%20tortillas%2C%20extra%20large' },
  );
});

describe('Wegmans regression: robustClick fires onClick at most twice in Chromium', () => {
  // The May-18 bug had robustClick calling btn.click() unconditionally after
  // dispatching a synthetic MouseEvent('click'), so QTY=1 added 2, QTY=2
  // added 3, etc. The fix removed the unconditional btn.click() fallback.
  //
  // The assertion is ≤ 2 (not ===1) because of a browser-engine quirk:
  //   • Chromium auto-synthesizes a `click` from `pointerdown`+`pointerup`
  //     in addition to our explicit MouseEvent('click'), so a single
  //     robustClick produces 2 listener invocations.
  //   • Real iOS WKWebView (production) does NOT auto-synthesize; the
  //     listener fires exactly once.
  //   • The May-18 regression would produce 3 in Chromium (auto-synth +
  //     explicit dispatch + extra btn.click) and 2 in WKWebView, so ≤ 2
  //     still catches the regression on the engine we test in.
  it('robustClick triggers the default-add-button onClick handler ≤ 2 times', async () => {
    const runner = await loadFixture(fx('_synthetic-tile.html'));
    try {
      const script = scripts.buildSearchAndAddScript('Wegmans Pico de Gallo Salsa', 1, null);
      await runner.inject(script);

      // Wait for the script's terminal message OR a reasonable timeout. The
      // script will probably fail to find a stepper button (we don't render
      // one in the synthetic fixture) — that's fine, we only care about the
      // initial click count.
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 10_000).catch(() => {});

      const clickCount = await runner.page.evaluate(() => (window as any).__addClickCount);
      expect(clickCount).toBeLessThanOrEqual(2);
      expect(clickCount).toBeGreaterThanOrEqual(1);
    } finally {
      await runner.close();
    }
  });
});

describe('Wegmans regression: scrollIntoCenter brings off-screen button into view', () => {
  // Bug from May 18, 2026 — Wegmans's sticky header covered the top of
  // tiles. When the test fixture has a fixed-position header, the default-
  // add-button rect.top was negative (off-screen). The fix: scrollIntoCenter
  // calls scrollIntoView + window.scrollBy to push the element below the
  // sticky header. Pinned here.
  //
  // We assert against the script's own `default_btn_pre_click` ADD_DEBUG
  // message, which captures the button's bounding rect AFTER scrollIntoCenter
  // ran but BEFORE the click (and the button's subsequent unmount). This is
  // exactly what production code reads and the only stable place to check.
  it('default_btn_pre_click rect.y is below the sticky header (>= 0)', async () => {
    const runner = await loadFixture(fx('_synthetic-tile.html'));
    try {
      // Make the page tall and add a fixed-position header so the tile starts
      // partially under it, simulating the off-screen condition we hit in
      // production.
      await runner.page.evaluate(() => {
        document.body.style.minHeight = '2000px';
        // The synthetic fixture already has a .header div fixed at top:0 h:80px.
        window.scrollTo(0, 0);
      });

      const script = scripts.buildSearchAndAddScript('Wegmans Pico de Gallo Salsa', 1, null);
      await runner.inject(script);

      // Wait for the SEARCH_AND_ADD_RESULT terminal message — by then all
      // ADD_DEBUG messages have been posted, so we can scan for the
      // default_btn_pre_click snapshot.
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 10_000).catch(() => {});
      const preClick = runner
        .messagesOfType('ADD_DEBUG')
        .find((m) => m.step === 'default_btn_pre_click');

      expect(preClick).toBeDefined();
      expect(preClick!.found).toBe(true);
      // The button's top should be >= 0 (not negative / above viewport).
      // In practice scrollIntoCenter aims for ~100px below the sticky header.
      expect(preClick!.rect.y).toBeGreaterThanOrEqual(0);
    } finally {
      await runner.close();
    }
  });
});

describe('Wegmans regression: bubble state (product already in cart)', () => {
  // Pins the State 2 (isBubble:true) path in buildSearchAndAddScript that
  // was at the heart of the May-18 add-to-cart bugs. Auto-skips until the
  // fixture is captured via the admin screen.
  itWithFixture(
    'search-results-product-in-cart.html',
    'detects isBubble:true when default-add-button shows a digit',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Wegmans Sour Cream', 1, null);
      await runner.inject(script);
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 15_000).catch(() => {});

      const decision = runner
        .messagesOfType('ADD_DEBUG')
        .find((m) => m.step === 'state_decision');
      expect(decision).toBeDefined();
      // When the product is already in cart, the default-add-button text
      // contains the quantity digit, so isBubble MUST be true.
      expect(decision!.isBubble).toBe(true);
    },
  );

  itWithFixture(
    'search-results-product-in-cart.html',
    'enters State 2 (bubble) path, not State 1 (fresh-add)',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Wegmans Sour Cream', 2, null);
      await runner.inject(script);
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 15_000).catch(() => {});

      // State 2 (bubble) posts state2_bubble_incBtn AFTER clicking the bubble.
      // State 1 (fresh) posts state1_fresh_post_first_incBtn instead. We
      // must see the State 2 marker and NOT the State 1 marker.
      const state2 = runner
        .messagesOfType('ADD_DEBUG')
        .find((m) => m.step === 'state2_bubble_incBtn');
      const state1 = runner
        .messagesOfType('ADD_DEBUG')
        .find((m) => m.step === 'state1_fresh_post_first_incBtn');
      expect(state2).toBeDefined();
      expect(state1).toBeUndefined();
    },
  );
});

describe('Wegmans regression: stepper already open (State 3)', () => {
  // Pins the State 3 path — when the stepper is already visible inside a
  // tile (rare, but the script must handle it). Auto-skips until captured.
  itWithFixture(
    'search-results-stepper-open.html',
    'enters State 3 (incBtn already present) and adds QTY directly',
    async (runner) => {
      const script = scripts.buildSearchAndAddScript('Wegmans Sour Cream', 2, null);
      await runner.inject(script);
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 15_000).catch(() => {});

      // State 3 takes the `if (incBtn)` early-return branch — distinguishable
      // by the state3_stepper_open_incBtn debug message.
      const state3 = runner
        .messagesOfType('ADD_DEBUG')
        .find((m) => m.step === 'state3_stepper_open_incBtn');
      expect(state3).toBeDefined();
    },
  );
});
