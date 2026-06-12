// ALDI (Instacart-backed) login helper.
//
// ALDI's storefront is hosted by Instacart. Login goes through Instacart's
// auth flow (mobile menu → Sign In → Instacart modal/page → email+password
// or OTP).
//
// Heads up: Instacart prefers OTP login over password. If the test account
// has no password set (Instacart sometimes nudges users toward passwordless),
// this helper will fall back to manual completion when configured.

import type { Page } from 'playwright';
import { StoreCreds } from './creds';

export interface LoginOptions {
  allowManualMs?: number;
}

export async function loginAldi(
  page: Page,
  creds: StoreCreds,
  opts: LoginOptions = {},
): Promise<void> {
  await page.goto('https://www.aldi.us', { waitUntil: 'domcontentloaded' });

  // Open the hamburger menu.
  await page.locator(
    'button[aria-label*="menu" i], button[aria-label*="navigation" i]',
  ).first().click({ timeout: 15_000 });

  // Tap "Sign in" in the drawer.
  await page.locator('button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in")').first().click({ timeout: 10_000 });

  // Instacart modal/page — fill email.
  await page.locator('input[type="email"], input[name="email"]').first().fill(creds.email);

  // Continue.
  await page.locator('button:has-text("Continue"), button[type="submit"]').first().click().catch(() => {});

  // Password field (may not appear if Instacart prefers OTP).
  const passwordField = page.locator('input[type="password"]').first();
  if (await passwordField.count() > 0) {
    await passwordField.fill(creds.password);
    await page.locator('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]').first().click();
  } else if (opts.allowManualMs) {
    // eslint-disable-next-line no-console
    console.warn(`[login-aldi] No password field — Instacart may want OTP. Pausing ${opts.allowManualMs}ms for manual completion...`);
    await page.waitForFunction(
      () => /Sign out|Account|Hi,/i.test(document.body.textContent || ''),
      { timeout: opts.allowManualMs },
    );
    return;
  } else {
    throw new Error(
      '[login-aldi] No password prompt — Instacart probably wants OTP. ' +
        'Re-call with { allowManualMs: 60000 } to complete OTP manually.',
    );
  }

  // Verify logged in.
  await page.waitForFunction(
    () => /Sign out|Hi,|Welcome/i.test(document.body.textContent || ''),
    { timeout: 20_000 },
  );
}
