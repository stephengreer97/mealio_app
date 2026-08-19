// The one message the done screen shows, and the cart-sourced list behind it
// (MEAL-199).
//
// The bug this replaces was not a wrong string. It was two observers rendered as
// peers: "Could not add: Sour Cream", from the run's own report, printed above a
// banner saying Sour Cream was in the cart. The tests that matter here are the
// ones asserting a single source — that the run's claims cannot reach the screen
// while a cart read is available, and that they are LABELLED when there is no
// cart read and they are all we have.

import { auditCartAfterRun, buildCartVerdict, compareCartToIntended } from '../../src/lib/cart-reconcile';
import type { CartCheckFindings, IntendedItem } from '../../src/lib/cart-reconcile';
import type { CartRow } from '../../src/lib/webview-scripts/cart-count';

const row = (name: string, qty: number, isWeight = false): CartRow =>
  ({ name, qty, added: true, isWeight });

const want = (name: string, expectedQty = 1, extra: Partial<IntendedItem> = {}): IntendedItem =>
  ({ name, expectedQty, isWeight: false, ...extra });

const audit = (
  rows: CartRow[] | null,
  reportedAdded: string[],
  intended: IntendedItem[],
  extra: { explainedRows?: string[]; skippedNames?: string[]; countBefore?: number; countAfter?: number } = {},
) =>
  auditCartAfterRun({
    rows,
    reportedAdded,
    active: intended,
    reconcileIntended: intended,
    countBefore: extra.countBefore ?? 0,
    countAfter: extra.countAfter ?? (rows ? rows.reduce((n, r) => n + r.qty, 0) : null),
    explainedRows: extra.explainedRows,
    skippedNames: extra.skippedNames,
  });

/** A row already in the cart before this run — grey, not this run's doing. */
const preexisting = (name: string, qty: number): CartRow =>
  ({ name, qty, added: false, isWeight: false });

const verdict = (findings: CartCheckFindings, reportedFailed: string[] = [], unreadReason: string | null = null) =>
  buildCartVerdict({ storeName: 'H-E-B', findings, reportedFailed, unreadReason });

describe('compareCartToIntended — products and units, matched by exact name', () => {
  const compare = (addedRows: CartRow[], intended: IntendedItem[], skippedNames: string[] = []) =>
    compareCartToIntended({ addedRows, intended, skippedNames });

  it('counts a full match as settled', () => {
    expect(compare([row('Large Eggs', 3)], [want('Large Eggs', 3)])).toEqual({ short: [], extra: [] });
  });

  it('reports the units the cart is short by', () => {
    expect(compare([row('Large Eggs', 1)], [want('Large Eggs', 3)]).short)
      .toEqual([{ name: 'Large Eggs', expected: 3, got: 1 }]);
  });

  it('reports a product the cart gained none of', () => {
    expect(compare([row('Sour Cream', 1)], [want('Sour Cream'), want('Butter')]).short)
      .toEqual([{ name: 'Butter', expected: 1, got: 0 }]);
  });

  it('reports units nothing asked for', () => {
    expect(compare([row('Sour Cream', 1), row('Chicken Thighs', 2)], [want('Sour Cream')]).extra)
      .toEqual([{ name: 'Chicken Thighs', qty: 2 }]);
  });

  it('does not consider a skipped product', () => {
    expect(compare([row('Sour Cream', 1)], [want('Sour Cream'), want('Tortillas')], ['Tortillas']))
      .toEqual({ short: [], extra: [] });
  });

  it('matches weight lines by presence, not units', () => {
    expect(compare([row('Chicken Breasts', 1, true)], [want('Chicken Breasts', 3, { isWeight: true })]))
      .toEqual({ short: [], extra: [] });
  });

  it('reports a weight line the cart never gained', () => {
    expect(compare([], [want('Chicken Breasts', 3, { isWeight: true })]).short)
      .toEqual([{ name: 'Chicken Breasts', expected: 1, got: 0 }]);
  });

  it('matches an increment-style item by its weight line', () => {
    expect(compare([row('Bananas', 1, true)], [want('Bananas', 4, { weightStepLb: 0.25 })]))
      .toEqual({ short: [], extra: [] });
  });

  it('normalises punctuation and case but nothing more', () => {
    // Same product, differently rendered by the cart page. Normalisation is
    // exactly what normalizeName already does for the add path.
    expect(compare([row('DAISY  SOUR-CREAM', 1)], [want('Daisy Sour Cream')]))
      .toEqual({ short: [], extra: [] });
  });

  it('does NOT match a near-miss title', () => {
    // The whole point of exact. "Bananas Organic" is a different product from
    // "Bananas", and the lenient matcher used to swallow one into the other —
    // which is how a real over-add went unreported.
    const result = compare([row('Bananas Organic', 1)], [want('Bananas')]);
    expect(result.short).toEqual([{ name: 'Bananas', expected: 1, got: 0 }]);
    expect(result.extra).toEqual([{ name: 'Bananas Organic', qty: 1 }]);
  });

  it('splits 12 units across 10 products without double-counting', () => {
    const intended = Array.from({ length: 10 }, (_, i) => want(`Product ${i}`, i < 2 ? 2 : 1));
    const rows = intended.map((it) => row(it.name, it.expectedQty));
    const result = compare(rows, intended);
    expect(intended.reduce((n, i) => n + i.expectedQty, 0)).toBe(12);
    expect(result).toEqual({ short: [], extra: [] });
  });
});

