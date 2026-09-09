/**
 * MEAL-7's cold window: clear the chosen products, then choose them again
 * through the real chooser.
 *
 * Stephen asked whether the canary tests choose-products as well as the
 * automation, and whether the selections should be cleared after each run. They
 * should be cleared at the START -- clearing afterwards leaves the meal
 * uncurated until somebody notices, while clearing and re-choosing makes
 * curation part of the run and keeps the plan current as stores relist.
 *
 * The danger is the obvious one, and it bit immediately: the re-choose is UI
 * automation against a live store, and when it fails the meal is left with
 * NOTHING chosen -- worse than before the run started, with every add window
 * after it having nothing to add. H-E-B ended up exactly there.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'live', 'device', 'canary.py'), 'utf8');

describe('clearing the canary meals is reversible', () => {
  it('snapshots before it clears', () => {
    expect(src).toContain('snapshot[name]');
    expect(src).toMatch(/def restore_selections/);
  });

  it('restores when the re-choose does not finish', () => {
    // One finding (the chooser is broken) must not become four (and nothing
    // else could be measured either).
    const main = src.slice(src.indexOf("entry['choose'] = {"), src.indexOf("entry['windows']['single']"));
    expect(main).toContain('restore_selections');
    expect(main).toContain("if not entry['choose'].get('ok')");
  });

  it('records a chooser that never opened, distinctly from an empty walk', () => {
    // An empty step list reads exactly like "nothing to do", which is how a walk
    // that never saw the chooser first reported success. The step is still
    // recorded for diagnosis -- but it is no longer what DECIDES the outcome,
    // because a label-based gate always misses the label nobody anticipated.
    // See the outcome check below.
    expect(src).toContain("'chooser-never-opened'");
  });

  it('waits for each ingredient search, not just the first', () => {
    // Every step runs its own live search. Acting on a half-rendered screen is
    // how the walk skipped an ingredient that had 40 candidates a second later.
    const walk = src.slice(src.indexOf('def choose_products'), src.indexOf('def run_once'));
    expect(walk.match(/candidate-0' in x/g)?.length).toBeGreaterThanOrEqual(1);
    expect(walk).toContain("'candidate-0' in xml or 'Products chosen' in xml");
  });
});

describe('the meal card is selected by its exact id', () => {
  // The single worst bug in the curation walk, and it presented as a race.
  //
  // drive.tap_id matches a SUBSTRING, and the combination window's duplicate is
  // the primary's name with a " B" on the end -- so "meal-card-Canary HEB" also
  // matches "meal-card-Canary HEB B". The walk opened whichever the dump listed
  // first, found only the line THAT meal had left unchosen, and reported
  // 'skipped' or 'stuck' about an ingredient nobody had asked it to touch. The
  // symptoms moved around between runs, which is what made it look like timing.
  it('never selects a meal by substring', () => {
    expect(src).toContain('def tap_meal_card');
    expect(src).toContain("rid.group(1) != want");
    // No path may reach a meal card through the substring matchers again.
    expect(src).not.toMatch(/tap_id\('meal-card-/);
    expect(src).not.toMatch(/tap_text\(meal_name/);
    expect(src).not.toMatch(/tap_text\(second_meal/);
  });

  it('presses the quantity stepper by bounds, not by its label', () => {
    // The '+' node is NOT marked clickable -- the handler sits on a parent -- so
    // tap_text('+') raises, and an except that swallowed it left the quantity
    // unset. The primary is disabled until it is set, a disabled tap is silent,
    // and the walk called that 'stuck'.
    expect(src).toContain('def _bump_qty');
    expect(src).toContain('qty-stepper-choose');
    const walk = src.slice(src.indexOf('def choose_products'), src.indexOf('def run_once'));
    expect(walk).not.toContain("tap_text('+'");
  });

  it('distinguishes a store answering "none" from a walk that gave up', () => {
    // H-E-B returns nothing at all for "Whole milk". That is a fact about the
    // store and belongs in the result as such, not hidden inside a generic skip
    // that also covers "I could not work this screen out".
    expect(src).toContain("'no-candidates' if answered else 'skipped'");
  });
});

describe('the meal decides whether curation worked, not the walk', () => {
  // The walk reports what it THINKS it did, and it has been wrong about that in
  // three different ways: an empty step list that read as "nothing to do", a
  // 'chose' for a screen that never moved, and a clean-looking run of
  // 'no-candidates' that left Walmart with nothing selected at all while passing
  // the step check -- so the restore guard, which exists for exactly that, did
  // not fire and the meal stayed empty.
  //
  // Reading the meal back cannot be fooled by any of them.
  it('verifies by reading the meal, not by inspecting step labels', () => {
    expect(src).toContain('def selections_ok');
    const main = src.slice(src.indexOf("entry['choose'] = {"), src.indexOf("entry['windows']['single']"));
    expect(main).toContain('selections_ok(meal)');
    expect(main).toContain('selections_ok(second)');
    // The old label-sniffing gate must be gone: a step vocabulary that grows
    // will always have a label nobody thought to treat as failure.
    expect(main).not.toContain("bad = ('stuck'");
  });

  it('does not count the deliberately unfindable line as missing', () => {
    // It is expected to have no product. That is the branch it exists for, and
    // treating it as a failure would make every successful curation look broken.
    expect(src).toContain("never=('Nonexistent unobtainium 9000',)");
  });
});
