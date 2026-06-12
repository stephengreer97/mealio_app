# Maestro E2E flows for the Mealio app

These flows exercise the full React Native app on a simulator/emulator or
on a real device. They drive the UI through actual taps and reads, not
through any internal API.

## Install Maestro

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
# adds maestro to ~/.maestro/bin — make sure it's on PATH
```

## Run a flow

The app must already be running on a device or simulator (e.g. via
`npx expo start --ios` or `--android`).

```bash
# iOS Simulator
maestro test tests/e2e/maestro/flows/login.yaml

# Connected device or emulator
maestro test --device <udid> tests/e2e/maestro/flows/add-meal-to-cart.yaml

# Run all flows
maestro test tests/e2e/maestro/flows/
```

## Flows

| File | What it covers |
| --- | --- |
| `login.yaml` | Email + password login → land on Discover |
| `signup.yaml` | New account creation → email verification stub → 2FA → home |
| `add-meal-to-cart-wegmans.yaml` | Open a saved meal, pick Wegmans, walk through choose-flow review, watch the in-cart-confirmation banner |
| `creator-apply.yaml` | Apply to become a creator from the Account screen |

## Auth credentials

Maestro flows use the same test account as the live store tests. Email
+ password are read from environment vars at run time:

```bash
export MEALIO_TEST_EMAIL="test@example.com"
export MEALIO_TEST_PASSWORD="..."
maestro test tests/e2e/maestro/flows/login.yaml
```

The flows reference `${MAESTRO_USER_EMAIL}` and `${MAESTRO_USER_PASSWORD}`
internally; the `env:` block at the top of each YAML maps from the env
vars above.

## Selecting elements: text vs id

Maestro can match on:
- `text:` (visible text — fastest to write, brittlest)
- `id:` (testID prop in React Native — most stable, requires source change)

Mealio's components don't have `testID` props yet. Phase 4 flows match by
text. If a flow becomes flaky as copy changes, add `testID` props to the
relevant components and switch the flow to `id:` selectors.

## CI / non-interactive runs

Maestro Cloud is the recommended runner for CI. Local Maestro is fine for
dev iteration but doesn't have an obvious headless mode — keep CI-bound
flows separate from rapid-iteration ones.
