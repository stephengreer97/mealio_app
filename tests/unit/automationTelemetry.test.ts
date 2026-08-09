import fs from 'fs';
import path from 'path';
import {
  AutomationTelemetry,
  ADD_REASON_CODES,
  addFailureCode,
  blockFailureCode,
  createNoopTelemetry,
  recordPoolAddOutcome,
  sanitizeDetail,
  StepRecord,
  STEP_FAILURE_CODES,
} from '../../src/lib/automation-telemetry';
import type { StepFailureCode } from '../../src/lib/automation-telemetry';

// The property that matters most here is "telemetry can never break a cart run":
// bounded buffer, swallowed errors, no throw from any entry point. The second is
// correct sequencing and retry, since `seq` is the server's idempotency key.

/** Collects batches and reports success, mimicking a healthy server. */
function okUpload() {
  const batches: StepRecord[][] = [];
  const fn = jest.fn(async (b: { steps: StepRecord[] }) => { batches.push(b.steps); return true; });
  return { fn, batches, get all() { return batches.flat(); } };
}

/** Reports failure, mimicking a 5xx worth retrying. */
function failUpload() {
  const attempts: StepRecord[][] = [];
  const fn = jest.fn(async (b: { steps: StepRecord[] }) => { attempts.push(b.steps); return false; });
  return { fn, attempts };
}

// MEAL-113. A recorder is a live object: `record()` arms a `setTimeout` for the
// next flush, so every instance a test builds and walks away from leaves a timer
// in the worker's event loop. That is what hung `npx jest` — the run finished its
// tests in ~3s and then sat there, because the retry path re-arms on every failed
// upload and a recorder built on `failUpload()` reschedules itself forever.
// `--detectOpenHandles` named these four call sites (test lines 96, 104, 173, 313)
// and `--forceExit` was papering over them.
//
// So every recorder gets tracked and disposed. `dispose()` is the documented way
// to stop one, it is safe to call twice, and it runs after the assertions — a
// test that wants to observe the flush still does it explicitly in its own body.
const live: AutomationTelemetry[] = [];

/** Track a recorder so afterEach can stop its timers. */
function track(t: AutomationTelemetry): AutomationTelemetry {
  live.push(t);
  return t;
}

afterEach(async () => {
  // Reverse order is not significant, but draining the array is: a recorder
  // disposed twice is a no-op, one left behind is a hung run.
  const pending = live.splice(0, live.length);
  await Promise.all(pending.map((t) => t.dispose().catch(() => {})));
});

const make = (opts: Partial<ConstructorParameters<typeof AutomationTelemetry>[0]> = {}) =>
  track(new AutomationTelemetry({
    runId: 'run-1',
    upload: async () => true,
    batchSize: 1000,        // large so nothing auto-flushes unless a test wants it
    flushIntervalMs: 60_000,
    ...opts,
  }));

describe('sanitizeDetail', () => {
  it('returns undefined for non-objects and empty objects', () => {
    for (const v of [undefined, null, 42, 'x', [1], {}]) {
      expect(sanitizeDetail(v)).toBeUndefined();
    }
  });

  it('keeps primitives and drops nested structures', () => {
    // Nesting is where payload bloat and accidental PII both hide.
    const out = sanitizeDetail({ n: 1, b: true, s: 'hi', obj: { a: 1 }, arr: [1, 2] });
    expect(out).toEqual({ n: 1, b: true, s: 'hi' });
  });

  it('truncates long strings', () => {
    const out = sanitizeDetail({ s: 'x'.repeat(1000) })!;
    expect((out.s as string).length).toBe(200);
  });

  it('caps the key count', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 50; i++) big[`k${i}`] = i;
    expect(Object.keys(sanitizeDetail(big)!).length).toBe(12);
  });

  it('drops null/undefined values and non-finite numbers become null', () => {
    const out = sanitizeDetail({ a: null, b: undefined, c: NaN })!;
    expect('a' in out).toBe(false);
    expect('b' in out).toBe(false);
    expect(out.c).toBeNull();
  });
});

