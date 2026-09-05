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
// The section has one tenant again since 2026-09-05: `manualPrefetch`, the kill
// switch for warming the next page of the Add It Yourself pass. It earns the
// slot on MEAL-32's own terms -- it is READ, through
// decisions.shouldWarmManualPage, and `every declared flag reaches a decision`
// covers it generically next door. It is a lever rather than a constant because
// it is the one thing here that fetches a store page the user did not ask for.
//
// What is still worth testing is that the section behaves: what ships, and that
// a push aimed at a flag that no longer exists is refused rather than silently
// accepted.

const SHIPPED_FLAGS = { manualPrefetch: true };

describe('the flags section', () => {
  it('ships exactly what is declared', () => {
    expect(BUNDLED_AUTOMATION_CONFIG.flags).toEqual(SHIPPED_FLAGS);
  });

  it('defaults the warm-up ON, because undefined must not turn it off', () => {
    // A device holding a config from before the flag existed has no key here.
    // Reading that as "off" would silently withdraw a shipped behaviour.
    expect(BUNDLED_AUTOMATION_CONFIG.flags.manualPrefetch).toBe(true);
  });

  it('merges to the shipped set with no override, and says nothing is wrong', () => {
    const { config, warnings } = mergeAutomationConfig({});
    expect(config.flags).toEqual(SHIPPED_FLAGS);
    expect(warnings).toEqual([]);
  });

  it('accepts a push that turns the warm-up off', () => {
    const { config, warnings } = mergeAutomationConfig({ flags: { manualPrefetch: false } });
    expect(config.flags.manualPrefetch).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('REFUSES a push aimed at a flag that no longer exists', () => {
    // Someone reaching for `parallelAdd: false` in an incident is reaching for a
    // lever that was removed. It must not look like it worked.
    const { config, warnings } = mergeAutomationConfig({
      flags: { parallelAdd: false, addCommitJitterMs: 1_500 } as Record<string, unknown>,
    });
    expect(config.flags).toEqual(SHIPPED_FLAGS);
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
