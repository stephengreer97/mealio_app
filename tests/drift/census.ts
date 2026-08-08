// Fixture drift detection: the decision layer (MEAL-30).
//
// WHAT PROBLEM THIS SOLVES
// Fixtures are the early-warning half of drift detection (the live canary in
// MEAL-7 is the late half). A store can change its markup in a way that does not
// break automation *yet* — a primary hook disappears and a fallback silently picks
// up the slack — and we want to hear about that before the day the fallback goes
// too. But a recaptured store page differs from the last capture by thousands of
// lines no matter what: session ids, prices, ad slots, which products happened to
// be in stock. A byte diff over that is unreadable, so it gets ignored, and a
// drift check that is ignored is worse than none.
//
// THE IDEA
// Don't diff the markup. Diff the SELECTORS' VIEW of the markup. For every
// selector the store scripts actually depend on, record what it matches in each
// fixture, and report only when that changes SHAPE. Nothing else is recorded, so
// nothing else can raise an alarm.
//
// WHAT COUNTS AS A SHAPE, AND WHY IT IS THIS COARSE
// A count is bucketed to `none` / `one` / `multi`, and two `multi`s are never
// compared to each other. That single decision removes the entire dominant class
// of false positive: a recapture whose search returned 41 products instead of 38
// is silent, as is an extra <li> from a new ad slot inside a page where the
// selector already matched 622 elements. What survives the bucketing is exactly
// the set of changes that break code:
//   • a selector that matched something now matches nothing (it died),
//   • a selector that identified ONE thing — a grid, a header, a container the
//     scripts scope their search to — now identifies several, or vice versa.
//
// BRANCHES ARE CENSUSED SEPARATELY, AND THAT IS THE POINT
// Most selectors in this app are comma-separated alternations kept deliberately
// broad, e.g. walmart's
//     card: '[data-automation-id="product"], [data-item-id]'
// The union surviving tells you automation still runs. It does NOT tell you the
// store still renders `data-automation-id="product"` — and in fact it no longer
// does; that branch matches zero elements in every committed Walmart fixture
// today, with `[data-item-id]` carrying the whole selector. Censusing each branch
// on its own is what turns "still working" into "still working, on its last leg",
// which is the warning the ticket asks for.
//
// A NOTE ON VISIBILITY
// Any reasoning about whether matched markup is *visible* would be invalid here.
// The fixture runner blocks stylesheets, so Albertsons' `d-none` class never
// applies and CSS-hidden markup is present, laid out, and readable. This module
// therefore counts matches and never asks whether a user could see them.

/** How many elements a selector matched, coarsened to a shape. */
export type CountBucket = 'none' | 'one' | 'multi' | 'invalid';

/** How much of a JSON payload's item list carried a field, coarsened. */
export type RatioBucket = 'none' | 'rare' | 'common';

/** Whether HEB's `__NEXT_DATA__` search payload was usable — see next-data.ts. */
export type PayloadState = 'absent' | 'unparseable' | 'no-grid' | 'grid';

/** Whether the payload could be proven to describe the fixture's own search. */
export type FreshnessState = 'fresh' | 'stale' | 'unverifiable';

/** The JSON surface of one fixture. Absent for stores with no JSON extractor. */
export interface NextDataCensus {
  payload: PayloadState;
  /** Only meaningful when payload === 'grid'. */
  freshness?: FreshnessState;
  /** Field path → how much of the grid's item list carried it. */
  fields?: Record<string, RatioBucket>;
}

/** One store's recorded shape: the selectors used, and what they matched where. */
export interface StoreCensus {
  /**
   * The selector text each key resolved to, as the store script would see it
   * (call-site fallbacks < platform table < store table — see selectorsFor()).
   * Recorded so a drift report can tell "the store's markup moved" from "someone
   * edited the selector", which are different problems with different fixes.
   */
  selectors: Record<string, string>;
  /** fixture file → target key → bucket. See targetKey() for the key shape. */
  fixtures: Record<string, Record<string, CountBucket>>;
  /** fixture file → JSON surface. Only present for stores that have one. */
  nextData?: Record<string, NextDataCensus>;
}

