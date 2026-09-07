/**
 * A PREWARM VERDICT NEVER OPENS THE SIGN-IN SCREEN.
 *
 * Stephen's rule, given on 2026-09-02 about Albertsons and repeated on
 * 2026-09-07 about ALDI and Publix:
 *
 *     positive signal we are NOT logged in -> show the webview
 *     positive signal we ARE logged in     -> continue with the add
 *     no signal                            -> show the webview
 *
 * and, plainly: "the webview should not open until mealio is 100% sure we are
 * not logged in."
 *
 * A prewarm verdict is not the first line. It is one probe's answer, taken
 * early, from a WebView built for speed -- and for an Instacart banner it was
 * taken on robots.txt, where the rail cannot answer at all. It is a hint that
 * decides whether to SKIP work, never a reason to put a login wall in front of
 * someone.
 *
 * The sheet has two entry points and they were fixed thirteen days apart:
 * handleStartSearch in September, the auto-start path inside the [visible]
 * effect only after Stephen hit the half that was left. A source check is
 * coarse, but what it catches is exactly what happened -- one entry point being
 * fixed and the other left behind.
 */
import * as fs from 'fs';
import * as path from 'path';

const SHEET = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'components', 'WebViewCartSheet.tsx'), 'utf8');

/** The body of each `pre === '<state>'` arm, up to its sibling. */
function armsFor(src: string, state: string): string[] {
  const needle = "pre === '" + state + "'";
  const out: string[] = [];
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + needle.length)) {
    const rest = src.slice(at + needle.length);
    // Stop at the sibling arm. A generous fixed window instead of this ran
    // straight past the end of the branch and picked up a surfaceLogin call
    // from unrelated code below it -- the assertion then failed on the right
    // file for the wrong reason, which is worse than not having it.
    const stop = rest.indexOf('else if (pre ===');
    out.push(rest.slice(0, stop === -1 ? 1200 : stop));
  }
  return out;
}

describe('the sheet never surfaces login on the prewarm alone', () => {
  it('has no surfaceLoginDirect left to call', () => {
    // Deleted rather than left for a future caller, because a future caller is
    // the bug: anything that opens the sign-in screen without a live check
    // reintroduces the flash.
    expect(SHEET).not.toMatch(/surfaceLoginDirect\s*\(/);
    expect(SHEET).not.toMatch(/const surfaceLoginDirect/);
  });

  it('routes every prewarm loggedOut into its own check', () => {
    const arms = armsFor(SHEET, 'loggedOut');
    // Two entry points; if a third appears it has to be looked at, not assumed.
    expect(arms).toHaveLength(2);
    // THE RULE IS "DOES NOT SURFACE LOGIN", not "calls startLoginCheck".
    //
    // The two entry points reach the check differently and both are right:
    // the auto-start arm calls it, and handleStartSearch's arm logs and falls
    // through to the check below it. Asserting the call site would pin one
    // implementation and fail on the other -- which it did, on correct code.
    for (const body of arms) expect(body).not.toMatch(/surfaceLogin[\w.]*\s*\(/);
  });

  it('has the auto-start arm run the check explicitly, since it cannot fall through', () => {
    // handleStartSearch's arm falls through; this one sits in an if/else chain
    // inside the [visible] effect, so falling through would start nothing at
    // all. It is the arm that was surfacing login directly until 2026-09-07.
    const [autoStart] = armsFor(SHEET, 'loggedOut');
    expect(autoStart).toContain('startLoginCheckRef.current()');
  });

  it('still lets a positive loggedIn skip the check', () => {
    // The other direction must NOT be tightened by accident. Being wrong here
    // costs a run that fails at the first write and is surfaced by reconcile;
    // being wrong the other way blocks someone from their own groceries.
    const arms = armsFor(SHEET, 'loggedIn');
    expect(arms).toHaveLength(2);
    for (const body of arms) expect(body).toMatch(/snapshotBeforeAndBeginSearch/);
  });

  it('would notice if an arm stopped checking, rather than passing vacuously', () => {
    const faked = "if (pre === 'loggedOut') { surfaceLoginRef.current(); } else if (pre === 'loggedIn') {}";
    const [body] = armsFor(faked, 'loggedOut');
    expect(body).not.toContain('startLoginCheck');
    expect(body).toMatch(/surfaceLogin[\w.]*\s*\(/);
  });
});