describe('AutomationTelemetry sampling', () => {
  it('records nothing when disabled', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn, enabled: false });
    expect(t.isRecording).toBe(false);
    t.record('search', 'ok');
    await t.flush();
    expect(up.fn).not.toHaveBeenCalled();
  });

  it('records nothing without a runId', () => {
    // Steps are keyed to a server-issued runId; without one there is nowhere to
    // put them, so the recorder must be inert rather than buffer forever.
    const t = make({ runId: '' });
    expect(t.isRecording).toBe(false);
    t.record('search', 'ok');
    expect(t.pending).toBe(0);
  });

  it('samples per RUN, not per step', () => {
    // A per-step coin flip would produce funnels with holes that read as failures.
    const sampledIn = make({ sampleRate: 0.5, random: () => 0.1 });
    const sampledOut = make({ sampleRate: 0.5, random: () => 0.9 });
    for (let i = 0; i < 5; i++) { sampledIn.record('search', 'ok'); sampledOut.record('search', 'ok'); }
    expect(sampledIn.pending).toBe(5);   // all of them
    expect(sampledOut.pending).toBe(0);  // none of them
  });

  // MEAL-5. The assertion above is what the property SAYS, but it does not pin
  // it: `random: () => 0.1` answers every call the same way, so a per-step roll
  // passes it identically — five steps all in, or all out. The two below vary the
  // roll, which is the only thing that can tell the two implementations apart.
  it('rolls the sample exactly once, at construction', () => {
    // First roll loses. Under a per-step roll the four steps after it would be
    // recorded; under a per-run roll the run is out and stays out.
    const rolls = [0.9, 0.1, 0.1, 0.1, 0.1];
    let i = 0;
    const random = jest.fn(() => rolls[i++] ?? 0.1);
    const t = make({ sampleRate: 0.5, random });
    for (let n = 0; n < 5; n++) t.record('search', 'ok');
    expect(t.pending).toBe(0);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('uploads every step of a sampled run, including ones a later roll would lose', async () => {
    // The direction that does the damage: a per-step roll on a run that is IN
    // yields a funnel with holes — an add with no confirm reads as a failure that
    // never happened. Read off the batch the upload actually received, since a
    // row can also be lost between record() and the wire.
    const rolls = [0.1, 0.9, 0.9, 0.9, 0.9];
    let i = 0;
    const random = jest.fn(() => rolls[i++] ?? 0.9);
    const up = okUpload();
    const t = make({ sampleRate: 0.5, random, upload: up.fn });
    t.record('login_check', 'ok');
    t.record('search', 'ok');
    t.record('add_click', 'ok');
    t.record('confirm', 'ok');
    t.record('run_summary', 'ok');
    await t.flush();
    expect(up.all.map((s) => s.step)).toEqual([
      'login_check', 'search', 'add_click', 'confirm', 'run_summary',
    ]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('records everything at sampleRate 1 without consulting random', () => {
    const random = jest.fn(() => 0.99);
    const t = make({ sampleRate: 1, random });
    t.record('search', 'ok');
    expect(t.pending).toBe(1);
    expect(random).not.toHaveBeenCalled();
  });

  it('records nothing at sampleRate 0', () => {
    const t = make({ sampleRate: 0, random: () => 0 });
    t.record('search', 'ok');
    expect(t.pending).toBe(0);
  });
});

describe('AutomationTelemetry recording', () => {
  it('assigns monotonic seq numbers starting at 0', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('login_check', 'ok');
    t.record('search', 'ok');
    t.record('confirm', 'error', { code: 'confirm_failed' });
    await t.flush();
    expect(up.all.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(up.all.map((s) => s.step)).toEqual(['login_check', 'search', 'confirm']);
  });

  it('keeps seq monotonic across flushes', async () => {
    // seq is the server's idempotency key, so it must never restart mid-run.
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('search', 'ok');
    await t.flush();
    t.record('confirm', 'ok');
    await t.flush();
    expect(up.all.map((s) => s.seq)).toEqual([0, 1]);
  });

  it('normalizes durationMs and itemIndex', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('search', 'ok', { durationMs: 123.9, itemIndex: 4.7 });
    t.record('search', 'ok', { durationMs: -50 });
    await t.flush();
    expect(up.all[0].durationMs).toBe(123);
    expect(up.all[0].itemIndex).toBe(4);
    expect(up.all[1].durationMs).toBe(0); // negatives clamped, not dropped
  });

  it('omits non-finite durationMs rather than sending NaN', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('search', 'ok', { durationMs: NaN });
    await t.flush();
    expect('durationMs' in up.all[0]).toBe(false);
  });

  it('auto-flushes when the batch size is reached', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn, batchSize: 3 });
    t.record('search', 'ok');
    t.record('search', 'ok');
    expect(up.fn).not.toHaveBeenCalled();
    t.record('search', 'ok');
    await Promise.resolve(); await Promise.resolve();
    expect(up.fn).toHaveBeenCalledTimes(1);
  });

  it('bounds the buffer, dropping the OLDEST rows', () => {
    // A wedged run must not grow memory without limit. The TAIL of a failing run
    // is the part worth keeping, so the head is what gets dropped.
    const t = make();
    for (let i = 0; i < 600; i++) t.record('search', 'ok');
    expect(t.pending).toBe(500);
  });

  it('never throws from record', () => {
    const t = make();
    // A getter that throws is the kind of thing a caller can accidentally pass.
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, 'boom', { get() { throw new Error('nope'); }, enumerable: true });
    expect(() => t.record('search', 'ok', { detail: hostile })).not.toThrow();
  });
});

