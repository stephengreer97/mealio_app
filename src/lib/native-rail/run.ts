/**
 * THE RUN, OVER THE NETWORK, WITH NO RENDERER.
 *
 * Stephen, 2026-09-11: "I want the same general logic, I just want it to be done
 * without a webview and just 100% over network instead."
 *
 * That sentence is the whole design. The rails have ALWAYS been 100% network --
 * every one of them is fetch() against the store's own gateway. The WebView was
 * never supplying the requests, only the ORIGIN they went from. So nothing about
 * what a run DECIDES changes here: the ~320 lines of decision logic in the cart
 * sheet are untouched, and a driver below posts exactly the messages the
 * injected script would have posted. The sheet cannot tell which side of the
 * bridge answered, which is the property that makes this revertible.
 *
 * WHAT THE DRIVERS MUST NOT DO is decide anything. A driver asks the store,
 * shapes the answer the way its injected twin shapes it, and posts. Every
 * judgement -- which candidate, how many, whether to review -- stays where it
 * already is.
 *
 * WHY THIS IS NOT A SECOND ENGINE. The retry policy, the backoff and the
 * NET_REQUEST telemetry are the SAME TypeScript that _retry.ts emits as script
 * text; this file imports those predicates rather than restating them, so the
 * two transports cannot drift on the one thing they must agree about.
 */
import {
  RETRY_ATTEMPTS, RETRY_EXTRA_BUDGET_MS, isRetriable, retryDelayMs,
} from '../webview-scripts/_retry';
import type { NetworkAddItem, NetworkSession } from '../webview-scripts/network-rail';

/**
 * A message going back to the sheet, in the shape the injected script posts.
 *
 * Deliberately untyped beyond this. The message vocabulary is the injected
 * scripts' -- SEARCH_RESULT, CART_COUNT, NET_ADD_DONE and the rest -- and
 * declaring it here would be a second, drifting copy of a contract whose only
 * real definition is the sheet's onMessage.
 */
export type PostToSheet = (msg: Record<string, unknown>) => void;

/** One attempt's answer, in the shape every rail's transport already uses. */
export type Attempt<T = unknown> = {
  ok: boolean;
  status?: number | null;
  why?: string | null;
  detail?: string | null;
  code?: string | null;
  aborted?: boolean;
  data?: T;
  ms?: number;
  retries?: number;
  partialErrors?: number;
};

// ── stopping ────────────────────────────────────────────────────────────────
//
// THE SAME GENERATION COUNTER, on this side of the bridge. __mealioStop bumps a
// number that every injected batch loop reads between terms; a native batch
// reads this one in the same places, for the same reason, and nothing that has
// already been posted is discarded. See _retry.ts for why it is a generation
// and not a boolean.

let generation = 0;
const inFlight: AbortController[] = [];

/** The generation to capture at the top of a batch. */
export function nativeGen(): number {
  return generation;
}

/**
 * Register a controller so a stop reaches the request that is ALREADY out.
 *
 * Not unregistered on completion, for the reason the injected copy is not:
 * aborting a settled controller is a no-op, so a stale entry is harmless, and
 * the list is capped rather than pruned.
 */
export function nativeTrack(ctl: AbortController): AbortController {
  inFlight.push(ctl);
  if (inFlight.length > 64) inFlight.splice(0, inFlight.length - 64);
  return ctl;
}

/** Bump the generation and abort what is on the wire. Returns how many. */
export function nativeStop(): number {
  generation += 1;
  const list = inFlight.splice(0, inFlight.length);
  for (const c of list) { try { c.abort(); } catch { /* already gone */ } }
  return list.length;
}

/** Tests only. A module-level counter outlives a test file otherwise. */
export function __resetNativeRunForTests(): void {
  generation = 0;
  inFlight.length = 0;
}

// ── one request ─────────────────────────────────────────────────────────────

/**
 * Fetch with a deadline, tracked so a stop can reach it.
 *
 * Returns the same `{ ok, why, status }` families the injected transports
 * return, because that is what isRetriable() classifies. `no_response` covers
 * both a throw and an expired budget, and `aborted` is what tells them apart --
 * the distinction _retry.ts needs and that only the caller can supply.
 */
