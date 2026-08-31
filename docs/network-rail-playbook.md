# Building a network rail for a store

**What this is:** what H-E-B taught us, written down so the next store costs days
instead of weeks. MEAL-200 (add) and MEAL-202 (search) took roughly three days of
probing, building and three rounds of correction. Most of that was discovering
things that are now written here.

**What a network rail is:** the automation asks the store's own backend for search
results and issues its own add-to-cart requests, from inside the WebView we
already hold, instead of loading pages and clicking. H-E-B went from **22.5 s to
6.6 s** for a twelve-ingredient run, with **zero page loads** and **zero worker
WebViews** (about 187 MB of peak memory).

---

## 1. The speed is the smaller half

This is the thing to lead with when deciding whether a store is worth it.

The parameters a real backend accepts retire whole classes of bug rather than
fixing them. On H-E-B:

| Parameter | What stopped existing |
|---|---|
| `excludeSponsoredContent` | Sponsored and "pairings" tiles are never asked for, so they cannot be mistaken for results. The page reader had to *recognise and discard* them — a permanent source of extraction bugs. |
| `includeOutOfStock` | Stock stops being inferred from button text. |
| `pageSize` | The result count is stated, not "however many tiles rendered". |

And every candidate arrives with a product id, a sku, images, quantity limits and
purchase preferences — things a rendered card either hides or forces you to
scrape.

**So evaluate a store on what its backend can TELL you, not just on latency.**

---

## 2. Discovery, in the order that worked

### 2.1 The bundles are readable without the bot wall

A storefront's own JavaScript contains its query documents. H-E-B's static CDN
(`cx.static.heb.com`) served all 83 chunks to plain `curl` with **no bot
defence** — the wall is on the app origin, not the assets.

```bash
# script srcs are in any captured fixture
grep -o '<script[^>]*src="[^"]*"' tests/fixtures/<store>/*.html
curl -s <chunk-url> -o chunk.js
grep -a "query \|mutation " chunk.js
```

This is the cheapest discovery there is. Do it first, before any device work.

### 2.2 The server will describe its own input

Introspection is usually disabled. It does not matter.

- A **wrong-typed** variable gets you `found JSON number for type X` — useless.
- An **unknown field** makes the server print **the entire input type**.

```json
{ "params": { "query": "x", "mealioUnknownField": 1 } }
```

That one request produced all nineteen `SearchPageParamsV2` fields and, crucially,
that only three were required. Days of guessing collapsed into one call.

### 2.3 Watch the real client, but expect it to tell you nothing

We hooked `fetch` and `XMLHttpRequest` before page scripts ran and watched six
search page loads plus filter and sort interactions: **zero search requests**.
H-E-B server-renders its search pages, so its own site never issues the call.

**Do not conclude the endpoint is unusable.** It was fine; the client just never
used it on the paths we could watch.

### 2.4 When one operation is blocked, look for its sibling

`productSearchItems` requires a `searchPageLayout` enum whose values resisted 35
guesses. `productSearchPageV2` takes **the same argument nullable**, and its
layout is where the products actually live. Same data, one omitted argument.

**Before brute-forcing a required value, check whether a neighbouring operation
makes it optional.**

---

## 3. Design decisions worth copying

### 3.1 Funnel into the existing completion

The network run ends by calling `finishParallelAdd` — the same function the
worker pool calls. So the reconcile, the review routing, the done screen and the
telemetry are untouched and **cannot disagree with a pooled run**.

An item the network could not match becomes the same unsuccessful `AddResult` a
pool worker produces, and reaches review by the ordinary road. No second
vocabulary, no parallel UI.

**This is the single highest-leverage decision in the whole rail.** Build the new
path to end where the old one ends.

### 3.2 The candidate shape must be indistinguishable

Network candidates carry exactly the fields page-read candidates carry, name for
name. `source: 'network'` rides along **only** so the two can be compared in
telemetry before the page path is retired.

Two copies of the candidate-building logic is how a candidate ends up meaning
something subtly different depending on which path produced it — and the add path
matches names EXACTLY, so "subtly different" is "matches nothing".

### 3.3 Every failure means the same thing: use the other path

The rail returns verdicts, never throws. An add that *cannot be issued* must look
identical to one that was *refused*, because the caller's answer to both is the
same. That property is what makes the fallback trustworthy.

### 3.4 Fall back per item, not per run

Our first version dropped the whole run back to the page path when **one** term
went unanswered — discarding eleven good answers and re-running everything
slowly. The batch script's own comment said failures were per-term; the
orchestrator contradicted it one layer up.

### 3.5 Once you have written, you may not fall back

Every phase before the first write can hand over safely. **After a write, never.**
The page path re-adds the whole list by clicking, and its loop baselines off a
card label that by then reflects your own writes — the user gets roughly double.

A deadline in the write phase must **finalize with what came back**, not start a
second pass. Items with no result are `write_unresolved` — *unknown*, not failed,
because a write may have landed unseen.

### 3.6 Nothing may be pinned to one store or account

Store id and fulfillment context are read from the session on **every run**.

