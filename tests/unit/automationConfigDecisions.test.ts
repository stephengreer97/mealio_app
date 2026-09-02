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
  type AddStrategy,
} from '../../src/lib/automation-config/decisions';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';


/** Every input to `chooseAddStrategy`. There are only two, and four combinations. */
const strategyCases = () => {
  const out: Array<Parameters<typeof chooseAddStrategy>[0]> = [];
  for (const allChoose of [true, false]) {
    for (const networkCapable of [true, false]) {
      out.push({ allChoose, networkCapable });
    }
  }
  return out;
};


describe('chooseAddStrategy', () => {
  // DOM automation was removed on 2026-09-01. There are three routes and none of
  // them click a storefront: the rail adds and can prove it, the rail searches
  // for a choose run, or Mealio searches and the USER adds.
  it('a store with no rail gets no automation, whatever else is true', () => {
    for (const allChoose of [true, false]) {
      expect(chooseAddStrategy({ allChoose, networkCapable: false })).toBe('assisted');
    }
    // Absent is not "maybe" — a store is capable or it is assisted.
    expect(chooseAddStrategy({ allChoose: false })).toBe('assisted');
  });

  it('a rail store adds over the network', () => {
    expect(chooseAddStrategy({ allChoose: false, networkCapable: true })).toBe('network');
  });

  it('a choose run STAYS on the rail, for search only', () => {
    // It needs candidates, not adds. Falling through to `assisted` here would
    // drop the Choose Products screen on the two stores best able to fill it —
    // which is what happened when the pooled search that used to serve it was
    // deleted along with the rest of the DOM path.
    expect(chooseAddStrategy({ allChoose: true, networkCapable: true })).toBe('networkChoose');
  });

  it('only ever answers with a route the caller handles', () => {
    const allowed: AddStrategy[] = ['network', 'networkChoose', 'assisted'];
    for (const c of strategyCases()) {
      expect(allowed).toContain(chooseAddStrategy(c));
    }
  });

  it('names no route that clicks a page', () => {
    // The point of the change. If one of these ever comes back as a strategy,
    // something has rebuilt the path this removed.
    const gone = ['presearch', 'parallelSearch', 'parallelAdd', 'serial'];
    for (const c of strategyCases()) {
      expect(gone).not.toContain(chooseAddStrategy(c));
    }
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
  /**
   * Flags a decision deliberately does not consume.
   *
   * EMPTY, and worth keeping that way. It held one row — `backgroundCart` —
   * described as "mount-site selection, owned by CartJobContext". Nothing read
   * it anywhere, `CartJobContext` never mentioned it, and it was published,
   * validated and bounded the entire time. On a ticket whose subject is
   * declared-and-inert flags, the exemption was describing the thing it hid.
   * The flag is gone rather than excused.
   *
   * A row here is a reviewer's judgement, not a check: the test below can
   * confirm a key is genuinely unread and cannot confirm the REASON is true.
   * That asymmetry is how the last one survived, so add one only when nothing
   * else will do.
   */
  const DELIBERATELY_UNREAD: Record<string, string> = {};

  /** Everything the decisions answer, for one set of flags. */
  const observe = (flags: Record<string, unknown>) => JSON.stringify({
    strategy: strategyCases().map((c) => chooseAddStrategy(c)),
  });

  /** A value for this flag that differs from the bundled one. */
  const altered = (value: unknown) => (typeof value === 'boolean' ? !value : (value as number) + 17);

  const bundled = BUNDLED_AUTOMATION_CONFIG.flags as unknown as Record<string, unknown>;

  const liveFlags = Object.keys(bundled).filter((k) => !DELIBERATELY_UNREAD[k]);

  if (liveFlags.length === 0) {
    // There are none left: all four were levers over the DOM worker pools and
    // went with them. The machinery above stays armed rather than being deleted,
    // because the invariant is about the NEXT flag — `observe` deliberately
    // ignores its argument now, so a flag added without a reader produces
    // identical output and fails here the day it appears.
    it('has no flags left to check, which is the current truth and not a gap', () => {
      expect(bundled).toEqual({});
    });
  } else {
    it.each(liveFlags)(
      'changing %s changes what the cart decides',
      (key) => {
        expect(observe(bundled)).not.toBe(observe({ ...bundled, [key]: altered(bundled[key]) }));
      },
    );
  }

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
