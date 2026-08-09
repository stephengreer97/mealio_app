// MEAL-160 — a critical word must mean the CONCEPT, not one spelling of it.
//
// The veto is a token-membership test, and the normalisers turn every hyphen
// into a space. So `lowfat` sitting in the set as a lone token misfired in both
// directions at once — measured on origin/main, and reproduced byte-for-byte
// here as the "before" column:
//
//   "low fat cottage cheese"  vs "Full Fat Cottage Cheese"  75 → 0
//   "lowfat cottage cheese"   vs "Low-Fat Cottage Cheese"    0 → 100
//
// The first is the dangerous one. The natural way to write the ingredient
// tokenises to `low` + `fat`, neither of which is critical, so the entry
// protected NOTHING and a full-fat product stayed eligible for auto-pick
// against a low-fat request. The second is the mirror: when the joined spelling
// did appear, no hyphenated or spaced label could ever satisfy it, so the RIGHT
// product scored zero.
//
// The ticket asked for an audit of the whole set while fixing. It found the same
// shape on the two-token entries: `grassfed` and `cagefree` queries both scored
// 0 against the correctly-spelled product.

import { scoreMatch } from '../../../src/lib/webview-scripts/_scoring';

describe('the veto fires for the natural spelling of the ingredient', () => {
  it('rejects a full-fat product for a "low fat" request', () => {
    // The regression that matters. 75 is above nothing in particular, but it is
    // not 0 — the product stayed eligible, and eligibility is what feeds
    // auto-pick and the choose-screen ranking.
    expect(scoreMatch('low fat cottage cheese', 'Full Fat Cottage Cheese')).toBe(0);
  });

  it('rejects it for the joined spelling too, which always worked', () => {
    expect(scoreMatch('nonfat cottage cheese', 'Full Fat Cottage Cheese')).toBe(0);
    expect(scoreMatch('non fat cottage cheese', 'Full Fat Cottage Cheese')).toBe(0);
  });

  it('still rejects a product missing the concept entirely', () => {
    expect(scoreMatch('low fat milk', 'Whole Milk')).toBe(0);
  });
});

describe('and stops zeroing the product that is actually right', () => {
  it.each([
    ['lowfat cottage cheese', 'Low-Fat Cottage Cheese'],
    ['lowfat cottage cheese', 'Low Fat Cottage Cheese'],
    ['low fat cottage cheese', 'Lowfat Cottage Cheese'],
    ['grassfed beef', 'Grass Fed Beef'],
    ['grass fed beef', 'Grassfed Beef'],
    ['cagefree eggs', 'Cage Free Eggs'],
    ['cage free eggs', 'Cagefree Eggs'],
    ['freerange chicken', 'Free Range Chicken'],
  ])('scores %s against %s as an exact match', (query, product) => {
    expect(scoreMatch(query, product)).toBe(100);
  });

  it('leaves the spellings that already agreed alone', () => {
    // Guard against "fixing" this by loosening the veto: these were correct
    // before and must be unchanged.
    expect(scoreMatch('lowfat cottage cheese', 'Lowfat Cottage Cheese')).toBe(100);
    expect(scoreMatch('grass fed beef', 'Grass-Fed Ground Beef')).toBe(99);
    expect(scoreMatch('cage free eggs', 'Cage-Free Large Eggs')).toBe(99);
  });
});

describe('the collapse does not quietly weaken the veto', () => {
  it('does not let a collapsed phrase match a product with only half of it', () => {
    expect(scoreMatch('grass fed beef', 'Grain Fed Beef')).toBe(0);
    expect(scoreMatch('cage free eggs', 'Free Eggs')).toBe(0);
  });

  it('vetoes a long request whose concept the product lacks', () => {
    // These are the cases that prove the canonical tokens are in CRITICAL_WORDS
    // and doing work, rather than being decoration.
    //
    // The short requests above return 0 from the 70% overlap FLOOR, not from the
    // veto — "grass fed beef" against "Grain Fed Beef" is 1 matching token out of
    // 2. So they pass whether or not `grassfed` is critical, and a mutant that
    // deleted the three canonical entries survived the entire suite until these
    // existed. Add a few more words and the floor stops covering for it:
    //
    //   "organic grass fed ground beef chuck" vs "Organic Ground Beef Chuck"
    //       4 of 5 tokens match = 80, and 80 is eligible for auto-pick.
    //   "cage free large brown eggs" vs "Large Brown Eggs" = 75.
    //
    // Both are a plain product answering a request that specifically asked for
    // something it is not.
    expect(scoreMatch('organic grass fed ground beef chuck', 'Organic Ground Beef Chuck')).toBe(0);
    expect(scoreMatch('cage free large brown eggs', 'Large Brown Eggs')).toBe(0);
    expect(scoreMatch('free range whole chicken breast', 'Whole Chicken Breast')).toBe(0);
  });

  it('leaves unrelated critical words firing', () => {
    expect(scoreMatch('organic boneless chicken', 'Boneless Chicken')).toBe(0);
    expect(scoreMatch('large eggs', 'Small Eggs')).toBe(0);
  });

  it('does not collapse across a word boundary it should not', () => {
    // "low" and "fat" adjacent by accident in a longer name must still collapse
    // the same way on both sides, which is the whole point — but a name where
    // they are NOT adjacent must not.
    expect(scoreMatch('low sodium fat free broth', 'Low Sodium Fat Free Broth')).toBe(100);
  });
});
