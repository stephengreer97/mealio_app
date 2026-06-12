---
description: Run the entire Mealio test suite (unit + fixtures for all stores + component tests)
---

Run the complete test suite for the Mealio mobile app.

## Steps

1. **Full suite**: `npm test` from /home/sgreer/mealio_app. This runs both
   projects (`node` and `components`) in one shot. Tail the last ~30 lines
   for the per-suite breakdown.

2. **Summarize** in a single report:

```
=== Mealio Test Suite ===
Node project:
  Unit:                     N/N passed
  Fixture tests:
    wegmans                 N/M passed, K skipped
    heb                     N/M passed, K skipped
    walmart                 N/M passed, K skipped
    albertsons              N/M passed, K skipped
    aldi                    N/M passed, K skipped
    amazon-fresh            N/M passed, K skipped
Components project:
  Hook + component tests:   N/N passed

Total: T passed, S skipped, F failed
```

3. **Skipped tests**: list each skipped test with the missing fixture name.
   The fix is always "capture <file> via the FixtureCaptureSheet in the
   mealio_app admin tab" — don't suggest the legacy `npm run capture` path.

4. **Failed tests**: quote the specific assertion error and any captured
   ADD_DEBUG / LOGIN_DEBUG / SEARCH_DEBUG messages. For each failure,
   identify the store and the script affected, then suggest ONE specific
   next step (recapture? selector update?). Don't suggest five things at
   once.

Live tests are intentionally not part of this suite — 2FA on most stores
makes unattended live runs impractical. Live validation happens manually
by exercising the cart in mealio_app.
