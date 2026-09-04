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


// ── Add to cart ───────────────────────────────────────────────────────────────


// ── Search navigation ─────────────────────────────────────────────────────────


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
// Measured over 469 real product/query pairs the two disagree on 427.
//
// NONE OF THAT DECIDES A PURCHASE ANY MORE (MEAL-121). This scorer used to gate the
// add — keep the highest scorer, buy it if it cleared 30 out of 100 — so a name
// sharing under a third of its words with the request went into a cart unattended.
// `isExactMatch` gates the add now, exact after normalization like every other
// store, so a divergence in the scoring curve cannot change which product anyone
// ends up buying. What remains of these two functions is unreachable from the
// decision path.
//
// What deleting them WOULD touch, precisely: the generated-script snapshot
// (tests/unit/webview-scripts/__snapshots__/aldiGeneratedScripts.test.ts.snap),
// which pins the emitted text — and nothing else. The match harness imports
// _scoring.ts and only _scoring.ts; it never calls the copy below. So
// tests/match-harness describes this divergence in prose and in its README but does
// not execute it, and would not go red. That makes removal a documentation-and-
// snapshot job rather than a behavioural one; still its own change, though, rather
// than part of a correctness fix.
//
// If you ever do reconcile them, note the ARGUMENT ORDER. This scoreOne(nf, nt)
// reads its SECOND parameter as the query, and until MEAL-121 deleted the call
// site it WAS called as scoreMatch(name, SEARCH_TERM); _scoring.ts's
// scoreMatch(a, b) scores candidate `b` against term `a`. The orientations agreed
// only because the function and that call site were written to match. Any future
// call site has to keep that up: substituting the shared function without also
// writing the arguments the other way round silently inverts the comparison — and
// it will still return plausible-looking numbers, so nothing will fail loudly.


// ── Parallel worker support: REMOVED ─────────────────────────────────────────
//
// This mirrored the Wegmans worker pool: hidden WebViews loading search URLs,
// an injected extractor reading product cards out of the rendered grid, and a
// WORKER_RESULT per worker. Both pools are gone (2026-09-04) and so are their
// extractors — the note below survives as the record of what was here. Unlike the
// sequential buildExtractProductsScript(), every dispatch is a fresh page load,
// so no stale-tile detection is needed.
//
// Note this path is built but NOT used for ALDI at runtime: forceSerialSearch is
// on because the platform's anti-bot 403s the concurrent burst. See getScripts().

// THE WORKER POOL IS GONE.
//
// It navigated a pool of hidden WebViews to search pages, waited for a results
// grid to render, read product cards out of the DOM by selector, and clicked
// Add. Roughly 110 lines of extractor plus the builder that baked a worker id
// into it, deleted here rather than left standing unreferenced.
//
// What replaced it is aldi-network.ts: the storefront's own GraphQL, with the
// cart as the judge of what landed. Nothing has called a worker since
// 2026-09-01 — this removes the code that was still sitting there.
//
// searchPrefix and menuExclusion STAY. They are not worker code: the first
// builds the search URL the assisted route hands the user, and the second is
// used by the login check.

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
 *   5. Nothing for cart probing: the RAIL reads the cart, and getNetworkRail
 *      dispatches on this registry via isInstacartStore(), so a tenant gets it
 *      for free. (The side-panel script that used to do this was deleted on
 *      2026-09-04; before that it tested for 'aldi' by name, silently giving a
 *      second banner no cart
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
    // THE QUIET PAGE. The rail asks this tenant's own GraphQL endpoint and reads
    // no DOM, so the storefront is pure cost: its bundles share the renderer
    // with our requests, which on Albertsons was measured as a 1-second timer
    // firing 12 seconds late. robots.txt has no JavaScript of its own.
    //
    // Same origin as the store, which is not optional — the session is a cookie
    // on this origin and a rail on another host would have none of it.
    railUrl: (cfg.storeUrl ?? t.origin) + '/robots.txt',
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
    getSearchUrl: (term: string) =>
      searchUrlFor(t.storeId, term, getInstacartSearchUrl(t, term)),
    cacheBustNav: cfg.cacheBustNav ?? t.cacheBustNav ?? false,
  };
}

/** Scripts for a storeId served by this adapter, or null if it isn't one. */
export function getInstacartScriptsFor(storeId: string): StoreScripts | null {
  const t = INSTACART_TENANTS[storeId];
  return t ? getInstacartScripts(t) : null;
}
