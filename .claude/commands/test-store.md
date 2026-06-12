---
description: Run the full test suite for a single grocery store and report pass/fail
---

You are running the Mealio test suite for the store named: $ARGUMENTS

Be efficient and don't over-explain.

## Step 1: Validate the store name

Valid stores: wegmans, heb, walmart, albertsons, aldi, amazon-fresh

If the user passed something else, say so and stop.

## Step 2: Run the unit tests

Run `npx jest --selectProjects node tests/unit` from /home/sgreer/mealio_app.
Store-agnostic but a fast sanity check (~2s).

## Step 3: Run that store's fixture tests

Run `npx jest tests/fixture-tests/$ARGUMENTS.spec.ts`.

For each result:
- If a test PASSED — note it briefly.
- If a test was SKIPPED (look for `[SKIPPED — capture X first]`) — tell the
  user they need to capture the missing fixture via the FixtureCaptureSheet
  in mealio_app's admin tab (Admin → Capture Fixtures → pick this store).
- If a test FAILED — quote the assertion error and the relevant ADD_DEBUG /
  LOGIN_DEBUG / SEARCH_DEBUG messages from the test output. Then ask the
  user whether they want you to investigate the failure further (selector
  drift in the script is the usual cause).

## Step 4: Run the component-test project too

Run `npx jest --selectProjects components`. These are RN hook + component
tests (currently 18 tests covering useParallelSearchPool and a smoke render
of WebViewCartSheet). They are store-agnostic but quick.

## Step 5: Summary

Final report format:

```
Store: $ARGUMENTS
Unit tests:     N passed, 0 failed
Fixture tests:  N passed, M skipped, K failed
Component:      N passed, 0 failed

Next step: <one specific action — "capture <file> via FixtureCaptureSheet" /
            "selector in $ARGUMENTS.ts moved — proposed edit attached" /
            "all green!">
```

Live tests are intentionally not part of this suite — most stores require
2FA which makes unattended live runs impractical. Live validation happens
manually by opening mealio_app and exercising the cart.
