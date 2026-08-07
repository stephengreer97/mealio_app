// Compute a drift census from a tree of captured fixtures (MEAL-30).
//
// The mechanical half: load each fixture in the same headless Chromium the fixture
// tests use, run every censused selector against it, and bucket the counts. All the
// judgement about what those numbers MEAN lives in census.ts, and all the judgement
// about which selectors to run lives in selector-surface.ts — this file only
// counts.
//
// WHY CHROMIUM AND NOT A PARSER
// The selectors this app ships lean on matching that a lightweight DOM library gets
// subtly wrong: case-insensitive attribute matching (`[aria-label*="account" i]`,
// used by every store's login check), `:not()` with an argument list, `^=`/`$=` over
// attribute values containing punctuation. A census taken by a different matching
// engine than the WebView's would record a shape the app never sees. Chromium is
// already a dependency of the fixture suite, so there is no new cost.
//
// WHY ONE BROWSER FOR THE WHOLE RUN
// loadFixture() launches a browser per fixture, which is right for a test that
// wants isolation. A census reads 40-odd fixtures across six stores and never
// mutates the page, so it shares one browser and one page: ~8 seconds for the whole
// tree instead of a minute of process launches. A check nobody waits for is a check
// nobody runs.

import * as fs from 'fs';
import * as path from 'path';
import { Browser, chromium } from 'playwright';

import {
  FIXTURE_CONTEXT_OPTIONS,
  FIXTURE_LAUNCH_OPTIONS,
  installResourceBlocking,
} from '../fixture-runners/runScript';
import {
  CENSUS_VERSION,
  Census,
  CountBucket,
  StoreCensus,
  countBucket,
  splitSelectorBranches,
  targetKey,
} from './census';
import { censusNextData } from './next-data';
import { STORE_SURFACES, StoreSurface, captureUrlFor, resolveSelectors } from './selector-surface';

/** Default fixture tree: the committed captures. */
export const DEFAULT_FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures');

export interface CensusOptions {
  /** Fixture tree to census. Lets a recapture be compared without overwriting the
   *  committed one — see the runner contract in tests/fixtures/README.md. */
  fixtureRoot?: string;
  /** Restrict to these fixture directories. Empty/absent means every store. */
  stores?: string[];
}

/** The .html files in a fixture directory, sorted so a census is reproducible. */
function fixtureFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every (target key → selector string) pair to run for a store.
 *
 * Branch entries are emitted only for selectors that have more than one branch:
 * for a single-branch selector the branch count IS the union count, so recording
 * both would double the baseline and report every finding twice.
 */
function censusTargets(selectors: Record<string, string>): Array<{ target: string; selector: string }> {
  const out: Array<{ target: string; selector: string }> = [];
  for (const key of Object.keys(selectors).sort()) {
    const selector = selectors[key];
    // A key with no value can happen: selectorsFor()'s Proxy hands back `""` for a
    // key nothing declared. Nothing to count, and `document.querySelectorAll('')`
    // throws, which would be reported as `invalid` — misleading, so skip it.
    if (!selector) continue;
    out.push({ target: key, selector });
    const branches = splitSelectorBranches(selector);
    if (branches.length > 1) {
      branches.forEach((branch, i) => out.push({ target: targetKey(key, i), selector: branch }));
    }
  }
  return out;
}

/** Raw match counts for a page. `-1` marks a selector querySelectorAll rejected. */
async function countMatches(
  page: import('playwright').Page,
  targets: Array<{ target: string; selector: string }>,
): Promise<Record<string, number>> {
  return page.evaluate((list: Array<{ target: string; selector: string }>) => {
    const counts: Record<string, number> = {};
    for (const { target, selector } of list) {
      try {
        counts[target] = document.querySelectorAll(selector).length;
      } catch {
        counts[target] = -1;
      }
    }
    return counts;
  }, targets);
}

