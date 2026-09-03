// Diacritic-tolerant product-name scoring.
//
// **Note on duplication**: the store scripts (heb.ts, walmart.ts, wegmans.ts,
// etc.) inline COPIES of these functions inside template literals because
// they get injected into a WebView's global scope where there's no module
// system. The copies must stay byte-identical to the bodies below; the
// fixture tests catch drift indirectly (a behavioral change in either copy
// fails the same store's spec), and the unit tests in tests/unit/webview-
// scripts/scoring.test.ts pin the contract here.

const CRITICAL_WORDS = new Set([
  'organic', 'grass', 'fed', 'free', 'range', 'cage', 'large', 'small',
  'jumbo', 'medium', 'extra', 'spicy', 'mild', 'hot', 'sweet', 'whole',
  'skim', 'nonfat', 'lowfat', 'salted', 'unsalted', 'sodium', 'boneless',
  'skinless', 'lean', 'ground',
  // Canonical joined forms of the phrases below. Nothing reaches the veto
  // spelled any other way once `collapseCriticalPhrases` has run.
  'grassfed', 'cagefree', 'freerange',
]);

/**
 * Concepts that are TWO words on one label and ONE word on the next.
 *
 * The veto is a set-membership test on tokens, so it is only as good as the
 * agreement between how a shopper writes an ingredient and how a store writes a
 * product. "lowfat" and "nonfat" were in the set as single tokens while the
 * normalisers turn every hyphen into a space — so the entries misfired in both
 * directions at once, measured (MEAL-160):
 *
 *   scoreMatch("low fat cottage cheese", "Full Fat Cottage Cheese") = 75
 *       The natural spelling of the query tokenises to `low` + `fat`, neither
 *       of which is critical, so the entry protected NOTHING: a full-fat
 *       product stayed eligible for auto-pick against a low-fat request.
 *
 *   scoreMatch("lowfat cottage cheese", "Low-Fat Cottage Cheese") = 0
 *       And when the joined spelling DID appear in the query, no hyphenated or
 *       spaced product could ever satisfy it, so the RIGHT product scored zero.
 *
 * The audit the ticket asked for found the same shape on the two-token entries,
 * reproduced the same way: `grassfed beef` vs "Grass Fed Beef" scored 0, and
 * `cagefree eggs` vs "Cage Free Eggs" scored 0.
 *
 * Collapsing every spelling to one canonical token on BOTH sides before the
 * membership test is what makes the entry mean the concept rather than one
 * spelling of it.
 *
 * Order matters, and not for the reason an earlier version of this comment gave
 * ("longest first" — which was both wrong about the lengths and unpinned by any
 * test). `cage free` and `free range` share a word, so whichever runs first eats
 * it. The three-word rule below settles that case explicitly instead.
 *
 * Deliberately NOT extended to `sodium`: it is a single word that works as a
 * single word, and adding a `lowsodium` concept would newly veto "Reduced
 * Sodium" against a "low sodium" request — a real behaviour change, not a
 * spelling fix, and not what this ticket measured.
 *
 * NOT a complete audit of `CRITICAL_WORDS`, and the docblock should not be read
 * as claiming one. A cold review found the same defect shape on families that
 * are not in the set at all, so this change does not touch them:
 *
 *   "glutenfree white sandwich bread" vs "White Sandwich Bread"  = 75
 *   "fatfree greek vanilla yogurt"    vs "Greek Vanilla Yogurt"  = 75
 *   "dairyfree almond vanilla milk"   vs "Almond Vanilla Milk"   = 75
 *
 * Those are "the entry protects nothing" on an allergen attribute — the same
 * shape MEAL-160 exists to fix, one family over. They score 75, not 100, so
 * nothing auto-adds: it is a wrong suggestion, not a wrong add. Adding them
 * means introducing new veto concepts rather than reconciling spellings of
 * existing ones, which changes matching broadly and wants its own measurement.
 * Filed as MEAL-168.
 */
