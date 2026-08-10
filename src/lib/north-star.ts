// The north-star metric: did the user get their groceries? (MEAL-3)
//
// "The automation ran" and "the user got their groceries" are different numbers,
// and only the second one is worth steering by. This module is the single home
// for the second one, so the client that emits it and the dashboard that reads it
// cannot drift into two different definitions of the same word.
//
// Two rates, from the same two counts:
//
//   itemSuccessRate = confirmed / requested          (per store, per day)
//   runSuccessRate  = runs where confirmed === requested / runs
//
// The run rate is the one the user actually lives in, and it is much lower than
// the item rate on purpose: a 90% item rate over an 8-item meal is a 0.9^8 = 43%
// chance of a clean run. The GAP between the two is the point of the metric — it
// is the argument for per-item confirmation over badge-count inference, and it is
// invisible unless both numbers are shown side by side.
//
// ── What "requested" means ────────────────────────────────────────────────────
//
// One line of the run's active item set, at the moment the add phase started.
// Items, not units: a line asked for ×2 and given ×1 is ONE unconfirmed item, not
// a half. That keeps the denominator the same shape as the thing the user
// experiences ("did I get the sour cream") rather than a units-weighted average
// that a single bulk line can dominate.
//
// IN the denominator:
//   • every checked, non-zero line the run set out to add — including ones that
//     later turned out to be out of stock, returned no results, or that the user
//     skipped in review. All three mean the user did not get that ingredient.
//     Whose FAULT that is belongs on the failure-code chart (see
//     STEP_FAILURE_CODES); the north-star only asks whether it landed.
//   • sold-by-weight lines, at 1 each — see below.
//
// OUT of the denominator:
//   • lines excluded at the qty step: box unchecked, or quantity stepped to zero
//     (isZeroedOut). Never requested, so never a miss.
//   • every line of a Choose Products run. That run adds NOTHING to a cart by
//     design — it saves which product to buy next time — so scoring it against a
//     cart would report a permanent 0% for a flow that worked perfectly. Those
//     runs are excluded WHOLE, by `kind: 'choose'`, not zeroed item by item.
//
// A skipped-in-review item staying in the denominator is the one debatable call,
// and it is deliberately the conservative one: review is only ever reached
// because the automation failed to match the item on its own, so a skip is a user
// giving up on our miss more often than it is a change of mind. We cannot tell
// the two apart, so the number takes the reading that never flatters us, and
// `skippedInReview` ships alongside so the read side can compute the other one.
//
// ── What a weight item contributes ───────────────────────────────────────────
//
// 1 to the denominator and 1 to the numerator, confirmed by PRESENCE.
//
// The rule is isWeightPriced() in cart-reconcile.ts — imported, never restated
// (MEAL-62 consolidated it precisely so this ticket would not fork it). A
// weight-priced line reaches the cart as one row at N lb, and the add rounds to a
// weight the store actually sells, so the cart weight almost never equals the
// requested one. Any numeric comparison would report a shortfall on nearly every
// run. So one matching weight row confirms the line whatever poundage it shows.
//
// This is a REAL weakening of the metric and must be visible, not buried: a
// weight item is confirmed as "something by that name is in the cart", not as
// "the right amount is in the cart". `weightRequested` ships on every run so the
// dashboard can say how much of a store's rate rests on presence — HEB Deli /
// Fish Market / bulk lines are the only source of them today.
//
// ── What "confirmed" means, and how much to trust it ─────────────────────────
//
// Confirmed = the line's full requested quantity is accounted for in the CART,
// as of the last cart read the run managed. Not "a worker said it clicked" and
// NOT "a `confirm` step row exists".
//
// That last exclusion was originally written because four of six stores emitted
// no per-item add_click/confirm rows for their parallel add pass, so counting
// confirm rows would have made the busiest stores look empty rather than
// successful. MEAL-122 closed that: the two worker pools now emit a row per item,
// so the rows are there on every store.
//
// The exclusion stands anyway, on the reason that was always the stronger one. A
// `confirm` row records what the RUN could observe at the moment it clicked —
// a cart badge, a per-card label, at best a cart query for one item — and those
// are known to be wrong in both directions under concurrency (see MEAL-47, and
// finishParallelAdd's note that a worker can falsely confirm against a shared
// counter). The cart read is ground truth and the confirm row is evidence toward
// it. Counting rows would be counting the guess, on every store, however many of
// them now emit one.
//
// Every run therefore ships `confirmedSource`, and the dashboard renders a rate
// only where the source supports one:
//
//   'cart_reconcile'  the count came from a before/after per-item cart diff
//                     (reconcileParallelAdd). Ground truth.
//   'worker_reports'  the count is the store scripts' own success flags, which
//                     are known to be wrong in both directions (MEAL-47). Usable
//                     only once the after-probe correction row lands on top.
//   'none'            no cart adds in this run (a Choose Products run).
//
// ── What the read side must do (spec for mealio_central, MEAL-2's dashboard) ──
//
// Emitted here, read there. Extend MEAL-2's existing per-store daily view; do
// not build a second surface.
//
// WHAT ARRIVES
//
//   1. `automation_runs`, via POST /api/usage/automation phase 'complete'.
//      Carries store_id (set at phase 'start'), items_requested (NEW — the field
//      was already in the client contract and never populated until MEAL-3),
//      items_added, outcome. Verify the ingest actually persists items_requested;
//      if it drops it, both rates lose their cheap read path.
//      → Both rates are computable from this table alone, per store, per day, no
//        join. This is the intended primary read.
//
//   2. `run_summary` step row (one per run), detail JSON:
//        kind             'add' | 'choose'
//        requested        the denominator (same value as items_requested)
//        itemsAdded       the numerator, UNCORRECTED (see 3)
//        runComplete      the run-rate numerator
//        confirmedSource  'cart_reconcile' | 'worker_reports' | 'none'
//        weightRequested  of `requested`, how many are presence-confirmed
//        skippedInReview  lines the user skipped (INSIDE `requested` — see above)
//        weightRowUnverified  weight lines the run could not verify by presence.
//                         Counted apart from skips (which pass over an item nobody
//                         has) and from itemsAdded. Whether it belongs in the
//                         denominator is still open — see the checklist item on the
//                         item-success rate.
//        failureCodes     every code this run recorded, counted, most frequent
//                         first: "confirm_failed:3,waf_block:1". A STRING, not an
//                         object — sanitizeDetail drops nested values. Present only
//                         when the run ended in failure. The row's own `code` is
//                         the most EXPLANATORY of these, not the most frequent
//                         (see FAILURE_CODE_SEVERITY), so read this when you want
//                         the distribution rather than the headline.
//        outcome, cartDeltaWarning, codeSource  (pre-existing)
//
//      `outcome` gained a fourth value in MEAL-190: 'unverified', the run that
//      finished without reading the cart at all — the probe never answered, or it
//      answered that it could not prove the page was the cart. Read it as the
//      COVERAGE flag it is: on such a run `itemsAdded` is the run's own report of
//      itself with nothing able to contradict it, since the cart diff is the only
//      check that has ever disagreed with a run. It is not 'partial' (that means
//      the cart was read and disagreed) and it is not a failure — the adds may
//      well all have landed. Whole stores can sit in this state when their cart
//      URL redirects, so a rate drawn without splitting it out attributes one
//      store's redirect to the automation.
//
//      `cartDeltaWarning` no longer covers that case: it now means only "the cart
//      was read and something was off". A run with outcome 'unverified' and
//      cartDeltaWarning false is the state where nothing checked the run, which
//      before MEAL-190 was recorded as an ordinary success.
//      → This is where the trust qualifiers live. Join to the run for store_id.
//
//      ABANDONED RUNS (MEAL-5) also ship a `run_summary`, and it is a DIFFERENT
//      row: outcome 'skipped', and a detail of
//        terminal      'abandoned'  — present only on these
//        abandonedAt   the step the run stopped on ('qty', 'login',
//                      'robot_challenge', 'adding', …)
//        kind, requested, itemsAdded, runComplete (always false)
//      A run that never reached the done screen — the user closed the sheet, a
//      sign-out ended the job, a store wedged until they gave up — emitted no
//      terminal row at all before this. It still had an `automation_runs` row, so
//      the funnel was a strict subset of the runs and the missing ones were
//      disproportionately the bad ones. Filter `terminal = 'abandoned'` OUT of
//      both rates (they have no cart outcome to score) and chart the count beside
//      them: it is the completeness check, and a rate drawn without it is drawn
//      over runs that chose to finish.
//      They carry no failure `code` by construction, so they cannot move the code
//      distribution or the `failureCodes` tally.
//
//   3. `reconcile` step row with detail.phase === 'north_star', at most one per
//      run, present only when an after-run cart probe returned per-item rows:
//        requested, summaryConfirmed, confirmed, runComplete, overstated,
//        recovered, recoveredLoose, confirmedSource: 'cart_after_probe'
//      → The correction. `confirmed` here SUPERSEDES the run's items_added.
//
//      Two other `reconcile` rows exist and must not be mistaken for it — filter
//      on `phase`: 'parallel' (the mid-run cart reconcile) and 'after' (MEAL-47's
//      recovery warning). Rows with no `phase` key are pre-MEAL-3 history.
//
// HOW TO COMPUTE, per store per day
//
//   confirmed(run) = coalesce(north_star.confirmed, run.items_added)
//   requested(run) = run.items_requested
//
//   itemSuccessRate = Σ confirmed / Σ requested      over runs with requested > 0
//   runSuccessRate  = count(confirmed >= requested) / count(*)
//                                                    over runs with requested > 0
//
//   `requested > 0` is the whole of the choose-run exclusion: a choose run
//   reports requested 0 and must appear in NEITHER numerator nor denominator of
//   either rate. Do not special-case `kind` beyond that.
//
//   Do NOT reuse the existing `outcome` column for any of this. A choose run adds
//   nothing, so it has always been recorded as outcome 'failed' — one of the ways
//   today's numbers mislead, and the reason the run rate needs `runComplete`
//   rather than `outcome = 'success'`. `outcome` also calls a 1-of-8 run
//   'success', which is precisely the gap this ticket is about.
//
//   SHOW THE GAP. The two rates on one axis with the space between them shaded is
//   the deliverable, not two numbers in separate tiles. The gap widens with basket
//   size, so also show median `requested` per store — otherwise a store with big
//   baskets looks worse at automation when it is only worse at arithmetic.
//
// HONESTY RULES — these are the acceptance criteria, not polish
//
//   a. A store-day whose runs are majority `confirmedSource: 'worker_reports'`
//      WITH no north_star correction row has no cart-backed numerator. Render it
//      as MEAL-2 renders partialInstrumentation — coverage warning, no figure.
//      Do not fall back to items_added and label it an estimate; that is the
//      badge-count inference this metric replaces.
//      The source mix is only observable on the SAMPLED step rows, so it is an
//      estimate of the unsampled population — fine, since sampling is per run and
//      unbiased, but the coverage warning should be driven by a share (e.g. under
//      70% cart-backed) rather than by an exact count.
//   b. Draw the corrected number as a BAND, not a point, whenever recoveredLoose
//      > 0: lower bound (confirmed − recoveredLoose), upper bound (confirmed). A
//      loose recovery cannot tell "the failed item landed" from "an unintended
//      product landed" (MEAL-47), and it is the correction most likely to flip a
//      run complete — exactly where a false point estimate does most damage.
//   c. Surface `weightRequested / requested` per store. Where it is material,
//      say on the chart that those items are confirmed by presence, not amount.
//      HEB is the only store with any today.
//   d. A store-day with too few runs to mean anything shows the count, not a
//      percentage. Reuse whatever threshold MEAL-2's `uncoded` bucket uses.
//   e. Telemetry is SAMPLED (telemetry.sampleRate) while `automation_runs` is
//      not. Never mix a rate computed off step rows with one off run rows in the
//      same series — the correction from (3) is only present for sampled runs, so
//      report the corrected rate over the sampled subset and say so.

