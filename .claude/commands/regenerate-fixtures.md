---
description: Re-capture HTML fixtures for a store via Playwright MCP (interactive login)
---

Re-capture fixture HTML for the Mealio store: $ARGUMENTS

There are two ways to capture fixtures:

1. **On-device via the FixtureCaptureSheet** (admin tab in mealio_app). Best
   when the store's WAF (Imperva on HEB, Akamai on Walmart) rejects desktop
   Playwright traffic. Works because the iPhone WebView passes the WAF.
   Recommended for HEB.

2. **Via Playwright MCP from this CLI session** — what this command does.
   Faster (no phone needed) and works for stores without aggressive WAF.

This command uses path 2. If the store's WAF blocks Playwright, fall back
to path 1 and tell the user.

## Prerequisites

- Playwright MCP must be configured (verify via `Bash claude mcp get playwright`).
- The expected MCP tool names are `mcp__playwright__browser_*`. If they are
  not in the tool list, ask the user to restart Claude Code so the MCP server
  registers.

## Procedure

1. Read `src/lib/fixture-capture-config.ts` and extract the entry for
   $ARGUMENTS — the `loginUrl` and the `fixtures` array (each has `file`,
   `url`, `waitFor`, `instruction`).

2. Open the Playwright browser at the store's `loginUrl` via
   `mcp__playwright__browser_navigate`.

3. **Pause and ask the user to log in** in the browser the MCP server opened.
   Wait for them to confirm they're signed in before proceeding. If 2FA is
   involved, this is the only place they need to intervene.

4. For each fixture in the config (skipping any marked `optional: true`
   unless the user asked for the full set):
   a. `mcp__playwright__browser_navigate(<fixture URL>)`
   b. Wait for the `waitFor` selector via `mcp__playwright__browser_wait_for`
      (or take a snapshot to confirm presence).
   c. Read the page HTML via
      `mcp__playwright__browser_evaluate(function: '() => document.documentElement.outerHTML')`.
   d. Write it to `tests/fixtures/$ARGUMENTS/<file>` using the Write tool.
   e. Report file size and one sanity-check fact (e.g. "first product tile
      title is 'Mission Burrito Grande'").

5. After all fixtures are written, run
   `npx jest tests/fixture-tests/$ARGUMENTS.spec.ts` and report results.

## When the WAF blocks Playwright

If `browser_navigate` returns an Access Denied page (HEB Imperva), or the
page comes back without the expected `waitFor` selector after 10 seconds,
stop the MCP flow and tell the user to capture via the on-device
FixtureCaptureSheet path. Don't keep retrying — Imperva won't relent.

## Reporting

End with:
- Which fixtures were written (with sizes)
- Whether `tests/fixture-tests/$ARGUMENTS.spec.ts` passes against the new
  captures
- Any selectors that look like they've moved (compare a few common
  selectors between the old and new captures via `git diff`)
