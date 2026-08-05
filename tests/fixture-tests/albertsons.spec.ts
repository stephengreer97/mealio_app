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
  // twice for responsive layouts). Qty comes from the cart-qty display text,
  // NOT the stepper button id suffix (that suffix is a row index). Fixture has
  // Basmati x1 + Hunt's x1 → 2 units, 2 distinct items.
  itWithFixture(
    'cart-with-items.html',
    'sums cart line-item quantities (deduped) and posts CART_COUNT',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('acme')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBe(2);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(2);
      const byName = Object.fromEntries(
        result.items.map((it: { name: string; qty: number }) => [it.name, it.qty]),
      );
      const basmati = Object.keys(byName).find((n) => /basmati/i.test(n));
      const hunts = Object.keys(byName).find((n) => /hunt/i.test(n));
      expect(basmati && byName[basmati]).toBe(1);
      expect(hunts && byName[hunts]).toBe(1);
    },
  );
});

describe('Albertsons regression: product already in cart (collapsed bubble)', () => {
  // When the searched product is already in the cart, Albertsons shows a
  // collapsed qty bubble (no ATC button) with a TRUNCATED aria-label. The add
  // script must match that bubble to the product and CLICK it (to reveal the
  // stepper) rather than bailing as "not found".
  itWithFixture(
    'search-results-collapsed-bubble.html',
    'matches the truncated bubble to the product and clicks it',
    async (runner) => {
      // Flag the bubble click (the static fixture has no real handler).
      await runner.page.evaluate(() => {
        const b = document.querySelector('[data-qa="qty-stppr-bbl"]');
        if (b) b.addEventListener('click', () => {
          (window as unknown as { __bubbleClicked?: boolean }).__bubbleClicked = true;
        });
      });
      const script = scripts.buildSearchAndAddScript(
        'Lucerne Heavy Whipping Cream - 16 Oz',
        1,
        null,
      );
      await runner.inject(script);
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      const clicked = await runner.page.evaluate(
        () => (window as unknown as { __bubbleClicked?: boolean }).__bubbleClicked === true,
      );
      expect(clicked).toBe(true);
    },
  );
});

