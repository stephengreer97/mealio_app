// Ingredient normalization for ingredient lists fetched from the API.
//
// DB rows can carry varied ingredient shapes depending on which writer last
// touched them (web vs mobile vs creator portal vs preset import). This
// function smooths over those differences so callers get a single canonical
// Ingredient[] regardless of source. The normalizer is also used by the
// preset-meal save flow and the discover-page ingredient editor.
//
// Extracted from api.ts so unit tests can exercise it without dragging the
// expo-secure-store import chain through node-jest.

import type { Ingredient } from '../types';
import { isWeightPriced } from './cart-reconcile';

/** The unit token meaning "countable" — the picker's "Qty" option. Mirrors
 *  COUNT_UNIT in mealio_central's `lib/import/ingredients.ts`. */
const COUNT_UNIT = 'qty';

/**
 * How many PACKAGES a recipe line asks a shopper to buy (MEAL-108).
 *
 * `qty`/`measure` is the RECIPE's amount; `productQty` is the SHOPPER's package
 * count. They are only ever equal on a countable line, and this is not a new
 * heuristic — it is the rule `IngredientEditor.fromFormIng` already writes with
 * (countable ⇒ `qty: N, productQty: N`; measured ⇒ `qty: 1, productQty: 1`) and
 * the rule `canonicalizeIngredient` writes with on the server, read back out.
 * A row that lost its `productQty` therefore derives the number the editor
 * would have stored.
 *
 * Only the count unit yields a number above 1. Every other unit means ONE
 * package, and the reason is money:
 *  - Measured units are an amount out of a package: "3 tbsp olive oil" is one
 *    bottle, "1/2 cup rice" one bag. Note the amount lives in `qty` on
 *    catalogue rows (`{qty: 3, unit: 'tbsp'}`), NOT the 1 that `fromFormIng`
 *    writes — so anything reading `qty` without consulting `unit` buys three
 *    bottles of olive oil for three tablespoons.
 *  - A cook's unit is a *part* of a package, which is worse: "3 cloves garlic"
 *    is one head and not three, "4 sprigs thyme" one bunch and not four. See
 *    the COOK_UNITS comment in mealio_central — that exact collapse is why the
 *    words are carried instead of folded into a count.
 *  - Package-ish words we do not have a vocabulary for ("bottle", "jar", "pkg",
 *    "head", "rack") fall here too. Buying N of those is often right, but
 *    "often" is not good enough for a number that spends money: a can sold as a
 *    4-pack turns 2 into 8. One is the reading that can only ever be too small,
 *    and the shopper's stepper is right there to raise it.
 *
 * The count unit is NOT sufficient on its own, which is the part that cost the
 * most care. The catalogue bakes sub-package nouns into the NAME rather than the
 * unit — "Garlic cloves" (156 rows), "Corn tortillas", "Bacon strips", "Egg
 * yolks", "Scallions", "Nori sheets" all carry `unit: 'qty'`. Reading their
 * count off `qty` orders four HEADS of garlic for four cloves and twelve PACKS
 * of tortillas for twelve tortillas, which is the same mistake COOK_UNITS was
 * written to prevent, arriving through the name instead of the unit. So the
 * count is taken only for names whose head noun is a thing stores sell loose,
 * one at a time — see SINGLE_UNIT_COUNTABLES. Everything else keeps 1.
 *
 * That allow-list is deliberately narrow and deliberately incomplete. It is an
 * allow-list rather than a deny-list because a deny-list can never be finished,
 * and every noun missing from it would be an over-buy; a name missing from THIS
 * list is merely a 1, which is the failure the shopper can see and fix on a
 * screen built to ask. Whether a given product is sold loose or in a bag is
 * store data the app does not have, so recovering the rest of these counts is
 * catalogue work, not a parse — see the MEAL-108 notes.
 */
export function packageQtyFor(ing: PackageQtyFields): number {
  if (ing.unit !== COUNT_UNIT) return 1;
  if (!isSoldSingly(ing.ingredientName)) return 1;
  const n = typeof ing.qty === 'number' ? ing.qty : Number(ing.qty);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // A fractional count ("1/2 onion", 45 rows in the catalogue) rounds UP to a
  // whole package: you cannot buy half an onion, and rounding down would zero
  // the row out. Ceil, so the result overshoots by at most part of one item.
  return Math.max(1, Math.ceil(n));
}

