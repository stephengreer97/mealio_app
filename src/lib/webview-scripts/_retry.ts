// Retrying the requests that are worth retrying, and only those.
//
// Stephen, 2026-09-04: "If we get a 5xx we should rety a couple times with some
// buffer. For everything else, decide if we are doing the optimal path."
//
// The decision this file encodes is WHICH failures are worth a second ask. The
// test is not "did it fail" but "would asking again plausibly get a different
// answer". Three families come out of that:
//
//   RETRY   The store broke, not us. A 5xx, a 429, a fetch that threw, a body
//           that was not JSON. Nothing about the request was wrong, so the same
//           request is a legitimate thing to send again.
//   NEVER   The store answered, and the answer was a real one -- a GraphQL
//           error, a 400, a 404, an out-of-stock. Asking again spends a request
//           to be told the same thing. These belong on the review screen.
//   NEVER   The wall (403) and the rate-limit challenge. Measured self-healing
//           in 71-84 s (MEAL-16), which is two orders of magnitude past any
//           backoff worth sitting through. The challenge screen owns these.
//
// TIMEOUTS ARE NOT RETRIED, and that is the load-bearing choice here. A request
// that aborted already spent its entire per-request budget; retrying it doubles
// the worst case for the whole batch, and on the add path it is ambiguous --
// the write may well have landed, and a blind second write is how you buy two
// of something. It also makes the cost of this file almost nothing: every
// retriable failure is a FAST failure, so two retries cost the backoff and not
// the budget. A 500 that comes back in 200 ms turns into 1.8 s, not 24 s.
//
// The injected copy below is generated from these same constants, and
// tests/unit/webview-scripts/retry.test.ts evaluates it and cross-checks it
// against the TypeScript predicate over a status matrix, so the two cannot
// drift the way the scoring copies can.

/** One initial attempt plus two retries. */
export const RETRY_ATTEMPTS = 3;

/** Backoff base. Doubles per retry: 400 ms, then 800 ms. */
export const RETRY_BASE_MS = 400;

/**
 * A 429 is the store asking for room, so give it more than a 5xx gets:
 * 1200 ms, then 2400 ms.
 */
export const RETRY_RATE_LIMIT_BASE_MS = 1200;

/**
 * The buffer. Total extra wall clock a single request may spend on retries,
 * measured from the first attempt's start and counting the failed attempts
 * themselves. A slow failure therefore buys fewer retries than a fast one,
 * which is the right way round: the phase deadline is the thing being
 * protected, and a request already 5 s in has spent the room.
 */
export const RETRY_EXTRA_BUDGET_MS = 5_000;

export type AttemptFailure = {
  ok?: boolean;
  why?: string | null;
  status?: number | null;
  /**
   * Did the per-request abort fire? Only meaningful alongside `no_response`,
   * which four of the five rails use for BOTH a connection that threw and a
   * budget that expired. Those need opposite answers here, and the rail is the
   * only place that can still tell them apart, so it reports the fact and this
   * file decides what it means. Absent is read as "an abort cannot be ruled
   * out", which costs a retry and never spends one wrongly.
   */
  aborted?: boolean;
};

