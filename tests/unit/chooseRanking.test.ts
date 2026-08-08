// Ranking for the choose-product flow (MEAL-28).
//
// The corpus-level evidence lives in tests/unit/match-harness.test.ts (the
// choose-flow columns). These tests pin the PROPERTIES that make the ordering
// safe to ship, which the corpus numbers cannot express — above all that this
// module reorders and does nothing else, so nothing it does can reach a cart.

import { rankChoiceCandidates, unrequestedWordCount } from '../../src/lib/chooseRanking';
import { scoreMatch } from '../../src/lib/webview-scripts/_scoring';

const named = (...names: string[]) => names.map((productName) => ({ productName }));
const order = (query: string, ...names: string[]) =>
  rankChoiceCandidates(query, named(...names)).map((c) => c.productName);

describe('unrequestedWordCount', () => {
  it('counts product words the query did not ask for', () => {
    expect(unrequestedWordCount('sour cream', 'Daisy Sour Cream, 16 oz')).toBe(3); // daisy, 16, oz
  });

  it('is zero when the product says nothing the query did not', () => {
    expect(unrequestedWordCount('sour cream', 'Sour Cream')).toBe(0);
  });

  it('counts a repeated word once', () => {
    expect(unrequestedWordCount('cream', 'Cream Soda Soda Soda')).toBe(1);
  });

  it('normalizes diacritics, so an accent is not an unrequested word', () => {
    expect(unrequestedWordCount('jalapeno', 'Jalapeño')).toBe(0);
  });
});

describe('rankChoiceCandidates', () => {
  describe('the reordering', () => {
    it('puts the product that covers the query above one that does not', () => {
      expect(order('sour cream', "Herr's Onion Chips - 13 OZ", 'Daisy Sour Cream, 16 oz')[0])
        .toBe('Daisy Sour Cream, 16 oz');
    });

    it('breaks a score tie toward the product that is less about something else', () => {
      // Both contain every query word, so scoreMatch ties them at 99. This is
      // the walmart/albertsons "sour cream" failure, in miniature.
      const q = 'sour cream';
      const dip = 'Daisy Sour Cream Creamy Ranch Dip, 16 oz Tub (Refrigerated)';
      const real = 'Daisy Sour Cream, 16 oz';
      expect(scoreMatch(q, dip)).toBe(scoreMatch(q, real));
      expect(order(q, dip, real)).toEqual([real, dip]);
    });

    it('keeps the store order when candidates tie on every key', () => {
      expect(order('sour cream', 'Sour Cream A', 'Sour Cream B', 'Sour Cream C'))
        .toEqual(['Sour Cream A', 'Sour Cream B', 'Sour Cream C']);
    });
  });

  describe('the tier boundary', () => {
    it('never floats an unrecognised product above a recognised one, however long its name', () => {
      // The name is deliberately long enough that the penalty, as a single
      // arithmetic score, would sink it BELOW the unrecognised products
      // (99 − 150 = −51, against −2 for "Motor Oil"). Only the tier split
      // keeps it on top. A shorter name passes this test whether the tier
      // split is there or not, which is what makes the length load-bearing
      // rather than decorative.
      const verbose = `Sour Cream ${Array.from({ length: 150 }, (_, i) => `filler${i}`).join(' ')}`;
      const unrelated = 'Motor Oil';
      expect(scoreMatch('sour cream', verbose)).toBeGreaterThan(0);
      expect(scoreMatch('sour cream', unrelated)).toBe(0);
      expect(unrequestedWordCount('sour cream', verbose)).toBeGreaterThan(100);
      expect(order('sour cream', unrelated, verbose, 'Duct Tape')).toEqual([verbose, unrelated, 'Duct Tape']);
    });

    it('leaves the store order alone among products it recognises none of', () => {
      // heb's "chicken thighs for fajitas": scoreMatch returns 0 on every
      // product, and the store's own relevance order is the right answer.
      const products = ['Chicken Thigh Fajitas Frozen', 'Chicken Breast Fajitas', 'Diced Chicken Tacos'];
      for (const p of products) expect(scoreMatch('HEB season chicken thighs for fajitas', p)).toBe(0);
      expect(order('HEB season chicken thighs for fajitas', ...products)).toEqual(products);
    });
  });

  describe('it reorders and does nothing else', () => {
    it('returns exactly the same candidate objects', () => {
      const input = named('Sour Cream & Onion Chips', 'Daisy Sour Cream', 'Motor Oil');
      const out = rankChoiceCandidates('sour cream', input);
      expect(out).toHaveLength(input.length);
      // Same multiset of names — nothing added, dropped or rewritten.
      expect(out.map((c) => c.productName).sort()).toEqual(input.map((c) => c.productName).sort());
      for (const c of out) expect(input).toContain(c); // identity, not a copy
    });

    it('does not mutate the input array', () => {
      const input = named('Sour Cream & Onion Chips', 'Daisy Sour Cream');
      const snapshot = [...input];
      rankChoiceCandidates('sour cream', input);
      expect(input).toEqual(snapshot);
    });

    it('carries every field of a candidate through untouched', () => {
      const rich = { productName: 'Daisy Sour Cream', price: '$3.49', outOfStock: false, weightOptions: [1, 2] };
      expect(rankChoiceCandidates('sour cream', [rich])[0]).toBe(rich);
    });

    it('handles an empty candidate list', () => {
      expect(rankChoiceCandidates('sour cream', [])).toEqual([]);
    });
  });

  describe('the add gate is untouched', () => {
    it('leaves scoreMatch === 100 as exact-equality-after-normalization', () => {
      // The property every store's add gate rests on. Ranking must not have
      // changed which strings reach 100 — this module imports scoreMatch and
      // never redefines it, and this is the assertion that says so.
      expect(scoreMatch('Daisy Sour Cream', 'Daisy Sour Cream')).toBe(100);
      expect(scoreMatch('Daisy Sour Cream', 'Daisy Sour Cream, 16 oz')).toBeLessThan(100);
      expect(scoreMatch('sour cream', 'Daisy Sour Cream')).toBeLessThan(100);
    });

    it('ranking a list does not make any candidate reach the add threshold', () => {
      const q = 'sour cream';
      const products = ['Sour Cream & Onion Chips', 'Daisy Sour Cream', 'Sour Cream Dip'];
      for (const c of rankChoiceCandidates(q, named(...products))) {
        expect(scoreMatch(q, c.productName)).toBeLessThan(100);
      }
    });
  });
});
