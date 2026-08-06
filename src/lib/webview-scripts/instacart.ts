// Injectable JavaScript strings for Instacart Storefront WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// WHAT THIS FILE IS
// Instacart white-labels one storefront app to many grocery banners. This module
// is that platform's adapter, parameterized by an InstacartTenant — the banner's
// origin, its /store/{slug}/ path segment, and its cookie domain. It began life
// as aldi.ts (ALDI moved onto the platform in its Q1 2026 relaunch) and was
// generalised in place, so every injected script below is the exact text that
// drove ALDI before the extraction.
//
// HOW MANY STOREFRONTS HAVE ACTUALLY RUN THROUGH IT: one.
// ALDI is the only tenant in INSTACART_TENANTS and the only banner we hold
// captured HTML for. MEAL-20 records that aldi.us, delivery.publix.com and
// shop.sprouts.com return 200 for the same /store/{slug}/s?k= route, but a
// matching URL contract is not a matching DOM. Nothing here is verified against
// a second banner, and the selectors below are ALDI observations — treat them as
// the platform's *likely* shape, not its confirmed one, until someone captures
// fixtures for another storefront (see tests/fixtures/README.md).
//
// DOM reference (observed on ALDI, 2026):
//   Store URL:          {origin}/store/{slug}/storefront
//   Search URL:         {origin}/store/{slug}/s?k={term} (Instacart pattern; /search was retired)
//   Add to cart button: button[aria-label^="Add 1 "] (name in aria-label)
//   Product card link:  a[href*="/store/{slug}/products/"]
//   Increment button:   button[aria-label^="Increment quantity"]
//   Decrement button:   button[aria-label^="Decrement quantity"]
//   Cart quantity:      [data-testid="item-quantity"] or similar counter element
//
// A NOTE ON THE PRODUCT-NAME SCORER BELOW
// buildSearchAndAddScript inlines its OWN scoring implementation, which has
// drifted from src/lib/webview-scripts/_scoring.ts (0.3 overlap floor vs 0.7, a
// ±15 critical-word penalty vs a hard veto, −5 per extra candidate word, and a
// COMMON stopword set with no counterpart there). The two disagree on 427 of 469
// real pairs. That divergence is DELIBERATELY PRESERVED here: reconciling it
// changes which product ALDI adds to a cart and is not this adapter's business.
// Read the note above buildSearchAndAddScript() before touching it — there is an
// argument-order trap that makes a naive swap silently invert the comparison.

import type { StoreScripts } from './index';
import {
  selectorsFor,
  rawSelectorsFor,
  storeConfig,
  searchUrlFor,
  PlatformId,
} from '../automation-config';

/**
 * The platform every tenant in this module runs on (MEAL-21).
 *
 * Passed to selectorsFor() so a banner inherits platforms.instacart.selectors from
 * the automation config. Declared HERE rather than read from each tenant's config
 * entry on purpose: a tenant registered below but not yet present in
 * BUNDLED_AUTOMATION_CONFIG still inherits, which is what lets a new banner skip
 * the config table entirely (its entry is then only about a per-banner kill switch).
 */
const PLATFORM: PlatformId = 'instacart';

// ── Tenant model ──────────────────────────────────────────────────────────────

/**
 * One grocery banner running on Instacart Storefront.
 *
 * An entry here buys you the injected scripts and nothing else — the store is
 * not yet selectable, automatable, or capturable. See the checklist above
 * INSTACART_TENANTS for the registrations a banner actually needs.
 */
export interface InstacartTenant {
  /** Store id from constants/stores.ts. Doubles as the automation-config and
   *  selector key, so each banner is tunable on its own from a config push. */
  storeId: string;
  /** Origin with scheme, no trailing slash. e.g. 'https://www.aldi.us' */
  origin: string;
  /** The banner's path segment in /store/{slug}/…. e.g. 'aldi' */
  slug: string;
  /** Cookie / navigation domain, used to recognise this banner's URLs. */
  domain: string;
  /** Selector fallbacks layered over the platform defaults, for a banner whose
   *  markup diverges. Remote config still overrides whatever lands here. */
  selectorOverrides?: Record<string, string>;
  /** Regex alternation proving the Main Menu belongs to a signed-OUT session.
   *  Parameterized because login is where banners diverge most (membership
   *  gates, SSO), even though search/add/confirm are shared. */
  signedOutWords?: string;
  /** Regex alternation proving a signed-IN session. */
  signedInWords?: string;
  /** Compiled-in defaults for the runtime knobs. Remote config overrides them. */
  forceSerialSearch?: boolean;
  workerCount?: number;
  workerStaggerMs?: number;
  cacheBustNav?: boolean;
}

/** Platform-wide selector fallbacks, with the tenant's slug woven in.
 *
 *  These are the COMPILE-TIME floor, the least specific layer. Above them sit
 *  platforms.instacart.selectors (shared by every banner) and then
 *  stores.<banner>.selectors (that banner alone) — see selectorsFor(). So a
 *  platform redesign is one config push rather than an App Store release, and the
 *  set below is what a banner still resolves to if config goes silent entirely.
 *
 *  Note which selectors CANNOT move up into the platform table: `cardLink` weaves
 *  in the tenant's own slug, and the platform table is static JSON that does not
 *  know which tenant is reading it. Slug-parameterised selectors stay here. */
