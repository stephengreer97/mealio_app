# Fixture HTML

These are recorded snapshots of each grocery store's pages, used by the fixture
test suite. Each store has its own subdirectory.

## Capturing fixtures

```bash
npm run capture -- wegmans
```

This launches a non-headless Chromium pointed at the store's homepage. **You'll
be prompted to log in manually** (the browser stays open so you can complete any
2FA, store selection, etc). When you press Enter in the terminal, it navigates
through each fixture URL and saves the HTML to disk.

## Fixture set per store

| File | Source URL | Purpose |
| --- | --- | --- |
| `logged-in-home.html` | homepage in your authenticated session | tests `LOGIN_STATUS:true` detection |
| `search-results-*.html` | search URLs for specific queries | tests EXTRACT_PRODUCTS and SEARCH_AND_ADD against real product tiles |
| `cart-with-items.html` | `/cart` while items are in the cart | tests cart-state detection and CART_DEBUG output |

## When fixtures go stale

Stores update their DOM occasionally. Symptoms:
- A previously-passing fixture test now fails on `tiles_found count: 0`
- `LOGIN_STATUS` posts an `error` field
- `extract_products` returns empty `candidates`

When that happens:
1. Re-run `npm run capture -- <store>`
2. Inspect the diff (`git diff tests/fixtures/<store>/`)
3. If selectors changed, update the relevant store script in
   `src/lib/webview-scripts/<store>.ts`. Some stores share a *platform adapter*
   rather than owning a file: the Albertsons banners live in `albertsons.ts`,
   and the Instacart Storefront banners (ALDI) live in `instacart.ts`. Editing
   one of those changes every banner on that platform — check the blast radius.
4. Re-run the tests until green

## Platform adapters need fixtures per banner

`albertsons.ts` and `instacart.ts` each drive several storefronts from one set
of selectors. That the platform serves the same URL contract to every banner
does **not** mean it serves them the same DOM, and the selectors in each adapter
were read off one specific banner (Albertsons; ALDI).

So a banner added to a platform adapter is not supported until it has its own
captures in `tests/fixtures/<storeId>/` and a spec modelled on the reference
banner's. `tests/unit/webview-scripts/instacartAdapter.test.ts` enforces this
for Instacart tenants — registering one without fixtures fails the suite.

## .gitignore policy

The HTML fixtures **are committed** to the repo — they're a deliberate snapshot
of the store's DOM at a known-good time. Don't gitignore them.

If a fixture contains personally-identifying info (cart contents, address,
account name beyond first name), redact those fields by hand before committing.
The capture script doesn't try to scrub.
