// Pure reconcile decisions for the WebView cart engine.
//
// Kept free of React and react-native-webview so it is unit-testable: the sheet
// does I/O only — inject a script, receive CART_COUNT, navigate, render — and
// hands the numbers here. The interesting logic is exactly the logic worth
// having tests for: whether a worker's "added" report is corroborated by the
// cart, how many units a short item still needs, which cart units nothing
// intended. A pepper double-count survived as long as it did precisely because
// the only way to exercise it was a live cart against a live store.
//
// The cart-row primitives this composes — diffCartItems, findUnaddedItems,
// findShortAddedItems, findOverAddedItems, name matching — stay in
// webview-scripts/cart-count next to the snapshot scripts that produce the rows.
// This module holds the decisions the sheet acts on.

import {
  CartRow,
  ShortAdd,
  cartNameMatches,
  decodeHtmlEntities,
  findOverAddedItems,
  findShortAddedItems,
  findUnaddedItems,
  normalizeName,
} from './webview-scripts/cart-count';
import { HebAddConfirmation } from './webview-scripts/heb-cart-query';

// ── Sold-by-weight ────────────────────────────────────────────────────────────

/** The fields the sold-by-weight rule reads. Structurally satisfied by a
 *  ConsolidatedIngredient and by a saved ingredient row. */
export interface WeightPricedFields {
  purchaseWeight?: number | null;
}

/**
 * THE sold-by-weight rule. One definition, imported everywhere — MEAL-3's
 * north-star metric needs the same rule and must not restate it.
 *
 * A weight-priced item is one with a chosen ABSOLUTE purchase weight (HEB Deli
 * / Fish Market / bulk). The store puts it in the cart as a single line at N lb,
 * so that row carries no unit count to compare against: 3 lb is not 3 units.
 *
 * The tolerance that follows is PRESENCE. A weight-priced item is confirmed as
 * soon as one unclaimed weight row matches it by name, whatever poundage that
 * row shows; it is never short-audited and never count-topped-up. The add
 * rounds to the nearest weight the store actually sells, so the cart weight
 * rarely equals the requested one — any numeric comparison would report a
 * shortfall on essentially every run.
 *
 * Stepper-weight items (HEB Deli with no weight dropdown) carry weightStep but
 * NO purchaseWeight: their source of truth is productQty, so they reconcile as
 * ordinary count items and are deliberately NOT weight-priced here.
 */
export function isWeightPriced<T extends WeightPricedFields>(
  item: T,
): item is T & { purchaseWeight: number } {
  return item.purchaseWeight != null;
}

// ── Increment-style weight lines: the after check (MEAL-148) ──────────────────

/**
 * How close two poundages have to be to count as the same weight (lb), and how
 * close a click count has to be to a whole number to count as one.
 *
 * Both are float-noise tolerances, NOT judgement thresholds — there is nothing
 * to absorb but the arithmetic itself. The store does not round these lines: the
 * weight a cart row reports is one of the discrete options the row offers (see
 * CartRow.weightOptions), chosen when the line was set, so N clicks × increment
 * lands exactly on an option. A tolerance wide enough to hide a missed click
 * would be the wrong shape of answer here — a missed click is exactly what this
 * check exists to catch.
 */
const WEIGHT_EPSILON_LB = 1e-4;
const CLICK_EPSILON = 1e-3;

/**
 * The weight the store could actually have given us for `targetLb`: the closest
 * option on this line's ladder, or `targetLb` itself when the ladder is unknown.
 *
 * The in-page twin of `__closestOpt` in heb.ts (handleWeightDropdown), and
 * deliberately the same rule down to the tie-break — the option list this snaps
 * against is the one the add path snapped against, handed back to us by the cart
 * row. Re-deriving a ladder from an assumed increment would make this a second
 * guess at a number we already have.
 */
export function snapToWeightLadder(targetLb: number, options?: readonly number[] | null): number {
  if (!options || options.length === 0) return targetLb;
  let best = targetLb;
  let bestD = Infinity;
  for (const opt of options) {
    if (!(opt > 0)) continue;
    const d = Math.abs(opt - targetLb);
    // Strict <, so ties keep the FIRST (lowest) option — __closestOpt's tie-break,
    // over an ascending ladder.
    if (d < bestD) { bestD = d; best = opt; }
  }
  return bestD === Infinity ? targetLb : best;
}

/** One increment-style weight line, checked against what the run asked for. */
export interface IncrementWeightCheck {
  /** Clicks requested. For these items productQty IS the click count. */
  expectedQty: number;
  /** Pounds one click adds — the item's `weightStep`. */
  stepLb: number;
  /** Pounds THIS RUN put on the line (CartRow.addedWeight), never the line's
   *  total: a line the user had already started reads heavier than we added. */
  addedLb: number;
  /** The line's own option ladder, when the cart read emitted one. */
  options?: readonly number[] | null;
}

/**
 * How many of the requested clicks landed on a weight line — MEAL-148's answer
 * to "when a run finishes, how should a weight line that was added by clicking N
 * times be checked?".
 *
 * It is checked by ARITHMETIC. An item the meal counts in units ("2 chicken
 * breasts") whose store line is priced by weight is added by clicking an
 * increment N times, so what the cart owes it is N × increment pounds — snapped
 * onto the row's own ladder, because that is the set of weights the line could
 * hold. Compare that against the pounds the run actually put on the line and the
 * question answers itself; no threshold, and nothing is asked of the user.
 *
 * Returns the clicks landed (== `expectedQty` when the line covers the request),
 * or NULL when the arithmetic cannot decide — no increment known, no poundage
 * read, or numbers that don't reconcile to a whole number of clicks. Null is not
 * a failure verdict: it routes the item to the report-only path it took before
 * this existed (see splitUnverifiableTopUps), which neither confirms nor re-adds.
 *
 * Two things it deliberately does not do:
 *
 *   • it never returns 0. `addedLb` comes from a green row, and a weight row is
 *     only green when the line GREW, so at least one click landed. That is what
 *     makes the resulting top-up safe to run unattended: the shortfall is always
 *     strictly less than the request, so the one branch the ticket rules out —
 *     re-adding the full quantity against a line that did land, and buying the
 *     meat twice — cannot be reached from here.
 *   • it does not report a line that came back HEAVIER than asked. That is the
 *     over-add channel's business, and it counts units, not pounds; here a line
 *     that covers the request is simply covered.
 */
export function landedIncrements(check: IncrementWeightCheck): number | null {
  const expectedQty = Math.max(1, check.expectedQty || 1);
  if (!(check.stepLb > 0) || !(check.addedLb > 0)) return null;
  const expectedLb = snapToWeightLadder(expectedQty * check.stepLb, check.options);
  if (check.addedLb + WEIGHT_EPSILON_LB >= expectedLb) return expectedQty;
  const missingClicks = (expectedLb - check.addedLb) / check.stepLb;
  const whole = Math.round(missingClicks);
  // Not a whole number of clicks short: the line moved by something this item's
  // increment cannot explain (a non-uniform ladder, a weight the user edited by
  // hand, a step we read wrong). Undecidable — and undecidable is a verdict we
  // already know how to route.
  if (Math.abs(missingClicks - whole) > CLICK_EPSILON) return null;
  // Short by the whole request, with the line demonstrably heavier than before:
  // the two facts contradict each other, so refuse rather than credit nothing and
  // re-add everything.
  if (whole < 1 || whole >= expectedQty) return null;
  return expectedQty - whole;
}

// ── Qty-step exclusion ────────────────────────────────────────────────────────

/** The fields the qty-step exclusion rule reads. Structurally satisfied by both
 *  sheets' ConsolidatedIngredient (Kroger's carries no weight fields at all). */
export interface QtyExcludableFields extends WeightPricedFields {
  productQty?: number;
}

/**
 * Is this item excluded from the run by its QUANTITY alone?
 *
 * The pre-automation qty step runs an item when its box is checked AND this is
 * false. One predicate, shared by the filters that build the run and by the
 * checkbox/strikethrough that report it — before MEAL-65 the row's treatment was
 * bound to the checkbox only, so a zeroed row rendered as included while every
 * filter had already dropped it. Tying both to the same expression is what keeps
 * the two from drifting apart again.
 *
 * Weight-priced items are never zeroed out: their quantity IS the chosen
 * absolute weight (see isWeightPriced), which the stepper floors at one step,
 * and their productQty carries no meaning. Stepper-weight items are not
 * weight-priced — productQty is their source of truth — so they zero out like
 * ordinary count items.
 */
export function isZeroedOut<T extends QtyExcludableFields>(item: T): boolean {
  return !isWeightPriced(item) && !((item.productQty ?? 0) > 0);
}

// ── Shared shapes ─────────────────────────────────────────────────────────────

/** One item the run intended to add, reduced to what reconcile compares. */
export interface IntendedItem {
  /** Product title to match cart rows against. */
  name: string;
  /** Units requested. */
  expectedQty: number;
  /** Sold by weight — see isWeightPriced. */
  isWeight: boolean;
  /**
   * Pounds one add-click puts on the line, for an INCREMENT-style item: counted
   * in units, priced by weight, no weight dropdown (`weightStep` set and no
   * `purchaseWeight` — see weightDisplay). Absent on everything else.
   *
   * Present, it is what lets the after check compare a unit count against a
   * poundage — expectedQty × this, against the pounds the line gained. See
   * landedIncrements. Absent, such an item can only be reported, not decided.
   */
  weightStepLb?: number;
}

