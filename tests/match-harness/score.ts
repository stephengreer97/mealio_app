// Product-matching evaluation harness (MEAL-27).
//
//   npm run match-harness              print the report
//   npm run match-harness -- --json    machine-readable metrics
//   npm run match-harness -- --write-baseline   overwrite baseline.json
//
// Scores src/lib/webview-scripts/_scoring.ts against the labelled corpus in
// corpus.json + labels.json and reports, per store, whether the matcher picks
// a product a shopper would accept. `npm test` gates on the numbers in
// baseline.json (tests/unit/match-harness.test.ts), so a change to _scoring.ts
// that lowers them fails the build.
//
// ── What the numbers mean ────────────────────────────────────────────────────
//
// scoreMatch is effectively ternary: it returns 0 (below the 70% word-overlap
// floor, or vetoed by a CRITICAL_WORD), 70–99 (partial overlap), or exactly 100
// (identical after normalization — Math.min(99, …) makes 100 unreachable any
// other way). Every metric below is built around that shape:
//
//   precision@1        Of the answerable queries where the matcher scored
//                      anything above 0, how often is its top-ranked product
//                      one a shopper would accept? Ties are broken by the
//                      store's own result order, which is what the store
//                      scripts do (they keep the FIRST best-scoring card).
//                      This is the metric that moves when ranking changes.
//
//   acceptable-match   Of ALL answerable queries, how often would the live flow
//                      actually put an acceptable product in the cart —
//                      i.e. the top pick clears that store's auto-add threshold
//                      AND is acceptable. Declining to pick counts as a miss.
//
//   abstain-correct    On queries where NO product is acceptable (see the
//                      "UNANSWERABLE BY DESIGN" notes in labels.json), the
//                      right behaviour is to add nothing. This counts that.
//
//   pair precision/    Over every labelled (query, product) pair rather than
//   recall @ score>0   per query, so the denominator is in the hundreds rather
//                      than single digits: of the pairs the matcher scores
//                      above 0, how many are acceptable (precision), and of the
//                      acceptable pairs, how many does it score above 0
//                      (recall). These are the statistically meaty numbers;
//                      the per-query ones have a denominator of 2–6.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { scoreMatch } from '../../src/lib/webview-scripts/_scoring';

const DIR = path.resolve(__dirname);

/**
 * The score at which each store's live flow will auto-add without asking.
 *
 * EVERY store requires an exact normalized name match — see
 * buildSearchAndAddScript in each store script and the auto-pick branch in
 * WebViewCartSheet. Four of them spell that as `scoreMatch(...) === 100`, which
 * in _scoring.ts means equality and nothing else because every path but the
 * `na === nb` fast path is capped by `Math.min(99, …)`; Albertsons and ALDI
 * compare the normalized strings themselves.
 *
 * ALDI used to be the exception, acting on a fuzzy score (`MIN_SCORE = 30` in
 * instacart.ts, in practice "70 or better" since its scoreOne emitted nothing
 * between 1 and 69). MEAL-121 removed that: its gate is now `isExactMatch`, an OR
 * over the same two normalizations scoreMatch maxes over, which accepts exactly
 * the strings `=== 100` accepts. So 100 is the faithful threshold for every row
 * here, and ALDI's accept-match column describes live behaviour again.
 */
const AUTO_ADD_THRESHOLD: Record<string, number> = {
  heb: 100,
  walmart: 100,
  albertsons: 100,
  'amazon-fresh': 100,
  wegmans: 100,
  aldi: 100,
};

