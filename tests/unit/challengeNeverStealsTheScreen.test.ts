/**
 * A bot challenge must not take a screen the user is using.
 *
 * Stephen, 2026-09-03: "the reconciliation items didn't get added. Seems like
 * they weren't even searched or attempted to be added."
 *
 * They weren't. He was on the review screen with two items to place when a rail
 * reported a block — for a DIFFERENT store's run, because the sheet is mounted
 * at app root and outlives any one run — and the sheet swapped his review for a
 * verification screen. His picks went with it.
 *
 * The decision is small enough to test on its own, which is the point: the last
 * attempt at covering this went through the whole component and produced three
 * tests that passed whether or not the feature worked.
 */
import { challengeMayTakeTheScreen } from '../../src/lib/cart-challenge';

describe('a rail block may interrupt a run, never a decision', () => {
  it.each(['searching', 'adding', 'login_check', 'qty'] as const)(
    'takes the screen during %s, which is the run working', (step) => {
      expect(challengeMayTakeTheScreen(step, false)).toBe(true);
    });

  it.each(['review', 'searchResult', 'done', 'manual'] as const)(
    'leaves %s alone, because the user is deciding there', (step) => {
      expect(challengeMayTakeTheScreen(step, false)).toBe(false);
    });

  it('only once per run — a second block means the first fix did not take', () => {
    expect(challengeMayTakeTheScreen('searching', true)).toBe(false);
  });
});