/** Statuses where the request was fine and the server was not. */
export function isRetriableStatus(status: number | null | undefined): boolean {
  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/**
 * Is this failure worth asking again?
 *
 * `blocked` is deliberately absent: a rail reports it for the anti-bot wall,
 * which the challenge screen handles and a backoff cannot outwait.
 */
export function isRetriable(f: AttemptFailure | null | undefined): boolean {
  if (!f || f.ok) return false;
  const why = f.why || '';
  // A fetch that threw, and a 200 whose body was not JSON -- an edge or proxy
  // error page, which is transient in the way a 502 is transient.
  if (why === 'network' || why === 'unparseable') return true;
  // The shared name for both. An abort spent its whole budget already; a throw
  // spent nothing.
  if (why === 'no_response') return f.aborted === false;
  if (why === 'http') return isRetriableStatus(f.status);
  return false;
}

/** Deterministic exponential backoff. `attempt` is 1-based. */
export function retryDelayMs(attempt: number, f: AttemptFailure | null | undefined): number {
  const base = f && f.status === 429 ? RETRY_RATE_LIMIT_BASE_MS : RETRY_BASE_MS;
  const n = attempt < 1 ? 1 : attempt;
  return base * Math.pow(2, n - 1);
}

/**
 * The same policy, as script text for injection.
 *
 * Every rail wraps its own transport in `__mealioRetry(fn)`, where `fn` makes
 * ONE attempt and resolves to the rail's ordinary `{ ok, why, status }` shape.
 * The result carries `retries` so a run that only succeeded on the second ask
 * says so in the telemetry rather than looking clean.
 */
export const RETRY_FN = `
  function __mealioRetriableStatus(status) {
    if (typeof status !== 'number') return false;
    if (status === 429) return true;
    return status >= 500 && status < 600;
  }
  function __mealioRetriable(f) {
    if (!f || f.ok) return false;
    var why = f.why || '';
    if (why === 'network' || why === 'unparseable') return true;
    if (why === 'no_response') return f.aborted === false;
    if (why === 'http') return __mealioRetriableStatus(f.status);
    return false;
  }
  function __mealioRetryDelay(attempt, f) {
    var base = (f && f.status === 429) ? ${RETRY_RATE_LIMIT_BASE_MS} : ${RETRY_BASE_MS};
    var n = attempt < 1 ? 1 : attempt;
    return base * Math.pow(2, n - 1);
  }
  // Retry a RAW fetch, for the call sites that classify the response
  // themselves rather than funnelling through a transport. makeRequest must
  // build a fresh request each time, its own AbortController included: a retry
  // cannot reuse a signal that has already fired, and reusing one is the way
  // this silently becomes a single attempt again.
  //
  // Resolves { ok: true, res } or, once the retries are spent,
  // { ok: false, why, status, res } for a response and { ok: false, why,
  // aborted, error } for a throw. A caller that had a catch block keeps it by
  // checking for a res.
  function __mealioFetchRetry(makeRequest, opts) {
    return __mealioRetry(function (attempt) {
      var p;
      try { p = makeRequest(attempt); } catch (e) { p = Promise.reject(e); }
      return Promise.resolve(p).then(function (res) {
        if (res && __mealioRetriableStatus(res.status)) {
          return { ok: false, why: 'http', status: res.status, res: res };
        }
        return { ok: true, res: res };
      }, function (e) {
        return { ok: false, why: 'no_response', aborted: !!(e && e.name === 'AbortError'), error: e };
      });
    }, opts);
  }
  // EVERY REQUEST REPORTS ITSELF. MEAL-219.
  //
  // Stephen, 2026-09-05: "it should be much easier to collect data since it all
  // traces back to http codes." It does, and this is the one place every rail's
  // requests already meet, so the status is emitted HERE rather than threaded
  // through five rails' report functions to the item they happened to belong
  // to. Attributing a status to an ITEM would also be wrong under concurrency:
  // H-E-B writes three at a time, and the last status seen is not the status of
  // the item currently being reported.
  //
  // Posted, not returned, because most callers do not want it and the ones that
  // do already have it. A failure to post must never break a request, hence the
  // swallow: telemetry is not allowed to cost an add.
  function __mealioReport(phase, op, res, attempts, ms) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'NET_REQUEST',
        phase: phase || null,
        op: op || null,
        status: (res && typeof res.status === 'number') ? res.status : null,
        // NO OK FIELD. why is null exactly when the request succeeded, so an ok
        // would be redundant -- and storeIsolation.test.ts refuses that field
        // anywhere in a rail script, because posting a result under it instead
        // of success is a bug Albertsons actually shipped: the engine read
        // undefined and called every successful add a failure.
        why: (res && !res.ok && res.why) ? String(res.why).slice(0, 40) : null,
        attempts: attempts,
        ms: ms,
      }));
    } catch (e) {}
  }
  function __mealioRetry(attemptFn, opts) {
    opts = opts || {};
    var attempts = opts.attempts || ${RETRY_ATTEMPTS};
    var budget = (typeof opts.extraBudgetMs === 'number') ? opts.extraBudgetMs : ${RETRY_EXTRA_BUDGET_MS};
    var startedAt = Date.now();
    return (async function () {
      var last = null;
      var tries = 0;
      for (var i = 1; i <= attempts; i++) {
        tries = i;
        last = await attemptFn(i);
        if (last && last.ok) {
          if (i > 1) { try { last.retries = i - 1; } catch (e) {} }
          __mealioReport(opts.phase, opts.op, last, tries, Date.now() - startedAt);
          return last;
        }
        if (i >= attempts) break;
        if (!__mealioRetriable(last)) break;
        var delay = __mealioRetryDelay(i, last);
        // The buffer: a retry that would push this request past its extra
        // budget is not taken, so a slow failure cannot eat the phase deadline.
        if (Date.now() - startedAt + delay > budget) break;
        await new Promise(function (r) { setTimeout(r, delay); });
      }
      if (last && typeof last === 'object') { try { last.retries = last.retries || 0; } catch (e) {} }
      __mealioReport(opts.phase, opts.op, last, tries, Date.now() - startedAt);
      return last;
    })();
  }
`;
