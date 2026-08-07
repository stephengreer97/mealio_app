import {
  setLastAutomationRun,
  getLastAutomationRun,
  clearLastAutomationRun,
} from '../../src/lib/lastRun';

// MEAL-142. The point of this module is that a bug report can be joined to the
// telemetry rows for the run it is about. The tests below are mostly about the
// ways that join can go WRONG — a missing id, a stale one, the wrong run — because
// a runId that points at an unrelated trace is worse than sending none.

describe('the run a bug report is about', () => {
  beforeEach(() => clearLastAutomationRun());

  it('reports nothing before any run has an id', () => {
    expect(getLastAutomationRun()).toBeNull();
  });

  it('carries the run id and the store, so a report names both', () => {
    setLastAutomationRun('run-abc', 'heb', 1_000);
    expect(getLastAutomationRun(1_000)).toEqual({
      runId: 'run-abc',
      storeId: 'heb',
      ageMs: 0,
    });
  });

  it('ages the run, which is how a reader tells a fresh report from a stale one', () => {
    setLastAutomationRun('run-abc', 'heb', 1_000);
    expect(getLastAutomationRun(1_000 + 45_000)?.ageMs).toBe(45_000);
    // Two days later the id still comes back — deliberately. The reader has the
    // description and the logs and can judge; discarding it here would lose the
    // association for someone who hit a bug, kept shopping, and reported it after.
    expect(getLastAutomationRun(1_000 + 2 * 24 * 3_600_000)?.runId).toBe('run-abc');
  });

  it('never reports a negative age when the clock moves backwards', () => {
    setLastAutomationRun('run-abc', 'heb', 10_000);
    expect(getLastAutomationRun(5_000)?.ageMs).toBe(0);
  });

  it('answers with the most recent run, not the first', () => {
    setLastAutomationRun('run-old', 'heb', 1_000);
    setLastAutomationRun('run-new', 'walmart', 2_000);
    expect(getLastAutomationRun(2_000)).toMatchObject({
      runId: 'run-new',
      storeId: 'walmart',
    });
  });

  it('ignores an empty id rather than recording a run that has no rows to join to', () => {
    setLastAutomationRun('', 'heb', 1_000);
    expect(getLastAutomationRun()).toBeNull();
  });

  it('does not let a failed run erase the last real one', () => {
    setLastAutomationRun('run-abc', 'heb', 1_000);
    // A run whose logAutomationStart never came back has no id, so it must not
    // overwrite the run the user is most likely reporting on.
    setLastAutomationRun('', 'walmart', 2_000);
    expect(getLastAutomationRun(2_000)?.runId).toBe('run-abc');
  });
});
