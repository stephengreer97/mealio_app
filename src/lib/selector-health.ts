// Per-selector resolution health from real cart runs (MEAL-31).
//
// WHAT WAS MISSING
// `selector_miss` already exists as a failure code, but it is only ever recorded
// when a STEP FAILS. So a selector that resolves on 60% of runs — the store has
// half-shipped a redesign, or a fallback branch is carrying a dead primary — is
// invisible until it breaks completely, at which point it reads as a sudden
// outage rather than three weeks of drift. What was never recorded is the
// DENOMINATOR: how often each configured selector was QUERIED, not just how often
// its absence happened to sink a step.
//
// HOW IT IS RECORDED
// The selectors live in a page the app does not own — the store scripts are
// strings injected into a WebView, so nothing in React Native can observe a
// querySelector. The observation therefore has to happen in the page and travel
// back over the bridge:
//
//   1. buildSelectorProbe() emits a small prefix that is prepended to a store
//      script. It installs ONE hook on window.ReactNativeWebView.postMessage and
//      registers the selectors that script actually interpolates.
//   2. When the script posts its terminal result (SEARCH_RESULT, ADD_RESULT,
//      WORKER_RESULT, …) the hook forwards that message untouched and THEN
//      samples every registered selector against the settled page, posting one
//      extra SELECTOR_HEALTH message.
//   3. SelectorHealthTally (below, in RN) accumulates those samples across the
//      run and renders one flat, sanitizer-safe string at the end.
//
// WHY THE HOOK IS PREPENDED AND NOT APPENDED
// The parallel-pool wrappers in worker-search.ts install postMessage overrides of
// their own that re-tag a store's SEARCH_RESULT as WORKER_RESULT and SWALLOW
// everything they do not recognise. Text order decides the chain: the prefix runs
// FIRST, so its hook sits closest to the native bridge, receives whatever the
// wrapper produced, and posts SELECTOR_HEALTH straight to native — under the
// wrapper's whitelist rather than into it. Appending the prefix instead would put
// the hook outside the wrapper and every worker's samples would be eaten in
// silence. Nothing in worker-search.ts had to change for this.
//
// "Prepended" is a property of the FINISHED worker, not of any one step, and that
// distinction is not pedantic — it is the bug this feature shipped with. The
// pre-search and parallel-add workers were composed in WebViewCartSheet from
// scripts it had already been handed, i.e. `wrapper(probe + body)`: each half was
// individually correct and the result was the one arrangement that discards
// everything. Both pools reported nothing, on the four stores where they ARE the
// add path, while the main WebView kept the row looking populated. Composition
// therefore lives at one seam now — see attachWorkerScripts in
// webview-scripts/index.ts, which runs before withSelectorProbes.
//
// WHAT `queried` ACTUALLY COUNTS, AND WHY THE RAW RATE HAS FLOORS
// A sample is taken when a script posts its terminal message, and it covers every
// selector that script's text interpolates. So `queried` means "a script that
// mentions this selector finished", NOT "the script reached the line that asks
// for it". Three consequences, none of which break a TREND — the thing this
// feature is for — but all of which put a permanent sub-100% floor on a raw rate,
// so the read side must not treat "below 100%" as drift:
//
//   • Alternative layouts. Amazon Fresh renders two distinct card layouts and its
//     add script interpolates all fifteen selectors, both sets. On an A-layout
//     page the seven B-selectors are honest, permanent misses, and vice versa.
//     (The script-text filter below prevents this ACROSS phases — the login
//     selectors are not probed on a search page — but it cannot split a single
//     script's own alternatives.)
//   • Shared documents. `CART_COUNT` is a terminal type, and the cart-count
//     scripts are not probed — they inject into the same main-WebView document,
//     so their post re-samples whatever the last probed script registered. That
//     inflates the denominator without a matching query.
//   • Login state. ALDI's login check probes `menu` and `hamburger`; signed out,
//     those legitimately do not render, so their rate tracks session state rather
//     than store drift.
//
// WHY "RESOLVED" IS NOT A BOOLEAN
// Most selectors are alternations — `[data-automation-id="product"], [data-item-id]`
// — where the first branch is what the store is supposed to render and the rest
// are what we fell back to last time it changed. A run where the primary branch
// misses and a fallback catches is a SUCCESSFUL run, and it is also the exact
// early warning this ticket exists to surface. So a sample records the INDEX of
// the first branch that matched, not a yes/no, and the tally counts primary hits
// apart from fallback hits.

