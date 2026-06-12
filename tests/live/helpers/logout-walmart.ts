// Walmart logout helper.
//
// Walmart logout UX:
//   1. Click "Hi, <name>" account greeting (top-right).
//   2. Menu opens with "Sign Out" link.
//   3. Optional confirmation page; final state is the homepage with
//      "Sign In" instead of "Hi, <name>".

import type { Page } from 'playwright';

export async function logoutWalmart(page: Page): Promise<void> {
  if (!/walmart\.com/i.test(page.url())) {
    await page.goto('https://www.walmart.com', { waitUntil: 'domcontentloaded' });
  }

  // Open account greeting menu. Walmart's account button is identifiable
  // by data-automation-id containing "account-greeting" OR aria-label
  // containing "Hi," / "Account".
  const accountBtn = page.locator(
    '[data-automation-id*="account-greeting" i], button[aria-label*="Hi," i], button[aria-label*="Account" i]',
  ).first();
  if ((await accountBtn.count()) === 0) {
    return;
  }
  await accountBtn.click({ timeout: 10_000 });

  const signOut = page.locator(
    'a:has-text("Sign Out"), button:has-text("Sign Out"), a:has-text("Log Out"), [data-automation-id*="sign-out" i]',
  ).first();
  await signOut.click({ timeout: 10_000 });

  await page.waitForLoadState('domcontentloaded');
  // Walmart sometimes shows a confirmation page — give it 5s to settle.
  await page.waitForTimeout(3000);

  // Verify the account greeting changed to "Sign In" or "Account".
  await page.waitForFunction(
    () => {
      const root = document.body.textContent || '';
      return /sign in|create an account/i.test(root);
    },
    { timeout: 15_000 },
  );
}
