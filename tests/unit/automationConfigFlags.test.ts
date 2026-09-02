import { mergeAutomationConfig } from '../../src/lib/automation-config/merge';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';

// MEAL-32 built this file to prove a flag that merges is a flag that is READ.
// The lesson stands; the flags do not.
//
// All four — parallelAdd, presearchAdd, parallelAddWorkers, addCommitJitterMs —
// were levers over the DOM worker pools: add concurrently or not, how many pages
// to hold open, how much to jitter the burst. DOM automation was removed on
// 2026-09-01 and the pools went with it, so every one of them became a switch
// wired to nothing. They are deleted rather than left as reassuring dead
// controls, which is the exact failure MEAL-32 was about — the difference being
// that this time the read is gone on purpose and so is the flag.
//
// What is still worth testing is that the section itself behaves: it is empty,
// and a push aimed at a flag that no longer exists is refused rather than
// silently accepted.

describe('flags after the DOM removal', () => {
  it('ships no flags at all', () => {
    expect(BUNDLED_AUTOMATION_CONFIG.flags).toEqual({});
  });

  it('merges to empty with no override, and says nothing is wrong', () => {
    const { config, warnings } = mergeAutomationConfig({});
    expect(config.flags).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('REFUSES a push aimed at a flag that no longer exists', () => {
    // Someone reaching for `parallelAdd: false` in an incident is reaching for a
    // lever that was removed. It must not look like it worked.
    const { config, warnings } = mergeAutomationConfig({
      flags: { parallelAdd: false, addCommitJitterMs: 1_500 } as Record<string, unknown>,
    });
    expect(config.flags).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(' ')).toContain('parallelAdd');
  });

  it('leaves the rest of the config alone while doing it', () => {
    const { config } = mergeAutomationConfig({
      flags: { parallelAdd: false } as Record<string, unknown>,
    });
    expect(config.timeouts).toEqual(BUNDLED_AUTOMATION_CONFIG.timeouts);
  });
});
