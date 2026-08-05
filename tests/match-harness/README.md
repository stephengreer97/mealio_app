# Product-matching evaluation harness (MEAL-27)

Measures whether `src/lib/webview-scripts/_scoring.ts` picks a product the
shopper would accept, per store, so a scoring change can be shown to help or
hurt instead of argued about.

```bash
npm run match-harness            # the report
npm run match-harness -- --json  # machine-readable metrics
```

`npm test` gates on it: `tests/unit/match-harness.test.ts` recomputes the
metrics and fails if they differ from `baseline.json` in either direction. An
improvement fails too — re-record the baseline with
`npm run match-harness -- --write-baseline` and put the before/after in the PR.

## Files

| File | What it is |
| --- | --- |
| `build-corpus.ts` | Extracts (query, products) out of the committed fixtures. Run only after re-capturing fixtures: `npm run match-harness:build`. Needs Playwright. |
| `corpus.json` | Generated. Real search queries and the real products each store returned. No hand-written product data. |
| `labels.json` | **The human-owned file.** Which products are acceptable for each query, the rubric, and the calls that are debatable. Edit this by hand. |
| `score.ts` | Runs `scoreMatch` over the labelled corpus and reports. |
| `baseline.json` | Generated. The numbers as of the last intentional scoring change. |

## Corpus size — the ≥200-pairs-per-store target is NOT met

A "pair" is one (ingredient string, candidate product) judgement. Everything
here comes from the fixtures that were already committed; nothing is invented.

| Store | Queries | Pairs | Acceptable | ≥200? |
| --- | --- | --- | --- | --- |
| heb | 6 | 182 | 59 | no |
| walmart | 3 | 85 | 32 | no |
| albertsons | 3 | 74 | 26 | no |
| amazon-fresh | 3 | 61 | 17 | no |
| aldi | 2 | 38 | 13 | no |
| wegmans | 3 | 29 | 4 | no |
| **total** | **20** | **469** | **151** | — |

The ceiling is the number of distinct searches that were ever captured, not the
number of tiles. Each store has 2–6 real search-result pages, several of which
are the *same* query re-captured in a different UI state (stepper open, product
in cart) and are merged rather than counted twice.

**Closing the gap needs more captures, not more labelling.** Roughly 20–40
products come back per search, so ~6 additional distinct ingredient searches per
store would clear 200. That is a `npm run capture` session per store with the
fixture list in `src/lib/fixture-capture-config.ts` extended with ingredients
drawn from real preset meals. Synthesising products to reach 200 would make the
report worse than useless — it would attest to precision the code has never
demonstrated — so it was not done.

### What is deliberately excluded

`build-corpus.ts`'s `EXCLUDED` map lists every search-looking fixture that
carries no labellable retrieval, with the reason: a deliberately stale HEB
capture whose query and results don't correspond, a Walmart product page, two
hand-trimmed DOM fragments, and the Wegmans synthetic tile.

## Metrics

`scoreMatch` is effectively ternary — 0, 70–99, or exactly 100 (`Math.min(99,…)`
makes 100 reachable only by exact match after normalization). The metrics are
shaped around that:

- **precision@1** — of the answerable queries the matcher scored at all, how
  often is its top-ranked product acceptable. Ties break by the store's own
  result order, which is what the store scripts do. This is the ranking-quality
  number.
- **acceptable-match rate** — of *all* answerable queries, how often the live
  flow would actually put an acceptable product in the cart, i.e. the top pick
  clears that store's auto-add threshold *and* is acceptable. Declining counts
  as a miss.
- **abstain-ok** — on queries where nothing is acceptable, adding nothing is the
  right answer. The unit test treats a false auto-add here as a hard failure.
- **pair precision / recall** — over all 469 pairs rather than per query, so the
  denominator is in the hundreds instead of single digits. Precision: of the
  pairs scored above 0, how many are acceptable. Recall: of the acceptable
  pairs, how many score above 0.

Note the small denominators on the per-query metrics: with 2–6 queries per
store, precision@1 moves in steps of 20–50 percentage points. Treat the
pair-level numbers as the sensitive ones and precision@1 as a coarse alarm.

## Baseline (recorded 2026-08-05, `_scoring.ts` unchanged)

