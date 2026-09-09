/**
 * MEAL-235, phase two. WHICH request fills the price the storefront renders?
 *
 * Phase one (`probe-instacart-prices.ts`) established two things by measurement:
 *
 *   - `ItemPricesQuery` is reachable and answers 200 with `itemPrices: []` for
 *     every id space a search item carries (`id`, `productId`, `legacyId`,
 *     `legacyV3Id`). The composite `items_23898-...` id 404s with "Not Found",
 *     which is the same error `Search` returns on its own price field.
 *   - The storefront renders prices to this exact session anyway. So they are
 *     not withheld from us; we are asking for them wrongly.
 *
 * Which makes this the only question left, and guessing at it is what has
 * already cost two afternoons. So rather than guess: drive the storefront the
 * way a person does, record every GraphQL call it makes, and report which
 * responses actually contain money — with the operation name, the persisted
 * hash and the variables that produced them.
 *
 *   npx tsx tests/fixture-runners/probe-instacart-price-op.ts
 *
 * HEADFUL=1 to watch. Read-only: it searches and scrolls, and adds nothing to
 * any cart.
 */

import { launchPersistentStealthContext } from '../_shared/launch-stealth';

const SLUG = 'aldi';
const TERM = 'sour cream';

/** A response body that mentions money in a shape a price would take. */
const MONEY = /"\$\d+\.\d{2}"|"priceString":|"unitPrice"|"amount":\s*\d/;

interface Seen {
  operationName: string;
  sha: string | null;
  variableKeys: string[];
  variables: unknown;
  status: number;
  bytes: number;
  money: boolean;
  moneySample: string[];
}

async function main() {
  const context = await launchPersistentStealthContext({
    profileName: SLUG,
    headless: process.env.HEADFUL !== '1',
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const seen: Seen[] = [];

  page.on('response', async (res) => {
    const req = res.request();
    const url = res.url();
    // EVERY request, not just /graphql. Phase two's first run watched /graphql
    // alone, saw two calls, and still found prices on the page — which only
    // means the prices came from somewhere else. Asking narrowly is how the
    // last two afternoons were spent.
    if (!/^https?:/.test(url)) return;
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') return;

    // THE OPERATION IS IN THE QUERY STRING, not the body. Instacart sends its
    // persisted queries as GET /graphql?operationName=..&variables=..&extensions=..
    // — the first pass here read `postData()` only, saw two POSTs, and concluded
    // the prices did not arrive over graphql at all. They arrive over 30 GETs.
    let payload: any = null;
    if (req.method() === 'POST') {
      try { payload = JSON.parse(req.postData() ?? 'null'); } catch { payload = null; }
    } else if (url.includes('/graphql')) {
      try {
        const qs = new URL(url).searchParams;
        payload = {
          operationName: qs.get('operationName'),
          variables: qs.get('variables') ? JSON.parse(qs.get('variables')!) : null,
          extensions: qs.get('extensions') ? JSON.parse(qs.get('extensions')!) : null,
        };
      } catch { payload = null; }
    }
    const ops = Array.isArray(payload) ? payload : [payload ?? {}];

    let body = '';
    try { body = await res.text(); } catch { return; }

    const money = MONEY.test(body);
    const moneySample = money
      ? Array.from(new Set(body.match(/"\$\d+\.\d{2}"/g) ?? [])).slice(0, 6)
      : [];

    for (const op of ops) {
      seen.push({
        operationName: op?.operationName ?? `${req.method()} ${new URL(url).pathname.slice(0, 70)}`,
        sha: op?.extensions?.persistedQuery?.sha256Hash ?? null,
        variableKeys: op?.variables ? Object.keys(op.variables) : [],
        variables: op?.variables ?? null,
        status: res.status(),
        bytes: body.length,
        money,
        moneySample,
      });
    }
  });

  // Drive it the way a person does: land on the storefront, search, let the
  // results render. Every price the page shows had to arrive in one of these.
  await page.goto(`https://www.instacart.com/store/${SLUG}/storefront`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  await page.waitForTimeout(4000);

  await page.goto(
    `https://www.instacart.com/store/${SLUG}/s?k=${encodeURIComponent(TERM)}`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );
  // Long enough for the lazy price calls the item tiles fire as they mount.
  await page.waitForTimeout(8000);
  // scrollBy rather than mouse.wheel: the stealth context is mobile WebKit,
  // which has no wheel. The point is only to mount the tiles below the fold, and
  // those fire their own price calls on mount either way.
  await page.evaluate('window.scrollBy(0, 2000)');
  await page.waitForTimeout(5000);

  const rendered = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    return (text.match(/\$\d+\.\d{2}/g) ?? []).slice(0, 10);
  });

  console.log('\n══════════ MEAL-235 phase two ══════════');
  console.log(`prices rendered on the page: ${JSON.stringify(rendered)}`);
  console.log(`graphql operations observed: ${seen.length}\n`);

  const withMoney = seen.filter((s) => s.money);
  const without = seen.filter((s) => !s.money);

  console.log('── operations whose RESPONSE carried money ──');
  if (!withMoney.length) console.log('  (none — the prices did not arrive over /graphql)');
  for (const s of withMoney) {
    console.log(`  ${s.operationName}`);
    console.log(`    sha        ${s.sha}`);
    console.log(`    variables  ${JSON.stringify(s.variables)?.slice(0, 260)}`);
    console.log(`    sample     ${s.moneySample.join(' ')}`);
    console.log(`    ${s.status}, ${s.bytes} bytes`);
  }

  console.log('\n── every operation seen, for the record ──');
  const tally = new Map<string, number>();
  for (const s of seen) tally.set(s.operationName, (tally.get(s.operationName) ?? 0) + 1);
  for (const [name, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    const any = seen.find((s) => s.operationName === name)!;
    console.log(`  ${String(n).padStart(3)}x ${name}${any.money ? '   <-- MONEY' : ''}  [${any.variableKeys.join(', ')}]`);
  }
  console.log(`\n(${without.length} carried none)`);
  console.log('════════════════════════════════════════\n');

  await context.close();
}

main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