import { RecoveredAdd, WeightPricedFields, isWeightPriced } from './cart-reconcile';

/** How much the run's confirmed count can be trusted — see the header. */
export type ConfirmedSource = 'cart_reconcile' | 'worker_reports' | 'none';

/** Whether a run shops (adds to a cart) or only saves product choices. A
 *  'choose' run has no cart outcome, so it is excluded from both rates rather
 *  than scored as a zero. */
export type RunKind = 'add' | 'choose';

export interface RequestedCount {
  /** The denominator: lines the run set out to add. */
  requested: number;
  /** How many of those are sold-by-weight, i.e. confirmed by presence rather
   *  than by unit count. A qualifier on the rate, never a subtraction from it. */
  weightRequested: number;
}

/**
 * Count the denominator off the run's active item set.
 *
 * Call this ONCE, with the set committed when the add phase starts — before the
 * parallel reconcile's top-up narrows activeItemsRef to the retry subset, which
 * would otherwise shrink the denominator to the items that went wrong and turn a
 * bad run into a perfect one.
 */
export function countRequested<T extends WeightPricedFields>(
  items: readonly T[],
): RequestedCount {
  let weightRequested = 0;
  for (const item of items) if (isWeightPriced(item)) weightRequested++;
  return { requested: items.length, weightRequested };
}

