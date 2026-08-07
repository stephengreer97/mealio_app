// The most recent add-to-cart run, so a bug report can be joined to its telemetry.
//
// WHY THIS EXISTS (MEAL-142). Diagnostics arrive on two channels and they never
// met:
//
//   • `automation_steps` rows — keyed (run_id, seq), one per step, carrying
//     outcome, a failure code, duration and a *thin* detail payload
//     (`sanitizeDetail` caps 12 keys, truncates strings to 200 chars, and drops
//     objects and arrays outright). Good for "HEB confirm fails 12% this week".
//
//   • The console ring buffer in ./logBuffer — 600 redacted lines, attached to a
//     bug report when the user files one. This is where the material that
//     actually reproduces a failure lives, because ADD_DEBUG and LOGIN_DEBUG are
//     console.log: pre-click visible/disabled state, cart counts either side of
//     the click, which selector matched, the header buttons that were on the
//     page, the cart-query verdict and its reason.
//
// A bug report used to carry appVersion, platform, osVersion, route, userId and
// tier — no runId. So a report gave a rich trace with no key back to the rows,
// and the rows gave a code with no trace, and joining the two meant guessing
// from timestamps. One string fixes that.
//
// IN MEMORY ONLY, deliberately. ./logBuffer makes the same choice for the same
// reason — nothing is written to disk and nothing leaves the device until the
// user explicitly files a report — and a runId is worthless outside the session
// that produced it, since the steps it keys were uploaded by that session.
//
// CLEARED AT LOGOUT, alongside the log buffer (see AuthContext.logout). Both are
// this account's shopping activity, and on a shared phone neither may follow the
// next person into their bug report.
//
// WHAT THE AGE IS AND IS NOT. `getLastAutomationRun` reports how long ago the
// run started, formatted for a human ("4s ago", "2 days ago"). It is a hint, not
// a filter, and it is weaker than it looks:
//
//   • A genuinely ANCIENT record is close to unreachable. This is module state:
//     it dies with the JS context, exactly as logBuffer's 600 lines do. So a
//     runId cannot outlive the logs it would be joined to, and a user who "kept
//     shopping" would have overwritten it with a newer run anyway.
//
//   • The failure that DOES happen is within one session, and the age cannot see
//     it: a cart run at 10:00 and an unrelated report at 10:02 — a login
//     problem, a payment question, a wrong ingredient — reads as 2m ago, exactly
//     as fresh as a report that really is about the run. `route` cannot
//     disambiguate either, because BugReportSheet is mounted once, on
//     HelpScreen, with a hardcoded route: every app bug report says "Help".
//
// So there is no cutoff here, and adding one would not help. The decision is
// about which mistake to make: a dropped association is unrecoverable by the
// person reading the report, while a stale one is noise they can reject once
// they open the run and see it does not match the description. We always send
// it, labelled clearly enough that a reader notices when it is old.

/** The run a bug report should be joined to. */
export interface LastAutomationRun {
  runId: string;
  storeId: string;
  /** How long ago the run started, in ms. */
  ageMs: number;
  /** The same age as a reader-facing phrase: "4s ago", "2 days ago". */
  ageLabel: string;
}

interface Stored {
  runId: string;
  storeId: string;
  startedAt: number;
}

let stored: Stored | null = null;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * An age a person can read at a glance.
 *
 * Formatting happens here because it cannot happen anywhere downstream: the
 * website renders each context value with `String(v)` and offers no formatting
 * hook (mealio_central lib/email.ts), so a raw millisecond count arrives in the
 * inbox as the last row of a nine-row table — `172800000`, which the reader has
 * to notice and divide by 86,400,000. Coarse on purpose: the only question the
 * age answers is "was this filed right after the run, or long after?".
 */
export function formatAge(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.round(v / SECOND)}s ago`;
  if (v < HOUR) return `${Math.round(v / MINUTE)}m ago`;
  if (v < DAY) {
    const hours = Math.round(v / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(v / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * Record the run the server just issued an id for.
 *
 * Called once per run, from the point where the runId actually arrives — a run
 * that never got an id has no rows to join to, so there is nothing to record.
 * A later run overwrites an earlier one: the useful answer is "the last cart run
 * in this session", and that is the most recent one.
 */
export function setLastAutomationRun(
  runId: string,
  storeId: string,
  now: number = Date.now(),
): void {
  if (!runId) return;
  stored = { runId, storeId, startedAt: now };
}

/**
 * The last cart run of this session, with its age. See the note at the top of
 * the file for what the age can and cannot tell a reader.
 */
export function getLastAutomationRun(now: number = Date.now()): LastAutomationRun | null {
  if (!stored) return null;
  const ageMs = Math.max(0, now - stored.startedAt);
  return {
    runId: stored.runId,
    storeId: stored.storeId,
    ageMs,
    ageLabel: formatAge(ageMs),
  };
}

/**
 * Forget the run. Called on logout — this account's cart activity must not reach
 * the next account's bug report — and by tests.
 */
export function clearLastAutomationRun(): void {
  stored = null;
}
