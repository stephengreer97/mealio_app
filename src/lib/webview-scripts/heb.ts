// Where H-E-B lives, and nothing else.
//
// Search, cart and sign-in all happen over the network in
// heb-network-search.ts. This file is the addresses.

import type { StoreScripts } from './index';
import { storeConfig, searchUrlFor } from '../automation-config';

export const HEB_URL = 'https://www.heb.com';
export const HEB_LOGIN_URL = 'https://www.heb.com/my-account/login';
export const HEB_CART_URL = 'https://www.heb.com/cart';

// The DOM builders lived below: the results-page extractor, the add-to-cart
// click script, the fused search-and-add, and the in-page search that drove
// H-E-B's own header search box. Roughly 1,400 lines of selectors and waits.
// Deleted 2026-09-01.
//
// The last of it went on 2026-09-04: the selector table, and the login check
// that clicked the profile icon and then polled the account panel's text for
// the words "log out" for eight seconds. The rail answers that question from
// the session endpoint, and a rail store that can silently fall back to
// clicking a storefront is a rail store whose answer nobody can check.

// A FUNCTION, not a module-level const: the remote automation config loads
// after this module is imported, so building the adapter per call means a
// config push takes effect on the next cart run rather than on the next app
// restart.
export function getScripts(): StoreScripts {
  const cfg = storeConfig('heb');
  return {
  storeUrl: cfg.storeUrl ?? HEB_URL,
  // The same quiet page Albertsons uses, and for the same measured reason.
  //
  // Stephen, 2026-09-02: "HEB was extremely fast yesterday. Now its not
  // working." Every term came back TypeError: Failed to fetch on a SAME-ORIGIN
  // POST to /graphql, immediately followed by two "re-reading the session"
  // lines -- the storefront homepage had navigated and taken the in-flight
  // requests with it. Fast on the runs where it happened to have settled,
  // broken on the ones where it had not.
  //
  // The rail needs the origin's cookies and nothing else: no DOM, no clicks,
  // nothing on screen. robots.txt is the same origin, carries the same session,
  // and has nothing that can redirect.
  railUrl: `${HEB_URL}/robots.txt`,
  loginUrl: cfg.loginUrl ?? HEB_LOGIN_URL,
  cartUrl: cfg.cartUrl ?? HEB_CART_URL,
  domain: 'heb.com',
  // Opens the My H-E-B app (com.heb.myheb). HEB exposes no cart-specific deep
  // link, so this lands on the app's home — still better than the website. The
  // 'heb://' scheme was wrong (copied the Kroger-family naming; HEB isn't Kroger).
  appScheme: 'myheb://',
  isSearchUrl: (url) => url.includes('/search'),
  // Do NOT match the OIDC callback — it must complete its redirect chain
  // to set session cookies. onLoadEnd re-injection handles post-login detection.
  isLoginSuccessUrl: () => false,
  // A signed-out session redirects to accounts.heb.com (an /authorize URL).
  // Recognise it so the sign-in form comes up immediately.
  isLoginPageUrl: (url) => /accounts\.heb\.com/i.test(url) || /\/my-account\/login/i.test(url),
  // After the user signs in, HEB lands back on www.heb.com. Re-run the session
  // probe there so the flow continues on its own. The auth-redirect skip means
  // this only fires once the OIDC chain settles on the store (cookies set), and
  // never on the accounts.heb.com login form, so it can't fight the user.
  reinjectLoginCheckOnNav: true,
  // A destination for the user, not a page anything of ours reads.
  getSearchUrl: (term) =>
    searchUrlFor('heb', term, 'https://www.heb.com/search?q=' + encodeURIComponent(term)),
  cacheBustNav: cfg.cacheBustNav,
  };
}
