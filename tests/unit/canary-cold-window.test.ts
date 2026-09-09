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

  it('counts a chooser that never opened as a failure, not a pass', () => {
    // An empty step list reads exactly like "nothing to do", which is how a
    // walk that never saw the chooser first reported success.
    expect(src).toContain("'chooser-never-opened'");
    const main = src.slice(src.indexOf("entry['choose'] = {"), src.indexOf("entry['windows']['single']"));
    expect(main).toContain('chooser-never-opened');
  });

  it('waits for each ingredient search, not just the first', () => {
    // Every step runs its own live search. Acting on a half-rendered screen is
    // how the walk skipped an ingredient that had 40 candidates a second later.
    const walk = src.slice(src.indexOf('def choose_products'), src.indexOf('def run_once'));
    expect(walk.match(/candidate-0' in x/g)?.length).toBeGreaterThanOrEqual(1);
    expect(walk).toContain("'candidate-0' in xml or 'Products chosen' in xml");
  });
});
