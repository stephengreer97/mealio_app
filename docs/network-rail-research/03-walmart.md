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

## Login detection — INFERRED

`accountLandingPage` and `GetUserResidency` both answered signed-in. Either is a
candidate. Cheaper and better: Walmart's own bootstrap
`GET /orchestra/api/ccm/v3/bootstrap` is a plain REST call — check whether its
body names the customer. **It answered 429 when tried, so this is untested.**

## Search — INFERRED

Not captured: the search navigation was what got blocked on the desktop, and by
the time the phone was driving, the waiting room had started. Walmart's search
operation is well known to be in the `search` domain
(`/orchestra/search/graphql/Search/<hash>`), and the app's existing
`walmart.ts` already has a working search URL for the assisted path.

## Cart write — INFERRED

`cartxo` holds `MergeAndGetCart` and `clearCartWarnings`, so the add is in the
same domain. Expect `addToCartV2` or `AddToCart`, POST,
`{"variables":{"input":{"cartId":…,"items":[…]}}}`.

**Bulk add — leaning yes.** `MergeAndGetCart` already takes an input object with
a strategy, and Walmart's "add all to cart" from a list is a single call in
their own UI. The `items` array is the thing to confirm.

## Getting the hashes

The hashes are not in the main bundles: a scan of 59 scripts and 4.9MB from the
loaded cart page found **zero** 64-hex strings paired with an operation name.
They are somewhere else — a lazily loaded chunk, a query manifest, or injected
by the server. See `05-open-questions.md`.

The pragmatic fallback: the hashes observed above are real and can be pinned in
the rail as constants with an expiry behaviour — on a 404/400 from a pinned
hash, hand over to the assisted path rather than guessing. That is worse than
harvesting but it ships.
