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

`.github/workflows/ios-maestro.yml` runs these flows on a free GitHub-hosted
macOS runner every PR into `main` and every push to `main`. The full
pipeline:

1. Checkout, install npm + CocoaPods deps.
2. `expo prebuild --platform ios` generates the native `ios/` folder.
3. `xcodebuild` builds for iOS Simulator (debug, no code signing).
4. Boot a fresh iPhone 15 simulator.
5. Install the built `.app` on the simulator.
6. `maestro test tests/maestro/flows` runs every YAML flow.
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