export async function nativeAttempt(
  url: string,
  init: RequestInit,
  budgetMs: number,
): Promise<Attempt<string> & { status: number | null }> {
  const ctl = nativeTrack(new AbortController());
  const timer = setTimeout(() => { try { ctl.abort(); } catch { /* gone */ } }, budgetMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { credentials: 'include', ...init, signal: ctl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text, ms: Date.now() - t0,
             why: res.ok ? null : 'http' };
  } catch (e) {
    const aborted = !!(e && (e as Error).name === 'AbortError');
    return {
      ok: false, status: null, why: 'no_response', aborted,
      detail: String(e).slice(0, 120), ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The retry policy, applied to a native attempt.
 *
 * A straight port of __mealioRetry, over the SAME predicates -- isRetriable and
 * retryDelayMs are imported, not restated. It reports every request exactly
 * where the injected copy reports it, so a native run's NET_REQUEST rows are
 * indistinguishable from an injected run's and the funnel needs no new
 * vocabulary.
 */
export async function nativeRetry<T>(
  attemptFn: (attempt: number) => Promise<Attempt<T>>,
  opts: { phase: string; op: string; post: PostToSheet; attempts?: number; extraBudgetMs?: number },
): Promise<Attempt<T>> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const budget = opts.extraBudgetMs ?? RETRY_EXTRA_BUDGET_MS;
  const startedAt = Date.now();
  let last: Attempt<T> = { ok: false, why: 'network' };
  let tries = 0;
  for (let i = 1; i <= attempts; i += 1) {
    tries = i;
    last = await attemptFn(i);
    if (last && last.ok) {
      if (i > 1) last.retries = i - 1;
      break;
    }
    if (i >= attempts) break;
    if (!isRetriable(last)) break;
    const delay = retryDelayMs(i, last);
    if (Date.now() - startedAt + delay > budget) break;
    await new Promise((r) => { setTimeout(r, delay); });
  }
  if (last && typeof last === 'object') last.retries = last.retries ?? 0;
  // EVERY REQUEST REPORTS ITSELF (MEAL-219), and it must never cost one.
  try {
    opts.post({
      type: 'NET_REQUEST',
      phase: opts.phase,
      op: opts.op,
      status: typeof last?.status === 'number' ? last.status : null,
      why: last && !last.ok && last.why ? String(last.why).slice(0, 40) : null,
      attempts: tries,
      ms: Date.now() - startedAt,
    });
  } catch { /* telemetry is not allowed to cost a request */ }
  return last;
}

/** Parse a body the way every rail parses one: a throw is an answer, not a crash. */
export function parseJson(text: string | undefined): unknown | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── the driver ──────────────────────────────────────────────────────────────

/**
 * One store's run, natively.
 *
 * EVERY METHOD RETURNS A THUNK OR NULL, and the shape is not arbitrary: it is
 * the same shape the injected rails already have. `searchBatch` returns
 * `string | null` -- a script, or null when this store cannot build one -- and
 * the sheet's call sites are written around that: build, check for null, set
 * up the phase, then send. A driver that answered by simply running would have
 * forced those call sites to reorder, which is exactly the change Stephen ruled
 * out. So null still means "cannot", and the thunk is the send.
 */
export type NativeRunDriver = {
  /** The store id this driver serves, for the log line that says which answered. */
  id: string;
  session(storeId: string | null): ((post: PostToSheet) => Promise<void>) | null;
  cartRead(storeId: string | null): ((post: PostToSheet) => Promise<void>) | null;
  searchBatch(
    terms: string[], sess: NetworkSession,
  ): ((post: PostToSheet) => Promise<void>) | null;
  addBatch(
    items: NetworkAddItem[],
    opts: { knownLines?: Record<string, number> | null; absoluteQty?: boolean | null },
  ): ((post: PostToSheet) => Promise<void>) | null;
};

/**
 * Wrap a driver body so a throw becomes a posted failure rather than an
 * unhandled rejection.
 *
 * The injected scripts each carry their own try/catch around the whole body and
 * post a terminal message from it -- SEARCH_BATCH_DONE with `threw`,
 * NET_ADD_DONE with `wrote: 0`. A native driver that threw would instead reject
 * a promise nobody awaits, the sheet would hear nothing at all, and the phase
 * budget would be the only thing that ended the run. `onThrow` is what each
 * driver's own terminal message is.
 */
export async function guarded(
  body: () => Promise<void>,
  onThrow: (detail: string) => void,
): Promise<void> {
  try {
    await body();
  } catch (e) {
    onThrow(String(e).slice(0, 140));
  }
}
