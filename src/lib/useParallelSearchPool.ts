// Generic parallel search-and-collect pool.
//
// Originally lived inline in WebViewCartSheet for the Wegmans 5-worker pool
// (parallel ingredient search via 5 hidden WebViews). Extracted here so it
// can be reused by any other store that benefits from parallelism, and so
// the queue / dispatch / timeout state machine is unit-testable in isolation.
//
// Usage shape:
//
//   const pool = useParallelSearchPool<MyItem, MyResult>({
//     workerCount: 5,
//     workerTimeoutMs: 20_000,
//     getUrl: (item) => buildSearchUrl(item.term),
//     emptyResult: () => [],
//   });
//
//   // Render N hidden WebViews; each loads pool.workerUris[i].
//   // When that WebView posts back a result, call pool.reportResult(i, value).
//
//   pool.start(items, (resultsByIdx) => {
//     // resultsByIdx is a Map<itemIdx, MyResult> indexed by the original
//     // item index in `items`. Fired once when all items have a result
//     // (real or timeout).
//   });
//
// State machine inside one worker:
//   idle → (dispatch) → busy → (reportResult|timeout) → idle | dispatch-next
//
// State machine for the whole pool:
//   inactive → (start) → active → (every result collected) → inactive → onAllDone

import { useCallback, useRef, useState } from 'react';

/** One item's final result, handed to onSettled. */
export interface PoolSettled<TResult> {
  /** Slot that ran the item. Slots are reused, so this is not an item identity. */
  workerId: number;
  /** The item's index in the array passed to start(). */
  itemIndex: number;
  result: TResult;
  /** True when no worker reported in time and `emptyResult()` was synthesized. */
  timedOut: boolean;
  /**
   * Whether an add was actually sent to the item's page before it settled.
   *
   * It separates "we tried to add this and it didn't land" from "we never got as
   * far as trying", which is the difference between an item that belongs in the
   * confirm-rate denominator and one that does not.
   *
   * The two pools know this to different depths, and the flag reports what each
   * one can honestly say:
   *
   *   useParallelSearchPool — always true once an item is dispatched. The add
   *     rides the page load (the worker's URL carries the payload and its script
   *     fires search+add on load), so dispatch happens inside the page and the RN
   *     side has no signal that separates "the page never loaded" from "it loaded
   *     and never answered". Both arrive as silence.
   *
   *     The engine resolves that same ambiguity BOTH ways, so neither is a
   *     precedent to hide behind. `path:'sequential'` emits add_click the moment
   *     it dispatches, on the stated grounds that a click producing no signal
   *     would otherwise vanish and flatter the confirm rate. `path:'fused'` —
   *     structurally the closer analogue, since its add also fires inside an
   *     injected script — does the opposite: on silence its timeout records
   *     `search`/`timeout` and no add half at all.
   *
   *     True here follows `sequential`, deliberately. Silence over a 35s budget
   *     that spans search, click AND the cart-badge confirmation poll is far more
   *     likely to be an add that went unanswered than a page that never loaded,
   *     and the cost of each error is not symmetric: over-counting reads the
   *     confirm rate LOW, under-counting reads it high. A metric about whether
   *     adds land should fail toward admitting failure.
   *
   *   usePresearchAddPool — known for its PARKED workers. Injecting the add is
   *     an explicit RN-side act (injectAdd sets the phase), so a parked item
   *     whose page was still loading when the run stopped waiting reports false,
   *     and that is not a guess.
   *
   *     NOT known for its COLD slot, which the pool reports true for and should
   *     not: dispatchColdNext sets phase 'adding' at dispatch, before the page
   *     has loaded, and the injection happens later in the component's onLoadEnd.
   *     The pool has no way to see that, so the CALLER corrects it — see
   *     presearchAddDispatched in lib/pool-add-funnel. Anything reading this flag
   *     straight off a pre-search settle is wrong on the cold slot.
   */
  addDispatched: boolean;
}

export interface ParallelPoolOptions<TItem, TResult> {
  /** Number of concurrent workers. Each gets its own URI slot. */
  workerCount: number;
  /** If a worker doesn't report within this many ms, its assigned item is
   *  synthesized with `emptyResult()` and the worker freed to take the next.
   *  Defaults to 20_000. */
  workerTimeoutMs?: number;
  /** Build the URL to load in the worker for a given item. */
  getUrl: (item: TItem) => string;
  /** Synthetic empty result used on timeout, so the result map always has
   *  exactly `items.length` entries when the pool finishes. */
  emptyResult: () => TResult;
  /** Called exactly once per dispatched item, at the moment its result becomes
   *  final — for a worker-reported result and for a synthesized timeout alike.
   *  This is the pool's only reporting seam; the pool itself stays
   *  telemetry-agnostic so it remains reusable, and the caller decides what (if
   *  anything) to emit. It fires BEFORE onAllDone, so every per-item row precedes
   *  the run's terminal rows. Errors thrown here are swallowed: a reporting
   *  mistake must not break a cart run. Items abandoned by reset() never settle
   *  and are deliberately not reported. */
  onSettled?: (info: PoolSettled<TResult>) => void;
  /** When > 0, the INITIAL burst is staggered: worker 0 starts immediately and
   *  each subsequent worker starts after ~i * dispatchStaggerMs (plus jitter),
   *  instead of all firing at once. Softens the "N simultaneous requests"
   *  pattern that trips anti-bot. Later dispatches (as workers free up) are
   *  already naturally spread out. Defaults to 0 (no stagger). */
  dispatchStaggerMs?: number;
}

