// Unit tests for normalizeIngredients.
//
// This function smooths over the many shapes ingredients can take in the DB
// (string, object with productName, object with product_name, object with
// ingredientName, snake_case search_term vs camelCase searchTerm, etc.).
// Per CLAUDE.md it is the canonical entry point for downstream code so the
// rest of the app sees a single shape. Mistakes here ripple everywhere.

import {
  normalizeIngredients,
  normalizePresetIngredients,
  packageQtyFor,
} from '../../src/lib/normalizeIngredients';

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
      const r = normalizeIngredients([{ ingredientName: 'Lemon', qty: 3 }]);
      expect(r[0].qty).toBe(3);
      expect(r[0].productQty).toBe(3); // absent productQty derives from the line
    });

    it('falls back to quantity', () => {
      const r = normalizeIngredients([{ ingredientName: 'Lemon', quantity: 4 }]);
      expect(r[0].qty).toBe(4);
      expect(r[0].productQty).toBe(4);
    });

    // MEAL-108: the derived productQty is not `qty` — it consults unit and name.
    // A name whose pack form is unknown keeps 1 however large qty is, because
    // deriving a package count there is what over-charges. `qty` is untouched.
    it('does not derive a package count for a name of unknown pack form', () => {
      const r = normalizeIngredients([{ ingredientName: 'Corn tortillas', qty: 12 }]);
      expect(r[0].qty).toBe(12);
      expect(r[0].productQty).toBe(1);
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

    it('carries purchaseWeight through (sold-by-weight items) so it survives reads', () => {
      const r = normalizeIngredients([{ ingredientName: 'Ground Beef', searchTerm: 'H-E-B Ground Beef', purchaseWeight: 1.5 }]);
      expect((r[0] as any).purchaseWeight).toBe(1.5);
    });

    it('omits purchaseWeight when absent (normal items)', () => {
      const r = normalizeIngredients([{ ingredientName: 'Milk' }]);
      expect('purchaseWeight' in r[0]).toBe(false);
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

// MEAL-108. These pin the one number in the app that spends money, so the
// asymmetry is asserted explicitly: too small is an annoyance, too large is a
// charge. Every "stays at 1" case below is a case where the recipe's amount was
// available and deliberately NOT read as a package count.
describe('packageQtyFor', () => {
  const line = (ingredientName: string, qty: unknown, unit: unknown) => ({ ingredientName, qty, unit });

  it('reads the count off a countable line that is sold loose', () => {
    expect(packageQtyFor(line('Eggplant', 3, 'qty'))).toBe(3);
    expect(packageQtyFor(line('Lemon', 2, 'qty'))).toBe(2);
    expect(packageQtyFor(line('Ripe Hass avocados', 4, 'qty'))).toBe(4);
  });

  it('buys one package for a measured amount, whatever the amount', () => {
    // The catalogue stores the AMOUNT in qty on these rows ({qty: 3, unit:
    // 'tbsp'}), so reading qty without the unit is three bottles of olive oil.
    expect(packageQtyFor(line('Olive oil', 3, 'tbsp'))).toBe(1);
    expect(packageQtyFor(line('Beef short ribs', 4, 'lb'))).toBe(1);
    expect(packageQtyFor(line('Tahini', 0.25, 'cups'))).toBe(1);
    expect(packageQtyFor(line('Cheddar', 8, 'oz'))).toBe(1);
    expect(packageQtyFor(line('Flour', 500, 'g'))).toBe(1);
  });

  it("buys one package for a cook's unit — a part of a package, not a package", () => {
    // "3 cloves garlic" is one head, not three; "4 sprigs thyme" one bunch.
    expect(packageQtyFor(line('Garlic', 3, 'cloves'))).toBe(1);
    expect(packageQtyFor(line('Thyme', 4, 'sprigs'))).toBe(1);
    expect(packageQtyFor(line('Parsley', 2, 'bunches'))).toBe(1);
    expect(packageQtyFor(line('Prosciutto', 6, 'slices'))).toBe(1);
    expect(packageQtyFor(line('Celery', 3, 'stalk'))).toBe(1);
  });

  it('buys one for package-ish words with no vocabulary entry', () => {
    // Often N is right, but a can sold as a 4-pack turns 2 into 8. One can only
    // ever be too small, and the stepper is right there.
    expect(packageQtyFor(line('Diced tomatoes', 2, 'cans'))).toBe(1);
    expect(packageQtyFor(line('Red wine', 2, 'bottle'))).toBe(1);
    expect(packageQtyFor(line('Puff pastry', 3, 'pkg'))).toBe(1);
    expect(packageQtyFor(line('Garlic', 2, 'head'))).toBe(1);
  });

  // The part that costs money. Each of these carries unit 'qty' in the live
  // catalogue, with the sub-package noun hidden in the NAME.
  it('does NOT read a count off a sub-package noun in the name', () => {
    expect(packageQtyFor(line('Garlic cloves', 4, 'qty'))).toBe(1);   // 4 heads of garlic
    expect(packageQtyFor(line('Corn tortillas', 12, 'qty'))).toBe(1); // 12 packs
    expect(packageQtyFor(line('Bacon strips', 6, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Egg yolks', 10, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Nori sheets', 4, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Dumpling wrappers', 30, 'qty'))).toBe(1);
    expect(packageQtyFor(line('American cheese slices', 8, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Celery stalks', 6, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Bay leaves', 3, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Toothpicks', 8, 'qty'))).toBe(1);
  });

  it('does not read a count off a bagged-or-loose item', () => {
    // The near misses. "3 carrots" must not fetch three 1 lb bags.
    expect(packageQtyFor(line('Carrots', 3, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Russet potatoes', 4, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Eggs', 6, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Scallions', 4, 'qty'))).toBe(1);
  });

  it('rejects a pack-form qualifier even when the head noun is on the list', () => {
    // Green onions come in a bunch, crushed tomatoes in a can, cherry tomatoes
    // in a punnet — all three end in a word the list knows.
    expect(packageQtyFor(line('Green onions', 4, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Crushed tomatoes', 2, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Cherry tomatoes', 3, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Sundried tomatoes', 2, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Chipotle peppers in adobo', 3, 'qty'))).toBe(1);
    // But the plain item still derives.
    expect(packageQtyFor(line('Yellow onion', 2, 'qty'))).toBe(2);
  });

  it('finds the head noun through leading qualifiers', () => {
    expect(packageQtyFor(line('Granny Smith apples', 2, 'qty'))).toBe(2);
    expect(packageQtyFor(line('Large eggplants', 2, 'qty'))).toBe(2);
    expect(packageQtyFor(line('Ripe Hass avocado', 2, 'qty'))).toBe(2);
  });

  it('gives up on a TRAILING preparation word, and that is the safe direction', () => {
    // "Ripe tomatoes, halved" has `halved` as its head noun, so the rule does not
    // recognise it and the row keeps 1. Deliberately not fixed by adding a
    // preparation vocabulary: the cost of this miss is a shopper tapping + once,
    // and every word added to make it match is a word that could let a bagged
    // item through. The catalogue's own examples ("Bell peppers mixed", "Eggs
    // separated") are not on the allow-list anyway.
    expect(packageQtyFor(line('Ripe tomatoes, halved', 3, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Onions, thinly sliced', 2, 'qty'))).toBe(1);
  });

  it('rounds a fractional count UP to a whole package', () => {
    // "1/2 onion" is still one onion to buy. Never 0 — that reads as excluded.
    expect(packageQtyFor(line('Onion', 0.5, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', 0.25, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Eggplant', 1.5, 'qty'))).toBe(2);
  });

  it('falls back to 1 for absent, zero, negative and unparseable amounts', () => {
    expect(packageQtyFor(line('Lemon', undefined, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', null, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', 0, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', -3, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', NaN, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', 'lots', 'qty'))).toBe(1);
    expect(packageQtyFor(line('Lemon', 3, undefined))).toBe(1);
    expect(packageQtyFor({ qty: 3, unit: 'qty' })).toBe(1); // no name at all
    expect(packageQtyFor({})).toBe(1);
  });

  it('reads a numeric string count', () => {
    expect(packageQtyFor(line('Lemon', '4', 'qty'))).toBe(4);
  });

  it('never truncates a real word into a list match', () => {
    // "Peas" must not become "pea"→ nothing, and "Molasses" must not lose "es"
    // into a match. Both are simply not on the list.
    expect(packageQtyFor(line('Peas', 3, 'qty'))).toBe(1);
    expect(packageQtyFor(line('Molasses', 2, 'qty'))).toBe(1);
  });
});

describe('normalizeIngredients — absent productQty derives from qty AND unit', () => {
  it('does not read a measured amount as a package count', () => {
    const r = normalizeIngredients([{ ingredientName: 'Olive oil', qty: 3, unit: 'tbsp' }]);
    expect(r[0].qty).toBe(3);
    expect(r[0].productQty).toBe(1);
  });

  it('still reads a countable amount as a package count', () => {
    const r = normalizeIngredients([{ ingredientName: 'Eggplant', qty: 3, unit: 'qty' }]);
    expect(r[0].productQty).toBe(3);
  });

  it('still trusts an explicit productQty (a user meal choice)', () => {
    const r = normalizeIngredients([{ ingredientName: 'Olive oil', qty: 3, unit: 'tbsp', productQty: 2 }]);
    expect(r[0].productQty).toBe(2);
  });
});

describe('normalizePresetIngredients', () => {
  it('recovers the recipe count a stale productQty was hiding', () => {
    // The MEAL-108 row, verbatim from the live catalogue.
    const r = normalizePresetIngredients([
      { ingredientName: 'Eggplant', qty: 3, unit: 'qty', measure: '3', productQty: 1, searchTerm: null },
    ]);
    expect(r[0].productQty).toBe(3);
    expect(r[0].qty).toBe(3);
    expect(r[0].measure).toBe('3');
  });

  it('leaves a measured line buying one product', () => {
    const r = normalizePresetIngredients([
      { ingredientName: 'Lemon juice', qty: 3, unit: 'tbsp', measure: '3', productQty: 1 },
      { ingredientName: 'Tahini', qty: 0.25, unit: 'cups', measure: '1/4', productQty: 1 },
      { ingredientName: 'Cod fillets', qty: 1.5, unit: 'lb', measure: '1 1/2', productQty: 1 },
    ]);
    expect(r.map((i) => i.productQty)).toEqual([1, 1, 1]);
  });

  it("leaves a cook's unit buying one product", () => {
    const r = normalizePresetIngredients([
      { ingredientName: 'Celery', qty: 3, unit: 'stalk', measure: '3', productQty: 1 },
      { ingredientName: 'Thyme', qty: 4, unit: 'sprigs', measure: '4', productQty: 1 },
      { ingredientName: 'Diced tomatoes', qty: 2, unit: 'cans', measure: '2', productQty: 1 },
    ]);
    expect(r.map((i) => i.productQty)).toEqual([1, 1, 1]);
  });

  it('keeps a to-taste line at one', () => {
    const r = normalizePresetIngredients([
      { ingredientName: 'salt', qty: 1, unit: 'qty', measure: null, productQty: 1 },
    ]);
    expect(r[0].productQty).toBe(1);
    expect(r[0].measure).toBeNull();
  });

  it('rounds a fractional countable up rather than excluding it', () => {
    const r = normalizePresetIngredients([
      { ingredientName: 'Red onion', qty: 0.5, unit: 'qty', measure: '1/2', productQty: 1 },
    ]);
    expect(r[0].productQty).toBe(1);
  });

  it('never lowers a productQty somebody set deliberately', () => {
    // The 51 catalogue rows whose productQty is not 1 today. Several are names
    // the derivation is NOT confident about, so a blanket override would drop
    // "Large Eggs" from 6 to 1 and throw away the only real number on the row.
    const rows = [
      { ingredientName: 'Large Eggs', qty: 6, unit: 'qty', measure: '6', productQty: 6 },
      { ingredientName: 'Corn Tortillas', qty: 12, unit: 'qty', measure: '12', productQty: 12 },
      { ingredientName: 'Garlic', qty: 5, unit: 'qty', measure: '5', productQty: 5 },
    ];
    expect(normalizePresetIngredients(rows).map((i) => i.productQty)).toEqual([6, 12, 5]);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const rows = [
      { ingredientName: 'Eggplant', qty: 3, unit: 'qty', measure: '3', productQty: 1 },
      { ingredientName: 'Large Eggs', qty: 6, unit: 'qty', measure: '6', productQty: 6 },
      { ingredientName: 'Olive oil', qty: 4, unit: 'tbsp', measure: '4', productQty: 1 },
    ];
    const once = normalizePresetIngredients(rows);
    expect(once.map((i) => i.productQty)).toEqual([3, 6, 1]);
    expect(normalizePresetIngredients(once).map((i) => i.productQty)).toEqual([3, 6, 1]);
  });

  it('is raise-only: the derived count never pulls a row down', () => {
    const r = normalizePresetIngredients([
      // Derivation says 1 (bagged-or-loose); stored says 4. Stored wins.
      { ingredientName: 'Carrots', qty: 4, unit: 'qty', measure: '4', productQty: 4 },
      // Derivation says 2; stored says 1. Derivation wins.
      { ingredientName: 'Lemon', qty: 2, unit: 'qty', measure: '2', productQty: 1 },
    ]);
    expect(r.map((i) => i.productQty)).toEqual([4, 2]);
  });

  it('does not touch a weight-priced row', () => {
    // Its quantity IS the chosen absolute weight; productQty carries no meaning
    // there, so asserting a count over it would be meaningless at best.
    const r = normalizePresetIngredients([
      { ingredientName: 'Sliced turkey', qty: 3, unit: 'qty', productQty: 4, purchaseWeight: 1.5 },
    ]);
    expect(r[0].productQty).toBe(4);
    expect(r[0].purchaseWeight).toBe(1.5);
  });

  it('derives from the legacy seed shape, which has no unit', () => {
    // The seed shape is {"productName": …, "searchTerm": …, "quantity": N} — no
    // `unit` key, which normalizes to the count unit. Carrots is the seed's own
    // example and deliberately does NOT derive (bagged-or-loose); a lime does.
    const r = normalizePresetIngredients([
      { productName: 'Limes', searchTerm: 'limes', quantity: 2 },
      { productName: 'Carrots', searchTerm: 'carrots', quantity: 2 },
    ]);
    expect(r[0].ingredientName).toBe('Limes');
    expect(r[0].productQty).toBe(2);
    expect(r[1].productQty).toBe(1);
  });

  it('tolerates the shapes normalizeIngredients tolerates', () => {
    expect(normalizePresetIngredients(null)).toEqual([]);
    expect(normalizePresetIngredients(['Lime'])[0].productQty).toBe(1);
  });
});
