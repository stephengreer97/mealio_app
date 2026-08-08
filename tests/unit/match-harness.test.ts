// Gate on the product-matching harness (MEAL-27).
//
// A change to src/lib/webview-scripts/_scoring.ts that makes matching WORSE
// fails here. A change that makes it better also fails, deliberately: the
// baseline has to be re-recorded (`npm run match-harness -- --write-baseline`)
// so the before/after numbers land in the PR instead of drifting silently.
//
// Run the readable report with `npm run match-harness`.

import * as fs from 'fs';
import * as path from 'path';

import { evaluate, StoreMetrics } from '../match-harness/score';

const baseline = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'match-harness', 'baseline.json'), 'utf8'),
) as { stores: Record<string, StoreMetrics>; overall: StoreMetrics };

const report = evaluate();

const REGENERATE =
  'Re-record it with `npm run match-harness -- --write-baseline` and put the ' +
  'before/after numbers in the PR description.';

describe('product-matching harness', () => {
  it('has a baseline for every store in the corpus', () => {
    expect(Object.keys(report.stores).sort()).toEqual(Object.keys(baseline.stores).sort());
  });

  // Compared exactly rather than as a floor: an improvement is still a change
  // to how carts get filled, and it should be stated, not absorbed.
  for (const store of Object.keys(baseline.stores)) {
    describe(store, () => {
      const now = () => report.stores[store];
      const was = baseline.stores[store];

      it('corpus is unchanged (queries, pairs, acceptable pairs)', () => {
        expect({ queries: now().queries, pairs: now().pairs, acceptablePairs: now().acceptablePairs })
          .toEqual({ queries: was.queries, pairs: was.pairs, acceptablePairs: was.acceptablePairs });
      });

      it(`precision@1 matches the baseline. ${REGENERATE}`, () => {
        expect(now().precisionAt1).toBeCloseTo(was.precisionAt1 ?? NaN, 6);
      });

      it(`acceptable-match rate matches the baseline. ${REGENERATE}`, () => {
        expect(now().acceptableMatchRate).toBeCloseTo(was.acceptableMatchRate, 6);
      });

      it(`pair precision/recall match the baseline. ${REGENERATE}`, () => {
        expect(now().pairPrecision).toBeCloseTo(was.pairPrecision ?? NaN, 6);
        expect(now().pairRecall).toBeCloseTo(was.pairRecall ?? NaN, 6);
      });

      it(`choose-flow ranking matches the baseline. ${REGENERATE}`, () => {
        expect(now().chooseRankedPrecision).toBeCloseTo(was.chooseRankedPrecision ?? NaN, 6);
      });

      // Not a match-the-baseline check: this is the claim the whole of MEAL-28
      // rests on. Ranking must never leave the user staring at a worse first
      // row than the store's own order would have given them.
      it('ranking is never worse than the store order it replaced', () => {
        expect(now().chooseRankedNumerator).toBeGreaterThanOrEqual(now().chooseStoreOrderNumerator);
      });

      it('abstains on every query where no product is acceptable', () => {
        // A false auto-add on an unanswerable query is the worst failure mode
        // the harness can see: the cart gets something nobody asked for. This
        // one is a hard floor, not a match-the-baseline check.
        expect(now().abstainCorrect).toBe(was.abstainDenominator ? was.abstainDenominator : null);
      });
    });
  }

  it(`overall precision@1 matches the baseline. ${REGENERATE}`, () => {
    expect(report.overall.precisionAt1).toBeCloseTo(baseline.overall.precisionAt1 ?? NaN, 6);
  });
});
