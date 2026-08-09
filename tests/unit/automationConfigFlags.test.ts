import { mergeAutomationConfig } from '../../src/lib/automation-config/merge';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';

// MEAL-32. `FlagConfig` declared five keys; the engine read one.
//
// The other four merged, type-checked, bounds-checked and had refusal tests —
// and then nothing consumed them. `automationConfigMerge.test.ts` passed on
// `flags.parallelAdd` the whole time, because it only ever asked whether the
// MERGE handled the key, never whether anything downstream read the result. So a
// config push setting `flags.parallelAdd: false` was accepted, validated, logged
// as applied, and did nothing at all.
//
// That is the specific failure these tests exist for: a knob that reads as
// available in the schema, in the docs and in the merge's own test suite, and is
// inert. It is worse than a missing knob, because someone reaches for it in the
// middle of a live block and believes it worked.
//
// ── The wiring half has moved (MEAL-162) ────────────────────────────────────
//
// This file used to carry a second half that asserted against the SOURCE TEXT of
// `WebViewCartSheet.tsx`, because no harness could drive a cart run and the text
// was the only thing that could tell "reads the config" from "reads the build
// constant".
//
// It lost five review rounds. A trailing `//`, a `/* */`, a multi-line block and
// a comment inside a template substitution each hid a gate from it; an AST walk
// killed that family, and then two value-flow mutants beat the AST too — an
// unwired `const _unused = cfgFlags.parallelAddWorkers;`, and a second live
// pre-search arming site placed before the gate. Source can show that a property
// access exists. It cannot show that the value goes anywhere.
//
// So the decisions moved into pure functions and the wiring half is now
// `automationConfigDecisions.test.ts`, which calls them with real values and
// asks the question of the OUTPUT: change a flag, and some decision must answer
// differently. What remains here is ordinary config coverage — the merge half,
// which was always sound.

describe('flags in the merge', () => {
  it('carries the bundled defaults with no override', () => {
    const { config, warnings } = mergeAutomationConfig({});
    expect(config.flags.parallelAdd).toBe(true);
    expect(config.flags.presearchAdd).toBe(true);
    expect(config.flags.addCommitJitterMs).toBe(500);
    expect(warnings).toEqual([]);
  });

  it('applies a valid override to each newly-wired flag', () => {
    const { config, warnings } = mergeAutomationConfig({
      flags: { parallelAdd: false, presearchAdd: false, addCommitJitterMs: 1_500 },
    });
    expect(config.flags.parallelAdd).toBe(false);
    expect(config.flags.presearchAdd).toBe(false);
    expect(config.flags.addCommitJitterMs).toBe(1_500);
    // Untouched siblings keep theirs — a partial payload is the normal shape.
    expect(config.flags.parallelAddWorkers)
      .toBe(BUNDLED_AUTOMATION_CONFIG.flags.parallelAddWorkers);
    expect(warnings).toEqual([]);
  });

  it('refuses a wrong-typed boolean flag and keeps the default', () => {
    // The dangerous direction: 'false' (a truthy string) reaching a gate as-is
    // would enable the very path the push was trying to turn off.
    const { config, warnings } = mergeAutomationConfig({
      flags: { parallelAdd: 'false', presearchAdd: 0 },
    });
    expect(config.flags.parallelAdd).toBe(true);
    expect(config.flags.presearchAdd).toBe(true);
    expect(warnings.length).toBe(2);
  });

  it('refuses an out-of-bounds or non-finite jitter and keeps the default', () => {
    for (const bad of [-1, 10_001, NaN, Infinity, '500']) {
      const { config } = mergeAutomationConfig({ flags: { addCommitJitterMs: bad } });
      expect(config.flags.addCommitJitterMs).toBe(500);
    }
    // A negative jitter would make the commit setTimeout fire immediately, which
    // is the burst the value exists to prevent — so refusal, not clamping.
    const { warnings } = mergeAutomationConfig({ flags: { addCommitJitterMs: -1 } });
    expect(warnings.join()).toMatch(/addCommitJitterMs/);
  });
});