const CRITICAL_PHRASES: Array<[RegExp, string]> = [
  // "Cage Free Range Eggs" is a real label, and the two concepts in it SHARE the
  // word `free`. A plain left-to-right pass collapses `cage free` first, eats
  // that word, and leaves `cagefree range` — so a "free range eggs" request
  // vetoes the very product it was looking for. This rule runs first and hands
  // both concepts their own token.
  [/\bcage free range\b/g, 'cagefree freerange'],
  [/\bcage free\b/g, 'cagefree'],
  [/\bfree range\b/g, 'freerange'],
  [/\bgrass fed\b/g, 'grassfed'],
  [/\blow fat\b/g, 'lowfat'],
  [/\bnon fat\b/g, 'nonfat'],
];

/** The canonical tokens the phrases above collapse TO. Each stands for two words. */
const CANONICAL_TOKENS = new Set(['cagefree', 'freerange', 'grassfed', 'lowfat', 'nonfat']);

/**
 * How much a token is worth in the overlap fraction.
 *
 * A collapsed token replaced two words, so counting it as one shrinks BOTH
 * sides of `matchCount / wa.length` and quietly raises the bar. `3/4 = 0.75`
 * passes the 70% floor; the same match after a collapse is `2/3 = 0.667` and
 * fails. Measured: "2% low fat milk" against "Low Fat Milk" scored 75 before
 * this change and 0 after — a correct product dropped out of the ranked list
 * because the request carried one extra word, which is the common real shape (a
 * percentage, a brand).
 *
 * Weighting a canonical token as the two words it stands for leaves the
 * denominator where it was. It is weighted whether the query wrote it joined or
 * spaced, so the two spellings cannot score differently — which is the entire
 * point of collapsing them.
 */
function tokenWeight(token: string): number {
  return CANONICAL_TOKENS.has(token) ? 2 : 1;
}

export function collapseCriticalPhrases(s: string): string {
  let out = s;
  for (const [pattern, canonical] of CRITICAL_PHRASES) out = out.replace(pattern, canonical);
  return out;
}

/**
 * Lowercases, NFD-decomposes, strips combining-mark codepoints (so "ñ"
 * becomes "n" via "n" + COMBINING TILDE → "n"), and reduces to alphanumeric
 * tokens. "Jalapeño" → "jalapeno".
 */
