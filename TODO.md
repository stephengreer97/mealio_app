# Mealio — Running TODO

Single source of truth for ongoing infra/feature work. Mirror the open items
into the Claude Code harness task list at the start of a session (the harness
list is per-session and does not persist; this file does).

---

## GTM — must ship before launch

### Engineering

- [ ] **Creator invite emails.** Email creators to invite them to participate.
  builds template + send mechanism; provides the recipient list + copy.

### Manual / accounts / content

- [ ] **Create a YouTube video** and add it to both app store listings.
- [ ] **Fix screenshots and publish to the Google Play Store.** (can assist
  with framing/copy; capture + Play Console publish.)

---

## Just Before GTM

- [ ] **Change `MEALIO_MAILING_ADDRESS` to a real address.** Currently a
  placeholder (`Mealio, PO Box 1234, Austin, TX 78701`) in Vercel prod + local
  `.env.local`. Must be a real USPS PO Box / virtual mailbox before ANY
  marketing/lifecycle email sends — CAN-SPAM requires a valid physical address.
  Blocks M2 email go-live. (mealio_central)
- [ ] **Upgrade to higher tier?** — Vercel, Supabase.
- [ ] **Test partner payout via Tremendous.**
- [ ] **Verify everything on the help page.**

---

## Stretch Goals

- [ ] **Android WebView WAF compatibility — real-device smoke test + Custom Tabs eval.**
  (1) ✅ DONE — dynamic Android UA (`src/lib/webview-user-agent-build.ts`, PR #27,
  unit-tested). 
  (2) Per-store smoke test across the 6 WebView stores — **needs a
  physical Android phone**; the emulator is invalid (x86 / `ranchu` / SwiftShader
  software-GPU / TLS fingerprint → every store falsely blocks regardless of UA).
  (3) Custom Tabs (`expo-web-browser`) fallback for any store still blocked. Low
  risk / deferred: iOS already ships the identical shared dynamic-UA JS against
  these same WAFs, so Android is formally unverified, not unknown.
- [ ] **Bug report → Claude auto-triage + fix.** Route incoming bug reports
  (the `/api/bug-report` payload: description + redacted session logs + context)
  through Claude FIRST. Claude analyzes the problem, cuts a branch, and attempts
  a fix. If it can't fix it or needs Stephen's input, email contact@mealio.co
  first. When fixed (PR opened/merged), email again with the resolution. Gate
  **duplicate/recurring reports of the same issue** so they don't flood the inbox
  (fingerprint the error/signature; collapse repeats into one thread or a
  counter). Builds on the bug-report feature below.
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
- [ ] **Testing enhancements.** Full assessment + reasoning in
  [`docs/testing-recommendations.md`](docs/testing-recommendations.md). Top picks:
  (1) real-store DOM-drift detection (same as the item above — the #1 gap, since
  the mock store + fixtures validate engine logic but can't catch a store
  redesign); 
  (2) extract the cart reconcile/decision logic into pure,
  unit-testable functions (would have caught the pepper double-count instantly);
  (3) programmatic CI seeding, promote mock-store flows to blocking + add a
  parallel-OOS regression flow, harden `inputText` flakiness; 
  (4) an Android Maestro lane and eventually a current-iOS runner.
- [ ] **Contact stores for direct API / OAuth access.**
- [ ] **Nutrition section + breakdown** (requires API integration).
- [ ] **Price section + breakdown** (requires API integration).
- [ ] **Support for other countries.**
- [ ] **Generate-photo search text.** Auto-populates with the meal name but stays
  editable. Consider a full overhaul / AI-generated photos.
- [ ] **Primary-tag chips above the search bar (website).** A row of quick-filter
  chips for the primary tags, placed above the Discover search bar (distinct from
  the removed hero chips).
- [ ] **Price-anchor copy in the upgrade section.** Add "just 1% of the average
  monthly grocery bill" to the Full Access upgrade section to frame the $4.99/mo
  price against what people already spend on groceries.
