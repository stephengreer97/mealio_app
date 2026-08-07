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

import { isLocalUrl, loadFixture } from './runScript';

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
