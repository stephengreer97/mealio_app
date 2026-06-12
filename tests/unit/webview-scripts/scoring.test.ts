import {
  normDiacritic,
  normStrip,
  scoreMatch,
} from '../../../src/lib/webview-scripts/_scoring';

describe('normDiacritic', () => {
  it('lowercases', () => {
    expect(normDiacritic('Hello World')).toBe('hello world');
  });

  it('strips diacritics by NFD-decomposing then removing combining marks', () => {
    // "ñ" → "n" + COMBINING TILDE → "n"
    expect(normDiacritic('Jalapeño')).toBe('jalapeno');
    expect(normDiacritic('Crème Brûlée')).toBe('creme brulee');
    expect(normDiacritic('Naïve')).toBe('naive');
  });

  it('collapses non-alphanumeric runs into single spaces', () => {
    expect(normDiacritic('foo!!bar  baz')).toBe('foo bar baz');
    expect(normDiacritic('a,b,c')).toBe('a b c');
  });

  it('preserves digits', () => {
    expect(normDiacritic('Avg. 2.85 lbs')).toBe('avg 2 85 lbs');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normDiacritic('  trim me  ')).toBe('trim me');
  });
});

describe('normStrip', () => {
  // KNOWN LIMITATION (see _scoring.ts docstring): the strip-non-ASCII step
  // runs AFTER NFD decomposition, so for Latin-script accented chars normStrip
  // produces the same output as normDiacritic. These tests pin the current
  // behavior, not the originally-documented intent.
  it('matches normDiacritic for typical accented Latin input', () => {
    expect(normStrip('Jalapeño')).toBe(normDiacritic('Jalapeño'));
    expect(normStrip('Café résumé')).toBe(normDiacritic('Café résumé'));
  });

  it('matches normDiacritic for pure-ASCII input', () => {
    expect(normStrip('Boneless Chicken')).toBe('boneless chicken');
    expect(normStrip('Organic Tomatoes')).toBe('organic tomatoes');
  });

  it('strips exotic non-ASCII that does not NFD-decompose to ASCII (the actual divergence)', () => {
    // Chinese / emoji / etc. — these survive NFD intact, then get stripped.
    expect(normStrip('Product 🥬 Lettuce')).toBe('product lettuce');
    expect(normStrip('白菜 Lettuce')).toBe('lettuce');
  });
});

describe('scoreMatch', () => {
  it('returns 100 for identical strings (after normalization)', () => {
    expect(scoreMatch('Wegmans Sour Cream', 'Wegmans Sour Cream')).toBe(100);
    expect(scoreMatch('Jalapeño', 'JALAPEÑO')).toBe(100);
  });

  it('returns 100 for accented vs unaccented when the underlying letter is the same', () => {
    // Both normalizations turn "Jalapeño" and "Jalapeno" into "jalapeno".
    expect(scoreMatch('Wegmans Pickled Jalapeño', 'Wegmans Pickled Jalapeno')).toBe(100);
  });

  it('vetoes when a critical word is missing from candidate', () => {
    // "organic" is a critical word — a non-organic candidate must score 0
    // even if every other word matches.
    expect(scoreMatch('Organic Boneless Chicken', 'Boneless Chicken')).toBe(0);
    expect(scoreMatch('Unsalted Butter', 'Salted Butter')).toBe(0);
  });

  it('returns 0 when overlap is below 70%', () => {
    // "Sour Cream" (2 words) against "Cream Cheese" (2 words) — only 1
    // overlap = 50% < 70% threshold.
    expect(scoreMatch('Sour Cream', 'Cream Cheese')).toBe(0);
  });

  it('returns a partial score when overlap is between 70% and 100%', () => {
    // 4 words, 3 overlap = 75% → above threshold, partial score.
    // None of "wegmans"/"plain"/"yogurt"/"vanilla" are critical words.
    const s = scoreMatch('Wegmans Plain Yogurt Vanilla', 'Wegmans Plain Yogurt');
    expect(s).toBeGreaterThanOrEqual(70);
    expect(s).toBeLessThan(100);
  });

  it('caps partial scores at 99 (never accidentally returns 100 for non-exact matches)', () => {
    // 10 words, 9 overlap = 90%. Math.round(90) = 90, Math.min(99, 90) = 90.
    // The Math.min(99, ...) guard exists to ensure only EXACT matches return 100.
    const s = scoreMatch(
      'a b c d e f g h i j',  // 10 unique non-critical words
      'a b c d e f g h i'      // 9 of 10 overlap
    );
    expect(s).toBeLessThanOrEqual(99);
  });
});