describe('buildCartVerdict — when the cart was read', () => {
  it('names an absent item from the cart, not from the run', () => {
    // The run claimed it added Butter. The cart disagrees, and the cart wins.
    const v = verdict(audit([row('Sour Cream', 1)], ['Sour Cream', 'Butter'], [want('Sour Cream'), want('Butter')]));
    expect(v.cartBacked).toBe(true);
    expect(v.notAdded).toEqual(['Butter']);
    expect(v.message).toContain('Mealio could not add Butter');
  });

  it('says nothing at all when the cart matches what was asked for', () => {
    const v = verdict(audit([row('Sour Cream', 1)], ['Sour Cream'], [want('Sour Cream')]));
    expect(v.message).toBeNull();
    expect(v.notAdded).toEqual([]);
  });

  it('never calls a recovered item failed', () => {
    // The invariant, as opposed to the copy. The run reported Sour Cream as
    // failed and the cart has it, so it must not appear in `notAdded` and must
    // not be named absent — whatever sentence the screen ends up printing.
    const findings = audit([row('Sour Cream', 1)], [], [want('Sour Cream')]);
    expect(findings.recovered.length).toBeGreaterThan(0);
    const v = verdict(findings, ['Sour Cream']);
    expect(v.notAdded).toEqual([]);
    expect(v.message ?? '').not.toContain('could not add Sour Cream');
  });

  it('reports a short add with the units the cart shows', () => {
    const v = verdict(audit([row('Large Eggs', 1)], ['Large Eggs'], [want('Large Eggs', 3)]));
    expect(v.message).toContain('Large Eggs (1 of 3)');
    // Short is not absent: the item IS in the cart, so it must not be named as
    // failed or the user re-adds a thing they already have.
    expect(v.notAdded).toEqual([]);
  });

  it('reports units nothing intended', () => {
    const v = verdict(audit([row('Sour Cream', 1), row('Chicken Thighs', 2)], ['Sour Cream'], [want('Sour Cream')]));
    expect(v.message).toContain('Mealio did not add');
    expect(v.message).toContain('Chicken Thighs ×2');
  });

  it('puts every finding in ONE message', () => {
    const v = verdict(audit(
      [row('Large Eggs', 1), row('Chicken Thighs', 1)],
      ['Large Eggs', 'Butter'],
      [want('Large Eggs', 3), want('Butter')],
    ));
    const messages = [v.message].filter(Boolean);
    expect(messages).toHaveLength(1);
    expect(v.message).toContain('Mealio could not add Butter');
    expect(v.message).toContain('Large Eggs (1 of 3)');
    expect(v.message).toContain('Chicken Thighs');
  });

  it('ignores the run’s failed list entirely once the cart has spoken', () => {
    // The run insists Sour Cream failed. The cart has it. Nothing the run says
    // reaches the screen.
    const v = verdict(audit([row('Sour Cream', 1)], ['Sour Cream'], [want('Sour Cream')]), ['Sour Cream', 'Butter']);
    expect(v.notAdded).toEqual([]);
    expect(v.message).toBeNull();
  });
});

describe('never call an item absent when it is not', () => {
  // Every case here produces a sentence of the form "X is not in your cart".
  // Each one would be false, and each drives the same expensive mistake: the
  // user buys a thing they already have.

  it('an item the user already had in their cart is not absent', () => {
    // The run failed to add it; the cart has it anyway, as a grey row this run
    // did not put there. `addedRows` cannot see it, so the claim pass leaves it
    // unclaimed — and saying it is missing is a flat false statement about cart
    // contents, made in the cart's own name.
    // The run failed to add it and the cart has it anyway, as a grey row this
    // run did not put there. We must not claim it is absent from the cart — we
    // only ever claim what WE did.
    const findings = audit(
      [preexisting('Daisy Sour Cream', 1)],
      [],
      [want('Daisy Sour Cream')],
    );
    const v = verdict(findings);
    expect(v.message ?? '').not.toMatch(/not in your cart|is missing/i);
    expect(v.message ?? '').toContain('could not add');
  });

  it('a line the run reports as unverified-by-weight is not absent', () => {
    // MEAL-119: a count item can never claim a weight row, so it arrives
    // unclaimed while the screen is separately naming that line as one it could
    // not verify. `over` was already filtered for this; `notInCart` must be too,
    // or the item lands in the failed list that forbids exactly this.
    const findings = audit(
      [row('H-E-B Boneless Chicken Breasts', 1, true)],
      [],
      [want('H-E-B Boneless Chicken Breasts', 1, { isWeight: true })],
      { explainedRows: ['H-E-B Boneless Chicken Breasts'] },
    );
    // Exact name, presence-matched: the weight line IS the item, so it settles.
    expect(findings.comparison.short).toEqual([]);
    expect(verdict(findings).notAdded).toEqual([]);
  });

  it('an ingredient the user skipped at review is not absent', () => {
    // Skips stay in the intended set — handleReviewDecision only records the
    // skip, it does not narrow activeItems — so without this they arrive as
    // cart-sourced failures beside the skipped banner that already reports them.
    const findings = audit(
      [row('Sour Cream', 1)],
      ['Sour Cream'],
      [want('Sour Cream'), want('Tortillas')],
      { skippedNames: ['Tortillas'] },
    );
    expect(findings.comparison.short).toEqual([]);
    expect(verdict(findings).notAdded).toEqual([]);
  });

  it('still names a genuinely absent item', () => {
    // The guard must not swallow the real case: nothing in the cart, not
    // explained, not skipped.
    const v = verdict(audit([row('Sour Cream', 1)], ['Sour Cream'], [want('Sour Cream'), want('Butter')]));
    expect(v.notAdded).toEqual(['Butter']);
    expect(v.message).toContain('Mealio could not add Butter');
  });
});

