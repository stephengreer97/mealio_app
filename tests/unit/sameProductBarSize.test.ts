// A store that appends its pack size to every product name.
//
// Stephen's ALDI run, 2026-09-03: 14 of 14 items "failed to add" and every one
// went to review. "Seems like you are stripping the search name? You shouldn't
// do that." Nothing stripped it — ALDI ADDS the size, so his saved
// "Happy Harvest Crushed Tomatoes" could never equal their
// "Happy Harvest Crushed Tomatoes, 28 oz", and the add path requires equality.
//
// Every pair below is real: term and candidate both taken from that run's log.

import { sameProductBarSize, scoreMatch } from '../../src/lib/webview-scripts/_scoring';

describe('a trailing size is not a different product', () => {
  it.each([
    ['Happy Harvest Crushed Tomatoes', 'Happy Harvest Crushed Tomatoes, 28 oz'],
    ['Organic Broccoli', 'Organic Broccoli, 1 ct'],
    ['Friendly Farms Heavy Whipping Cream', 'Friendly Farms Heavy Whipping Cream, 32 fl oz'],
    ['Stonemill Ground Cumin', 'Stonemill Ground Cumin, 2 oz'],
    ['Simply Nature Organic Smoked Paprika', 'Simply Nature Organic Smoked Paprika, 1.6 oz'],
    ['Friendly Farms Nonfat Plain Greek Yogurt', 'Friendly Farms Nonfat Plain Greek Yogurt, 32 oz'],
    ['Simply Nature Organic Ginger Stir in Paste', 'Simply Nature Organic Ginger Stir in Paste, 2.8 oz'],
    ['Earthly Grains Basmati Ready to Serve Rice', 'Earthly Grains Basmati Ready to Serve Rice, 8.8 oz'],
  ])('%s is the same product as %s', (term, candidate) => {
    expect(sameProductBarSize(term, candidate)).toBe(true);
    // The reason this rule has to exist at all: the score never reaches 100.
    expect(scoreMatch(term, candidate)).toBeLessThan(100);
  });

  it('handles a name that carries two size fragments', () => {
    expect(sameProductBarSize('Cilantro Bunch', 'Cilantro Bunch, each, 1 each')).toBe(true);
  });
});

describe('but EXTRA WORDS are a different product', () => {
  // The whole reason this is not simply "accept a score of 99". Each of these
  // scores 99 and each is something the user did not ask for.
  it.each([
    // Different brand AND a different cut, from the same run.
    ['Organic Broccoli', "Season's Choice Organic Broccoli Florets, 10 oz"],
    // ALDI stocks Sticks, not Quarters. This one belongs on the review screen.
    ['Countryside Creamery Salted Butter Quarters', 'Countryside Creamery Salted Butter Sticks, 16 oz'],
    ['Cilantro', 'Cilantro Bunch, each, 1 each'],
  ])('%s is NOT %s', (term, candidate) => {
    expect(sameProductBarSize(term, candidate)).toBe(false);
  });

  it('is not fooled by a shorter candidate', () => {
    // The term is the longer string here; nothing about that makes them equal.
    expect(sameProductBarSize('Happy Harvest Crushed Tomatoes, 28 oz', 'Happy Harvest Crushed Tomatoes')).toBe(false);
  });

  it('an identical name is left to scoreMatch, which already returns 100', () => {
    expect(sameProductBarSize('Stonemill Ground Cumin', 'Stonemill Ground Cumin')).toBe(false);
    expect(scoreMatch('Stonemill Ground Cumin', 'Stonemill Ground Cumin')).toBe(100);
  });

  it('a different size of a DIFFERENT product still does not match', () => {
    expect(sameProductBarSize('Happy Harvest Crushed Tomatoes', 'Happy Harvest Diced Tomatoes, 14.5 oz')).toBe(false);
  });
});
