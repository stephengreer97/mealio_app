// Launch a stealthed Chromium for use against real grocery-store sites
// (which actively fingerprint Playwright/Puppeteer).
//
// Stealth layers (most-to-least effective):
//   1. **playwright-extra + stealth plugin** — patches ~20 fingerprint
//      vectors automatically (navigator.webdriver, plugins, languages,
//      hardwareConcurrency, deviceMemory, WebGL renderer, missing chrome
//      runtime, permissions API quirks, screen dimensions, etc.).
//   2. **launchPersistentContext** — keeps cookies + storage between
//      runs. Stores see "returning user with history" instead of "fresh
//      browser from nowhere". Use launchPersistentStealthContext() for
//      this path; pass --user-data-dir via the persistentProfileDir arg.
//   3. **--disable-blink-features=AutomationControlled** — suppresses
//      Chrome's automation infobar + correlated API flags.
//   4. **Manual init scripts** (navigator.webdriver override, etc.) —
//      redundant with #1 now but kept as defense in depth.
//
// MEALIO_CDP_URL env var still works as an emergency escape hatch to
// attach to an already-running Chrome via CDP. With stealth + persistent
// context in place, the CDP path should rarely be needed.

import {
  chromium as playwrightChromium,
  webkit,
  devices,
  Browser,
  BrowserContext,
} from 'playwright';
import { chromium as extraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

// Apply the stealth plugin ONCE. Subsequent calls to extraChromium.launch()
// inherit it. Safe to call multiple times (idempotent).
extraChromium.use(StealthPlugin());

// Mobile device profile used everywhere we want to look like a real iPhone.
// devices['iPhone 13'] gives us viewport, userAgent, deviceScaleFactor,
// isMobile, hasTouch — all consistent with each other.
const MOBILE_DEVICE = devices['iPhone 13'];

/**
 * Default to WebKit (Safari's engine) for grocery-store traffic. Reason:
 * iOS Safari is the engine the real Mealio app's WebView uses, and the
 * UA we want stores to see ("iPhone Safari") matches WebKit's actual TLS
 * fingerprint, HTTP/2 priorities, and JS environment — no lies for
 * Cloudflare/Incapsula to catch.
 *
 * Override with MEALIO_BROWSER_ENGINE=chromium if a specific store
 * behaves better in Chromium (rare; usually the opposite).
 */
const ENGINE = (process.env.MEALIO_BROWSER_ENGINE || 'webkit').toLowerCase();
const USE_WEBKIT = ENGINE === 'webkit';

export interface LaunchOptions {
  headless?: boolean;
  /** Channel to attempt first; falls back to executablePath, then bundled. */
  channel?: 'chrome' | 'msedge' | 'chrome-beta';
}

/**
 * Did we attach to a pre-existing Chrome via CDP (MEALIO_CDP_URL) rather
 * than launching a fresh one? Callers should check this before
 * `browser.close()` — closing an attached browser closes the user's real
 * Chrome window.
 */
const ATTACHED_BROWSERS = new WeakSet<Browser>();

export function isAttachedBrowser(browser: Browser): boolean {
  return ATTACHED_BROWSERS.has(browser);
}

/**
 * Safe close: no-op if the browser was CDP-attached, otherwise closes
 * normally. Use this instead of `browser.close()` in afterAll/teardown.
 */
export async function safeCloseBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  if (ATTACHED_BROWSERS.has(browser)) return;
  await browser.close();
}

// Common Chrome binary locations to probe before falling back to bundled
// Chromium. The first one that exists wins.
const CHROME_PATH_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  '/usr/local/bin/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[];

function findInstalledChrome(): string | null {
  for (const p of CHROME_PATH_CANDIDATES) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not present
    }
  }
  return null;
}

const COMMON_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--no-first-run',
];

const isLooksLikeChannelMiss = (err: unknown) =>
  /Executable doesn't exist|Browser channel|not found at|Failed to launch/i.test(String(err));

