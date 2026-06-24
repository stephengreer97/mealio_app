# Mealio — Running TODO

Single source of truth for ongoing infra/feature work. Mirror the open items
into the Claude Code harness task list at the start of a session (the harness
list is per-session and does not persist; this file does).

Legend: **[S]** = Stephen does this (accounts / content / outreach / decisions).
**[C]** = Claude can build/do it. Mixed items note who owns what.

---

## GTM — must ship before launch

### Engineering — [C]

- [ ] **Android WebView WAF compatibility — dynamic UA + Custom Tabs eval.**
  (1) Dynamic Android UA in `src/lib/webview-user-agent.ts` (currently static
  "Android 16 / Chrome 138 / Pixel 9"): map `Platform.Version` → Android version,
  query Chrome WebView version or keep a freshness policy. (2) Per-store smoke
  test on real Android for all 6 WebView stores. (3) Evaluate Custom Tabs where
  the in-app WebView is fingerprinted.
- [ ] **HEB multi-quantity add-to-cart — test + fix.** Adding multiple qty of one
  product appears broken, and the cart snapshot is not catching the miss.
  Investigate the qty path and tighten snapshot detection.
- [ ] **Mock store + complete Maestro suite.** Build a controllable mock store and
  run full Maestro coverage against it: product search, add-to-cart, cart
  snapshot, product reconciliation, and the rest of the flow. (Deferred to its own
  session — Maestro is not yet set up in the repo.)
- [ ] **Marketing/lifecycle emails — creators.** Reminder emails to publish meals,
  auto-sent based on lack of activity; plus an initial onboarding email with
  tips. [C] builds + wires auto-send; Also builds Admin dashboard for viewing/tracking 
  the emails and click rates. Plan more dashboard features [S] provides/approves copy 
  + tips content.
- [ ] **Marketing emails — users.** Upsell to Full Access, auto-sent to users who
  have not paid. [C] builds + wires the trigger; [S] approves copy.
- [ ] **Creator invite emails.** Email creators to invite them to participate.
  [C] builds template + send mechanism; [S] provides the recipient list + copy.

### Manual / accounts / content — [S]

- [ ] **Create a YouTube video** and add it to both app store listings.
- [ ] **Fix screenshots and publish to the Google Play Store.** ([C] can assist
  with framing/copy; capture + Play Console publish are [S].)
- [ ] **Google Play + RevenueCat setup.** Dashboard/console config is [S]; [C] can
  wire the RevenueCat SDK in-app.

---

## Just Before GTM

- [ ] **Upgrade to higher tier?** — Vercel, Supabase.
- [ ] **Test partner payout via Tremendous.**
- [ ] **Verify everything on the help page.**
- [ ] **Decide on the website carousel.**

---

## Stretch Goals

- [ ] **Background add-to-cart, v2 (server-side).** True background while the app
  is fully closed, with real push on completion. Do NOT move the WebView trick
  server-side (storing passwords / replaying cookies breaks store ToS + risks
  CFAA). Use official partner APIs with user OAuth: primary **Instacart Developer
  Platform**, plus **Kroger Developer API** cart endpoints and Walmart partner
  where available. mealio.co backend fires APNs/FCM when the cart is built.
- [ ] **Store DOM drift detection — selector canary or recapture cadence.** Catch
  store redesigns before users hit broken carts. Residential-IP canary from
  Stephen's home machine on a local cron with realistic UA, or a scheduled
  fixture-recapture cadence. (Live-Playwright was WAF-blocked from datacenter IP.)
- [ ] **Live-store Maestro tests with 2FA trust-cookie persistence.** Clear 2FA
  once and reuse the long-lived device-trust COOKIE (NOT IP-based). LOCAL: golden
  simulator, Maestro `clearState:false`, install OVER the app. CI: capture trust
  cookies via `CookieManager.get`, store as secret, inject via `CookieManager.set`.
- [ ] **Contact stores for direct API / OAuth access.**
- [ ] **Nutrition section + breakdown** (requires API integration).
- [ ] **Price section + breakdown** (requires API integration).
- [ ] **Support for other countries.**
- [ ] **Generate-photo search text.** Auto-populates with the meal name but stays
  editable. Consider a full overhaul / AI-generated photos.

