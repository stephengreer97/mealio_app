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

import { chromium, Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
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
  // A service worker's own fetches are not routed by `context.route`, so a
  // registered worker is a hole in the blocking below. Nothing in a fixture
  // registers one today; blocking the class costs nothing and keeps it that way.
  serviceWorkers: 'block',
} as const;

/**
 * Chromium launch options every fixture load and the drift census share.
 *
 * ONE ARG, AND IT IS THE ONE THAT ACTUALLY CLOSES THE DOOR (MEAL-113).
 * `installResourceBlocking` below refuses every non-local *request*, and that is
 * still worth having — it is what keeps a captured page's runtime behavior from
 * changing the DOM under a test. But `context.route` only ever sees requests, and
 * a browser reaches the network in ways that are not requests:
 *
 *   • `<link rel="preconnect">` / `rel="dns-prefetch"`. The committed fixtures
 *     carry 200 of these hints (albertsons 80, walmart 45, aldi 36, wegmans 25,
 *     amazon-fresh 14). A preconnect is a DNS lookup and a TLS handshake with no
 *     HTTP request inside it, so no route handler is ever consulted and no count
 *     of `route.continue()` calls can see one.
 *   • WebSockets. Those need `context.routeWebSocket`, which we do not install.
 *     Latent only: no fixture contains `new WebSocket(` today, and a re-capture
 *     could introduce one that would then egress silently.
 *   • Service-worker-initiated fetches (blocked separately above).
 *
 * WHAT IS ACTUALLY MEASURED, since an earlier version of this comment asserted more
 * than anyone had checked. At the OS layer — `ss` filtered to the chrome PIDs under
 * jest, chrome count 0 before and after — a fixture run holds **zero** TCP and UDP
 * sockets with this rule on. But it also holds zero with the rule OFF, and zero with
 * every name mapped to a listener that would accept and hold. Nothing in the captured
 * pages attempts a connection on this box either way, because the route layer above
 * already refuses everything non-local.
 *
 * A figure of "36 third-party endpoints across 29 PIDs" appeared here and did not
 * reproduce. Treat it as withdrawn. It most likely predates the route-layer widening,
 * and its host list overlaps the request-level list this file says is already blocked.
 *
 * So the resolver rule is **defence in depth, not a fix for an observed leak.** It is
 * not inert — with it on, `https://www.aldi.us/` fails `ERR_NAME_NOT_RESOLVED` — and
 * it closes three holes `context.route` structurally cannot see (a preconnect carries
 * no request; WebSockets and service workers are not intercepted). Keep it for that
 * reason, which is a design argument rather than a measurement.
 *
 * WHAT THAT DID AND DID NOT LEAK, stated precisely, because the previous version of
 * this comment overstated the fix and that is its own kind of bug. A preconnect
 * carries no HTTP request, so no cookie, cart, price or loyalty id went anywhere:
 * the "0 requests forwarded" claim was true and still is. What left on every run
 * was METADATA — DNS and DoH lookups, TLS SNI hostnames, and this machine's IP —
 * to ad-tech hosts.
 *
 * `--host-resolver-rules=MAP * ~NOTFOUND` refuses at the resolver instead, which is
 * below all three holes at once: a preconnect, a WebSocket and a service worker all
 * have to resolve a name first, and none of them can. `EXCLUDE localhost` keeps the
 * mock store (tests/mock-store) reachable when it is served — but only by NAME.
 * `MAP * ~NOTFOUND` clobbers IP literals and a name EXCLUDE does not cover them, so
 * each loopback spelling needs its own clause (MEAL-149). Without them
 * `http://127.0.0.1:PORT/` failed `ERR_NAME_NOT_RESOLVED` while `http://localhost:PORT/`
 * answered — which contradicted `isLocalUrl` below, whose own tests pin `127.0.0.1`,
 * `[::1]` and `2130706433` as ALLOWED. Two layers disagreeing about what counts as
 * local is how a boundary ends up being trusted for something it does not do.
 *
 * `2130706433` needs no clause of its own: WHATWG URL normalises the integer form to
 * `127.0.0.1` before the browser ever resolves it, which is the same reason
 * `isLocalUrl` can compare against the dotted form alone.
 *
 * Run time is unchanged, not faster: 75.45 s vs 74.89 s on albertsons, 52.84 s vs
 * 51.97 s on aldi. An earlier version of this comment claimed a speedup; it is noise.
 *
 * Keep both layers. The resolver rule is the boundary; the route handler is what
 * makes an intercepted navigation land on a known empty page rather than on a
 * network error, which is what the tests read.
 */
