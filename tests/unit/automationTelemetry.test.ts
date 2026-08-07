import fs from 'fs';
import path from 'path';
import {
  AutomationTelemetry,
  ADD_REASON_CODES,
  addFailureCode,
  blockFailureCode,
  createNoopTelemetry,
  sanitizeDetail,
  StepRecord,
  STEP_FAILURE_CODES,
} from '../../src/lib/automation-telemetry';

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
  it('exposes exactly the eight agreed codes', () => {
    expect([...STEP_FAILURE_CODES]).toEqual([
      'selector_miss', 'waf_block', 'auth_required', 'no_candidates',
      'match_rejected', 'confirm_failed', 'timeout', 'nav_failed',
    ]);
  });

  it('maps the reasons this table was written against', () => {
    const expected: Record<string, string> = {
      no_results: 'no_candidates',
      low_confidence: 'match_rejected',
      out_of_stock: 'match_rejected',
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
      // MEAL-136: a CART_COUNT reason, not an ADD_RESULT one. The Albertsons
      // cart-page script posts it alongside `count: null` when a redirect landed
      // us somewhere other than /erums/cart, so it explains why a COUNT is
      // unknown — it never describes an add, and addFailureCode never sees it.
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

  it('reports the dominant code for the run, ties going to the first seen', () => {
    const t = make();
    expect(t.dominantFailureCode()).toBeUndefined();
    t.record('confirm', 'error', { code: 'selector_miss' });
    t.record('confirm', 'error', { code: 'confirm_failed' });
    expect(t.dominantFailureCode()).toBe('selector_miss');
    t.record('confirm', 'error', { code: 'confirm_failed' });
    expect(t.dominantFailureCode()).toBe('confirm_failed');
  });

  it('keeps the run tally past a flush and past buffer trimming', async () => {
    // run_summary is recorded last, after the buffer has been flushed several
    // times over — the tally must not live in the buffer.
    const up = okUpload();
    const t = make({ upload: up.fn });
    t.record('confirm', 'error', { code: 'waf_block' });
    await t.flush();
    for (let i = 0; i < 600; i++) t.record('search', 'ok');
    expect(t.dominantFailureCode()).toBe('waf_block');
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
