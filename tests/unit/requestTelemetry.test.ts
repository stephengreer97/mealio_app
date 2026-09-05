// A REQUEST'S OWN ROW: what it carries, and what it must never claim.
//
// MEAL-219. Every rail's requests now report themselves through the shared
// retry helper, and this pins the two decisions that make those rows worth
// storing: the status is kept EXACTLY, and the failure code is honest about
// being coarse.
import {
  requestFailureCode, STEP_PHASES, STEP_FAILURE_CODES,
} from '../../src/lib/automation-telemetry';

describe('the code a failing request carries', () => {
  it.each([403, 429, 412, 418])('reads %i as the wall, not as a store answer', (status) => {
    // Nothing after a block is evidence of anything, which is why these are
    // named first and separately: counted as ordinary failures they would make
    // a walled store look like a broken one.
    expect(requestFailureCode(status, 'http')).toBe('waf_block');
  });

  it('reads a 401 as not signed in', () => {
    expect(requestFailureCode(401, 'unauthorised')).toBe('auth_required');
  });

  it('separates a request that ran out of clock from one that answered badly', () => {
    // The retry policy deliberately declines to retry a timeout, so telling it
    // apart from a 5xx is the difference between "the store is ill" and "we did
    // not wait long enough".
    expect(requestFailureCode(null, 'timeout')).toBe('timeout');
    expect(requestFailureCode(null, 'no_response')).toBe('timeout');
    expect(requestFailureCode(503, 'http')).not.toBe('timeout');
  });

  it.each([500, 502, 503, 504, 400, 404, 422])('does not call %i a rejected match', (status) => {
    // THE POINT OF THE WHOLE TICKET. Eighteen network reasons already collapse
    // into `match_rejected`, which reads as "we picked the wrong product" — so a
    // store that 500s and a store that does not stock the item are one bar. A
    // request row must never add to that pile.
    expect(requestFailureCode(status, 'http')).not.toBe('match_rejected');
    expect(requestFailureCode(status, 'http')).not.toBe('no_candidates');
  });

  it('only ever returns a code the dashboard already knows', () => {
    const cases: Array<[number | null, string | null]> = [
      [500, 'http'], [403, 'http'], [401, 'x'], [null, 'timeout'],
      [null, 'no_response'], [200, 'unparseable'], [null, null], [418, 'blocked'],
    ];
    for (const [s, w] of cases) {
      expect(STEP_FAILURE_CODES).toContain(requestFailureCode(s, w));
    }
  });
});

describe('the phases a request can belong to', () => {
  it('is exactly the four a network run performs', () => {
    // Not derived from StepName, which is the DOM funnel's vocabulary and still
    // contains `add_click`.
    expect([...STEP_PHASES]).toEqual(['session', 'search', 'add', 'cart_read']);
  });

  it('does not overlap the old step names, so neither can be read as the other', () => {
    expect(STEP_PHASES).not.toContain('add_click' as never);
    expect(STEP_PHASES).not.toContain('confirm' as never);
  });
});
