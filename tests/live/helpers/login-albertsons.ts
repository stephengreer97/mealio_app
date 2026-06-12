// Albertsons-family login helper.
//
// Works for ACME, Safeway, Vons, Jewel-Osco, Pavilions, Randalls, etc — they
// share the same auth UI. The login domain varies (each family member has
// its own domain) but the selectors are identical.

import type { Page } from 'playwright';
import { StoreCreds } from './creds';

export interface LoginOptions {
  allowManual2faMs?: number;
}

export async function loginAlbertsons(
  page: Page,
  creds: StoreCreds,
  homeUrl: string,
  opts: LoginOptions = {},
): Promise<void> {
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });

  // Open the sign-in modal. Albertsons family typically has a "Sign In"
  // button in the header that opens a modal (not a separate page).
  await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click({ timeout: 15_000 });

  // Fill email + password in the modal.
  await page.locator('input[type="email"], input[name="username"], input[name="email"]').first().fill(creds.email);
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.locator('button:has-text("Sign In"), button[type="submit"]').last().click();

  // Wait for the modal to dismiss (logged-in state shows greeting in header).
  try {
    await page.waitForFunction(
      () => {
        const t = document.body.textContent || '';
        return /Hi,\s+\w/i.test(t) || /Welcome,/i.test(t) || /Sign Out/i.test(t);
      },
      { timeout: 20_000 },
    );
  } catch {
    const url = page.url();
    if (opts.allowManual2faMs) {
      // eslint-disable-next-line no-console
      console.warn(`[login-albertsons] Login challenge. Pausing ${opts.allowManual2faMs}ms for manual completion at ${url}...`);
      await page.waitForFunction(
        () => /Hi,\s+\w|Sign Out/i.test(document.body.textContent || ''),
        { timeout: opts.allowManual2faMs },
      );
    } else {
      throw new Error(`Albertsons login didn't complete. URL: ${url}`);
    }
  }
}
