// Shared helper for injecting a WebView store script into a Playwright page
// and capturing the postMessage payloads it produces.
//
// Mirrors the fixture-runner contract but runs against a LIVE page that the
// caller has already navigated and (usually) logged into.

import type { BrowserContext, Page } from 'playwright';

export interface PostedMessage {
  type: string;
  [key: string]: any;
}

export interface InjectSession {
  /** All messages captured since the bridge was installed (clone). */
  messages: () => PostedMessage[];
  /** Filter to a specific type. */
  messagesOfType: (type: string) => PostedMessage[];
  /** Inject a store-script string into the current page. */
  inject: (script: string) => Promise<void>;
  /**
   * Wait up to `timeoutMs` for a message of the given type. Rejects on
   * timeout with a useful dump of what WAS captured.
   */
  waitForMessage: (type: string, timeoutMs?: number) => Promise<PostedMessage>;
  /** Reset the captured-messages buffer. Useful between consecutive script runs. */
  clearMessages: () => void;
}

/**
 * Install the `window.ReactNativeWebView` bridge on the page and start
 * capturing postMessage payloads. Safe to call once per page — subsequent
 * navigations within the same page keep the bridge alive via addInitScript.
 */
export async function installInjectBridge(
  context: BrowserContext,
  page: Page,
): Promise<InjectSession> {
  const messages: PostedMessage[] = [];

  // Expose the Node-side capture function (context-scoped so it survives nav).
  // If already exposed by a previous call in this context, skip.
  try {
    await context.exposeFunction('__capturePostMessage', (json: string) => {
      try {
        messages.push(JSON.parse(json));
      } catch {
        messages.push({ type: 'RAW_NON_JSON', raw: json });
      }
    });
  } catch (err: any) {
    if (!String(err).includes('has been already registered')) {
      throw err;
    }
  }

  // Install bridge on every navigation in this page.
  await page.addInitScript(() => {
    (window as any).ReactNativeWebView = {
      postMessage: (json: string) => (window as any).__capturePostMessage(json),
    };
  });

  // Also install it on the current document (init script doesn't fire on the
  // already-loaded page).
  await page.evaluate(() => {
    (window as any).ReactNativeWebView = {
      postMessage: (json: string) => (window as any).__capturePostMessage(json),
    };
  });

  return {
    messages: () => [...messages],
    messagesOfType: (type) => messages.filter((m) => m.type === type),
    inject: async (script) => {
      // Re-install the bridge on the current document in case a navigation
      // dropped it. addInitScript only fires for FUTURE navs.
      await page.evaluate(() => {
        (window as any).ReactNativeWebView = {
          postMessage: (json: string) => (window as any).__capturePostMessage(json),
        };
      });
      await page.evaluate((s: string) => {
        // eslint-disable-next-line no-new-func
        new Function(s)();
      }, script);
    },
    waitForMessage: async (type, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = messages.find((m) => m.type === type);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      const captured = messages.map((m) => m.type).join(', ');
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for postMessage type="${type}". ` +
          `Captured types: [${captured}]`,
      );
    },
    clearMessages: () => {
      messages.length = 0;
    },
  };
}
