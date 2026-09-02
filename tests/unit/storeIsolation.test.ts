// Store differences belong on the rail, not in the engine.
//
// Stephen, 2026-09-02: "I think the changes we are making as we do each store is
// breaking the others. I want more isolation between stores code."
//
// He is right, and the failure this week was not a missing abstraction — it was
// one store's rule written as if it were everyone's:
//
//   • the matcher required a productId AND a skuId. That is how H-E-B addresses
//     a cart line. Albertsons addresses by product id and its search returns no
//     sku at all, so no Albertsons product could ever match — with every search
//     answered and the right product in the list.
//   • the landing page was one storeUrl for everybody. H-E-B's storefront
//     homepage navigates out from under an in-flight request; Albertsons' does
//     too. Both now name their own quiet page.
//
// Neither showed up as `storeId === 'heb'`. Both were universal-looking code
// carrying one store's assumption, which is what these tests are for.

import { getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../../src/lib/webview-scripts/network-rail';
import { getStoreScripts } from '../../src/lib/webview-scripts';
import { ALBERTSONS_FAMILY_IDS } from '../../src/lib/webview-scripts/albertsons';
import * as fs from 'fs';
import * as path from 'path';

const RAIL_STORES = ['heb', ...ALBERTSONS_FAMILY_IDS];

describe('every rail answers every question the engine asks', () => {
  // A new store that omits a member does not inherit another store's behaviour
  // by accident — it fails here instead.
  const MEMBERS = [
    'sessionMessageType', 'sessionScript', 'searchBatch',
    'cartRead', 'addBatch', 'writable',
  ] as const;

  for (const id of RAIL_STORES) {
    it(`${id} implements the whole rail`, () => {
      const rail = getNetworkRail(id);
      expect(rail).not.toBeNull();
      for (const m of MEMBERS) expect(rail![m]).toBeDefined();
    });
  }

  it('the stores disagree about writability, and say so themselves', () => {
    // The bug that started this: H-E-B needs a sku, Albertsons does not, and the
    // engine must ask rather than assume.
    expect(getNetworkRail('heb')!.writable({ productId: 'p', skuId: null })).toBe(false);
    expect(getNetworkRail('albertsons')!.writable({ productId: 'p', skuId: null })).toBe(true);
  });

  it('each rail store names its own quiet landing page', () => {
    // The rail needs the origin's cookies and nothing else. Sitting on a
    // storefront homepage means every request shares a renderer with the site's
    // own bundles — and can be cancelled when that page navigates, which is
    // exactly how H-E-B broke.
    for (const id of RAIL_STORES) {
      const scripts = getStoreScripts(id)!;
      expect(scripts.railUrl).toBeTruthy();
      // Same origin as the store, or the session cookies do not apply.
      expect(scripts.railUrl!.startsWith(scripts.storeUrl)).toBe(true);
      expect(scripts.railUrl).not.toBe(scripts.storeUrl);
    }
  });

  it('every rail posts a session message type of its own', () => {
    const types = RAIL_STORES.map((id) => getNetworkRail(id)!.sessionMessageType);
    // Albertsons' fifteen banners share one rail and therefore one type; H-E-B's
    // is its own. Two rails sharing a type would cross their answers.
    expect(new Set(types).size).toBe(2);
    for (const t of types) expect(NETWORK_SESSION_MESSAGE_TYPES).toContain(t);
  });
});

describe('the cart engine does not branch on store id', () => {
  // A count, not a ban: the remaining branches are Amazon Fresh's store-picker,
  // which has no rail and no other home yet. The number is pinned so a new one
  // has to be argued for — the question being "why can the rail not answer
  // this?", which is how `writable` and `railUrl` came to exist.
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/components/WebViewCartSheet.tsx'), 'utf8');

  it('has no per-store branch for any store that HAS a rail', () => {
    const offenders = RAIL_STORES.filter((id) => SRC.includes(`=== '${id}'`));
    expect(offenders).toEqual([]);
  });

  it('holds the line on the stores that still have one', () => {
    const branches = SRC.match(/=== '(heb|albertsons|walmart|amazon|aldi|wegmans|kroger)'/g) ?? [];
    // Amazon Fresh only. If this fails upward, move the difference onto the rail
    // (or the store's scripts) instead of raising the number.
    expect(branches.length).toBeLessThanOrEqual(3);
  });
});
