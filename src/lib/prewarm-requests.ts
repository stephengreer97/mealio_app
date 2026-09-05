// Request rows the PREWARM produced, held until a run can record them.
//
// MEAL-219, found on the Pixel. A run whose searches were prewarmed produced
// six request rows and not one of them was a `search`: the prewarm does its
// searching in SilentSearchProbe, a different WebView with its own onMessage,
// and that handler had never heard of NET_REQUEST. So the statuses for the most
// interesting phase of the run were computed, posted, and dropped on the floor
// — while the dashboard showed a tidy session/cart_read/add breakdown that
// looked complete.
//
// They cannot simply be recorded where they happen: telemetry is keyed to a
// RUN, and the prewarm deliberately runs before there is one (that is the whole
// point of it). So they are buffered here and drained by the run that benefits
// from them.
//
// A module-level buffer rather than context, because both ends are already
// module-level singletons — the probe posts from a callback and the sheet
// drains from an effect — and threading a provider between them would be
// ceremony around a list.

export type PrewarmRequest = {
  storeId: string;
  phase?: string | null;
  op?: string | null;
  status?: number | null;
  why?: string | null;
  attempts?: number | null;
  ms?: number | null;
};

/**
 * Bounded, and dropping the OLDEST.
 *
 * A prewarm that runs several times before a run starts — the user browsing
 * stores — must not grow this without limit. The newest rows are the ones the
 * run about to start will actually be about.
 */
const MAX_BUFFERED = 200;

let buffer: PrewarmRequest[] = [];

export function recordPrewarmRequest(row: PrewarmRequest): void {
  buffer.push(row);
  if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(-MAX_BUFFERED);
}

/**
 * Take the rows for one store, leaving the rest.
 *
 * DRAINED, not read: a row recorded twice is a request that never happened, and
 * the retry-rate denominator is the first thing that would quietly wrong.
 * Filtered by store because the prewarm probes whichever store the user is
 * looking at, which is not always the store they then run.
 */
export function drainPrewarmRequests(storeId: string): PrewarmRequest[] {
  const mine = buffer.filter((r) => r.storeId === storeId);
  buffer = buffer.filter((r) => r.storeId !== storeId);
  return mine;
}

/** For tests, and for a sign-out: another account's prewarm is not ours. */
export function clearPrewarmRequests(): void {
  buffer = [];
}
