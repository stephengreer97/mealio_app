// When may a user be handed the store and told to do it themselves?
//
// Stephen, 2026-09-04: "I want to change the do it yourself logic to only ever
// appear if these retries all fail. That should be the only scenario a user
// ever sees the do it yourself logic."
//
// It had grown into the answer to eleven different questions. Every dead end in
// the run -- no session, a phase that timed out, a script that would not build
// -- called the same function, and the user got the store's search page and a
// list of terms whether Mealio had learned nothing or had learned almost
// everything. Handing over after finding fourteen products and failing to write
// two of them is not a last resort; it is throwing away the work.
//
// So the decision is made once, here, from three facts:
//
//   RETRY THE RUN   The failure is the kind that a second attempt can fix -- a
//                   session that did not answer, a phase that ran out of clock.
//                   Nothing store-specific and nothing deterministic: a store
//                   with no rail at all will have no rail the second time too.
//   REVIEW          We know something per-item. Either the user can pick
//                   (candidates) or we can say what went wrong (a definite
//                   reason). Both are worth more than the store's own search
//                   box, and both keep Mealio in the loop.
//   ASSISTED        Nothing above is true. We got nowhere, and the honest thing
//                   is to say so and open the store.
//
// The request-level retries in webview-scripts/_retry.ts sit underneath this:
// by the time a `why` reaches here, the individual requests behind it have
// already been asked again and still failed.

export type HandoverDecision = 'retry_run' | 'review' | 'assisted';

export type HandoverInput = {
  /** The engine's reason string, as passed to netHandOverToUser. */
  why: string;
  /** Whole-run retries already spent this run. */
  runRetriesUsed: number;
  /** How many whole-run retries this run is allowed. */
  maxRunRetries: number;
  /** Active items the review screen could offer a choice for. */
  reviewableCount: number;
  /** Active items we can at least explain -- out of stock, no results. */
  informativeCount: number;
};

/** One whole-run retry. A second is a loop, not a recovery. */
export const MAX_RUN_RETRIES = 1;

/**
 * Failures a second run can plausibly fix.
 *
 * Deliberately a prefix list and not a catch-all: a `why` nobody has classified
 * must NOT quietly earn a free retry, because the ones that do not belong here
 * are the deterministic ones and retrying those just doubles the wait before
 * the same dead end.
 */
const TRANSIENT_RUN_FAILURES = [
  // The session phase. Nothing has been written when these fire, so a second
  // run costs a few seconds and risks nothing.
  'session_',            // session_timeout, and session_<whatever the rail said>
  'no_session',          // covers no_session_at_add
  // The search phase. Partial results are discarded by the rerun, which is
  // fine: they were not written either.
  'search_timeout',
];

/**
 * THE ADD PHASE IS NOT ON THAT LIST, and it must not be.
 *
 * A rerun starts from a fresh cart baseline, so re-running after a write that
 * may have half-landed is how a cart ends up with two of something --
 * [[cart-qty-adds-on-top]] means the second run adds on top of the first. The
 * add phase already has the right answer for its own deadline: netArmFinalize
 * reconciles against what the cart actually holds instead of handing over, and
 * the shortfall top-up re-writes only the units that are genuinely missing.
 */


/**
 * Failures where a second run changes nothing, named so the reason is on the
 * record rather than implied by absence.
 *
 *   no_rail                  this store has no rail; it will have none next time
 *   *_script_unbuildable     the config or session is missing a field
 *   search_blocked           the anti-bot wall, which the challenge screen owns
 *                            and which a rerun would only trip again
 */
const DETERMINISTIC_FAILURES = ['no_rail', 'script_unbuildable', 'search_blocked'];

export function isTransientRunFailure(why: string): boolean {
  const w = String(why || '');
  if (DETERMINISTIC_FAILURES.some((d) => w.includes(d))) return false;
  return TRANSIENT_RUN_FAILURES.some((t) => w.startsWith(t));
}

export function decideHandover(input: HandoverInput): HandoverDecision {
  const { why, runRetriesUsed, maxRunRetries, reviewableCount, informativeCount } = input;

  // A RERUN THROWS AWAY WHAT THE RUN FOUND, so products the user could pick
  // right now outrank it. startNetworkRun clears the candidate maps -- it has
  // to, or a rerun would mix two runs' results -- which means retrying a search
  // timeout that had already found twelve products destroys the twelve to go
  // looking for fourteen. Measured while writing this: cards=1 reviewable=1
  // retried, the rerun timed out too, and the run that had a product to offer
  // ended on the store's search page with nothing.
  if (reviewableCount > 0) return 'review';

  // Nothing to lose, so a second attempt is free. This sits ABOVE the
  // informative case on purpose: a card that only says "the store had none of
  // this" is worth less than another go at finding some.
  if (isTransientRunFailure(why) && runRetriesUsed < maxRunRetries) return 'retry_run';

  // We cannot offer a choice, but we can say what happened, and that beats the
  // store's search box.
  if (informativeCount > 0) return 'review';

  return 'assisted';
}
