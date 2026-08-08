// Smoke test for the fixture-runner itself. Validates:
//   - isLocalUrl(), the predicate that decides what reaches the network
//   - HTML fixture loading
//   - ReactNativeWebView.postMessage capture
//   - inject() actually executes the script
//   - waitForMessage() resolves when expected message arrives
//   - waitForMessage() rejects on timeout with a useful error

import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

import { FIXTURE_LAUNCH_OPTIONS, isLocalUrl, loadFixture } from './runScript';

const TMP = path.join(os.tmpdir(), 'mealio-fixture-runner-test');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

/*
 * isLocalUrl is the security boundary of the fixture suite (MEAL-113):
 * installResourceBlocking forwards a request if and only if this returns true, so
 * every `true` here is a hole someone could later widen by accident. The comment on
 * the function says "do not narrow it to a type list again"; these are the guard
 * that comment cannot be.
 */
describe('isLocalUrl', () => {
  it.each([
    ['http://localhost/', true],
    ['http://localhost:3000/mock-store/', true],
    ['https://localhost/x?y=1#z', true],
    ['http://127.0.0.1:8080/', true],
    // WHATWG URL normalises these before we compare, which is why the plain
    // equality checks are enough: the integer form becomes 127.0.0.1, the IPv6
    // literal keeps its brackets, and the host is lowercased.
    ['http://2130706433/', true],
    ['http://[::1]:5173/', true],
    ['http://LOCALHOST/', true],
    ['about:blank', true],
    ['data:text/html,<p>hi', true],
    ['blob:http://localhost/abc-123', true],
  ])('allows %s', (raw, expected) => {
    expect(isLocalUrl(raw as string)).toBe(expected);
  });

  it.each([
    // The check is equality, never endsWith/includes — this is the one that would
    // quietly open the door to anybody who can register a subdomain.
    ['http://localhost.evil.com/', false],
    ['http://notlocalhost/', false],
    ['https://www.heb.com/api/dsf', false],
    ['https://1.1.1.1/dns-query', false],
    // Loopback is wider than the allow list on purpose: the list is what the
    // suite actually uses, and everything outside it is refused rather than
    // guessed at.
    ['http://127.0.0.2/', false],
    ['http://0.0.0.0/', false],
    ['http://[::ffff:127.0.0.1]/', false],
    // Deliberately not allowed: nothing here navigates to a file URL (fixtures
    // arrive via setContent), and it is the one scheme whose failure mode hands a
    // captured third-party inline script the local filesystem.
    ['file:///etc/passwd', false],
    // Unparseable → refused, which is the safe direction. `http://::1/` is in this
    // list rather than the one above: `new URL` rejects the unbracketed literal, so
    // a `hostname === '::1'` branch would never have been reached.
    ['not a url', false],
    ['http://::1/', false],
    ['', false],
  ])('denies %s', (raw, expected) => {
    expect(isLocalUrl(raw as string)).toBe(expected);
  });
});

describe('loadFixture', () => {
  it('loads HTML and exposes the page object', async () => {
    const fixturePath = path.join(TMP, 'simple.html');
    writeFileSync(
      fixturePath,
      '<!doctype html><html><body><div id="hello">hi</div></body></html>',
    );

    const runner = await loadFixture(fixturePath);
    try {
      const text = await runner.page.locator('#hello').textContent();
      expect(text).toBe('hi');
    } finally {
      await runner.close();
    }
  });

  it('captures window.ReactNativeWebView.postMessage calls from injected script', async () => {
    const fixturePath = path.join(TMP, 'empty.html');
    writeFileSync(
      fixturePath,
      '<!doctype html><html><body></body></html>',
    );

    const runner = await loadFixture(fixturePath);
    try {
      await runner.inject(`
        (function() {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'HELLO', n: 1 }));
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'HELLO', n: 2 }));
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DONE' }));
        })();
      `);

      const done = await runner.waitForMessage('DONE');
      expect(done.type).toBe('DONE');

      const hellos = runner.messagesOfType('HELLO');
      expect(hellos).toHaveLength(2);
      expect(hellos[0].n).toBe(1);
      expect(hellos[1].n).toBe(2);

      expect(runner.messages()).toHaveLength(3);
    } finally {
      await runner.close();
    }
  });

  it('captures messages from async IIFE store-script shape', async () => {
    const fixturePath = path.join(TMP, 'async.html');
    writeFileSync(
      fixturePath,
      '<!doctype html><html><body></body></html>',
    );

    const runner = await loadFixture(fixturePath);
    try {
      // Mimic the exact shape of a store script: async IIFE with `})();true;`
      await runner.inject(`
        (async function() {
          function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'START' }));
          await wait(100);
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MIDDLE' }));
          await wait(100);
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'END', ok: true }));
        })();
        true;
      `);

      const end = await runner.waitForMessage('END');
      expect(end.ok).toBe(true);
      const types = runner.messages().map((m) => m.type);
      expect(types).toEqual(['START', 'MIDDLE', 'END']);
    } finally {
      await runner.close();
    }
  });

  it('waitForMessage rejects with a useful error on timeout', async () => {
    const fixturePath = path.join(TMP, 'empty.html');
    writeFileSync(fixturePath, '<!doctype html><html><body></body></html>');

    const runner = await loadFixture(fixturePath);
    try {
      await runner.inject(`
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'OTHER' }));
      `);

      await expect(
        runner.waitForMessage('NEVER_FIRES', 500),
      ).rejects.toThrow(/Timed out.*Captured types so far: \[OTHER\]/);
    } finally {
      await runner.close();
    }
  });
});

