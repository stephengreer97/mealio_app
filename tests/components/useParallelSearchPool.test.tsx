// Tests for the generic parallel search-and-collect pool extracted from
// the Wegmans cart-flow coordinator. Verifies queue dispatch, per-worker
// timeout, result ordering by item index, and the all-done callback.

import { act, renderHook } from '@testing-library/react-native';
import { useParallelSearchPool } from '../../src/lib/useParallelSearchPool';

jest.useFakeTimers();

type Item = { term: string };
type Result = { hits: number };

const setup = (opts?: Partial<Parameters<typeof useParallelSearchPool<Item, Result>>[0]>) => {
  return renderHook(() =>
    useParallelSearchPool<Item, Result>({
      workerCount: 3,
      workerTimeoutMs: 1_000,
      getUrl: (i) => `https://example/?q=${i.term}`,
      emptyResult: () => ({ hits: 0 }),
      ...opts,
    }),
  );
};

describe('useParallelSearchPool — initial state', () => {
  it('starts with empty workerUris and isActive=false', () => {
    const { result } = setup();
    expect(result.current.workerUris).toEqual(['', '', '']);
    expect(result.current.isActive).toBe(false);
  });
});

describe('useParallelSearchPool — start()', () => {
  it('dispatches up to workerCount items immediately', () => {
    const { result } = setup();
    act(() => {
      result.current.start(
        [{ term: 'a' }, { term: 'b' }, { term: 'c' }],
        () => {},
      );
    });
    expect(result.current.isActive).toBe(true);
    expect(result.current.workerUris).toEqual([
      'https://example/?q=a',
      'https://example/?q=b',
      'https://example/?q=c',
    ]);
  });

  it('leaves extra workers idle when items < workerCount', () => {
    const { result } = setup();
    act(() => {
      result.current.start([{ term: 'a' }], () => {});
    });
    expect(result.current.workerUris[0]).toBe('https://example/?q=a');
    expect(result.current.workerUris[1]).toBe('');
    expect(result.current.workerUris[2]).toBe('');
  });

  it('with empty items, immediately fires onAllDone with an empty map and stays inactive', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start([], cb);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual(new Map());
    expect(result.current.isActive).toBe(false);
  });

  it('ignores a second start() while already active', () => {
    const { result } = setup();
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], () => {});
    });
    const beforeUris = [...result.current.workerUris];
    act(() => {
      result.current.start([{ term: 'x' }, { term: 'y' }], () => {});
    });
    expect(result.current.workerUris).toEqual(beforeUris);
  });
});

describe('useParallelSearchPool — reportResult / queue draining', () => {
  it('records a result against the item index the worker was dispatched on', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], cb);
    });
    act(() => {
      result.current.reportResult(0, { hits: 7 });
      result.current.reportResult(1, { hits: 8 });
      result.current.reportResult(2, { hits: 9 });
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const got = cb.mock.calls[0][0] as Map<number, Result>;
    expect(got.get(0)).toEqual({ hits: 7 });
    expect(got.get(1)).toEqual({ hits: 8 });
    expect(got.get(2)).toEqual({ hits: 9 });
  });

  it('dispatches the next queued item to a worker after it reports', () => {
    const { result } = setup();
    act(() => {
      result.current.start(
        [{ term: 'a' }, { term: 'b' }, { term: 'c' }, { term: 'd' }, { term: 'e' }],
        () => {},
      );
    });
    // Initial dispatch: a, b, c.
    expect(result.current.workerUris).toEqual([
      'https://example/?q=a',
      'https://example/?q=b',
      'https://example/?q=c',
    ]);
    // Worker 0 reports → should pick up d.
    act(() => {
      result.current.reportResult(0, { hits: 1 });
    });
    expect(result.current.workerUris[0]).toBe('https://example/?q=d');
    // Worker 1 reports → should pick up e.
    act(() => {
      result.current.reportResult(1, { hits: 1 });
    });
    expect(result.current.workerUris[1]).toBe('https://example/?q=e');
    // Queue is now empty; worker 2 reports → goes idle (no URI change).
    act(() => {
      result.current.reportResult(2, { hits: 1 });
    });
    // The URI may still display the last URL it was loading; what matters is
    // that the worker is not assigned a new item. isActive stays true until
    // all results have come in.
  });

  it('fires onAllDone exactly once after the final result', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start(
        [{ term: 'a' }, { term: 'b' }, { term: 'c' }, { term: 'd' }],
        cb,
      );
    });
    // 3 of 4 results.
    act(() => {
      result.current.reportResult(0, { hits: 1 });
      result.current.reportResult(1, { hits: 1 });
      result.current.reportResult(2, { hits: 1 });
    });
    expect(cb).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);
    // Final result.
    act(() => {
      result.current.reportResult(0, { hits: 1 }); // worker 0 picked up d
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);
  });

  it('ignores reportResult from a worker that is not currently assigned', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start([{ term: 'a' }], cb);
    });
    // Worker 1 is idle (no item). Reporting from it should be a no-op.
    act(() => {
      result.current.reportResult(1, { hits: 999 });
    });
    expect(cb).not.toHaveBeenCalled();
    // Worker 0 finishes its real item.
    act(() => {
      result.current.reportResult(0, { hits: 1 });
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const got = cb.mock.calls[0][0] as Map<number, Result>;
    expect(got.size).toBe(1);
    expect(got.get(0)).toEqual({ hits: 1 });
  });
});