import { selectorsFor, PlatformId } from './automation-config';
import { MAX_DETAIL_STRING } from './automation-telemetry';
import { SEL_FALLBACKS as HEB_FALLBACKS } from './webview-scripts/heb';
import { SEL_FALLBACKS as WALMART_FALLBACKS } from './webview-scripts/walmart';
import { SEL_FALLBACKS as WEGMANS_FALLBACKS } from './webview-scripts/wegmans';
import { SEL_FALLBACKS as AMAZON_FALLBACKS } from './webview-scripts/amazon-fresh';
import { SEL_FALLBACKS as ALBERTSONS_FALLBACKS } from './webview-scripts/albertsons';
import { INSTACART_TENANTS, selFallbacks } from './webview-scripts/instacart';

// ── Selector branches ───────────────────────────────────────────────────────

/**
 * Split a selector into its top-level comma-separated branches.
 *
 * Depth-aware, because commas also appear INSIDE a branch and splitting on those
 * would produce nonsense that querySelector rejects:
 *   • `:not([type="submit"])` and other functional pseudo-classes take argument
 *     lists — HEB's `searchOpen` has one;
 *   • an attribute value can contain a comma — Amazon's
 *     `button[aria-label^="Add to Cart,"]` does, and naively split it yields
 *     `button[aria-label^="Add to Cart` plus a stray `"]`.
 *
 * Lives in src/ rather than in the drift census that first needed it because both
 * readers must agree on what "branch 1" means: the census names a finding
 * `card[1]` and this module reports a fallback hit on the same index. Two copies
 * of the splitter would eventually disagree about which branch that is.
 */
