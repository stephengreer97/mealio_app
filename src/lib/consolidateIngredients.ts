// Ingredient consolidation for the cart-sheet add-to-cart flow.
//
// Given a list of meals, each with its own ingredient list, merge duplicate
// ingredients across meals into a single line that adds them together. The
// merge key is the chosen product (searchTerm + dropdown selection). When an
// ingredient is "unchosen" (no searchTerm set yet), it MUST NOT be merged
// across meals — each meal must pick its product independently.
//
// Extracted from WebViewCartSheet for unit testability.

export interface ConsolidatedIngredient {
  ingredientName: string;
  productQty: number;
  unit: string;
  measure: string | null;
  searchTerm: string | null;
  dropdown: { type: string; selectedText: string; selectedValue: string } | null;
  /** Remembered buy-weight (lb) for a sold-by-weight item; drives auto-add. */
  purchaseWeight?: number | null;
  /** The weight dropdown's increment (lb); steps the pre-automation picker. */
  weightStep?: number | null;
  mealIds: string[];
  mealNames: string[];
  /**
   * What each meal asks for, per meal.
   *
   * `measure` and `unit` are in here rather than only on the entry because the
   * entry's pair is whichever meal happened to create it — every later meal
   * merges in and its own amount was dropped. Two meals sharing chicken then
   * both claimed the first one's "2 lb", on the one screen whose entire job is
   * asking how much to buy.
   *
   * `prep` is here for the same reason and one more (MEAL-102). Two meals can
   * share a product and want different things done to it — one dices the onion,
   * the other slices it — so a preparation on the merged entry would state one
   * meal's instruction under both meals' names. Keeping it per-meal also keeps
   * it structurally away from `ingredientName` and `searchTerm`, which are what
   * the cart searches for; nothing that builds a store query reads this array.
   */
  mealIngredients: Array<{ mealId: string; mealName: string; qty: number; measure: string | null; unit: string; prep?: string }>;
  /** Per-rail identifiers for the product the user chose. Absent on a row nobody
   *  has chosen for, which is the normal case for a new meal. */
  storeProducts?: Record<string, { upc: string; name: string; sku?: string }> | null;
}

export function normIngName(ing: any): string {
  return ing.ingredientName ?? ing.productName ?? ing.product_name ?? ing.name ?? '';
}

/**
 * This row's preparation, as a spreadable so "none" stays absent (MEAL-102).
 *
 * Read off the row rather than assigned, for the same reason `normalizeIngredients`
 * omits the key: a per-meal entry with no `prep` has to look exactly like one
 * written before the field existed.
 */
export function prepOf(ing: any): { prep?: string } {
  return typeof ing?.prep === 'string' && ing.prep.trim() ? { prep: ing.prep.trim() } : {};
}

export function normProductQty(ing: any): number {
  // Clamp non-positive/invalid values to 1: saved meal data can leak qty=0
  // from the chooser flow, which would otherwise disable the cart CTA.
  const raw = ing.productQty ?? ing.qty ?? ing.quantity ?? 1;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Structurally typed input. The function only needs id, name, and ingredients,
// and the ingredient shape varies (saved meals can carry productName / product_name
// / name / ingredientName keys; qty fields likewise vary). Using `any[]` here
// matches what the body of the function actually treats.
export interface ConsolidatableMeal {
  id: string;
  name: string;
  ingredients: any[];
}

export function consolidateIngredients(
  meals: ConsolidatableMeal[],
): ConsolidatedIngredient[] {
  const map = new Map<string, ConsolidatedIngredient>();
  for (const meal of meals) {
    for (const ing of meal.ingredients as any[]) {
      const name = normIngName(ing);
      const dropdownKey = ing.dropdown?.selectedValue ? `|${ing.dropdown.selectedValue}` : '';
      // Unchosen ingredients (no searchTerm) must never be consolidated across meals — each meal
      // picks its own product independently. Only consolidate when a searchTerm is already set.
      const key = ing.searchTerm
        ? ing.searchTerm.toLowerCase().trim() + dropdownKey
        : `__unchosen__|${meal.id}|${name.toLowerCase().trim()}`;
      if (!key) continue;
      const qty = normProductQty(ing);
      if (map.has(key)) {
        const e = map.get(key)!;
        e.productQty += qty;
        // Sold-by-weight lines: total poundage is additive across meals, so
        // SUM purchaseWeight the same way productQty is accumulated. Taking it
        // from only the first meal would under-add the weight for the rest.
        const w = ing.purchaseWeight;
        if (typeof w === 'number' && Number.isFinite(w)) {
          e.purchaseWeight = (typeof e.purchaseWeight === 'number' ? e.purchaseWeight : 0) + w;
        }
        const existing = e.mealIngredients.find((m) => m.mealId === meal.id);
        if (existing) {
          existing.qty += qty;
        } else {
          e.mealIngredients.push({ mealId: meal.id, mealName: meal.name, qty, measure: ing.measure ?? null, unit: ing.unit ?? 'qty', ...prepOf(ing) });
          e.mealIds.push(meal.id);
          e.mealNames.push(meal.name);
        }
      } else {
        map.set(key, {
          ingredientName: name,
          productQty: qty,
          unit: ing.unit ?? 'qty',
          measure: ing.measure ?? null,
          searchTerm: ing.searchTerm ?? null,
          dropdown: ing.dropdown ?? null,
          purchaseWeight: ing.purchaseWeight ?? null,
          weightStep: ing.weightStep ?? null,
          // The store's own ids for this row, kept whole and keyed by rail. The
          // run reads its own store's entry; carrying the map rather than one
          // id means consolidation does not need to know which store is running.
          storeProducts: ing.storeProducts ?? null,
          mealIds: [meal.id],
          mealNames: [meal.name],
          mealIngredients: [{ mealId: meal.id, mealName: meal.name, qty, measure: ing.measure ?? null, unit: ing.unit ?? 'qty', ...prepOf(ing) }],
        });
      }
    }
  }
  return [...map.values()];
}
