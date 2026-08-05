// The auth/SSO interstitial predicate (MEAL-42).
//
// Three places must agree on it — WebViewCartSheet.onLoadEnd,
// SilentLoginProbe.onLoadEnd, and the injected check scripts — so it lives in
// one module and is pinned here. Getting it wrong in either direction is
// expensive: too narrow and the login check runs on an interstitial with no
// header and posts a false "logged out"; too broad and it skips a real store
// page, so the check never runs and the flow waits out its timeout.

import { isAuthRedirectUrl, AUTH_REDIRECT_URL_PATTERN } from '../../src/lib/webview-scripts/auth-urls';

describe('isAuthRedirectUrl', () => {
  it('matches the Albertsons SSO bounce that MEAL-42 is about', () => {
    expect(
      isAuthRedirectUrl('https://www.albertsons.com/bin/safeway/unified/sso/authorize?code=abc123'),
    ).toBe(true);
    // Same bounce on the other family banners.
    expect(
      isAuthRedirectUrl('https://www.safeway.com/bin/safeway/unified/sso/authorize?code=x'),
    ).toBe(true);
    expect(isAuthRedirectUrl('https://www.jewelosco.com/bin/safeway/unified/sso/authorize')).toBe(
      true,
    );
  });

  it('matches the other stores’ auth interstitials', () => {
    expect(isAuthRedirectUrl('https://accounts.heb.com/oauth/authorize?client_id=1')).toBe(true);
    expect(isAuthRedirectUrl('https://login.wegmans.com/oidc/auth')).toBe(true);
    expect(isAuthRedirectUrl('https://example.com/callback?code=1')).toBe(true);
    expect(isAuthRedirectUrl('https://example.com/authcallback/done')).toBe(true);
  });

  it('does NOT match real store pages the check must run on', () => {
    expect(isAuthRedirectUrl('https://www.albertsons.com')).toBe(false);
    expect(isAuthRedirectUrl('https://www.albertsons.com/')).toBe(false);
    expect(isAuthRedirectUrl('https://www.albertsons.com/shop/search-results.html?q=milk')).toBe(
      false,
    );
    expect(isAuthRedirectUrl('https://www.albertsons.com/erums/cart')).toBe(false);
    expect(isAuthRedirectUrl('https://www.albertsons.com/shop/cart.html')).toBe(false);
  });

  it('treats a bare "authorize" or "sso" substring as a normal page', () => {
    // The pattern is delimiter-anchored on purpose: a product or category whose
    // slug merely contains these words is a real page, not an interstitial.
    expect(isAuthRedirectUrl('https://www.albertsons.com/shop/search-results.html?q=espresso')).toBe(
      false,
    );
    expect(isAuthRedirectUrl('https://www.albertsons.com/authorized-dealers')).toBe(false);
  });

  it('handles empty/missing input without throwing', () => {
    expect(isAuthRedirectUrl('')).toBe(false);
    expect(isAuthRedirectUrl(undefined as unknown as string)).toBe(false);
  });

  it('exports a pattern source that rebuilds the same matcher in a page context', () => {
    // The injected scripts do `new RegExp(<pattern>)` because they have no
    // module scope. Same string in, same decisions out.
    const rebuilt = new RegExp(AUTH_REDIRECT_URL_PATTERN);
    for (const url of [
      'https://www.albertsons.com/bin/safeway/unified/sso/authorize?code=abc',
      'https://www.albertsons.com/',
      'https://accounts.heb.com/oauth/authorize',
    ]) {
      expect(rebuilt.test(url)).toBe(isAuthRedirectUrl(url));
    }
  });
});
