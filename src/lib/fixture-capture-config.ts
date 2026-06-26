// Per-store fixture-capture configuration.
//
// Shared between:
//   - tests/fixture-runners/capture-fixtures.ts   (Node Playwright capture)
//   - mobile app's admin FixtureCaptureSheet      (real iOS WebView capture)
//
// Keep this module dependency-free (no React Native imports, no Playwright
// imports) so both runtimes can pull it in cleanly.

export interface FixtureDef {
  /** Output filename, e.g. "search-results.html" */
  file: string;
  /** URL to navigate to */
  url: string;
  /** CSS selector to wait for before capturing (best-effort) */
  waitFor?: string;
  /** Instruction shown to the user before this fixture's capture */
  instruction?: string;
  /**
   * Optional fixtures don't fail the test suite if missing. Used for
   * store-specific UI states (e.g. preference modals only exist on HEB).
   */
  optional?: boolean;
  /**
   * Suggested capture delay in seconds — for fleeting states like an open
   * stepper that auto-collapses. The capture sheet pre-selects this.
   */
  suggestedDelayMs?: number;
}

export interface StoreCaptureConfig {
  loginUrl: string;
  fixtures: FixtureDef[];
}

export const FIXTURE_CAPTURE_STORES: Record<string, StoreCaptureConfig> = {
  wegmans: {
    loginUrl: 'https://www.wegmans.com',
    fixtures: [
      {
        file: 'logged-in-home.html',
        url: 'https://www.wegmans.com',
        waitFor: 'button[aria-label="Account"]',
        instruction:
          'The Account button at the top of the page should read "Hello, <name>". CHECK_LOGIN_SCRIPT reads that button text literally — anything starting with "Hello," counts as logged in, "Sign In" as logged out.',
      },
      {
        file: 'search-results-tortillas.html',
        url: 'https://www.wegmans.com/shop/search?query=la%20banderita%20burrito%20grande%20flour%20tortillas%2C%20extra%20large',
        waitFor: 'div.component--product-tile',
        instruction: 'Should show at least one La Banderita tortilla tile.',
      },
      {
        file: 'search-results-sour-cream.html',
        url: 'https://www.wegmans.com/shop/search?query=wegmans%20sour%20cream',
        waitFor: 'div.component--product-tile',
      },
      {
        file: 'cart-with-items.html',
        url: 'https://www.wegmans.com/cart',
        waitFor: 'body',
        instruction: 'Add at least one item to the cart manually before this fixture captures.',
      },
      {
        file: 'search-results-product-in-cart.html',
        url: 'https://www.wegmans.com/shop/search?query=wegmans%20sour%20cream',
        waitFor: 'div.component--product-tile',
        instruction:
          'On a search result, tap the + icon on ONE product tile to add it to your cart. The button should change from an SVG icon to show "1". Then tap Capture.',
      },
      {
        file: 'search-results-stepper-open.html',
        url: 'https://www.wegmans.com/shop/search?query=wegmans%20sour%20cream',
        waitFor: 'div.component--product-tile',
        suggestedDelayMs: 2000,
        instruction:
          'On a search result, tap the qty bubble on a product that\'s already in your cart. The stepper [- N +] appears. Use the "Capture in 2s" button — click the bubble in the WebView, then immediately tap the timed capture before the stepper auto-collapses.',
      },
      {
        file: 'search-results-out-of-stock.html',
        url: 'https://www.wegmans.com/shop/search?query=seasonal',
        waitFor: 'div.component--product-tile',
        optional: true,
        instruction:
          'Find any product marked Out of Stock or Unavailable. Search for seasonal/limited items if needed. Then tap Capture.',
      },
    ],
  },

  heb: {
    loginUrl: 'https://www.heb.com',
    fixtures: [
      {
        file: 'logged-in-home.html',
        url: 'https://www.heb.com',
        waitFor: 'button[aria-label*="account" i], button[aria-label*="profile" i]',
        instruction:
          'Landing page in the logged-in state. A profile/account icon button must exist at the top (on mobile this is just an icon, no initials). Do NOT open the panel before capturing — leave the home page as is, then Capture. Pairs with logged-in-account-panel-open.html which captures the post-click state.',
      },
      {
        file: 'logged-in-account-panel-open.html',
        url: 'https://www.heb.com',
        waitFor: 'body',
        instruction:
          'Tap the profile/account icon at the top of the page to open the account side panel. With the panel visible (showing "Sign Out", "My Account", etc.) tap Capture. Future markup changes to the panel will be caught by tests that scan this captured DOM for the expected logged-in indicators.',
      },
      {
        file: 'search-results-tortillas.html',
        url: 'https://www.heb.com/search?q=mission%20flour%20tortillas',
        waitFor: '[data-qe-id="searchResult"], [data-testid*="productCard" i]',
      },
      {
        file: 'search-results-sour-cream.html',
        url: 'https://www.heb.com/search?q=sour%20cream',
        waitFor: '[data-qe-id="searchResult"], [data-testid*="productCard" i]',
      },
      {
        file: 'cart-with-items.html',
        url: 'https://www.heb.com/cart',
        waitFor: 'body',
        instruction: 'Add at least one item to your H-E-B cart manually first.',
      },
      {
        file: 'cart-with-weight-item.html',
        url: 'https://www.heb.com/cart',
        optional: true,
        instruction:
          'Add a SOLD-BY-THE-POUND item to your H-E-B cart (e.g. a "… Bulk Coffee, lb" — pick a weight from its dropdown), then open /cart and Capture. We need to see how the cart line renders a weight item (its name + how the weight/quantity is shown) so the snapshot + reconcile can confirm weight items by weight rather than a discrete count.',
      },
      {
        file: 'search-results-product-in-cart.html',
        url: 'https://www.heb.com/search?q=sour%20cream',
        instruction:
          'Tap the + on one tile to add it to your cart. The tile should now show qty 1 with stepper buttons. Tap Capture.',
      },
      {
        file: 'search-results-stepper-open.html',
        url: 'https://www.heb.com/search?q=sour%20cream',
        suggestedDelayMs: 2000,
        instruction:
          'On a result already in cart, tap to expand the stepper. Use "Capture in 2s" before it auto-collapses.',
      },
      {
        file: 'search-results-with-preferences.html',
        url: 'https://www.heb.com/search?q=avocado',
        instruction:
          'Find an item that requires you to pick a variant (e.g. avocados with size choices). Tap + on its tile — HEB pops a preference modal. Tap Capture WHILE the modal is open.',
      },
      {
        file: 'search-results-deli-weight-modal-open.html',
        url: 'https://www.heb.com/search?q=deli%20turkey',
        optional: true,
        suggestedDelayMs: 2000,
        instruction:
          'Find an H-E-B DELI "Custom Sliced, lb" item (e.g. "H-E-B Deli Oven Roasted Turkey Breast, Custom Sliced, lb"). Tap + / Add — it opens a modal that has BOTH the slicing preference (No preference / Shaved / Thin / …) AND a weight selector. Use "Capture in 2s": tap Add in the WebView, then immediately tap the timed capture WHILE that modal is open. We need the modal\'s weight-control structure (deli weight lives in the modal, not on the search card) to read its options and remember the chosen weight alongside the slicing.',
      },
      {
        file: 'search-results-weight-dropdown-closed.html',
        url: 'https://www.heb.com/search?q=bulk%20coffee',
        optional: true,
        instruction:
          'Find a SOLD-BY-THE-POUND weight item — e.g. "CAFE Olé by H-E-B Bavarian Hazelnut Medium Roast Whole Bean Bulk Coffee, lb" — whose tile shows a WEIGHT DROPDOWN (a weight selector like "0.25 lb") instead of a normal "Add to cart" button. Do NOT open the dropdown. Capture the search results as-is. This pins the tile + dropdown-control structure so we can read the weight increments. (Pairs with search-results-weight-dropdown-open.html.)',
      },
      {
        file: 'search-results-weight-dropdown-open.html',
        url: 'https://www.heb.com/search?q=bulk%20coffee',
        optional: true,
        suggestedDelayMs: 2000,
        instruction:
          'Same "… Bulk Coffee, lb" weight item — now TAP its weight dropdown so the full list of weight options is visible (e.g. 0.25 lb, 0.5 lb, 0.75 lb, …). Use "Capture in 2s": tap the dropdown in the WebView, then immediately tap the timed capture before it closes. We need the rendered option weight values to detect the increment.',
      },
      {
        file: 'search-results-out-of-stock.html',
        url: 'https://www.heb.com/search?q=seasonal',
        optional: true,
        instruction: 'Find any Out of Stock / Unavailable tile. Tap Capture.',
      },
    ],
  },

  walmart: {
    loginUrl: 'https://www.walmart.com/account/login',
    fixtures: [
      {
        file: 'logged-in-home.html',
        url: 'https://www.walmart.com/grocery',
        waitFor: 'button[aria-label*="department" i], button[aria-label*="menu" i], header button[aria-haspopup]',
        instruction:
          'Landing page in the logged-in state, hamburger CLOSED. Confirms the hamburger button selector still matches Walmart\'s current markup. Pairs with logged-in-menu-drawer-open.html which captures the open-drawer state where the script reads "Hi, <name>".',
      },
      {
        file: 'logged-in-menu-drawer-open.html',
        url: 'https://www.walmart.com/grocery',
        waitFor: 'body',
        instruction:
          'Tap the hamburger menu (top-left). With the side drawer open showing "Hi, <name>" at the top (not "Sign in or create account"), tap Capture. CHECK_LOGIN_SCRIPT scans this drawer text to decide logged-in vs logged-out; this fixture pins the layout so we catch future markup changes.',
      },
      {
        file: 'search-results-tortillas.html',
        url: 'https://www.walmart.com/search?q=mission+flour+tortillas',
        waitFor: '[data-automation-id="product"], [data-testid="item-stack"] > div',
      },
      {
        file: 'search-results-sour-cream.html',
        url: 'https://www.walmart.com/search?q=sour+cream',
        waitFor: '[data-automation-id="product"]',
      },
      {
        file: 'cart-with-items.html',
        url: 'https://www.walmart.com/cart',
        waitFor: 'body',
        instruction: 'Add at least one item to your Walmart cart manually first.',
      },
      {
        file: 'search-results-product-in-cart.html',
        url: 'https://www.walmart.com/search?q=sour+cream',
        instruction:
          'Tap the + button on one Walmart tile to add it to cart. The button transitions to show qty. Tap Capture.',
      },
      {
        file: 'search-results-stepper-open.html',
        url: 'https://www.walmart.com/search?q=sour+cream',
        suggestedDelayMs: 2000,
        instruction:
          'Tap the qty stepper on a product already in cart. Use "Capture in 2s" before it collapses.',
      },
      {
        file: 'search-results-with-options.html',
        url: 'https://www.walmart.com/search?q=cheese',
        optional: true,
        instruction:
          'Find a product whose tile shows an "Options" button instead of a "+" (Walmart uses this for items with size/variant choices). No tap needed — Capture the search results page as-is. The script flags these as hasOptions:true and routes them to the product detail page rather than adding inline.',
      },
      {
        file: 'search-results-out-of-stock.html',
        url: 'https://www.walmart.com/search?q=seasonal',
        optional: true,
        instruction: 'Find any Out of Stock tile. Tap Capture.',
      },
    ],
  },

  albertsons: {
    loginUrl: 'https://www.acmemarkets.com',
    fixtures: [
      {
        file: 'logged-in-home.html',
        url: 'https://www.acmemarkets.com',
        waitFor: 'button[aria-label*="account" i], button[aria-label*="profile" i]',
        instruction:
          'Landing page in the logged-in state, panel CLOSED. Confirms the account/profile button selector still matches. Pairs with logged-in-account-panel-open.html for the post-click "sign out" text scan.',
      },
      {
        file: 'logged-in-account-panel-open.html',
        url: 'https://www.acmemarkets.com',
        waitFor: 'body',
        instruction:
          'Tap the account/profile icon at the top to open the account panel. With it showing "Sign Out" / "Log Out" / "My Account", tap Capture. CHECK_LOGIN_SCRIPT body-text-scans this panel state to confirm logged-in.',
      },
      {
        file: 'search-results-tortillas.html',
        url: 'https://www.acmemarkets.com/shop/search-results.html?q=tortillas',
        waitFor: '[data-qa="prod-tile"], [data-marker*="product" i]',
      },
      {
        file: 'cart-with-items.html',
        url: 'https://www.acmemarkets.com/shop/cart.html',
        waitFor: 'body',
        instruction: 'Add at least one item to the cart manually first.',
      },
      {
        file: 'search-results-product-in-cart.html',
        url: 'https://www.acmemarkets.com/shop/search-results.html?q=sour%20cream',
        instruction:
          'Tap + on one tile to add it to cart. The tile now shows qty + a stepper. Tap Capture.',
      },
      {
        file: 'search-results-stepper-open.html',
        url: 'https://www.acmemarkets.com/shop/search-results.html?q=sour%20cream',
        suggestedDelayMs: 2000,
        instruction:
          'Tap the qty stepper button on a product already in cart. Use "Capture in 2s".',
      },
      {
        file: 'search-results-out-of-stock.html',
        url: 'https://www.acmemarkets.com/shop/search-results.html?q=seasonal',
        optional: true,
        instruction: 'Find any Out of Stock / Unavailable tile. Tap Capture.',
      },
    ],
  },

  aldi: {
    // ALDI's web storefront is Instacart-backed; everything lives under
    // /store/aldi/. The bare aldi.us domain is a marketing site and doesn't
    // host the actual cart-and-search UX our scripts target.
    loginUrl: 'https://www.aldi.us/store/aldi/storefront',
    fixtures: [
      {
        file: 'logged-in-home.html',
        url: 'https://www.aldi.us/store/aldi/storefront',
        waitFor: '[role="dialog"][aria-label="Main Menu"]',
        instruction:
          'Open the Main Menu (hamburger, top-left) BEFORE tapping Capture. CHECK_LOGIN_SCRIPT does not click the hamburger — it polls for the open Main Menu dialog directly. With the dialog open, the drawer should show "Sign Out" / "My Account" items (logged in) rather than "Sign In" / "Register" (logged out). Keep the menu open while capturing.',
      },
      {
        file: 'search-results-tortillas.html',
        url: 'https://www.aldi.us/store/aldi/s?k=tortillas',
        waitFor: '[data-testid*="product" i], [class*="ProductCard" i]',
      },
      {
        file: 'cart-with-items.html',
        url: 'https://www.aldi.us/store/aldi/storefront',
        waitFor: 'body',
        instruction:
          'Add at least one item to your ALDI cart first, then navigate to the cart view within the WebView before tapping Capture. ALDI does not expose a stable /cart URL — the cart is reached through the storefront UI.',
      },
      {
        file: 'search-results-product-in-cart.html',
        url: 'https://www.aldi.us/store/aldi/s?k=sour%20cream',
        instruction:
          'Tap + on a tile to add it to cart. The tile transitions to show qty + stepper buttons. Tap Capture.',
      },
      {
        file: 'search-results-stepper-open.html',
        url: 'https://www.aldi.us/store/aldi/s?k=sour%20cream',
        suggestedDelayMs: 2000,
        instruction:
          'Tap the qty stepper on a product already in cart. Use "Capture in 2s".',
      },
      {
        file: 'search-results-out-of-stock.html',
        url: 'https://www.aldi.us/store/aldi/s?k=seasonal',
        optional: true,
        instruction: 'Find any Out of Stock tile. Tap Capture.',
      },
    ],
  },

  'amazon-fresh': {
    // The bare /ap/signin URL needs OpenID return_to params and shows an
    // error when hit directly. Land on the Fresh storefront instead — Amazon
    // surfaces "Hello, sign in" there and handles the auth round-trip on tap.
    loginUrl: 'https://www.amazon.com/fresh',
    fixtures: [
      {
        file: 'logged-in-home.html',
        url: 'https://www.amazon.com/fresh',
        waitFor: '#nav-greeting-name, #nav-logobar-greeting.nav-greeting-recognized',
        instruction:
          'The top nav must show a "Hello, <name>" greeting. CHECK_LOGIN_SCRIPT checks for #nav-logobar-greeting carrying the class "nav-greeting-recognized" AND a child <a id="nav-greeting-name"> — both must be in the captured DOM. If you only see "Hello, sign in" the page is logged out.',
      },
      {
        file: 'search-results-tortillas.html',
        url: 'https://www.amazon.com/s?k=mission+flour+tortillas&i=amazonfresh',
        waitFor: '[data-component-type="s-search-result"]',
      },
      {
        file: 'cart-with-items.html',
        url: 'https://www.amazon.com/cart',
        waitFor: 'body',
        instruction:
          'Add at least one Amazon Fresh item to the cart first. This is the cart LANDING page (the "cart of carts" with a collapsed Fresh preview + a "view full cart" link). Capture it as-is.',
      },
      {
        file: 'cart-fresh-full.html',
        url: 'https://www.amazon.com/cart',
        waitFor: 'body',
        instruction:
          'Add 2+ DIFFERENT Amazon Fresh items to your cart. Tap the cart icon, then on the Amazon Fresh section tap "View full cart" (the cart_expand_link_fresh link) so EVERY item is listed individually with its name and quantity. Capture THAT expanded Fresh cart page (not the collapsed cart-of-carts summary). This is what the cart snapshot reads.',
      },
      {
        file: 'search-results-product-in-cart.html',
        url: 'https://www.amazon.com/s?k=sour+cream&i=amazonfresh',
        instruction:
          'Tap "Add to cart" on one product. The button changes to a stepper. Tap Capture.',
      },
      {
        file: 'search-results-stepper-open.html',
        url: 'https://www.amazon.com/s?k=sour+cream&i=amazonfresh',
        suggestedDelayMs: 2000,
        instruction:
          'Tap the qty stepper on a product already in cart. Use "Capture in 2s".',
      },
      {
        file: 'search-results-out-of-stock.html',
        url: 'https://www.amazon.com/s?k=seasonal&i=amazonfresh',
        optional: true,
        instruction: 'Find any Out of Stock / Currently Unavailable tile. Tap Capture.',
      },
    ],
  },
};

export type StoreId = keyof typeof FIXTURE_CAPTURE_STORES;
