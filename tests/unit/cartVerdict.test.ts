// The one message the done screen shows, and the cart-sourced list behind it
// (MEAL-199).
//
// The bug this replaces was not a wrong string. It was two observers rendered as
// peers: "Could not add: Sour Cream", from the run's own report, printed above a
// banner saying Sour Cream was in the cart. The tests that matter here are the
// ones asserting a single source — that the run's claims cannot reach the screen
// while a cart read is available, and that they are LABELLED when there is no
// cart read and they are all we have.

import { auditCartAfterRun, buildCartVerdict, splitCartLeftover } from '../../src/lib/cart-reconcile';
import type { CartCheckFindings, IntendedItem } from '../../src/lib/cart-reconcile';
import type { CartRow } from '../../src/lib/webview-scripts/cart-count';

const row = (name: string, qty: number, isWeight = false): CartRow =>
  ({ name, qty, added: true, isWeight });

const want = (name: string, expectedQty = 1, extra: Partial<IntendedItem> = {}): IntendedItem =>
  ({ name, expectedQty, isWeight: false, ...extra });

const audit = (rows: CartRow[] | null, reportedAdded: string[], intended: IntendedItem[]) =>
  auditCartAfterRun({
    rows,
    reportedAdded,
    active: intended,
    reconcileIntended: intended,
    countBefore: 0,
    countAfter: rows ? rows.reduce((n, r) => n + r.qty, 0) : null,
  });

const verdict = (findings: CartCheckFindings, reportedFailed: string[] = [], unreadReason: string | null = null) =>
  buildCartVerdict({ storeName: 'H-E-B', findings, reportedFailed, unreadReason });

describe('splitCartLeftover — the unaccounted side of the claim', () => {
  it('reports an intended item the cart never got', () => {
    const split = splitCartLeftover([row('Daisy Sour Cream 16 oz', 1)], ['Sour Cream'], [want('Sour Cream'), want('Butter')]);
    expect(split.unaccounted).toEqual([{ name: 'Butter', expected: 1, got: 0 }]);
  });

  it('reports a partial claim with the units the cart credits', () => {
    const split = splitCartLeftover([row('Large Eggs', 1)], ['Large Eggs'], [want('Large Eggs', 3)]);
    expect(split.unaccounted).toEqual([{ name: 'Large Eggs', expected: 3, got: 1 }]);
  });

  it('leaves a fully claimed item out of it', () => {
    const split = splitCartLeftover([row('Large Eggs', 3)], ['Large Eggs'], [want('Large Eggs', 3)]);
    expect(split.unaccounted).toEqual([]);
  });

  it('settles a weight item by presence, not by requested count', () => {
    // A deli line is one row whatever the poundage. Reading expectedQty here
    // would report a satisfied item as short by 2.
    const split = splitCartLeftover(
      [row('Boneless Skinless Chicken Breasts', 1, true)],
      ['Chicken Breasts'],
      [want('Chicken Breasts', 3, { isWeight: true })],
    );
    expect(split.unaccounted).toEqual([]);
  });

  it('settles an increment-style item by its weight line too', () => {
    const split = splitCartLeftover(
      [row('Bananas', 1, true)],
      ['Bananas'],
      [want('Bananas', 4, { weightStepLb: 0.25 })],
    );
    expect(split.unaccounted).toEqual([]);
  });

  it('never lists a unit as both unaccounted and over', () => {
    // One pool, one partition — the property the done screen's coherence rests on.
    const split = splitCartLeftover(
      [row('Chicken Thighs', 1), row('Daisy Sour Cream', 1)],
      ['Sour Cream'],
      [want('Sour Cream'), want('Butter')],
    );
    const overNames = split.over.map((o) => o.name);
    const unaccountedNames = split.unaccounted.map((u) => u.name);
    expect(overNames).toEqual(['Chicken Thighs']);
    expect(unaccountedNames).toEqual(['Butter']);
    expect(overNames.filter((n) => unaccountedNames.includes(n))).toEqual([]);
  });
});

describe('buildCartVerdict — when the cart was read', () => {
  it('names an absent item from the cart, not from the run', () => {
    // The run claimed it added Butter. The cart disagrees, and the cart wins.
    const v = verdict(audit([row('Daisy Sour Cream', 1)], ['Sour Cream', 'Butter'], [want('Sour Cream'), want('Butter')]));
    expect(v.cartBacked).toBe(true);
    expect(v.notAdded).toEqual(['Butter']);
    expect(v.message).toContain('Butter is not in your cart');
  });

  it('says nothing at all when the cart matches what was asked for', () => {
    const v = verdict(audit([row('Sour Cream', 1)], ['Sour Cream'], [want('Sour Cream')]));
    expect(v.message).toBeNull();
    expect(v.notAdded).toEqual([]);
  });

  it('does NOT tell the user to avoid re-adding a recovered item', () => {
    // The run reported Sour Cream as failed; the cart has it. Under one source
    // it is simply not in the failed list, so there is nothing to take back —
    // the old screen printed a rebuttal of its own line above.
    const findings = audit([row('Sour Cream', 1)], [], [want('Sour Cream')]);
    expect(findings.recovered.length).toBeGreaterThan(0);
    const v = verdict(findings, ['Sour Cream']);
    expect(v.notAdded).toEqual([]);
    expect(v.message ?? '').not.toContain("don't add it again");
    expect(v.message ?? '').not.toContain('Sour Cream is not in your cart');
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
    expect(v.message).toContain('Butter is not in your cart');
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

describe('buildCartVerdict — when the cart could not be read', () => {
  it('returns the run’s failed list UNPROMOTED', () => {
    // cartBacked false is the whole signal: the caller keeps rendering the run's
    // own "Could not add" line, rather than the cart-sourced sentence, because
    // no cart said anything.
    const v = verdict(audit(null, ['Sour Cream'], [want('Sour Cream')]), ['Butter']);
    expect(v.cartBacked).toBe(false);
    expect(v.notAdded).toEqual(['Butter']);
  });

  it('emits no message of its own — MEAL-190 owns that copy', () => {
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
    expect(findings.notInCart).toEqual([]);
    const v = verdict(findings, []);
    expect(v.notAdded).toEqual([]);
  });
});
