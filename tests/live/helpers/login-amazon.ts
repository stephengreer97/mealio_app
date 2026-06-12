// Amazon Fresh login helper.
//
// Amazon's login is two-step: email → continue → password (sometimes OTP).
// Use the canonical /ap/signin entry point.

import type { Page } from 'playwright';
import { StoreCreds } from './creds';

export interface LoginOptions {
  allowManual2faMs?: number;
}

export async function loginAmazon(
  page: Page,
  creds: StoreCreds,
  opts: LoginOptions = {},
): Promise<void> {
  await page.goto('https://www.amazon.com/ap/signin', { waitUntil: 'domcontentloaded' });

  // Step 1: email.
  await page.locator('input[name="email"], #ap_email').first().fill(creds.email);
  await page.locator('input#continue, button:has-text("Continue")').first().click();

  // Step 2: password.
  await page.locator('input[name="password"], #ap_password').first().fill(creds.password);
  await page.locator('input#signInSubmit, button:has-text("Sign in")').first().click();

  // 2FA challenge: Amazon may prompt for an OTP via email/SMS.
  try {
    await page.waitForFunction(
      () => {
        const accountList = document.getElementById('nav-link-accountList');
        if (!accountList) return false;
        const t = (accountList.textContent || '').trim();
        return /Hello,\s+\w/i.test(t) && !/Sign in/i.test(t);
      },
      { timeout: 15_000 },
    );
  } catch {
    if (opts.allowManual2faMs && /\/ap\//.test(page.url())) {
      // eslint-disable-next-line no-console
      console.warn(`[login-amazon] 2FA challenge. Pausing ${opts.allowManual2faMs}ms for manual completion...`);
      await page.waitForFunction(
        () => /Hello,\s+\w/i.test(document.getElementById('nav-link-accountList')?.textContent || ''),
        { timeout: opts.allowManual2faMs },
      );
    } else {
      throw new Error(`Amazon login didn't complete. URL: ${page.url()}`);
    }
  }

  // Navigate to Amazon Fresh to get into the merchant context the script expects.
  await page.goto('https://www.amazon.com/fresh', { waitUntil: 'domcontentloaded' });
}
