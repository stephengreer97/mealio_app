// Run JS inside the Mealio app's LIVE WebView on the phone.
//
// The app's WebView is debuggable in a dev build, so `adb forward` plus
// connectOverCDP puts us inside Stephen's real, signed-in session for every
// store at once -- the cookie jar is shared across the app's WebViews.
//
// READ ONLY. Nothing here writes to a cart. Discovering the write endpoint is
// one thing; putting groceries in a sleeping man's basket is another.
import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  const url = process.argv[2];
  const file = process.argv[3];
  const expr = fs.readFileSync(file, 'utf8');

  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('about:')) ?? ctx.pages()[0];
  if (!page) throw new Error('no page target — is the cart sheet open on a rail store?');

  if (url && url !== '-' && !page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
      console.log('[nav]', e.message.slice(0, 80));
    });
    await page.waitForTimeout(1500);
  }
  const out = await page.evaluate(expr as any);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  await browser.close();
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
