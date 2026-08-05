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
}

/** Failure reasons that are definitive: the item is genuinely not in the cart
 *  and re-running the same search would only fail the same way, so it goes to
 *  the user for review rather than to the top-up. */
export type DefiniteFailureReason = 'out_of_stock' | 'no_results';

/**
 * One item the parallel pass attempted, paired with its worker's report.
 *
 * The inherited `name` is only the FALLBACK title: when the worker reported a
 * product name, that name is what identifies the item in the cart. `isWeight`
 * feeds the intended snapshot — whether an item is confirmed by presence is
 * decided by the cart ROW, not by this flag.
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
  const pool = addedRows.map((row) => ({ name: row.name, qty: row.qty }));
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

  // Weight rows first, confirmed by PRESENCE (see isWeightPriced). Matching is
  // driven by the CART ROW rather than by the item's own isWeight: whatever the
  // intent said, a row the store sells by weight is one line at N lb and cannot
  // be count-compared. Consume the row so a sibling can't claim it too.
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
  toMatch.forEach((m) => {
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, m.name));
    if (w) { w.used = true; m.confirmedWeight = true; }
  });
  // Pass 1: every item reserves its exact-name units. Pass 2: items still short
  // take loose matches from whatever remains unclaimed.
  toMatch.forEach((m) => { if (!m.confirmedWeight) m.claimed = claimQty(m.name, m.expectedQty, true); });
  toMatch.forEach((m) => { if (!m.confirmedWeight && m.claimed < m.expectedQty) m.claimed += claimQty(m.name, m.expectedQty - m.claimed, false); });

  const confirmed: { index: number; name: string }[] = [];
  const topUps: { index: number; shortfall: number }[] = [];
  toMatch.forEach((m) => {
    if (m.confirmedWeight) { confirmed.push({ index: m.index, name: m.name }); return; }
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

export interface WorkerReportOutcome {
  confirmed: { index: number; name: string }[];
  failed: { index: number; name: string }[];
}

/**
 * The reconcile decision when the cart gave no per-item data to diff against
 * (a header-badge store): trust the worker results, because there is nothing
 * better to trust. Parallel add is HEB-only today — a per-item cart store — so
 * this is a safety fallback, not the normal path.
 */
export function reconcileFromWorkerReports(attempts: AttemptedAdd[]): WorkerReportOutcome {
  const confirmed: { index: number; name: string }[] = [];
  const failed: { index: number; name: string }[] = [];
  attempts.forEach((attempt, index) => {
    const r = attempt.report;
    if (r && r.success) confirmed.push({ index, name: r.productName || attempt.name });
    else failed.push({ index, name: attempt.name });
  });
  return { confirmed, failed };
}

// ── After-run cart check ──────────────────────────────────────────────────────

export interface CartCheckFindings {
  /** Reported as added, but no cart row bears the name — a silent miss. */
  missing: string[];
  /** Present in the cart but with fewer units than requested (e.g. a store
   *  per-item cap accepted 2 of 3). */
  short: ShortAdd[];
  /** Cart units no intended item accounts for. */
  over: OverAdd[];
  /** Total units across `over`. */
  overUnits: number;
  /**
   * Fallback shortfall for stores with no per-item cart data (header badge
   * only), or when names didn't resolve: the badge rose by less than the number
   * of items reported added. Null whenever there are per-item findings above —
   * those are strictly more specific, and the caller reports them instead.
   */
  countShortfall: { delta: number; expected: number } | null;
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
  if (rows) {
    const addedRows = rows.filter((r) => r.added);
    missing = findUnaddedItems(reportedAdded, addedRows.map((r) => r.name));
    over = findOverAddedItems(addedRows, reconcileIntended.length > 0 ? reconcileIntended : active);
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
    countShortfall:
      clean && countBefore != null && countAfter != null && expected > 0 && countAfter - countBefore < expected
        ? { delta: Math.max(countAfter - countBefore, 0), expected }
        : null,
  };
}
