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

/**
 * WHY a step failed, as opposed to `outcome`, which only says THAT it did.
 *
 * The outcome alone can't be acted on: 'error' covers a broken selector, a
 * challenge wall, and a click that never committed, and the fix for each has
 * nothing to do with the other two. The code names the fix family, so the funnel
 * can be grouped into work rather than into a single "failures" bar.
 *
 * This list is a CONTRACT shared with the Kroger Brands web extension, which
 * emits the same vocabulary into the same table. Adding a code means agreeing on
 * it in both places first; a code that only one side emits reads as a regression
 * on the other's chart. Codes are only ever appended — the dashboard groups on
 * the raw string, so renaming one silently splits a metric's history.
 *
 *   selector_miss   element not found              → selector config / healing
 *   waf_block       challenge or robot wall        → backoff, fingerprint, handoff
 *   auth_required   logged out mid-run             → pre-warm, session
 *   no_candidates   search returned nothing        → search / matching
 *   match_rejected  candidates found, none good    → scoring
 *   confirm_failed  clicked, no evidence it landed → confirmation rail
 *   timeout         step exceeded its budget       → timeouts, perf
 *   nav_failed      navigation never completed     → URL / routing
 *
 * `nav_failed` has no producer in this app: the WebView engine can't distinguish
 * a nav that never completed from a page that loaded and never answered, so
 * those land on `timeout` instead (see the search/add safety timeouts). It is
 * kept here because the extension, which drives real navigations, does emit it.
 */
export const STEP_FAILURE_CODES = [
  'selector_miss',
  'waf_block',
  'auth_required',
  'no_candidates',
  'match_rejected',
  'confirm_failed',
  'timeout',
  'nav_failed',
] as const;

export type StepFailureCode = (typeof STEP_FAILURE_CODES)[number];

/**
 * The codes in order of how much they EXPLAIN, most explanatory first.
 *
 * This is not "how bad it is" — it is "if you only read one code from this run,
 * which one tells you what happened". The top two are conditions under which
 * everything downstream was always going to fail, so a count of the downstream
 * failures says nothing:
 *
 *   waf_block      the store refused us. Nothing after this is evidence of anything.
 *   auth_required  not signed in, so every add would have failed regardless.
 *   nav_failed     the page never loaded, so nothing could be read from it.
 *   selector_miss  the page is not the shape we expect. Usually store drift, and
 *                  it explains the misses that follow it.
 *   timeout        genuinely ambiguous — the page may be slow, or wrong.
 *   no_candidates  the search returned nothing. Often a true answer about stock.
 *   match_rejected we saw products and none matched. A real, actionable answer.
 *   confirm_failed most often a SYMPTOM: the add was dispatched and nothing
 *                  evidenced it landing, which is what any of the above causes
 *                  looks like from here.
 *
 * Reordering this changes which code lands on the run_summary row, and that row
 * is what the dashboard groups on — so it is a reporting decision, not a cleanup.
 */
const FAILURE_CODE_SEVERITY = [
  'waf_block',
  'auth_required',
  'nav_failed',
  'selector_miss',
  'timeout',
  'no_candidates',
  'match_rejected',
  'confirm_failed',
] as const satisfies readonly StepFailureCode[];

// Exhaustiveness, checked by the compiler rather than by whoever adds the next
// code: a new member of STEP_FAILURE_CODES that is missing from the table above
// makes this line an error, so the ranking cannot silently fall through to the
// frequency fallback.
type _SeverityCoversEveryCode =
  Exclude<StepFailureCode, (typeof FAILURE_CODE_SEVERITY)[number]> extends never
    ? true
    : ['FAILURE_CODE_SEVERITY is missing a StepFailureCode'];
const _severityIsExhaustive: _SeverityCoversEveryCode = true;
void _severityIsExhaustive;

/** Outcomes that end a step in failure and therefore must carry a code.
 *  'skipped' is excluded deliberately: a step that never ran didn't fail. */
export type FailureOutcome = Exclude<StepOutcome, 'ok' | 'skipped'>;

