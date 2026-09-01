// Which store gets a network rail, and what it speaks.
//
// This resolver is now load-bearing in three places — the prewarm probe, the
// in-run login check, and the search/add strategy — so "does this store have a
// rail" decides whether login is answered over the network or read off the DOM.
// A store silently losing its rail here would not fail loudly; it would quietly
// go back to the markup heuristic this work exists to stop trusting.

import { getNetworkRail, NETWORK_SESSION_MESSAGE_TYPES } from '../../src/lib/webview-scripts/network-rail';
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

  it('gives no rail to a store that has none, so those keep the page path', () => {
    for (const id of ['walmart', 'aldi', 'wegmans', 'amazon', 'kroger', 'nonsense']) {
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
