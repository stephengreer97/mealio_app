// MEAL-19 — remembering WHICH product the user chose, not just what it is called.
//
// `searchTerm` is a display name, and re-deriving a product from it means the
// store's relevance ranking re-decides the choice on every cart run. These pin
// the three properties that make the identifier safe to store: it is keyed per
// rail so it cannot leak between stores, it never appears on a row nobody has
// chosen for, and it never forgets another store's choice.

import {
  storeProductKey,
  getStoreProduct,
  withStoreProduct,
  withoutStoreProducts,
} from '../../src/lib/storeProducts';
import { normalizeIngredients } from '../../src/lib/normalizeIngredients';

const MILK = { upc: '0001111041700', name: 'Kroger Whole Milk, 1 gal' };

describe('storeProductKey — the rail, not the banner', () => {
  it('files every Kroger-family banner under one key', () => {
    // One catalogue, one API, one UPC. A meal moved from Kroger to Ralphs keeps
    // its choices, which is the whole reason the key is the rail.
    for (const banner of ['kroger', 'ralphs', 'fred_meyer', 'king_soopers', 'harris_teeter']) {
      expect(storeProductKey(banner)).toBe('kroger');
    }
  });

  it('gives a non-Kroger store its own key', () => {
    expect(storeProductKey('heb')).toBe('heb');
    expect(storeProductKey('albertsons')).toBe('albertsons');
  });

  it('has no key at all for a missing store', () => {
    expect(storeProductKey(undefined)).toBe('');
    expect(storeProductKey(null)).toBe('');
    expect(storeProductKey('')).toBe('');
  });
});

describe('getStoreProduct — a choice cannot leak between stores', () => {
  const ing = { ingredientName: 'Whole Milk', storeProducts: { kroger: MILK } };

  it('returns the choice for the rail that made it', () => {
    expect(getStoreProduct(ing, 'kroger')).toEqual(MILK);
    expect(getStoreProduct(ing, 'ralphs')).toEqual(MILK);
  });

  it('returns nothing for a store that never made one', () => {
    // The failure this prevents: `searchTerm` is global and already reaches the
    // wrong store's search, where the text ladder recovers. An identifier
    // reaching the wrong store would add a real product nobody picked.
    expect(getStoreProduct(ing, 'heb')).toBeNull();
    expect(getStoreProduct(ing, 'albertsons')).toBeNull();
  });

  it('returns nothing for a row that has never been chosen for', () => {
    expect(getStoreProduct({ ingredientName: 'Whole Milk' }, 'kroger')).toBeNull();
    expect(getStoreProduct({ ingredientName: 'Whole Milk', storeProducts: {} }, 'kroger')).toBeNull();
  });

  it('ignores an entry with no usable identifier', () => {
    // Better to search than to look up an id that can only resolve to nothing.
    expect(getStoreProduct({ storeProducts: { kroger: { name: 'Milk' } } }, 'kroger')).toBeNull();
    expect(getStoreProduct({ storeProducts: { kroger: { upc: '  ', name: 'Milk' } } }, 'kroger')).toBeNull();
    expect(getStoreProduct({ storeProducts: { kroger: { upc: 12345 } } }, 'kroger')).toBeNull();
  });
});

describe('withStoreProduct — recording a choice', () => {
  it('records it under the rail and leaves the rest of the row alone', () => {
    const out = withStoreProduct({ ingredientName: 'Whole Milk', productQty: 2 }, 'ralphs', MILK);
    expect(out).toEqual({
      ingredientName: 'Whole Milk',
      productQty: 2,
      storeProducts: { kroger: MILK },
    });
  });

  it('does not forget another store’s choice', () => {
    const heb = { upc: 'heb-1', name: 'H-E-B Milk' };
    const out = withStoreProduct({ storeProducts: { heb } }, 'kroger', MILK);
    expect(out.storeProducts).toEqual({ heb, kroger: MILK });
  });

  it('does not mutate the ingredient it was given', () => {
    const before = { ingredientName: 'Whole Milk' };
    withStoreProduct(before, 'kroger', MILK);
    expect(before).toEqual({ ingredientName: 'Whole Milk' });
  });

  it('writes nothing when there is no store or no identifier', () => {
    const row = { ingredientName: 'Whole Milk' };
    expect(withStoreProduct(row, undefined, MILK)).toEqual(row);
    expect(withStoreProduct(row, 'kroger', { upc: '', name: 'Milk' })).toEqual(row);
  });
});