/**
 * Store-script failure `reason` → code, for the add/confirm half of a run.
 *
 * The reasons are the vocabulary the injected scripts already post back in
 * ADD_RESULT / SEARCH_AND_ADD_RESULT; this is the only place that translates
 * them, so a new store script only has to reuse an existing reason to be
 * grouped correctly.
 *
 * Two of these are honest-but-imperfect fits, kept rather than growing the
 * enum unilaterally (the extension would not know a ninth code):
 *   • out_of_stock — the store had the item and we declined it, which is the
 *     shape of match_rejected even though the fix is substitution, not scoring.
 *   • needs_weight — a sold-by-weight item bailed to the review picker for a
 *     poundage. It's a handoff, not a failure of any family here.
 * Both keep their raw reason in the row's detail, so the dashboard can split
 * them back out without a schema change.
 *
 * Two more are genuinely ambiguous at the source and take the conservative read:
 *   • click_failed — Walmart's click loop returns the same reason whether the
 *     button was missing/disabled or the cart total never moved after clicking.
 *     Only the second is knowable from the RN side, so it reads as confirm_failed
 *     rather than sending anyone selector-hunting on a coin flip.
 *   • not_found — the chosen product's card wasn't on the results page. On the
 *     add path the candidates were already extracted once for that term, so a
 *     miss now points at the page/selectors, not at the search.
 */
export const ADD_REASON_CODES: Record<string, StepFailureCode> = {
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
  // MEAL-14: the store's own cart query answered and our line was absent (or
  // unchanged) after the click. `confirm_failed` is the right family — nothing
  // landed — but it is the only member of it backed by positive evidence rather
  // than by an absent signal, so the raw reason in detail is what separates a
  // cart-verified miss from a badge that never moved.
  cart_absent: 'confirm_failed',
  // MEAL-14 review: the cart said absent and the per-card "N added" label said
  // added. Two independent product-specific signals disagreeing is not a miss, so
  // the add still commits on the label and these should NOT normally reach a
  // failure row at all — they are mapped because a reason that can be emitted must
  // have a deliberate family, not fall through to a default. `confirm_failed` is
  // the least wrong: if one of these ever does surface as a failure, what happened
  // is that we could not verify the item, and the raw reason in detail says which
  // signal we distrusted. A run producing these repeatedly means the cart read is
  // unreliable and `stores.heb.cartSkuConfirm` should go back off.
  contradicted: 'confirm_failed',
  contradicted_by_card: 'confirm_failed',
  not_confirmed: 'confirm_failed',
  click_failed: 'confirm_failed',
  blocked: 'waf_block',
  timeout: 'timeout',
  // The add landed, just short of the quantity asked for (Walmart, both the
  // ADD_RESULT and the fused SEARCH_AND_ADD_RESULT paths: `success` is
  // `added === QTY`, so 1-of-2 arrives here as a failure). It is the one reason
  // in this table where the cart demonstrably DID move, which makes the
  // `confirm_failed` fallback the worst available fit — "no evidence it landed"
  // is the opposite of what happened. Filed under match_rejected because the
  // fix family is the same: we could not get the units we wanted for this item.
  partial: 'match_rejected',
  // A store script threw and its catch reported out (ALDI's search-and-add).
  // Not a confirm failure — nothing was confirmed because nothing completed —
  // but there is no `script_error` code and adding one is a schema change the
  // extension would have to agree to. `confirm_failed` explicitly, so that at
  // least it is a decision on the record rather than the fallback silently
  // swallowing an exception class.
  error: 'confirm_failed',
};

/**
 * Code for an add/confirm failure reported by a store script.
 *
 * Unknown and missing reasons fall to `confirm_failed` on purpose: by the time a
 * script reports a failure the add was already dispatched, so "we have no
 * evidence it landed" is the one thing that is always true. The alternatives
 * would send someone hunting a selector or a scorer on no evidence.
 */
export function addFailureCode(reason: string | null | undefined): StepFailureCode {
  if (!reason) return 'confirm_failed';
  return ADD_REASON_CODES[reason] ?? 'confirm_failed';
}

/**
 * Code for a `blocked` step, keyed by the reason surfaceBlocker was called with.
 *
 * 'fresh-no-store' is the imperfect one: Amazon Fresh answering with its empty
 * state means no store or delivery address is selected, which is a session
 * precondition rather than a robot wall. It rides on auth_required because the
 * fix family (pre-warm the session before the run) is the same one; the raw
 * reason stays in detail so it can be split off the auth chart.
 */
export function blockFailureCode(reason: string): StepFailureCode {
  return reason === 'fresh-no-store' ? 'auth_required' : 'waf_block';
}

export interface StepRecord {
  seq: number;
  step: StepName;
  outcome: StepOutcome;
  /** Present on every failing terminal step; absent on 'ok'/'skipped'. Sent as a
   *  top-level column so the dashboard can group on it without touching detail. */
  code?: StepFailureCode;
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

type RecordExtra = { durationMs?: number; itemIndex?: number; detail?: Record<string, unknown> };

/** Settle function returned by startTimer. Same code-on-failure rule as record. */
export interface StepSettle {
  (outcome: 'ok' | 'skipped', detail?: Record<string, unknown>): void;
  (outcome: FailureOutcome, detail: Record<string, unknown> | undefined, code: StepFailureCode): void;
}

export class AutomationTelemetry {
  private buffer: StepRecord[] = [];
  private seq = 0;
  // Every code recorded this run, counted. Feeds primaryFailureCode() and
  // failureCodeCounts() — see
  // there for why the run's own terminal row needs it.
  private readonly failureCounts = new Map<StepFailureCode, number>();
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

