// The policy is worth nothing if a rail does not go through it.
//
// [[measure-the-feature-not-the-function]]: retry.test.ts proves the rule is
// right by calling it directly, which is exactly the kind of proof that shipped
// MEAL-28 to two stores out of six. This file reads the script each rail
// actually injects and checks the transport is wrapped there.
import { getNetworkRail } from '../../../src/lib/webview-scripts/network-rail';

/** One id per rail, so a family is checked once rather than fifteen times. */
const RAILS = ['heb', 'albertsons', 'aldi', 'wegmans', 'walmart'];

/** Every script a rail can inject, with a name for the failure message. */
function scriptsFor(storeId: string): Array<[string, string]> {
  const rail = getNetworkRail(storeId);
  if (!rail) throw new Error('no rail for ' + storeId);
  const cfg = {
    storeId, shoppingContext: 'pickup', storeNumber: '1', shopId: '1', token: 't',
    fulfillmentStoreId: '1', serviceType: 'DUG', addressId: '1',
  } as any;
  const out: Array<[string, string]> = [];
  const push = (label: string, s: string | null | undefined) => {
    if (typeof s === 'string' && s.length) out.push([label, s]);
  };
  push('session', rail.sessionScript());
  try { push('searchBatch', rail.searchBatch(['milk'], cfg)); } catch { /* needs more cfg */ }
  try { push('cartRead', rail.cartRead()); } catch { /* not every rail has one */ }
  try {
    push('addBatch', rail.addBatch(
      [{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'Milk' }], {}));
  } catch { /* needs more cfg */ }
  return out;
}

describe('every rail sends its requests through the retry policy', () => {
  it('has rails to check', () => {
    expect(RAILS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(RAILS)('%s injects the helper', (storeId) => {
    const scripts = scriptsFor(storeId);
    expect(scripts.length).toBeGreaterThan(0);
    for (const [label, s] of scripts) {
      expect(`${storeId}/${label}: ${s.includes('function __mealioRetry(')}`)
        .toBe(`${storeId}/${label}: true`);
    }
  });

  it.each(RAILS)('%s calls it rather than just carrying it', (storeId) => {
    // The helper being present proves the prelude landed. Something has to
    // CALL it, or the transport is still one-shot with dead code beside it.
    const scripts = scriptsFor(storeId);
    const calls = scripts.filter(([, s]) => /__mealioRetry\(function/.test(s));
    expect(calls.length).toBe(scripts.length);
  });

  it.each(RAILS)('%s leaves no unresolved interpolation behind', (storeId) => {
    for (const [label, s] of scriptsFor(storeId)) {
      expect(`${storeId}/${label}`).toBe(s.includes('${') ? '' : `${storeId}/${label}`);
    }
  });
});
