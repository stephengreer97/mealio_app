// HEB's SECOND extraction surface, as a drift census (MEAL-30 × MEAL-13).
//
// MEAL-13 gave HEB two ways to read a search result set:
//   1. the DOM — `__hebFindCards()` over `[data-qe-id="productCard"]`, covered by
//      the selector census in census.ts like every other store;
//   2. the embedded `__NEXT_DATA__` JSON, behind the `nextDataSearch` config flag.
//
// The second surface is invisible to a selector census: HEB can rename
// `decodedDisplayName` without touching a single attribute in the markup. It is
// also invisible to the fixture TESTS in a way the DOM path is not, because every
// failure mode of the JSON path degrades silently back to the DOM scrape by
// design. Nothing goes red; the fast path just stops being taken. So this is the
// only place that failure can be seen at all.
//
// WHAT IS CENSUSED, AND WHY IT MIRRORS heb.ts SO LITERALLY
// Three things, in the order `__hebNextDataCandidates()` checks them:
//   • PAYLOAD STATE — is there a `__NEXT_DATA__`, does it parse, does a
//     SearchGridV2 visual component resolve out of it. These are the extractor's
//     own 'no_next_data' / 'parse_error' / 'no_grid' bail-outs.
//   • THE FRESHNESS GATE — does the payload's own search term equal the term the
//     fixture was captured from. heb.ts requires equality and treats any mismatch
//     as stale, because HEB runs with spaSearch:true and the payload describes the
//     page's INITIAL server render, not the current SPA search. This gate is pure
//     JSON-shape logic, so it can drift on its own: if HEB moves the echoed term
//     out of `props.pageProps.searchTerm`, every payload becomes unverifiable and
//     the JSON path quietly switches itself off everywhere.
//   • FIELD PRESENCE — for each field the mapper reads off an item or its SKU,
//     what share of the grid's items carry it, bucketed (see ratioBucket).
//
// The freshness gate is reproduced here rather than shared with heb.ts because
// heb.ts's copy exists only as text inside an injectable script string — there is
// no importable function to call. NORMALIZE below is a transcription of
// `__hebNorm`, and the guard test in tests/unit/driftNextDataSurface.test.ts
// checks it still agrees with the regexes in that file.

import type { NextDataCensus, RatioBucket } from './census';
import { ratioBucket } from './census';

/**
 * Fields read directly off a grid ITEM by `__hebNextDataCandidates()` and its
 * helpers. Kept as a flat list of names (not paths) because the guard test scans
 * heb.ts for `item.X` / `it.X` accesses and compares against exactly this set —
 * so a future field added to the mapper cannot be forgotten here.
 */
export const ITEM_FIELDS = [
  '__typename',
  'SKUs',
  'carouselImageUrls',
  'decodedDisplayName',
  'displayName',
  'fullDisplayName',
  'id',
  'inventory',
  'productImageUrls',
  'purchasePreferenceList',
  'shoppingContext',
] as const;

/** Fields read off an item's first SKU. Guarded the same way, via `sku.X`. */
export const SKU_FIELDS = [
  'contextPrices',
  'customerFriendlySize',
  'id',
  'weightSelectionIncrements',
] as const;

/**
 * The nested paths the mapper reaches through, beyond the top level.
 *
 * `*` means "any element of this array". These are hand-maintained: the guard
 * test can only see top-level accesses on `item`/`it`/`sku`, because everything
 * below that is read off a local (`pick.salePrice`, `imgs[i].size`) whose type
 * a regex cannot know. A field added down here without a line added below is the
 * one gap in the guard, and is why this list is short and commented rather than
 * clever.
 */
export const NESTED_PATHS = [
  // The payload's own stock verdict — `outOfStock` on the candidate.
  'inventory.inventoryState',
  // Purchase preferences: the list, and the `.text` the add scripts match a modal
  // row against. Present on ~1 item in 60, so it lands in the `rare` band and is
  // deliberately not reported when it disappears — see ratioBucket.
  'purchasePreferenceList.purchasePreferences',
  'purchasePreferenceList.purchasePreferences.*.text',
  // Prices are quoted per shopping context; the mapper picks by `.context` and
  // reads `salePrice ?? listPrice` then `.formattedAmount`.
  'SKUs.0.contextPrices.*.context',
  'SKUs.0.contextPrices.*.salePrice.formattedAmount',
  'SKUs.0.contextPrices.*.listPrice.formattedAmount',
  // The MEDIUM-rendition image fallback, for items with no carousel renditions.
  'productImageUrls.*.size',
  'productImageUrls.*.url',
] as const;

