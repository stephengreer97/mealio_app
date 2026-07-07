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
  mealIngredients: Array<{ mealId: string; mealName: string; qty: number }>;
}

export function normIngName(ing: any): string {
  return ing.ingredientName ?? ing.productName ?? ing.product_name ?? ing.name ?? '';
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
          e.mealIngredients.push({ mealId: meal.id, mealName: meal.name, qty });
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
          mealIds: [meal.id],
          mealNames: [meal.name],
          mealIngredients: [{ mealId: meal.id, mealName: meal.name, qty }],
        });
      }
    }
  }
  return [...map.values()];
}
