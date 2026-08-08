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
 * One line with any `//` comment removed, quote-aware.
 *
 * Quote-aware because this file is full of `https://` URLs and a naive
 * `/\/\/.*$/` truncates every line carrying one. Tracking string state costs a
 * dozen lines and is the difference between a filter that works and one that
 * silently deletes code it was never meant to touch.
 */
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/**
 * `src` with every comment removed — whole lines and trailing ones alike.
 *
 * These assertions have to distinguish a flag the engine READS from one it
 * merely mentions, and this file mentions all of them in prose: the note beside
 * each gate names `flags.presearchAdd` in the very comment explaining it.
 *
 * Dropping comment-ONLY lines is not enough, and the gap was live. A cold review
 * demonstrated that replacing the gate with
 *
 *   if (!FEATURE_PRESEARCH_ADD) return; // gate removed; see cfgFlags.presearchAdd
 *
 * deleted the entire wiring with all ten tests green — the trailing comment
 * carried the string every assertion was looking for. So trailing comments go
 * too, and every assertion below reads `code`, never `src`.
 */
const code = src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(stripLineComment)
  .join('\n');

/** Does the engine actually read `flags.<key>` off the config snapshot? */
function readsFlag(key: string): boolean {
  // Anchored to the two legal read forms, and \b-terminated. Neither detail is
  // decoration: a bare `.${key}` search reports `parallelAdd` as read because
  // `cfgFlags.parallelAddWorkers` — a DIFFERENT key, wired years earlier —
  // contains it as a prefix. That false positive was live until a mutant found it.
  return new RegExp(`\\bcfgFlags(?:Ref\\.current)?\\.${key}\\b`).test(code);
}

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
    const arms = code.match(/presearchStartedRef\.current = true;/g) ?? [];
    expect(arms.length).toBe(1);
  });

  it('gates pre-search parking on flags.presearchAdd, in the right direction', () => {
    const arm = code.indexOf('presearchStartedRef.current = true;');
    const open = code.lastIndexOf('useEffect(() => {', arm);
    expect(open).toBeGreaterThan(-1);
    const body = code.slice(open, arm);
    // POLARITY, not just presence. `toContain('cfgFlags.presearchAdd')` cannot
    // see a dropped `!`, and a cold review showed what that costs: with
    // `|| cfgFlags.presearchAdd` the switch runs backwards — the bundled default
    // `true` disables pre-search on every build, and publishing `false` turns it
    // ON. All ten tests passed. A ticket that exists because a switch did nothing
    // must not ship one that does the opposite of what it says.
    expect(body).toMatch(/!FEATURE_PRESEARCH_ADD\s*\|\|\s*!cfgFlags\.presearchAdd/);
  });

  it('gates the parallel-add branch on flags.parallelAdd', () => {
    const at = code.indexOf('const beginSearchFlow = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf('\n  }, [', at));
    // Both halves on the same branch: dropping the constant would ship the
    // pilot flag's decision to config, and dropping the config read is the
    // regression this whole file is about.
    expect(body).toMatch(/FEATURE_PARALLEL_ADD && cfgFlagsRef\.current\.parallelAdd/);
  });

  it('computes the pre-search commit jitter from flags.addCommitJitterMs', () => {
    const at = code.indexOf('const presearchOnInjectAdd = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf('\n  }, [', at));
    expect(body).toContain('cfgFlagsRef.current.addCommitJitterMs');
    // The RANDOMISATION, not just the source of the base. `const jitter = base`
    // reads the config correctly and still turns every worker's commit into a
    // fixed 500ms metronome — which is the exact property §1.5 of
    // docs/store-fingerprint-profiles.md calls load-bearing, and it passed all
    // ten tests. `base` has to appear on both sides of the arithmetic.
    expect(body).toMatch(/jitter\s*=\s*base\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*base\)/);
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
      expect({ key, read: readsFlag(key) }).toEqual({ key, read: true });
    }
  });

  it('keeps the deliberately-unread list honest', () => {
    // A stale exemption is the other way this rots: `backgroundCart` sitting
    // here after someone wires it would exempt a key that no longer needs it,
    // and the next unread key added beside it inherits the excuse.
    for (const key of Object.keys(DELIBERATELY_UNREAD)) {
      expect(Object.keys(BUNDLED_AUTOMATION_CONFIG.flags)).toContain(key);
      // And that the exemption is still needed. Wiring `backgroundCart` without
      // deleting its row here would leave a standing excuse for the next unread
      // key someone adds beside it.
      expect({ key, read: readsFlag(key) }).toEqual({ key, read: false });
    }
  });
});
