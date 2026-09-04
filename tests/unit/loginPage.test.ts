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

  it('yes on the store\'s own sign-in page', () => {
    // Where the skip earns its place: the store has redirected us to its form,
    // and navigating again would throw away the chain that got us there.
    expect(canSignInHere({ url: 'https://www.heb.com/my-account/login', ...HEB })).toBe(true);
    expect(canSignInHere({ url: 'https://accounts.heb.com/interaction/abc/login', ...HEB, domain: 'heb.com' })).toBe(true);
  });

  it('NO on the storefront homepage, which is not a sign-in page', () => {
    // TIGHTENED 2026-09-04. The rule was "is this the store's domain", written
    // when a DOM login check could open a sign-in menu on the storefront and
    // navigating away would have lost it. Every one of those checks is deleted,
    // and the wide rule had a cost: the session repair sends the user to the
    // STOREFRONT, which passed — so they were left on the homepage under the
    // word "Log in", with the sign-in link somewhere on the page to find.
    expect(canSignInHere({ url: 'https://www.heb.com/', ...HEB })).toBe(false);
    expect(canSignInHere({ url: 'https://www.heb.com?_t=17885.3', ...HEB })).toBe(false);
  });

  it('asks the STORE where it has an opinion', () => {
    // H-E-B's sign-in lives on accounts.heb.com, and its adapter says so. A
    // store that knows better than a regex is asked.
    const said: string[] = [];
    expect(canSignInHere({
      url: 'https://www.heb.com/whatever', ...HEB,
      isLoginPageUrl: (u) => { said.push(u); return true; },
    })).toBe(true);
    expect(said).toEqual(['https://www.heb.com/whatever']);
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

  it('works for a store with no quiet page', () => {
    // No store ships without a rail today — Amazon Fresh was the last and left
    // the catalogue on 2026-09-04 — but the mock store has no railUrl, and a
    // store added before its rail would not either. Nothing is excluded then
    // but the pages that are not this store's.
    const noRail = { domain: 'mealiomockstore.vercel.app', railUrl: null };
    expect(canSignInHere({ url: 'https://mealiomockstore.vercel.app/login', ...noRail })).toBe(true);
    expect(canSignInHere({ url: 'https://www.heb.com/', ...noRail })).toBe(false);
  });
});