/**
 * The run-rate numerator: did EVERY requested item land?
 *
 * Zero requested is not a complete run, it is no run — a Choose Products run
 * would otherwise count as a win on a cart it never touched. `>=` rather than
 * `===` so a confirmed count that somehow overshoots (a cart row claimed by two
 * lines with near-identical names) reads as complete instead of as impossible.
 */
export function isRunComplete(requested: number, confirmed: number): boolean {
  return requested > 0 && confirmed >= requested;
}

/** The cart-backed correction to a worker-reported confirmed count. */
export interface CartCorrection {
  /** Confirmed, as the cart has it. Clamped to 0..requested. */
  confirmed: number;
  /** Reported-added lines the cart could not corroborate (missing + short) —
   *  the direction that makes the uncorrected number too HIGH. */
  overstated: number;
  /** Reported-failed lines the cart says landed anyway (MEAL-47) — the direction
   *  that makes the uncorrected number too low. */
  recovered: number;
  /**
   * Of `recovered`, how many were claimed by a LOOSE name match.
   *
   * MEAL-47's own caveat: names alone cannot separate "the failed item landed"
   * from "an unintended product landed", so a loose recovery might be crediting
   * us with a cart row the user did not want. An exact-name recovery is not
   * subject to that doubt. Splitting them is what turns "slightly noisy" into a
   * band the dashboard can actually draw: subtract these and the corrected
   * number becomes a lower bound.
   */
  recoveredLoose: number;
  /** isRunComplete against the corrected count. */
  runComplete: boolean;
}

