// MEAL-7. Scoring a canary run against what it was PREDICTED to do.
//
// The canary meal contains items that are supposed to fail: one that cannot be
// found, one that finds candidates but none good enough, one that is out of
// stock. So the run cannot be scored by success rate -- a 60% run may be a
// perfect pass and a 100% run may mean a store started matching something it
// should have refused.
//
// Each line is scored against an expected terminal step and failure code, and
// the run passes when every line lands where it was predicted to. A line that
// unexpectedly SUCCEEDS is a finding, not a bonus.

/** What a single curated item is expected to do. */
export interface CanaryExpectation {
  /** The ingredient as written in the canary meal. */
  item: string;
  /** Why this line is in the meal: which branch of the engine it walks. */
  why: string;
  /** Where the line is expected to end. */
  expect:
    | { outcome: 'added' }
    /** Found, but sold by weight: confirmed by presence, never by quantity. */
    | { outcome: 'added_by_weight' }
    | { outcome: 'review'; code?: string }
    | { outcome: 'failed'; code: string };
}

export interface CanaryStorePlan {
  storeId: string;
  /** The saved meal this plan drives. Curated data, expected to need upkeep. */
  mealName: string;
  items: CanaryExpectation[];
}

/** What actually happened to one line, read off the run. */
export interface CanaryObservation {
  item: string;
  outcome: 'added' | 'added_by_weight' | 'review' | 'failed';
  code?: string | null;
}

export type LineVerdict =
  | { item: string; status: 'as_predicted'; expected: string; actual: string }
  /** Landed somewhere else. The ordinary failure. */
  | { item: string; status: 'mismatch'; expected: string; actual: string; why: string }
  /** Was predicted to fail and did not. A finding in its own right. */
  | { item: string; status: 'unexpected_success'; expected: string; actual: string; why: string }
  /** The run never reported this line at all. */
  | { item: string; status: 'missing'; expected: string; actual: 'not reported'; why: string };

export interface CanaryResult {
  storeId: string;
  /** True only when every line landed where it was predicted to. */
  passed: boolean;
  lines: LineVerdict[];
  /** Lines the run reported that the plan does not mention. */
  unplanned: string[];
}

function describe(e: CanaryExpectation['expect']): string {
  if (e.outcome === 'failed') return `failed:${e.code}`;
  if (e.outcome === 'review') return e.code ? `review:${e.code}` : 'review';
  return e.outcome;
}

function describeObserved(o: CanaryObservation): string {
  if (o.outcome === 'failed' || o.outcome === 'review') {
    return o.code ? `${o.outcome}:${o.code}` : o.outcome;
  }
  return o.outcome;
}

/**
 * Compare a run against its plan.
 *
 * A code is only compared when the plan NAMES one. "ends at review" is a
 * weaker claim than "ends at review with no_candidates", and the plan is
 * allowed to make either -- an expectation table that forces a precise code for
 * every line would break every time a store reworded something, and a canary
 * that cries wolf gets muted.
 */
export function scoreCanaryRun(
  plan: CanaryStorePlan,
  observations: CanaryObservation[],
): CanaryResult {
  const seen = new Map(observations.map((o) => [o.item.toLowerCase(), o]));
  const lines: LineVerdict[] = [];

  for (const exp of plan.items) {
    const expected = describe(exp.expect);
    const got = seen.get(exp.item.toLowerCase());
    if (!got) {
      lines.push({
        item: exp.item, status: 'missing', expected, actual: 'not reported',
        why: 'The run never reported this line. A silent drop is worse than a '
           + 'predicted failure, because nothing in the funnel counts it.',
      });
      continue;
    }
    const actual = describeObserved(got);
    const landedWhereExpected = got.outcome === exp.expect.outcome
      && (!('code' in exp.expect && exp.expect.code) || got.code === exp.expect.code);

    if (landedWhereExpected) {
      lines.push({ item: exp.item, status: 'as_predicted', expected, actual });
      continue;
    }
    // Predicted to fail or need review, and it sailed through instead.
    const wasPredictedToNotAdd = exp.expect.outcome === 'failed' || exp.expect.outcome === 'review';
    const didAdd = got.outcome === 'added' || got.outcome === 'added_by_weight';
    if (wasPredictedToNotAdd && didAdd) {
      lines.push({
        item: exp.item, status: 'unexpected_success', expected, actual,
        why: 'This line exists to prove the engine REFUSES something. It added '
           + 'instead, which means either the store relisted it (curation) or '
           + 'the refusal stopped working (a bug). Both need a human.',
      });
      continue;
    }
    lines.push({
      item: exp.item, status: 'mismatch', expected, actual,
      why: 'Landed somewhere other than predicted.',
    });
  }

  const planned = new Set(plan.items.map((i) => i.item.toLowerCase()));
  const unplanned = observations
    .filter((o) => !planned.has(o.item.toLowerCase()))
    .map((o) => o.item);

  return {
    storeId: plan.storeId,
    passed: lines.every((l) => l.status === 'as_predicted') && unplanned.length === 0,
    lines,
    unplanned,
  };
}

