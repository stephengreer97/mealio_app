// The north-star metric (MEAL-3): did the user get their groceries?
//
// The value of this number is entirely in its credibility, so these tests are
// mostly about the ways it could lie: a denominator that shrinks to the items
// that went wrong, a correction that can only revise upward, a weight item
// counted as a fraction, a Choose Products run scored against a cart it never
// touched, and a recovery credited on a name that merely looked similar.

import {
  correctConfirmedFromCart,
  countRequested,
  isRunComplete,
  runSummaryDetail,
  runSummaryFailureDetail,
} from '../../src/lib/north-star';
import type { RunSummaryFacts } from '../../src/lib/north-star';
import { MAX_DETAIL_KEYS, sanitizeDetail } from '../../src/lib/automation-telemetry';
import { auditCartAfterRun, isWeightPriced } from '../../src/lib/cart-reconcile';
import type { IntendedItem, RecoveredAdd } from '../../src/lib/cart-reconcile';
import type { CartRow } from '../../src/lib/webview-scripts/cart-count';

const row = (name: string, qty: number, isWeight = false): CartRow =>
  ({ name, qty, added: true, isWeight });

const recovery = (name: string, matchQuality: 'exact' | 'loose'): RecoveredAdd =>
  ({ name, cartName: name, qty: 1, matchQuality });

// ── The denominator ───────────────────────────────────────────────────────────

describe('countRequested', () => {
  it('counts LINES, not units — an item asked for ×3 is one requested item', () => {
    // Units-weighted would let a single bulk line dominate a store's rate, and
    // the user experiences "did I get the sour cream", not "did I get 83% of my
    // requested units".
    expect(countRequested([{}, {}, {}])).toEqual({ requested: 3, weightRequested: 0 });
  });

  it('counts a weight-priced item as ONE requested item, not a fraction', () => {
    // A weight line is confirmed by presence (see isWeightPriced), so it is a
    // whole unit of both the numerator and the denominator. Anything else would
    // make the rate depend on how much brisket someone bought.
    const out = countRequested([{ purchaseWeight: 2.5 }, {}]);
    expect(out).toEqual({ requested: 2, weightRequested: 1 });
  });

  it('does not treat a stepper-weight item as weight-priced — it reconciles by count', () => {
    // HEB Deli with no weight dropdown: weightStep but no purchaseWeight. The
    // one rule lives in isWeightPriced and this must agree with it, not restate
    // it (MEAL-62 consolidated it so MEAL-3 would not fork it).
    const stepper = { purchaseWeight: null } as { purchaseWeight?: number | null };
    expect(isWeightPriced(stepper)).toBe(false);
    expect(countRequested([stepper])).toEqual({ requested: 1, weightRequested: 0 });
  });

  it('is zero for an empty set — a Choose Products run requests nothing of a cart', () => {
    expect(countRequested([])).toEqual({ requested: 0, weightRequested: 0 });
  });
});

// ── The run-rate numerator ────────────────────────────────────────────────────

describe('isRunComplete', () => {
  it('is true only when every requested item landed', () => {
    expect(isRunComplete(8, 8)).toBe(true);
    expect(isRunComplete(8, 7)).toBe(false);
    expect(isRunComplete(1, 0)).toBe(false);
  });

  it('is FALSE for a run that requested nothing — no run is not a clean run', () => {
    // Otherwise every Choose Products run would count as a win on the run rate
    // while contributing nothing to the item rate, quietly inflating the number
    // the ticket exists to expose.
    expect(isRunComplete(0, 0)).toBe(false);
  });

  it('reads an overshoot as complete rather than as impossible', () => {
    // Two near-identical titles can both claim one cart row. That is a matching
    // bug worth its own chart, not a reason for the run rate to go undefined.
    expect(isRunComplete(2, 3)).toBe(true);
  });

  it('shows the gap the ticket is about: a good item rate is a poor run rate', () => {
    // 7-of-8 items on every run is an 87.5% item rate and a 0% run rate. The two
    // numbers side by side are the argument for per-item confirmation.
    const runs = [7, 7, 7].map((confirmed) => ({ requested: 8, confirmed }));
    const itemRate =
      runs.reduce((n, r) => n + r.confirmed, 0) / runs.reduce((n, r) => n + r.requested, 0);
    const runRate =
      runs.filter((r) => isRunComplete(r.requested, r.confirmed)).length / runs.length;
    expect(itemRate).toBeCloseTo(0.875);
    expect(runRate).toBe(0);
  });
});

// ── The after-probe correction (MEAL-3 × MEAL-47) ─────────────────────────────

