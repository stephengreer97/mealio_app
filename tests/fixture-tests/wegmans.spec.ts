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

import { loadFixture, FixtureRunner } from '../fixture-runners/runScript';
import { getScripts } from '../../src/lib/webview-scripts/wegmans';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';

const { fxPath, itWithFixture } = storeFixtures('wegmans');
const fx = fxPath;
const scripts = getScripts();

const LOGIN_CACHE_KEY = 'mealio_wegmans_login_state';

/** Every selector readState() will look at, kept in one place. */
const GREETING_SEL =
  'button.component--site-header-desktop-sign-in-greeting-button, ' +
  'button[class*="sign-in-greeting-button"], ' +
  'button[aria-label="Account"]';

/**
 * Replace sessionStorage with an in-page stub. The fixture is loaded via
 * setContent on an opaque origin where the real sessionStorage throws
 * SecurityError, and the script swallows that — so without a stub the cache
 * tests would pass vacuously. The stub also lets the test read back what the
 * script stored. Same arrangement as tests/fixture-tests/albertsons.spec.ts.
 */
async function stubSessionStorage(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const store: Record<string, string> = {};
    (window as unknown as { __wegStore: Record<string, string> }).__wegStore = store;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = String(v);
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
    });
  });
}

/** What the script has actually written to the stubbed cache (null if absent). */
async function readCachedLoginState(runner: FixtureRunner): Promise<string | null> {
  return runner.page.evaluate((key) => {
    const store = (window as unknown as { __wegStore?: Record<string, string> }).__wegStore;
    return store && key in store ? store[key] : null;
  }, LOGIN_CACHE_KEY);
}

/** Simulate a page reload: the JS-context latches go, sessionStorage survives. */
async function clearWindowLatches(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.__wegmansLoginPosted;
    delete w.__wegmansLoginObserver;
  });
}

/**
 * Turn the captured logged-in header into the signed-out one: every greeting
 * button reads "Sign In" instead of "Hello, <name>". Also neutralises readState's
 * fallback scan (any header/nav span starting with "Hello,"), which would
 * otherwise still answer 'in' off the other header variant in this capture.
 */
async function flipHeaderToSignedOut(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate((sel) => {
    const btns = document.querySelectorAll(sel);
    if (btns.length === 0) throw new Error('fixture drift: no greeting button matches ' + sel);
    btns.forEach((b) => {
      b.textContent = 'Sign In';
    });
    document.querySelectorAll('header span, nav span').forEach((s) => {
      if ((s.textContent || '').trim().indexOf('Hello,') === 0) s.textContent = 'Sign In';
    });
  }, GREETING_SEL);
}

/** Put the greeting back, as a post-sign-in reload would. */
async function flipHeaderToSignedIn(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) throw new Error('fixture drift: no greeting button matches ' + sel);
    btn.textContent = 'Hello, Stephen';
  }, GREETING_SEL);
}

/**
 * The unhydrated MSAL landing page: no account control at all, and no greeting
 * anywhere for the fallback scan to find. readState() must be genuinely
 * inconclusive, so this asserts that rather than assuming it.
 */
async function stripAccountControls(runner: FixtureRunner): Promise<void> {
  await runner.page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => el.remove());
    document.querySelectorAll('header span, nav span').forEach((s) => {
      if ((s.textContent || '').trim().indexOf('Hello,') === 0) s.remove();
    });
  }, GREETING_SEL);
  const leftovers = await runner.page.evaluate((sel) => {
    return {
      btns: document.querySelectorAll(sel).length,
      greetings: Array.from(document.querySelectorAll('header span, nav span')).filter(
        (s) => (s.textContent || '').trim().indexOf('Hello,') === 0,
      ).length,
    };
  }, GREETING_SEL);
  expect(leftovers.btns).toBe(0);
  expect(leftovers.greetings).toBe(0);
}

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
    // The script refuses to count anywhere but /cart (MEAL-152), so the fixture
    // has to be served from the URL it was captured at.
    { url: 'https://www.wegmans.com/cart' },
  );

  // MEAL-152. No redirect has been observed on www.wegmans.com/cart (200, 0
  // redirects, measured 2026-08-07 anonymously under the app's mobile UA), so
  // this guard is a no-op on today's Wegmans and this test is a standing
  // guarantee rather than a regression pin for a live defect. What it pins is
  // the rule: "the cart is empty" and "we are not on the cart" must not be the
  // same zero, because a trusted zero baseline makes the done screen attribute
  // the user's own cart to this run.
  itWithFixture(
    'cart-with-items.html',
    'posts count:null off the cart path instead of a trusted count (MEAL-152)',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('wegmans')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBeNull();
      expect(result.reason).toBe('not_cart_page');
      expect(result.url).toBe('https://www.wegmans.com/');
      expect(result.items).toBeUndefined();
    },
    { url: 'https://www.wegmans.com/' },
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

