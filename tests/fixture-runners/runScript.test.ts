// Smoke test for the fixture-runner itself. Validates:
//   - HTML fixture loading
//   - ReactNativeWebView.postMessage capture
//   - inject() actually executes the script
//   - waitForMessage() resolves when expected message arrives
//   - waitForMessage() rejects on timeout with a useful error

import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

import { loadFixture } from './runScript';

const TMP = path.join(os.tmpdir(), 'mealio-fixture-runner-test');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
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
