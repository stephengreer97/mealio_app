// Shared factory for live test suites.
//
// Every store's live suite has the same shape:
//   - beforeAll: launch browser
//   - beforeEach: fresh context, fresh page
//   - afterEach: clearCart → logout → close context (best effort)
//   - describe('CHECK_LOGIN_SCRIPT'): three tests verifying login detection
//     before login, after login, and after logout.
//
// Per-store specs supply the login/logout/clearCart helpers and the
// store's scripts; everything else is identical.

import { Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

import { StoreScripts } from '../../../src/lib/webview-scripts';
import { launchStealthBrowser, newStealthContext, safeCloseBrowser } from '../../_shared/launch-stealth';
import { AllCreds, StoreCreds, credsFor } from './creds';
import { installInjectBridge, InjectSession } from './inject-script';

export interface LiveSuiteConfig {
  /** Display name in describe(), e.g. "Wegmans" */
  storeName: string;
  /** Cred key for credsFor() */
  credsKey: keyof AllCreds;
  /** Homepage URL used by the logged-out check */
  homepageUrl: string;
  /** Store scripts (the one returned by getScripts() for the relevant store) */
  scripts: StoreScripts;
  /** Login the test account */
  login: (page: Page, creds: StoreCreds, opts?: any) => Promise<void>;
  /** Sign the test account out */
  logout: (page: Page) => Promise<void>;
  /** Optional: clear the cart before logout. Skip if the store has no cart concept yet. */
  clearCart?: (page: Page) => Promise<void>;
  /** Optional: extra `it` blocks specific to this store (extract, ATC, etc) */
  extraTests?: (ctx: ExtraTestCtx) => void;
}

export interface ExtraTestCtx {
  getPage: () => Page;
  getContext: () => BrowserContext;
  getScripts: () => StoreScripts;
  getCreds: () => StoreCreds;
  installBridge: () => Promise<InjectSession>;
}

/**
 * Build a Jest describe() block for one store. Call from the top of the
 * store's <store>.live.spec.ts:
 *
 *   buildLiveSuite({ ...config });
 *
 * The suite skips cleanly if MEALIO_TEST_CREDS_KEY isn't set or
 * tests/live/creds.json.gpg doesn't exist.
 */
export function buildLiveSuite(cfg: LiveSuiteConfig) {
  const credsGpgPath = path.resolve(__dirname, '..', 'creds.json.gpg');
  const hasCreds = fs.existsSync(credsGpgPath) && !!process.env.MEALIO_TEST_CREDS_KEY;
  const describeFn = hasCreds ? describe : describe.skip;

  describeFn(`${cfg.storeName} LIVE`, () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let cachedCreds: StoreCreds | null = null;

    beforeAll(async () => {
      browser = await launchStealthBrowser({ headless: process.env.HEADFUL !== '1' });
    });

    afterAll(async () => {
      // safeCloseBrowser is a no-op when attached via MEALIO_CDP_URL.
      await safeCloseBrowser(browser);
    });

    beforeEach(async () => {
      context = await newStealthContext(browser);
      page = await context.newPage();
      cachedCreds = credsFor(cfg.credsKey) as StoreCreds;
    });

    afterEach(async () => {
      // Cleanup runs best-effort: clearCart → logout → context.close(). Each
      // step is independent so a failure in one doesn't block later steps.
      if (cfg.clearCart) {
        try { await cfg.clearCart(page); } catch { /* ignore */ }
      }
      try { await cfg.logout(page); } catch { /* ignore — may already be logged out */ }
      try { await context?.close(); } catch { /* ignore */ }
    });

    describe('CHECK_LOGIN_SCRIPT', () => {
      it('reports LOGIN_STATUS:false when not logged in', async () => {
        await page.goto(cfg.homepageUrl, { waitUntil: 'domcontentloaded' });
        const session = await installInjectBridge(context, page);
        await session.inject(cfg.scripts.checkLoginScript);
        const status = await session.waitForMessage('LOGIN_STATUS', 15_000);
        expect(status.isLoggedIn).toBe(false);
      });

      it('reports LOGIN_STATUS:true after a successful login', async () => {
        await cfg.login(page, cachedCreds!);
        const session = await installInjectBridge(context, page);
        await session.inject(cfg.scripts.checkLoginScript);
        const status = await session.waitForMessage('LOGIN_STATUS', 15_000);
        expect(status.isLoggedIn).toBe(true);
      });

      it('reports LOGIN_STATUS:false again after logout', async () => {
        await cfg.login(page, cachedCreds!);
        await cfg.logout(page);
        const session = await installInjectBridge(context, page);
        await session.inject(cfg.scripts.checkLoginScript);
        const status = await session.waitForMessage('LOGIN_STATUS', 15_000);
        expect(status.isLoggedIn).toBe(false);
      });
    });

    if (cfg.extraTests) {
      const ctx: ExtraTestCtx = {
        getPage: () => page,
        getContext: () => context,
        getScripts: () => cfg.scripts,
        getCreds: () => cachedCreds!,
        installBridge: () => installInjectBridge(context, page),
      };
      cfg.extraTests(ctx);
    }
  });
}