export interface Census {
  /** Bumped when the recorded shape changes meaning, forcing a re-baseline. */
  version: number;
  stores: Record<string, StoreCensus>;
}

export const CENSUS_VERSION = 1;

// ── Buckets ─────────────────────────────────────────────────────────────────

/**
 * A raw match count as a shape. `-1` is the sentinel the in-page counter returns
 * for a selector querySelectorAll refused to parse.
 *
 * `multi` swallows everything from 2 upward on purpose: see the header. The one
 * distinction worth keeping inside "more than none" is one-vs-several, because
 * the scripts treat a singleton match as an identity ("this is THE search grid")
 * and a multi match as a list ("these are the product cards"). A selector
 * crossing that line changes what the code does with it.
 */
export function countBucket(n: number): CountBucket {
  if (n < 0) return 'invalid';
  if (n === 0) return 'none';
  if (n === 1) return 'one';
  return 'multi';
}

/**
 * A field's presence across a payload's item list, as a shape.
 *
 * The `rare` band exists to absorb a specific false positive. Fields like
 * `purchasePreferenceList` appear on 1 of 60 items — whether ANY item in a
 * recaptured search carries one is a fact about which avocados H-E-B had in
 * stock, not about the payload's shape. So `rare` and `none` are never reported
 * against each other (see diffRatio): only a field the mapper can currently rely
 * on losing that status is worth waking someone for.
 *
 * The 25% line is a judgement call, not a measurement. Every field heb.ts treats
 * as required sits at 100% across all eight committed search payloads, and every
 * field it treats as optional sits at 1.6% or 90%+ — so the band is wide of both
 * clusters, and the exact threshold is not load-bearing today.
 */
export function ratioBucket(present: number, total: number): RatioBucket {
  if (total <= 0 || present <= 0) return 'none';
  return present / total > 0.25 ? 'common' : 'rare';
}

// ── Selector branches ───────────────────────────────────────────────────────

/**
 * Split a selector into its top-level comma-separated branches.
 *
 * Re-exported rather than defined here since MEAL-31: the runtime selector probe
 * needs the same split, and it ships in the app, so the implementation moved to
 * src/lib/selector-health.ts. Both readers have to agree on what "branch 1" is —
 * this census names a finding `card[1]` and the probe reports a fallback hit on
 * the same index, and two copies would eventually disagree about which branch
 * that is. Imported here so every existing caller keeps its import path.
 */
import { splitSelectorBranches } from '../../src/lib/selector-health';

export { splitSelectorBranches };

/**
 * The census key for a selector, or for one branch of it.
 *
 * Branch keys are only emitted for selectors that HAVE more than one branch —
 * for a single-branch selector the branch and the union are the same number, and
 * recording both would double the baseline's size while doubling every finding.
 */
export function targetKey(selectorKey: string, branchIndex?: number): string {
  return branchIndex === undefined ? selectorKey : `${selectorKey}[${branchIndex}]`;
}

/** Parse a census key back into its parts. */
export function parseTargetKey(key: string): { selectorKey: string; branchIndex?: number } {
  const m = /^(.*)\[(\d+)\]$/.exec(key);
  if (!m) return { selectorKey: key };
  return { selectorKey: m[1], branchIndex: Number(m[2]) };
}

// ── Findings ────────────────────────────────────────────────────────────────

