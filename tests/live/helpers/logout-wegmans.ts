// Wegmans logout helper.
//
// Wegmans logout UX:
//   1. Click the "Hello, <name>" greeting button in the header — opens a
//      dropdown menu.
//   2. Click "Sign Out" link in the menu.
//   3. Page redirects, the greeting button is replaced with "Sign In".
//
// Throws with a clear error if any step can't find its target — the caller
// should let this surface so the test run reports a failed cleanup.

import type { Page } from 'playwright';

export async function logoutWegmans(page: Page): Promise<void> {
  // Ensure we're on a wegmans.com page; if we navigated away (e.g. to a
  // search URL), go back home first so the header is the standard one.
  if (!/wegmans\.com/i.test(page.url())) {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
  }

  // Open the account menu.
  const greeting = page.locator('button[aria-label="Account"]:has-text("Hello,"), button.component--site-header-desktop-sign-in-greeting-button').first();
  if ((await greeting.count()) === 0) {
    // Already logged out — nothing to do.
    return;
  }
  await greeting.click({ timeout: 10_000 });

  // Click "Sign Out". The dropdown link text is exactly "Sign Out".
  const signOut = page.locator('a:has-text("Sign Out"), button:has-text("Sign Out")').first();
  await signOut.click({ timeout: 10_000 });

  // Wait for the greeting button to disappear / change to "Sign In".
  await page.waitForFunction(
    () => {
      const greetBtn = document.querySelector(
        'button[aria-label="Account"], button.component--site-header-desktop-sign-in-greeting-button',
      );
      if (!greetBtn) return true; // no greeting at all = logged out
      const txt = (greetBtn.textContent || '').trim();
      return txt === 'Sign In';
    },
    { timeout: 15_000 },
  );
}
