// Unit tests for normalizeIngredients.
//
// This function smooths over the many shapes ingredients can take in the DB
// (string, object with productName, object with product_name, object with
// ingredientName, snake_case search_term vs camelCase searchTerm, etc.).
// Per CLAUDE.md it is the canonical entry point for downstream code so the
// rest of the app sees a single shape. Mistakes here ripple everywhere.

import { normalizeIngredients } from '../../src/lib/normalizeIngredients';

describe('normalizeIngredients', () => {
  it('returns [] for null / undefined / non-array', () => {
    expect(normalizeIngredients(null)).toEqual([]);
    expect(normalizeIngredients(undefined)).toEqual([]);
    expect(normalizeIngredients('not an array')).toEqual([]);
    expect(normalizeIngredients(42)).toEqual([]);
    expect(normalizeIngredients({})).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(normalizeIngredients([])).toEqual([]);
  });

  it('handles a plain string ingredient', () => {
    const result = normalizeIngredients(['Sour Cream']);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      ingredientName: 'Sour Cream',
      qty: 1,
      productQty: 1,
      unit: 'qty',
      measure: null,
    });
  });

  it('drops items with empty ingredient names', () => {
    const result = normalizeIngredients(['', { ingredientName: '' }, { name: '' }]);
    expect(result).toEqual([]);
  });

  describe('object inputs — name field priority', () => {
    it('prefers ingredientName', () => {
      const r = normalizeIngredients([{
        ingredientName: 'A', productName: 'B', product_name: 'C', name: 'D',
      }]);
      expect(r[0].ingredientName).toBe('A');
    });

    it('falls back to productName when ingredientName missing', () => {
      const r = normalizeIngredients([{ productName: 'B', product_name: 'C', name: 'D' }]);
      expect(r[0].ingredientName).toBe('B');
    });

    it('falls back to product_name (snake_case) when productName missing', () => {
      const r = normalizeIngredients([{ product_name: 'C', name: 'D' }]);
      expect(r[0].ingredientName).toBe('C');
    });

    it('falls back to name when all product variants missing', () => {
      const r = normalizeIngredients([{ name: 'D' }]);
      expect(r[0].ingredientName).toBe('D');
    });
  });

  describe('object inputs — searchTerm', () => {
    it('reads camelCase searchTerm', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', searchTerm: 'x search' }]);
      expect(r[0].searchTerm).toBe('x search');
    });

    it('reads snake_case search_term', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', search_term: 'x search' }]);
      expect(r[0].searchTerm).toBe('x search');
    });

    it('camelCase wins over snake_case if both present', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', searchTerm: 'camel', search_term: 'snake' }]);
      expect(r[0].searchTerm).toBe('camel');
    });

    it('defaults to null when both absent', () => {
      const r = normalizeIngredients([{ ingredientName: 'X' }]);
      expect(r[0].searchTerm).toBe(null);
    });
  });

  describe('object inputs — qty / productQty', () => {
    it('uses qty when present', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', qty: 3 }]);
      expect(r[0].qty).toBe(3);
      expect(r[0].productQty).toBe(3); // productQty defaults to qty
    });

    it('falls back to quantity', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', quantity: 4 }]);
      expect(r[0].qty).toBe(4);
      expect(r[0].productQty).toBe(4);
    });

    it('uses explicit productQty when set', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', qty: 2, productQty: 5 }]);
      expect(r[0].qty).toBe(2);
      expect(r[0].productQty).toBe(5);
    });

    it('defaults qty + productQty to 1 when neither set', () => {
      const r = normalizeIngredients([{ ingredientName: 'X' }]);
      expect(r[0].qty).toBe(1);
      expect(r[0].productQty).toBe(1);
    });
  });

  describe('object inputs — unit / measure / dropdown', () => {
    it('preserves explicit unit and measure', () => {
      const r = normalizeIngredients([{ ingredientName: 'X', unit: 'pack', measure: '10 ct' }]);
      expect(r[0].unit).toBe('pack');
      expect(r[0].measure).toBe('10 ct');
    });

    it('defaults unit="qty" and measure=null', () => {
      const r = normalizeIngredients([{ ingredientName: 'X' }]);
      expect(r[0].unit).toBe('qty');
      expect(r[0].measure).toBe(null);
    });

    it('preserves dropdown object as-is', () => {
      const dd = { type: 'size', selectedText: '8 oz', selectedValue: 'small' };
      const r = normalizeIngredients([{ ingredientName: 'X', dropdown: dd }]);
      expect(r[0].dropdown).toEqual(dd);
    });

    it('defaults dropdown to null', () => {
      const r = normalizeIngredients([{ ingredientName: 'X' }]);
      expect(r[0].dropdown).toBe(null);
    });
  });

  it('handles a mixed array (string + multiple object shapes)', () => {
    const result = normalizeIngredients([
      'Lime',
      { ingredientName: 'Sour Cream', searchTerm: 'sour cream', qty: 2 },
      { product_name: 'Tortillas', search_term: 'flour tortillas', quantity: 3 },
      { name: 'Cilantro' },
    ]);
    expect(result).toHaveLength(4);
    expect(result[0].ingredientName).toBe('Lime');
    expect(result[1].ingredientName).toBe('Sour Cream');
    expect(result[1].searchTerm).toBe('sour cream');
    expect(result[1].qty).toBe(2);
    expect(result[2].ingredientName).toBe('Tortillas');
    expect(result[2].searchTerm).toBe('flour tortillas');
    expect(result[2].qty).toBe(3);
    expect(result[3].ingredientName).toBe('Cilantro');
  });
});
