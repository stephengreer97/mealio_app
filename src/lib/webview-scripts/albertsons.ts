// Injectable JavaScript strings for Albertsons-family WebView automation.
// All scripts communicate back to React Native via window.ReactNativeWebView.postMessage.
//
// This single file covers ALL Albertsons-platform stores. They share identical
// selectors and behavior — only the domain/URLs differ.
//
// Ported from ~/mealio_ext/content-albertsons-family.js — same verified selectors,
// adapted to the StoreScripts interface used by the store registry.
//
// SELECTORS ARE REMOTE-CONFIGURABLE. The literals below are the fallbacks that
// ship in the binary; the live values come from selectorsFor('albertsons', ...),
// which layers a remote config push on top. When Albertsons renames a button we
// publish a config version instead of shipping a build through App Store review.
//
// Two consequences for anyone editing this file:
//   • Selectors must be read INSIDE a build function, never captured at module
//     load — the remote config arrives after this module is imported.
//   • `sel.x` interpolates a complete JS string literal (quotes included), so
//     write `var ATC_SEL = ${sel.atc};` and never `'${sel.atc}'`.
//
// VERIFIED SELECTORS (confirmed on Albertsons platform 2026-02):
//   Login detection:    span[data-qa="hdr-accnt-nm"]  (text = name OR "Sign in")
//   Search input:       input[type="search"][name="q"]
//   Search open button: button[aria-label="search"]
//   Add to cart button: button[aria-label^="Add 1 unit of"]
//   Collapsed bubble:   button[data-qa="qty-stppr-bbl"]
//   Increment button:   button[data-qa="prdctincrmntr"]
//   Cart URL:           /erums/cart  (ALBERTSONS_CART_PATH)

import type { StoreScripts } from './index';
import { buildExtractWorker } from './worker-search';
import { AUTH_REDIRECT_URL_PATTERN } from './auth-urls';
import { selectorsFor, storeConfig, PlatformId } from '../automation-config';

// Every Albertsons banner runs the same storefront platform, so one selector set
// covers all 15 brands and a single config push fixes them together.
const SELECTOR_KEY = 'albertsons';

// The sharing is now STRUCTURAL, not just conventional: the live selectors come
// from platforms.albertsons in the automation config (MEAL-21), so a push there
// reaches every banner even if someone later gives one its own store entry.
const PLATFORM: PlatformId = 'albertsons';

// Compiled-in fallbacks. Kept in sync with BUNDLED_AUTOMATION_CONFIG's
// platforms.albertsons table so the bundled config and this file can't silently
// disagree.
// Exported for the fixture drift census (MEAL-30) — see the note on heb.ts's copy.
export const SEL_FALLBACKS = {
  atc: 'button[aria-label^="Add 1 unit of"]',
  bubble: 'button[data-qa="qty-stppr-bbl"]',
  increment: 'button[data-qa="prdctincrmntr"]',
  searchOpen: 'button[aria-label="search"]',
  // Login detection is heuristic rather than the documented
  // span[data-qa="hdr-accnt-nm"]: the platform ships several header variants and
  // aria-label matching survives them. Both halves are configurable so a header
  // redesign is a config push.
  profileBtn: 'button[aria-label*="account" i], button[aria-label*="profile" i], a[aria-label*="account" i]',
  headerEls: 'header button, header a, nav button, nav a, [role="banner"] button, [role="banner"] a',
  card: 'li, article, [class*="ProductCard"], [class*="product-card"], [data-qa*="product"]',
};

/** Live selectors as interpolatable JS literals. Call inside a build function. */
const sel = () => selectorsFor(SELECTOR_KEY, SEL_FALLBACKS, PLATFORM);

// ── Domain map ──────────────────────────────────────────────────────────────

const DOMAIN_MAP: Record<string, string> = {
  albertsons:   'albertsons.com',
  safeway:      'safeway.com',
  vons:         'vons.com',
  jewel_osco:   'jewelosco.com',
  shaws:        'shaws.com',
  acme:         'acmemarkets.com',
  tom_thumb:    'tomthumb.com',
  randalls:     'randalls.com',
  pavilions:    'pavilions.com',
  star_market:  'starmarket.com',
  haggen:       'haggen.com',
  carrs:        'carrsqc.com',
  kings:        'kingsfoodmarkets.com',
  balduccis:    'balduccis.com',
  // NOT unitedsupermarkets.com (MEAL-136). That host is the banner's Squarespace
  // MARKETING site: it 301s to https://shopunitedsupermarkets.com **discarding
  // the path**, which then 301s to www, so every URL we built for this banner —
  // /erums/cart, /shop/search-results.html — landed on a marketing home page.
  // No cart, no product tiles, no selectors, and nothing that failed loudly.
  // shopunitedsupermarkets.com is the storefront: /erums/cart and
  // /shop/search-results.html both return 200 off the same istio-envoy platform
  // that serves the other 14 banners. Pinned by tests/unit/webview-scripts/
  // url-builders.test.ts — a path-discarding redirect is invisible at runtime,
  // so the host is only ever as right as the test that names it.
  //
  // The platform agrees, and we already had it on disk: the captured fixture
  // tests/fixtures/albertsons/logged-in-home.html:158 carries the storefront's
  // own `trustedBannerDomains` list, which names shopunitedsupermarkets.com and
  // does NOT name unitedsupermarkets.com.
  united:       'shopunitedsupermarkets.com',
};

export const ALBERTSONS_FAMILY_IDS: string[] = Object.keys(DOMAIN_MAP);

/** The cart's path on every Albertsons banner — a separate Angular app from the
 *  /shop storefront. Platform-uniform (MEAL-15: endpoint paths need no
 *  per-banner configuration; only the host list does). Exported so the cart-page
 *  count script can check it still IS the path it landed on. */
export const ALBERTSONS_CART_PATH = '/erums/cart';

/** Cart page URL for a given Albertsons-family brand.
 *
 *  The `|| 'albertsons.com'` fallback below is UNREACHABLE, and stays only
 *  because unreachable is cheaper than a throw here. It is not, as it might
 *  read, a guard against a stale persisted storeId: every caller gates on
 *  ALBERTSONS_FAMILY_IDS first (cart-count.ts getCartPageUrl, and index.ts
 *  getStoreScripts for the getScripts twin of this fallback), and that list IS
 *  `Object.keys(DOMAIN_MAP)` — so an id that would need the fallback never gets
 *  this far. A stale id gets `null` from those gates and the ordinary
 *  unsupported-store UI, which is the behaviour we want anyway.
 *
 *  Two tests hold the invariant, one for each way it could break, and both live in
 *  tests/unit/webview-scripts/url-builders.test.ts:
 *    • "has a verified cart URL for every banner in the family" — catches a
 *      DOMAIN_MAP row added without a curl-verified host.
 *    • "has scripts for every store the app says runs the WebView engine" —
 *      iterates WEBVIEW_STORE_IDS, the hand-maintained list a new banner actually
 *      gets added to, and catches the opposite mistake: a banner in the app's store
 *      list with no DOMAIN_MAP row, which is what would silently take a fallback.
 *
 *  An earlier version of this note credited tests/unit/generatedScripts.test.ts with
 *  the second invariant. It does not hold it: that file's `STORES` is a hand-written
 *  seven-entry array local to the test, not src/constants/stores.ts, so the app's
 *  real store list was unguarded. Corrected rather than left, because a comment
 *  naming coverage that does not exist is how the next reader gets misled. */
export function getAlbertsonsCartPageUrl(storeId: string): string {
  // Unreachable fallback — see the note above.
  const domain = DOMAIN_MAP[storeId] || 'albertsons.com';
  return `https://www.${domain}${ALBERTSONS_CART_PATH}`;
}

/** Albertsons over-constrains on long queries — a full product title (esp. the
 *  size suffix) returns zero results. Search with the first 5 words only; the
 *  scorer still matches candidates against the full saved name for precision. */
export function albertsonsSearchQuery(name: string): string {
  return (name || '').trim().split(/\s+/).slice(0, 5).join(' ');
}

// ── Login check ─────────────────────────────────────────────────────────────

