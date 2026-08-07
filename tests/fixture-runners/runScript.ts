// Fixture runner for WebView store scripts.
//
// The runtime contract: each store's script is a string template that gets
// injected into a WebView via `window.ReactNativeWebView.postMessage` for
// observability. To test these scripts without a phone or a real RN
// runtime, we:
//
//   1. Launch headless Chromium via Playwright.
//   2. Stub `window.ReactNativeWebView.postMessage` to capture every call
//      into a Node-side array.
//   3. Load a recorded HTML fixture from disk into the page.
//   4. Inject the store script string and let it run.
//   5. Wait for a specific terminal message (LOGIN_STATUS, ADD_RESULT, etc).
//   6. Assert on the captured payloads.
//
// Reused by every store's fixture-test spec.

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { readFile } from 'fs/promises';
import * as path from 'path';

/**
 * Browser context settings every fixture load uses.
 *
 * Exported because the drift census (tests/drift/capture.ts) loads the same
 * fixtures in the same browser and MUST see the same DOM this runner does — a
 * census taken under a different user agent or viewport would be recording a page
 * the fixture tests never run against, and its baseline would disagree with them
 * for reasons that have nothing to do with store drift.
 */
export const FIXTURE_CONTEXT_OPTIONS = {
  // Use a mobile UA so fixture pages that branch on userAgent see the same
  // markup as our actual RN WebView does.
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },  // iPhone 13/14 pixel dims
} as const;

/**
 * Block external resource loads. Captured fixture HTML preserves <script>
 * tags pointing at gtag, GTM, the store's React/Next bundle, etc. If those
 * run inside Playwright, the store's SPA bootstrap can navigate the page
 * away, destroying the execution context of the script we want to test
 * (observed on HEB: search-results-tortillas.html bootstrap navigates and
 * kills buildSearchAndAddScript before its first postMessage). We only care
 * about the static DOM, never the captured page's runtime behavior.
 *
 * CONSEQUENCE WORTH KNOWING: stylesheets are blocked too, so a class like
 * Albertsons' `d-none` never applies. CSS-hidden markup is present, laid out and
 * readable here, which makes any visibility-based reasoning invalid against a
 * fixture — including in the drift census, which therefore counts matches and
 * never asks whether a user could see them.
 *
 * NOTHING LEAVES THIS MACHINE (MEAL-113). The list above is a list of resource
 * types, and every type missing from it — `document`, `fetch`, `xhr`, `ping`,
 * `other` — used to be forwarded to the public internet. Blocking a class of
 * request by naming its members is a losing game: the members that matter are the
 * ones nobody named. So the rule is now the class itself. A request to anything
 * but localhost is never forwarded, whatever type it is.
 *
 * That was not a theoretical hole. Blocking `<script src>` does not stop the
 * captured page's INLINE scripts, and they are what reach out: 348 `document`
 * requests to ~25 third-party hosts across the fixture suites (ad and consent
 * iframes, plus 5 to live store URLs — heb.com/my-account/login, the aldi.us
 * storefront, a wegmans search), 17 live `fetch` calls to heb.com/api/dsf, beacons
 * to unagi.amazon.com, ~40 Walmart bundle prefetches, and a DNS-over-HTTPS query
 * to 1.1.1.1. On every run.
 *
 * Two reasons that has to stay shut, and the second is the one to remember:
 *
 *   1. It makes the suite depend on third parties answering, and on how fast. A
 *      live navigation takes seconds; an answered one takes milliseconds. A store
 *      script that posts a message and then does `window.location.href = …`
 *      (wegmans.ts, walmart.ts, albertsons.ts, amazon-fresh.ts) was winning that
 *      race only because the round trip was slow — a test green for a reason with
 *      nothing to do with the code under test. In the project's main defence
 *      against selector drift, that is the worst property it could have.
 *   2. It exfiltrated captured session data. Those requests carried what is
 *      committed in the fixtures — HEB cart contents and prices, an Albertsons
 *      loyalty id, a hashed email — out to ad networks on every fixture run.
 *
 * So do not relax this back to `continue()` for convenience, and do not narrow it
 * to a type list again. A `document` request is answered with an empty page —
 * enough to set `window.location`, and nothing else — and everything else is
 * aborted, which is what a captured page's runtime behavior deserves.
 */
export async function installResourceBlocking(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'script' || type === 'stylesheet' || type === 'font' || type === 'image' || type === 'media') {
      return route.abort();
    }
    // Local URLs are allowed through: a fixture run reaches nothing else, but the
    // mock store (tests/mock-store) is served on localhost when it is served.
    if (isLocalUrl(route.request().url())) {
      return route.continue();
    }
    if (type === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: EMPTY_DOCUMENT });
    }
    return route.abort();
  });
}

/**
 * The page every intercepted navigation is answered with. It exists only to give
 * the document a `location`; the markup a test reads always arrives afterwards
 * via `setContent`.
 */
export const EMPTY_DOCUMENT = '<!doctype html><html><head></head><body></body></html>';

/** Whether a URL resolves on this machine. Everything else is refused. */
export function isLocalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false; // unparseable: treat as external, which is the safe direction
  }
  if (url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') {
    return true;
  }
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
}

export interface PostedMessage {
  type: string;
  // store-script messages have varied payload shapes; widen via index signature
  [key: string]: any;
}

export interface FixtureRunner {
  /** The Playwright page (with fixture HTML loaded). */
  page: Page;

