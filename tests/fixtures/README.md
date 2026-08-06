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
- `npm run drift` reports a selector that stopped matching (see below — this one
  fires *before* the three above, which is the point of it)

When that happens:
1. Re-run `npm run capture -- <store>`
2. Run `npm run drift -- <store>` — it names which selectors moved
3. Inspect the diff (`git diff tests/fixtures/<store>/`)
4. If selectors changed, update the relevant store script in
   `src/lib/webview-scripts/<store>.ts`. Some stores share a *platform adapter*
   rather than owning a file: the Albertsons banners live in `albertsons.ts`,
   and the Instacart Storefront banners (ALDI) live in `instacart.ts`. Editing
   one of those changes every banner on that platform — check the blast radius.
5. Re-run the tests until green, then accept the new shape with
   `npm run drift -- <store> --update` and commit the baseline alongside the
   fixtures

## Drift detection (MEAL-30)

```bash
npm run drift                     # every store
npm run drift -- heb walmart      # just these
npm run drift -- --standing       # also list selectors dead in every fixture
npm run drift -- heb --update     # accept the new shape
npm run drift -- --json           # machine-readable, for a scheduled caller
npm run drift -- --fixtures DIR   # census a capture tree somewhere else
```

Exit code is 1 when something drifted, so a scheduled caller needs no output
parsing. The same comparison runs in CI as
`tests/fixture-tests/selector-drift.spec.ts`.

**What it compares.** Not the markup — the *selectors' view* of the markup. For
every selector the store scripts resolve (call-site fallbacks merged with the
automation config, so a platform-level selector is covered too), it records how
many elements that selector matches in each fixture, coarsened to
`none` / `one` / `multi`, and reports only when that changes. Two `multi`s are
never compared, so a recapture whose search returned 19 products instead of 38 is
silent, as is a new ad slot on a page where the selector already matched 622
elements. What survives is the set of changes that break code: a selector that
matched something now matches nothing, or a selector that named exactly one thing
(a search grid, a container the scripts scope to) now names several.

**Comma-branches are counted separately, and that is where the early warning comes
from.** Most selectors here are deliberately broad alternations. The union
surviving means automation still runs; it does not mean the store still renders the
primary hook. Walmart's `card` is
`[data-automation-id="product"], [data-item-id]`, and the first branch already
matches zero elements in every committed fixture — `[data-item-id]` carries the
whole thing. `npm run drift -- --standing` lists all 23 targets in that state
today. A branch dying while the union survives is a warning with the branch named,
which is exactly the "markup changed but nothing is broken yet" alert this is for.

**HEB has two surfaces.** MEAL-13 added a `__NEXT_DATA__` JSON reader behind the
`nextDataSearch` flag, so HEB drift can happen in the markup *or* in the payload.
The JSON side is censused too: whether a `SearchGridV2` resolves, whether the
freshness gate can still prove the payload belongs to its search, and what share
of the grid's items carry each field the mapper reads. Every failure mode of the
JSON path degrades silently back to the DOM scrape by design, so nothing goes red
when it breaks — this is the only place it can be seen.

**The baseline records shapes, not counts.** `tests/drift/selector-baseline.json`
holds buckets only, so a recapture that changed nothing structural produces an
*empty* diff on it, and one that did produces a diff containing exactly the drift.
That diff is the artifact to attach to an alert.

**Caveat that limits what this can ever check:** the fixture runner blocks
stylesheets, so `d-none` never applies and CSS-hidden markup is present and
readable. Any visibility-based reasoning is invalid against a fixture. The census
counts matches and never asks whether a user could see them.

## Scheduled recapture — what is still missing

MEAL-30 asks for a weekly refresh per store. The **capture** half is not
implementable from CI and is not implemented here:

- Recapture must egress from a **residential IP**. GitHub-hosted runners use
  well-known cloud ranges, and H-E-B and Albertsons answer those with a challenge
  page, so a hosted job would faithfully capture a bot wall and the drift check
  would report every selector as dead.
- MEAL-7 owns that runner (self-hosted, on the WSL box) and **it does not exist
  yet** — MEAL-7 is in the backlog and `.github/workflows/` has nothing
  self-hosted. MEAL-30 says explicitly not to build a second scheduling
  mechanism, so nothing here schedules anything.
- Capture also needs a logged-in session per store. `npm run capture` is
  interactive for that reason (manual login, 2FA, store selection), and the
  fixture set includes states only a human can produce — an opened stepper, a
  preference modal, an item in the cart.

When MEAL-7's runner lands, the drift half plugs into it as three commands, no new
scheduling and no new code:

```bash
npm run capture -- <store>                    # residential IP + a live session
npm run drift   -- <store> --json > drift.json   # exit 1 ⇒ raise the alert
git diff tests/fixtures/<store>               # attach this for triage
```

Two properties worth knowing before wiring that up: `npm run capture` overwrites
fixtures in place, so a runner that does not want to dirty the tree should capture
to a scratch directory and point the census at it with `--fixtures DIR`; and the
alert is only as good as the capture, so a run that produced a challenge page will
report *every* selector as dead — treat a store-wide wall of `died` findings as
"the capture failed", not "the store was rewritten".

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
