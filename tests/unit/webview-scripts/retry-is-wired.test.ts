// The policy is worth nothing if a rail does not go through it.
//
// [[measure-the-feature-not-the-function]]: retry.test.ts proves the rule is
// right by calling it directly, which is exactly the kind of proof that shipped
// MEAL-28 to two stores out of six. This file reads the script each rail
// actually injects and checks the transport is wrapped there.
import { getNetworkRail } from '../../../src/lib/webview-scripts/network-rail';
import { RETRY_FN } from '../../../src/lib/webview-scripts/_retry';

/**
 * The script with the helper's own text removed.
 *
 * RETRY_FN contains `__mealioRetry(function (attempt)` inside __mealioFetchRetry,
 * so a bare search for a call matches the helper itself and passes on a rail
 * that never calls it. Measured: unwrapping Walmart's transport changed nothing
 * and all sixteen tests stayed green.
 */
const railOwnCode = (s: string) => s.split(RETRY_FN).join('');

/** One id per rail, so a family is checked once rather than fifteen times. */
const RAILS = ['heb', 'albertsons', 'aldi', 'wegmans', 'walmart'];

/** Every script a rail can inject, with a name for the failure message. */
function scriptsFor(storeId: string): Array<[string, string]> {
  const rail = getNetworkRail(storeId);
  if (!rail) throw new Error('no rail for ' + storeId);
  // NOT the rail key. NetworkSession.storeId is the store NUMBER, and two rails
  // refuse anything non-numeric -- so passing 'albertsons' here made searchBatch
  // return null and the search script, the most-used one of the four, was
  // silently never checked for H-E-B or Albertsons.
  const cfg = { storeId: '161', shoppingContext: 'pickup' } as any;
  const out: Array<[string, string]> = [];
  const push = (label: string, s: string | null | undefined) => {
    if (typeof s === 'string' && s.length) out.push([label, s]);
  };
  push('session', rail.sessionScript());
  push('searchBatch', rail.searchBatch(['milk'], cfg));
  push('cartRead', rail.cartRead());
  push('addBatch', rail.addBatch(
    [{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'Milk' }], {}));
  // All four, every rail. A try/catch here, or a builder quietly returning
  // null, turns "this rail retries" into "this rail has at most four scripts
  // and the ones that built are fine".
  expect(out.map(([l]) => l)).toEqual(['session', 'searchBatch', 'cartRead', 'addBatch']);
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

  it.each(RAILS)('%s never calls a one-attempt function directly', (storeId) => {
    // THE INVARIANT, and it took four mutants to find the right one.
    //
    // "The script contains a call to __mealioRetry" is too coarse: a rail's
    // scripts share chunks, so Albertsons' SEARCH script carries the cart
    // read's wrapped call and passed while its own search was unwrapped. What
    // actually has to hold is narrower and exact -- a function that makes ONE
    // attempt is reached through the policy and never on its own.
    //
    // The `Attempt` suffix is what makes that checkable, and it is not
    // decoration: the first version keyed on `Once` and matched WM.searchOnce,
    // which is Walmart's "search one term" and has nothing to do with retries.
    let defined = 0;
    for (const [label, script] of scriptsFor(storeId)) {
      const own = railOwnCode(script);
      const names = new Set(
        [...own.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[\w$]+)?Attempt)\b/g)].map((m) => m[1]),
      );
      defined += names.size;
      for (const name of names) {
        const calls = own.split('\n').filter(
          (l) => l.includes(name + '(') && !/(?:async\s+)?function\s|=\s*(?:async\s*)?function/.test(l),
        );
        for (const line of calls) {
          expect(`${storeId}/${label} ${name}: ${line.trim()}`)
            .toMatch(/__mealio(Fetch)?Retry\(/);
        }
      }
    }
    // A rail with none at all would pass the loop above vacuously.
    expect(`${storeId} wraps a transport: ${defined > 0}`).toBe(`${storeId} wraps a transport: true`);
  });

  it.each(RAILS)('%s leaves no unresolved interpolation behind', (storeId) => {
    for (const [label, s] of scriptsFor(storeId)) {
      expect(`${storeId}/${label}`).toBe(s.includes('${') ? '' : `${storeId}/${label}`);
    }
  });
});