export type FindingKind =
  /** Matched something last time, matches nothing now. */
  | 'died'
  /** Matched nothing last time, matches something now. */
  | 'appeared'
  /** Identified one element, now identifies several. */
  | 'widened'
  /** Identified several elements, now identifies one. */
  | 'narrowed'
  /** querySelectorAll refuses to parse it. */
  | 'invalid'
  /** Was unparseable, now parses. */
  | 'repaired'
  /** The selector TEXT changed — a code edit, not store drift. */
  | 'selector-changed'
  /** A fixture file appeared or vanished since the baseline. */
  | 'fixture-added'
  | 'fixture-removed'
  /** A store's fixture directory appeared or vanished. */
  | 'store-added'
  | 'store-removed'
  /** HEB's JSON payload stopped/started being usable. */
  | 'payload-lost'
  | 'payload-changed'
  /** The payload's freshness gate stopped/started proving the search matches. */
  | 'freshness-changed'
  /** A JSON field the mapper relies on is no longer reliably present. */
  | 'field-degraded'
  /** A JSON field the mapper treats as optional is now reliably present. */
  | 'field-appeared'
  /** Nearly everything died at once — read as a failed capture, not as drift. */
  | 'capture-suspect';

export interface DriftFinding {
  /** `warn` fails the drift gate; `info` is reported and does not. */
  level: 'warn' | 'info';
  kind: FindingKind;
  store: string;
  /** Absent for store-level findings. */
  fixture?: string;
  /** Selector census key, `json:<path>`, or a bare label for structural findings. */
  target: string;
  from?: string;
  to?: string;
  /** Human context — the selector text, the union's bucket, the live count. */
  note?: string;
}

/**
 * Whether a selector names ONE thing or a LIST of things.
 *
 * This is the distinction that makes the one↔multi rule safe, and it cannot be
 * decided per fixture. `wegmans.tile` matches exactly one product tile in the
 * captured tortillas search and sixty in the sour-cream one: at the fixture level
 * it looks like a singleton in the first and a list in the second, and treating the
 * first as a singleton would report a recapture that happened to return three
 * tortillas as a shape change. It is not one — Wegmans changed nothing.
 *
 * So the shape is read off the WHOLE store: a target that ever matches more than
 * one element anywhere is list-shaped, and one↔multi is never reported for it. What
 * stays covered is the set of selectors that are singletons everywhere they match —
 * `heb.searchGrid`, `heb.cardContainer`, `aldi.menu`, the search inputs, the opened
 * stepper — which is exactly the set the scripts treat as an identity and scope
 * their work to. A second `#search_product_grid` appearing on the page changes
 * which cards `__hebFindCards()` sees, and that is worth waking someone for.
 */
export type TargetShape = 'singleton' | 'list';

/** Shape per target, derived from a baseline store census. */
export function targetShapes(store: StoreCensus): Record<string, TargetShape> {
  const shapes: Record<string, TargetShape> = {};
  for (const fixture of Object.values(store.fixtures)) {
    for (const [target, bucket] of Object.entries(fixture)) {
      if (bucket === 'multi') shapes[target] = 'list';
      else if (!(target in shapes)) shapes[target] = 'singleton';
    }
  }
  return shapes;
}

/**
 * Bucket transitions, as findings. Returns null for the transitions we have
 * deliberately chosen not to report — which is most of them, and is the whole
 * reason this check is worth running.
 *
 * `shape` gates the one↔multi rule; see TargetShape. Defaults to 'singleton' so a
 * caller that has no census to derive it from gets the stricter reading.
 */
export function diffCount(
  from: CountBucket,
  to: CountBucket,
  shape: TargetShape = 'singleton',
): { kind: FindingKind; level: 'warn' | 'info' } | null {
  if (from === to) return null;
  if (to === 'invalid') return { kind: 'invalid', level: 'warn' };
  if (from === 'invalid') return { kind: 'repaired', level: 'info' };
  if (to === 'none') return { kind: 'died', level: 'warn' };
  if (from === 'none') return { kind: 'appeared', level: 'info' };
  // Both non-none and different, so this is one↔multi. For a list-shaped target
  // that is a result-set size change, which is not our business.
  if (shape === 'list') return null;
  return from === 'one'
    ? { kind: 'widened', level: 'warn' }
    : { kind: 'narrowed', level: 'warn' };
}

