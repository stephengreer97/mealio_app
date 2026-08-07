// The drift gate (MEAL-30).
//
// Recomputes the selector census over the committed fixtures and compares it to
// tests/drift/selector-baseline.json. Green means every selector the store scripts
// depend on still matches the same SHAPE it did when the baseline was written.
//
// WHAT MAKES THIS FAIL, AND WHY IT IS SAFE TO LEAVE ON
// Only two kinds of change reach this suite:
//   1. someone recaptured fixtures and the store's markup moved under our
//      selectors — the case the whole ticket is about, and a failure here is the
//      warning it asks for, raised BEFORE the live canary breaks;
//   2. someone edited a selector in a store script and it now matches something
//      different — which is exactly the feedback they wanted.
// Nothing else can trip it. A recapture that changed a thousand prices, dropped a
// third of the search results and added a promo rail produces no findings at all,
// because none of that changes any censused selector's bucket. That property is
// load-bearing: this repo has already had a fixture assertion so loose it passed
// whether or not the thing it tested worked, and the opposite failure — a check
// that fires on noise — ends the same way, with someone deleting it.
//
// WHEN IT FAILS, the message names each selector, the fixture, and whether a
// sibling comma-branch is still carrying the selector. Then:
//   git diff tests/fixtures/<store>      the markup change itself, for triage
//   npm run drift -- <store>             the same report, with --standing available
//   npm run drift -- <store> --update    accept the new shape (review the diff)

import { Census, diffCensus, formatFindings } from '../drift/census';
import { computeCensus, closeOpenCensusBrowsers } from '../drift/capture';
import { readBaseline } from '../drift/baseline';
import { STORE_SURFACES } from '../drift/selector-surface';

// One census for every store, computed once. The census shares a single browser
// across ~50 fixtures (see capture.ts), so this is seconds, not minutes.
let census: Census;
let baseline: Census;

beforeAll(async () => {
  baseline = readBaseline();
  census = await computeCensus();
}, 120_000);

/*
 * MEAL-113. The teardown that closes leaked browsers for the per-store fixture
 * specs lives in _helpers.ts, and THIS spec does not import it — it does not use
 * `storeFixtures`, so nothing registered it here. But this is the file with the
 * expensive hook: if the `beforeAll` above blows its 120s budget it is abandoned
 * mid-await, `computeCensus`'s own `finally` never runs, and its Chromium survives
 * the run. That is what happened in review, and it printed the "worker process has
 * failed to exit gracefully" warning.
 *
 * jest runs afterAll even when beforeAll failed or timed out, which is what makes
 * this the right place for it.
 */
afterAll(closeOpenCensusBrowsers);

/** Just this store's slice, so a per-store failure message stays readable. */
function slice(c: Census, store: string): Census {
  return { version: c.version, stores: c.stores[store] ? { [store]: c.stores[store] } : {} };
}

describe('fixture selector drift', () => {
  it('baseline was written by this version of the census', () => {
    expect(baseline.version).toBe(census.version);
  });

  it.each(STORE_SURFACES.map((s) => s.fixtureDir))('%s selectors match the baseline shape', (store) => {
    const findings = diffCensus(slice(baseline, store), slice(census, store));
    const warns = findings.filter((f) => f.level === 'warn');
    if (warns.length > 0) {
      throw new Error(
        `${store}: the markup these selectors read has changed shape.\n\n` +
          `${formatFindings(warns)}\n\n` +
          `Triage: git diff tests/fixtures/${store}\n` +
          `Accept:  npm run drift -- ${store} --update`,
      );
    }
    expect(warns).toEqual([]);
  });

  // Informational findings are reported, never failed on: a new fixture or an
  // intentional selector edit is not drift, and failing on it would train people
  // to reach for --update without reading.
  it('reports informational census changes without failing', () => {
    const infos = diffCensus(baseline, census).filter((f) => f.level === 'info');
    if (infos.length > 0) {
      console.log(`[drift] ${infos.length} informational change(s):\n${formatFindings(infos)}`);
    }
    expect(Array.isArray(infos)).toBe(true);
  });
});