**And beware two identifiers for the same shop.** H-E-B's
`me.preferredStore.storeNumber` is **243**; the id search wants,
`cart.fulfillment.store.id`, is **476**. Sending the wrong one searches a
different store's catalogue and returns results that look entirely reasonable.
There is no error to notice.

### 3.7 The session read is also the login gate

One request answers "is anyone signed in" and "which store" together. A
signed-out session simply has no user. This replaces a page load and a DOM check.

---

## 4. The quantity question, which is where carts go wrong

**Ask this before writing any code: does the add endpoint SET the line's quantity
or INCREMENT it?**

H-E-B **sets**. That one fact makes five ordinary things unsafe:

| Situation | What goes wrong | Fix |
|---|---|---|
| Cart already holds the item | Sending `qty` sets the line DOWN to `qty` and reports success | Send `held + qty` |
| Baseline read from the UI label | The label reads 0 while unhydrated, so the line is set to `qty` | Read the baseline from the **cart**, never the page |
| Two ingredients → one product | `set(base+q1)` then `set(base+q2)` lands `base + max`, not both | Coalesce writes by product before sending |
| Product already has a line under a different variant | Lines are keyed by preference; the sum is not *your* line | Decline when a preference write meets an existing line |
| Store's per-item cap | `held + qty` over the cap makes the store refuse the WHOLE write | Respect `maximumOrderQuantity`; clamp only where it still adds something |

That last one has a trap inside it: **clamping to a number the cart already holds
writes no change and reports success** — an under-add dressed as a win. A cap
already met has to be its own failure.

---

## 5. What only a real device will tell you

Every one of these passed its unit tests first.

- **An empty result set is an answer, not a failure.** A well-formed page with no
  product grid means the store has nothing. We called it a transport failure and
  loaded a page to be told the same thing 1.8 s later.
- **An out-of-stock exact match is definitive.** Reporting it as "no good match"
  sent it to the retry queue, which abandoned a 280 ms rail to load a page. The
  store has it and will not sell it today; asking again finds that out again.
- **The store's error messages are worth showing.** "You must supply a weight to
  purchase this item." and "Quantity limit reached." are both actionable, and both
  came back from a request we would otherwise have logged as a generic failure.
- **A run script injected too early goes nowhere.** Same-origin requests need the
  WebView actually on the store. Re-inject on the next page load.

---

## 6. Guards that will not save you unless you feed them

The telemetry taxonomy test finds failure reasons by scanning for a **lowercase
word-boundary `reason`**. Our new file passed its reasons positionally, so
**fifteen were invisible and seven had no code at all** — the primary rail's
entire failure vocabulary, riding the unmapped default. That is precisely the
failure the guard exists to catch.

The first fix did not work either: an uppercase constant is still invisible, and
the test kept passing. **Write reasons where the scanner can see them, then check
that it now complains.** A guard that goes quiet is not the same as a guard that
passes.

---

## 7. Order of work for the next store

1. **Pull the bundles with curl.** Are there query documents? Persisted-query
   hashes only, or full text?
2. **One probe from inside the WebView**: read the session (login + store), then
   one search. If both answer, the rail is buildable.
3. **Measure the quantity semantics** — set or increment — against a cart that
   already holds the item. Before any code.
4. Build the **search** adapter first: it is a read, so a wrong answer falls back
   and nothing happens to a cart.
5. Build the **add** behind its own switch, count-priced items only until an undo
   is proven.
6. **Device-run it**, then have it cold-reviewed. On H-E-B the device proved it
   was fast and the review proved it was safe — two over-adds and an under-add
   that all passed the tests.

### Do not ship without an undo

On H-E-B a count line can be set back to zero; a **weight line cannot be undone
at all** — `quantity: 0` errors and `weight: 0` is accepted without removing.
Weight and preference items therefore still click. An over-add you cannot walk
back is not something to ship.

---

## 8. Where the remaining stores stand

Measured from the committed captures and the store catalogue (29 banners).

| Platform | Banners | Backend | Status |
|---|---|---|---|
| Kroger family | ~13 | Public partner API | Already API-driven; no WebView rail needed |
| **Albertsons family** | **~13** | REST (`/items`) | **An authenticated add was accepted, `200`** (MEAL-137). Search path unexplored. |
| Walmart | 1 | GraphQL, `/orchestra/*/graphql` | Endpoint map is in the page — `cartxo`, `pdp`, `search`. Unexplored. |
| Amazon Fresh | 1 | No GraphQL in captures | Unknown |
| Wegmans | 1 | No GraphQL in captures | Unknown |
| ALDI (Instacart) | 1 | GraphQL, **persisted queries** | Highest risk: `/graphql?operationName=…&extensions={"persistedQuery":…}`. Hashes change per deploy. |

**Recommendation: the Albertsons family next.** It is the largest group still on
WebView automation, one rail serves about thirteen banners, and it is the only
one where a write has already been accepted. Its open question — MEAL-194, what
`qty` means on a repeat add — is exactly section 4 of this document, which is now
a checklist rather than an investigation.

**Walmart second**, on the strength of its GraphQL surface and its size, but as a
single banner it buys less per unit of risk.

**Instacart last.** Persisted queries mean we may not be able to send our own
documents at all, which was the first thing MEAL-12 ruled out for H-E-B and the
thing the entire rail rests on.
