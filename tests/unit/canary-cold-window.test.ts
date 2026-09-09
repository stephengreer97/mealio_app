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

describe('the runner reads results instead of pattern-matching them', () => {
  it('parses the clear result as JSON', () => {
    // It looked for '"ok": true' WITH a space; the rail posts '{"ok":true'
    // without one. So a cleanup that removed exactly what it meant to, and said
    // so, was recorded as a failure. A canary whose verdict turns on whitespace
    // cannot do the one job it has.
    expect(src).not.toContain('\'"ok": true\' in line');
    expect(src).toContain("payload.get('ok') is True");
  });

  it('says so when the result cannot be parsed at all', () => {
    // Unparseable and false are different answers; collapsing them is how the
    // last four of these bugs hid.
    expect(src).toContain('could not parse the clear result');
  });
});

describe('the cold window is opt-in', () => {
  it('does not run unless --cold is passed', () => {
    // It is the only part of the canary that WRITES to the meals it tests, and
    // a walk that fails leaves a meal uncurated -- after which the add windows
    // measure nothing, on a store that was fine. Off until the walk is clean
    // everywhere.
    expect(src).toContain("COLD = '--cold' in sys.argv");
    expect(src).toContain('if COLD:');
    expect(src).toContain('COLD = False');
  });

  it('keeps the add, repeat, merge and cleanup windows independent of it', () => {
    // Those four are the canary proper and must not depend on a chooser walk.
    const main = src.slice(src.indexOf('def main():'));
    const single = main.indexOf("entry['windows']['single']");
    const cold = main.indexOf('if COLD:');
    expect(cold).toBeGreaterThan(-1);
    expect(single).toBeGreaterThan(cold);
    expect(main.slice(single)).toContain("entry['windows']['repeat']");
    expect(main.slice(single)).toContain("entry['windows']['combination']");
  });
});

describe('a window ends on the run\'s own verdict, not on a timeout', () => {
  // A run PARKS at the end. H-E-B's window sat on "Items Not Added -- 2 items
  // could not be added to cart / Nonexistent Unobtainium 9000: H-E-B had no
  // match for this" until its 240s settle expired, three times per store, and
  // recorded nothing at all. That sheet is a RESULT, not a question: it is the
  // unfindable line's branch reported correctly, and it is the single most
  // interesting thing a window produces.
  it('reads the not-added sheet and closes it', () => {
    const wait = src.slice(src.indexOf('def run_once'), src.indexOf('def cart_count'));
    expect(wait).toContain("'could not be added' in xml");
    expect(wait).toContain('run-reported-items-not-added');
    // And it must actually record WHICH items, not just that there were some.
    expect(wait).toContain("'not-added: '");
  });

  it('answers a review rather than waiting for a person', () => {
    // An item with no candidates parks the run on a review screen. Skipping is
    // the honest answer and the branch the plan expects that line to take.
    const wait = src.slice(src.indexOf('def run_once'), src.indexOf('def cart_count'));
    expect(wait).toContain("'Skip this ingredient' in xml");
    expect(wait).toContain('skipped-in-review');
  });

  it('still returns the window start time', () => {
    // The nightly script reads windows.single as an ISO string to hand the
    // scorer; making this a dict would break scoring silently.
    const wait = src.slice(src.indexOf('def run_once'), src.indexOf('def cart_count'));
    expect(wait).toContain('return since');
  });
});

describe('a window refuses to run something it cannot identify', () => {
  // Three windows once ran WEGMANS with a Caprese Sandwich while reporting
  // themselves as H-E-B canary windows. The store chip had not changed, the
  // meal tap landed on a neighbour, and each window recorded a tidy timestamp
  // for work nobody asked for.
  //
  // That is the worst shape a canary result can take: not a failure, but a
  // green for the wrong thing. The device is shared state and every assumption
  // about what is on screen has been wrong at least once, so the run checks the
  // app's own words before it commits.
  it('checks the action button names this store', () => {
    expect(src).toContain('def _action_label');
    const start = src.slice(src.indexOf('def _start_run'), src.indexOf('def _action_label'));
    expect(start).toContain('store_chip.lower() not in label.lower()');
  });

  it('checks the meal COUNT matches what it selected', () => {
    // A combination window that selected one meal is not a combination window,
    // and it would otherwise pass as one.
    const start = src.slice(src.indexOf('def _start_run'), src.indexOf('def _action_label'));
    expect(start).toContain('want = 2 if second_meal else 1');
  });

  it('reports an unverifiable window as a rig problem, not a store failure', () => {
    // Neither a pass nor a red store: the phone was in a state the runner did
    // not expect, which says nothing about whether the store works.
    expect(src).toContain("'skipReason': 'wrong_selection'");
  });

  it('fails loudly when the store chip cannot be selected', () => {
    // select_store returned False and nothing looked at it, so the run carried
    // on against whichever store happened to be showing.
    expect(src).toContain("could not select the %r chip");
  });
});
