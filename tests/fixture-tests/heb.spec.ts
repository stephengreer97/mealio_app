// H-E-B fixture tests.
//
// All tests auto-skip when their fixture file isn't present. Activate by
// running `npm run capture -- heb`.

import { getStoreScripts } from '../../src/lib/webview-scripts';
import {
  loadAutomationConfig,
  __resetAutomationConfigForTests,
} from '../../src/lib/automation-config';
import { buildCartPageCountScript } from '../../src/lib/webview-scripts/cart-count';
import { storeFixtures } from './_helpers';
import { FixtureRunner } from '../fixture-runners/runScript';

const { itWithFixture } = storeFixtures('heb');
const scripts = getStoreScripts('heb')!;

// ── MEAL-13 helpers ───────────────────────────────────────────────────────────

/**
 * The extract script built with `nextDataSearch` pushed ON, i.e. what a device
 * runs after the config flip. Built through the same remote-config path the app
 * uses, so this also proves the flag actually reaches the injected string.
 */
async function extractScriptWithNextData(): Promise<string> {
  await loadAutomationConfig(async () => ({
    version: 13,
    config: { stores: { heb: { nextDataSearch: true } } },
  }));
  return getStoreScripts('heb')!.extractProductsScript;
}

/** Run one extractor to completion and return its SEARCH_RESULT. */
async function runExtractor(runner: FixtureRunner, script: string, timeoutMs = 20_000) {
  runner.clearMessages();
  await runner.inject(script);
  return runner.waitForMessage('SEARCH_RESULT', timeoutMs);
}

