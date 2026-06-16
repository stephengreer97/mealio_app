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

export interface ChosenProductUpdate {
  /** Qty to persist for this meal, if the choose UI supplied one. */
  qty?: number | null;
  /** Preference/dropdown selection, or null to clear a stale one. */
  dropdown?: { type: string; selectedText: string; selectedValue: string } | null;
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
    return { ...ing, ...updates };
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
