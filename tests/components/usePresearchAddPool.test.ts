import { renderHook, act } from '@testing-library/react-native';
import {
  usePresearchAddPool,
  PresearchItem,
  PresearchPoolOptions,
} from '../../src/lib/usePresearchAddPool';

// Exercises the pre-search parking state machine in isolation: park → commit →
// requeue, deselection abandonment, overflow rolling, and post-tap auto-commit.
// The "worker" is simulated by driving reportSearched / reportAdded by hand.

type Item = { name: string };
type Result = { success: boolean; product: string };

const mk = (names: string[]): PresearchItem<Item>[] =>
  names.map((name, idx) => ({ idx, item: { name } }));

function setup(overrides: Partial<PresearchPoolOptions<Item, Result>> = {}) {
  const injected: Array<{ workerId: number; name: string }> = [];
  const opts: PresearchPoolOptions<Item, Result> = {
    workerCount: 2,
    getUrl: (it) => `https://store/search?q=${it.name}`,
    emptyResult: () => ({ success: false, product: '' }),
    onInjectAdd: (workerId, item) => injected.push({ workerId, name: item.name }),
    ...overrides,
  };
  const hook = renderHook(() => usePresearchAddPool<Item, Result>(opts));
  return { hook, injected };
}

describe('usePresearchAddPool', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('parks the initial burst on start and does not add before commit', () => {
    const { hook, injected } = setup();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    expect(hook.result.current.workerUris).toEqual([
      'https://store/search?q=milk',
      'https://store/search?q=eggs',
    ]);
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    // Parked, but no add fired — we haven't tapped add-to-cart yet.
    expect(injected).toHaveLength(0);
    expect(hook.result.current.isCommitting).toBe(false);
  });

  it('commits every parked selected item and finishes when all report added', () => {
    const { hook, injected } = setup();
    const done = jest.fn();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs']), done));

    expect(injected).toEqual([
      { workerId: 0, name: 'milk' },
      { workerId: 1, name: 'eggs' },
    ]);
    expect(hook.result.current.total).toBe(2);

    act(() => hook.result.current.reportAdded(0, { success: true, product: 'Milk 1gal' }));
    expect(done).not.toHaveBeenCalled();
    expect(hook.result.current.completed).toBe(1);

    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs 12' }));
    expect(done).toHaveBeenCalledTimes(1);
    const map: Map<number, Result> = done.mock.calls[0][0];
    expect(map.get(0)).toEqual({ success: true, product: 'Milk 1gal' });
    expect(map.get(1)).toEqual({ success: true, product: 'Eggs 12' });
  });

  it('abandons a parked item that was deselected before the tap', () => {
    const { hook, injected } = setup();
    const done = jest.fn();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    // User unchecked "milk" (idx 0); only "eggs" (idx 1) is committed.
    act(() => hook.result.current.commit([{ idx: 1, item: { name: 'eggs' } }], done));

    expect(injected).toEqual([{ workerId: 1, name: 'eggs' }]);
    expect(hook.result.current.total).toBe(1);

    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs 12' }));
    expect(done).toHaveBeenCalledTimes(1);
    const map: Map<number, Result> = done.mock.calls[0][0];
    expect(map.has(0)).toBe(false);
    expect(map.get(1)).toEqual({ success: true, product: 'Eggs 12' });
  });

  it('rolls overflow items onto workers after commit and auto-commits them', () => {
    const { hook, injected } = setup();
    const done = jest.fn();
    // 3 items, 2 workers: milk+eggs park, bread waits in queue.
    act(() => hook.result.current.start(mk(['milk', 'eggs', 'bread'])));
    expect(hook.result.current.workerUris).toEqual([
      'https://store/search?q=milk',
      'https://store/search?q=eggs',
    ]);
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs', 'bread']), done));
    // Parked pair commits immediately; bread still queued.
    expect(injected).toEqual([
      { workerId: 0, name: 'milk' },
      { workerId: 1, name: 'eggs' },
    ]);

    // Worker 0 finishes milk → pulls bread → searches it.
    act(() => hook.result.current.reportAdded(0, { success: true, product: 'Milk' }));
    expect(hook.result.current.workerUris[0]).toBe('https://store/search?q=bread');

    // Bread parks post-tap → auto-commits without another tap.
    act(() => hook.result.current.reportSearched(0));
    expect(injected).toContainEqual({ workerId: 0, name: 'bread' });

    act(() => hook.result.current.reportAdded(0, { success: true, product: 'Bread' }));
    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs' }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(hook.result.current.completed).toBe(3);
  });

  it('records a synthetic miss when a commit add times out', () => {
    const { hook } = setup({ addTimeoutMs: 1000 });
    const done = jest.fn();
    act(() => hook.result.current.start(mk(['milk'])));
    act(() => hook.result.current.reportSearched(0));
    act(() => hook.result.current.commit(mk(['milk']), done));
    // No reportAdded — let the add timeout fire.
    act(() => jest.advanceTimersByTime(1001));
    expect(done).toHaveBeenCalledTimes(1);
    const map: Map<number, Result> = done.mock.calls[0][0];
    expect(map.get(0)).toEqual({ success: false, product: '' });
  });

  it('reset clears worker uris and cancels the run', () => {
    const { hook } = setup();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => hook.result.current.reset());
    expect(hook.result.current.workerUris).toEqual(['', '']);
    expect(hook.result.current.isCommitting).toBe(false);
    expect(hook.result.current.total).toBe(0);
  });
});

