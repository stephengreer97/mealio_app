/**
 * MEAL-11's remaining half: a run that cannot reconcile SAYS SO.
 *
 * `shouldProbeAfterRun` requires a before-snapshot, and that requirement is
 * correct — a diff needs something to diff against. What was wrong is that the
 * refusal was silent: the call site ended in a bare `return`, so a run with no
 * baseline took the whole cart check offline and recorded nothing to say it had.
 *
 * Nobody could then tell a run that reconciled cleanly from one that never
 * tried, which is the difference the ticket exists to make visible.
 */
import { shouldProbeAfterRun } from '../../src/lib/cart-reconcile';
import * as fs from 'fs';
import * as path from 'path';

describe('shouldProbeAfterRun, unchanged and still strict', () => {
  it('refuses without a baseline, however many adds were attempted', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 9, hasBaseline: false })).toBe(false);
  });

  it('refuses when nothing was added, baseline or not', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 0, hasBaseline: true })).toBe(false);
  });

  it('probes when it has both', () => {
    expect(shouldProbeAfterRun({ addsAttempted: 1, hasBaseline: true })).toBe(true);
  });
});

describe('and the refusal is now recorded', () => {
  // A source check, said plainly: the branch is inside a `useEffect` in a
  // 8000-line component behind a run reaching 'done', and the invariant worth
  // protecting is narrow — that this particular early return is not silent.
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'components', 'WebViewCartSheet.tsx'), 'utf8');
  const at = SRC.indexOf('shouldProbeAfterRun({ addsAttempted, hasBaseline })');
  const branch = SRC.slice(at, at + 1600);

  it('has a call site at all, so a rename cannot quietly pass this file', () => {
    expect(at).toBeGreaterThan(0);
  });

  it('records a reconcile row before returning', () => {
    expect(branch).toMatch(/tel\(\)\.record\('reconcile', 'skipped'/);
  });

  it('names WHICH of the two reasons it was', () => {
    // The two have different fixes: no_baseline is the before-probe retry,
    // no_adds is a run that legitimately added nothing. One bar for both would
    // be the same mistake MEAL-219 just finished undoing elsewhere.
    expect(branch).toContain("'no_baseline'");
    expect(branch).toContain("'no_adds'");
  });

  it('calls it skipped, not an error', () => {
    // Nothing went wrong. The engine declined to guess, and putting a correct
    // refusal on the failure bars would misreport the run.
    expect(branch).not.toMatch(/record\('reconcile', 'error'/);
  });

  it('carries the cart_read phase, so it groups with the other cart work', () => {
    expect(branch).toContain("phase: 'cart_read'");
  });
});
