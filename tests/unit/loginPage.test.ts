// The sign-in screen must show something you can sign in on.
//
// FOUND ON THE PIXEL, 2026-09-04. H-E-B, signed out, the sheet correctly
// reached its login step — and rendered a blank white page under the words
// "Log into your H-E-B account once and Mealio won't ask again". There was
// nothing to type into.
//
// The login step skips its navigation when the WebView is "already on the
// store", so that a store whose check script had opened a sign-in menu did not
// have that state navigated away. The test for "already on the store" was the
// URL containing the store's domain. Rail stores park on robots.txt, which is
// on the store's domain and is a text file.
//
// Every rail store parks there, so this was every rail store: H-E-B, the
// fifteen Albertsons banners, ALDI, Wegmans and Walmart.
import { canSignInHere } from '../../src/lib/login-page';

const HEB = { domain: 'heb.com', railUrl: 'https://www.heb.com/robots.txt' };

describe('where the user can actually sign in', () => {
  it('not on the rail\'s quiet page, however store-shaped its URL is', () => {
    // THE BUG, exactly as it shipped.
    expect(canSignInHere({ url: 'https://www.heb.com/robots.txt', ...HEB })).toBe(false);
  });

  it('not on the quiet page with a cache-buster either', () => {
    // What the URL really looks like — every navigation carries one, and an
    // equality check would have missed the case that actually occurs.
    expect(canSignInHere({
      url: 'https://www.heb.com/robots.txt?_t=1788535270654.1', ...HEB,
    })).toBe(false);
  });

  it('yes on a real store page, which is the case worth protecting', () => {
    // The reason the skip exists: a store whose check opened a sign-in menu
    // must not have it navigated out from under the user.
    expect(canSignInHere({ url: 'https://www.heb.com/my-account/login', ...HEB })).toBe(true);
    expect(canSignInHere({ url: 'https://www.heb.com/', ...HEB })).toBe(true);
  });

  it('not on about:blank', () => {
    expect(canSignInHere({ url: 'about:blank', ...HEB })).toBe(false);
  });

  it('not on another site entirely', () => {
    expect(canSignInHere({ url: 'https://accounts.google.com/', ...HEB })).toBe(false);
  });

  it('not before anything has loaded', () => {
    expect(canSignInHere({ url: '', ...HEB })).toBe(false);
  });

  it('works for a store with no rail, where any store page will do', () => {
    // Amazon Fresh has no quiet page, so the old rule was right there and stays
    // right: nothing is excluded but the pages that are not this store's.
    const amazon = { domain: 'amazon.com', railUrl: null };
    expect(canSignInHere({ url: 'https://www.amazon.com/ap/signin', ...amazon })).toBe(true);
    expect(canSignInHere({ url: 'https://www.heb.com/', ...amazon })).toBe(false);
  });
});
