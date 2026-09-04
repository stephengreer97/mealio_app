import { storeConfig, searchUrlFor } from '../automation-config';
// Amazon Fresh: the addresses, and one login check.
//
// This store has no network rail, so it is ASSISTED — Mealio searches, the user
// adds. See the note on buildCheckLoginScript below.
//


const AMAZON_URL = 'https://www.amazon.com/fresh';
const AMAZON_LOGIN_URL = 'https://www.amazon.com/ap/signin';
const AMAZON_CART_URL = 'https://www.amazon.com/cart';
const AMAZON_DOMAIN = 'amazon.com';

const SELECTOR_KEY = 'amazon';

// THE LAST DOM READ IN THE BUILD, and it is not a fallback from anything.
//
// Amazon Fresh is the one store with no network rail: Mealio searches for the
// user here and the user does the adding. This twenty-line check is the only
// way this build can tell whether they are signed in, so it is primary, not a
// second opinion — the thing the 2026-09-04 removal was aimed at. Everything
// else that read a storefront is gone, including this store's own selector
// table, whose extractors and add-to-cart clickers went with the DOM
// automation on 2026-09-01.
//
// It goes when Amazon Fresh gets a rail, and not before: replacing a check that
// works with an unverified one on the only store nobody can regression-test
// from a fixture would be trading a known thing for a guess.
function buildCheckLoginScript(): string {
  return `(async function() {
  if (window.__amazonLoginCheckActive) return;
  window.__amazonLoginCheckActive = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    await wait(1500);

    // True positive login detection using DOM structure.
    // When logged in, the greeting element has class "nav-greeting-recognized"
    // and contains a child <a id="nav-greeting-name"> with the user's name.
    var greetingEl = document.getElementById('nav-logobar-greeting');
    var isRecognized = greetingEl && greetingEl.classList.contains('nav-greeting-recognized');
    var nameLink = document.getElementById('nav-greeting-name');

    var isLoggedIn = !!(isRecognized && nameLink);

    window.__amazonLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn }));
  } catch(e) {
    window.__amazonLoginCheckActive = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;
}


const AMAZON_CART_PAGE_SCRIPT = `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function norm(s) { return (s || '').trim().replace(/\\s+/g, ' '); }
  function lineItemCards() {
    return Array.prototype.slice.call(
      document.querySelectorAll('div.sc-list-item[data-quantity]')
    );
  }
  // Poll for the expanded Fresh cart's line-item cards to render.
  var cards = [];
  for (var i = 0; i < 25; i++) {
    cards = lineItemCards();
    if (cards.length > 0) break;
    await wait(200);
  }
  // No line items: we're on the cart-of-carts page. Expand the Fresh cart once
  // (guard against navigation loops), then let onLoadEnd re-inject this script.
  if (cards.length === 0) {
    var expand = document.querySelector(
      'a[href*="cart_expand_link_fresh"], a[href*="/cart/localmarket"]'
    );
    if (expand && !window.__mealioFreshExpanded) {
      window.__mealioFreshExpanded = true;
      var href = expand.getAttribute('href') || '';
      try { expand.click(); } catch (e) {}
      // Fall back to a hard navigation if the click didn't move us.
      if (href) { window.location.href = href; }
      return;
    }
  }
  var count = 0;
  var items = [];
  var seen = {};
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var id = card.getAttribute('data-itemid') || ('idx' + c);
    if (seen[id]) continue;
    seen[id] = true;
    var del = card.querySelector('[aria-label^="Delete "]');
    var al = del ? (del.getAttribute('aria-label') || '') : '';
    var name = norm(al.replace(/^Delete\\s+/i, ''));
    if (!name) continue;
    var qty = parseInt(card.getAttribute('data-quantity'), 10);
    if (!qty || isNaN(qty)) qty = 1;
    count += qty;
    items.push({ name: name, qty: qty });
  }
  // Report the URL we actually counted on so the sheet can cache it and hit the
  // expanded Fresh cart directly for the after-snapshot (skipping the cart-icon
  // → cart-of-carts → expand-link hops).
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CART_COUNT', count: count, items: items, url: location.href }));
})(); true;`;

const AMAZON_OPEN_CART_SCRIPT = `(function() {
  var icon = document.querySelector('#nav-button-cart')
    || document.querySelector('a[href*="navm_hdr_cart"]');
  if (!icon) {
    var badge = document.querySelector('#nav-cart-count');
    if (badge && badge.closest) icon = badge.closest('a');
  }
  if (icon) {
    var href = icon.getAttribute('href') || '';
    try { icon.click(); } catch (e) {}
    if (href) { window.location.href = href; }
  }
})(); true;`;

export function getScripts() {
  const cfg = storeConfig(SELECTOR_KEY);
  return {
    storeUrl: cfg.storeUrl ?? AMAZON_URL,
    loginUrl: cfg.loginUrl ?? AMAZON_LOGIN_URL,
    cartUrl: cfg.cartUrl ?? AMAZON_CART_URL,
    // The Amazon Shopping app's URL-carrying scheme opens the cart inside the app.
    // handleOpenCart tries this first, then falls back to the https cartUrl in the
    // browser if the app isn't installed. (Bare amazon:// / amzn:// don't work.)
    appScheme: 'com.amazon.mobile.shopping.web://amazon.com/gp/cart/view.html',
    domain: AMAZON_DOMAIN,
    isSearchUrl: (url: string) => url.includes('/s?') && url.includes('amazon.com'),
    isLoginSuccessUrl: (url: string) =>
      url.includes('amazon.com') && !url.includes('/ap/') && !url.includes('/ax/') && !url.includes('openid.'),
    checkLoginScript: buildCheckLoginScript(),
    getSearchUrl: (term: string) =>
      searchUrlFor(SELECTOR_KEY, term,
        'https://www.amazon.com/s?k=' + encodeURIComponent(term) + '&i=amazonfresh'),
    cacheBustNav: cfg.cacheBustNav,
    // HOW THIS STORE READS ITS OWN CART, since it has no rail to ask.
    //
    // No URL: /cart 302s to a signed-in-only interstitial often enough that
    // navigating there is unreliable, so the header cart icon is clicked and the
    // count is read on whatever page that lands on. The two scripts moved here
    // from cart-count.ts on 2026-09-04 — a shared file is the wrong home for one
    // store's page reader, and this is now the only store with one.
    cartPage: {
      openScript: AMAZON_OPEN_CART_SCRIPT,
      countScript: AMAZON_CART_PAGE_SCRIPT,
    },
  };
}
