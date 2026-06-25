# Testing Recommendations

A standing assessment of where Mealio's automated testing is strong, where the
real gaps are, and what to invest in next. Written after building the mock-store
Maestro suite (June 2026). Revisit this when planning test work.

## TL;DR — the two highest-value next steps

1. **Real-store DOM-drift detection** — covers the gap nothing else does.
2. **Extract the cart reconcile/decision logic into pure, unit-testable
   functions** — cheap to write, catches the class of bug we keep hitting.

---

## What is well covered today

- **Unit tests** (`tests/unit`, ~113): api mappers, `diffCartItems`,
  `normalizeIngredients`, and other pure helpers. Fast and reliable.
- **Fixture tests** (`tests/fixture-tests`): per-store extract scripts run in a
  headless browser against captured HTML snapshots (ALDI, Walmart, Wegmans, HEB,
  Albertsons, Amazon Fresh). Validates the parsing/extraction logic.
- **Maestro smoke flows** (`tests/maestro/flows`): app launch, guest screens,
  screenshot tour — the required, blocking CI lane.
- **Mock-store Maestro suite** (`tests/mock-store/maestro`, flows 10–15): full
  end-to-end cart-flow coverage against a controllable Vercel-hosted store —
  login detection, search/add, cart snapshot, and every reconcile branch
  (auto-add, choose-product, skip, out-of-stock, qty-reconcile, parallel). Runs
  as a non-blocking bring-up step on an EAS iOS-simulator build.
- **CI infra**: EAS build + iOS simulator, per-flow retry, `clearKeychain` per
  flow, hidden-file debug-artifact upload, creds via `-e`.

---

## The gaps that matter

### 1. Real-store DOM-drift detection (highest real-world risk)

The mock store proves the **engine** works. It cannot catch the single most
likely production failure: **a store redesigning its DOM** so the selectors stop
matching. Fixtures share this blind spot — they are static snapshots, so when a
store changes its markup the fixture test stays green while real carts silently
break.

**Recommendation:** a periodic canary that exercises the *live* stores —
residential-IP Playwright from a home machine, or a scheduled fixture-recapture
job that diffs fresh captures against the committed fixtures and alerts on drift.
This is the most valuable testing investment available. (Tracked as the
"Store DOM drift detection" stretch item.)

### 2. Pure-function unit tests for the cart decision logic (high value, moderate effort)

The brittle core — auto-pick scoring, out-of-stock/no-results routing, the
consume-pool reconcile, qty-shortfall top-up — currently lives inline in
`WebViewCartSheet` and is only exercised by slow, flaky Maestro flows. The
recent "pepper double-count" bug (two near-identical product names cross-counting
in reconcile, masking a per-item shortfall) would have been caught instantly by a
unit test feeding `(workerResults, cartRows, expectedQtys) → {confirmed, retry,
review}`.

**Recommendation:** extract the reconcile/decision logic into pure functions and
unit-test the permutations (multiple OOS, mixed qty + OOS, near-identical names,
partial adds). Far faster and more thorough than Maestro for edge cases.

### 3. Smaller, concrete items

- **Programmatic seeding in CI.** The mock-store flows depend on `seed.sql` run
  by hand; if the test account drifts, flows break for non-code reasons. Seed via
  the service-role API in a CI setup step for determinism.
- **Promote mock-store flows to blocking** once stable across several runs (they
  are non-blocking bring-up today), and add the **parallel-OOS regression flow**
  (multi-ingredient meal, one ingredient out of stock) to cover the reconcile
  OOS-surfacing fix.
- **Harden `inputText` flakiness.** A character-reorder flake once produced
  `test@malio.coe` and a failed login. Set `autoCorrect={false}` on the email
  field in E2E builds and assert the typed value before submit so corruption
  fails loudly instead of silently.

### 4. Platform gaps (tracked, worth flagging)

- **No Android e2e.** Maestro runs iOS-only, but Android WebView differs
  meaningfully (the reason for the dynamic-UA / WAF work). An Android Maestro lane
  for smoke + mock-store would catch Android-specific breakage that is currently
  invisible.
- **iOS 18.5, not current.** CI runs whatever the `macos-15` runner ships
  (Xcode 16 → iOS 18.x). Given how many iOS-specific issues surfaced building the
  suite (keyboard covering the submit button, Strong-Password autofill swallowing
  secure-field input, `hideKeyboard` unsupported on the sim), eventually testing
  on a current-iOS runner is worth it.

---

## iOS / Maestro gotchas learned (reference)

Captured so the next person doesn't re-derive them:

- Maestro does **not** import shell env into `${...}` interpolation — pass values
  with `-e KEY=VALUE` or the flow's `env:` block resolves them to the literal
  string `"undefined"`.
- iOS **Strong-Password AutoFill** on a `secureTextEntry` field swallows Maestro's
  injected text (RN `onChangeText` never fires). Use a plain field + autofill off
  in E2E only.
- The on-screen **keyboard covers the submit button**; tapping it lands on the
  keyboard. `hideKeyboard` is unsupported on the iOS sim — use `pressKey: Enter`
  to drop it.
- `expo-secure-store` keeps the auth token in the **keychain**, which
  `clearState` does NOT wipe — add `clearKeychain: true` so each flow starts
  logged out.
- A `TouchableOpacity` **absorbs its child text** into one accessibility label, so
  `tapOn: "Some Text"` fails — add a `testID`, or match with a wrapped
  `.*Some Text.*` regex (Maestro anchors the regex to the full label).
- Upload-artifact skips Maestro's debug output because it lives under a **hidden**
  `.maestro/` dir — set `include-hidden-files: true`.
- A store's patient extract (ALDI waits ~10s for a stale→fresh SPA transition that
  never happens on a static fixture) needs a generous test timeout, not 12s.