/** The fields reconcile reads off a cart-run ingredient. Structurally satisfied
 *  by ConsolidatedIngredient. */
export interface ReconcilableItem extends WeightPricedFields {
  ingredientName: string;
  searchTerm?: string | null;
  productQty?: number;
  weightStep?: number | null;
}

/** Reduce a cart-run ingredient to what reconcile compares: the title it is
 *  matched by, the units requested (never below 1 — saved meal data can leak a
 *  zero qty), whether it is weight-priced, and — for an increment-style item —
 *  the pounds one click adds. */
export function toIntendedItem(item: ReconcilableItem): IntendedItem {
  // Only for the increment shape. A weight-PRICED item carries weightStep too
  // (the stepper nudges its purchaseWeight by it), but its productQty means
  // nothing, so multiplying the two would invent an expectation.
  const stepper = !isWeightPriced(item) && item.weightStep != null && item.weightStep > 0;
  return {
    name: item.searchTerm || item.ingredientName,
    expectedQty: Math.max(1, item.productQty || 1),
    isWeight: isWeightPriced(item),
    ...(stepper ? { weightStepLb: item.weightStep as number } : {}),
  };
}

/**
 * What one intended item is worth as "items" (MEAL-178).
 *
 * "items" means TOTAL QUANTITY, not distinct products: three lines totalling
 * seven units is seven items. A sold-by-weight line counts 1 — one line at N lb
 * has no discrete unit count, so it is counted by PRESENCE. That is not a
 * convenience: it is the same rule every cart counter already applies
 * (cart-count.ts adds `count += 1` for a weight row), and the whole point of one
 * definition is that a label and the count it gets compared against measure the
 * same thing.
 *
 * An INCREMENT-style item counts 1 for exactly that reason (MEAL-148). Two
 * chicken breasts are two of something to a shopper, but they reach the cart as
 * ONE weight line, and every counter this number is compared against — the cart
 * badge, the count delta, the row totals — counts that line once. Counting the
 * clicks here instead would make a correct run read as an item short.
 *
 * Whether the amount on such a line actually covers the meal is a different
 * question, and landedIncrements answers it from the poundage. Counting it as one
 * unit here does not claim it was right, only that it is one line.
 */
export function unitsOf(item: IntendedItem): number {
  if (item.isWeight || item.weightStepLb != null) return 1;
  return Math.max(1, item.expectedQty || 1);
}

/**
 * Units for a set of product names, resolved against what the run intended.
 *
 * Each name claims at most one intended item, so two near-identical cart titles
 * cannot both bill the same requested quantity. A name matching nothing intended
 * counts as ONE unit rather than zero: it is a product the run says it handled,
 * and dropping it would silently shrink every count that depends on name
 * matching succeeding — the failure mode being that a user is shown a smaller
 * number than the truth and believes less landed than did.
 *
 * EXACT NAMES ARE RESERVED FIRST, in the same two passes and for the same reason
 * as claimQty and claimCountRows: a single loose pass is order-dependent and lets
 * a sibling swallow a claim that belongs to an exact match. Intending
 * "H-E-B Bakery Sliced White Bread" x3 and "H-E-B White Bread" x1, a report for
 * the latter met the former first and billed 3 units — inflating `expected` and
 * raising a cart-check warning on a run that was correct.
 */
export function unitsForNames(names: readonly string[], intended: readonly IntendedItem[]): number {
  const pool = intended.map((item) => ({ item, used: false }));
  const claim = (name: string, exactOnly: boolean) => pool.find((c) => !c.used && (
    exactOnly
      ? normalizeName(c.item.name) === normalizeName(name)
      : cartNameMatches(c.item.name, name) || cartNameMatches(name, c.item.name)
  ));
  // Pass 1 reserves every exact match; pass 2 lets what is left match loosely, so
  // a stray comma or ® on one title cannot cost another its own row.
  const claimed = new Map<number, ReturnType<typeof claim>>();
  names.forEach((name, i) => { const hit = claim(name, true); if (hit) { hit.used = true; claimed.set(i, hit); } });
  names.forEach((name, i) => {
    if (claimed.has(i)) return;
    const hit = claim(name, false);
    if (hit) { hit.used = true; claimed.set(i, hit); }
  });
  return names.reduce((units, _name, i) => {
    const hit = claimed.get(i);
    return units + (hit ? unitsOf(hit.item) : 1);
  }, 0);
}

/** Units in the cart that no intended item accounts for. */
export interface OverAdd {
  name: string;
  qty: number;
}

/** What a worker reported for one item, as far as reconcile cares. */
export interface WorkerReport {
  success: boolean;
  productName: string | null;
  reason: string | null;
  /**
   * MEAL-14: what the STORE'S CART said about this item, when the store has a
   * cart query we can read (H-E-B, behind `stores.heb.cartSkuConfirm`). Null for
   * every store and every path still confirming off the DOM — absence means "no
   * cart verdict", which is not the same as a negative one.
   */
  confirm?: HebAddConfirmation | null;
}

/** Failure reasons that are definitive: the item is genuinely not in the cart
 *  and re-running the same search would only fail the same way, so it goes to
 *  the user for review rather than to the top-up.
 *
 *  `quantity_limit_reached` joined them for MEAL-202. The cart already holds the
 *  store's per-item maximum, so a retry cannot add anything — and on the network
 *  route a retry is worse than useless: it abandons a rail that answered in
 *  280 ms for one that loads a page, to be told the same thing 1.8 s later. */
/**
 * A failure no retry can fix, so the item goes to the user instead of being
 * re-attempted against the cart.
 *
 * `low_confidence` and `needs_weight` joined the list when DOM automation was
 * removed. They were not definitive before because a retry meant loading the
 * results page again and clicking something else — a second chance that could
 * genuinely go differently. On the rail it cannot: the same search returns the
 * same candidates, so treating a near-miss as a shortfall just retried it into
 * the same answer and then handed the run over, with candidates already in hand
 * that nobody was shown.
 *
 * Both are exactly the case the review screen exists for: we found products, we
 * are not confident enough to add one, so the user picks.
 */
export type DefiniteFailureReason =
  | 'out_of_stock' | 'no_results' | 'quantity_limit_reached'
  | 'low_confidence' | 'needs_weight'
  /**
   * The store never answered the search for this term -- a timeout or a dropped
   * request, not an empty result.
   *
   * It belongs here for the reason the engine's own comment gives when it stamps
   * the reason: "it goes to review instead, which is where an item nobody could
   * answer for belongs, and the user can pick or skip it." That was the
   * intention and it was not what happened. The reason was not in this union, so
   * the item fell through to `toMatch`, the cart had none of it, and it came out
   * as a QUANTITY SHORTFALL -- a top-up. The top-up then had no product id to
   * write and handed the user the store's own search page.
   *
   * Measured on Stephen's 31-item Albertsons run of 2026-09-02:
   *   reconcile: confirmed= 29 retry= 2 [...] review= 0 []
   *   cart verdicts: ... missing= [] unverified= 2
   * Two items nobody could search for, reported as a shortfall and routed to
   * the last-resort screen.
   */
  | 'search_unanswered'
  /**
   * The product needs a variant chosen -- H-E-B's "sliced or shaved?".
   *
   * Same story as `search_unanswered`, found the same way. The engine's comment
   * where it stamps this reads "Either way it goes to review, where the user
   * picks on the page. Silence is the one outcome not available." It was not in
   * this union either, so it went to quantity matching instead, came out as a
   * shortfall, and -- because the branch that stamps it returns BEFORE recording
   * a match -- the top-up had no product id to write and handed over the store.
   *
   * A variant the user must choose is the review screen's entire purpose. The
   * screen has copy for it and SearchResult has carried the reason all along.
   */
  | 'needs_preference';

/**
 * One item the parallel pass attempted, paired with its worker's report.
 *
 * The inherited `name` is only the FALLBACK title: when the worker reported a
 * product name, that name is what identifies the item in the cart. `isWeight` is
 * the item's INTENT (see isWeightPriced) and it decides which pool the item draws
 * from: a weight-priced item is confirmed by presence off a weight row, an
 * ordinary item by unit count off the count rows, and neither can touch the
 * other's pool. Where the row disagrees with the intent, the intent wins — see
 * reconcileParallelAdd.
 *
 * Decisions refer back to items by their INDEX in the array passed in, so this
 * module never needs to know the caller's item type nor hand it back.
 */
export interface AttemptedAdd extends IntendedItem {
  /** null when no worker ever reported for this index. */
  report: WorkerReport | null;
}

// ── Parallel-add reconciliation ───────────────────────────────────────────────

