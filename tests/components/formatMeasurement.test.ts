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
    // answering a question the recipe declined to answer — and the singular is
    // what the recipe wrote, which is why the unit is spelled for one here.
    // Storage keeps the plural; that is a storage decision, not a sentence.
    expect(ingredientAmount(ing({ unit: 'handfuls', measure: null, qty: 1 }))).toBe('handful');
  });

  it('pairs a measured amount with its unit', () => {
    expect(ingredientAmount(ing({ unit: 'cups', measure: '1.5' }))).toBe('1.5 cups');
  });
});

describe('units are spelled for the amount beside them', () => {
  it('takes the singular for a bare fraction', () => {
    // "1/4 cup", never "1/4 cups". The catalogue is full of these now that
    // amounts are stored as the fractions recipes are written in.
    expect(ingredientAmount(ing({ unit: 'cups', measure: '1/4' }))).toBe('1/4 cup');
    expect(ingredientAmount(ing({ unit: 'cups', measure: '1/2' }))).toBe('1/2 cup');
  });

  it('keeps the plural above one, including a mixed fraction', () => {
    // "1 1/2" is more than one, so it is cups — which is why this is a string
    // test rather than a parse that would see the leading 1.
    expect(ingredientAmount(ing({ unit: 'cups', measure: '1 1/2' }))).toBe('1 1/2 cups');
    expect(ingredientAmount(ing({ unit: 'cups', measure: '2' }))).toBe('2 cups');
  });

  it('agrees with the website for the same ingredient', () => {
    // These two renderers are a pair. Drift between them is one meal reading
    // differently on each platform, which is the bug this file exists to stop.
    expect(ingredientAmount(ing({ unit: 'cans', measure: '1' }))).toBe('1 can');
  });
});