describe('Albertsons family CHECK_LOGIN_SCRIPT', () => {
  // NOTE ON WHAT THESE FIXTURES CAN AND CANNOT PROVE (MEAL-42).
  //
  // There is a logged-IN capture here but no logged-OUT one, so every assertion
  // below is about the logged-in side of the marker. The logged-out side — that
  // the same control reads "Sign In" when signed out — is asserted by
  // tests/live/helpers/logout-albertsons.ts against the real site, not here.
  // Don't "strengthen" the passive rule on the strength of these fixtures alone:
  // they cannot tell you what the header looks like signed out.
  //
  // Also note the fixture runner blocks stylesheets, so Bootstrap's `d-none`
  // never applies and hidden markup shows up in innerText. That is exactly why
  // the old body-text test was vacuous: logged-in-home.html contains "Sign Out"
  // in the (CSS-hidden) flyout markup, so scanning body text "passed" without
  // the click ever doing anything. Assert on attributes and script behaviour,
  // never on visibility.

  // The passive marker the fast path actually reads. Pins BOTH halves: the
  // account control's aria-label (what acctIsMenu matches) and the name span
  // inside it (documented at the top of albertsons.ts as the login marker).
  // If Albertsons renames either, this fails instead of the check silently
  // falling back to the slow click path.
  itWithFixture(
    'logged-in-home.html',
    'pins the passive logged-in marker: account control + hdr-accnt-nm span',
    async (runner) => {
      const marker = await runner.page.evaluate(() => {
        const link = document.querySelector('[data-qa="hdr-accnt-lnk"]');
        const nameSpan = document.querySelector('span[data-qa="hdr-accnt-nm"]');
        return {
          linkAria: link ? link.getAttribute('aria-label') : null,
          nameText: nameSpan ? (nameSpan.textContent || '').trim() : null,
        };
      });
      // Logged in, the control announces itself as the account menu…
      expect(marker.linkAria).toMatch(/account\s*menu/i);
      // …and the name span holds a user name, NOT a sign-in call to action.
      expect(marker.nameText).toBeTruthy();
      expect(marker.nameText).not.toMatch(/sign\s?in|sign\s?up|log\s?in|create account/i);
    },
  );

  // Non-vacuous replacement for the old body-text test: the verdict must be
  // reached WITHOUT clicking the account control. Previously the script clicked
  // and then waited a flat 1.5s; this asserts the click never happens, so a
  // regression back to the click path fails here rather than just getting slower.
  itWithFixture(
    'logged-in-home.html',
    'decides logged-in passively — no click on the account control',
    async (runner) => {
      await runner.page.evaluate(() => {
        (window as unknown as { __clicked: string[] }).__clicked = [];
        document.addEventListener(
          'click',
          (e) => {
            const t = e.target as Element;
            const el = (t.closest && t.closest('a,button')) || t;
            (window as unknown as { __clicked: string[] }).__clicked.push(
              el.getAttribute('data-qa') || el.tagName,
            );
          },
          true,
        );
      });

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);

      const clicked = await runner.page.evaluate(
        () => (window as unknown as { __clicked: string[] }).__clicked,
      );
      expect(clicked).toEqual([]);

      // And it decided from the passive marker, not the click fallback.
      const decision = runner
        .messagesOfType('LOGIN_DEBUG')
        .find((m) => m.step === 'passive_decision');
      expect(decision?.decided).toBe('loggedIn');
      expect(runner.messagesOfType('LOGIN_DEBUG').some((m) => m.step === 'after_click')).toBe(false);
    },
  );

  // The re-injection latch. WebViewCartSheet and SilentLoginProbe both re-inject
  // on page loads; without the latch each injection re-ran the whole detection
  // AND stacked another 3-minute LOGIN_COMPLETE background poll.
  itWithFixture(
    'logged-in-home.html',
    'posts exactly one LOGIN_STATUS when injected repeatedly in one context',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      await runner.waitForMessage('LOGIN_STATUS', 12_000);
      await runner.inject(scripts.checkLoginScript);
      await runner.inject(scripts.checkLoginScript);
      await new Promise((r) => setTimeout(r, 500));
      expect(runner.messagesOfType('LOGIN_STATUS')).toHaveLength(1);
    },
  );

  // The ~5s saving in MEAL-42: after the SSO round-trip the page reloads into a
  // FRESH JS context (window latches gone) but the SAME sessionStorage. The
  // second run must answer from cache instead of redoing detection.
  //
  // sessionStorage is stubbed rather than real because the fixture is loaded via
  // setContent on an opaque origin, where the real one throws SecurityError.
  // Stubbing keeps the test offline and deterministic; it exercises the same
  // getItem/setItem calls the script makes.
  itWithFixture(
    'logged-in-home.html',
    're-check after an SSO reload answers from sessionStorage without re-detecting',
    async (runner) => {
      await runner.page.evaluate(() => {
        const store: Record<string, string> = {};
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

      await runner.inject(scripts.checkLoginScript);
      expect((await runner.waitForMessage('LOGIN_STATUS', 12_000)).isLoggedIn).toBe(true);

      // Simulate the post-SSO reload: fresh JS context, storage survives.
      runner.clearMessages();
      await runner.page.evaluate(() => {
        delete (window as unknown as Record<string, unknown>).__albLoginPosted;
        delete (window as unknown as Record<string, unknown>).__albLoginCheckActive;
      });

      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 12_000);
      expect(status.isLoggedIn).toBe(true);

      const debug = runner.messagesOfType('LOGIN_DEBUG');
      expect(debug.find((m) => m.step === 'passive_decision')?.via).toBe('sessionStorage');
      // Proof it skipped detection: no profile-button scan happened at all.
      expect(debug.some((m) => m.step === 'profile_btn')).toBe(false);
    },
  );

  // Pinning test: the captured account-panel DOM must contain "Sign Out"
  // / "Log Out" text. Catches real markup drift in the click fallback's
  // terminal condition.
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

describe('Albertsons family CHECK_LOGIN on an SSO interstitial', () => {
  // Albertsons bounces through …/bin/safeway/unified/sso/authorize?code=… on the
  // way to the storefront. That page has no site header, so the old script polled
  // 3s for an account control, found none, and posted isLoggedIn:false —
  // measured at 3008ms to a WRONG answer, which SilentLoginProbe then latched
  // permanently (a login wall for an already-signed-in user).
  //
  // The fixture body is irrelevant here; the URL is the whole point, so any
  // header-less capture stands in for the interstitial.
  itWithFixture(
    'search-results-collapsed-bubble.html',
    'posts no verdict from an sso/authorize URL',
    async (runner) => {
      // Guard: if the navigation didn't take, this test would pass vacuously.
      const href = await runner.page.evaluate(() => window.location.href);
      expect(href).toContain('sso/authorize');

      await runner.inject(scripts.checkLoginScript);
      await new Promise((r) => setTimeout(r, 4_000)); // > the old 3s dead poll

      expect(runner.messagesOfType('LOGIN_STATUS')).toEqual([]);
      expect(
        runner.messagesOfType('LOGIN_DEBUG').some((m) => m.step === 'skip_auth_redirect'),
      ).toBe(true);
    },
    { url: 'https://www.albertsons.com/bin/safeway/unified/sso/authorize?code=test' },
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
    // The extractor now bails unless it's on a real search-results page (guards
    // against scraping homepage/recommendation carousels), so load the fixture
    // under a matching URL.
    { url: 'https://www.albertsons.com/shop/search-results.html?q=tortillas' },
  );
});