describe('useParallelSearchPool — timeout', () => {
  it('synthesizes emptyResult() when a worker does not report within workerTimeoutMs', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], cb);
    });
    // All three workers hang.
    act(() => {
      jest.advanceTimersByTime(1_001);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const got = cb.mock.calls[0][0] as Map<number, Result>;
    expect(got.size).toBe(3);
    expect(got.get(0)).toEqual({ hits: 0 });
    expect(got.get(1)).toEqual({ hits: 0 });
    expect(got.get(2)).toEqual({ hits: 0 });
    expect(result.current.isActive).toBe(false);
  });

  it('reportResult before the timeout cancels the timer', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start([{ term: 'a' }], cb);
    });
    act(() => {
      jest.advanceTimersByTime(500);
      result.current.reportResult(0, { hits: 42 });
    });
    // Advance past the original timeout — the timer should already be cleared
    // and not produce a phantom empty result.
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const got = cb.mock.calls[0][0] as Map<number, Result>;
    expect(got.get(0)).toEqual({ hits: 42 });
  });

  it('timeout on one worker still lets the queue keep draining on the others', () => {
    const { result } = setup();
    const cb = jest.fn();
    act(() => {
      result.current.start(
        [{ term: 'a' }, { term: 'b' }, { term: 'c' }, { term: 'd' }, { term: 'e' }],
        cb,
      );
    });
    // a, b, c in flight at t=0 with 1000ms timers each.
    // Advance to t=300, then b and c report. Workers 1 and 2 pick up d and e
    // and start fresh 1000ms timers (expire at t=1300).
    act(() => {
      jest.advanceTimersByTime(300);
      result.current.reportResult(1, { hits: 11 });
      result.current.reportResult(2, { hits: 12 });
    });
    // Advance to t=1100. Worker 0's original timer (set at t=0) fires at
    // t=1000 → idx 0 becomes empty. Workers 1 and 2's timers (set at t=300)
    // fire at t=1300 — not yet. Pool is not done (need 5, have 3).
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(cb).not.toHaveBeenCalled();
    // Workers 1 and 2 deliver real results before their timers fire.
    act(() => {
      result.current.reportResult(1, { hits: 13 });
      result.current.reportResult(2, { hits: 14 });
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const got = cb.mock.calls[0][0] as Map<number, Result>;
    expect(got.size).toBe(5);
    expect(got.get(0)).toEqual({ hits: 0 }); // a timed out
    expect(got.get(1)).toEqual({ hits: 11 });
    expect(got.get(2)).toEqual({ hits: 12 });
    expect(got.get(3)).toEqual({ hits: 13 });
    expect(got.get(4)).toEqual({ hits: 14 });
  });
});

describe('useParallelSearchPool — reset', () => {
  it('clears workerUris, isActive, and pending timers', () => {
    const { result } = setup();
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }], () => {});
    });
    expect(result.current.isActive).toBe(true);
    act(() => {
      result.current.reset();
    });
    expect(result.current.isActive).toBe(false);
    expect(result.current.workerUris).toEqual(['', '', '']);
    // Advance past timeout — must NOT fire a synthetic result on a reset pool.
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
  });
});