describe('usePresearchAddPool — cold slot (main WebView as extra worker)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function setupCold() {
    const injected: Array<{ workerId: number; name: string }> = [];
    const cold: Array<{ slot: number; name: string }> = [];
    const opts: PresearchPoolOptions<Item, Result> = {
      workerCount: 2,      // parked slots 0,1
      coldWorkerCount: 1,  // cold slot 2 (the main WebView)
      getUrl: (it) => `https://store/search?q=${it.name}`,
      emptyResult: () => ({ success: false, product: '' }),
      onInjectAdd: (workerId, item) => injected.push({ workerId, name: item.name }),
      onColdDispatch: (slot, item) => cold.push({ slot, name: item.name }),
    };
    const hook = renderHook(() => usePresearchAddPool<Item, Result>(opts));
    return { hook, injected, cold };
  }

  it('does not park the cold slot on start', () => {
    const { hook, cold } = setupCold();
    act(() => hook.result.current.start(mk(['milk', 'eggs', 'bread'])));
    // Slots 0,1 parked; slot 2 (cold) stays idle; bread waits in the queue.
    expect(hook.result.current.workerUris[0]).toBe('https://store/search?q=milk');
    expect(hook.result.current.workerUris[1]).toBe('https://store/search?q=eggs');
    expect(hook.result.current.workerUris[2]).toBe('');
    expect(cold).toHaveLength(0);
  });

  it('the cold slot pulls overflow at commit and keeps pulling as it finishes', () => {
    const { hook, injected, cold } = setupCold();
    const done = jest.fn();
    // 4 items, 2 parked + 1 cold: milk/eggs park; bread/butter overflow.
    act(() => hook.result.current.start(mk(['milk', 'eggs', 'bread', 'butter'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs', 'bread', 'butter']), done));

    // Parked pair commits in place; the cold slot immediately grabs one overflow item.
    expect(injected).toEqual([
      { workerId: 0, name: 'milk' },
      { workerId: 1, name: 'eggs' },
    ]);
    expect(cold).toEqual([{ slot: 2, name: 'bread' }]);
    expect(hook.result.current.workerUris[2]).toBe('https://store/search?q=bread');

    // Cold slot finishes bread → pulls the next overflow item (butter).
    act(() => hook.result.current.reportAdded(2, { success: true, product: 'Bread' }));
    expect(cold).toEqual([{ slot: 2, name: 'bread' }, { slot: 2, name: 'butter' }]);

    // Everything reports in → done, and the cold slot frees (uri cleared).
    act(() => {
      hook.result.current.reportAdded(0, { success: true, product: 'Milk' });
      hook.result.current.reportAdded(1, { success: true, product: 'Eggs' });
      hook.result.current.reportAdded(2, { success: true, product: 'Butter' });
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(hook.result.current.completed).toBe(4);
    expect(hook.result.current.workerUris[2]).toBe('');
  });

  it('leaves the cold slot idle when there is no overflow', () => {
    const { hook, cold } = setupCold();
    const done = jest.fn();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs']), done));
    expect(cold).toHaveLength(0);
    expect(hook.result.current.workerUris[2]).toBe('');
  });
});

// ── MEAL-122: the pool's reporting seam ─────────────────────────────────────
//
// Same contract as useParallelSearchPool's onSettled, over a state machine with
// more ways for an item to end: committed and reported, committed and timed out,
// parked-but-still-loading when the tap came, deselected, or never committed at
// all. Only the first two are add attempts; the funnel must count those and no
// others.
describe('usePresearchAddPool — onSettled', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  type Settled = { workerId: number; itemIndex: number; result: Result; timedOut: boolean; addDispatched: boolean };

  function setupSettled(overrides: Partial<PresearchPoolOptions<Item, Result>> = {}) {
    const settled: Settled[] = [];
    const { hook, injected } = setup({ onSettled: (i) => settled.push(i as Settled), ...overrides });
    return { hook, injected, settled };
  }

  it('does not fire during the park phase — nothing has been added yet', () => {
    const { hook, settled } = setupSettled();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    expect(settled).toEqual([]);
  });

  it('fires once per committed item, carrying the item index and not the slot', () => {
    const { hook, settled } = setupSettled();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs']), () => {}));
    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs' }));
    act(() => hook.result.current.reportAdded(0, { success: false, product: '' }));
    expect(settled).toEqual([
      { workerId: 1, itemIndex: 1, result: { success: true, product: 'Eggs' }, timedOut: false, addDispatched: true },
      { workerId: 0, itemIndex: 0, result: { success: false, product: '' }, timedOut: false, addDispatched: true },
    ]);
  });

  it('fires for an add that timed out, flagged as timed out AND dispatched', () => {
    const { hook, settled } = setupSettled({ addTimeoutMs: 1000 });
    act(() => hook.result.current.start(mk(['milk'])));
    act(() => hook.result.current.reportSearched(0));
    act(() => hook.result.current.commit(mk(['milk']), () => {}));
    act(() => jest.advanceTimersByTime(1001));
    // The add WAS injected here — the page just never answered. Contrast with
    // the park-timeout case below, which is the one that must not be counted.
    expect(settled).toEqual([
      { workerId: 0, itemIndex: 0, result: { success: false, product: '' }, timedOut: true, addDispatched: true },
    ]);
  });

  it('reports an item whose park timed out as NOT dispatched — no add ever reached it', () => {
    // The tap came before this item's results page did, so injectAdd never ran.
    // It still settles (the result map must be complete), but calling it an add
    // attempt put an item nobody tried to add into the confirm-rate denominator.
    const { hook, injected, settled } = setupSettled({ searchTimeoutMs: 1000, addTimeoutMs: 9000 });
    act(() => hook.result.current.start(mk(['milk'])));
    act(() => hook.result.current.commit(mk(['milk']), () => {}));
    act(() => jest.advanceTimersByTime(1001));
    expect(injected).toEqual([]);   // the proof: no add script was ever injected
    expect(settled).toEqual([
      { workerId: 0, itemIndex: 0, result: { success: false, product: '' }, timedOut: true, addDispatched: false },
    ]);
  });

  it('fires before onAllDone, so per-item rows precede the run terminal rows', () => {
    // The one ordering constraint the seam's placement actually carries. Moving
    // notifySettled below tryFinish would put an item's rows after the reconcile
    // and run_summary of the run that produced it.
    const order: string[] = [];
    const { hook } = setup({
      onSettled: (i) => order.push(`settled:${i.itemIndex}`),
    });
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs']), () => order.push('allDone')));
    act(() => hook.result.current.reportAdded(0, { success: true, product: 'Milk' }));
    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs' }));
    expect(order).toEqual(['settled:0', 'settled:1', 'allDone']);
  });

  it('fires before onAllDone on the timeout path too', () => {
    const order: string[] = [];
    const { hook } = setup({
      addTimeoutMs: 1000,
      onSettled: (i) => order.push(`settled:${i.itemIndex}`),
    });
    act(() => hook.result.current.start(mk(['milk'])));
    act(() => hook.result.current.reportSearched(0));
    act(() => hook.result.current.commit(mk(['milk']), () => order.push('allDone')));
    act(() => jest.advanceTimersByTime(1001));
    expect(order).toEqual(['settled:0', 'allDone']);
  });

  it('does not fire for an item deselected before the tap', () => {
    // Nobody attempted it, so it belongs on neither side of the confirm rate.
    const { hook, settled } = setupSettled();
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit([{ idx: 1, item: { name: 'eggs' } }], () => {}));
    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs' }));
    expect(settled).toEqual([
      { workerId: 1, itemIndex: 1, result: { success: true, product: 'Eggs' }, timedOut: false, addDispatched: true },
    ]);
  });

  it('does not fire for a run cancelled by reset()', () => {
    const { hook, settled } = setupSettled({ addTimeoutMs: 1000 });
    act(() => hook.result.current.start(mk(['milk'])));
    act(() => hook.result.current.reportSearched(0));
    act(() => hook.result.current.commit(mk(['milk']), () => {}));
    act(() => hook.result.current.reset());
    act(() => jest.advanceTimersByTime(5000));
    expect(settled).toEqual([]);
  });

  it('fires for the cold slot too, keyed to the overflow item it pulled', () => {
    const injected: Array<{ workerId: number; name: string }> = [];
    const settled: Settled[] = [];
    const opts: PresearchPoolOptions<Item, Result> = {
      workerCount: 2,
      coldWorkerCount: 1,
      getUrl: (it) => `https://store/search?q=${it.name}`,
      emptyResult: () => ({ success: false, product: '' }),
      onInjectAdd: (workerId, item) => injected.push({ workerId, name: item.name }),
      onColdDispatch: () => {},
      onSettled: (i) => settled.push(i as Settled),
    };
    const hook = renderHook(() => usePresearchAddPool<Item, Result>(opts));
    act(() => hook.result.current.start(mk(['milk', 'eggs', 'bread'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs', 'bread']), () => {}));
    act(() => hook.result.current.reportAdded(2, { success: false, product: '' }));
    expect(settled).toEqual([
      { workerId: 2, itemIndex: 2, result: { success: false, product: '' }, timedOut: false, addDispatched: true },
    ]);
  });

  it('keeps committing when the caller throws', () => {
    const done = jest.fn();
    const { hook } = setup({ onSettled: () => { throw new Error('reporter blew up'); } });
    act(() => hook.result.current.start(mk(['milk', 'eggs'])));
    act(() => { hook.result.current.reportSearched(0); hook.result.current.reportSearched(1); });
    act(() => hook.result.current.commit(mk(['milk', 'eggs']), done));
    act(() => hook.result.current.reportAdded(0, { success: true, product: 'Milk' }));
    act(() => hook.result.current.reportAdded(1, { success: true, product: 'Eggs' }));
    expect(done).toHaveBeenCalledTimes(1);
    const map: Map<number, Result> = done.mock.calls[0][0];
    expect(map.get(0)).toEqual({ success: true, product: 'Milk' });
    expect(map.get(1)).toEqual({ success: true, product: 'Eggs' });
  });
});
