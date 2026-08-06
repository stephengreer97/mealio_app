# MEAL-35 — What H-E-B's `__NEXT_DATA__` search payload actually carries

**Date:** 2026-08-06
**Status:** Answered from the committed fixtures alone. **No live session was used**,
so everything below is what a real logged-in curbside/delivery session recorded at
capture time, not a live re-verification.
**Companion to:** MEAL-13 (which now reads this payload — see
`src/lib/webview-scripts/heb.ts`), MEAL-12 (`docs/heb-graphql-persisted-queries.md`).

This is the field inventory MEAL-35 asked for. It closes the "what can we get
without a network rail?" question for **search results**; it does **not** close
nutrition (see the gap at the bottom).

---

## Where it lives

```
<script id="__NEXT_DATA__">          →  JSON.parse(el.textContent)
  .props.pageProps.layout.visualComponents[]
    → the entry with __typename === 'SearchGridV2'   (id: "searchGridV2:<uuid>")
      .items[]                        →  __typename === 'Product'
        .SKUs[0]                      →  __typename === 'SKU'
```

The ticket's guess that the list sits under a `searchGridV2` key was right in
substance: it is the `__typename`/`id` of one entry in `layout.visualComponents`,
not a named key on `pageProps`.

**Coverage across `tests/fixtures/heb/` (14 files):**

| | Files |
| --- | --- |
| Search page with `__NEXT_DATA__` **and** a `SearchGridV2` | 8 |
| Search page with **no** `__NEXT_DATA__` at all (trimmed captures) | 2 — `search-results-yogurt-pairings-carousel.html`, `search-results-stale-hoisin.html` |
| Non-search pages with `__NEXT_DATA__` but no grid | 4 — 2 cart, 2 home |

On a search page the grid is the **only** visual component. The "perfect pairings"
entity carousel and the sponsored two-panel rail — both of which render
`data-component="product-card"` in the DOM, and which are why `__hebFindCards()`
exists — are client-fetched and appear **nowhere** in this payload. On the home
page, by contrast, `visualComponents` is 23 entries of `Carousel` /
`ContentDeliveryHeroGrid` / `ModuleCardSetV2`, each with its own `items`, so a
future reader of a non-search page must select on `SearchGridV2` rather than
`visualComponents[0]`.

Across the 8 search fixtures: **336 products**, and **every field below is present
on all 336** — the payload is uniformly shaped, with `null` (not absence) standing
for "not applicable".

---

## Grid-level fields

| Field | Example | Note |
| --- | --- | --- |
| `items` | 22–60 products | One page of results. **Capped at 60** — the two 60-item fixtures are truncated pages, not complete result sets |
| `total` | `38`, and `1962` for a 60-item page | The FULL result count, which equals `items.length` only when the results fit one page. Do not read it as "how many items are in this array" |
| `suggestedText` | `{ text: null, highlighted: null, reason: null }` | Spell-correction slot; null in all 8 |
| `relaxedResults`, `resultsOverrideApplied`, `resultsTitleOverride` | | Merchandising overrides |
| `filters`, `categoryFilters`, `categoryNavigations`, `parentCategory`, `sortOptions` | | Facet UI |
| `noShoppableProducts` | `false` | |
| `searchContextToken`, `requestId`, `rootRequestId` | | Would be needed to attribute a search server-side |
| `appliedRules`, `engineVersion` | | Which search ruleset served the page |

## Product fields (`items[]`)

**Identity**

| Field | Example | MEAL-14 relevance |
| --- | --- | --- |
| `id` | `"314026"` | **the productId** |
| `SKUs[0].id` | `"4122025475"` | **the skuId** |
| `SKUs[0].twelveDigitUPC` | `"041220254750"` | UPC, on all 336 |
| `productPageURL` | `/product-detail/h-e-b-regular-sour-cream-16-oz/314026` | id is the last path segment |
| `storeId` | `476` | the captured session's store |

**Naming** — `decodedDisplayName` is entity-decoded and byte-faithful to the card's
title text (it carries the real U+00A0 where HEB's `displayName` has a literal
`&nbsp;`), **except** that for each-priced items it omits the size:
`"Fresh Large Hass Avocado"` where the card reads `"Fresh Large Hass Avocado,
Each"`. The card renders `displayName + ", " + SKUs[0].customerFriendlySize`;
9 of 60 items in the avocado fixture need that append. `fullDisplayName` is a
third variant, equal to `decodedDisplayName` in every fixture item.

