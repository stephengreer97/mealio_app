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

/**
 * MEAL-208 — what the 5 is, now that it has been measured.
 *
 * The cap was written to dodge an Albertsons rejection. On the device, against
 * a live store (id 177) and both search paths, no such rejection exists: 13-word
 * real titles, 22-word padded ones and a 2000-character query all answered
 * HTTP 200 with a healthy primaryProducts.appCode and a non-empty docs array.
 * The only refusals seen were gateway URL-length errors (431, then 414) beyond
 * roughly 2,500 characters of query.
 *
 * These pin the two facts that make the number safe to reason about:
 *  - it is the FIRST five words that survive, so the size suffix is what a
 *    person handed this search box loses;
 *  - it is confined to the manual-mode URL. If it ever reappears on a path that
 *    feeds automated matching, that is a regression, not a tightening.
 */
describe('albertsonsSearchQuery — MEAL-208 measured boundaries', () => {
  it('drops the TAIL, which is where the size lives', () => {
    // The ticket's own example.
    expect(albertsonsSearchQuery('Signature SELECT Rice Basmati - 32 Oz'))
      .toBe('Signature SELECT Rice Basmati -');
  });

  it('leaves a full 13-word title alone below the cap and cuts it above', () => {
    const full = 'Lundberg Family Farms Regenerative Organic Certified California White Basmati Rice - 32 Oz';
    // Measured live: this exact string returns 4 products with the right one
    // first. Nothing about the store requires the cut.
    expect(albertsonsSearchQuery(full)).toBe('Lundberg Family Farms Regenerative Organic');
  });

  it('never truncates on characters — only on words', () => {
    const longTokens = 'Simple-Truth-Organic Grass-Fed-Free-Range Boneless-Skinless-Chicken-Breast Family-Size-Value-Pack Individually-Quick-Frozen';
    const out = albertsonsSearchQuery(longTokens);
    expect(out.split(' ')).toHaveLength(5);
    expect(out.length).toBeGreaterThan(100);
    // Measured: Albertsons answers 200 with results well past this length.
    expect(out).toBe(longTokens);
  });
});

/**
 * The control for the measurement above, kept as prose because it is a fact
 * about the store rather than about this function: Albertsons search cannot
 * return zero results. Gibberish ("zzqxwvtplkj") answers with 2 products and
 * "purple monkey dishwasher scaffolding tuesday" with 495, so "a long query
 * returned nothing" was never an observation this store can produce. Its only
 * search failure is the MEAL-207 envelope — HTTP 200 with
 * primaryProducts.appCode 400 and no docs array — which is independent of query
 * length and did not occur once during the sweep.
 */
