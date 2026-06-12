// Shared helpers for per-store fixture spec files.
//
// Every store spec needs the same "load fixture, inject script, capture
// messages, auto-skip when fixture missing" plumbing. This module
// centralizes it so each store spec file is just a coverage matrix.

import * as fs from 'fs';
import * as path from 'path';

import { loadFixture, FixtureRunner } from '../fixture-runners/runScript';

/**
 * Build a per-store fixture helper bound to that store's fixture directory.
 * Use:
 *
 *   const wegmans = storeFixtures('wegmans');
 *   wegmans.itWithFixture('logged-in-home.html', 'detects login', async (runner) => {
 *     await runner.inject(...);
 *     ...
 *   });
 */
export function storeFixtures(storeId: string) {
  const dir = path.resolve(__dirname, '..', 'fixtures', storeId);

  function fxPath(name: string): string {
    return path.join(dir, name);
  }

  function fixtureExists(name: string): boolean {
    try {
      return fs.statSync(fxPath(name)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Wraps `it()` so the test auto-skips (with a useful message) when its
   * fixture file isn't present. Encourages the user to run `npm run capture`
   * rather than failing.
   *
   * The body receives a runner that's already loaded with the fixture HTML
   * and the postMessage bridge installed. The runner is closed automatically
   * after the body runs (success or failure).
   */
  function itWithFixture(
    fixtureName: string,
    description: string,
    body: (runner: FixtureRunner) => Promise<void>,
    options: { url?: string } = {},
  ) {
    const fn = fixtureExists(fixtureName) ? it : it.skip;
    const label = fixtureExists(fixtureName)
      ? description
      : `${description} [SKIPPED — capture ${fixtureName} first]`;
    fn(label, async () => {
      const runner = await loadFixture(fxPath(fixtureName), options);
      try {
        await body(runner);
      } finally {
        await runner.close();
      }
    });
  }

  return {
    /** Absolute path to a fixture file (may not exist) */
    fxPath,
    /** Whether the fixture exists on disk */
    fixtureExists,
    /** it() that auto-skips with a useful message when the fixture is missing */
    itWithFixture,
  };
}
