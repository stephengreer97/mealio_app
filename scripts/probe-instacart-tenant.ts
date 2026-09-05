/**
 * MEAL-220. Is this storefront a tenant the ALDI rail could serve?
 *
 *   npx tsx scripts/probe-instacart-tenant.ts <host> <slug>
 *   npx tsx scripts/probe-instacart-tenant.ts delivery.publix.com publix
 *
 * WHY THIS IS A BROWSER AND NOT A CURL. The first version of this probe fetched
 * the storefront HTML, pulled out every <script src>, and grepped the bundles
 * for the persisted-query manifest. Run against ALDI — the tenant we KNOW works
 * — it found nothing. The manifest is not in the initially-referenced bundles;
 * it arrives in code the page loads at runtime, which is exactly why
 * IC.harvestOps walks `performance.getEntriesByType('resource')` instead of
 * parsing markup.
 *
 * A control that fails means the method is wrong, not the subject. So this runs
 * the real harvest in a real page, and ALDI is checked first every time for
 * precisely that reason: a probe that cannot find ALDI's manifest has proved
 * nothing about anybody else's.
 *
 * SIGNED OUT ON PURPOSE. The manifest is in public bundles, so the question
 * "does this tenant speak the same GraphQL" is answerable without an account —
 * which matters, because the point of the spike is to decide which tenants are
 * worth getting an account for. What it CANNOT answer is whether the session
 * probe, the cart read and the write work; those need a signed-in run and stay
 * on the ticket.
 */
import { chromium } from 'playwright';

const OPS = ['Search', 'AsyncItemSearch', 'ActiveCarts', 'CartItems', 'UpdateCartItemsMutation'];

/** The harvest, as the rail does it: over the page's own loaded resources. */
async function harvest(host: string, slug: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/124.0.0.0 Mobile Safari/537.36',
    viewport: { width: 414, height: 896 },
  });
  try {
    const res = await page.goto(`https://${host}/store/${slug}/storefront`, {
      // `domcontentloaded`, not `networkidle`. These storefronts poll and keep
      // long-lived connections open, so the network is never idle and the wait
      // times out on a page that loaded perfectly — measured against ALDI.
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    const status = res?.status() ?? 0;
    // Give lazily-loaded chunks a moment; the manifest is in one of them.
    await page.waitForTimeout(9_000);

    const found = await page.evaluate(async (ops: string[]) => {
      const urls = performance.getEntriesByType('resource')
        .map((r) => r.name).filter((n) => n.includes('.js'));
      const out: Record<string, string> = {};
      for (const u of urls) {
        if (ops.every((o) => out[o])) break;
        let txt = '';
        try { txt = await (await fetch(u)).text(); } catch { continue; }
        for (const o of ops) {
          if (out[o]) continue;
          const at = txt.indexOf(`"${o}":"`);
          if (at < 0) continue;
          const hash = txt.substr(at + o.length + 4, 64);
          if (/^[0-9a-f]{64}$/.test(hash)) out[o] = hash;
        }
      }
      return { out, bundles: urls.length };
    }, OPS);

    return { status, ...found };
  } finally {
    await browser.close();
  }
}

async function main() {
  const [host, slug] = process.argv.slice(2);
  if (!host || !slug) {
    console.error('usage: probe-instacart-tenant.ts <host> <slug>');
    process.exit(2);
  }

  // THE CONTROL, ALWAYS FIRST.
  const control = await harvest('www.aldi.us', 'aldi');
  const controlFound = OPS.filter((o) => control.out[o]);
  console.log(`control  www.aldi.us/aldi  status=${control.status} bundles=${control.bundles} `
    + `ops=${controlFound.length}/${OPS.length}`);
  for (const o of OPS) console.log(`   ${o.padEnd(24)} ${control.out[o] ? control.out[o].slice(0, 16) + '…' : '—'}`);
  if (controlFound.length === 0) {
    console.error('\nCONTROL FAILED. The probe cannot find the manifest on the tenant we know '
      + 'works, so it can say nothing about any other. Fix the probe, not the tenant.');
    process.exit(1);
  }

  const t = await harvest(host, slug);
  const found = OPS.filter((o) => t.out[o]);
  console.log(`tenant   ${host}/${slug}  status=${t.status} bundles=${t.bundles} `
    + `ops=${found.length}/${OPS.length}`);
  for (const o of OPS) console.log(`   ${o.padEnd(24)} ${t.out[o] ? t.out[o].slice(0, 16) + '…' : '—'}`);

  // The hashes being DIFFERENT is expected and fine — they are per-deploy. What
  // matters is that the operation NAMES exist, because that is what the rail
  // asks for by name and gets a hash for at runtime.
  const missing = OPS.filter((o) => !t.out[o] && control.out[o]);
  console.log(missing.length === 0
    ? '\nEvery operation the control found is present here too.'
    : `\nMissing what the control has: ${missing.join(', ')}`);

  // Are the hashes the SAME as the control's, or merely present?
  //
  // This is the difference between "another tenant we must harvest separately"
  // and "one platform-wide manifest". If they match, a hash learned anywhere is
  // good everywhere, and the per-tenant harvest is only about timing.
  const same = OPS.filter((o) => control.out[o] && control.out[o] === t.out[o]);
  const differ = OPS.filter((o) => control.out[o] && t.out[o] && control.out[o] !== t.out[o]);
  console.log(`hashes: ${same.length} identical to ALDI, ${differ.length} different`);
}

main().catch((e) => { console.error(e); process.exit(1); });
