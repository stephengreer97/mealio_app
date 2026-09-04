// Where Wegmans lives, and nothing else.
//
// Everything Mealio does at this store it does over the network, in
// wegmans-network.ts: Algolia for search, the commerce API for the cart, and
// MSAL's own encrypted cache for the bearer. This file is the addresses.
//
// The DOM half is gone (2026-09-04) — the tile/name/add-button selector table
// and the 150-line sign-in-greeting observer that read it. Neither had a
// caller: the rail answers the session, and a rail store that falls back to
// reading a storefront is a rail store whose answer nobody can check.

import type { StoreScripts } from './index';
import { storeConfig, searchUrlFor } from '../automation-config';

const WEGMANS_URL = 'https://www.wegmans.com';
const WEGMANS_LOGIN_URL = 'https://www.wegmans.com';
const WEGMANS_CART_URL = 'https://www.wegmans.com/cart';
// THE QUIET PAGE. The rail asks Algolia and the commerce API and reads no DOM,
// so the storefront is pure cost -- its bundles share the renderer with our
// requests. Same origin as the store, because the MSAL cache and the session
// cookies are per origin and a rail on another host would have neither.
const WEGMANS_RAIL_URL = 'https://www.wegmans.com/robots.txt';
const WEGMANS_DOMAIN = 'wegmans.com';

const SELECTOR_KEY = 'wegmans';

/**
 * Where the storefront shows a search, for the user to finish by hand.
 *
 * A URL, not a scraper: nothing reads this page: we navigate to it and the
 * person takes over. That is why it outlived the selectors.
 */
export function getWegmansSearchUrl(query: string): string {
  return 'https://www.wegmans.com/shop/search?query=' + encodeURIComponent(query);
}

export function getScripts(): StoreScripts {
  const cfg = storeConfig(SELECTOR_KEY);
  return {
    storeUrl: cfg.storeUrl ?? WEGMANS_URL,
    loginUrl: cfg.loginUrl ?? WEGMANS_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? WEGMANS_CART_URL,
    domain: WEGMANS_DOMAIN,
    railUrl: WEGMANS_RAIL_URL,
    isSearchUrl: (url: string) => url.includes('wegmans.com/search') || url.includes('wegmans.com/shop'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('wegmans.com') && !url.includes('/sign-in') && !url.includes('/login'),
    getSearchUrl: (term: string) => searchUrlFor(SELECTOR_KEY, term, getWegmansSearchUrl(term)),
    cacheBustNav: cfg.cacheBustNav ?? false,
  };
}