```
store           queries  pairs   P@1          accept-match   abstain-ok   pair-P   pair-R
heb                6     182  100.0% 5/5      0.0% 0/6      n/a         35.9%   88.1%
walmart            3      85   66.7% 2/3     33.3% 1/3      n/a         49.2%   96.9%
albertsons         3      74   50.0% 1/2      0.0% 0/2      1/1         52.1%   96.2%
aldi *             2      38  100.0% 2/2    100.0% 2/2      n/a         80.0%   92.3%
amazon-fresh       3      61  100.0% 2/2      0.0% 0/2      1/1         56.7%  100.0%
wegmans            3      29  100.0% 2/2    100.0% 2/2      1/1         36.4%  100.0%
ALL               20     469   87.5% 14/16   29.4% 5/17     3/3         45.2%   93.4%
```

What the baseline says:

1. **Ranking is mostly right, but ties are decided by the store.** Two of the
   sixteen scored queries put an unacceptable product first, and both are ties
   at 99 broken by result order: Walmart's "sour cream" leads with *Daisy Sour
   Cream Creamy Ranch Dip*, Albertsons' with *Herr's Sour Cream & Onion Chips*.
   `scoreMatch` cannot separate a dip from the dairy it is named after, because
   every word of the query appears in both.

2. **The auto-add gate is exact-name equality, so ranking barely reaches the
   cart.** Only 5 of 17 answerable queries end with an acceptable product added.
   Four of those five are queries that were already a full product name (the
   search-and-add flow re-finding a product the user picked earlier). For an
   ingredient like "sour cream" no product is ever named exactly that, so the
   score tops out at 99 and every store except ALDI sends the item to manual
   review. Improving the ranking will not change the cart at all until that gate
   changes.

3. **Pair precision is low (45%) against high recall (93%).** The 70%
   word-overlap floor lets nearly everything related through — for "sour cream"
   that includes the chips, the dips and the crema — and then leans on the exact
   match to sort it out. That is the shape of a matcher tuned for recall.

4. **`_scoring.ts` no longer describes what ALDI runs.** The header comment says
   the store copies must stay byte-identical; `aldi.ts` has its own `scoreOne`
   (a 0.3 overlap floor, −5 per extra candidate word, a critical-word penalty
   instead of a hard veto) and calls it with the arguments reversed. Its row is
   `_scoring.ts` measured on ALDI's pages, not ALDI's live match quality — hence
   the asterisk. The other five stores' copies were checked and are identical.

## What the corpus can and cannot see

Checked by mutating `_scoring.ts` and re-running:

| Change to `_scoring.ts` | Harness reaction |
| --- | --- |
| Extra-word penalty (`−5` per candidate word absent from the query) | **Detected.** Overall P@1 87.5% → 93.8%; walmart 66.7% → 100%, albertsons 50% → 100%, heb 100% → 80%. |
| Word-overlap floor 0.7 → 0.9 | **Invisible.** Every metric identical. |
| `CRITICAL_WORDS` veto removed entirely | **Invisible.** Every metric identical. |

The last two are a real blind spot, not a bug in the harness. Almost every
scored pair here has *all* the query's words present (`p = 1.0`), so the floor
never binds between 0.7 and 0.9; and only two of the twenty queries contain a
critical word at all, in both cases on a query where the exact match wins anyway.
Ranking changes are caught; threshold and veto changes are not. Closing that
needs queries carrying the attributes the veto exists for — "organic milk",
"boneless skinless chicken thighs", "unsalted butter", "large eggs" — which is
another argument for the extra capture sessions above.

## Labelling

`labels.json` carries the rubric, the per-query notes, and a `debatable` list of
the calls that could reasonably have gone the other way (light vs regular sour
cream, crema, whole-wheat tortillas, organic, Greek yogurt, case packs). The
short version:

> A product is acceptable if a shopper who wrote that line on a meal plan would
> be satisfied to find it in their cart. Brand is free when the query names none
> and binding when it names one; size and packaging are free; an attribute the
> query does not ask for and that changes how the food eats (light, low-carb,
> whole wheat, flavoured, dairy-free) makes it unacceptable; organic is the
> deliberate exception. Where it is genuinely arguable, the conservative reading
> wins.

Each entry records `reviewedProductCount` and a `productsFingerprint` of the
product list it was written against. `score.ts` refuses to run if the corpus has
moved underneath the labels — a re-capture that changes a result page forces a
human back through the new products before any number is reported again.