describe('a run the cart says succeeded must not read as a failure', () => {
  it('speaks up when every item was recovered', () => {
    // The likelier recovery shape: a stale badge fails the whole run, the cart
    // has everything. Nothing is absent, short or unintended — so there is no
    // warning to print, while the headline still says "No items were added."
    // Silence here leaves that claim standing and the user re-adds a full cart.
    const findings = audit([row('Sour Cream', 1)], [], [want('Sour Cream')]);
    expect(findings.recovered).toHaveLength(1);
    const v = verdict(findings, ['Sour Cream']);
    expect(v.cartBacked).toBe(true);
    expect(v.message).toContain('everything you asked for is there');
    expect(v.message).toContain('Sour Cream');
    expect(v.notAdded).toEqual([]);
  });

  it('does not claim Mealio added them', () => {
    // A recovery is a name match against a row: enough to say the row is there,
    // not enough to say this run put it there (MEAL-177).
    const v = verdict(audit([row('Sour Cream', 1)], [], [want('Sour Cream')]), ['Sour Cream']);
    expect(v.message ?? '').not.toMatch(/we added|mealio added/i);
  });

  it('reports the problem instead when there is one', () => {
    // The positive sentence is for a clean cart only. With something absent, the
    // warning wins — a reassurance printed over a real finding is worse than
    // either alone.
    const v = verdict(
      audit([row('Sour Cream', 1)], [], [want('Sour Cream'), want('Butter')]),
      ['Sour Cream', 'Butter'],
    );
    expect(v.message).toContain('Mealio could not add Butter');
    expect(v.message ?? '').not.toContain('everything you asked for is there');
  });
});

describe('buildCartVerdict — when the cart could not be read', () => {
  it('returns the run’s failed list UNPROMOTED', () => {
    // cartBacked false is the whole signal: the caller keeps rendering the run's
    // own "Could not add" line, rather than the cart-sourced sentence, because
    // no cart said anything.
    const v = verdict(audit(null, ['Sour Cream'], [want('Sour Cream')]), ['Butter']);
    expect(v.cartBacked).toBe(false);
    expect(v.notAdded).toEqual(['Butter']);
  });

  it('still warns a header-badge store on a count shortfall', () => {
    // The only cart evidence a badge-only store can produce. Returning early
    // past it made this warning unreachable in exactly the case it was written
    // for — the user got nothing at all.
    const findings = audit(null, ['Sour Cream', 'Butter', 'Eggs'], [want('Sour Cream'), want('Butter'), want('Eggs')], {
      countBefore: 0,
      countAfter: 1,
    });
    expect(findings.countShortfall).toEqual({ delta: 1, expected: 3 });
    const v = verdict(findings, []);
    expect(v.message).toContain('went up by 1 item where 3 were expected');
    // A count cannot say WHICH item, so the run's own failed list must stay on
    // screen rather than be replaced by a per-item verdict nobody can build.
    expect(v.cartBacked).toBe(false);
  });

  it('emits no message of its own when there is no count either — MEAL-190 owns that copy', () => {
    // A second "we could not check your cart" sentence would either clobber
    // MEAL-190's (the done screen prefers this one) or print beside it, which is
    // the two-sources defect rebuilt in the one case where the cart never spoke.
    const v = verdict(audit(null, ['Sour Cream'], [want('Sour Cream')]), ['Butter']);
    expect(v.message).toBeNull();
  });

  it('does not treat an unread cart as an empty one', () => {
    // Every intended item is unaccounted for by a cart nobody read. Reporting
    // that as "nothing landed" is the false positive this must never produce.
    const findings = audit(null, [], [want('Sour Cream'), want('Butter')]);
    expect(findings.cartRead).toBe(false);
    expect(findings.comparison).toEqual({ short: [], extra: [] });
    const v = verdict(findings, []);
    expect(v.notAdded).toEqual([]);
  });
});
