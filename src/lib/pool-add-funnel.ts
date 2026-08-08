// The cart sheet's side of MEAL-122: turning one worker pool's settled item into
// the funnel rows for it.
//
// This lives here rather than inline in WebViewCartSheet for a testing reason
// that is the ticket's own point. The mapping is almost all attribution — which
// item, which slot, which pool, did we actually try — and the failures it can
// have are not "no row" but "a row attributed to the wrong thing", which is
// exactly what MEAL-122 exists to prevent. Inline in the component it was
// reachable only by rendering the whole sheet (login_check, the qty screen, a
// mocked WebView's onMessage), so the tests had to re-implement it and assert
// against their own copy — which proves nothing about the copy that runs.
// Extracted, a test calls the real thing with a real recorder.

import {
  AutomationTelemetry,
  recordPoolAddOutcome,
} from './automation-telemetry';
import type { PoolSettled } from './useParallelSearchPool';
import type { HebAddConfirmation } from './webview-scripts/heb-cart-query';

/** Which pool produced a row. Splits the funnel by add path — and is the only
 *  thing separating two rows that share an itemIndex (see StepRecord.itemIndex). */
export type PoolAddPath = 'parallel_add' | 'presearch';

/** The part of the engine's AddResult this needs. Structural on purpose: the
 *  full type carries product names and candidate lists that have no business in
 *  telemetry. */
export interface PoolAddResult {
  success: boolean;
  reason: string | null;
  /** MEAL-14: the cart's own verdict, when the store has a cart query we can
   *  read. Null = no verdict, NOT a negative one. */
  confirm?: HebAddConfirmation | null;
}

/**
 * A cart verdict flattened into telemetry `detail` scalars (sanitizeDetail drops
 * nested objects, so a nested confirm would vanish silently). Empty when no rail
 * ran — an absent `confirmVia` in the funnel means the DOM decided, which is a
 * different row from a cart that answered.
 */
export function confirmDetail(confirm: HebAddConfirmation | null | undefined): Record<string, unknown> {
  if (!confirm) return {};
  return {
    confirmVia: confirm.via,
    confirmState: confirm.state,
    confirmWhy: confirm.reason ?? undefined,
    confirmSku: confirm.skuId ?? confirm.productId ?? undefined,
  };
}

/** What the component knows about the pre-search pool's COLD slot: which slot it
 *  is, and whether the fused add has actually been injected into it. */
export interface ColdSlotState {
  slotId: number;
  /** The component's mainColdInjectedRef — set at the moment onLoadEnd injects. */
  injected: boolean;
}

/**
 * Whether a pre-search settle really had an add dispatched to it.
 *
 * The pool's own answer is right for every PARKED worker: those go to phase
 * 'adding' inside injectAdd, so the phase is the injection. It is wrong for the
 * COLD slot (the main WebView enlisted as an extra add surface), which
 * dispatchColdNext puts in phase 'adding' at DISPATCH — before its page has even
 * loaded. The injection happens later, from the component's onLoadEnd. So a cold
 * slot whose page never loads settles as phase 'adding' with nothing injected,
 * and reported the exact defect MEAL-122's review caught on the park path: an
 * item nobody tried to add, counted in the confirm-rate denominator.
 *
 * The pool cannot know this — the fact lives in the component, which owns both
 * the WebView and the injection. So the component supplies it here rather than
 * the comment on PoolSettled.addDispatched being softened to admit an exception.
 * The same answer also covers onColdDispatch's `!getSearchUrl` early exit, where
 * no navigation happens at all.
 */
export function presearchAddDispatched(
  info: Pick<PoolSettled<unknown>, 'workerId' | 'addDispatched'>,
  cold: ColdSlotState,
): boolean {
  return info.workerId === cold.slotId ? cold.injected : info.addDispatched;
}

/**
 * Record the funnel rows for one item a worker pool has settled.
 *
 * Bound to the pools through their generic onSettled seam rather than to the
 * WORKER_RESULT handlers, because a worker that never answers sends no message —
 * and that item is precisely the one the funnel most needs to show. The pool's
 * own timeout is the only thing that settles it.
 *
 * See recordPoolAddOutcome for which rows come out, why both add halves are
 * emitted at settle, and why an item whose add was never dispatched gets a
 * `search` row instead of entering the confirm-rate denominator.
 */
export function recordPoolAdd(
  tel: AutomationTelemetry,
  path: PoolAddPath,
  info: PoolSettled<PoolAddResult>,
): void {
  recordPoolAddOutcome(tel, {
    path,
    workerId: info.workerId,
    itemIndex: info.itemIndex,
    success: !!info.result.success,
    reason: info.result.reason,
    timedOut: info.timedOut,
    addDispatched: info.addDispatched,
    // MEAL-14's cart verdict, flattened — sanitizeDetail keeps scalars only.
    detail: confirmDetail(info.result.confirm),
  });
}
