// MEAL-208. The 5-word cap is gone, and this is what replaced it.
//
// The cap was written to dodge an Albertsons rejection (43b4f83). Measured on
// the device against a live store and BOTH search paths — the pgmsearch
// operation the rail uses and the rendered /shop/search-results.html page — no
// such rejection exists:
//
//   13-word real title    200, healthy appCode, 4 results, exact product FIRST
//   22 words / 124 chars  200, 1 result
//   341 words / 2000 ch   200, 1 result
//   ~2500+ characters     431 then 414 from the gateway — a URL-length limit,
//                         nothing to do with search
//
// AND THE CONTROL, because "never returned zero" means nothing without one:
// this search CANNOT return zero. "zzqxwvtplkj" answers with 2 products,
// "purple monkey dishwasher scaffolding tuesday" with 495. So "a full title
// returns zero results" is not an observation this store can produce, which is
// what made the original cap a guess rather than a measurement.
//
// The only consumer was getSearchUrl, and its only consumer is manual mode: a
// person handed the store's own search page. The network rail sends the full
// term and always has, so no automated matching ever passed through here.
import { albertsonsSearchQuery } from '../../src/lib/webview-scripts/albertsons';
import { getScripts } from '../../src/lib/webview-scripts/albertsons';

describe('albertsonsSearchQuery', () => {
  it('sends the WHOLE product name', () => {
    // The exact case the cap used to break: the size lives in the tail, and
    // trimming dropped it before the store ever saw it.
    const full = 'PERDUE SIMPLY SMART ORGANIC Gluten Free Breaded Chicken Breast Tenders - 22 Oz';
    expect(albertsonsSearchQuery(full)).toBe(full);
  });

  it('keeps the size suffix the old cap threw away', () => {
    const full = 'Signature SELECT Rice Basmati - 32 Oz';
    expect(albertsonsSearchQuery(full)).toBe(full);
    // Measured: this exact query returns 32 matches with that product on top —
    // the opposite of what the cap's comment claimed.
    expect(albertsonsSearchQuery(full)).toContain('32 Oz');
  });

  it('trims surrounding whitespace and nothing else', () => {
    expect(albertsonsSearchQuery('  Hunt\'s Crushed Tomatoes - 28  ')).toBe("Hunt's Crushed Tomatoes - 28");
  });

  it('handles empty input', () => {
    expect(albertsonsSearchQuery('')).toBe('');
    expect(albertsonsSearchQuery(null as unknown as string)).toBe('');
  });

  it('caps nothing, at any length', () => {
    // A named number here would be the cap coming back by the side door.
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(albertsonsSearchQuery(long)).toBe(long);
  });
});

describe('the search URL a person is handed', () => {
  it('carries the full name through to the store page', () => {
    // The property that actually matters — the trim being gone is only useful
    // if the URL builder passes the whole thing on.
    const full = 'PERDUE SIMPLY SMART ORGANIC Gluten Free Breaded Chicken Breast Tenders - 22 Oz';
    const url = getScripts('safeway').getSearchUrl!(full);
    expect(decodeURIComponent(url)).toContain(full);
  });
});
