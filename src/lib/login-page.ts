// CAN THE USER SIGN IN ON WHAT THE WEBVIEW IS SHOWING?
//
// The login step used to answer this with "is the URL on the store's domain",
// and skip its navigation when it was — so that a check script which had
// already opened a sign-in UI (a hamburger menu, a modal) did not have that
// state navigated out from under it.
//
// That became wrong the moment rail stores started parking on a QUIET PAGE.
// robots.txt is on the store's domain, so the test passed; it is also a text
// file with no sign-in form, no menu and no markup at all.
//
// FOUND ON THE PIXEL, 2026-09-04, on H-E-B:
//
//   10:21:11  onLoadEnd https://www.heb.com/robots.txt?_t=...
//   10:21:38  prewarm said logged out - checking for ourselves
//   10:21:39  onLoadEnd https://www.heb.com/robots.txt?_t=...
//   10:21:5x  [login-poll] ask #16..#21 -> signed out
//
// The sheet said "Log in to H-E-B", told the user "Log into your H-E-B account
// once and Mealio won't ask again", and showed them a BLANK WHITE PAGE. There
// was nothing to type into and no way forward. Every rail store parks on
// robots.txt, so this was every rail store.
export interface SignInPageInput {
  /** The last page the WebView actually finished loading. */
  url: string;
  /** The store's cookie/navigation domain. */
  domain: string;
  /** The rail's quiet page, if this store has one. */
  railUrl?: string | null;
  /** The store's own answer to "is this my sign-in page", where it has one. */
  isLoginPageUrl?: ((url: string) => boolean) | null;
}

/**
 * The shapes a sign-in URL takes when a store has not said.
 *
 * Deliberately narrow. This decides whether to LEAVE the user where they are,
 * and being wrong that way is the blank-page bug.
 */
const LOOKS_LIKE_SIGN_IN = /\/login|\/sign-?in|\/authorize|\/ap\/signin|accounts\./i;

/**
 * True when the WebView is already showing a page the user could sign in from,
 * so the login step should leave it alone rather than navigate.
 *
 * False for anything off the store's domain (about:blank included), and false
 * for the rail's quiet page — same origin, and deliberately empty.
 */
export function canSignInHere({ url, domain, railUrl, isLoginPageUrl }: SignInPageInput): boolean {
  if (!url || !domain || !url.includes(domain)) return false;
  // startsWith, not equality: every navigation carries a ?_t= cache-buster.
  if (railUrl && url.startsWith(railUrl)) return false;
  // A SIGN-IN PAGE, not merely a page of this store's.
  //
  // This started as "are we on the store's domain", which was written when a
  // DOM login check could open a sign-in menu on the storefront and navigating
  // away would have thrown that away. Those checks are all deleted (2026-09-04)
  // — the only one left is Amazon Fresh's, which opens nothing — so the case the
  // wide rule protected no longer exists, and what it costs is real: the
  // storefront HOMEPAGE passed it, so a user sent there by the session repair
  // was then left on it under the words "Log in", with the sign-in link
  // somewhere on the page for them to find.
  return isLoginPageUrl ? isLoginPageUrl(url) : LOOKS_LIKE_SIGN_IN.test(url);
}

/**
 * Is a SIGNED-OUT answer from this page one to act on?
 *
 * A rail parks on a quiet page — robots.txt — so its requests are not queued
 * behind the storefront's own bundles. The cost is that some stores cannot
 * answer "who is signed in" from there at all until their own code has run
 * once, and they answer SIGNED OUT rather than "I do not know".
 *
 * MEASURED, Albertsons, Pixel, 2026-09-04, on a session that was perfectly
 * good:
 *
 *   12:53:08.8  session says signed out, from robots.txt -> sign-in screen
 *   12:53:09.7  the storefront loads
 *   12:53:10.0  ask #1 -> signed out
 *   12:53:12.0  ask #3 -> signed out
 *   12:53:14.2  ask #5 -> SIGNED IN
 *   12:53:15.0  verified
 *
 * Stephen: "I am already signed in, but it took me to the sign into albertsons
 * page for few seconds before realizing I am logged in. That should not
 * happen." It is the site re-establishing his session the moment its own
 * JavaScript ran — which is the repair the engine already knows how to do, and
 * it should do it BEFORE showing anyone a sign-in wall rather than underneath
 * one.
 *
 * So a signed-out answer from the quiet page is not final. Give the site one
 * storefront load, ask again, and believe the second answer. A genuinely
 * signed-out user reaches the same screen about a second later; a signed-in one
 * never sees it.
 */
export function signedOutIsFinal({ url, railUrl }: SignInPageInput): boolean {
  if (!railUrl || !url) return true;
  // startsWith, because every navigation carries a ?_t= cache-buster.
  return !url.startsWith(railUrl);
}
