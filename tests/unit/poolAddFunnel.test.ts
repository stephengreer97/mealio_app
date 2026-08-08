import {
  AutomationTelemetry,
  StepRecord,
} from '../../src/lib/automation-telemetry';
import { confirmDetail, presearchAddDispatched, recordPoolAdd } from '../../src/lib/pool-add-funnel';
import type { PoolSettled } from '../../src/lib/useParallelSearchPool';
import type { PoolAddResult } from '../../src/lib/pool-add-funnel';

// MEAL-122 cold review. Everything here is ATTRIBUTION — which item, which slot,
// which pool, did we actually try to add it. The failure mode is not a missing
// row, it is a row that exists and points at the wrong thing, which is precisely
// the defect this ticket exists to prevent. That class survived the first round
// because the tests asserted against an inline re-implementation of this mapping
// rather than the mapping itself; transposing workerId and itemIndex left the
// whole suite green.
//
// So: the real function, a real recorder, and assertions on the batch the upload
// function received.

const live: AutomationTelemetry[] = [];
afterEach(async () => {
  const pending = live.splice(0, live.length);
  await Promise.all(pending.map((t) => t.dispose().catch(() => {})));
});

/** Run one settle through the real mapping and return the rows the server saw. */
async function rowsFor(
  path: 'parallel_add' | 'presearch',
  info: PoolSettled<PoolAddResult>,
): Promise<StepRecord[]> {
  const batches: StepRecord[][] = [];
  const tel = new AutomationTelemetry({
    runId: 'run-1',
    upload: async (b) => { batches.push(b.steps); return true; },
    batchSize: 1000,
    flushIntervalMs: 60_000,
  });
  live.push(tel);
  recordPoolAdd(tel, path, info);
  await tel.flush();
  return batches.flat();
}

const settled = (over: Partial<PoolSettled<PoolAddResult>> = {}): PoolSettled<PoolAddResult> => ({
  workerId: 3,
  itemIndex: 7,
  result: { success: true, reason: null },
  timedOut: false,
  addDispatched: true,
  ...over,
});

describe('recordPoolAdd — attribution', () => {
  it('puts the ITEM index on itemIndex and the SLOT id in detail, not the reverse', () => {
    // Distinct values on purpose. Transposed, every pool row in the funnel points
    // at the wrong item, and nothing downstream can tell.
    return rowsFor('parallel_add', settled({ workerId: 3, itemIndex: 7 })).then((rows) => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.itemIndex).toBe(7);
        expect((row.detail as Record<string, unknown>).workerId).toBe(3);
      }
    });
  });

  it('tags each pool with its own path', async () => {
    const parallel = await rowsFor('parallel_add', settled());
    const presearch = await rowsFor('presearch', settled());
    expect(parallel.every((r) => (r.detail as Record<string, unknown>).path === 'parallel_add')).toBe(true);
    expect(presearch.every((r) => (r.detail as Record<string, unknown>).path === 'presearch')).toBe(true);
  });

  it('carries timedOut through, so a silent worker reads as a timeout not an error', async () => {
    // The code is `timeout` either way (ADD_REASON_CODES maps the reason), so
    // dropping the flag changes only the OUTCOME — which is the field that says
    // whether anyone answered at all.
    const rows = await rowsFor('parallel_add', settled({
      result: { success: false, reason: 'timeout' }, timedOut: true,
    }));
    expect(rows.map((r) => [r.step, r.outcome])).toEqual([
      ['add_click', 'ok'],
      ['confirm', 'timeout'],
    ]);
  });

  it('carries addDispatched through, so an item nobody tried to add is not an attempt', async () => {
    const rows = await rowsFor('presearch', settled({
      result: { success: false, reason: 'timeout' }, timedOut: true, addDispatched: false,
    }));
    expect(rows.map((r) => r.step)).toEqual(['search']);
    expect(rows[0].itemIndex).toBe(7);
  });

  it('flattens the cart verdict onto the confirm row, all the way to the server', async () => {
    // sanitizeDetail drops nested objects, so a confirm passed through unflattened
    // would vanish between here and the upload without anything failing.
    const rows = await rowsFor('parallel_add', settled({
      result: {
        success: true,
        reason: null,
        confirm: { via: 'cart_sku', state: 'present', reason: 'matched', skuId: 'SKU-9' } as never,
      },
    }));
    expect(rows[1].detail).toEqual({
      attempt: 1,
      path: 'parallel_add',
      workerId: 3,
      confirmVia: 'cart_sku',
      confirmState: 'present',
      confirmWhy: 'matched',
      confirmSku: 'SKU-9',
    });
  });

  it('maps a reported failure to its code and keeps the raw reason', async () => {
    const rows = await rowsFor('presearch', settled({
      result: { success: false, reason: 'out_of_stock' },
    }));
    expect(rows.map((r) => [r.step, r.outcome, r.code])).toEqual([
      ['add_click', 'ok', undefined],
      ['confirm', 'error', 'match_rejected'],
    ]);
    expect(rows[1].detail).toEqual({
      attempt: 1, path: 'presearch', workerId: 3, reason: 'out_of_stock',
    });
  });
});

