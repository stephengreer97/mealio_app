# Product-matching evaluation harness (MEAL-27)

Measures whether `src/lib/webview-scripts/_scoring.ts` picks a product the
shopper would accept, per store, so a scoring change can be shown to help or
hurt instead of argued about. Since MEAL-28 it also measures the ordering the
choose-product flow shows the user — see [Choose-product ranking](#choose-product-ranking-meal-28).

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
| heb | 6 | 182 | 45 | no |
| walmart | 3 | 85 | 32 | no |
| albertsons | 3 | 74 | 26 | no |
| amazon-fresh | 3 | 61 | 17 | no |
| aldi | 2 | 38 | 13 | no |
| wegmans | 3 | 29 | 4 | no |
| **total** | **20** | **469** | **137** | — |

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

## Baseline (recorded 2026-08-08, `_scoring.ts` unchanged)

```
store           queries  pairs   P@1          accept-match   abstain-ok   pair-P   pair-R
heb                6     182  100.0% 5/5      0.0% 0/6      n/a         26.2%   84.4%
walmart            3      85   66.7% 2/3     33.3% 1/3      n/a         49.2%   96.9%
albertsons         3      74   50.0% 1/2      0.0% 0/2      1/1         52.1%   96.2%
aldi *             2      38  100.0% 2/2      0.0% 0/2      n/a         80.0%   92.3%
amazon-fresh       3      61  100.0% 2/2      0.0% 0/2      1/1         56.7%  100.0%
wegmans            3      29  100.0% 2/2    100.0% 2/2      1/1         36.4%  100.0%
ALL               20     469   87.5% 14/16   17.6% 3/17     3/3         40.7%   92.7%
```

Re-recorded for MEAL-121, which did not touch `_scoring.ts`: ALDI's auto-add
threshold in `score.ts` was 30, describing a fuzzy gate ALDI no longer has, and is
now 100 like everything else. Only ALDI's accept-match moved — `100.0% 2/2` →
`0.0% 0/2`, and with it `ALL` from `29.4% 5/17` to `17.6% 3/17`. Both of ALDI's
queries are generic ingredients ("sour cream", "tortillas") that no product is
named exactly, so ALDI now sends them to review, which is what the store actually
does. Every other cell is unchanged, including all of P@1, pair-P and pair-R: the
threshold is not an input to those.

### Three things the headline numbers do not say

**`abstain-ok 3/3` passes for the wrong reason.** Two of the three unanswerable
queries score **99** at the top — amazon-fresh "seasonal" leads with Flonase
nasal spray, wegmans "seasonal" with a Kentucky Bourbon Seasonal Ale. They
abstain only because the auto-add gate is exact-name equality, not because the
scorer recognised there was nothing to buy. Relax that gate to `>= 90` — the exact
change argued for below — and abstain-ok drops to 1/3. **A gate change and a
ranking change therefore have to land together**, and the harness will say so.

This is also the argument MEAL-121 acted on from the other end. ALDI's gate *was*
relaxed, to 30 out of 100, without a ranking change — and its two queries do not
appear in abstain-ok, because both have an acceptable product, so the harness
scored them as hits and said nothing about the brand it was choosing on the user's
behalf. What the number could not see, the store did.

**precision@1 excludes total misses from its denominator.** heb's "HEB season
chicken thighs for fajitas" is answerable (2 of 19 products are acceptable) but
scores 0 on everything, so it leaves the denominator entirely: 16, not 17. Read
the other way — counting a query with an acceptable answer that we ranked
nowhere as a miss — the headline 87.5% is **82.4%**.

**No store has a ranking step at all.** heb, walmart, wegmans and amazon-fresh
take the *first* card scoring exactly 100; albertsons requires `>= 100` from its
own local scorer; aldi takes the first card whose normalized name equals the term.
aldi's max-score loop was the last one, and MEAL-121 removed it. So P@1 here
measures a ranker that no shipped store code contains — it describes what
`_scoring.ts` *would* do if a store ranked, which is the thing to fix, but it is
not a measurement of today's behaviour.

What the baseline says:

1. **Ranking is mostly right, but ties are decided by the store.** Two of the
   sixteen scored queries put an unacceptable product first, and both are ties
   at 99 broken by result order: Walmart's "sour cream" leads with *Daisy Sour
   Cream Creamy Ranch Dip*, Albertsons' with *Herr's Sour Cream & Onion Chips*.
   `scoreMatch` cannot separate a dip from the dairy it is named after, because
   every word of the query appears in both.

2. **The auto-add gate is exact-name equality, so ranking barely reaches the
   cart.** Only 3 of 17 answerable queries end with an acceptable product added,
   and all three are queries that were already a full product name (the
   search-and-add flow re-finding a product the user picked earlier): walmart's
   butterball turkey breast and wegmans' two. For an ingredient like "sour cream"
   no product is ever named exactly that, so the score tops out at 99 and every
   store sends the item to manual review. Improving the ranking will not change
   the cart at all until that gate changes.

   It was 5 of 17 before MEAL-121, and the two extra were ALDI's — an
   ingredient-shaped query being answered with a brand at 30 points out of 100.
   That is not a capability the number should have been crediting.

3. **Pair precision is low (41%) against high recall (93%).** The 70%
   word-overlap floor lets nearly everything related through — for "sour cream"
   that includes the chips, the dips and the crema — and then leans on the exact
   match to sort it out. That is the shape of a matcher tuned for recall.

4. **`_scoring.ts` still does not describe the scorer ALDI carries — but that
   scorer no longer decides anything.** The header comment says the store copies
   must stay byte-identical; `instacart.ts` has its own `scoreOne` — a 0.3 overlap
   floor, −5 per extra candidate word, and a ±15 critical-word penalty instead of
   a hard veto, plus a `COMMON` stopword set with no counterpart in `_scoring.ts`.

   As of MEAL-121 nothing calls it. ALDI's add gate is `isExactMatch`, an equality
   test over the same two normalizations, which accepts exactly the strings
   `scoreMatch(...) === 100` accepts — so the accept-match and abstain columns are
   live-accurate. The asterisk now marks the *ranking* columns only: P@1 and the
   pair numbers are `_scoring.ts` measured on ALDI's pages, and ALDI ranks nothing.

   Over all 469 pairs the two disagree on 427 (lower on 377, higher on 50):
   ALDI's copy is *stricter* on long product names, because the per-word penalty
   dominates, but *more permissive* at the match-at-all gate. On ALDI's own 38
   pairs `_scoring` accepts 15 and ALDI's copy accepts 18. On both ALDI queries the
   top pick is the same product either way. That was a consistency defect rather
   than a live outage even while the scorer was wired up, and it is now dead-code
   trivia: none of those 427 disagreements can reach a cart.

   **Its parameter order is a signature difference, not a bug — and it is the trap
   waiting for whoever reconciles them.** ALDI's `scoreOne(nf, nt)` reads its
   *second* parameter as the query, so the call site it had until MEAL-121,
   `scoreMatch(name, SEARCH_TERM)`, produced the same orientation as `_scoring`'s
   `scoreMatch(query, candidate)`. Dropping in the shared `scoreOne` without
   writing any future call site as `scoreMatch(SEARCH_TERM, name)` would silently
   invert the comparison, and it would still return plausible numbers.

   Deleting ALDI's copy outright breaks nothing here — the harness imports
   `_scoring.ts` and never runs it. What it does touch is
   `tests/unit/webview-scripts/__snapshots__/aldiGeneratedScripts.test.ts.snap`, which pins the
   emitted script text, and these paragraphs.

   The other five stores' `scoreOne`/`scoreMatch` copies are byte-identical to
   each other and agree with `_scoring.ts` on all 469 pairs. Note that this is a
   claim about that pair of functions only: `albertsons.ts` additionally carries
   two *other* local scorers (`normalizeForScoring` / `scoreProductName`, 0.7
   floor, −10 per extra word) used for cart-bubble and add-to-cart matching.

## What the corpus can and cannot see

Checked by mutating `_scoring.ts` and re-running. The floor and veto rows were
re-measured on 2026-08-08 (MEAL-121); the extra-word row was not, so read its
figures as of when they were taken.

| Change to `_scoring.ts` | Harness reaction |
| --- | --- |
| Extra-word penalty (`−5` per candidate word absent from the query) | **Detected.** Overall P@1 87.5% → 93.8%; walmart 66.7% → 100%, albertsons 50% → 100%, heb 100% → 80%. |
| Word-overlap floor 0.7 → **anything up to and including 1.0** | **Invisible.** Every metric identical. |
| `CRITICAL_WORDS` veto removed entirely | **Invisible.** Every metric identical. |

The last two are a real blind spot, not a bug in the harness, and it is wider
than "0.9 happens not to bind". The overlap distribution is **strictly bimodal**:
312 pairs sit at exactly `p = 1.0`, 157 sit below 0.7, and **nothing at all sits
in between** — 312 + 157 is the whole corpus. So *every* floor in `(0.7, 1.0]` is
unobservable here, under either normalization: this corpus cannot tell today's
fuzzy matcher apart from one that demands every query word. Loosening the floor IS
caught (0.7 → 0.5 moves overall pair-P 40.7% → 36.6%, pair-R 92.7% → 96.4%);
tightening it is not, at any value.

The veto is structurally unreachable rather than merely untested: it fires on 9
of 469 pairs, all of which already score 0 on overlap, and the only two queries
containing a critical word are exact matches where `na === nb` returns 100 before
the veto is consulted.
Ranking changes are caught; threshold and veto changes are not. Closing that
needs queries carrying the attributes the veto exists for — "organic milk",
"boneless skinless chicken thighs", "unsalted butter", "large eggs" — which is
another argument for the extra capture sessions above.

## Choose-product ranking (MEAL-28)

The metrics above describe `_scoring.ts`. The **choose-flow** columns describe
what a user actually sees, and they are the only place a scoring change is
visible at all — the add gate is exact-name equality, so `scoreMatch`
improvements below 100 cannot change a cart.

Before MEAL-28 the choose flow passed the store's candidate list straight to the
UI in the store's own order (`WebViewCartSheet.tsx`, the `else` branch of
`isChooseFlow`). Our scorer was never consulted, so the first row — and with it
the default selection — was whatever the store ranked first, paid placement
included.

