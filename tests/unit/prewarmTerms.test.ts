// What a prewarm looks up, and — the point of this file — what it does NOT.
//
// The prewarm now starts on the selection screen, before the user has asked for
// anything. Stephen's question when that was proposed: "what if I selected every
// meal, then removed all but 1. Are we going to do lookup on a dozen meals?"
//
// Two mechanisms answer that, and this file covers the pure one. The set of
// terms is derived from the CURRENT selection every time, so a meal that is no
// longer ticked contributes nothing. (The other half — that nothing is sent
// until the tapping stops — lives in the provider and is covered in
// tests/components/selection-search-prewarm.test.tsx.)

import { prewarmTermsFor, prewarmTermsForMeals, SEARCH_PREWARM_MAX_TERMS } from '../../src/lib/prewarmTerms';

const meal = (id: string, name: string, ingredients: any[]) => ({ id, name, ingredients });
const ing = (name: string, extra: Record<string, any> = {}) => ({
  ingredientName: name, productQty: 1, unit: 'qty', measure: null, searchTerm: null, ...extra,
});

describe('what the prewarm asks for', () => {
  it('asks for the ingredient name when nobody has chosen a product', () => {
    expect(prewarmTermsFor([ing('white onion')], 'albertsons')).toEqual(['white onion']);
  });

  it('asks for the chosen product name once one is set', () => {
    expect(prewarmTermsFor([ing('white onion', { searchTerm: 'Signature Farms White Onion' })], 'albertsons'))
      .toEqual(['Signature Farms White Onion']);
  });

  it('skips a row already chosen for AT THIS STORE — the run writes its saved id', () => {
    const row = ing('white onion', {
      searchTerm: 'Signature Farms White Onion',
      storeProducts: { albertsons: { upc: '960073721', name: 'White Onion' } },
    });
    expect(prewarmTermsFor([row], 'albertsons')).toEqual([]);
  });

  it('still asks when the saved product belongs to a DIFFERENT store', () => {
    const row = ing('white onion', {
      searchTerm: 'H-E-B White Onion',
      storeProducts: { heb: { upc: '123', name: 'White Onion', sku: '456' } },
    });
    expect(prewarmTermsFor([row], 'albertsons')).toEqual(['H-E-B White Onion']);
  });

  it('skips a zeroed-out row — it is not being bought, so it is not being searched', () => {
    expect(prewarmTermsFor([ing('white onion', { productQty: 0 })], 'albertsons')).toEqual([]);
  });

  it('asks once for a term two rows share', () => {
    expect(prewarmTermsFor([ing('garlic'), ing('garlic')], 'albertsons')).toEqual(['garlic']);
  });

  it('caps one batch, so ticking the whole list cannot open a burst on spec', () => {
    const many = Array.from({ length: SEARCH_PREWARM_MAX_TERMS + 20 }, (_, i) => ing(`item ${i}`));
    expect(prewarmTermsFor(many, 'albertsons')).toHaveLength(SEARCH_PREWARM_MAX_TERMS);
  });
});

describe('unticking a meal takes its terms out of the set', () => {
  const tikka = meal('m1', 'Tikka Masala', [ing('garam masala'), ing('chicken thighs')]);
  const tacos = meal('m2', 'Tacos', [ing('tortillas'), ing('ground beef')]);
  const soup = meal('m3', 'Soup', [ing('celery'), ing('stock')]);

  it('asks for everything while all three are ticked', () => {
    expect(prewarmTermsForMeals([tikka, tacos, soup], 'albertsons').sort())
      .toEqual(['celery', 'chicken thighs', 'garam masala', 'ground beef', 'stock', 'tortillas']);
  });

  it('asks for one meal only once the other two are unticked', () => {
    // The derivation runs against the selection AS IT STANDS. Nothing carries
    // over from the wider selection it passed through a moment ago.
    expect(prewarmTermsForMeals([tikka], 'albertsons').sort())
      .toEqual(['chicken thighs', 'garam masala']);
  });

  it('asks for nothing at all when the selection is emptied', () => {
    expect(prewarmTermsForMeals([], 'albertsons')).toEqual([]);
  });

  it('counts a term two meals share ONCE, so the cap is not spent twice over', () => {
    const a = meal('m1', 'A', [ing('onion', { searchTerm: 'Signature Farms White Onion' })]);
    const b = meal('m2', 'B', [ing('onion', { searchTerm: 'Signature Farms White Onion' })]);
    expect(prewarmTermsForMeals([a, b], 'albertsons')).toEqual(['Signature Farms White Onion']);
  });
});
