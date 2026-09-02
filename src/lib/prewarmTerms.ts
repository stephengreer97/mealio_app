// WHAT A SEARCH PREWARM SHOULD LOOK UP, derived once and read from two places.
//
// The cart sheet has always worked this out for itself at the quantity screen.
// The selection screen now works it out too, several seconds earlier, so the
// answers are already in hand by the time the sheet opens. Two derivations of
// "which rows still need looking up" would drift, and the failure would be
// silent: the early pass searches one set, the sheet searches another, and the
// prewarm quietly stops saving anything. So there is one function and both call
// it.
import { isZeroedOut } from './cart-reconcile';
import { getStoreProduct } from './storeProducts';
import { consolidateIngredients, ConsolidatableMeal } from './consolidateIngredients';

/**
 * A ceiling on one prewarm batch.
 *
 * The prewarm is speculative work — the user has not asked for anything yet —
 * and Albertsons' search is the part of that store measured to degrade under
 * load (MEAL-207). Ticking a dozen meals at once is a hundred terms, and firing
 * all of them before the user has even opened the sheet is the wrong shape of
 * request to send a store on spec.
 *
 * Nothing is lost by capping: whatever the prewarm does not cover, the run
 * searches, exactly as it did before the prewarm existed. The cap only decides
 * how much of the head start is taken, never what ends up in the cart.
 */
export const SEARCH_PREWARM_MAX_TERMS = 24;

/** The fields the derivation reads. Structurally satisfied by
 *  ConsolidatedIngredient and by a saved ingredient row. */
export interface PrewarmableRow {
  ingredientName: string;
  searchTerm?: string | null;
  productQty?: number;
  purchaseWeight?: number | null;
  weightStep?: number | null;
  storeProducts?: Record<string, { upc: string; name: string; sku?: string }> | null;
}

/**
 * The terms a prewarm would look up for these rows at this store.
 *
 * Three filters, and each one is the same rule the run applies:
 *
 *   • A zeroed-out row is not being bought, so it is not being searched.
 *   • A row already chosen for at THIS store has nothing to look up — the run
 *     writes its saved id straight to the cart. Searching it would be work
 *     whose answer is thrown away, on the one phase that exists to save time.
 *   • The query is the chosen product name when there is one, and the
 *     ingredient name when there is not.
 *
 * Deduped, because two meals sharing an onion are one lookup, and capped.
 */
export function prewarmTermsFor(
  rows: PrewarmableRow[],
  storeId: string | null | undefined,
): string[] {
  const terms = new Set<string>();
  for (const row of rows) {
    if (isZeroedOut(row)) continue;
    if (getStoreProduct(row, storeId)) continue;
    const term = row.searchTerm || row.ingredientName;
    if (term) terms.add(term);
  }
  return Array.from(terms).slice(0, SEARCH_PREWARM_MAX_TERMS);
}

/**
 * The same answer, starting from meals rather than consolidated rows.
 *
 * The selection screen holds meals; the sheet holds rows it has already
 * consolidated. Consolidating here first is what makes the two agree — two
 * meals that share a searchTerm are ONE row and one lookup in the sheet, and
 * counting them twice here would cap the batch early and prewarm a term the
 * sheet was never going to ask for.
 */
export function prewarmTermsForMeals(
  meals: ConsolidatableMeal[],
  storeId: string | null | undefined,
): string[] {
  if (!meals.length) return [];
  return prewarmTermsFor(consolidateIngredients(meals), storeId);
}
