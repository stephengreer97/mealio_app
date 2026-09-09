/**
 * MEAL-235, the proof. Run the RAIL'S OWN search script against a live ALDI
 * session and report whether the candidates it posts carry prices.
 *
 * This file used to be the question. The question is answered:
 *
 *   The rail read the fulfilment zone out of the ids a search returns --
 *   items_23898-18647633 -> 23898 -- and that is the RETAILER LOCATION id, not
 *   the zone. The zone is 32, and the storefront sends it on every call. A wrong
 *   zone does not fail: Search answers 200 with every item present and
 *   "Not Found" on every price field, which is why this read as "Instacart does
 *   not give us prices" for two months.
 *
 *   MEASURED, same session, same items, one variable at a time:
 *     zone 23898 + placeholder postcode -> 20 price errors, no prices
 *     zone 23898 + real postcode        -> 20 price errors, no prices
 *     zone 32    + placeholder postcode -> 0 errors, every price
 *     zone 32    + real postcode        -> 0 errors, every price
 *   The postcode makes no difference. It was only ever the zone.
 *
 * WHY THIS RUNS THE REAL SCRIPT rather than a hand-written query. A probe that
 * composes its own request proves the endpoint works and nothing about whether
 * the product reaches it -- which is how a fix ships green and helps nobody. So
 * this evaluates the exact string `buildInstacartSearchBatchScript` emits,
 * listens for the messages it posts, and reads the prices off the candidates the
 * app would actually render.
 *
 *   npx tsx tests/fixture-runners/probe-instacart-prices.ts
 *
 * HEADFUL=1 to watch, and to sign in the first time. Read-only: it searches, and
 * adds nothing to any cart.
 */

import { launchPersistentStealthContext } from '../_shared/launch-stealth';
import { buildInstacartSearchBatchScript } from '../../src/lib/webview-scripts/instacart-network';

const SLUG = 'aldi';
const TERMS = ['sour cream', 'tortillas'];

async function main() {
  const context = await launchPersistentStealthContext({
    profileName: SLUG,
    headless: process.env.HEADFUL !== '1',
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`https://www.instacart.com/store/${SLUG}/storefront`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });

  // esbuild's keep-names helper is injected by tsx and does not exist in the
  // page, so it goes in before any evaluated function that carries a name.
  // A string, so it cannot itself be transformed on the way in.
  await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; }');

  // The shop id, discovered the way the session script discovers it, because the
  // search script is handed one rather than finding its own.
  const shopId = await page.evaluate(async (slug) => {
    const html = await (await fetch(`/store/${slug}/storefront`, { credentials: 'include' })).text();
    const after = (needle: string) => {
      const at = html.indexOf(needle);
      if (at < 0) return null;
      let v = '';
      for (let i = at + needle.length; i < at + needle.length + 8; i++) {
        const ch = html.charAt(i);
        if (ch < '0' || ch > '9') break;
        v += ch;
      }
      return v || null;
    };
    return after('%5C%22shopId%5C%22%3A%5C%22') || after('%22shopId%22%3A%22') || after('"shopId":"');
  }, SLUG);

  if (!shopId) {
    console.error('[probe] no shopId — almost certainly signed out. Re-run with HEADFUL=1 and sign in.');
    await context.close();
    process.exit(1);
  }

  // The rail posts through ReactNativeWebView; stand one up that collects.
  await page.evaluate(`
    globalThis.__name = globalThis.__name || function (f) { return f; };
    window.__mealioPosts = [];
    window.ReactNativeWebView = { postMessage: function (m) { window.__mealioPosts.push(m); } };
  `);

  const script = buildInstacartSearchBatchScript(TERMS, { shopId, requestMs: 20000 });
  if (!script) { console.error('[probe] the rail refused to build a script'); process.exit(1); }

  // addScriptTag, not evaluate. The rail emits STATEMENTS ending in `true;` --
  // which is exactly what a WebView injection wants and is not an expression,
  // and page.evaluate only takes an expression. A script tag runs it as the
  // browser would, so what executes here is byte-for-byte what ships.
  // Indirect eval, not addScriptTag and not evaluate-as-expression. The rail
  // emits STATEMENTS ending in `true;` -- what a WebView injection wants, and
  // not an expression, which is all page.evaluate accepts as a string.
  // addScriptTag was the obvious alternative and is silently blocked by the
  // storefront's CSP. `(0, eval)` runs the exact bytes that ship, in the page's
  // own global scope, which is what a WebView injection does.
  const ran = await page.evaluate((src: string) => {
    try { (0, eval)(src); return { ok: true }; }
    catch (e) { return { ok: false, why: String(e).slice(0, 200) }; }
  }, script);
  if (!ran.ok) console.error(`[probe] the injected script threw: ${ran.why}`);
  try {
    await page.waitForFunction(
      "(window.__mealioPosts || []).some(function (m) { return m.indexOf('SEARCH_BATCH_DONE') >= 0; })",
      null, { timeout: 90_000 },
    );
  } catch {
    // Report what DID arrive rather than dying on the wait: a batch that never
    // finishes is itself the finding, and the posts so far say where it stopped.
    console.error('[probe] the batch never posted SEARCH_BATCH_DONE — dumping what arrived');
  }

  const posts: string[] = await page.evaluate('window.__mealioPosts');
  const parsed = posts.map((p) => { try { return JSON.parse(p); } catch { return { raw: p }; } });

  const shape = parsed.find((m) => m.type === 'IC_SEARCH_SHAPE');
  const results = parsed.filter((m) => m.type === 'SEARCH_RESULT');
  const failed = parsed.filter((m) => m.type === 'SEARCH_RESULT_FAILED');

  console.log('\n══════════ MEAL-235 proof ══════════');
  console.log(`shopId ${shopId}`);
  console.log(`zone   ${shape?.zone}   (from: ${shape?.zoneFrom})`);
  console.log('');

  let withPrice = 0;
  let total = 0;
  for (const r of results) {
    console.log(`"${r.term}" -> ${r.n} candidates in ${r.ms}ms`);
    for (const c of (r.candidates ?? []).slice(0, 5)) {
      total += 1;
      if (c.price) withPrice += 1;
      console.log(`   ${String(c.price ?? '—').padStart(7)}  ${c.productName}`);
    }
  }
  for (const f of failed) console.log(`"${f.term}" FAILED: ${f.why} ${f.detail ?? ''}`);

  console.log('');
  console.log(`VERDICT: ${withPrice}/${total} of the candidates the app would render carry a price.`);
  if (shape?.zoneFrom === 'item-id' || shape?.zoneFrom === 'cache:item-id') {
    console.log('         zoneFrom is the FALLBACK. The storefront marker did not answer, so prices are expected to be missing.');
  }
  console.log('════════════════════════════════════\n');

  await context.close();
}

main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