/**
 * Field-presence transitions. `none` and `rare` are never reported against each
 * other — see ratioBucket() for why that is a feature.
 */
export function diffRatio(from: RatioBucket, to: RatioBucket): { kind: FindingKind; level: 'warn' | 'info' } | null {
  if (from === to) return null;
  if (from === 'common') return { kind: 'field-degraded', level: 'warn' };
  if (to === 'common') return { kind: 'field-appeared', level: 'info' };
  return null; // none ↔ rare
}

// ── Diffing two censuses ────────────────────────────────────────────────────

/**
 * Compare a freshly computed census against the committed baseline.
 *
 * Findings are ordered store → fixture → target so a report reads like the
 * fixture tree, and `warn` findings are what the drift gate fails on.
 */
export function diffCensus(baseline: Census, current: Census): DriftFinding[] {
  const findings: DriftFinding[] = [];

  for (const store of Object.keys(current.stores).sort()) {
    const cur = current.stores[store];
    const base = baseline.stores[store];
    if (!base) {
      findings.push({
        level: 'info',
        kind: 'store-added',
        store,
        target: store,
        note: `${Object.keys(cur.fixtures).length} fixture(s) censused for the first time`,
      });
      continue;
    }
    diffStore(store, base, cur, findings);
  }

  for (const store of Object.keys(baseline.stores).sort()) {
    if (current.stores[store]) continue;
    findings.push({
      level: 'warn',
      kind: 'store-removed',
      store,
      target: store,
      note: 'baseline has this store but no fixtures were censused for it',
    });
  }

  return findings;
}

/**
 * How wholesale a die-off has to be before we stop calling it drift.
 *
 * A recapture that egressed from a blocked IP captures a challenge page, and a
 * challenge page kills EVERY selector at once — several hundred findings for one
 * fact, which is the single worst thing this check could put in front of someone.
 * A real markup change never looks like that: even a full redesign leaves the
 * search input, the header links, and the generic `li` / `article` branches
 * matching. So a near-total wipe is reported as one finding that says what it
 * probably is.
 *
 * Set deliberately high, with a floor, so a small store with few censused targets
 * cannot trip it by losing three selectors.
 */
const CAPTURE_SUSPECT_SHARE = 0.8;
const CAPTURE_SUSPECT_FLOOR = 20;

/** Live targets in the baseline, and how many of them died in this census. */
function dieOff(base: StoreCensus, cur: StoreCensus): { live: number; died: number } {
  let live = 0;
  let died = 0;
  for (const [fixture, baseFx] of Object.entries(base.fixtures)) {
    const curFx = cur.fixtures[fixture];
    if (!curFx) continue;
    for (const [target, bucket] of Object.entries(baseFx)) {
      if (bucket === 'none' || bucket === 'invalid') continue;
      live++;
      if (curFx[target] === 'none') died++;
    }
  }
  return { live, died };
}