/**
 * Whether the store's injected script actually runs _scoring.ts's algorithm.
 *
 * heb/walmart/albertsons/amazon-fresh/wegmans inline a byte-identical copy of
 * scoreOne + scoreMatch, so their rows describe live behaviour.
 *
 * ALDI does NOT, despite the "must stay byte-identical" note at the top of
 * _scoring.ts. instacart.ts carries its own scoreOne (a 0.3 overlap floor, a −5
 * penalty per extra word in the candidate, and a critical-word penalty instead of
 * a hard veto), and until MEAL-121 it called that scorer as
 * scoreMatch(candidateName, searchTerm) — the arguments the other way round from
 * every other store — to decide what to add.
 *
 * It no longer decides anything: the add gate is string equality, and the local
 * scorer is unreachable from it. So the false flag below now means something
 * narrower than it used to. ALDI's accept-match and abstain columns are live-
 * accurate (see AUTO_ADD_THRESHOLD). What is still not a statement about ALDI is
 * the RANKING: P@1 and the pair columns are _scoring.ts measured on ALDI's result
 * pages, and ALDI ranks nothing — it takes the first exactly-named tile. Left in
 * the corpus because the pages are real labelled data for the scorer under test;
 * flagged so the ranking numbers are never read as ALDI's live match quality.
 */
const USES_SHARED_SCORER: Record<string, boolean> = {
  heb: true,
  walmart: true,
  albertsons: true,
  'amazon-fresh': true,
  wegmans: true,
  aldi: false,
};

interface CorpusQuery {
  query: string;
  queryProvenance: string;
  fixtures: string[];
  products: string[];
}
interface Corpus { stores: Record<string, CorpusQuery[]> }
interface LabelEntry {
  reviewedProductCount: number;
  productsFingerprint: string;
  acceptable: string[];
  notes?: string;
}
interface Labels { queries: Record<string, LabelEntry> }

export interface StoreMetrics {
  /** False when the store's live script runs a different scorer — see USES_SHARED_SCORER. */
  usesSharedScorer?: boolean;
  queries: number;
  answerableQueries: number;
  unanswerableQueries: number;
  pairs: number;
  acceptablePairs: number;
  /** Top-ranked product is acceptable, over answerable queries the matcher scored. */
  precisionAt1: number | null;
  precisionAt1Numerator: number;
  precisionAt1Denominator: number;
  /** Live flow would add an acceptable product, over ALL answerable queries. */
  acceptableMatchRate: number;
  acceptableMatchNumerator: number;
  /** Correctly added nothing, over unanswerable queries. */
  abstainCorrect: number | null;
  abstainDenominator: number;
  pairPrecision: number | null;
  pairRecall: number | null;
}

export interface QueryDetail {
  store: string;
  query: string;
  products: number;
  acceptable: number;
  topProduct: string | null;
  topScore: number;
  topAcceptable: boolean | null;
  autoAdds: boolean;
}

export interface Report {
  stores: Record<string, StoreMetrics>;
  overall: StoreMetrics;
  details: QueryDetail[];
}

function fingerprint(products: string[]): string {
  return crypto.createHash('sha1').update(products.join(' ')).digest('hex').slice(0, 12);
}

/**
 * Ranks candidates: highest score wins, and the FIRST card at that score wins a
 * tie, so the store's own relevance order is the tiebreak.
 *
 * No store script actually ranks. Every one of them scans in result order behind a
 * `!bestName` guard and stops at the first card that clears its gate — which at a
 * threshold of 100 gives the same answer as this function, since the tie it breaks
 * is a tie among exact matches. The max-score loop this mirrors was ALDI's, and
 * MEAL-121 replaced it. Ranking therefore only shows up in the P@1 and pair
 * columns, which describe what _scoring.ts WOULD do if a store ranked.
 */
function topCandidate(query: string, products: string[]): { name: string; score: number } {
  let best = { name: products[0], score: -1 };
  for (const p of products) {
    const s = scoreMatch(query, p);
    if (s > best.score) best = { name: p, score: s };
  }
  return best;
}