/**
 * The repeat run: quantities ADD ON TOP.
 *
 * Decided 2026-09-01 and deliberately not idempotent -- re-running the same
 * meals doubles the cart. The canary asserts the doubling, because a canary
 * written to expect idempotency would go red on correct behaviour and, worse,
 * would go green if someone made adds idempotent by accident.
 */
export function scoreRepeatRun(
  firstCartCount: number,
  secondCartCount: number,
  addedPerRun: number,
): { passed: boolean; expected: number; actual: number; note: string } {
  const expected = firstCartCount + addedPerRun;
  return {
    passed: secondCartCount === expected,
    expected,
    actual: secondCartCount,
    note: secondCartCount === firstCartCount
      ? 'The cart did not grow. That is IDEMPOTENCY, which this project decided '
      + 'against on 2026-09-01 -- so it is a regression, not a relief.'
      : 'Adds land on top of what is already there, as designed.',
  };
}

/**
 * Why a canary produced no result.
 *
 * Device unavailability must never be reported as a store failure. An unplugged
 * night that reads as a red store trains everyone to ignore the colour, which
 * costs more than the missed run.
 */
export type CanarySkipReason =
  | 'device_offline'
  | 'device_locked'
  | 'app_not_installed'
  | 'not_signed_in'
  | 'cleanup_failed';

export interface CanaryDidNotRun {
  ran: false;
  storeId: string;
  reason: CanarySkipReason;
  detail: string;
}

/** True when the reason is about the RIG, not about the store. */
export function isRigProblem(reason: CanarySkipReason): boolean {
  // cleanup_failed is deliberately NOT here. A canary that leaves state behind
  // poisons its own next run, so it is a canary FAILURE that needs attention --
  // it is just not evidence about the store's automation.
  return reason === 'device_offline'
    || reason === 'device_locked'
    || reason === 'app_not_installed'
    || reason === 'not_signed_in';
}

// ── Building a plan from what an admin typed ────────────────────────────────
//
// The two hardest lines to curate are the ones that must FAIL: an item the store
// genuinely has out of stock, and one that returns candidates none of which
// should match. Both are store-specific and both go stale as shelves change, so
// they are not code -- they are two text boxes per store in the admin panel.
//
// AN EMPTY BOX SKIPS THAT BRANCH. That is the whole point of the design: a
// canary that demands curation before it runs at all does not run, and a canary
// that invents a plausible-looking out-of-stock item tests nothing while
// reporting confidently.

/** What an admin typed for one store. Either field may be blank. */
export interface CanaryStoreConfig {
  storeId: string;
  mealName: string;
  /** An item this store genuinely does not have in stock. */
  outOfStockItem?: string | null;
  /** An item that returns candidates, none of which should be good enough. */
  unmatchedItem?: string | null;
}

/**
 * The lines every store gets, regardless of curation.
 *
 * `alwaysAdded` and `alwaysWeight` are deliberately generic: milk and bananas
 * exist at every grocer in the catalogue, and a canary line that needs curating
 * to work at all belongs in the two boxes rather than here.
 */
export const UNIVERSAL_LINES = {
  added: 'Whole milk',
  byWeight: 'Bananas',
  /** Nothing on earth matches this, so it needs no curation and never goes stale. */
  noCandidates: 'Nonexistent unobtainium 9000',
} as const;

/** One saved-meal ingredient, as the plan needs to see it. */
export interface CanaryMealLine {
  ingredientName: string;
  /** The chosen product's NAME. Null means the app sends this line to the chooser. */
  searchTerm?: string | null;
  unit?: string | null;
  /**
   * The chosen product's IDENTITY, per store, as the chooser saved it.
   *
   * THIS WINS over searchTerm, because the add path uses it and skips the
   * matcher entirely -- "the identifier IS the choice". An ingredient can carry
   * both, and they can disagree: editing a meal's searchTerm in the database
   * without touching storeProducts leaves the run adding the OLD product while
   * every name in the plan says the new one. That looked like the app ignoring
   * a chosen product; it was two fields describing one choice, and only one of
   * them edited.
   */
  storeProducts?: Record<string, { name?: string | null }> | null;
}

/**
 * Build the expectation table from the CANARY MEAL ITSELF.
 *
 * The meal is the only description of what a canary run does, now that the admin
 * item boxes are gone -- Stephen curates the out-of-stock and no-match lines by
 * adding them to the saved meal.
 *
 * KEYED ON THE CHOSEN PRODUCT, not the ingredient name. A run reports what it
 * put in the cart, which is the product ("Borden Whole Milk, 1 gal"); the plan
 * used to name the ingredient ("Whole milk") and every line scored as "never
 * reported". Four silent drops and four unplanned lines, describing the same
 * four items twice.
 *
 * The expectation follows from the line:
 *   - a product that cannot exist  -> no candidates
 *   - a line sold by weight        -> confirmed by presence, never by quantity
 *   - anything else                -> added
 */
