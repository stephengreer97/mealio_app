# Wegmans

**Build this one first.** Its search needs no session and answers in 26ms, and
its login state is readable with no network at all. Neither of those is true of
any store we already support.

## Platform

Next.js front end on `www.wegmans.com`. Identity is **Azure AD B2C** through
MSAL. Commerce is a separate REST API on `api.digitaldevelopment.wegmans.cloud`
(the host is named "development" and is what production calls — do not read
anything into it). Fulfilment is **Instacart Connect**, which the access token's
own scope list gives away.

---

## 1. Login detection — MEASURED

**Read localStorage. No network at all.**

MSAL keeps its state under `msal.*` keys on the `www.wegmans.com` origin:

```
msal.1.account.keys                  JSON array — one entry per signed-in account
msal.1.token.keys.<clientId>         JSON: { idToken:[…], accessToken:[…], refreshToken:[…] }
msal.<…>-accesstoken-<…>-<scopes>    the credential: { secret, expiresOn, target, credentialType, … }
```

The check is:

```js
const keys = JSON.parse(localStorage.getItem('msal.1.account.keys') || '[]');
const signedIn = Array.isArray(keys) && keys.length > 0;
```

MEASURED on the device: `count: 1`, an account key of the shape
`msal.<id>_1a_wegmanssignupsigninwithphoneverification.<id>myaccount.wegmans.com<id>`.
That entry is plaintext.

**This is the best login signal of any store we have.** It is instant, it cannot
be rate-limited, and it cannot be confused by markup.

### ⚠ BUT THE TOKEN ITSELF IS NOT READABLE — MEASURED, and it changes the design

An earlier draft of this file said the bearer could be lifted from localStorage.
**That is wrong**, and it is recorded here rather than quietly fixed because it
would have sent an implementation down a dead end.

MSAL is running with its **encrypted cache** enabled — there is a
`msal.cache.encryption` cookie, and the credential entries named by
`msal.<n>.token.keys.<clientId>` have the fields:

```
{ id, nonce, data, lastUpdatedAt }        ← not { secret, expiresOn, target }
```

`data` is ciphertext. So the account list tells us *someone is signed in*, and
nothing tells us *what their token is*.

### And the commerce API will not take the cookie — MEASURED

Three probes from `https://www.wegmans.com/robots.txt`:

| call | result |
|---|---|
| same-origin `/api/stores` (control) | **200**, 441ms |
| `api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/` | `TypeError: Failed to fetch` |
| the same, `mode: 'no-cors'` | **status 0, type `opaque`** |

The opaque response is the tell: the request LEAVES and is answered, and CORS
blocks us reading it. The API is bearer-authenticated and its CORS policy is
written for the site's own authenticated calls, not for ours.

**Conclusion: the cart cannot be read or written from the quiet page.**

---

## 2. Search — MEASURED, and it needs no session

**Algolia, with a public search-only key that ships in the page's own URLs.**

```
POST https://qgppr19v8v-dsn.algolia.net/1/indexes/products/query
  ?x-algolia-api-key=9a10b1401634e9a6e55161c3a60c200d
  &x-algolia-application-id=QGPPR19V8V
content-type: application/json

{"query":"sour cream","hitsPerPage":10}
```

MEASURED from a plain `curl`, no cookies, no bearer: **200, 26ms processing,
32,223 hits.** Index name confirmed by probing: `products` exists;
`prod_products`, `wegmans_products`, `catalog`, `items` all return
`Index … does not exist`.

That key is not a secret — Algolia search keys are public by design and this one
is in every request the site makes. It is still worth treating as a value that
can rotate: read it from the page if it is ever wrong, the way the Albertsons
rail re-harvests its APIM key.

### The record has everything the matcher needs

MEASURED fields on a hit:

| Field | Use |
|---|---|
| `productId` / `skuId` | both present, both `"626485"` — the cart identifier |
| `objectID` | `"50-626485"` — **`<storeNumber>-<productId>`** |
| `productName` | what the matcher scores against |
| `isAvailable`, `isSoldAtStore` | out-of-stock, before we ever write |
| `maxQuantity` | the per-item cap (`99` here) — H-E-B's cap problem, solved up front |
| `isSoldByWeight`, `onlineSellByUnit`, `onlineApproxUnitWeight` | the weight rules |
| `price_inStore`, `price_delivery` | per-channel price |
| `images[]` | the review screen's thumbnail |
| `storeNumber` | **results are per-store — this must be filtered** |
| `fulfilmentType[]` | `["instore","pickup","delivery"]` |
| `upc[]` | a second identifier if the cart ever wants one |

### The store filter is not optional — MEASURED

32k hits for "sour cream" is every store's catalogue at once. The filter is a
plain Algolia `filters` string:

```json
{"query":"sour cream","hitsPerPage":10,"filters":"storeNumber:140"}
```

MEASURED:

| filters | nbHits | first objectID | time |
|---|---|---|---|
| *(none)* | 32,223 | `50-626485` | 25ms |
| `storeNumber:140` | **282** | `140-608294` | **13ms** |
| `storeNumber:50` | 279 | `50-626485` | 12ms |

