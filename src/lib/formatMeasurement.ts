

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
/**
 * The three fields the amount is read from.
 *
 * Structural rather than `Ingredient`, because the qty step reads a *per-meal*
 * entry — `{ mealName, qty, measure, unit }` off a consolidated row — which is
 * not an ingredient and has no name of its own. Both callers hold these three.
 */
export interface Measurable {
  measure?: string | null;
  unit?: string | null;
  qty?: number | null;
}

/**
 * Units that inflect, and the singular the card should say.
 *
 * Storage keeps the plural — one token per unit — which is a storage decision
 * that used to show through as "1/4 cups tahini" and "1 cans tomatoes". Mirrors
 * `SINGULAR_UNITS` in mealio_central's `lib/import/ingredients.ts`; the two are
 * a pair and drift between them is a card that reads differently on each
 * platform for the same meal.
 */
const SINGULAR: Record<string, string> = {
  cups: 'cup', cloves: 'clove', cans: 'can', bunches: 'bunch', sprigs: 'sprig',
  pinches: 'pinch', handfuls: 'handful', grinds: 'grind', slices: 'slice', thumbs: 'thumb',
};

/**
 * How a unit is spelled beside this amount.
 *
 * Singular for exactly one, and for a bare fraction: a cook writes "1/2 cup",
 * never "1/2 cups". A string test rather than a parse, so "1 1/2" — which is
 * more than one — keeps its plural.
 */
function unitLabel(unit: string, amount: string): string {
  const one = amount === '1' || /^\d+\s*\/\s*\d+$/.test(amount);
  return one ? (SINGULAR[unit] ?? unit) : unit;
}

/**
 * Trails a preparation after a rendered ingredient line — "1 onion, finely
 * diced" (MEAL-102).
 *
 * One function, called by every surface that prints an ingredient, for the same
 * reason `ingredientAmount` is one function: there were three amount rules and
 * they disagreed, and a second rule for the comma would disagree the same way.
 * It mirrors `withPrep` in mealio_central's `components/MealCard.tsx`, so the
 * same meal reads the same on both platforms.
 *
 * The comma is added HERE and not stored, so the data holds the phrase a cook
 * wrote ("finely diced") and not the punctuation joining it to something else —
 * store the comma and a row reads "1 onion, , finely diced" the moment both
 * agree. Whitespace-only prep is no prep, and a row with none returns `line`
 * unchanged, character for character.
 *
 * Plain text, not italic. The ticket wrote `1 onion, *finely diced*` to mark
 * WHICH part is the preparation, not to specify styling; whether it should be
 * emphasised is Stephen's call and is on his checklist.
 *
 * **Only ever applied to a line already rendered for a human.** Prep must never
 * reach `searchTerm` or `ingredientName` — the cart's add gate is
 * exact-after-normalisation equality against `searchTerm ?? ingredientName`, so
 * prep in either does not buy a worse product, it matches nothing and routes the
 * item to review looking like a matching bug.
 */
export function withPrep(line: string, prep?: string | null): string {
  const trailer = (prep ?? '').trim();
  return trailer ? `${line}, ${trailer}` : line;
}

export function ingredientAmount(ing: Measurable): string {
  const measure = (ing.measure ?? '').toString().trim();

  if (!ing.unit || ing.unit === 'qty') {
    return measure || ((ing.qty ?? 1) > 1 ? String(ing.qty) : '');
  }

  // A unit with no number is a real line — "a handful of parsley" keeps its unit
  // and never had an amount — so the unit prints alone rather than borrowing the
  // product count, which would say "1 handful" where the recipe said "a".
  const amount = measure || ((ing.qty ?? 1) > 1 ? String(ing.qty) : '');
  return amount ? `${amount} ${unitLabel(ing.unit, amount)}` : unitLabel(ing.unit, '1');
}
