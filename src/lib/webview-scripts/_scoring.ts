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
 * spelling of it. Ordered longest-first, since "cage free" and "free range"
 * share a word.
 *
 * Deliberately NOT extended here: `sodium` is a single word that works as a
 * single word, and adding a `lowsodium` concept would newly veto "Reduced
 * Sodium" against a "low sodium" request — a real behaviour change, not a
 * spelling fix, and not what this ticket measured.
 */
const CRITICAL_PHRASES: Array<[RegExp, string]> = [
  [/\bcage free\b/g, 'cagefree'],
  [/\bfree range\b/g, 'freerange'],
  [/\bgrass fed\b/g, 'grassfed'],
  [/\blow fat\b/g, 'lowfat'],
  [/\bnon fat\b/g, 'nonfat'],
];

function collapseCriticalPhrases(s: string): string {
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
  const matchCount = wa.filter((w) => sb.has(w)).length;
  const p = matchCount / wa.length;
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
