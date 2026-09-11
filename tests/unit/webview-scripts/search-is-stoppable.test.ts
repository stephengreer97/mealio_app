// EVERY RAIL'S SEARCH BATCH CAN BE STOPPED, AND STOPPING IT LOSES NOTHING.
//
// Stephen, 2026-09-10: "We really need to make sure prewarm does not have a path
// to actually making things worse. The prewarm should be cleanly interruptible
// and that should not add any time. Even if interrupted I still want to be able
// to use the data that it warmed."
//
// The sheet's prewarm runs in the SAME WebView as the run, so it cannot be
// unmounted the way the selection screen's probe can. The run used to stand back
// and wait for it instead, which is prewarm charging the user for existing. It
// stops it now, and the stop only works if every rail's batch actually reads it.
//
// That is a property of the EMITTED SCRIPT, which is why it is tested here
// rather than through the sheet: a rail added later gets no stop unless someone
// wires it, and the sheet's own tests would still pass while the store kept
// searching. Same reasoning as every-fetch-is-accounted-for.test.ts next door.
import { getNetworkRail } from '../../../src/lib/webview-scripts/network-rail';

const RAILS = ['heb', 'albertsons', 'aldi', 'wegmans', 'walmart'];

const SESSION = { storeId: '161', shoppingContext: 'pickup' } as never;

/** The search batch this rail emits for a handful of terms. */
function searchScript(storeId: string): string {
  const rail = getNetworkRail(storeId)!;
  const script = rail.searchBatch(['milk', 'eggs', 'bread', 'butter'], SESSION);
  expect(script).toBeTruthy();
  return script!;
}

describe('a search batch can be stopped where it stands', () => {
  it.each(RAILS)('%s captures the generation it was injected under', (storeId) => {
    // Captured, not read live. A boolean flag would have to be cleared before
    // the run's own requests, and clearing it races the loop that has not read
    // it yet; a generation the script captured at injection cannot be cleared
    // out from under it, and the run's script captures the NEW one.
    expect(searchScript(storeId)).toContain('var MY_GEN = __mealioGen()');
  });

  it.each(RAILS)('%s checks it inside the loop, not only at the top', (storeId) => {
    // At the top it would only ever catch a stop that arrived before the first
    // request, which is the case that needs it least.
    expect(searchScript(storeId)).toContain('__mealioGen() !== MY_GEN');
  });

  it.each(RAILS)('%s ships the stop itself', (storeId) => {
    // __mealioStop lives in RETRY_FN, which every rail's prelude includes. If a
    // rail ever stopped including it, MY_GEN above would be a reference error
    // and the whole batch would die on injection rather than merely not stop.
    const s = searchScript(storeId);
    expect(s).toContain('__mealioRoot.__mealioStop = function');
    expect(s).toContain('__mealioRoot.__mealioNet.gen');
  });

  it('the stop survives being evaluated outside a browser', () => {
    // RETRY_FN is evaluated in Node by retry.test.ts next door, to cross-check
    // the injected policy against the TypeScript one. A bare `window` at the top
    // of it is a ReferenceError there, and the failure is a whole suite that
    // does not run rather than an assertion — which is how it got missed once.
    const { RETRY_FN } = require('../../../src/lib/webview-scripts/_retry');
    const root: Record<string, unknown> = {};
    const run = new Function('window', RETRY_FN + '\nreturn __mealioGen();');
    expect(() => run(root)).not.toThrow();
    expect(run(root)).toBe(0);
    // And it installed the stop on whatever global it was handed.
    expect(typeof (root as { __mealioStop?: unknown }).__mealioStop).toBe('function');
  });

  it.each(RAILS)('%s registers its request controllers so a stop reaches the wire', (storeId) => {
    // The loop check stops the NEXT request. The registry is what cancels the
    // one already out, which on a rail whose per-request budget is 15s is the
    // difference between stopping now and stopping in fifteen seconds.
    expect(searchScript(storeId)).toContain('__mealioTrack(new AbortController())');
  });

  it('every AbortController in every rail is registered, not just the search path', () => {
    // A tracked controller is how a stop is felt. One built by hand somewhere
    // else is a request the stop cannot reach, and the failure is silent: the
    // batch stops issuing, and that one request runs its whole budget out.
    const all = RAILS.flatMap((id) => {
      const rail = getNetworkRail(id)!;
      return [
        rail.sessionScript(id),
        rail.searchBatch(['milk'], SESSION) ?? '',
        rail.cartRead(id),
        rail.addBatch([{ idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'Milk' }], {} as never) ?? '',
      ];
    }).join('\n');

    const total = (all.match(/new AbortController\(\)/g) || []).length;
    const tracked = (all.match(/__mealioTrack\(new AbortController\(\)\)/g) || []).length;
    expect(total).toBeGreaterThan(4);   // a scan that finds nothing must not pass
    expect(tracked).toBe(total);
  });

  it('the stop is not retried into three stops', () => {
    // An aborted request comes back as no_response with aborted true, and
    // _retry.ts refuses to retry those precisely because they spent their whole
    // budget. A stop that got retried would be three requests, not zero.
    const s = searchScript('aldi');
    expect(s).toContain("if (why === 'no_response') return f.aborted === false;");
  });
});
