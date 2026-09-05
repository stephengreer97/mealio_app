// The retry policy, and the proof that the injected copy of it agrees.
//
// _retry.ts states the policy twice: once in TypeScript, which the engine and
// these tests can call, and once as script text, which is the copy that
// actually runs. That is the same duplication _scoring.ts carries, and the same
// way it goes wrong -- one copy gets a fix and the other does not. Here it is
// mechanical instead: the injected source is evaluated and cross-checked
// against the TypeScript over the whole matrix of failures a rail can report.
import {
  isRetriable, isRetriableStatus, retryDelayMs, RETRY_FN, RETRY_ATTEMPTS,
  RETRY_BASE_MS, RETRY_RATE_LIMIT_BASE_MS, RETRY_EXTRA_BUDGET_MS,
} from '../../../src/lib/webview-scripts/_retry';

/** The injected helpers, evaluated exactly as the WebView would see them. */
function injected() {
  const fn = new Function(
    RETRY_FN + '\n return { __mealioRetriable: __mealioRetriable,' +
    ' __mealioRetryDelay: __mealioRetryDelay, __mealioRetry: __mealioRetry };'
  );
  return fn() as {
    __mealioRetriable: (f: unknown) => boolean;
    __mealioRetryDelay: (attempt: number, f: unknown) => number;
    __mealioRetry: (fn: (i: number) => Promise<unknown>, opts?: unknown) => Promise<any>;
  };
}

/** Everything a rail can hand the policy, retriable or not. */
const MATRIX: Array<Record<string, unknown>> = [
  { ok: true },
  { why: 'http', status: 500 }, { why: 'http', status: 502 },
  { why: 'http', status: 503 }, { why: 'http', status: 504 },
  { why: 'http', status: 429 }, { why: 'http', status: 599 },
  { why: 'http', status: 400 }, { why: 'http', status: 401 },
  { why: 'http', status: 403 }, { why: 'http', status: 404 },
  { why: 'http', status: 418 }, { why: 'http', status: 422 },
  { why: 'http', status: 200 }, { why: 'http' },
  { why: 'network' }, { why: 'unparseable' },
  { why: 'no_response', aborted: false }, { why: 'no_response', aborted: true },
  { why: 'no_response' },
  { why: 'timeout' }, { why: 'blocked', status: 403 },
  { why: 'graphql_error' }, { why: 'search_error' }, { why: 'unauthorised', status: 401 },
  { why: 'no_hash' }, { why: 'not_hydrated' }, {},
];

describe('which failures earn a second ask', () => {
  const RETRIABLE = new Set([
    'http/500', 'http/502', 'http/503', 'http/504', 'http/429', 'http/599',
    'network/-', 'unparseable/-', 'no_response/false',
  ]);
  const key = (f: Record<string, unknown>) =>
    `${f.why ?? '-'}/${f.status ?? (f.aborted === undefined ? '-' : String(f.aborted))}`;

  it.each(MATRIX)('classifies %j the way the table says', (f) => {
    expect(isRetriable(f)).toBe(RETRIABLE.has(key(f)));
  });

  it('never retries a request that spent its whole budget', () => {
    // A timeout is the expensive failure and the ambiguous one on the add path.
    expect(isRetriable({ why: 'timeout' })).toBe(false);
    expect(isRetriable({ why: 'no_response', aborted: true })).toBe(false);
    // A rail that has not been taught to report the fact is read as an abort,
    // which spends nothing rather than risking a second write.
    expect(isRetriable({ why: 'no_response' })).toBe(false);
  });

  it('leaves the anti-bot wall to the challenge screen', () => {
    // Measured self-healing in 71-84s, which no backoff here can outwait.
    expect(isRetriable({ why: 'blocked', status: 403 })).toBe(false);
    expect(isRetriable({ why: 'http', status: 403 })).toBe(false);
  });

  it('does not re-ask a store that gave a real answer', () => {
    for (const why of ['graphql_error', 'search_error', 'unauthorised', 'no_hash']) {
      expect(isRetriable({ why, status: 200 })).toBe(false);
    }
    expect(isRetriableStatus(499)).toBe(false);
    expect(isRetriableStatus(600)).toBe(false);
  });
});

describe('the injected copy agrees with the TypeScript', () => {
  const js = injected();

  it.each(MATRIX)('same verdict for %j', (f) => {
    expect(js.__mealioRetriable(f)).toBe(isRetriable(f));
  });

  it.each([1, 2, 3])('same backoff at attempt %i', (attempt) => {
    for (const f of [{ why: 'http', status: 500 }, { why: 'http', status: 429 }, { why: 'network' }]) {
      expect(js.__mealioRetryDelay(attempt, f)).toBe(retryDelayMs(attempt, f));
    }
  });

  it('backs off further for a rate limit than for a server error', () => {
    expect(retryDelayMs(1, { why: 'http', status: 429 })).toBe(RETRY_RATE_LIMIT_BASE_MS);
    expect(retryDelayMs(1, { why: 'http', status: 500 })).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2, { why: 'http', status: 500 })).toBe(RETRY_BASE_MS * 2);
  });
});

describe('the loop', () => {
  const js = injected();

  it('asks a couple more times for a 5xx and reports the win as a retry', async () => {
    let calls = 0;
    const out = await js.__mealioRetry(() => {
      calls += 1;
      return Promise.resolve(calls < 3 ? { ok: false, why: 'http', status: 500 } : { ok: true, data: 1 });
    });
    expect(calls).toBe(3);
    expect(out.ok).toBe(true);
    // A run that only worked on the second ask must not read as a clean one.
    expect(out.retries).toBe(2);
  });

  it('stops at the cap and hands back the last failure', async () => {
    let calls = 0;
    const out = await js.__mealioRetry(() => {
      calls += 1;
      return Promise.resolve({ ok: false, why: 'http', status: 503 });
    });
    expect(calls).toBe(RETRY_ATTEMPTS);
    expect(out.why).toBe('http');
    expect(out.retries).toBe(0);
  });

  it('does not ask twice when the store gave a real answer', async () => {
    let calls = 0;
    const out = await js.__mealioRetry(() => {
      calls += 1;
      return Promise.resolve({ ok: false, why: 'http', status: 404 });
    });
    expect(calls).toBe(1);
    expect(out.status).toBe(404);
  });

  it('costs nothing when the first ask works', async () => {
    let calls = 0;
    const out = await js.__mealioRetry(() => { calls += 1; return Promise.resolve({ ok: true }); });
    expect(calls).toBe(1);
    expect(out.retries).toBeUndefined();
  });

  it('spends the buffer and no more', async () => {
    // A failure slow enough that a retry would push the request past its extra
    // budget does not get one -- the phase deadline is the thing being kept.
    let calls = 0;
    const slow = () => {
      calls += 1;
      return new Promise((r) => setTimeout(() => r({ ok: false, why: 'http', status: 500 }), 60));
    };
    const out = await js.__mealioRetry(slow, { extraBudgetMs: 50 });
    expect(calls).toBe(1);
    expect(out.status).toBe(500);
  });

  it('has a buffer big enough for the backoff it schedules', () => {
    // Two retries at 400ms and 800ms, plus the failures themselves. If the
    // budget ever drops below the delays it hands out, the second retry is
    // dead code and nobody notices.
    const scheduled = retryDelayMs(1, { why: 'http', status: 500 })
      + retryDelayMs(2, { why: 'http', status: 500 });
    expect(RETRY_EXTRA_BUDGET_MS).toBeGreaterThan(scheduled);
  });
});