// ── The sessionStorage login cache (MEAL-114) ──────────────────────────────
//
// Wegmans had the same design MEAL-42 removed from Albertsons: the cache was an
// unconditional fast path AHEAD of detection, only ever wrote 'in', and never
// called removeItem. So after a mid-session logout or a session expiry the
// greeting button plainly read "Sign In" and the cache still answered true, for
// the rest of the WebView's life. Both consumers reach it — SilentLoginProbe is
// generic over storeId and latches; WebViewCartSheet re-injects at the login step
// for any URL matching isLoginSuccessUrl, and Wegmans' rule (any wegmans.com URL
// that is not /sign-in or /login) is more permissive than Albertsons'.
//
// A false logged-in is the direction that breaks a run silently: every search
// runs against a signed-out session, every add fails, and no login wall is ever
// shown. These four tests pin the corrected contract, mirroring albertsons.spec:
//   1. live detection always beats the cache (the post-logout re-scan),
//   2. a negative verdict CLEARS a cached positive,
//   3. the cache is still consulted when detection is inconclusive,
//   4. inconclusive with nothing cached resolves to signed OUT.
//
// sessionStorage is stubbed rather than real because the fixture is loaded via
// setContent on an opaque origin, where the real one throws SecurityError and the
// script swallows it — unstubbed, every test here would pass vacuously.
describe('Wegmans CHECK_LOGIN_SCRIPT sessionStorage cache', () => {
  // 1 + 2. THE REGRESSION. First run caches 'in'; then the header flips to the
  // signed-out shape and the window latches clear — a post-logout reload in the
  // same WebView, where sessionStorage survives but __wegmansLoginPosted does not.
  // The verdict must follow the header, and the disproved positive must be gone.
  itWithFixture(
    'logged-in-home.html',
    'post-logout reload re-detects and posts false — the cached positive does not win',
    async (runner) => {
      await stubSessionStorage(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);
      // Guard: the positive really was cached, so this test can't pass vacuously.
      expect(await readCachedLoginState(runner)).toBe('in');

      runner.clearMessages();
      await flipHeaderToSignedOut(runner);
      await clearWindowLatches(runner);

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(false);

      // It read the header, not the cache.
      const scan = runner.messagesOfType('LOGIN_DEBUG').find((m) => m.step === 'scan_result');
      expect(scan?.via).toBe('btn_signin');
      // And the disproved positive is gone, so nothing downstream can read it.
      expect(await readCachedLoginState(runner)).toBeNull();
    },
  );

  // 'out' is still never written — that would defeat the post-sign-in re-check,
  // which is the mechanism by which we notice the user finishing a login. So a
  // negative must not poison the next run.
  itWithFixture(
    'logged-in-home.html',
    'never caches a negative, so a later sign-in is still detected',
    async (runner) => {
      await stubSessionStorage(runner);
      await flipHeaderToSignedOut(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(false);
      expect(await readCachedLoginState(runner)).toBeNull();

      // The user signs in; the store reloads onto the storefront.
      runner.clearMessages();
      await flipHeaderToSignedIn(runner);
      await clearWindowLatches(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);
      expect(await readCachedLoginState(runner)).toBe('in');
    },
  );

  // 3. The one legitimate use, kept: the MSAL landing page whose header has not
  // hydrated. Detection finds no greeting control at all, and WITHOUT the cache
  // the watchdog would post isLoggedIn:false — the exact wrong answer
  // SilentLoginProbe latches permanently. Takes >8s: that is the watchdog, and
  // the delay is the price of putting detection first.
  itWithFixture(
    'logged-in-home.html',
    'answers from sessionStorage when detection is inconclusive (unhydrated header)',
    async (runner) => {
      await stubSessionStorage(runner);

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);

      runner.clearMessages();
      await stripAccountControls(runner);
      await clearWindowLatches(runner);

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 15_000);
      expect(status.isLoggedIn).toBe(true);

      // Detection ran FIRST and came up empty — that is what licenses the cache.
      const scan = runner.messagesOfType('LOGIN_DEBUG').find((m) => m.step === 'scan_result');
      expect(scan?.via).toBe('sessionStorage');
    },
  );

  // 4. THE DIRECTION THAT MATTERS. Inconclusive, and nothing cached to fall back
  // on. This must resolve to signed OUT — which shows the user a login wall —
  // never to signed in, which would run the whole cart against a signed-out
  // session and fail every add with no visible error.
  itWithFixture(
    'logged-in-home.html',
    'inconclusive with nothing cached resolves to signed OUT (fail closed)',
    async (runner) => {
      await stubSessionStorage(runner);
      await stripAccountControls(runner);

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 15_000);
      expect(status.isLoggedIn).toBe(false);

      const scan = runner.messagesOfType('LOGIN_DEBUG').find((m) => m.step === 'scan_result');
      expect(scan?.via).toBe('inconclusive_fail_closed');
      expect(await readCachedLoginState(runner)).toBeNull();
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