**Price** — `SKUs[0].contextPrices[]`, one entry per shopping context (`ONLINE` and
`CURBSIDE` in every fixture; they differ by ~5%). The card shows the entry matching
the product's own `shoppingContext` (`"CURBSIDE_DELIVERY"` → `CURBSIDE`). Each entry
carries `listPrice`, `salePrice`, `unitListPrice`, `unitSalePrice` — all four as
`{ amount: 2.4, formattedAmount: "$2.40", unit: "each" | "oz" }` — plus `isOnSale`
(true for exactly 1 of the 336), `isPriceCut`, `priceType`. **`amount` as a number is strictly better than what the
DOM path gets**, which is a `"$2.52"` string scraped out of nested leaf spans.

**Availability**

| Field | Example |
| --- | --- |
| `inventory.inventoryState` | `IN_STOCK` \| `OUT_OF_STOCK` (8 of 336 were OOS) |
| `availability.unavailabilityReasons` | `[]` in all 336 |
| `availability.schedule` | `null` in all 336 |
| `inAssortment` | `true` |
| `SKUs[0].productAvailability` | `["IN_STORE","CURBSIDE_PICKUP","CURBSIDE_DELIVERY"]` |
| `minimumOrderQuantity` / `maximumOrderQuantity` | min is `1`, or `0.25`/`0.5` for by-the-pound items; max ranges `4, 5, 6, 10, 20, 99, 999999999` across the 336 — **an order cap we do not read anywhere today** |

`SKUs` is an array but is length 1 for all 336 items, which is why MEAL-13 reads
`SKUs[0]`; a multi-SKU product would need a rule for choosing.

**Sold-by-weight** — `SKUs[0].weightSelectionIncrements` is the buyable lb list
(`[1,2,3,4,5]` for bulk coffee; `[0.25 … 10]` for a deli item), i.e. exactly what the
DOM path reads out of `<select name="addByWeight">`, and `pricedByWeight` is the
boolean. Non-empty on 75 of 336 items (37 of 40 in the bulk-coffee fixture).

**Preferences** — `purchasePreferenceList` = `{ label, purchasePreferences: [{ preferenceId, text, subtext }] }`.
Non-null on 2 of 336 items (avocado "ripeness", deli roast beef "thickness"), null
elsewhere. Three things the DOM path cannot get without clicking a tile's Add button
and reading the modal: the **`preferenceId`** (a stable uuid, vs. matching on the
visible label), the **`subtext`** (`"1-2 days"`), and the **`label`** naming the
dimension (`"ripeness"`).

**Images** — `carouselImageUrls[]` (bare `…/000314026-1`, 0–10 renditions; the card's
`<img>` requests `[0] + "?hei=360&wid=360"`, which MEAL-13 reproduces exactly) and
`productImageUrls[]` (`{ url, size: SMALL|MEDIUM|LARGE }`, always all three).
**7 of 336 items have an empty `carouselImageUrls`** and only `productImageUrls`; all
7 sit either in the stale-payload fixture or past the 8-candidate cap, so what the
card's own `<img>` uses for them is **not** verified.

**Merchandising / classification**

`brand` (`{ name, isOwnBrand }`), `productCategory` (`{ id, name }`),
`fullCategoryHierarchy` (`"Dairy & eggs/Sour cream"`),
`productLocation.location` (**the in-store aisle**, e.g. `"In Dairy on the Right
Wall, B15"` / `"Aisle 9, B20"`), `isEbtSnapProduct`, `onAd`, `showCouponFlag`,
`isNew`, `bestAvailable`, `pastPurchaseInfo` (populated on 11 of 336 — the capture
session's own purchase history), `analyticsProductProperties` (`isCrossSell`,
`isEveryDayLowPrice`, `isLimitedTimeOffer`, `isOwnBrandUpsell`),
`productPlacementContext` (non-null on 2 of 336; presumably a sponsored placement).

---

## The gap: no nutrition

**There is no nutrition data in this payload.** No nutrition, allergen, ingredient
statement, serving size, or calorie field appears on any of the 336 products — the
only `nutrition` matches anywhere in a fixture are storefront nav links
("Sports nutrition", "Nutrition Services") in the DOM, outside `__NEXT_DATA__`.

So MEAL-35's nutrition ask is **not** closeable from a search page. It would need
either the product-detail page's own payload (`/product-detail/<slug>/<id>`, not
captured) or a GraphQL query against the endpoint MEAL-12 established, and MEAL-12's
Imperva ABP constraint applies there unchanged.

## What is not verified here

- Everything is from captures, not a live session. Field **presence** is solid
  (336/336); field **stability across HEB deploys** is not something fixtures can
  speak to.
- All 8 search fixtures are from one store (`storeId: 476`) in one shopping context
  (`CURBSIDE_DELIVERY`). A pickup-only or in-store context may quote a different
  `contextPrices` set.
- `suggestedText`, `relaxedResults` and `productPlacementContext` are null/empty in
  every fixture, so their populated shapes are unknown — which is also why MEAL-13's
  freshness gate treats a spell-corrected `searchTerm` as a reason to fall back to
  the DOM rather than trying to match it.