function diffStore(store: string, base: StoreCensus, cur: StoreCensus, findings: DriftFinding[]): void {
  const { live, died } = dieOff(base, cur);
  if (live >= CAPTURE_SUSPECT_FLOOR && died >= live * CAPTURE_SUSPECT_SHARE) {
    findings.push({
      level: 'warn',
      kind: 'capture-suspect',
      store,
      target: store,
      from: `${live} live`,
      to: `${died} dead`,
      note:
        'nearly every selector died at once, which is not how a storefront changes. ' +
        'Check the capture first — a recapture from a blocked IP records the challenge ' +
        'page, not the store. Per-selector findings are suppressed because they would ' +
        'all say the same thing.',
    });
    return;
  }

  // Derived from the BASELINE, not from the new census: the shape is the claim the
  // committed baseline makes about each selector, and a recapture must be judged
  // against that claim rather than against itself.
  const shapes = targetShapes(base);

  // Selector-text edits first. They are `info` — a developer changing a selector
  // MEANT to change it — but they come before the bucket findings because they
  // explain them: "you edited albertsons.card and it now matches nothing" is a
  // different story from "Albertsons changed their markup".
  for (const key of Object.keys({ ...base.selectors, ...cur.selectors }).sort()) {
    const from = base.selectors[key];
    const to = cur.selectors[key];
    if (from === to) continue;
    findings.push({
      level: 'info',
      kind: 'selector-changed',
      store,
      target: key,
      from: from ?? '(new key)',
      to: to ?? '(key removed)',
    });
  }

  for (const fixture of Object.keys(cur.fixtures).sort()) {
    const curFx = cur.fixtures[fixture];
    const baseFx = base.fixtures[fixture];
    if (!baseFx) {
      findings.push({
        level: 'info',
        kind: 'fixture-added',
        store,
        fixture,
        target: fixture,
        note: 'not in the baseline — its shape is being recorded for the first time',
      });
      continue;
    }
    for (const target of Object.keys(curFx).sort()) {
      const to = curFx[target];
      const from = baseFx[target];
      // A target with no baseline entry is a newly declared selector (or a newly
      // added branch of one). Nothing to compare against, and reporting it as
      // `appeared` would misattribute a code change to the store.
      if (from === undefined) continue;
      const verdict = diffCount(from, to, shapes[target] ?? 'singleton');
      if (!verdict) continue;

      const { selectorKey, branchIndex } = parseTargetKey(target);
      const notes: string[] = [];
      if (branchIndex !== undefined) {
        // The single most useful thing to say about a dead branch: is the whole
        // selector down, or is a sibling branch quietly carrying it? Only the
        // second case is "working, for now".
        const unionTo = curFx[selectorKey];
        notes.push(
          unionTo === undefined || unionTo === 'none'
            ? `whole selector is ${unionTo ?? 'unknown'}`
            : `union still ${unionTo} — a sibling branch is carrying this selector`,
        );
        const text = cur.selectors[selectorKey];
        if (text) {
          const branch = splitSelectorBranches(text)[branchIndex];
          if (branch) notes.push(`branch: ${branch}`);
        }
      } else if (cur.selectors[selectorKey]) {
        notes.push(cur.selectors[selectorKey]);
      }

      findings.push({
        level: verdict.level,
        kind: verdict.kind,
        store,
        fixture,
        target,
        from,
        to,
        note: notes.join(' · ') || undefined,
      });
    }
    diffNextData(store, fixture, base.nextData?.[fixture], cur.nextData?.[fixture], findings);
  }

  for (const fixture of Object.keys(base.fixtures).sort()) {
    if (cur.fixtures[fixture]) continue;
    findings.push({
      level: 'info',
      kind: 'fixture-removed',
      store,
      fixture,
      target: fixture,
      note: 'in the baseline but no longer on disk',
    });
  }
}

