// Which stores a query finds (MEAL-229).
//
// Written against the real BUNDLED_STORES rather than fixtures: the cases worth
// having are the actual names, and a fixture called "Test Store" proves nothing
// about "Pick 'n Save".

import { BUNDLED_STORES } from '../../src/constants/stores';
import { filterStores, storeMatchesQuery } from '../../src/lib/storeSearch';

const names = (query: string) => filterStores(BUNDLED_STORES, query).map((s) => s.name);
const store = (id: string) => BUNDLED_STORES.find((s) => s.id === id)!;

describe('typing a store name', () => {
  it('finds it', () => {
    expect(names('wegmans')).toEqual(['Wegmans']);
  });

  it('ignores case', () => {
    expect(names('WEGMANS')).toEqual(['Wegmans']);
  });

  it('matches on any part of the name, not just the start', () => {
    expect(names('meyer')).toEqual(['Fred Meyer']);
  });

  it('does not care about the punctuation in the name', () => {
    // The three that fail a raw comparison, which is the whole reason for the
    // second comparison on a stripped form.
    expect(names('heb')).toEqual(['H-E-B']);
    expect(names('jewel')).toEqual(['Jewel-Osco']);
    expect(names('picknsave')).toEqual(["Pick 'n Save"]);
  });

  it('still matches a name typed with its spaces', () => {
    expect(names('fred meyer')).toEqual(['Fred Meyer']);
  });

  it('returns nothing for a store that is not there, rather than something close', () => {
    // Substring, not fuzzy: "vans" must not find Vons. The picker writes the id
    // onto a saved meal, so a plausible wrong row costs more than an empty one.
    expect(names('vans')).toEqual([]);
  });
});

describe('typing a family name', () => {
  it('surfaces the banners under it', () => {
    const found = names('kroger');
    expect(found).toContain('Kroger');
    expect(found).toContain('Ralphs');
    expect(found).toContain("Fry's Food");
    expect(found).toContain('Harris Teeter');
  });

  it('surfaces the Albertsons banners, whose names say nothing about the family', () => {
    const found = names('albertsons');
    expect(found).toContain('Albertsons');
    expect(found).toContain('Tom Thumb');
    expect(found).toContain('Jewel-Osco');
    expect(found).toContain("Shaw's");
  });

  it('does not put every store in one family', () => {
    const kroger = names('kroger');
    expect(kroger).not.toContain('H-E-B');
    expect(kroger).not.toContain('Tom Thumb');
    expect(kroger).not.toContain('Walmart');
  });
});

describe('an empty query', () => {
  it('is everything, in the order it was given', () => {
    expect(filterStores(BUNDLED_STORES, '')).toEqual(BUNDLED_STORES);
    expect(filterStores(BUNDLED_STORES, '   ')).toEqual(BUNDLED_STORES);
    expect(storeMatchesQuery(store('heb'), '')).toBe(true);
  });

  it('is everything when the query is only punctuation, not nothing', () => {
    // "-" squashes to an empty string. Answering "no matches" for a stray
    // keystroke would empty the picker with no way to see why.
    expect(filterStores(BUNDLED_STORES, '-')).toEqual(BUNDLED_STORES);
  });
});