export interface ReconcileOutcome {
  /** Items whose full requested quantity is accounted for in the cart. */
  confirmed: { index: number; name: string }[];
  /** Items to re-add serially, and how many units are still missing. Only the
   *  shortfall is re-added; re-adding the full qty would over-add the units
   *  that already landed. */
  topUps: { index: number; shortfall: number }[];
  /** Items a worker definitively failed. Never matched against the cart, never
   *  retried — they route to the review queue. */
  definiteFailures: { index: number; reason: DefiniteFailureReason }[];
  /** The full intended set (definite failures excluded). The caller must keep
   *  this: the after-snapshot's over-add check needs it once the top-up has
   *  narrowed the active items down to the retry subset. */
  intended: IntendedItem[];
  /** Cart units no intended item accounts for — a double-add or an unintended
   *  product. A safety net: even if a future bug re-adds something, the cart
   *  check surfaces it rather than trusting the run silently. */
  overAdds: OverAdd[];
  /** Total units across overAdds. */
  overAddUnits: number;
  /**
   * The intent-vs-row disagreements among `topUps` that the WEIGHT ARITHMETIC
   * COULD NOT DECIDE: items ordered by unit COUNT that came up short while an
   * unclaimed sold-by-weight line bearing their name sits in the cart (the
   * increment-style H-E-B deli shape — weightStep but no purchaseWeight, so
   * isWeightPriced is false and the ×N is a unit count).
   *
   * Reported separately because the top-up these items get is the one case where
   * a re-add can cost real money: the line plausibly DID land, so re-adding the
   * full quantity unattended buys the meat a second time. A caller that cannot
   * tell the two apart must not re-add them — see splitUnverifiableTopUps, which
   * is how WebViewCartSheet does it. They appear in `topUps` as well, so a caller
   * that ignores this field behaves exactly as before (and re-adds them).
   *
   * Each unclaimed weight row explains at most one item, so this can never name
   * more items than the cart has unexplained weight lines.
   *
   * NO LONGER THE ANSWER, only the residue (MEAL-148). Where the item's increment
   * and the row's poundage are both known, landedIncrements decides the case:
   * the item is confirmed if the line covers N clicks, or topped up by exactly
   * the clicks that are missing — neither of which lands here. What still lands
   * here is what the arithmetic refused: no increment (a store whose cart read
   * emits no weight rows at all, or an item that never went through choose), no
   * poundage, or numbers that don't reconcile. For those, "we could not verify
   * this" is still the most that is true, and the sheet still puts the count on
   * the funnel — now as a measure of how much is left undecided rather than of
   * how often the whole case fires.
   */
  countItemsOnWeightRows: { index: number; cartName: string }[];
}

/**
 * Reconcile a parallel add against the cart: trust the CART, not the workers.
 *
 * Qty-aware — each item's expected quantity is compared against the quantity
 * that actually landed, so a product present but short (added ×1 when ×2 was
 * wanted) is topped up by the shortfall, not just fully-missing items.
 *
 * `addedRows` are the added (green) rows from diffCartItems.
 */
export function reconcileParallelAdd(
  attempts: AttemptedAdd[],
  addedRows: CartRow[],
): ReconcileOutcome {
  const definiteFailures: { index: number; reason: DefiniteFailureReason }[] = [];
  // Resolve each item's identity up front, routing definitive failures out so
  // they don't consume pool units. An out-of-stock / no-results item is
  // genuinely not in the cart, so it must NOT be qty-matched (productName is
  // null; the search term loosely collides with a sibling's row) nor blindly
  // retried — it goes to review so the user can pick an alternative or skip,
  // like the serial add path.
  const toMatch: {
    index: number;
    name: string;
    expectedQty: number;
    isWeight: boolean;
    weightStepLb?: number;
    claimed: number;
    confirmedWeight: boolean;
    /** The weight line this count item was blamed on when the arithmetic could
     *  not decide — see countItemsOnWeightRows. */
    undecidedOn: string | null;
  }[] = [];
  attempts.forEach((attempt, index) => {
    const r = attempt.report;
    // Named one by one rather than tested against the union, so adding a member
    // to DefiniteFailureReason is a decision someone makes here on purpose.
    if (r && !r.success && (r.reason === 'out_of_stock' || r.reason === 'no_results'
        || r.reason === 'quantity_limit_reached'
        || r.reason === 'low_confidence' || r.reason === 'needs_weight'
        || r.reason === 'search_unanswered' || r.reason === 'needs_preference')) {
      definiteFailures.push({ index, reason: r.reason });
      return;
    }
    toMatch.push({
      index,
      name: decodeHtmlEntities((r && r.productName) || attempt.name),
      expectedQty: Math.max(1, attempt.expectedQty || 1),
      isWeight: attempt.isWeight,
      weightStepLb: attempt.weightStepLb,
      claimed: 0,
      confirmedWeight: false,
      undecidedOn: null,
    });
  });
  const intended: IntendedItem[] = toMatch.map((m) => ({
    name: m.name,
    expectedQty: m.expectedQty,
    isWeight: m.isWeight,
    ...(m.weightStepLb != null ? { weightStepLb: m.weightStepLb } : {}),
  }));

  // Attribute each added cart unit to a SINGLE item. Summing every name-matching
  // row per item double-counts when two distinct products have near-identical
  // names (e.g. "…Dried Chile Ancho Peppers, 4 oz" vs "…Guajillo Peppers, 4 oz"):
  // each pepper's name matches both rows, so a 1-of-2 shortfall looks fully
  // stocked. Instead, consume from a shared pool — reserve exact-name matches
  // first, then let a loose match take only what's genuinely left over.
  //
  // TWO pools, and every added row belongs to exactly one of them — the split
  // toLeftover makes below, and the split findOverAddedItems makes over the same
  // rows, which is what lets the two agree about one cart. A weight line carries
  // no unit count (one line at N lb) so it can never be spent as a count unit;
  // MEAL-119: it used to sit in BOTH pools, and one physical row could be
  // consumed twice over — once by the presence pass, then again as a "unit" by
  // some other item's claimQty, which confirmed an item nothing had been bought
  // for.
  const pool = addedRows.filter((r) => !r.isWeight).map((row) => ({ name: row.name, qty: row.qty }));
  // Punctuation- and entity-insensitive so a reported title can reserve its OWN
  // cart row in the exact pass before a loosely-similar sibling ("McCormick
  // Ground Cumin" vs "…Gourmet Organic Ground Turmeric") can claim it in the
  // loose pass. A stray comma/® otherwise sank the exact match and caused a
  // spurious re-add (double add).
  const claimQty = (reportedName: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of pool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly
        ? normalizeName(row.name) === normalizeName(reportedName)
        : cartNameMatches(row.name, reportedName);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };

  // Weight-priced items first, confirmed by PRESENCE (see isWeightPriced): one
  // unclaimed weight row bearing the name confirms the item at whatever poundage
  // that row shows. Consume the row, so neither a sibling nor the count passes
  // below can spend it a second time.
  //
  // Gated on the ITEM's isWeight — the SAME gate claimWeightRows and
  // findOverAddedItems use. When intent and cart row disagree (a count item
  // ordered ×3 whose name matches a sold-by-weight line, e.g. a stepper-weight
  // deli item), intent wins and the item is count-compared. The count pool holds
  // no weight rows, so it claims nothing and reports its full shortfall.
  //
  // Intent wins because the alternative is a GUESS: presence-confirming a count
  // item off a weight row rests on cartNameMatches, a 0.6 token overlap, and when
  // that guess is wrong the user is told their ×3 landed and receives nothing.
  // Silent non-delivery is the worst failure available here, so failing visibly
  // beats it.
  //
  // But the shortfall must not be re-added on its own either, WHERE THE SIZE OF IT
  // is still a guess. The top-up is unattended and, with nothing claimed off the
  // weight line, the shortfall is the full quantity — so where the line genuinely
  // did land it buys a second one, and for a deli line that is meat the user pays
  // for twice. Where the item's increment is known, MEAL-148's arithmetic removes
  // the guess (see the count pass below and landedIncrements): the clicks that
  // landed are read off the poundage, so the item is either confirmed or topped up
  // by the few clicks actually missing. Where it is not known, both machine
  // answers are still refused: the item is named in `countItemsOnWeightRows`,
  // splitUnverifiableTopUps lifts it out of the top-up, nothing is bought and
  // nothing claims success, and the sheet reports it as unverified.
  //
  // The disagreement is not swallowed either — no weight-priced item claimed the
  // row, so findOverAddedItems returns it in `overAdds` and both sides are
  // announced. (An increment item that the arithmetic DID account for is not a
  // disagreement any more, and findOverAddedItems lets it keep its row.)
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ row: r, used: false }));
  toMatch.forEach((m) => {
    if (!m.isWeight) return;
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.row.name, m.name));
    if (w) { w.used = true; m.confirmedWeight = true; }
  });
  // Count items only, out of the count pool. Pass 1: every item reserves its
  // exact-name units. Pass 2: items still short take loose matches from whatever
  // remains unclaimed.
  toMatch.forEach((m) => { if (!m.isWeight) m.claimed = claimQty(m.name, m.expectedQty, true); });
  toMatch.forEach((m) => { if (!m.isWeight && m.claimed < m.expectedQty) m.claimed += claimQty(m.name, m.expectedQty - m.claimed, false); });
  // Third pass, count items only, and the one that answers MEAL-148: a count item
  // still short, with an unclaimed sold-by-weight line bearing its name, is the
  // increment-style item this whole branch is about — the store prices it by
  // weight, the meal counts it in units, and the add clicked an increment N times.
  // Its units are therefore IN that line's poundage, not in the count pool, and
  // landedIncrements reads them back out.
  //
  // Consume the row whichever way it goes. Two count items must not both be
  // credited (or both blamed) for one physical line, and the row is spent either
  // way: it has explained this item, or it has failed to.
  toMatch.forEach((m) => {
    if (m.isWeight || m.claimed >= m.expectedQty) return;
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.row.name, m.name));
    if (!w) return;
    w.used = true;
    const landed = m.weightStepLb == null ? null : landedIncrements({
      expectedQty: m.expectedQty,
      stepLb: m.weightStepLb,
      // The run's own contribution, never the line total — a line the user had
      // already started would otherwise confirm an add that never happened.
      addedLb: w.row.addedWeight ?? 0,
      options: w.row.weightOptions,
    });
    // Undecidable: no increment (no choose data, or a store whose cart read emits
    // no weight rows), no poundage, or numbers that don't reconcile. Report it,
    // exactly as before the arithmetic existed.
    if (landed == null) { m.undecidedOn = w.row.name; return; }
    m.claimed = Math.min(m.expectedQty, m.claimed + landed);
  });

  const confirmed: { index: number; name: string }[] = [];
  const topUps: { index: number; shortfall: number }[] = [];
  const countItemsOnWeightRows: { index: number; cartName: string }[] = [];
  toMatch.forEach((m) => {
    // A weight-priced item needs exactly ONE row, not N units: its productQty
    // carries no meaning (see isWeightPriced), so an absent one is a shortfall of
    // 1 — one re-add, which re-picks the requested weight.
    if (m.isWeight) {
      if (m.confirmedWeight) confirmed.push({ index: m.index, name: m.name });
      else topUps.push({ index: m.index, shortfall: 1 });
      return;
    }
    const shortfall = m.expectedQty - m.claimed;
    if (shortfall <= 0) { confirmed.push({ index: m.index, name: m.name }); return; }
    topUps.push({ index: m.index, shortfall });
    // Short, and the weight line that bears its name explained nothing: the
    // intent disagreement, unresolved. Its top-up may buy a second one, so it is
    // named here and splitUnverifiableTopUps lifts it out.
    if (m.undecidedOn) countItemsOnWeightRows.push({ index: m.index, cartName: m.undecidedOn });
  });

  const overAdds = findOverAddedItems(addedRows, intended);
  return {
    confirmed,
    topUps,
    definiteFailures,
    intended,
    overAdds,
    overAddUnits: overAdds.reduce((n, o) => n + o.qty, 0),
    countItemsOnWeightRows,
  };
}

