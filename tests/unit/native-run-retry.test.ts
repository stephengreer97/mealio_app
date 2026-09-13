// ONE RETRY POLICY, TWO TRANSPORTS.
//
// _retry.ts holds the policy twice on purpose: as TypeScript predicates, and as
// the script text every injected rail carries. retry.test.ts next door evaluates
// that script text in Node and cross-checks it against the predicates, so the
// two cannot drift.
//
// The native driver is the third caller, and it does NOT hold a third copy -- it
// imports isRetriable and retryDelayMs and applies them. This file pins that it
// actually behaves that way, because "imports the predicate" and "obeys the
// predicate" are different claims and only the second one matters: a loop that
// asks once and returns would still import it.
import {
  Attempt, PostToSheet, __resetNativeRunForTests, nativeRetry,
} from '../../src/lib/native-rail/run';

const posted: Array<Record<string, unknown>> = [];
const post: PostToSheet = (m) => { posted.push(m); };

beforeEach(() => { posted.length = 0; __resetNativeRunForTests(); });

/** An attempt that fails `times` times with `f`, then succeeds. */
function failThen(times: number, f: Attempt<string>) {
  let n = 0;
  return async (): Promise<Attempt<string>> => {
    n += 1;
    return n <= times ? { ...f } : { ok: true, status: 200, data: 'fine' };
  };
}

describe('the failures the store owns', () => {
  it('asks a 500 again', async () => {
    const r = await nativeRetry(failThen(1, { ok: false, why: 'http', status: 500 }),
      { phase: 'search', op: 'X', post });
    expect(r.ok).toBe(true);
    expect(r.retries).toBe(1);
  });

  it('asks a 429 again, and waits longer for it', async () => {
    // A 429 is the store asking for room, so it gets 1200ms rather than 400.
    const t0 = Date.now();
    const r = await nativeRetry(failThen(1, { ok: false, why: 'http', status: 429 }),
      { phase: 'search', op: 'X', post });
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
  });

  it('asks again when the fetch threw', async () => {
    const r = await nativeRetry(failThen(1, { ok: false, why: 'no_response', aborted: false }),
      { phase: 'add', op: 'X', post });
    expect(r.ok).toBe(true);
  });
});

describe('the answers that are answers', () => {
  it('does not ask a 403 again -- the wall self-heals in 71-84s, not in a backoff', async () => {
    let calls = 0;
    await nativeRetry(async () => { calls += 1; return { ok: false, why: 'blocked', status: 403 }; },
      { phase: 'session', op: 'X', post });
    expect(calls).toBe(1);
  });

  it('does not ask a 400 again', async () => {
    let calls = 0;
    await nativeRetry(async () => { calls += 1; return { ok: false, why: 'http', status: 400 }; },
      { phase: 'search', op: 'X', post });
    expect(calls).toBe(1);
  });

  it('does not ask a timeout again -- it already spent its whole budget', async () => {
    // THE LOAD-BEARING ONE. A retried abort doubles the worst case for the whole
    // batch, and on the add path it is ambiguous: the write may well have landed.
    let calls = 0;
    await nativeRetry(async () => { calls += 1; return { ok: false, why: 'no_response', aborted: true }; },
      { phase: 'add', op: 'X', post });
    expect(calls).toBe(1);
  });

  it('does not ask a GraphQL error again', async () => {
    let calls = 0;
    await nativeRetry(async () => { calls += 1; return { ok: false, why: 'graphql_error', status: 200 }; },
      { phase: 'search', op: 'X', post });
    expect(calls).toBe(1);
  });
});

describe('every request reports itself', () => {
  it('posts one NET_REQUEST, with the status and the attempt count', async () => {
    // MEAL-219. Posted from HERE rather than threaded through each driver, for
    // the reason the injected copy posts it from the shared retry: under
    // concurrency the last status seen is not the status of the item being
    // reported.
    await nativeRetry(failThen(1, { ok: false, why: 'http', status: 500 }),
      { phase: 'search', op: 'productSearchesV2', post });
    const rows = posted.filter((p) => p.type === 'NET_REQUEST');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'search', op: 'productSearchesV2', status: 200, attempts: 2 });
    // NO OK FIELD, and none is wanted: why is null exactly when the request
    // succeeded. storeIsolation.test.ts refuses `ok` in a rail's posted row.
    expect(rows[0].why).toBeNull();
    expect(rows[0]).not.toHaveProperty('ok');
  });

  it('reports the failure that ended the attempts', async () => {
    await nativeRetry(async () => ({ ok: false, why: 'blocked', status: 403 }),
      { phase: 'session', op: 'SessionContext', post });
    expect(posted[0]).toMatchObject({ type: 'NET_REQUEST', status: 403, why: 'blocked', attempts: 1 });
  });

  it('never lets a broken post cost a request', async () => {
    const r = await nativeRetry(async () => ({ ok: true, status: 200, data: 'fine' }),
      { phase: 'search', op: 'X', post: () => { throw new Error('bridge gone'); } });
    expect(r.ok).toBe(true);
  });
});

describe('the extra budget', () => {
  it('stops retrying rather than eating the phase deadline', async () => {
    // A slow failure buys fewer retries than a fast one, which is the right way
    // round: the phase deadline is the thing being protected.
    let calls = 0;
    await nativeRetry(async () => {
      calls += 1;
      await new Promise((r) => { setTimeout(r, 60); });
      return { ok: false, why: 'http', status: 500 };
    }, { phase: 'search', op: 'X', post, extraBudgetMs: 50 });
    expect(calls).toBe(1);
  });
});
