// Walmart login helper for live tests.
//
// Walmart's login is at walmart.com/account/login. The form is a single
// page with email + password (no email-then-password split). Captchas can
// appear randomly — if one shows up the helper waits for manual solve.

import type { Page } from 'playwright';
import { StoreCreds } from './creds';

export interface LoginOptions {
  allowManualMs?: number;
}

export async function loginWalmart(
  page: Page,
  creds: StoreCreds,
  opts: LoginOptions = {},
): Promise<void> {
  await page.goto('https://www.walmart.com/account/login', { waitUntil: 'domcontentloaded' });

  await page.locator('input[type="email"], input[name="email"], #email').first().fill(creds.email);
  await page.locator('input[type="password"], #password').first().fill(creds.password);

  await page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Continue")').first().click();

  // Watch for captcha / "press and hold" challenge. If one appears, pause.
  const captchaSelector = '[data-testid*="captcha" i], [class*="press-and-hold" i], iframe[title*="captcha" i]';
  try {
    await page.waitForURL(/walmart\.com\/(?!account\/login)/, { timeout: 12_000 });
  } catch {
    const isCaptcha = await page.locator(captchaSelector).count() > 0;
    if (isCaptcha && opts.allowManualMs) {
      // eslint-disable-next-line no-console
      console.warn(`[login-walmart] Captcha detected. Pausing ${opts.allowManualMs}ms for manual solve...`);
      await page.waitForURL(/walmart\.com\/(?!account\/login)/, { timeout: opts.allowManualMs });
    } else {
      throw new Error(
        `Walmart login didn't redirect. Current URL: ${page.url()}. ` +
          (isCaptcha ? 'Captcha detected — pass allowManualMs to wait for manual solve.' : ''),
      );
    }
  }

  // Verify we see "Hi, <name>" instead of "Sign In".
  await page.waitForFunction(
    () => {
      const t = document.body.textContent || '';
      return /Hi,\s+\w/i.test(t) || /Account & Lists/i.test(t);
    },
    { timeout: 15_000 },
  );
}