function diffNextData(
  store: string,
  fixture: string,
  base: NextDataCensus | undefined,
  cur: NextDataCensus | undefined,
  findings: DriftFinding[],
): void {
  if (!base || !cur) return;

  if (base.payload !== cur.payload) {
    // Losing a usable grid is the warn case: the JSON extraction path silently
    // falls back to the DOM scrape, so nothing fails — the fast path just stops
    // being taken, which is invisible without this check.
    const lost = base.payload === 'grid';
    findings.push({
      level: lost ? 'warn' : 'info',
      kind: lost ? 'payload-lost' : 'payload-changed',
      store,
      fixture,
      target: 'json:__NEXT_DATA__',
      from: base.payload,
      to: cur.payload,
    });
  }

  if (base.freshness && cur.freshness && base.freshness !== cur.freshness) {
    // The gate is an equality test against the term in the fixture's capture URL.
    // It flipping means either the payload stopped echoing the search term where
    // heb.ts looks for it, or the capture genuinely served a different search —
    // both worth a human look, neither detectable any other way.
    findings.push({
      level: cur.freshness === 'fresh' ? 'info' : 'warn',
      kind: 'freshness-changed',
      store,
      fixture,
      target: 'json:freshness-gate',
      from: base.freshness,
      to: cur.freshness,
    });
  }

  const baseFields = base.fields ?? {};
  const curFields = cur.fields ?? {};
  for (const path of Object.keys(curFields).sort()) {
    const from = baseFields[path];
    if (from === undefined) continue; // newly censused field — see the note above
    const verdict = diffRatio(from, curFields[path]);
    if (!verdict) continue;
    findings.push({
      level: verdict.level,
      kind: verdict.kind,
      store,
      fixture,
      target: `json:${path}`,
      from,
      to: curFields[path],
    });
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

const KIND_LABEL: Record<FindingKind, string> = {
  died: 'matches nothing now',
  appeared: 'now matches',
  widened: 'identified one element, now several',
  narrowed: 'identified several elements, now one',
  invalid: 'is not a parseable selector',
  repaired: 'parses again',
  'selector-changed': 'selector text edited',
  'fixture-added': 'new fixture',
  'fixture-removed': 'fixture gone',
  'store-added': 'new store',
  'store-removed': 'store gone',
  'payload-lost': 'JSON search payload no longer usable',
  'payload-changed': 'JSON search payload state changed',
  'freshness-changed': 'JSON freshness gate changed',
  'field-degraded': 'JSON field the mapper relies on is no longer reliably present',
  'field-appeared': 'JSON field is now reliably present',
  'capture-suspect': 'nearly every selector died at once — suspect the capture, not the store',
};

/** One finding as a single line, for a terminal report or a jest failure message. */
export function formatFinding(f: DriftFinding): string {
  const where = f.fixture ? `${f.store}/${f.fixture}` : f.store;
  const shift = f.from !== undefined && f.to !== undefined ? ` (${f.from} → ${f.to})` : '';
  const note = f.note ? `\n      ${f.note}` : '';
  return `  ${f.level === 'warn' ? 'WARN' : 'info'}  ${where}  ${f.target}: ${KIND_LABEL[f.kind]}${shift}${note}`;
}

/** A whole report. Returns a single reassuring line when there is no drift. */
export function formatFindings(findings: DriftFinding[]): string {
  if (findings.length === 0) return 'No selector drift: every censused selector matches the same shape as the baseline.';
  const warns = findings.filter((f) => f.level === 'warn');
  const infos = findings.filter((f) => f.level === 'info');
  const lines: string[] = [];
  if (warns.length > 0) {
    lines.push(`${warns.length} selector shape change(s) — the markup our code reads has moved:`);
    lines.push(...warns.map(formatFinding));
  }
  if (infos.length > 0) {
    if (warns.length > 0) lines.push('');
    lines.push(`${infos.length} informational change(s):`);
    lines.push(...infos.map(formatFinding));
  }
  return lines.join('\n');
}

/**
 * Selectors that match nothing in ANY of a store's fixtures.
 *
 * Not drift — the baseline agrees with them, so nothing changed. It is the other
 * question worth asking of a selector census: which of the hooks we ship are
 * already dead, and which comma-branches are dead weight. Deliberately kept out
 * of the drift gate: it is a standing property of the repo, and a gate that fails
 * on a pre-existing condition fails forever and gets deleted.
 */
export function standingDeadTargets(census: Census): Array<{ store: string; target: string; fixtures: number }> {
  const out: Array<{ store: string; target: string; fixtures: number }> = [];
  for (const store of Object.keys(census.stores).sort()) {
    const fixtures = Object.values(census.stores[store].fixtures);
    if (fixtures.length === 0) continue;
    const targets = new Set<string>();
    for (const fx of fixtures) for (const t of Object.keys(fx)) targets.add(t);
    for (const target of [...targets].sort()) {
      const seen = fixtures.filter((fx) => fx[target] !== undefined);
      if (seen.length === 0) continue;
      if (seen.every((fx) => fx[target] === 'none')) {
        out.push({ store, target, fixtures: seen.length });
      }
    }
  }
  return out;
}