export function evaluate(): Report {
  const corpus: Corpus = JSON.parse(fs.readFileSync(path.join(DIR, 'corpus.json'), 'utf8'));
  const labels: Labels = JSON.parse(fs.readFileSync(path.join(DIR, 'labels.json'), 'utf8'));

  const details: QueryDetail[] = [];
  const stores: Record<string, StoreMetrics> = {};
  const blank = (): StoreMetrics & { tp: number; fp: number; fn: number } => ({
    queries: 0, answerableQueries: 0, unanswerableQueries: 0, pairs: 0, acceptablePairs: 0,
    precisionAt1: null, precisionAt1Numerator: 0, precisionAt1Denominator: 0,
    acceptableMatchRate: 0, acceptableMatchNumerator: 0,
    abstainCorrect: null, abstainDenominator: 0,
    pairPrecision: null, pairRecall: null,
    tp: 0, fp: 0, fn: 0,
  });
  const acc: Record<string, ReturnType<typeof blank>> = {};
  const overall = blank();

  for (const [store, queries] of Object.entries(corpus.stores)) {
    acc[store] = blank();
    const threshold = AUTO_ADD_THRESHOLD[store];
    if (threshold === undefined) throw new Error(`No auto-add threshold recorded for store "${store}"`);

    for (const q of queries) {
      const key = `${store}|${q.query}`;
      const label = labels.queries[key];
      // Fail loudly rather than scoring against stale or missing judgement.
      // A corpus rebuild that changes a result page invalidates its labels;
      // a human has to look at the new products before the number means anything.
      if (!label) throw new Error(`labels.json has no entry for "${key}". Label it before scoring.`);
      const fp = fingerprint(q.products);
      if (label.productsFingerprint !== fp) {
        throw new Error(
          `labels.json for "${key}" was written against a different product list ` +
          `(fingerprint ${label.productsFingerprint}, corpus is now ${fp}). ` +
          `Re-review the ${q.products.length} products and update the labels.`,
        );
      }
      const acceptable = new Set(label.acceptable);
      for (const name of label.acceptable) {
        if (!q.products.includes(name)) {
          throw new Error(`labels.json "${key}" marks a product that is not in the corpus: "${name}"`);
        }
      }

      const a = acc[store];
      a.queries++;
      a.pairs += q.products.length;
      a.acceptablePairs += acceptable.size;

      // Pair-level confusion at "the matcher considers this a match at all".
      for (const p of q.products) {
        const scored = scoreMatch(q.query, p) > 0;
        const ok = acceptable.has(p);
        if (scored && ok) a.tp++;
        else if (scored && !ok) a.fp++;
        else if (!scored && ok) a.fn++;
      }

      const top = topCandidate(q.query, q.products);
      const answerable = acceptable.size > 0;
      const autoAdds = top.score >= threshold;

      details.push({
        store, query: q.query, products: q.products.length, acceptable: acceptable.size,
        topProduct: top.score > 0 ? top.name : null,
        topScore: top.score,
        topAcceptable: top.score > 0 ? acceptable.has(top.name) : null,
        autoAdds,
      });

      if (answerable) {
        a.answerableQueries++;
        if (top.score > 0) {
          a.precisionAt1Denominator++;
          if (acceptable.has(top.name)) a.precisionAt1Numerator++;
        }
        if (autoAdds && acceptable.has(top.name)) a.acceptableMatchNumerator++;
      } else {
        a.unanswerableQueries++;
        a.abstainDenominator++;
        if (!autoAdds) a.abstainCorrect = (a.abstainCorrect ?? 0) + 1;
        else a.abstainCorrect = a.abstainCorrect ?? 0;
      }
    }
  }

  const finish = (a: ReturnType<typeof blank>): StoreMetrics => {
    a.precisionAt1 = a.precisionAt1Denominator ? a.precisionAt1Numerator / a.precisionAt1Denominator : null;
    a.acceptableMatchRate = a.answerableQueries ? a.acceptableMatchNumerator / a.answerableQueries : 0;
    a.pairPrecision = a.tp + a.fp ? a.tp / (a.tp + a.fp) : null;
    a.pairRecall = a.tp + a.fn ? a.tp / (a.tp + a.fn) : null;
    if (a.abstainDenominator === 0) a.abstainCorrect = null;
    const { tp, fp, fn, ...rest } = a;
    return rest;
  };

  for (const [store, a] of Object.entries(acc)) {
    for (const k of ['queries', 'answerableQueries', 'unanswerableQueries', 'pairs', 'acceptablePairs',
      'precisionAt1Numerator', 'precisionAt1Denominator', 'acceptableMatchNumerator',
      'abstainDenominator', 'tp', 'fp', 'fn'] as const) {
      (overall as any)[k] += (a as any)[k];
    }
    overall.abstainCorrect = (overall.abstainCorrect ?? 0) + (a.abstainCorrect ?? 0);
    stores[store] = { usesSharedScorer: USES_SHARED_SCORER[store], ...finish(a) };
  }

  return { stores, overall: finish(overall), details };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v === null ? '   n/a' : (v * 100).toFixed(1).padStart(5) + '%';
}

