// Albertsons family logout helper (works for ACME, Safeway, Vons, Jewel-Osco,
// Pavilions, Randalls, Tom Thumb, Shaw's, Star Market, Haggen, Carrs, Kings,
// Balducci's).
//
// All family members share the same DOM. Logout UX:
//   1. Click the account/profile button at the top.
//   2. Menu opens; click "Sign Out".
//   3. Land on homepage with "Sign In" button visible.

import type { Page } from 'playwright';

export async function logoutAlbertsons(page: Page, homeUrl: string): Promise<void> {
  if (!new URL(homeUrl).host.split('.').slice(-2).join('.').includes(new URL(page.url()).host.split('.').slice(-2).join('.'))) {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
  }

  const accountBtn = page.locator('button[aria-label*="account" i], button:has-text(/Hi,|Welcome/i)').first();
  if ((await accountBtn.count()) === 0) {
    return;
  }
  await accountBtn.click({ timeout: 10_000 });

  const signOut = page.locator('button:has-text("Sign Out"), a:has-text("Sign Out"), button:has-text("Log Out"), a:has-text("Log Out")').first();
  await signOut.click({ timeout: 10_000 });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Verify by checking for "Sign In" in the header.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('a, button')).some((el) =>
      (el.textContent || '').trim().match(/^Sign In$|^Log In$/i),
    ),
    { timeout: 15_000 },
  );
}