// MEAL-122 confirming review. The park-timeout fix left a narrower version of the
// same bug alive on the pre-search pool's COLD slot: dispatchColdNext puts it in
// phase 'adding' at DISPATCH, before its page loads, so the pool reports
// addDispatched:true for an item the component never injected an add into. The
// pool cannot see that — the injection happens in onLoadEnd — so the caller
// corrects it here.
describe('presearchAddDispatched', () => {
  const COLD = 3;

  it('trusts the pool for a parked worker', () => {
    for (const flag of [true, false]) {
      expect(presearchAddDispatched(
        { workerId: 1, addDispatched: flag }, { slotId: COLD, injected: !flag },
      )).toBe(flag);
    }
  });

  it('overrides the pool for the cold slot, which is what the pool gets wrong', () => {
    // The bug's exact shape: pool says dispatched, nothing was ever injected.
    expect(presearchAddDispatched(
      { workerId: COLD, addDispatched: true }, { slotId: COLD, injected: false },
    )).toBe(false);
  });

  it('still counts a cold item whose add WAS injected', () => {
    // The correction must not swing the other way and drop real attempts out of
    // the denominator — under-counting reads the confirm rate high.
    expect(presearchAddDispatched(
      { workerId: COLD, addDispatched: true }, { slotId: COLD, injected: true },
    )).toBe(true);
  });

  it('produces a search row, not an add attempt, for an uninjected cold item', async () => {
    // End to end through the real mapping, on the rows the server would receive.
    const info = settled({ workerId: COLD, itemIndex: 2, timedOut: true, addDispatched: true,
      result: { success: false, reason: 'timeout' } });
    const rows = await rowsFor('presearch', {
      ...info,
      addDispatched: presearchAddDispatched(info, { slotId: COLD, injected: false }),
    });
    expect(rows.map((r) => [r.step, r.outcome, r.code])).toEqual([['search', 'timeout', 'timeout']]);
    expect(rows[0].itemIndex).toBe(2);
  });
});

describe('confirmDetail', () => {
  it('is empty when no rail ran, so an absent confirmVia means the DOM decided', () => {
    expect(confirmDetail(null)).toEqual({});
    expect(confirmDetail(undefined)).toEqual({});
  });

  it('keeps only scalars, which is what survives sanitizeDetail', () => {
    const out = confirmDetail({ via: 'badge', state: 'absent', reason: null, productId: 'P1' } as never);
    expect(out).toEqual({
      confirmVia: 'badge', confirmState: 'absent', confirmWhy: undefined, confirmSku: 'P1',
    });
    expect(Object.values(out).every((v) => v === undefined || typeof v !== 'object')).toBe(true);
  });
});
