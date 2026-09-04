// Comparing two carts.
//
// Reading one is a store's own business — its rail asks for it, or, on the one
// store with no rail, its own cartPage script reads it. What arrives here is the
// answer, in one shape: { type: 'CART_COUNT', count, items }.
//
// count === null means UNKNOWN — nobody could read the cart. Callers must treat
// null as unknown and SKIP validation, never warn. The converse is the
// load-bearing half: any NUMBER is trusted, so nothing may emit one it is not
// sure of.
//
// NOTHING IN THIS FILE KNOWS WHICH STORE IT IS LOOKING AT, and that is the
// property worth protecting. It used to: a badge selector per store, a cart-page
// reader per store, a URL table, a remote override and a page-identity guard,
// all in a file every store imports — about 900 lines where one store's cart bug
// had every other store's run in reach. See the note at the bottom for where
// each piece went.

export function isCountedCartSnapshot(
  snapshot: { count: number | null } | null | undefined,
): boolean {
  return typeof snapshot?.count === 'number';
}

export interface CartItem {
  name: string;
  qty: number;
  /**
   * The store's own id for this cart line, where the read can see one.
   *
   * Absent on every page-read row and on stores whose cart read is name-only,
   * which is why nothing may REQUIRE it. It exists so a baseline can be handed
   * to a write without a second cart request -- and a write addresses lines by
   * id, so a baseline keyed by name would silently look up nothing, find no
   * held quantity, and SET a line the user already had down to what this run
   * asked for. See the guard in netStartAdds.
   */
  itemId?: string;
  /** Sold-by-weight line (HEB Deli / Fish Market / bulk). qty is 1 (present);
   *  weight carries the lb amount. Reconciled by presence, not discrete count. */
  isWeight?: boolean;
  weight?: number;
  /** The weights this line could have been set to, in lb — the row's own option
   *  ladder (MEAL-148). Absent on stores whose cart read doesn't emit it, and on
   *  a row read from the a11y text rather than a <select>. */
  weightOptions?: number[];
}

export interface CartRow {
  name: string;
  qty: number;
  /** true = added by this run (green +), false = already in the cart (grey). */
  added: boolean;
  isWeight?: boolean;
  /** Pounds ON THE LINE — the cart's total, not this run's contribution. What the
   *  done screen shows, because that is what the user's cart says. */
  weight?: number;
  weightOptions?: number[];
  /**
   * Pounds THIS RUN added to the line: the after weight less the before weight
   * (MEAL-148). Set on added weight rows only.
   *
   * Reconcile must compare against this and not `weight`: a user who already had
   * 0.25 lb of deli beef in their cart and asked Mealio for 0.5 lb ends on a line
   * reading 0.75 lb, and checking the requested weight against the LINE would
   * call a run that added nothing at all a success. Always > 0 where it is set,
   * because a weight row is only green when the line grew.
   */
  addedWeight?: number;
}

/**
 * Diff a before/after cart snapshot into display rows for the done screen.
 * The portion of each product that was already in the cart is an "already
 * there" (grey) row; any quantity this run added is an "added" (green +) row.
 * A product whose qty rose yields BOTH a grey row (pre-existing qty) and a
 * green row (added qty). Added rows are listed first. Items that left the cart
 * during the run are omitted.
 */
// Store cart pages sometimes emit product titles with HTML entities left
// literal (e.g. a double-encoded "Chobani&reg;" whose text node is the string
// "Chobani&reg;", not "Chobani®"). Left as-is they show as "&reg;" on the done
// screen AND poison name matching (the entity tokenizes to a spurious "reg"
// word). Decode the common ones plus any numeric entity. No DOM here (this runs
// in RN as well as in-page), so it's a small explicit map.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  reg: '®', trade: '™', copy: '©', deg: '°', hellip: '…',
  mdash: '—', ndash: '–', minus: '−', times: '×', frac12: '½', frac14: '¼', frac34: '¾',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è',
};
export function decodeHtmlEntities(s: string): string {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit !== undefined ? hit : m;
  });
}

