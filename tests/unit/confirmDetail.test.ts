import { confirmDetail } from '../../src/lib/cart-confirmation';

// confirmDetail is all that survived lib/pool-add-funnel. The rest of that module
// — recordPoolAdd's per-item attribution and presearchAddDispatched's cold-slot
// bookkeeping — described the DOM worker pools, which were deleted on
// 2026-09-01. This flattens a cart verdict into telemetry scalars and moved to
// live beside the type it flattens.

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