---

## Done

### GTM burndown (2026-06-23 / 24)
- Parallel add-to-cart — shipped ON (`FEATURE_PARALLEL_ADD`); covers all WebView
  stores except ALDI + Wegmans (serial). PR #10.
- "Skip" option when no results — added to the choose-product flow (the review /
  reconciliation flow already had it).
- Remove the "N items" label on authorless meals.
- Android App Links — verified already wired (autoVerify intent filter +
  `assetlinks.json` + AASA + in-app `/meal` routing). Remaining [S]: confirm the
  `assetlinks.json` SHA-256 matches the Play App Signing cert + on-device test.
- Deep links to store carts (PR #12, found via Apple's AASA CDN — no app installs):
  Kroger family → `https://<domain>/cart` Universal Link (opens app to cart);
  HEB → `myheb://`; Amazon → `com.amazon.mobile.shopping.web://amazon.com/gp/cart/view.html`
  (device-confirmed); Walmart already opened via its cart-URL fallback. Albertsons
  family / ALDI / Wegmans expose no cart deep link — website-cart fallback stays.
  Dropped the 16 unverified Kroger `<name>://` guesses + their LSApplicationQueriesSchemes.
- App broadcast → in-app dismissible banner with per-store targeting, then upgraded
  to MULTIPLE simultaneous broadcasts with server-generated IDs (dismissal keyed by
  id, so reused wording re-shows), a "show on every launch" (forceShow) option, and
  admin list/remove. PRs: website #4 + #5, app #10 + #11.
- Mobile TypeScript cleanup — cleared the pre-existing tsc errors (Ingredient
  `productName` alias, valid empty-ingredient placeholders, nullable Kroger
  `locationName`, RevenueCat `introductoryDiscount` cast, dead nullish check).
  tsc clean, jest 207/207. Pushed straight to main.

### Background add-to-cart v1 (in-app) — MERGED (PR #9)
- Root `CartJobProvider` owns the WebView engine; the sheet is a consumer.
  Draggable circular-progress bubble (bottom-right): tap to expand; success →
  cart snapshot, review/out-of-stock/snapshot problem → warning. Login handled
  up front in the foreground, then auto-collapse. One-time "keep the app open"
  popup. Push notification on terminal/action states when backgrounded.
  Deterministic cart-count confirmation gates add success.
- Phases 3 (AppState pause/resume of timers + notifications) and 4 (haptics,
  a11y, position persistence, cancel, tests) intentionally DROPPED — not doing.

### Sunset browser extensions (2026-06-23)
- Chrome + Firefox extension repos archived read-only; mealio_central server
  hooks + UI references removed (PR #3 on mealio_website). Cart automation is now
  the Kroger web integration + the mobile app only.

### Walmart
- Cart snapshot (before/after) — Walmart has a /cart page, so URL-based like HEB.
  Added `WALMART_CART_PAGE_SCRIPT` (per-item: `productName` + `quantity-label`)
  and registered the cart URL. Fixture test (4 items). Parallel search was
  already enabled (getSearchUrl + buildWorkerScript, no forceSerialSearch).
- Fixed "only 2 suggestions per product": EXTRACT_PRODUCTS_SCRIPT poll broke on
  the first 1-2 hydrated cards. Now waits for the card count to STABILIZE before
  extracting, AND distrusts low counts — accepts a healthy count (>=4) as soon as
  it's stable, but keeps polling (~3.6s) for a small count so a cold first-load
  (worker 0's first search) isn't read mid-hydration. Affects serial choose flow
  + parallel workers.
- Fixed double-add / skipped-item / duplicate cart-check warning: Walmart is an
  SPA that fires onLoadEnd 2x per /search nav, so the inflight re-injection ran a
  DUPLICATE search-and-add (double-add → next nav race-cancels the POST → item
  reverts; and the phantom result overwrites the next item's slot, skipping it).
  Added `spaSearch: true` (same fix as ALDI).

### Misc
- Removed temporary session-debug instrumentation (`STORAGE_DEBUG` in aldi.ts,
  `COOKIE_DUMP`/`dumpStoreCookies` in WebViewCartSheet, `CART_DEBUG` in the ALDI
  cart script).
- Amazon Fresh cart snapshot — done.

### Wegmans
- Cart snapshot (before/after) — Wegmans has a /cart page, so URL-based like HEB.
  Added `WEGMANS_CART_PAGE_SCRIPT`: each cart line's stepper aria-label
  ("Add 1 ea to N ea of <name> in the cart") gives name + qty; the "in the cart"
  pattern isolates real lines from the ~70 recommendation tiles. Fixture test.
  Parallel search was the original feature here, but the WAF 403s the concurrent
  worker searches (even 2 staggered workers blocked), so Wegmans is now
  `forceSerialSearch: true` + `cacheBustNav: false` (like ALDI). Does NOT get
  `spaSearch` — Wegmans relies on the SSO inflight re-injection.
- Fixed serial choose-flow showing WRONG products (item N got item N-1's
  results): the EXTRACT_PRODUCTS_SCRIPT had no re-injection guard, so spurious
  same-URL onLoadEnds re-ran it and the duplicate SEARCH_RESULTs were consumed by
  later items. Added a `__wegmansExtractActive` guard (+ try/finally to clear it)
  — same idea as the existing `__wegmansAddInflight` guard on the add script.
  WATCH: that add guard is set but never cleared (relies on nav resetting the JS
  context); if Wegmans add-to-cart ever drops items past the first, harden it the
  same try/finally way.

### ALDI anti-bot + login
- Verified ALDI serial search end-to-end after the 403 cooldown: clean storefront
  loads (no cache-buster), correct login verdict, search + add-to-cart complete,
  cart snapshot working.
- ALDI login detection rewrite — open the Main Menu before reading it, positive
  signal (`buy it again` / `saved recipes`) + stability gating, default-safe to
  logged-out. Fixed the render-race false-positive.
- ALDI forced to serial search (`forceSerialSearch`); per-store `workerCount` /
  `workerStaggerMs`; staggered initial worker dispatch in the pool.
- HTTP 403/429/503 block detection (`onHttpError`) + fixed the tight 403
  auto-resume loop (`blockReasonRef` guard in `onLoadEnd`).
- ALDI skips the `?_t=` cache-buster (`cacheBustNav:false`) — `navTo` navigates
  to the clean URL and uses `reload()` for same-URL re-nav.
- Fixed ALDI items silently skipped / mis-reported: the Instacart SPA fires
  `onLoadEnd` multiple times per pushState search, and the inflight re-injection
  spawned duplicate add-runs that over-advanced `searchIdxRef`. Added `spaSearch`
  flag (ALDI) that suppresses inflight re-injection.
- ALDI cart snapshot (before/after) — ALDI has no cart page; cart is an in-page
  side panel. Added `buildInlineCartScript` (open panel → read name + qty per
  line → post CART_COUNT → close) injected directly (no nav). Fixture test
  against `cart-with-items.html` (6 items).
- App-promo + OneTrust cookie suppressor REMOVED — turned out not to be needed
  (was a suspected bot tell). Deleted `suppress-app-promo.ts` + its test.

### Infra plan (Jun 2026 — session 4d7af0eb)
- Phase A — HTML fixtures captured for all 6 stores + fixture tests green.
- Phase D — generic parallel-search framework (decoupled from Wegmans) + tests + docs.
- Phase E — WebViewCartSheet step state-machine tests + consolidateIngredients unit test.
- Phase F — Playwright + Maestro MCP servers; slash commands validated.
- Phase G — parallel search rolled out to a second store.
- Phase H — dev capture server, shared fixture-capture config, mobile AuthContext +
  backend isAdmin, FixtureCaptureSheet, AdminScreen + nav.
- Phase I — bubble/stepper/preferences/OOS fixtures + burst capture + regression tests.
- HEB Imperva block — dynamic UA + warmup fixed Access Denied.
- ALDI `/s?k=` search URL verified for live add-to-cart.
- api.ts mappers extracted + unit-tested; GitHub Actions CI green.
- Screenshot tour + Maestro flows; preview-build acceptance loop; mealio_central
  Vitest API route tests.
- Add-to-cart timeout for every store; progress bar; price increase to $5/mo;
  before/after cart snapshot (silent-miss detection); Maestro OOM hardening.
