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
}

/**
 * True when the WebView is already showing a page the user could sign in from,
 * so the login step should leave it alone rather than navigate.
 *
 * False for anything off the store's domain (about:blank included), and false
 * for the rail's quiet page — same origin, and deliberately empty.
 */
export function canSignInHere({ url, domain, railUrl }: SignInPageInput): boolean {
  if (!url || !domain || !url.includes(domain)) return false;
  // startsWith, not equality: every navigation carries a ?_t= cache-buster.
  if (railUrl && url.startsWith(railUrl)) return false;
  return true;
}
