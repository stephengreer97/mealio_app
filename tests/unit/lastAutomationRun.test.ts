import {
  setLastAutomationRun,
  getLastAutomationRun,
  clearLastAutomationRun,
  formatAge,
} from '../../src/lib/lastAutomationRun';

// MEAL-142. The point of this module is that a bug report can be joined to the
// telemetry rows for the run it is about. The tests below are mostly about the
// ways that join can go WRONG — a missing id, the wrong run, an age nobody can
// read — because a runId that silently points at an unrelated trace is worse
// than sending none.

describe('the last cart run of a session', () => {
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
      ageLabel: '0s ago',
    });
  });

  it('ages the run, so a reader can tell a fresh report from a late one', () => {
    setLastAutomationRun('run-abc', 'heb', 1_000);
    expect(getLastAutomationRun(1_000 + 45_000)?.ageMs).toBe(45_000);
    expect(getLastAutomationRun(1_000 + 45_000)?.ageLabel).toBe('45s ago');
  });

  it('keeps the association however long the gap, because losing it is worse', () => {
    // No cutoff, deliberately. A dropped association cannot be recovered by the
    // person reading the report; a stale one is noise they reject as soon as they
    // open the run and see it does not match the description. In practice a long
    // gap barely happens — this is module state and dies with the JS context, the
    // same as the log buffer it would be joined to — but when it does, the reader
    // gets a legible "1 hour ago" rather than a silently missing key.
    setLastAutomationRun('run-abc', 'heb', 1_000);
    const late = getLastAutomationRun(1_000 + 90 * 60_000);
    expect(late?.runId).toBe('run-abc');
    expect(late?.ageLabel).toBe('2 hours ago');
  });

  it('never reports a negative age when the clock moves backwards', () => {
    setLastAutomationRun('run-abc', 'heb', 10_000);
    expect(getLastAutomationRun(5_000)?.ageMs).toBe(0);
    expect(getLastAutomationRun(5_000)?.ageLabel).toBe('0s ago');
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

  it('forgets the run when told to, which is what logout does', () => {
    setLastAutomationRun('run-abc', 'heb', 1_000);
    clearLastAutomationRun();
    expect(getLastAutomationRun(2_000)).toBeNull();
  });
});

// The age is formatted here because it cannot be formatted downstream: the
// website prints each context value with String(v) and has no formatting hook,
// so an unformatted age lands in the inbox as `172800000` — a nine-digit integer
// in the last row of a nine-row table, which is the same as not sending it.
describe('the age a reader actually sees', () => {
  it('reads in seconds for a report filed straight after the run', () => {
    expect(formatAge(0)).toBe('0s ago');
    expect(formatAge(4_000)).toBe('4s ago');
    expect(formatAge(59_000)).toBe('59s ago');
  });

  it('reads in minutes inside the hour', () => {
    expect(formatAge(60_000)).toBe('1m ago');
    expect(formatAge(2 * 60_000)).toBe('2m ago');
    expect(formatAge(59 * 60_000)).toBe('59m ago');
  });

  it('spells out hours, so "1" cannot be misread as a minute count', () => {
    expect(formatAge(3_600_000)).toBe('1 hour ago');
    expect(formatAge(5 * 3_600_000)).toBe('5 hours ago');
  });

  it('spells out days — the case a raw millisecond count hid completely', () => {
    expect(formatAge(24 * 3_600_000)).toBe('1 day ago');
    expect(formatAge(2 * 24 * 3_600_000)).toBe('2 days ago');
    // Rounds DOWN across days: 47 hours is still "1 day ago", never a
    // reassuring-looking "2 days ago" for something not yet two days old.
    expect(formatAge(47 * 3_600_000)).toBe('1 day ago');
  });

  it('never shows a negative age', () => {
    expect(formatAge(-5_000)).toBe('0s ago');
  });
});
