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
export type AddStrategy = 'presearch' | 'parallelSearch' | 'parallelAdd' | 'serial';

export interface AddStrategyInput {
  /** The store has the scripts for a worker pool and does not force serial. */
  canParallel: boolean;
  /** Every active item still needs a product chosen. */
  allChoose: boolean;
  /** Pre-search workers are parked and their adds are ready to commit. */
  presearchCommitArmed: boolean;
  /** Build-time switches — what this binary contains. */
  features: { presearchAdd: boolean; parallelAdd: boolean };
  /** Remote config — what operations has turned on. */
  flags: Pick<Flags, 'parallelAdd'>;
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
  const { canParallel, allChoose, presearchCommitArmed, features, flags } = input;
  if (canParallel && !allChoose && features.presearchAdd && presearchCommitArmed) return 'presearch';
  if (canParallel && allChoose) return 'parallelSearch';
  if (canParallel && !allChoose && features.parallelAdd && !!flags.parallelAdd) return 'parallelAdd';
  return 'serial';
}

export interface PresearchStartInput {
  features: { presearchAdd: boolean };
  flags: Pick<Flags, 'presearchAdd'>;
  /** The sheet's current step. Pre-search parks while the user is on `qty`. */
  step: string;
  /** This run has already armed the pool. */
  alreadyStarted: boolean;
  /** The parallel worker config resolved for the locked store. */
  hasParallelCfg: boolean;
  /** `loginPrewarm.getStatus(store)` — parking pages while logged out is wasted. */
  loginStatus: string;
  /** Consolidated items on the qty screen. */
  itemCount: number;
  /** How many of them already have a chosen product. */
  chosenCount: number;
}

/**
 * Whether to park pre-search workers for this run.
 *
 * Every condition of the inline version, in order. The last one is the subtle
 * one: pre-search only runs when EVERY item is already chosen, because a run
 * with an unchosen item goes to the choose screen and the parked results pages
 * would be thrown away.
 *
 * Why a remote kill switch exists for it at all: pre-search holds N results
 * pages open across the qty screen and then fires N adds within ~1s of the tap.
 * That is a distinct request pattern from the fused search+add path, and this is
 * the only way to drop back to the latter without a release.
 */
export function shouldStartPresearch(input: PresearchStartInput): boolean {
  const { features, flags, step, alreadyStarted, hasParallelCfg, loginStatus, itemCount, chosenCount } = input;
  if (!features.presearchAdd || !flags.presearchAdd) return false;
  if (step !== 'qty' || alreadyStarted) return false;
  if (!hasParallelCfg) return false;
  if (loginStatus !== 'loggedIn') return false;
  if (chosenCount === 0 || chosenCount !== itemCount) return false;
  return true;
}

/**
 * How long to wait before injecting one parked worker's add.
 *
 * Spreads a commit burst against a store that has started scoring it. The value
 * is `base` to `2 × base` — never zero, so the burst is always spread, and never
 * constant, so it is not a pattern in itself.
 *
 * `random` is injected so a test can assert the range at the ends rather than
 * sampling and hoping. `flags.addCommitJitterMs` shipped in the config schema —
 * bounded 0..10_000, refused when malformed — but nothing read it, so the
 * documented way to spread a burst did nothing. That is the original MEAL-32
 * defect, and the reason this returns a number a test can check.
 */
export function commitJitterMs(
  flags: Pick<Flags, 'addCommitJitterMs'>,
  fallbackMs: number,
  random: () => number = Math.random,
): number {
  const base = flags.addCommitJitterMs ?? fallbackMs;
  return base + Math.floor(random() * base);
}

/**
 * How many workers the parallel add pool runs.
 *
 * The store's own script wins, then the remote flag, then the bundled default.
 * The store comes first because a worker count is a property of that store's
 * page weight; the flag is the lever for turning the whole fleet down.
 *
 * This is the flag the fifth review caught with no behavioural guard at all —
 * its read could be replaced with an unused constant and every test still
 * passed. It has one now because the answer is a number a test can assert.
 */
export function parallelAddWorkerCount(input: {
  scriptWorkerCount?: number;
  flags: Pick<Flags, 'parallelAddWorkers'>;
  fallback: number;
}): number {
  return input.scriptWorkerCount ?? input.flags.parallelAddWorkers ?? input.fallback;
}