export function normDiacritic(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Same as normDiacritic, plus strips any remaining non-ASCII characters
 * that didn't NFD-decompose to ASCII + combining-mark pairs. In practice
 * for Latin-script names this produces identical output to normDiacritic
 * — the extra strip step only matters for exotic chars (Chinese, emoji).
 *
 * **Known limitation**: the original intent (per the wegmans.ts comment)
 * was to handle Walmart's stripped form where "Jalapeño" → "Jalapeo"
 * (ñ dropped entirely, not substituted). To achieve that, non-ASCII would
 * need to be stripped BEFORE NFD decomposition, not after. The current
 * order means normStrip("Jalapeño") returns "jalapeno", same as
 * normDiacritic. The dual-normalization in scoreMatch therefore provides
 * minimal benefit for grocery product names today. Reordering the steps
 * is deferred (would change runtime behavior of every store's matching).
 */
export function normStrip(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreOne(rawA: string, rawB: string): number {
  // Both sides, so the veto compares concepts rather than spellings. Applied
  // here rather than inside the normalisers because `chooseRanking` tokenises
  // with `normDiacritic` for its own overlap score, which is a different
  // mechanism and not what MEAL-160 measured.
  const na = collapseCriticalPhrases(rawA);
  const nb = collapseCriticalPhrases(rawB);
  if (na === nb) return 100;
  const wa = na.split(' ').filter(Boolean);
  const sb = new Set(nb.split(' ').filter(Boolean));
  // Hard veto: if a critical word from the search term is missing from the
  // candidate, the candidate is wrong regardless of how many other words
  // overlap. "Organic Boneless Chicken" must not match "Boneless Chicken".
  for (const w of wa) {
    if (CRITICAL_WORDS.has(w) && !sb.has(w)) return 0;
  }
  // Weighted, so a collapsed token counts for the two words it replaced — see
  // `tokenWeight`. With every weight 1 this is the arithmetic it always was.
  const total = wa.reduce((sum, w) => sum + tokenWeight(w), 0);
  const matched = wa.reduce((sum, w) => sum + (sb.has(w) ? tokenWeight(w) : 0), 0);
  const p = matched / total;
  if (p < 0.7) return 0;
  return Math.min(99, Math.round(p * 100));
}

/**
 * Returns 0-100 confidence that candidate `b` matches search term `a`.
 * Compares using both normalizations (diacritic-substitute and diacritic-
 * strip) and returns the better score, so a Walmart "Jalapeo" candidate
 * scores the same as a Wegmans "Jalapeño" candidate for the same search.
 */
export function scoreMatch(a: string, b: string): number {
  const s1 = scoreOne(normDiacritic(a), normDiacritic(b));
  const s2 = scoreOne(normStrip(a), normStrip(b));
  return Math.max(s1, s2);
}

/**
 * Units a store appends to a product name. Not a general unit list: these are
 * the ones that appear in a trailing SIZE, which is the only place this is used.
 */
const SIZE_UNITS = '(?:fl\\s*oz|oz|lbs?|ct|count|g|kg|mg|ml|l|liters?|litres?|'
  + 'pk|packs?|pieces?|each|ea|qt|pt|gal|dozen)';

/** A trailing ", 28 oz" / " - 8 count" / ", per lb" / ", 1.6 oz", one at a time. */
const SIZE_TAIL = new RegExp(
  '[,\\-\\s]*(?:per\\s+)?(?:\\d+(?:[.,/]\\d+)?\\s*)?' + SIZE_UNITS + '\\.?\\s*$', 'i');

/**
 * Peel trailing sizes off a product name.
 *
 * On the RAW string, not the normalised one. normDiacritic turns every
 * non-alphanumeric into a space, so "1.6 oz" becomes "1 6 oz" and the decimal
 * that the size pattern is matching on is gone — three of ALDI's eight
 * size-suffixed names are decimals, and stripping after normalising left a
 * stray "1" behind on each. Normalise once at the end, for the comparison.
 *
 * "Cilantro Bunch, each, 1 each" -> "cilantro bunch".
 */
function stripTrailingSizes(name: string): string {
  let s = name;
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(SIZE_TAIL, '').replace(/[,\-\s]+$/, '');
    if (next === s || !next) break;
    s = next;
  }
  return normDiacritic(s);
}

/**
 * IS THE CANDIDATE THE SAME PRODUCT, DIFFERING ONLY BY A TRAILING SIZE?
 *
 * scoreMatch returns 100 only for strings that are equal after normalisation,
 * and the add path requires 100 — deliberately, because anything looser adds a
 * product the user did not ask for. But a store that appends its pack size to
 * every product name can then never produce a 100:
 *
 *   saved     "Happy Harvest Crushed Tomatoes"
 *   ALDI      "Happy Harvest Crushed Tomatoes, 28 oz"      -> 99, forever
 *
 * MEASURED on Stephen's own run, 2026-09-03: 14 of 14 items scored 99 and every
 * one went to review. "Seems like you are stripping the search name? You
 * shouldn't do that." Nothing was stripping it — the store was ADDING to it.
 *
 * This is deliberately narrower than "accept 99". A 99 also covers a candidate
 * with EXTRA WORDS, and on that same run 99 would have matched "Organic
 * Broccoli" to "Season's Choice Organic Broccoli Florets, 10 oz" — a different
 * product, a different brand. The rule here is that everything the candidate has
 * beyond the term is a size, and nothing else.
 *
 * The caller must also require that exactly ONE candidate qualifies. Where a
 * store lists the same product in two sizes, picking one is a size choice the
 * user never made, and that belongs on the review screen.
 */
export function sameProductBarSize(term: string, candidateName: string): boolean {
  const t = normDiacritic(term);
  const c = normDiacritic(candidateName);
  if (!t || !c || t === c) return false;
  // The RAW candidate, for the reason stripTrailingSizes explains: normalising
  // first destroys the decimal point that the size pattern matches on.
  return stripTrailingSizes(candidateName) === t;
}
