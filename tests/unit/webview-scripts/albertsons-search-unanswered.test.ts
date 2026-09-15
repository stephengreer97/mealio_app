// WHEN ALBERTSONS' SEARCH IS NOT BEING SERVED, STOP ASKING.
//
// Stephen, 2026-09-14: "Albertsons still takes an extremely long time. It also
// does not show any progress in the frame sequence for a long time, then shows
// progress in a burst."
//
// From his 2026-09-13 log, one run, 92 seconds:
//
//   store        op             outcome        n
//   albertsons   cart           ok             5
//   albertsons   cart-write     ok             1
//   albertsons   cart-undo      ok             1
//   albertsons   search:site    NO_RESPONSE    7     <- one at 40s, six at 15s
//   tom_thumb    search:site    ok             4     <- same rail, same quiet page
//
// Eighty-five of those ninety-two seconds were spent asking an endpoint that
// never answered, on a document that was reading and writing its cart in under a
// second and a half. The animation is driven by items settling, so it sat on one
// frame for 55 seconds and then jumped five -- the burst he describes is the
// hang, not the animation.
//
// Reproduced on the Pixel 2026-09-14, signed in, one term:
//
//   22:04:26.565  search:site   sent
//   22:05:06.594  search:site   no_response after 40.0s
//   22:05:06.750  search:plain  HTTP 401 after 151ms
//
// That pair is the whole signal. A timeout alone is ambiguous and the 40s cold
// budget exists because a slow first request HAS paid off before; a timeout plus
// a real HTTP reply from the other shape is not ambiguous at all.
import { ALB_SEARCH_UNSERVED_FN } from '../../../src/lib/webview-scripts/albertsons-network';
import { getNetworkRail } from '../../../src/lib/webview-scripts/network-rail';

/** The predicate exactly as it ships, evaluated. */
function deadFn(): (firstWhy: unknown, got: Record<string, unknown>) => boolean {
  return new Function(ALB_SEARCH_UNSERVED_FN + '\nreturn __albSearchUnserved;')() as never;
}

/** THROUGH THE RAIL, so the budgets asserted below are the ones that ship.
 *  Built directly, the script takes its own 15s defaults and a test on the 40s
 *  cold budget passes against a number no run ever uses. */
const script = () =>
  getNetworkRail('albertsons')!.searchBatch(
    ['milk', 'eggs', 'bread'], { storeId: '161', shoppingContext: 'pickup' },
  )!;

describe('the signal that says the endpoint is not serving us', () => {
  const dead = deadFn();

  it('latches on the measured pair: one shape hung, the other answered', () => {
    // The Pixel run above, exactly.
    expect(dead('no_response', { why: 'http', status: 401 })).toBe(true);
  });

  it.each([500, 403, 404, 429, 200])('any real status counts, including %s', (status) => {
    // What matters is that the connection carried a reply, not which one.
    expect(dead('no_response', { why: 'http', status })).toBe(true);
  });

  it('does NOT latch when the fallback timed out too', () => {
    // Both shapes silent IS a bad minute, and the run should keep asking -- this
    // is the case the 40s cold budget was measured for.
    expect(dead('no_response', { why: 'no_response' })).toBe(false);
  });

  it('does NOT latch when the first shape answered and was merely refused', () => {
    // A 400 ladder is the ordinary variant fallback, not a dead endpoint.
    expect(dead('http', { why: 'http', status: 400 })).toBe(false);
    expect(dead('search_error', { why: 'http', status: 401 })).toBe(false);
  });

  it('does NOT latch on a status-less failure', () => {
    // `status: null` is how a dead connection reports, and that is a bad minute.
    expect(dead('no_response', { why: 'http', status: null })).toBe(false);
    expect(dead('no_response', { why: 'unparseable' })).toBe(false);
  });
});

describe('the batch the rail emits', () => {
  it('ships the predicate rather than a second copy of the rule', () => {
    expect(script()).toContain('function __albSearchUnserved(');
  });

  it('shortens the wait rather than skipping the term', () => {
    // THE CORRECTNESS LINE. A skipped term is an ingredient that never reaches
    // the cart, and this endpoint recovers mid-run -- so the latch may only ever
    // change the budget, never whether the request is made.
    const s = script();
    expect(s).toContain('var budget = A.searchUnserved');
    expect(s).toContain('setTimeout(function () { ctl.abort(); }, budget)');
    // Nothing between entering the term and issuing its request reads the latch
    // to bail out of it.
    const one = s.slice(s.indexOf('async function one(term)'));
    const request = one.indexOf('var got = await attempt(term, first)');
    expect(request).toBeGreaterThan(-1);
    expect(one.slice(0, request)).not.toContain('A.searchUnserved');
  });

  it('spends the short budget only after the store has shown its hand', () => {
    // Every term before that still gets the full budget, because a store that is
    // merely slow has answered inside it before.
    const s = script();
    expect(s).toContain('A.searchedOnce ? 15000 : 40000');
    expect(s).toContain('? 3000');
  });

  it('clears the latch when a new run reads the session', () => {
    // It lives on the shared window object so the batches of ONE run stop
    // re-proving the same thing. Without a reset, a document that hung once
    // would carry the short budget for as long as the WebView lived.
    const { buildAlbertsonsSessionScript } = require('../../../src/lib/webview-scripts/albertsons-network');
    expect(buildAlbertsonsSessionScript()).toContain('A.searchUnserved = false');
  });
});
