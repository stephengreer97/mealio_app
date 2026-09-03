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

**This is the best login signal of any store we have.** It is instant, it cannot
be rate-limited, and it cannot be confused by markup.

### The refinement, and the two-answer lesson

localStorage says *an account exists*. It does not say *the token still works*.
Take the Albertsons lesson (`sessionUsable`) and treat them as two facts:

- **`early`** — an account key exists → answer the LOGIN gate immediately.
- **`verified`** — an access token exists whose `expiresOn` is in the future →
  the run may start.

If the token is expired, MSAL will renew it silently on the site's next call,
but a rail sitting on `robots.txt` runs none of the site's code, so **an expired
token will not renew itself.** Treat expired as "hand the user the login screen"
until someone proves otherwise. That is the single biggest open risk here.

### Confirming over the network (optional, ~200-400ms)

```
GET https://api.digitaldevelopment.wegmans.cloud/commerce/account/customer
Authorization: Bearer <secret from the msal accesstoken entry>
```
MEASURED: 200.

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

## 3. Cart read — MEASURED

```
GET https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/
Authorization: Bearer <token>
```
MEASURED: 200. The trailing slash is as the site sends it.

Neighbouring endpoints observed on the same bearer, all 200:

```
/commerce/account/customer          who the user is
/commerce/account/addresses
/commerce/order/orders/activeorders
/commerce/saved-list/savedlists
/commerce/my-items
/commerce/digital-coupons/offers
/commerce/browse/products/
/commerce/instacart/fulfillment/service_options/pickup   POST
    body: {"cart_total_cents":0,"items_count":0,"location_code":140}
```

That last one is the Instacart Connect seam, and `location_code` is the store.

---

## 4. Cart write — INFERRED, not executed

Not captured, because capturing it means adding to a real basket. By the shape
of every other endpoint on this API it is:

```
POST   https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/{cartId}/items
PATCH  …/commerce/cart/carts/{cartId}/items/{itemId}
```

**The probe to run** (one minute, with Stephen awake, on a cheap item):

```js
// In the app's WebView on www.wegmans.com/robots.txt, with the bearer read
// from localStorage as above.
const cart = await (await fetch(BASE + '/commerce/cart/carts/', { headers: H })).json();
console.log(JSON.stringify(cart).slice(0, 1500));   // learn the cart + item shape
```

Read the cart FIRST with one item added by hand through the UI. The response
shape names the write: an item object's fields are what the write takes, and
whether it holds an array tells you whether bulk is one call or many.

### Is bulk add possible? — INFERRED, leaning yes

The API is REST with a `/items` collection, which conventionally accepts an
array. Instacart Connect's own fulfilment API takes line-item arrays. **Assume
one call, verify before relying on it**, and remember the H-E-B lesson: a batched
call can still execute serially on the server, so measure the wall clock rather
than the request count.

---

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
