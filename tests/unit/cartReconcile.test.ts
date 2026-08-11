// Reconcile decisions — the logic that decides what actually landed in the
// cart, what still needs a top-up, and what genuinely failed.
//
// These used to be reachable only by running a real cart against a live store,
// which is how a pepper double-count survived for months. Each table row below
// is a failure mode seen in the wild.

import {
  auditCartAfterRun,
  dropExplainedOverAdds,
  dropRecoveredFailures,
  isWeightPriced,
  landedIncrements,
  reconcileFromWorkerReports,
  reconcileParallelAdd,
  shouldProbeAfterRun,
  snapToWeightLadder,
  splitUnverifiableTopUps,
  summarizeConfirmations,
  toIntendedItem,
  unitsForNames,
  unitsOf,
} from '../../src/lib/cart-reconcile';
import type { AttemptedAdd, IntendedItem, OverAdd, RecoveredAdd, WorkerReport } from '../../src/lib/cart-reconcile';
import type { CartRow } from '../../src/lib/webview-scripts/cart-count';
import type { HebAddConfirmation } from '../../src/lib/webview-scripts/heb-cart-query';

const row = (name: string, qty: number, isWeight = false): CartRow =>
  ({ name, qty, added: true, isWeight });

/** A cart verdict, as MEAL-14's rail posts it back from the page. */
const confirm = (
  state: HebAddConfirmation['state'],
  reason: string,
  skuId: string | null = null,
  productId: string | null = null,
): HebAddConfirmation => ({ state, via: 'cart_query', reason, skuId, productId });

const attempt = (
  name: string,
  expectedQty: number,
  report: Partial<WorkerReport> | null,
  isWeight = false,
): AttemptedAdd => ({
  name,
  expectedQty,
  isWeight,
  report: report ? { success: false, productName: null, reason: null, ...report } : null,
});

// ── Parallel-add reconciliation ───────────────────────────────────────────────

interface ReconcileCase {
  /** The failure mode, named the way it shows up in a bug report. */
  name: string;
  attempts: AttemptedAdd[];
  addedRows: CartRow[];
  confirmed: string[];
  topUps: { index: number; shortfall: number }[];
  definiteFailures: { index: number; reason: string }[];
  overAdds: OverAdd[];
  /** The intent-vs-row disagreements the outcome should name. Omitted means none
   *  — asserted on every row, so a case that starts reporting one has to say so. */
  onWeightRows?: { index: number; cartName: string }[];
}

