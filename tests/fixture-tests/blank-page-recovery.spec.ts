// Blank-login-page recovery (Albertsons, observed on a Pixel 6).
//
// The failure this guards is a document that finished loading with a populated
// <head> and nothing in the body — what an Albertsons storefront request leaves
// behind when the site's own OAuth session bounce aborts the HTML stream
// mid-flight. The user is shown a white sheet with no way to sign in, and no
// check script can report it, because they all read document.body first.
//
// The fixture is head-only on purpose. A parser always synthesizes a body even
// when the markup has none, so `body.children.length === 0` — not `!document.body`
// — is the condition a test can actually reach; the script accepts either, since
// the device produces the stricter one.
//
// The reload is asserted as a real navigation rather than through a stub:
// every member of `location` is unforgeable in Chrome, so `location.reload = fn`
// silently does not take, and a test written that way passes while proving
// nothing. Counting frame navigations is what is left, and it has the merit of
// checking the thing the user actually needs to happen.

import { buildBlankPageRecoveryScript } from '../../src/lib/webview-scripts/blank-page-recovery';
import { storeFixtures } from './_helpers';

// A real origin, answered locally by the runner's own route stub. Needed because
// the latch lives in sessionStorage, which throws on an opaque origin — the
// try/catch would swallow that and the second pass would reload again.
const STORE_URL = 'https://www.albertsons.com/';

describe('blank-page recovery', () => {
  const { itWithFixture } = storeFixtures('_generic');

  itWithFixture(
    'head-only.html',
    'reports the blank page and reloads it once',
    async (runner) => {
      // A marker on the current context. A reload replaces the document, so its
      // disappearance is the proof — and it is proof the page really was
      // reloaded, not merely that a navigation event was emitted somewhere.
      await runner.page.evaluate(() => {
        (window as unknown as { __preReload?: number }).__preReload = 1;
      });

      // The reload tears down the execution context this call is awaiting, so
      // the rejection IS the expected outcome, not a failure to handle.
      await runner.inject(buildBlankPageRecoveryScript()).catch(() => {});

      const msg = await runner.waitForMessage('BLANK_PAGE', 8_000);
      expect(msg.retried).toBe(false);
      expect(msg.hasBody).toBe(true);
      await runner.page.waitForFunction(
        'typeof window.__preReload === "undefined"',
        undefined,
        { timeout: 8_000 },
      );
    },
    { url: STORE_URL },
  );

  itWithFixture(
    'head-only.html',
    'reloads at most once — with the latch set it reports and stands down',
    async (runner) => {
      await runner.page.evaluate(() => {
        window.sessionStorage.setItem('__mealioBlankReload', '1');
        (window as unknown as { __preReload?: number }).__preReload = 1;
      });

      await runner.inject(buildBlankPageRecoveryScript());
      const msg = await runner.waitForMessage('BLANK_PAGE', 8_000);
      expect(msg.retried).toBe(true);

      // The marker SURVIVING is the assertion: the reload in this script runs
      // synchronously on the line after the message is posted, so if the latch
      // failed to stop it the document would already be on its way out by the
      // time the message reached us. Settling first keeps that honest.
      await runner.page.waitForTimeout(500);
      expect(await runner.page.evaluate('window.__preReload')).toBe(1);
    },
    { url: STORE_URL },
  );
});

describe('blank-page recovery leaves a page that rendered alone', () => {
  const { itWithFixture } = storeFixtures('albertsons');

  itWithFixture(
    'search-results-tortillas.html',
    'a real store page posts nothing and is never reloaded',
    async (runner) => {
      await runner.page.evaluate(() => {
        (window as unknown as { __preReload?: number }).__preReload = 1;
      });

      await runner.inject(buildBlankPageRecoveryScript());
      await runner.page.waitForTimeout(500);
      expect(runner.messagesOfType('BLANK_PAGE')).toHaveLength(0);
      expect(await runner.page.evaluate('window.__preReload')).toBe(1);
    },
  );
});
