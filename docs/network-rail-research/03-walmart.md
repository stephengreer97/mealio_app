# Walmart

Works, and is the most defended of the four. Build it third, and plan the
requests before making them.

## Transport — MEASURED

```
GET|POST https://www.walmart.com/orchestra/<domain>/graphql/<OperationName>/<sha256>
```

The operation name AND its hash are in the URL PATH — this is not Apollo's
`extensions.persistedQuery`, it is Walmart's own scheme. `<domain>` groups
operations: `cartxo` for the cart, `home` for everything else.

Cookie-authenticated. **No Authorization header.**

### Required headers — MEASURED

```
x-apollo-operation-name: getCart
x-o-gql-query:           query getCart          ← the NAME only, never the text
tenant-id:               elh9ie
x-o-mart:                B2C
x-o-bu:                  WALMART-US
x-o-segment:             oaoh
wm-client-traceid:       <uuid>
x-o-platform:            <observed on bootstrap>
```

`x-o-gql-query` looked like the escape hatch — send your own query text and
skip the hash. It is not: MEASURED, it carries only `query getCart`.
**The hash is mandatory.**

### Operations observed, signed in — MEASURED

| Domain | Operation | What it is |
|---|---|---|
| `cartxo` | `MergeAndGetCart` | the cart, with `cartId` — POST, `{"variables":{"input":{…}}}` |
| `cartxo` | `getCart` | the cart |
| `cartxo` | `clearCartWarnings` | a mutation, and proof mutations use the same scheme |
| `home` | `getSlots`, `getAmendableOrder`, `PostCartLoadPage`, `getSFL`, `accountLandingPage`, `GetUserResidency`, `GlobalIntentCenter`, `getHeartedItems` | |

A real `MergeAndGetCart` body, MEASURED:

```json
{"variables":{"input":{"cartId":"<uuid>","strategy":"MERGE","enableLiquorBox":true,
 "enableCartSplitClarity":false,"features":["lmpdel","mlrx","vsrx","maappl",…]}}}
```

## The anti-bot problem — MEASURED, and it cost us

Two separate facts, and they point in opposite directions:

1. **A headless Chromium from this machine is blocked in two page loads.**
   `walmart.com/blocked?url=…` on both the search and the cart. PerimeterX
   (`px-cloud.net`, `perimeterx.net`) and a `/si/` sensor script are all over
   the page.
2. **The phone's WebView is served normally.** Every measurement above came from
   it. A real device with a real UA and a real cookie history is a different
   customer to them.

But: **after roughly forty automated requests, the session started answering
`429` with Walmart's virtual waiting room** ("Hang on- you're so close…"), from a
real page as well as from `robots.txt`. It was not the quiet page; it was the
volume. Probing stopped there deliberately rather than degrade the account
further.

### What that means for a rail

- **Budget the requests.** One session probe, one search batch, one write, one
  cart read. Do not poll Walmart. The login poll built for the sheet
  (1s while the page moves) is almost certainly too aggressive here and should
  be given a per-store rate — another thing that belongs on the rail.
- **Handle 429 as a first-class outcome**, not as a failure. The right response
  is to hand the user the store, not to retry.
- **The quiet page is UNPROVEN here.** For H-E-B and Albertsons `robots.txt`
  buys 12–18 seconds. For Walmart, a session with no page-sensor history may
  look *more* like a bot, not less. Measure it before assuming.

## Login detection — PARTLY MEASURED, 2026-09-03

`__NEXT_DATA__` on a signed-in page contains a `"customerId":"…"` — present and
non-empty when signed in. Zero network, same origin, no page of our own beyond
the search document a run fetches anyway.

Not yet measured: what a signed-OUT page carries in that field, which is the
half that actually decides. Check it before trusting it — the Albertsons
early-session bug came from exactly this shape of assumption.

## Search — MEASURED, 2026-09-03

**The results are in the page, as JSON.** `/search?q=<term>` is server-rendered
Next.js, and `#__NEXT_DATA__` carries:

```
props.pageProps.initialData.searchResult.itemStacks[].items[]
```

