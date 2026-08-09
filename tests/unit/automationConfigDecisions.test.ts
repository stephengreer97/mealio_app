// The cart's remote-flag decisions, tested by CALLING them (MEAL-162).
//
// This file replaces a source-text oracle that decided whether the engine reads
// a config flag by inspecting `WebViewCartSheet.tsx`. That oracle lost five
// review rounds in a row. Each fix was correct and each left the next member of
// the family standing:
//
//   round 1  a trailing `//` hid the gate
//   round 2  a `/* */` did
//   round 3  a multi-line block did
//   round 4  a comment inside a template substitution did
//   —        and a plain string literal always would have, which no
//            comment-stripper can reach, because a string is text it must keep
//
// Rewriting it as an AST walk killed that whole family at once, and the fifth
// round found the two it still could not reach, both value-flow rather than
// syntax:
//
//   • `parallelAddWorkers` had NO behavioural guard. Replacing its read with
//     `const _unused = cfgFlags.parallelAddWorkers;` and leaving an unwired
//     constant passed all 1139 tests — the original MEAL-32 defect exactly
//     (merged, validated, logged as applied, inert) on the one flag whose only
//     guard was the oracle.
//   • The pre-search arming check failed OPEN: a live SECOND arming site placed
//     before the gate passed everything, as did `= !0` and `= Boolean(1)`.
//
// An oracle that reads source can see that a property access exists. It can
// never see that the value goes anywhere. So the decisions moved into pure
// functions and the tests below call them with real values.
//
// What that buys, beyond killing those two mutants: a De Morgan rewrite or a
// reordered operand is now a refactor rather than a red test, and a dead
// `if (false)` around a gate cannot be written, because there is no gate left in
// the component to wrap.

import {
  chooseAddStrategy,
  commitJitterMs,
  parallelAddWorkerCount,
  shouldStartPresearch,
  type AddStrategy,
} from '../../src/lib/automation-config/decisions';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';

const BOTH_FEATURES = { presearchAdd: true, parallelAdd: true };

/** Every input to `chooseAddStrategy` that is not a flag. */
const strategyCases = () => {
  const out: Array<Omit<Parameters<typeof chooseAddStrategy>[0], 'flags'>> = [];
  for (const canParallel of [true, false]) {
    for (const allChoose of [true, false]) {
      for (const presearchCommitArmed of [true, false]) {
        for (const presearchAdd of [true, false]) {
          for (const parallelAdd of [true, false]) {
            out.push({ canParallel, allChoose, presearchCommitArmed, features: { presearchAdd, parallelAdd } });
          }
        }
      }
    }
  }
  return out;
};

const presearchBase = {
  features: { presearchAdd: true },
  step: 'qty',
  alreadyStarted: false,
  hasParallelCfg: true,
  loginStatus: 'loggedIn',
  itemCount: 3,
  chosenCount: 3,
};

describe('chooseAddStrategy', () => {
  it('never runs a pool on a store that cannot', () => {
    // The one condition that outranks every flag: a store without worker
    // scripts, or one that forces serial search, is serial whatever operations
    // has published.
    for (const c of strategyCases().filter((x) => !x.canParallel)) {
      expect(chooseAddStrategy({ ...c, flags: { parallelAdd: true } })).toBe('serial');
    }
  });

  it('commits parked pre-search workers ahead of anything else', () => {
    expect(chooseAddStrategy({
      canParallel: true, allChoose: false, presearchCommitArmed: true,
      features: BOTH_FEATURES, flags: { parallelAdd: true },
    })).toBe('presearch');
  });

  it('sends an all-unchosen run to the parallel SEARCH pool, which adds nothing', () => {
    expect(chooseAddStrategy({
      canParallel: true, allChoose: true, presearchCommitArmed: false,
      features: BOTH_FEATURES, flags: { parallelAdd: true },
    })).toBe('parallelSearch');
  });

  it('falls to serial when the remote kill switch is off', () => {
    // The lever's whole purpose: stop adding concurrently without a release.
    expect(chooseAddStrategy({
      canParallel: true, allChoose: false, presearchCommitArmed: false,
      features: BOTH_FEATURES, flags: { parallelAdd: false },
    })).toBe('serial');
  });

  it('treats an absent flag as off rather than assuming a default', () => {
    // A merge that refused a malformed value leaves the key absent. Guessing
    // "on" there would turn a rejected push into an enabled feature.
    expect(chooseAddStrategy({
      canParallel: true, allChoose: false, presearchCommitArmed: false,
      features: BOTH_FEATURES, flags: {},
    })).toBe('serial');
  });

  it('is not overridden by the flag when the build lacks the feature', () => {
    // Flags cannot turn on code the binary does not contain — the same rule the
    // store catalog keeps for capability.
    expect(chooseAddStrategy({
      canParallel: true, allChoose: false, presearchCommitArmed: false,
      features: { presearchAdd: true, parallelAdd: false }, flags: { parallelAdd: true },
    })).toBe('serial');
    expect(chooseAddStrategy({
      canParallel: true, allChoose: false, presearchCommitArmed: true,
      features: { presearchAdd: false, parallelAdd: true }, flags: { parallelAdd: true },
    })).toBe('parallelAdd');
  });

  it('only ever answers with a route the caller handles', () => {
    const allowed: AddStrategy[] = ['presearch', 'parallelSearch', 'parallelAdd', 'serial'];
    for (const c of strategyCases()) {
      for (const flags of [{ parallelAdd: true }, { parallelAdd: false }, {}]) {
        expect(allowed).toContain(chooseAddStrategy({ ...c, flags }));
      }
    }
  });
});