/** The fields the package-count rule reads. Structurally satisfied by a raw DB
 *  row and by a normalized `Ingredient`. */
export interface PackageQtyFields {
  ingredientName?: unknown;
  qty?: unknown;
  unit?: unknown;
}

/**
 * Head nouns for things a grocery store sells LOOSE, one at a time, so that a
 * recipe's count of them is also the number of products to buy.
 *
 * Singular forms only; `isSoldSingly` folds the plural. Everything here is
 * picked-by-hand produce, and the bar for entry is that buying N of it cannot
 * over-charge: three lemons is three lemons at every store we support. Items
 * sold loose *or* bagged are left out on purpose — carrots and potatoes are the
 * near misses, and "3 carrots" fetching three 1 lb bags is exactly the outcome
 * this list exists to avoid.
 */
const SINGLE_UNIT_COUNTABLES = new Set([
  'lemon', 'lime', 'orange', 'grapefruit', 'avocado', 'tomato', 'eggplant',
  'zucchini', 'cucumber', 'onion', 'shallot', 'apple', 'banana', 'pear',
  'peach', 'mango', 'plantain', 'beet', 'turnip', 'parsnip', 'leek',
  'jalapeno', 'poblano', 'artichoke',
]);

/**
 * Words that change the pack form of an otherwise loose item, disqualifying the
 * whole name.
 *
 * The head noun alone is not enough. "Green onions" ends in `onions` but is sold
 * in a BUNCH, so four of them is four bunches; "crushed tomatoes" ends in
 * `tomatoes` and is a can; "cherry tomatoes" a punnet; "chipotle peppers in
 * adobo" a tin. `pepper` is in here rather than in the list above for the same
 * reason — bell peppers are sold singly, but the word attaches to too many
 * things that are not, and losing the bell peppers to a 1 is the cheap mistake.
 */
const PACK_QUALIFIERS = new Set([
  'green', 'spring', 'scallion', 'scallions', 'pearl', 'crushed', 'diced',
  'stewed', 'canned', 'sundried', 'chipotle', 'adobo', 'cherry', 'grape',
  'roasted', 'pickled', 'dried', 'frozen', 'jarred', 'paste', 'sauce',
  'powder', 'juice', 'zest', 'oil', 'pepper', 'peppers',
]);

/** Is this ingredient name a thing sold loose, one at a time? Reads the head
 *  noun, and rejects any name carrying a pack-form qualifier. */
function isSoldSingly(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  // Punctuation to spaces so "1/2 lemon, halved" and "Hass avocado (ripe)"
  // still expose their head noun.
  const words = name.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return false;
  if (words.some((w) => PACK_QUALIFIERS.has(w))) return false;
  const last = words[words.length - 1];
  // Fold the plural onto the singular the list stores: "tomatoes" → "tomato",
  // "limes" → "lime". Only when the result is actually in the list, so a real
  // word ending in s is never truncated into a match.
  const singular = last.endsWith('es') && SINGLE_UNIT_COUNTABLES.has(last.slice(0, -2))
    ? last.slice(0, -2)
    : last.endsWith('s') && SINGLE_UNIT_COUNTABLES.has(last.slice(0, -1))
      ? last.slice(0, -1)
      : last;
  return SINGLE_UNIT_COUNTABLES.has(singular);
}

