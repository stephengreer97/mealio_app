// Amazon Fresh logout helper.
//
// Amazon's logout: navigate to /gp/flex/sign-out.html (the canonical sign-out
// endpoint). This is cleaner than trying to hover the Account dropdown.

import type { Page } from 'playwright';

export async function logoutAmazon(page: Page): Promise<void> {
  // Direct navigation to the sign-out endpoint.
  await page.goto('https://www.amazon.com/gp/flex/sign-out.html', {
    waitUntil: 'domcontentloaded',
  });

  // After sign-out Amazon usually shows a sign-in prompt. Wait for it.
  await page.waitForFunction(
    () => {
      const accountList = document.getElementById('nav-link-accountList');
      if (!accountList) return true;
      const txt = (accountList.textContent || '').trim();
      // Logged-out shows "Hello, sign in" (or just "Sign in"); logged-in
      // shows "Hello, <name>".
      return /sign in/i.test(txt) && !/Hello, (?!sign in)/i.test(txt);
    },
    { timeout: 20_000 },
  );
}
