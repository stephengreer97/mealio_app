import { albertsonsSearchQuery } from '../../src/lib/webview-scripts/albertsons';

describe('albertsonsSearchQuery', () => {
  it('trims a long product title to its first 5 words', () => {
    expect(
      albertsonsSearchQuery('PERDUE SIMPLY SMART ORGANIC Gluten Free Breaded Chicken Breast Tenders - 22 Oz'),
    ).toBe('PERDUE SIMPLY SMART ORGANIC Gluten');
  });

  it('leaves short names (<=5 words) unchanged', () => {
    expect(albertsonsSearchQuery('Hunt\'s Crushed Tomatoes - 28')).toBe("Hunt's Crushed Tomatoes - 28");
    expect(albertsonsSearchQuery('Bacon')).toBe('Bacon');
  });

  it('collapses extra whitespace and counts exactly 5 words', () => {
    const out = albertsonsSearchQuery('  Signature   SELECT  Crushed   Tomatoes  Diced  Whole  Peeled ');
    expect(out).toBe('Signature SELECT Crushed Tomatoes Diced');
    expect(out.split(' ')).toHaveLength(5);
  });

  it('handles empty input', () => {
    expect(albertsonsSearchQuery('')).toBe('');
  });
});
