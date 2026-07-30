// Pre-search parking pool (FEATURE_PRESEARCH_ADD).
//
// A two-phase sibling of useParallelSearchPool. Instead of each worker searching
// AND adding in one shot, this splits the worker's life across the user's
// add-to-cart tap:
//
//   PARK phase   — start(items) dispatches the first `workerCount` items; each
//                  worker loads its search-results page and PARKS there (holds
//                  the loaded page). No adds happen yet. Extra items wait in the
//                  queue.
//   COMMIT phase — commit(selectedIdxs) fires on the add-to-cart tap. Every
//                  parked worker whose item is still selected injects its add
//                  into the ALREADY-OPEN page (the component does the injection
//                  via onInjectAdd, applying human-like jitter). A parked worker
//                  whose item was DESELECTED abandons it and pulls the next
//                  queued selected item. Items dispatched after the tap search
//                  then auto-commit the instant they park.
//
// The hook owns the queue / worker-slot / result state machine (unit-testable in
// isolation); the component owns the WebView refs and performs the actual
// script injection when the pool calls onInjectAdd.
//
// Worker slot state machine:
//   idle → (dispatchSearch) → loading → (reportSearched) → parked
//   parked → (commit selected | auto-commit post-tap) → adding
//   adding → (reportAdded | addTimeout) → idle | dispatchSearch(next)
//
// Internal functions call each other through a single `fns` ref so the mutual
// recursion (settleAdd → dispatchNext → dispatchSearch → settleAdd) has no
// dependency cycle and never captures a stale peer.

import { useCallback, useMemo, useRef, useState } from 'react';

export interface PresearchItem<TItem> {
  /** Stable identity of the item across park/commit — its index in the caller's
   *  active-items array. Results come back keyed by this. */
  idx: number;
  item: TItem;
}

export interface PresearchPoolOptions<TItem, TResult> {
  /** Parked worker slots (indices 0..workerCount-1) — they pre-search during the
   *  qty screen and commit their loaded page on the tap. */
  workerCount: number;
  /** Extra "cold" slots (indices workerCount..workerCount+coldWorkerCount-1) that
   *  do NOT pre-search: they only activate at commit, each pulling an overflow
   *  item from the shared queue and doing a cold search+add. Used to enlist the
   *  main cart WebView as an extra add surface once it's done snapshotting.
   *  Defaults to 0. */
  coldWorkerCount?: number;
  /** URL to load in a worker to search for an item (its results page). */
  getUrl: (item: TItem) => string;
  /** Synthetic result recorded when a commit times out, so the result map is
   *  always complete for the selected set. */
  emptyResult: () => TResult;
  /** Called when a parked (or freshly searched, post-tap) worker should add its
   *  item. The component injects the store's add script into worker `workerId`'s
   *  open page, typically after a jitter delay. */
  onInjectAdd: (workerId: number, item: TItem) => void;
  /** Called when a COLD slot picks up an item. The component drives that slot's
   *  surface (the main WebView): navigate it to the results page and, once
   *  loaded, inject the fused search+add, then feed the result to reportAdded. */
  onColdDispatch?: (slotId: number, item: TItem) => void;
  /** Park (search) timeout. Defaults to 20_000. */
  searchTimeoutMs?: number;
  /** Commit (add) timeout. Defaults to 20_000. */
  addTimeoutMs?: number;
}

export interface PresearchAddPool<TItem, TResult> {
  /** Per-worker URI; '' when idle. Mount `workerCount` WebViews using these. */
  workerUris: string[];
  /** Per-worker assigned item (for tile labels); null when idle. */
  workerItems: (TItem | null)[];
  /** True once commit() has been called and before it finishes. */
  isCommitting: boolean;
  /** Selected items with a final add result so far in the commit phase. */
  completed: number;
  /** Total selected items being committed (0 until commit()). */
  total: number;
  /** Begin the park phase: dispatch the first `workerCount` items to search. */
  start: (items: PresearchItem<TItem>[]) => void;
  /** Fire on the add-to-cart tap. `selected` is the still-checked subset (with
   *  original idxs). onAllDone fires once every selected item has an add result. */
  commit: (
    selected: PresearchItem<TItem>[],
    onAllDone: (resultsByIdx: Map<number, TResult>) => void,
  ) => void;
  /** Worker parked on its results page (WORKER_RESULT phase:'search'). */
  reportSearched: (workerId: number) => void;
  /** Worker's add finished (WORKER_RESULT phase:'add'). */
  reportAdded: (workerId: number, result: TResult) => void;
  /** Hard reset (teardown / cancel). */
  reset: () => void;
}

