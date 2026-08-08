import fs from 'fs';
import path from 'path';
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
// Two halves, and both are needed. The merge half is ordinary config coverage.
// The wiring half asserts against the SOURCE of WebViewCartSheet, which is
// unusual and deserves its reason stated: there is no harness that can drive a
// cart run (MEAL-158), so the only thing available that can tell "reads the
// config" from "reads the build constant" is the text. `automationTelemetry.test.ts`
// establishes the same pattern for the same reason.

const src = fs.readFileSync(
  path.join(__dirname, '../../src/components/WebViewCartSheet.tsx'), 'utf8',
);

/**
 * Flag keys the engine deliberately does NOT read, with the reason.
 *
 * Listed rather than omitted so the coverage test below can tell "decided not
 * to" from "forgot to" — the distinction the original defect erased. A new key
 * added to FlagConfig fails that test until it is either wired or named here.
 */
const DELIBERATELY_UNREAD: Record<string, string> = {
  // Selects the cart engine's MOUNT SITE (root CartJobProvider vs inline on the
  // screen), not a request pattern. Not an anti-bot lever, and it belongs to
  // whoever owns CartJobContext rather than to this file.
  backgroundCart: 'mount-site selection, owned by CartJobContext',
};

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

describe('the engine reads the flags it validates', () => {
  it('has exactly one place that arms pre-search, so gating it there is total', () => {
    // The gate below is only "the kill switch for the whole path" because this
    // is true: every downstream branch (commit arming, beginSearchFlow, the
    // tiles) is conditioned on presearchStartedRef. A second arming site would
    // route around the flag, so the claim is pinned rather than trusted.
    const arms = src.match(/presearchStartedRef\.current = true;/g) ?? [];
    expect(arms.length).toBe(1);
  });

  it('gates pre-search parking on flags.presearchAdd', () => {
    const arm = src.indexOf('presearchStartedRef.current = true;');
    const open = src.lastIndexOf('useEffect(() => {', arm);
    expect(open).toBeGreaterThan(-1);
    const body = src.slice(open, arm);
    expect(body).toContain('FEATURE_PRESEARCH_ADD');
    expect(body).toContain('cfgFlags.presearchAdd');
  });

  it('gates the parallel-add branch on flags.parallelAdd', () => {
    const at = src.indexOf('const beginSearchFlow = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n  }, [', at));
    // Both halves on the same branch: dropping the constant would ship the
    // pilot flag's decision to config, and dropping the config read is the
    // regression this whole file is about.
    expect(body).toMatch(/FEATURE_PARALLEL_ADD && cfgFlagsRef\.current\.parallelAdd/);
  });

  it('computes the pre-search commit jitter from flags.addCommitJitterMs', () => {
    const at = src.indexOf('const presearchOnInjectAdd = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n  }, [', at));
    expect(body).toContain('cfgFlagsRef.current.addCommitJitterMs');
    // Reading the config and then doing the arithmetic on the build constant
    // anyway is the mutation a `toContain` alone cannot see: the config read
    // would still be right there in the source. So the constant must appear
    // ONLY as the `??` fallback, never as an operand of the jitter itself.
    expect(body).not.toMatch(/ADD_COMMIT_JITTER_MS\s*\+/);
    expect(body).not.toMatch(/\*\s*ADD_COMMIT_JITTER_MS/);
  });

  it('reads every flag it declares, or says why not', () => {
    // The test that stops the original defect reopening. A key added to
    // FlagConfig is inert until something consumes it, and nothing else in the
    // suite can notice — the merge tests pass on a key no reader exists for.
    for (const key of Object.keys(BUNDLED_AUTOMATION_CONFIG.flags)) {
      if (DELIBERATELY_UNREAD[key]) continue;
      expect({ key, read: src.includes(`.${key}`) }).toEqual({ key, read: true });
    }
  });

  it('keeps the deliberately-unread list honest', () => {
    // A stale exemption is the other way this rots: `backgroundCart` sitting
    // here after someone wires it would exempt a key that no longer needs it,
    // and the next unread key added beside it inherits the excuse.
    for (const key of Object.keys(DELIBERATELY_UNREAD)) {
      expect(Object.keys(BUNDLED_AUTOMATION_CONFIG.flags)).toContain(key);
    }
  });
});