function cartTokens(s: string): string[] {
  return decodeHtmlEntities(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Entity- and punctuation-insensitive normalization for EXACT name comparison.
 *  "McCormick Gourmet, Organic…" and "McCormick Gourmet Organic…" collapse to the
 *  same string so a product reliably matches its own cart row before a loosely
 *  similar sibling can. */
export function normalizeName(s: string): string {
  return decodeHtmlEntities(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Lenient match between a store cart title and a product name Mealio added.
 *  True when most of the reported name's tokens appear in the cart name (or
 *  vice versa) — tolerant of weight/size suffixes and minor title differences. */
export function cartNameMatches(cartName: string, reportedName: string): boolean {
  const ct = cartTokens(cartName);
  const rt = cartTokens(reportedName);
  if (rt.length === 0 || ct.length === 0) return false;
  const cset = new Set(ct);
  const overlap = rt.filter((t) => cset.has(t)).length;
  return overlap / rt.length >= 0.6;
}

/**
 * Given the product names Mealio reported as successfully added and the names
 * of the items that ACTUALLY appeared as new in the cart, return the reported
 * names with no matching cart item — i.e. the ones that silently failed to add.
 */
export function findUnaddedItems(reportedAdded: string[], addedCartNames: string[]): string[] {
  return reportedAdded.filter(
    (rn) => !addedCartNames.some((cn) => cartNameMatches(cn, rn)),
  );
}

export interface ShortAdd {
  name: string;
  /** Units this run actually added to the cart. */
  got: number;
  /** Units that were requested. */
  expected: number;
}

/**
 * Audit added cart quantities against what was requested and return the items
 * that landed SHORT — present in the cart but with fewer units than asked for
 * (e.g. a store per-item cap accepted 2 of 3). Fully-missing items (got 0) are
 * excluded here; they're covered by findUnaddedItems.
 *
 * `addedRows` are the added (green) rows from diffCartItems, whose `qty` is the
 * delta this run added. Each added unit is attributed to a SINGLE audited item
 * via a shared pool — exact-name matches reserved first, then loose matches take
 * whatever remains — so two near-identical product names can't both claim the
 * same row and hide a shortfall.
 *
 * Sold-by-weight rows are dropped from the pool, not left to the caller. This is
 * a UNIT-COUNT comparison and a weight line carries no unit count: diffCartItems
 * emits it as qty 1 whatever the poundage, so counting it as "1 unit" is a made-up
 * number. Filtering here rather than at the call site because the two sides of
 * the comparison have to agree about which rows exist, and only this function
 * knows it is counting units — auditCartAfterRun filtered the ITEM side only
 * (`!a.isWeight`) and still handed over every row, so a stepper-weight deli line
 * was reported as `short: got 1, expected 3` by this pool AND as `over: qty 1` by
 * splitCartLeftover, which cannot claim a weight row for a count item. One
 * physical line, two contradictory findings about it. See findOverAddedItems,
 * which has always split the pools internally for the same reason.
 */
export function findShortAddedItems(
  addedRows: CartRow[],
  audit: { name: string; expectedQty: number }[],
): ShortAdd[] {
  const pool = addedRows.filter((row) => !row.isWeight).map((row) => ({ name: row.name, qty: row.qty }));
  const claimQty = (reportedName: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of pool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly ? normalizeName(row.name) === normalizeName(reportedName) : cartNameMatches(row.name, reportedName);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };
  const state = audit.map((a) => ({ name: a.name, expected: Math.max(1, a.expectedQty || 1), got: 0 }));
  // Pass 1 reserves exact-name units for every item; pass 2 lets those still
  // short take remaining loose matches, so a loose match can't steal units an
  // exact match needed.
  state.forEach((s) => { s.got = claimQty(s.name, s.expected, true); });
  state.forEach((s) => { if (s.got < s.expected) s.got += claimQty(s.name, s.expected - s.got, false); });
  return state
    .filter((s) => s.got > 0 && s.got < s.expected)
    .map((s) => ({ name: s.name, got: s.got, expected: s.expected }));
}

/**
 * Units that landed in the cart this run that NO intended item accounts for —
 * over-adds (a product added more times than requested) or an entirely
 * unintended product. A safety net: even if a future bug re-adds something, the
 * cart check surfaces it rather than trusting the run silently.
 *
 * Each intended item claims matching added units first (exact name, then loose,
 * capped at its expected qty); whatever added units remain unclaimed are the
 * overage. Weight lines are presence-based (one row regardless of poundage), so
 * an intended weight item consumes at most one matching weight row.
 *
 * An INCREMENT-STYLE item (`weightStepLb` — counted in units, priced by weight,
 * added by clicking an increment N times) may consume one too, once the count
 * pool has come up short for it. Its units are physically ON that line, so a line
 * it explains is not a line "nothing intended": before MEAL-148 that row was
 * reported as an over-add and the caller had to un-report it by name, which is
 * one warning talking the user into deleting a thing they asked for. Only after
 * the count passes, and only one row, so it can neither pre-empt an exact count
 * match nor absorb two lines.
 */
export function findOverAddedItems(
  addedRows: CartRow[],
  intended: { name: string; expectedQty: number; isWeight?: boolean; weightStepLb?: number }[],
): { name: string; qty: number }[] {
  const countPool = addedRows.filter((r) => !r.isWeight).map((r) => ({ name: r.name, qty: r.qty }));
  const weightPool = addedRows.filter((r) => r.isWeight).map((r) => ({ name: r.name, used: false }));
  const claim = (name: string, need: number, exactOnly: boolean): number => {
    let got = 0;
    for (const row of countPool) {
      if (got >= need) break;
      if (row.qty <= 0) continue;
      const match = exactOnly ? normalizeName(row.name) === normalizeName(name) : cartNameMatches(row.name, name);
      if (match) { const take = Math.min(row.qty, need - got); row.qty -= take; got += take; }
    }
    return got;
  };
  // Weight items consume one matching weight row by presence.
  for (const it of intended.filter((i) => i.isWeight)) {
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, it.name));
    if (w) w.used = true;
  }
  // Count items: exact pass then loose pass, capped at each item's expected qty,
  // so a legitimately-requested unit never counts as overage.
  const need = intended
    .filter((i) => !i.isWeight)
    .map((i) => ({ name: i.name, left: Math.max(1, i.expectedQty || 1), increment: i.weightStepLb != null }));
  need.forEach((n) => { n.left -= claim(n.name, n.left, true); });
  need.forEach((n) => { if (n.left > 0) n.left -= claim(n.name, n.left, false); });
  // Increment items last: their units live on a weight line, not in the count
  // pool (see above).
  need.forEach((n) => {
    if (!n.increment || n.left <= 0) return;
    const w = weightPool.find((p) => !p.used && cartNameMatches(p.name, n.name));
    if (w) { w.used = true; n.left = 0; }
  });
  const over: { name: string; qty: number }[] = [];
  for (const row of countPool) if (row.qty > 0) over.push({ name: row.name, qty: row.qty });
  for (const w of weightPool) if (!w.used) over.push({ name: w.name, qty: 1 });
  return over;
}

export function diffCartItems(beforeRaw: CartItem[], afterRaw: CartItem[]): CartRow[] {
  // Decode HTML entities up front so both the qty matching (by name) and the
  // rendered rows use clean titles ("Chobani®", not "Chobani&reg;").
  const before = beforeRaw.map((it) => ({ ...it, name: decodeHtmlEntities(it.name) }));
  const after = afterRaw.map((it) => ({ ...it, name: decodeHtmlEntities(it.name) }));
  const beforeQty = new Map<string, number>();
  const beforeWeight = new Map<string, number>();
  for (const it of before) {
    beforeQty.set(it.name, (beforeQty.get(it.name) || 0) + it.qty);
    if (it.isWeight && typeof it.weight === 'number') {
      beforeWeight.set(it.name, (beforeWeight.get(it.name) || 0) + it.weight);
    }
  }
  const green: CartRow[] = [];
  const grey: CartRow[] = [];
  for (const it of after) {
    // Sold-by-weight lines carry qty:1 (present/absent), so the qty diff always
    // yields greenQty=0 and mislabels a freshly added/topped-up weight line as
    // "already in cart". Classify by weight instead: a line that's new, or
    // heavier than the before snapshot, was added/increased by this run.
    if (it.isWeight) {
      const bw = beforeWeight.get(it.name) || 0;
      const aw = typeof it.weight === 'number' ? it.weight : 0;
      const added = !beforeWeight.has(it.name) || aw > bw;
      // `addedWeight` is the run's own contribution, which is the only poundage
      // reconcile may check an expectation against — see CartRow.addedWeight.
      // Only on the green row: a grey row is by definition weight this run did
      // not add.
      (added ? green : grey).push({
        name: it.name, qty: it.qty, added, isWeight: true, weight: it.weight,
        weightOptions: it.weightOptions,
        ...(added ? { addedWeight: +(aw - bw).toFixed(4) } : {}),
      });
      continue;
    }
    const bq = beforeQty.get(it.name) || 0;
    const greyQty = Math.min(bq, it.qty);
    const greenQty = Math.max(it.qty - bq, 0);
    if (greenQty > 0) green.push({ name: it.name, qty: greenQty, added: true, isWeight: it.isWeight, weight: it.weight });
    if (greyQty > 0) grey.push({ name: it.name, qty: greyQty, added: false, isWeight: it.isWeight, weight: it.weight });
  }
  return [...green, ...grey];
}

/**
 * Script that reads the store's already-loaded cart page and posts
 * { type: 'CART_COUNT', count, items: [{ name, qty }] }. `count` is the total
 * unit count (silent-miss detection); `items` is the per-line breakdown used to
 * render the done screen (added vs already-in-cart). Caller must navigate to
 * getCartPageUrl(storeId) first and inject this on the cart page's load.
 * Returns null for stores that don't use cart-page counting.
 *
 * count is 0 / items is [] for a genuinely empty cart — no item rows on a page
 * the script has CONFIRMED is the cart.
 *
 * That confirmation is the script's own (cartPathGuardJs), not the caller's.
 * This comment used to credit onLoadEnd with "confirmed the cart URL"; onLoadEnd
 * tests `url.includes(store.domain)` and nothing more, so every page on the
 * store's domain — its homepage included — passed. MEAL-152: a script that
 * cannot tell it is on the cart page posts `count: null, reason:
 * 'not_cart_page'` and no items. Not yet true of every store here; see the
 * per-script notes.
 */
// buildCartPageCountScript, buildOpenCartScript and buildCartCountScript lived
// here, and behind them a per-store cart-page reader for H-E-B, Walmart,
// Wegmans, the Albertsons family, Amazon Fresh and the mock store — around 600
// lines of selectors, hydration waits and path guards in a file every store
// imports.
//
// Deleted 2026-09-04. Five of those six stores have a rail and ask it instead:
// both call sites (the cart sheet's triggerCartProbe and the prewarm probe's
// startCartCapture) check for a rail first and return, so none of this had been
// reachable for them since the rails shipped. The two that still read a page —
// Amazon Fresh and the mock store — briefly carried their own reader on
// StoreScripts.cartPage, and then went themselves the same day, taking the last
// page-reading cart path in the app with them.
//
// What is left in this file is arithmetic: comparing two carts, matching a
// reported name to a cart line, and deciding what a diff means. None of it knows
// which store it is looking at, which is the property that keeps one store's
// cart bug out of another store's run.
