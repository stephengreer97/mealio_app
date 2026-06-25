# Mock store — deterministic e2e target for the cart flow

The existing Maestro flows (`tests/maestro/flows/`) are guest/auth/UI smoke
tests. The **core product** — the add-to-cart automation — has no end-to-end
coverage because it needs a real store login (2FA, WAF, anti-bot, flakiness).

This mock store removes that dependency: a deterministic fake storefront the
WebView cart engine drives exactly like a real store, so Maestro can exercise the
whole flow (login → search → choose → add → cart-count confirm → snapshot →
reconcile → skip → parallel).

## Where it lives

The storefront is a **standalone Vercel app** (repo `mealio_mock_store`), so the
WebView loads a real remote https site — real DNS/TLS/navigation/cookies, not
just localhost. State is a `mock_cart` cookie the WebView carries (serverless-
friendly). See that repo's README for scenarios, deploy, and the DOM contract.

The mobile side here:

| Piece | Where |
|---|---|
| WebView adapter (`mockstore` store id) | `src/lib/webview-scripts/mockstore.ts` |
| Cart snapshot script + URL | `src/lib/webview-scripts/cart-count.ts` (`mockstore`) |
| Registration | `getStoreScripts` + `STORES`, both gated on `MOCK_STORE_ENABLED` |
| Flow scaffolds (not yet auto-run) | `tests/mock-store/maestro/` |

## Gating (Option B — E2E flag)

`MOCK_STORE_ENABLED = __DEV__ || EXPO_PUBLIC_E2E === '1'`. So the mock store shows
up as **"Mock Store"** in the store list in local dev (`__DEV__`) and in the e2e
build, and is excluded from production (the flag is unset there).

- **`EXPO_PUBLIC_MOCK_STORE_URL`** — the deployed mock-store URL (defaults to
  `https://mealio-mock-store.vercel.app`). Set it in the `ios-simulator` EAS
  profile (already wired in `eas.json`) and/or a local `.env`.
- **`EXPO_PUBLIC_E2E=1`** — enables the mock store in a non-dev build. Set in the
  `ios-simulator` EAS profile so the Maestro CI build (which is
  `environment: production`, so `__DEV__` is false) still registers it.

## Maestro flows — remaining work

Scaffolds live in `tests/mock-store/maestro/` (NOT in `tests/maestro/flows/` yet,
so CI doesn't auto-run them — keeps the green CI safe until verified).

**Done:** the storefront is deployed (`https://mealiomockstore.vercel.app`, wired
in `eas.json`), and all six flows are written against the real UI with testIDs:
`login-email` / `login-password` / `login-submit`, `floating-add-to-cart`,
`candidate-{i}`, `cart-status-bubble`, plus the existing `cart-progress-fill` /
`cart-row-added` / `cart-check-warning`.

The flows are: `10` happy · `11` choose (`multi`) · `12` no-results→skip
(`noresults`) · `13` out-of-stock (`oos`) · `14` reconcile (`failadd`) · `15`
parallel. The real cart flow is: My Meals → tap the **Mock Store** filter pill →
tap the seeded meal → **floating-add-to-cart** → (dismiss the one-time popup) →
the job collapses to the **cart-status-bubble**; tap it to resolve choose/skip or
to open the done snapshot.

### Seed the test account (one-time)

Log in as the test account in a dev/e2e build and save these meals at **Mock
Store** (the scenario rides in the ingredient term):

| Meal name | Ingredient term(s) |
|---|---|
| `E2E Happy` | `milk`, `eggs`, `bread` (default → auto-add) |
| `E2E Choose` | `cheese multi` |
| `E2E Skip` | `rice noresults` |
| `E2E OOS` | `soda oos` |
| `E2E Reconcile` | `ham failadd` |
| `E2E Parallel` | `milk`, `eggs`, `bread`, `butter` |

### Remaining

1. **First local run** on a simulator (`maestro test tests/mock-store/maestro/10-cart-happy-path.yaml`)
   to confirm the two text-based taps (the store pill, the one-time popup label)
   and the bubble timing. Adjust selectors as needed.
2. Once green, **move the flows into `tests/maestro/flows/`** and add the
   `MEALIO_TEST_EMAIL` / `MEALIO_TEST_PASSWORD` secrets to `ios-maestro.yml`.
   No local server or build change needed (the store is hosted; the e2e env is
   already in `eas.json`).