describe('failure codes', () => {
  // The dashboard groups on the raw string, so a renamed or mistyped code
  // silently splits a metric's history rather than failing anywhere visible.
  // Order is asserted, not just membership: the server orders its breakdown by
  // position in this list, so moving a code re-labels a column on the dashboard.
  // A new code therefore has to arrive at the END, and this test is what says so.
  it('exposes exactly the nine codes, in order, with out_of_stock appended last', () => {
    expect([...STEP_FAILURE_CODES]).toEqual([
      'selector_miss', 'waf_block', 'auth_required', 'no_candidates',
      'match_rejected', 'confirm_failed', 'timeout', 'nav_failed',
      'out_of_stock',
    ]);
  });

  it('maps the reasons this table was written against', () => {
    const expected: Record<string, string> = {
      no_results: 'no_candidates',
      low_confidence: 'match_rejected',
      // MEAL-29: its own code, not match_rejected. The store not having the item
      // is not our scorer refusing every candidate, and counting them together
      // put the store's inventory on our reliability numbers.
      out_of_stock: 'out_of_stock',
      needs_weight: 'match_rejected',
      not_found: 'selector_miss',
      no_button: 'selector_miss',
      no_modal: 'selector_miss',
      no_row: 'selector_miss',
      no_trigger: 'selector_miss',
      stepper_not_found: 'selector_miss',
      pref_required: 'selector_miss',
      cart_not_incremented: 'confirm_failed',
      not_confirmed: 'confirm_failed',
      click_failed: 'confirm_failed',
      blocked: 'waf_block',
      timeout: 'timeout',
    };
    for (const [reason, code] of Object.entries(expected)) {
      expect(addFailureCode(reason)).toBe(code);
    }
  });

  /**
   * The drift detector the table above cannot be.
   *
   * That test restates `ADD_REASON_CODES` by hand, so it passes forever no
   * matter what the store scripts start emitting — which is exactly how
   * `partial` and `error` reached `addFailureCode` unmapped and rode the
   * fallback into `confirm_failed`. This one reads the scripts.
   *
   * Reasons are extracted from `reason: '...'` literals. Not every hit is a
   * result reason — the scripts also put `reason` on `log()` diagnostics — so
   * those are listed explicitly rather than pattern-matched, because a rule
   * loose enough to exclude them by shape would also exclude real ones.
   */
  it('has a code for every reason the store scripts actually emit', () => {
    const dir = path.join(__dirname, '../../src/lib/webview-scripts');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));

    /**
     * Literals the line scan picks up that are not add-result reasons:
     * `reason` fields on log/diagnostic payloads, and unrelated strings that
     * happen to share a line with one. Listed rather than pattern-matched — a
     * rule loose enough to exclude these by shape would exclude real reasons.
     */
    const IGNORED = new Set([
      'no_target', 'healthy', 'small_confirmed',   // log/diagnostic payloads
      'add', 'cards_ready', 'no_best', 'skip_submit_method', // co-located, not reasons
      // MEAL-14's cart-query rail (heb-cart-query.ts) carries its OWN `reason`
      // vocabulary — why a cart read failed, and why a verdict came out the way it
      // did. None of these are ever posted as an ADD_RESULT reason: the rail's
      // verdict reaches the funnel as `confirmState`/`confirmWhy` detail, and the
      // single reason it does turn into is `cart_absent`, which IS mapped. Listed
      // one by one so a genuinely new ADD_RESULT reason still fails this test.
      'http_error', 'shape', 'graphql_error', 'network', 'no_read', 'no_baseline',
      'cart_query', 'cart_query_confirm', 'cart_query_crosscheck', 'missing', 'unknown',
      // A CART_COUNT reason, not an ADD_RESULT one. The cart-page scripts post it
      // alongside `count: null` when the page they landed on is not the cart — the
      // Albertsons guard for a redirect off /erums/cart (MEAL-136), and the
      // Walmart/HEB/Wegmans guards for the same shape (MEAL-152). It explains why
      // a COUNT is unknown; it never describes an add, and addFailureCode never
      // sees it.
      'not_cart_page',
    ]);

    const found = new Map<string, string>();
    for (const file of files) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      // Line-scoped rather than `reason:\s*'x'`: `partial` — the reason that
      // motivated this test — is emitted from inside a ternary
      // (`walmart.ts:479`), so a pattern anchored to the property name misses
      // exactly the case this exists to catch. Any single-quoted snake_case
      // literal on a line mentioning `reason` is a candidate instead, which
      // over-collects and is corrected by the ignore lists below. A ternary
      // split across lines would still slip through; nothing in these scripts
      // does that today.
      for (const line of src.split('\n')) {
        if (!/\breason\b/.test(line)) continue;
        for (const m of line.matchAll(/'([a-z][a-z_]*)'/g)) {
          if (!IGNORED.has(m[1])) found.set(m[1], file);
        }
      }
    }

    expect(found.size).toBeGreaterThan(0); // the scan itself must not silently find nothing

    const unmapped = [...found.entries()]
      .filter(([reason]) => !(reason in ADD_REASON_CODES))
      .map(([reason, file]) => `${reason} (${file})`);

    expect(unmapped).toEqual([]);
  });

  it('falls back to confirm_failed for unknown and missing reasons', () => {
    // A script reason we have not mapped yet must not be attributed to a
    // selector or a scorer on no evidence: the add WAS dispatched, so the only
    // safe claim is that nothing evidenced it landing.
    expect(addFailureCode('unknown')).toBe('confirm_failed');
    expect(addFailureCode('some_new_store_reason')).toBe('confirm_failed');
    expect(addFailureCode(null)).toBe('confirm_failed');
    expect(addFailureCode(undefined)).toBe('confirm_failed');
  });

  it('separates the Fresh store-picker block from a real robot wall', () => {
    expect(blockFailureCode('http-403')).toBe('waf_block');
    expect(blockFailureCode('nudge')).toBe('waf_block');
    expect(blockFailureCode('fresh-no-store')).toBe('auth_required');
  });

  it('sends the code as a top-level field, only on failing rows', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('candidates', 'empty', { code: 'no_candidates' });
    t.record('search', 'ok');
    await t.flush();
    expect(up.all[0].code).toBe('no_candidates');
    expect('code' in up.all[1]).toBe(false);
  });

  it('reports the code that explains the run, not the one that occurs most', () => {
    const t = make();
    expect(t.primaryFailureCode()).toBeUndefined();

    // MEAL-123's own scenario. Three confirmation misses and one block: the block
    // is why the other three happened, and it is the only actionable one. Ranking
    // by count reported confirm_failed and buried it.
    t.record('confirm', 'error', { code: 'confirm_failed' });
    t.record('confirm', 'error', { code: 'confirm_failed' });
    t.record('confirm', 'error', { code: 'confirm_failed' });
    t.record('search', 'blocked', { code: 'waf_block' });
    expect(t.primaryFailureCode()).toBe('waf_block');

    // And frequency is still available, so nothing was traded away for the
    // ranking — most frequent first, as a flat string because sanitizeDetail drops
    // nested objects. It is asserted THROUGH the sanitizer, because a Record here
    // was silently discarded on the way to the server and the claim that nothing
    // is lost was false without anyone noticing.
    expect(t.failureCodeSummary()).toBe('confirm_failed:3,waf_block:1');
    expect(sanitizeDetail({ failureCodes: t.failureCodeSummary() }))
      .toEqual({ failureCodes: 'confirm_failed:3,waf_block:1' });
  });

  it('headlines a run with out_of_stock over match_rejected, and never over no_candidates', () => {
    // MEAL-29 placed out_of_stock between these two, and the placement is the
    // whole decision — it is what a mixed run reports on its run_summary row.
    //
    // Above match_rejected: the store's own answer about the item beats our
    // judgement of the candidates, because there is nothing to go and check.
    const beatsRejection = make();
    for (let i = 0; i < 5; i++) beatsRejection.record('confirm', 'error', { code: 'match_rejected' });
    beatsRejection.record('confirm', 'error', { code: 'out_of_stock' });
    expect(beatsRejection.primaryFailureCode()).toBe('out_of_stock');

    // Below no_candidates: an empty search might be stock and might be our search
    // term, and the ambiguous answer is the one worth reading first.
    const losesToEmptySearch = make();
    for (let i = 0; i < 5; i++) losesToEmptySearch.record('confirm', 'error', { code: 'out_of_stock' });
    losesToEmptySearch.record('candidates', 'empty', { code: 'no_candidates' });
    expect(losesToEmptySearch.primaryFailureCode()).toBe('no_candidates');

    // And a wall still outranks it, as it outranks everything: behind a WAF we
    // never asked the store about stock, so an out_of_stock read there is not
    // evidence of anything.
    const walled = make();
    for (let i = 0; i < 5; i++) walled.record('confirm', 'error', { code: 'out_of_stock' });
    walled.record('search', 'blocked', { code: 'waf_block' });
    expect(walled.primaryFailureCode()).toBe('waf_block');
  });

  it('codes a store-reported out-of-stock as out_of_stock end to end', () => {
    // The path that actually produces these rows: a store script reports
    // `reason: 'out_of_stock'`, addFailureCode translates it, and the row carries
    // the code the server subtracts on. Asserted through record() rather than
    // through addFailureCode alone, because the mapping being right does not by
    // itself put the code on a row.
    const t = make();
    t.record('confirm', 'error', {
      itemIndex: 2,
      detail: { attempt: 1, path: 'parallel_add', reason: 'out_of_stock' },
      code: addFailureCode('out_of_stock'),
    });
    expect(t.primaryFailureCode()).toBe('out_of_stock');
    expect(t.failureCodeSummary()).toBe('out_of_stock:1');
  });

  it('outranks a symptom with its cause however lopsided the counts', () => {
    // selector_miss explains the confirm failures that follow it, so it wins at
    // any ratio. Under the old count-based rule it lost as soon as a second
    // confirm_failed arrived.
    const t = make();
    t.record('confirm', 'error', { code: 'selector_miss' });
    for (let i = 0; i < 20; i++) t.record('confirm', 'error', { code: 'confirm_failed' });
    expect(t.primaryFailureCode()).toBe('selector_miss');
  });

  it('says nothing when no failure was recorded', () => {
    const t = make();
    expect(t.primaryFailureCode()).toBeUndefined();
    expect(t.failureCodeSummary()).toBeUndefined();
  });

  it('falls back to the most frequent when no ranked code was recorded', () => {
    // Defensive: the severity table is exhaustive over StepFailureCode and the
    // compiler enforces that, so this path should be unreachable today. It exists
    // so a future code added to the union without a rank still reports something
    // instead of nothing.
    //
    // Which means the only way to test it is to do what that future edit would do
    // by accident — record a code the table has never heard of. Hence the casts.
    // Asserting undefined on an empty telemetry would NOT test this: the loop can
    // be deleted outright and an empty run still reports undefined.
    const unranked = 'script_error' as StepFailureCode;
    const alsoUnranked = 'quota_exceeded' as StepFailureCode;

    const t = make();
    t.record('confirm', 'error', { code: unranked });
    t.record('confirm', 'error', { code: unranked });
    t.record('search', 'error', { code: alsoUnranked });

    // Most frequent wins, which is the pre-MEAL-123 behaviour.
    expect(t.primaryFailureCode()).toBe(unranked);
    expect(t.failureCodeSummary()).toBe('script_error:2,quota_exceeded:1');
  });

  it('keeps the run tally past a flush and past buffer trimming', async () => {
    // run_summary is recorded last, after the buffer has been flushed several
    // times over — the tally must not live in the buffer.
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('confirm', 'error', { code: 'waf_block' });
    await t.flush();
    for (let i = 0; i < 600; i++) t.record('search', 'ok');
    expect(t.primaryFailureCode()).toBe('waf_block');
  });

  it('carries a code through startTimer', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.startTimer('search', 1)('timeout', { term: 'cumin' }, 'timeout');
    await t.flush();
    expect(up.all[0].code).toBe('timeout');
    expect(up.all[0].outcome).toBe('timeout');
  });
});