describe('shouldStartPresearch', () => {
  it('parks when every condition holds', () => {
    expect(shouldStartPresearch({ ...presearchBase, flags: { presearchAdd: true } })).toBe(true);
  });

  it('is off when the remote flag is off, or absent', () => {
    expect(shouldStartPresearch({ ...presearchBase, flags: { presearchAdd: false } })).toBe(false);
    expect(shouldStartPresearch({ ...presearchBase, flags: {} })).toBe(false);
  });

  it('is off when the build lacks the feature', () => {
    expect(shouldStartPresearch({
      ...presearchBase, features: { presearchAdd: false }, flags: { presearchAdd: true },
    })).toBe(false);
  });

  it('arms once per run', () => {
    // The count that used to fail OPEN: a second live arming site passed every
    // test. Asked as a question, "already started" is just an input.
    expect(shouldStartPresearch({ ...presearchBase, alreadyStarted: true, flags: { presearchAdd: true } })).toBe(false);
  });

  it('only parks from the qty screen', () => {
    for (const step of ['login', 'searching', 'adding', 'review', 'done']) {
      expect(shouldStartPresearch({ ...presearchBase, step, flags: { presearchAdd: true } })).toBe(false);
    }
  });

  it('will not park pages for a shopper who is not logged in', () => {
    for (const loginStatus of ['loggedOut', 'unknown', '']) {
      expect(shouldStartPresearch({ ...presearchBase, loginStatus, flags: { presearchAdd: true } })).toBe(false);
    }
  });

  it('refuses a run where anything still needs choosing', () => {
    // A partly-chosen run goes to the choose screen, and the parked results
    // pages would be thrown away.
    expect(shouldStartPresearch({
      ...presearchBase, itemCount: 3, chosenCount: 2, flags: { presearchAdd: true },
    })).toBe(false);
    expect(shouldStartPresearch({
      ...presearchBase, itemCount: 3, chosenCount: 0, flags: { presearchAdd: true },
    })).toBe(false);
  });
});

describe('commitJitterMs', () => {
  it('spreads the burst across base..2×base', () => {
    expect(commitJitterMs({ addCommitJitterMs: 500 }, 999, () => 0)).toBe(500);
    expect(commitJitterMs({ addCommitJitterMs: 500 }, 999, () => 0.999999)).toBe(999);
  });

  it('uses the remote value, not the build constant', () => {
    // The original MEAL-32 defect: the flag shipped, was validated, was logged
    // as applied, and nothing read it.
    expect(commitJitterMs({ addCommitJitterMs: 2000 }, 500, () => 0)).toBe(2000);
  });

  it('falls back to the build constant when the flag is absent', () => {
    expect(commitJitterMs({}, 500, () => 0)).toBe(500);
  });

  it('is not constant across calls', () => {
    // A fixed delay is a pattern in itself, which is the opposite of the point.
    const seen = new Set(Array.from({ length: 40 }, () => commitJitterMs({ addCommitJitterMs: 500 }, 500)));
    expect(seen.size).toBeGreaterThan(1);
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThan(1000);
    }
  });
});