  // The overloads are what make "every terminal failure carries a code" a
  // compile error rather than a code review: a failing outcome cannot be
  // recorded without one. A call site whose outcome is a ternary has to split,
  // which is the point — the code almost always depends on the same condition.
  record(step: StepName, outcome: 'ok' | 'skipped', extra?: RecordExtra): void;
  record(step: StepName, outcome: FailureOutcome, extra: RecordExtra & { code: StepFailureCode }): void;
  record(
    step: StepName,
    outcome: StepOutcome,
    extra: RecordExtra & { code?: StepFailureCode } = {},
  ): void {
    if (!this.isRecording) return;
    try {
      const record: StepRecord = { seq: this.seq++, step, outcome };
      if (extra.code) {
        record.code = extra.code;
        this.failureCounts.set(extra.code, (this.failureCounts.get(extra.code) ?? 0) + 1);
      }
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
  startTimer(step: StepName, itemIndex?: number): StepSettle {
    const startedAt = Date.now();
    let settled = false;
    const settle = (outcome: StepOutcome, detail?: Record<string, unknown>, code?: StepFailureCode): void => {
      if (settled) return;
      settled = true;
      this.record(step, outcome as FailureOutcome, {
        durationMs: Date.now() - startedAt, itemIndex, detail, code: code as StepFailureCode,
      });
    };
    return settle as StepSettle;
  }

  /**
   * The code that best EXPLAINS this run, by severity rather than by count.
   *
   * The run's terminal row has no cause of its own — it fails because its steps
   * did — so it borrows one. The dashboard could derive this by joining a run's
   * step rows, but the run_summary row is the one most likely to survive a dropped
   * batch or a truncated buffer, so it carries the answer itself. That is exactly
   * why the answer has to be the useful one.
   *
   * It used to return whichever code appeared MOST OFTEN, which buries the causes
   * worth acting on. A run with three `confirm_failed` and one `waf_block`
   * reported `confirm_failed` — so a store that had blocked us looked like eight
   * ordinary confirmation misses, and the row most likely to become the headline
   * number on the dashboard named the symptom instead of the cause.
   *
   * Frequency is not lost: `failureCodeCounts()` carries the whole tally, and the
   * caller puts it in the row's detail. So both readings are available and this
   * ranking is a default, not a deletion.
   */
  primaryFailureCode(): StepFailureCode | undefined {
    for (const code of FAILURE_CODE_SEVERITY) {
      if (this.failureCounts.has(code)) return code;
    }
    // A code outside the severity table should be impossible — the table is
    // exhaustive over StepFailureCode and the compiler checks it below. If one
    // ever appears anyway, say something rather than nothing: fall back to the
    // most frequent, which is the old behaviour.
    let best: StepFailureCode | undefined;
    let bestCount = 0;
    for (const [code, count] of this.failureCounts) {
      if (count > bestCount) { best = code; bestCount = count; }
    }
    return best;
  }

  /** Every failure code recorded this run, with its count. Ordered most frequent
   *  first so a reader sees the shape of the run, not just its worst moment. */
  failureCodeCounts(): Record<string, number> {
    return Object.fromEntries(
      [...this.failureCounts.entries()].sort((a, b) => b[1] - a[1]),
    );
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
    // That flush re-arms the timer when the upload fails — it re-queues the
    // batch and schedules the retry, and it had no way to know it was being
    // disposed. Clear it again: nothing may outlive dispose().
    //
    // What that timer actually was, measured, because a generation guard around
    // this lifecycle has to know: ONE pending timeout, not an unbounded chain. It
    // fires once, `flush()` returns immediately on the empty buffer this line just
    // cleared, and nothing re-arms — one flushInterval of lifetime and then gone.
    // (The unbounded chain is the other half of the leak: an UNDISPOSED recorder
    // whose uploads keep failing re-arms on every refused attempt, forever. That
    // one is why the test run hung; this one is not.)
    //
    // A single bounded timeout is still worth clearing. It is a handle that keeps
    // an event loop alive past the run that owns it — which is how jest came to
    // need `--forceExit` — and it makes dispose() mean what it says.
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
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
