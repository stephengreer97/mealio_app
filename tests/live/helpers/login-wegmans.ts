// Wegmans login helper for live tests.
//
// Wegmans login flow:
//   1. Click "Sign In" in the header (or open the hamburger menu first).
//   2. Page redirects to myaccount.wegmans.com (Azure AD B2C OAuth).
//   3. Enter email, click Continue, enter password.
//   4. Sometimes a 2FA prompt (phone OTP) — see TWO_FA_HANDLING below.
//   5. Redirected back to wegmans.com with auth cookies.
//
// 2FA handling: this helper does NOT attempt automated 2FA. If your test
// account has 2FA enabled, either:
//   (a) disable 2FA on the test account, OR
//   (b) accept that the test will pause for ~30s waiting for the OTP and
//       complete manually (call the helper with { allowManual2fa: true })

import type { Page } from 'playwright';
import { StoreCreds } from './creds';

export interface LoginOptions {
  /** Wait this long (ms) for a 2FA challenge to be completed manually */
  allowManual2faMs?: number;
}

export async function loginWegmans(
  page: Page,
  creds: StoreCreds,
  opts: LoginOptions = {},
): Promise<void> {
  await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });

  // Open the sign-in flow. On mobile the button is in the hamburger menu;
  // on desktop it's in the top-right.
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  await signInBtn.click({ timeout: 15_000 });

  // Wait for the Azure AD B2C signin page.
  await page.waitForURL(/myaccount\.wegmans\.com/, { timeout: 20_000 });

  // Email page.
  await page.locator('input[type="email"], input[name="email"]').first().fill(creds.email);
  await page.locator('button:has-text("Continue"), button[type="submit"]').first().click();

  // Password page.
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.locator('button:has-text("Sign In"), button[type="submit"]').first().click();

  // 2FA check: if we're still on myaccount.wegmans.com after a few seconds,
  // we hit a challenge.
  try {
    await page.waitForURL(/^https:\/\/www\.wegmans\.com/, { timeout: 8_000 });
  } catch {
    // Either still on B2C (2FA) or login failed.
    const url = page.url();
    if (/myaccount\.wegmans\.com/.test(url)) {
      const wait = opts.allowManual2faMs ?? 0;
      if (wait > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[login-wegmans] 2FA challenge detected. Pausing ${wait}ms for manual completion...`,
        );
        await page.waitForURL(/^https:\/\/www\.wegmans\.com/, { timeout: wait });
      } else {
        throw new Error(
          'Wegmans login stuck on B2C (likely 2FA). Disable 2FA on the test ' +
            'account or pass { allowManual2faMs: 60000 } to loginWegmans().',
        );
      }
    } else {
      throw new Error(`Wegmans login failed — URL is ${url}`);
    }
  }

  // Verify by checking for the "Hello, <name>" greeting button.
  await page.waitForSelector('button[aria-label="Account"], button.component--site-header-desktop-sign-in-greeting-button', {
    timeout: 15_000,
  });
}
