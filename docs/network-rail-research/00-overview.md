# Network rails for Wegmans, Walmart, Amazon Fresh and ALDI

Research done 2026-09-02/03 against **live signed-in sessions on Stephen's
Pixel**, reached through the app's own WebView over adb (see
`tools/rail-recon/README.md`). Everything marked MEASURED was executed and its
answer recorded. Everything marked INFERRED was read out of the store's own
JavaScript or its behaviour and has **not** been executed. The difference
matters: this whole project's worst bugs came from treating one store's rule as
everyone's, and treating an inference as a measurement is the same mistake.

## The one-paragraph answer

**ALDI is fully mapped and ready to implement** — every operation measured
against a live session, and its add takes an array, so bulk add is one call.
**Wegmans is the fastest** — its search needs no session at all and answers in
26ms, and its login state is readable from localStorage with zero network — but
its cart write is still unmeasured. **Walmart works and is the most defended**;
probing it has a cost. **Amazon Fresh has no JSON API worth the name** and is
the one store here where a rail may not be the right answer.

Build order: **ALDI first** (it is done bar the writing), **Wegmans second**
(one probe away), Walmart third, Amazon not at all.

| | Login detection | Search | Cart read | Bulk add | Verdict |
|---|---|---|---|---|---|
| **Wegmans** | localStorage, **0 network** | Algolia, **no auth**, 26ms | REST + bearer | likely | **build first** |
| **ALDI** | `ActiveCarts`, 176ms | `AsyncItemSearch`, 556ms | `CartItems`, 306ms | **YES — one call** | **fully mapped** |
| **Walmart** | cookie | GraphQL, hash-locked | GraphQL | likely | build third, carefully |
| **Amazon Fresh** | cookie | none found | AJAX fragment | unlikely | **do not build yet** |

## What every rail here must do, whatever the store

These are the lessons H-E-B and Albertsons cost us. They are not suggestions.

1. **Ask the server, never the DOM.** A DOM login check infers from markup that
   exists in both states. Getting it wrong costs a signed-in user their entire
   run. Every store below has a server answer; use it.
2. **"Could not tell" is not "signed out."** Three separate outages traced to
   an inconclusive check being reported as a negative. Return a third state.
3. **Run on the quiet page.** `robots.txt` has no JavaScript of its own, so our
   requests get the renderer to themselves. Measured on the storefront by
   comparison: a 1-second heartbeat firing 12 seconds late, and a search taking
   15.9s that the store answered in 576ms. **Walmart is the exception — see its
   own file.**
4. **A store may answer the session probe more than once.** Albertsons answers
   twice and only the second reply carries its API keys; acting on the first
   wrote `0 of 29` items with twenty-nine `401`s. Put "is this answer ready to
   work on?" on the rail (`sessionUsable`), not in shared code.
5. **The store decides what a writable candidate is.** H-E-B needs a sku,
   Albertsons needs only a product id. Requiring both silently broke Albertsons
   entirely. Put it on the rail (`writable`).
6. **Budgets are store facts.** Albertsons' first search in a fresh document has
   measured 40–70s while later ones take 0.3s. A shared 15s ceiling turns a slow
   answer into no answer.
7. **One batch, never a burst.** Two identical search batches at once is the
   shape that makes a store stop answering. Serialise, and never let a second
   trigger fire while one is outstanding.
8. **Write once, verify against the cart.** Never trust the write's own report;
   read the cart back and let it decide. Quantity is absolute at both stores
   built so far — `held + wanted`, never `wanted`.

## Files

- `01-wegmans.md` — the strongest candidate, and nearly complete
- `02-aldi.md` — Instacart Storefront; also covers any future Instacart tenant
- `03-walmart.md` — works, but the most defended
- `04-amazon-fresh.md` — why this one is different
- `05-open-questions.md` — exactly what is still unknown, and the probe to run

## What was deliberately NOT done

**No cart was written to.** Discovering the write endpoint is one thing; putting
groceries in a sleeping man's basket is another, and the cart rules here have
always been that Mealio never adds what the user did not ask for. Every
add-to-cart section below is therefore INFERRED, with the exact probe to confirm
it written out ready to run. Those probes take about a minute each with the
account owner awake and watching.
