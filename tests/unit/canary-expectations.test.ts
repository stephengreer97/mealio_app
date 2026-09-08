/**
 * MEAL-7's scoring rule, which is the part most likely to be got subtly wrong.
 *
 * The canary meal contains items that are SUPPOSED to fail, so "all green" is
 * not the pass condition and a high success rate is not evidence of health.
 * These tests are about the three ways a naive scorer would mislead: counting
 * successes, ignoring a line that vanished, and treating an unexpected success
 * as good news.
 */
import {
  scoreCanaryRun, scoreRepeatRun, isRigProblem,
  type CanaryStorePlan, type CanaryObservation,
} from '../../src/lib/canary-expectations';

const plan: CanaryStorePlan = {
  storeId: 'heb',
  mealName: 'Canary',
  items: [
    { item: 'Whole milk', why: 'plain in-stock match', expect: { outcome: 'added' } },
    { item: 'Bananas', why: 'sold by weight', expect: { outcome: 'added_by_weight' } },
    { item: 'Nonexistent unobtainium', why: 'nothing should match', expect: { outcome: 'failed', code: 'no_candidates' } },
    { item: 'Ambiguous thing', why: 'candidates but none good enough', expect: { outcome: 'review' } },
  ],
};

const obs = (o: Partial<CanaryObservation> & { item: string }): CanaryObservation =>
  ({ outcome: 'added', ...o });

