// Unit tests for the ingredient consolidation logic used by the cart sheet.
//
// This is the function that merges identical chosen-products across meals
// before search/add. If it ever miscounts the whole cart is wrong, so the
// behavior here is pinned in some detail.

import {
  consolidateIngredients,
  normIngName,
  normProductQty,
  type ConsolidatedIngredient,
} from '../../src/lib/consolidateIngredients';

type Ing = Record<string, any>;
type Meal = { id: string; name: string; ingredients: Ing[] };

const meal = (id: string, name: string, ingredients: Ing[]): Meal => ({ id, name, ingredients });

describe('normIngName', () => {
  it('prefers ingredientName, then productName, then product_name, then name', () => {
    expect(normIngName({ ingredientName: 'A', productName: 'B', product_name: 'C', name: 'D' })).toBe('A');
    expect(normIngName({ productName: 'B', product_name: 'C', name: 'D' })).toBe('B');
    expect(normIngName({ product_name: 'C', name: 'D' })).toBe('C');
    expect(normIngName({ name: 'D' })).toBe('D');
    expect(normIngName({})).toBe('');
  });
});

describe('normProductQty', () => {
  it('reads productQty, then qty, then quantity', () => {
    expect(normProductQty({ productQty: 3 })).toBe(3);
    expect(normProductQty({ qty: 2 })).toBe(2);
    expect(normProductQty({ quantity: 5 })).toBe(5);
  });

  it('clamps invalid / non-positive values to 1', () => {
    expect(normProductQty({})).toBe(1);
    expect(normProductQty({ productQty: 0 })).toBe(1);
    expect(normProductQty({ productQty: -2 })).toBe(1);
    expect(normProductQty({ productQty: NaN })).toBe(1);
    expect(normProductQty({ productQty: 'abc' })).toBe(1);
    expect(normProductQty({ productQty: null })).toBe(1);
  });

  it('coerces numeric strings', () => {
    expect(normProductQty({ productQty: '4' })).toBe(4);
  });
});

