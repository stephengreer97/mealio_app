// HEB login helper for live tests.
//
// HEB login uses OIDC (auth.heb.com). After credentials, browser bounces
// through accounts.heb.com → heb.com with auth cookies. CRITICAL: don't
// intercept the OIDC callback — let it complete naturally or session
// cookies don't get set.

import type { Page } from 'playwright';
import { StoreCreds } from './creds';

export interface LoginOptions {
  allowManual2faMs?: number;
}

export async function loginHeb(
  page: Page,
  creds: StoreCreds,
  opts: LoginOptions = {},
): Promise<void> {
  await page.goto('https://www.heb.com/my-account/login', { waitUntil: 'domcontentloaded' });

  // Email field.
  await page.locator('input[type="email"], input[name="email"]').first().fill(creds.email);

  // Some HEB flows have a Continue button between email and password.
  const continueBtn = page.locator('button:has-text("Continue")').first();
  if ((await continueBtn.count()) > 0) {
    await continueBtn.click().catch(() => {});
  }

  // Password.
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.locator('button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]').first().click();

  // OIDC redirect chain → back to heb.com. Wait for the final domain.
  try {
    await page.waitForURL(/^https:\/\/www\.heb\.com\/(?!my-account\/login)/, { timeout: 30_000 });
  } catch {
    const url = page.url();
    if (/accounts\.heb\.com|auth\.heb\.com/.test(url) && opts.allowManual2faMs) {
      // eslint-disable-next-line no-console
      console.warn(`[login-heb] Possible 2FA at ${url}. Waiting ${opts.allowManual2faMs}ms for manual completion...`);
      await page.waitForURL(/^https:\/\/www\.heb\.com\/(?!my-account\/login)/, { timeout: opts.allowManual2faMs });
    } else {
      throw new Error(`HEB login stuck on ${url}`);
    }
  }

  // Verify by waiting for the account button to show user info, not "Sign In".
  await page.waitForFunction(
    () => {
      const accountBtns = Array.from(document.querySelectorAll('button[aria-label*="account" i]'));
      return accountBtns.some((b) => !/Sign In/i.test(b.textContent || ''));
    },
    { timeout: 15_000 },
  );
}