const RECONCILE_CASES: ReconcileCase[] = [
  {
    name: 'clean run — every item reported added and every item is in the cart',
    attempts: [
      attempt('sour cream', 1, { success: true, productName: 'H-E-B Sour Cream 16 oz' }),
      attempt('tortillas', 2, { success: true, productName: 'Mission Flour Tortillas' }),
    ],
    addedRows: [row('H-E-B Sour Cream 16 oz', 1), row('Mission Flour Tortillas', 2)],
    confirmed: ['H-E-B Sour Cream 16 oz', 'Mission Flour Tortillas'],
    topUps: [],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'false-negative worker report — the worker missed the confirm signal but the item IS in the cart, so it must NOT be re-added',
    attempts: [attempt('sour cream', 1, { success: false, reason: 'timeout' })],
    addedRows: [row('Daisy Pure & Natural Sour Cream, 16 oz', 1)],
    confirmed: ['sour cream'],
    topUps: [],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'false positive under concurrency — the shared cart counter moved for another worker, so an item reported added never landed',
    attempts: [
      attempt('cumin', 1, { success: true, productName: 'McCormick Ground Cumin, 4.5 oz' }),
      attempt('paprika', 1, { success: true, productName: 'McCormick Smoked Paprika, 1.75 oz' }),
    ],
    addedRows: [row('McCormick Ground Cumin, 4.5 oz', 1)],
    confirmed: ['McCormick Ground Cumin, 4.5 oz'],
    topUps: [{ index: 1, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'partial top-up — 2 of 3 units landed, so only the missing unit is re-added',
    attempts: [attempt('sparkling water', 3, { success: true, productName: 'Topo Chico Mineral Water' })],
    addedRows: [row('Topo Chico Mineral Water', 2)],
    confirmed: [],
    topUps: [{ index: 0, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'near-identical siblings — each pepper claims its OWN row, so the missing one is still seen as short (the double-count regression)',
    attempts: [
      attempt('ancho chiles', 1, { success: true, productName: 'El Guapo Dried Chile Ancho Peppers, 4 oz' }),
      attempt('guajillo chiles', 1, { success: true, productName: 'El Guapo Whole Dried Guajillo Peppers, 4 oz' }),
    ],
    addedRows: [row('El Guapo Dried Chile Ancho Peppers, 4 oz', 1)],
    confirmed: ['El Guapo Dried Chile Ancho Peppers, 4 oz'],
    topUps: [{ index: 1, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    // The same two peppers with the row's true owner LAST. This is what pins
    // the exact-before-loose pass order: with the owner first, both orderings
    // agree and the property is invisible. Here they diverge — a loose-first
    // pass lets guajillo claim the ancho row, so ancho is topped up and
    // re-added while guajillo is never bought at all.
    name: 'near-identical siblings, row owner LAST — the exact match still wins its row over an earlier loose one',
    attempts: [
      attempt('guajillo chiles', 1, { success: true, productName: 'El Guapo Whole Dried Guajillo Peppers, 4 oz' }),
      attempt('ancho chiles', 1, { success: true, productName: 'El Guapo Dried Chile Ancho Peppers, 4 oz' }),
    ],
    addedRows: [row('El Guapo Dried Chile Ancho Peppers, 4 oz', 1)],
    confirmed: ['El Guapo Dried Chile Ancho Peppers, 4 oz'],
    topUps: [{ index: 0, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'entity-mangled title still reserves its own row exactly (a stray ® used to sink the exact match and cause a re-add)',
    attempts: [attempt('greek yogurt', 1, { success: true, productName: 'Chobani&reg; Non-Fat Plain Greek Yogurt 32oz' })],
    addedRows: [row('Chobani® Non-Fat Plain Greek Yogurt 32oz', 1)],
    confirmed: ['Chobani® Non-Fat Plain Greek Yogurt 32oz'],
    topUps: [],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'weight-priced tolerance — a weight row confirms by presence whatever poundage it shows, and is never topped up',
    attempts: [attempt('beef brisket', 4, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true)],
    addedRows: [row('H-E-B Prime 1 Beef Brisket', 1, true)],
    confirmed: ['H-E-B Prime 1 Beef Brisket'],
    topUps: [],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'definitive failure goes to review, not to the top-up, and does not consume a sibling\'s row',
    attempts: [
      attempt('whole milk', 1, { success: true, productName: 'H-E-B Whole Milk, 1 gal' }),
      attempt('milk', 1, { success: false, reason: 'out_of_stock' }),
    ],
    addedRows: [row('H-E-B Whole Milk, 1 gal', 1)],
    confirmed: ['H-E-B Whole Milk, 1 gal'],
    topUps: [],
    definiteFailures: [{ index: 1, reason: 'out_of_stock' }],
    overAdds: [],
  },
  {
    name: 'a no-results failure is definitive too',
    attempts: [attempt('galangal', 1, { success: false, reason: 'no_results' })],
    addedRows: [],
    confirmed: [],
    topUps: [],
    definiteFailures: [{ index: 0, reason: 'no_results' }],
    overAdds: [],
  },
  {
    name: 'over-add safety net — a double-added product is surfaced even though the item itself is confirmed',
    attempts: [attempt('turmeric', 1, { success: true, productName: 'McCormick Gourmet Organic Ground Turmeric, 1.37 Oz' })],
    addedRows: [row('McCormick Gourmet Organic Ground Turmeric, 1.37 Oz', 2)],
    confirmed: ['McCormick Gourmet Organic Ground Turmeric, 1.37 Oz'],
    topUps: [],
    definiteFailures: [],
    overAdds: [{ name: 'McCormick Gourmet Organic Ground Turmeric, 1.37 Oz', qty: 1 }],
  },
  // ── One cart row, one claim (MEAL-119) ────────────────────────────────────
  // A weight line used to sit in BOTH claim pools: the presence pool AND the
  // count pool. `used` on the presence pool never decremented the count pool, so
  // one physical row could be consumed twice — and the second consumer was told
  // its item had landed when nothing had been bought for it.
  {
    name: 'one weight row cannot be spent twice — a row claimed by presence is no longer available as a count unit',
    // Two brisket items: one weight-priced (4 lb from the dropdown), one an
    // ordinary packaged product whose title matches the same cart line. Only the
    // weight line landed. The presence pass confirmed the weight-priced item off
    // it and claimQty then spent the very same row as a count unit for the
    // packaged one: two items reported landed, one physical brisket in the cart,
    // and no top-up for the item that never made it.
    attempts: [
      attempt('beef brisket', 4, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true),
      attempt('brisket', 1, { success: true, productName: 'H-E-B Beef Brisket, Boneless' }),
    ],
    addedRows: [row('H-E-B Prime 1 Beef Brisket', 1, true)],
    confirmed: ['H-E-B Prime 1 Beef Brisket'],
    topUps: [{ index: 1, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    // The other half of the pool split, and the half the segregated pools are
    // ONLY tested by here: not "a weight row can't be spent as a count unit" but
    // "a weight-priced ITEM can't spend count units". Gating the count passes on
    // confirmedWeight instead of isWeight leaves every other MEAL-119 case
    // passing, because in all of them the weight-priced item found its row and so
    // never reached the count pool. This one denies it a row.
    name: 'a weight-priced item with NO weight row to claim cannot fall back onto count units — the count sibling that owns them stays confirmed',
    attempts: [
      // No remembered poundage, so the worker bailed to the weight picker and
      // added nothing (heb.ts posts needs_weight, which is not a definitive
      // failure). Its identity falls back to the search term.
      attempt('beef brisket', 2, { success: false, reason: 'needs_weight' }, true),
      // An ordinary packaged brisket that DID land: the worker missed the confirm
      // signal (the false-negative case above) so it too is identified by its
      // search term, and its row is a loose match for both items.
      attempt('beef brisket', 1, { success: false, reason: 'timeout' }),
    ],
    addedRows: [row('H-E-B Beef Brisket', 1)],
    // The count item keeps the row it paid for. Gated on confirmedWeight, the
    // unconfirmed weight item reaches the loose pass FIRST and takes the row out
    // from under it — so the packaged brisket is reported short and re-added, and
    // the user pays for a second brisket against a row already in the cart.
    confirmed: ['beef brisket'],
    // The weight-priced item still needs its one line, whatever poundage.
    topUps: [{ index: 0, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'a COUNT item ×3 whose name matches a weight row is short, not confirmed — and the row is announced as an over-add',
    // Intent and cart row disagree: a stepper-weight deli line (weightStep, no
    // purchaseWeight — NOT weight-priced, see isWeightPriced) whose ×3 was
    // ordered by unit count. The item's own isWeight used to be ignored here, so
    // presence confirmed it off one line and the other two units were never
    // bought and never mentioned. Intent wins now: it is count-compared, finds
    // nothing in the count pool, and is topped up — the recoverable direction.
    // The row is not swallowed either: no weight-priced item claimed it, so it
    // comes back as an over-add, the same verdict findOverAddedItems and
    // splitCartLeftover give it.
    attempts: [attempt('chicken breast', 3, { success: true, productName: 'H-E-B Boneless Chicken Breast' })],
    addedRows: [row('H-E-B Boneless Chicken Breast', 1, true)],
    confirmed: [],
    topUps: [{ index: 0, shortfall: 3 }],
    definiteFailures: [],
    overAdds: [{ name: 'H-E-B Boneless Chicken Breast', qty: 1 }],
    // Named as the disagreement it is, so a caller can ask before re-adding: the
    // deli line plausibly DID land, and the top-up re-adds the full ×3 unattended.
    onWeightRows: [{ index: 0, cartName: 'H-E-B Boneless Chicken Breast' }],
  },
  {
    // No disagreement to report here even though a count item is short beside a
    // weight row: the weight-priced sibling claimed that row, so the row is
    // explained and the count item's shortfall is an ordinary missing item.
    name: 'a count item cannot even RESERVE a weight row — the weight-priced sibling that needs it still gets it',
    // The count item is listed first, so a presence pass that ignored intent
    // marked the row used and starved the weight-priced item behind it: the one
    // item the row genuinely belonged to was reported short and re-added, buying
    // a second value pack.
    attempts: [
      attempt('chicken breast', 3, { success: true, productName: 'H-E-B Boneless Skinless Chicken Breast' }),
      attempt('chicken value pack', 2, { success: true, productName: 'H-E-B Boneless Chicken Breast Value Pack' }, true),
    ],
    addedRows: [row('H-E-B Boneless Chicken Breast Value Pack', 1, true)],
    confirmed: ['H-E-B Boneless Chicken Breast Value Pack'],
    topUps: [{ index: 0, shortfall: 3 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'two weight-priced items matching ONE weight row — the first claims it, the second is short by one line, not by its poundage',
    attempts: [
      attempt('beef brisket', 2, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true),
      attempt('brisket flat', 3, { success: true, productName: 'H-E-B Prime Beef Brisket' }, true),
    ],
    addedRows: [row('H-E-B Prime 1 Beef Brisket', 1, true)],
    confirmed: ['H-E-B Prime 1 Beef Brisket'],
    // Shortfall 1, not 3: a weight-priced item needs one LINE, and its
    // productQty carries no meaning (see isWeightPriced). Before the fix the
    // unclaimed sibling fell through to the count pool and took the very row its
    // brother had already claimed, reporting a shortfall of 2 against a row that
    // was already spoken for.
    topUps: [{ index: 1, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'a weight-priced item the cart has no weight line for tops up ONE line, whatever poundage was asked for',
    attempts: [attempt('beef brisket', 4, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true)],
    addedRows: [row('McCormick Ground Cumin, 4.5 oz', 2)],
    confirmed: [],
    topUps: [{ index: 0, shortfall: 1 }],
    definiteFailures: [],
    // The cumin row belongs to no attempted item, and a weight-priced item may
    // not claim count units — so it stays overage rather than quietly confirming
    // the brisket.
    overAdds: [{ name: 'McCormick Ground Cumin, 4.5 oz', qty: 2 }],
  },
  {
    // A regression guard rather than a reproduction: diffCartItems emits weight
    // rows with qty 1, so count-comparing them would report a false shortfall on
    // every multi-lb run. Segregating the pools must not turn into that.
    name: 'a weight-priced item beside a genuine multi-unit count item — presence for one, unit count for the other, no false shortfall',
    attempts: [
      attempt('beef brisket', 4, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true),
      attempt('cumin', 2, { success: true, productName: 'McCormick Ground Cumin, 4.5 oz' }),
    ],
    addedRows: [row('H-E-B Prime 1 Beef Brisket', 1, true), row('McCormick Ground Cumin, 4.5 oz', 2)],
    confirmed: ['H-E-B Prime 1 Beef Brisket', 'McCormick Ground Cumin, 4.5 oz'],
    topUps: [],
    definiteFailures: [],
    overAdds: [],
  },
  {
    name: 'nothing landed at all — every item tops up its full quantity',
    attempts: [
      attempt('eggs', 2, { success: true, productName: 'H-E-B Grade A Large Eggs' }),
      attempt('butter', 1, null),
    ],
    addedRows: [],
    confirmed: [],
    topUps: [{ index: 0, shortfall: 2 }, { index: 1, shortfall: 1 }],
    definiteFailures: [],
    overAdds: [],
  },
];

describe('reconcileParallelAdd', () => {
  it.each(RECONCILE_CASES)('$name', (c) => {
    const out = reconcileParallelAdd(c.attempts, c.addedRows);
    expect(out.confirmed.map((x) => x.name)).toEqual(c.confirmed);
    expect(out.topUps).toEqual(c.topUps);
    expect(out.definiteFailures).toEqual(c.definiteFailures);
    expect(out.overAdds).toEqual(c.overAdds);
    expect(out.overAddUnits).toBe(c.overAdds.reduce((n, o) => n + o.qty, 0));
    expect(out.countItemsOnWeightRows).toEqual(c.onWeightRows ?? []);
    // Whatever it names is a subset of the top-up, never a fourth verdict of its
    // own: a caller that ignores it behaves exactly as it did before.
    for (const d of out.countItemsOnWeightRows) {
      expect(out.topUps.some((t) => t.index === d.index)).toBe(true);
    }
  });

  it('snapshots the full intended set (definitive failures excluded) for the later over-add check', () => {
    const out = reconcileParallelAdd(
      [
        attempt('cumin', 2, { success: true, productName: 'McCormick Ground Cumin, 4.5 oz' }),
        attempt('galangal', 1, { success: false, reason: 'no_results' }),
        attempt('brisket', 1, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true),
      ],
      [],
    );
    expect(out.intended).toEqual([
      { name: 'McCormick Ground Cumin, 4.5 oz', expectedQty: 2, isWeight: false },
      { name: 'H-E-B Prime 1 Beef Brisket', expectedQty: 1, isWeight: true },
    ]);
  });

  it('clamps a zero/absent requested quantity to one unit', () => {
    const out = reconcileParallelAdd([attempt('milk', 0, { success: true, productName: 'Milk' })], []);
    expect(out.topUps).toEqual([{ index: 0, shortfall: 1 }]);
  });

  // MEAL-119, stated as the property rather than as a table row: the reconcile
  // and the over-add check consume ONE pool, so every unit the cart holds is
  // credited to exactly one item or reported as overage — never to both, and
  // never to two items. While weight rows sat in both pools this sum came out
  // ABOVE the cart's real contents, which is precisely a unit credited twice.
  it('credits every added cart unit exactly once — the reconcile and findOverAddedItems agree about one cart', () => {
    const addedRows = [
      row('H-E-B Prime 1 Beef Brisket', 1, true),        // weight line, weight-priced item
      row('H-E-B Boneless Chicken Breast', 1, true),      // weight line, COUNT item ordered ×2
      row('McCormick Ground Cumin, 4.5 oz', 2),           // count line, fully accounted for
      row('Impulse Candy Bar', 1),                        // nothing intended it
    ];
    const attempts = [
      attempt('beef brisket', 4, { success: true, productName: 'H-E-B Prime 1 Beef Brisket' }, true),
      attempt('chicken breast', 2, { success: true, productName: 'H-E-B Boneless Chicken Breast' }),
      attempt('cumin', 2, { success: true, productName: 'McCormick Ground Cumin, 4.5 oz' }),
    ];
    const out = reconcileParallelAdd(attempts, addedRows);
    // No definitive failures here, so intended[i] is attempt i.
    const credited = out.intended.reduce((n, item, i) => {
      const short = out.topUps.find((t) => t.index === i);
      // A weight-priced item is credited by PRESENCE (one line) and a count item
      // by the units it claimed — its request less whatever it is still short.
      if (item.isWeight) return n + (short ? 0 : 1);
      return n + (item.expectedQty - (short ? short.shortfall : 0));
    }, 0);
    const cartUnits = addedRows.reduce((n, r) => n + r.qty, 0);
    expect(credited + out.overAddUnits).toBe(cartUnits);
    // And the same cart read from both sides: the brisket line is the brisket's,
    // the chicken line is claimed by nobody (its item wanted units, not a line)
    // so it is overage AND the item is re-added.
    expect(out.confirmed.map((c) => c.name)).toEqual([
      'H-E-B Prime 1 Beef Brisket',
      'McCormick Ground Cumin, 4.5 oz',
    ]);
    expect(out.topUps).toEqual([{ index: 1, shortfall: 2 }]);
    expect(out.overAdds).toEqual([
      { name: 'Impulse Candy Bar', qty: 1 },
      { name: 'H-E-B Boneless Chicken Breast', qty: 1 },
    ]);
    // The chicken's top-up is the intent disagreement, and it is named as one so
    // a caller can ask the user before re-adding ×2 against a deli line that may
    // well have landed.
    expect(out.countItemsOnWeightRows).toEqual([
      { index: 1, cartName: 'H-E-B Boneless Chicken Breast' },
    ]);
  });

  // The disagreement report obeys the same one-row-one-claim discipline as the
  // pools it reads: naming both short items against a single deli line would
  // overstate the cost of the rule, and a caller routing on it would send two
  // items to review over one row.
  it('blames at most one count item per unclaimed weight row', () => {
    const out = reconcileParallelAdd(
      [
        attempt('roast beef', 3, { success: true, productName: 'H-E-B Deli Roast Beef, lb' }),
        attempt('deli roast beef', 2, { success: true, productName: 'H-E-B Deli Roast Beef, lb' }),
      ],
      [row('H-E-B Deli Roast Beef, lb', 1, true)],
    );
    expect(out.topUps).toEqual([{ index: 0, shortfall: 3 }, { index: 1, shortfall: 2 }]);
    expect(out.countItemsOnWeightRows).toEqual([
      { index: 0, cartName: 'H-E-B Deli Roast Beef, lb' },
    ]);
  });
});

// ── Increment-style weight items: the after check (MEAL-148) ─────────────────
//
// The item this whole section is about: the meal counts it in units ("2 chicken
// breasts"), the store prices it by weight, and the store's line has no weight
// dropdown — so the add clicks an increment N times. Until now the cart could
// not say whether that worked, and the run reported the line as unverified.
// It can now: N clicks owe the line N × increment pounds.

/** A sold-by-weight cart row as diffCartItems emits it: the line's total, the
 *  poundage THIS RUN added, and the line's own option ladder. */
const weightRow = (
  name: string,
  addedWeight: number,
  options: number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5],
  weight = addedWeight,
): CartRow => ({ name, qty: 1, added: true, isWeight: true, weight, addedWeight, weightOptions: options });

/** An increment-style item: counted in units, `weightStepLb` pounds per click. */
const incrementAttempt = (
  name: string,
  expectedQty: number,
  stepLb: number,
  report: Partial<WorkerReport> | null,
): AttemptedAdd => ({ ...attempt(name, expectedQty, report), weightStepLb: stepLb });

describe('snapToWeightLadder', () => {
  it('leaves the target alone when the line offered no ladder', () => {
    expect(snapToWeightLadder(0.75, undefined)).toBe(0.75);
    expect(snapToWeightLadder(0.75, [])).toBe(0.75);
  });

  it('picks the closest weight the store actually sells', () => {
    expect(snapToWeightLadder(1.2, [0.5, 1, 1.25, 1.5])).toBe(1.25);
  });

  it('keeps the LOWER option on a tie — the add path\'s tie-break, so both snap the same way', () => {
    expect(snapToWeightLadder(1.25, [1, 1.5])).toBe(1);
  });

  it('ignores a placeholder option', () => {
    expect(snapToWeightLadder(0.6, [0, 0.5, 1])).toBe(0.5);
  });
});

describe('landedIncrements', () => {
  it('counts the whole request landed when the line gained what N clicks owe it', () => {
    expect(landedIncrements({ expectedQty: 2, stepLb: 0.25, addedLb: 0.5 })).toBe(2);
  });

  it('counts the clicks that DID land when one went missing', () => {
    expect(landedIncrements({ expectedQty: 3, stepLb: 0.25, addedLb: 0.5 })).toBe(2);
  });

  it('snaps the expectation to the line\'s own ladder before comparing', () => {
    // 3 × 0.4 lb = 1.2, which this line cannot hold; 1 lb is the closest weight
    // it can. A run that got 1 lb got everything there was to get.
    expect(landedIncrements({ expectedQty: 3, stepLb: 0.4, addedLb: 1, options: [0.5, 1, 1.5, 2] })).toBe(3);
  });

  it('treats a line that came back heavier than asked as covered', () => {
    expect(landedIncrements({ expectedQty: 2, stepLb: 0.25, addedLb: 0.75 })).toBe(2);
  });

  it('refuses to decide with no increment or no poundage', () => {
    expect(landedIncrements({ expectedQty: 2, stepLb: 0, addedLb: 0.5 })).toBeNull();
    expect(landedIncrements({ expectedQty: 2, stepLb: 0.25, addedLb: 0 })).toBeNull();
  });

  it('refuses to decide when the shortfall is not a whole number of clicks', () => {
    // The line moved by 0.3 lb against a 0.25 lb click: something we do not
    // understand set this line, so we do not get to pronounce on it.
    expect(landedIncrements({ expectedQty: 3, stepLb: 0.25, addedLb: 0.3 })).toBeNull();
  });

  it('never reports the whole order missing off a line that grew — that is the double-buy branch', () => {
    expect(landedIncrements({ expectedQty: 1, stepLb: 0.25, addedLb: 0.25 })).toBe(1);
    // A line whose smallest option is 1 lb, against an item we believe clicks in
    // 0.25 lb: the snap puts the expectation a full order above what the line
    // gained, so the arithmetic would "prove" nothing landed on a line that
    // demonstrably grew. Two facts that contradict each other — refuse, rather
    // than re-add the full quantity against a line that plainly took something.
    expect(landedIncrements({ expectedQty: 2, stepLb: 0.25, addedLb: 0.5, options: [1, 2, 3] })).toBeNull();
  });
});

describe('reconcileParallelAdd — increment-style weight items', () => {
  it('confirms the item when the line gained what the clicks owe it', () => {
    const out = reconcileParallelAdd(
      [incrementAttempt('chicken breast', 2, 0.25, { success: true, productName: 'H-E-B Boneless Chicken Breast' })],
      [weightRow('H-E-B Boneless Chicken Breast', 0.5)],
    );
    expect(out.confirmed).toEqual([{ index: 0, name: 'H-E-B Boneless Chicken Breast' }]);
    expect(out.topUps).toEqual([]);
    // Neither reported as unverifiable nor as a line nothing intended: it is
    // this item's line, and the arithmetic says so.
    expect(out.countItemsOnWeightRows).toEqual([]);
    expect(out.overAdds).toEqual([]);
  });

  it('tops up exactly the clicks that are missing, never the whole order', () => {
    const out = reconcileParallelAdd(
      [incrementAttempt('chicken breast', 3, 0.25, { success: true, productName: 'H-E-B Boneless Chicken Breast' })],
      [weightRow('H-E-B Boneless Chicken Breast', 0.5)],
    );
    expect(out.confirmed).toEqual([]);
    expect(out.topUps).toEqual([{ index: 0, shortfall: 1 }]);
    // Decided, so it is not held back from the retry — and the retry is one
    // click, which is the whole point: re-adding ×3 here buys the meat twice.
    expect(out.countItemsOnWeightRows).toEqual([]);
    expect(splitUnverifiableTopUps(out).retry).toEqual([{ index: 0, shortfall: 1 }]);
    expect(out.overAdds).toEqual([]);
  });

  it('credits the run with the poundage IT added, not with the line the user had already started', () => {
    // Cart line reads 0.75 lb, but 0.25 of it was the user's own. The run asked
    // for 3 clicks and landed 2.
    const out = reconcileParallelAdd(
      [incrementAttempt('roast beef', 3, 0.25, { success: true, productName: 'H-E-B Deli Roast Beef, lb' })],
      [weightRow('H-E-B Deli Roast Beef, lb', 0.5, undefined, 0.75)],
    );
    expect(out.topUps).toEqual([{ index: 0, shortfall: 1 }]);
  });

  it('reports, and never re-adds, an item whose increment nobody captured', () => {
    // No weightStepLb — the pre-MEAL-147 shape, or a store whose cart read emits
    // no weight rows. Unchanged from before the arithmetic existed.
    const out = reconcileParallelAdd(
      [attempt('roast beef', 3, { success: true, productName: 'H-E-B Deli Roast Beef, lb' })],
      [weightRow('H-E-B Deli Roast Beef, lb', 0.5)],
    );
    expect(out.topUps).toEqual([{ index: 0, shortfall: 3 }]);
    expect(out.countItemsOnWeightRows).toEqual([{ index: 0, cartName: 'H-E-B Deli Roast Beef, lb' }]);
    expect(splitUnverifiableTopUps(out).retry).toEqual([]);
  });

  it('reports, and never re-adds, an item whose numbers do not reconcile', () => {
    // The line gained 0.3 lb against a 0.25 lb click. Undecidable is a verdict we
    // already know how to route: report it, buy nothing.
    const out = reconcileParallelAdd(
      [incrementAttempt('roast beef', 3, 0.25, { success: true, productName: 'H-E-B Deli Roast Beef, lb' })],
      [weightRow('H-E-B Deli Roast Beef, lb', 0.3)],
    );
    expect(out.confirmed).toEqual([]);
    expect(out.countItemsOnWeightRows).toEqual([{ index: 0, cartName: 'H-E-B Deli Roast Beef, lb' }]);
    expect(splitUnverifiableTopUps(out).unverified).toEqual([
      { index: 0, cartName: 'H-E-B Deli Roast Beef, lb', shortfall: 3 },
    ]);
  });

  it('gives one weight line to one item, whichever way each is decided', () => {
    // Two deli items, one line. The first claims it and is confirmed; the second
    // finds nothing left and reports its own full shortfall — it is NOT blamed on
    // a line already spoken for.
    const out = reconcileParallelAdd(
      [
        incrementAttempt('roast beef', 2, 0.25, { success: true, productName: 'H-E-B Deli Roast Beef, lb' }),
        incrementAttempt('deli roast beef', 2, 0.25, { success: true, productName: 'H-E-B Deli Roast Beef, lb' }),
      ],
      [weightRow('H-E-B Deli Roast Beef, lb', 0.5)],
    );
    expect(out.confirmed).toEqual([{ index: 0, name: 'H-E-B Deli Roast Beef, lb' }]);
    expect(out.topUps).toEqual([{ index: 1, shortfall: 2 }]);
    expect(out.countItemsOnWeightRows).toEqual([]);
  });

  it('leaves an item with an ordinary count row alone — the weight pass is for what the count pool could not explain', () => {
    const out = reconcileParallelAdd(
      [incrementAttempt('chicken breast', 2, 0.25, { success: true, productName: 'H-E-B Chicken Breast' })],
      [row('H-E-B Chicken Breast', 2)],
    );
    expect(out.confirmed).toEqual([{ index: 0, name: 'H-E-B Chicken Breast' }]);
    expect(out.overAdds).toEqual([]);
  });

  it('counts a confirmed increment item as ONE item, because that is what the cart counts', () => {
    // The cart holds one line whatever the click count, and every counter this is
    // compared against counts it once. Two clicks reported as "2 items" against a
    // cart delta of 1 is how a correct run reads as short.
    expect(unitsOf({ name: 'H-E-B Deli Roast Beef, lb', expectedQty: 3, isWeight: false, weightStepLb: 0.25 })).toBe(1);
  });
});

// The header-badge fallback: no per-item cart data exists, so the workers'
// reports are all there is to go on.
describe('reconcileFromWorkerReports (unreadable per-item cart)', () => {
  it('splits the run by what the workers reported, preferring the reported product name', () => {
    const out = reconcileFromWorkerReports([
      attempt('sour cream', 1, { success: true, productName: 'H-E-B Sour Cream 16 oz' }),
      attempt('tortillas', 1, { success: true, productName: null }),
      attempt('galangal', 1, { success: false, reason: 'no_results' }),
      attempt('butter', 1, null),
    ]);
    expect(out.confirmed).toEqual([
      { index: 0, name: 'H-E-B Sour Cream 16 oz' },
      { index: 1, name: 'tortillas' },
    ]);
    expect(out.failed).toEqual([
      { index: 2, name: 'galangal' },
      { index: 3, name: 'butter' },
    ]);
  });

  // MEAL-14: a cart verdict is the store answering about one product, so it beats
  // a worker that inferred from a shared badge — but only when it is definite.
  it('lets a definite cart verdict overrule the worker on both sides', () => {
    const out = reconcileFromWorkerReports([
      // Worker said it landed; the cart says the line is not there.
      attempt('sour cream', 1, { success: true, productName: 'H-E-B Sour Cream 16 oz', confirm: confirm('missing', 'absent_from_cart') }),
      // Worker's badge read went stale; the cart says it landed anyway.
      attempt('tortillas', 1, { success: false, reason: 'cart_not_incremented', productName: 'H-E-B Flour Tortillas', confirm: confirm('landed', 'qty_increased') }),
    ]);
    expect(out.confirmed).toEqual([{ index: 1, name: 'H-E-B Flour Tortillas' }]);
    expect(out.failed).toEqual([{ index: 0, name: 'sour cream' }]);
  });

  it('leaves the worker in charge when the cart could not be read', () => {
    const out = reconcileFromWorkerReports([
      attempt('sour cream', 1, { success: true, productName: 'H-E-B Sour Cream 16 oz', confirm: confirm('unknown', 'blocked') }),
      attempt('galangal', 1, { success: false, reason: 'cart_not_incremented', confirm: confirm('unknown', 'timeout') }),
    ]);
    expect(out.confirmed).toEqual([{ index: 0, name: 'H-E-B Sour Cream 16 oz' }]);
    expect(out.failed).toEqual([{ index: 1, name: 'galangal' }]);
  });
});

// ── Per-item cart verdicts (MEAL-14) ─────────────────────────────────────────

describe('summarizeConfirmations', () => {
  it('names the items the cart says are missing, apart from the unverified ones', () => {
    const out = summarizeConfirmations([
      attempt('sour cream', 1, { success: true, productName: 'H-E-B Sour Cream 16 oz', confirm: confirm('landed', 'qty_increased', '4122025475', '314026') }),
      attempt('tortillas', 2, { success: false, reason: 'cart_absent', confirm: confirm('missing', 'absent_from_cart', '4122006881', '124989') }),
      attempt('bulk coffee', 1, { success: true, productName: 'CAFE Olé Bulk Coffee', confirm: confirm('unknown', 'weight_unchanged', '61342', '894630') }, true),
      // No rail ran at all — the DOM decided, as it does for every other store.
      attempt('butter', 1, { success: true, productName: 'H-E-B Butter' }),
    ]);
    expect(out.landed.map((i) => i.index)).toEqual([0]);
    expect(out.missing).toEqual([
      { index: 1, name: 'tortillas', skuId: '4122006881', productId: '124989', reason: 'absent_from_cart' },
    ]);
    expect(out.unknown.map((i) => [i.index, i.reason])).toEqual([
      [2, 'weight_unchanged'],
      [3, 'no_verdict'],
    ]);
  });

  // The failure mode this rail must never cause: one blocked read turning into a
  // screenful of "we couldn't add these".
  it('reports a blocked cart as unverified for every item, never as mass failure', () => {
    const attempts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) =>
      attempt(n, 1, { success: true, productName: n, confirm: confirm('unknown', 'blocked') }));
    const out = summarizeConfirmations(attempts);
    expect(out.missing).toEqual([]);
    expect(out.landed).toEqual([]);
    expect(out.unknown).toHaveLength(8);
  });

  it('decodes entities in the name a human will read', () => {
    const out = summarizeConfirmations([
      attempt('yogurt', 1, { success: true, productName: 'Chobani&reg; Whole Milk', confirm: confirm('landed', 'qty_increased') }),
    ]);
    expect(out.landed[0].name).toBe('Chobani® Whole Milk');
  });
});

// ── After-run cart check ──────────────────────────────────────────────────────

const intended = (name: string, expectedQty: number, isWeight = false): IntendedItem =>
  ({ name, expectedQty, isWeight });

interface AuditCase {
  name: string;
  rows: CartRow[] | null;
  reportedAdded: string[];
  active: IntendedItem[];
  reconcileIntended: IntendedItem[];
  countBefore: number | null;
  countAfter: number | null;
  missing: string[];
  short: { name: string; got: number; expected: number }[];
  over: OverAdd[];
  countShortfall: { delta: number; expected: number } | null;
  /** Omitted where nothing was under-reported (the common case). */
  recovered?: RecoveredAdd[];
}

const AUDIT_CASES: AuditCase[] = [
  {
    name: 'clean run — nothing to warn about',
    rows: [row('H-E-B Sour Cream 16 oz', 1)],
    reportedAdded: ['H-E-B Sour Cream 16 oz'],
    active: [intended('sour cream', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
  },
  {
    name: 'false-positive report — an item reported added has no cart row at all (silent miss)',
    rows: [row('H-E-B Sour Cream 16 oz', 1)],
    reportedAdded: ['H-E-B Sour Cream 16 oz', 'Mission Flour Tortillas'],
    active: [intended('sour cream', 1), intended('tortillas', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: ['Mission Flour Tortillas'],
    short: [],
    over: [],
    countShortfall: null,
  },
  {
    name: 'partial add — a store per-item cap accepted 2 of 3',
    rows: [row('Topo Chico Mineral Water', 2)],
    reportedAdded: ['Topo Chico Mineral Water'],
    active: [intended('Topo Chico Mineral Water', 3)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [{ name: 'Topo Chico Mineral Water', got: 2, expected: 3 }],
    over: [],
    countShortfall: null,
  },
  {
    name: 'weight-priced tolerance — a weight line is never short-audited, however many lb were asked for',
    rows: [row('H-E-B Prime 1 Beef Brisket', 1, true)],
    reportedAdded: ['H-E-B Prime 1 Beef Brisket'],
    active: [intended('H-E-B Prime 1 Beef Brisket', 4, true)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
  },
  {
    name: 'over-add — a unit landed that nothing intended',
    rows: [row('Milk', 1), row('Impulse Candy Bar', 1)],
    reportedAdded: ['Milk'],
    active: [intended('Milk', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [],
    over: [{ name: 'Impulse Candy Bar', qty: 1 }],
    countShortfall: null,
  },
  {
    name: 'the reconcile snapshot wins over the (top-up-narrowed) active set for the over-add check',
    rows: [row('Milk', 1), row('Eggs', 1)],
    reportedAdded: ['Milk', 'Eggs'],
    // Only Eggs was topped up, so `active` no longer mentions Milk. Without the
    // snapshot, Milk's row would read as an unintended addition.
    active: [intended('Eggs', 1)],
    reconcileIntended: [intended('Milk', 1), intended('Eggs', 1)],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
  },
  {
    name: 'unreadable cart badge and no per-item rows — never warn on data we do not have',
    rows: null,
    reportedAdded: ['Milk', 'Eggs'],
    active: [intended('Milk', 1), intended('Eggs', 1)],
    reconcileIntended: [],
    countBefore: null,
    countAfter: null,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
  },
  {
    name: 'header-badge store — the badge rose by less than what was reported added',
    rows: null,
    reportedAdded: ['Milk', 'Eggs'],
    active: [intended('Milk', 1), intended('Eggs', 1)],
    reconcileIntended: [],
    countBefore: 4,
    countAfter: 5,
    missing: [],
    short: [],
    over: [],
    countShortfall: { delta: 1, expected: 2 },
  },
  {
    name: 'a cart that SHRANK reports a zero delta rather than a negative one',
    rows: null,
    reportedAdded: ['Milk'],
    active: [intended('Milk', 1)],
    reconcileIntended: [],
    countBefore: 4,
    countAfter: 2,
    missing: [],
    short: [],
    over: [],
    countShortfall: { delta: 0, expected: 1 },
  },
  {
    name: 'nothing was reported added — a badge that did not move is not a shortfall',
    rows: null,
    reportedAdded: [],
    active: [],
    reconcileIntended: [],
    countBefore: 4,
    countAfter: 4,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
  },
  {
    name: 'per-item findings suppress the count fallback — the specific message is strictly better',
    rows: [row('Milk', 1)],
    reportedAdded: ['Milk', 'Eggs'],
    active: [intended('Milk', 1), intended('Eggs', 1)],
    reconcileIntended: [],
    countBefore: 4,
    countAfter: 5,
    missing: ['Eggs'],
    short: [],
    over: [],
    countShortfall: null,
  },
  // ── Under-reported adds (MEAL-47) ──────────────────────────────────────────
  // The direction the audit used to be blind to: the worker said "failed", the
  // cart says otherwise. These runs reported NOTHING added, which is exactly why
  // the after-probe used to skip them.
  {
    name: 'worker false negative — the add committed while the badge read stale, so only the cart knows it landed',
    rows: [row('Daisy Pure & Natural Sour Cream, 16 oz', 1)],
    reportedAdded: [],
    active: [intended('sour cream', 1)],
    reconcileIntended: [],
    countBefore: 4,
    countAfter: 5,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
    // 'loose': the store's product title is not the search term, so only the
    // token-subset matcher connects them. This is the ordinary shape of a
    // recovery and the reason MEAL-3 counts loose ones apart — the same match
    // that finds a real landed item would also find a lookalike.
    recovered: [{ name: 'sour cream', cartName: 'Daisy Pure & Natural Sour Cream, 16 oz', qty: 1, matchQuality: 'loose' as const }],
  },
  {
    name: 'a partly-landed false negative reports the units actually found, not the units asked for',
    rows: [row('Topo Chico Mineral Water', 1)],
    reportedAdded: [],
    active: [intended('Topo Chico Mineral Water', 3)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
    // 'exact': the cart title and the search term normalize to the same string,
    // so this recovery is not open to the lookalike doubt — even though it is
    // short of the 3 units asked for. Falling short and being misidentified are
    // different problems and the metric keeps them apart.
    recovered: [{ name: 'Topo Chico Mineral Water', cartName: 'Topo Chico Mineral Water', qty: 1, matchQuality: 'exact' as const }],
  },
  {
    name: 'a weight-priced false negative is recovered by PRESENCE — one row at N lb, whatever poundage was asked for',
    rows: [row('H-E-B Prime 1 Beef Brisket', 1, true)],
    reportedAdded: [],
    active: [intended('brisket', 4, true)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
    // Always 'loose': presence matching has no exact pass in front of it, so a
    // weight row is only ever claimed on name similarity.
    recovered: [{ name: 'brisket', cartName: 'H-E-B Prime 1 Beef Brisket', qty: 1, matchQuality: 'loose' as const }],
  },
  {
    name: 'a genuinely failed item is NOT recovered by a lookalike row a reported item already claimed',
    // "McCormick Ground Coriander" loosely matches the cumin row (2 of its 3
    // tokens), so without the reported item claiming its own row first, a
    // coriander that never landed would be announced as already in the cart.
    rows: [row('McCormick Ground Cumin, 4.5 oz', 1)],
    reportedAdded: ['McCormick Ground Cumin, 4.5 oz'],
    active: [intended('McCormick Ground Cumin', 1), intended('McCormick Ground Coriander', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
    recovered: [],
  },
  // ── over and recovered are ONE partition, never two claims on one unit ─────
  // Both cases below used to report the SAME cart unit twice: once as recovered
  // ("in your cart already — don't add it again") and once as an over-add
  // ("added that Mealio didn't intend"), naming one product twice with
  // contradictory instructions and over-counting recoveries on the funnel.
  {
    name: 'a weight cart row is never recovered by a COUNT item — the row stays a single over-add, not an over-add AND a recovery',
    // A stepper-weight HEB deli item: weightStep but no purchaseWeight, so it is
    // intended as an ordinary count item (see isWeightPriced) while its cart line
    // is a weight row. `over` may not claim it for a count item, so the recovery
    // pass must not either — the old pool flattened weight rows to {name, qty: 1}
    // and lost the flag, letting the count item claim what over had left behind.
    rows: [row('H-E-B Boneless Chicken Breast', 1, true)],
    reportedAdded: [],
    active: [intended('chicken breast', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [{ name: 'H-E-B Boneless Chicken Breast', qty: 1 }],
    countShortfall: null,
    recovered: [],
  },
  {
    name: 'two rows and disjoint search terms — the unit an unreported item explains is a recovery ONLY, with no weight flag involved',
    // "shredded cheese" loosely matches both rows; "mexican blend" matches only
    // the H-E-B one, which is what the run reported adding. Recomputing `over`
    // from the full intended set attributed the H-E-B row to "shredded cheese"
    // (leaving the Kraft row as an over-add) while the recovery pass attributed
    // the Kraft row to it — one 1-unit row, two claims. Reported items claim
    // first now, so the H-E-B row is the reported add and the Kraft row is
    // claimed exactly once.
    rows: [row('H-E-B Shredded Cheese Mexican Blend, 8 oz', 1), row('Kraft Shredded Cheese Sharp Cheddar', 1)],
    reportedAdded: ['H-E-B Mexican Blend Cheese'],
    active: [intended('shredded cheese', 1), intended('mexican blend', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [],
    over: [],
    countShortfall: null,
    recovered: [{ name: 'shredded cheese', cartName: 'Kraft Shredded Cheese Sharp Cheddar', qty: 1, matchQuality: 'loose' as const }],
  },
  // MEAL-119, end to end: the same physical line reported as BOTH short and over.
  // findShortAddedItems was handed every added row while only the audited ITEMS
  // were filtered for weight, so the deli line was spent as "1 unit" against a ×3
  // count item (`short: got 1, expected 3`) — and splitCartLeftover, which cannot
  // claim a weight row for a count item, still had it left over (`over: qty 1`).
  // The done screen then said "you got 1 of 3" and "nothing intended this" about
  // one line. Neither sentence survives at the sheet: the row is real, so it is
  // reported once, by name, as a line the run could not verify — and held out of
  // the over-add warning by dropExplainedOverAdds, which the audit below covers.
  // This row asserts the raw audit with no explanation supplied.
  {
    name: 'a stepper-weight deli line is reported ONCE — an over-add, not an over-add AND a shortfall',
    rows: [row('H-E-B Boneless Chicken Breast', 1, true)],
    reportedAdded: ['H-E-B Boneless Chicken Breast'],
    // Count-intended (no purchaseWeight → isWeight false), so the audit does
    // cover it; the cart line came back sold-by-weight.
    active: [intended('H-E-B Boneless Chicken Breast', 3)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [{ name: 'H-E-B Boneless Chicken Breast', qty: 1 }],
    countShortfall: null,
    recovered: [],
  },
  {
    name: 'an unintended unit stays an over-add — nothing attempted explains it',
    rows: [row('Milk', 1), row('Impulse Candy Bar', 1)],
    reportedAdded: ['Milk'],
    active: [intended('Milk', 1), intended('Eggs', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [],
    over: [{ name: 'Impulse Candy Bar', qty: 1 }],
    countShortfall: null,
    recovered: [],
  },
  // ── "items" means UNITS (MEAL-178) ─────────────────────────────────────────
  // countBefore/countAfter are unit totals — every cart counter sums line
  // quantities — so `expected` has to be units too. Measured in products, the
  // comparison was blind in one direction and could not see a multi-qty
  // under-add at all.
  {
    name: 'multi-qty under-add on a header-badge store — 3 units were requested, 1 landed',
    rows: null,
    reportedAdded: ['Topo Chico Mineral Water'],
    active: [intended('Topo Chico Mineral Water', 3)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    // Counted in products this was `1 < 1` — false, and the run finished silent.
    countShortfall: { delta: 1, expected: 3 },
  },
  {
    name: 'the MEAL-185 shape — two products, one requested x2, and one of its units never landed',
    rows: null,
    reportedAdded: ['Topo Chico Mineral Water', 'H-E-B Sour Cream 16 oz'],
    active: [intended('Topo Chico Mineral Water', 2), intended('H-E-B Sour Cream 16 oz', 1)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [],
    over: [],
    // `2 < 2` was false. The per-item audit is the primary guard for this and
    // needs rows; on a badge-only store this backstop is all there is.
    countShortfall: { delta: 2, expected: 3 },
  },
  {
    name: 'a weight line expects ONE unit however many lb were asked for — presence, not count',
    rows: null,
    reportedAdded: ['H-E-B Prime 1 Beef Brisket'],
    active: [intended('H-E-B Prime 1 Beef Brisket', 4, true)],
    reconcileIntended: [],
    countBefore: 0,
    countAfter: 1,
    missing: [],
    short: [],
    over: [],
    // Counting the 4 lb as 4 units would warn on a cart that is exactly right:
    // the store's counter contributes 1 for that line and always will.
    countShortfall: null,
  },
  {
    name: 'the top-up snapshot supplies the quantities once active has narrowed to the retry subset',
    rows: null,
    reportedAdded: ['Milk', 'Eggs'],
    // Only Eggs was retried, so `active` no longer carries Milk's x3.
    active: [intended('Eggs', 1)],
    reconcileIntended: [intended('Milk', 3), intended('Eggs', 1)],
    countBefore: 0,
    countAfter: 2,
    missing: [],
    short: [],
    over: [],
    countShortfall: { delta: 2, expected: 4 },
  },
  {
    name: 'a reported name matching nothing intended still expects one unit, not zero',
    rows: null,
    // The worker reported a product title the intended set cannot be matched to.
    // Counting it as zero would shrink `expected` below the truth and mute the
    // check on exactly the runs where name resolution is already failing.
    reportedAdded: ['Some Title No Intended Item Resembles'],
    active: [intended('Milk', 1)],
    reconcileIntended: [],
    countBefore: 4,
    countAfter: 4,
    missing: [],
    short: [],
    over: [],
    countShortfall: { delta: 0, expected: 1 },
  },
];

// ── One definition of "items" (MEAL-178) ─────────────────────────────────────
//
// "items" is total QUANTITY, weight-priced lines counting 1 by presence. The
// definition is shared by the labels the user reads and the count the cart check
// compares against, because the whole failure this fixes was the two measuring
// different things and disagreeing in the user's favour.

describe('unitsOf', () => {
  it('is the requested quantity for an ordinary item', () => {
    expect(unitsOf(intended('Topo Chico Mineral Water', 3))).toBe(3);
  });

  it('is ONE for a weight-priced line, whatever weight was asked for', () => {
    expect(unitsOf(intended('H-E-B Prime 1 Beef Brisket', 4, true))).toBe(1);
  });

  it('floors at one — saved meal data can leak a zero qty', () => {
    expect(unitsOf(intended('Milk', 0))).toBe(1);
  });
});

describe('unitsForNames', () => {
  const INTENDED = [
    intended('Topo Chico Mineral Water', 3),
    intended('H-E-B Sour Cream 16 oz', 1),
    intended('H-E-B Prime 1 Beef Brisket', 4, true),
  ];

  it('sums the requested quantities of the items the names resolve to', () => {
    expect(unitsForNames(['Topo Chico Mineral Water', 'H-E-B Sour Cream 16 oz'], INTENDED)).toBe(4);
  });

  it('counts a weight line once', () => {
    expect(unitsForNames(['H-E-B Prime 1 Beef Brisket'], INTENDED)).toBe(1);
  });

  it('lets one intended item be billed once, not once per near-identical name', () => {
    // Two cart titles both resolving to the x3 line must not report six units.
    expect(unitsForNames(['Topo Chico Mineral Water', 'Topo Chico Mineral Water'], INTENDED)).toBe(4);
  });

  it('reserves the exact name before a sibling can swallow it', () => {
    // The bug this pins: with a single loose pass, "H-E-B White Bread" met the
    // longer sibling first and billed its x3, inflating `expected` and raising a
    // cart-check warning on a run that was correct. Same exact-first rule as
    // claimQty and claimCountRows, and for the same reason.
    const BREAD = [
      intended('H-E-B Bakery Sliced White Bread', 3),
      intended('H-E-B White Bread', 1),
    ];
    expect(unitsForNames(['H-E-B White Bread'], BREAD)).toBe(1);
    // And both together still add up to the whole order, in either order.
    expect(unitsForNames(['H-E-B White Bread', 'H-E-B Bakery Sliced White Bread'], BREAD)).toBe(4);
    expect(unitsForNames(['H-E-B Bakery Sliced White Bread', 'H-E-B White Bread'], BREAD)).toBe(4);
  });

  it('still falls back to a loose match when no exact title exists', () => {
    // The exact pass is a reservation, not a restriction: a cart title that
    // differs by a comma or an ® must still find its item.
    expect(unitsForNames(['Topo Chico Mineral Water, 12 pk'], INTENDED)).toBe(3);
  });

  it('counts an unresolvable name as one unit rather than dropping it', () => {
    expect(unitsForNames(['Nothing Here Matches That'], INTENDED)).toBe(1);
  });

  it('is zero for no names — a run that added nothing added no units', () => {
    expect(unitsForNames([], INTENDED)).toBe(0);
  });
});

describe('auditCartAfterRun', () => {
  it.each(AUDIT_CASES)('$name', (c) => {
    const out = auditCartAfterRun({
      rows: c.rows,
      reportedAdded: c.reportedAdded,
      active: c.active,
      reconcileIntended: c.reconcileIntended,
      countBefore: c.countBefore,
      countAfter: c.countAfter,
    });
    expect(out.missing).toEqual(c.missing);
    expect(out.short).toEqual(c.short);
    expect(out.over).toEqual(c.over);
    expect(out.overUnits).toBe(c.over.reduce((n, o) => n + o.qty, 0));
    expect(out.countShortfall).toEqual(c.countShortfall);
    expect(out.recovered).toEqual(c.recovered ?? []);
    // `over` and `recovered` split ONE pool, so every case — not just the two
    // that regressed — must obey the partition: no more units claimed than the
    // run added, and no cart row named on both sides (the done screen would tell
    // the user not to re-add a product and that nothing intended it, at once).
    if (c.rows) {
      const addedUnits = c.rows.filter((r) => r.added).reduce((n, r) => n + r.qty, 0);
      const claimedUnits = out.overUnits + out.recovered.reduce((n, r) => n + r.qty, 0);
      expect(claimedUnits).toBeLessThanOrEqual(addedUnits);
      const overNames = out.over.map((o) => o.name);
      expect(out.recovered.filter((r) => overNames.includes(r.cartName))).toEqual([]);
    }
  });
});

// ── An explained line is not overage (MEAL-119) ───────────────────────────────
//
// The unverified sold-by-weight line is still an added weight row no count item
// can claim, so it falls through to `over` — where the copy calls it an item
// "Mealio didn't intend to add", on the same done screen as the banner naming the
// same physical line as one the run could not verify.
//
// Both halves of that are wrong. It is FALSE: the user put chicken breast in
// their meal, and the row is the store's weight-priced rendering of that request,
// so Mealio did intend it. And it CONTRADICTS the banner beside it: one line,
// described twice, once as unverifiable and once as unwanted. A user who believes
// the warning deletes the thing they asked for.
//
// The suppression is therefore about explanation, not approval: an over-add
// warning is for rows nothing accounts for, and this row is already accounted for
// by name. What must NOT follow is a blanket mute — the over-add check is the
// safety net for "never add what the user didn't ask for", so the match is exact.

describe('dropExplainedOverAdds', () => {
  const CHICKEN = 'H-E-B Boneless Skinless Chicken Breasts';
  const over: OverAdd[] = [
    { name: CHICKEN, qty: 1 },
    { name: 'H-E-B Bakery Chocolate Chip Cookies, 12 ct', qty: 2 },
  ];

  it('holds out the explained line, and only that one', () => {
    expect(dropExplainedOverAdds(over, [CHICKEN])).toEqual([
      { name: 'H-E-B Bakery Chocolate Chip Cookies, 12 ct', qty: 2 },
    ]);
  });

  it('changes nothing when the run explained nothing', () => {
    expect(dropExplainedOverAdds(over, [])).toEqual(over);
  });

  it('still reports the cookie nobody ordered — explaining one row is not a mute', () => {
    const out = dropExplainedOverAdds(over, [CHICKEN]);
    expect(out.map((o) => o.name)).toEqual(['H-E-B Bakery Chocolate Chip Cookies, 12 ct']);
    expect(out.reduce((n, o) => n + o.qty, 0)).toBe(2);
  });

  it('still reports a NEAR name match — the chicken-thighs case the loose matcher muted', () => {
    // The regression that killed cartNameMatches (0.6 token overlap) here: store
    // titles for two different cuts share their descriptors, so the explained
    // breasts line scored 3/4 against an unintended thighs line and swallowed the
    // warning. A different product must survive however similar its title reads.
    const thighs: OverAdd[] = [{ name: 'H-E-B Chicken Thighs, Boneless Skinless, 2 lb', qty: 1 }];
    expect(dropExplainedOverAdds(thighs, [CHICKEN])).toEqual(thighs);
  });

  it('still reports a strict superset name — "Bananas" must not mute "Bananas Organic"', () => {
    // Every token of the explained name appears in the over-add name, which is a
    // 1.0 loose score and a total mute. They are two different products.
    const organic: OverAdd[] = [{ name: 'Bananas Organic', qty: 1 }];
    expect(dropExplainedOverAdds(organic, ['Bananas'])).toEqual(organic);
  });

  it('compares normalized, so punctuation and HTML entities between cart reads do not un-explain a row', () => {
    // The two titles come from the same extractor on two reads of the same page —
    // directly comparable — but one read may still carry an entity or a comma.
    const encoded: OverAdd[] = [{ name: 'H-E-B Boneless Skinless Chicken&nbsp;Breasts', qty: 1 }];
    expect(dropExplainedOverAdds(encoded, [CHICKEN])).toEqual([]);
  });

  it('cancels ONE unit per explained row — extra units under the same title stay reported', () => {
    // Two explained lines cannot excuse three units, and one cannot excuse two.
    expect(dropExplainedOverAdds([{ name: CHICKEN, qty: 3 }], [CHICKEN])).toEqual([
      { name: CHICKEN, qty: 2 },
    ]);
    expect(dropExplainedOverAdds([{ name: CHICKEN, qty: 3 }], [CHICKEN, CHICKEN])).toEqual([
      { name: CHICKEN, qty: 1 },
    ]);
  });

  it('does not mutate the caller\'s over-add list', () => {
    const input: OverAdd[] = [{ name: CHICKEN, qty: 2 }];
    dropExplainedOverAdds(input, [CHICKEN]);
    expect(input).toEqual([{ name: CHICKEN, qty: 2 }]);
  });
});

// ── The failed list, corrected by the cart (MEAL-177) ────────────────────────
//
// "Could not add: Sour Cream" is the only place a user is ever told an item
// failed. When the after-probe finds it in the cart, that line is a false claim
// with real cost in both directions: leave it and the user buys the item twice,
// drop one too many and they are never told about a genuine failure and go home
// without it. So the drop is claim-by-claim, not a name-based sweep.
describe('dropRecoveredFailures', () => {
  const recovery = (name: string, over: Partial<RecoveredAdd> = {}): RecoveredAdd =>
    ({ name, cartName: name, qty: 1, matchQuality: 'exact', ...over });

  it('drops the line the cart disproved, and leaves the rest', () => {
    expect(dropRecoveredFailures(
      ['Sour Cream', 'Tortillas'],
      [recovery('Sour Cream')],
    )).toEqual(['Tortillas']);
  });

  it('changes nothing when the cart recovered nothing', () => {
    const failed = ['Sour Cream', 'Tortillas'];
    expect(dropRecoveredFailures(failed, [])).toEqual(failed);
  });

  it('matches across the search-term / store-title gap the recovery was built on', () => {
    // `recovered.name` is the intended SEARCH TERM ("sour cream"); a failed name
    // is whatever the run reported, which on the serial path is the store's own
    // product title. A stricter comparison here would never find the very line
    // the recovery came from, and the correction would silently do nothing.
    expect(dropRecoveredFailures(
      ['Daisy Pure & Natural Sour Cream, 16 oz'],
      [recovery('sour cream', { cartName: 'Daisy Pure & Natural Sour Cream, 16 oz' })],
    )).toEqual([]);
  });

  it('cancels ONE failed line per recovery — a second near-identical failure stays reported', () => {
    // One recovered unit proves one thing landed. Two failures whose titles both
    // match it are not both excused by it: the user must still be told about the
    // one the cart has nothing for, or they leave without it.
    expect(dropRecoveredFailures(
      ['H-E-B Sour Cream, 16 oz', 'H-E-B Sour Cream, 8 oz'],
      [recovery('sour cream')],
    )).toEqual(['H-E-B Sour Cream, 8 oz']);
  });

  it('keeps a failure no recovery names, however loudly the cart recovered something else', () => {
    expect(dropRecoveredFailures(
      ['Tortillas'],
      [recovery('sour cream'), recovery('cumin')],
    )).toEqual(['Tortillas']);
  });

  it('drops a loose recovery too — the advice it carries is safe either way', () => {
    // matchQuality only bounds what may be claimed as ADDED (see RecoveredAdd);
    // it is not a reason to keep telling the user an item failed while a matching
    // line sits in their cart.
    expect(dropRecoveredFailures(
      ['H-E-B Fine Ground Cumin, 1.5 oz'],
      [recovery('cumin', { matchQuality: 'loose' })],
    )).toEqual([]);
  });

  it('does not mutate the caller\'s failed list', () => {
    const failed = ['Sour Cream', 'Tortillas'];
    dropRecoveredFailures(failed, [recovery('Sour Cream')]);
    expect(failed).toEqual(['Sour Cream', 'Tortillas']);
  });
});

describe('auditCartAfterRun — the retry exit, beside the unverified banner', () => {
  // The exact state the sheet is in on the done screen: the reconcile could not
  // verify the deli line and topped up the cumin, so `active` is the retry subset
  // only and the deli item survives in `reconcileIntended`. The cart also holds a
  // cookie nobody asked for, which the audit must still surface.
  const UNVERIFIED_LINE = 'H-E-B Boneless Skinless Chicken Breasts';
  const COOKIES = 'H-E-B Bakery Chocolate Chip Cookies, 12 ct';
  const audit = (explainedRows?: string[]) =>
    auditCartAfterRun({
      rows: [
        row(UNVERIFIED_LINE, 1, true),
        row('McCormick Ground Cumin, 4.5 oz', 2),
        row(COOKIES, 1),
      ],
      reportedAdded: ['McCormick Ground Cumin, 4.5 oz'],
      active: [intended('cumin', 2)],
      reconcileIntended: [intended('chicken breast', 3), intended('cumin', 2)],
      countBefore: 0,
      countAfter: 4,
      explainedRows,
    });

  it('reports the weight line as an over-add when nothing explains it — the bug', () => {
    // Not a claim about desired behaviour: it pins that this audit really does
    // surface the row, so the assertion below cannot pass vacuously.
    // Count rows are listed before weight rows (see splitCartLeftover's residue).
    expect(audit().over).toEqual([{ name: COOKIES, qty: 1 }, { name: UNVERIFIED_LINE, qty: 1 }]);
  });

  it("never names an explained line as an item Mealio didn't intend", () => {
    const out = audit([UNVERIFIED_LINE]);
    expect(out.over.map((o) => o.name)).not.toContain(UNVERIFIED_LINE);
    // And it is not quietly moved to another finding instead: the count item whose
    // line this is added nothing, so there is nothing to recover or report short.
    expect(out.recovered).toEqual([]);
    expect(out.short).toEqual([]);
    expect(out.missing).toEqual([]);
  });

  it('still reports the cookie on the very same run — the safety net is intact', () => {
    const out = audit([UNVERIFIED_LINE]);
    expect(out.over).toEqual([{ name: COOKIES, qty: 1 }]);
    expect(out.overUnits).toBe(1);
  });

  it('still reports a near-name-match row that the explained line resembles', () => {
    // Same shape as the cookie case, but with the title that used to be muted:
    // an unintended thighs line beside an explained breasts line.
    const out = auditCartAfterRun({
      rows: [
        row(UNVERIFIED_LINE, 1, true),
        row('H-E-B Chicken Thighs, Boneless Skinless, 2 lb', 1),
      ],
      reportedAdded: [],
      active: [],
      reconcileIntended: [intended('chicken breast', 3)],
      countBefore: 0,
      countAfter: 2,
      explainedRows: [UNVERIFIED_LINE],
    });
    expect(out.over).toEqual([{ name: 'H-E-B Chicken Thighs, Boneless Skinless, 2 lb', qty: 1 }]);
    expect(out.overUnits).toBe(1);
  });

  it('takes its explained rows from the same cartName the banner is built from', () => {
    // Binds the two ends together: the string held out of the warning is the string
    // the done screen shows the user, not a second guess at the title.
    const reconciled = reconcileParallelAdd(
      [
        attempt('chicken breast', 3, { success: true, productName: UNVERIFIED_LINE }),
        attempt('cumin', 2, { success: true, productName: 'McCormick Ground Cumin, 4.5 oz' }),
      ],
      [row(UNVERIFIED_LINE, 1, true)],
    );
    const explained = splitUnverifiableTopUps(reconciled).unverified.map((u) => u.cartName);
    expect(explained).toEqual([UNVERIFIED_LINE]);
    expect(dropExplainedOverAdds(reconciled.overAdds, explained)).toEqual([]);
    expect(audit(explained).over).toEqual([{ name: COOKIES, qty: 1 }]);
  });
});

// ── The after-probe, for an item that lands as a weight line (MEAL-148) ───────
//
// Once the reconcile can CONFIRM an increment-style item off its poundage, that
// item is no longer named as unverified — so the row is no longer held out of
// the over-add check by name, and this audit has to know on its own that a deli
// line is where a ×3 deli order lives. Otherwise the fix for one warning would
// have manufactured the other.
describe('auditCartAfterRun — an increment-style item lands as a weight line', () => {
  const DELI = 'H-E-B Deli Roast Beef, lb';
  const incrementItem = (name: string, expectedQty: number): IntendedItem =>
    ({ name, expectedQty, isWeight: false, weightStepLb: 0.25 });
  const auditDeli = (extraRows: CartRow[] = []) =>
    auditCartAfterRun({
      rows: [row(DELI, 1, true), ...extraRows],
      reportedAdded: [DELI],
      active: [incrementItem(DELI, 3)],
      reconcileIntended: [],
      countBefore: 0,
      countAfter: 1 + extraRows.length,
    });

  it("never calls the line an item Mealio didn't intend", () => {
    expect(auditDeli().over).toEqual([]);
  });

  it('reports no shortfall of any other kind either', () => {
    const out = auditDeli();
    expect(out.missing).toEqual([]);
    expect(out.short).toEqual([]);
    expect(out.recovered).toEqual([]);
  });

  it('counts the order as the ONE cart line it became, not as three units', () => {
    // The cart badge moved by 1 because one line was added. Expecting 3 against
    // that delta is how a correct run reads as short — see unitsOf.
    expect(auditDeli().countShortfall).toBeNull();
  });

  it('still surfaces a line nothing intended on the same run', () => {
    expect(auditDeli([row('Impulse Candy Bar', 1)]).over).toEqual([{ name: 'Impulse Candy Bar', qty: 1 }]);
  });
});

// ── Routing the top-up: retry vs unverified (MEAL-119) ────────────────────────
//
// A count-ordered item whose cart line came back sold-by-weight has no machine
// answer. Two rules bind cart automation — never add what the user didn't ask
// for, and never over- or under-add — and both obvious paths break one:
//
//   • re-add the shortfall (which here is the FULL quantity): where the weight
//     line did land, the user buys the deli meat twice. An over-add.
//   • presence-confirm it off the weight line: we assume it landed and say
//     nothing. A silent under-add.
//
// So the item is neither re-added nor confirmed, and it is REPORTED — an under-add
// that says so, the only branch that does not break a rule in silence. This split
// is where that is enforced; if an item does not stop being re-added here, nothing
// downstream can save it.
//
// STOPGAP. MEAL-148 replaces the whole question by computing the expected weight
// (productQty × increment) and comparing it against the cart line's actual
// poundage.

describe('splitUnverifiableTopUps', () => {
  const outcome = (
    topUps: { index: number; shortfall: number }[],
    countItemsOnWeightRows: { index: number; cartName: string }[] = [],
  ) => ({ topUps, countItemsOnWeightRows });

  it('takes the disagreement OUT of the retry — no unattended re-add is possible for it', () => {
    // The one that costs money: a ×3 count item short beside its own deli line.
    // Left in `retry`, WebViewCartSheet re-adds productQty: 3 with no confirmation
    // step and the user pays for the meat twice.
    const routing = splitUnverifiableTopUps(outcome(
      [{ index: 0, shortfall: 3 }],
      [{ index: 0, cartName: 'H-E-B Boneless Chicken Breast' }],
    ));
    expect(routing.retry).toEqual([]);
    expect(routing.unverified).toEqual([
      { index: 0, cartName: 'H-E-B Boneless Chicken Breast', shortfall: 3 },
    ]);
  });

  it('still retries an ordinary shortfall — nothing in the cart plausibly covers it', () => {
    const routing = splitUnverifiableTopUps(outcome([{ index: 0, shortfall: 2 }]));
    expect(routing.retry).toEqual([{ index: 0, shortfall: 2 }]);
    expect(routing.unverified).toEqual([]);
  });

  it('splits a mixed top-up per item, not per run — one unverified item must not strand the others', () => {
    const routing = splitUnverifiableTopUps(outcome(
      [{ index: 0, shortfall: 2 }, { index: 1, shortfall: 3 }, { index: 2, shortfall: 1 }],
      [{ index: 1, cartName: 'H-E-B Deli Roast Beef, lb' }],
    ));
    expect(routing.retry).toEqual([{ index: 0, shortfall: 2 }, { index: 2, shortfall: 1 }]);
    expect(routing.unverified).toEqual([
      { index: 1, cartName: 'H-E-B Deli Roast Beef, lb', shortfall: 3 },
    ]);
  });

  it('is a total partition of the top-up — nothing in both sides, nothing dropped', () => {
    const topUps = [
      { index: 0, shortfall: 1 },
      { index: 3, shortfall: 4 },
      { index: 7, shortfall: 2 },
    ];
    const routing = splitUnverifiableTopUps(outcome(topUps, [
      { index: 3, cartName: 'H-E-B Deli Turkey, lb' },
      { index: 7, cartName: 'H-E-B Deli Ham, lb' },
    ]));
    const retried = routing.retry.map((r) => r.index);
    const unverified = routing.unverified.map((u) => u.index);
    expect([...retried, ...unverified].sort()).toEqual([0, 3, 7]);
    expect(retried.filter((i) => unverified.includes(i))).toEqual([]);
    // The shortfall travels with the item so the report can say how much of the
    // request the cart line is being asked to cover.
    expect(routing.unverified.map((u) => u.shortfall)).toEqual([4, 2]);
  });

  it('carries a real reconcile outcome through — the shapes the sheet actually passes', () => {
    // Not a hand-built outcome: the deli case from the reconcile table above,
    // reconciled for real and then routed. Guards the two from drifting apart.
    const out = reconcileParallelAdd(
      [
        attempt('chicken breast', 3, { success: true, productName: 'H-E-B Boneless Chicken Breast' }),
        attempt('cumin', 2, { success: true, productName: 'McCormick Ground Cumin, 4.5 oz' }),
      ],
      [row('H-E-B Boneless Chicken Breast', 1, true)],
    );
    const routing = splitUnverifiableTopUps(out);
    expect(routing.retry).toEqual([{ index: 1, shortfall: 2 }]);
    expect(routing.unverified).toEqual([
      { index: 0, cartName: 'H-E-B Boneless Chicken Breast', shortfall: 3 },
    ]);
  });

  // THE regression test for this branch, stated as the three things that must all
  // hold at once. Each clause fails on a different way of reverting the routing:
  //
  //   • back into the top-up (`retry` holds it)  → a second physical purchase
  //   • back to presence-confirm (`confirmed` holds it) → a silent under-add
  //   • routing deleted (`unverified` empty)     → an under-add nobody is told of
  //
  // Nothing may be bought, nothing may claim success, and the item must be named.
  it('is neither bought nor claimed as landed, and is reported by name', () => {
    const CART_LINE = 'H-E-B Deli Boneless Chicken Breast, lb';
    const out = reconcileParallelAdd(
      [attempt('chicken breast', 3, { success: true, productName: CART_LINE })],
      [row(CART_LINE, 1, true)],
    );
    const routing = splitUnverifiableTopUps(out);

    // 1. Nothing is bought. The sheet builds retryItems from `retry` alone, so an
    //    empty retry is what makes the unattended re-add unreachable.
    expect(routing.retry).toEqual([]);
    // 2. Nothing claims success. `confirmed` is what becomes addResultsRef and
    //    itemsAdded, so the item appearing here would report a delivery that was
    //    never verified.
    expect(out.confirmed).toEqual([]);
    expect(out.confirmed.map((c) => c.name)).not.toContain(CART_LINE);
    // 3. It is reported — the item, and the cart line it could not be compared
    //    against. This pair is exactly what the done screen's
    //    `snapshot-unverified-weight` banner renders, with no buttons on it.
    expect(routing.unverified).toEqual([
      { index: 0, cartName: CART_LINE, shortfall: 3 },
    ]);
    // And the detection it is derived from is still on the outcome, which is what
    // the funnel's weightRowUnverified counts for MEAL-148.
    expect(out.countItemsOnWeightRows).toEqual([{ index: 0, cartName: CART_LINE }]);
  });
});
// ── Arming the after-snapshot (MEAL-47) ───────────────────────────────────────
//
// The gate used to be the reported-success count, which skipped the cart read on
// precisely the run that needed it: every add reported failed. The confirmation
// rail is a shared header badge, so "failed" and "landed but unconfirmed" are the
// same report — and the user was told an item was missing that was in their cart.

describe('shouldProbeAfterRun', () => {
  it('probes a run whose adds ALL reported failure — that run is the reason the snapshot exists', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 3, hasBaseline: true })).toBe(true);
  });

  it('probes a run that reported successes too (unchanged)', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 1, hasBaseline: true })).toBe(true);
  });

  it('does NOT probe when nothing was attempted — a choose-a-product run or an all-skipped review has no signal to find, and a cart load is not free', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 0, hasBaseline: true })).toBe(false);
  });

  it('does NOT probe without a baseline — with no before-snapshot every row diffs as newly added, so the findings would be the whole cart', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 3, hasBaseline: false })).toBe(false);
  });
});

// ── The sold-by-weight rule ───────────────────────────────────────────────────

describe('isWeightPriced', () => {
  it('is weight-priced when an absolute purchase weight was chosen (dropdown item)', () => {
    expect(isWeightPriced({ purchaseWeight: 2.5 })).toBe(true);
  });

  it('a stepper-weight item (weightStep only, e.g. HEB Deli) is NOT weight-priced — productQty is its source of truth', () => {
    expect(isWeightPriced({ purchaseWeight: null } as { purchaseWeight?: number | null })).toBe(false);
    expect(isWeightPriced({})).toBe(false);
  });
});

describe('toIntendedItem', () => {
  it('matches on the search term, falling back to the ingredient name', () => {
    expect(toIntendedItem({ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 2 }))
      .toEqual({ name: 'sour cream', expectedQty: 2, isWeight: false });
    expect(toIntendedItem({ ingredientName: 'Sour Cream', searchTerm: null, productQty: 1 }))
      .toEqual({ name: 'Sour Cream', expectedQty: 1, isWeight: false });
  });

  it('clamps a zero quantity (saved meal data can leak one) to a single unit', () => {
    expect(toIntendedItem({ ingredientName: 'Milk', productQty: 0 }).expectedQty).toBe(1);
  });

  it('carries the sold-by-weight rule through', () => {
    expect(toIntendedItem({ ingredientName: 'Brisket', purchaseWeight: 3 }).isWeight).toBe(true);
  });
});
