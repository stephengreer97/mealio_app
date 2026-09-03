// Run the Wegmans rail's OWN add script against the real store, then read the
// cart back. Authorised by Stephen: development, writes to his basket allowed.
import { chromium, Page } from 'playwright';
import { getNetworkRail } from '../../src/lib/webview-scripts/network-rail';
import { buildWegmansCartReadScript } from '../../src/lib/webview-scripts/wegmans-network';

const ALL: Record<string, unknown>[] = [];
let bound = false;
async function bind(page: Page) {
  if (bound) return; bound = true;
  await page.exposeFunction('__railMsg', (raw: string) => {
    try { ALL.push(JSON.parse(raw)); } catch { /* non-JSON */ }
  });
}
async function collect(page: Page, script: string, want: string[], ms = 40000) {
  await bind(page);
  await page.evaluate('window.ReactNativeWebView = { postMessage: function (m) { window.__railMsg(m); } };');
  const from = ALL.length;
  await page.evaluate(script);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const got = ALL.slice(from);
    if (want.some((w) => got.some((m) => m.type === w))) break;
    await page.waitForTimeout(200);
  }
  return ALL.slice(from);
}

(async () => {
  const rail = getNetworkRail('wegmans')!;
  const b = await chromium.connectOverCDP('http://localhost:9333');
  const page = b.contexts()[0].pages().find((p) => /wegmans\.com/.test(p.url()));
  if (!page) { console.log('no wegmans page'); process.exit(1); }
  await page.goto('https://www.wegmans.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(1200);

  const before = await collect(page, buildWegmansCartReadScript(), ['CART_COUNT']);
  const b0 = before.find((m) => m.type === 'CART_COUNT') as any;
  console.log('cart before:', b0.count, 'lines', (b0.items || []).length);

  // WEG_SKUS="sku:qty,sku:qty" for a batch, or WEG_SKU/WEG_QTY for one.
  const spec = process.env.WEG_SKUS
    || (process.env.WEG_SKU ? process.env.WEG_SKU + ':' + (process.env.WEG_QTY || 1) : '');
  if (!spec) { console.log('set WEG_SKU or WEG_SKUS'); process.exit(1); }
  const items = spec.split(",").map((pair: string, idx: number) => {
    const [sku, qty] = pair.split(':');
    return { idx, productId: sku.trim(), skuId: sku.trim(), quantity: Number(qty || 1), name: 'restore ' + sku };
  });
  for (const it of items) {
    const h = ((b0.items || []) as any[]).find((i) => String(i.itemId) === it.productId);
    console.log('  ', it.productId, 'x', it.quantity, '| held', h ? h.qty : 0);
  }

  const script = rail.addBatch(items as never, 
    { knownLines: null, absoluteQty: process.env.WEG_ABS === '1' } as never);
  if (!script) { console.log('rail refused to build an add'); process.exit(1); }
  const res = await collect(page, script, ['NET_ADD_DONE']);
  for (const m of res) console.log(' ', JSON.stringify(m).slice(0, 300));

  const after = await collect(page, buildWegmansCartReadScript(), ['CART_COUNT']);
  const a0 = after.find((m) => m.type === 'CART_COUNT') as any;
  console.log('cart after:', a0.count, 'items across', (a0.items || []).length, 'lines');
  for (const it of items) {
    const n = ((a0.items || []) as any[]).find((i) => String(i.itemId) === it.productId);
    console.log('  ', it.productId, '->', n ? n.qty : 0);
  }
  await b.close();
})();