export function selFallbacks(t: InstacartTenant): Record<string, string> {
  return {
    atc: 'button[aria-label^="Add 1 "]',
    inc: 'button[aria-label^="Increment quantity"], button[aria-label^="Increase quantity"]',
    qtyBubble: 'button[aria-label^="Quantity:"]',
    cardLink: `a[href*="/store/${t.slug}/products/"]`,
    menu: '[role="dialog"][aria-label="Main Menu"]',
    hamburger: '[data-testid="hamburger-coachmark-button"], button[aria-label="Main Menu"]',
    // The collapsed search affordance. Instacart renders it with Emotion, so
    // these class names are BUILD-HASHED content, not a stable contract — they
    // can change on any ALDI redeploy and are near-certain to differ on another
    // banner. They live here, not inline, precisely so that day is a config push
    // instead of an App Store release. The script keeps a text-matching fallback
    // ("ask or search") for when they go stale before a push lands.
    searchTrigger: 'label[class*="e-6xs547"], span[class*="e-1olf6x2"]',
    // The in-cart count on a product card, in the two shapes ALDI was observed
    // rendering it: a testid'd counter, or a bubble button whose aria-label
    // carries the number ("Quantity: N", "N ct", "N in cart").
    cardQty: '[data-testid="item-quantity"], [data-testid*="quantity" i]',
    cardQtyBubble: 'button[aria-label^="Quantity:"], button[aria-label$=" ct"], button[aria-label$=" in cart"]',
    // NOT pushable, and deliberately so: getCardQty's last resort reads the
    // count out of the increment button's aria-label with /currently\s+(\d+)/i.
    // A regex is not a selector — merge.ts rejects the backslashes it needs, and
    // splicing an unescaped `/` into a regex literal is an injection this file
    // should not open. It stays inline. Both selectors above run first, so a
    // banner that labels its stepper differently is still recoverable by a push.
    ...t.selectorOverrides,
  };
}

/** Live selectors as interpolatable JS literals (quotes included).
 *  Call inside a build function — the remote config loads after this module is
 *  imported, so a module-scope capture would freeze the fallbacks forever. */
const sel = (t: InstacartTenant) => selectorsFor(t.storeId, selFallbacks(t), PLATFORM);

/** The same selectors, RAW, for the sites that interpolate into a quoted literal
 *  the script already owns. Same override precedence, revalidated on read — see
 *  rawSelectorsFor(). Used where switching to the `${sel.x}` form would have
 *  changed the bytes of a script that already ships. */
const rawSel = (t: InstacartTenant) => rawSelectorsFor(t.storeId, selFallbacks(t), PLATFORM);

/**
 * The `:not(…)` clause that keeps the "is some OTHER modal up?" probe from
 * matching the banner's own Main Menu.
 *
 * Derived from the tenant's RESOLVED menu selector rather than hardcoded: the
 * menu is overridable (per-tenant and by config push), and an exclusion that
 * didn't move with it would silently stop matching, leaving the login poll
 * fighting the sign-in modal it was written to yield to. Prefers the menu's
 * aria-label clause (what the dialogs are actually distinguished by); falls back
 * to excluding the whole menu selector when there isn't one.
 */
