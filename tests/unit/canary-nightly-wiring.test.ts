/**
 * MEAL-7. The nightly job's contract, asserted on the script rather than on a
 * run: this thing fires at 03:15 with nobody watching, and the two ways it can
 * be quietly wrong are both about what it does when things go badly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'canary-nightly.sh'), 'utf8');

describe('the nightly canary job', () => {
  it('never exits non-zero', () => {
    // A phone asleep on a nightstand is not a failing store. A non-zero exit
    // from cron mails someone about it, and the fastest way to make a canary
    // useless is to have it cry wolf every night the device is unplugged.
    expect(script).toContain('exit 0');
    // No path may end in a bare failure exit.
    expect(script).not.toMatch(/\bexit [1-9]\b/);
  });

  it('treats "could not find the run" as a rig problem, not a store failure', () => {
    // The scorer's exit code IS the verdict: 0 passed, 1 failed, 2 the run could
    // not be found. Publishing a 2 as `passed: false` would paint a store red
    // for a device that never woke up.
    expect(script).toContain('run_not_found');
    expect(script).toContain('code !== 2');
  });

  it('publishes per store rather than stopping at the first bad one', () => {
    // One store that cannot be scored must not cost the other four their rows.
    expect(script).toContain('|| true');
  });

  it('keeps the runner output on disk', () => {
    // "The device was locked" belongs in a file next to the run, not in a mail
    // spool nobody reads.
    expect(script).toContain('.mealio-canary');
    expect(script).toMatch(/run-\$STAMP\.err/);
  });
});