describe('AutomationTelemetry startTimer', () => {
  it('records elapsed time on settle', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    const done = t.startTimer('search', 2);
    done('ok', { count: 5 });
    await t.flush();
    expect(up.all[0].step).toBe('search');
    expect(up.all[0].itemIndex).toBe(2);
    expect(typeof up.all[0].durationMs).toBe('number');
    expect(up.all[0].detail).toEqual({ count: 5 });
  });

  it('is idempotent — only the first settle wins', async () => {
    // A step that succeeds and then also hits its timeout must log once, as what
    // actually happened first.
    const up = okUpload();
    const t = make({ upload: up.fn });
    const done = t.startTimer('confirm');
    done('ok');
    done('timeout', undefined, 'timeout');
    await t.flush();
    expect(up.all.length).toBe(1);
    expect(up.all[0].outcome).toBe('ok');
  });
});

describe('AutomationTelemetry flush and retry', () => {
  it('does not call upload with an empty buffer', async () => {
    const up = okUpload();
    await make({ upload: up.fn }).flush();
    expect(up.fn).not.toHaveBeenCalled();
  });

  it('re-queues a batch the server said to retry', async () => {
    const up = failUpload();
    const t = make({ upload: up.fn });
    t.record('search', 'ok');
    await t.flush();
    expect(up.attempts.length).toBe(1);
    expect(t.pending).toBe(1); // back in the buffer, not lost
  });

  it('re-queues at the FRONT so ordering survives a retry', async () => {
    let allow = false;
    const seen: StepRecord[][] = [];
    const upload = jest.fn(async (b: { steps: StepRecord[] }) => {
      seen.push(b.steps);
      return allow;
    });
    const t = make({ upload });
    t.record('login_check', 'ok');  // seq 0
    await t.flush();                // fails, re-queued
    t.record('search', 'ok');       // seq 1
    allow = true;
    await t.flush();
    expect(seen[1].map((s) => s.seq)).toEqual([0, 1]);
  });

  it('survives an upload that throws', async () => {
    const upload = jest.fn(async () => { throw new Error('network down'); });
    const t = make({ upload });
    t.record('search', 'ok');
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.pending).toBe(1);
  });

  it('passes run metadata on every batch', async () => {
    const up = okUpload();
    const t = track(new AutomationTelemetry({
      runId: 'run-9', upload: up.fn, configVersion: 7,
      appVersion: '1.2.3', platform: 'android', batchSize: 1000, flushIntervalMs: 60_000,
    }));
    t.record('search', 'ok');
    await t.flush();
    expect(up.fn).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-9', configVersion: 7, appVersion: '1.2.3', platform: 'android',
    }));
  });
});

