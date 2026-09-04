// Where Walmart lives, and nothing else.
//
// Search, cart and sign-in all happen over the network in walmart-network.ts:
// the site's own persisted-query endpoints, with the headers it sends. This
// file is the addresses.
//
// The DOM half is gone (2026-09-04) — the product-tile selector table and the
// 160-line script that opened the hamburger menu to read a "Hi, <name>"
// greeting out of the slide-out drawer. Clicking a storefront to find out who
// is signed in is exactly the thing the rail replaced.

import type { StoreScripts } from './index';
import { storeConfig, searchUrlFor } from '../automation-config';

const WALMART_URL = 'https://www.walmart.com/grocery';
const WALMART_LOGIN_URL = 'https://www.walmart.com/account/login';
const WALMART_CART_URL = 'https://www.walmart.com/cart';
const WALMART_DOMAIN = 'walmart.com';

const SELECTOR_KEY = 'walmart';

export function getScripts(): StoreScripts {
  const cfg = storeConfig(SELECTOR_KEY);
  const fallbackSearchUrl = (term: string) =>
    'https://www.walmart.com/search?q=' + encodeURIComponent(term);

  return {
    storeUrl: cfg.storeUrl ?? WALMART_URL,
    // The rail's quiet page: no JavaScript of its own, so our requests get the
    // renderer to themselves, and same-origin so localStorage and the cookies
    // are all there. Same choice as the other four rails.
    railUrl: 'https://www.walmart.com/robots.txt',
    loginUrl: cfg.loginUrl ?? WALMART_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? WALMART_CART_URL,
    domain: WALMART_DOMAIN,
    isSearchUrl: (url: string) => url.includes('walmart.com/search'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('walmart.com') && !url.includes('/account/login') && !url.includes('/sign-in'),
    // A URL for the person to finish by hand, not a page anything reads.
    getSearchUrl: (term: string) => searchUrlFor(SELECTOR_KEY, term, fallbackSearchUrl(term)),
    cacheBustNav: cfg.cacheBustNav,
  };
}
