// Single source of truth for "this URL is an intermediate auth/SSO redirect".
//
// Three consumers have to agree on this, or the login check double-runs — or
// worse, runs ON the interstitial and posts a bogus verdict:
//
//   • WebViewCartSheet.onLoadEnd — skips injecting on these pages.
//   • SilentLoginProbe.onLoadEnd — same, for the hidden prewarm probe.
//   • The injected check scripts themselves — a page script can't import this
//     module (it runs in the page with no module scope), so the pattern SOURCE
//     is exported separately for interpolation into the script string.
//
// Albertsons is the motivating case (MEAL-42): the storefront silently bounces
// through …/bin/safeway/unified/sso/authorize?code=… and back. That interstitial
// carries no site header, so a check injected there finds no account control,
// polls the full 3s, and then posts LOGIN_STATUS:{isLoggedIn:false} — which
// SilentLoginProbe latches permanently via reportLogin/finish. Measured at
// 3008ms to a wrong answer against a header-less page; pinned by
// tests/fixture-tests/albertsons.spec.ts and tests/unit/authRedirectUrl.test.ts.

/** Regex SOURCE, for building the same test inside an injected page script. */
export const AUTH_REDIRECT_URL_PATTERN =
  '\\/sso\\/|\\/authorize[?/]|\\/oidc\\/|\\/oauth[?/]|\\/callback[?/]|\\/authcallback\\/|\\/secur\\/|\\/frontdoor|\\/RemoteAccessAuth|\\/CIAM_';

const AUTH_REDIRECT_URL_RE = new RegExp(AUTH_REDIRECT_URL_PATTERN);

/**
 * True when `url` is an intermediate auth/SSO/OIDC redirect rather than a real
 * store page. Scripts injected into these pages get killed the moment the
 * redirect resolves, so callers should skip injection and wait for the landing
 * page instead.
 */
export function isAuthRedirectUrl(url: string): boolean {
  return AUTH_REDIRECT_URL_RE.test(url || '');
}