  /**
   * Inject a store-script string into the page. Returns immediately; the
   * script runs asynchronously and posts back via ReactNativeWebView.postMessage.
   * Use waitForMessage() to await its terminal output.
   */
  inject: (script: string) => Promise<void>;

  /** Snapshot of all captured messages so far (clone). */
  messages: () => PostedMessage[];

  /** Filtered to a specific message type. */
  messagesOfType: (type: string) => PostedMessage[];

  /**
   * Wait up to timeoutMs for a message of the given type to appear. Resolves
   * with the first matching message. Rejects on timeout (with a helpful dump
   * of what WAS captured) so test failures show the actual script output.
   */
  waitForMessage: (type: string, timeoutMs?: number) => Promise<PostedMessage>;

  /** Clear the captured message buffer (rarely useful, but available). */
  clearMessages: () => void;

  /** Close the page + browser. Call in afterEach/afterAll. */
  close: () => Promise<void>;
}

/**
 * Load a fixture HTML file into a fresh headless Chromium page, with the
 * RN postMessage bridge installed.
 *
 * @param fixturePath absolute or relative-to-cwd path to an .html fixture
 * @param options.url   the URL to set as document.location for the loaded
 *                      page (some store scripts read window.location.search
 *                      to extract query params); defaults to about:blank
 */
export async function loadFixture(
  fixturePath: string,
  options: { url?: string } = {},
): Promise<FixtureRunner> {
  const browser = await chromium.launch();
  let closed = false;
  const context = await browser.newContext(FIXTURE_CONTEXT_OPTIONS);
  const page = await context.newPage();

  await installResourceBlocking(context);

  const messages: PostedMessage[] = [];

  // Expose a Node-side capture function callable from the page.
  await context.exposeFunction('__capturePostMessage', (json: string) => {
    try {
      messages.push(JSON.parse(json));
    } catch {
      // Some scripts post non-JSON strings; preserve raw for visibility.
      messages.push({ type: 'RAW_NON_JSON', raw: json });
    }
  });

  // Install the ReactNativeWebView bridge on every navigation. Must run
  // before any page script, so addInitScript (not evaluate).
  await page.addInitScript(() => {
    (window as any).ReactNativeWebView = {
      postMessage: (json: string) => (window as any).__capturePostMessage(json),
    };
  });

  const absPath = path.resolve(fixturePath);
  const html = await readFile(absPath, 'utf8');

  // If caller specified a url to mimic, navigate there first (which sets
  // window.location); then setContent overrides the body. This lets store
  // scripts that read window.location.search see the right URL.
  if (options.url) {
    /*
     * MEAL-113. That navigation is answered locally, and it has to be.
     *
     * These are real store URLs — `https://www.walmart.com/search?q=tortillas`
     * and friends — so every fixture test that passes a `url` used to make a live
     * HTTP request to a grocery store. A recorded fixture exists precisely so the
     * suite does not depend on the store answering.
     *
     * And the failure it caused was the ugly kind. The old code let `goto` fail
     * and swallowed the error — but a swallowed rejection is not a settled page.
     * A real 200 arriving late, or a redirect, or a `goto` whose 30s budget
     * expired mid-flight, left a navigation still committing underneath the
     * `setContent` below, which then died with "Execution context was destroyed,
     * most likely because of a navigation". It landed on whichever store's server
     * happened to answer at the wrong moment, so it was never the same test twice
     * and never reproduced on re-run — the unreproducible fixture failure this
     * ticket was chasing. Under load the window is wider, which is why it looked
     * like contention; the dependency on the public internet is the actual bug.
     *
     * `installResourceBlocking` now answers every non-local `document` request,
     * so this route is not what keeps the goto off the network. It stays because
     * this one navigation carries a store's real URL and deserves an answer that
     * cannot be widened away by an edit to the resource-type list above.
     */
    const target = options.url;
    // Compare NORMALIZED hrefs. `new URL('https://www.aldi.us').href` is
    // `https://www.aldi.us/` — a bare host gains a trailing slash — and the
    // predicate is handed a parsed URL, so matching against the raw option
    // string silently misses exactly the callers that pass a bare origin. Which
    // is how ALDI's warmup test kept being the one that went to the network.
    const targetHref = new URL(target).href;
    await page.route(
      (url) => url.href === targetHref,
      (route) => route.fulfill({ status: 200, contentType: 'text/html', body: EMPTY_DOCUMENT }),
    );
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  }

  await page.setContent(html, { waitUntil: 'domcontentloaded' });

  // setContent can replace the document, dropping our addInitScript bridge.
  // Reinstall after every setContent to be safe.
  await page.evaluate(() => {
    (window as any).ReactNativeWebView = {
      postMessage: (json: string) => (window as any).__capturePostMessage(json),
    };
  });

  return {
    page,
    inject: async (script: string) => {
      // Store scripts are IIFEs wrapped in `(async function() { ... })();true;`.
      // page.evaluate with a string arg evaluates it as JS in the page context.
      // We don't await the IIFE's promise — use waitForMessage to know it
      // completed.
      await page.evaluate((s: string) => {
        // eslint-disable-next-line no-new-func
        new Function(s)();
      }, script);
    },
    messages: () => [...messages],
    messagesOfType: (type: string) => messages.filter((m) => m.type === type),
    waitForMessage: async (type: string, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = messages.find((m) => m.type === type);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      const captured = messages.map((m) => m.type).join(', ');
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for postMessage type="${type}". ` +
          `Captured types so far: [${captured}]`,
      );
    },
    clearMessages: () => {
      messages.length = 0;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await browser.close();
    },
  };
}