export function normalizeIngredients(raw: any): Ingredient[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') {
      return { ingredientName: item, qty: 1, productQty: 1, unit: 'qty', measure: null };
    }
    if (item && typeof item === 'object') {
      const qty = item.qty ?? item.quantity ?? 1;
      const unit = item.unit ?? COUNT_UNIT;
      const ingredientName = item.ingredientName ?? item.productName ?? item.product_name ?? String(item.name ?? item) ?? '';
      return {
        ingredientName,
        searchTerm: item.searchTerm ?? item.search_term ?? null,
        qty,
        // Absent `productQty` derives from the whole line, not from `qty` alone.
        // `?? qty` read the recipe's AMOUNT as a package count, so a row that had
        // never stored the field asked the cart for three bottles of olive oil for
        // "3 tbsp" and four heads of garlic for "4 garlic cloves". Deriving
        // properly here is also what makes the field genuinely optional in
        // storage, so the catalogue can stop keeping a copy of `qty` that rots
        // (MEAL-108).
        productQty: item.productQty ?? packageQtyFor({ ingredientName, qty, unit }),
        unit,
        measure: item.measure ?? null,
        dropdown: item.dropdown ?? null,
        // Sold-by-weight remembered weight (lb) + its dropdown increment. Must be
        // carried through or the saved choice is lost on every read — the meal
        // card can't show it and the cart re-prompts for weight every run.
        ...(item.purchaseWeight != null ? { purchaseWeight: item.purchaseWeight } : {}),
        ...(item.weightStep != null ? { weightStep: item.weightStep } : {}),
      };
    }
    return { ingredientName: String(item), qty: 1, productQty: 1, unit: 'qty', measure: null };
  }).filter((i) => i.ingredientName);
}

/**
 * Preset-catalogue ingredients, with the shopper's package count RE-DERIVED
 * rather than trusted (MEAL-108).
 *
 * On a `preset_meals` row a stored `productQty` carries nothing `qty`/`unit` do
 * not already say. Every writer that CREATES one sets it from that pair —
 * `canonicalizeIngredient` (mealio_central `lib/import/ingredients.ts`) and
 * `IngredientEditor.fromFormIng` — and the two only ever diverge when a *user*
 * moves one, which happens exclusively on the user's own `meals` row
 * (`MealDetailSheet`'s stepper, `ProductChooserSheet`, `mergeChosenProduct`).
 * So the catalogue's copy is a duplicate that can rot out of sync with the
 * recipe, and MEAL-108 is what that looks like: the 2026-08-05 catalogue fix
 * corrected `measure` and `unit` on 854 countable lines and deliberately left
 * `productQty: 1` sitting in front of them, so "3 ct Eggplant" told the cart to
 * buy one eggplant.
 *
 * The correction is RAISE-ONLY — `max(stored, derived)` — and that is the safety
 * property, not an optimisation. It gives two guarantees by construction rather
 * than by measurement:
 *
 *  - No row's quantity can go DOWN. The 51 catalogue rows whose `productQty` is
 *    not 1 today had it set deliberately by an importer or a creator, and several
 *    are names the derivation is not confident about ("Large Eggs" 6, "Corn
 *    Tortillas" 12). Overriding those would throw away the only real information
 *    on the row and undo MEAL-92, which put the recipe's amount beside the
 *    stepper so a pre-filled number could be JUDGED.
 *  - No row's quantity can rise above what the derivation is confident about, and
 *    the derivation is confident only where buying N cannot over-charge.
 *
 * So the stale copy can only ever be corrected upward, toward the recipe, and
 * only for a line where that is unambiguous. Replayed over the live catalogue on
 * 2026-08-06: 130 rows raised, 3466 unchanged, 0 lowered, largest derived count
 * 6 (six Granny Smith apples).
 *
 * It does NOT recover every lost count, and that is the intended trade. ~500
 * countable rows stay at 1 because their name does not say whether the store
 * sells the thing loose or in a bag ("Corn tortillas", "Eggs", "Carrots") — see
 * packageQtyFor. Too small is a second tap; too large is a charge.
 *
 * `mapMeal` deliberately does NOT do this. On a user's meal the number is a
 * choice somebody made, and re-deriving it would overwrite the stepper.
 */
export function normalizePresetIngredients(raw: any): Ingredient[] {
  return normalizeIngredients(raw).map((ing) => {
    // A weight-priced row's quantity IS its chosen absolute weight and its
    // productQty carries no meaning (see isWeightPriced — the one definition of
    // sold-by-weight), so leave the pair alone rather than assert a count over
    // it. No catalogue row carries purchaseWeight today; this keeps the rule
    // true if one ever does.
    if (isWeightPriced(ing)) return ing;
    const derived = packageQtyFor(ing);
    return derived > ing.productQty ? { ...ing, productQty: derived } : ing;
  });
}
