# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

**Genuinely two-sided (confirmed).** Neither audience leads, and a change that helps one at the other's expense is a bad trade.

- **Home cooks who shop groceries online.** Save meals they want to cook, then get every ingredient into their real cart at their own store without typing each item into a grocery site.
- **Creators who publish meals.** Apply, get approved, publish preset meals, and accumulate followers. `CreatorPortalScreen`, `CreatorApplyScreen`, `CreatorProfileSheet`, creator follows.

The two sides are economically linked, not just adjacent: subscription revenue partly funds creators, stated to users directly in `mealio_central/lib/email-campaigns.ts:33` — *"your subscription helps pay the creators whose meals you save."*

A third role, **admin**, is internal only (`AdminScreen`, `isAdmin` on the auth context).

## Product Purpose

Mealio saves meal recipes and puts their ingredients into the user's real online grocery cart at their own store.

Success is not "the app ran." Success is that the ingredients actually landed in the cart. Everything upstream — discovery, creators, saved meals — exists to reach that one moment.

## Positioning

**Cart automation is the product.** The defensible mechanism is per-store integration across 37 stores, each on the highest-fidelity rail available to it: Kroger's public API where one exists, and automation of the user's own authenticated session inside a WebView where one does not.

Three positions are decided and closed, and future work must not reopen them as if they were open:

- **No retail partnerships.** Not available at current size (MEAL-51).
- **No Instacart Developer Platform.** Off the table (MEAL-34).
- **No first-party client impersonation.** Mealio automates the user's own session at the user's explicit request; it does not assert a retailer's identity to a security system (MEAL-33).

## Operating Context

One product, three clients, one API at `mealio.co`:

- **`mealio_app`** (this repo) — React Native + Expo, managed workflow, no native code.
- **`mealio_central`** — Next.js 16 web app *and* the API server for everything.
- **`mealio_ext`** — Chrome extension with its own independent automation implementation.

Thirteen screens: auth (login, signup, OTP, forgot password, check email), discover, my meals, account, creator portal, creator apply, help, shared meal, admin.

The defining scene is unusual and should shape design decisions: **add-to-cart happens in a live WebView the user is watching**, against the real store, in their own logged-in session. It can take minutes, it can be interrupted by a login wall or a bot challenge, and it can partially succeed. The user is present and waiting.

## Capabilities and Constraints

- **One shared visual design language across iOS and Android** (confirmed). Native conventions are honored for **behavior** — hardware back, gestures, keyboard — but not for visual style. Recorded as `adaptive` so both platforms' *behavioral* guidance applies; it does **not** license two visual designs. Only 2 platform branches in the codebase touch visual style today.
- Auth: email + password, email OTP two-factor, 90-day access tokens, `expo-secure-store` on device.
- Tiers: free tops out at **3 saved meals**; **Full Access** is unlimited at $4.99/mo default (`NEXT_PUBLIC_LS_MONTHLY_PRICE`). Stripe on web, RevenueCat on device.
- Email verification and password reset deliberately open `mealio.co` in the browser rather than staying in the app.
- 37 stores in `src/constants/stores.ts`, hardcoded — adding one currently needs an app release.
- Ingredient records carry inconsistent keys (`product_name` / `productName` / `name`); always normalize via `normalizeIngredients`.
- **Known weak point:** cart automation reliability. Five of seven store families run DOM automation, which breaks on any markup change and gives only inferential confirmation that an add succeeded. This is the subject of the MEAL-1 epic and is the single biggest threat to the product's core promise.
- **Undecided:** whether the store catalog moves server-side, and how store selection works beyond ~100 stores (MEAL-23, MEAL-24).

## Brand Commitments

- **Name "Mealio" is fixed.** Not open for change.
- **Brand red `#DD0031` is fixed.** `Colors.brand`, and the Android adaptive-icon background in `app.json`.
- **Wordmark typeface and app icon are open.** Currently Pacifico. Note for future work: Pacifico is SIL Open Font License 1.1 — free for commercial use, irrevocably, with no scale limit. The reason to replace it is distinctiveness, not licensing. Tracked as MEAL-66.
- Voice and tone: **not established.** Do not infer one from the current copy and treat it as binding.

## Evidence on Hand

**Real, and usable:**

- 37 working store integrations; Kroger runs on a sanctioned public API.
- Creator application and approval flow with real creators and followers.
- Live payments via Stripe (web) and RevenueCat (device).
- Assets: `assets/icon.png`, `splash-icon.png`, `favicon.png`, `android-icon-{foreground,background,monochrome}.png`; `mealio_central/public/email-logo.png` (referenced by 7 email templates at a fixed 130×45) and `icon1024.png`.

**Not on hand — future work must not fabricate these:** testimonials, named customers, user or download counts, press coverage, benchmarks, awards, or any retail partnership or endorsement. The partnership absence is a decided position (MEAL-51), so implying one would be actively false.

## Product Principles

1. **The cart is the moment.** Every surface is upstream of add-to-cart. Work that does not improve the odds of ingredients landing in a real cart is secondary, however good it looks.
2. **Both sides or neither.** Cooks and creators are one economic loop. A change that wins one side by taxing the other is a regression.
3. **The user's own session, never an assumed identity.** Automation acts on what the user already has access to, at their explicit request. This is a boundary, not a preference.
4. **A failure must never be a dead end.** Automation against live third-party sites will fail. When it does, the user gets a next step — never a spinner that never resolves and never a silent partial success.
5. **Fix without shipping.** Store-facing behavior should be correctable by remote config, because a broken store cannot wait for App Store review.

## Accessibility & Inclusion

No product-specific standard has been established, and none is claimed here.

Recorded as a **known gap**: accessibility props (`accessibilityLabel`, `accessibilityRole`, `accessible`) appear in only 3 of the app's files. That is a fact about the current state, not a requirement someone has set. If a standard is wanted, it needs a decision.
