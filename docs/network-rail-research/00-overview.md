# Network rails for Wegmans, Walmart, Amazon Fresh and ALDI

Research done 2026-09-02/03 against **live signed-in sessions on Stephen's
Pixel**, reached through the app's own WebView over adb (see
`tools/rail-recon/README.md`). Everything marked MEASURED was executed and its
answer recorded. Everything marked INFERRED was read out of the store's own
JavaScript or its behaviour and has **not** been executed. The difference
matters: this whole project's worst bugs came from treating one store's rule as
everyone's, and treating an inference as a measurement is the same mistake.

## Where this stands (2026-09-03)

**ALDI and Wegmans are BUILT** — `src/lib/webview-scripts/aldi-network.ts` and
`wegmans-network.ts`, registered in `network-rail.ts`, 31 fixture tests running
the real scripts. Search and cart read are on; **both adds are off**, each for a
named reason, each one measurement away. Walmart is researched and not built.
Amazon Fresh should not be.

| | Login | Search | Cart read | Add | State |
|---|---|---|---|---|---|
| **ALDI** | `ActiveCarts` 176ms | `AsyncItemSearch` 556ms | `CartItems` 306ms | bulk, one call | **built**, add off |
| **Wegmans** | localStorage, **0 network** | Algolia, **no session**, 13ms | bearer | endpoint unseen | **built**, add off |
| **Walmart** | cookie | hash-locked | `getCart` | likely bulk | researched only |
| **Amazon Fresh** | cookie | none exists | HTML fragment | no | do not build |

### The two things that would finish them

1. **ALDI: which shop?** Every operation takes the shop the user is shopping
   (8583 here), which is NOT the retailer id `ActiveCarts` returns (12). The
   rail refuses to search without it rather than search the wrong catalogue, so
   ALDI's search is inert until this is found. The session probe reports where
   it looked (`shopTries`); one device run reads the answer off it.
2. **Both: is quantity absolute?** H-E-B and Albertsons both SET a line rather
   than adding to it. Neither of these two has been measured, so both scripts
   write only where the readings agree (the cart holds none of the item) and
   decline where they do not. Add one item by hand, write the same id with
   quantity 2, see whether the cart holds 2 or 3.

`npx tsx tools/rail-recon/verify-rail.ts aldi` runs the shipped scripts against
the real store and answers the first one.

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
