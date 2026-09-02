// Saving a chosen product back to a meal.
//
// Background: each "Add & Update Meal Ingredient" choice PATCHes the meal's
// ENTIRE ingredient array. Choices arrive faster than the server round-trip, so
// if two choices on the same meal run concurrently they both rebuild the array
// from the same pre-save snapshot and the later write clobbers the earlier one
// (last-write-wins). For a meal with many ingredients, choosing several in a row
// silently dropped all but the last.
//
// Two primitives fix that and are unit-testable in isolation:
//   - mergeChosenProduct: pure array merge (set searchTerm/qty/dropdown on the
//     matching ingredient), so the matching rules are pinned by tests.
//   - createMealSaveQueue: a per-meal promise chain so saves on the same meal
//     serialize (each reads the result of the prior one) while different meals
//     still save in parallel.

import { withStoreProduct, withoutStoreProducts } from './storeProducts';

export interface ChosenProductUpdate {
  /** Qty to persist for this meal, if the choose UI supplied one. */
  qty?: number | null;
  /** Preference/dropdown selection, or null to clear a stale one. */
  dropdown?: { type: string; selectedText: string; selectedValue: string } | null;
  /** Chosen buy-weight (lb) for a sold-by-weight item, remembered across runs. */
  purchaseWeight?: number | null;
  /** The weight dropdown's increment (lb), for the meal editor's stepper. */
  weightStep?: number | null;
  /**
   * THE STORE'S OWN ID FOR THE PRODUCT THE USER PICKED, and the store it is for.
   *
   * Choose Product once, add to cart forever -- that is the tenet. Until now the
   * only thing kept was `searchTerm`, the product's DISPLAY NAME, so every later
   * run re-derived the product by searching that string and letting the store's
   * relevance ranking vote again. The choice was made once and re-made on every
   * run.
   *
   * With this, the choice IS the identifier. `searchTerm` stays for display and
   * as the fallback when the id no longer resolves.
   */
  storeProduct?: { upc: string; name: string; sku?: string } | null;
  /** Which store the id belongs to. An id is meaningless at another chain, and
   *  `storeProducts` is keyed by rail for exactly that reason. */
  storeId?: string | null;
}

/** Name an ingredient row goes by, tolerating the three key variants the DB
 *  uses (see CLAUDE.md "Ingredients in DB"). */
function ingName(ing: any): string {
  return ing.ingredientName ?? ing.productName ?? ing.product_name ?? ing.name ?? '';
}

/**
 * Return a new ingredients array with the chosen product applied to the row
 * matching `ingredientName` (by display name OR existing searchTerm). All other
 * rows are returned unchanged. Pure — no mutation of the input.
 */
export function mergeChosenProduct(
  ingredients: any[],
  ingredientName: string,
  productName: string,
  update: ChosenProductUpdate = {},
): any[] {
  return ingredients.map((ing) => {
    const name = ingName(ing);
    const term = ing.searchTerm ?? ing.search_term ?? name;
    if (name !== ingredientName && term !== ingredientName) return ing;
    const updates: Record<string, any> = { searchTerm: productName };
    if (update.qty != null) updates.productQty = update.qty;
    if (update.dropdown) updates.dropdown = update.dropdown;
    else if ('dropdown' in ing) updates.dropdown = null; // clear stale preference if none selected
    if (update.purchaseWeight != null) updates.purchaseWeight = update.purchaseWeight;
    if (update.weightStep != null) updates.weightStep = update.weightStep;
    // A choice made at THIS store renames the row, and `searchTerm` is one
    // global field — so any other store's saved identifier now sits beside a
    // name that describes a different product (MEAL-19). It would still
    // resolve: move a meal to H-E-B, pick something else, move it back, and
    // Kroger auto-adds the forgotten product while the meal displays the H-E-B
    // one. Dropped for the same reason `dropdown` above is.
    const cleared = withoutStoreProducts({ ...ing, ...updates });
    // ...and THIS store's id is then written back, because it is the one the
    // user just chose. Order matters: clearing first is what stops a stale id
    // from another chain surviving beside the new name.
    return update.storeProduct && update.storeProduct.upc
      ? withStoreProduct(cleared, update.storeId, update.storeProduct)
      : cleared;
  });
}

export type MealSaveQueue = (mealId: string, task: () => Promise<void>) => Promise<void>;

/**
 * Create a per-meal serialization queue. `enqueue(mealId, task)` runs `task`
 * after any previously-enqueued task for the same `mealId` has settled, so
 * same-meal saves never overlap. Tasks for different meals run independently.
 * A failing/rejecting task does not stall the chain — the next task still runs.
 */
export function createMealSaveQueue(): MealSaveQueue {
  const chains: Record<string, Promise<void>> = {};
  return (mealId, task) => {
    const prior = chains[mealId] ?? Promise.resolve();
    // Run `task` whether the prior task resolved or rejected (settle, not chain
    // failure), so one bad save can't block later ones.
    const next = prior.then(
      () => task(),
      () => task(),
    );
    chains[mealId] = next;
    return next;
  };
}

/**
 * Record the store's id for a product the user ALREADY chose, changing nothing
 * else.
 *
 * The identity is written when a product is PICKED -- on the Choose Products
 * screen or at review -- which never happens again for a meal that is already
 * chosen. So every existing meal kept searching its saved product NAME on every
 * run, and "Choose Product once, add forever" stayed half true: the choice was
 * remembered, the identity was re-derived.
 *
 * This is the backfill. A run that searched the saved name, matched it exactly,
 * wrote it, and had the store accept it has just proven which product that name
 * means. Recording that is not a new decision -- it is the one the user already
 * made, written down properly.
 *
 * Deliberately NOT mergeChosenProduct: that renames the row and drops every
 * other chain's id, both correct when someone picks something new and both
 * wrong here. Nothing about the meal changed.
 */
export function mergeStoreProductOnly(
  ingredients: any[],
  ingredientName: string,
  storeId: string | null | undefined,
  product: { upc: string; name: string; sku?: string },
): any[] {
  if (!product?.upc) return ingredients;
  return ingredients.map((ing) => {
    const name = ingName(ing);
    const term = ing.searchTerm ?? ing.search_term ?? name;
    if (name !== ingredientName && term !== ingredientName) return ing;
    return withStoreProduct(ing, storeId, product);
  });
}