// ── Routing the top-up: retry vs unverified (MEAL-119) ────────────────────────

/** One short item whose cart line disagrees with its intent: the sold-by-weight
 *  line that bears its name, and the units still unaccounted for. */
export interface UnverifiableTopUp {
  index: number;
  /** The sold-by-weight cart line matching this item's name. Truthful enough to
   *  render: it is a line the cart really holds. */
  cartName: string;
  /** Units still unaccounted for, if the line covers none of them. Reported, not
   *  acted on — see splitUnverifiableTopUps. */
  shortfall: number;
}

export interface TopUpRouting {
  /** Safe to re-add unattended: nothing in the cart plausibly covers these. */
  retry: { index: number; shortfall: number }[];
  /** Neither re-added nor confirmed — only reported. See UnverifiableTopUp. */
  unverified: UnverifiableTopUp[];
}

/**
 * Split a reconcile's top-up into the part a machine may re-add and the part it
 * must leave alone.
 *
 * Two governing rules bind cart automation: never add an item the user did not
 * ask for, and never over- or under-add. The intent-vs-row disagreement breaks
 * one of them whichever obvious thing we do:
 *
 *   • re-add the shortfall — here the shortfall IS the full quantity, so where
 *     the weight line did land the user buys the deli meat a second time. An
 *     over-add, and the expensive direction.
 *   • presence-confirm it off the weight line — we assume it landed and tell
 *     nobody. A silent under-add, and "they'll see it at checkout" is not a
 *     defence.
 *
 * So the item goes to neither. It leaves `retry`, so nothing is bought; it never
 * reaches `confirmed`, so nothing claims success; and it lands in `unverified`,
 * which the caller REPORTS. That is still an under-add — but a stated one, and
 * stating it is the only branch that does not silently break a rule.
 *
 * NARROWED, not removed (MEAL-148). Where the item's increment is known, the
 * reconcile now compares productQty × increment against the poundage the line
 * gained and decides the case: such an item is confirmed, or topped up by the
 * clicks actually missing, and either way it never reaches
 * `countItemsOnWeightRows`. What still arrives here is what the arithmetic
 * refused to decide — no increment, no poundage, or numbers that don't reconcile
 * — and for those, "we could not verify this" remains the most that is true.
 *
 * A total partition of `topUps` by index — every short item ends up in exactly
 * one side, so no item can be both re-added and reported, and none can be
 * dropped. `countItemsOnWeightRows` is already a subset of `topUps` (each
 * unclaimed weight row blames at most one item), which is what makes that true.
 */
export function splitUnverifiableTopUps(
  outcome: Pick<ReconcileOutcome, 'topUps' | 'countItemsOnWeightRows'>,
): TopUpRouting {
  const disagreements = new Map(outcome.countItemsOnWeightRows.map((c) => [c.index, c.cartName]));
  const retry: { index: number; shortfall: number }[] = [];
  const unverified: UnverifiableTopUp[] = [];
  for (const t of outcome.topUps) {
    const cartName = disagreements.get(t.index);
    if (cartName === undefined) retry.push(t);
    else unverified.push({ index: t.index, cartName, shortfall: t.shortfall });
  }
  return { retry, unverified };
}

// ── Per-item cart verdicts (MEAL-14) ─────────────────────────────────────────

/** One item, and what the cart itself said about it. */
export interface ConfirmedItem {
  index: number;
  /** The product name to show a human — the worker's title, else the intent's. */
  name: string;
  /** The cart's own ids for the line, when it had them. */
  skuId: string | null;
  productId: string | null;
  /** Why the verdict — `absent_from_cart` vs `blocked` vs `weight_unchanged`. */
  reason: string | null;
}

/**
 * The three-way split MEAL-9's partial-success UI and MEAL-3's item-success
 * metric need: which items the cart CONFIRMED, which ones the cart says are NOT
 * there, and which ones we simply could not verify.
 *
 * `unknown` is the whole point of keeping this separate from confirmed/failed.
 * An unreadable cart — Imperva block, timeout, unexpected shape — must never be
 * counted as "these items failed": that would turn one broken read into a
 * screenful of false failures, worse than the badge guess it replaced. Items in
 * `unknown` were decided by the DOM rail as before, and their success/failure is
 * still on the report; what is absent is cart-grade evidence either way.
 *
 * A `requested` count is deliberately NOT returned. MEAL-3 counts LINES, not
 * units, and each attempt here is one line — so the denominator is
 * `attempts.length` and there is no second definition of it to drift.
 */
export interface ConfirmSummary {
  landed: ConfirmedItem[];
  missing: ConfirmedItem[];
  unknown: ConfirmedItem[];
}

/**
 * Split attempted adds by what the store's cart said about each one.
 *
 * Items with no cart verdict at all (every store but H-E-B, every path still on
 * the DOM rail, and every run with the flag off) land in `unknown` with reason
 * `no_verdict` — no rail ran, so nothing was verified. That keeps "we didn't
 * look" and "we looked and it isn't there" apart, which is the distinction the
 * badge rail could never draw.
 */
export function summarizeConfirmations(attempts: AttemptedAdd[]): ConfirmSummary {
  const out: ConfirmSummary = { landed: [], missing: [], unknown: [] };
  attempts.forEach((attempt, index) => {
    const r = attempt.report;
    const c = r ? r.confirm : null;
    const item: ConfirmedItem = {
      index,
      name: decodeHtmlEntities((r && r.productName) || attempt.name),
      skuId: (c && c.skuId) || null,
      productId: (c && c.productId) || null,
      reason: c ? c.reason : 'no_verdict',
    };
    if (c && c.state === 'landed') out.landed.push(item);
    else if (c && c.state === 'missing') out.missing.push(item);
    else out.unknown.push(item);
  });
  return out;
}

export interface WorkerReportOutcome {
  confirmed: { index: number; name: string }[];
  failed: { index: number; name: string }[];
}

/**
 * The reconcile decision when the cart gave no per-item data to diff against
 * (a header-badge store): trust the worker results, because there is nothing
 * better to trust.
 *
 * NOT a rare path, and an earlier version of this comment said it was. Parallel add
 * covers HEB, Walmart, Amazon Fresh and the Albertsons family — only ALDI and
 * Wegmans force serial — and since MEAL-152 a cart page that cannot prove it is the
 * cart posts no per-item rows on purpose, which routes here by design rather than
 * by accident.
 *
 * MEAL-14 gives it one thing better to trust. Where an item carries a cart
 * verdict, that verdict wins over the worker's own claim — the worker inferred
 * from a shared badge, the verdict is the store answering about this product. It
 * applies ONLY to a definite verdict: `unknown` (an unreadable cart) leaves the
 * worker's report in charge exactly as before, because a read we could not
 * perform is not evidence about the item.
 */
