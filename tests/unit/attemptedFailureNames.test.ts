// A store that ACCEPTS a write and flags the line unavailable is not the user
// putting something in their own cart.
//
// MEASURED, Albertsons, Pixel, 2026-09-04. Six items requested, five written:
//
//   10:38:06  cart before: 44 units, 25 lines, no Sargento cheese anywhere
//   10:38:23  network add 'Sargento Shredded 4 Cheese...' failed: out_of_stock
//   10:38:25  the cart now holds it — qty 1, available: false
//   10:38:26  reconcile: OVER-ADD detected [Sargento Shredded 4 Cheese...]
//
// which would have told Stephen "your Albertsons cart has 1 item(s) Mealio
// didn't intend to add. Mealio did not add: Sargento Shredded 4 Cheese" — about
// the cheese Mealio had asked for by name seventeen seconds earlier. It is the
// same false warning he has already reported once: "it is showing a warning
// that 170 items are in the cart that mealio did not intend to add. That is
// wrong."
//
// Two files held opposite beliefs about one fact. albertsons-network.ts reports
// out_of_stock with the detail "the store added it but marked it unavailable";
// reconcileParallelAdd routes such an item out of the qty matching because "an
// out-of-stock item is genuinely not in the cart". The second is true at some
// stores and false at this one — [[one-stores-rule-is-not-everyones]].
import {
  attemptedFailureNames, dropExplainedOverAdds, AttemptedAdd,
} from '../../src/lib/cart-reconcile';

const attempt = (
  name: string,
  report: { success: boolean; productName: string | null; reason: string | null } | null,
): AttemptedAdd => ({ name, expectedQty: 1, isWeight: false, report });

describe('what this run tried and was refused', () => {
  it('names the failure by the title the store used', () => {
    // The cart row carries the STORE's title, so that is what has to match.
    const attempts = [
      attempt('shredded cheese', {
        success: false, reason: 'out_of_stock',
        productName: 'Sargento Shredded 4 Cheese Mexican Natural Cheese Fine Cut - 8 Oz',
      }),
    ];
    expect(attemptedFailureNames(attempts, [{ index: 0 }]))
      .toEqual(['Sargento Shredded 4 Cheese Mexican Natural Cheese Fine Cut - 8 Oz']);
  });

  it('falls back to what we intended when the store named nothing', () => {
    // A no_results failure has no product title — there was no product.
    const attempts = [attempt('sour cream', { success: false, reason: 'no_results', productName: null })];
    expect(attemptedFailureNames(attempts, [{ index: 0 }])).toEqual(['sour cream']);
  });

  it('names only the failures, not the whole run', () => {
    // A SUCCESSFUL item is already accounted for in `intended` at its full
    // requested quantity. Naming it here would explain a second unit of it and
    // blind the double-add check, which is the thing the over-add warning is
    // actually for.
    const attempts = [
      attempt('milk', { success: true, reason: null, productName: 'Whole Milk' }),
      attempt('cheese', { success: false, reason: 'out_of_stock', productName: 'Cheddar' }),
    ];
    expect(attemptedFailureNames(attempts, [{ index: 1 }])).toEqual(['Cheddar']);
  });

  it('one name per failure, so two failures explain two units and no more', () => {
    const attempts = [
      attempt('a', { success: false, reason: 'out_of_stock', productName: 'Cheddar' }),
      attempt('b', { success: false, reason: 'out_of_stock', productName: 'Cheddar' }),
    ];
    expect(attemptedFailureNames(attempts, [{ index: 0 }, { index: 1 }]))
      .toEqual(['Cheddar', 'Cheddar']);
  });

  it('says nothing when the run had no failures', () => {
    const attempts = [attempt('milk', { success: true, reason: null, productName: 'Whole Milk' })];
    expect(attemptedFailureNames(attempts, [])).toEqual([]);
  });

  it('survives an index nothing reported for', () => {
    // A worker that never answered leaves report null; the intended name still
    // stands, and an index past the end must not throw.
    expect(attemptedFailureNames([attempt('milk', null)], [{ index: 0 }])).toEqual(['milk']);
    expect(attemptedFailureNames([], [{ index: 3 }])).toEqual([]);
  });
});

describe('and what that does to the warning', () => {
  // The two halves joined, in the shape the cart sheet joins them.
  const overAdds = [{
    name: 'Sargento Shredded 4 Cheese Mexican Natural Cheese Fine Cut - 8 Oz', qty: 1,
  }];

  it('drops the row the run itself asked for', () => {
    const attempts = [
      attempt('shredded cheese', {
        success: false, reason: 'out_of_stock',
        productName: 'Sargento Shredded 4 Cheese Mexican Natural Cheese Fine Cut - 8 Oz',
      }),
    ];
    const explained = attemptedFailureNames(attempts, [{ index: 0 }]);
    expect(dropExplainedOverAdds(overAdds, explained)).toEqual([]);
  });

  it('but still reports a product nothing in the run asked for', () => {
    // The safety net has to survive the fix. A line the run never mentioned is
    // exactly what this warning is for.
    const attempts = [
      attempt('shredded cheese', { success: false, reason: 'out_of_stock', productName: 'Cheddar' }),
    ];
    const explained = attemptedFailureNames(attempts, [{ index: 0 }]);
    expect(dropExplainedOverAdds(overAdds, explained)).toEqual(overAdds);
  });

  it('and still reports a DOUBLE-add of something it did ask for', () => {
    // The other half of the safety net. A successful item is accounted for at
    // its requested quantity, so a second unit is still unexplained — and
    // nothing here explains it, because only failures are named.
    const attempts = [
      attempt('cheese', {
        success: true, reason: null,
        productName: 'Sargento Shredded 4 Cheese Mexican Natural Cheese Fine Cut - 8 Oz',
      }),
    ];
    const explained = attemptedFailureNames(attempts, []);
    expect(dropExplainedOverAdds(overAdds, explained)).toEqual(overAdds);
  });
});