/** Every path censused per item, in a stable order. */
export function nextDataFieldPaths(): string[] {
  return [
    ...ITEM_FIELDS,
    ...SKU_FIELDS.map((f) => `SKUs.0.${f}`),
    ...NESTED_PATHS,
  ].sort();
}

/** Transcription of `__hebNorm` in heb.ts. Guarded by driftNextDataSurface.test.ts. */
function normalizeTerm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `q` parameter of the URL a fixture was captured from, normalized. */
export function expectedTermFromUrl(url: string | undefined): string {
  if (!url) return '';
  const m = /[?&]q=([^&]*)/.exec(url);
  if (!m) return '';
  try {
    return normalizeTerm(decodeURIComponent(m[1].replace(/\+/g, ' ')));
  } catch {
    return '';
  }
}

/** True when a value counts as "the field is there". */
function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

/**
 * Resolve a dotted path, where a numeric segment indexes an array and `*` means
 * "any element of this array satisfies the rest of the path".
 */
function hasPath(root: unknown, segments: string[]): boolean {
  if (segments.length === 0) return isPresent(root);
  const [head, ...rest] = segments;
  if (root === null || root === undefined) return false;

  if (head === '*') {
    return Array.isArray(root) && root.some((el) => hasPath(el, rest));
  }
  if (/^\d+$/.test(head)) {
    return Array.isArray(root) && hasPath(root[Number(head)], rest);
  }
  if (typeof root !== 'object') return false;
  return hasPath((root as Record<string, unknown>)[head], rest);
}

/** The SearchGridV2 visual component, by the same two signals heb.ts uses. */
function findGrid(nd: any): any | null {
  const vcs = nd?.props?.pageProps?.layout?.visualComponents;
  if (!Array.isArray(vcs) || vcs.length === 0) return null;
  for (const c of vcs) {
    if (!c) continue;
    if (c.__typename === 'SearchGridV2') return c;
    if (typeof c.id === 'string' && c.id.indexOf('searchGridV2:') === 0) return c;
  }
  return null;
}

/**
 * Census one fixture's JSON surface.
 *
 * @param rawJson the text content of `<script id="__NEXT_DATA__">`, or null when
 *        the page has none. Several committed fixtures are trimmed captures with
 *        no payload at all; that is a legitimate baselined state, not a failure.
 * @param captureUrl the URL from FIXTURE_CAPTURE_STORES this fixture came from,
 *        which supplies the term the freshness gate compares against.
 */
export function censusNextData(rawJson: string | null, captureUrl: string | undefined): NextDataCensus {
  if (rawJson === null) return { payload: 'absent' };

  let nd: any;
  try {
    nd = JSON.parse(rawJson);
  } catch {
    return { payload: 'unparseable' };
  }
  if (!nd) return { payload: 'unparseable' };

  const grid = findGrid(nd);
  if (!grid) return { payload: 'no-grid' };

  const items: unknown[] = Array.isArray(grid.items) ? grid.items : [];

  // Freshness, by heb.ts's rule: the term from the URL is primary, and with no
  // term to compare against the payload is unverifiable rather than trusted.
  // (heb.ts also falls back to the echoed <h1>, which is a DOM read and therefore
  // the DOM census's business, not this one — noted so the two are not mistaken
  // for a disagreement.)
  const expected = expectedTermFromUrl(captureUrl);
  const embedded = normalizeTerm(nd?.props?.pageProps?.searchTerm ?? nd?.query?.q ?? '');
  const freshness = !expected ? 'unverifiable' : embedded === expected ? 'fresh' : 'stale';

  const fields: Record<string, RatioBucket> = {};
  for (const path of nextDataFieldPaths()) {
    const segments = path.split('.');
    let present = 0;
    for (const item of items) if (hasPath(item, segments)) present++;
    fields[path] = ratioBucket(present, items.length);
  }

  return { payload: 'grid', freshness, fields };
}
