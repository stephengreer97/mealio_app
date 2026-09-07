/**
 * Which page a login probe loads, and why it is ONE rule rather than two.
 *
 * Stephen, 2026-09-07: "when we are logged in, we are seeing the login prompt
 * from mealio for a couple seconds before it realizes. The webview should not
 * open until mealio is 100% sure we are not logged in."
 *
 * Two things caused that flash and both are here. The cart sheet and the silent
 * prewarm probe each wrote out their own copy of "park on the quiet page", so
 * fixing the sheet left the prewarm still mounting on robots.txt -- where the
 * Instacart rail provably cannot answer -- and publishing a signed-out verdict
 * for the whole session. Measured, one run, six seconds apart:
 *
 *   robots.txt  harvested 0, ActiveCarts 401  -> "signed out"
 *   storefront  harvested 6, ActiveCarts 200  -> SIGNED IN
 */
import { loginProbeUrl } from '../../src/lib/login-page';

const SCRIPTS = { railUrl: 'https://www.aldi.us/robots.txt', storeUrl: 'https://www.aldi.us/store/aldi/storefront' };

describe('loginProbeUrl', () => {
  it('parks on the quiet page for a rail that can answer from it', () => {
    expect(loginProbeUrl(SCRIPTS, { sessionNeedsStorefront: false })).toBe(SCRIPTS.railUrl);
  });

  it('loads the storefront for a rail that cannot', () => {
    expect(loginProbeUrl(SCRIPTS, { sessionNeedsStorefront: true })).toBe(SCRIPTS.storeUrl);
  });

  it('parks on the quiet page when there is no rail at all', () => {
    expect(loginProbeUrl(SCRIPTS, null)).toBe(SCRIPTS.railUrl);
    expect(loginProbeUrl(SCRIPTS, undefined)).toBe(SCRIPTS.railUrl);
  });

  it('falls back to the storefront when a store has no quiet page', () => {
    expect(loginProbeUrl({ railUrl: null, storeUrl: SCRIPTS.storeUrl }, null)).toBe(SCRIPTS.storeUrl);
    expect(loginProbeUrl({ storeUrl: SCRIPTS.storeUrl }, null)).toBe(SCRIPTS.storeUrl);
  });
});

describe('both probes ask the same question the same way', () => {
  // THE POINT OF EXTRACTING IT. The rule existed twice, in two files, and the
  // copies drifted the moment one was fixed. A source check is coarse, but the
  // failure it catches is precisely "someone wrote the choice out again".
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (...p: string[]) =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

  it.each([
    ['components/SilentLoginProbe.tsx'],
    ['components/WebViewCartSheet.tsx'],
  ])('%s picks its probe page through loginProbeUrl', (file) => {
    expect(read(...file.split('/'))).toContain('loginProbeUrl(');
  });

  it('neither reaches for railUrl on its own any more', () => {
    for (const f of ['components/SilentLoginProbe.tsx', 'components/WebViewCartSheet.tsx']) {
      const src = read(...f.split('/'));
      // The shapes both files used to build the choice by hand.
      expect(`${f}: ${/railUrl\s*\|\|\s*.*storeUrl/.test(src)}`).toBe(`${f}: false`);
      expect(`${f}: ${/sessionNeedsStorefront\s*&&/.test(src)}`).toBe(`${f}: false`);
    }
  });
});
