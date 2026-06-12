// ALDI logout helper.
//
// ALDI runs on Instacart's storefront. Login state lives in Instacart's
// cookies + their auth API. Logout UX:
//   1. Open hamburger menu (top-left).
//   2. Drawer opens; scroll down to find "Sign out" / "Log out".
//   3. Click — Instacart logs the user out and the drawer reflects logged-out state.

import type { Page } from 'playwright';

export async function logoutAldi(page: Page): Promise<void> {
  if (!/aldi\.us/i.test(page.url()) && !/instacart\.com/i.test(page.url())) {
    await page.goto('https://www.aldi.us', { waitUntil: 'domcontentloaded' });
  }

  // Open hamburger menu.
  const menuBtn = page.locator(
    'button[aria-label*="menu" i], button[aria-label*="navigation" i], button:has(svg[aria-label*="menu" i])',
  ).first();
  if ((await menuBtn.count()) === 0) {
    // No menu visible — likely already logged out, or DOM unexpected.
    return;
  }
  await menuBtn.click({ timeout: 10_000 });

  // Wait for drawer to open and find the Sign Out link.
  const signOut = page.locator('button:has-text("Sign out"), a:has-text("Sign out"), button:has-text("Log out"), a:has-text("Log out")').first();
  if ((await signOut.count()) === 0) {
    // Already logged out — drawer would show "Sign in" instead.
    return;
  }
  await signOut.click({ timeout: 10_000 });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  // Re-open menu to verify it now shows "Sign in" / "Login".
  const menuBtn2 = page.locator(
    'button[aria-label*="menu" i], button[aria-label*="navigation" i], button:has(svg[aria-label*="menu" i])',
  ).first();
  if ((await menuBtn2.count()) > 0) {
    await menuBtn2.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForFunction(
      () => {
        const txt = document.body.textContent || '';
        return /sign in|log in/i.test(txt);
      },
      { timeout: 10_000 },
    );
  }
}