type SlotPhase = 'idle' | 'loading' | 'parked' | 'adding';

interface Machine<TItem, TResult> {
  dispatchSearch: (workerId: number, entry: PresearchItem<TItem>) => void;
  dispatchNext: (workerId: number) => void;
  dispatchColdNext: (slot: number) => void;
  settleAdd: (workerId: number, result: TResult) => void;
  injectAdd: (workerId: number) => void;
  tryFinish: () => boolean;
  freeSlot: (workerId: number) => void;
}

export function usePresearchAddPool<TItem, TResult>(
  options: PresearchPoolOptions<TItem, TResult>,
): PresearchAddPool<TItem, TResult> {
  const { workerCount, getUrl, emptyResult, onInjectAdd } = options;
  const coldWorkerCount = options.coldWorkerCount ?? 0;
  const totalSlots = workerCount + coldWorkerCount;
  const isCold = useCallback((slot: number) => slot >= workerCount, [workerCount]);
  const searchTimeoutMs = options.searchTimeoutMs ?? 20_000;
  const addTimeoutMs = options.addTimeoutMs ?? 20_000;

  const [workerUris, setWorkerUris] = useState<string[]>(() => new Array(totalSlots).fill(''));
  const [workerItems, setWorkerItems] = useState<(TItem | null)[]>(() => new Array(totalSlots).fill(null));
  const [isCommitting, setIsCommitting] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);

  const modeRef = useRef<'idle' | 'parking' | 'committing'>('idle');
  const queueRef = useRef<PresearchItem<TItem>[]>([]);
  const slotItemRef = useRef<(PresearchItem<TItem> | null)[]>(new Array(totalSlots).fill(null));
  const slotPhaseRef = useRef<SlotPhase[]>(new Array(totalSlots).fill('idle'));
  const timersRef = useRef<(ReturnType<typeof setTimeout> | null)[]>(new Array(totalSlots).fill(null));
  const onColdDispatchRef = useRef(options.onColdDispatch);
  onColdDispatchRef.current = options.onColdDispatch;
  const resultsRef = useRef<Map<number, TResult>>(new Map());
  const totalRef = useRef(0);
  const selectedIdxRef = useRef<Set<number>>(new Set());
  const onAllDoneRef = useRef<((r: Map<number, TResult>) => void) | null>(null);
  // Bumped on start()/reset() so stray timers from an old run are ignored.
  const runIdRef = useRef(0);

  // Latest option callbacks, read through refs so the machine (built once) never
  // captures stale ones.
  const getUrlRef = useRef(getUrl);
  getUrlRef.current = getUrl;
  const emptyResultRef = useRef(emptyResult);
  emptyResultRef.current = emptyResult;
  const onInjectAddRef = useRef(onInjectAdd);
  onInjectAddRef.current = onInjectAdd;
  const searchTimeoutRef = useRef(searchTimeoutMs);
  searchTimeoutRef.current = searchTimeoutMs;
  const addTimeoutRef = useRef(addTimeoutMs);
  addTimeoutRef.current = addTimeoutMs;

  const setUri = useCallback((workerId: number, uri: string) => {
    setWorkerUris((prev) => {
      if (prev[workerId] === uri) return prev;
      const next = [...prev];
      next[workerId] = uri;
      return next;
    });
  }, []);
  const setItem = useCallback((workerId: number, item: TItem | null) => {
    setWorkerItems((prev) => {
      if (prev[workerId] === item) return prev;
      const next = [...prev];
      next[workerId] = item;
      return next;
    });
  }, []);
  const clearTimer = useCallback((workerId: number) => {
    const t = timersRef.current[workerId];
    if (t) { clearTimeout(t); timersRef.current[workerId] = null; }
  }, []);

  // The recursive state machine. Built once; peers are called via fns.current.
  const fns = useRef<Machine<TItem, TResult>>(undefined as unknown as Machine<TItem, TResult>);
  if (!fns.current) {
    const freeSlot = (workerId: number) => {
      clearTimer(workerId);
      slotItemRef.current[workerId] = null;
      slotPhaseRef.current[workerId] = 'idle';
      setUri(workerId, '');
      setItem(workerId, null);
    };

    const tryFinish = (): boolean => {
      if (modeRef.current !== 'committing') return false;
      if (resultsRef.current.size < totalRef.current) return false;
      const cb = onAllDoneRef.current;
      onAllDoneRef.current = null;
      modeRef.current = 'idle';
      setIsCommitting(false);
      if (cb) cb(new Map(resultsRef.current));
      return true;
    };

    const dispatchNext = (workerId: number) => {
      if (isCold(workerId)) { fns.current.dispatchColdNext(workerId); return; }
      const next = queueRef.current.shift();
      if (!next) { freeSlot(workerId); return; }
      fns.current.dispatchSearch(workerId, next);
    };

    // A cold slot (the main WebView) has no parked page: it pulls an overflow
    // item and does a fresh search+add. The component drives the surface via
    // onColdDispatch (navigate + inject the fused script on load), then feeds the
    // outcome to reportAdded. Phase goes straight to 'adding' (no park step).
    const dispatchColdNext = (slot: number) => {
      const next = queueRef.current.shift();
      if (!next) { freeSlot(slot); return; }
      slotItemRef.current[slot] = next;
      slotPhaseRef.current[slot] = 'adding';
      setUri(slot, getUrlRef.current(next.item));
      setItem(slot, next.item);
      clearTimer(slot);
      const runId = runIdRef.current;
      timersRef.current[slot] = setTimeout(() => {
        timersRef.current[slot] = null;
        if (runIdRef.current !== runId) return;
        if (slotPhaseRef.current[slot] !== 'adding') return;
        fns.current.settleAdd(slot, emptyResultRef.current());
      }, addTimeoutRef.current);
      if (onColdDispatchRef.current) onColdDispatchRef.current(slot, next.item);
    };

    const settleAdd = (workerId: number, result: TResult) => {
      const assigned = slotItemRef.current[workerId];
      if (assigned) {
        resultsRef.current.set(assigned.idx, result);
        setCompleted(resultsRef.current.size);
      }
      freeSlot(workerId);
      if (!tryFinish()) dispatchNext(workerId);
    };

    const injectAdd = (workerId: number) => {
      const assigned = slotItemRef.current[workerId];
      if (!assigned) return;
      slotPhaseRef.current[workerId] = 'adding';
      clearTimer(workerId);
      const runId = runIdRef.current;
      timersRef.current[workerId] = setTimeout(() => {
        timersRef.current[workerId] = null;
        if (runIdRef.current !== runId) return;
        if (slotPhaseRef.current[workerId] !== 'adding') return;
        fns.current.settleAdd(workerId, emptyResultRef.current());
      }, addTimeoutRef.current);
      onInjectAddRef.current(workerId, assigned.item);
    };

    const dispatchSearch = (workerId: number, entry: PresearchItem<TItem>) => {
      slotItemRef.current[workerId] = entry;
      slotPhaseRef.current[workerId] = 'loading';
      setUri(workerId, getUrlRef.current(entry.item));
      setItem(workerId, entry.item);
      clearTimer(workerId);
      const runId = runIdRef.current;
      timersRef.current[workerId] = setTimeout(() => {
        timersRef.current[workerId] = null;
        if (runIdRef.current !== runId) return;
        if (slotPhaseRef.current[workerId] !== 'loading') return;
        if (modeRef.current === 'committing') {
          fns.current.settleAdd(workerId, emptyResultRef.current());
        } else {
          freeSlot(workerId);
        }
      }, searchTimeoutRef.current);
    };

    fns.current = { dispatchSearch, dispatchNext, dispatchColdNext, settleAdd, injectAdd, tryFinish, freeSlot };
  }

  const resetSlots = useCallback(() => {
    for (let i = 0; i < totalSlots; i++) {
      clearTimer(i);
      slotItemRef.current[i] = null;
      slotPhaseRef.current[i] = 'idle';
    }
  }, [totalSlots, clearTimer]);

  const reset = useCallback(() => {
    runIdRef.current++;
    modeRef.current = 'idle';
    queueRef.current = [];
    resultsRef.current = new Map();
    totalRef.current = 0;
    selectedIdxRef.current = new Set();
    onAllDoneRef.current = null;
    resetSlots();
    setIsCommitting(false);
    setCompleted(0);
    setTotal(0);
    setWorkerUris(new Array(totalSlots).fill(''));
    setWorkerItems(new Array(totalSlots).fill(null));
  }, [totalSlots, resetSlots]);

  const start = useCallback(
    (items: PresearchItem<TItem>[]) => {
      runIdRef.current++;
      modeRef.current = 'parking';
      resultsRef.current = new Map();
      totalRef.current = 0;
      selectedIdxRef.current = new Set();
      onAllDoneRef.current = null;
      resetSlots();
      setIsCommitting(false);
      setCompleted(0);
      setTotal(0);
      // Only the parked worker slots pre-search; cold slots stay idle until commit.
      const burst = Math.min(workerCount, items.length);
      queueRef.current = items.slice(burst);
      setWorkerUris(new Array(totalSlots).fill(''));
      setWorkerItems(new Array(totalSlots).fill(null));
      for (let i = 0; i < burst; i++) fns.current.dispatchSearch(i, items[i]);
    },
    [workerCount, totalSlots, resetSlots],
  );

  const reportSearched = useCallback((workerId: number) => {
    if (slotPhaseRef.current[workerId] !== 'loading') return;
    clearTimer(workerId);
    slotPhaseRef.current[workerId] = 'parked';
    if (modeRef.current === 'committing') {
      const assigned = slotItemRef.current[workerId];
      if (assigned && selectedIdxRef.current.has(assigned.idx)) {
        fns.current.injectAdd(workerId);
      } else {
        fns.current.freeSlot(workerId);
        fns.current.dispatchNext(workerId);
      }
    }
  }, [clearTimer]);

  const reportAdded = useCallback((workerId: number, result: TResult) => {
    if (slotPhaseRef.current[workerId] !== 'adding') return;
    fns.current.settleAdd(workerId, result);
  }, []);

  const commit = useCallback(
    (selected: PresearchItem<TItem>[], onAllDone: (r: Map<number, TResult>) => void) => {
      if (modeRef.current === 'committing') return;
      modeRef.current = 'committing';
      onAllDoneRef.current = onAllDone;
      selectedIdxRef.current = new Set(selected.map((s) => s.idx));
      totalRef.current = selected.length;
      resultsRef.current = new Map();
      setCompleted(0);
      setTotal(selected.length);
      setIsCommitting(true);

      if (selected.length === 0) { fns.current.tryFinish(); return; }

      // Which selected idxs is a worker already handling?
      const coveredIdx = new Set<number>();
      for (let w = 0; w < workerCount; w++) {
        const assigned = slotItemRef.current[w];
        const phase = slotPhaseRef.current[w];
        if (assigned && phase !== 'idle') coveredIdx.add(assigned.idx);
      }
      queueRef.current = selected.filter((s) => !coveredIdx.has(s.idx));

      // Resolve every slot — parked workers first, then the idle cold slot(s),
      // which pull overflow from the shared queue via dispatchNext → dispatchColdNext.
      for (let w = 0; w < totalSlots; w++) {
        const assigned = slotItemRef.current[w];
        const phase = slotPhaseRef.current[w];
        if (!assigned || phase === 'idle') {
          fns.current.dispatchNext(w);
          continue;
        }
        const stillSelected = selectedIdxRef.current.has(assigned.idx);
        if (phase === 'parked') {
          if (stillSelected) fns.current.injectAdd(w);
          else { fns.current.freeSlot(w); fns.current.dispatchNext(w); }
        }
        // 'loading' → resolved on reportSearched (commit branch).
        // 'adding' → impossible before commit.
      }
    },
    [workerCount, totalSlots],
  );

  return useMemo(
    () => ({
      workerUris,
      workerItems,
      isCommitting,
      completed,
      total,
      start,
      commit,
      reportSearched,
      reportAdded,
      reset,
    }),
    [workerUris, workerItems, isCommitting, completed, total, start, commit, reportSearched, reportAdded, reset],
  );
}
