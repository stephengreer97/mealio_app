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

/** The run a bug report should be joined to. */
export interface LastAutomationRun {
  runId: string;
  storeId: string;
  /** How long ago the run started, in ms. See the note on getLastAutomationRun. */
  ageMs: number;
}

interface Stored {
  runId: string;
  storeId: string;
  startedAt: number;
}

let stored: Stored | null = null;

/**
 * Record the run the server just issued an id for.
 *
 * Called once per run, from the point where the runId actually arrives — a run
 * that never got an id has no rows to join to, so there is nothing to record.
 * A later run overwrites an earlier one: the useful answer is "the run this
 * report is probably about", and that is the most recent one.
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
 * The last run, with its age.
 *
 * `ageMs` is the point of this function rather than a nicety. A report filed
 * seconds after a failed run is almost certainly about that run; one filed two
 * days later is about something else, and a runId attached to it would send
 * whoever reads it to an unrelated trace — worse than no runId at all. This
 * deliberately does NOT decide the cutoff: the reader has the description and
 * the logs and can judge, and a threshold here would silently discard the
 * association in the one case (a user who hit a bug, kept using the app, and
 * reported it later) where it is still worth having.
 */
export function getLastAutomationRun(now: number = Date.now()): LastAutomationRun | null {
  if (!stored) return null;
  return {
    runId: stored.runId,
    storeId: stored.storeId,
    ageMs: Math.max(0, now - stored.startedAt),
  };
}

/** Drop the record. Exported for tests; nothing in the app needs to forget a run. */
export function clearLastAutomationRun(): void {
  stored = null;
}