export interface ParallelPool<TItem, TResult> {
  /** Current URI for each worker, length = workerCount. Each is an empty
   *  string before that worker is first dispatched AND once a worker goes idle
   *  (its queue ran dry), so a `uri ? <WebView/> : null` render mounts exactly
   *  the workers that are actively working — visible tiles drop as workers
   *  finish. Mount N WebViews and use these as their source. */
  workerUris: string[];
  /** The item each worker is currently assigned, length = workerCount. null
   *  when that worker is idle. Lets the UI label each live tile with the
   *  ingredient it's working on, in lockstep with workerUris. */
  workerItems: (TItem | null)[];
  /** True while a start() run is in flight. False once all items have been
   *  collected (real or timeout) or before the first start(). */
  isActive: boolean;
  /** Number of items that have a result so far in the current run (reactive). */
  completed: number;
  /** Total items dispatched in the current run (reactive). */
  total: number;
  /** Begin dispatching `items` across workers. `onAllDone` fires exactly
   *  once when every item has a result. Indexes in the result Map align
   *  with the indexes in `items`. Subsequent start() calls before the
   *  current one completes are ignored. */
  start: (items: TItem[], onAllDone: (resultsByIdx: Map<number, TResult>) => void) => void;
  /** Call when a worker's hidden WebView posts back a result. The result
   *  is recorded against the item the worker was last dispatched. */
  reportResult: (workerId: number, result: TResult) => void;
  /** Hard-reset (clear queue, clear timers, mark inactive). Component
   *  teardown / cancel paths call this. */
  reset: () => void;
}

interface QueueEntry<TItem> {
  idx: number;
  item: TItem;
}

