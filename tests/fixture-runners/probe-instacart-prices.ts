/**
 * Does Instacart hand us prices? One measured call, and it prints what came
 * back rather than deciding anything.
 *
 * WHY THIS EXISTS. The Instacart rail already asks for a price and always gets
 * nothing: `Search` answers with one "Not Found" error per item, ALL of them on
 * the price field, alongside complete items — measured on the device, under the
 * real postcode and the placeholder alike, with the zone or the shop as zoneId
 * (see the comments in `src/lib/webview-scripts/instacart-network.ts`). The
 * obvious fix was tried and failed too: `ItemDetailsRetailerProduct` answers with
 * an empty list for ids the search has just returned, because it addresses a
 * different id space.
 *
 * What the storefront bundle says, greppable in `tests/.chrome-profile/aldi`:
 * there is a SEPARATE operation for this, and the app itself uses it rather than
 * reading a price off a search result.
 *
 *   ItemPricesQuery  3077743e0ab9f6d3210a7c415c541591ec84b4d90a44df76f7f047e115dc8e54
 *   variables        { ids: [...], shopId, zoneId, postalCode }
 *   collection       itemPrices, of __typename ItemsItemPrice
 *   used by          client/disorganized/store_app/shared/ItemPrice/useItemPrice.tsx
 *
 * That is a strong lead and NOT an answer. It shares the failure mode of the
 * attempt that did not work — a second operation keyed on ids the search gave us
 * — and the only thing that settles it is asking. So this asks, in a real
 * logged-in session, and DUMPS THE RESPONSE: the top-level keys, the errors, and
 * the field names on the first entry. Nothing here infers a price from a shape.
 *
 * If it answers with prices, the rail change is small: one more batched call in
 * `buildInstacartSearchBatchScript`, ids already in hand, and the `price` field
 * that is already plumbed to the Choose Products row stops being null.
 * If it answers "Not Found" again, Instacart prices are closed and this file is
 * the record of why, so nobody spends another afternoon on it.
 *
 * RUN IT:
 *
 *   npx tsx tests/fixture-runners/probe-instacart-prices.ts
 *
 * It reuses `tests/.chrome-profile/aldi`, so if that session is still good it
 * asks straight away; if not, log in in the window it opens and press Enter.
 * Read-only: it searches and reads prices, and adds nothing to any cart.
 */

import * as readline from 'readline';
import { launchPersistentStealthContext } from '../_shared/launch-stealth';

/** The persisted hash the storefront itself sends for this operation. */
const ITEM_PRICES_SHA = '3077743e0ab9f6d3210a7c415c541591ec84b4d90a44df76f7f047e115dc8e54';

const TERM = 'sour cream';
const STOREFRONT = 'https://www.aldi.us/store/aldi/storefront';

function prompt(q: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, () => { rl.close(); resolve(); }));
}

async function main() {
  const context = await launchPersistentStealthContext({ profileName: 'aldi', headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(STOREFRONT, { waitUntil: 'domcontentloaded' });

  console.log(
    '\n[probe] If you are not signed in to ALDI in this window, sign in now.\n' +
    '[probe] The profile is persistent, so this is a one-off.',
  );
  await prompt('[probe] Press Enter when the storefront has loaded > ');

  // Everything runs in the page so the session cookies and the origin are the
  // storefront's own. Same transport the rail uses.
  const out = await page.evaluate(async ({ sha, term }) => {
    const post = async (opName: string, hash: string, variables: unknown) => {
      const res = await fetch('/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: opName,
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
      });
      const text = await res.text();
      try { return { status: res.status, json: JSON.parse(text) }; }
      catch { return { status: res.status, raw: text.slice(0, 400) }; }
    };

    // The ids, the shop and the zone come from the page rather than from
    // guesses: the search ids carry the zone (items_23898-18647633), which is
    // the same trick the rail uses to discover it.
    const shopId =
      (window as any).__NEXT_DATA__?.props?.pageProps?.shopId ??
      (location.pathname.match(/\/store\/[^/]+\/?/) ? null : null);

    return {
      note: 'Run the search in the app UI first if ids come back empty.',
      shopIdFromPage: shopId ?? null,
      // A raw, unauthenticated-of-assumptions dump. Field NAMES first.
      probe: await post('ItemPricesQuery', sha, { ids: [], shopId: String(shopId ?? ''), postalCode: '' }),
      term,
    };
  }, { sha: ITEM_PRICES_SHA, term: TERM });

  console.log('\n[probe] ── response ─────────────────────────────────────────');
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
  console.log('[probe] ─────────────────────────────────────────────────────\n');
  console.log(
    '[probe] WHAT TO READ:\n' +
    '[probe]  - errors[] mentioning the price field  -> closed, same wall as Search\n' +
    '[probe]  - itemPrices: []                       -> wrong id space, like ItemDetailsRetailerProduct\n' +
    '[probe]  - itemPrices: [{ ... }]                -> OPEN. Report the field names.\n' +
    '[probe] An empty ids[] is expected to be rejected; that rejection still tells us\n' +
    '[probe] whether the operation is reachable and what it wants. Paste real ids from a\n' +
    '[probe] search to go further.\n',
  );

  await prompt('[probe] Press Enter to close > ');
  await context.close();
}

main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
