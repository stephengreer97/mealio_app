// Wegmans cart-cleanup helper.
//
// Critical: every live test that adds to the cart MUST run this in its
// afterEach so test runs don't accumulate items.
//
// Strategy:
//   1. Navigate to /cart
//   2. For each line item: click its decrement (-) button repeatedly until
//      the item is removed, OR click an explicit "Remove" button if one is
//      present.
//   3. Verify the cart-count badge in the header reads 0.
//
// If cleanup can't reach 0 (network error, DOM changed, item refuses to
// remove), throws with a clear error — the caller's afterEach should let
// this bubble up so the test run reports an unclean state.

import type { Page } from 'playwright';

const CART_URL = 'https://www.wegmans.com/cart';
const CART_COUNT_SEL = 'a[aria-label*="selected items in my Cart"], a[aria-label*="selected items in my List"]';
const LINE_ITEM_SEL = '[class*="cart-item"], [data-testid*="cart-line" i], li[class*="line"]';
// The minus button inside each line-item's stepper. Wegmans uses the same
// add-button class for both + and -, distinguished by aria-label.
const DEC_BTN_SEL = 'button[aria-label*="Decrease" i], button[aria-label*="Subtract" i], button[aria-label*="Remove" i]';

export async function clearCartWegmans(page: Page): Promise<void> {
  await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000); // settle for hydration

  let attempts = 0;
  const MAX_ATTEMPTS = 30;
  while (attempts++ < MAX_ATTEMPTS) {
    const lineItems = await page.locator(LINE_ITEM_SEL).count();
    if (lineItems === 0) break;

    // Take the first line item and click its decrement button until it goes
    // away.
    const firstItem = page.locator(LINE_ITEM_SEL).first();
    const decBtn = firstItem.locator(DEC_BTN_SEL).first();
    if ((await decBtn.count()) === 0) {
      throw new Error(
        `[clear-cart-wegmans] Could not find decrement button in cart line item. ` +
          `DOM may have changed.`,
      );
    }
    await decBtn.click();
    await page.waitForTimeout(700); // wait for cart API to commit

    if (attempts >= MAX_ATTEMPTS) {
      throw new Error(
        `[clear-cart-wegmans] Exceeded ${MAX_ATTEMPTS} click attempts; cart still has items.`,
      );
    }
  }

  // Verify cart count is 0 in the header.
  const cartLink = page.locator(CART_COUNT_SEL).first();
  if ((await cartLink.count()) > 0) {
    const aria = (await cartLink.getAttribute('aria-label')) || '';
    if (!/View 0 selected items/i.test(aria)) {
      throw new Error(
        `[clear-cart-wegmans] After cleanup the cart-count header still reads: "${aria}"`,
      );
    }
  }
}