describe('parallelAddWorkerCount', () => {
  it("prefers the store's own count", () => {
    expect(parallelAddWorkerCount({ scriptWorkerCount: 6, flags: { parallelAddWorkers: 3 }, fallback: 2 })).toBe(6);
  });

  it('uses the remote flag when the store has no opinion', () => {
    expect(parallelAddWorkerCount({ flags: { parallelAddWorkers: 5 }, fallback: 2 })).toBe(5);
  });

  it('falls back to the bundled default', () => {
    expect(parallelAddWorkerCount({ flags: {}, fallback: 2 })).toBe(2);
  });
});

describe('every declared flag reaches a decision', () => {
  // The invariant that stops the original defect reopening, and the reason this
  // file exists rather than a sixth patch to the oracle.
  //
  // A key added to `FlagConfig` is inert until something consumes it, and the
  // merge tests cannot notice — they pass on a key no reader exists for. The old
  // version asked the question of the SOURCE ("does this identifier appear?"),
  // which is what five rounds of mutants kept fooling. This asks it of the
  // OUTPUT: change the flag, and some decision must answer differently.
  //
  // Generic on purpose. There is no per-flag mapping to go stale, so a new flag
  // that nothing consumes fails here the day it is added — UNLESS someone also
  // writes it an exemption row below, which three lines can do. The list is a
  // reviewer's call, not a check: the test underneath can confirm a row's key
  // exists and is genuinely unread, and cannot confirm its REASON is true. That
  // is exactly how `backgroundCart` sat here describing itself as owned
  // elsewhere while nothing read it at all.
  const DELIBERATELY_UNREAD: Record<string, string> = {
    // Read by NOTHING, anywhere. `grep -rn backgroundCart src/ tests/` returns
    // its two schema lines and this row — `CartJobContext` never mentions it.
    //
    // The previous wording here said "mount-site selection, owned by
    // CartJobContext", which reads as *consumed somewhere else* and is how this
    // row survived a ticket whose entire subject is declared-and-inert flags. It
    // is inherited from the retired oracle, not introduced here, but describing
    // it accurately is the least this file owes: it is a published, validated,
    // bounded flag that does nothing, and it should be wired or dropped.
    backgroundCart: 'DECLARED AND INERT — read nowhere in src/; wire it or drop it',
  };

  /** Everything the decisions answer, for one set of flags. */
  const observe = (flags: Record<string, unknown>) => JSON.stringify({
    strategy: strategyCases().map((c) => chooseAddStrategy({ ...c, flags })),
    presearch: [true, false].flatMap((presearchAdd) =>
      ['qty', 'login'].flatMap((step) =>
        [true, false].map((alreadyStarted) =>
          shouldStartPresearch({ ...presearchBase, features: { presearchAdd }, step, alreadyStarted, flags })))),
    jitterLow: commitJitterMs(flags, 500, () => 0),
    jitterHigh: commitJitterMs(flags, 500, () => 0.9),
    workers: parallelAddWorkerCount({ flags, fallback: 3 }),
    workersWithScript: parallelAddWorkerCount({ scriptWorkerCount: 9, flags, fallback: 3 }),
  });

  /** A value for this flag that differs from the bundled one. */
  const altered = (value: unknown) => (typeof value === 'boolean' ? !value : (value as number) + 17);

  const bundled = BUNDLED_AUTOMATION_CONFIG.flags as unknown as Record<string, unknown>;

  it.each(Object.keys(bundled).filter((k) => !DELIBERATELY_UNREAD[k]))(
    'changing %s changes what the cart decides',
    (key) => {
      expect(observe(bundled)).not.toBe(observe({ ...bundled, [key]: altered(bundled[key]) }));
    },
  );

  it('keeps the deliberately-unread list honest', () => {
    // A stale exemption is the other way this rots: a row left here after
    // someone wires the flag exempts a key that no longer needs it, and the next
    // unread key added beside it inherits the excuse.
    for (const key of Object.keys(DELIBERATELY_UNREAD)) {
      expect(Object.keys(bundled)).toContain(key);
      expect(observe(bundled)).toBe(observe({ ...bundled, [key]: altered(bundled[key]) }));
    }
  });
});