export async function launchStealthBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  // 0) CDP attach escape hatch — Chromium only.
  const cdpUrl = process.env.MEALIO_CDP_URL;
  if (cdpUrl) {
    // eslint-disable-next-line no-console
    console.log(`[launch-stealth] Attaching to existing Chrome via CDP at ${cdpUrl}`);
    const browser = await playwrightChromium.connectOverCDP(cdpUrl);
    ATTACHED_BROWSERS.add(browser);
    return browser;
  }

  const headless = opts.headless ?? false;

  // WebKit path: bundled with Playwright, no channel dance needed. Returns
  // a real Safari renderer whose TLS+JS environment matches the iPhone UA
  // we present — much less likely to trip Incapsula/Akamai than Chromium.
  if (USE_WEBKIT) {
    return await webkit.launch({ headless });
  }

  const channel = opts.channel ?? 'chrome';

  // Chromium path: stealth-plugin + channel fallback chain.
  try {
    return await extraChromium.launch({ headless, channel, args: COMMON_ARGS });
  } catch (err) {
    if (!isLooksLikeChannelMiss(err)) throw err;
  }
  const chromePath = findInstalledChrome();
  if (chromePath) {
    try {
      return await extraChromium.launch({ headless, executablePath: chromePath, args: COMMON_ARGS });
    } catch (err) {
      if (!isLooksLikeChannelMiss(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[launch-stealth] Found ${chromePath} but it failed to launch — falling back to bundled chromium.`);
    }
  }
  return await extraChromium.launch({ headless, args: COMMON_ARGS });
}

export interface NewContextOptions {
  /**
   * When the browser was attached via MEALIO_CDP_URL, prefer reusing the
   * user's existing context (which already has their cookies, login state,
   * etc) rather than creating a fresh ephemeral one. Default: false.
   */
  reuseExistingIfAttached?: boolean;
  /** Override any newContext() option (userAgent, viewport, locale, etc) */
  overrides?: Parameters<Browser['newContext']>[0];
}

/**
 * Create (or reuse) a context with stealth init scripts installed. Use
 * this instead of `browser.newContext()` anywhere a stealth context is
 * needed.
 */
export async function newStealthContext(
  browser: Browser,
  options: NewContextOptions = {},
): Promise<BrowserContext> {
  const { reuseExistingIfAttached = false, overrides = {} } = options;

  let context: BrowserContext;
  if (reuseExistingIfAttached && ATTACHED_BROWSERS.has(browser) && browser.contexts().length > 0) {
    context = browser.contexts()[0];
  } else {
    // Use the iPhone device profile (viewport, UA, deviceScaleFactor,
    // isMobile, hasTouch) so EVERY mobile signal lines up coherently.
    context = await browser.newContext({
      ...MOBILE_DEVICE,
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      ...overrides,
    });
  }

  // Defense-in-depth init script. Stealth plugin (Chromium) handles most
  // of this; WebKit doesn't need most of it because there's no automation
  // lie to hide. Still useful when somebody opts back into Chromium.
  if (!USE_WEBKIT) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!(window as any).chrome) {
        (window as any).chrome = { runtime: {} };
      }
    });
  }

  return context;
}

/**
 * Launch a stealthed PERSISTENT context — cookies, localStorage, IndexedDB,
 * service workers, all preserved between runs in a Chrome profile directory.
 *
 * Use this for the capture script (and any other tool where you log in
 * once and expect that login to stick across many runs). Stores see a
 * "returning user with history" rather than "fresh browser every time",
 * which is dramatically less suspicious.
 *
 * The profile directory is gitignored (see .gitignore). Don't commit it —
 * it contains login cookies in plaintext, like any browser profile.
 *
 * Returns a BrowserContext (NOT a Browser — persistent contexts don't have
 * a top-level Browser; you operate directly on the context). To close:
 * call context.close().
 */
export async function launchPersistentStealthContext(opts: {
  /** Profile directory under tests/.chrome-profile/<name>/ */
  profileName: string;
  headless?: boolean;
  channel?: 'chrome' | 'msedge' | 'chrome-beta';
}): Promise<BrowserContext> {
  // The directory name is "chrome-profile" historically; it stores either
  // a Chrome OR a WebKit profile depending on MEALIO_BROWSER_ENGINE. Both
  // engines persist cookies/storage the same way from our perspective.
  const profilesRoot = path.resolve(__dirname, '..', '.chrome-profile');
  fs.mkdirSync(profilesRoot, { recursive: true });
  const userDataDir = path.join(profilesRoot, opts.profileName);

  const headless = opts.headless ?? false;

  // WebKit path: simpler — no channel/executablePath dance, just launch
  // bundled WebKit with the iPhone profile applied.
  if (USE_WEBKIT) {
    return await webkit.launchPersistentContext(userDataDir, {
      headless,
      ...MOBILE_DEVICE,
      locale: 'en-US',
      timezoneId: 'America/Chicago',
    });
  }

  // Chromium path: channel → executablePath → bundled fallback chain.
  const channel = opts.channel ?? 'chrome';
  const launchPersistent = async (extra: { channel?: string; executablePath?: string } = {}) =>
    extraChromium.launchPersistentContext(userDataDir, {
      headless,
      args: COMMON_ARGS,
      ...MOBILE_DEVICE,
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      ...extra,
    });

  try {
    return await launchPersistent({ channel });
  } catch (err) {
    if (!isLooksLikeChannelMiss(err)) throw err;
  }
  const chromePath = findInstalledChrome();
  if (chromePath) {
    try {
      return await launchPersistent({ executablePath: chromePath });
    } catch (err) {
      if (!isLooksLikeChannelMiss(err)) throw err;
    }
  }
  return await launchPersistent({});
}
