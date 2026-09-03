// Watch what a store's own site calls while SIGNED IN, from inside the app's
// WebView on the phone. See README.md for how to get a page target.
//
// Read-only: it navigates and observes. Nothing is clicked, no cart is written.
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = process.env.RAIL_RECON_OUT || '/tmp/rail-recon';

async function main() {
  const label = process.argv[2];
  const urls = process.argv.slice(3);
  if (!label || urls.length === 0) {
    console.error('usage: watch.ts <label> <url> [url…]');
    process.exit(1);
  }
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => !p.url().startsWith('about:')) ?? ctx.pages()[0];
  if (!page) throw new Error('no page target — open the cart sheet on a rail store and stop on the qty screen');

  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    const t = r.resourceType();
    if (t !== 'xhr' && t !== 'fetch' && t !== 'document') return;
    let op: string | undefined;
    let bodyPeek: string | undefined;
    try {
      const b = r.postData();
      if (b) {
        bodyPeek = b.slice(0, 1200);
        const m = b.match(/"operationName"\s*:\s*"([^"]+)"/);
        if (m) op = m[1];
      }
    } catch { /* body unavailable on some requests */ }
    // Headers, with anything that authenticates redacted to its length.
    const h: Record<string, string> = { ...r.headers() };
    for (const k of Object.keys(h)) {
      if (/cookie|authorization|token|secret/i.test(k)) h[k] = `<redacted ${h[k].length}ch>`;
      else if (h[k].length > 600) h[k] = `${h[k].slice(0, 600)}…<+${h[k].length - 600}>`;
    }
    calls.push({ m: r.method(), url: r.url(), type: t, op, bodyPeek, headers: h });
  });
  page.on('response', (res) => {
    const hit = calls.find((c) => c.url === res.url() && c.status === undefined);
    if (hit) hit.status = res.status();
  });

  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(11000);
    } catch (e) {
      console.log('[nav]', u.slice(0, 60), String((e as Error).message).slice(0, 70));
    }
    console.log(`[${u.slice(0, 70)}] ${calls.length} calls so far, now at ${page.url().slice(0, 80)}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${label}-live.json`);
  fs.writeFileSync(out, JSON.stringify(calls, null, 1));
  console.log(`\nwrote ${calls.length} calls to ${out}`);
  await browser.close();
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
