# Mock store — deterministic e2e target for the cart flow

The existing Maestro flows (`tests/maestro/flows/`) are guest/auth/UI smoke
tests. The **core product** — the add-to-cart automation — has no end-to-end
coverage because it needs a real store login (2FA, WAF, anti-bot, flakiness).

This mock store removes that dependency: a tiny deterministic fake storefront the
WebView cart engine drives exactly like a real store, so Maestro can exercise the
whole flow (login → search → choose → add → cart-count confirm → snapshot →
reconcile → skip → parallel).

## Pieces

| Piece | Where |
|---|---|
| Fake storefront server (zero-dep Node) | `tests/mock-store/server.js` |
| WebView adapter (`mockstore` store id) | `src/lib/webview-scripts/mockstore.ts` |
| Cart snapshot script + URL | `src/lib/webview-scripts/cart-count.ts` (`mockstore`) |
| Registration | `getStoreScripts` (dev-gated) + `STORES` (dev-gated) |
| Flow scaffolds (not yet auto-run) | `tests/mock-store/maestro/` |

The mock store is registered **only in dev/test builds** (`__DEV__`): it appears
in the store list as **"Mock Store"** and `getStoreScripts('mockstore')` returns
`null` in production.

## Run it

```bash
npm run mock-store          # listens on http://localhost:8788
MOCK_STORE_PORT=9000 npm run mock-store
```

Then, in a **dev build** on the iOS Simulator, save a meal at "Mock Store" and run
add-to-cart. The WebView loads `http://localhost:8788` (reachable from the
simulator's localhost).

## Scenario control (rides in the ingredient/search term)

A Maestro flow just gives a meal ingredients whose names encode the scenario
(case-insensitive substring):

| Term contains | Behaviour | Exercises |
|---|---|---|
| *(default)* | 3 candidates, first is an exact match → auto-adds | happy path |
| `multi` | 5 candidates, none exact | **Choose Product** UI |
| `oos` | candidates present but out of stock | review / skip |
| `noresults` | 0 candidates | no-results review → **Skip** |
| `failadd` | first add silently doesn't persist (badge bumps optimistically) | **reconcile** re-adds |

`GET /reset` clears the cart; `GET /state` returns it as JSON (test setup/asserts).

## DOM contract (stable — it's ours)

```
<body data-logged-in="true">                          login state
.mock-product[data-name][data-price][data-oos]        a search result tile
  button[data-qe="add"][data-name][data-failadd]      its add button ("N added")
#mock-cart-count                                       header cart badge total
.mock-cart-line[data-name] .mock-cart-qty             a cart line on /cart
```

## Maestro flows — TODO (tomorrow)

The flow scaffolds live in `tests/mock-store/maestro/`. They are **not** in
`tests/maestro/flows/` yet because the CI auto-runs everything there and these
have two unmet dependencies:

1. **Dev build in CI.** The mock store only registers under `__DEV__`. The
   `ios-maestro.yml` prebuilt app must be a dev/debug build for "Mock Store" to
   appear. (The current workflow's build profile needs checking.)
2. **A logged-in test account with a seeded `mockstore` meal.** The cart flow
   needs a signed-in Mealio user who has a saved meal at the mock store. Regular
   (non-creator) accounts skip 2FA, so a dedicated test account can log in with
   just email+password. Store creds as GH secrets; seed a meal at `mockstore`
   (either pre-seed server-side or have the flow create one in-app).

Planned flows: `10` happy path · `11` choose-product (`multi`) · `12`
no-results→skip (`noresults`) · `13` out-of-stock (`oos`) · `14` reconcile
(`failadd`) · `15` parallel (multi-ingredient meal).

### CI wiring (to add to `.github/workflows/ios-maestro.yml` once the above is ready)

Add a step before "Run Maestro flows" to boot the server:

```yaml
      - name: Start mock store
        run: |
          node tests/mock-store/server.js > mock-store.log 2>&1 &
          for i in $(seq 1 20); do curl -sf http://localhost:8788/state && break || sleep 0.5; done
          curl -sf http://localhost:8788/reset
```

Then move the `tests/mock-store/maestro/*.yaml` flows into
`tests/maestro/flows/` so they're picked up by the existing glob.