function menuExclusion(menuSel: string): string {
  const label = menuSel.match(/\[aria-label=("[^"]*"|'[^']*'|[^\]]+)\]/);
  return `:not(${label ? `[aria-label=${label[1]}]` : menuSel})`;
}

/** The `{origin}/store/{slug}/s?k=` prefix every search URL is built from. */
function searchPrefix(t: InstacartTenant): string {
  return `${t.origin}/store/${t.slug}/s?k=`;
}

/** Name of the window guard that stops a re-injected login check from
 *  double-driving the Main Menu. Per-tenant so two banners in one WebView
 *  session cannot share (and clobber) one flag. */
function loginFlag(t: InstacartTenant): string {
  return `__${t.storeId}LoginCheckActive`;
}

const DEFAULT_SIGNED_OUT_WORDS = 'sign in|log in|register|create account';
const DEFAULT_SIGNED_IN_WORDS =
  'buy it again|saved recipes|sign out|log out|your account|account settings';

// ── Login check ───────────────────────────────────────────────────────────────

function buildCheckLoginScript(t: InstacartTenant): string {
  const s = sel(t);
  const FLAG = loginFlag(t);
  // Follows s.menu wherever a tenant or a config push moves it. See menuExclusion().
  const NOT_MENU = menuExclusion(rawSel(t).menu);
  // NOTE: these are spliced RAW into /${outWords}/ below, so they are a regex
  // source, not a literal — `|` alternation is the point. Developer-authored at
  // compile time (InstacartTenant is a code-level registry, not a config push),
  // so this is not a reachable injection surface; it does mean a tenant author
  // must write a VALID regex here, and a stray `/` would end the literal.
  const outWords = t.signedOutWords ?? DEFAULT_SIGNED_OUT_WORDS;
  const inWords = t.signedInWords ?? DEFAULT_SIGNED_IN_WORDS;
  return `(async function() {
  if (window.${FLAG}) return;
  window.${FLAG} = true;
  try {
    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    var MENU_SEL = ${s.menu};
    var HAMBURGER_SEL = ${s.hamburger};

    // The logged-in state (user name vs "Sign In"/"Register") is only visible
    // INSIDE the Main Menu dialog, so it must be opened before it can be read.
    function getMenu() {
      var d = document.querySelector(MENU_SEL);
      return (d && d.textContent && d.textContent.length > 5) ? d : null;
    }

    // Open the Main Menu (if not already open) and wait for it to render.
    // Returns the dialog element, or null if it never appeared.
    async function openMenu() {
      var menu = getMenu();
      if (menu) return menu;
      var btn = document.querySelector(HAMBURGER_SEL);
      if (btn) btn.click();
      for (var i = 0; i < 20; i++) {
        menu = getMenu();
        if (menu) return menu;
        await wait(200);
      }
      return null;
    }

    // Close the Main Menu so the modal doesn't block the search flow that follows.
    function closeMenu() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      var menu = document.querySelector(MENU_SEL);
      if (menu) {
        var closeBtn = menu.querySelector('button[aria-label*="close" i], button[aria-label*="dismiss" i]');
        if (closeBtn) closeBtn.click();
      }
    }

    // Positive proof of logged-OUT: the sign-in CTA. Checked FIRST and treated
    // as decisive, so we never falsely claim logged-in while it's still
    // rendering (the menu mounts before its contents populate).
    var SIGNED_OUT_RE = /${outWords}/;
    // Positive proof of logged-IN: personalized menu entries that only exist for
    // a signed-in account (plus the account/sign-out controls when present).
    var SIGNED_IN_RE = /${inWords}/;

    // Open the menu and decide login state. The menu's contents render AFTER the
    // dialog mounts, so an early read can miss the "Sign in" CTA and look
    // logged-in. So: (a) short-circuit to 'out' the instant the CTA appears
    // (the safe direction), and (b) only trust 'in' once the menu text has
    // STABILIZED (no length change across two ticks) and a logged-in signal is
    // present. Returns 'in' | 'out' | 'unknown'.
    async function evaluateMenu() {
      var menu = await openMenu();
      if (!menu) return 'unknown';
      var lastLen = -1, stableTicks = 0, text = '';
      for (var i = 0; i < 28; i++) {            // up to ~7s
        menu = getMenu() || menu;
        text = (menu.textContent || '').toLowerCase();
        if (SIGNED_OUT_RE.test(text)) return 'out';
        if (text.length === lastLen) {
          if (++stableTicks >= 2) break;        // menu has settled
        } else { stableTicks = 0; lastLen = text.length; }
        await wait(250);
      }
      if (SIGNED_OUT_RE.test(text)) return 'out';
      if (SIGNED_IN_RE.test(text)) return 'in';
      return 'unknown';
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    var verdict = await evaluateMenu();
    // Default-safe: only a positive 'in' counts as logged-in. 'unknown' (the
    // menu never produced a decisive signal) shows the login UI.
    var isLoggedIn = verdict === 'in';

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'check_done', verdict: verdict, isLoggedIn: isLoggedIn
    }));

    if (isLoggedIn) {
      // Close the menu so the upcoming search isn't blocked by the modal.
      closeMenu();
      window.${FLAG} = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }));
      return;
    }

    // Not logged in (or inconclusive) — leave the menu open so the user sees
    // "Sign In" when the webview becomes visible, then post the status. Keep
    // ${FLAG} set so a reinject (reinjectLoginCheckOnNav) during
    // the poll is suppressed and can't double-drive the menu.
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false }));

    // Background poll: every 2s for up to 3 minutes, re-evaluate the menu.
    // Covers SPA logins that finish without a full page reload (where
    // reinjectLoginCheckOnNav never fires). Posts LOGIN_COMPLETE.
    for (var pi = 0; pi < 90; pi++) {
      await wait(2000);
      // Don't fight a sign-in modal: if some OTHER visible dialog is up (the
      // login form), skip this tick rather than yanking the Main Menu open.
      var other = document.querySelector('[role="dialog"][aria-modal="true"]${NOT_MENU}');
      if (other && other.offsetParent !== null) continue;
      if (await evaluateMenu() === 'in') {
        closeMenu();
        window.${FLAG} = false;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_COMPLETE' }));
        return;
      }
    }
    window.${FLAG} = false;
  } catch(e) {
    window.${FLAG} = false;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: false, error: String(e) }));
  }
})();true;`;
}

// ── Product extraction ────────────────────────────────────────────────────────

/**
 * Injected on an ALDI/Instacart search results page.
 * Extracts product candidates from "Add 1 item" buttons.
 * Posts { type: 'SEARCH_RESULT', candidates: [...] }.
 */
function buildExtractProductsScript(t: InstacartTenant): string {
  const s = sel(t);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var ATC_SEL = ${s.atc};
  var QTY_BUBBLE_SEL = ${s.qtyBubble};
  // Product cards contain either an add button OR a quantity bubble.
  // Use product card links to find all products regardless of cart state.
  var CARD_LINK_SEL = ${s.cardLink};

  // Stale detection: capture current first product link text.
  function getFirstLinkName() {
    var links = document.querySelectorAll(CARD_LINK_SEL);
    for (var li = 0; li < links.length; li++) {
      var t = links[li].textContent.trim();
      if (t.length > 5) return t.slice(0, 80);
    }
    return null;
  }
  var staleName = getFirstLinkName();

  // Poll for fresh products (up to 10s).
  var productLinks = [];
  for (var poll = 0; poll < 50; poll++) {
    productLinks = Array.from(document.querySelectorAll(CARD_LINK_SEL));
    if (productLinks.length > 0) {
      var currentName = getFirstLinkName();
      if (!staleName || currentName !== staleName) break;
    }
    await wait(200);
  }

  if (productLinks.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 30) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var text = card.textContent || '';
    var m = text.match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  function getProductName(card) {
    // Try "Add 1" button aria-label first (clean product name).
    var addBtn = card.querySelector(ATC_SEL);
    if (addBtn) {
      var m = (addBtn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
      if (m) return m[1].trim();
    }
    // Try image alt text (usually clean product name).
    var img = card.querySelector('img[alt]');
    if (img) {
      var alt = img.getAttribute('alt').trim();
      if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) return alt;
    }
    // Fall back to URL slug: /store/${t.slug}/products/12345-product-name-size
    var link = card.querySelector(CARD_LINK_SEL);
    if (link) {
      var href = link.getAttribute('href') || '';
      var slugMatch = href.match(/\\/products\\/\\d+-(.+)/);
      if (slugMatch) {
        // Convert slug to title: "happy-harvest-crushed-tomatoes-28-oz" → "Happy Harvest Crushed Tomatoes 28 Oz"
        return slugMatch[1].split('-').map(function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
    }
    return null;
  }

  var seen = new Set();
  var candidates = [];

  // Iterate over product card links to find ALL products (including those already in cart).
  for (var pi = 0; pi < productLinks.length && pi < 20; pi++) {
    var card = findCard(productLinks[pi]);
    if (!card) continue;
    var name = getProductName(card);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector(ATC_SEL);
    var outOfStock = addBtn ? (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true') : false;
    var imgEl = card.querySelector('img');
    var imageUrl = imgEl ? (imgEl.src || imgEl.getAttribute('srcset')?.split(' ')[0] || null) : null;
    var price = extractPrice(card);

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: null, price: price });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;
}

// ── Add to cart ───────────────────────────────────────────────────────────────

function buildAddToCartScript(
  t: InstacartTenant,
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  const escapedName = JSON.stringify(productName);

  const s = sel(t);
  const r = rawSel(t);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var QTY = ${qty};
  var ATC_SEL = ${s.atc};
  var INC_SEL = ${s.inc};
  var QTY_BUBBLE_SEL = ${s.qtyBubble};

  // Find the add button for this product.
  var btns = Array.from(document.querySelectorAll(ATC_SEL));
  var targetBtn = null;
  for (var i = 0; i < btns.length; i++) {
    var ariaLabel = btns[i].getAttribute('aria-label') || '';
    var nameMatch = ariaLabel.match(/^Add 1 (?:item|ct)\\s+(.+)/i);
    if (nameMatch && nameMatch[1].trim() === TARGET_NAME) {
      targetBtn = btns[i];
      break;
    }
  }

  if (!targetBtn) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  // Find the product card container for increment buttons.
  var card = targetBtn.parentElement;
  for (var depth = 0; depth < 10 && card; depth++) {
    if (card.querySelector('img') && card.textContent.length > 30) break;
    card = card.parentElement;
  }

  // Read the in-cart quantity shown on this product's card. Returns a number
  // when the count is legible, 0 when only the "Add 1" button is present, or
  // null when the DOM exposes no counter at all (caller then falls back to a
  // presence check). ALDI surfaces the count as a "Quantity: N" bubble, an
  // "N ct"/"N in cart" bubble, an item-quantity testid, or inside the
  // increment button's aria-label ("Increment quantity, currently N").
  function getCardQty(el) {
    if (!el) return null;
    var q = el.querySelector('${r.cardQty}');
    if (q) { var qt = (q.textContent || '').match(/\\d+/); if (qt) return parseInt(qt[0], 10); }
    var bubble = el.querySelector('${r.cardQtyBubble}');
    if (bubble) { var bm = (bubble.getAttribute('aria-label') || '').match(/(\\d+)/); if (bm) return parseInt(bm[1], 10); }
    var inc = el.querySelector(INC_SEL);
    if (inc) { var im = (inc.getAttribute('aria-label') || '').match(/currently\\s+(\\d+)/i); if (im) return parseInt(im[1], 10); }
    if (el.querySelector(ATC_SEL)) return 0;
    return null;
  }

  // Poll until the card's quantity reaches target. Instacart commits the add
  // over the network, so the count lags the click — bounded poll, not a fixed
  // wait. When the count is unreadable, fall back to "did the item enter the
  // cart at all" (stepper/bubble present). Returns false on timeout so the
  // caller can report an honest failure instead of a hardcoded success.
  async function confirmQty(el, target) {
    for (var ci = 0; ci < 16; ci++) {
      var q = getCardQty(el);
      if (q !== null) { if (q >= target) return true; }
      else if (el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL))) return true;
      await wait(250);
    }
    var qf = getCardQty(el);
    if (qf !== null) return qf >= target;
    return !!(el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL)));
  }

  // Baseline before we touch the cart; add is additive, so the target is
  // whatever was already there plus the requested QTY.
  var beforeQty = getCardQty(card);
  var target = (beforeQty === null ? 0 : beforeQty) + QTY;

  // Click add button first time.
  targetBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
  await wait(200);
  targetBtn.click();
  await wait(1000);
  var quantityAdded = 1;

  // Increment for remaining qty.
  while (quantityAdded < QTY) {
    var incrBtn = card ? card.querySelector(INC_SEL) : null;
    if (!incrBtn) break;
    incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await wait(200);
    incrBtn.click();
    await wait(500);
    quantityAdded++;
  }

  var confirmed = await confirmQty(card, target);
  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify(
    confirmed
      ? { type: 'ADD_RESULT', success: true }
      : { type: 'ADD_RESULT', success: false, reason: 'not_confirmed' }
  ));
})();true;`;
}

// ── Search navigation ─────────────────────────────────────────────────────────

function buildSearchScript(t: InstacartTenant, term: string): string {
  const escaped = JSON.stringify(term);
  const s = sel(t);
  const r = rawSel(t);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};
  var ATC_SEL = ${s.atc};

  // Capture stale product name for freshness detection.
  function getFirstName() {
    var b = document.querySelector(ATC_SEL);
    if (!b) return null;
    var m = (b.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
    return m ? m[1].trim() : null;
  }
  var staleName = getFirstName();

  // The search input (#search-bar-input) is hidden until the search area is clicked.
  // Click the "Ask or search anything" label/span to open it.
  var trigger = document.querySelector('${r.searchTrigger}');
  if (!trigger) {
    // Broader fallback: click anything containing "search anything".
    var allEls = document.querySelectorAll('label, span, div');
    for (var ti = 0; ti < allEls.length; ti++) {
      if (/ask or search/i.test(allEls[ti].textContent) && allEls[ti].textContent.length < 60) {
        trigger = allEls[ti];
        break;
      }
    }
  }
  if (trigger) {
    trigger.click();
    await wait(500);
  }

  // Now find the search input (should be visible after clicking trigger).
  var searchInput = document.getElementById('search-bar-input')
    || document.querySelector('input[aria-label="Search"]')
    || document.querySelector('input[placeholder*="search" i]');

  if (!searchInput) {
    // Last resort: URL navigation.
    window.location.href = '${searchPrefix(t)}' + encodeURIComponent(term);
    return;
  }

  // Focus and type the search term.
  searchInput.focus();
  await wait(100);

  var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  var setter = nativeSetter ? nativeSetter.set : null;
  if (setter) {
    setter.call(searchInput, '');
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(50);
    setter.call(searchInput, term);
  } else {
    searchInput.value = term;
  }
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(300);

  // Submit with Enter.
  var form = searchInput.closest('form');
  if (form) {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  ['keydown', 'keypress', 'keyup'].forEach(function(type) {
    searchInput.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
  });

  // Wait for fresh results (stale detection, up to 10s).
  for (var pi = 0; pi < 50; pi++) {
    await wait(200);
    var currentName = getFirstName();
    if (currentName && currentName !== staleName) break;
    // If products disappeared (SPA transition), wait for new ones.
    if (pi > 15 && document.querySelectorAll(ATC_SEL).length === 0) {
      for (var wi = 0; wi < 30; wi++) {
        await wait(200);
        if (document.querySelectorAll(ATC_SEL).length > 0) break;
      }
      break;
    }
  }
})();true;`;
}