/**
 * The resolver boundary itself, exercised rather than described.
 *
 * Everything above this is pure — `isLocalUrl` is the predicate the route handler
 * consults, and its tests never launch anything. But the predicate is only half of
 * the boundary. The other half is `FIXTURE_LAUNCH_OPTIONS`, a single string handed
 * to Chromium, and until now nothing anywhere ran a browser with it and checked
 * what that browser could actually reach. MEAL-113 built the boundary; the claim
 * that it works was carried by a comment.
 *
 * That gap is what let MEAL-149 sit undetected: `MAP * ~NOTFOUND` clobbers IP
 * literals and `EXCLUDE localhost` covers only the name, so the two layers
 * disagreed — `isLocalUrl` said `127.0.0.1` was allowed while the browser could not
 * resolve it. A test that only reads the predicate can never see that.
 *
 * This lives here rather than in tests/unit because it needs Chromium, and the CI
 * matrix already runs this file in a browser-capable job for exactly that reason.
 *
 * Every excluded spelling is covered, including `::1`. An earlier version of this
 * block left `::1` out, reasoning that binding an IPv6 loopback is not something
 * every CI image will do and that a self-skipping test claims coverage it does not
 * have. The second half of that is true; the conclusion was wrong, and wrong in the
 * way that costs something — the one clause with no test was the one that did not
 * work. `EXCLUDE [::1]` is inert, and it shipped saying otherwise.
 *
 * It needs no IPv6 server. What the rule decides is whether a name RESOLVES, and a
 * resolver refusal has its own error code — so asserting on the error rather than on
 * a 200 covers the clause on any machine, with or without IPv6.
 */
describe('the fixture browser can reach loopback and nothing else', () => {
  /** A port nothing binds. Used where the assertion is about NAME RESOLUTION, so
   *  what happens after the resolver answers is irrelevant. */
  const UNBOUND_PORT = 49_999;

  let server: import('http').Server;
  let port: number;
  let browser: import('playwright').Browser;

  beforeAll(async () => {
    const http = await import('http');
    const { chromium } = await import('playwright');

    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>mock</title><body>reached</body>');
    });
    // 127.0.0.1 explicitly, not the default wildcard: the point of the test is
    // which SPELLING of loopback the browser resolves, so the server must answer
    // on the literal rather than on whatever the host maps `localhost` to.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as import('net').AddressInfo).port;

    browser = await chromium.launch(FIXTURE_LAUNCH_OPTIONS);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    // `server?.close(cb)` would short-circuit if beforeAll died before createServer
    // returned, leaving the promise unresolved and hanging this hook to the jest
    // timeout instead of surfacing the real error.
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('reaches the mock store by IP literal, which is what MEAL-149 fixed', async () => {
    // This is the assertion that fails on the pre-MEAL-149 arg: without
    // `EXCLUDE 127.0.0.1` the navigation dies with ERR_NAME_NOT_RESOLVED, even
    // though isLocalUrl has always called this address local.
    const page = await browser.newPage();
    const res = await page.goto(`http://127.0.0.1:${port}/`);
    expect(res?.status()).toBe(200);
    expect(await page.evaluate(() => document.body.textContent)).toBe('reached');
    await page.close();
  }, 30_000);

  it('still reaches the mock store by name', async () => {
    // The case that already worked. Here so a future edit to the arg cannot fix
    // the IP literal by breaking the name.
    //
    // The body assertion is not decoration. On a host where `localhost` resolves to
    // `::1` first, this reaches our 127.0.0.1 server only via Happy Eyeballs
    // fallback; a status check alone would keep passing while quietly proving
    // something other than what it says. Reading the body pins that we got OUR page.
    const page = await browser.newPage();
    const res = await page.goto(`http://localhost:${port}/`);
    expect(res?.status()).toBe(200);
    expect(await page.evaluate(() => document.body.textContent)).toBe('reached');
    await page.close();
  }, 30_000);

  it('reaches loopback by its IPv6 spelling', async () => {
    // No IPv6 server, deliberately. The rule decides whether a name RESOLVES, and
    // that is the only thing that can produce ERR_NAME_NOT_RESOLVED here. Once it
    // resolves, the connection is free to fail however this machine likes —
    // refused, unreachable, no IPv6 stack at all — and the clause has done its job.
    //
    // With `EXCLUDE [::1]` (the bracketed form that shipped) this fails: the
    // pattern never matches, the wildcard applies, and the error IS a resolver
    // refusal.
    const page = await browser.newPage();
    await expect(page.goto(`http://[::1]:${UNBOUND_PORT}/`))
      .rejects.not.toThrow(/ERR_NAME_NOT_RESOLVED/);
    await page.close();
  }, 30_000);

  it('refuses an address the wildcard still covers', async () => {
    // The boundary doing its job. The target is a LOOPBACK address that is not on
    // the exclude list, and that choice is the whole point.
    //
    // This first asserted against a real ad-tech host, which was wrong twice over.
    // ERR_NAME_NOT_RESOLVED is also what an ordinary NXDOMAIN produces, so on any
    // machine behind a filtering resolver — Pi-hole, NextDNS, a corporate DNS — the
    // test passed with the boundary DELETED. Measured, not supposed. And proving it
    // was load-bearing meant removing the rule and letting a real request leave the
    // machine, every single time anyone mutation-tested this file.
    //
    // 127.0.0.2 has neither problem. No DNS is involved at all, so the resolver
    // refusal can only come from our rule: with it, ERR_NAME_NOT_RESOLVED; without
    // it, ERR_CONNECTION_REFUSED from a local address with nothing listening.
    // Nothing can leave the machine under any mutation.
    const page = await browser.newPage();
    await expect(page.goto(`http://127.0.0.2:${UNBOUND_PORT}/`)).rejects.toThrow(
      /ERR_NAME_NOT_RESOLVED/,
    );
    await page.close();
  }, 30_000);
});
