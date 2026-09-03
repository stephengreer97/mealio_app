// Which store gets a network rail, and what it speaks.
//
// This resolver is now load-bearing in three places — the prewarm probe, the
// in-run login check, and the search/add strategy — so "does this store have a
// rail" decides whether login is answered over the network or read off the DOM.
// A store silently losing its rail here would not fail loudly; it would quietly
// go back to the markup heuristic this work exists to stop trusting.

import { INSTACART_TENANTS } from '../../src/lib/webview-scripts/instacart';
import { railConfigKey, getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../../src/lib/webview-scripts/network-rail';
import { ALBERTSONS_FAMILY_IDS } from '../../src/lib/webview-scripts/albertsons';

describe('network rail resolution', () => {
  it('gives H-E-B a rail that speaks its own session message', () => {
    const rail = getNetworkRail('heb');
    expect(rail).not.toBeNull();
    expect(rail!.sessionMessageType).toBe('HEB_SESSION');
  });

  it('gives every Albertsons banner the same rail, not just albertsons itself', () => {
    // The family shares one storefront surface, so a rail for `albertsons` that
    // did not cover `safeway` would leave most of the family on the DOM path.
    expect(ALBERTSONS_FAMILY_IDS.length).toBeGreaterThan(1);
    for (const id of ALBERTSONS_FAMILY_IDS) {
      const rail = getNetworkRail(id);
      expect(rail).not.toBeNull();
      expect(rail!.sessionMessageType).toBe('ALB_SESSION');
    }
  });

  it('gives every Instacart tenant the same rail, by platform not by name', () => {
    // ALDI is not named anywhere in getNetworkRail. The rail is registered
    // against the PLATFORM, so a tenant added to INSTACART_TENANTS gets it
    // without another line here — the same reasoning that gives the fifteen
    // Albertsons banners one rail.
    for (const id of Object.keys(INSTACART_TENANTS)) {
      const rail = getNetworkRail(id);
      expect(rail).not.toBeNull();
      expect(rail!.sessionMessageType).toBe('ALDI_SESSION');
    }
  });

  it('gives no rail to a store that has none, so those keep the page path', () => {
    for (const id of ['walmart', 'wegmans', 'amazon', 'kroger', 'nonsense']) {
      expect(getNetworkRail(id)).toBeNull();
    }
    expect(getNetworkRail(null)).toBeNull();
    expect(getNetworkRail(undefined)).toBeNull();
    expect(getNetworkRail('')).toBeNull();
  });

  it('lists every rail session type, or the engine drops answers on the floor', () => {
    // The message dispatcher matches on this list. A rail whose type is missing
    // posts an answer nobody reads, and the run hangs to its timeout.
    const types = new Set(NETWORK_SESSION_MESSAGE_TYPES);
    expect(types.has('HEB_SESSION')).toBe(true);
    expect(types.has('ALB_SESSION')).toBe(true);
    for (const id of ['heb', ...ALBERTSONS_FAMILY_IDS]) {
      expect(types.has(getNetworkRail(id)!.sessionMessageType)).toBe(true);
    }
  });

  it('builds a session script for each rail', () => {
    for (const id of ['heb', 'albertsons']) {
      const src = getNetworkRail(id)!.sessionScript();
      expect(typeof src).toBe('string');
      expect(src.length).toBeGreaterThan(100);
      // Injected scripts must end truthy or react-native-webview warns.
      expect(src.trimEnd().endsWith('true;')).toBe(true);
    }
  });

  it('refuses an Albertsons add with no writable item, rather than sending an empty write', () => {
    const rail = getNetworkRail('albertsons')!;
    expect(rail.addBatch([])).toBeNull();
  });

  it('drops H-E-B items with no sku, because a line there is addressed by sku', () => {
    const rail = getNetworkRail('heb')!;
    const noSku = rail.addBatch([{ idx: 0, productId: 'p', quantity: 1, name: 'x' }]);
    expect(noSku).toBeNull();
    // Albertsons addresses by itemId alone, so the same item IS writable there.
    expect(getNetworkRail('albertsons')!.addBatch([
      { idx: 0, productId: 'p', quantity: 1, name: 'x' },
    ])).not.toBeNull();
  });
});

describe('writability is the store\'s rule, not a shared one', () => {
  // MEASURED 2026-09-02: the matcher required BOTH a productId and a skuId, so
  // every Albertsons run ended "nothing matched exactly" -- with every term
  // answered, thirty candidates for one of them, and the right product in the
  // list. Albertsons addresses a cart line by product id and its search returns
  // no sku at all, so the rail could never have added anything.
  it('H-E-B needs a sku, because that is how it addresses a cart line', () => {
    const heb = getNetworkRail('heb')!;
    expect(heb.writable({ productId: 'p1', skuId: 's1' })).toBe(true);
    expect(heb.writable({ productId: 'p1', skuId: null })).toBe(false);
    expect(heb.writable({ productId: null, skuId: 's1' })).toBe(false);
  });

  it('Albertsons needs only the product id', () => {
    const alb = getNetworkRail('albertsons')!;
    expect(alb.writable({ productId: 'p1', skuId: null })).toBe(true);
    expect(alb.writable({ productId: null, skuId: null })).toBe(false);
  });

  it('every rail answers the question', () => {
    for (const id of ['heb', 'albertsons', 'safeway', 'vons']) {
      const rail = getNetworkRail(id);
      if (!rail) continue;
      expect(typeof rail.writable).toBe('function');
    }
  });
});

describe('railConfigKey', () => {
  // The Albertsons family is fifteen banners on one platform, and its config —
  // selectors, kill switch, networkSearch/networkAdd — is stored ONCE under
  // 'albertsons'. albertsons.ts always resolved it that way; the cart engine did
  // not, so it read stores['safeway'], found nothing, and decided Safeway had no
  // rail. Every banner but the one literally named 'albertsons' fell through to
  // the page path, and after the DOM removal would have fallen through to
  // assisted — a silent downgrade for fourteen stores.
  it('folds every Albertsons banner onto the family key', () => {
    for (const id of ALBERTSONS_FAMILY_IDS) {
      expect(railConfigKey(id)).toBe('albertsons');
    }
    // Including the one that already matched, so the rule has no special case.
    expect(railConfigKey('albertsons')).toBe('albertsons');
  });

  it('leaves every other store alone', () => {
    expect(railConfigKey('heb')).toBe('heb');
    expect(railConfigKey('walmart')).toBe('walmart');
  });

  it('is total — a missing store id is not a crash', () => {
    expect(railConfigKey(null)).toBe('');
    expect(railConfigKey(undefined)).toBe('');
  });

  it('covers a banner that HAS a rail, which is what makes this load-bearing', () => {
    // If a banner ever stopped resolving a rail, the key would not matter.
    expect(getNetworkRail('safeway')).not.toBeNull();
  });
});

describe('a saved product must be writable at the store that saved it', () => {
  // The two stores address a cart line differently, and a saved product that
  // omitted what its own store needs would be unusable — the row would skip the
  // search and then fail the write, every run, silently.
  it('H-E-B needs the sku it saved', () => {
    const heb = getNetworkRail('heb')!;
    expect(heb.writable({ productId: 'p1', skuId: 's1' })).toBe(true);
    // What a saved product WITHOUT a sku would look like at H-E-B.
    expect(heb.writable({ productId: 'p1', skuId: null })).toBe(false);
  });

  it('Albertsons needs only the product id, and never has a sku to save', () => {
    const alb = getNetworkRail('albertsons')!;
    expect(alb.writable({ productId: 'p1', skuId: null })).toBe(true);
  });
});