```
store            store order      ranked
----------------------------------------
heb              83.3% 5/6      83.3% 5/6
walmart          33.3% 1/3     100.0% 3/3
albertsons        0.0% 0/2     100.0% 2/2
aldi             50.0% 1/2     100.0% 2/2
amazon-fresh    100.0% 2/2     100.0% 2/2
wegmans          50.0% 1/2     100.0% 2/2
----------------------------------------
ALL              58.8% 10/17    94.1% 16/17
```

**Read the denominator carefully.** It is every *answerable* query, not just the
ones the matcher scored, because the choose list always has a first row: a query
we rank nowhere is a miss, not an abstention. That makes these numbers stricter
than, and not comparable to, `precision@1` above.

Most of the movement — 10/17 → 15/17 — is from ranking by the **existing**
`scoreMatch` at all. `_scoring.ts` is unchanged by MEAL-28, and every column in
the first table is byte-identical to the pre-MEAL-28 baseline. That is the point:
the win was never a better scorer, it was consulting the scorer we already had.

The remaining step, 15/17 → 16/17, is the unrequested-word tiebreak in
`src/lib/chooseRanking.ts`. `scoreOne` computes `|query ∩ candidate| / |query|` —
how much of the *query* the product covers — and never looks the other way, so
every word of the product name the query did not ask for is free. That is why
"sour cream" ties at 99 across the dairy, the ranch dip and the onion chips. The
tiebreak supplies the missing direction.

