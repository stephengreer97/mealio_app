// Tests for the generic parallel search-and-collect pool extracted from
// the Wegmans cart-flow coordinator. Verifies queue dispatch, per-worker
// timeout, result ordering by item index, and the all-done callback.

import { act, renderHook } from '@testing-library/react-native';
import { PoolSettled, useParallelSearchPool } from '../../src/lib/useParallelSearchPool';
import {
  AutomationTelemetry,
  StepRecord,
  recordPoolAddOutcome,
} from '../../src/lib/automation-telemetry';

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

  it('tracks progress: total set on start, completed rises per result', () => {
    const { result } = setup();
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], () => {});
    });
    expect(result.current.total).toBe(3);
    expect(result.current.completed).toBe(0);
    act(() => { result.current.reportResult(0, { hits: 1 }); });
    expect(result.current.completed).toBe(1);
    act(() => { result.current.reportResult(1, { hits: 1 }); });
    expect(result.current.completed).toBe(2);
    act(() => { result.current.reset(); });
    expect(result.current.completed).toBe(0);
    expect(result.current.total).toBe(0);
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

describe('useParallelSearchPool — staggered dispatch', () => {
  it('dispatches worker 0 immediately and the rest after the stagger delay', () => {
    // Long worker timeout so a worker can't time out mid-advance and grab a
    // still-queued item (which would scramble the positional mapping below).
    const { result } = setup({ dispatchStaggerMs: 400, workerTimeoutMs: 100_000 });
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], () => {});
    });
    // Only worker 0 goes out synchronously; 1 and 2 are still pending.
    expect(result.current.workerUris[0]).toBe('https://example/?q=a');
    expect(result.current.workerUris[1]).toBe('');
    expect(result.current.workerUris[2]).toBe('');
    // Past the max jittered stagger (i*400 + up to 400 → ≤1200ms for worker 2).
    act(() => { jest.advanceTimersByTime(1_600); });
    expect(result.current.workerUris[1]).toBe('https://example/?q=b');
    expect(result.current.workerUris[2]).toBe('https://example/?q=c');
  });

  it('reset() cancels pending staggered dispatches (runId guard)', () => {
    const { result } = setup({ dispatchStaggerMs: 400 });
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], () => {});
    });
    act(() => { result.current.reset(); });
    // A stale stagger timer must not dispatch onto the reset pool.
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(result.current.workerUris).toEqual(['', '', '']);
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

// ── MEAL-122: the pool's reporting seam ─────────────────────────────────────
//
// The pool stays telemetry-agnostic; onSettled is the single point at which an
// item's result becomes final. What matters is that it fires for EVERY dispatched
// item exactly once — including the item nobody ever reported, which is the one
// the funnel most needs, and which no message handler can see.

