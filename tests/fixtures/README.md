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
   `src/lib/webview-scripts/<store>.ts`
4. Re-run the tests until green

## .gitignore policy

The HTML fixtures **are committed** to the repo — they're a deliberate snapshot
of the store's DOM at a known-good time. Don't gitignore them.

If a fixture contains personally-identifying info (cart contents, address,
account name beyond first name), redact those fields by hand before committing.
The capture script doesn't try to scrub.