/**
 * Recompute confirmed from the after-run cart audit.
 *
 * This exists because of an ordering fact that cannot be fixed by reordering:
 * the after-probe costs a real page load on a store that is watching for
 * automation, and it returns AFTER the run has finished and its terminal
 * run_summary row has already shipped. Holding run_summary back until the probe
 * answers would trade a slightly wrong number for a frequently ABSENT one — the
 * terminal row is the one most likely to survive a dropped batch, and a probe
 * that hangs would take the whole run out of the funnel.
 *
 * So the run ships its uncorrected count and then, if the probe finds anything,
 * a second row carrying this. The read side coalesces (see the emission site in
 * WebViewCartSheet); neither row is rewritten.
 *
 * `missing` and `short` are disjoint by construction — auditCartAfterRun
 * excludes anything already in `missing` from the short audit — so adding them
 * cannot double-subtract one line.
 */
export function correctConfirmedFromCart(input: {
  requested: number;
  /** What run_summary already shipped as itemsAdded. */
  summaryConfirmed: number;
  /** auditCartAfterRun's `missing`.length. */
  missing: number;
  /** auditCartAfterRun's `short`.length. */
  short: number;
  /** auditCartAfterRun's `recovered`. */
  recovered: readonly RecoveredAdd[];
}): CartCorrection {
  const { requested, summaryConfirmed, missing, short } = input;
  const overstated = missing + short;
  const recovered = input.recovered.length;
  const recoveredLoose = input.recovered.filter((r) => r.matchQuality === 'loose').length;
  // Clamped both ends: the inputs come from three different name-matching passes
  // over one cart, and a metric that can read 9-of-8 or -1-of-8 is a metric
  // nobody believes the rest of.
  const confirmed = Math.max(0, Math.min(requested, summaryConfirmed - overstated + recovered));
  return {
    confirmed,
    overstated,
    recovered,
    recoveredLoose,
    runComplete: isRunComplete(requested, confirmed),
  };
}

