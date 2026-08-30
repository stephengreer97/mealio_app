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
import { buildHebCartQueryFn } from '../../src/lib/webview-scripts/heb-cart-query';
import { buildPresearchWorker } from '../../src/lib/webview-scripts/worker-search';
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
  //
  // The budget is 20s, not 12s, and that is not slack for a slow assertion.
  // Reaching a logged-out verdict COSTS 8.2s by construction: CHECK_LOGIN polls
  // 40 × 200ms (heb.ts:418) for a "log out" marker that a logged-out page will
  // never show, plus a 200ms close, and only then reports.
  //
  // Measured, three idle runs: 8309 / 8310 / 11903 ms. Two modes ~3.6s apart — the
  // same step aldi.spec.ts documents on three other waits. The fast mode is 42% of
  // the new 20s budget; the SLOW mode is 8ms short of failing the old 12s one,
  // which is the whole story of why this test was intermittent.
  //
  // What widening does and does not buy. It cannot hide a killed or silent script:
  // one that never posts fails anyway, 8s later, with the same error. It does raise
  // the tolerated latency ceiling — from about 1.46× the 8.2s structural floor to
  // about 2.44× — so a real regression that merely makes this path ~2× slower now
  // passes. That is the price of not failing on load, and it is worth paying only
  // because this test's verdict (isLoggedIn === false) is asserted, so a wrong
  // answer still fails on the answer.
  itWithFixture(
    'logged-in-home.html',
    'CHECK_LOGIN reports logged-out when no "Log out" marker is visible',
    async (runner) => {
      await runner.inject(scripts.checkLoginScript);
      const status = await runner.waitForMessage('LOGIN_STATUS', 20_000);
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
  // opens each tile's Add popup and reads the modal rows, for every candidate
  // carrying a dialog (MEAL-180 raised that cap above the 8-candidate ceiling).
  // The payload carries them outright, for every item, with no interaction —
  // same labels, same {text, value} pairs the add scripts match on.
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

// ── MEAL-180: what the preference probe's budget is allowed to spend ───────────
//
// The probe is the only thing that turns an item with a store preference into a
// preference SELECTOR in Choose Products. A card it skips arrives with
// preferences:null and the user is never asked — the setting then surfaces only
// after the add fails, which is the bug Stephen reported.
//
// It used to be gated on `candidates.length < 5`: a budget counted in ACCEPTED
// CANDIDATES rather than in probes performed, so cards with no dialog to open —
// which cost nothing, no click, no poll, no modal — spent it anyway. His "sliced
// turkey" search was seven pre-packaged deli cards and, at DOM index 6, the one
// Custom Sliced item that HAS a preference. The budget was gone before the loop
// reached it, and the log showed zero probes had actually run.
//
// The avocado capture has exactly one popup-bearing card, so moving it to index 6
// reproduces that shape out of real store DOM. Fails on `< 5`; passes now.
describe('HEB MEAL-180: preference probe budget', () => {
  itWithFixture(
    'search-results-with-preferences.html',
    'probes the one card with a dialog when it sits past the old 5-card cap',
    async (runner) => {
      const popupIndexes = await runner.page.evaluate(() => {
        const scope =
          document.querySelector('[data-qe-id="productCardContainer"]') ||
          document.querySelector('#search_product_grid') ||
          document;
        const cards = () =>
          Array.prototype.slice.call(
            scope.querySelectorAll('[data-qe-id="productCard"]'),
          ) as HTMLElement[];
        // Move the whole grid CELL, not the card node — the card is nested
        // inside the cell the grid lays out, and reparenting the inner node
        // would change the DOM in a way the real page never does.
        const cell = (card: HTMLElement) => {
          let n = card;
          while (n.parentElement && n.parentElement !== scope) n = n.parentElement;
          return n;
        };
        const before = cards();
        cell(before[6]).after(cell(before[0]));
        return cards()
          .map((c, i) => {
            const btn = c.querySelector('button[data-qe-id="addToCart"]');
            return btn && btn.getAttribute('aria-haspopup') === 'true' ? i : -1;
          })
          .filter((i) => i >= 0);
      });
      // If a re-capture ever changes which tiles carry a dialog this test stops
      // reproducing MEAL-180's shape, and says so here rather than passing
      // vacuously below.
      expect(popupIndexes).toEqual([6]);

      const result = await runExtractor(runner, scripts.extractProductsScript);
      expect(result.source).toBe('dom');
      expect(result.candidates[6].productName).toBe('Fresh Large Hass Avocado, Each');
      expect(result.candidates[6].preferences).toEqual([
        { text: 'No preference', value: 'No preference' },
        { text: 'Ready Now', value: 'Ready Now' },
        { text: 'Ready Later', value: 'Ready Later' },
      ]);
      // And it cost exactly the one probe the page had to offer.
      expect(
        runner.messagesOfType('PREF_DEBUG').filter((m) => m.step === 'clicking_add'),
      ).toHaveLength(1);
    },
    { url: 'https://www.heb.com/search?q=avocado', testTimeoutMs: 60_000 },
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

  // No q in the URL means nothing independent to check the payload against, so it
  // goes unused — even though this fixture's <h1> and payload agree.
  //
  // The <h1> is not an acceptable substitute, which is why it is not consulted:
  // during an SPA search the h1 and the payload lag TOGETHER (the h1 still shows
  // the previous term until the new results render, and the previous term is
  // exactly what the payload holds), so "they agree" is not evidence of freshness.
  // The DOM path can gate on the h1 because it POLLS it against the URL term; with
  // no URL term there is nothing to poll against.
  itWithFixture(
    'search-results-sour-cream.html',
    'declines the payload when the URL carries no search term',
    async (runner) => {
      // No `url` option → window.location has no ?q=.
      const result = await runExtractor(runner, await extractScriptWithNextData());
      const dbg = runner.messagesOfType('EXTRACT_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg?.ndReason).toBe('unverifiable');
      expect(result.source).toBe('dom');
      // Still answers, off the DOM.
      expect(result.candidates[0].productName).toBe('H-E-B Regular Sour Cream, 16 oz');
    },
  );

  // What the h1 fallback actually let through, kept as the regression. This is the
  // stale-payload fixture again — DOM showing chicken thighs, payload describing an
  // earlier "seasonal" search — loaded with no q and with its h1 rewritten to the
  // payload's term, which is what an SPA search looks like mid-flight. Trusting the
  // h1 here served Morton Season-All for a chicken-thighs search with
  // `why: 'ok'`; the gate must decline instead.
  itWithFixture(
    'search-results-out-of-stock.html',
    'an <h1> that agrees with a stale payload is not evidence of freshness',
    async (runner) => {
      await runner.page.evaluate(() => {
        const h1 = document.querySelector('#searchGridHeader');
        if (h1) h1.textContent = '“seasonal”';
      });
      const result = await runExtractor(runner, await extractScriptWithNextData());
      const dbg = runner.messagesOfType('EXTRACT_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg?.ndReason).toBe('unverifiable');
      expect(result.source).toBe('dom');
      const names: string[] = result.candidates.map((c: { productName: string }) => c.productName);
      expect(names.some((n) => /season-all/i.test(n))).toBe(false);
      expect(names.some((n) => /chicken thighs/i.test(n))).toBe(true);
    },
  );

  // The `unverifiable` guard's own mutation test. Deleting `if (!expected) return
  // …'unverifiable'…` used to leave every HEB test passing, because on the fixtures
  // the payload's term is non-empty and the gate then declined as 'stale' anyway.
  // This is the case that has no such safety net: a grid-bearing page where the
  // payload's search term is EMPTY too, so '' !== '' is false and a guardless gate
  // accepts 38 products with zero verification that they belong to this search.
  itWithFixture(
    'search-results-sour-cream.html',
    'declines a grid whose payload carries no search term either (no q, no term)',
    async (runner) => {
      await runner.page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__')!;
        const nd = JSON.parse(el.textContent!);
        nd.props.pageProps.searchTerm = '';
        nd.query = {};
        el.textContent = JSON.stringify(nd);
      });
      const result = await runExtractor(runner, await extractScriptWithNextData());
      const dbg = runner.messagesOfType('EXTRACT_DEBUG').find((m) => m.step === 'next_data');
      // The grid is intact and non-empty — 'no_grid'/'empty' would mean this test
      // stopped exercising the guard.
      expect(dbg?.ndReason).toBe('unverifiable');
      expect(result.source).toBe('dom');
    },
  );

  // An unexpected payload SHAPE must fall back, not kill the script. Next.js parses
  // a repeated ?q= into an ARRAY, and __hebNorm's .toLowerCase() cannot take one:
  // the throw escaped the extractor entirely, so the page posted NOTHING — no
  // EXTRACT_DEBUG, no SEARCH_RESULT — and the item died on the engine's search
  // timeout. "HEB changed the payload" is the exact risk this fallback exists for.
  itWithFixture(
    'search-results-sour-cream.html',
    'falls back to the DOM when reading the payload throws',
    async (runner) => {
      await runner.page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__')!;
        const nd = JSON.parse(el.textContent!);
        delete nd.props.pageProps.searchTerm;
        nd.query = { q: ['sour cream', 'sour cream'] };  // what ?q=x&q=x parses to
        el.textContent = JSON.stringify(nd);
      });
      const result = await runExtractor(runner, await extractScriptWithNextData());
      const dbg = runner.messagesOfType('EXTRACT_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg?.ndReason).toBe('threw');
      expect(dbg?.ndError).toMatch(/toLowerCase/);
      // Fell back and answered off the DOM, like every other failure reason.
      expect(result.source).toBe('dom');
      expect(result.candidates[0].productName).toBe('H-E-B Regular Sour Cream, 16 oz');
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
  );

  // A malformed NAME field reads as absent, never as a candidate. Fed
  // `decodedDisplayName: {weird:1}` the reader used to emit a candidate whose
  // productName was an OBJECT, tagged source: 'next_data' — something the DOM path
  // cannot produce and that scoreMatch and the add scripts both call string methods
  // on. Two items, for the two ways it must read as absent: item 0 still has a
  // usable fullDisplayName (the next field answers), item 1 has no string name
  // anywhere (no candidate at all).
  //
  // Both items' SKU size is blanked deliberately. With a size present the old code
  // reached `name.slice(...)` and threw, which the new call-site catch would turn
  // into an honest DOM fallback — a pass for the wrong reason. Blanking the size
  // skips the append, which is the path that actually let the object THROUGH.
  itWithFixture(
    'search-results-sour-cream.html',
    'treats a non-string display name as absent instead of passing it through',
    async (runner) => {
      const skipped = await runner.page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__')!;
        const nd = JSON.parse(el.textContent!);
        const grid = nd.props.pageProps.layout.visualComponents.find(
          (c: { __typename: string }) => c.__typename === 'SearchGridV2',
        );
        for (const it of [grid.items[0], grid.items[1]]) it.SKUs[0].customerFriendlySize = '';
        grid.items[0].decodedDisplayName = { weird: 1 };  // fullDisplayName survives
        const gone = grid.items[1].decodedDisplayName;
        grid.items[1].decodedDisplayName = { weird: 1 };
        grid.items[1].fullDisplayName = 42;
        grid.items[1].displayName = null;
        el.textContent = JSON.stringify(nd);
        return gone as string;
      });
      const result = await runExtractor(runner, await extractScriptWithNextData());
      // The payload is still perfectly usable — this is not a fallback test.
      expect(result.source).toBe('next_data');
      const names = result.candidates.map((c: { productName: unknown }) => c.productName);
      // Nothing non-string reached a candidate.
      for (const n of names) expect(typeof n).toBe('string');
      // Item 0's fullDisplayName answered — the object read as absent, not as a name.
      expect(names[0]).toBe('H-E-B Regular Sour Cream, 16 oz');
      // Item 1 had no string name anywhere, so it produced no candidate.
      expect(names).not.toContain(skipped);
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
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

// The flag's whole purpose is a telemetry comparison between the two extractors
// before the DOM path is removed, and both of the signals that comparison needs
// have to survive the worker wrappers to reach RN. The parallel pools do most of
// the searching, and the PRESEARCH worker navigates straight to the results URL —
// a real navigation, i.e. where the JSON path fires most reliably — so a wrapper
// that drops `source` blinds the rollout on its best evidence.
describe('HEB MEAL-13: the rollout signals survive the worker wrappers', () => {
  itWithFixture(
    'search-results-sour-cream.html',
    'presearch worker forwards source + the extractor reason',
    async (runner) => {
      const wrapped = buildPresearchWorker(3, await extractScriptWithNextData());
      runner.clearMessages();
      await runner.inject(wrapped);
      const result = await runner.waitForMessage('WORKER_RESULT', 15_000);
      expect(result.workerId).toBe(3);
      expect(result.phase).toBe('search');
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.source).toBe('next_data');
      // `why` travels on the re-tagged debug message, the only place RN can read it.
      const dbg = runner.messagesOfType('WORKER_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg?.workerId).toBe(3);
      expect(dbg?.ndReason).toBe('ok');
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
  );

  itWithFixture(
    'search-results-sour-cream.html',
    'parallel-search worker forwards source + the extractor reason',
    async (runner) => {
      await extractScriptWithNextData();  // flip the flag, then build via the store hook
      const wrapped = getStoreScripts('heb')!.buildWorkerScript!(2);
      runner.clearMessages();
      await runner.inject(wrapped);
      const result = await runner.waitForMessage('WORKER_RESULT', 15_000);
      expect(result.workerId).toBe(2);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.source).toBe('next_data');
      const dbg = runner.messagesOfType('WORKER_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg?.ndReason).toBe('ok');
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
  );

  // And the fallback case reports itself the same way through the wrapper: source
  // 'dom' with the reason that sent it there, which is what separates "HEB removed
  // the payload" from "the freshness gate declined" in the funnel.
  itWithFixture(
    'search-results-out-of-stock.html',
    'a wrapped worker reports source=dom with the reason it fell back',
    async (runner) => {
      const wrapped = buildPresearchWorker(0, await extractScriptWithNextData());
      runner.clearMessages();
      await runner.inject(wrapped);
      const result = await runner.waitForMessage('WORKER_RESULT', 15_000);
      expect(result.source).toBe('dom');
      const dbg = runner.messagesOfType('WORKER_DEBUG').find((m) => m.step === 'next_data');
      expect(dbg?.ndReason).toBe('stale');
    },
    { url: 'https://www.heb.com/search?q=HEB%20season%20chicken%20thighs%20for%20fajitas' },
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
    // The script refuses to count anywhere but /cart (MEAL-152), so the fixture
    // has to be served from the URL it was captured at.
    { url: 'https://www.heb.com/cart' },
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
    { url: 'https://www.heb.com/cart' },
  );

  // MEAL-148. The reconcile decides an increment-style item by arithmetic —
  // clicks × increment against the poundage the line gained — and it snaps that
  // expectation onto the LINE'S OWN option ladder rather than an assumed step.
  // So the ladder has to survive the trip out of the page, off a real captured
  // cart and not just a hand-built row. This is the reachability half: the unit
  // tests prove snapToWeightLadder snaps, this proves it is given something to
  // snap to.
  itWithFixture(
    'cart-with-weight-item.html',
    'carries each weight line\'s own option ladder out with it (MEAL-148)',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('heb')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      const weighty = (result.items as any[]).filter((it) => it.isWeight);
      expect(weighty.length).toBeGreaterThan(0);
      for (const it of weighty) {
        // A ladder, ascending, with no "Select a Weight" placeholder in it.
        expect(Array.isArray(it.weightOptions)).toBe(true);
        expect(it.weightOptions.length).toBeGreaterThan(1);
        expect(it.weightOptions.every((o: number) => o > 0)).toBe(true);
        expect([...it.weightOptions].sort((a: number, b: number) => a - b)).toEqual(it.weightOptions);
        // The weight the row is SET to is one of the weights it offers. This is
        // the property the arithmetic rests on: the selected value is a choice
        // off this list, not a scale reading, so an expectation snapped to the
        // list is comparable to it.
        expect(it.weightOptions).toContain(it.weight);
      }
      // Uniform ladders starting at the increment are what make N clicks land
      // exactly on an option — pinned here so a captured cart that stops being
      // uniform fails loudly instead of quietly making the arithmetic undecidable.
      for (const it of weighty) {
        const step = it.weightOptions[0];
        it.weightOptions.forEach((o: number, i: number) => {
          expect(o).toBeCloseTo(step * (i + 1), 6);
        });
      }
      // The bulk coffee's ladder is 1 → 5 lb in 1 lb steps.
      const coffee = weighty.find((it) => /bulk coffee/i.test(it.name));
      expect(coffee.weightOptions).toEqual([1, 2, 3, 4, 5]);
    },
    { url: 'https://www.heb.com/cart' },
  );

  // MEAL-152. No redirect has been observed on www.heb.com/cart (200, 0
  // redirects, measured 2026-08-07 anonymously under the app's mobile UA), so
  // this guard is a no-op on today's HEB and this test is a standing guarantee
  // rather than a regression pin for a live defect. What it pins is the rule:
  // a page that is not the cart yields the honest unknown, never a trusted
  // zero that would present the user's own cart as this run's additions.
  itWithFixture(
    'cart-with-items.html',
    'posts count:null off the cart path instead of a trusted count (MEAL-152)',
    async (runner) => {
      await runner.inject(buildCartPageCountScript('heb')!);
      const result = await runner.waitForMessage('CART_COUNT', 8_000);
      expect(result.count).toBeNull();
      expect(result.reason).toBe('not_cart_page');
      expect(result.url).toBe('https://www.heb.com/');
      expect(result.items).toBeUndefined();
    },
    { url: 'https://www.heb.com/' },
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

// ── MEAL-14: the cart-query rail's one DOM dependency ─────────────────────────
//
// Everything else about the rail is network-shaped and covered fast in
// tests/unit/hebCartQuery.test.ts. What only a real capture can pin is the join
// key: H-E-B's result cards carry no sku anywhere, so the rail identifies its
// target by the product id in the card's /product-detail/<slug>/<id> link — the
// same id the cart's own CartItem.id embeds. If that link ever moves, this fails
// here instead of silently making every add unverifiable on a device.
describe('HEB MEAL-14 cart-query target identity', () => {
  itWithFixture(
    'search-results-sour-cream.html',
    'reads the product id off a real result card',
    async (runner) => {
      await runner.inject(`(function() {
${buildHebCartQueryFn()}
        var cards = Array.prototype.slice.call(document.querySelectorAll('[data-qe-id="productCard"]'));
        var first = cards[0] || null;
        var title = first ? first.querySelector('[data-qe-id="productTitle"]') : null;
        var target = __hebTargetFromCard(first, title ? title.textContent.trim() : null);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_TARGET', cards: cards.length, target: target }));
      })(); true;`);
      const msg = await runner.waitForMessage('CART_TARGET', 12_000);
      expect(msg.cards).toBeGreaterThan(0);
      // The first tile of the captured sour-cream page. `skuId` was null until
      // MEAL-139 — the card markup has no sku, but the page's embedded JSON
      // carries one beside the product id the link already gave us.
      expect(msg.target).toEqual({
        skuId: '4122025475',
        productId: '314026',
        name: 'H-E-B Regular Sour Cream, 16 oz',
      });
    },
  );

  // The sku is what makes an item ADDRESSABLE to H-E-B: its add-to-cart request
  // declares `$skuId: String!`, non-null, so a null sku is the difference between
  // being able to ask the store to add something and only being able to click.
  itWithFixture(
    'search-results-tortillas.html',
    'reads the sku for a different page, so it is a lookup and not a constant',
    async (runner) => {
      await runner.inject(`(function() {
${buildHebCartQueryFn()}
        var cards = Array.prototype.slice.call(document.querySelectorAll('[data-qe-id="productCard"]'));
        var first = cards[0] || null;
        var title = first ? first.querySelector('[data-qe-id="productTitle"]') : null;
        var target = __hebTargetFromCard(first, title ? title.textContent.trim() : null);
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_TARGET', target: target }));
      })(); true;`);
      const msg = await runner.waitForMessage('CART_TARGET', 12_000);
      expect(msg.target.productId).toBe('402171');
      expect(msg.target.skuId).toBe('7373100830');
    },
  );

  // Strictly additive is the whole safety argument (MEAL-139): where the payload
  // cannot answer, the target must be exactly what it was before this change.
  itWithFixture(
    'search-results-stale-hoisin.html',
    'leaves the sku null on a page with no embedded JSON at all',
    async (runner) => {
      await runner.inject(`(function() {
${buildHebCartQueryFn()}
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'CART_TARGET',
          hasPayload: !!document.getElementById('__NEXT_DATA__'),
          sku: __hebSkuForProduct('314026'),
        }));
      })(); true;`);
      const msg = await runner.waitForMessage('CART_TARGET', 12_000);
      expect(msg.hasPayload).toBe(false);
      expect(msg.sku).toBeNull();
    },
  );

  // A stale payload is a payload for a DIFFERENT search, so it does not contain
  // the product the script just picked. That is why this lookup needs no
  // freshness gate: absence is the gate, and it cannot return a wrong sku for a
  // right product id.
  itWithFixture(
    'search-results-sour-cream.html',
    'returns null for a product the payload does not contain',
    async (runner) => {
      await runner.inject(`(function() {
${buildHebCartQueryFn()}
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'CART_TARGET',
          known: __hebSkuForProduct('314026'),
          // A product id from the tortillas page — a real id, wrong page.
          foreign: __hebSkuForProduct('402171'),
        }));
      })(); true;`);
      const msg = await runner.waitForMessage('CART_TARGET', 12_000);
      expect(msg.known).toBe('4122025475');
      expect(msg.foreign).toBeNull();
    },
  );
});

// ── MEAL-185: multi-quantity adds are RELATIVE to what the cart already holds ──
//
// Stephen's run added one unit of a two-unit item and every check agreed it had
// worked. The card's button label reads "N added", and N is the product's
// CART-ABSOLUTE quantity — it counts units this run never touched. The
// multi-quantity loop drove itself to that absolute number, so a product already
// in the cart satisfied the loop's exit before the second unit was ever clicked.
//
// WHY THIS TEST DRIVES A LIVE LABEL. The captured page is static, so a click
// cannot move anything: with a frozen "1 added" the buggy loop reads prevQty 1,
// compares against QTY 2, and happily keeps clicking — the defect is invisible.
// It only appears once the label tracks the cart the way the real storefront's
// does, which is precisely the property the code comment relies on when it calls
// the label "the quantity for THIS product". So the simulator below is not a
// convenience; without it the fixture agrees with the bug.
//
// The observable is UNITS ADDED, never the result flag. The buggy path reports
// success — that is what made this silent — so a test written against
// SEARCH_AND_ADD_RESULT would agree with the bug too.
describe('HEB multi-quantity add (MEAL-185)', () => {
  /**
   * Make the target card's "N added" label behave like the live one: each click
   * on its addToCart button bumps the count. Returns nothing; read the tally
   * back through `window.__mealioAdded`.
   */
  async function installLiveQtyLabel(
    runner: FixtureRunner,
    productName: string,
    opts: { latencyMs?: number; dropClicks?: number[] } = {},
  ) {
    await runner.page.evaluate(
      (arg: { name: string; latencyMs: number; dropClicks: number[] }) => {
        const btns = Array.from(document.querySelectorAll('button[data-qe-id="addToCart"]'));
        const target = btns.find((b) => (b.textContent || '').includes(arg.name));
        if (!target) throw new Error('fixture no longer has an in-cart card for ' + arg.name);
        const label = target.querySelector('div[class*="AddByQuantityButton_label"]');
        if (!label) throw new Error('fixture no longer has an "N added" label for ' + arg.name);
        const m = (label.textContent || '').match(/(\d+)\s*added/i);
        const w = window as any;
        w.__mealioAdded = m ? parseInt(m[1], 10) : 0;
        w.__mealioClicks = 0;
        const paint = () => {
          label.textContent = w.__mealioAdded + ' added, ' + arg.name + ', add 1 more';
        };
        target.addEventListener('click', () => {
          w.__mealioClicks += 1;
          // A dropped click: the store took the click and did nothing with it.
          // This is the failure the label wait exists to catch, so it has to be
          // expressible or the wait is untested.
          if (arg.dropClicks.indexOf(w.__mealioClicks) !== -1) return;
          w.__mealioAdded += 1;
          if (arg.latencyMs > 0) setTimeout(paint, arg.latencyMs); else paint();
        });
      },
      { name: productName, latencyMs: opts.latencyMs ?? 0, dropClicks: opts.dropClicks ?? [] },
    );
  }

  const IN_CART_PRODUCT = 'H-E-B Regular Sour Cream, 16 oz';

  itWithFixture(
    'search-results-product-in-cart.html',
    'adds the full quantity when the cart already holds one unit',
    async (runner) => {
      await installLiveQtyLabel(runner, IN_CART_PRODUCT);
      // The exact scenario from the log: one unit already in the cart, two asked
      // for. Before the fix this added ONE — the first click took the label to
      // "2 added", `prevQty >= QTY` was satisfied, and the loop stopped.
      await runner.inject(scripts.buildSearchAndAddScript(IN_CART_PRODUCT, 2, null));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 25_000).catch(() => undefined);
      const added = await runner.page.evaluate(() => (window as any).__mealioAdded);
      // 1 already there + 2 this run.
      expect(added).toBe(3);
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
  );

  itWithFixture(
    'search-results-product-in-cart.html',
    'still adds exactly one unit for a qty-1 item already in the cart',
    async (runner) => {
      // The other side of the same rule, and the one an over-correction breaks:
      // driving to `base + QTY` must not turn a single-unit add into a top-up to
      // some absolute target. Over-adding is the same governing principle as
      // under-adding, pointing the other way.
      await installLiveQtyLabel(runner, IN_CART_PRODUCT);
      await runner.inject(scripts.buildSearchAndAddScript(IN_CART_PRODUCT, 1, null));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 25_000).catch(() => undefined);
      const clicks = await runner.page.evaluate(() => (window as any).__mealioClicks);
      expect(clicks).toBe(1);
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
  );
  itWithFixture(
    'search-results-product-in-cart.html',
    'recovers a dropped increment click instead of under-adding',
    async (runner) => {
      // WHY THIS TEST EXISTS, and it is about the fix's OTHER half.
      //
      // The loop waits for the label to reach base+1 before it starts
      // incrementing, and then waits for prevQty+1 after each click, retrying
      // once if the label does not move. That retry is the only thing standing
      // between a dropped click and a silent under-add.
      //
      // Leaving that first wait at the absolute `1` — as the pre-fix code did —
      // looks harmless because the arithmetic still comes out right when every
      // click lands. It is not harmless: with a unit already in the cart the wait
      // returns INSTANTLY, so prevQty is read before the first click has painted,
      // and the post-click wait for prevQty+1 is then satisfied by the FIRST
      // click's own label update rather than the increment's. The retry never
      // fires and the dropped unit is lost.
      //
      // A synchronous label cannot show this: the stale read and the fresh read
      // are the same number. So this drives a 400ms label latency AND drops the
      // increment click, which is the combination that separates the two.
      // 2000ms, chosen against the script's own clock rather than picked round.
      // The script waits 600ms after the first click before it reaches this branch,
      // so a latency under that paints the label BEFORE prevQty is read and the
      // stale-read bug cannot express itself — a 400ms version of this test passed
      // against the mutant. It also has to stay under the first-unit wait's 3s
      // budget (15 x 200ms) or the correct code times out too and both sides fail
      // alike. 2000ms sits in that window with margin at both ends.
      await installLiveQtyLabel(runner, IN_CART_PRODUCT, { latencyMs: 2000, dropClicks: [2] });
      await runner.inject(scripts.buildSearchAndAddScript(IN_CART_PRODUCT, 2, null));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 30_000).catch(() => undefined);
      const added = await runner.page.evaluate(() => (window as any).__mealioAdded);
      // 1 already there + 2 asked for, with the retry recovering the dropped one.
      expect(added).toBe(3);
    },
    { url: 'https://www.heb.com/search?q=sour%20cream' },
  );
});

// ── MEAL-200: adding by request instead of by click ──────────────────────────
//
// The store's own add endpoint SETS a line's quantity rather than incrementing
// it. That is the same trap MEAL-185 fixed on the click path, where targeting the
// raw requested quantity under-added any product the cart already held — and
// reported success while doing it. So the quantity actually SENT is the property
// under test here, not merely that a request went out.
//
// The other half is what the path DECLINES. Weight-priced and preference-bearing
// items are excluded because a weight line cannot be undone: quantity 0 errors,
// weight 0 is accepted without removing, and the storefront has no remove-item
// operation. Those must keep clicking.

/** The add script with the network path pushed ON, through the real config path. */
async function addScriptWithNetworkAdd(term: string, qty: number): Promise<string> {
  await loadAutomationConfig(async () => ({
    version: 14,
    config: { stores: { heb: { cartSkuConfirm: true, networkAdd: true } } },
  }));
  return getStoreScripts('heb')!.buildSearchAndAddScript!(term, qty, null);
}

/** The same script with the flag OFF — the shipping default. */
async function addScriptDefault(term: string, qty: number): Promise<string> {
  await loadAutomationConfig(async () => ({
    version: 14,
    config: { stores: { heb: { cartSkuConfirm: true } } },
  }));
  return getStoreScripts('heb')!.buildSearchAndAddScript!(term, qty, null);
}

/**
 * Replace fetch so no test reaches H-E-B, record what the add path asked for, and
 * count Add-button clicks. `addArm` chooses which side of the response union the
 * write gets back.
 */
function stubNetwork(addArm: string): string {
  return [
    '(function () {',
    '  window.__gqlCalls = [];',
    '  window.__clicks = 0;',
    '  document.addEventListener("click", function (e) {',
    '    var b = e.target && e.target.closest && e.target.closest("button");',
    '    if (b && b.getAttribute("data-qe-id") === "addToCart") window.__clicks++;',
    '  }, true);',
    '  var reply = function (obj) {',
    '    return Promise.resolve({ ok: true, status: 200,',
    '      text: function () { return Promise.resolve(JSON.stringify(obj)); } });',
    '  };',
    '  window.fetch = function (url, init) {',
    '    var body = null;',
    '    try { body = JSON.parse((init && init.body) || "null"); } catch (e) {}',
    '    window.__gqlCalls.push(body);',
    '    var op = body && body.operationName;',
    '    if (op === "cartItemV2") {',
    '      return reply({ data: { addItemToCartV2: { __typename: ' + JSON.stringify(addArm) + ',',
    '        message: "You must supply a weight to purchase this item." } } });',
    '    }',
    '    // Cart reads: one line for the product the fixtures target, so the',
    '    // confirmation has a baseline to move off.',
    '    return reply({ data: { cartV2: { __typename: "Cart", id: "c1",',
    '      itemCount: { total: 1 },',
    '      items: [{ id: "i1", quantity: 1, estimatedWeight: null,',
    '        product: { id: "314026", fullDisplayName: "H-E-B Regular Sour Cream, 16 oz" },',
    '        sku: { id: "4122025475", twelveDigitUPC: null, weightSelectionIncrements: [] } }] } } });',
    '  };',
    '})(); true;',
  ].join('\n');
}

/** What the add path sent to the write endpoint, if anything. */
const ASK_SENT = [
  '(function () {',
  '  var add = null;',
  '  for (var i = 0; i < (window.__gqlCalls || []).length; i++) {',
  '    var c = window.__gqlCalls[i];',
  '    if (c && c.operationName === "cartItemV2") add = c;',
  '  }',
  '  window.ReactNativeWebView.postMessage(JSON.stringify({',
  '    type: "NET_ADD_SEEN", sent: add ? add.variables : null,',
  '    clicks: window.__clicks || 0,',
  '  }));',
  '})(); true;',
].join('\n');

describe('HEB MEAL-200: add by request', () => {
  itWithFixture(
    'search-results-sour-cream.html',
    'sends the cart-ABSOLUTE quantity, not the requested one',
    async (runner) => {
      // The stub says the cart already holds 1 of this product, and the fixture's
      // own card label agrees. Asking for 2 more must send 3, not 2. Sending 2
      // would SET the line to 2 — one short — and report success (MEAL-185).
      await runner.inject(stubNetwork('Cart'));
      await runner.inject(await addScriptWithNetworkAdd('H-E-B Regular Sour Cream, 16 oz', 2));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      runner.clearMessages();
      await runner.inject(ASK_SENT);
      const seen = await runner.waitForMessage('NET_ADD_SEEN', 10_000);
      expect(seen.sent).toBeTruthy();
      expect(seen.sent.productId).toBe('314026');
      expect(seen.sent.skuId).toBe('4122025475');
      expect(seen.sent.quantity).toBe(3);
    },
  );

  itWithFixture(
    'search-results-sour-cream.html',
    'does not click the Add button when the request succeeded',
    async (runner) => {
      // The point of the path. A request AND a click would add twice.
      await runner.inject(stubNetwork('Cart'));
      await runner.inject(await addScriptWithNetworkAdd('H-E-B Regular Sour Cream, 16 oz', 1));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      runner.clearMessages();
      await runner.inject(ASK_SENT);
      const seen = await runner.waitForMessage('NET_ADD_SEEN', 10_000);
      expect(seen.clicks).toBe(0);
    },
  );

  itWithFixture(
    'search-results-sour-cream.html',
    'falls back to clicking when the store answers the error arm',
    async (runner) => {
      // Anything that is not the Cart arm means the add did not happen, so the
      // click path must still run. Never skipped on a maybe.
      await runner.inject(stubNetwork('AddItemToCartV2Error'));
      await runner.inject(await addScriptWithNetworkAdd('H-E-B Regular Sour Cream, 16 oz', 1));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      runner.clearMessages();
      await runner.inject(ASK_SENT);
      const seen = await runner.waitForMessage('NET_ADD_SEEN', 10_000);
      expect(seen.sent).toBeTruthy();
      expect(seen.clicks).toBeGreaterThan(0);
    },
  );

  itWithFixture(
    'search-results-sour-cream.html',
    'issues no request at all with the flag at its shipping default',
    async (runner) => {
      await runner.inject(stubNetwork('Cart'));
      await runner.inject(await addScriptDefault('H-E-B Regular Sour Cream, 16 oz', 1));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      runner.clearMessages();
      await runner.inject(ASK_SENT);
      const seen = await runner.waitForMessage('NET_ADD_SEEN', 10_000);
      expect(seen.sent).toBeNull();
      expect(seen.clicks).toBeGreaterThan(0);
    },
  );

  itWithFixture(
    'search-results-sour-cream.html',
    'sends nothing when the cart could not be read',
    async (runner) => {
      // No baseline means no way to know what quantity to SET. Guessing would
      // set the line to the requested count and silently drop whatever the cart
      // already held, so the request is not sent at all.
      await runner.inject([
        '(function () {',
        '  window.__gqlCalls = []; window.__clicks = 0;',
        '  document.addEventListener("click", function (e) {',
        '    var b = e.target && e.target.closest && e.target.closest("button");',
        '    if (b && b.getAttribute("data-qe-id") === "addToCart") window.__clicks++;',
        '  }, true);',
        '  window.fetch = function (url, init) {',
        '    var body = null;',
        '    try { body = JSON.parse((init && init.body) || "null"); } catch (e) {}',
        '    window.__gqlCalls.push(body);',
        '    return Promise.resolve({ ok: false, status: 403,',
        '      text: function () { return Promise.resolve("<html>blocked</html>"); } });',
        '  };',
        '})(); true;',
      ].join('\n'));
      await runner.inject(await addScriptWithNetworkAdd('H-E-B Regular Sour Cream, 16 oz', 2));
      // Deliberately NOT waiting for the terminal result: with the cart
      // unreadable the confirmation retries against a wall and outruns jest's
      // budget. The decline happens before any of that, and the claim under test
      // is only that no write was issued.
      await new Promise((r) => setTimeout(r, 6_000));
      runner.clearMessages();
      await runner.inject(ASK_SENT);
      const seen = await runner.waitForMessage('NET_ADD_SEEN', 10_000);
      expect(seen.sent).toBeNull();
      expect(seen.clicks).toBeGreaterThan(0);
    },
  );

  itWithFixture(
    'search-results-weight-dropdown-closed.html',
    'declines a sold-by-weight item and clicks instead',
    async (runner) => {
      // Not because the request would fail — it works, measured — but because a
      // weight line cannot be un-added if it goes wrong.
      await runner.inject(stubNetwork('Cart'));
      await runner.inject(await addScriptWithNetworkAdd('CAFE Olé by H-E-B Whole Bean Colombian Coffee', 1));
      await runner.waitForMessage('SEARCH_AND_ADD_RESULT', 20_000);
      runner.clearMessages();
      await runner.inject(ASK_SENT);
      const seen = await runner.waitForMessage('NET_ADD_SEEN', 10_000);
      expect(seen.sent).toBeNull();
    },
  );
});