function frac(n: number, d: number): string {
  return `${n}/${d}`;
}

function print(report: Report) {
  console.log('\nProduct-matching harness — src/lib/webview-scripts/_scoring.ts');
  console.log('Corpus: real search-result fixtures only (tests/match-harness/corpus.json)\n');

  const head = 'store           queries  pairs   P@1          accept-match   abstain-ok   pair-P   pair-R';
  console.log(head);
  console.log('-'.repeat(head.length));
  const row = (name: string, m: StoreMetrics) => {
    console.log(
      (m.usesSharedScorer === false ? name + ' *' : name).padEnd(15) +
      String(m.queries).padStart(5) + '  ' +
      String(m.pairs).padStart(6) + '  ' +
      pct(m.precisionAt1) + ' ' + frac(m.precisionAt1Numerator, m.precisionAt1Denominator).padEnd(7) +
      pct(m.acceptableMatchRate) + ' ' + frac(m.acceptableMatchNumerator, m.answerableQueries).padEnd(7) +
      (m.abstainCorrect === null ? '  n/a  ' : frac(m.abstainCorrect, m.abstainDenominator).padStart(5) + '  ').padEnd(13) +
      pct(m.pairPrecision) + '  ' + pct(m.pairRecall),
    );
  };
  for (const [store, m] of Object.entries(report.stores)) row(store, m);
  console.log('-'.repeat(head.length));
  row('ALL', report.overall);

  if (Object.values(report.stores).some((m) => m.usesSharedScorer === false)) {
    console.log(
      '\n  * instacart.ts still carries ALDI\'s own scorer (different overlap floor,\n' +
      '    extra-word penalty, reversed argument order), but since MEAL-121 nothing\n' +
      '    calls it: ALDI gates the add on string equality like every other store. So\n' +
      '    the accept-match and abstain columns are live-accurate, while P@1 and the\n' +
      '    pair columns are _scoring.ts measured on ALDI pages — ALDI ranks nothing.',
    );
  }

  console.log('\nPer query (top-ranked product, ties broken by store result order):\n');
  for (const d of report.details) {
    const verdict = d.acceptable === 0
      ? (d.autoAdds ? 'WRONG-ADD (no acceptable product exists)' : 'ok — declined, nothing acceptable exists')
      : d.topScore === 0
      ? 'MISS — matcher scored nothing'
      : d.topAcceptable
      ? (d.autoAdds ? 'HIT — would auto-add' : 'ranked right, below auto-add threshold → manual review')
      : 'WRONG — top pick is not acceptable';
    console.log(`  ${d.store}/${d.query}`);
    console.log(`      ${d.acceptable}/${d.products} acceptable · top=${d.topScore} ${d.topProduct ?? '(none)'}`);
    console.log(`      ${verdict}`);
  }
  console.log();
}

if (require.main === module) {
  const report = evaluate();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ stores: report.stores, overall: report.overall }, null, 2));
  } else {
    print(report);
  }
  if (process.argv.includes('--write-baseline')) {
    const out = {
      recordedAt: new Date().toISOString().slice(0, 10),
      note: 'Baseline for MEAL-27. Regenerate with `npm run match-harness -- --write-baseline` ' +
        'ONLY alongside an intentional scoring change, and state the before/after in the PR.',
      stores: report.stores,
      overall: report.overall,
    };
    fs.writeFileSync(path.join(DIR, 'baseline.json'), JSON.stringify(out, null, 2) + '\n');
    console.log('Wrote tests/match-harness/baseline.json');
  }
}
