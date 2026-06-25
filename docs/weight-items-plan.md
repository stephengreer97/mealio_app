# Plan: weight / by-the-pound items (detected increments)

Status: **plan — not yet implemented.** Blocked on capturing the HEB weight
dropdown fixtures (see "Prerequisite" below).

## Problem

Some store products are sold **by weight**, not by discrete quantity (HEB Deli,
Fish Market, and bulk items like "CAFE Olé … Bulk Coffee, lb"). Their tile shows
a **weight dropdown** (e.g. `0.25 lb`, `0.5 lb`, …) instead of an Add button.

Today the automation hardcodes one assumption — `targetLbs = qty * 0.25` in
`heb.ts handleWeightDropdown`. That breaks whenever the increment isn't 0.25 lb,
and there's no user-facing way to choose how much weight to buy. The cart
snapshot also can't reconcile these (they land as ~0 count and get falsely
retried).

## Model (agreed)

Make **qty 1-to-1 with the dropdown's weight increment**, detected from the live
dropdown instead of assumed:

- `weight = qty × increment`, where `increment` is read from the dropdown.
- The choose-product qty picker steps by one increment and **displays the
  weight**; the DB stores `qty` = number of steps.
- Add-to-cart selects the `qty`-th dropdown option.
- The cart snapshot reads the weight.

Example: a `0.5 lb` dropdown → the picker steps `0.5 lb, 1.0 lb, …`; two `+`
clicks shows `1.0 lb`, stored as **qty 2**; add-to-cart selects the `1.0 lb`
option.

**Refinement — index-based, not strictly `qty × increment`.** Map `qty` to the
**Nth dropdown option** (1-based). For uniform steps this equals `qty ×
increment` (the common case); for non-uniform dropdowns (`0.25, 0.5, 1, 2, …`)
the index mapping still holds. Present uniform steps as the default UX.

## Prerequisite (before building)

Capture the real dropdown DOM so the extract logic is written against fact, not
assumption. Two fixtures were added to the HEB admin capture walkthrough
(`fixture-capture-config.ts`), both using the bulk-coffee example:

- `search-results-weight-dropdown-closed.html` — the tile + dropdown control,
  un-opened (tells us whether the options live in a native `<select>` already in
  the DOM, or a custom control).
- `search-results-weight-dropdown-open.html` — the dropdown opened, options
  visible (the rendered weight values → the increment).

Open the **Admin → Fixture Capture → HEB** flow, capture both, and commit them to
`tests/fixtures/heb/`. The closed/open pair tells us **where** the weight options
live and **how** to read them, which decides the extract implementation.

## Implementation (five touch points)

1. **Extract** (`heb.ts` extractProductsScript + worker): for a weight item, read
   its dropdown options → emit `weightOptions: number[]` (the lb values, in order)
   on the candidate, alongside the existing `isWeightItem`. Derive `increment`
   from the options (consecutive diff; flag non-uniform).
2. **Types + DB write**: carry weight info on the ingredient. Reuse the existing
   ingredient fields — `unit: 'lb'`, `measure: <increment>`, `qty: <steps>` — so
   **no schema migration**. Keep this distinct from the existing `dropdown` field,
   which holds the *preference* modal choice (deli slicing thickness), not weight.
3. **Choose-product UI** (`WebViewCartSheet` review/choose step + the Add-to-Cart
   review sheet): when the selected candidate is a weight item, the qty stepper
   steps through `weightOptions` and the label shows the **weight** (`0.5 lb`)
   rather than a count. `chooseQty` / review qty becomes the option index.
4. **Add-to-cart** (`heb.ts` buildSearchAndAddScript / buildAddToCartScript): in
   the now-scoped `handleWeightDropdown`, select the `qty`-th option (or the
   option closest to `qty × increment`) instead of `qty * 0.25`. Pass the
   detected option set / increment through from the ingredient.
5. **Snapshot + reconcile** (`cart-count.ts` HEB cart-page script +
   `WebViewCartSheet` reconcile): the cart-page script tags weight lines
   (name ends `, lb` / weight unit) and reads their weight. Reconcile confirms a
   weight item by **presence / weight ≈ expected**, not a discrete count
   shortfall — so a correctly-added weight item isn't re-added.

## Tests

- Fixture tests against the two new HEB fixtures: extract reads the correct
  `weightOptions` / increment from both the closed and open DOM.
- A cart-page fixture with a `, lb` weight line → snapshot reads the weight; a
  reconcile unit test confirms a weight item by weight, not count.
- (Stretch) a mock-store weight scenario once the engine logic is pure-testable.

## Open questions (resolve after capturing fixtures)

- Native `<select>` (options always in DOM) vs custom `[role="listbox"]`
  (options only render when open)? Decides whether the closed fixture is enough
  or we must drive the open state during extract.
- Does the weight picker live on the search tile, or only after clicking Add
  (a modal)? Decides the extract/probe path.
- Min order weight / non-uniform steps — confirm against the captured options.
