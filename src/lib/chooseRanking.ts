// Ranking for the CHOOSE-PRODUCT flow (MEAL-28).
//
// The choose flow shows the user every candidate the store returned and lets
// them pick one. Until now it showed them in the store's own order, which is
// the store's relevance ranking — influenced by paid placement and by whatever
// the store thinks it can upsell. On the labelled corpus that put an
// unacceptable product in the first row, and therefore under the default
// selection, on 7 of 17 answerable queries.
//
// ── Why this is NOT in _scoring.ts ──────────────────────────────────────────
//
// `scoreMatch` is copied verbatim into six injected store scripts, and each
// store's add-to-cart gate is `scoreMatch(term, name) === 100` (or the
// equivalent string equality). 100 is reachable only via the `na === nb` fast
// path, so the gate is exact-equality-after-normalization and nothing else.
// Changing `_scoring.ts` risks widening or narrowing what the add gate accepts,
// which is the one governing-principle breach this work could cause.
//
// So nothing here touches `scoreMatch`. This module only REORDERS a list that
// is already going to be shown to a human, using `scoreMatch` read-only. Three
// independent reasons it cannot affect what reaches a cart:
//
//   1. It is never called on the add path — only in the `isChooseFlow` branch.
//   2. The choose flow adds nothing. Picking a product saves it as the
//      ingredient's `searchTerm` for future runs; a later run still has to
//      clear the same exact-match gate.
//   3. It reorders; it never adds, removes or edits a candidate. The set of
//      products the user can choose from is byte-for-byte what the store
//      returned.
//
// ── What the ordering is ────────────────────────────────────────────────────
//
// Two tiers, because the difference between "the matcher recognised this" and
// "the matcher has no opinion" is categorical, not a matter of degree:
//
//   Tier 1  scoreMatch > 0 — ordered by score, then by how much of the product
//           name is stuff the query did not ask for (fewer is better).
//   Tier 2  scoreMatch === 0 — left in the store's own order.
//
// Tier 2 keeps the store's order deliberately. When our matcher recognises
// nothing, the store's relevance ranking is better than any order we can
// invent, and re-sorting it measurably hurts: on heb's "HEB season chicken
// thighs for fajitas" every product scores 0, and any reordering of that tier
// demotes the correct answer.
//
// The tiers are separate sort keys rather than one arithmetic score, so no
// choice of penalty weight can ever float an unrecognised product above a
// recognised one.
//
// ── The unrequested-word penalty ────────────────────────────────────────────
//
// `scoreOne` computes |query ∩ candidate| / |query| — what fraction of the
// QUERY the product covers. It never looks at the other direction, so every
// word of the product name that the query did not ask for is free. That is why
// "sour cream" ties at 99 across sour cream, sour cream dip, and sour cream &
// onion chips: all three contain both query words. The tiebreak below supplies
// the missing direction — of two products that cover the query equally, prefer
// the one that is less about something else.
//
// Measured on tests/match-harness (choose-flow P@1, 17 answerable queries):
// store order 10/17 → score-ranked 15/17 → with this tiebreak 16/17. See
// tests/match-harness/README.md for what was tried and rejected.

import { normDiacritic, scoreMatch } from './webview-scripts/_scoring';

/**
 * Per-word penalty for a word in the product name that the query did not ask
 * for. Only ever separates candidates that `scoreMatch` scored equally, and
 * only within tier 1, so its magnitude is not load-bearing: 1, 2 and 5 all
 * produce the identical ranking on the whole corpus. 1 is used because it is
 * the smallest value that expresses "this is a tiebreak, not a score".
 */
const UNREQUESTED_WORD_PENALTY = 1;

function tokens(s: string): string[] {
  return normDiacritic(s).split(' ').filter(Boolean);
}

/**
 * How many words of the product name the query did not ask for. Counted over
 * distinct words so a name that repeats a word is not punished twice for it.
 */
export function unrequestedWordCount(query: string, productName: string): number {
  const asked = new Set(tokens(query));
  let n = 0;
  for (const w of new Set(tokens(productName))) if (!asked.has(w)) n++;
  return n;
}

/**
 * Orders the products shown by the choose-product flow, best match first.
 *
 * Presentational only — see the module header. Returns a new array; the input
 * is not mutated and no element is added, dropped or altered.
 *
 * Stable: candidates that tie on every key keep the store's original order.
 */
export function rankChoiceCandidates<T extends { productName: string }>(
  query: string,
  candidates: readonly T[],
): T[] {
  const keyed = candidates.map((candidate, storeOrder) => {
    const score = scoreMatch(query, candidate.productName);
    return {
      candidate,
      storeOrder,
      recognised: score > 0,
      // Only meaningful in tier 1; tier 2 never consults it.
      rank: score - UNREQUESTED_WORD_PENALTY * unrequestedWordCount(query, candidate.productName),
    };
  });

  keyed.sort((a, b) => {
    // Tier: anything the matcher recognised outranks anything it did not,
    // whatever the penalty did to the numbers.
    if (a.recognised !== b.recognised) return a.recognised ? -1 : 1;
    // Within tier 2 the store's order is the only signal we have, and it is
    // better than ours.
    if (!a.recognised) return a.storeOrder - b.storeOrder;
    if (a.rank !== b.rank) return b.rank - a.rank;
    return a.storeOrder - b.storeOrder;
  });

  return keyed.map((k) => k.candidate);
}