describe('scoreCanaryRun', () => {
  it('passes when every line lands where predicted, failures included', () => {
    const r = scoreCanaryRun(plan, [
      obs({ item: 'Whole milk' }),
      obs({ item: 'Bananas', outcome: 'added_by_weight' }),
      obs({ item: 'Nonexistent unobtainium', outcome: 'failed', code: 'no_candidates' }),
      obs({ item: 'Ambiguous thing', outcome: 'review', code: 'match_rejected' }),
    ]);
    expect(r.passed).toBe(true);
    expect(r.lines.every((l) => l.status === 'as_predicted')).toBe(true);
  });

  it('FAILS a run where everything succeeded', () => {
    // The trap this whole design exists for. Three of four lines "worked",
    // which a success-rate scorer would call a great night.
    const r = scoreCanaryRun(plan, [
      obs({ item: 'Whole milk' }),
      obs({ item: 'Bananas', outcome: 'added_by_weight' }),
      obs({ item: 'Nonexistent unobtainium' }),
      obs({ item: 'Ambiguous thing' }),
    ]);
    expect(r.passed).toBe(false);
    const surprises = r.lines.filter((l) => l.status === 'unexpected_success');
    expect(surprises.map((s) => s.item)).toEqual(['Nonexistent unobtainium', 'Ambiguous thing']);
  });

  it('treats a line the run never mentioned as a failure, not an absence', () => {
    const r = scoreCanaryRun(plan, [
      obs({ item: 'Whole milk' }),
      obs({ item: 'Bananas', outcome: 'added_by_weight' }),
      obs({ item: 'Nonexistent unobtainium', outcome: 'failed', code: 'no_candidates' }),
      // 'Ambiguous thing' silently dropped
    ]);
    expect(r.passed).toBe(false);
    expect(r.lines.find((l) => l.item === 'Ambiguous thing')!.status).toBe('missing');
  });

  it('only compares a code when the plan named one', () => {
    // 'Ambiguous thing' expects review with NO code, so any review code passes.
    // An expectation table that demanded a precise code everywhere would go red
    // whenever a store reworded something, and a canary that cries wolf is muted.
    const r = scoreCanaryRun(plan, [
      obs({ item: 'Whole milk' }),
      obs({ item: 'Bananas', outcome: 'added_by_weight' }),
      obs({ item: 'Nonexistent unobtainium', outcome: 'failed', code: 'no_candidates' }),
      obs({ item: 'Ambiguous thing', outcome: 'review', code: 'anything_at_all' }),
    ]);
    expect(r.passed).toBe(true);
  });

  it('holds a named code to the letter', () => {
    const r = scoreCanaryRun(plan, [
      obs({ item: 'Whole milk' }),
      obs({ item: 'Bananas', outcome: 'added_by_weight' }),
      obs({ item: 'Nonexistent unobtainium', outcome: 'failed', code: 'out_of_stock' }),
      obs({ item: 'Ambiguous thing', outcome: 'review' }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.lines.find((l) => l.item.startsWith('Nonexistent'))!.status).toBe('mismatch');
  });

  it('reports lines the run added that the plan never mentioned', () => {
    const r = scoreCanaryRun(plan, [
      obs({ item: 'Whole milk' }),
      obs({ item: 'Bananas', outcome: 'added_by_weight' }),
      obs({ item: 'Nonexistent unobtainium', outcome: 'failed', code: 'no_candidates' }),
      obs({ item: 'Ambiguous thing', outcome: 'review' }),
      obs({ item: 'Something nobody asked for' }),
    ]);
    expect(r.unplanned).toEqual(['Something nobody asked for']);
    expect(r.passed).toBe(false);
  });
});

describe('scoreRepeatRun', () => {
  it('expects the cart to DOUBLE, because adds land on top', () => {
    const r = scoreRepeatRun(6, 12, 6);
    expect(r.passed).toBe(true);
  });

  it('fails an idempotent second run and says why that is not good news', () => {
    // Decided 2026-09-01. A canary written to expect idempotency would go red on
    // correct behaviour and green if someone made adds idempotent by accident.
    const r = scoreRepeatRun(6, 6, 6);
    expect(r.passed).toBe(false);
    expect(r.note).toMatch(/IDEMPOTENCY/);
    expect(r.note).toMatch(/regression, not a relief/);
  });
});

describe('isRigProblem', () => {
  it('calls device trouble a rig problem, never a store failure', () => {
    // An unplugged night that reads as a red store trains everyone to ignore
    // the colour, which costs more than the missed run.
    for (const r of ['device_offline', 'device_locked', 'app_not_installed', 'not_signed_in'] as const) {
      expect(`${r}: ${isRigProblem(r)}`).toBe(`${r}: true`);
    }
  });

  it('does NOT excuse a failed cleanup', () => {
    // A canary that leaves state behind poisons its own next run. It is a real
    // failure -- it just is not evidence about the store.
    expect(isRigProblem('cleanup_failed')).toBe(false);
  });
});

describe('building a plan from what an admin typed', () => {
  const { buildPlanFromConfig, planCoverage, UNIVERSAL_LINES } =
    require('../../src/lib/canary-expectations');

  it('gives every store the three lines that need no curation', () => {
    const p = buildPlanFromConfig({ storeId: 'heb', mealName: 'Canary' });
    expect(p.items.map((i: any) => i.item)).toEqual([
      UNIVERSAL_LINES.added, UNIVERSAL_LINES.byWeight, UNIVERSAL_LINES.noCandidates,
    ]);
  });

  it('SKIPS the curated branches when the boxes are empty', () => {
    // A canary that demands curation before it runs at all does not run. Three
    // covered branches beat five that never execute.
    const p = buildPlanFromConfig({ storeId: 'heb', mealName: 'Canary' });
    expect(p.items).toHaveLength(3);
    expect(planCoverage(p).skipped).toEqual(['out of stock', 'no good match']);
  });

  it('adds the out-of-stock line once someone curates it', () => {
    const p = buildPlanFromConfig({
      storeId: 'heb', mealName: 'Canary', outOfStockItem: 'Some discontinued thing',
    });
    const line = p.items.find((i: any) => i.item === 'Some discontinued thing');
    expect(line.expect).toEqual({ outcome: 'failed', code: 'out_of_stock' });
    expect(planCoverage(p).skipped).toEqual(['no good match']);
  });

  it('adds the no-good-match line, and does not demand a code for it', () => {
    // Stores word this differently and the canary must not go red when one
    // rewords it. The expectation is "ends at review", full stop.
    const p = buildPlanFromConfig({
      storeId: 'heb', mealName: 'Canary', unmatchedItem: 'Ambiguous thing',
    });
    const line = p.items.find((i: any) => i.item === 'Ambiguous thing');
    expect(line.expect).toEqual({ outcome: 'review' });
  });

  it('treats whitespace as empty, because a text box collects it', () => {
    const p = buildPlanFromConfig({
      storeId: 'heb', mealName: 'Canary', outOfStockItem: '   ', unmatchedItem: '\n',
    });
    expect(p.items).toHaveLength(3);
  });

  it('scores a skipped-branch plan without inventing the missing lines', () => {
    // The run only reports what the plan asked for, so a store with empty boxes
    // passes on three lines rather than failing on two it never ran.
    const p = buildPlanFromConfig({ storeId: 'heb', mealName: 'Canary' });
    const r = scoreCanaryRun(p, [
      { item: UNIVERSAL_LINES.added, outcome: 'added' },
      { item: UNIVERSAL_LINES.byWeight, outcome: 'added_by_weight' },
      { item: UNIVERSAL_LINES.noCandidates, outcome: 'failed', code: 'no_candidates' },
    ]);
    expect(r.passed).toBe(true);
  });
});