describe('correctConfirmedFromCart', () => {
  it('leaves a clean audit alone', () => {
    expect(correctConfirmedFromCart({
      requested: 4, summaryConfirmed: 4, missing: 0, short: 0, recovered: [],
    })).toEqual({
      confirmed: 4, overstated: 0, recovered: 0, recoveredLoose: 0, runComplete: true,
    });
  });

  it('revises DOWN when the cart cannot corroborate a reported add', () => {
    // The direction that matters most: itemsAdded is worker-reported on the
    // serial stores, so `missing`/`short` mean the shipped number was too high.
    // A metric that can only be revised upward is a vanity metric.
    const out = correctConfirmedFromCart({
      requested: 5, summaryConfirmed: 5, missing: 1, short: 1, recovered: [],
    });
    expect(out.confirmed).toBe(3);
    expect(out.overstated).toBe(2);
    expect(out.runComplete).toBe(false);
  });

  it('revises UP for a false negative the cart found anyway, and can flip the run complete', () => {
    const out = correctConfirmedFromCart({
      requested: 3, summaryConfirmed: 2, missing: 0, short: 0,
      recovered: [recovery('sour cream', 'exact')],
    });
    expect(out.confirmed).toBe(3);
    expect(out.recovered).toBe(1);
    expect(out.recoveredLoose).toBe(0);
    expect(out.runComplete).toBe(true);
  });

  it('counts the LOOSELY-matched share of a recovery apart from the rest', () => {
    // MEAL-47's caveat: names alone cannot separate "the failed item landed" from
    // "an unintended product landed". Subtracting recoveredLoose gives the read
    // side a lower bound, so a run flipped complete by a guess can be shown as a
    // band rather than as a fact.
    const out = correctConfirmedFromCart({
      requested: 4, summaryConfirmed: 1, missing: 0, short: 0,
      recovered: [recovery('a', 'exact'), recovery('b', 'loose'), recovery('c', 'loose')],
    });
    expect(out.confirmed).toBe(4);
    expect(out.recovered).toBe(3);
    expect(out.recoveredLoose).toBe(2);
    // The lower bound the dashboard should draw the band down to.
    expect(out.confirmed - out.recoveredLoose).toBe(2);
  });

  it('corrects in both directions at once', () => {
    const out = correctConfirmedFromCart({
      requested: 6, summaryConfirmed: 4, missing: 2, short: 0,
      recovered: [recovery('x', 'exact')],
    });
    expect(out.confirmed).toBe(3);
    expect(out.overstated).toBe(2);
    expect(out.recovered).toBe(1);
  });

  it('never reports more confirmed than requested', () => {
    // Three separate name-matching passes over one cart feed this, and a rate
    // that can read 9-of-8 is a rate nobody believes the rest of.
    const out = correctConfirmedFromCart({
      requested: 2, summaryConfirmed: 2, missing: 0, short: 0,
      recovered: [recovery('x', 'loose'), recovery('y', 'loose')],
    });
    expect(out.confirmed).toBe(2);
    expect(out.runComplete).toBe(true);
  });

  it('never reports a negative confirmed count', () => {
    const out = correctConfirmedFromCart({
      requested: 3, summaryConfirmed: 1, missing: 3, short: 1, recovered: [],
    });
    expect(out.confirmed).toBe(0);
    expect(out.runComplete).toBe(false);
  });

  it('leaves a Choose Products run at zero-of-zero and NOT complete', () => {
    const out = correctConfirmedFromCart({
      requested: 0, summaryConfirmed: 0, missing: 0, short: 0, recovered: [],
    });
    expect(out.confirmed).toBe(0);
    expect(out.runComplete).toBe(false);
  });
});

// ── The correction's inputs come from the real audit ──────────────────────────
//
// correctConfirmedFromCart is only as honest as auditCartAfterRun's match
// quality, so these drive the two together rather than hand-writing recoveries.

