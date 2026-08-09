// The scoring rule exists three times, and nothing checked that they agree.
//
// `_scoring.ts` says so itself: the store scripts inline COPIES of these
// functions inside template literals, because they are injected into a
// WebView's global scope where there is no module system, and "the copies must
// stay byte-identical to the bodies below; the fixture tests catch drift
// indirectly".
//
// Indirectly is the problem. A fixture test only notices drift if some fixture
// happens to contain a product name the two copies disagree about — so the
// safety net has holes exactly where nobody thought to capture a fixture.
// MEAL-160 changed the veto, which meant changing all three copies by hand, and
// discovering there was no test that would have caught doing two of them.
//
// This runs the REAL emitted script text — the string the WebView is actually
// handed, after every escape in the template literal has been resolved — and
// compares it to the module across the cases that distinguish them. Reading the
// .ts source instead would prove only that two files look alike, and would have
// missed an escaping bug in the emitted output entirely.

import { getStoreScripts } from '../../../src/lib/webview-scripts';
import { scoreMatch } from '../../../src/lib/webview-scripts/_scoring';

/**
 * The stores whose scripts carry a copy of the MODULE's scorer — the hard-veto
 * shape, which is what `_scoring.ts` describes and what this file compares.
 *
 * There are six inlined copies in `src/lib/webview-scripts/`, not five. ALDI's
 * (`instacart.ts`) is deliberately NOT one of them: it PENALISES a missing
 * critical word by 15 rather than vetoing outright, because ALDI's selection is
 * narrow enough that "Organic Broccoli" should still be allowed to match
 * "Broccoli Crowns". It is a different algorithm on purpose, so holding it to
 * the module's numbers would be wrong. It shares the same tokenisation, and so
 * shares the MEAL-160 fix — but its behaviour is pinned by its own tests, not
 * here. Naming the exclusion rather than quietly listing five stores is the
 * point: a silent omission is how the next divergence gets missed.
 */
const INLINED_STORES = ['heb', 'walmart', 'albertsons', 'wegmans', 'amazon'] as const;

/**
 * Pull the scoring block out of an emitted script and turn it back into a
 * callable `scoreMatch`.
 *
 * Everything from the CRITICAL set to the end of `scoreMatch` is
 * self-contained, so it evaluates standalone.
 */
function extractScorer(script: string): (a: string, b: string) => number {
  const start = script.indexOf('var CRITICAL = new Set(');
  expect(start).toBeGreaterThan(-1);
  const marker = 'function scoreMatch(a, b) {';
  const fnStart = script.indexOf(marker, start);
  expect(fnStart).toBeGreaterThan(-1);
  const end = script.indexOf('\n  }', fnStart);
  expect(end).toBeGreaterThan(-1);
  const body = script.slice(start, end + 4);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return scoreMatch;`)() as (a: string, b: string) => number;
}

/** One emitted script per store, whatever that store's entry point is. */
function emittedScript(storeId: string): string {
  const s: any = getStoreScripts(storeId);
  expect(s).toBeTruthy();
  const script = s.buildSearchAndAddScript
    ? s.buildSearchAndAddScript('turkey breast', 1, null)
    : s.buildSearchScript('turkey breast');
  expect(typeof script).toBe('string');
  return script;
}

/**
 * Cases chosen to separate the copies, not to re-test the module: every phrase
 * MEAL-160 collapses, both spellings, plus the vetoes and the partial-overlap
 * band that would move if a copy drifted in any other way.
 */
const CASES: Array<[string, string]> = [
  ['low fat cottage cheese', 'Full Fat Cottage Cheese'],
  ['lowfat cottage cheese', 'Low-Fat Cottage Cheese'],
  ['low fat cottage cheese', 'Lowfat Cottage Cheese'],
  ['nonfat milk', 'Full Fat Milk'],
  ['non fat milk', 'Nonfat Milk'],
  ['grassfed beef', 'Grass Fed Beef'],
  ['grass fed beef', 'Grain Fed Beef'],
  ['cagefree eggs', 'Cage Free Eggs'],
  ['cage free eggs', 'Free Eggs'],
  ['freerange chicken', 'Free Range Chicken'],
  ['organic boneless chicken', 'Boneless Chicken'],
  ['large brown eggs', 'Large Brown Eggs'],
  ['jalapeño peppers', 'Jalapeno Peppers'],
  ['whole milk', 'Whole Milk 1 Gallon'],
  ['unsalted butter', 'Salted Butter'],
];

describe.each(INLINED_STORES)('%s ships the same scorer as the module', (storeId) => {
  const inlineScore = extractScorer(emittedScript(storeId));

  it.each(CASES)('agrees on %s vs %s', (a, b) => {
    expect(inlineScore(a, b)).toBe(scoreMatch(a, b));
  });

  it('is not vacuously agreeing — the cases really do span the range', () => {
    // Without this, a scorer that returned 0 for everything would "agree" with
    // a module that did the same, and the whole file would prove nothing.
    const scores = new Set(CASES.map(([a, b]) => inlineScore(a, b)));
    expect(scores.has(0)).toBe(true);
    expect(scores.has(100)).toBe(true);
    expect(scores.size).toBeGreaterThanOrEqual(3);
  });
});