export function reconcileFromWorkerReports(attempts: AttemptedAdd[]): WorkerReportOutcome {
  const confirmed: { index: number; name: string }[] = [];
  const failed: { index: number; name: string }[] = [];
  attempts.forEach((attempt, index) => {
    const r = attempt.report;
    const c = r ? r.confirm : null;
    const name = (r && r.productName) || attempt.name;
    if (c && c.state === 'landed') { confirmed.push({ index, name }); return; }
    if (c && c.state === 'missing') { failed.push({ index, name: attempt.name }); return; }
    if (r && r.success) confirmed.push({ index, name });
    else failed.push({ index, name: attempt.name });
  });
  return { confirmed, failed };
}

// ── After-run cart check ──────────────────────────────────────────────────────

/**
 * Whether a finished run has earned an after-snapshot of the cart.
 *
 * Gated on adds ATTEMPTED, never on adds REPORTED. A run whose adds all came
 * back "failed" is exactly the run the snapshot exists to catch: the
 * confirmation rail is a shared header badge (see webview-scripts/cart-confirm),
 * so an add that committed while the badge read stale is reported as a failure.
 * Gating on the reported count re-trusted the workers in the single case we know
 * they are unreliable — the user was told an item was missing while it sat in
 * their cart, and found out at checkout or by re-adding it and paying twice.
 *
 * Deliberately NOT unconditional. A run that attempted no adds at all — the
 * choose-a-product flow, or every item skipped while picking substitutes — has
 * no signal to find, and a cart read costs a real page load on a store that is
 * watching for automation. `addsAttempted` is the count of items that reached an
 * add click on the SEQUENTIAL paths only.
 *
 * It is no longer the same number as the funnel's `add_click` denominator, which
 * it used to match. MEAL-122 gave the two worker pools per-item `add_click` rows;
 * this counter was deliberately left alone, because it is not instrumentation —
 * it gates a real extra cart page load. A parallel run already reconciles against
 * the cart with its own probe, so counting its adds here would only add a SECOND
 * probe, and only in the case where the first one timed out, on a store that is
 * watching. Whether this gate should follow the funnel is a product call.
 *
 * `hasBaseline` stays a hard requirement: with no before-snapshot every row in
 * the cart diffs as newly added, so the "findings" would be the user's entire
 * cart. That a timed-out baseline therefore suppresses an otherwise useful
 * reconcile is a real hole — it is MEAL-47's named follow-up (retry the
 * before-probe, and/or an after-only presence check), deliberately not decided
 * here.
 */
export function shouldProbeAfterRun(input: {
  addsAttempted: number;
  hasBaseline: boolean;
}): boolean {
  return input.hasBaseline && input.addsAttempted > 0;
}

/** An item the run reported as NOT added that the cart says did land. */
export interface RecoveredAdd {
  /** The intended item, by the title the run searched for. */
  name: string;
  /** The cart row accounting for it — the title the user sees in their cart. */
  cartName: string;
  /** Units of it found in the cart. */
  qty: number;
  /**
   * How this recovery's cart row was matched: 'exact' when every unit came from
   * a normalized exact-title match, 'loose' when any came from the token-subset
   * matcher (cartNameMatches) — which includes every weight row, since presence
   * matching has no exact pass.
   *
   * MEAL-47's caveat, made measurable. A recovery says "we told the user this
   * failed, but it's in their cart" — and names alone cannot separate that from
   * "an unintended product with a similar name is in their cart". An exact-title
   * match is not open to that doubt; a loose one is. The done screen treats both
   * the same (both mean "don't add it again", which is the safe advice either
   * way), but MEAL-3's metric must not silently credit a loose guess as an add,
   * so the two are counted apart in the telemetry.
   */
  matchQuality: 'exact' | 'loose';
}

export interface CartCheckFindings {
  /** Reported as added, but no cart row bears the name — a silent miss. */
  missing: string[];
  /** Present in the cart but with fewer units than requested (e.g. a store
   *  per-item cap accepted 2 of 3). */
  short: ShortAdd[];
  /** Cart units no intended item accounts for — neither a reported add nor a
   *  recovered one. Partitioned against `recovered`, so a unit never appears in
   *  both (see splitCartLeftover). */
  over: OverAdd[];
  /** Total units across `over`. */
  overUnits: number;
  /**
   * Attempted, reported as NOT added, and in the cart anyway — a worker false
   * negative. The run already told the user these failed; the cart says
   * otherwise, and re-adding them by hand would double them.
   *
   * Claimed from the same pool as `over` and before it, so a recovered unit is
   * never also announced as unintended.
   */
  recovered: RecoveredAdd[];
  /**
   * Fallback shortfall for stores with no per-item cart data (header badge
   * only), or when names didn't resolve: the badge rose by less than the number
   * of items reported added. Null whenever there are per-item findings above —
   * those are strictly more specific, and the caller reports them instead.
   */
  countShortfall: { delta: number; expected: number } | null;
  /** Whether a per-item cart read actually happened. False means every list
   *  above is empty for want of evidence, not for want of findings. */
  cartRead: boolean;
  /**
   * The before/after comparison the user-facing message is built from
   * (MEAL-199): products and units we meant to add, against products and units
   * the cart gained, matched by exact name, skips excluded.
   *
   * Held apart from the lists above rather than replacing them. Those feed the
   * funnel — `missing`, `recovered` and `over` are how we measure the run's own
   * reporting against the cart, which is MEAL-47's subject and needs the lenient
   * matcher to see a near-miss at all. This one decides what a person is told,
   * where a near-miss is a wrong sentence.
   */
  comparison: SnapshotComparison;
}

/** Do an intended title and a title the RUN reported name the same product?
 *  Matched in BOTH directions on purpose: the intended title is a search term
 *  ("sour cream") while a reported title is the store's product name ("Daisy
 *  Pure & Natural Sour Cream, 16 oz"), and cartNameMatches only asks whether the
 *  second argument's tokens are present in the first. Reading it one way alone
 *  would classify half the reported items as unreported. */
function namesSameProduct(intended: string, reported: string): boolean {
  return cartNameMatches(intended, reported) || cartNameMatches(reported, intended);
}

/** Did the run report adding this item? Erring towards "reported" is the safe
 *  direction here: it costs a recovery we don't announce, never a false "it's
 *  already in your cart". */
function wasReported(item: IntendedItem, reportedAdded: string[]): boolean {
  return reportedAdded.some((n) => namesSameProduct(item.name, n));
}

/**
 * The two findings that share the added rows: recoveries and over-adds.
 *
 * They are computed together because they are one partition of one pool. Two
 * independent passes over the same rows (an `over` recomputed from the full
 * intended set, a `recovered` claiming from its own reported-only pool) can
 * attribute the same unit differently, and a unit the two disagree about lands
 * in BOTH — the done screen then names one product twice, telling the user in
 * the same breath not to re-add it and that nothing intended it. See
 * splitCartLeftover.
 */
export interface CartLeftoverSplit {
  recovered: RecoveredAdd[];
  over: OverAdd[];
}


/** One added cart row while it is being consumed. Weight rows are held apart:
 *  they carry no unit count (one line at N lb), so only a weight-priced item may
 *  claim one, and only by presence — exactly findOverAddedItems' rule, which
 *  loses the flag when it flattens leftovers to `{name, qty: 1}` on output. */
interface Leftover {
  count: { name: string; qty: number }[];
  weight: { name: string; used: boolean }[];
}

function toLeftover(addedRows: CartRow[]): Leftover {
  return {
    count: addedRows.filter((r) => !r.isWeight).map((r) => ({ name: r.name, qty: r.qty })),
    weight: addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false })),
  };
}

/** A claim in progress: how many units of `item` the pool has yielded so far,
 *  and the cart title they came from (what the user sees in their cart). */
interface Claim {
  item: IntendedItem;
  qty: number;
  cartName: string;
  /** Set once any unit of this claim came from a LOOSE (token-subset) match
   *  rather than an exact title match. Sticky and pessimistic: a claim that took
   *  two units exactly and one loosely is a loose claim, because the doubt
   *  attaches to the row, not to the average. See RecoveredAdd.matchQuality. */
  loose: boolean;
}

/** Consume weight rows by PRESENCE for the weight-priced items among `claims` —
 *  one row at N lb confirms the item whatever poundage was asked for (see
 *  isWeightPriced). Mutates `pool`. */
function claimWeightRows(pool: Leftover, claims: Claim[]): void {
  for (const c of claims) {
    if (!c.item.isWeight || c.qty > 0) continue;
    const w = pool.weight.find((p) => !p.used && cartNameMatches(p.name, c.item.name));
    // Always loose: presence matching runs cartNameMatches with no exact pass in
    // front of it, so a weight row is only ever claimed on name similarity.
    if (w) { w.used = true; c.qty = 1; c.cartName = w.name; c.loose = true; }
  }
}

/** Consume one weight row for each INCREMENT-style item (`weightStepLb`) the count
 *  pool left empty-handed — its clicks are poundage on that line, so the line is
 *  its, not an unintended add. Runs after the count passes for the same reason as
 *  in findOverAddedItems, and claims at most one row per item. Mutates `pool`. */
