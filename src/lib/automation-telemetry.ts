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
 * Codes are only ever APPENDED, and never renamed or removed. The code is stored
 * as a raw string on every row ever written, so a rename splits a metric's
 * history and a removal orphans the rows already carrying it — neither of which
 * fails anywhere visible. Appending is a convention on top of that: it keeps this
 * list readable as the order the codes were introduced in. Nothing reads the
 * ORDER of this array. What is order-sensitive is FAILURE_CODE_SEVERITY below,
 * which is a separate list for exactly that reason.
 *
 * This list used to be described here as a contract shared with the Kroger
 * Brands web extension, needing agreement on both sides before a code could be
 * added. That is no longer true and had become a standing block on work (MEAL-29):
 * the extensions are retired, the Kroger Brands integration writes no
 * `automation_steps` rows at all, the ingest route stores the string as-is
 * without checking it against any enum, and the server's copy of this list says
 * in its own docblock that it is for display ordering and NOT a filter. This app
 * is the only producer, so appending here is a one-repo change.
 *
 *   selector_miss   element not found              → selector config / healing
 *   waf_block       challenge or robot wall        → backoff, fingerprint, handoff
 *   auth_required   logged out mid-run             → pre-warm, session
 *   no_candidates   search returned nothing        → search / matching
 *   match_rejected  candidates found, none good    → scoring
 *   confirm_failed  clicked, no evidence it landed → confirmation rail
 *   timeout         step exceeded its budget       → timeouts, perf
 *   nav_failed      navigation never completed     → URL / routing
 *   out_of_stock    the store does not have it     → nothing. Not our failure.
 *
 * `out_of_stock` is the one code here that does not name a fix family, because
 * there is no fix: the store is out of the item. It exists so that outcome stops
 * being counted as one of ours — before this it rode `match_rejected`, which put
 * the store's inventory on the same bar as our scoring being wrong (MEAL-29).
 *
 * It is also the only code that makes a store's numbers look BETTER: the server
 * subtracts these items from the item-success denominator, so a store reporting
 * more of them reports a higher success rate. That puts weight on the store
 * scripts being right about which items get it, and they are not simply reading a
 * flag — the shape is "the page says out of stock" AND "this is the item we
 * asked for", and the second half is our own exact-match judgement (see
 * `hasExactOos` in instacart.ts, whose comment records a version that tested a
 * 30-point similarity threshold and so reported out_of_stock for products that
 * merely resembled the request). A regression that loosens exact-match therefore
 * does not show up as a failure; it shows up as a store getting quietly better.
 * The count is reported on the dashboard tile and in the alert email next to the
 * rate it adjusted, so the inflation is at least visible, but the honest summary
 * is that this code is only as trustworthy as the exact-match gate feeding it.
 *
 * `nav_failed` has no producer in this app: the WebView engine can't distinguish
 * a nav that never completed from a page that loaded and never answered, so
 * those land on `timeout` instead (see the search/add safety timeouts). It is
 * kept because removing a code is the one edit this list does not allow, and
 * because rows carrying it already exist from when the extension emitted it.
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
  // Appended, and append-only — see above. MEAL-29.
  'out_of_stock',
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
 *   timeout        ranked here not because a timeout is itself explanatory — it is
 *                  ambiguous, and on its own that argues for ranking it LOW — but
 *                  because in this app it is the catch-all for two conditions that
 *                  explain a whole run. It absorbs every `nav_failed` case (see
 *                  above), and a `login_check` timeout means we never established
 *                  whether the user was signed in, which is `auth_required`'s
 *                  neighbourhood. Those outrank any per-item answer below.
 *                  The cost: `selector_miss` sits above it, so a run whose login
 *                  check timed out and whose one add hit a missing button headlines
 *                  as store drift. Accepted, because if the user was in fact signed
 *                  in, drift IS the story. Splitting the code would fix it
 *                  properly, and now that this enum has no second party (see
 *                  STEP_FAILURE_CODES) nothing outside this repo stops that.
 *   no_candidates  the search returned nothing. Often a true answer about stock.
 *   out_of_stock   the store told us it has none. Ranked above match_rejected
 *                  because when a run fails for several reasons at once, "the
 *                  store was out of it" is a better headline than "we didn't like
 *                  any of the matches": it is the store's own answer about that
 *                  item rather than our judgement of it, so there is nothing to
 *                  go and check. Below no_candidates, which is the same answer
 *                  arriving less certainly — an empty search result MIGHT be
 *                  stock and might be our search term, and the ambiguous one is
 *                  the one worth looking at first.
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
  'out_of_stock',
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
 * `out_of_stock` maps to itself (MEAL-29). It used to ride `match_rejected` —
 * listed here as an honest-but-imperfect fit, kept because growing the enum was
 * believed to need a second party's agreement — which meant an item the store
 * does not stock was counted on the same bar as our scorer refusing every
 * candidate. Those are not the same problem and only one of them is ours.
 *
 * `needs_weight` is still an imperfect fit: a sold-by-weight item bailed to the
 * review picker for a poundage, which is a handoff rather than a failure of any
 * family here. It keeps its raw reason in the row's detail, so the dashboard can
 * split it back out without a schema change.
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
  out_of_stock: 'out_of_stock',
  needs_weight: 'match_rejected',
  not_found: 'selector_miss',
  no_button: 'selector_miss',
  no_modal: 'selector_miss',
  no_row: 'selector_miss',
  no_trigger: 'selector_miss',
  stepper_not_found: 'selector_miss',
  pref_required: 'selector_miss',
  // MEAL-200: the store's add request answered with an error arm instead of a
  // cart — "You must supply a weight to purchase this item.", say.
  //
  // MAPPED BUT NOT REACHABLE, and that is the honest state. The guard below
  // requires a code for every reason the store scripts can emit, and this one is
  // emitted — but only onto the EXTRACT_DEBUG channel. The run then CLICKS, and
  // whatever the click does is what reaches a failure row, so addFailureCode is
  // never called with this. It is here to satisfy the guard and to be correct on
  // the day the network path reports its own failures; nothing looks it up today.
  // match_rejected is the family it belongs to: the store declined the request
  // as malformed for that product, which is not a confirmation failure.
  error_arm: 'match_rejected',
  // MEAL-200: the network write's answer was lost (timeout / dropped connection)
  // AND the cart could not be re-read to find out whether it landed. The run
  // deliberately does NOT click in that state — clicking on top of a set that did
  // apply adds the item twice — so nothing was attempted twice and nothing is
  // confirmed. confirm_failed is the family: no evidence it landed. The raw
  // reason in detail is what separates it from a click that simply did not take.
  write_unresolved: 'confirm_failed',
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
  // but there is no `script_error` code. Adding one was described here as a
  // schema change needing the extension's agreement; that was wrong and is now
  // corrected at STEP_FAILURE_CODES, so this stays `confirm_failed` on its own
  // merits and not because anything blocks it. Explicit rather than left to the
  // fallback, so that it is a decision on the record rather than a silently
  // swallowed exception class.
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
  /** Position in the run's active-items array at the time the row was recorded.
   *  NOT a run-wide item identity: the reconcile re-points that array at its
   *  retry subset and restarts the index, so rows from the top-up reuse low
   *  indexes for different items. Group by `detail.path` before comparing. */
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
export const MAX_DETAIL_KEYS = 12;
// Exported so a caller that has to pre-chunk a long value can chunk against the
// REAL cap rather than a copy of it. Truncation here is silent — a payload that
// overruns arrives parseable and short — so anything building a flat string long
// enough to hit this must be able to see where it is (see SelectorHealthTally).
export const MAX_DETAIL_STRING = 200;

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
  // failureCodeSummary() — see there for why the run's own terminal row needs it.
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
   * Frequency is not lost: `failureCodeSummary()` carries the whole tally, and the
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

  /**
   * Every failure code recorded this run with its count, as a flat string:
   * `"confirm_failed:3,waf_block:1"`. Most frequent first, so a reader sees the
   * shape of the run and not just its worst moment.
   *
   * A STRING, not the obvious Record, because `sanitizeDetail` drops objects and
   * arrays outright — nesting is where payload bloat and PII hide, so that is the
   * right call and this has to live within it. An earlier version of this returned
   * a Record and the tally was silently discarded on its way to the server, which
   * made the claim that ranking by severity loses nothing quietly false. Measured,
   * not assumed: `sanitizeDetail({a:1, failureCodes:{x:1}})` returns `{a:1}`.
   *
   * All nine codes at worst is ~150 characters, inside the 200-char string cap.
   * Two more codes would put it at the edge; a tenth should re-measure this.
   */
  failureCodeSummary(): string | undefined {
    if (this.failureCounts.size === 0) return undefined;
    return [...this.failureCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code}:${count}`)
      .join(',');
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

/** One item's final outcome as a worker pool settled it. */
export interface PoolAddOutcome {
  /** Which pool produced it, for splitting the funnel by add path. */
  path: 'parallel_add' | 'presearch';
  /** Pool slot that ran the item. Not stable across items — a slot is reused. */
  workerId: number;
  /** The item's index in the run's active-items array. */
  itemIndex: number;
  success: boolean;
  /** The store script's failure reason, or null. Ignored when `success`. */
  reason?: string | null;
  /** True when no worker reported and the pool synthesized the result. */
  timedOut: boolean;
  /** Whether an add was actually sent to the item's page. False means we never
   *  got as far as trying — see PoolSettled.addDispatched for what each pool can
   *  honestly say, and the `search` row below for what that item gets instead. */
  addDispatched: boolean;
  /** Extra scalars for the confirm row (the caller's flattened cart verdict).
   *  Nested values are dropped downstream by sanitizeDetail. */
  detail?: Record<string, unknown>;
}

/**
 * Emit the per-item add funnel rows for ONE item a worker pool has settled.
 *
 * MEAL-122. The parallel-add and pre-search pools report every item's outcome
 * through their pool, not through the sequential engine, so before this the
 * PARALLEL PASS emitted no add or confirm rows at all on the four stores those
 * pools serve (HEB, Walmart, Amazon Fresh, Albertsons). Five items failing five
 * different ways collapsed into the single reconcile row that followed them.
 *
 * Not the whole run, though: the serial top-up that follows a shortfall emits
 * both halves for the subset it retries (`path: 'fused'`), and since the
 * reconcile exists BECAUSE shortfalls are common, a failing run on these stores
 * routinely did emit add/confirm rows. What it could not emit was a row for an
 * item the top-up never retried — anything the cart said had landed, and the
 * definite failures (out_of_stock, no_results) that route to review instead of
 * retry. So the funnel's add half was a biased sample: only items that failed at
 * least once in the parallel pass, never the ones that worked. A confirm rate
 * computed over it is a rate among items already known to have gone wrong once,
 * which is not the number anyone thinks they are reading.
 *
 * Rows emitted, when an add WAS dispatched, in this order:
 *   add_click  ok       always — this is the confirm-rate DENOMINATOR
 *   blocked    blocked  only when the reason is 'blocked' (see below)
 *   confirm    ok | timeout | error
 *
 * And when it was NOT (`addDispatched: false`), one row instead:
 *   search     timeout | error
 *
 * That second case is the pre-search pool's park timeout: the user tapped
 * add-to-cart while an item's results page was still loading, the pool stopped
 * waiting, and onInjectAdd never ran — no add script ever touched that page. It
 * emitted an `add_click` here until it didn't, which put an item nobody had tried
 * to add into the denominator of the confirm rate. The denominator is a real
 * number people divide by, so the item is reported for what it is: a `search`
 * that never finished. It keeps its itemIndex and stays visible in the funnel; it
 * just is not counted as an attempt.
 *
 * (The 'error' variant of that row has no producer today — the only undispatched
 * settle is a timeout. It exists so that a future one is not silently dropped,
 * the way STEP_FAILURE_CODES keeps `nav_failed` for a producer it does not have.)
 *
 * Both add halves are emitted at SETTLE rather than add_click at dispatch, which
 * is how the sequential path does it. That is safe here for a reason specific to
 * the pools: every dispatched item settles exactly once — a real worker result,
 * or a result the pool synthesizes when its timeout fires — so no attempt can
 * vanish from the denominator by never being heard from. (The one item that
 * settles zero times is one abandoned by reset(), i.e. a cancelled run, and an
 * abandoned attempt is correctly absent from both sides of the rate.) The fused
 * sequential handler already emits the pair together for the same reason: the
 * click happens inside the injected script, so there is no click moment to hook.
 *
 * The `blocked` row: a worker that hits an app-nudge or robot wall reports
 * reason 'blocked' and is recorded as a failed add. The engine deliberately does
 * NOT escalate that to the UI from the worker message handler — the reconcile's
 * serial retry re-detects the wall and calls surfaceBlocker, and calling it from
 * the handler would forward-reference it. That restraint is about the USER-FACING
 * escalation only; it never had a telemetry reason. Recording the row here
 * surfaces nothing and touches no UI.
 *
 * What it adds is attribution, not existence. surfaceBlocker records a `blocked`
 * row of its own, so a wall was never invisible: a blocked item claims no cart
 * row, becomes a shortfall, lands in the reconcile's retry set, and the serial
 * fused retry re-detects the nudge and records it. But that row is RUN-LEVEL —
 * one per run, no itemIndex, and only after a second page load on a store that
 * has just refused us. This row is per-item and immediate, so a funnel can say
 * which items the wall took and how many, without waiting for the re-detect.
 *
 * It does land `waf_block` on the run's code tally twice for one item — once
 * here and once on the confirm row that follows, whose reason is also 'blocked'.
 * Both rows genuinely failed for that reason, so both are counted rather than one
 * being suppressed. Concretely, once PR #83 lands: its failureCodeSummary() reads
 * the same failureCounts map into `run_summary.failureCodes`, so a single blocked
 * item reads there as `waf_block:2`, and run_summary carries no itemIndex to
 * de-duplicate against. Only the tally distorts — #83 ranks the run's PRIMARY
 * code by severity, not by count, so the headline code is immune. A reader
 * wanting items rather than rows counts distinct itemIndex on the blocked rows.
 *
 * That immunity is worth more than it sounds, because these rows RELOCATE what
 * run_summary's code means. It used to be a run-level verdict derived from one or
 * two rows; with 2N per-item rows it becomes a vote over them. Under the
 * frequency rule on main today that is roughly lateral — a run whose code was
 * `confirm_failed` from the reconcile now reports the modal per-item symptom
 * instead, which hides no more than it did. Under #83's severity rule it is a
 * clear gain: a single wall among many ordinary misses wins, where a vote buries
 * it. So the two changes are complements, and #83 is the one that turns this
 * volume into an answer rather than a bigger majority.
 *
 * Never throws. The pools call this from a worker message handler and from a
 * timer, and telemetry must never disturb an add — record() already swallows its
 * own errors, and the outer catch covers building the arguments too.
 */
export function recordPoolAddOutcome(tel: AutomationTelemetry, out: PoolAddOutcome): void {
  try {
    const base = { path: out.path, workerId: out.workerId };
    if (!out.addDispatched) {
      // Never reached its add — report the step it actually died on, and leave
      // the add funnel alone. See the header for why this is not an add_click.
      const why = String(out.reason ?? (out.timedOut ? 'timeout' : 'unknown'));
      // Split rather than a ternary outcome: record()'s overloads require the
      // code to be decided alongside the outcome, which is the point of them.
      if (out.timedOut) {
        tel.record('search', 'timeout', {
          itemIndex: out.itemIndex, detail: { reason: why, ...base }, code: 'timeout',
        });
      } else {
        tel.record('search', 'error', {
          itemIndex: out.itemIndex, detail: { reason: why, ...base }, code: addFailureCode(why),
        });
      }
      return;
    }
    // Emitted for a timed-out item as well: the add went to the page, so it
    // counts as an attempt whether or not we ever heard that a button was
    // pressed. On the parallel-add pool "went to the page" is the page load
    // itself — see PoolSettled.addDispatched for why that is the honest read.
    tel.record('add_click', 'ok', { itemIndex: out.itemIndex, detail: { ...base } });
    if (out.success) {
      tel.record('confirm', 'ok', {
        itemIndex: out.itemIndex,
        detail: { attempt: 1, ...base, ...out.detail },
      });
      return;
    }
    const reason = String(out.reason ?? (out.timedOut ? 'timeout' : 'unknown'));
    if (reason === 'blocked') {
      tel.record('blocked', 'blocked', {
        itemIndex: out.itemIndex,
        // blockFailureCode, not addFailureCode. Both return 'waf_block' for this
        // one reason, so swapping them is a mutant no test can kill and none
        // pretends to — it is named here instead. blockFailureCode is the entry
        // point FOR a blocked row, and it is the one that stays right if the
        // reason set ever widens (it already splits off 'fresh-no-store').
        detail: { reason, ...base },
        code: blockFailureCode(reason),
      });
    }
    if (out.timedOut) {
      tel.record('confirm', 'timeout', {
        itemIndex: out.itemIndex,
        detail: { attempt: 1, reason, ...base, ...out.detail },
        code: 'timeout',
      });
      return;
    }
    tel.record('confirm', 'error', {
      itemIndex: out.itemIndex,
      detail: { attempt: 1, reason, ...base, ...out.detail },
      code: addFailureCode(reason),
    });
  } catch { /* telemetry must never throw into the engine */ }
}
