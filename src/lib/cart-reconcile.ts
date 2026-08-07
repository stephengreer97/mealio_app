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
}

/** The fields reconcile reads off a cart-run ingredient. Structurally satisfied
 *  by ConsolidatedIngredient. */
export interface ReconcilableItem extends WeightPricedFields {
  ingredientName: string;
  searchTerm?: string | null;
  productQty?: number;
}

/** Reduce a cart-run ingredient to what reconcile compares: the title it is
 *  matched by, the units requested (never below 1 — saved meal data can leak a
 *  zero qty), and whether it is weight-priced. */
export function toIntendedItem(item: ReconcilableItem): IntendedItem {
  return {
    name: item.searchTerm || item.ingredientName,
    expectedQty: Math.max(1, item.productQty || 1),
    isWeight: isWeightPriced(item),
  };
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
 *  the user for review rather than to the top-up. */
export type DefiniteFailureReason = 'out_of_stock' | 'no_results';

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
    claimed: number;
    confirmedWeight: boolean;
  }[] = [];
  attempts.forEach((attempt, index) => {
    const r = attempt.report;
    if (r && !r.success && (r.reason === 'out_of_stock' || r.reason === 'no_results')) {
      definiteFailures.push({ index, reason: r.reason });
      return;
    }
    toMatch.push({
      index,
      name: decodeHtmlEntities((r && r.productName) || attempt.name),
      expectedQty: Math.max(1, attempt.expectedQty || 1),
      isWeight: attempt.isWeight,
      claimed: 0,
      confirmedWeight: false,
    });
  });
  const intended: IntendedItem[] = toMatch.map((m) => ({
    name: m.name,
    expectedQty: m.expectedQty,
    isWeight: m.isWeight,
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
  // no weight rows, so it claims nothing and reports its full shortfall. That is
  // the deliberate choice, and it is the recoverable direction: a shortfall costs
  // a re-add the user watches happen, whereas confirming a ×3 count item off one
  // weight line hands them a single unit and tells them the order landed. The
  // disagreement is not swallowed either — no weight-priced item claimed the row,
  // so findOverAddedItems returns it in `overAdds` and both sides are announced.
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
  toMatch.forEach((m) => {
    if (!m.isWeight) return;
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, m.name));
    if (w) { w.used = true; m.confirmedWeight = true; }
  });
  // Count items only, out of the count pool. Pass 1: every item reserves its
  // exact-name units. Pass 2: items still short take loose matches from whatever
  // remains unclaimed.
  toMatch.forEach((m) => { if (!m.isWeight) m.claimed = claimQty(m.name, m.expectedQty, true); });
  toMatch.forEach((m) => { if (!m.isWeight && m.claimed < m.expectedQty) m.claimed += claimQty(m.name, m.expectedQty - m.claimed, false); });

  const confirmed: { index: number; name: string }[] = [];
  const topUps: { index: number; shortfall: number }[] = [];
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
    if (shortfall <= 0) confirmed.push({ index: m.index, name: m.name });
    else topUps.push({ index: m.index, shortfall });
  });

  const overAdds = findOverAddedItems(addedRows, intended);
  return {
    confirmed,
    topUps,
    definiteFailures,
    intended,
    overAdds,
    overAddUnits: overAdds.reduce((n, o) => n + o.qty, 0),
  };
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
 * better to trust. Parallel add is HEB-only today — a per-item cart store — so
 * this is a safety fallback, not the normal path.
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
 * choose-a-product flow, or every item skipped during review — has no signal to
 * find, and a cart read costs a real page load on a store that is watching for
 * automation. `addsAttempted` is the count of items that reached an add click,
 * which is also the funnel's `add_click` denominator.
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
}

/** Did the run report adding this item? Matched in BOTH directions on purpose:
 *  the intended title is a search term ("sour cream") while a reported title is
 *  the store's product name ("Daisy Pure & Natural Sour Cream, 16 oz"), and
 *  cartNameMatches only asks whether the second argument's tokens are present in
 *  the first. Reading it one way alone would classify half the reported items as
 *  unreported. Erring towards "reported" is the safe direction here: it costs a
 *  recovery we don't announce, never a false "it's already in your cart". */
function wasReported(item: IntendedItem, reportedAdded: string[]): boolean {
  return reportedAdded.some(
    (n) => cartNameMatches(item.name, n) || cartNameMatches(n, item.name),
  );
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
 */
export function auditCartAfterRun(input: {
  rows: CartRow[] | null;
  reportedAdded: string[];
  active: IntendedItem[];
  reconcileIntended: IntendedItem[];
  countBefore: number | null;
  countAfter: number | null;
}): CartCheckFindings {
  const { rows, reportedAdded, active, reconcileIntended, countBefore, countAfter } = input;
  let missing: string[] = [];
  let short: ShortAdd[] = [];
  let over: OverAdd[] = [];
  let recovered: RecoveredAdd[] = [];
  if (rows) {
    const addedRows = rows.filter((r) => r.added);
    missing = findUnaddedItems(reportedAdded, addedRows.map((r) => r.name));
    // The full set the run meant to add. After a parallel top-up `active` is
    // only the retry subset, so the reconcile's snapshot is preferred; the
    // serial path never reconciles and falls back to its (unnarrowed) active set.
    const intendedAll = reconcileIntended.length > 0 ? reconcileIntended : active;
    // ONE claim over the added rows, split two ways (see splitCartLeftover).
    // Computing these separately let a single cart unit be reported as both a
    // recovery and an over-add — the same product named twice on the done
    // screen, "don't add it again" beside "nothing intended it".
    ({ over, recovered } = splitCartLeftover(addedRows, reportedAdded, intendedAll));
    // Only audit items we reported as added (failures already route to review),
    // skip sold-by-weight lines (one row at N lb, not count-comparable), and
    // skip fully-missing items (covered by `missing`).
    const auditItems = active.filter((a) =>
      !a.isWeight
      && reportedAdded.some((n) => cartNameMatches(a.name, n))
      && !missing.some((n) => cartNameMatches(a.name, n)),
    );
    short = findShortAddedItems(addedRows, auditItems);
  }
  const expected = reportedAdded.length;
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
  };
}
