// Verify a rail against the real store, from inside the app's live session.
//
//   npx tsx tools/rail-recon/verify-rail.ts aldi
//   npx tsx tools/rail-recon/verify-rail.ts wegmans
//
// Runs the rail's OWN scripts — the ones the app ships — against the real store
// and prints what came back. Not a stub and not a reimplementation: if this
// says the search works, the app's search works.
//
// Setup (see README.md): unlock the phone, open the cart sheet on a rail store
// and stop on the quantity screen, then
//   PID=$(adb shell pidof co.mealio.app | tr -d '\r')
//   adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
//
// READ ONLY. It runs the session probe, the search and the cart read. It does
// NOT run the add: that writes to a real basket and needs the account owner
// awake and asking for it.
import { chromium, Page } from 'playwright';
import { getNetworkRail } from '../../src/lib/webview-scripts/network-rail';
import { getStoreScripts } from '../../src/lib/webview-scripts';

const TERM = process.env.RAIL_TERM || 'sour cream';

async function collect(page: Page, script: string, want: string[], ms = 30000) {
  const seen: Record<string, unknown>[] = [];
  await page.exposeFunction('__railMsg', (raw: string) => {
    try { seen.push(JSON.parse(raw)); } catch { /* non-JSON */ }
  }).catch(() => { /* already exposed */ });
  await page.evaluate(`window.ReactNativeWebView = { postMessage: (m) => window.__railMsg(m) };`);
  await page.evaluate(script);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (want.some((w) => seen.some((m) => m.type === w))) break;
    await page.waitForTimeout(250);
  }
  return seen;
}

async function main() {
  const storeId = process.argv[2];
  const rail = getNetworkRail(storeId);
  const scripts = getStoreScripts(storeId);
  if (!rail || !scripts) { console.error(`no rail for "${storeId}"`); process.exit(1); }

  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('about:')) ?? ctx.pages()[0];
  if (!page) throw new Error('no page target — open the cart sheet on a rail store, qty screen');

  const quiet = scripts.railUrl || scripts.storeUrl;
  console.log(`\n=== ${storeId} — running its own rail scripts on ${quiet} ===\n`);
  await page.goto(quiet, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(1500);

  // 1. session
  const sess = await collect(page, rail.sessionScript(), [rail.sessionMessageType]);
  const answers = sess.filter((m) => m.type === rail.sessionMessageType);
  console.log('SESSION —', answers.length, 'answer(s)');
  for (const a of answers) console.log('  ', JSON.stringify(a).slice(0, 420));
  const usable = answers.filter((a) => rail.sessionUsable(a as never)).pop();
  if (!usable || !usable.loggedIn) {
    console.log('\nnot signed in (or no usable session) — stopping here.\n');
    await browser.close();
    return;
  }

  const session = {
    storeId: String(usable.storeId ?? ''),
    shoppingContext: String(usable.shoppingContext ?? ''),
  };

  // 2. search
  const searchScript = rail.searchBatch([TERM], session);
  if (!searchScript) {
    console.log(`\nSEARCH — the rail REFUSED to build one for storeId="${session.storeId}".`);
    console.log('That is deliberate when the store is unknown; see the rail.\n');
  } else {
    const t0 = Date.now();
    const out = await collect(page, searchScript, ['SEARCH_BATCH_DONE'], 60000);
    const hit = out.find((m) => m.type === 'SEARCH_RESULT') as Record<string, unknown> | undefined;
    const fail = out.find((m) => m.type === 'SEARCH_RESULT_FAILED');
    console.log(`\nSEARCH "${TERM}" — ${Date.now() - t0}ms wall`);
    if (fail) console.log('  FAILED:', JSON.stringify(fail).slice(0, 300));
    if (hit) {
      const cands = (hit.candidates as Record<string, unknown>[]) ?? [];
      console.log(`  ${cands.length} candidates, store reported ${hit.ms}ms`);
      for (const c of cands.slice(0, 3)) {
        console.log('   ', JSON.stringify({
          productName: c.productName, productId: c.productId, skuId: c.skuId,
          price: c.price, outOfStock: c.outOfStock, maxOrderQuantity: c.maxOrderQuantity,
          upc: c.upc,
        }));
      }
    }
    for (const d of out.filter((m) => String(m.type).startsWith('IC_'))) {
      console.log('  diagnostic:', JSON.stringify(d).slice(0, 300));
    }
  }

  // 3. cart read
  const t1 = Date.now();
  const cart = await collect(page, rail.cartRead(), ['CART_COUNT'], 40000);
  const count = cart.find((m) => m.type === 'CART_COUNT');
  console.log(`\nCART READ — ${Date.now() - t1}ms wall`);
  console.log('  ', JSON.stringify(count).slice(0, 500));

  console.log('\nThe add is NOT run here — it writes to a real basket.');
  console.log('To measure whether quantity is absolute: add one item by hand, run this,');
  console.log('note the qty, then write the same id with quantity 2 and read again.\n');
  await browser.close();
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