describe('withoutStoreProducts — a choice cannot outlive itself', () => {
  it('removes the key rather than emptying it', () => {
    const out = withoutStoreProducts({ ingredientName: 'Whole Milk', searchTerm: null, storeProducts: { kroger: MILK } });
    expect(out).toEqual({ ingredientName: 'Whole Milk', searchTerm: null });
    expect(JSON.stringify(out)).not.toContain('storeProducts');
  });

  it('leaves a row that never had one exactly as it was', () => {
    const row = { ingredientName: 'Whole Milk' };
    expect(withoutStoreProducts(row)).toBe(row);
  });

  it('does not mutate its input', () => {
    const before = { ingredientName: 'Whole Milk', storeProducts: { kroger: MILK } };
    withoutStoreProducts(before);
    expect(before.storeProducts).toEqual({ kroger: MILK });
  });
});

describe('normalizeIngredients carries the choice, and only when there is one', () => {
  it('round-trips a stored choice', () => {
    const [ing] = normalizeIngredients([
      { ingredientName: 'Whole Milk', qty: 1, unit: 'qty', storeProducts: { kroger: MILK } },
    ]);
    expect(ing.storeProducts).toEqual({ kroger: MILK });
  });

  it('leaves the key ABSENT on a row that has none', () => {
    // These objects are PATCHed back whole with no migration, so a row nobody
    // has chosen for has to serialise byte-for-byte the way it did before the
    // field existed — the same rule `prep` follows.
    const [ing] = normalizeIngredients([{ ingredientName: 'Whole Milk', qty: 1, unit: 'qty' }]);
    expect('storeProducts' in ing).toBe(false);
  });

  it('leaves the key absent rather than carrying an empty or unusable map', () => {
    for (const storeProducts of [{}, { kroger: {} }, { kroger: { name: 'Milk' } }, [], 'nope']) {
      const [ing] = normalizeIngredients([{ ingredientName: 'Whole Milk', qty: 1, unit: 'qty', storeProducts }]);
      expect('storeProducts' in ing).toBe(false);
    }
  });

  it('keeps the usable entries and drops the rest', () => {
    const [ing] = normalizeIngredients([{
      ingredientName: 'Whole Milk',
      qty: 1,
      unit: 'qty',
      storeProducts: { kroger: MILK, heb: { name: 'no id here' } },
    }]);
    expect(ing.storeProducts).toEqual({ kroger: MILK });
  });
});

describe('choose once, add forever — the id is saved with the choice', () => {
  // Until now the only thing kept was searchTerm, the product's DISPLAY NAME,
  // so every later run re-derived the product by searching that string and
  // letting the store's relevance ranking vote again. The choice was made once
  // and re-made on every run.
  const { mergeChosenProduct } = require('../../src/lib/saveChosenIngredient');

  it('records the store id beside the name', () => {
    const out = mergeChosenProduct(
      [{ ingredientName: 'Sour Cream', searchTerm: null }],
      'Sour Cream', 'Daisy Sour Cream Light - 16 Oz',
      { storeProduct: { upc: '184040105', name: 'Daisy Sour Cream Light - 16 Oz' }, storeId: 'albertsons' },
    );
    expect(out[0].searchTerm).toBe('Daisy Sour Cream Light - 16 Oz');
    expect(out[0].storeProducts.albertsons.upc).toBe('184040105');
  });

  it('drops another chain\'s id rather than leaving it beside a new name', () => {
    // searchTerm is one global field. A choice made at Albertsons renames the
    // row, so a surviving H-E-B id would resolve to a product the meal no
    // longer describes and add it without asking (MEAL-19).
    const out = mergeChosenProduct(
      [{ ingredientName: 'Milk', searchTerm: 'H-E-B Whole Milk',
         storeProducts: { heb: { upc: 'heb-1', name: 'H-E-B Whole Milk' } } }],
      'Milk', 'Lucerne Whole Milk',
      { storeProduct: { upc: 'alb-1', name: 'Lucerne Whole Milk' }, storeId: 'albertsons' },
    );
    expect(out[0].storeProducts.heb).toBeUndefined();
    expect(out[0].storeProducts.albertsons.upc).toBe('alb-1');
  });

  it('a row nobody chose for still serialises with no key at all', () => {
    // These objects are PATCHed back whole with no migration, so an untouched
    // row has to look exactly as it did before this field existed.
    const out = mergeChosenProduct(
      [{ ingredientName: 'Milk', searchTerm: null }],
      'Milk', 'Some Milk', {},
    );
    expect('storeProducts' in out[0]).toBe(false);
  });

  it('every Albertsons banner shares one key, H-E-B has its own', () => {
    // One Albertsons id is valid at Safeway and Vons — same catalogue. An H-E-B
    // id at Albertsons would add a real product nobody picked.
    expect(storeProductKey('safeway')).toBe(storeProductKey('vons'));
    expect(storeProductKey('heb')).not.toBe(storeProductKey('albertsons'));
  });
});
