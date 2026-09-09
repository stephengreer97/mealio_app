/**
 * MEAL-234. Which Walmart items come back without a price, and what do THEY
 * carry instead?
 *
 * The rail reads `priceInfo.priceDetails.priceLines[]`, takes the line whose
 * `lineType` is `DISCOUNTED_PRICE` and then the value keyed `PRICE`, falling
 * back to `priceInfo.currentPrice`. When neither answers, `price` stays null and
 * the Choose Products row simply draws no price — the gate is
 * `c.price && !c.outOfStock` — so a miss is INVISIBLE rather than wrong, which
 * is why this reads as "some products" and not as an error.
 *
 * So: run the rail's own search, split the candidates into priced and unpriced,
 * and dump the raw `priceInfo` of each group side by side. Field names first.
 * Widening the fallback chain before reading them is how you end up with four
 * fallbacks and the same bug.
 *
 *   npx tsx tests/fixture-runners/probe-walmart-prices.ts
 *
 * HEADFUL=1 to watch, and to sign in the first time. Read-only.
 */

import { launchPersistentStealthContext } from '../_shared/launch-stealth';
import { getNetworkRail } from '../../src/lib/webview-scripts/network-rail';

/**
 * ONE TERM. This store answers a burst of searches with a 412 challenge, and
 * once it has, even the homepage comes back "Robot or human?" for a while. The
 * question here needs one search, so it takes one.
 */
const TERMS = (process.env.TERMS ?? 'sour cream').split('|');

async function main() {
  const context = await launchPersistentStealthContext({
    profileName: 'walmart',
    headless: process.env.HEADFUL !== '1',
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://www.walmart.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; }');

  const rail = getNetworkRail('walmart');
  if (!rail) { console.error('[probe] no walmart rail'); process.exit(1); }

  await page.evaluate(`
    window.__mealioPosts = [];
    window.ReactNativeWebView = { postMessage: function (m) { window.__mealioPosts.push(m); } };
    // Keep the raw response TEXT of every graphql call. Parsed in node rather
    // than walked in the page: the walk is where the first attempt lost the
    // items, and a string cannot be lost.
    window.__rawBodies = [];
    (function () {
      var real = window.fetch;
      window.fetch = function (url, init) {
        var p = real.apply(this, arguments);
        try {
          if (String(url).indexOf('graphql') >= 0 || String(url).indexOf('orchestra') >= 0) {
            p.then(function (res) {
              try {
                res.clone().text().then(function (t) { window.__rawBodies.push(t); }).catch(function () {});
              } catch (e) {}
            }).catch(function () {});
          }
        } catch (e) {}
        return p;
      };
    })();
  `);

  const script = rail.searchBatch(TERMS, { storeId: 'walmart', shoppingContext: '' });
  if (!script) { console.error('[probe] the rail refused to build a script'); process.exit(1); }

  const ran = await page.evaluate((src: string) => {
    try { (0, eval)(src); return { ok: true, why: null as string | null }; }
    catch (e) { return { ok: false, why: String(e).slice(0, 300) }; }
  }, script);
  if (!ran.ok) console.error('[probe] injected script threw:', ran.why);
  // Watch it rather than only waiting on the end: zero posts after two minutes
  // and zero posts after ten seconds are different failures, and the first
  // SEARCH_RESULT_FAILED says which.
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(10_000);
    const n = await page.evaluate('(window.__mealioPosts || []).length') as number;
    const last = await page.evaluate('((window.__mealioPosts || []).slice(-1)[0] || "").slice(0, 160)');
    console.log(`[probe] +${(i + 1) * 10}s posts=${n} last=${last}`);
    if (String(last).includes('SEARCH_BATCH_DONE')) break;
  }
  try {
    await page.waitForFunction(
      "(window.__mealioPosts || []).some(function (m) { return m.indexOf('SEARCH_BATCH_DONE') >= 0; })",
      null, { timeout: 120_000 },
    );
  } catch { console.error('[probe] batch never finished; dumping what arrived'); }

  const posts: string[] = await page.evaluate('window.__mealioPosts');
  console.log(`[probe] ${posts.length} posts:`);
  for (const p of posts.slice(0, 12)) console.log('   ', p.slice(0, 220));
  console.log('[probe] url:', page.url());
  const parsed = posts.map((p) => { try { return JSON.parse(p); } catch { return { raw: p }; } });
  const results = parsed.filter((m) => m.type === 'SEARCH_RESULT');
  const failed = parsed.filter((m) => m.type === 'SEARCH_RESULT_FAILED');

  const priced: any[] = [];
  const unpriced: any[] = [];
  for (const r of results) for (const c of r.candidates ?? []) (c.price ? priced : unpriced).push(c);

  console.log('\n══════════ MEAL-234 probe ══════════');
  for (const f of failed) console.log(`"${f.term}" FAILED: ${f.why} ${f.detail ?? ''}`);
  console.log(`priced ${priced.length} / unpriced ${unpriced.length}`);
  console.log('\n── unpriced candidates ──');
  for (const c of unpriced.slice(0, 12)) {
    console.log(`  ${c.productName}   [oos=${c.outOfStock} weight=${c.isWeightItem} offer=${c.productId ?? '-'}]`);
  }

  // The raw shapes, which is the actual point.
  const bodies: string[] = await page.evaluate('window.__rawBodies');
  console.log(`[probe] captured ${bodies.length} graphql bodies, ${bodies.reduce((n, b) => n + b.length, 0)} bytes`);
  const byName = new Map<string, any>();
  const collect = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node.name && (node.priceInfo || node.usItemId)) byName.set(String(node.name), node);
    for (const k of Object.keys(node)) collect(node[k]);
  };
  for (const b of bodies) { try { collect(JSON.parse(b)); } catch { /* not json */ } }
  console.log(`[probe] ${byName.size} raw items recovered`);

  const shapeOf = (c: any) => {
    const it = byName.get(String(c.productName));
    if (!it) return { name: c.productName, raw: 'not captured' };
    const pi = it.priceInfo ?? null;
    return {
      name: c.productName,
      canAddToCart: it.canAddToCart ?? null,
      availability: it.availabilityStatusDisplayValue ?? it.availabilityStatus ?? null,
      salesUnitType: it.salesUnitType ?? null,
      sellerName: it.sellerName ?? it.seller?.name ?? null,
      priceInfoKeys: pi ? Object.keys(pi) : null,
      lineTypes: pi?.priceDetails?.priceLines?.map((l: any) => ({
        lineType: l.lineType,
        keys: (l.values ?? []).map((v: any) => v.key),
      })) ?? null,
      currentPrice: pi?.currentPrice ?? null,
      priceDisplayCodes: pi?.priceDisplayCodes ?? null,
    };
  };

  console.log('\n── RAW priceInfo: one that HAS a price ──');
  console.log(JSON.stringify(priced.slice(0, 2).map(shapeOf), null, 2));
  console.log('\n── RAW priceInfo: ones that DO NOT ──');
  console.log(JSON.stringify(unpriced.slice(0, 4).map(shapeOf), null, 2));
  console.log('════════════════════════════════════\n');

  await context.close();
}

main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