describe('AutomationTelemetry dispose', () => {
  it('flushes what is buffered', async () => {
    // A short run's terminal rows would otherwise sit in the buffer until the
    // flush interval and be lost when the app is backgrounded.
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('run_summary', 'ok');
    await t.dispose();
    expect(up.all.length).toBe(1);
  });

  it('is safe to call twice and stops recording after', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('search', 'ok');
    await t.dispose();
    await t.dispose();
    t.record('search', 'ok');
    expect(up.fn).toHaveBeenCalledTimes(1);
    expect(t.pending).toBe(0);
    expect(t.isRecording).toBe(false);
  });

  it('leaves no timer running when the last upload fails', async () => {
    // MEAL-113. dispose() ends with a flush, and flush() re-arms the retry timer
    // whenever the server refuses the batch — so the recorder used to come back
    // out of dispose() with a live timer over a buffer dispose() had just
    // emptied. Nothing observable changes in the app, which is exactly why it
    // went unnoticed: the only symptom is a handle that keeps a Node event loop
    // alive, and under jest that was a run that never exited.
    jest.useFakeTimers();
    try {
      const up = failUpload();
      const t = make({ upload: up.fn });
      t.record('search', 'ok');
      expect(jest.getTimerCount()).toBe(1);   // the flush is armed
      await t.dispose();                      // its upload fails and re-arms it
      expect(jest.getTimerCount()).toBe(0);   // and dispose still ends clean
    } finally {
      jest.useRealTimers();
    }
  });
});

