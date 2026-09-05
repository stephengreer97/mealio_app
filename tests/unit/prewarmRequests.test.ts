// MEAL-219, found on the Pixel: the prewarm's searches are the run's searches.
//
// A run whose searches were prewarmed produced six request rows and not one was
// a `search`. SilentSearchProbe has its own WebView and its own onMessage, and
// that handler had never heard of NET_REQUEST — so the statuses for the most
// interesting phase of the run were computed, posted and dropped, while the
// dashboard showed a tidy session/cart_read/add breakdown that looked complete.
import {
  recordPrewarmRequest, drainPrewarmRequests, clearPrewarmRequests,
} from '../../src/lib/prewarm-requests';

const row = (over: Record<string, unknown> = {}) => ({
  storeId: 'heb', phase: 'search', op: 'productSearchPageV2',
  status: 200, why: null, attempts: 1, ms: 120, ...over,
} as never);

beforeEach(() => clearPrewarmRequests());

describe('holding the prewarm\'s rows until a run can record them', () => {
  it('gives back what was recorded for that store', () => {
    recordPrewarmRequest(row());
    recordPrewarmRequest(row({ status: 500, why: 'http', attempts: 3 }));
    const out = drainPrewarmRequests('heb');
    expect(out).toHaveLength(2);
    expect(out[1].status).toBe(500);
    expect(out[1].attempts).toBe(3);
  });

  it('DRAINS rather than reads', () => {
    // A row recorded twice is a request that never happened, and the retry-rate
    // denominator is the first thing that would quietly go wrong.
    recordPrewarmRequest(row());
    expect(drainPrewarmRequests('heb')).toHaveLength(1);
    expect(drainPrewarmRequests('heb')).toHaveLength(0);
  });

  it('leaves another store\'s rows alone', () => {
    // The prewarm probes whichever store the user is looking at, which is not
    // always the store they then run. Draining everything would attribute one
    // store's requests to another.
    recordPrewarmRequest(row({ storeId: 'heb' }));
    recordPrewarmRequest(row({ storeId: 'aldi' }));
    expect(drainPrewarmRequests('heb')).toHaveLength(1);
    expect(drainPrewarmRequests('aldi')).toHaveLength(1);
  });

  it('returns nothing for a store that was never prewarmed', () => {
    expect(drainPrewarmRequests('walmart')).toEqual([]);
  });

  it('drops the OLDEST when a browsing session prewarms over and over', () => {
    // Someone flicking between stores must not grow this without bound, and the
    // newest rows are the ones the run about to start will be about.
    for (let i = 0; i < 260; i++) recordPrewarmRequest(row({ ms: i }));
    const out = drainPrewarmRequests('heb');
    expect(out).toHaveLength(200);
    expect(out[out.length - 1].ms).toBe(259);
    expect(out[0].ms).toBe(60);
  });
});