// Why this check is injected more than once per cart open, and what that costs:
//
// Albertsons bounces the storefront through …/bin/safeway/unified/sso/authorize
// ?code=… and straight back (~5s). Both injection sites re-inject on every page
// load, so without a guard the whole detection runs again on the landing page —
// the ~5s the ticket (MEAL-42) calls "paying it twice".
//
// Three defences, in order of how much they save:
//
//   1. Bail on the interstitial. The authorize page has no site header, so the
//      old script polled the full 3s for an account control, found none, and
//      posted isLoggedIn:false — 3008ms spent to reach a WRONG answer that
//      SilentLoginProbe latches for good. We now post no verdict at all from an
//      auth URL and let the landing page decide.
//   2. sessionStorage cache, consulted ONLY when detection is inconclusive.
//      A run that concluded "logged in" records it; a later injection reads it
//      just when this page has no account control at all (an SSO landing page
//      whose header has not hydrated), where detection would otherwise poll the
//      full 3s and post a wrong isLoggedIn:false.
//
//      It is NOT a fast path ahead of detection, and that placement is the whole
//      point. As an unconditional fast path it produced a stale positive that
//      nothing could clear: after a session expiry or a store-side auth bounce
//      the page comes back signed out, the header plainly reads "Sign In", and
//      the cache still answered true forever. SilentLoginProbe latches, so it
//      never asked again; WebViewCartSheet does NOT latch (it shows the login
//      step on a later LOGIN_STATUS:false), so the login UI simply never
//      appeared and every add failed silently against a signed-out session.
//      Live detection now always wins when it can see the header; the cache only
//      breaks ties. Cost of that ordering, measured on logged-in-home.html:
//      ~20-30ms of passive detection, versus the ~1ms cache read. The ~5s the
//      cache was credited with was the interstitial's dead poll, and defence 1
//      already removes that.
//
//      'out' is still never written (caching it would defeat
//      reinjectLoginCheckOnNav, the mechanism by which we notice the user
//      finishing a sign-in) — but a negative verdict now REMOVES any cached
//      positive, so a contradicted 'in' cannot outlive the run that disproved it.
//   3. __albLoginPosted latch. Terminal, unlike __albLoginCheckActive (which is
//      cleared before the background poll starts). Without it, a same-context
//      re-injection both re-runs the detection and stacks a second 3-minute
//      LOGIN_COMPLETE poll on top of the first.
//
// WHY window.AB.userInfo.SWY_SHOP_TOKEN IS NOT THE LOGIN SIGNAL (MEAL-124).
//
// The MEAL-15 spike (docs/albertsons-network-rail-feasibility.md) found the
// session bearer sitting on a page global — window.AB.userInfo.SWY_SHOP_TOKEN,
// which Albertsons' own chat-widget code labels okta_token — and proposed it as
// the passive login marker this check wants. It reads strictly better than a
// markup heuristic: a positive fact about the session rather than an inference
// from DOM that exists in both states. It is still not wired into the decision,
// for three reasons, in descending order of how much they matter:
//
//   1. It would not fix this bug. window.AB.userInfo is populated by the AEM/
//      Angular bootstrap at runtime — nothing in the committed logged-in capture
//      defines it — so pre-hydration the property is simply absent, which is
//      exactly the window MEAL-124 is about. Absent has to fall back to
//      something: to the DOM (so the DOM heuristic still decides the racy case,
//      and nothing is fixed) or to signed-out (a login wall for a signed-in user
//      every time we inject early). It moves the race, it does not remove it.
//   2. We had never observed it populated, and now we have — but not the part
//      that matters here. UPDATED 2026-08-11 (MEAL-137): the logged-in probe was
//      run, and on a settled signed-in safeway.com tab the property IS non-empty.
//      An in-page fetch reading it reached the cart service's application layer
//      (a 400, where every bogus bearer got a 403), so the value is a credential
//      the origin treats as real. Note the separate add-to-cart that returned 200
//      in that session replayed a bearer CAPTURED from the site's own request —
//      nobody has yet compared the two values byte for byte. What is
//      still unobserved is everything this check actually turns on: the value
//      DURING the hydration window (nobody has captured the immediate-vs-delayed
//      read), what it holds for a guest (initSearchConfig ships
//      userInfoSkipIfGuest:true, so plausibly an empty value rather than an
//      absent one), the format of tokenExpiration, so we still cannot bound
//      staleness — and none of it inside OUR WebView, which is the only place
//      this code runs. One thing the probe did add: the token lives 45 minutes,
//      so "present" and "usable" are not the same property.
//      See docs/albertsons-network-rail-feasibility.md, "What the real token
//      turned out to say".
//   3. It is unexercisable here. Fixture tests load static HTML with scripts
//      blocked, so window.AB never exists — the token path would ship with no
//      coverage at all while the covered path went unused.
//
// So the fix is the empty-span case itself (see acctIsMenu below), and the token
// is recorded as a presence-only diagnostic in the passive_decision debug
// payload. When someone runs the app on a real signed-in Albertsons session and
// the log shows hasToken:true alongside a rendered name, points 1 and 2 are
// answerable and promoting it to a cross-check — a second signal that must AGREE
// before we say logged in, never one that can say it alone — becomes a small,
// evidenced change. MEAL-137 moved that closer without reaching it: the token is
// now known to be readable in a browser tab, but this diagnostic is still the
// only thing that can show it inside our WebView, in the window we care about.
// tests/fixture-tests/albertsons.spec.ts pins the refusal so it cannot be
// reversed by accident.
function buildCheckLoginScript(domain: string): string {
  const s = sel();
  return `(async function() {
  // Terminal latch — survives re-injection within this JS context. A page
  // reload clears it (that's intended: post-login re-checks must run fresh).
  if (window.__albLoginPosted) return;
  if (window.__albLoginCheckActive) return;

  // Never speak from an intermediate auth/SSO page. Kept in sync with the
  // native-side skip in WebViewCartSheet/SilentLoginProbe via auth-urls.ts.
  if (new RegExp(${JSON.stringify(AUTH_REDIRECT_URL_PATTERN)}).test(window.location.href)) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'skip_auth_redirect', url: window.location.href }));
    return;
  }

  window.__albLoginCheckActive = true;

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // The single terminal exit. Declared OUTSIDE the try so the catch below can
  // call it without relying on Annex B block-function hoisting. Writes the cache
  // BEFORE postMessage so that if the SSO bounce navigates away before RN
  // receives the message, the next injection still has the answer.
  //
  // A negative CLEARS the cached positive rather than writing 'out'. Writing
  // 'out' would defeat reinjectLoginCheckOnNav; leaving a stale 'in' in place
  // would let a verdict we have just disproved answer for the rest of the
  // WebView's life.
  function postStatus(isLoggedIn, error) {
    if (window.__albLoginPosted) return;
    window.__albLoginPosted = true;
    window.__albLoginCheckActive = false;
    try {
      if (isLoggedIn) {
        sessionStorage.setItem('mealio_albertsons_login_state', 'in');
      } else {
        sessionStorage.removeItem('mealio_albertsons_login_state');
      }
    } catch(_) {}
    var payload = { type: 'LOGIN_STATUS', isLoggedIn: isLoggedIn };
    if (error) payload.error = error;
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }

  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'start', url: window.location.href }));

    // NOTE: the sessionStorage read used to sit HERE, ahead of detection. It is
    // now in the !profileBtn branch below. See the header comment: as a fast
    // path it answered "logged in" against a header that read "Sign In", and no
    // re-scan could ever correct it. Do not move it back up.

    // The account control's rendered NAME, which is the only part of it that
    // differs between auth states. aria-label is deliberately excluded: it is
    // static markup ("Account menu") that reads the same signed in or out.
    function acctNameOf(el) {
      return el ? (el.textContent || '').trim() : '';
    }

    // Has that span RESOLVED to one of its two real states, or is it still a
    // loading placeholder? (MEAL-140.)
    //
    // MEAL-124 made the positive verdict require a non-empty name. Non-empty is
    // too weak, because the regex it gates runs against aria-label + text, and
    // aria-label="Account menu" is static markup present in BOTH auth states —
    // so the text only had to contain SOME character. A skeleton placeholder
    // ("...", "—", a spinner glyph, "Loading") produced "Account menu Loading",
    // matched /account\\s*menu/, and resolved to loggedIn. Same window as
    // MEAL-124, one step narrower: empty was closed, meaningless was not.
    //
    // The rule, in two clauses, because placeholders come in two kinds:
    //
    //   1. TYPOGRAPHIC — "...", "…", "-", "—", "•", "*", braille/dot spinners,
    //      a bare digit. Their defining property is that they carry no lexical
    //      content at all, so: require a LETTER. \\p{L} rather than [a-z],
    //      because a name in Cyrillic or CJK is a name.
    //   2. LEXICAL — "Loading", "Loading...", "Please wait". These are made of
    //      letters, so clause 1 cannot see them and they have to be named. This
    //      list is NOT exhaustive and cannot be: no test separates a name from
    //      a word in general. It covers the placeholder vocabulary a header
    //      actually uses; clause 1 covers everything without words in it.
    //
    // ONE letter, not two, and the threshold is deliberate rather than
    // arbitrary. Every typographic placeholder above has ZERO letters — that is
    // what makes it typographic — so a second letter rejects nothing extra in
    // the class this exists to catch, while it does reject a header that renders
    // a bare initial ("J") or a single-glyph name. Raising it would be paying a
    // click, for those users, on every run, to buy nothing. The boundary that
    // matters is 0 vs ≥1 and that is the one the tests pin.
    //
    // "Sign in" passes this — deliberately. This predicate answers "has the
    // span settled", not "is this a name". A settled "Sign in" is a DEFINITE
    // state, and the caller reads acctIsSignIn before acctIsMenu, so settling
    // is exactly when both the poll and the decision should act on it. (Which
    // is also why "signing in" is absent from the word list below: SIGNIN_RE
    // matches it — "signin" is a substring of "signing" — so it decides
    // loggedOut before ever reaching here, and listing it would claim coverage
    // of a branch that cannot run.)
    //
    // WHAT IT COSTS WHEN IT IS WRONG, which is the whole reason it is shaped
    // this way. A false negative falls through to the click check, which opens
    // the panel, finds "Sign Out", and answers loggedIn — the right answer, at a
    // cost of up to ~4.5s: the poll below spends its full 3s budget first,
    // because acctTextResolved never returns true, and only then does the panel
    // wait add up to 1.5s. Measured: placeholder cases 3.8-4.9s against 0.5s for
    // a genuine name. An earlier version of this comment said "one click and up
    // to 1.5s", counting only the second half. A false positive is a wrong verdict the entire run
    // then acts on. The two directions are not comparable, so where there is
    // any doubt this returns false — e.g. a real user literally named "Loading"
    // takes the click check and still gets the right answer.
    //
    // Rejected alternative: requiring the text to hold STEADY across two polls.
    // It does not separate the cases — a placeholder that persists because auth
    // never resolves is just as steady as a name — and it would put 200ms on
    // the passive path for every signed-in user to buy nothing.
    function acctTextResolved(t) {
      var s = (t || '').replace(/\\s+/g, ' ').trim();
      if (!s) return false;
      if (!/\\p{L}/u.test(s)) return false;
      // Leading non-letters stripped before the word test, because the two clauses
      // do not partition the space the way the comment above first claimed. A
      // spinner glyph in FRONT of the word — a braille dot, a bullet — is
      // covered by neither: clause 1 sees the letters in "Loading" and passes it,
      // and an anchored clause 2 never reaches the word. Cold review drove both
      // through the real script and got a passive loggedIn in ~500ms, which is
      // the original defect intact.
      //
      // A leading run of non-letters is exactly the shape of a spinner, a bullet
      // or an ellipsis, so dropping it costs nothing a real name would miss —
      // a name does not begin with punctuation. Measured against ~60 strings:
      // O'Brien, -Ann, .Stephen, RLM/LRM-prefixed Arabic and Hebrew, Cyrillic,
      // CJK, Devanagari, Thai and a bare initial all still resolve.
      //
      // What it does NOT close, stated so the next reader does not rediscover it:
      // a LETTER-bearing prefix still defeats the anchor. "Hi, Loading" and
      // "Welcome, Loading" resolve true and decide loggedIn passively. Not idle
      // — the span carries class user-greeting, and acctIsMenu's own regex
      // already lists hi[, ] and welcome, so the code anticipates greeting
      // content here. Not evidenced on any committed capture, so latent rather
      // than live, and the honest reason it is unfixed is that stripping words
      // is where a blacklist over page text stops being defensible.
      var word = s.replace(/^[^\\p{L}]+/u, '');
      if (/^(loading|please wait|one moment|updating|fetching)\\b/i.test(word)) return false;
      return true;
    }

    // Poll for the profile button (up to 3s, usually < 1s).
    //
    // MEAL-124: the loop used to stop the moment the ELEMENT existed. That is
    // the bug — the element is present pre-hydration, and the decision below
    // then matched a static aria-label and answered "logged in" in single-digit
    // milliseconds with no user in sight. Keep polling, within the same 3s
    // budget, until the name inside it has actually rendered. A name that never
    // arrives is not treated as a name: it falls through to the click check.
    //
    // MEAL-140: "has rendered" is acctTextResolved, not "is non-empty" — the
    // same predicate the decision below uses. That matters in both directions.
    // Stopping on non-empty made a placeholder look READY, so the loop handed
    // the decision a settled-looking span 200ms in and reported nameReady:true
    // in the log; now a placeholder spends the full 3s budget waiting for the
    // real text, and if it never comes, nameReady stays false and the verdict
    // falls through to the click check on its own.
    var profileBtn = null;
    var acctNameReady = false;
    for (var pi = 0; pi < 15; pi++) {
      var candidates = document.querySelectorAll(${s.profileBtn});
      for (var ci = 0; ci < candidates.length; ci++) {
        var aria = (candidates[ci].getAttribute('aria-label') || '').toLowerCase();
        if (!aria.includes('close')) { profileBtn = candidates[ci]; break; }
      }
      if (profileBtn && acctTextResolved(acctNameOf(profileBtn))) { acctNameReady = true; break; }
      await wait(200);
    }
    if (!profileBtn) {
      var headerEls = Array.from(document.querySelectorAll(${s.headerEls}));
      for (var hi = 0; hi < headerEls.length; hi++) {
        var el = headerEls[hi];
        var aria = (el.getAttribute('aria-label') || '').toLowerCase();
        var txt = (el.textContent || '').trim().toLowerCase();
        if (aria.includes('close')) continue;
        if (aria.includes('account') || aria.includes('profile') || txt === 'sign in' || txt === 'account') {
          profileBtn = el;
          break;
        }
      }
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'profile_btn',
      found: !!profileBtn,
      nameReady: acctNameReady,
      ariaLabel: profileBtn ? profileBtn.getAttribute('aria-label') : null,
      text: profileBtn ? profileBtn.textContent.trim().slice(0, 40) : null
    }));

    // NOTE: a 'passive_markers' diagnostic used to sit here — it dumped cookie
    // names, every localStorage key, and document.body.innerText.slice(0, 4000)
    // on EVERY run. It existed to hunt for the passive marker that the decision
    // below now uses, so it was pure instrumentation left on the hot path, and
    // the innerText read forces a full layout flush of a ~1.5MB homepage DOM
    // before we're allowed to answer. Removed. If you need it again, put it
    // behind a debug flag rather than back on the critical path.

    if (!profileBtn) {
      // Detection is INCONCLUSIVE — three seconds of polling and this page has
      // no account control at all. That is the SSO landing page before its
      // header hydrates. Only here do we defer to what an earlier injection in
      // this session concluded, because the alternative is posting a false that
      // SilentLoginProbe latches for good. A header we CAN read always wins over
      // the cache; a header we cannot read is the one case where the cache is
      // better evidence than anything on this page.
      try {
        if (sessionStorage.getItem('mealio_albertsons_login_state') === 'in') {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'passive_decision', decided: 'loggedIn', via: 'sessionStorage' }));
          postStatus(true);
          return;
        }
      } catch(_) {}
      postStatus(false);
      return;
    }

    // ── Passive determination (no click) ──────────────────────────────────
    // Logged-out state is universal: the account/header control is a sign-in
    // CTA. So: a sign-in CTA present → logged out; an account control present
    // with NO sign-in CTA anywhere in the header → logged in. Anything
    // ambiguous falls through to the click check below. No user-specific text.
    //
    // WHAT THIS RULE ACTUALLY DECIDES ON, and where it is thin:
    //
    //   • acctIsSignIn is evaluated before acctIsMenu, and it reads the SAME
    //     span the logged-in case reads. Albertsons reuses one span for both
    //     states — in logged-in-home.html span[data-qa="hdr-accnt-nm"] holds the
    //     user's name while still carrying the class
    //     'menu-nav__profile-button-sign-in-up dst-sign-in-up'. Set that span's
    //     text to "Sign in" and this rule decides loggedOut, correctly. So the
    //     signed-out half is NOT unevidenced — it is one span away from the
    //     capture we have, and tests/fixture-tests/albertsons.spec.ts asserts it.
    //
    //   • The reachable risk was NOT the signed-out state. It was any state where
    //     that span is EMPTY, because nothing waited for it. The poll waited for
    //     the ELEMENT; acctIsMenu then matched on aria-label="Account menu",
    //     which is static markup present regardless of auth state. Pre-hydration,
    //     mid-render, or a slow auth bootstrap therefore reached 'loggedIn' in
    //     single-digit ms with no user in sight. FIXED in MEAL-124, two ways: the
    //     poll now waits for the name to render (same 3s budget), and acctIsMenu
    //     requires a non-empty name. An empty name reaches the click check, which
    //     resolves to signed OUT when it finds no "sign out" — the direction that
    //     shows a login wall rather than failing every add in silence.
    //
    //     MEAL-140 closed the rest of that window. "Non-empty" was the wrong
    //     standard: the regex it gated matches the static aria-label on its own,
    //     so the text only had to contain SOME character, and a skeleton
    //     placeholder ("...", a spinner glyph, "Loading") read as a signed-in
    //     user just as an empty span had. Both the poll and the decision now use
    //     acctTextResolved — text that has SETTLED, letters and not a loading
    //     word — so an unsettled span spends the full budget and then takes the
    //     same click-check path an empty one does. See acctTextResolved for why
    //     it is deliberately quick to say "not settled".
    //
    //   • headerSignIn is the only independent second signal, and it is weaker
    //     than it looks: on the real capture Albertsons ships NO <header>, <nav>
    //     or [role="banner"] at all — the account control lives in a
    //     <div role="navigation" aria-label="Account and Cart">. The selector
    //     below therefore includes [role="navigation"]; without it the branch
    //     matched zero elements and was pure decoration. It is deliberately NOT
    //     widened to the whole document: logged-in-home.html contains nine
    //     sign-in/create-account controls inside hidden dialogs (#menu,
    //     #signin-dropdown, the <sign-in> form component), so a document-wide
    //     scan would post loggedOut for a signed-in user.
    try {
      var SIGNIN_RE = /sign\\s?in|log\\s?in|sign\\s?up|create account/i;
      var acctText = acctNameOf(profileBtn);
      var acctName = ((profileBtn.getAttribute('aria-label') || '') + ' ' + acctText).trim();
      var headerSignIn = Array.prototype.slice
        .call(document.querySelectorAll('header a, header button, nav a, nav button, [role="banner"] a, [role="banner"] button, [role="navigation"] a, [role="navigation"] button'))
        .some(function(el) {
          var n = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
          return SIGNIN_RE.test(n);
        });
      var acctIsSignIn = SIGNIN_RE.test(acctName);
      // The regex half of this is satisfied by aria-label ALONE — "Account menu"
      // is in the raw markup signed in or out — so it carries no information
      // about auth state and the whole verdict rests on the conjunct in front
      // of it. That conjunct is therefore the rule, and the regex is only
      // "is this an account control rather than something else in the header".
      //
      // MEAL-124 made the conjunct !!acctText: an empty name is no evidence,
      // so it must not decide. MEAL-140: neither is a non-empty MEANINGLESS
      // name. !!acctText accepted "..." or "Loading" as the per-state
      // evidence this rule has none of otherwise, and answered loggedIn off a
      // skeleton. acctTextResolved is the same conjunct with the standard
      // raised from "some character" to "text that has actually settled" —
      // see its definition for what that means and what it costs when wrong.
      var acctResolved = acctTextResolved(acctText);
      var acctIsMenu = acctResolved && /account\\s*menu|my\\s*account|account & lists|hi[, ]|welcome/i.test(acctName);
      if (acctIsSignIn || headerSignIn) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'passive_decision', decided: 'loggedOut', acctName: acctName.slice(0, 60) }));
        postStatus(false);
        for (var __pp = 0; __pp < 90; __pp++) {
          await wait(2000);
          var __pt = document.body.innerText.slice(0, 8000).toLowerCase();
          if (__pt.includes('sign out') || __pt.includes('log out')) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_COMPLETE' }));
            return;
          }
        }
        return;
      }
      if (acctIsMenu) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_DEBUG', step: 'passive_decision', decided: 'loggedIn', acctName: acctName.slice(0, 60) }));
        postStatus(true);
        return;
      }
      // else: ambiguous → click check below. Three labels, not one, because
      // these are three different things and a log that conflates them cannot
      // tell a rule that is thin from a header that has moved:
      //   • empty       — MEAL-124: everything rendered except the one thing
      //                   that distinguishes the two states.
      //   • unresolved  — MEAL-140: that thing rendered, but as a placeholder.
      //                   Distinct from empty because it means the span exists
      //                   and is being written to; the auth bootstrap is just
      //                   slower than our 3s. It is also the label that says
      //                   acctTextResolved rejected something, so a placeholder
      //                   vocabulary we have not seen shows up here by name.
      //   • click       — a settled name that simply matched no known pattern.
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'LOGIN_DEBUG', step: 'passive_decision',
        decided: !acctText
          ? 'ambiguous_empty_acct_name'
          : (acctResolved ? 'ambiguous_click_fallback' : 'ambiguous_unresolved_acct_name'),
        acctName: acctName.slice(0, 60),
        acctText: acctText.slice(0, 60),
        nameReady: acctNameReady,
        // MEAL-15 found window.AB.userInfo.SWY_SHOP_TOKEN — the session bearer,
        // which Albertsons' own chat code labels okta_token — and proposed it as
        // the passive login marker this rule wants. It is NOT wired into the
        // decision, deliberately: see the note above buildCheckLoginScript. This
        // records only its PRESENCE (never its value — it is a live bearer) from
        // real sessions, so the observation MEAL-15 is missing can come off a
        // device log instead of a hand-run DevTools probe. Bounded: property
        // reads only, no DOM, no enumeration, no layout flush.
        sessionMarker: (function() {
          try {
            var ui = window.AB && window.AB.userInfo;
            if (!ui) return { hasAB: false };
            var t = ui.SWY_SHOP_TOKEN;
            return { hasAB: true, hasToken: !!t, tokenLen: t ? String(t).length : 0, tokenExpiration: ui.tokenExpiration || null };
          } catch (_) { return { hasAB: false, threw: true }; }
        })(),
      }));
    } catch (e) {}

    // Click the profile icon. Two outcomes:
    // Logged in: side panel opens with "Sign Out" option
    // Not logged in: sign-in form/page appears
    profileBtn.click();

    // Wait for the flyout on the panel's own schedule instead of a flat 1500ms.
    // Identical terminal condition ("sign out"/"log out" in body text) — we just
    // stop asking the moment it's true, which is typically the first or second
    // tick. Still gives up at 1500ms, so a panel that never renders behaves
    // exactly as before. 250ms steps rather than something tighter because each
    // read is an innerText call, and innerText flushes layout on a very large
    // DOM; 6 reads is the point where polling stays cheaper than the wait it
    // replaces.
    var isLoggedIn = false;
    var panelTicks = 0;
    for (var wi = 0; wi < 6; wi++) {
      await wait(250);
      panelTicks++;
      var bodyText = document.body.innerText.slice(0, 8000).toLowerCase();
      if (bodyText.includes('sign out') || bodyText.includes('log out')) { isLoggedIn = true; break; }
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'LOGIN_DEBUG', step: 'after_click',
      isLoggedIn: isLoggedIn, waitedMs: panelTicks * 250
    }));

    if (isLoggedIn) {
      // Answer FIRST, then tidy up: closing the panel is housekeeping for the
      // search that follows, and the caller shouldn't wait 300ms to hear it.
      postStatus(true);
      document.body.click();
      return;
    }

    // Not logged in — post status so the webview becomes visible,
    // then poll in the background for login completion.
    postStatus(false);

    // Background poll: check every 2s for up to 3 minutes.
    // When user completes login, the page updates and "sign out" appears.
    for (var pi = 0; pi < 90; pi++) {
      await wait(2000);
      var pollText = document.body.innerText.slice(0, 8000).toLowerCase();
      if (pollText.includes('sign out') || pollText.includes('log out')) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'LOGIN_COMPLETE' }));
        return;
      }
    }
  } catch(e) {
    window.__albLoginCheckActive = false;
    postStatus(false, String(e));
  }
})();true;`;
}

