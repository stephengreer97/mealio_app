# Mealio — Running TODO

Single source of truth for ongoing infra/feature work. Mirror these open items
into the Claude Code harness task list at the start of a session (the harness
list is per-session and does not persist; this file does).

## Open

- [ ] **Parallel add-to-cart (experiment + per-store flag; exclude ALDI)** — try
  adding via `useParallelSearchPool` with `buildSearchAndAddScript`. KEY RISK:
  workers share one cookie jar = one server-side cart, so concurrent adds are
  WRITES that can race (drop/clobber/double-add). Separate branch. Bounded
  concurrency (2–3), cart-count (#69 snapshot) as hard guard + retry. MUST
  exclude ALDI (anti-bot 403s on concurrency — reuse `forceSerialSearch`).
- [ ] **Android WebView WAF compatibility — dynamic UA + Custom Tabs eval**
  (Android is next). (1) Dynamic Android UA in `src/lib/webview-user-agent.ts`
  (currently static "Android 16 / Chrome 138 / Pixel 9"): map `Platform.Version`
  → Android version, query Chrome WebView version or keep a freshness policy.
  (2) Per-store smoke test on real Android for all 6 WebView stores. (3) Evaluate
  Custom Tabs where the in-app WebView is fingerprinted.
- [ ] **Store DOM drift detection — selector canary or recapture cadence** —
  detect store redesigns before users hit broken carts. Prior live-Playwright
  attempt was WAF-blocked (datacenter IP). Options: residential-IP canary from
  Stephen's home machine on a local cron with realistic UA; or scheduled
  fixture-recapture cadence.
- [ ] **Live-store Maestro tests with 2FA trust-cookie persistence** — clear 2FA
  once and reuse the device-trust COOKIE (long-lived, NOT IP-based). (a) LOCAL:
  golden simulator, log in once, Maestro `clearState:false`, always install OVER
  the app. (b) CI-portable: capture trust cookies via `CookieManager.get`
  (reads HttpOnly), store as secret, inject via `CookieManager.set`.
## Done

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

### ALDI anti-bot + login (current work)
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