The user's store number comes from
`GET https://www.wegmans.com/api/stores/store-number/<n>`; `140` was observed on
this device, fulfilment `pickup` (from `/api/categories/v3/pickup/140`).

### ⚠ THE PRODUCT ID IS PER STORE, AND THIS CHANGES THE DATA MODEL

Look at the table again. The SAME product — "Daisy Sour Cream, Pure & Natural" —
is `626485` at store 50 and `608294` at store 140.

`storeProducts` currently folds banners that share a catalogue onto one key:
Kroger's family share `kroger`, the Albertsons family share `albertsons`, and
`storeProductKey()` is where that lives. **Wegmans must not be folded that way,
and worse, a saved Wegmans product is only valid at the store it was chosen at.**

A user who changes their Wegmans store has product ids that will resolve to the
wrong item or to nothing. Two options, and this is a decision for Stephen:

- **Key the saved product by store number** (`wegmans:140`), so changing store
  re-chooses. Safe, and costs the user a re-choose they did not ask for.
- **Store the UPC as well** (`upc[]` is on the record) and re-resolve by UPC
  against the new store's index. More work, and it keeps the choice.

The second is better and the record already carries what it needs. Either way,
**saving a bare `productId` for Wegmans the way we do for H-E-B would silently
add the wrong product after a store change** — which is precisely the over/under-add
the cart rules exist to prevent.

### Why this matters more than it looks

A search that needs no session means the Wegmans search prewarm can run **before
the login check finishes**, and even for a signed-out user. No other store can
do that. It also means search cannot be broken by an expired token.

---

## 3. Cart read and write — REACHABLE, but not from the quiet page

These endpoints exist and answered 200 while the SITE called them, observed on
the signed-in session:

```
GET  /commerce/cart/carts/                     the cart
GET  /commerce/account/customer                who the user is
GET  /commerce/account/addresses
GET  /commerce/order/orders/activeorders
GET  /commerce/saved-list/savedlists
GET  /commerce/my-items
GET  /commerce/browse/products/
POST /commerce/instacart/fulfillment/service_options/pickup
       {"cart_total_cents":0,"items_count":0,"location_code":140}
```

All on `https://api.digitaldevelopment.wegmans.cloud`, all with
`Authorization: Bearer …`. The write is not in that list because nothing was
added; by the shape of the rest it is
`POST /commerce/cart/carts/{cartId}/items`.

### Getting a token — three options, and only one is sane

1. **Capture it from the site.** Load a real Wegmans shop page once, with
   `window.fetch` patched to record the `Authorization` header the site's own
   MSAL puts on its first commerce call. Cache the token with its expiry; run
   everything else from the quiet page. **Cost: one heavy page load per token
   lifetime** (typically an hour). This is the only option worth building.
2. **Ask MSAL.** `acquireTokenSilent()` on the site's own instance — but the
   instance is not on `window`, so this needs the app's internals and breaks on
   any refactor of theirs.
3. **Decrypt the cache.** Reimplementing someone's crypto to lift their token is
   not a thing to do. Recorded so nobody proposes it as clever.

Option 1 has a real precedent here: it is what
`page-globals-are-someone-elses-fetch` says to do, one step further — find the
request that carries the value and capture it once, rather than polling for it.

### ⚠ Or do not build the cart at all — the SEARCH-ONLY rail

Worth considering seriously, because the numbers say so. Search is the slow part
of a run for anything not already chosen, and **Wegmans search needs no session
at all** (see above: 13ms, no cookies, no token). A Wegmans rail could:

- **search over the rail** — fast, sessionless, cannot be broken by an expired
  token, works even for a signed-out user;
- **leave cart read and add on the assisted path**, where the user adds and
  Mealio claims nothing it has not seen.

That is a smaller feature that ships sooner and carries none of the token risk.
Whether the full rail is worth the heavy page load is a call for Stephen, and it
is the main decision this research surfaces for Wegmans.

## 4. Bulk add — INFERRED, unmeasurable until the token question is settled

The API is REST with an `/items` collection, which conventionally takes an
array, and Wegmans fulfils on Instacart Connect — whose cart mutation, MEASURED
on ALDI, is `UpdateCartItemsMutation($cartItemUpdates: [CartsCartItemUpdate!]!)`,
a list. So bulk is likely. **Measure the wall clock, not the request count**:
H-E-B's batched add is one request that the server runs serially, 34 items in
8.2 seconds.

## 5. Quiet page

`https://www.wegmans.com/robots.txt` — MEASURED, loads, and the origin's
localStorage and cookies are present on it. That is the whole requirement.

The Algolia search is cross-origin and needs no page at all, so a Wegmans rail
could in principle search from anywhere; keep it on the quiet page anyway so the
cart calls are same-origin and the cookie jar is right.

## 6. Budgets — to be measured, starting points

Nothing here has the Albertsons cold-start problem so far as we saw. Start at
H-E-B's numbers, which are the tighter set, and widen only on evidence:

```
sessionMs 8_000    (it is a localStorage read plus one optional request)
searchMs  (t) => min(10_000 + t * 1_000, 45_000)      Algolia answered in 26ms
addMs     (i) => min(30_000 + i * 3_000, 120_000)
cartProbeMs 12_000
searchRequestMs / searchFirstRequestMs 10_000
```
