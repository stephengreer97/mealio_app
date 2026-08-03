import {
  AutomationTelemetry,
  createNoopTelemetry,
  sanitizeDetail,
  StepRecord,
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

const make = (opts: Partial<ConstructorParameters<typeof AutomationTelemetry>[0]> = {}) =>
  new AutomationTelemetry({
    runId: 'run-1',
    upload: async () => true,
    batchSize: 1000,        // large so nothing auto-flushes unless a test wants it
    flushIntervalMs: 60_000,
    ...opts,
  });

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
    t.record('confirm', 'error');
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
    done('timeout');
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
    const t = new AutomationTelemetry({
      runId: 'run-9', upload: up.fn, configVersion: 7,
      appVersion: '1.2.3', platform: 'android', batchSize: 1000, flushIntervalMs: 60_000,
    });
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
