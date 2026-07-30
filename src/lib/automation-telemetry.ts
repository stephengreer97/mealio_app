// Per-run step telemetry for the WebView cart engine.
//
// The funnel this feeds answers questions the app previously couldn't without
// asking a user to send their logs: what share of HEB adds confirmed on the first
// click this week, which step runs die on, how slow each step is per store.
//
// Three properties matter more than completeness:
//
//   1. It CANNOT break a cart run. Every entry point swallows its own errors, the
//      buffer is bounded, and uploads are fire-and-forget with a short timeout.
//      Losing telemetry is always preferable to disturbing an add-to-cart.
//   2. Steps are SEQUENCED client-side. Batches upload out of order and many rows
//      share a millisecond, so ordering can't come from the timestamp; `seq` is
//      also the idempotency key the server dedupes on.
//   3. It's SAMPLED and remotely configurable, so cost is a config push away from
//      being dialed down (see telemetry.sampleRate in the automation config).
//
// The upload function is injected rather than imported so tests drive it with a
// fake and no network.

export type StepName =
  | 'login_check'   // did we determine login state, and was the user signed in
  | 'search'        // search navigation + results render
  | 'candidates'    // how many products the extractor found
  | 'add_click'     // the add button was actually clicked
  | 'confirm'       // evidence the item landed (per-card qty, badge, network)
  | 'reconcile'     // the post-run cart diff and what it corrected
  | 'blocked'       // WAF / robot wall
  | 'run_summary';  // one terminal row per run

export type StepOutcome =
  | 'ok'
  | 'empty'     // completed but found nothing (0 candidates)
  | 'timeout'
  | 'error'
  | 'blocked'
  | 'skipped';

export interface StepRecord {
  seq: number;
  step: StepName;
  outcome: StepOutcome;
  durationMs?: number;
  itemIndex?: number;
  detail?: Record<string, unknown>;
}

export type UploadFn = (batch: {
  runId: string;
  configVersion?: number;
  appVersion?: string;
  platform?: 'ios' | 'android';
  steps: StepRecord[];
}) => Promise<boolean>;

export interface TelemetryOptions {
  runId: string;
  upload: UploadFn;
  enabled?: boolean;
  /** 0..1. Rolled once per run so a sampled run reports ALL its steps — a
   *  per-step coin flip would produce funnels with holes that read as failures. */
  sampleRate?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  configVersion?: number;
  appVersion?: string;
  platform?: 'ios' | 'android';
  /** Injected for tests. */
  random?: () => number;
}

// Hard ceiling on buffered rows. A wedged run that loops forever must not grow
// the buffer without bound; past this we drop the OLDEST rows, because the tail
// of a failing run is the part worth keeping.
const MAX_BUFFER = 500;
// Detail payloads are for diagnosis, not archival. Cap the key count and value
// sizes so a well-meaning caller can't attach a page's worth of HTML.
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_STRING = 200;

/** Strip a detail payload down to something safe to send. Never throws. */
export function sanitizeDetail(detail: unknown): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (keys >= MAX_DETAIL_KEYS) break;
    if (v == null) continue;
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_DETAIL_STRING);
    // Objects/arrays are deliberately dropped: nesting is where accidental
    // payload bloat and PII both hide.
    else continue;
    keys++;
  }
  return keys > 0 ? out : undefined;
}

export class AutomationTelemetry {
  private buffer: StepRecord[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private disposed = false;
  private readonly sampled: boolean;

  constructor(private readonly opts: TelemetryOptions) {
    const rate = opts.sampleRate ?? 1;
    const rand = opts.random ?? Math.random;
    this.sampled = (opts.enabled ?? true) && !!opts.runId && (rate >= 1 || rand() < rate);
  }

  /** False when this run isn't reporting, so callers can skip building details. */
  get isRecording(): boolean {
    return this.sampled && !this.disposed;
  }

  record(
    step: StepName,
    outcome: StepOutcome,
    extra: { durationMs?: number; itemIndex?: number; detail?: Record<string, unknown> } = {},
  ): void {
    if (!this.isRecording) return;
    try {
      const record: StepRecord = { seq: this.seq++, step, outcome };
      if (typeof extra.durationMs === 'number' && Number.isFinite(extra.durationMs)) {
        record.durationMs = Math.max(0, Math.trunc(extra.durationMs));
      }
      if (typeof extra.itemIndex === 'number' && Number.isFinite(extra.itemIndex)) {
        record.itemIndex = Math.trunc(extra.itemIndex);
      }
      const detail = sanitizeDetail(extra.detail);
      if (detail) record.detail = detail;

      this.buffer.push(record);
      if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);

      const batchSize = this.opts.batchSize ?? 25;
      if (this.buffer.length >= batchSize) void this.flush();
      else this.scheduleFlush();
    } catch { /* telemetry must never throw into the engine */ }
  }

  /**
   * Start timing a step. The returned function records it with the elapsed time.
   * Calling it more than once is a no-op after the first, so a step that both
   * succeeds and then times out logs only what actually happened first.
   */
  startTimer(step: StepName, itemIndex?: number) {
    const startedAt = Date.now();
    let settled = false;
    return (outcome: StepOutcome, detail?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      this.record(step, outcome, { durationMs: Date.now() - startedAt, itemIndex, detail });
    };
  }

  private scheduleFlush(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushIntervalMs ?? 10_000);
  }

  /** Upload buffered steps. Re-queues the batch when the server says it's worth
   *  retrying (5xx/timeout) and drops it when it doesn't (4xx). */
  async flush(): Promise<void> {
    if (!this.sampled || this.flushing || this.buffer.length === 0) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      const ok = await this.opts.upload({
        runId: this.opts.runId,
        configVersion: this.opts.configVersion,
        appVersion: this.opts.appVersion,
        platform: this.opts.platform,
        steps: batch,
      });
      if (!ok && !this.disposed) {
        // Put the failed batch back at the FRONT: seq still orders it correctly,
        // and the server dedupes, so a later duplicate is harmless.
        this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFER);
        this.scheduleFlush();
      }
    } catch {
      if (!this.disposed) this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFER);
    } finally {
      this.flushing = false;
      // More arrived while we were uploading (or the retry re-queued).
      if (this.buffer.length >= (this.opts.batchSize ?? 25)) void this.flush();
    }
  }

  /** Final flush + stop timers. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // Flush BEFORE marking disposed so the last batch is still sent; a run's
    // terminal rows are the most valuable ones in the funnel.
    await this.flush().catch(() => {});
    this.disposed = true;
    this.buffer = [];
  }

  /** Buffered-row count. Test/diagnostic use. */
  get pending(): number {
    return this.buffer.length;
  }
}

/** A recorder that discards everything — used when a run isn't sampled or has no
 *  runId, so call sites never need a null check. */
export function createNoopTelemetry(): AutomationTelemetry {
  return new AutomationTelemetry({ runId: '', upload: async () => true, enabled: false });
}