export function buildPlanFromMeal(
  storeId: string,
  mealName: string,
  lines: CanaryMealLine[],
): CanaryStorePlan {
  const items: CanaryExpectation[] = [];
  for (const line of lines) {
    // THE STORED PRODUCT FIRST. It is what the run will actually add, and the
    // name it will report; searchTerm is only what the chooser searched for.
    const stored = line.storeProducts?.[storeId]?.name;
    const term = (stored || line.searchTerm || '').trim();
    if (!term) {
      // No chosen product: the app sends this to the chooser rather than adding
      // it, so a run does not report it at all and the plan must not expect it.
      continue;
    }
    const unfindable = /unobtainium|thereshouldnotbe/i.test(term)
      || /unobtainium|thereshouldnotbe/i.test(line.ingredientName ?? '');
    if (unfindable) {
      items.push({
        item: term,
        // REVIEW, AND NO CODE. Measured against all five stores:
        //
        //   Walmart, H-E-B   search returns nothing        -> no_candidates
        //   Wegmans, ALDI,   search returns junk the       -> match_rejected
        //   Tom Thumb        matcher refuses
        //
        // Both are the same property and both are correct -- the run ASKED
        // rather than guessed. Which one a store produces is a fact about its
        // search, not about the app, and pinning either scored three stores red
        // for behaving properly. The scorer compares a code only when the plan
        // names one, so leaving it out is the way to say "either".
        //
        // 'failed' was wrong for the same reason and worse: no store answers it.
        // A line with nothing to match is handed to the USER, and the run parks
        // on "could not be added to cart" naming the item and why.
        why: 'nothing should match: the run must ask rather than guess',
        expect: { outcome: 'review' },
      });
      continue;
    }
    // ADDED, and the plan does NOT try to predict sold-by-weight.
    //
    // Weight is a property the STORE assigns to a product, and no amount of
    // reading the name gets at it. Two attempts failed on real runs:
    //
    //   the recipe's unit   a line measured in lb whose chosen product is a
    //                       6 oz packet is an ordinary count item
    //   "per lb" in the name ALDI's "Bananas, per lb, per lb" reports plain
    //                       `added`; the label is decoration, not a price mode
    //
    // Both predicted added_by_weight and failed a correct run, which is the one
    // thing an expectation table must never do -- a canary that cries wolf gets
    // ignored, and then it is worth less than nothing.
    //
    // THE COST: the sold-by-weight branch the ticket asks for is NOT asserted by
    // this plan. Getting it needs a genuinely weight-priced product chosen
    // through the app (H-E-B's deli counter is the obvious one), so that the
    // stored product itself carries the weight semantics -- not a guess made
    // from its name.
    items.push({
      item: term,
      why: 'plain in-stock item: should match and confirm',
      expect: { outcome: 'added' },
    });
  }
  return { storeId, mealName, items };
}

export function buildPlanFromConfig(cfg: CanaryStoreConfig): CanaryStorePlan {
  const items: CanaryExpectation[] = [
    {
      item: UNIVERSAL_LINES.added,
      why: 'plain in-stock item: should match and confirm',
      expect: { outcome: 'added' },
    },
    {
      item: UNIVERSAL_LINES.byWeight,
      why: 'sold by weight: confirmed by presence, never by quantity',
      expect: { outcome: 'added_by_weight' },
    },
    {
      item: UNIVERSAL_LINES.noCandidates,
      why: 'nothing should match: proves the search reports empty rather than guessing',
      expect: { outcome: 'failed', code: 'no_candidates' },
    },
  ];

  // Curated, and only if someone curated it. A blank box is a branch we are
  // honestly not testing, which is better than a branch we are pretending to.
  const oos = (cfg.outOfStockItem ?? '').trim();
  if (oos) {
    items.push({
      item: oos,
      why: 'out of stock: proves out_of_stock is not laundered into a match failure',
      expect: { outcome: 'failed', code: 'out_of_stock' },
    });
  }
  const unmatched = (cfg.unmatchedItem ?? '').trim();
  if (unmatched) {
    items.push({
      item: unmatched,
      why: 'candidates, none good enough: proves the scorer refuses rather than settles',
      expect: { outcome: 'review' },
    });
  }

  return { storeId: cfg.storeId, mealName: cfg.mealName, items };
}

/** Which branches this store is actually covering, for the panel to show. */
export function planCoverage(plan: CanaryStorePlan): {
  covered: string[]; skipped: string[];
} {
  const has = (o: string) => plan.items.some((i) => i.expect.outcome === o
    || ('code' in i.expect && i.expect.code === o));
  const covered: string[] = [];
  const skipped: string[] = [];
  (has('out_of_stock') ? covered : skipped).push('out of stock');
  (has('review') ? covered : skipped).push('no good match');
  covered.push('adds', 'by weight', 'not found');
  return { covered, skipped };
}
