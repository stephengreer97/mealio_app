// HEB logout helper.
//
// HEB logout UX (verified empirically — selectors may drift; update from
// the captured logged-in-home.html fixture if a test starts failing here):
//   1. Click the "My account" profile button (top-right).
//   2. Dropdown menu opens with "Sign Out" link.
//   3. After clicking Sign Out, browser redirects through HEB's OIDC
//      logout endpoint and lands back on heb.com unauthenticated.

import type { Page } from 'playwright';

export async function logoutHeb(page: Page): Promise<void> {
  if (!/heb\.com/i.test(page.url())) {
    await page.goto('https://www.heb.com', { waitUntil: 'domcontentloaded' });
  }

  // Open account menu. HEB uses an aria-label containing "account" (case-insensitive).
  const accountBtn = page.locator('button[aria-label*="account" i], button[aria-label*="My account" i]').first();
  if ((await accountBtn.count()) === 0) {
    return; // already logged out
  }
  await accountBtn.click({ timeout: 10_000 });

  // Click Sign Out. Use a:contains or button:contains depending on which is rendered.
  const signOut = page.locator('a:has-text("Sign Out"), button:has-text("Sign Out"), a:has-text("Log Out"), button:has-text("Log Out")').first();
  await signOut.click({ timeout: 10_000 });

  // Wait for OIDC redirect chain to finish and land on heb.com without auth.
  await page.waitForURL(/heb\.com/, { timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');

  // Verify the account button no longer shows initials/name (logged-out shows
  // "Sign In" instead).
  await page.waitForFunction(
    () => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      return btns.some((b) => (b.textContent || '').trim().match(/^Sign In$/i));
    },
    { timeout: 15_000 },
  );
}