/**
 * Compute a census over a fixture tree.
 *
 * A store whose fixture directory is missing or empty is omitted entirely rather
 * than recorded as all-zero: the baseline comparison treats a vanished store as a
 * finding of its own, and recording zeros would instead produce one `died` finding
 * per selector per fixture — a wall of noise for a single fact.
 */
export async function computeCensus(options: CensusOptions = {}): Promise<Census> {
  const root = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const wanted = options.stores && options.stores.length > 0 ? new Set(options.stores) : null;
  const surfaces = STORE_SURFACES.filter((s) => !wanted || wanted.has(s.fixtureDir));

  const census: Census = { version: CENSUS_VERSION, stores: {} };
  // Register the LAUNCH, not the browser. `add(await launch())` leaves a window
  // where an abandoned hook (see the note on openCensusBrowsers) has already
  // spawned a Chromium that nothing has a handle to yet.
  const launching = chromium.launch(FIXTURE_LAUNCH_OPTIONS);
  openCensusBrowsers.add(launching);
  const browser = await launching;
  try {
    const context = await browser.newContext(FIXTURE_CONTEXT_OPTIONS);
    await installResourceBlocking(context);
    const page = await context.newPage();

    for (const surface of surfaces) {
      const dir = path.join(root, surface.fixtureDir);
      const files = fixtureFiles(dir);
      if (files.length === 0) continue;

      const selectors = resolveSelectors(surface);
      const targets = censusTargets(selectors);
      const store: StoreCensus = { selectors, fixtures: {} };
      if (surface.nextData) store.nextData = {};

      for (const file of files) {
        const html = fs.readFileSync(path.join(dir, file), 'utf8');
        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        const counts = await countMatches(page, targets);
        const buckets: Record<string, CountBucket> = {};
        for (const { target } of targets) buckets[target] = countBucket(counts[target] ?? 0);
        store.fixtures[file] = buckets;

        if (store.nextData) {
          // Pull the payload out as TEXT and parse it in Node. Keeping the JSON
          // census a pure function of (text, url) is what makes it unit-testable
          // without a browser, and there is nothing about it that needs the DOM.
          const raw = await page.evaluate(() => {
            const el = document.getElementById('__NEXT_DATA__');
            return el ? el.textContent : null;
          });
          store.nextData[file] = censusNextData(raw, captureUrlFor(surface, file));
        }
      }

      census.stores[surface.fixtureDir] = store;
    }
  } finally {
    openCensusBrowsers.delete(launching);
    await browser.close();
  }
  return census;
}

/*
 * Census browsers that have been launched and not yet closed. Held as the LAUNCH
 * PROMISE rather than the `Browser`, so a hook abandoned *during* `chromium.launch()`
 * still leaves the teardown something to close.
 *
 * MEAL-113. The `finally` above is not enough on its own. `computeCensus()` is
 * called from a jest `beforeAll` (tests/fixture-tests/selector-drift.spec.ts) with
 * a 120s budget, and a hook that exceeds its budget is ABANDONED mid-await: the
 * rest of the function never runs, `finally` included, and the Chromium this
 * launched outlives the run. That is the exact hook that timed out in review, and
 * the run then printed the "worker process has failed to exit gracefully" warning
 * this ticket set out to eliminate — the fixture-runner teardown in
 * tests/fixture-tests/_helpers.ts could not cover it, because the drift spec does
 * not import that module.
 *
 * So the census registers its browser where a teardown can find it, and the spec
 * closes whatever is still open. `close()` is idempotent and the happy path
 * deregisters first, so on a normal run the teardown has nothing to do.
 */
const openCensusBrowsers = new Set<Promise<Browser>>();

/** Close any census browser a timed-out hook left behind. Safe to call always. */
export async function closeOpenCensusBrowsers(): Promise<void> {
  const leaked = [...openCensusBrowsers];
  openCensusBrowsers.clear();
  await Promise.all(
    leaked.map((launching) => launching.then((b) => b.close()).catch(() => {})),
  );
}

/** Which stores a census actually covered, for a report header. */
export function censusedStores(census: Census): string[] {
  return Object.keys(census.stores).sort();
}

export type { StoreSurface };
