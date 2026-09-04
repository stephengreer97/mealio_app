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
  };
}