export function splitSelectorBranches(selector: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;

  for (const ch of selector) {
    if (quote) {
      buf += ch;
      // CSS string escapes are not handled: merge.ts rejects backslashes in a
      // configured selector, and no developer-authored fallback contains one.
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ── Which selectors a store resolves ────────────────────────────────────────

/** A store's selector table, as the store's own scripts resolve it. */
export interface SelectorSurface {
  /** The automation-config key. NOT always the store id: all 15 Albertsons
   *  banners resolve under `albertsons`, and Amazon Fresh under `amazon`. */
  configKey: string;
  /** The call-site fallback table, exactly as the store's scripts pass it. */
  fallbacks: Record<string, string>;
  /** The platform the adapter declares for itself, if any. */
  platform?: PlatformId;
}

/** Every Albertsons banner reads the one shared table; see albertsons.ts. */
const ALBERTSONS_CONFIG_KEY = 'albertsons';

/**
 * The selector surface for a store, or null for one with no table to watch.
 *
 * Derived from the same SEL_FALLBACKS exports the store scripts pass to
 * selectorsFor(), so a selector added to a store script is probed on the next run
 * with no edit here. The drift census reads this too (tests/drift/selector-surface.ts)
 * — a fixture-time census and a runtime probe that disagreed about which selectors
 * a store has would be worse than either alone.
 */
export function selectorSurfaceFor(storeId: string): SelectorSurface | null {
  switch (storeId) {
    case 'heb':     return { configKey: 'heb', fallbacks: HEB_FALLBACKS };
    case 'walmart': return { configKey: 'walmart', fallbacks: WALMART_FALLBACKS };
    case 'amazon':  return { configKey: 'amazon', fallbacks: AMAZON_FALLBACKS };
    case 'wegmans': return { configKey: 'wegmans', fallbacks: WEGMANS_FALLBACKS };
    default: break;
  }
  const tenant = INSTACART_TENANTS[storeId];
  if (tenant) {
    return { configKey: tenant.storeId, fallbacks: selFallbacks(tenant), platform: 'instacart' };
  }
  return null;
}

/** The Albertsons surface, for the family ids the registry resolves separately. */
export function albertsonsSelectorSurface(): SelectorSurface {
  return { configKey: ALBERTSONS_CONFIG_KEY, fallbacks: ALBERTSONS_FALLBACKS, platform: 'albertsons' };
}

/**
 * A store's selectors as RAW CSS strings, resolved through the same accessor and
 * therefore the same override precedence the injected scripts get.
 *
 * selectorsFor() returns JS string LITERALS (it exists to be interpolated), so
 * each value is parsed back to what the browser will be handed.
 */
export function resolveSurfaceSelectors(surface: SelectorSurface): Record<string, string> {
  const literals = selectorsFor(surface.configKey, surface.fallbacks, surface.platform);
  const out: Record<string, string> = {};
  for (const [key, literal] of Object.entries(literals)) {
    try {
      out[key] = JSON.parse(literal) as string;
    } catch {
      // selectorsFor always emits JSON.stringify output, so this is unreachable;
      // a probe that threw while being BUILT would take the cart run with it.
    }
  }
  return out;
}

// ── Probe targets ───────────────────────────────────────────────────────────

/** One selector the probe will sample, pre-split into its branches. */
export interface ProbeTarget {
  key: string;
  branches: string[];
}

/**
 * The selectors a BUILT script will actually query, with their branches.
 *
 * Filtered by looking for each selector's text in the finished script, which is
 * the only evidence available: by the time a script is a string there is nothing
 * left to ask about which `${s.card}` it interpolated. Both interpolation styles
 * are covered — selectorsFor()'s JSON literal and rawSelectorsFor()'s bare value
 * spliced inside a quoted literal the script already owns.
 *
 * Filtering matters more than it looks. A store's table spans the whole run — the
 * login hamburger, the search affordance, the product card, the cart bubble — and
 * a script only touches its own slice. Probing the whole table on every script
 * would report the login selectors as missing on every search page, which is not
 * drift, and burying the real signal under permanent false misses is how a health
 * metric gets ignored and then deleted.
 *
 * Two keys sharing one value both match, and both are reported. That is honest:
 * a query for that text serves both.
 */
export function probeTargetsFor(surface: SelectorSurface, script: string): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  for (const [key, value] of Object.entries(resolveSurfaceSelectors(surface))) {
    if (!value) continue;
    if (!script.includes(value) && !script.includes(JSON.stringify(value))) continue;
    const branches = splitSelectorBranches(value);
    if (branches.length > 0) out.push({ key, branches });
  }
  return out;
}

// ── The injected probe ──────────────────────────────────────────────────────

/** Message type the probe posts back. */
export const SELECTOR_HEALTH_MESSAGE = 'SELECTOR_HEALTH';

/**
 * Message types that mean "this script has finished and the page has settled".
 *
 * The hook sits closest to native, so on the parallel paths it sees the wrapper's
 * WORKER_RESULT rather than the store's own SEARCH_RESULT — both are listed for
 * that reason, not out of caution.
 */
const TERMINAL_TYPES = [
  'SEARCH_RESULT',
  'ADD_RESULT',
  'SEARCH_AND_ADD_RESULT',
  'WORKER_RESULT',
  'LOGIN_STATUS',
  'CART_COUNT',
];

/** Sample value meaning no branch matched. */
export const SELECTOR_MISS = -1;
/** Sample value meaning the browser refused to parse a branch. */
export const SELECTOR_INVALID = -2;

/**
 * The prefix that turns a store script into a self-reporting one.
 *
 * Everything here is defensive by construction, because this code runs inside a
 * live storefront in the middle of an add-to-cart:
 *   • the whole body is wrapped in try/catch, and so is each sample;
 *   • the intercepted message is forwarded BEFORE anything is sampled, so a
 *     throw in the probe cannot swallow a result the engine is waiting on, and
 *     an exception from the native post propagates exactly as it did before;
 *   • the hook installs at most once per page, so a re-injected script (SPA
 *     re-render, the pre-search pool's second injection into a parked page) does
 *     not stack overrides;
 *   • the registered target list is REPLACED, not merged, on each injection —
 *     each script is measured on its own selectors rather than inheriting the
 *     previous script's and reporting them as queried when they were not.
 *
 * Returns '' when there is nothing to sample, so a script with no configured
 * selectors carries no probe at all.
 */
export function buildSelectorProbe(targets: ProbeTarget[]): string {
  if (targets.length === 0) return '';
  const payload = JSON.stringify(targets.map((t) => [t.key, t.branches]));
  const terminal = JSON.stringify(TERMINAL_TYPES);
  return `(function(){
  try {
    var W = window;
    var T = ${payload};
    var H = W.__mealioSelHealth;
    if (!H) {
      var rn = W.ReactNativeWebView;
      if (!rn || typeof rn.postMessage !== 'function') return;
      var post = rn.postMessage.bind(rn);
      var TERM = ${terminal};
      H = W.__mealioSelHealth = { targets: [] };
      rn.postMessage = function(s) {
        post(s);
        try {
          var m = JSON.parse(s);
          if (!m || TERM.indexOf(m.type) < 0) return;
          var sel = {};
          for (var i = 0; i < H.targets.length; i++) {
            var key = H.targets[i][0];
            var branches = H.targets[i][1];
            var v = ${SELECTOR_MISS};
            for (var b = 0; b < branches.length; b++) {
              try {
                if (document.querySelector(branches[b])) { v = b; break; }
              } catch (e) { v = ${SELECTOR_INVALID}; break; }
            }
            sel[key] = v;
          }
          post(JSON.stringify({ type: '${SELECTOR_HEALTH_MESSAGE}', sel: sel }));
        } catch (e) {}
      };
    }
    H.targets = T;
  } catch (e) {}
})();
`;
}

/**
 * Prepend a probe to one built script. Returns the script unchanged when the
 * store has no selector surface or the script queries none of it.
 *
 * Never throws: a store script that failed to build because its telemetry prefix
 * did would be the exact failure mode telemetry is not allowed to have.
 */
export function withSelectorProbe(surface: SelectorSurface | null, script: string): string {
  if (!surface || !script) return script;
  try {
    return buildSelectorProbe(probeTargetsFor(surface, script)) + script;
  } catch {
    return script;
  }
}

// ── The RN-side tally ───────────────────────────────────────────────────────

export interface SelectorCounts {
  /** Samples taken — the DENOMINATOR this ticket is about. */
  queried: number;
  /** Samples where branch 0, the selector the store is supposed to render, hit. */
  primary: number;
  /** Samples where the primary missed and a later branch caught. Degraded, not
   *  broken — and the early warning the failure codes never carried. */
  fallback: number;
  /** Samples where the browser refused a branch. Should never be non-zero. */
  invalid: number;
}

const EMPTY: SelectorCounts = { queried: 0, primary: 0, fallback: 0, invalid: 0 };

/** Chunks of the tally string a single row may carry. Three fixed keys plus these
 *  plus one overflow key is 12 — sanitizeDetail's MAX_DETAIL_KEYS exactly. */
export const MAX_SUMMARY_PARTS = 8;

/**
 * Accumulates SELECTOR_HEALTH samples for one run.
 *
 * Aggregating in RN rather than shipping a row per sample is the whole volume
 * argument: a ten-item run samples on the order of 20 script completions across
 * up to 15 selectors, which is ~300 observations, and it uploads ONE row. See
 * detail() for what that row is allowed to carry.
 *
 * Every method swallows its own errors. The ingest path is fed by a message
 * handler in the middle of a cart run.
 */
export class SelectorHealthTally {
  private readonly byKey = new Map<string, SelectorCounts>();
  private sampleCount = 0;

  /** Fold one SELECTOR_HEALTH message's `sel` map in. Ignores anything else. */
  ingest(sel: unknown): void {
    try {
      if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return;
      let counted = false;
      for (const [key, raw] of Object.entries(sel as Record<string, unknown>)) {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        const branch = Math.trunc(raw);
        const cur = this.byKey.get(key) ?? { ...EMPTY };
        cur.queried++;
        if (branch === SELECTOR_INVALID) cur.invalid++;
        else if (branch === 0) cur.primary++;
        else if (branch > 0) cur.fallback++;
        // SELECTOR_MISS and any other negative fall through as a miss. Misses are
        // not stored: they are `queried - primary - fallback - invalid`. Note the
        // uploaded term carries only the first three, so what a reader can derive
        // from the row alone is misses-plus-invalids — see summaryParts().
        this.byKey.set(key, cur);
        counted = true;
      }
      if (counted) this.sampleCount++;
    } catch { /* telemetry must never throw into the engine */ }
  }

  /** Distinct selectors observed this run. */
  get size(): number {
    return this.byKey.size;
  }

  /** SELECTOR_HEALTH messages folded in. */
  get samples(): number {
    return this.sampleCount;
  }

  /** Counts for one selector. Test/diagnostic use. */
  counts(key: string): SelectorCounts | undefined {
    return this.byKey.get(key);
  }

  /**
   * The tally as `key:queried/primary/fallback` terms, joined by commas and split
   * into chunks that survive sanitizeDetail's 200-character string cap.
   *
   * A STRING, and chunked, for one reason each:
   *
   *   • sanitizeDetail DROPS objects and arrays outright, so the obvious
   *     Record<string, Counts> would arrive at the server as nothing at all. That
   *     has happened here before — MEAL-123's failureCodes shipped as a nested
   *     Record and the row claimed a tally it did not carry — so this follows
   *     failureCodeSummary()'s flat `name:count` shape deliberately.
   *   • the same sanitizer TRUNCATES a long string at 200 characters silently,
   *     and Amazon Fresh alone resolves 15 selectors, which overruns that in one
   *     line. A truncated tail is worse than a missing one: it parses, and the
   *     selectors it drops are simply absent from the dashboard with nothing
   *     saying so. Chunking at the sanitizer's own constant means the cap can
   *     move without this quietly starting to lose data.
   *
   * Only three numbers, because the fourth is derivable and chunks cost bytes:
   * `queried - primary - fallback` is everything that DID NOT RESOLVE. Note that
   * is misses PLUS invalids, not misses alone — an unparseable selector is
   * counted in `queried` and in neither of the other two. The two are only
   * separable from `selInvalid` in detail(), which names the keys but not their
   * counts and yields its slot to `selDropped` when the tally overflows.
   *
   * That is deliberate rather than a gap: `invalid` should always be zero (a
   * configured selector that does not parse is refused by merge.ts, and a bundled
   * one that does not parse would fail driftSurface's own check), so the read side
   * can read the remainder as misses. If `selInvalid` ever appears, the fix is the
   * selector, not the arithmetic.
   */
  summaryParts(): string[] {
    const terms: string[] = [];
    for (const [key, c] of [...this.byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      terms.push(`${key}:${c.queried}/${c.primary}/${c.fallback}`);
    }
    const parts: string[] = [];
    let buf = '';
    for (const term of terms) {
      const next = buf ? `${buf},${term}` : term;
      if (next.length > MAX_DETAIL_STRING) {
        if (buf) parts.push(buf);
        // A single term longer than the cap cannot happen — a selector key would
        // have to be ~180 characters — but if one ever did, emit it alone rather
        // than dropping it and let the sanitizer's truncation be visible.
        buf = term;
      } else {
        buf = next;
      }
    }
    if (buf) parts.push(buf);
    return parts;
  }

  /**
   * The detail payload for the run's selector-health row, or undefined when
   * nothing was sampled (no probe ran, or the run never reached a store page).
   *
   * Built to fit MAX_DETAIL_KEYS = 12 BY CONSTRUCTION rather than by hoping:
   * three fixed keys, at most eight chunks, and a ninth-chunk overflow reported
   * as `selDropped` instead of vanishing. Eight chunks is ~1600 characters, room
   * for roughly a hundred selectors against a largest table of fifteen.
   */
  detail(): Record<string, unknown> | undefined {
    try {
      if (this.byKey.size === 0) return undefined;
      const parts = this.summaryParts();
      const invalid = [...this.byKey.entries()]
        .filter(([, c]) => c.invalid > 0)
        .map(([key]) => key);
      const out: Record<string, unknown> = {
        // Distinguishes this row from the other `reconcile` rows a run emits —
        // the cart-diff row and the false-negative recovery row. See the emission
        // site in WebViewCartSheet for why it rides on `reconcile` at all.
        phase: 'selector_health',
        selectors: this.byKey.size,
        samples: this.sampleCount,
      };
      const kept = parts.slice(0, MAX_SUMMARY_PARTS);
      kept.forEach((part, i) => { out[`sel${i + 1}`] = part; });
      // ONE key left in the budget, and two things that might want it. Overflow
      // wins: `selDropped` says the row is incomplete, which changes how every
      // other number on it should be read, while a selector the browser refused
      // is already visible as a resolution rate of zero — `selInvalid` only says
      // that the cause is a malformed selector rather than store drift.
      // Neither can be added unconditionally — a thirteenth key is dropped by
      // sanitizeDetail in Object.entries order, which would take a chunk of the
      // tally with it and leave the row parsing cleanly and quietly short.
      if (parts.length > kept.length) out.selDropped = parts.length - kept.length;
      else if (invalid.length > 0) out.selInvalid = invalid.join(',').slice(0, MAX_DETAIL_STRING);
      return out;
    } catch {
      return undefined;
    }
  }
}