function claimIncrementRows(pool: Leftover, claims: Claim[]): void {
  for (const c of claims) {
    if (c.item.isWeight || c.item.weightStepLb == null || c.qty > 0) continue;
    const w = pool.weight.find((p) => !p.used && cartNameMatches(p.name, c.item.name));
    if (w) { w.used = true; c.qty = 1; c.cartName = w.name; c.loose = true; }
  }
}

/** Consume count rows for the count items among `claims`, capped at each item's
 *  expected qty so a legitimately-requested unit never reads as overage.
 *  Mutates `pool`. */
function claimCountRows(pool: Leftover, claims: Claim[], exactOnly: boolean): void {
  for (const c of claims) {
    if (c.item.isWeight) continue;
    const need = Math.max(1, c.item.expectedQty || 1);
    for (const row of pool.count) {
      if (c.qty >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly
        ? normalizeName(row.name) === normalizeName(c.item.name)
        : cartNameMatches(row.name, c.item.name);
      if (!match) continue;
      const take = Math.min(row.qty, need - c.qty);
      row.qty -= take;
      c.qty += take;
      if (!exactOnly) c.loose = true;
      if (!c.cartName) c.cartName = row.name;
    }
  }
}

/**
 * Split the added cart rows into what the run under-reported (`recovered`) and
 * what nothing intended (`over`) — ONE pool, claimed once, so no unit can be
 * reported twice.
 *
 * Every added unit is offered to the intended items in a fixed order and then
 * removed from the pool:
 *
 *   1. items the run REPORTED as added take their own rows — exact-name matches
 *      reserved before loose ones, the pool discipline the pepper double-count
 *      taught us. A lookalike title can then never be announced as landed.
 *   2. items the run reported as FAILED claim from what is left. A unit one of
 *      them explains is a `recovered` false negative: attempted, reported
 *      failed, in the cart anyway — the bug MEAL-47 is about.
 *   3. whatever no intended item claimed is `over`.
 *
 * Because it is a true partition, `over` is no longer recomputed from the full
 * intended set: it is the residue of steps 1-2. Where the two used to disagree
 * about a unit — a count item claiming a weight row it could never claim in the
 * over pass, or a loose match the two passes attributed differently — the unit
 * is now attributed once, to the recovery, and `over` no longer repeats it.
 *
 * The exact-name passes run before the loose ones ACROSS both groups, so a
 * reported item's loose match cannot take the row an unreported item names
 * exactly; within a pass, reported items claim first.
 */
export function splitCartLeftover(
  addedRows: CartRow[],
  reportedAdded: string[],
  intendedAll: IntendedItem[],
): CartLeftoverSplit {
  const pool = toLeftover(addedRows);
  const claims: Claim[] = intendedAll.map((item) => ({ item, qty: 0, cartName: '', loose: false }));
  const reported = claims.filter((c) => wasReported(c.item, reportedAdded));
  const unreported = claims.filter((c) => !wasReported(c.item, reportedAdded));

  claimWeightRows(pool, reported);
  claimWeightRows(pool, unreported);
  claimCountRows(pool, reported, true);
  claimCountRows(pool, unreported, true);
  claimCountRows(pool, reported, false);
  claimCountRows(pool, unreported, false);
  claimIncrementRows(pool, reported);
  claimIncrementRows(pool, unreported);

  const over: OverAdd[] = [];
  for (const row of pool.count) if (row.qty > 0) over.push({ name: row.name, qty: row.qty });
  for (const w of pool.weight) if (!w.used) over.push({ name: w.name, qty: 1 });
  return {
    recovered: unreported
      .filter((c) => c.qty > 0)
      .map((c) => ({
        name: c.item.name,
        cartName: c.cartName,
        qty: c.qty,
        matchQuality: c.loose ? ('loose' as const) : ('exact' as const),
      })),
    over,
  };
}

/**
 * Hold the cart lines the run has ALREADY ACCOUNTED FOR out of an over-add list
 * (MEAL-119).
 *
 * `countItemsOnWeightRows` / `TopUpRouting.unverified` name a real cart line: a
 * sold-by-weight row bearing a requested item's own name, which the count item
 * that asked for it can never claim (see claimWeightRows and the weight pool in
 * reconcileParallelAdd). So the row falls straight through to `over`, where the
 * copy calls it an item "Mealio didn't intend to add".
 *
 * That sentence is false. Mealio DID intend it — the user put chicken breast in
 * their meal, and the row is the store's weight-priced rendering of the thing
 * they asked for. The row is not overage: it is the blame for one specific
 * requested item, and the done screen already reports it BY NAME as a line the
 * run could not verify. Left in `over` it becomes one physical line described
 * twice on one screen, once as unverifiable and once as unwanted, and a user who
 * believes the second sentence deletes the chicken they asked for — the outcome
 * MEAL-119 exists to prevent, reached by following Mealio's own advice.
 *
 * The justification is that the row is EXPLAINED, not that the user approved it.
 * (An earlier version of this filter said "the user kept this line", which was
 * true only while a review card existed to keep it with; that card is gone and
 * the suppression is not.) An over-add warning is for cart rows nothing accounts
 * for. This row is accounted for, so it belongs to the finding that accounts for
 * it and to no other.
 *
 * EXACT normalized comparison, deliberately. Both sides are cart-page titles
 * produced by the same extractor, so they are directly comparable and leniency
 * buys nothing. The version that matched with cartNameMatches (0.6 token
 * overlap) was found muting genuine warnings: an explained "Boneless Skinless
 * Chicken Breasts" swallowed the warning about unintended "Chicken Thighs", and
 * "Bananas" swallowed "Bananas Organic". Muting a safety net on a near-miss is
 * far worse than printing one row of noise, so the match here is the strict one.
 * The asymmetry is the whole argument: a miss here prints a warning about a row
 * the banner also names — noise the user can check against their cart — while a
 * false hit deletes a warning about a product nobody ordered.
 *
 * One unit per explained row. Each unclaimed weight row is a single line and
 * explains at most one item, so it cancels exactly one over-add UNIT under its
 * name; any further unit the cart holds under that same title is still nothing's
 * claim and is still reported.
 */
export function dropExplainedOverAdds(over: OverAdd[], explainedRows: string[]): OverAdd[] {
  if (explainedRows.length === 0) return over;
  const remaining = over.map((o) => ({ ...o }));
  for (const name of explainedRows) {
    const hit = remaining.find((o) => o.qty > 0 && normalizeName(o.name) === normalizeName(name));
    if (hit) hit.qty -= 1;
  }
  return remaining.filter((o) => o.qty > 0);
}

/**
 * Take the items the cart proved landed back out of the run's failed list
 * (MEAL-177).
 *
 * The done screen tells the user "Could not add: X" from the workers' reports,
 * and the after-probe is the only thing that ever checks them. When it finds X
 * in the cart, the screen is left asserting two opposite things about one
 * product — and there is nowhere else the user was told X failed, so that line
 * IS the claim the cart just disproved. Correcting it is the fix; a banner
 * printed underneath explaining that the line above is wrong is not.
 *
 * Only the failed list is corrected here. A recovery is NOT promoted to
 * "added": `matchQuality: 'loose'` means a name matched, not that this run put
 * the product there, and the added headline is the run's claim about what it
 * did. What both qualities support is the cart statement the caller renders
 * instead — it is in your cart, don't add it again — which is the advice that
 * is safe either way (see RecoveredAdd).
 *
 * ONE claim per recovery, the same pool discipline as dropExplainedOverAdds and
 * for a sharper reason: dropping a name here means the user is never told that
 * item failed, so they do not buy it. One recovered unit cancels one failed
 * line and no more — two failures with near-identical titles and a single
 * recovery leave one still reported.
 *
 * Matching is namesSameProduct, i.e. the matcher the recovery itself was built
 * with (`recovered.name` is the intended search term; a failed name is whatever
 * the run reported, usually the store's product title). A stricter comparison
 * here would routinely fail to find the very line the recovery came from.
 */
export function dropRecoveredFailures(failedNames: string[], recovered: RecoveredAdd[]): string[] {
  if (recovered.length === 0) return failedNames;
  const lines = failedNames.map((name) => ({ name, claimed: false }));
  for (const r of recovered) {
    const hit = lines.find((l) => !l.claimed && namesSameProduct(r.name, l.name));
    if (hit) hit.claimed = true;
  }
  return lines.filter((l) => !l.claimed).map((l) => l.name);
}

/**
 * Audit the after-run cart against what the run reported adding.
 *
 * `rows` are the diffCartItems output for this store, or null when the store
 * only yields a header count. `reportedAdded` are the product names the run
 * reported as successfully added.
 *
 * `active` is the LIVE active item set — the short-add audit is scoped to it,
 * so after a top-up it covers the retry subset only. `reconcileIntended` is the
 * full intended set the parallel reconcile snapshotted before the top-up
 * narrowed `active`; the over-add check prefers it and falls back to `active`
 * for the serial path, which never reconciles and so never captures one.
 *
 * The audit reads in both directions: items reported added that the cart can't
 * corroborate (`missing`/`short`), and items reported FAILED that the cart says
 * landed anyway (`recovered`). The second direction is why this runs at all on
 * a run that reported nothing added — see shouldProbeAfterRun.
 *
 * `explainedRows` are cart titles this run has already reported to the user in
 * their own right — the unverified sold-by-weight lines (MEAL-119). They are held
 * out of the over-add finding; see dropExplainedOverAdds for why naming them
 * there is not noise but false and actively harmful advice.
 */
export function auditCartAfterRun(input: {
  rows: CartRow[] | null;
  reportedAdded: string[];
  active: IntendedItem[];
  reconcileIntended: IntendedItem[];
  countBefore: number | null;
  countAfter: number | null;
  explainedRows?: string[];
  /** Cart rows the user added by hand during a manual pass — see
   *  compareCartToIntended's userAddedRows. */
  userAddedRows?: string[];
  /** Ingredients the user passed over at review. They were never attempted, so
   *  the cart not having them is the outcome they asked for — see notInCart. */
  skippedNames?: string[];
}): CartCheckFindings {
  const { rows, reportedAdded, active, reconcileIntended, countBefore, countAfter } = input;
  const explainedRows = input.explainedRows ?? [];
  const userAddedRows = input.userAddedRows ?? [];
  const skippedNames = input.skippedNames ?? [];
  let missing: string[] = [];
  let short: ShortAdd[] = [];
  let over: OverAdd[] = [];
  let recovered: RecoveredAdd[] = [];
  // The full set the run meant to add. After a parallel top-up `active` is
  // only the retry subset, so the reconcile's snapshot is preferred; the
  // serial path never reconciles and falls back to its (unnarrowed) active set.
  // Hoisted out of the `rows` branch: the count-shortfall check below needs the
  // requested quantities on the header-badge stores too, and those never have rows.
  const intendedAll = reconcileIntended.length > 0 ? reconcileIntended : active;
  if (rows) {
    const addedRows = rows.filter((r) => r.added);
    missing = findUnaddedItems(reportedAdded, addedRows.map((r) => r.name));
    // ONE claim over the added rows, split two ways (see splitCartLeftover).
    // Computing these separately let a single cart unit be reported as both a
    // recovery and an over-add — the same product named twice on the done
    // screen, "don't add it again" beside "nothing intended it".
    ({ over, recovered } = splitCartLeftover(addedRows, reportedAdded, intendedAll));
    // Rows the run already reports by name as unverified are accounted for, not
    // unintended — see dropExplainedOverAdds. Filtered here rather than inside
    // splitCartLeftover so the partition stays a partition: the row is still
    // consumed as nothing's claim, it just isn't ALSO called unwanted.
    over = dropExplainedOverAdds(over, explainedRows);
    // Only audit items we reported as added (failures already route to review),
    // skip sold-by-weight ITEMS (presence, not count — see isWeightPriced), and
    // skip fully-missing items (covered by `missing`). The weight ROWS are
    // dropped by findShortAddedItems itself: filtering only the items here left a
    // weight line countable as a unit, and one deli line was reported short AND
    // over at the same time.
    const auditItems = active.filter((a) =>
      !a.isWeight
      && reportedAdded.some((n) => cartNameMatches(a.name, n))
      && !missing.some((n) => cartNameMatches(a.name, n)),
    );
    short = findShortAddedItems(addedRows, auditItems);
  }
  // UNITS expected in the cart, not distinct products (MEAL-178). `countBefore`
  // and `countAfter` are unit totals — every cart counter sums line quantities —
  // so measuring `expected` in products made the comparison blind in one
  // direction. A run that added 2 products, one of them requested ×2, expects 3
  // units; if only 1 unit of that product landed the delta is 2 and the old
  // expected was also 2, so `2 < 2` was false and nothing warned. That is the
  // MEAL-185 multi-qty under-add shape, and this backstop could not see it.
  const expected = unitsForNames(reportedAdded, intendedAll);
  const clean = missing.length === 0 && short.length === 0 && over.length === 0;
  return {
    missing,
    short,
    over,
    overUnits: over.reduce((n, o) => n + o.qty, 0),
    recovered,
    countShortfall:
      clean && countBefore != null && countAfter != null && expected > 0 && countAfter - countBefore < expected
        ? { delta: Math.max(countAfter - countBefore, 0), expected }
        : null,
    cartRead: rows != null,
    comparison: rows
      ? compareCartToIntended({
          addedRows: rows.filter((r) => r.added),
          intended: intendedAll,
          skippedNames,
          userAddedRows,
        })
      : { short: [], extra: [] },
  };
}

// ── The one thing the done screen says (MEAL-199) ───────────────────────────
//
// Before this, the done screen carried two warnings from two observers: "Could
// not add: X", sourced from the run's own per-item reports, and a cart-check
// banner sourced from the before/after snapshot diff. The second existed because
// the first is known to lie, which made them a claim and its own rebuttal
// printed as peers, and left the user to work out which to believe.
//
// The snapshot is the source of truth. This builds the single message from it,
// and the run's reports are consulted in exactly one case: when there is no
// snapshot to read, where saying so out loud beats quietly reverting to the
// weaker source (MEAL-190 established `unverified` as its own outcome for the
// same reason).
//
// CONSERVATISM IS A REQUIREMENT, NOT A STYLE. The original snapshot check
// (`e5d92da`, 2026-06-12) recorded its own safety property: "the comparison can
// only under-warn, never false-positive." Promoting the snapshot to sole arbiter
// makes its false positives the only thing a user sees, so that property is
// restored here deliberately — every clause below reports what the cart SHOWS,
// and nothing is inferred from a silence.

/** Cart-check copy for one over-added product: bare name, or "name ×N". */
function overLabel(o: OverAdd): string {
  return o.qty > 1 ? `${o.name} ×${o.qty}` : o.name;
}

/** One product the cart is short on. */
export interface ShortProduct {
  name: string;
  expected: number;
  got: number;
}

export interface SnapshotComparison {
  /** Products the after-snapshot does not fully account for. `got === 0` means
   *  the cart shows none of it. */
  short: ShortProduct[];
  /** Units the cart gained that no intended product accounts for. */
  extra: { name: string; qty: number }[];
}

/**
 * The whole comparison, as Stephen specified it (MEAL-199):
 *
 *   We are supposed to add 12 units of 10 products. Snapshot the cart before,
 *   snapshot it at the very end, compare products and their units, matching by
 *   EXACT name. Weight is matched as weight. Products skipped during reconcile
 *   are not considered.
 *
 * `addedRows` is already that before/after comparison — diffCartItems keys rows
 * by exact title and returns the delta, so every row here is a unit this run put
 * in the cart. What this adds is the other half: matching that delta against the
 * products we chose, again by exact title.
 *
 * WHY THE SEARCH TERM IS THE RIGHT NAME TO MATCH ON. The add path finds a
 * product card by EXACT name (`heb.ts` and its siblings; `scoreMatch` must
 * return 100 for the add gate to fire), so the title that reaches the cart is
 * the term we searched for. `IntendedItem.name` is therefore not an approximate
 * label for the product — it is the product's title, and equality against a cart
 * row is a fair comparison rather than a lucky one.
 *
 * WHY EXACT AND NOTHING ELSE. The claim passes this replaces match with
 * `cartNameMatches`, a 60% token overlap, and every false statement the cold
 * review found came out of that leniency: "Bananas" swallowing "Bananas
 * Organic", a substitute sharing no tokens with its search term landing in two
 * clauses of one sentence about one product. A looser matcher cannot be made
 * safe by filtering its output, because the mistakes are indistinguishable from
 * findings. Exact equality has one failure mode, it is inspectable, and it fails
 * toward silence: a title that does not match is a product we do not claim
 * anything about.
 *
 * Weight lines are matched by presence, not units — one line at N lb has no unit
 * count, which is the same rule every cart counter and MEAL-178 already apply.
 */
export function compareCartToIntended(input: {
  /** The before/after delta — diffCartItems' added rows. */
  addedRows: CartRow[];
  intended: IntendedItem[];
  /** Ingredients passed over at review. Never considered. */
  skippedNames?: string[];
  /**
   * Cart rows the USER put there by hand (MEAL-197), which nothing in the run
   * intended and nothing in the run should be asked to account for. Dropped
   * from the pool outright.
   *
   * Deliberately NOT `explainedRows`, which is the opposite case: a weight row
   * IS its intended item and has to stay in the pool to settle it — dropping
   * those makes the item read as absent.
   */
  userAddedRows?: string[];
}): SnapshotComparison {
  const { intended } = input;
  const skippedNames = input.skippedNames ?? [];
  const userAddedRows = input.userAddedRows ?? [];
  const addedRows = userAddedRows.length === 0
    ? input.addedRows
    : input.addedRows.filter((r) => !userAddedRows.some((u) => normalizeName(u) === normalizeName(r.name)));
  const isSkipped = (item: IntendedItem) =>
    skippedNames.some((s) => normalizeName(s) === normalizeName(item.name));

  const countPool = addedRows.filter((r) => !r.isWeight).map((r) => ({ name: r.name, qty: r.qty }));
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
  const considered = intended.filter((i) => !isSkipped(i));

  const short: ShortProduct[] = [];
  for (const item of considered) {
    const presenceOnly = item.isWeight || item.weightStepLb != null;
    const expected = presenceOnly ? 1 : Math.max(1, item.expectedQty || 1);
    let got = 0;
    if (presenceOnly) {
      const w = weightPool.find((p) => !p.used && normalizeName(p.name) === normalizeName(item.name));
      if (w) { w.used = true; got = 1; }
    } else {
      for (const rowEntry of countPool) {
        if (got >= expected) break;
        if (rowEntry.qty <= 0) continue;
        if (normalizeName(rowEntry.name) !== normalizeName(item.name)) continue;
        const take = Math.min(rowEntry.qty, expected - got);
        rowEntry.qty -= take;
        got += take;
      }
    }
    if (got < expected) short.push({ name: item.name, expected, got });
  }

  const extra: { name: string; qty: number }[] = [];
  for (const rowEntry of countPool) if (rowEntry.qty > 0) extra.push({ name: rowEntry.name, qty: rowEntry.qty });
  for (const w of weightPool) if (!w.used) extra.push({ name: w.name, qty: 1 });
  return { short, extra };
}

function joinNames(names: string[]): string {
  return names.join(', ');
}

export interface CartVerdict {
  /**
   * Items to name on the done screen as not in the cart. Cart-sourced when
   * `cartBacked`, otherwise the run's own claim about itself.
   */
  notAdded: string[];
  /** The single message, or null when there is nothing to tell the user. */
  message: string | null;
  /** The verdict WITHOUT the product names — how many, and that something needs
   *  attention. Never collapsed by the banner (MEAL-176). Null with `message`. */
  title: string | null;
  /** The product names, one labelled line per finding. The part the banner folds
   *  away. Empty string when there is nothing to list (a badge-only shortfall,
   *  or the everything-is-there message). */
  detail: string;
  /** True when the message rests on a cart read. False means it rests on the
   *  run's own reporting and says so. */
  cartBacked: boolean;
}

/**
 * The done screen's whole verdict, in one place.
 *
 * `recovered` deliberately produces no copy. It names items the run called
 * failed that the cart shows are present — advice not to re-add them only ever
 * made sense as a rebuttal of a failure line sourced from the run. With the
 * failure list now read off the cart, such an item is never called failed in the
 * first place, so there is nothing to take back. It stays in the findings
 * because it measures how often the confirmation rail lies, which is MEAL-47's
 * subject and belongs on the funnel rather than on a kitchen counter.
 */
export function buildCartVerdict(input: {
  storeName: string;
  findings: CartCheckFindings;
  /** The run's own failed list. Consulted only when the cart was not read. */
  reportedFailed: string[];
  /** Non-null when the cart could not be read at all — see MEAL-190. */
  unreadReason: string | null;
}): CartVerdict {
  const { storeName, findings, reportedFailed, unreadReason } = input;

  // No cart read. The run's own failed list is all there is, and it is returned
  // UNPROMOTED: `cartBacked` false is what tells the screen this is the run
  // talking about itself, so it can keep saying so plainly instead of dressing a
  // guess as a finding.
  //
  // `message` is deliberately null rather than a "we could not check your cart"
  // sentence. That copy already exists and is already rendered — MEAL-190 owns
  // it, holds it in its own state, and distinguishes the ways a read can fail.
  // Returning a second version here would either clobber that one (the done
  // screen prefers this message when both are set) or print beside it, which is
  // the two-sources-one-screen defect this function exists to end, rebuilt in
  // the one case where the cart never spoke at all.
  if (!findings.cartRead || unreadReason) {
    // One thing still gets through without rows: the badge count. A header-badge
    // store has no per-item data ever, and the shortfall check is the only cart
    // evidence it can produce — returning early past it made the warning
    // unreachable in precisely the case it was written for.
    //
    // It does NOT make this verdict cart-backed. A count says something is
    // short; it cannot say WHICH item, so the run's own failed list stays on
    // screen rather than being replaced by a per-item verdict nobody can build.
    const shortfall = findings.countShortfall;
    const unreadMsg = shortfall
      ? `We checked your ${storeName} cart: it went up by ${shortfall.delta} item${shortfall.delta === 1 ? '' : 's'} where ${shortfall.expected} ${shortfall.expected === 1 ? 'was' : 'were'} expected. Please double-check it before checking out.`
      : unreadReason;
    return {
      notAdded: reportedFailed.filter((n) => n.trim() !== ''),
      cartBacked: false,
      message: unreadMsg,
      title: unreadMsg,
      detail: '',
    };
  }

  // One comparison decides everything below: the products we meant to add and
  // their units, against the products the cart gained and their units, matched
  // by exact name. `absent` and `short` are the same finding at two depths —
  // nothing of it arrived, or some of it did.
  const comparison = findings.comparison;
  const absent = comparison.short.filter((s) => s.got === 0);
  const partial = comparison.short.filter((s) => s.got > 0);
  const clauses: string[] = [];
  // The same findings said twice, on purpose (MEAL-176). `clauses` name every
  // product inline and become `message`, which is what the funnel and the tests
  // read. `summaries` and `details` are the same facts split at the seam the
  // banner collapses on: the VERDICT — how many, and that something needs
  // attention — must survive collapsing, and only the LIST may fold away. A
  // single blob cannot be elided that way without hiding the fact that anything
  // is wrong, which is the one thing this banner exists to say.
  const summaries: string[] = [];
  const details: string[] = [];

  if (absent.length > 0) {
    // "Mealio could not add X", never "X is not in your cart".
    //
    // The comparison measures what this run ADDED — the delta between the two
    // snapshots — so a zero says we put nothing there. It does not say the cart
    // is empty of it: the user may well have had that product before we started,
    // in which case it is sitting in their cart right now and a sentence
    // claiming otherwise sends them to buy a second one. What we always know is
    // what we did, so that is what we say.
    const names = joinNames(absent.map((s) => s.name));
    clauses.push(absent.length === 1
      ? `Mealio could not add ${names}`
      : `Mealio could not add ${absent.length} items (${names})`);
    summaries.push(absent.length === 1 ? 'Mealio could not add 1 item' : `Mealio could not add ${absent.length} items`);
    details.push(`Could not add: ${names}`);
  }
  if (partial.length > 0) {
    const detail = partial.map((s) => `${s.name} (${s.got} of ${s.expected})`).join(', ');
    clauses.push(`${partial.length} item${partial.length === 1 ? '' : 's'} came up short — ${detail} — which a store limit can cause`);
    summaries.push(`${partial.length} item${partial.length === 1 ? '' : 's'} came up short, which a store limit can cause`);
    details.push(`Came up short: ${detail}`);
  }
  if (comparison.extra.length > 0) {
    const units = comparison.extra.reduce((n, e) => n + e.qty, 0);
    const names = joinNames(comparison.extra.map(overLabel));
    clauses.push(`your cart has ${units} item${units === 1 ? '' : 's'} Mealio did not add (${names})`);
    summaries.push(`your cart has ${units} item${units === 1 ? '' : 's'} Mealio did not add`);
    details.push(`Mealio did not add: ${names}`);
  }
  // Header-badge stores have no rows to name, so the count is all there is. Only
  // reachable when the per-item lists are empty — see countShortfall's own note.
  if (clauses.length === 0 && findings.countShortfall) {
    const { delta, expected } = findings.countShortfall;
    const shortfall = `your cart went up by ${delta} item${delta === 1 ? '' : 's'} where ${expected} were expected`;
    clauses.push(shortfall);
    // Nothing to fold: a badge-only store has no product names to list.
    summaries.push(shortfall);
  }

  // Nothing wrong with the cart — but silence is only safe if the rest of the
  // screen is telling the truth, and on a fully-recovered run it is not.
  //
  // The shape: a stale badge fails every worker, the after-probe reads the cart,
  // and everything is there. Nothing is absent, short or unintended, so there is
  // no warning to print — while the headline, driven by the run's own confirmed
  // count, still says "No items were added." That headline is itself a
  // run-sourced failure claim, and dropping `recovered`'s copy removed the only
  // thing that ever contradicted it. The user re-adds a full cart by hand.
  //
  // So the cart speaks up when it disagrees with the run in the GOOD direction
  // too. Deliberately not phrased as "we added them": a recovery is a name match
  // against a cart row, which is enough to say the row is there and not enough
  // to claim this run put it there (see RecoveredAdd.matchQuality, and MEAL-177,
  // which declined to promote recoveries into the added count for this reason).
  if (clauses.length === 0 && findings.recovered.length > 0) {
    const names = joinNames(findings.recovered.map((r) => r.cartName || r.name));
    const okTitle = `We checked your ${storeName} cart and everything you asked for is there — no need to add ${findings.recovered.length === 1 ? 'it' : 'them'} again.`;
    return {
      notAdded: [],
      cartBacked: true,
      message: `We checked your ${storeName} cart and everything you asked for is there, including ${names} — no need to add ${findings.recovered.length === 1 ? 'it' : 'them'} again.`,
      title: okTitle,
      detail: `Already there: ${names}`,
    };
  }

  return {
    notAdded: absent.map((s) => s.name),
    cartBacked: true,
    message: clauses.length === 0
      ? null
      : `We checked your ${storeName} cart: ${clauses.join('; ')}. Please double-check it before checking out.`,
    title: summaries.length === 0
      ? null
      : `We checked your ${storeName} cart: ${summaries.join('; ')}. Please double-check it before checking out.`,
    detail: details.join('\n'),
  };
}
