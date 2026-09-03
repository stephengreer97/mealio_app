# ALDI — and every other Instacart Storefront tenant

ALDI runs on **Instacart Storefront**, which the app already knows
(`src/lib/webview-scripts/instacart.ts`, `INSTACART_TENANTS`). Everything here is
about the PLATFORM, so a rail built once serves any tenant that registry gains —
the same reasoning `railConfigKey` uses for the Albertsons family.

**This store is fully mapped and ready to implement.** Every operation below was
executed against Stephen's live session. No cart was written to: the two write
operations were probed for their SIGNATURE only, by sending no arguments, which
fails validation before the mutation runs.

## Transport — MEASURED

```
POST https://www.aldi.us/graphql
content-type: application/json
x-client-identifier: mobile_web
```

Cookie-authenticated on the `aldi.us` origin — the cookie jar the app's WebView
already holds. **No Authorization header, no API key.**

## The constraint that shapes everything — MEASURED

**Instacart accepts allow-listed persisted queries only.**

```
POST /graphql  {"operationName":"Ping","query":"query Ping { __typename }"}
→ 400  PersistedQueryNotSupported
```

Introspection: the same refusal. **The rail cannot invent a query.** It must
send an operation name plus the sha256 the store already knows.

### Where the hashes live — MEASURED, and this is the unlock

They are in the storefront's own JavaScript. A scan of 80 script files /
6.2&nbsp;MB from `https://www.aldi.us/store/aldi/storefront` found **1,552
operation→hash pairs**, in the plain shape `"OperationName":"<64 hex>"`.

`tools/rail-recon/probes/harvest-hashes.js` is that scan.

So the rail follows the Albertsons APIM-key pattern exactly:

1. Harvest the map from the storefront's scripts.
2. Cache it in localStorage with an age cap (Albertsons uses 12 hours,
   `__mealio_alb_keys_v1`).
3. On `PERSISTED_QUERY_NOT_FOUND`, forget the cache and harvest again — the same
   trigger as `__albForgetKeys()` when every cart key 401s.

Harvesting needs the storefront page loaded once, because its chunks carry the
map. That is one real page load per twelve hours of runs.

---

## The five operations a rail needs — ALL MEASURED

Hashes as of 2026-09-02. **Treat them as a cache, not as constants.**

### 1. Login / session

```json
{"operationName":"ActiveCarts","variables":{},
 "extensions":{"persistedQuery":{"version":1,
   "sha256Hash":"839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d"}}}
```
MEASURED **176ms**, and it needs no arguments at all:

```json
{"data":{"userCarts":{"carts":[{"id":"16636288909","itemCount":0,
  "retailer":{"id":"12","name":"ALDI","slug":"aldi"}}]}}}
```

A signed-in user has `userCarts` with a cart id. That is the session probe AND
the cart id in one call — nothing else this project has does both.

A second signal, free: the site sends `x-client-user-id` (a numeric id) on every
request while signed in. Worth checking as the `early` half of the answer, with
`ActiveCarts` as the `verified` half — the two-answer shape Albertsons taught us.

**Do not use the DOM.** `instacart.ts` currently decides login by looking for the
words "sign in"/"log in" in the header. That is the inference that has cost this
project three outages.

### 2. Search — MEASURED, 556ms

```
AsyncItemSearch  19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e
  ($query: String!, $shopId: ID!, $postalCode: String!, $searchSource: String!)
```
`searchSource: "search"`. Returns **ids only**:

```json
{"data":{"itemSearch":{"itemResultList":{"itemIds":[
  "items_23898-18647633","items_23898-21369371", …28 of them ]},
  "searchId":"8d5c79eb-…"}}}
```

`postalCode` is not validated — `"00000"` was accepted. The rail does not need
the user's real postcode.

### 3. Hydrate the ids — MEASURED signature, BULK

```
ItemDetailsRetailerProduct  5ac2d820f689a151c7dbaccefbbcb4b59d1c84db56a667a6b90d0137d5e72cca
  ($ids: [ID!]!, $zoneId: ID!)
```

**Takes an array**, so one call turns all 28 search ids into products. Search is
therefore two round trips total, not one per result.

`zoneId` is unknown — see `05-open-questions.md`.

### 4. Cart read — MEASURED, 306ms

```
CartItems  60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c
  ($id: ID!, $shopId: ID!, $postalCode: String!)
```
`id` is the cart id from `ActiveCarts`. Returns:

```json
{"data":{"userCart":{"id":"16636288909","cartItemCollection":{"cartItems":[]}},
         "cartTotals":{"cartLineItems":[]}}}
```
(empty because the cart was empty — the structure is what matters)

### 5. Add to cart — BULK, signature MEASURED, never executed

```
UpdateCartItemsMutation  a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7
  ($cartItemUpdates: [CartsCartItemUpdate!]!)

CartsCartItemUpdate { itemId: ID!, quantity: Float! }
```

Both field names came from the server's own validation error, with nothing
written:

```
Variable $cartItemUpdates of type [CartsCartItemUpdate!]! was provided invalid
value for 0.itemId (Expected value to not be null),
         0.quantity (Expected value to not be null)
```

**Bulk add is real and it is one call.** The argument is a list, and the
operation is named for the plural.

Two things to carry in from the stores already built:

- **`quantity` is a Float, and it is almost certainly ABSOLUTE**, like H-E-B and
  Albertsons. So it is `held + wanted`, never `wanted` — read the cart first.
  **Verify this before the first real write**; getting it backwards is the
  silent under-add MEAL-194 exists to prevent.
- The name is *Update*, not *Add*. An update that sets quantity is exactly the
  absolute-write shape, which supports the above.

`AddAllCta` turned out to be a UI-strings query ("Add all to cart ({item_count})"),
not a mutation. Worth recording so nobody chases it twice.

---

## Quiet page

`https://www.aldi.us/robots.txt` — untested, but note the tenant config sets
`cacheBustNav: false` because ALDI's anti-bot 403s on a synthetic `?_t=` query.
**Carry that into the rail: never cache-bust an ALDI navigation.**

The GraphQL calls above were all made from `/store/aldi/storefront`, a heavy
page, and still answered in 100–550ms — so ALDI does not show the storefront
starvation Albertsons does. Moving to `robots.txt` should only help; measure it.

## Budgets — starting points from what was measured

```
sessionMs 10_000   (ActiveCarts measured at 176ms)
searchMs  (t) => min(15_000 + t * 1_500, 60_000)     (556ms for one term)
addMs     (i) => min(20_000 + i * 1_000, 60_000)     (one call for all items)
cartProbeMs 15_000                                    (306ms measured)
searchRequestMs / searchFirstRequestMs 15_000
```

## The prize

`INSTACART_TENANTS` is a registry. This rail lights up every banner in it, and
Wegmans fulfils on the same platform (its access-token scopes name
`instacartconnect.fulfillment`), so the two may share more than expected.