describe('correctConfirmedFromCart over auditCartAfterRun output', () => {
  const intended = (name: string, expectedQty: number, isWeight = false): IntendedItem =>
    ({ name, expectedQty, isWeight });

  it('marks a store-title recovery loose, so a run it flips complete is shown as a band', () => {
    // The worker said the sour cream failed; the cart holds "Daisy Pure &
    // Natural Sour Cream, 16 oz". Only the token matcher connects the two, which
    // is exactly the match that would also connect a lookalike.
    const findings = auditCartAfterRun({
      rows: [row('Daisy Pure & Natural Sour Cream, 16 oz', 1)],
      reportedAdded: [],
      active: [intended('sour cream', 1)],
      reconcileIntended: [],
      countBefore: 0,
      countAfter: 1,
    });
    const out = correctConfirmedFromCart({
      requested: 1, summaryConfirmed: 0,
      missing: findings.missing.length, short: findings.short.length,
      recovered: findings.recovered,
    });
    expect(out.confirmed).toBe(1);
    expect(out.runComplete).toBe(true);
    // ...but on a loose match, so the lower bound is still 0-of-1.
    expect(out.recoveredLoose).toBe(1);
  });

  it('marks a weight recovery loose — presence matching has no exact pass', () => {
    const findings = auditCartAfterRun({
      rows: [row('H-E-B Prime 1 Beef Brisket', 1, true)],
      reportedAdded: [],
      active: [intended('brisket', 4, true)],
      reconcileIntended: [],
      countBefore: 0,
      countAfter: 1,
    });
    expect(findings.recovered).toEqual([
      { name: 'brisket', cartName: 'H-E-B Prime 1 Beef Brisket', qty: 1, matchQuality: 'loose' },
    ]);
  });

  it('a mixed claim is loose — the doubt attaches to the row, not to the average', () => {
    // "Milk" ×2: one unit from an exact-title row, one from a lookalike. Calling
    // the claim half-trustworthy would be a number about nothing; the pessimistic
    // read is the only one that cannot overstate.
    const findings = auditCartAfterRun({
      rows: [row('Milk', 1), row('Organic Whole Milk', 1)],
      reportedAdded: [],
      active: [intended('Milk', 2)],
      reconcileIntended: [],
      countBefore: 0,
      countAfter: 2,
    });
    expect(findings.recovered).toHaveLength(1);
    expect(findings.recovered[0].qty).toBe(2);
    expect(findings.recovered[0].matchQuality).toBe('loose');
  });

  it('an unclaimed cart row stays an over-add and never becomes a recovery', () => {
    // The correction must not be able to credit us with a unit nothing intended.
    const findings = auditCartAfterRun({
      rows: [row('Milk', 1), row('Impulse Candy Bar', 1)],
      reportedAdded: ['Milk'],
      active: [intended('Milk', 1), intended('Eggs', 1)],
      reconcileIntended: [],
      countBefore: 0,
      countAfter: 2,
    });
    expect(findings.recovered).toEqual([]);
    expect(findings.over).toEqual([{ name: 'Impulse Candy Bar', qty: 1 }]);
    const out = correctConfirmedFromCart({
      requested: 2, summaryConfirmed: 1,
      missing: findings.missing.length, short: findings.short.length,
      recovered: findings.recovered,
    });
    expect(out.confirmed).toBe(1);
    expect(out.runComplete).toBe(false);
  });
});

describe('the run_summary detail a finished run ships', () => {
  // A plausible failed run: eight lines asked for, none confirmed, two of them
  // sold by weight, one skipped in review.
  const facts: RunSummaryFacts = {
    outcome: 'failed',
    itemsAdded: 0,
    cartDeltaWarning: false,
    kind: 'add',
    requested: 8,
    confirmedSource: 'worker_reports',
    weightRequested: 2,
    skippedInReview: 1,
    runComplete: false,
    keptInReview: 0,
  };

  it('survives sanitizeDetail whole, including the failure tally', () => {
    // The point of this test, and the reason the payload is assembled in a
    // function at all: the failed-run detail is at MAX_DETAIL_KEYS EXACTLY.
    //
    // sanitizeDetail truncates over the cap silently, in Object.entries order, and
    // `failureCodes` is last — so a field added to RunSummaryFacts drops the tally
    // and nothing anywhere says so. The row would go on claiming a distribution it
    // no longer carries, which is the exact failure MEAL-123 fixed once already (as
    // a nested Record the sanitizer discarded).
    //
    // If this fails after you added a field: the fix is not to loosen the
    // assertion. Either raise MAX_DETAIL_KEYS deliberately, or drop a field.
    const detail = runSummaryFailureDetail(facts, 'waf_block', 'confirm_failed:3,waf_block:1');

    expect(Object.keys(detail)).toHaveLength(MAX_DETAIL_KEYS);
    expect(sanitizeDetail(detail)).toEqual(detail);
    expect(sanitizeDetail(detail)!.failureCodes).toBe('confirm_failed:3,waf_block:1');
  });

  it("says whether the row's code was ranked or guessed", () => {
    // codeSource is how the read side tells a severity-ranked answer from the
    // fallback the caller uses when a run recorded no coded failure at all.
    expect(runSummaryFailureDetail(facts, 'waf_block', 'waf_block:1').codeSource)
      .toBe('severity');
    expect(runSummaryFailureDetail(facts, undefined, undefined).codeSource)
      .toBe('fallback');
  });

  it('carries no failure fields on a run that did not fail', () => {
    const detail = runSummaryDetail({
      ...facts, outcome: 'success', itemsAdded: 8, runComplete: true,
    });
    expect('codeSource' in detail).toBe(false);
    expect('failureCodes' in detail).toBe(false);
    expect(sanitizeDetail(detail)).toEqual(detail);
  });
});