// The flag is global module state, so every test that flips it must put it back
// or the DOM-path tests below would silently start exercising the JSON path.
afterEach(() => __resetAutomationConfigForTests());

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

  itWithFixture(
    'search-results-weight-dropdown-closed.html',
    'search+add of a weight item with NO chosen weight bubbles needs_weight (prompt first)',
    async (runner) => {
      // No weight passed → the combined add must NOT guess a poundage; it bails
      // with needs_weight + the options so the review UI can prompt once.
      const script = scripts.buildSearchAndAddScript(
        'CAFE Olé by H-E-B Panama Medium Roast Whole Bean Bulk Coffee, lb',
        1,
        null,
      );
      await runner.inject(script);
      const result = await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('needs_weight');
      expect(result.candidates[0].isWeightItem).toBe(true);
      expect(result.candidates[0].weightOptions.length).toBeGreaterThan(0);
      expect(result.candidates[0].weightOptions.every((w: number) => w > 0)).toBe(true);
    },
  );

  itWithFixture(
    'search-results-weight-dropdown-closed.html',
    'detects sold-by-weight items and reads their real lb increments',
    async (runner) => {
      await runner.inject(scripts.extractProductsScript);
      const result = await runner.waitForMessage('SEARCH_RESULT', 14_000);
      const weighty = (result.candidates as any[]).filter(
        (c) => c.isWeightItem && Array.isArray(c.weightOptions) && c.weightOptions.length > 0,
      );
      // The "bulk coffee" search is almost all by-the-pound items.
      expect(weighty.length).toBeGreaterThan(0);
      // Placeholder ("Select a Weight", value 0) filtered out; the remaining
      // options are the real buyable lb weights, positive and ascending.
      expect(weighty.every((c) => c.weightOptions.every((w: number) => w > 0))).toBe(true);
      const w = weighty[0].weightOptions as number[];
      expect(w.length).toBeGreaterThan(1);
      const increment = w[1] - w[0];
      // We read the product's OWN increment from the dropdown (1 lb for these
      // coffees) rather than assuming a fixed lb-per-qty: the first option equals
      // one increment and the steps are uniform.
      expect(increment).toBeGreaterThan(0);
      expect(w[0]).toBeCloseTo(increment);
      expect(w[2] - w[1]).toBeCloseTo(increment);
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

// ── MEAL-13: __NEXT_DATA__ extraction ─────────────────────────────────────────

describe('HEB MEAL-13: __NEXT_DATA__ and DOM extraction agree', () => {
  // The load-bearing test for the swap. Both extractors run against the SAME
  // fixture and must produce the same candidates, field for field — the shape
  // _scoring.ts and the add scripts consume is not allowed to drift.
  //
  // Note the JSON candidates carry two EXTRA keys (productId/skuId, from MEAL-13's
  // acceptance criteria) that no DOM card exposes; they are compared separately.
  const SHARED_FIELDS = [
    'productName',
    'imageUrl',
    'outOfStock',
    'preferences',
    'price',
    'isWeightItem',
    'weightOptions',
  ] as const;

  function shared(c: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const f of SHARED_FIELDS) out[f] = c[f];
    return out;
  }

  // Every committed search fixture whose embedded payload belongs to the search
  // its DOM shows. (search-results-out-of-stock.html deliberately does NOT: see
  // the stale-payload describe below.)
  const AGREEING: Array<[string, string]> = [
    ['search-results-sour-cream.html', 'sour cream'],
    ['search-results-with-preferences.html', 'avocado'],
    ['search-results-weight-dropdown-closed.html', 'bulk coffee'],
    ['search-results-tortillas.html', 'mission flour tortillas'],
    ['search-results-product-in-cart.html', 'sour cream'],
    ['search-results-stepper-open.html', 'sour cream'],
  ];

  for (const [fixture, term] of AGREEING) {
    itWithFixture(
      fixture,
      `JSON candidates are identical to DOM candidates (${term})`,
      async (runner) => {
        const domResult = await runExtractor(runner, scripts.extractProductsScript);
        const jsonResult = await runExtractor(runner, await extractScriptWithNextData());

        expect(jsonResult.source).toBe('next_data');
        expect(domResult.source).toBe('dom');
        expect(domResult.candidates.length).toBeGreaterThan(0);
        // Same products, same order, same count — the JSON list is capped at the
        // same 8 the DOM loop stops at.
        expect(jsonResult.candidates.map(shared)).toEqual(domResult.candidates.map(shared));

        // The two id fields only the JSON path can supply (MEAL-14 depends on them).
        for (const c of jsonResult.candidates) {
          expect(typeof c.productId).toBe('string');
          expect(c.productId.length).toBeGreaterThan(0);
          expect(typeof c.skuId).toBe('string');
          expect(c.skuId.length).toBeGreaterThan(0);
        }
      },
      { url: `https://www.heb.com/search?q=${encodeURIComponent(term)}` },
    );
  }

  // Preference options are the one field the DOM path pays for with clicks: it
  // opens each tile's Add popup and reads the modal rows, for at most the first 5
  // candidates. The payload carries them outright, for every item, with no
  // interaction — same labels, same {text, value} pairs the add scripts match on.
  itWithFixture(
    'search-results-with-preferences.html',
    'reads the avocado ripeness preferences without opening the modal',
    async (runner) => {
      const result = await runExtractor(runner, await extractScriptWithNextData());
      expect(result.source).toBe('next_data');
      expect(result.candidates[0].productName).toBe('Fresh Large Hass Avocado, Each');
      expect(result.candidates[0].preferences).toEqual([
        { text: 'No preference', value: 'No preference' },
        { text: 'Ready Now', value: 'Ready Now' },
        { text: 'Ready Later', value: 'Ready Later' },
      ]);
      // No modal was opened to get them.
      expect(runner.messagesOfType('PREF_DEBUG')).toHaveLength(0);
    },
    { url: 'https://www.heb.com/search?q=avocado' },
  );

  // The name HEB's card renders is displayName + the SKU's size, and for
  // each-priced produce decodedDisplayName omits that size ("Fresh Large Hass
  // Avocado" vs the card's "Fresh Large Hass Avocado, Each"). Getting this wrong
  // would hand scoreMatch a name that can never reach 100 and hand the add script
  // a name no tile's title matches, so it is pinned on its own.
  itWithFixture(
    'search-results-with-preferences.html',
    'appends the SKU size for each-priced items so names match the card exactly',
    async (runner) => {
      const jsonResult = await runExtractor(runner, await extractScriptWithNextData());
      const names: string[] = jsonResult.candidates.map((c: { productName: string }) => c.productName);
      expect(names).toContain('Fresh Large Hass Avocado, Each');
      expect(names).toContain('Fresh Small Hass Avocado, Each');
      // The DOM's own title text for the same tiles, straight from the page.
      const domTitles = await runner.page.evaluate(() =>
        Array.prototype.slice
          .call(document.querySelectorAll('[data-qe-id="productCardContainer"] [data-qe-id="productTitle"]'))
          .slice(0, 8)
          .map((el: any) => el.textContent.trim()),
      );
      expect(names).toEqual(domTitles);
    },
    { url: 'https://www.heb.com/search?q=avocado' },
  );
});

describe('HEB MEAL-13: the DOM extractor is still the fallback', () => {
  // A trimmed capture with no <script id="__NEXT_DATA__"> at all. With the flag ON
  // the extractor must notice, say so, and produce the same DOM answer as before —
  // including still excluding the pairings carousel's granola.
  itWithFixture(
    'search-results-yogurt-pairings-carousel.html',
    'falls back to the DOM when the page has no __NEXT_DATA__',
    async (runner) => {
      const result = await runExtractor(runner, await extractScriptWithNextData());
      expect(result.source).toBe('dom');
      const dbg = runner.messagesOfType('EXTRACT_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg).toBeDefined();
      expect(dbg!.ndReason).toBe('no_next_data');

      const names: string[] = result.candidates.map((c: { productName: string }) => c.productName);
      expect(names).toHaveLength(3);
      expect(names.some((n) => /granola/i.test(n))).toBe(false);
      expect(/yogurt/i.test(names[0])).toBe(true);
    },
  );

  // The discrepancy this ticket has to survive. __NEXT_DATA__ is the INITIAL
  // server render's payload and is not rewritten by an in-page SPA search, so on
  // this capture the DOM is a "HEB season chicken thighs for fajitas" results page
  // while the embedded JSON still describes the earlier "seasonal" search (Morton
  // Season-All Seasoned Salt et al). The DOM is right; the payload is a lie. The
  // freshness gate must catch it and fall back.
  itWithFixture(
    'search-results-out-of-stock.html',
    'rejects a payload left over from the previous SPA search',
    async (runner) => {
      const result = await runExtractor(runner, await extractScriptWithNextData());
      const dbg = runner.messagesOfType('EXTRACT_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg).toBeDefined();
      expect(dbg!.ndReason).toBe('stale');
      expect(dbg!.embeddedTerm).toBe('seasonal');
      expect(dbg!.expectedTerm).toBe('heb season chicken thighs for fajitas');

      // Fell back, and returned what the page actually shows.
      expect(result.source).toBe('dom');
      const names: string[] = result.candidates.map((c: { productName: string }) => c.productName);
      expect(names.some((n) => /chicken thighs/i.test(n))).toBe(true);
      expect(names.some((n) => /season-all/i.test(n))).toBe(false);
      // And the out-of-stock flag still comes off the live Add button.
      expect(result.candidates.some((c: { outOfStock: boolean }) => c.outOfStock)).toBe(true);
    },
    { url: 'https://www.heb.com/search?q=HEB%20season%20chicken%20thighs%20for%20fajitas' },
  );

  // Nothing to check freshness against (no q in the URL, no echoed header) means we
  // cannot prove the payload is for this search, so it goes unused. Same fixture,
  // loaded with no URL: the header still disagrees, but this pins the "decline
  // rather than guess" behavior at the gate's own level.
  itWithFixture(
    'search-results-sour-cream.html',
    'uses the echoed header when the URL carries no search term',
    async (runner) => {
      // No `url` option → window.location has no ?q=. The <h1> "sour cream" is the
      // only signal, and it agrees with the payload, so the JSON path is used.
      const result = await runExtractor(runner, await extractScriptWithNextData());
      expect(result.source).toBe('next_data');
      expect(result.candidates[0].productName).toBe('H-E-B Regular Sour Cream, 16 oz');
    },
  );

  // The flag defaults OFF: a build with no config push must run the DOM extractor,
  // which is what makes this safe to ship.
  itWithFixture(
    'search-results-sour-cream.html',
    'bundled default keeps the DOM extractor',
    async (runner) => {
      __resetAutomationConfigForTests();
      const result = await runExtractor(runner, getStoreScripts('heb')!.extractProductsScript);
      expect(result.source).toBe('dom');
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
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

  // Sold-by-weight lines (Deli / Fish Market / bulk) have NO
  // cartQuantityCounterValue — the snapshot must read their weight from the
  // itemRowWeighedQuantityDropdown / "Quantity: N lb" a11y text and tag them
  // isWeight, so reconcile confirms them by presence instead of re-adding (they
  // used to read as qty 0 → "missing" → double-added).
  itWithFixture(
    'cart-with-weight-item.html',
    'reads sold-by-weight lines as isWeight with their lb amount',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('heb')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      const weighty = (result.items as any[]).filter((it) => it.isWeight);
      // The captured cart has multiple by-the-pound items (Bulk Coffee, Deli
      // Roast Beef, Fish Market Trout).
      expect(weighty.length).toBeGreaterThan(0);
      // Each carries a positive lb weight and counts as one present unit.
      expect(weighty.every((it) => typeof it.weight === 'number' && it.weight > 0)).toBe(true);
      expect(weighty.every((it) => it.qty === 1)).toBe(true);
      // The bulk coffee is one of them.
      expect(weighty.some((it) => /bulk coffee/i.test(it.name))).toBe(true);
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
    'finds and adds the exact-match tile (posts SEARCH_AND_ADD_RESULT)',
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
      // The script found and clicked the exact-match tile. In a STATIC fixture a
      // click can't move the real cart badge, so the cart-confirmation gate
      // reports cart_not_incremented — what matters here is that it matched the
      // RIGHT product. (Live, the badge ticks up and success is true.)
      expect(result.productName).toBe('Mission Super Soft Flour Tortillas, Fajita Size, 40 ct');
    },
    { url: 'https://www.heb.com/search?q=mission%20flour%20tortillas' },
  );
});
