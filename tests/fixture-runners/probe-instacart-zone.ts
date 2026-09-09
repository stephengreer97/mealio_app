/**
 * MEAL-235, phase three. WHICH variable was wrong?
 *
 * Phase two watched the storefront render prices and recorded the call that
 * carried them:
 *
 *   Items  388f200246a7fcc0f10ed9c1bb97952f9046e69c1be3b14ebae5855822cec831
 *   { ids: ["items_23898-25928617", ...], shopId: "8583", zoneId: "32", postalCode: "78731" }
 *
 * Three things there contradict what the rail sends:
 *
 *   1. The operation is `Items`, not `ItemPricesQuery` and not a price field on
 *      `Search`.
 *   2. The ids are the FULL composite ids the search already returns. The rail
 *      had them all along.
 *   3. **zoneId is 32.** The rail parses the zone out of the item id
 *      (items_23898-18647633 -> 23898) and sends that. But 23898 is the
 *      RETAILER LOCATION id -- `viewSection.trackingProperties.retailer_location_id`
 *      says so in the same response -- and the real zone is a different, much
 *      smaller number.
 *
 * If (3) is the whole story then the price failure was never about id spaces at
 * all: `Search` takes a zoneId too, and has been getting the wrong one since the
 * day the zone was "discovered" by parsing it out of an id.
 *
 * This isolates it: the same search, four ways, changing one variable at a time.
 *
 *   npx tsx tests/fixture-runners/probe-instacart-zone.ts
 */

import { launchPersistentStealthContext } from '../_shared/launch-stealth';

const SLUG = 'aldi';
const TERM = 'sour cream';
const SEARCH_SHA = '6d77b6fd5b62f6d88999f5a022af16fafcb00de911da6b942990f61a478ed8c1';
const ITEMS_SHA = '388f200246a7fcc0f10ed9c1bb97952f9046e69c1be3b14ebae5855822cec831';
const ASYNC_SEARCH_SHA = '19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e';
const PLACEHOLDER_POSTAL = '00000';

async function main() {
  const context = await launchPersistentStealthContext({
    profileName: SLUG,
    headless: process.env.HEADFUL !== '1',
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Catch the real zoneId and postalCode off any call the page makes, rather
  // than hard-coding what phase two happened to see.
  let observed: { zoneId?: string; postalCode?: string; shopId?: string } = {};
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/graphql')) return;
    try {
      const raw = new URL(url).searchParams.get('variables');
      if (!raw) return;
      const v = JSON.parse(raw);
      if (v.zoneId && !observed.zoneId) observed.zoneId = String(v.zoneId);
      if (v.postalCode && !observed.postalCode) observed.postalCode = String(v.postalCode);
      if (v.shopId && !observed.shopId) observed.shopId = String(v.shopId);
    } catch { /* not every call carries them */ }
  });

  await page.goto(`https://www.instacart.com/store/${SLUG}/s?k=${encodeURIComponent(TERM)}`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  await page.waitForTimeout(9000);

  console.log('\nobserved from the storefront:', JSON.stringify(observed));

  // esbuild's keep-names helper does not exist inside the page; see the note in
  // probe-instacart-prices.ts. Passed as a string so it cannot be transformed.
  await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; }');

  const out = await page.evaluate(async (cfg) => {
    const gql = async (operationName: string, sha256Hash: string, variables: unknown) => {
      const t0 = Date.now();
      const res = await fetch('/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash } } }),
      });
      const text = await res.text();
      try { return { status: res.status, ms: Date.now() - t0, json: JSON.parse(text) as any }; }
      catch { return { status: res.status, ms: Date.now() - t0, raw: text.slice(0, 200) }; }
    };

    const shopId = cfg.shopId!;
    // The zone the rail computes today, straight out of an item id.
    const asyncRes = await gql('AsyncItemSearch', cfg.asyncSha, {
      query: cfg.term, shopId, postalCode: cfg.placeholder, searchSource: 'search',
    });
    let railZone: string | null = null;
    let ids: string[] = [];
    try {
      ids = (asyncRes as any).json.data.itemSearch.itemResultList.itemIds ?? [];
      const f = String(ids[0] ?? '');
      const us = f.indexOf('_'); const dash = f.indexOf('-');
      if (us >= 0 && dash > us) railZone = f.slice(us + 1, dash);
    } catch { /* reported as null */ }

    const priceOf = (r: any) => {
      let items: any[] = [];
      try { items = r.json.data.searchResults.primaryItemResultList.items ?? []; } catch { items = []; }
      return {
        status: r.status, ms: r.ms,
        itemCount: items.length,
        priceErrors: (r.json?.errors ?? []).filter((e: any) => String(e.path?.slice(-1)[0]) === 'price').length,
        totalErrors: r.json?.errors?.length ?? 0,
        prices: items.slice(0, 4).map((it: any) => it.viewSection?.priceString ?? it.price?.viewSection?.priceString ?? null),
      };
    };

    // ONE VARIABLE AT A TIME.
    const searchTrials: Record<string, unknown> = {};
    const combos: Array<[string, string | null, string]> = [
      ['railZone + placeholder postal (what ships today)', railZone, cfg.placeholder],
      ['realZone + placeholder postal', cfg.realZone, cfg.placeholder],
      ['railZone + real postal', railZone, cfg.realPostal],
      ['realZone + real postal (what the page sends)', cfg.realZone, cfg.realPostal],
    ];
    for (const [label, zone, postal] of combos) {
      if (!zone) { searchTrials[label] = { skipped: 'no zone' }; continue; }
      searchTrials[label] = priceOf(await gql('Search', cfg.searchSha, {
        query: cfg.term, shopId, zoneId: zone, postalCode: postal,
      }));
    }

    // And the operation the page actually uses for prices, with the full ids.
    const fullIds = ids.slice(0, 4).map(String);
    const itemsTrials: Record<string, unknown> = {};
    for (const [label, zone, postal] of combos) {
      if (!zone) { itemsTrials[label] = { skipped: 'no zone' }; continue; }
      const r: any = await gql('Items', cfg.itemsSha, { ids: fullIds, shopId, zoneId: zone, postalCode: postal });
      const list = r.json?.data?.items ?? null;
      itemsTrials[label] = {
        status: r.status, ms: r.ms,
        dataKeys: r.json?.data ? Object.keys(r.json.data) : null,
        count: Array.isArray(list) ? list.length : null,
        errors: (r.json?.errors ?? []).slice(0, 2).map((e: any) => String(e.message).slice(0, 80)),
        prices: Array.isArray(list)
          ? list.slice(0, 4).map((it: any) => it?.viewSection?.priceString ?? it?.price?.viewSection?.priceString ?? null)
          : null,
        firstItemPriceKeys: Array.isArray(list) && list[0]?.price ? Object.keys(list[0].price) : null,
      };
    }

    return { shopId, railZone, realZone: cfg.realZone, idsSample: fullIds, searchTrials, itemsTrials };
  }, {
    term: TERM, placeholder: PLACEHOLDER_POSTAL,
    shopId: observed.shopId ?? null,
    realZone: observed.zoneId ?? null,
    realPostal: observed.postalCode ?? PLACEHOLDER_POSTAL,
    searchSha: SEARCH_SHA, itemsSha: ITEMS_SHA, asyncSha: ASYNC_SEARCH_SHA,
  });

  console.log('\n══════════ MEAL-235 phase three ══════════');
  console.log(JSON.stringify(out, null, 2));
  console.log('══════════════════════════════════════════\n');
  await context.close();
}

main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
