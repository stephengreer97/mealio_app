// Display helper for sold-by-weight ingredients. Two models:
//
//  • Dropdown items (HEB bulk coffee, Fish Market): the store offers discrete
//    weight options. We remember the chosen ABSOLUTE weight in `purchaseWeight`
//    (lb); the add selects the closest dropdown option. The stepper adjusts
//    purchaseWeight by `weightStep`.
//
//  • Stepper items (HEB Deli): NO weight dropdown — it increments by weight but
//    behaves like a quantity stepper (1 step = 0.25 lb). The source of truth is
//    `productQty` (the stepper count); weight = productQty × weightStep. The
//    add is plain stepper clicks (unchanged). Such items carry `weightStep` but
//    NO `purchaseWeight`.
//
// Distinguish by which field is set: purchaseWeight ⇒ dropdown, weightStep-only
// ⇒ stepper.

import { isWeightPriced } from './cart-reconcile';

export interface WeightIngredientFields {
  purchaseWeight?: number | null;
  weightStep?: number | null;
  productQty?: number;
  qty?: number;
}

export interface WeightInfo {
  /** The weight to display, in lb. */
  lb: number;
  /** The increment (lb). */
  step: number;
  /** 'dropdown' ⇒ adjust purchaseWeight by step; 'stepper' ⇒ adjust productQty by 1. */
  mode: 'dropdown' | 'stepper';
}

/** Returns weight display info for a sold-by-weight ingredient, or null if it's
 *  a normal (count-based) item. */
export function ingredientWeight(ing: WeightIngredientFields): WeightInfo | null {
  // Through `isWeightPriced` rather than an inline `!= null`, so "sold by
  // weight" has one definition. MEAL-3 needs the same predicate for the
  // north-star metric, and a second copy here is how the two would drift.
  if (isWeightPriced(ing)) {
    return { lb: ing.purchaseWeight, step: ing.weightStep ?? 0.25, mode: 'dropdown' };
  }
  if (ing.weightStep != null) {
    const q = ing.productQty ?? ing.qty ?? 1;
    return { lb: +(q * ing.weightStep).toFixed(2), step: ing.weightStep, mode: 'stepper' };
  }
  return null;
}

/** "0.75 lb" formatter (trims trailing zeros). */
export function weightLabelLb(lb: number): string {
  return `${+lb.toFixed(2)} lb`;
}