export const FIXTURE_LAUNCH_OPTIONS: LaunchOptions = {
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'],
};

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
 * NO REQUEST LEAVES THIS MACHINE (MEAL-113). The list above is a list of resource
 * types, and every type missing from it — `document`, `fetch`, `xhr`, `ping`,
 * `other` — used to be forwarded to the public internet. Blocking a class of
 * request by naming its members is a losing game: the members that matter are the
 * ones nobody named. So the rule is now the class itself. A request to anything
 * but localhost is never forwarded, whatever type it is.
 *
 * (This used to say NOTHING leaves this machine. It does not cover preconnect
 * hints, WebSockets or a service worker, none of which are requests — that is what
 * FIXTURE_LAUNCH_OPTIONS is for, and the two together are what make the stronger
 * claim true.)
 *
 * That was not a theoretical hole. Blocking `<script src>` does not stop the
 * captured page's INLINE scripts, and they are what reach out. Measured by logging
 * every non-local request that reaches this handler over one full fixture run:
 * 11506 in total, of which 371 are not assets — 310 `document` requests to 17
 * third-party hosts (safeframe.googlesyndication.com, four `fls.doubleclick.net`
 * accounts, insight.adsrvr.org, websdk.ujet.co among them), 39 `other` (Walmart
 * `_next` bundle prefetches from i5.walmartimages.com), 18 `fetch` — 17 of them
 * live calls to heb.com/api/dsf — 2 `ping` beacons to unagi.amazon.com, and 2
 * `xhr`, one of which is a page script's own DNS-over-HTTPS query to
 * 1.1.1.1/dns-query. On every run.
 *
 * Separately, 21 fixture tests pass an `options.url` naming a real store URL
 * (heb.com/search, aldi.us, albertsons.com, walmart.com, amazon.com, wegmans.com).
 * Those navigations do NOT appear in the count above, because loadFixture registers
 * a page-level route for them and page routes take precedence over context routes —
 * see the note at that `page.route` call.
 *
 * Two reasons that has to stay shut, and the second is the one to remember:
 *
 *   1. It makes the suite depend on third parties answering, and on how fast. A
 *      live navigation takes seconds; an answered one takes milliseconds, so every
 *      one of them was wall-clock spent inside a budget the tests then had to be
 *      widened to fit, and the amount varied with someone else's uptime. In the
 *      project's main defence against selector drift, that is a bad property.
 *
 *      NOT, to be precise, because the scripts that navigate after posting
 *      (wegmans.ts, walmart.ts, albertsons.ts, amazon-fresh.ts) were racing the
 *      navigation and winning only on latency. They were not, and an earlier
 *      version of this comment said they were. `postMessage` calls an
 *      `exposeFunction` binding, so by the time that call returns the payload is
 *      already in the Node-side `messages` array, and `waitForMessage` polls Node —
 *      destroying the page afterwards cannot take it back out. Making navigations
 *      faster is safe here, and it is what this does.
 *   2. It exfiltrated captured session data. Those requests carried what is
 *      committed in the fixtures — HEB cart contents and prices, an Albertsons
 *      loyalty id, a hashed email — out to ad networks on every fixture run.
 *      Note the tense: `document`/`fetch`/`ping` requests DID carry payloads, and
 *      they are what this handler stops. The residue that outlived it was
 *      metadata only (see FIXTURE_LAUNCH_OPTIONS), never body or cookies.
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

/**
 * Whether a URL resolves on this machine. Everything else is refused.
 *
 * This is the predicate that decides what reaches the network, so it is
 * default-deny and every branch is exercised by runScript.test.ts — a comment
 * saying "do not narrow this" is not a guard, and the tests are. What they pin,
 * and why each case is the way it is:
 *
 *   • `localhost.evil.com` is DENIED. The check is equality, never `endsWith`.
 *   • `http://2130706433/` is ALLOWED, because WHATWG URL normalises the integer
 *     form to `127.0.0.1` before we compare — the same reason `http://[::1]/` has
 *     hostname `[::1]`, brackets included, and `LOCALHOST` arrives lowercased.
 *   • `127.0.0.2`, `0.0.0.0` and `[::ffff:127.0.0.1]` are DENIED. Loopback is
 *     wider than this list; the list is what the suite actually uses.
 *   • an unparseable string is DENIED, which is the safe direction.
 *
 * `file:` is deliberately NOT on the allow list. Fixtures arrive via `setContent`,
 * so nothing here navigates to a file URL, and of all the schemes it is the one
 * whose failure mode is not fail-safe — an allowed `file:` read is local
 * filesystem access granted to a captured third-party page's inline script.
 */
export function isLocalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false; // unparseable: treat as external, which is the safe direction
  }
  if (url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:') {
    return true;
  }
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
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
  const browser = await chromium.launch(FIXTURE_LAUNCH_OPTIONS);
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
     *
     * One consequence to know when reading counts off that handler: a PAGE route
     * takes precedence over a CONTEXT route, so these 21 store-URL navigations are
     * answered here and never reach `installResourceBlocking`. They are therefore
     * absent from its measured totals, which is why the two figures in the MEAL-113
     * history disagreed about whether "5 live store URLs" were included.
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
