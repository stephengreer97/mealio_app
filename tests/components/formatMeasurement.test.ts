import { ingredientAmount } from '../../src/lib/formatMeasurement';
import type { Ingredient } from '../../src/types';

/**
 * One rule for what prints beside an ingredient, shared with the website.
 *
 * There were three of these and they disagreed: the meal sheet printed the raw
 * `qty`, so "salt to taste" read "Salt, 1"; the shared meal screen printed `qty`
 * and `measure` side by side; the website did something different again.
 */
const ing = (over: Partial<Ingredient>): Ingredient =>
  ({ ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: null, ...over }) as Ingredient;

describe('ingredientAmount', () => {
  it('prints a count the recipe actually stated', () => {
    expect(ingredientAmount(ing({ measure: '1' }))).toBe('1');
  });

  it('says nothing for a line that was never quantified', () => {
    // Every unquantified line arrives as a countable 1. Printing it invents an
    // amount nobody wrote, which is the whole reason this rule exists.
    expect(ingredientAmount(ing({ ingredientName: 'Salt', measure: null, qty: 1 }))).toBe('');
  });

  it('reads qty on rows written before measure carried the count', () => {
    // MEAL-103. Without this, "12 corn tortillas" reads "corn tortillas".
    expect(ingredientAmount(ing({ qty: 12, measure: null }))).toBe('12');
  });

  it('prefers what the source said over the product count', () => {
    expect(ingredientAmount(ing({ measure: '2', qty: 6 }))).toBe('2');
  });

  it('keeps a unit that never had a number, without borrowing one', () => {
    // "a handful of parsley" is a real line. Saying "1 handfuls" would be us
    // answering a question the recipe declined to answer.
    expect(ingredientAmount(ing({ unit: 'handfuls', measure: null, qty: 1 }))).toBe('handfuls');
  });

  it('pairs a measured amount with its unit', () => {
    expect(ingredientAmount(ing({ unit: 'cups', measure: '1.5' }))).toBe('1.5 cups');
  });
});
