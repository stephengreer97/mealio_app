// The rule that "do it yourself" is the last resort, not a shrug.
import { decideHandover, isTransientRunFailure, MAX_RUN_RETRIES } from '../../src/lib/handover';

const base = { runRetriesUsed: 0, maxRunRetries: MAX_RUN_RETRIES, reviewableCount: 0, informativeCount: 0 };

describe('a transient dead end gets the run rerun', () => {
  it.each(['session_timeout', 'session_failed', 'session_no_response', 'no_session',
           'no_session_at_add', 'search_timeout'])('%s', (why) => {
    expect(isTransientRunFailure(why)).toBe(true);
    expect(decideHandover({ ...base, why })).toBe('retry_run');
  });

  it('spends the allowance once and not twice', () => {
    const why = 'session_timeout';
    expect(decideHandover({ ...base, why, runRetriesUsed: 0 })).toBe('retry_run');
    expect(decideHandover({ ...base, why, runRetriesUsed: MAX_RUN_RETRIES })).toBe('assisted');
  });

  it('one retry, because a second is a loop', () => {
    expect(MAX_RUN_RETRIES).toBe(1);
  });
});

describe('a dead end a rerun cannot fix does not get one', () => {
  it.each(['no_rail', 'add_script_unbuildable', 'search_script_unbuildable', 'search_blocked'])(
    '%s', (why) => {
      expect(isTransientRunFailure(why)).toBe(false);
      expect(decideHandover({ ...base, why })).toBe('assisted');
    });

  it('does not hand a free retry to a reason nobody classified', () => {
    // The list is a list and not a catch-all on purpose: an unclassified `why`
    // is far more likely to be deterministic than transient, and guessing wrong
    // costs the user a doubled wait before the same dead end.
    expect(isTransientRunFailure('something_new')).toBe(false);
    expect(decideHandover({ ...base, why: 'something_new' })).toBe('assisted');
  });

  it('never reruns the add phase', () => {
    // [[cart-qty-adds-on-top]]: a rerun starts from a fresh baseline, so a
    // rerun after a half-landed write buys two of something.
    expect(isTransientRunFailure('add_timeout')).toBe(false);
    expect(isTransientRunFailure('add_failed')).toBe(false);
  });
});

describe('anything we can show beats the store search box', () => {
  const spent = { ...base, runRetriesUsed: MAX_RUN_RETRIES };

  it('reviews when the user could pick something', () => {
    expect(decideHandover({ ...spent, why: 'session_timeout', reviewableCount: 3 })).toBe('review');
  });

  it('reviews when all we can do is say what went wrong', () => {
    expect(decideHandover({ ...spent, why: 'no_rail', informativeCount: 2 })).toBe('review');
  });

  it('reviews even a deterministic dead end, once there is something to show', () => {
    // The failure being unfixable says nothing about whether the twelve
    // products already found are worth showing.
    expect(decideHandover({ ...spent, why: 'search_blocked', reviewableCount: 12 })).toBe('review');
  });

  it('hands over only when the run learned nothing at all', () => {
    expect(decideHandover({ ...spent, why: 'session_timeout' })).toBe('assisted');
  });

  it('does NOT rerun over the top of products it already found', () => {
    // startNetworkRun clears the candidate maps, so a rerun here destroys the
    // twelve to go looking for fourteen -- and when the rerun fails too, the
    // user gets the store's search page having had a pickable product all along.
    expect(decideHandover({ ...base, why: 'session_timeout', reviewableCount: 12 })).toBe('review');
  });

  it('reruns rather than showing a card that offers nothing to pick', () => {
    // "The store had none of this" is worth less than another go at finding
    // some, so the free retry goes first when that is all we hold.
    expect(decideHandover({ ...base, why: 'session_timeout', informativeCount: 4 })).toBe('retry_run');
    expect(decideHandover({ ...base, why: 'session_timeout', informativeCount: 4,
      runRetriesUsed: MAX_RUN_RETRIES })).toBe('review');
  });
});