// MEAL-122. Every assertion here reads the batch the UPLOAD function actually
// received, never a spy on record(). The distinction is not academic on this
// library: `sanitizeDetail` silently drops anything that is not a scalar, so a
// detail payload can be "passed" by a call site and still never reach the
// server. Only the uploaded rows prove what a dashboard would be able to group on.
describe('recordPoolAddOutcome', () => {
  const base = { path: 'parallel_add' as const, workerId: 2, itemIndex: 4, addDispatched: true };

  /** Record one outcome on a real recorder and return the rows the server saw. */
  async function upload(out: Parameters<typeof recordPoolAddOutcome>[1]): Promise<StepRecord[]> {
    const up = okUpload();
    const t = make({ upload: up.fn });
    recordPoolAddOutcome(t, out);
    await t.flush();
    return up.all;
  }

  it('emits add_click + confirm for a successful add, and carries the cart verdict', async () => {
    const rows = await upload({
      ...base, success: true, timedOut: false,
      detail: { confirmVia: 'cart_sku', confirmState: 'present' },
    });
    expect(rows.map((r) => [r.step, r.outcome])).toEqual([
      ['add_click', 'ok'],
      ['confirm', 'ok'],
    ]);
    // itemIndex is what ties a row back to its item — without it, five items
    // failing five ways are indistinguishable in the funnel.
    expect(rows.every((r) => r.itemIndex === 4)).toBe(true);
    expect(rows.every((r) => r.code === undefined)).toBe(true);
    expect(rows[0].detail).toEqual({ path: 'parallel_add', workerId: 2 });
    // The MEAL-14 verdict, read off the uploaded row rather than the argument.
    expect(rows[1].detail).toEqual({
      attempt: 1, path: 'parallel_add', workerId: 2,
      confirmVia: 'cart_sku', confirmState: 'present',
    });
  });

  it('codes a reported failure through ADD_REASON_CODES and keeps the raw reason', async () => {
    const rows = await upload({ ...base, success: false, reason: 'no_button', timedOut: false });
    expect(rows.map((r) => r.step)).toEqual(['add_click', 'confirm']);
    expect(rows[0].code).toBeUndefined();      // the attempt itself did not fail
    expect(rows[1].outcome).toBe('error');
    expect(rows[1].code).toBe('selector_miss');
    // toEqual, not toMatchObject: `attempt` is the field a dashboard reads to
    // separate a first try from a retry, and a loose matcher let it drift.
    expect(rows[1].detail).toEqual({
      attempt: 1, path: 'parallel_add', workerId: 2, reason: 'no_button',
    });
  });

  it('still emits the add_click denominator row for an item that never reported', async () => {
    // The whole point of settling at the pool: an item nobody heard back about is
    // the one most worth counting, and it would otherwise vanish from both sides
    // of the confirm rate.
    const rows = await upload({ ...base, success: false, reason: 'timeout', timedOut: true });
    expect(rows.map((r) => [r.step, r.outcome])).toEqual([
      ['add_click', 'ok'],
      ['confirm', 'timeout'],
    ]);
    expect(rows[1].code).toBe('timeout');
  });

  it('reads a timeout as a timeout even when the pool synthesized no reason', async () => {
    const rows = await upload({ ...base, success: false, reason: null, timedOut: true });
    expect(rows[1].outcome).toBe('timeout');
    expect(rows[1].code).toBe('timeout');
    expect(rows[1].detail).toEqual({
      attempt: 1, path: 'parallel_add', workerId: 2, reason: 'timeout',
    });
  });

  it('emits a blocked row for a worker that hit a wall — the row that did not exist before', async () => {
    const rows = await upload({ ...base, success: false, reason: 'blocked', timedOut: false });
    expect(rows.map((r) => [r.step, r.outcome, r.code])).toEqual([
      ['add_click', 'ok', undefined],
      ['blocked', 'blocked', 'waf_block'],
      ['confirm', 'error', 'waf_block'],
    ]);
    // itemIndex on the blocked row is what lets a reader count blocked ITEMS
    // rather than blocked rows, which is why waf_block landing twice is legible.
    expect(rows[1].itemIndex).toBe(4);
    expect(rows[1].detail).toEqual({ reason: 'blocked', path: 'parallel_add', workerId: 2 });
  });

  it('does NOT count an item whose add was never dispatched as an attempt', async () => {
    // The pre-search park timeout: the tap came before the results page did, so
    // onInjectAdd never ran and no add script reached that page. Counting it as
    // an add_click put an item nobody tried to add into the confirm-rate
    // denominator — a number people divide by.
    const rows = await upload({
      ...base, addDispatched: false, success: false, reason: 'timeout', timedOut: true,
    });
    expect(rows.map((r) => [r.step, r.outcome, r.code])).toEqual([
      ['search', 'timeout', 'timeout'],
    ]);
    expect(rows.map((r) => r.step)).not.toContain('add_click');
    expect(rows.map((r) => r.step)).not.toContain('confirm');
    // Still attributable: it is a visible item in the funnel, just not an attempt.
    expect(rows[0].itemIndex).toBe(4);
    expect(rows[0].detail).toEqual({ reason: 'timeout', path: 'parallel_add', workerId: 2 });
  });

  it('reports an undispatched item that failed rather than timed out on its reason', async () => {
    // No producer today — the only undispatched settle is a timeout. Kept so a
    // future one is coded rather than silently dropped.
    const rows = await upload({
      ...base, addDispatched: false, success: false, reason: 'no_results', timedOut: false,
    });
    expect(rows.map((r) => [r.step, r.outcome, r.code])).toEqual([
      ['search', 'error', 'no_candidates'],
    ]);
  });

  it('tags the pool that produced each row', async () => {
    const rows = await upload({ ...base, path: 'presearch', success: true, timedOut: false });
    expect(rows.every((r) => (r.detail as Record<string, unknown>).path === 'presearch')).toBe(true);
  });

  it('numbers an item\'s rows consecutively, so parallel workers cannot interleave one item', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    // Two workers settling back to back, as they do under a real pool.
    recordPoolAddOutcome(t, { path: 'parallel_add', workerId: 0, itemIndex: 0, success: false, reason: 'blocked', timedOut: false, addDispatched: true });
    recordPoolAddOutcome(t, { path: 'parallel_add', workerId: 1, itemIndex: 1, success: true, timedOut: false, addDispatched: true });
    await t.flush();
    expect(up.all.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(up.all.map((r) => r.itemIndex)).toEqual([0, 0, 0, 1, 1]);
  });

  it('never throws, and records nothing it cannot build', async () => {
    const up = okUpload();
    const t = make({ upload: up.fn });
    // A detail whose enumeration throws — telemetry runs inside a worker message
    // handler and a timer callback, and a throw there would disturb a cart run.
    const hostile = Object.defineProperty({}, 'boom', {
      enumerable: true, get() { throw new Error('detail exploded'); },
    }) as Record<string, unknown>;
    expect(() => recordPoolAddOutcome(t, {
      path: 'presearch', workerId: 0, itemIndex: 0, success: true, timedOut: false, addDispatched: true, detail: hostile,
    })).not.toThrow();
    await t.flush();
    // The add_click row precedes the throw and survives; the confirm row is lost.
    // Losing telemetry is always preferable to disturbing an add.
    expect(up.all.map((r) => r.step)).toEqual(['add_click']);
  });

  it('is a no-op on a recorder that is not reporting', async () => {
    const up = okUpload();
    const t = track(new AutomationTelemetry({ runId: 'r', upload: up.fn, enabled: false }));
    recordPoolAddOutcome(t, { path: 'presearch', workerId: 0, itemIndex: 0, success: false, reason: 'blocked', timedOut: false, addDispatched: true });
    await t.flush();
    expect(up.all).toEqual([]);
  });
});