// ── Search + auto-add ─────────────────────────────────────────────────────────
//
// DO NOT REPLACE THE INLINE SCORER BELOW WITH _scoring.ts.
//
// The scoreOne/scoreMatch pair inside this template is NOT the shared scorer in
// src/lib/webview-scripts/_scoring.ts, and the difference is not an oversight:
//
//   • overlap floor 0.3 here vs 0.7 there
//   • missing/extra critical words cost ±15 here vs a hard veto (return 0) there
//   • −5 per extra candidate word here; no such term there
//   • a COMMON stopword set here with no counterpart there
//
// Measured over 469 real product/query pairs the two disagree on 427. Swapping
// in the shared function would change which product lands in a customer's cart
// on every one of those, so it is a product decision, not a cleanup.
//
// If you ever do reconcile them, note the ARGUMENT ORDER. This scoreOne(nf, nt)
// reads its SECOND parameter as the query and is called as scoreMatch(name,
// SEARCH_TERM); _scoring.ts's scoreMatch(a, b) scores candidate `b` against
// term `a`. The orientations agree only because both the function and its call
// site are written this way. Substituting the shared function without also
// flipping the call site silently inverts the comparison — and it will still
// return plausible-looking numbers, so nothing will fail loudly.

function buildSearchAndAddScript(
  t: InstacartTenant,
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
): string {
  const escapedTerm = JSON.stringify(searchTerm);
  const s = sel(t);
  const r = rawSel(t);
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  var ATC_SEL = ${s.atc};
  var INC_SEL = ${s.inc};
  var QTY_BUBBLE_SEL = ${s.qtyBubble};
  var CARD_LINK_SEL = ${s.cardLink};

  // Stale detection using card links (works for products in cart too).
  function getFirstLinkName() {
    var links = document.querySelectorAll(CARD_LINK_SEL);
    for (var li = 0; li < links.length; li++) {
      var t = links[li].textContent.trim();
      if (t.length > 5) return t.slice(0, 80);
    }
    return null;
  }
  var staleName = getFirstLinkName();

  // Open search, type term, submit.
  var trigger = document.querySelector('${r.searchTrigger}');
  if (!trigger) {
    var allEls = document.querySelectorAll('label, span, div');
    for (var ti = 0; ti < allEls.length; ti++) {
      if (/ask or search/i.test(allEls[ti].textContent) && allEls[ti].textContent.length < 60) {
        trigger = allEls[ti];
        break;
      }
    }
  }
  if (trigger) { trigger.click(); await wait(500); }

  var searchInput = document.getElementById('search-bar-input')
    || document.querySelector('input[aria-label="Search"]')
    || document.querySelector('input[placeholder*="search" i]');

  if (searchInput) {
    searchInput.focus();
    await wait(100);
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    var setter = nativeSetter ? nativeSetter.set : null;
    if (setter) {
      setter.call(searchInput, '');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(50);
      setter.call(searchInput, SEARCH_TERM);
    } else {
      searchInput.value = SEARCH_TERM;
    }
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
    var form = searchInput.closest('form');
    if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    ['keydown', 'keypress', 'keyup'].forEach(function(type) {
      searchInput.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
  } else {
    window.location.href = '${searchPrefix(t)}' + encodeURIComponent(SEARCH_TERM);
  }

  // Wait for fresh search results (stale detection via card links, up to 10s).
  var productLinks = [];
  for (var poll = 0; poll < 50; poll++) {
    productLinks = Array.from(document.querySelectorAll(CARD_LINK_SEL));
    if (productLinks.length > 0) {
      var currentName = getFirstLinkName();
      if (!staleName || currentName !== staleName) break;
    }
    await wait(200);
  }

  if (productLinks.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: [] }));
    return;
  }

  // Score and find best match.
  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground']);
  var COMMON = new Set(['the','and','or','of','a','an','in','on','at','to','for','with']);

  // Dual normalization to handle stores that mangle ñ/é/etc. inconsistently
  // across renderings (Walmart strips ñ entirely on certain queries; others
  // may NFD-decompose). Score both ways and take the better.
  function normDiacritic(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function normStrip(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^\\x00-\\x7f]/g, '').replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\\s+/g, ' ').trim();
  }

  function scoreOne(nf, nt) {
    if (nf === nt) return 100;
    var wt = nt.split(' ').filter(Boolean), wf = new Set(nf.split(' ').filter(Boolean));
    var critTarget = wt.filter(function(w) { return CRITICAL.has(w); });
    var critFound = [];
    wf.forEach(function(w) { if (CRITICAL.has(w)) critFound.push(w); });
    // Penalize missing critical words instead of hard-rejecting.
    // ALDI has limited selection — "Organic Broccoli" should still match "Broccoli Crowns".
    var critPenalty = 0;
    for (var i = 0; i < critTarget.length; i++) { if (!wf.has(critTarget[i])) critPenalty += 15; }
    for (var j = 0; j < critFound.length; j++) {
      var inTarget = false;
      for (var k = 0; k < critTarget.length; k++) { if (critTarget[k] === critFound[j]) { inTarget = true; break; } }
      if (!inTarget) critPenalty += 15;
    }
    var matching = wt.filter(function(w) { return wf.has(w); });
    var pct = matching.length / wt.length;
    if (pct < 0.3) return -1;
    var extra = [];
    wf.forEach(function(w) {
      if (!new Set(wt).has(w) && !COMMON.has(w)) extra.push(w);
    });
    var score = Math.round(pct * 100) - (extra.length * 5) - critPenalty;
    return Math.max(0, score);
  }

  function scoreMatch(found, target) {
    var s1 = scoreOne(normDiacritic(found), normDiacritic(target));
    var s2 = scoreOne(normStrip(found), normStrip(target));
    return Math.max(s1, s2);
  }

  function findCard(btn) {
    var node = btn.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 30) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var m = (card.textContent || '').match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  function getProductName(card) {
    var addBtn = card.querySelector(ATC_SEL);
    if (addBtn) {
      var m = (addBtn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
      if (m) return m[1].trim();
    }
    var img = card.querySelector('img[alt]');
    if (img) {
      var alt = img.getAttribute('alt').trim();
      if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) return alt;
    }
    var link = card.querySelector(CARD_LINK_SEL);
    if (link) {
      var href = link.getAttribute('href') || '';
      var slugMatch = href.match(/\\/products\\/\\d+-(.+)/);
      if (slugMatch) {
        return slugMatch[1].split('-').map(function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
    }
    return null;
  }

  var seen = new Set();
  var candidates = [];
  var bestCard = null, bestName = null, bestScore = -1;

  for (var pi = 0; pi < productLinks.length && pi < 20; pi++) {
    var card = findCard(productLinks[pi]);
    if (!card) continue;
    var name = getProductName(card);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var addBtn = card.querySelector(ATC_SEL);
    var oos = addBtn ? (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true') : false;
    var imgEl = card.querySelector('img');

    candidates.push({
      productName: name,
      imageUrl: imgEl ? (imgEl.src || null) : null,
      outOfStock: oos,
      preferences: null,
      price: extractPrice(card)
    });

    if (!oos) {
      var sc = scoreMatch(name, SEARCH_TERM);
      if (sc > bestScore) {
        bestScore = sc;
        bestName = name;
        bestCard = card;
      }
    }
    if (candidates.length >= 8) break;
  }

  var MIN_SCORE = 30;
  if (!bestName || bestScore < MIN_SCORE || !bestCard) {
    var hasExactOos = candidates.some(function(c) { return scoreMatch(c.productName, SEARCH_TERM) >= MIN_SCORE && c.outOfStock; });
    var reason = candidates.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: candidates }));
    return;
  }

  // Read the in-cart quantity on a card (see buildAddToCartScript for the DOM
  // shapes ALDI uses). Number when legible, 0 when only "Add 1" is present,
  // null when no counter is exposed.
  function getCardQty(el) {
    if (!el) return null;
    var q = el.querySelector('${r.cardQty}');
    if (q) { var qt = (q.textContent || '').match(/\\d+/); if (qt) return parseInt(qt[0], 10); }
    var bubble = el.querySelector('${r.cardQtyBubble}');
    if (bubble) { var bm = (bubble.getAttribute('aria-label') || '').match(/(\\d+)/); if (bm) return parseInt(bm[1], 10); }
    var inc = el.querySelector(INC_SEL);
    if (inc) { var im = (inc.getAttribute('aria-label') || '').match(/currently\\s+(\\d+)/i); if (im) return parseInt(im[1], 10); }
    if (el.querySelector(ATC_SEL)) return 0;
    return null;
  }

  // Bounded poll for the cart to reflect the add over the network; presence
  // fallback when the count is unreadable. False on timeout → honest failure.
  async function confirmQty(el, target) {
    for (var ci = 0; ci < 16; ci++) {
      var q = getCardQty(el);
      if (q !== null) { if (q >= target) return true; }
      else if (el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL))) return true;
      await wait(250);
    }
    var qf = getCardQty(el);
    if (qf !== null) return qf >= target;
    return !!(el && (el.querySelector(INC_SEL) || el.querySelector(QTY_BUBBLE_SEL)));
  }

  try {
    // Baseline before we touch the cart; the add is additive.
    var beforeQty = getCardQty(bestCard);
    var target = (beforeQty === null ? 0 : beforeQty) + QTY;

    // Find the add button or qty bubble on the matched card.
    var addBtn2 = bestCard.querySelector(ATC_SEL);
    var quantityAdded = 0;

    if (addBtn2) {
      // Product not yet in cart — click add.
      addBtn2.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      addBtn2.click();
      await wait(1000);
      quantityAdded = 1;
    } else {
      // Product already in cart — increment button should be visible.
      // Only click qty bubble if increment isn't directly available (collapsed stepper).
      var initIncr = bestCard.querySelector(INC_SEL);
      if (!initIncr) {
        var initBubble = bestCard.querySelector(QTY_BUBBLE_SEL);
        if (initBubble) {
          initBubble.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(200);
          initBubble.click();
          await wait(500);
        }
      }
    }

    // Increment for remaining qty.
    while (quantityAdded < QTY) {
      var incrBtn = bestCard ? bestCard.querySelector(INC_SEL) : null;
      if (!incrBtn) break;
      incrBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(200);
      incrBtn.click();
      await wait(500);
      quantityAdded++;
    }

    var confirmed = await confirmQty(bestCard, target);
    document.removeEventListener('focusin', __noKbd, true);
    if (confirmed) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: bestName }));
    } else {
      // Same shape as the not-found/low-confidence failures above, so an add
      // that never committed routes into the Review picker like other search
      // stores instead of reporting a false success.
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'not_confirmed', candidates: candidates }));
    }
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'error', candidates: candidates }));
  }
})();true;`;
}

// ── Parallel worker support ───────────────────────────────────────────────────
//
// Mirrors the Wegmans 5-worker pool (see wegmans.ts buildWegmansWorkerScript
// and useParallelSearchPool): each hidden worker WebView loads a search URL
// from getInstacartSearchUrl, and this injected script extracts up to 8 product
// candidates and posts WORKER_RESULT with the baked-in workerId. Unlike the
// sequential buildExtractProductsScript(), every dispatch is a fresh page load,
// so no stale-tile detection is needed.
//
// Note this path is built but NOT used for ALDI at runtime: forceSerialSearch is
// on because the platform's anti-bot 403s the concurrent burst. See getScripts().

function buildWorkerExtractBody(t: InstacartTenant): string {
  const s = sel(t);
  return `(function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function dbg(obj) {
    try {
      obj.type = 'WORKER_DEBUG'; obj.workerId = WORKER_ID;
      window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } catch(_) {}
  }

  var CARD_LINK_SEL = ${s.cardLink};
  var ATC_SEL = ${s.atc};

  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      if (node.querySelector('img') && node.textContent.length > 30) return node;
      node = node.parentElement;
    }
    return null;
  }

  function extractPrice(card) {
    if (!card) return null;
    var text = card.textContent || '';
    var m = text.match(/\\$\\d+\\.\\d{2}/);
    return m ? m[0] : null;
  }

  function getProductName(card) {
    var addBtn = card.querySelector(ATC_SEL);
    if (addBtn) {
      var m = (addBtn.getAttribute('aria-label') || '').match(/^Add 1 (?:item|ct)\\s+(.+)/i);
      if (m) return m[1].trim();
    }
    var img = card.querySelector('img[alt]');
    if (img) {
      var alt = img.getAttribute('alt').trim();
      if (alt.length > 2 && !/placeholder|logo|banner/i.test(alt)) return alt;
    }
    var link = card.querySelector(CARD_LINK_SEL);
    if (link) {
      var href = link.getAttribute('href') || '';
      var slugMatch = href.match(/\\/products\\/\\d+-(.+)/);
      if (slugMatch) {
        return slugMatch[1].split('-').map(function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
      }
    }
    return null;
  }

  // Query comes from the search URL (/store/${t.slug}/s?k=...). No query means a
  // warmup/initial load — stay silent so the pool doesn't record a result.
  var query = '';
  try {
    var sp = new URLSearchParams(window.location.search);
    query = sp.get('k') || '';
  } catch(_) {}
  if (!query) {
    dbg({ step: 'warmup_load', url: window.location.href });
    return;
  }

  (async function() {
    dbg({ step: 'extract_start', query: query, url: window.location.href });

    var productLinks = [];
    var waitedMs = 0;
    for (var poll = 0; poll < 50; poll++) {
      productLinks = Array.from(document.querySelectorAll(CARD_LINK_SEL));
      if (productLinks.length > 0) break;
      await wait(200);
      waitedMs += 200;
    }

    var seen = new Set();
    var candidates = [];
    for (var pi = 0; pi < productLinks.length && candidates.length < 8; pi++) {
      var card = findCard(productLinks[pi]);
      if (!card) continue;
      var name = getProductName(card);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      var addBtn = card.querySelector(ATC_SEL);
      var outOfStock = addBtn ? (addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true') : false;
      var imgEl = card.querySelector('img');
      candidates.push({
        productName: name,
        imageUrl: imgEl ? imgEl.src : null,
        outOfStock: outOfStock,
        preferences: null,
        price: extractPrice(card),
      });
    }

    dbg({ step: 'extract_done', waitedMs: waitedMs, candidateCount: candidates.length, firstName: candidates[0] ? candidates[0].productName : null });
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'WORKER_RESULT', workerId: WORKER_ID, query: query, candidates: candidates,
    }));
  })();
})();
true;
`;
}

/** Returns injectedJavaScript for a single worker. The workerId is baked in. */
export function buildInstacartWorkerScript(t: InstacartTenant, workerId: number): string {
  return 'var WORKER_ID = ' + workerId + ';\n' + buildWorkerExtractBody(t);
}

/** Returns the Instacart search-results URL for a query on this tenant. */
export function getInstacartSearchUrl(t: InstacartTenant, query: string): string {
  return searchPrefix(t) + encodeURIComponent(query);
}

// ── Tenant registry ───────────────────────────────────────────────────────────

/**
 * Every banner we drive on Instacart Storefront, keyed by storeId.
 *
 * ADDING ONE needs no new SCRIPT code — that is what the tenant seam bought —
 * but it is more than an entry here. The full checklist, in the order a missing
 * step bites:
 *
 *   1. `WEBVIEW_STORE_IDS` and `STORES` in src/constants/stores.ts. Without the
 *      first, isWebViewStore() is false and the store is never automated;
 *      without the second it does not appear in the picker at all. A tenant
 *      registered only here is unreachable — the most silent miss on the list.
 *   2. An entry here — origin, slug, domain, and any knob whose default differs.
 *   3. OPTIONAL since MEAL-21: a `stores.<storeId>` entry in
 *      BUNDLED_AUTOMATION_CONFIG (schema.ts). It used to mean copying this
 *      platform's whole selector table per banner; now the banner inherits
 *      platforms.instacart.selectors automatically (this module declares PLATFORM,
 *      so inheritance does not depend on the entry existing), and every one of
 *      those selectors is already pushable for it. Add `{ enabled: true }` when you
 *      want the per-banner kill switch, plus any knob whose default differs, and
 *      `selectors` only for a key where this banner genuinely diverges.
 *   4. A `fixture-capture-config.ts` entry, or the documented
 *      `npm run capture -- <storeId>` has nothing to drive and step 6 is manual.
 *   5. Nothing for cart probing: buildInlineCartScript() and extractorFor() in
 *      cart-count.ts both dispatch on this registry via isInstacartStore(), so a
 *      tenant gets the side panel and the header badge for free. (They used to
 *      test for 'aldi' by name, which silently gave a second banner no cart
 *      probe at all; tests/unit/webview-scripts/instacartAdapter.test.ts pins it.)
 *   6. Captured fixtures under tests/fixtures/<storeId>/ and a spec modelled on
 *      tests/fixture-tests/aldi.spec.ts.
 *
 * Step 6 is the one that cannot be skipped. The URL contract being identical
 * across banners (MEAL-20's evidence) says nothing about the DOM, and every
 * selector in selFallbacks() was read off ALDI. A banner added without fixtures
 * is a guess, not a supported store. Expect real work beyond the registrations:
 * the scripts still carry English copy, a USD price regex and scorer word lists
 * tuned on ALDI (see the header of instacartAdapter.test.ts).
 */
export const INSTACART_TENANTS: Record<string, InstacartTenant> = {
  aldi: {
    storeId: 'aldi',
    origin: 'https://www.aldi.us',
    slug: 'aldi',
    domain: 'aldi.us',
    // ALDI (Instacart) anti-bot 403s on concurrent worker requests — confirmed
    // 2026-06-17 that 5 parallel workers still 403 even with the cache-buster
    // removed, so concurrency itself is a trigger. Run searches SERIALLY.
    // workerCount / stagger are kept for if/when the parallel path is retried.
    // Remotely tunable: if ALDI ever stops 403-ing concurrent searches we can
    // re-enable the parallel path with a config push instead of a release.
    forceSerialSearch: true,
    workerCount: 3,
    workerStaggerMs: 400,
    // The anti-bot 403s on the `?_t=` cache-buster query (it lands right on the
    // blocked storefront request). Navigate to the clean URL instead.
    cacheBustNav: false,
  },
};

/** Store ids served by this adapter. Snapshotted at module load. */
export const INSTACART_STORE_IDS: string[] = Object.keys(INSTACART_TENANTS);

/** True when this store runs on Instacart Storefront.
 *
 *  Read LIVE off the registry rather than off the INSTACART_STORE_IDS snapshot,
 *  so anything dispatching on "is this the Instacart platform?" — cart probing
 *  in cart-count.ts especially — picks up a tenant the moment it is registered.
 *  This is the predicate to reach for when the answer is about the PLATFORM
 *  (a side-panel cart, a shared header badge) rather than about one banner. */
export function isInstacartStore(storeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(INSTACART_TENANTS, storeId);
}

// ── Public interface ──────────────────────────────────────────────────────────

export function getInstacartScripts(t: InstacartTenant): StoreScripts {
  // Per-banner config key: unlike the Albertsons family (one shared entry for 15
  // brands), Instacart banners are separate retailers whose selectors can drift
  // apart, so each is tuned and kill-switched on its own.
  const cfg = storeConfig(t.storeId);
  return {
    storeUrl: cfg.storeUrl ?? t.origin,
    loginUrl: cfg.loginUrl ?? t.origin,  // login is via the hamburger menu, not a page
    cartUrl: cfg.cartUrl ?? t.origin,    // no dedicated cart page; it's a side panel
    domain: t.domain,
    isSearchUrl: function(url: string) {
      // Instacart search bar is available on any store page, not just /search.
      // Returning true skips the storefront reload and injects search directly.
      return url.includes(t.domain + '/store/');
    },
    isLoginSuccessUrl: function() { return false; },
    // Instacart reloads the storefront after sign-in. Re-run the login check on
    // that nav so an already-completed login is detected (the background poll in
    // buildCheckLoginScript() is the fallback for SPA logins with no full reload).
    reinjectLoginCheckOnNav: true,
    checkLoginScript: buildCheckLoginScript(t),
    extractProductsScript: buildExtractProductsScript(t),
    buildAddToCartScript: (productName, preference, qty) =>
      buildAddToCartScript(t, productName, preference, qty),
    buildSearchScript: (term) => buildSearchScript(t, term),
    buildSearchAndAddScript: (term, qty, dropdown) =>
      buildSearchAndAddScript(t, term, qty, dropdown),
    getSearchUrl: (term: string) =>
      searchUrlFor(t.storeId, term, getInstacartSearchUrl(t, term)),
    buildWorkerScript: (workerId: number) => buildInstacartWorkerScript(t, workerId),
    forceSerialSearch: cfg.forceSerialSearch ?? t.forceSerialSearch ?? true,
    workerCount: cfg.workerCount ?? t.workerCount ?? 3,
    workerStaggerMs: cfg.workerStaggerMs ?? t.workerStaggerMs ?? 400,
    cacheBustNav: cfg.cacheBustNav ?? t.cacheBustNav ?? false,
    // Instacart SPA: search is a pushState route change (no reload), so the same
    // search page fires onLoadEnd multiple times while the add script is still
    // running. Suppress inflight re-injection so we don't double-add / skip items.
    spaSearch: true,
  };
}

/** Scripts for a storeId served by this adapter, or null if it isn't one. */
export function getInstacartScriptsFor(storeId: string): StoreScripts | null {
  const t = INSTACART_TENANTS[storeId];
  return t ? getInstacartScripts(t) : null;
}