### What was tried and rejected

Measured the same way, on the same 17 queries. Recorded so the next person does
not pay for them again.

| Candidate from the ticket | Verdict |
| --- | --- |
| Rank the choose flow by `scoreMatch` | **Kept.** 10/17 → 15/17. |
| Unrequested-word tiebreak | **Kept.** 15/17 → 16/17. Insensitive to the weight: −1, −2 and −5 give an identical ranking over the whole corpus. |
| Unrequested-word penalty applied across *all* candidates, not just recognised ones | **Rejected.** 15/17. Reordering the score-0 tier demotes the right answer on heb's "chicken thighs for fajitas", where every product scores 0 and the store's own order is correct. Hence the two-tier sort. |
| Category / prepared-food penalty (`dip`, `chips`, `spread`, `sauce`, …) | **Rejected.** 15/17 — no movement, and it is whack-a-mole: penalising *dip* and *chips* promoted "Sour Cream & Onion **Kettle**" and "**Crema** Salvadorena" instead. The tail of sour-cream-flavoured things is unbounded, so each word added promotes the next word not on the list. |
| `CRITICAL_WORDS` veto applied in reverse (penalise a critical word in the *candidate* the query did not ask for) | **Rejected, and it actively hurts.** 13/17 alone, 15/17 combined with the tiebreak. The set contains words that are *good* in a candidate: "whole" (whole-milk yogurt is the acceptable one), "large"/"jumbo" (large Hass avocado is acceptable). |
| Unit / quantity awareness ("2 lbs chicken thighs" prefers a ~2 lb pack) | **Not built — unmeasurable here.** No query in the corpus carries a quantity. Building it would be exactly the unfalsifiable tinkering the ticket forbids. Note the data *is* available in the component (`SearchResult.unit` / `.measure`); what is missing is corpus queries to validate against, which needs capture sessions, not code. |
| Pack-count parsing ("12 ct", "6-pack") | **Not built — unmeasurable here.** Same reason: no corpus query names a pack count. |
| Deprioritise sponsored placements | **Not buildable.** No candidate carries a sponsored flag. The extractors *discard* the signal: `walmart.ts` skips `sba-container`, `heb.ts` keeps only `data-qe-id="productCard"` tiles (which excludes the sponsored rail), and `amazon-fresh.ts` strips the `"Sponsored Ad - "` prefix off the name in 15 places. The corpus is product names only, so even if the flag were plumbed through, nothing here could score it. |
| Share weight normalisation with `weightDisplay.ts` | **Nothing to share.** `weightDisplay.ts` does not parse product names. It converts an ingredient's `purchaseWeight` / `weightStep` into a "0.75 lb" label for the stepper UI. It and `_scoring.ts` have no overlapping concern, so there is no disagreement to unify. |

### The one remaining miss

heb's "yogurt" — 3 products in a trimmed fixture, all scoring 99, where the
acceptable one (`H-E-B 17g Protein Whole Milk Greek Yogurt - Plain`) has the
*longest* name and the unacceptable one (`Fage Total 0% Nonfat Plain Greek
Yogurt`) the shortest. No length-based measure can fix it; it needs the rubric's
rule 5 (an unrequested attribute that changes how the food eats), which means
knowing "nonfat" and "low-fat" are disqualifying while "whole" and "organic" are
not. The reverse-`CRITICAL_WORDS` attempt above was that idea, and it lost. It
also exposed a **tokenisation defect worth fixing on its own**: `CRITICAL_WORDS`
contains `lowfat` as one token, but "Low-Fat" normalizes to `low` + `fat`, so the
existing veto never fires on any product written that way.

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