// The reporter and the pools are each covered on their own; nothing above holds
// them TOGETHER. Deleting `onSettled` from either pool in the cart sheet would
// restore the exact defect MEAL-122 is about — an add path that emits no rows —
// and every other test here would still pass, because each half still works.
//
// This is a source scan, and it is worth being clear about what that buys: it
// proves the option is passed, not that the rows come out right for a real run.
// Driving a parallel add end-to-end through the rendered sheet means getting
// through login_check, the qty screen and a mocked WebView's onMessage, which is
// a harness this suite does not have. The scan is the cheap guard against the
// wiring silently going away; it is not a substitute for that harness.
describe('WebViewCartSheet wires both pools to the funnel', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/components/WebViewCartSheet.tsx'), 'utf8',
  );

  /** The option-object body of a hook call, from `<hook>({` to its closing `});`. */
  function optionsBlock(hook: string): string {
    const at = src.indexOf(hook);
    expect(at).toBeGreaterThan(-1);          // the call itself must still exist
    const open = src.indexOf('({', at);
    expect(open).toBeGreaterThan(-1);
    const close = src.indexOf('\n  });', open);
    expect(close).toBeGreaterThan(open);
    return src.slice(open, close);
  }

  /** The handler wired to a pool's onSettled, and the path literal it carries. */
  function wiredHandler(hook: string): { name: string; body: string } {
    const m = /onSettled:\s*(\w+)\s*,/.exec(optionsBlock(hook));
    expect(m).not.toBeNull();
    const name = m![1];
    const at = src.indexOf(`const ${name} = useCallback(`);
    expect(at).toBeGreaterThan(-1);
    return { name, body: src.slice(at, src.indexOf('\n  );', at)) };
  }

  it('wires the parallel ADD pool to a handler that tags path parallel_add', () => {
    // The SEARCH pool (parallelPool) deliberately has no onSettled — it adds
    // nothing, and its `candidates` rows come from the message handler. So this
    // finds the add pool's block by its result type.
    //
    // The path literal is pinned, not just the option: swapping the two handlers
    // makes both pools report as one path, and every other test still passes
    // because each handler works perfectly — for the wrong pool.
    const { body } = wiredHandler('useParallelSearchPool<ConsolidatedIngredient, AddResult>');
    expect(body).toContain("'parallel_add'");
    expect(body).not.toContain("'presearch'");
  });

  it('wires the pre-search pool to a handler that tags path presearch', () => {
    const { body } = wiredHandler('usePresearchAddPool<ConsolidatedIngredient, AddResult>');
    expect(body).toContain("'presearch'");
    expect(body).not.toContain("'parallel_add'");
  });

  it('corrects the pre-search cold slot with the component-only injection flag', () => {
    // The pool reports addDispatched:true for the cold slot from the moment it is
    // dispatched, so without this the uninjected cold item goes back into the
    // confirm-rate denominator — the same defect as the park timeout, one path
    // over. presearchAddDispatched is covered directly in poolAddFunnel.test.ts;
    // what only the source can show is that the component still feeds it the ref.
    const { body } = wiredHandler('usePresearchAddPool<ConsolidatedIngredient, AddResult>');
    expect(body).toContain('presearchAddDispatched(');
    expect(body).toContain('mainColdInjectedRef.current');
    // And that it names the slot the correction applies TO. Point this at the wrong
    // index and the cold slot never matches, the pool's optimistic `true` is used
    // instead, and the defect above is silently back with every test still green.
    // A regex, not toContain: 'slotId: COLD_SLOT_IDX' is a substring of
    // 'slotId: COLD_SLOT_IDX + 1', so the plain form cannot see the mutation.
    expect(body).toMatch(/slotId:\s*COLD_SLOT_IDX\s*[,}]/);
  });

  it('routes them through the extracted mapping rather than an inline one', () => {
    // recordPoolAdd is what poolAddFunnel.test.ts covers directly. An inline
    // re-implementation here would be untested again.
    expect(src).toContain('recordPoolAdd(tel()');
  });
});

describe('createNoopTelemetry', () => {
  it('accepts calls and records nothing', async () => {
    const t = createNoopTelemetry();
    expect(t.isRecording).toBe(false);
    expect(() => t.record('search', 'ok')).not.toThrow();
    const done = t.startTimer('confirm');
    expect(() => done('ok')).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    await expect(t.dispose()).resolves.toBeUndefined();
    expect(t.pending).toBe(0);
  });
});