// ── Product extraction ──────────────────────────────────────────────────────

function buildExtractProductsScript(): string {
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', __noKbd, true);

  // Only extract from a real search-results page. Albertsons returns nothing for
  // long queries and can bounce to the homepage / show a "recommended / buy it
  // again" carousel — those tiles have Add buttons too and would otherwise be
  // scraped as bogus, irrelevant suggestions.
  if (location.href.indexOf('search-results') === -1) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  var ATC_SEL = ${s.atc};

  // Poll for ATC buttons, then wait for the result grid to SETTLE — the button
  // count must hold steady across 2 consecutive checks (300ms apart) before we
  // extract. Under concurrent load (parallel add) the grid paints its first card
  // early but keeps hydrating; extracting on first sight grabbed a partial set
  // and mis-scored every item as low-confidence. Up to ~9s (30 * 300ms).
  var btns = [];
  var lastCount = -1, stableStreak = 0;
  for (var poll = 0; poll < 30; poll++) {
    btns = Array.from(document.querySelectorAll(ATC_SEL));
    if (btns.length > 0 && btns.length === lastCount) {
      if (++stableStreak >= 2) break;
    } else {
      stableStreak = btns.length > 0 ? 1 : 0;
    }
    lastCount = btns.length;
    await wait(300);
  }

  if (btns.length === 0) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: [] }));
    return;
  }

  // Helper: walk up from an element to find the product card container.
  // Albertsons wraps each product in a parent that contains the image, price, and ATC button.
  function findCard(el) {
    var node = el.parentElement;
    for (var depth = 0; depth < 8 && node; depth++) {
      // A card should have an img and some text content beyond just the button.
      if (node.querySelector('img') && node.textContent.length > 50) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Helper: extract price from a card element.
  function extractPrice(card) {
    if (!card) return null;
    // Try specific selectors first.
    var priceEl = card.querySelector('[class*="price" i], [data-qa*="price" i]');
    if (priceEl) {
      var m = priceEl.textContent.match(/\\$[\\d]+\\.\\d{2}/);
      if (m) return m[0];
    }
    // Fallback: find first $X.XX pattern in the card's text.
    var cardText = card.textContent || '';
    var m2 = cardText.match(/\\$[\\d]+\\.\\d{2}/);
    return m2 ? m2[0] : null;
  }

  var seen = new Set();
  var candidates = [];

  for (var bi = 0; bi < btns.length && bi < 20; bi++) {
    var btn = btns[bi];
    var ariaLabel = btn.getAttribute('aria-label') || '';
    var nameMatch = ariaLabel.match(/^Add 1 unit of (.+)/i);
    if (!nameMatch) continue;
    var name = nameMatch[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var outOfStock = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    var card = findCard(btn);
    var imageUrl = null;
    var price = null;

    if (card) {
      var imgEl = card.querySelector('img');
      imageUrl = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || null) : null;
      price = extractPrice(card);
    }

    candidates.push({ productName: name, imageUrl: imageUrl, outOfStock: outOfStock, preferences: null, price: price });
    if (candidates.length >= 8) break;
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_RESULT', candidates: candidates }));
})();true;`;
}

// ── Add to cart ──────────────────────────────────────────────────────────────

function buildAddToCartScript(
  productName: string,
  _preference: { text: string } | null,
  qty: number,
): string {
  var escapedName = JSON.stringify(productName);
  const s = sel();

  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var TARGET_NAME = ${escapedName};
  var QTY = ${qty};
  var ATC_SEL = ${s.atc};
  var BUBBLE_SEL = ${s.bubble};
  var INCREMENT_SEL = ${s.increment};

  function normalizeForScoring(s) {
    return s.toLowerCase().replace(/[^\\w\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
  }

  function scoreProductName(foundName, targetName) {
    var found = normalizeForScoring(foundName);
    var target = normalizeForScoring(targetName);
    if (found === target) return 100;
    var targetWords = target.split(' ').filter(Boolean);
    var foundWords = found.split(' ').filter(Boolean);
    var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
    var matchPct = matchCount / targetWords.length;
    if (matchPct < 0.7) return -1;
    var extraCount = foundWords.filter(function(w) { return targetWords.indexOf(w) === -1; }).length;
    return Math.round(matchPct * 100) - (extraCount * 10);
  }

  // Find the collapsed bubble button for a product already in cart.
  function findBubbleForProduct(productName) {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allBubbles.length; i++) {
      var btn = allBubbles[i];
      var al = btn.getAttribute('aria-label') || '';
      var extracted = null;
      var m1 = al.match(/collapsed[,:]?\\s*\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)\\s+in\\s+cart/i);
      if (m1) { extracted = m1[1]; }
      else {
        var m2 = al.match(/\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)(?:\\s+in\\s+cart|\\s*\\.|$)/i);
        if (m2) extracted = m2[1];
      }
      if (!extracted) continue;
      var cleaned = extracted
        .replace(/,?\\s*\\$[\\d.,]+\\s*(per\\s+\\w+|each|\\/\\s*\\w+)\\b.*/i, '')
        .replace(/,?\\s*\\d+\\s+for\\s+\\$[\\d.,]+.*/i, '')
        .trim();
      var score = -1;
      if (/\\.{3}|\\u2026/.test(cleaned)) {
        // Truncated label, e.g. "Lucerne Heavy Whipping Cream -...(packaging may
        // vary)". Score on the words shown BEFORE the ellipsis against the target;
        // trailing noise after "..." (like "(packaging may vary)") is never in the
        // real product name, so requiring it to match would wrongly reject the bubble.
        // Middle-truncation "prefix...suffix" — the store cuts the title in the
        // middle (e.g. "PERDUE SIMPLY SMART ORGANIC Gl...east Tenders - 22 Oz").
        // Anchor BOTH ends to the target deterministically instead of word-
        // scoring the fragment: the target must start with the prefix and end
        // with the suffix. (Prefix-only truncation with trailing packaging noise
        // — "…Cream -...(packaging may vary)" — matches on the prefix alone.)
        var __parts = cleaned.split(/\\.{3}|\\u2026/);
        var __pre = normalizeForScoring(__parts[0]);
        var __suf = normalizeForScoring(__parts[__parts.length - 1]);
        var __t = normalizeForScoring(productName);
        var __preOk = __pre.length >= 3 && __t.indexOf(__pre) === 0;
        var __sufOk = __suf.length >= 3 && __t.length >= __suf.length && __t.lastIndexOf(__suf) === __t.length - __suf.length;
        if (__preOk && __sufOk) score = 100;
        else if (__preOk && (__suf.length < 3 || __t.indexOf(__suf) === -1)) score = 95;
        else score = -1;
      } else {
        var targetWords = normalizeForScoring(productName).split(' ').filter(Boolean);
        var foundWords = normalizeForScoring(cleaned).split(' ').filter(Boolean);
        var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
        var matchPct = matchCount / targetWords.length;
        score = matchPct < 0.7 ? -1 : Math.round(matchPct * 100);
      }
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    return best;
  }

  // Find the expanded increment button for a product.
  function findIncrementForProduct(productName) {
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allInc.length; i++) {
      var btn = allInc[i];
      var al = btn.getAttribute('aria-label') || '';
      var m = al.match(/^Increase Quantity \\d+ unit[^\\s]* of (.+)/i);
      if (!m) continue;
      var score = scoreProductName(m[1], productName);
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    if (!best && allInc.length === 1) return allInc[0];
    return best;
  }

  // Poll for the increment button with re-expand support.
  function pollForIncrement(productName) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      var POLL_MS = 150;
      var MAX_MS = 5000;
      function tick() {
        if (elapsed >= MAX_MS) { resolve(null); return; }
        var incBtn = findIncrementForProduct(productName);
        if (incBtn) { resolve(incBtn); return; }
        var bubble = findBubbleForProduct(productName);
        if (bubble) {
          bubble.scrollIntoView({ behavior: 'instant', block: 'center' });
          bubble.click();
        }
        elapsed += POLL_MS;
        setTimeout(tick, POLL_MS);
      }
      tick();
    });
  }

  // Read current cart qty from bubble/increment aria-labels.
  function getCartQty() {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    for (var i = 0; i < allBubbles.length; i++) {
      var al = allBubbles[i].getAttribute('aria-label') || '';
      var qm = al.match(/(\\d+)\\s*unit/i);
      if (qm) return parseInt(qm[1], 10);
    }
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    for (var i = 0; i < allInc.length; i++) {
      var al = allInc[i].getAttribute('aria-label') || '';
      var qm = al.match(/Quantity\\s+(\\d+)/i);
      if (qm) return parseInt(qm[1], 10);
    }
    return 0;
  }

  // Poll until cart qty increases (up to 5s).
  function waitForQtyChange(prevQty) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        if (elapsed >= 5000) { resolve(false); return; }
        var current = getCartQty();
        if (current > prevQty) { resolve(true); return; }
        elapsed += 200;
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  // The header cart-count badge reflects the REAL (server) cart, unlike the
  // product tile's optimistic bubble — so it only ticks up when an item
  // actually commits. Returns null when the badge can't be read (then callers
  // fall back to the tile bubble). Empty text = 0 (empty cart).
  function getHeaderCartCount() {
    var el = document.querySelector('[data-qa="hdr-crt-txt-plus"]');
    if (!el) return null;
    var t = (el.textContent || '').trim();
    if (t === '') return 0;
    var m = t.match(/\\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  // Confirm an add by the header cart count incrementing (authoritative). Falls
  // back to the tile qty bubble only when the header count isn't readable, so a
  // store/page without the badge still works. Polls up to ~7s.
  function waitForCartConfirm(headerBefore, tileBefore) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        var hc = getHeaderCartCount();
        if (headerBefore != null && hc != null && hc > headerBefore) { resolve(true); return; }
        if (headerBefore == null && getCartQty() > tileBefore) { resolve(true); return; }
        if (elapsed >= 7000) { resolve(false); return; }
        elapsed += 250;
        setTimeout(tick, 250);
      }
      tick();
    });
  }

  // Poll for ATC buttons to appear (up to 6s).
  var allAtcBtns = [];
  for (var poll = 0; poll < 20; poll++) {
    allAtcBtns = Array.from(document.querySelectorAll(ATC_SEL));
    if (allAtcBtns.length > 0) break;
    await wait(300);
  }
  var bestAtcBtn = null, bestAtcScore = -1;
  for (var i = 0; i < allAtcBtns.length; i++) {
    var btn = allAtcBtns[i];
    var al = btn.getAttribute('aria-label') || '';
    var m = al.match(/^Add 1 unit of (.+)/i);
    if (!m) continue;
    var score = scoreProductName(m[1], TARGET_NAME);
    if (score > bestAtcScore && score >= 100) { bestAtcScore = score; bestAtcBtn = btn; }
    if (bestAtcScore === 100) break;
  }

  // Check for pre-existing qty (product already in cart)
  var preExistingBubble = findBubbleForProduct(TARGET_NAME);
  var preExistingIncrement = !preExistingBubble ? findIncrementForProduct(TARGET_NAME) : null;

  // Poll if nothing found yet
  if (!preExistingBubble && !preExistingIncrement && !bestAtcBtn) {
    for (var attempt = 0; attempt < 8 && !preExistingBubble && !preExistingIncrement && !bestAtcBtn; attempt++) {
      await wait(500);
      var freshBtns = Array.from(document.querySelectorAll(ATC_SEL));
      for (var fi = 0; fi < freshBtns.length; fi++) {
        var fal = freshBtns[fi].getAttribute('aria-label') || '';
        var fm = fal.match(/^Add 1 unit of (.+)/i);
        if (!fm) continue;
        var fs = scoreProductName(fm[1], TARGET_NAME);
        if (fs > bestAtcScore && fs >= 100) { bestAtcScore = fs; bestAtcBtn = freshBtns[fi]; }
        if (bestAtcScore === 100) break;
      }
      preExistingBubble = findBubbleForProduct(TARGET_NAME);
      preExistingIncrement = !preExistingBubble ? findIncrementForProduct(TARGET_NAME) : null;
    }
  }

  // If ATC found but no bubble yet, wait for cart state overlay
  if (bestAtcBtn && !preExistingBubble && !preExistingIncrement) {
    for (var wa = 0; wa < 3 && !preExistingBubble && !preExistingIncrement; wa++) {
      await wait(400);
      preExistingBubble = findBubbleForProduct(TARGET_NAME);
      preExistingIncrement = !preExistingBubble ? findIncrementForProduct(TARGET_NAME) : null;
    }
  }

  var usePreExisting = !!(preExistingBubble || preExistingIncrement);
  var stepperAlreadyOpen = !!preExistingIncrement && !preExistingBubble;

  if (!usePreExisting && !bestAtcBtn) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ADD_RESULT', success: false, reason: 'not_found' }));
    return;
  }

  var actuallyClicked = 0;

  if (usePreExisting) {
    if (stepperAlreadyOpen) {
      for (var i = 0; i < QTY; i++) {
        var qtyBefore = getCartQty();
        var headerBefore = getHeaderCartCount();
        var incBtn = i === 0 ? preExistingIncrement : await pollForIncrement(TARGET_NAME);
        if (!incBtn) break;
        incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        incBtn.click();
        var confirmed = await waitForCartConfirm(headerBefore, qtyBefore);
        if (confirmed) actuallyClicked++;
      }
    } else {
      preExistingBubble.scrollIntoView({ behavior: 'instant', block: 'center' });
      preExistingBubble.click();
      await wait(600);
      for (var i = 0; i < QTY; i++) {
        var qtyBefore = getCartQty();
        var headerBefore = getHeaderCartCount();
        var incBtn = await pollForIncrement(TARGET_NAME);
        if (!incBtn) break;
        incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        incBtn.click();
        var confirmed = await waitForCartConfirm(headerBefore, qtyBefore);
        if (confirmed) actuallyClicked++;
      }
    }
  } else {
    // Normal path: ATC adds first unit, increment handles the rest.
    for (var i = 0; i < QTY; i++) {
      var qtyBefore = getCartQty();
      var headerBefore = getHeaderCartCount();
      var buttonToClick;
      if (i === 0) {
        buttonToClick = bestAtcBtn;
      } else {
        buttonToClick = await pollForIncrement(TARGET_NAME);
        if (!buttonToClick) {
          var freshAtc = Array.from(document.querySelectorAll(ATC_SEL));
          for (var fa = 0; fa < freshAtc.length; fa++) {
            var faLabel = freshAtc[fa].getAttribute('aria-label') || '';
            var faMatch = faLabel.match(/^Add 1 unit of (.+)/i);
            if (faMatch && faMatch[1].trim() === TARGET_NAME) { buttonToClick = freshAtc[fa]; break; }
          }
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ADD_DEBUG', step: 'increment_' + i,
          foundIncrement: !!buttonToClick, qtyBefore: qtyBefore
        }));
        if (!buttonToClick) break;
      }
      if (buttonToClick.disabled || buttonToClick.getAttribute('aria-disabled') === 'true') break;
      buttonToClick.scrollIntoView({ behavior: 'instant', block: 'center' });
      await wait(100);
      buttonToClick.click();
      var confirmed = await waitForCartConfirm(headerBefore, qtyBefore);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'ADD_DEBUG', step: 'click_confirmed_' + i,
        confirmed: confirmed, qtyBefore: qtyBefore, qtyAfter: getCartQty(),
        headerBefore: headerBefore, headerAfter: getHeaderCartCount()
      }));
      if (confirmed) actuallyClicked++;
    }
  }

  document.removeEventListener('focusin', __noKbd, true);
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'ADD_RESULT',
    success: actuallyClicked >= 1,
    reason: actuallyClicked === 0 ? 'not_found' : undefined
  }));
})();true;`;
}

