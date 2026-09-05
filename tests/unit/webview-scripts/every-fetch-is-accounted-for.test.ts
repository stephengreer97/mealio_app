// EVERY REQUEST A RAIL MAKES IS EITHER RETRIED OR ON THIS LIST.
//
// The wiring test next door proves that a one-attempt function is only reached
// through the policy. It cannot prove there are no OTHER requests, and there
// were: wrapping the transports left Wegmans' search (Algolia, not the commerce
// API) and Walmart's search (its own URL, not WM.gql) one-shot, on two stores,
// on the hottest path there is. Neither showed up until the emitted scripts
// were read and every `fetch(` in them counted.
//
// So the invariant is the whole set, not the wrapped part of it. A new request
// added to any rail fails this test until someone decides which side it is on,
// which is the entire point -- the failure mode being guarded against is a
// request nobody thought about, and a test of the wrapped ones cannot see those.
import { getNetworkRail } from '../../../src/lib/webview-scripts/network-rail';
import { RETRY_FN } from '../../../src/lib/webview-scripts/_retry';

const RAILS = ['heb', 'albertsons', 'aldi', 'wegmans', 'walmart'];

/**
 * Requests deliberately left un-retried, and why.
 *
 * Every one of these is session or catalogue BOOTSTRAP, and every one already
 * has a recovery that a request-level retry would duplicate: they cache, they
 * try several candidates, or their failure surfaces as a session failure, which
 * the run-level retry in lib/handover.ts reruns wholesale.
 *
 * Nothing on the search or add path belongs here.
 */
const UNRETRIED: Record<string, string> = {
  // Session bootstrap. A failure lands as `not_hydrated` and fails the session,
  // which the run-level retry reruns.
  __albFetchUserInfo: 'albertsons session bootstrap; run-level retry covers it',
  // Already a ladder: it walks a list of key candidates itself.
  __albEnsureKeys: 'albertsons key ladder; its own redundancy',
  // Already a ladder: it walks several operation-manifest URLs.
  'IC.harvestOps': 'instacart op-hash manifest; tries several URLs itself',
  // Has a page-read fallback.
  'IC.fetchShopId': 'instacart shop id; falls back to the document',
  // Both cache in localStorage and fall back.
  'WG.storeKey': 'wegmans store lookup; cached, with a fallback',
  'WG.tokenEndpoint': 'wegmans endpoint discovery; cached for a week',
  // A failed refresh surfaces as `unauthorised`, which the session repair
  // already re-asks every 2s for 30s.
  'WG.refresh': 'wegmans token refresh; the session repair re-asks it',
};

/** The rail's own code, with the shared helper's text removed. */
function railCode(storeId: string): string {
  const rail = getNetworkRail(storeId)!;
  const cfg = { storeId: '161', shoppingContext: 'pickup' } as never;
  return [
    rail.sessionScript(),
    rail.searchBatch(['milk'], cfg)!,
    rail.cartRead(),
    rail.addBatch([{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'Milk' }], {})!,
  ].join('\n').split(RETRY_FN).join('');
}

/** Every `fetch(` site, named by the function it sits in. */
function fetchSites(storeId: string): string[] {
  const lines = railCode(storeId).split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!/[^\w.]fetch\(/.test(line)) return;
    let fn = '(top level)';
    for (let j = i; j >= 0 && i - j < 200; j--) {
      const m = lines[j].match(/(?:function\s+([\w$]+)|([\w$.]+)\s*=\s*(?:async\s*)?function)/);
      if (m) { fn = m[1] || m[2]; break; }
    }
    // Behind the policy either by being inside a one-attempt function, or by
    // sitting in a __mealioFetchRetry closure.
    const ctx = lines.slice(Math.max(0, i - 40), i + 1).join('\n');
    if (/Attempt\b/.test(fn) || /__mealioFetchRetry\(/.test(ctx)) return;
    out.push(fn);
  });
  return [...new Set(out)];
}

describe('every request a rail makes is accounted for', () => {
  it.each(RAILS)('%s has no unaccounted-for request', (storeId) => {
    const unaccounted = fetchSites(storeId).filter((fn) => !(fn in UNRETRIED));
    expect(`${storeId}: ${unaccounted.join(', ')}`).toBe(`${storeId}: `);
  });

  it('finds requests at all, so a broken scan cannot pass everything', () => {
    // If railCode or the fetch regex stopped matching, every rail above would
    // pass with an empty list and the whole file would be decoration.
    const total = RAILS.reduce(
      (n, id) => n + (railCode(id).match(/[^\w.]fetch\(/g) || []).length, 0);
    expect(total).toBeGreaterThan(12);
  });

  it('keeps the allowlist honest', () => {
    // An entry nobody hits any more is a claim about code that no longer
    // exists, which is how a list like this rots into permission for anything.
    const live = new Set(RAILS.flatMap(fetchSites));
    expect([...Object.keys(UNRETRIED)].filter((k) => !live.has(k))).toEqual([]);
  });
});
