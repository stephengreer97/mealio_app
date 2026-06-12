# Live store tests

These tests run against **real grocery store websites** using real credentials.
They're gated behind the `MEALIO_RUN_LIVE_TESTS=1` env var so they don't
fire on every `npm test`. The npm script `test:live` sets that var.

## What every live test does

Every live test follows this contract (enforced by `buildLiveSuite`):

```
beforeEach: fresh browser context (zero cookies)
test body:  login → assertions → maybe cart ops
afterEach:  clearCart → logout → close context   (best effort, even on test failure)
```

The key point: **every test starts and ends from a verified logged-out
state**. This means:
- Each test re-validates login detection independently
- The real test account's session is cleared between runs (no stale cookies)
- The real cart is emptied between runs (no accumulated junk)

## CHECK_LOGIN_SCRIPT coverage (auto-generated per store)

Each store's `buildLiveSuite` call auto-generates three tests verifying
`CHECK_LOGIN_SCRIPT`:

1. **Logged-out detection** — fresh context, navigate to homepage, inject
   the script, expect `LOGIN_STATUS:false`.
2. **Logged-in detection** — login, inject script, expect `LOGIN_STATUS:true`.
3. **Post-logout detection** — login, logout, inject script, expect
   `LOGIN_STATUS:false` again.

If a store's CHECK_LOGIN_SCRIPT has a bug (false positive, race with page
hydration, MSAL bootstrap timing, etc), at least one of these tests fails.

## Credentials

Credentials live in `creds.json` (not committed) which is decrypted from
`creds.json.gpg` (committed) at the start of each test run.

Generate the encrypted file:

```bash
cp tests/live/helpers/creds.example.json tests/live/creds.json
# Edit creds.json with real test-account credentials
gpg --symmetric --cipher-algo AES256 tests/live/creds.json
# Set passphrase to the value you'll export as MEALIO_TEST_CREDS_KEY
rm tests/live/creds.json   # never commit unencrypted
```

Then to run tests:

```bash
export MEALIO_TEST_CREDS_KEY="your-gpg-passphrase"
npm run test:live -- wegmans
```

The runtime decrypts to a temp file, reads it, then deletes the temp file
on test end. The plaintext never persists on disk.

## Per-store helpers

Each store has three helpers in `helpers/`:

| File | Required | Purpose |
| --- | --- | --- |
| `login-<store>.ts` | yes | Navigate to login, fill credentials, complete 2FA, verify. |
| `logout-<store>.ts` | yes | Sign the test account out and verify the session ended. |
| `clear-cart-<store>.ts` | optional | Empty the cart. Only needed if the suite adds to cart. |

## When 2FA is enabled

The login helpers all accept `{ allowManual2faMs: <ms> }` (or `allowManualMs`)
options that, when set, pause the helper waiting for you to complete 2FA
in the browser. If you run tests headfully (`HEADFUL=1 npm run test:live`),
this is straightforward.

For unattended runs, **disable 2FA on the test account**. The flag exists
to support interactive debugging, not as a long-term workaround.

## Running selectively

```bash
npm run test:live -- wegmans          # one store
npm run test:live -- heb walmart      # several
npm run test:live                     # all 6 stores — slow! (>5 min)
HEADFUL=1 npm run test:live -- wegmans  # visible browser (debug)
```

## What happens on failure

If a test fails mid-add (item added but assertion failed before cleanup),
the `afterEach` cleanup still runs — `clearCart` then `logout` then close.

If cleanup itself fails (rare — typically because the store's logout UI
moved), the test reports both errors. Manually clear the cart and sign
out, then re-run.

## Why these tests are slow

Per test:
- Browser context setup: 1-2s
- Login: 10-20s (page loads + form fill + sometimes 2FA prompt)
- Assertions: 1-15s (depends on what the test does)
- Logout: 5-10s

Per store with the 3 auto-generated tests: ~90-120s. For all 6 stores: ~10
minutes. Expected.

## Adding a new store

1. Add the store to `tests/live/helpers/creds.example.json`.
2. Write `login-<store>.ts` and `logout-<store>.ts` (and optionally
   `clear-cart-<store>.ts`).
3. Create `<store>.live.spec.ts` and call `buildLiveSuite({ ... })`.
4. Add the store's encrypted creds to your `creds.json.gpg`.
5. Run `npm run test:live -- <store>` and iterate on selectors until green.
