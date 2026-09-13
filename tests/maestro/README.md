# Maestro iOS UI tests

Black-box UI flows that exercise the actual built app on an iOS Simulator.
Catches regressions that the Jest layer can't see: native crashes,
navigation bugs, screens that render blank, splash screens that never
clear, form fields that don't accept input.

This layer is intentionally THIN. Most of mealio's logic is covered by
the Jest unit / component / fixture suites in `tests/unit`, `tests/components`,
and `tests/fixture-tests`. Maestro is here to validate that the assembled
binary actually boots and the user can get past the first screen.

## Running locally (requires macOS)

You can't run Maestro for iOS from Windows or Linux — Apple's tooling is
macOS-only. If you have access to a Mac:

```bash
# One-time install
curl -fsSL https://get.maestro.mobile.dev | bash

# Build a development client for the simulator
npx expo run:ios

# Once the simulator is showing the login screen, run the flows
cd ~/mealio_app
maestro test tests/maestro/flows
```

For interactive flow authoring, run `maestro studio` in a second terminal.
It opens a web UI that mirrors the simulator and lets you click around to
generate `tapOn` / `assertVisible` lines.

## Running in CI (no Mac needed)

`.github/workflows/ios-maestro.yml` runs these flows on a GitHub-hosted macOS
runner every PR into `main` and every push to `main`. **GitHub never compiles
the app** — the binary comes from EAS:

1. `wait-for-eas` (ubuntu) finds the `ios-simulator` build for this commit,
   waiting if one is in flight.
2. If there is no build for the commit it falls back to the newest finished
   one, and **refuses a fallback more than 14 days old**. A flow-only change
   riding yesterday's binary is what the fallback is for; a green tick against
   a binary from two months ago is not a smoke test, and this lane spent two
   months proving that.
3. `ios-maestro` (macOS) downloads that artifact, boots a simulator, installs
   it, and runs each flow with a `sudo purge` and one retry between them.

Kick a commit-exact build whenever app code changes:

```bash
eas build --platform ios --profile ios-simulator --no-wait
```

## First run gets in the way, on purpose

Every flow launches with `clearState: true` **and `clearKeychain: true`**, which
together are genuinely a first run, so the welcome sheet covers Discover before
any of them can see the meal list.

`clearKeychain` is load-bearing, not belt-and-braces. The first-run flags live in
`expo-secure-store`, which is the keychain, and `clearState` does not touch it.
With only `clearState`, whichever flow ran first dismissed the sheet **for every
flow after it** — so the flows were not independent, and a flow passed or failed
depending on what ran before it.
`../subflows/dismiss-welcome.yaml` waits for it and taps through, and every flow
runs it immediately after `launchApp`.

**A new first-run modal will break all of them at once**, with the same line in
each: an assertion about a Discover element that is simply behind something. If
that happens, dismiss the new thing in that subflow rather than in seven flows.

Dismiss it by its **text**, not by a `testID` on the `<Modal>`. React Native
does not surface a Modal's own testID as a queryable view on iOS — the content
is presented in its own `UIWindow` — so a flow waiting on that id times out
against a sheet that is plainly on screen. The modal's contents are visible to
Maestro; its wrapper is not.
7. Upload a JUnit-formatted report. On failure, upload a screenshot of the
   simulator at the moment of failure.

Expect ~25-30 minutes per run because of CocoaPods + xcodebuild.
CocoaPods is cached between runs so subsequent runs are faster.

**Cost note**: macOS GitHub-Actions minutes are billed 10x the standard
rate on the private-repo free tier (2000 minutes/month → ~6-7 iOS runs).
If you find yourself iterating fast on flows, expect to either pay for
more macOS minutes or get a Mac.

## Writing new flows

One YAML file per flow under `tests/maestro/flows`. The numeric prefix
(`01-`, `02-`) orders execution. Maestro picks them up automatically.

Minimal flow shape:

```yaml
appId: co.mealio.app
---
- launchApp:
    clearState: true
- assertVisible: "Welcome back"
- tapOn: "Sign In"
- assertVisible: "Email is required"
```

Useful patterns:

- `tapOn: text-or-id` to tap anything visible
- `inputText: "abc"` types into the focused field
- `assertVisible:` accepts a string, an `id:`, or a regex
- `swipe: { from: {x: 0.5, y: 0.8}, to: {x: 0.5, y: 0.2} }` scrolls
- `runScript: file.js` runs JS over the page state (rarely needed)

Full syntax: https://docs.maestro.dev/

## Why not test the login submit + 2FA flow?

The mealio login requires email-based 2FA OTP. Maestro can drive the
form, but the OTP arrives via email. To automate the full submit, the
flow would need either:

- A test account with 2FA disabled (requires a server-side toggle that
  doesn't exist today), or
- Email-inbox access in CI to read the OTP (extra infrastructure).

Neither is set up. So the flows here stop at "form renders correctly".
If you eventually want full login coverage, the easiest path is a
test-account exception on the backend that returns the OTP in the API
response when called from a specific test-only origin.
