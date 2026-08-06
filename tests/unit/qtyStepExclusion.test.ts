// MEAL-65: the qty step's exclusion rule.
//
// The bug was feedback-only — a zeroed row was ALREADY dropped from the run,
// the screen just did not say so. So the bar for the fix is that what runs is
// bit-for-bit what ran before, while the checkbox and strikethrough now read
// off the same predicate as the filters.
//
// These tests do both halves: the rule itself (including the weight-priced
// exception), and an equivalence check against the exact expressions the two
// sheets used before the change. If `isZeroedOut` ever stops agreeing with
// those, the run's contents have changed and this fails.

import { isZeroedOut } from '../../src/lib/cart-reconcile';

/** The expression WebViewCartSheet used to filter active items, verbatim. */
const oldWebViewActive = (it: { purchaseWeight?: number | null; productQty: number }) =>
  it.purchaseWeight != null || it.productQty > 0;

/** The expression KrogerCartReviewSheet used, verbatim. Kroger's items carry no
 *  weight fields at all — an invariant this file DEPENDS on and cannot check
 *  itself (the sheet is a React module, out of reach of the node project). It is
 *  pinned, both structurally and at the type level, in
 *  tests/components/KrogerCartReviewSheetQty.test.tsx → "Kroger qty item shape".
 *  The disagreement that invariant holds off is spelled out below. */
const oldKrogerActive = (it: { productQty: number }) => it.productQty > 0;

describe('isZeroedOut — the rule', () => {
  it('zeroes out a count item at qty 0', () => {
    expect(isZeroedOut({ productQty: 0 })).toBe(true);
  });

  it('leaves a count item with qty ≥ 1 alone', () => {
    expect(isZeroedOut({ productQty: 1 })).toBe(false);
    expect(isZeroedOut({ productQty: 7 })).toBe(false);
  });

  it('never zeroes out a weight-priced item, whatever its productQty', () => {
    // The whole point of the exception: a Deli/bulk item bought at 1.5 lb is in
    // the run, and productQty is meaningless for it. Striking it out at qty 0
    // would tell the user an item that IS being added is not.
    expect(isZeroedOut({ purchaseWeight: 1.5, productQty: 0 })).toBe(false);
    expect(isZeroedOut({ purchaseWeight: 0.25, productQty: 0 })).toBe(false);
    // Even a nonsense zero weight is a chosen weight — isWeightPriced is a
    // `!= null` rule, and this stays tied to it.
    expect(isZeroedOut({ purchaseWeight: 0, productQty: 0 })).toBe(false);
  });

  it('zeroes out a STEPPER-weight item at qty 0 (weightStep but no purchaseWeight)', () => {
    // Stepper-weight items are deliberately not weight-priced: productQty is
    // their source of truth, so they zero out like ordinary count items.
    expect(isZeroedOut({ weightStep: 0.25, productQty: 0 } as any)).toBe(true);
    expect(isZeroedOut({ weightStep: 0.25, productQty: 2 } as any)).toBe(false);
  });

  it('treats a missing or null purchaseWeight as not weight-priced', () => {
    expect(isZeroedOut({ purchaseWeight: null, productQty: 0 })).toBe(true);
    expect(isZeroedOut({ productQty: 0 })).toBe(true);
  });

  it('treats a missing productQty as zeroed', () => {
    expect(isZeroedOut({})).toBe(true);
  });
});

describe('isZeroedOut — add-to-cart behaviour is unchanged', () => {
  const qtys = [-1, 0, 1, 2, 99];
  const weights = [null, undefined, 0, 0.25, 3] as (number | null | undefined)[];

  it('matches the pre-MEAL-65 WebView active filter on every qty × weight pair', () => {
    for (const productQty of qtys) {
      for (const purchaseWeight of weights) {
        const item = { productQty, purchaseWeight };
        expect(!isZeroedOut(item)).toBe(oldWebViewActive(item));
      }
    }
  });

  it('matches the pre-MEAL-65 Kroger active filter on every qty', () => {
    for (const productQty of qtys) {
      const item = { productQty };
      expect(!isZeroedOut(item)).toBe(oldKrogerActive(item));
    }
  });

  it('shows WHY the Kroger sweep may stop at qty — weight is what pulls them apart', () => {
    // The equivalence above iterates qty only, and this is the reason it is
    // allowed to: the moment an item has a purchaseWeight, isZeroedOut takes
    // the sold-by-weight exception while Kroger's old filter keeps reading
    // productQty, and the two disagree on every non-positive qty. Kroger's item
    // type has no weight field, so this input is unconstructible there — which
    // is exactly the invariant pinned in KrogerCartReviewSheetQty.test.tsx. If
    // that pin ever goes, this shows what breaks.
    let disagreements = 0;
    for (const productQty of qtys) {
      for (const purchaseWeight of [0, 0.25, 3]) {
        const item = { productQty, purchaseWeight };
        if (!isZeroedOut(item) !== oldKrogerActive(item)) disagreements++;
      }
    }
    // qty ≤ 0 (−1 and 0) × three weights: weight-priced stays in, the old
    // Kroger filter drops it.
    expect(disagreements).toBe(6);
  });
});