export function useParallelSearchPool<TItem, TResult>(
  options: ParallelPoolOptions<TItem, TResult>,
): ParallelPool<TItem, TResult> {
  const { workerCount, getUrl, emptyResult } = options;
  const workerTimeoutMs = options.workerTimeoutMs ?? 20_000;
  const dispatchStaggerMs = options.dispatchStaggerMs ?? 0;

  // workerUris is the only piece of React-visible state; everything else is
  // refs so a single dispatch tick can read+update without scheduling renders.
  const [workerUris, setWorkerUris] = useState<string[]>(() =>
    new Array(workerCount).fill(''),
  );
  // Reactive per-worker item assignment, mirrored from workerIdxRef so the UI
  // can label each live tile. null = idle.
  const [workerItems, setWorkerItems] = useState<(TItem | null)[]>(() =>
    new Array(workerCount).fill(null),
  );
  const [isActive, setIsActive] = useState(false);
  // Reactive progress for the UI: how many items have a result so far, out of
  // the total dispatched. (The sequential flow tracks progress via index refs;
  // the pool dispatches all at once, so it must surface its own count.)
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);

  const queueRef = useRef<QueueEntry<TItem>[]>([]);
  const resultsRef = useRef<Map<number, TResult>>(new Map());
  const totalRef = useRef(0);
  const workerBusyRef = useRef<boolean[]>(new Array(workerCount).fill(false));
  const workerIdxRef = useRef<number[]>(new Array(workerCount).fill(-1));
  const workerTimersRef = useRef<(ReturnType<typeof setTimeout> | null)[]>(
    new Array(workerCount).fill(null),
  );
  const onAllDoneRef = useRef<((r: Map<number, TResult>) => void) | null>(null);
  // Read through a ref, not a dependency: the option is rebuilt on every render
  // of the caller, and putting it in dispatchToWorker's deps would rebuild the
  // dispatch closure (and so `start`) on every render.
  const onSettledRef = useRef(options.onSettled);
  onSettledRef.current = options.onSettled;
  // Bumped on every start()/reset(). A staggered initial-dispatch timer checks
  // this against the run it was scheduled in, so a reset (or a new run) cancels
  // any still-pending stagger timers without per-timer bookkeeping.
  const runIdRef = useRef(0);

  const setWorkerUri = useCallback((workerId: number, uri: string) => {
    setWorkerUris((prev) => {
      if (prev[workerId] === uri) return prev;
      const next = [...prev];
      next[workerId] = uri;
      return next;
    });
  }, []);

  const setWorkerItem = useCallback((workerId: number, item: TItem | null) => {
    setWorkerItems((prev) => {
      if (prev[workerId] === item) return prev;
      const next = [...prev];
      next[workerId] = item;
      return next;
    });
  }, []);

  const clearTimer = useCallback((workerId: number) => {
    const t = workerTimersRef.current[workerId];
    if (t) {
      clearTimeout(t);
      workerTimersRef.current[workerId] = null;
    }
  }, []);

  /** Report one item's final result. Swallows anything the caller throws — the
   *  pool's job is dispatching adds, and a reporting bug must not stop it. */
  const notifySettled = useCallback((info: PoolSettled<TResult>) => {
    try { onSettledRef.current?.(info); } catch { /* reporting must not break the pool */ }
  }, []);

  const tryFinish = useCallback(() => {
    if (resultsRef.current.size < totalRef.current) return false;
    const cb = onAllDoneRef.current;
    onAllDoneRef.current = null;
    setIsActive(false);
    if (cb) cb(new Map(resultsRef.current));
    return true;
  }, []);

  // dispatchToWorker pops the next item off the queue and assigns it to
  // workerId. If the queue is empty, the worker goes idle.
  const dispatchToWorker = useCallback((workerId: number) => {
    const next = queueRef.current.shift();
    if (!next) {
      workerBusyRef.current[workerId] = false;
      workerIdxRef.current[workerId] = -1;
      // Idle: clear the URI so the worker's tile unmounts (drop from the grid)
      // the instant it runs out of work, rather than lingering on its last page.
      setWorkerUri(workerId, '');
      setWorkerItem(workerId, null);
      return;
    }
    workerBusyRef.current[workerId] = true;
    workerIdxRef.current[workerId] = next.idx;
    const url = getUrl(next.item);
    setWorkerUri(workerId, url);
    setWorkerItem(workerId, next.item);

    clearTimer(workerId);
    workerTimersRef.current[workerId] = setTimeout(() => {
      workerTimersRef.current[workerId] = null;
      const stuckIdx = workerIdxRef.current[workerId];
      if (stuckIdx < 0) return;
      const synthesized = emptyResult();
      resultsRef.current.set(stuckIdx, synthesized);
      setCompleted(resultsRef.current.size);
      workerBusyRef.current[workerId] = false;
      workerIdxRef.current[workerId] = -1;
      notifySettled({ workerId, itemIndex: stuckIdx, result: synthesized, timedOut: true, addDispatched: true });
      if (!tryFinish()) {
        dispatchToWorker(workerId);
      }
    }, workerTimeoutMs);
  }, [getUrl, emptyResult, workerTimeoutMs, setWorkerUri, clearTimer, tryFinish, notifySettled]);

  const reportResult = useCallback((workerId: number, result: TResult) => {
    const idx = workerIdxRef.current[workerId];
    if (idx < 0) {
      // Worker isn't currently assigned — stale or out-of-band message.
      return;
    }
    clearTimer(workerId);
    resultsRef.current.set(idx, result);
    setCompleted(resultsRef.current.size);
    workerBusyRef.current[workerId] = false;
    workerIdxRef.current[workerId] = -1;
    notifySettled({ workerId, itemIndex: idx, result, timedOut: false, addDispatched: true });
    if (!tryFinish()) {
      dispatchToWorker(workerId);
    }
  }, [clearTimer, dispatchToWorker, tryFinish, notifySettled]);

  const reset = useCallback(() => {
    queueRef.current = [];
    resultsRef.current = new Map();
    totalRef.current = 0;
    workerBusyRef.current = new Array(workerCount).fill(false);
    workerIdxRef.current = new Array(workerCount).fill(-1);
    for (let i = 0; i < workerCount; i++) clearTimer(i);
    runIdRef.current++; // invalidate any pending staggered-dispatch timers
    onAllDoneRef.current = null;
    setIsActive(false);
    setCompleted(0);
    setTotal(0);
    setWorkerUris(new Array(workerCount).fill(''));
    setWorkerItems(new Array(workerCount).fill(null));
  }, [workerCount, clearTimer]);

  const start = useCallback(
    (items: TItem[], onAllDone: (r: Map<number, TResult>) => void) => {
      if (isActive) return;
      if (items.length === 0) {
        onAllDone(new Map());
        return;
      }
      queueRef.current = items.map((item, idx) => ({ idx, item }));
      resultsRef.current = new Map();
      totalRef.current = items.length;
      setCompleted(0);
      setTotal(items.length);
      workerBusyRef.current = new Array(workerCount).fill(false);
      workerIdxRef.current = new Array(workerCount).fill(-1);
      setWorkerItems(new Array(workerCount).fill(null));
      onAllDoneRef.current = onAllDone;
      setIsActive(true);
      const runId = ++runIdRef.current;
      const burst = Math.min(workerCount, items.length);
      for (let i = 0; i < burst; i++) {
        if (dispatchStaggerMs <= 0 || i === 0) {
          dispatchToWorker(i);
          continue;
        }
        // Stagger worker i by ~i * base + up to one base of jitter, so the
        // initial requests don't all leave at the same instant.
        const delay = i * dispatchStaggerMs + Math.floor(Math.random() * dispatchStaggerMs);
        setTimeout(() => {
          if (runIdRef.current !== runId) return; // reset / superseded by a new run
          dispatchToWorker(i);
        }, delay);
      }
    },
    [isActive, workerCount, dispatchToWorker, dispatchStaggerMs],
  );

  return { workerUris, workerItems, isActive, completed, total, start, reportResult, reset };
}
