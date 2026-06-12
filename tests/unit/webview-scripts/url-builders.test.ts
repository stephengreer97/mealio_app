import {
  getWegmansSearchUrl,
  getWegmansWarmupUrl,
} from '../../../src/lib/webview-scripts/wegmans';

describe('getWegmansSearchUrl', () => {
  it('builds the canonical /shop/search?query=... URL', () => {
    expect(getWegmansSearchUrl('salsa')).toBe(
      'https://www.wegmans.com/shop/search?query=salsa'
    );
  });

  it('URL-encodes spaces and special characters', () => {
    expect(getWegmansSearchUrl('Wegmans Pico de Gallo Salsa')).toBe(
      'https://www.wegmans.com/shop/search?query=Wegmans%20Pico%20de%20Gallo%20Salsa'
    );
  });

  it('URL-encodes non-ASCII characters (the diacritic case)', () => {
    // Pickled Jalapeños — the ñ should be percent-encoded.
    expect(getWegmansSearchUrl('Pickled Jalapeños')).toBe(
      'https://www.wegmans.com/shop/search?query=Pickled%20Jalape%C3%B1os'
    );
  });

  it('encodes apostrophes and other commonly-stripped chars', () => {
    // Walmart-style apostrophe was a regression earlier in the session.
    // encodeURIComponent does NOT encode apostrophes by default — verify
    // that's the case so callers know the limitation.
    const url = getWegmansSearchUrl("Ben's Original");
    expect(url).toBe("https://www.wegmans.com/shop/search?query=Ben's%20Original");
  });
});

describe('getWegmansWarmupUrl', () => {
  it('returns the homepage URL', () => {
    expect(getWegmansWarmupUrl()).toBe('https://www.wegmans.com');
  });
});
