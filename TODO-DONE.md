# Mealio — Completed TODO

## Done

### Google Play + RevenueCat setup (2026-07-08)
- **Google Play + RevenueCat billing — set up + verified end-to-end.** RevenueCat
  offerings (`full_access` set as the current offering, with Play + App Store
  monthly/annual products), `full_access` entitlement, SDK already wired in-app,
  Play↔RevenueCat service account, and the purchase → RevenueCat webhook →
  `user_profiles.subscription_tier` sync. A live Play **sandbox** subscription was
  verified via the RevenueCat V2 API (`store=play_store`, entitlement active,
  `will_renew`) and confirmed to flow to Supabase (`tier=paid`). App User ID =
  Supabase `user_profiles.id`.
- **Cross-platform Manage Subscription — fixed** (branch `google-signin-android-iap`,
  not yet merged). Route by the store a sub was purchased on vs the current platform;
  on Android open the Play subscriptions page via RevenueCat's `managementURL`
  instead of the iOS-only `showManageSubscriptions()` (which threw "not available in
  the current platform"). Verified on the internal-track build (versionCode 7).
- Store *listing* screenshots + production publish are a separate open item in TODO.md.

### Google SSO sign-in fix (2026-07-08)
- **BUG: Google SSO sign-in "Access Blocked: Mealio's request is invalid" — fixed.**
  Google's OAuth was rejecting the sign-in (Google 400). Root cause was OAuth client
  misconfig (redirect URI / signing-cert SHA-1 / consent screen status). Google
  sign-in restored.

### Marketing/lifecycle emails + carousel decision (2026-07-08)
- **Creator lifecycle emails — shipped.** Onboarding email with tips + activity-based
  reminder auto-sends to publish meals, plus the Admin dashboard for viewing/tracking
  sends and click rates (M1/M3). [S] still owns final copy/tips approval.
- **User upsell emails — shipped.** Full Access upsell drip auto-sent to unpaid users
  (M2). [S] still owns final copy approval.
- **Website carousel — decided: removed.** Dropped the auto-scrolling Discover carousel;
  briefly replaced with a hero band + category chips (PR #18), then removed those too
  (PR #20). Discover now opens straight to the section nav + meal grid.

### In-app + web bug report (2026-06-26)
- **Bug report → contact@mealio.co — shipped.** Help-section form on both the
  mobile app (mealio_app PR #25) and website (mealio_website PR #7). Mobile keeps
  an in-memory ring buffer of recent console output (`logBuffer`), redacted **at
  capture** — strips secrets (JWTs/Bearer/passwords/cookies) + emails but **keeps
  product/cart names** (Option A — best debugging signal). On submit it POSTs
  description + redacted logs + context (version, platform/OS, route, user id) to
  `POST /api/bug-report`, which re-scrubs server-side, caps sizes, and emails
  contact@mealio.co via Resend with the logs as `session-logs.txt`. Privacy
  policy updated to disclose it (mealio_website PR #8). Redaction unit-tested.
  **Owner/counsel track (not code):** App Store/Play data declarations + Resend
  DPA + counsel review of the policy wording. Claude auto-triage/fix + dedup
  gating is a separate Stretch item.

### Profit-share → 100% rolling annual (2026-06-24)
- **Profit-share formula dropped the all-time component → 100% rolling 12-month
  saves.** Website (mealio_website PR #6): pure-TS calc over `preset_meal_saves`
  (no migration), creator page, admin leaderboard, help + terms copy. Mobile
  (mealio_app PR #15): `CreatorPortalScreen` reads the new `savesAnnual` /
  `sharePercent` fields + typed `CreatorStats`; dropped the stale quarterly/
  all-time fields.

### HEB cart correctness + sold-by-weight items (2026-06-24 → 26)
- **HEB multi-quantity add-to-cart — fixed (PR #13).** Confirm each unit via the
  card's "N added" label + re-click on a dropped click; qty-aware snapshot/
  reconcile so under-adds are caught instead of silently missed.
- **Weight-dropdown sibling double-add — fixed (PR #19).** `handleWeightDropdown`
  was page-wide and added an unrelated by-the-pound sibling (e.g. Bulk Coffee);
  scoped it to the target card / our own modal.
- **Mid-run logout detection (PR #21).** A session lost mid-run bounced searches
  to the login wall; the engine now detects "empty result on the login page" and
  re-prompts login instead of churning every item to a false "no results".
- **Sold-by-weight items — full feature (PRs #22, #24).** Two models, auto-
  detected: **dropdown** items (bulk coffee, Fish Market) remember an absolute
  `purchaseWeight` (lb) and select the closest option; **HEB Deli** is a
  **stepper** item (no dropdown — 1 step = 0.25 lb, weight = qty × step), add
  unchanged. Detect via `select[name="addByWeight"]` + read real increments;
  prompt-first-then-remember; reconcile weight lines by presence (no double-add);
  show weight on the meal card/detail, editor incrementer, pre-automation
  Add-to-Cart sheet, and post-run cart snapshot. Root-cause: `normalizeIngredients`
  was stripping the saved field on every read — carried through now.
  (Captured: HEB weight dropdown + cart-with-weight fixtures; `ingredientWeight()`
  helper centralizes the dropdown-vs-stepper display.)

### Testing + cart correctness (2026-06-24 / 25)
- **Mock store + complete Maestro suite — DONE (PR #17, merged).** Vercel-hosted
  controllable store gated behind `__DEV__ || EXPO_PUBLIC_E2E`; six green flows
  (10–15: happy path, choose-product, no-results skip, out-of-stock, reconcile,
  parallel) covering login detection → search/add → cart snapshot → every
  reconcile branch. Runs as a non-blocking CI bring-up step on an EAS
  ios-simulator build (creds via `-e`, `clearKeychain` per flow, one retry).
  testIDs: `tab-*`, `meal-card-<name>`, `candidate-<i>`, E2E-only plain password
  field. Seed via `tests/mock-store/seed.sql`. iOS/Maestro gotchas captured in
  [`docs/testing-recommendations.md`](docs/testing-recommendations.md).
- **Parallel reconcile correctness (PR #16, merged).** (1) A worker's explicit
  out-of-stock / no-results failure now surfaces in the "Items Not Added" review
  instead of being silently dropped. (2) Reconcile consumes added units from a
  shared pool (exact-name first) so two near-identical products (Ancho vs
  Guajillo peppers) can't cross-count and mask a per-item qty shortfall.
- **HEB multi-qty under-add + qty-aware snapshot/reconcile (PR #13, merged).**
- **Fixed flaky ALDI fixture test** — its extract waits ~10s for a stale→fresh
  SPA transition that never happens on a static fixture, so the 12s timeout had
  no headroom under parallel load; bumped to 25s.
- Next testing steps live in **Stretch → Testing enhancements** +
  `docs/testing-recommendations.md`.

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