describe('useParallelSearchPool — onSettled', () => {
  const settledOf = (calls: PoolSettled<Result>[]) =>
    calls.map((c) => [c.itemIndex, c.workerId, c.timedOut, c.result.hits]);

  it('fires once per reported item, with the index the worker was dispatched on', () => {
    const onSettled = jest.fn();
    const { result } = setup({ onSettled });
    act(() => { result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], () => {}); });
    act(() => {
      result.current.reportResult(2, { hits: 9 });
      result.current.reportResult(0, { hits: 7 });
      result.current.reportResult(1, { hits: 8 });
    });
    // Reported out of order on purpose: the seam must carry the item index, not
    // the arrival order.
    expect(settledOf(onSettled.mock.calls.map((c) => c[0]))).toEqual([
      [2, 2, false, 9],
      [0, 0, false, 7],
      [1, 1, false, 8],
    ]);
  });

  it('fires for an item that never reported, flagged as timed out', () => {
    const onSettled = jest.fn();
    const { result } = setup({ onSettled });
    act(() => { result.current.start([{ term: 'a' }], () => {}); });
    act(() => { jest.advanceTimersByTime(1_001); });
    expect(settledOf(onSettled.mock.calls.map((c) => c[0]))).toEqual([[0, 0, true, 0]]);
  });

  it('fires exactly once per item across a queue that outlasts the workers', () => {
    const onSettled = jest.fn();
    const { result } = setup({ onSettled });
    act(() => {
      result.current.start(
        [{ term: 'a' }, { term: 'b' }, { term: 'c' }, { term: 'd' }, { term: 'e' }],
        () => {},
      );
    });
    act(() => { result.current.reportResult(0, { hits: 1 }); }); // 0 done, picks up d
    act(() => { result.current.reportResult(0, { hits: 2 }); }); // d done
    act(() => { result.current.reportResult(1, { hits: 3 }); }); // 1 done, picks up e
    act(() => { jest.advanceTimersByTime(1_001); });             // c and e time out
    const seen = onSettled.mock.calls.map((c) => c[0] as PoolSettled<Result>);
    expect(seen.map((s) => s.itemIndex).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(seen).toHaveLength(5);
  });

  it('does not fire for an item abandoned by reset()', () => {
    // A cancelled run must not inflate either side of the confirm rate.
    const onSettled = jest.fn();
    const { result } = setup({ onSettled });
    act(() => { result.current.start([{ term: 'a' }, { term: 'b' }], () => {}); });
    act(() => { result.current.reset(); });
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('keeps draining when the caller throws', () => {
    // Reporting is not the pool's job. A throw out of onSettled must not strand
    // an add mid-run.
    const cb = jest.fn();
    const { result } = setup({
      onSettled: () => { throw new Error('reporter blew up'); },
    });
    act(() => { result.current.start([{ term: 'a' }, { term: 'b' }], cb); });
    act(() => { result.current.reportResult(0, { hits: 1 }); });
    act(() => { result.current.reportResult(1, { hits: 2 }); });
    expect(cb).toHaveBeenCalledTimes(1);
    const got = cb.mock.calls[0][0] as Map<number, Result>;
    expect(got.get(0)).toEqual({ hits: 1 });
    expect(got.get(1)).toEqual({ hits: 2 });
  });
});

// ── MEAL-122: the funnel a real run would upload ────────────────────────────
//
// Wires the pool to a REAL recorder through the same reporter the cart sheet
// uses, and reads the batch the upload function received. Asserting that a mock
// was called would not have caught the thing this project has already been
// burned by: a detail payload that sanitizeDetail silently dropped on its way
// out. These assertions are on rows the server would actually have seen.
describe('useParallelSearchPool — end-to-end funnel through a real recorder', () => {
  type AddLike = { success: boolean; reason: string | null };

  async function run(): Promise<{ rows: StepRecord[]; tel: AutomationTelemetry }> {
    const uploaded: StepRecord[][] = [];
    const tel = new AutomationTelemetry({
      runId: 'run-122',
      upload: async (b) => { uploaded.push(b.steps); return true; },
      batchSize: 1000,
      flushIntervalMs: 60_000,
    });
    const { result } = renderHook(() =>
      useParallelSearchPool<Item, AddLike>({
        workerCount: 2,
        workerTimeoutMs: 1_000,
        getUrl: (i) => `https://example/?q=${i.term}`,
        emptyResult: () => ({ success: false, reason: 'timeout' }),
        onSettled: (info) => recordPoolAddOutcome(tel, {
          path: 'parallel_add',
          workerId: info.workerId,
          itemIndex: info.itemIndex,
          success: info.result.success,
          reason: info.result.reason,
          timedOut: info.timedOut,
          detail: { confirmVia: 'badge' },
        }),
      }),
    );
    // Three items, two workers: one succeeds, one hits a wall, one never answers.
    act(() => {
      result.current.start([{ term: 'a' }, { term: 'b' }, { term: 'c' }], () => {});
    });
    act(() => { result.current.reportResult(0, { success: true, reason: null }); });
    act(() => { result.current.reportResult(1, { success: false, reason: 'blocked' }); });
    act(() => { jest.advanceTimersByTime(1_001); });
    await tel.flush();
    return { rows: uploaded.flat(), tel };
  }

  it('gives every item a coded, item-attributed funnel row the server can see', async () => {
    const { rows, tel } = await run();
    try {
      // Before MEAL-122 this whole batch was empty: three items, three outcomes,
      // no rows at all.
      expect(rows.map((r) => [r.step, r.outcome, r.code, r.itemIndex])).toEqual([
        ['add_click', 'ok', undefined, 0],
        ['confirm', 'ok', undefined, 0],
        ['add_click', 'ok', undefined, 1],
        ['blocked', 'blocked', 'waf_block', 1],
        ['confirm', 'error', 'waf_block', 1],
        ['add_click', 'ok', undefined, 2],
        ['confirm', 'timeout', 'timeout', 2],
      ]);
      // seq is the server's idempotency key and its only ordering signal. Rows
      // from concurrent workers interleave by item, never within one.
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      // The detail actually arrived — sanitizeDetail keeps these because they
      // are scalars. This is the assertion a mock-was-called test cannot make.
      expect(rows[1].detail).toEqual({
        attempt: 1, path: 'parallel_add', workerId: 0, confirmVia: 'badge',
      });
      // Confirm-rate denominator: one add_click per item, no more and no fewer.
      expect(rows.filter((r) => r.step === 'add_click')).toHaveLength(3);
      // And the run's headline code is now the wall rather than nothing at all.
      // NOTE for whoever merges PR #83 (fix/meal-123-dominant-severity): that
      // branch renames dominantFailureCode() to primaryFailureCode(). This line
      // is the rename's only reach into MEAL-122, and it is not a git conflict —
      // different file — so it will break at compile time rather than at merge.
      // The assertion holds either way: waf_block is both the most frequent code
      // here and the most severe.
      expect(tel.dominantFailureCode()).toBe('waf_block');
    } finally {
      await tel.dispose();
    }
  });
});
