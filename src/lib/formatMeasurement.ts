import type { Ingredient } from '../types';

/**
 * The amount to print beside an ingredient, or '' when the source gave none.
 *
 * One rule, in one place, because there were three of them and they disagreed:
 * `MealDetailSheet` printed the raw `qty` for countables, so an unquantified
 * line read "Salt, 1"; `SharedMealScreen` printed `qty` only above one and then
 * `measure` beside it; and the website did something different again.
 *
 * **`measure` is what the source said. `qty` is how many products to buy.**
 * A countable with a measure ("1 onion") states a number the recipe gave, so it
 * prints. One without ("salt to taste") does not, so it stays "salt" — printing
 * the 1 that every unquantified line arrives with would invent an amount nobody
 * wrote.
 *
 * The `qty` fallback underneath is temporary. Most preset rows still keep their
 * amount in `qty` with `measure` null (MEAL-103); without it "12 corn tortillas"
 * would read "corn tortillas" until that migration lands. It can go once it has.
 */
export function ingredientAmount(ing: Ingredient): string {
  const measure = (ing.measure ?? '').toString().trim();

  if (!ing.unit || ing.unit === 'qty') {
    return measure || ((ing.qty ?? 1) > 1 ? String(ing.qty) : '');
  }

  // A unit with no number is a real line — "a handful of parsley" keeps its unit
  // and never had an amount — so the unit prints alone rather than borrowing the
  // product count, which would say "1 handful" where the recipe said "a".
  const amount = measure || ((ing.qty ?? 1) > 1 ? String(ing.qty) : '');
  return amount ? `${amount} ${ing.unit}` : ing.unit;
}