/**
 * The facts a finished run reports on its own `run_summary` row: every field of the
 * detail JSON documented in the header block above, except `codeSource` and
 * `failureCodes`, which describe how the row's failure code was chosen rather than
 * what the run did. Keep the two lists in step — a fact here and not up there is a
 * field the dashboard receives and has no definition for.
 *
 * A named type rather than an inline literal because the row sits at exactly
 * sanitizeDetail's key cap. Adding a field here is a schema change with a
 * consequence, and the detail-cap test in tests/unit/northStar.test.ts is what
 * tells you so.
 */
export interface RunSummaryFacts {
  /**
   * 'unverified' (MEAL-190) is the run that finished without reading the cart. It
   * is a value on this field rather than a fact of its own deliberately: the
   * detail sits at sanitizeDetail's key cap exactly (see below), so a new KEY here
   * would silently drop `failureCodes` off every failing row. A new value on a key
   * that already exists costs nothing.
   */
  outcome: 'success' | 'partial' | 'unverified' | 'failed';
  itemsAdded: number;
  cartDeltaWarning: boolean;
  kind: RunKind;
  requested: number;
  confirmedSource: ConfirmedSource;
  weightRequested: number;
  skippedInReview: number;
  runComplete: boolean;
  weightRowUnverified: number;
}

/** The detail for a run that finished without failing. */
export function runSummaryDetail(facts: RunSummaryFacts): Record<string, unknown> {
  return { ...facts };
}

/**
 * The detail for a failed run: the same facts, plus which rule chose the row's
 * code and the full tally of codes behind it.
 *
 * This is a function, and not the object literal it used to be at the call site,
 * because of how the two extra fields can be lost. `failureCodes` was first
 * written as a nested Record and sanitizeDetail dropped it in silence — the row
 * shipped claiming a tally it did not carry. It is a flat string now, but the
 * second way to lose it is still open: with these two fields the detail is at
 * MAX_DETAIL_KEYS exactly, the cap truncates in Object.entries order, and
 * `failureCodes` is last. So the next field added to RunSummaryFacts would drop the
 * tally again, the same way, and nothing in a running app would report it.
 *
 * Assembling it in one place lets a test hold the cap instead of a comment asking
 * the next reader to.
 */
export function runSummaryFailureDetail(
  facts: RunSummaryFacts,
  primaryCode: string | undefined,
  failureCodes: string | undefined,
): Record<string, unknown> {
  return {
    ...facts,
    // Whether the code on this row came from the severity ranking or from the
    // frequency fallback, so the read side can tell a ranked answer from a guess.
    codeSource: primaryCode ? 'severity' : 'fallback',
    failureCodes,
  };
}
