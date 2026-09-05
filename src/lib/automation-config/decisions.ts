// The cart's remote-flag decisions, as pure functions (MEAL-162).
//
// ── Why these are not inline in WebViewCartSheet ─────────────────────────────
//
// MEAL-32 added a guard that decided whether the engine READS a config flag by
// inspecting `WebViewCartSheet.tsx` as text. Four cold-review rounds found four
// ways to fool a text oracle — a trailing `//`, a `/* */`, a multi-line block, a
// comment inside a template substitution — and each fix was correct and left
// another member of the family standing. The family does not end at comments
// either: a plain string literal containing the gate text fools it too, and no
// comment-stripping can reach that, because a string is text the stripper has to
// keep. Rewriting the oracle as an AST walk killed the comment/string/template
// classes at once, and the fifth review found the next two counter-examples:
//
//   • `parallelAddWorkers` had no behavioural guard at all. Replacing its read
//     with `const _unused = cfgFlags.parallelAddWorkers;` and leaving an unwired
//     constant passed all 1139 tests — the original defect exactly (merged,
//     validated, logged as applied, inert) on the one flag whose only guard was
//     the text oracle.
//   • The pre-search arming count failed OPEN. The test asserted exactly one
//     site arms pre-search, so gating that site is total — but a live SECOND
//     arming site placed before the gate passed every test, as did `= !0` and
//     `= Boolean(1)`.
//
// Both are value-flow bugs. An oracle that reads source can see that a property
// access exists; it can never see that the value goes anywhere. So the answer is
// not a sixth patch to the oracle — it is to make the decisions observable:
// functions that take flags and return an answer, tested by calling them.
//
// A De Morgan rewrite or a reordered operand is then a refactor, not a test
// failure, and a dead `if (false)` around a gate is impossible to write, because
// there is no gate left in the component to wrap.
//
// The component keeps a one-line call at each site.

import type { FlagConfig } from './schema';

/**
 * The flags as a CALLER may actually hold them.
 *
 * `FlagConfig` declares every field required, but the component reads each one
 * with `??` against a bundled default — a remote payload can be partial, and a
 * merge that dropped a malformed field leaves the key absent. Typing these
 * functions to the optimistic shape would push the `??` back out to the call
 * sites, which is where MEAL-32's whole problem lived.
 */
type Flags = Partial<FlagConfig>;

/** Which route `beginSearchFlow` takes. */
/**
 * How a run adds to the cart. Three routes, and DOM clicking is not one of them.
 *
 *  • `network`       — ask the store's own API from a signed-in WebView.
 *  • `networkChoose` — same rail, search only: the run needs candidates for the
 *                      Choose Products screen, not adds.
 *  • `assisted`      — Mealio searches on the user's behalf and hands them the
 *                      page to add from. No automation at all.
 *
 * The Kroger family never reaches here: the server fans out per ingredient.
 */
export type AddStrategy = 'network' | 'networkChoose' | 'assisted';

export interface AddStrategyInput {
  /** Every active item still needs a product chosen. */
  allChoose: boolean;
  /** The store has a rail and network SEARCH is switched on. */
  networkSearchCapable?: boolean;
  /**
   * ...and network ADD is switched on too, including any per-store proof
   * switch. Implies networkSearchCapable: a rail that cannot search has
   * nothing to add.
   */
  networkAddCapable?: boolean;
}

/**
 * The add route, from build features and remote flags.
 *
 * Order is load-bearing and is preserved exactly from the inline version. The
 * pre-search branch is checked BEFORE the parallel-add kill switch on purpose:
 * parked workers commit their adds through `startPresearchCommit`, which the
 * `parallelAdd` branch never reaches. So the two flags have to be published
 * together to mean "stop adding concurrently" — `flags.presearchAdd: false` is
 * the other half, and it is read earlier, by `shouldStartPresearch`.
 */
export function chooseAddStrategy(input: AddStrategyInput): AddStrategy {
  // DOM automation is gone (2026-09-01). It clicked through the storefront to
  // search and add, and it was the source of most of what went wrong: stale
  // selectors, races with the page's own navigation, adds that reported success
  // and never landed. Every route that clicked has been deleted rather than
  // fixed, and nothing falls back to one.
  //
  // What is left is honest about what it can do. A store either has a rail, in
  // which case Mealio adds to the cart itself and can prove it; or it does not,
  // in which case Mealio does the searching and the user does the adding.
  //
  // A choose run stays on the rail too, for search only. It needs candidates,
  // not adds, and letting it fall through to `assisted` would drop the Choose
  // Products screen on exactly the stores best able to fill it.
  //
  // The two capabilities are asked SEPARATELY because a choose run never writes
  // to a cart. Reading one combined "can do both" flag meant a search-on/add-off
  // store -- ALDI and Wegmans, both of them deliberately half-on while their
  // write is unproven -- fell through to `assisted` and handed the user six
  // manual searches, on the exact stores whose search is fastest. Stephen,
  // 2026-09-03, on an ALDI run that did this: "first test out the gate and
  // login detection is not working for ALDI even though I am logged in".
  if (input.allChoose) return input.networkSearchCapable ? 'networkChoose' : 'assisted';
  return input.networkAddCapable ? 'network' : 'assisted';
}

// shouldStartPresearch, commitJitterMs and parallelAddWorkerCount lived here.
// All three sized, paced or armed the DOM worker pools, which were deleted on
// 2026-09-01 along with every route that clicked a storefront. Nothing sizes a
// pool any more: a run is a rail or it is the user.


/**
 * Should the Add It Yourself pass warm the page the next tap will want?
 *
 * Stephen, 2026-09-05: "We could even maybe have a little bit of looking ahead
 * and back so that when a user clicks next or back, the page is already
 * loaded." The answer is yes by default, and this exists so it can be made no
 * from a config push.
 *
 * It lives HERE and not at the call site because a flag read straight out of
 * the config in a component is invisible to the invariant next door: a flag is
 * only real when a decision answers differently for it, and the decisions are
 * what that test observes. Reading it in WebViewCartSheet worked perfectly and
 * failed `every declared flag reaches a decision`, which was right to fail --
 * the flag was a lever the architecture could not see.
 *
 * The default is ON, and `undefined` means on: a config that predates the flag
 * must not silently turn a shipped behaviour off.
 */
export function shouldWarmManualPage(flags: { manualPrefetch?: boolean }): boolean {
  return flags.manualPrefetch !== false;
}