// ── Search navigation ───────────────────────────────────────────────────────

function buildSearchScript(domain: string) {
  const s = sel();
  return function (term: string): string {
    // Search with the first 5 words only (Albertsons returns nothing for long
    // full-title queries). Scoring still uses the full name downstream.
    var escaped = JSON.stringify(albertsonsSearchQuery(term));
    return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  var term = ${escaped};

  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      e.target.setAttribute('inputmode', 'none');
    }
  }
  document.querySelectorAll('input, textarea').forEach(function(el) { el.setAttribute('inputmode', 'none'); });
  document.addEventListener('focusin', __noKbd, true);

  var searchUrl = 'https://www.${domain}/shop/search-results.html?q=' + encodeURIComponent(term);

  // Click the search icon button to reveal/focus the input
  var openBtn = document.querySelector(${s.searchOpen});
  if (openBtn) { openBtn.click(); await wait(300); }

  // Poll for the search input — the storefront hydrates async, and submitting
  // before it's ready sends an empty ?q=.
  var input = null;
  for (var p = 0; p < 40; p++) {
    input = document.querySelector('input[type="search"][name="q"]')
      || document.querySelector('input[type="search"], input[name="q"], input[placeholder*="search" i]');
    if (input) break;
    await wait(150);
  }

  var submitted = false;
  if (input) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    // Set the value and VERIFY it stuck before submitting — Angular's binding
    // can drop a programmatic set if the component isn't wired yet, which is
    // what caused empty-query searches. Retry until input.value holds the term.
    var ok = false;
    for (var t = 0; t < 20; t++) {
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, term);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(120);
      if (input.value === term) { ok = true; break; }
    }
    if (ok) {
      // Only press Enter once the term is actually in the box.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      submitted = true;
      var startUrl = window.location.href;
      for (var i = 0; i < 30; i++) {
        if (window.location.href !== startUrl) break;
        await wait(100);
      }
    }
  }

  // Fallback: input never appeared, value never stuck, Enter didn't navigate to a
  // real results page, OR it navigated with an EMPTY/partial ?q= (Angular can
  // submit before the model updates → the homepage carousel / irrelevant results)
  // → navigate straight to the correct search URL.
  var __cur = window.location.href;
  var __onResults = __cur.indexOf('search-results') !== -1;
  var __qm = __cur.match(/[?&]q=([^&]*)/);
  var __hasQuery = !!(__qm && __qm[1] && decodeURIComponent(__qm[1]).trim().length > 0);
  if (!submitted || !__onResults || !__hasQuery) {
    document.removeEventListener('focusin', __noKbd, true);
    window.location.href = searchUrl;
    return;
  }

  document.removeEventListener('focusin', __noKbd, true);
})();true;`;
  };
}

// ── Search and add ──────────────────────────────────────────────────────────

function buildSearchAndAddScriptFn(
  searchTerm: string,
  qty: number,
  _dropdown: { type: string; selectedText: string; selectedValue: string } | null,
): string {
  var escapedTerm = JSON.stringify(searchTerm);
  const s = sel();
  return `(async function() {
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function __noKbd(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))
      e.target.setAttribute('inputmode', 'none');
  }
  document.addEventListener('focusin', __noKbd, true);

  var SEARCH_TERM = ${escapedTerm};
  var QTY = ${qty};
  // Parallel-add worker mode: the pool injects ONE fixed script per worker (built
  // with an empty term), so each item's real term/qty ride in the URL hash
  // (#mealio=<json>). Override the baked-in defaults when present. No hash →
  // sequential flow, unchanged. Without this, workers scored every candidate
  // against an empty SEARCH_TERM and returned low_confidence for all items.
  try {
    if (location.hash && location.hash.indexOf('#mealio=') === 0) {
      var __mq = JSON.parse(decodeURIComponent(location.hash.slice(8)));
      if (__mq) {
        if (typeof __mq.term === 'string') SEARCH_TERM = __mq.term;
        if (typeof __mq.qty === 'number') QTY = __mq.qty;
      }
    }
  } catch (e) {}
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'saa_start', searchTerm: SEARCH_TERM, qty: QTY, url: location.href }));
  var ATC_SEL = ${s.atc};
  var BUBBLE_SEL = ${s.bubble};
  var INCREMENT_SEL = ${s.increment};

  var CRITICAL = new Set(['organic','grass','fed','free','range','cage','large','small','jumbo',
    'medium','extra','spicy','mild','hot','sweet','whole','skim','nonfat','lowfat',
    'salted','unsalted','sodium','boneless','skinless','lean','ground',
    'grassfed','cagefree','freerange']);
  // MEAL-160: two-words-on-one-label, one-word-on-the-next. The critical-word
  // check is a token membership test, so 'lowfat' as a lone entry both failed to
  // fire for the natural query spelling ("low fat" tokenises to two non-critical
  // words) and punished the RIGHT product when it did fire (no hyphenated label
  // can contain it). Collapsed on both sides so the entry means the concept, not
  // one spelling of it. Longest first — 'cage free' and 'free range' share a
  // word. Same rule as CRITICAL_PHRASES in _scoring.ts.
  // "Cage Free Range Eggs" is a real label and the two concepts SHARE the word
  // 'free'. A plain left-to-right pass collapses 'cage free' first, eats it, and
  // leaves 'cagefree range' - so a "free range" request vetoed the exact product
  // it wanted. The three-word rule runs first and gives both their own token.
  var CRITICAL_PHRASES = [[/\\bcage free range\\b/g,'cagefree freerange'],
    [/\\bcage free\\b/g,'cagefree'],[/\\bfree range\\b/g,'freerange'],
    [/\\bgrass fed\\b/g,'grassfed'],[/\\blow fat\\b/g,'lowfat'],[/\\bnon fat\\b/g,'nonfat']];
  var CANONICAL_TOKENS = new Set(['cagefree','freerange','grassfed','lowfat','nonfat']);
  function collapseCriticalPhrases(s) {
    var out = s;
    for (var ci = 0; ci < CRITICAL_PHRASES.length; ci++) {
      out = out.replace(CRITICAL_PHRASES[ci][0], CRITICAL_PHRASES[ci][1]);
    }
    return out;
  }
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
  function scoreOne(rawA, rawB) {
    var na = collapseCriticalPhrases(rawA), nb = collapseCriticalPhrases(rawB);
    if (na === nb) return 100;
    var wa = na.split(' ').filter(Boolean), sb = new Set(nb.split(' ').filter(Boolean));
    for (var i = 0; i < wa.length; i++) { if (CRITICAL.has(wa[i]) && !sb.has(wa[i])) return 0; }
    // Weighted: a collapsed token stands for two words, so counting it once
    // would shrink both sides of the fraction and raise the 70% bar. Same rule
    // as tokenWeight in _scoring.ts.
    var total = 0, matched = 0;
    for (var wi = 0; wi < wa.length; wi++) {
      var tw = CANONICAL_TOKENS.has(wa[wi]) ? 2 : 1;
      total += tw;
      if (sb.has(wa[wi])) matched += tw;
    }
    var p = matched / total;
    if (p < 0.7) return 0;
    return Math.min(99, Math.round(p * 100));
  }
  function scoreMatch(a, b) {
    var s1 = scoreOne(normDiacritic(a), normDiacritic(b));
    var s2 = scoreOne(normStrip(a), normStrip(b));
    return Math.max(s1, s2);
  }

  function normalizeForScoring(s) {
    return s.toLowerCase().replace(/[^\\w\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
  }

  // A surfaced suggestion must share at least one meaningful word with the search
  // term. Albertsons returns nothing for long queries and shows a "recommended /
  // buy it again" carousel instead — those Add buttons would otherwise become
  // bogus suggestions. Zero-overlap products are that carousel, so drop them.
  function __relevant(name) {
    var tw = normalizeForScoring(SEARCH_TERM).split(' ').filter(function(w) { return w.length > 2; });
    if (tw.length === 0) return true;
    var fw = normalizeForScoring(name).split(' ');
    return tw.some(function(w) { return fw.indexOf(w) !== -1; });
  }

  function scoreProductName(foundName, targetName) {
    var found = normalizeForScoring(foundName);
    var target = normalizeForScoring(targetName);
    if (found === target) return 100;
    var targetWords = target.split(' ').filter(Boolean);
    var foundWords = found.split(' ').filter(Boolean);
    var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
    var matchPct = matchCount / targetWords.length;
    if (matchPct < 0.7) return -1;
    var extraCount = foundWords.filter(function(w) { return targetWords.indexOf(w) === -1; }).length;
    return Math.round(matchPct * 100) - (extraCount * 10);
  }

  function findBubbleForProduct(productName) {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allBubbles.length; i++) {
      var btn = allBubbles[i];
      var al = btn.getAttribute('aria-label') || '';
      var extracted = null;
      var m1 = al.match(/collapsed[,:]?\\s*\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)\\s+in\\s+cart/i);
      if (m1) { extracted = m1[1]; }
      else {
        var m2 = al.match(/\\d+\\s*unit[^\\s]*\\s+of\\s+(.+?)(?:\\s+in\\s+cart|\\s*\\.|$)/i);
        if (m2) extracted = m2[1];
      }
      if (!extracted) continue;
      var cleaned = extracted
        .replace(/,?\\s*\\$[\\d.,]+\\s*(per\\s+\\w+|each|\\/\\s*\\w+)\\b.*/i, '')
        .replace(/,?\\s*\\d+\\s+for\\s+\\$[\\d.,]+.*/i, '')
        .trim();
      var score = -1;
      if (/\\.{3}|\\u2026/.test(cleaned)) {
        // Truncated label, e.g. "Lucerne Heavy Whipping Cream -...(packaging may
        // vary)". Score on the words shown BEFORE the ellipsis against the target;
        // trailing noise after "..." (like "(packaging may vary)") is never in the
        // real product name, so requiring it to match would wrongly reject the bubble.
        // Middle-truncation "prefix...suffix" — the store cuts the title in the
        // middle (e.g. "PERDUE SIMPLY SMART ORGANIC Gl...east Tenders - 22 Oz").
        // Anchor BOTH ends to the target deterministically instead of word-
        // scoring the fragment: the target must start with the prefix and end
        // with the suffix. (Prefix-only truncation with trailing packaging noise
        // — "…Cream -...(packaging may vary)" — matches on the prefix alone.)
        var __parts = cleaned.split(/\\.{3}|\\u2026/);
        var __pre = normalizeForScoring(__parts[0]);
        var __suf = normalizeForScoring(__parts[__parts.length - 1]);
        var __t = normalizeForScoring(productName);
        var __preOk = __pre.length >= 3 && __t.indexOf(__pre) === 0;
        var __sufOk = __suf.length >= 3 && __t.length >= __suf.length && __t.lastIndexOf(__suf) === __t.length - __suf.length;
        if (__preOk && __sufOk) score = 100;
        else if (__preOk && (__suf.length < 3 || __t.indexOf(__suf) === -1)) score = 95;
        else score = -1;
      } else {
        var targetWords = normalizeForScoring(productName).split(' ').filter(Boolean);
        var foundWords = normalizeForScoring(cleaned).split(' ').filter(Boolean);
        var matchCount = targetWords.filter(function(w) { return foundWords.indexOf(w) !== -1; }).length;
        var matchPct = matchCount / targetWords.length;
        score = matchPct < 0.7 ? -1 : Math.round(matchPct * 100);
      }
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    return best;
  }

  function findIncrementForProduct(productName) {
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    var best = null, bestScore = 90;
    for (var i = 0; i < allInc.length; i++) {
      var btn = allInc[i];
      var al = btn.getAttribute('aria-label') || '';
      var m = al.match(/^Increase Quantity \\d+ unit[^\\s]* of (.+)/i);
      if (!m) continue;
      var score = scoreProductName(m[1], productName);
      if (score > bestScore) { bestScore = score; best = btn; }
    }
    if (!best && allInc.length === 1) return allInc[0];
    return best;
  }

  function pollForIncrement(productName) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      var POLL_MS = 150;
      var MAX_MS = 5000;
      function tick() {
        if (elapsed >= MAX_MS) { resolve(null); return; }
        var incBtn = findIncrementForProduct(productName);
        if (incBtn) { resolve(incBtn); return; }
        var bubble = findBubbleForProduct(productName);
        if (bubble) {
          bubble.scrollIntoView({ behavior: 'instant', block: 'center' });
          bubble.click();
        }
        elapsed += POLL_MS;
        setTimeout(tick, POLL_MS);
      }
      tick();
    });
  }

  // Read the current cart qty for a product by inspecting bubble/increment aria-labels.
  function getCartQty() {
    var allBubbles = Array.from(document.querySelectorAll(BUBBLE_SEL));
    for (var i = 0; i < allBubbles.length; i++) {
      var al = allBubbles[i].getAttribute('aria-label') || '';
      var qm = al.match(/(\\d+)\\s*unit/i);
      if (qm) return parseInt(qm[1], 10);
    }
    var allInc = Array.from(document.querySelectorAll(INCREMENT_SEL));
    for (var i = 0; i < allInc.length; i++) {
      var al = allInc[i].getAttribute('aria-label') || '';
      var qm = al.match(/Quantity\\s+(\\d+)/i);
      if (qm) return parseInt(qm[1], 10);
    }
    return 0;
  }

  // After clicking ATC or increment, poll until the cart qty changes (up to 2.5s).
  // Kept short: the parallel pass reconciles against the real cart afterward and
  // retries anything not present, so a slow commit is caught there, not here.
  function waitForQtyChange(prevQty) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        if (elapsed >= 2500) { resolve(false); return; }
        var current = getCartQty();
        if (current > prevQty) { resolve(true); return; }
        elapsed += 200;
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  // The header cart-count badge reflects the REAL (server) cart, unlike the
  // product tile's optimistic bubble — so it only ticks up when an item
  // actually commits. null = badge unreadable (fall back to the tile bubble).
  function getHeaderCartCount() {
    var el = document.querySelector('[data-qa="hdr-crt-txt-plus"]');
    if (!el) return null;
    var t = (el.textContent || '').trim();
    if (t === '') return 0;
    var m = t.match(/\\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  // Confirm an add by the header cart count incrementing (authoritative). Falls
  // back to the tile qty bubble only when the header count isn't readable.
  function waitForCartConfirm(headerBefore, tileBefore) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        var hc = getHeaderCartCount();
        if (headerBefore != null && hc != null && hc > headerBefore) { resolve(true); return; }
        if (headerBefore == null && getCartQty() > tileBefore) { resolve(true); return; }
        // Short cap: unconfirmed adds are caught by the post-pass cart reconcile.
        if (elapsed >= 2500) { resolve(false); return; }
        elapsed += 250;
        setTimeout(tick, 250);
      }
      tick();
    });
  }

  // PER-PRODUCT cart qty: read THIS product's quantity from its own in-cart
  // stepper/bubble aria-label. Unlike the shared header count, this can't be
  // spoofed by a concurrent worker's add — the reliable confirm signal.
  function getProductCartQty(productName) {
    var b = findBubbleForProduct(productName);
    if (b) { var m = (b.getAttribute('aria-label') || '').match(/(\\d+)\\s*unit/i); if (m) return parseInt(m[1], 10); }
    var inc = findIncrementForProduct(productName);
    if (inc) {
      var a = inc.getAttribute('aria-label') || '';
      var m2 = a.match(/(\\d+)\\s*unit/i) || a.match(/Quantity\\s+(\\d+)/i);
      if (m2) return parseInt(m2[1], 10);
    }
    return 0;
  }

  // Confirm an add by THIS product's own qty rising (its Add button turning into
  // an "N in cart" stepper, or the stepper incrementing). Albertsons can be slow,
  // so poll up to ~4.5s.
  function waitForProductInCart(productName, prevQty) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        if (getProductCartQty(productName) > prevQty) { resolve(true); return; }
        if (elapsed >= 4500) { resolve(false); return; }
        elapsed += 200;
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  var CARD_SEL = ${s.card};
  function cardOf(el) { return el ? el.closest(CARD_SEL) : null; }

  // The authoritative per-add signal: the quantity shown ON THIS PRODUCT CARD.
  // The card's "Add" turns into a stepper whose number only rises once the item
  // is truly in the cart — immune to concurrency AND to name mismatches (we read
  // the exact card we clicked, not one found by name).
  function getCardQty(card) {
    if (!card) return 0;
    var b = card.querySelector('[data-qa="qty-stppr-bbl"]');
    if (b) { var m = (b.getAttribute('aria-label') || '').match(/(\\d+)\\s*unit/i); if (m) return parseInt(m[1], 10); }
    var inc = card.querySelector('[data-qa="prdctincrmntr"]');
    if (inc) {
      var a = inc.getAttribute('aria-label') || '';
      var m2 = a.match(/(\\d+)\\s*unit/i) || a.match(/Quantity\\s+(\\d+)/i);
      if (m2) return parseInt(m2[1], 10);
    }
    var qd = card.querySelector('[data-qa*="qty"], [data-qa*="Qty"], input[aria-label*="quantity" i]');
    if (qd) { var t = (qd.value || qd.textContent || '').match(/\\d+/); if (t) return parseInt(t[0], 10); }
    return 0;
  }
  function waitForCardQty(card, prevQty) {
    return new Promise(function(resolve) {
      var elapsed = 0;
      function tick() {
        if (getCardQty(card) > prevQty) { resolve(true); return; }
        if (elapsed >= 4500) { resolve(false); return; }
        elapsed += 200;
        setTimeout(tick, 200);
      }
      tick();
    });
  }

  // Poll for ATC buttons, then wait for the result grid to SETTLE (count steady
  // across 2 consecutive 300ms checks) before scoring — see buildExtractProductsScript.
  // Up to ~9s (30 * 300ms).
  var allAtcBtns = [];
  var lastCount = -1, stableStreak = 0;
  for (var poll = 0; poll < 30; poll++) {
    allAtcBtns = Array.from(document.querySelectorAll(ATC_SEL)).slice(0, 20);
    if (allAtcBtns.length > 0 && allAtcBtns.length === lastCount) {
      if (++stableStreak >= 2) break;
    } else {
      stableStreak = allAtcBtns.length > 0 ? 1 : 0;
    }
    lastCount = allAtcBtns.length;
    await wait(300);
  }
  // DOM snapshot at the poll boundary: if the ATC selector found nothing, this
  // shows what buttons/cards ARE on the page so we can spot a changed selector.
  try {
    var __allBtns = Array.prototype.slice.call(document.querySelectorAll('button'));
    var __addish = __allBtns
      .filter(function(b) {
        var a = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-qa') || '');
        return /add|unit|cart|increase|quantity/i.test(a);
      })
      .slice(0, 15)
      .map(function(b) { return { aria: (b.getAttribute('aria-label') || '').slice(0, 90), qa: b.getAttribute('data-qa') || null }; });
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'EXTRACT_DEBUG', step: 'saa_poll_done',
      atcCount: allAtcBtns.length, polls: poll, url: location.href,
      totalButtons: __allBtns.length,
      productCards: document.querySelectorAll('[class*="ProductCard"], [class*="product-card"], li[data-qa]').length,
      bubbles: document.querySelectorAll(BUBBLE_SEL).length,
      increments: document.querySelectorAll(INCREMENT_SEL).length,
      addLikeButtons: __addish,
    }));
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACT_DEBUG', step: 'saa_poll_done', atcCount: allAtcBtns.length, polls: poll, snapErr: String(e) }));
  }

  // Real-block detection: an app-download / "open in app" interstitial can cover
  // the page so the ATC button can't be clicked, with NO HTTP error. If we see
  // such a nudge in a visible on-top element, report it as a BLOCK (distinct
  // from a plain missing item) so the flow surfaces it for the user to dismiss.
  try {
    var __NUDGE_RE = /download the app|open in( the)? app|get the app|continue (in|to)( the)? app|shop (in|on)( the)? app|use the app|app store|google play/i;
    var __ov = Array.prototype.slice.call(document.querySelectorAll('div,section,aside,dialog,[role="dialog"]'));
    var __nudge = null;
    for (var __oi = 0; __oi < __ov.length && __oi < 4000; __oi++) {
      var __e = __ov[__oi];
      var __st = window.getComputedStyle(__e);
      if (__st.display === 'none' || __st.visibility === 'hidden') continue;
      if (__st.position !== 'fixed' && __st.position !== 'sticky' && __st.position !== 'absolute') continue;
      var __t = __e.innerText || '';
      if (__t.length === 0 || __t.length > 400) continue; // nudges are small; skip big content
      if (__NUDGE_RE.test(__t)) {
        var __r = __e.getBoundingClientRect();
        if (__r.width > 40 && __r.height > 30) { __nudge = __t.trim().slice(0, 140); break; }
      }
    }
    if (__nudge) {
      document.removeEventListener('focusin', __noKbd, true);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'blocked', blockedText: __nudge, candidates: [] }));
      return;
    }
  } catch (e) {}

  // Find ATC buttons and score against search term
  var candidates = [];
  var seen = new Set();
  var bestAtcBtn = null, bestAtcScore = -1, bestName = null;

  for (var bi = 0; bi < allAtcBtns.length; bi++) {
    var btn = allAtcBtns[bi];
    var al = btn.getAttribute('aria-label') || '';
    var atcMatch = al.match(/^Add 1 unit of (.+)/i);
    if (!atcMatch) continue;
    var name = atcMatch[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    var oos = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    var card = btn.closest('li, article, [class*="ProductCard"], [class*="product-card"]');
    var imgEl = card ? card.querySelector('img') : null;

    // Collect the store's first 8 displayed products for review suggestions...
    if (candidates.length < 8) {
      candidates.push({
        productName: name,
        imageUrl: imgEl ? imgEl.src : null,
        outOfStock: oos,
        preferences: null,
        price: null
      });
    }

    // ...but keep scanning ALL results for an exact (normalized) name match to
    // add — no fuzzy scoring. A different size/variant is not the chosen product;
    // it stays a review suggestion. The exact match may be past the first 8.
    if (!bestName && normalizeForScoring(name) === normalizeForScoring(SEARCH_TERM) && !oos) {
      bestAtcBtn = btn; bestAtcScore = 100; bestName = name;
    }
  }
  // Diagnostic: the raw candidate names (from each ATC button's aria-label) and
  // their score vs the search term. Reveals truncated titles / why nothing hit 100.
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'EXTRACT_DEBUG', step: 'saa_candidates', searchTerm: SEARCH_TERM, bestName: bestName,
    candidates: candidates.map(function(c) { return { name: c.productName, score: scoreMatch(SEARCH_TERM, c.productName), oos: c.outOfStock }; })
  }));

  // The product may already be in the cart, shown as a collapsed bubble or an
  // open stepper INSTEAD of an "Add 1 unit of" button — so there may be no ATC
  // candidate (bestName/bestAtcBtn null). Match these against SEARCH_TERM.
  var matchName = bestName || SEARCH_TERM;
  var preExistingBubble = findBubbleForProduct(matchName);
  var preExistingIncrement = !preExistingBubble ? findIncrementForProduct(matchName) : null;

  // Give up only if there's no ATC button AND the item isn't already in the cart.
  if (!bestAtcBtn && !preExistingBubble && !preExistingIncrement) {
    // No exact match to add → surface the store's OWN top results (in the order
    // it displayed them), unfiltered, so the user can pick an alternative. No
    // score-based filtering: we just show what the store showed.
    var surfaced = candidates.slice(0, 8);
    var hasExactOos = candidates.some(function(c) { return normalizeForScoring(c.productName) === normalizeForScoring(SEARCH_TERM) && c.outOfStock; });
    var reason = surfaced.length === 0 ? 'no_results' : hasExactOos ? 'out_of_stock' : 'low_confidence';
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: reason, candidates: surfaced }));
    return;
  }

  try {
    // If we have an ATC but the in-cart bubble hasn't rendered yet, give it a moment.
    if (!preExistingBubble && !preExistingIncrement && bestAtcBtn) {
      for (var wa = 0; wa < 3 && !preExistingBubble && !preExistingIncrement; wa++) {
        await wait(400);
        preExistingBubble = findBubbleForProduct(matchName);
        preExistingIncrement = !preExistingBubble ? findIncrementForProduct(matchName) : null;
      }
    }

    var usePreExisting = !!(preExistingBubble || preExistingIncrement);
    var stepperAlreadyOpen = !!preExistingIncrement && !preExistingBubble;
    var actuallyClicked = 0;

    if (usePreExisting) {
      if (stepperAlreadyOpen) {
        for (var i = 0; i < QTY; i++) {
          var qtyBefore = getCartQty();
          var headerBefore = getHeaderCartCount();
          var prodBefore = getProductCartQty(matchName);
          var incBtn = i === 0 ? preExistingIncrement : await pollForIncrement(matchName);
          if (!incBtn) break;
          incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incBtn.click();
          var confirmed = await waitForProductInCart(matchName, prodBefore);
          if (confirmed) actuallyClicked++;
        }
      } else {
        preExistingBubble.scrollIntoView({ behavior: 'instant', block: 'center' });
        preExistingBubble.click();
        await wait(600);
        for (var i = 0; i < QTY; i++) {
          var qtyBefore = getCartQty();
          var headerBefore = getHeaderCartCount();
          var prodBefore = getProductCartQty(matchName);
          var incBtn = await pollForIncrement(matchName);
          if (!incBtn) break;
          incBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          await wait(100);
          incBtn.click();
          var confirmed = await waitForProductInCart(matchName, prodBefore);
          if (confirmed) actuallyClicked++;
        }
      }
    } else {
      // Normal path: ATC adds first unit, increment handles the rest.
      // After each click, poll until the cart qty increases before continuing.
      for (var i = 0; i < QTY; i++) {
        var qtyBefore = getCartQty();
        var headerBefore = getHeaderCartCount();
        var prodBefore = getProductCartQty(matchName);
        var buttonToClick;
        if (i === 0) {
          buttonToClick = bestAtcBtn;
        } else {
          // Try increment (handles bubble→stepper), fall back to re-clicking ATC
          buttonToClick = await pollForIncrement(matchName);
          if (!buttonToClick) {
            var freshAtc = Array.from(document.querySelectorAll(ATC_SEL));
            for (var fa = 0; fa < freshAtc.length; fa++) {
              var faLabel = freshAtc[fa].getAttribute('aria-label') || '';
              var faMatch = faLabel.match(/^Add 1 unit of (.+)/i);
              if (faMatch && faMatch[1].trim() === matchName) { buttonToClick = freshAtc[fa]; break; }
            }
          }
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'ADD_DEBUG', step: 'increment_' + i,
            foundIncrement: !!buttonToClick,
            qtyBefore: qtyBefore
          }));
          if (!buttonToClick) break;
        }
        if (buttonToClick.disabled || buttonToClick.getAttribute('aria-disabled') === 'true') break;
        // The product CARD holding this button — read its own qty as the confirm.
        var cardEl = cardOf(buttonToClick);
        var cardBefore = getCardQty(cardEl);
        buttonToClick.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(100);
        buttonToClick.click();
        // Confirm via THIS card's own quantity rising (definitive per-add signal);
        // fall back to the per-product read if the card wasn't resolvable.
        var confirmed = cardEl
          ? await waitForCardQty(cardEl, cardBefore)
          : await waitForProductInCart(matchName, prodBefore);
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ADD_DEBUG', step: 'click_confirmed_' + i,
          confirmed: confirmed,
          cardFound: !!cardEl, cardBefore: cardBefore, cardAfter: getCardQty(cardEl),
          prodBefore: prodBefore, prodAfter: getProductCartQty(matchName),
          headerBefore: headerBefore, headerAfter: getHeaderCartCount(),
          // One-time DOM snapshot of the card so we can verify the qty selector.
          cardHtml: (i === 0 && cardEl) ? cardEl.outerHTML.replace(/\\s+/g, ' ').slice(0, 700) : undefined
        }));
        if (confirmed) actuallyClicked++;
      }
    }

    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: actuallyClicked >= 1, productName: matchName, actuallyClicked: actuallyClicked, qty: QTY }));
  } catch(e) {
    document.removeEventListener('focusin', __noKbd, true);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SEARCH_AND_ADD_RESULT', success: false, reason: 'no_results', candidates: candidates.filter(__relevant) }));
  }
})();true;`;
}

// ── Export ───────────────────────────────────────────────────────────────────

export function getScripts(storeId: string): StoreScripts {
  // Unreachable fallback, for the same reason and held by the same two tests as
  // the one on getAlbertsonsCartPageUrl — see that note. index.ts only routes
  // here for ids in ALBERTSONS_FAMILY_IDS, i.e. keys of DOMAIN_MAP.
  const domain = DOMAIN_MAP[storeId] || 'albertsons.com';
  const storeOrigin = `https://www.${domain}`;
  // Read under the shared 'albertsons' key: every banner runs one storefront
  // platform, so one config entry tunes all 15. URLs stay derived from the
  // storeId — a per-banner URL override would need 15 entries to say one thing.
  const cfg = storeConfig(SELECTOR_KEY);

  return {
    storeUrl: storeOrigin,
    loginUrl: storeOrigin,
    // MEAL-151: was `/shop/cart.html`, which 404s while `/erums/cart` returns 200
    // — spot-checked live on albertsons.com, safeway.com and vons.com. Not all
    // fifteen were probed; the path is uniform across the family (pinned by
    // url-builders.test.ts), so there is no reason to expect the rest to differ,
    // but the comment should say what was measured rather than what follows. This is not a dead
    // constant: `cartUrl` has exactly one consumer, the Linking.openURL that opens
    // the user's cart in the real app (WebViewCartSheet), so every tap of that
    // button landed on a 404 page.
    //
    // ALBERTSONS_CART_PATH rather than another literal, because it is the same
    // path the cart-count probe already navigates to and MEAL-136 already proved
    // uniform across the family. Two copies of a path is how one of them goes
    // stale without the other noticing.
    cartUrl: `${storeOrigin}${ALBERTSONS_CART_PATH}`,
    domain: domain,
    isSearchUrl: (url: string) => url.includes(domain) && url.includes('/shop/search-results.html'),
    // Albertsons login is a popup on the same page — login success is detected via
    // LOGIN_COMPLETE message from the background poll, not via URL change.
    isLoginSuccessUrl: () => false,
    // The page reloads after sign-in, killing the background poll's JS context.
    // Re-inject the login check on each post-login store load so the check
    // re-runs and detects the now-logged-in state.
    reinjectLoginCheckOnNav: true,
    checkLoginScript: buildCheckLoginScript(domain),
    extractProductsScript: buildExtractProductsScript(),
    buildAddToCartScript: buildAddToCartScript,
    buildSearchScript: buildSearchScript(domain),
    buildSearchAndAddScript: buildSearchAndAddScriptFn,
    getSearchUrl: (term: string) => `${storeOrigin}/shop/search-results.html?q=` + encodeURIComponent(albertsonsSearchQuery(term)),
    buildWorkerScript: (workerId: number) => buildExtractWorker(workerId, buildExtractProductsScript()),
    // Albertsons search loads are heavy — 5 concurrent WebViews crashed the iOS
    // WKWebView content process (shared memory budget). 3 staggered by 400ms is
    // proven safe and matches the low global default for anti-bot reasons (fewer
    // concurrent requests). Keeps parallel on (unlike ALDI/Wegmans forceSerialSearch).
    // Remotely tunable: if this store starts tripping a WAF we can drop the
    // concurrency or force serial without shipping a build.
    workerCount: cfg.workerCount ?? 3,
    workerStaggerMs: cfg.workerStaggerMs ?? 400,
    forceSerialSearch: cfg.forceSerialSearch,
    cacheBustNav: cfg.cacheBustNav,
    spaSearch: cfg.spaSearch,
  };
}
