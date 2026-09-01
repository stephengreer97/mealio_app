import { auditCartAfterRun, buildCartVerdict } from '../../src/lib/cart-reconcile';

// Two ingredients, both onions. One named a product H-E-B carries; the other
// named "H-E-B Texas Roots Fresh White Onion", which their search returns
// nothing for, so the user picked the plain "Fresh White Onion" as a substitute
// on the review screen. The cart gained TWO of the same product, on purpose.
//
// A review pick REPLACES what an ingredient means. Both snapshots of the run's
// intent have to learn that — runIntendedRef AND the reconcile's own, which is
// the one the cart audit reads. Neither did, so the audit went looking for a
// Texas Roots onion, did not find one, and had a spare Fresh White Onion that
// nothing claimed. Stephen read the result next to a green row saying two were
// added:
//
//   "Mealio did not add: Fresh White Onion, Avg 0.955 lb"
//
// which is the over-add warning, not a failure — it means "this is in your cart
// and we are not claiming credit for it". About a product he had chosen thirty
// seconds earlier.
const ONION = 'Fresh White Onion, Avg. 0.955 lb';
const TEXAS_ROOTS = 'H-E-B Texas Roots Fresh White Onion, Avg. 0.955 lb';

const row = (name: string, qty: number) => ({ name, qty, added: true });
const intended = (name: string, expectedQty: number) => ({ name, expectedQty, isWeight: false });

// reconcileIntended, NOT active. auditCartAfterRun uses
//   intendedAll = reconcileIntended.length > 0 ? reconcileIntended : active
// so on any run that reconciled — every network run — the reconcile's snapshot
// is the one that decides, and `active` is never consulted. A first attempt at
// this test passed reconcileIntended: [] and therefore proved nothing about the
// path Stephen was actually on.
const audit = (intendedAll: ReturnType<typeof intended>[]) =>
  auditCartAfterRun({
    rows: [row(ONION, 2)],
    reportedAdded: [ONION, ONION],
    active: intendedAll,
    reconcileIntended: intendedAll,
    countBefore: 0,
    countAfter: 2,
  }) as ReturnType<typeof auditCartAfterRun> & {
    comparison: { extra: { name: string; qty: number }[]; short: { name: string }[] };
  };

describe('a substitute landing on a product another ingredient already added', () => {
  it('REVISED intent: two onions asked for, two arrived, and the screen says nothing', () => {
    const findings = audit([intended(ONION, 1), intended(ONION, 1)]);
    expect(findings.comparison.extra).toEqual([]);
    expect(findings.comparison.short).toEqual([]);

    const verdict = buildCartVerdict({
      storeName: 'H-E-B', findings, reportedFailed: [], unreadReason: null,
    });
    expect(verdict.detail).toBe('');
  });

  it('UN-REVISED intent produces the exact contradiction Stephen read', () => {
    const findings = audit([intended(ONION, 1), intended(TEXAS_ROOTS, 1)]);

    // One onion in the cart that no intended item claims...
    expect(findings.comparison.extra).toEqual([{ name: ONION, qty: 1 }]);
    // ...and the ingredient he HAD resolved, reported as never arriving.
    expect(findings.comparison.short.map((s) => s.name)).toEqual([TEXAS_ROOTS]);

    const verdict = buildCartVerdict({
      storeName: 'H-E-B', findings, reportedFailed: [], unreadReason: null,
    });
    // Both halves of the confusion, in one banner, about the same onion.
    expect(verdict.detail).toContain(`Mealio did not add: ${ONION}`);
    expect(verdict.detail).toContain(`Could not add: ${TEXAS_ROOTS}`);
  });
});