describe('consolidateIngredients', () => {
  it('returns empty for empty meals', () => {
    expect(consolidateIngredients([])).toEqual([]);
  });

  it('returns one entry per ingredient for a single meal', () => {
    const result = consolidateIngredients([
      meal('m1', 'Tacos', [
        { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 },
        { ingredientName: 'Tortillas', searchTerm: 'tortillas', productQty: 2 },
      ]),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.ingredientName).sort()).toEqual(['Sour Cream', 'Tortillas']);
  });

  it('merges the same chosen product across meals and sums qty', () => {
    const result = consolidateIngredients([
      meal('m1', 'Tacos', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 }]),
      meal('m2', 'Burritos', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 2 }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].productQty).toBe(3);
    expect(result[0].mealIds).toEqual(['m1', 'm2']);
    expect(result[0].mealNames).toEqual(['Tacos', 'Burritos']);
    expect(result[0].mealIngredients).toEqual([
      { mealId: 'm1', mealName: 'Tacos', qty: 1 },
      { mealId: 'm2', mealName: 'Burritos', qty: 2 },
    ]);
  });

  it('merges duplicate ingredient lines within the same meal (single mealIngredients row)', () => {
    const result = consolidateIngredients([
      meal('m1', 'Tacos', [
        { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 },
        { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 2 },
      ]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].productQty).toBe(3);
    // Inside one meal the per-meal row must be summed, not duplicated.
    expect(result[0].mealIngredients).toEqual([
      { mealId: 'm1', mealName: 'Tacos', qty: 3 },
    ]);
    expect(result[0].mealIds).toEqual(['m1']);
  });

  it('normalizes searchTerm whitespace and case for the merge key', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{ ingredientName: 'Sour Cream', searchTerm: 'Sour Cream', productQty: 1 }]),
      meal('m2', 'B', [{ ingredientName: 'Sour Cream', searchTerm: '  sour cream  ', productQty: 1 }]),
      meal('m3', 'C', [{ ingredientName: 'Sour Cream', searchTerm: 'SOUR CREAM', productQty: 1 }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].productQty).toBe(3);
  });

  it('does NOT merge across different dropdown selectedValue', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{
        ingredientName: 'Cheese', searchTerm: 'cheese', productQty: 1,
        dropdown: { type: 'size', selectedText: '8 oz', selectedValue: 'small' },
      }]),
      meal('m2', 'B', [{
        ingredientName: 'Cheese', searchTerm: 'cheese', productQty: 1,
        dropdown: { type: 'size', selectedText: '16 oz', selectedValue: 'large' },
      }]),
    ]);
    expect(result).toHaveLength(2);
  });

  it('DOES merge across the same dropdown selectedValue', () => {
    const dd = { type: 'size', selectedText: '8 oz', selectedValue: 'small' };
    const result = consolidateIngredients([
      meal('m1', 'A', [{ ingredientName: 'Cheese', searchTerm: 'cheese', productQty: 1, dropdown: dd }]),
      meal('m2', 'B', [{ ingredientName: 'Cheese', searchTerm: 'cheese', productQty: 2, dropdown: dd }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].productQty).toBe(3);
    expect(result[0].dropdown).toEqual(dd);
  });

  it('does NOT merge unchosen ingredients across meals (each meal picks its own product)', () => {
    const result = consolidateIngredients([
      meal('m1', 'Tacos', [{ ingredientName: 'Cheese', productQty: 1 }]),
      meal('m2', 'Burritos', [{ ingredientName: 'Cheese', productQty: 1 }]),
    ]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.searchTerm === null)).toBe(true);
  });

  it('merges chosen with chosen but keeps unchosen separate even when names match', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 }]),
      meal('m2', 'B', [{ ingredientName: 'Sour Cream', productQty: 1 }]),
      meal('m3', 'C', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 2 }]),
    ]);
    // m1 + m3 consolidate (both chose "sour cream"); m2 stays separate.
    expect(result).toHaveLength(2);
    const chosen = result.find((r) => r.searchTerm === 'sour cream')!;
    const unchosen = result.find((r) => r.searchTerm === null)!;
    expect(chosen.productQty).toBe(3);
    expect(chosen.mealIds).toEqual(['m1', 'm3']);
    expect(unchosen.productQty).toBe(1);
    expect(unchosen.mealIds).toEqual(['m2']);
  });

  it('clamps qty=0 ingredient to 1 on the consolidated line (saved-meal qty=0 leak)', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 0 }]),
    ]);
    expect(result[0].productQty).toBe(1);
  });

  it('reads unit + measure from the first ingredient and preserves them on the consolidated line', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{
        ingredientName: 'Tortillas',
        searchTerm: 'tortillas',
        productQty: 1,
        unit: 'pack',
        measure: '10 ct',
      }]),
    ]);
    expect(result[0].unit).toBe('pack');
    expect(result[0].measure).toBe('10 ct');
  });

  it('defaults unit to "qty" and measure to null when absent', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream' }]),
    ]);
    expect(result[0].unit).toBe('qty');
    expect(result[0].measure).toBe(null);
  });

  it('handles 3-meal merge (the common cart shape)', () => {
    const result = consolidateIngredients([
      meal('m1', 'Tacos', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 }]),
      meal('m2', 'Burritos', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 }]),
      meal('m3', 'Enchiladas', [{ ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1 }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].productQty).toBe(3);
    expect(result[0].mealIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps mealIds and mealNames aligned in insertion order', () => {
    const result = consolidateIngredients([
      meal('mc', 'C', [{ ingredientName: 'X', searchTerm: 'x', productQty: 1 }]),
      meal('ma', 'A', [{ ingredientName: 'X', searchTerm: 'x', productQty: 1 }]),
      meal('mb', 'B', [{ ingredientName: 'X', searchTerm: 'x', productQty: 1 }]),
    ]);
    expect(result[0].mealIds).toEqual(['mc', 'ma', 'mb']);
    expect(result[0].mealNames).toEqual(['C', 'A', 'B']);
  });

  it('survives mixed key shapes on the ingredient object (productName / product_name / name)', () => {
    const result = consolidateIngredients([
      meal('m1', 'A', [{ productName: 'Tortillas', searchTerm: 'tortillas', qty: 2 }]),
      meal('m2', 'B', [{ product_name: 'Tortillas', searchTerm: 'tortillas', quantity: 3 }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].productQty).toBe(5);
    expect(result[0].ingredientName).toBe('Tortillas');
  });
});