So a search is ONE GET of an HTML document and a `JSON.parse` of one script tag
— no rendering, no DOM walking, no selectors to drift. That is a different
proposition from the other three rails (which call an API directly) but it has
the same properties: one request, structured output.

`props.pageProps.persistedQueriesConfig` confirms `enablePersistedQueries: true`,
so a pure-GraphQL search exists too; the SSR route needs no hash and is the
cheaper thing to build first.

## Cart write — MEASURED, 2026-09-03

Captured by clicking Add on a real search page with a fetch/XHR recorder
installed before the page's own scripts.

```
POST /orchestra/home/graphql/updateItems/f7a7a5c72f31319f198a9097f111a1a5f121ed523e4400fcc215aa98152c5e4b
{"variables":{
  "getDetailedAccesspoint": false,
  "input": {
    "cartId": "3d56809c-…",
    "items": [{ "offerId": "8EFDEF50A94834269068E1D2F4DFF5EF",
                "quantity": 1, "usItemId": "", "name": "Fruit Riot Sour Candy Mango Mix, 8 oz" }],
    "enableLiquorBox": true, "skipPolicyCheck": false, "enableCartSplitClarity": false,
    "features": ["lmpdel","mlrx","vsrx","maappl","accfournudge","potp","byod","vptires",
                 "pdr","gepmss","dd","qsr","qsr_qty","qsro4w","cbs","tfd","moqvariant",
                 "wfss","dynevgn"]
  },
  …~20 further boolean feature flags
}}
```

**Three things the guess above got wrong, and they matter:**

| guessed | measured |
|---|---|
| domain `cartxo` | **`home`** |
| name `addToCartV2` / `AddToCart` | **`updateItems`** |
| item keyed by usItemId | **`offerId`** — `usItemId` is sent EMPTY |

**Bulk add — yes, confirmed.** `items` is a list.

**`cartId` needs no call.** It is in localStorage under `glassCartIdMap`
(~106 bytes, keyed by cart type). The same id appears in both `MergeAndGetCart`
and `updateItems`.

Unmeasured: whether `updateItems` SETS a line or ADDS to it. Both ALDI and
Wegmans surprised me on exactly this question — Wegmans turned out to do BOTH
depending on whether a line id is present — so measure it before shipping, with
an item already in the cart, and read the cart back.

## Getting the hashes

The hashes are not in the main bundles: a scan of 59 scripts and 4.9MB from the
loaded cart page found **zero** 64-hex strings paired with an operation name.
They are somewhere else — a lazily loaded chunk, a query manifest, or injected
by the server. See `05-open-questions.md`.

The pragmatic fallback: the hashes observed above are real and can be pinned in
the rail as constants with an expiry behaviour — on a 404/400 from a pinned
hash, hand over to the assisted path rather than guessing. That is worse than
harvesting but it ships.


## The identifier — MEASURED, 2026-09-03

Stephen: "if usItemId is the stable key, then why are we keying on offerId".

Because the write will not take anything else.

| | |
|---|---|
| `usItemId` | the PRODUCT. Stable. |
| `offerId` | a specific OFFER — seller and price. Can retire. |

`updateItems` was called with `usItemId` populated, a real `lineItemId`, and no
`offerId`; and again with `offerId: ""`. Both answered **`"offerId is invalid"`**
with the cart unchanged. Walmart's own site sends `usItemId` EMPTY on every add.

So offerId is not a preference, it is the only identifier this endpoint acts on.
Both ids are saved on a chosen product regardless: if an offer retires the write
fails, the cart disagrees, and the row reaches review — and the saved usItemId is
where a re-resolve (`/ip/<usItemId>` carries the current offer in its
`__NEXT_DATA__`) would start. Not built: no offer has been seen to retire yet,
and every page fetch on this store costs bot-defence budget.

## Recovering from a block — MEASURED

A challenged session does NOT recover by waiting or by more fetches: a `fetch`
never runs PerimeterX's JavaScript, which is what issues a fresh decision cookie.
Loading `https://www.walmart.com/` in the WebView once cleared it immediately
(title back to "Walmart | Save Money. Live better.", `__NEXT_DATA__` present).

Which is convenient: the assisted hand-over a blocked run already performs puts
the user on a real store page, so the act of degrading also repairs the session.
