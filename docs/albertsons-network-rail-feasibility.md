# MEAL-15 — Can we drive the Albertsons family from an in-page network rail?

**Date:** 2026-08-06 (corrected 2026-08-06 after cold review)
**Status:** **Not disproven.** Every measurement here is anonymous, and every one
of them is a *refusal*. Nothing in this document shows an authenticated call
succeeding. Two probes remain and both need a logged-in human.
**Timebox:** 1 day (spike — findings, not shipped code).

> ### Corrected after cold review
>
> A cold review re-ran the probes independently and returned "ship with stated
> corrections". The four headline conclusions survive; two got **stronger** under
> further measurement. But two inferential steps were wrong, and the original
> framing said "feasible" where the evidence only supports "not yet disproven".
> If you read the merged version, re-read these:
>
> | | What changed |
> |---|---|
> | **Answer 1** | **Wrong.** "A guessed path could not produce that error" — it could; the 400 is a generic Spring path-variable binder. The endpoints rest on the **bundle alone**, not on two independent sources. Conclusion unchanged, confidence basis narrowed. |
> | **Gate chain** | **Overstated.** The 401/403 split does *not* show the origin validated the token, so "the bearer is the only remaining gate" is withdrawn. What survives: the request does reach the app tier. |
> | **New gaps 1 and 5** | **Missing.** No authenticated call has been observed *succeeding* (gap 1), and token readiness — `SWY_SHOP_TOKEN` is hydrated asynchronously — was never declared (gap 5). There is now a numbered "What remains unknown" section, which the merged version lacked entirely. |
> | **Load / ABP** | **Under-weighted.** Promoted from a bullet to a numbered unknown, mirroring MEAL-12, and tracked as **MEAL-115**. |
> | **Answer 5** | **Overstated.** 31 *hosts*, not 31 banners of payoff — net new consumer brands over our `DOMAIN_MAP` is **4**. "Zero per-banner configuration" is withdrawn: paths need none, the **host list** does, and ours is already wrong for one banner (**MEAL-136**). |
> | **Durability** | **Wrong (small).** The fixture is ~2026-06, not 2026-02 — the window is ~2 months, not ~6. The claim itself came back *stronger*; "byte-identical" was the wrong word for the config comparisons. |
> | **Tarpit** | **Refined.** The doc's own preferred explanation is the weaker branch. |
> | **Probe 1** | **Fixed.** Two bugs (baseline diffed against a nonexistent file; 16 hosts, not 31). |
>
> A second pass then tightened four places where the corrected text still claimed
> more than it had:
>
> | | What changed |
> |---|---|
> | **Answer 1 confidence** | Split into "high that the bundle says this; moderate that the server agrees". A single unverified source does not support one undifferentiated *high*, and the source is minified JavaScript read by a human. |
> | **Answer 3 headline** | Narrowed from "no bot wall" to "no bot **interstitial**". Absence of an interstitial on ten anonymous requests is what was measured; absence of a wall is not, and Imperva profiles behaviour. |
> | **Operations table + probe 2** | Marked bundle-only inline. The hedge existed in the surrounding prose, but tables and code blocks get copied out of context, and a 404 from probe 2 is a real result rather than a typo. |
> | **The blob count** | **Wrong in both the merged version and the review** — both said 18. Counted directly: 17 `*Config` blobs, 19 named initialisers, 20 calls. No reading gives 18, so the "17 of 18" diff ratio is reported as unverified while the finding it carries stands. |

**Question:** Albertsons is the widest family we support — 15 banners on one
platform — so a network rail there pays out repeatedly. Where are the search and
add-to-cart endpoints, will they work from an in-page `fetch` on the user's own
session, and do they generalise across the family?

---

## Answers up front

1. **The endpoints are identified.**
   Search: `GET /abs/pub/xapi/search/products`. Cart: `/abs/pub/erums/cartservice/api/v2/cart`.
   Both are relative paths on whichever banner domain the page is already on.
   **Confidence: high that the bundle says this; moderate that the server agrees.**
   The base *prefix* is corroborated three ways: the page's own config blob, the
   Angular bundle's call-construction code, and a live APIM 404 for a sibling
   prefix (`/basket/items`) that a wrong prefix would not produce.
   But `/items` and the three cart operations come from **the bundle alone** — the
   config blob does not name them, and live probing cannot corroborate them (see
   the guessed-path correction below: `/items-typo` is indistinguishable from
   `/items` at every gate we can reach anonymously).
   The bundle evidence is strong — their own code, in the clear, not inferred —
   but it is minified JavaScript read by a human, and no server response has yet
   agreed with it about `/items`. Splitting the confidence is the honest form:
   high that this is what their client sends, moderate that the server accepts it.

   *Corrected: the original text claimed this was "validated against production".
   It was not. See "The gate chain" — the 400 that was read as route confirmation
   is a generic binder error that any unmatched path produces.*

2. **The family genuinely shares endpoints. This is not an inheritance from
   sharing selectors — it is measured, and the cold review strengthened it.**
   15 of 17 config blobs are **value-identical** across Acme, Safeway and Vons,
   subscription keys included; the two that differ are the default store
   id/zipcode and two cosmetic feature toggles. The review then extended this to
   16 banners and found `initSearchConfig` + `initErumsConfig` **byte-identical on
   15 of 16** (the 16th is the unitedsupermarkets redirect, identical once
   followed). **Confidence: high.**

   *Note on wording: AEM emits these config maps in nondeterministic key order, so
   for the whole-blob-set comparisons "value-identical" is the correct word and
   "byte-identical" was not. Where a byte comparison genuinely held — the two
   endpoint blobs across 16 banners — this document says so explicitly.*

3. **There is no bot *interstitial* on this API surface.** Imperva is present at
   the CDN (`x-cdn: Imperva`) but **passes plain-`curl` requests through to the
   origin** and has done so on every probe. This is the decisive difference from
   H-E-B (MEAL-12), where plain `curl` got an ABP interstitial for *everything*.
   **Confidence: high, for that claim.** What is measured is the *absence of an
   interstitial* on a handful of anonymous requests — which is not the same as
   the absence of a bot wall, and this document deliberately no longer says the
   latter. Imperva demonstrably sits in the path and profiles behaviour rather
   than only credentials, so a wall that never fires on ten requests may still
   fire on ten thousand. Behaviour under sustained authenticated load is
   unmeasured and is the largest unknown on the list — see "What remains
   unknown", gap 4, tracked as **MEAL-115**. And the search tarpit is a live
   candidate for edge posture on this very surface; if it is, this answer is
   narrower still.

4. **An in-page `fetch` is still the right shape — but for a different reason than
   H-E-B, and that reason matters.** At H-E-B the WebView was needed to *defeat*
   the bot wall. Here it is needed to **read the session**: the bearer the cart API
   wants is sitting on a page global, `window.AB.userInfo.SWY_SHOP_TOKEN`. So we
   ride the session by reading it, not by minting it. **No Okta flow of our own,
   no credential handling.** The ticket's second acceptance criterion is satisfied
   **in principle only. No probe has confirmed it in practice** — the original
   text said "one probe confirms it in practice", which describes a probe nobody
   has run. Two things stand between principle and practice: nothing here has
   observed an authenticated call *succeed* (gap 1, **MEAL-137**), and the token is
   hydrated asynchronously rather than being simply present (gap 5).

5. **The ~15-banner payoff argument survives.** The shared config lists **31
   banner hosts** — but 31 hosts is not 31 banners of payoff, and the original
   "stronger than the ticket claims" is withdrawn. Net new consumer brands over
   our `DOMAIN_MAP` is **4**, and realising them is a product decision, not a rail
   dividend. See "Does the payoff argument hold?".

**One thing the ticket gets wrong:** it describes the auth flow as
`albertsons.okta.com/api/v1/authn` → sessionToken → bearer. The live config says
the IdP is **`ciam.albertsons.com`** (`initOktaConfig.issuer`), not
`albertsons.okta.com`. Either way it is out of scope — noted so nobody plans
against a stale hostname.

---

## Where the endpoints came from

Albertsons has no `__NEXT_DATA__`. Its equivalent is a set of **`SWY.CONFIGSERVICE.init*()`
calls inlined in the page**, each taking a single-quoted JSON string. The
committed logged-in fixture carries **20 such calls**: 17 whose name ends in
`Config`, plus `initPopularSearches`, `initThemeBuilderFlag`, and one bare
`SWY.CONFIGSERVICE.init(`. Between them they carry the entire API surface —
paths, hosts, subscription keys, and the Okta/CIAM config.

*(Both the merged version of this document and its cold review said "18". Counted
directly in `tests/fixtures/albertsons/logged-in-home.html`, no reading of the
fixture yields 18: it is 17 `*Config` blobs, 19 named initialisers, or 20 calls.
Nothing downstream depends on the count, but see the durability section — the
"17 of 18" diff ratio inherits the bad denominator.)*

That is the discovery mechanism worth remembering: **the endpoint map ships in the
HTML of the storefront, on every banner, logged in or out.** No bundle spelunking
required to find *what* the endpoints are — only to find their request shapes.

**Corrected — not "every page", and the exception is the page we care about.**
The original claim was "every page". `tests/fixtures/albertsons/cart-with-items.html`
is the real `/erums/cart` page (`<title>Full Cart</title>`, 21 `/erums/cart`
references) and it contains **zero** `SWY.CONFIGSERVICE.*` blobs. That matters
because `/erums/cart` is exactly where `getAlbertsonsCartPageUrl` sends our
WebView. It is survivable — the token globals (`AB.userInfo`,
`AB.COMMON.getActiveSessionUser()`) *are* present on the cart page, so the
session is still readable there — but **a rail must not expect to read config
from the cart page.** Either hard-code the paths and keys (they are public
constants, and per "Durability signal" they barely move) or read them from a
storefront page. Verified: of the eight committed Albertsons fixtures, six carry
the config blobs and the two that do not are `cart-with-items.html` and a
1 KB fragment.

### Search

From `SWY.CONFIGSERVICE.initSearchConfig` (identical on all three banners):

```json
"apimSearchProductsAPIPath":  "/abs/pub/xapi/search/products",
"apimSearchPath":             "/abs/pub/xapi",
"apimSearchProductsEndpoint": "/search/products",
"apimProgramSearchProductsEndpoint": "/pgmsearch/v1/search/products",
"grsSuggestEndpoint":         "/abs/pub/xapi/search/autosuggest",
"apimSubscriptionKey":        "e914eec9448c4d5eb672debf5011cf8f",
"apimHost":                   "",
"domainKey":                  "albertsons",
"defaultBanner":              "safeway"
```

`apimHost: ""` is the important one: search is a **same-origin relative path**. An
in-page `fetch('/abs/pub/xapi/search/products?…')` needs no host configuration at all.

The **request shape** is not guessed. It is lifted verbatim from
`clientlib-angular-global.min.*.js`, which builds the call in the clear:

```js
getMoreSearchProducts({searchQuery:e,start:t,rows:i,fulfillmentType:n,nextPageToken:r}){
  let s = this._config[this._currentEnv].searchProductsAPIDetails.searchProductsAPI,
      a = this._config[this._currentEnv].baseURL.replace("{banner}", this._userInfoService.getBanner()),
      o = { pageurl:a, url:a, "request-id":this._getUTCTimeStampRandom(), pagename:"search",
            rows:i, start:t, "search-type":"keyword",
            storeid:this._userInfoService.getShopStoreId(), q:e,
            dvid:"GhXAoLXN-ss-search", channel:n,
            uuid:this._userInfoService.getUUID(), featured:!1,
            banner:this._userInfoService.getBanner(), includeOffer:!0 };
  r && (o.nextPageToken = r);
  let l = `/${s}?${Object.keys(o).map(e=>e+"="+o[e]).join("&")}`,
      c = { headers: new Jv({ "ocp-apim-subscription-key": …subscriptionKey.value,
                              accept: "application/json" }) };
  return this._http.get(l, c).pipe(…)
}
```

So: **GET**, query-string params, **and no `authorization` header** — search is
unauthenticated by design. Response is unwrapped as
`primaryProducts.response.docs` / `offersData` / `primaryProducts.response.miscInfo.nextPageToken`
(a Solr-shaped payload).

Note `baseURL: "https://www.{banner}.com"` — one codebase, banner substituted at
runtime. That is the generalisation mechanism, visible in their own source.

### Cart

From `SWY.CONFIGSERVICE.initErumsConfig` (identical on all three banners):

```json
"cart.service.endpoint": "/abs/pub/erums/cartservice/api/v1",
"cart.path":             "/cart/",
"cart.by.customer.path": "/cart/customer/",
"cart.apim.key":         "c645e9387c654aa8ae253045f648bfac"
```

The bundle uses a **v2** path the config does not mention —
`/abs/pub/erums/cartservice/api/v2/cart/` — with the same key. Prefer v2; it is
what the live site calls. The origin service identifies itself as `osms-cartservice`.

**Source basis, stated precisely.** The config blob gives us the APIM prefix and
the key. Live probing confirms *that prefix exists*: `GET /abs/pub/erums/cartservice/api/v2/basket/items`
returns a **404** APIM `"Resource not found"`, while the same request under
`/cart/` gets past APIM to the origin — so `/…/api/v2/cart` is a real APIM route.
That is the only genuine live confirmation in this document, and it confirms
something the config blob already told us.

Everything below — `/items`, and the three operations — comes from **the bundle
alone.** Live probing cannot distinguish a real sub-path from a made-up one here
(see "The gate chain"), so do not treat the probe transcript as corroborating them.

The three operations the ticket asks for, from the bundle:

| Operation | Call (all three: **bundle-only, unconfirmed by any server response**) |
|---|---|
| **Add / update item** | `POST {cartAPI}/items` — body is the item payload, params from `generateCommonParams` |
| **Read cart** | `POST {cartAPI}/customer/{customerId}?type=mini&storeId=…&zipCode=…&cartCategoryList=…&expressChk=true` with body `{}` (a POST that semantically reads) |
| **Remove item** | `DELETE {cartAPI}/items` with a body |

`generateCommonParams` verbatim:

```js
generateCommonParams(e,t){
  let i = (new ny).set("serviceType", e.serviceType)
                  .set("storeId", e.primaryStoreId ? e.primaryStoreId : e.storeId)
                  .set("zipCode", e.zipCode)
                  .set("expressChk","true")
                  .set("cartCategoryList", "1P_B2B"===e.cartCategory ? "1P_B2B" : this.config[this.env].cartCategoryList);
  return e.seller && (i = i.set("sellerId", e.seller.sellerId)),
         t && !e.seller && (i = i.set("cartId", e.cartId)),
         $ue(this.env) && (i = i.set("tax","true")), i
}
```

Prod `cartCategoryList` is `1P,3P_MARKETPLACE,1P_Wine`.

And the headers, verbatim — this is the load-bearing piece:

```js
buildHeadersWithToken(e,t,i){
  let n = h({}, this.httpOptions);
  return n.headers = n.headers.set("Ocp-Apim-Subscription-Key", i[t].cartAPIDetails.subscriptionKey.value),
         n.headers = n.headers.set("authorization", "Bearer " + e),
         n.headers = n.headers.set("slotsRequired", "true"),
         n.headers = n.headers.set("x-swy-client-id", "web-portal"),
         n.headers = n.headers.set("Content-Type", "application/json"), n
}
```

**I have not seen the `/items` request body.** It is assembled from a product object
at click time rather than written literally in the bundle, so it is not recoverable
by reading. Probe 3 recovers it from a real add. **Do not invent it.**

*Corrected: the merged version called this "the one part of the contract that is not
established". It is not the only one — it is the only one we knew we were missing.
Whether the call needs anything **beyond** the bearer (required headers, cookies, a
CSRF token, an owned `cartId`, a write-scoped token) is equally unestablished, and
the anonymous probes cannot see it. See "What remains unknown", gap 1.*

---

## The session token is already in the page

This is the finding that decides the rail's shape.

```js
getAccessToken(){ return this._aemService.getSWY_SHOP_TOKEN() ? this._aemService.getSWY_SHOP_TOKEN() : this.accessToken }
getSWY_SHOP_TOKEN(){ return window.AB.userInfo.SWY_SHOP_TOKEN }
```

Alongside it, on the same object: `storeId`, `shopStoreId`, `shopZipcode`, `banner`,
`customerId`, `UUID`, `clubCardNumber`, `userType`, `tokenExpiration` — i.e. every
parameter the cart and search calls need.

**Corroborated independently inside the committed fixture.** `logged-in-home.html`
contains the site's own chat-widget setup, which labels this exact value:

```js
okta_token: { label: 'okta_token', value: activeSessionUser.SWY_SHOP_TOKEN },
token_expiration: { label: 'token_expiration', value: activeSessionUser.tokenExpiration },
```

where `activeSessionUser = AB.COMMON.getActiveSessionUser()`. So the page itself
calls `SWY_SHOP_TOKEN` the Okta token. **The bearer the ticket describes minting
through a login flow is already sitting in the page we have a WebView on.**

The consequence for scope: we never touch credentials, never call Okta, never mint
a bearer. We read a global on a page the user has already signed into. That is
exactly the "ride the session" shape the ticket asked for.

### But the token is not simply *there* — it is hydrated

**Added after cold review. The original document treated `SWY_SHOP_TOKEN` as a
value you read; it is a value you wait for.** This is an operational gap the spike
never declared, and it is the kind a human probing a settled browser tab will
never surface, because by the time they paste anything into a console the
hydration has long finished.

The bundle's own session check does not assume the token is present:
`validateSession` (in `clientlib-angular-global`) tests
`SWY.ENFORCEMENT.isTokenActive() && AB.userInfo.SWY_SHOP_TOKEN`, and when that
fails it falls back to `await http.get(AB.userInfoPath)` — `/bin/safeway/unified/userinfo`
— and assigns the token from the response. So the site itself treats
`AB.userInfo.SWY_SHOP_TOKEN` as possibly-not-yet-populated and has a documented
way to fill it.

Confirmed against the repo: **no token is serialized into any committed fixture.**
Every `SWY_SHOP_TOKEN` occurrence across the eight Albertsons fixtures is a *code
reference* (`activeSessionUser.SWY_SHOP_TOKEN`), never a literal; there is no
JWT-shaped string anywhere in them. `AB.userInfo` is hydrated at runtime, kicked
off by `AB.COMMON.autoSignInIfSessionTokenAvailable()` — which is present in
`logged-in-home.html` and is exactly the "auto sign-in if there is a valid session
token" path its own comment describes.

What a rail therefore has to do, none of which is in scope today:

- **Wait for hydration** rather than reading the global once on page load. A read
  that is merely early is indistinguishable from a signed-out user.
- **Handle expiry and refresh.** `tokenExpiration` sits on the same object, and a
  cart run long enough to add 30 items can outlive a token.
- **Not treat an absent token as "not signed in"**, because
  `autoSignInIfSessionTokenAvailable` may still be in flight.

This is gap 5 in "What remains unknown", and probe 2 has been amended to measure
it (re-reading the token after a delay) rather than assume it away.

---

## The bot wall: present, but not binding (contrast with MEAL-12)

MEAL-12's conclusion for H-E-B was that Imperva ABP was the binding constraint and
a rail must originate inside the already-cleared WebView. **That reasoning does not
transfer, and it is worth being precise about why.**

Measured from this machine, plain `curl`, no browser, no cookies:

```
/                                                    200   0.30s   (825 KB of real HTML)
/shop/search-results.html?q=milk                     200   0.34s
/abs/pub/nonsense-does-not-exist                     404   0.27s
/abs/pub/xapi/search/nonsense-xyz                    404   0.18s   {"statusCode":404,"message":"Resource not found"}
/abs/pub/xapi/search/autosuggest?q=milk&storeid=3132 200   0.25s   real product suggestions
/abs/pub/xapi/storeresolver/all                      400   0.32s   structured app error
/abs/pub/erums/cartservice/api/v2/cart/items         401   0.19s   APIM: missing subscription key
```

Compare H-E-B, where `GET https://www.heb.com/` from the same machine returned a
10 KB "Pardon Our Interruption" interstitial instead of the real homepage. Here the
**full 825 KB homepage arrives in 300ms**, and the API surface answers with ordinary
application-level JSON. Imperva is in the path — responses carry `x-cdn: Imperva`
and `x-iinfo` — but it is passing traffic through, not challenging it.

### The gate chain, measured end to end

Walking the cart endpoint one gate at a time. Every response arrived in under 210ms:

| Request | Result |
|---|---|
| `GET /cart/items`, **no** subscription key | `401` — `"Access denied due to missing subscription key…"` (from **APIM**, not the app) |
| `GET /cart/items`, **with** key | `400` — `{"detail":"Failed to convert 'id' with value: 'items'","instance":"/osms-cartservice/api/v2/cart/items"}` |
| `GET /cart/12345`, with key | `401` — `{"developerMessage":"Not Authorized","uri":"uri=/osms-cartservice/api/v2/cart/12345"}` |
| `POST /cart/items?serviceType=…`, key, **no** bearer | `401` — `"Not Authorized"` |
| `POST /cart/items?…`, key **+ a bogus bearer** | **`403 Forbidden`** |

What survives from this, and what does not — both of the original readings of this
table were wrong, so read the corrections before the conclusions:

- The subscription key is the **APIM** gate, and it is a **public constant we read
  out of the page config**. Supplying it gets us to the origin. *(Holds.)*
- **The request genuinely reaches the app tier.** The 403 is from the origin, not
  from APIM and not from Imperva: it carries `x-envoy-upstream-service-time: 3`
  and the body names `"path":"/osms-cartservice/api/v2/cart/items"`. This is the
  one substantive thing the transcript establishes, and it is worth having —
  nothing in front of the cart service is refusing us on sight. *(Holds.)*

#### Correction — "a guessed path could not produce that error". It could.

**This was wrong.** The original text read the `400 "Failed to convert 'id' with
value: 'items'"` as proof that `/items` is a real route. It is not. The same error
comes back for anything at all in that position:

```
GET  …/api/v2/cart/items                 → 400 "Failed to convert 'id' with value: 'items'"
GET  …/api/v2/cart/xyzzy-not-a-route     → 400 "Failed to convert 'id' with value: 'xyzzy-not-a-route'"
POST …/api/v2/cart/items                 → 403   (bogus bearer)
POST …/api/v2/cart/items-typo            → 403   (bogus bearer)
POST …/api/v2/cart/xyzzy-not-a-route     → 403   (bogus bearer)
```

The 400 is a generic **Spring path-variable binder** firing for *any* unmatched
segment under `/cart/{id}` — it reports that the segment is not a cart id, which
tells you nothing about whether a handler exists for it. And the 403 fires *ahead
of* handler mapping, so it cannot discriminate either.

The only real live confirmation available is negative-space: `GET …/api/v2/basket/items`
returns a **404** APIM `"Resource not found"`, which confirms the APIM prefix
`/abs/pub/erums/cartservice/api/v2/cart` — a thing the config blob already gave us.

**Consequence for Answer 1:** "then validated against production" was not an
independent second source. `/items` and the three operations rest on the bundle
alone. That evidence is strong and the conclusion stands, but on **one source, not
two**.

#### Correction — the 401/403 split does not show the token was validated.

**This was overstated.** The original text read `no bearer → 401` vs
`bogus bearer → 403` as the origin having *validated and rejected* the token, and
concluded that the bearer is "the **only** remaining gate". Varying nothing but
the `Authorization` header on the same endpoint:

| Header | Result |
|---|---|
| absent, or an irrelevant header (`X-Nonsense: 1`) | `401 "Not Authorized"` |
| `Bearer notarealtoken` | `403 {"error":"Forbidden"}` |
| `Bearer <JWT-shaped, bogus signature>` | `403` — **byte-identical body** |
| `Bearer ` (empty) | `500 OSMS-CART-0000 "Unknown error"` |
| `notarealtoken` (no scheme) | `500 OSMS-CART-0000` |
| `Basic Zm9vOmJhcg==` | `500 OSMS-CART-0000` |

Three things follow, and none of them is token validation:

- **Garbage and a well-formed JWT are indistinguishable to the origin** — same
  status, same body, byte for byte. A filter that parsed the token would separate
  those two cases.
- **There is no `WWW-Authenticate` on the 403.** RFC 6750 says a rejected token is
  a `401` with `WWW-Authenticate: Bearer error="invalid_token"`. We get neither.
- **Malformed schemes crash it** with a 500 rather than being rejected cleanly.

That is the signature of a filter **branching on the presence of a Bearer
credential**, not one verifying signature, expiry or audience. So the split tells
us the string is being *looked at*, and nothing about what happens when it is
*correct*.

**Withdrawn: "the bearer is the only remaining gate."** It is *a* gate. Whether it
is the last one is unmeasured — see gap 1. The rail may still need `slotsRequired`,
`x-swy-client-id`, cookies, a CSRF token, an owned `cartId`, or a token with the
right audience for writes, and this transcript would look identical in every one
of those worlds.

So: the rail is not blocked by bot defence at these volumes, and the app tier does
see our requests. It is *plausibly* gated by ordinary OAuth on a token that lives
in the page — but that is a hypothesis about acceptance drawn entirely from
refusals, and refusals do not license it.

### The one anomaly: product search tarpits from a plain client

Every *product-search* endpoint holds the connection open and never responds, while
its siblings answer in ~200ms. Reproducible, four ways:

```
/abs/pub/xapi/search/products?q=milk&storeid=3132            no response  (8s timeout)
/abs/pub/xapi/pgmsearch/v1/search/products?q=milk&…          no response  (8s timeout)
/abs/pub/xapi/v1/aisles/products?q=milk&…                    no response  (8s timeout)
/abs/pub/xapi/search/autosuggest?q=milk&…                    200 in 0.25s
```

Adding the full param set from the bundle (`uuid`, `dvid`, `pagename`, `channel`,
`banner`, `pageurl`, `request-id`, …) does not change it.

**I am not going to claim I know why**, and the cold review's extra measurements
make the original document's preferred explanation the *less* likely one. What the
review added:

- Reproduced at **8–12 s, 0 bytes**. TLS completes; `starttransfer` never fires.
  Nothing is returned, not even headers.
- It hangs **without** the subscription key too — where siblings on the same APIM
  API return an APIM `401` in **under 270 ms** without it (`search/autosuggest`,
  `storeresolver/all`). So the hang happens *before* the gate that answers
  instantly for its neighbours.
- It is an **operation-prefix match on `search/products`**: `/search/productsX`
  hangs, while `/search/xproducts`, `/search/PRODUCTS` and `/search/nonsense-xyz`
  all 404 in under 250 ms.
- **Nothing the caller supplies changes it** — key present or absent, Chrome UA or
  curl UA, minimal params or the full bundle param set.
- Same behaviour on `acmemarkets.com`, so it is platform-wide, not banner-specific.

Two consequences for how this document originally read it:

- **"Needs a real store/session context" is the weaker branch, not the likely
  one.** The store id *is* already supplied in the hanging request and does not
  help; neither does any other caller-supplied input. A dependency waiting on
  context we are withholding does not fit a request that never even gets headers
  back, and does not explain a prefix-scoped match on the operation name.
- **"A tarpit is not the signature of a WAF block" was asserted without
  evidence** — softened. The review's probes neither confirm nor refute it. An
  operation-scoped hang that ignores everything the client sends is at least as
  consistent with deliberate edge posture on one expensive operation as with an
  upstream dependency. If it *is* edge posture, that partially contradicts
  Answer 3 and raises **MEAL-115**'s priority, because it would mean the platform
  does shape traffic on this surface — just not with an interstitial.

**The in-page probe still settles it**, and settles it in the environment we would
actually ship in — with real cookies, a real `uuid`, and a real store id. Until
then, treat the cause as open and both branches as live.

This is the reason not to over-read finding 3 into "we could skip the WebView
entirely": search from a plain client **does not currently work**, whatever the cause.

### What this does not license

- **Do not conclude a plain React Native HTTP client is viable.** Even setting the
  tarpit aside, the bearer only exists inside the page.
- **Sustained load is untested.** This was a bullet here in the merged version;
  it has been promoted to a numbered unknown — see "What remains unknown", gap 4.
- **`docs/network-confirmation-findings.md` still applies.** Do not patch `fetch` or
  `XMLHttpRequest` — that is a detectable tamper signal. *Calling* `fetch` is not
  patching it, so the rail is not forbidden; but nothing here licenses going further.

---

## What remains unknown

Added after cold review, and numbered deliberately: MEAL-12 gives these the same
treatment (`docs/heb-graphql-persisted-queries.md:258-276`) and the merged version
of this document did not, which let three *Confidence: high* lines at the top read
as more settled than the evidence supports. **Gaps 1 and 4 could each sink the rail
on their own** — and within gap 1, so could any one of the four sub-items. Gaps 2, 3
and 5 shape the rail rather than veto it.

1. **No authenticated call has been observed succeeding.** This is the gap the
   merged version omitted entirely. Every measurement in this document is a
   *refusal* — 401, 403, 400, 404, a hang — and per the gate-chain correction above,
   a refusal tells us nothing about acceptance. MEAL-12 declared exactly this for
   H-E-B (`docs/heb-graphql-persisted-queries.md:267-268`: "Mutations specifically
   may carry extra requirements (a CSRF token, an order/cart id, store-context
   headers)"); MEAL-15 declared only the missing request *body*, which is the
   smaller half of the same gap. Specifically unmeasured:
   - Whether `slotsRequired` and `x-swy-client-id` are **required** or merely sent
     by the site's own client.
   - Whether there is a **CSRF token, or cookies** the call needs beyond the bearer.
   - Whether the cart id is **ownership-bound** to the caller. Note
     `generateCommonParams` sets `cartId` *conditionally* (`t && !e.seller`), so the
     site does not always send one — that conditional is unexplained.
   - Whether the token's **audience/scope differs for writes vs reads**. A read
     working would not settle an add.

   Tracked as **MEAL-137**. This is the gate on budgeting the rail.

2. **The `/items` request body.** Unchanged from the merged version: it is
   assembled from a product object at click time rather than written literally in
   the bundle. Probe 3 recovers it. **Do not invent it.**

3. **Why product search tarpits from a plain client**, and in particular whether
   the cause is an upstream dependency or edge posture. See the tarpit section —
   the second branch would partially contradict Answer 3.

4. **Rate limiting / Imperva behaviour under sustained programmatic load is
   untested, and this is the largest unknown on the list rather than the
   smallest.** A handful of anonymous probes is not a rail doing 30 authenticated
   adds; Imperva profiles behaviour, not just tokens, and it is demonstrably in the
   path here (`x-cdn: Imperva`, `x-iinfo` on every response). It is also the failure
   mode that would surface late and expensively — after a rail is built, in
   production, on real users' carts. Measure it no later than the authenticated
   probe in gap 1. Tracked as **MEAL-115**.

   *This is deliberately worded to match MEAL-12's gap 4
   (`docs/heb-graphql-persisted-queries.md:271-276`). Same risk, same platform
   posture, same priority — and the merged version of this document gave it a
   bullet where MEAL-12 gave it a number.*

5. **Token readiness.** `window.AB.userInfo.SWY_SHOP_TOKEN` is populated
   asynchronously, so "the token is in the page" is true of a settled tab and not
   necessarily true at the moment a rail wants to read it. Expiry and refresh
   mid-run are likewise unhandled. See "But the token is not simply *there*".
   Operational rather than existential — it shapes the rail, it does not veto it.

---

## Does the family genuinely share endpoints?

The ticket, and our own `albertsons.ts`, assert family-wide sameness on the
strength of **shared selectors**. Those are different claims and the brief is right
that one does not imply the other. So this was measured directly.

Method: fetch the logged-out homepage of three banners, extract all
`SWY.CONFIGSERVICE.*` blobs from each, diff them. (Anonymous GETs of public pages —
no account, no login.)

**Result: 15 of 17 blobs are value-identical across `acmemarkets.com`,
`safeway.com` and `vons.com`** — including `initSearchConfig`, `initErumsConfig`,
`initCatalogConfig`, `initDatapowerConfig`, `initOktaConfig`, `initWcaxXapiConfig`,
and every subscription key in them.

The only two that differ:

```
initStoreResolutionConfig   safeway: storeId 3132, zip 94611
                            vons:    storeId 2053, zip 92110
initFeatureToggleConfig     vons has enableAemOneTrustScript + enableThemeBuilder
```

Both are irrelevant to endpoint shape. The default store id is a logged-out
geography placeholder; a signed-in rail reads the real one from
`window.AB.userInfo.shopStoreId`.

**A note on "byte-identical", which this document originally used throughout.**
AEM emits these config maps in **nondeterministic key order**, so two pages
carrying the same configuration will differ byte for byte while agreeing on every
value. For the whole-blob-set comparison above the correct claim is
**value-identical** (parse, then compare), and the merged version's "byte-identical"
overstated the method even though the finding is right. The wording has been fixed
everywhere it described a config comparison. One place a byte comparison genuinely
did hold, and is stated as such: the cold review compared `initSearchConfig` +
`initErumsConfig` specifically across **16 banners** and found **15 of 16
byte-identical**, the 16th being `unitedsupermarkets.com` — which is a redirect,
and identical once followed. Being precise about which is which matters, because
a reader who tries to reproduce a byte diff across all blobs will get spurious
`DIFFERS` results.

Three further pieces of corroboration, all from the **Acme** capture:

- `initSearchConfig` says `"domainKey": "albertsons"` and `"defaultBanner": "safeway"`
  — on an Acme page.
- `initDatapowerConfig` says `"host": "api-prod-origin.safeway.com"`,
  `"cncHost": "api-aem-prod.albertsons.com"`, `"xApiConvertHost": "www.safeway.com"`.
- The bundle templates its origin as `baseURL: "https://www.{banner}.com"` and
  substitutes `getBanner()` at call time.

So it is not merely that the banners *behave* alike. **They are served the same
config by the same AEM codebase, and their client substitutes the banner name into
a shared URL template.** Endpoint paths are shared; only the origin host varies,
and it varies exactly as the domain the WebView is already on. A relative-path
in-page `fetch` therefore **needs no per-banner *path* configuration** — which is
the useful half of the claim. The merged version went further and said "zero
per-banner configuration"; that is withdrawn, because the **host list** is
per-banner configuration, we already maintain one, and ours has a bug in it. See
"Withdrawn: zero per-banner configuration".

**Confidence: high.** Caveat, stated plainly: the 17-blob comparison was measured
on 3 of 31 hosts, and on logged-out pages. The cold review widened the two blobs
that matter to 16 hosts (see above), which is the version of this claim to cite.
Widening the *whole* blob set is still cheap and needs no account — the probe below
does it, and has been fixed to actually cover the hosts it claims.

### Durability signal, for free

**Corrected: the fixture is ~2026-06, not 2026-02, so the window is ~2 months, not
~6.** The merged version said 2026-02, which is the *selector*-verification date
from `src/lib/webview-scripts/albertsons.ts:21` ("confirmed on Albertsons platform
2026-02") — a different date about a different thing. Verified in the repo:
`tests/fixtures/albertsons/logged-in-home.html` carries weekly-ad dates
2026-06-11 / 06-18 / 06-25 and first landed in commit `87498ca`, dated **2026-06-12**.

The claim itself survives, and the cold review made it **stronger** than as
written. It diffed the committed config blobs against live Acme:

- **All but one are value-identical**, `initSearchConfig` and `initErumsConfig`
  included. The merged version checked only those two; the whole set holds.
  The review reported this as "17 of 18", but the fixture contains no set of 18
  (see the count above), so treat the *ratio* as unverified and the *finding* —
  one blob changed, and it was `initFeatureToggleConfig` — as the substance.
  Anyone re-running the diff should report the denominator they actually counted.
- Only `initFeatureToggleConfig` changed — the same blob that varies between
  banners, i.e. the churn is confined to feature flags.
- `initDeliverySubscriptionConfig` was **removed from live entirely**. The merged
  version does not mention this. It is not an endpoint blob, so it does not touch
  the rail, but it is the one piece of evidence here that this config set *does*
  get restructured and not merely re-valued — worth knowing before treating the
  blobs as immutable.

So: ~2 months, all but one blob unmoved, and the two endpoint blobs unmoved across
16 banners. The endpoint config is not churning — still a marked contrast with
H-E-B's rotating persisted-query hashes, just on a shorter observed baseline than
the merged version claimed. **Confidence: moderate** on durability specifically,
because ~2 months is a weaker basis than ~6 and one blob disappeared inside it.

---

## Does the ~15-banner payoff argument hold?

**Yes — at 15 banners. The merged version's "and it is understated" is withdrawn.**
The host count was right; the inference from host count to payoff was not.

The host count, re-parsed from `initBannerDomainMapConfig` in the committed fixture
and confirmed: **exactly 31 hosts — 10 `business.*` and 21 consumer.** The six
extras the merged version named beyond our `DOMAIN_MAP` are all really there
(`andronicos`, `albertsonsmarket`, `shopalbertsonsmarket`, `shopmarketstreet`,
`shopamigos`, `shopunitedsupermarkets`). The B2B sites do run the same cart service
with a `1P_B2B` `cartCategoryList`, a code path visible throughout the bundle.

**But 31 hosts is not 31 banners of payoff.** Deduplicating:

| | Count | |
|---|---|---|
| Hosts in `initBannerDomainMapConfig` | 31 | |
| − `business.*` B2B storefronts | −10 | B2B fronts of banners **already counted** on the consumer side |
| Consumer hosts | 21 | |
| − same brand listed twice | −2 | `albertsonsmarket`/`shopalbertsonsmarket`, `unitedsupermarkets`/`shopunitedsupermarkets` |
| Distinct consumer brands | 19 | |
| − already in our `DOMAIN_MAP` | −15 | |
| **Net new consumer brands** | **4** | `andronicos`, `albertsonsmarket`, `shopmarketstreet`, `shopamigos` |

And those 4 are not a rail dividend at all. **Verified: none of them appears in
`src/constants/stores.ts` — not in `STORES`, not in `WEBVIEW_STORE_IDS`.** We do
not support them today, by DOM or otherwise. Adding them is a *product* decision
about which chains to offer, and it would be equally available to the DOM rail,
which already covers the platform with one selector set. A network rail does not
unlock them; shipping four store entries does.

So the payoff is **~15×, the same figure the ticket used**, plus a real but
secondary saving from one shared surface: one config blob, one subscription-key
set, one IdP (`ciam.albertsons.com`), one cart service.

**The economics-inverting risk did not materialise.** The brief was right to flag
that per-banner endpoints would change the maths. Endpoint *paths* are not
per-banner; the diff is empty where it counts. That part stands.

### Withdrawn: "zero per-banner configuration"

The merged version concluded a relative-path in-page `fetch` "generalises with
**zero per-banner configuration**". The document's own evidence contradicts that
twice, and so does our shipped code.

From the bundle, in this document already:

- `generateCommonParams` branches on `'1P_B2B' === e.cartCategory` to set
  `cartCategoryList`.
- `getCartByCustId` branches on `getSiteType() === 'B'` to append
  `&cartCategoryList=1P_B2B`.

So the ten `business.*` hosts need a per-host branch to get their cart category
right — a branch their own client makes.

From our code, and worse: **`DOMAIN_MAP.united = 'unitedsupermarkets.com'`**
(`src/lib/webview-scripts/albertsons.ts:82`). That host is a Squarespace marketing
site which 301s to `https://shopunitedsupermarkets.com/` **dropping the path**, so
`getAlbertsonsCartPageUrl('united')` lands on a marketing root rather than a cart.
Our per-banner host list is already wrong for one of the 15, today, in shipped
code — which is the strongest possible evidence that the host list is exactly the
kind of per-banner configuration that needs maintaining. Filed as **MEAL-136**;
not fixed here, because this is a docs-only change.

**Restated correctly:** endpoint **paths** need no per-banner configuration — that
is the real and useful finding. The **host list** does, we already maintain one,
and ours currently contains a bug.

The honest deductions:

- **Payoff is per-*platform*, not per-banner, and so is the risk.** One Albertsons
  change breaks all 31 hosts at once. That is the same concentration that makes the
  payoff large — worth one shared canary, not 31. See "What the canary must
  assert" for what that canary has to cover to be worth anything.
- **Nothing here is an argument for building the rail**, only that if we build it,
  it covers the family. The unknowns above are unmeasured, and gaps 1 and 4 are the
  real gating risks (**MEAL-137**, **MEAL-115**).
- **Keep the DOM rail.** Same conclusion as MEAL-12: this is an optimisation with a
  fallback, not a replacement.

### What the canary must assert

One platform, one config, one cart service does make **one canary the right unit** —
that part of the merged conclusion is right and is not disproportionate. But "one
shared canary" was left unspecified, and an underspecified canary passes straight
through the failure that matters. Per family, it must assert:

1. **Both endpoint blobs' *contents*, not their presence** — the paths *and* the
   subscription keys out of `initSearchConfig` and `initErumsConfig`. A canary that
   only checks the blobs exist will not notice a rotated key.
2. **One live gate-chain response.** That APIM still routes `/…/api/v2/cart` and
   the origin still answers from the app tier — the `x-envoy-upstream-service-time`
   / `osms-cartservice` signature above.
3. **The DOM fallback too.** This is the one most likely to be skipped and it is
   the reason the canary exists: a platform change big enough to break the rail
   will very likely break the selectors as well, and a rail-only canary would
   report a rail failure while the fallback it is supposed to fall back to is also
   broken. Assert the selectors in `SEL_FALLBACKS` still resolve.

A canary that merely pings the endpoint and gets a 401 tells us nothing — a 401 is
what a *working* endpoint returns to it. Relevant existing ticket: **MEAL-7**
(nightly live canary per store family in CI).

---

## Closing the gap — runnable, needs a human

Everything above was established without an account, and **everything above is a
refusal.** What remains needs a logged-in Albertsons-family session, which is why
it stops here.

Open, mapped to "What remains unknown": (1) does an authenticated call **succeed** —
including a *write* — and what else does it need besides the bearer (gap 1,
**MEAL-137**); (2) the `/items` request body (gap 2); (3) why product search tarpits
for a plain client (gap 3); (5) when the token is actually readable, and what
happens when it expires (gap 5). Gap 4, sustained load, is **MEAL-115** and is not
closed by any probe below — it needs its own volume test.

### Probe 1 — the family sweep. No account needed.

Widens the generalisation claim from 3 hosts toward all 31. Run from anywhere.

**Two bugs fixed from the merged version, both of which change the result:**

- The Safeway baseline was written **inside the loop**, while `albertsons` was
  ordered first — so iteration 1 always diffed against a file that did not exist
  yet and reported a spurious `DIFFERS`. The cold review hit exactly this. Fetch
  Safeway **before** the loop.
- The loop covered **16 hosts, not 31**, though the surrounding text claimed 31 in
  two places. It omitted all ten `business.*` hosts and five of the
  `shop*`/`albertsonsmarket` consumer hosts. Either fix the loop or stop saying 31;
  this version fixes the loop.

Minor, and worth knowing if you read byte counts rather than a diff: `[^']*`
matches each blob **twice** on live pages, because they carry a second
backslash-escaped copy. Harmless for a diff (both sides match twice), misleading
otherwise.

```bash
# Extracts the two endpoint config blobs from each host's logged-out homepage and
# diffs them against Safeway. Expect: every line SAME.
# Note: -L follows redirects — unitedsupermarkets.com 301s to shopunitedsupermarkets.com.

CONSUMER="albertsons safeway vons jewelosco shaws acmemarkets tomthumb randalls
          pavilions starmarket haggen carrsqc kingsfoodmarkets balduccis
          unitedsupermarkets andronicos albertsonsmarket shopalbertsonsmarket
          shopmarketstreet shopamigos shopunitedsupermarkets"
B2B="safeway albertsons acmemarkets tomthumb shaws starmarket pavilions
     jewelosco vons randalls"

extract() {  # $1 = full URL -> stdout
  curl -sL --max-time 30 "$1" \
  | grep -oE "initSearchConfig\('[^']*'\)|initErumsConfig\('[^']*'\)"
}

# Baseline FIRST, outside the loop — this was the bug.
extract "https://www.safeway.com/" > /tmp/cfg-baseline.txt
[ -s /tmp/cfg-baseline.txt ] || { echo "baseline empty — abort"; exit 1; }

check() {  # $1 = label, $2 = URL
  extract "$2" > "/tmp/cfg-$1.txt"
  if [ ! -s "/tmp/cfg-$1.txt" ]; then
    echo "$1  no config found (host may redirect to a non-platform site, or be retired)"
  elif diff -q /tmp/cfg-baseline.txt "/tmp/cfg-$1.txt" >/dev/null 2>&1; then
    echo "$1  SAME"
  else
    echo "$1  *** DIFFERS — investigate ***"
  fi
}

for b in $CONSUMER; do check "$b"          "https://www.$b.com/";      done
for b in $B2B;      do check "business-$b" "https://business.$b.com/"; done
```

**How to read it:** all `SAME` → the shared-endpoint-path claim is settled for the
whole family. Any `DIFFERS` → diff that host by hand; if a *path or subscription
key* differs the rail needs a per-banner lookup (the payoff argument weakens but
does not collapse). A host with no config found is most likely a redirect off the
platform — **not** automatically a counter-example, but check where it went: that
is precisely how the `united` → marketing-site bug (**MEAL-136**) shows up. Note
this probe settles *paths only*; it says nothing about gaps 1, 4 or 5.

### Probe 2 — the session and the read half. Needs a logged-in session.

*(The merged version called this "the decisive one". It is not — it is read-only,
and gap 1 is about writes. **Probe 3 step B is the decisive one.**)*

Sign in to **any** Albertsons-family banner in a normal browser, set your store,
**put one item in the cart by hand**, then paste this into DevTools console **on a
tab of that same banner** (same-origin matters — the cookies and the `AB` global
both need to be there).

It is deliberately **read-only**: it reads the session, reads the cart, and reads
search. It does not add anything — which is also its limitation, because per gap 1
a read succeeding does not establish that a write will. Probe 3 covers the write.

**Amended after cold review:** step 1 now dumps `Object.keys(window.AB.userInfo)`
and **re-reads the token after a delay**. The merged version read the token once,
which cannot distinguish "the token is on the page" from "the token happened to
have finished hydrating before you pressed Enter" — and a human pasting into a
settled tab will always see the latter. The key dump matters too: it shows what
else is on that object, which is the cheapest way to notice a field the rail needs
that this document never named.

```js
// MEAL-15 probe. Read-only. Run on a logged-in www.<banner>.com tab.
(async () => {
  // ── 1. Is the session really readable from the page, and WHEN? ────────────
  const ui = window.AB?.userInfo;
  if (!ui) return console.error('window.AB.userInfo missing — are you on a banner storefront page, signed in?');

  // Everything on the object, not just the fields we expected. Cheap, and the
  // fastest way to spot something the rail needs that this doc never named.
  console.log('userInfo KEYS:', Object.keys(ui).sort().join(', '));

  const snap = () => { const t = window.AB?.userInfo?.SWY_SHOP_TOKEN;
                       return { hasToken: !!t, len: t ? t.length : 0 }; };
  const t_immediate = snap();

  const tok = ui.SWY_SHOP_TOKEN;
  const sess = { hasToken: !!tok, tokenLen: tok ? tok.length : 0,
                 customerId: ui.customerId, storeId: ui.storeId,
                 shopStoreId: ui.shopStoreId, shopZipcode: ui.shopZipcode,
                 banner: ui.banner, uuid: ui.UUID, tokenExpiration: ui.tokenExpiration };
  console.log('SESSION:', sess);

  // TOKEN READINESS (gap 5). The token is hydrated asynchronously via
  // AB.COMMON.autoSignInIfSessionTokenAvailable() / AB.userInfoPath, so a single
  // read on a settled tab proves nothing about what a rail sees on page load.
  // Re-read after a delay: if these two disagree, hydration is still landing and
  // the rail must WAIT rather than read once.
  await new Promise(r => setTimeout(r, 3000));
  console.log('TOKEN READINESS: immediate', t_immediate, '→ after 3s', snap(),
              '| tokenExpiration:', window.AB?.userInfo?.tokenExpiration,
              '| now:', new Date().toISOString());
  // Best signal of all: hard-reload the page and re-run this block as the FIRST
  // thing you do. If hasToken is false immediately after load and true 3s later,
  // gap 5 is confirmed and the rail needs a readiness wait.

  if (!tok) return console.error('No SWY_SHOP_TOKEN. Everything below will 401 — sign in first (or it is still hydrating: wait and re-run).');

  const storeId = ui.shopStoreId || ui.storeId;
  const zip     = ui.shopZipcode || '';
  const CART    = '/abs/pub/erums/cartservice/api/v2/cart';
  const CART_KEY   = 'c645e9387c654aa8ae253045f648bfac';   // from initErumsConfig
  // NOTE: the prefix above is corroborated (config blob, bundle, and a live APIM
  // 404 for the sibling /basket/items). The sub-paths this probe calls are NOT —
  // they come from the bundle alone, and anonymous probing cannot tell `/items`
  // from `/items-typo`. A 404 here is therefore a real result worth reporting,
  // not a mistake in the probe.
  const SEARCH_KEY = 'e914eec9448c4d5eb672debf5011cf8f';   // from initSearchConfig

  // ── 2. CART READ. POST, but semantically a read — adds nothing. ───────────
  const cartQs = new URLSearchParams({
    type: 'mini', storeId, zipCode: zip,
    cartCategoryList: '1P,3P_MARKETPLACE,1P_Wine', expressChk: 'true' });
  const cr = await fetch(`${CART}/customer/${ui.customerId}?${cartQs}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Ocp-Apim-Subscription-Key': CART_KEY,
               'authorization': 'Bearer ' + tok,
               'slotsRequired': 'true',
               'x-swy-client-id': 'web-portal',
               'Content-Type': 'application/json' },
    body: '{}' });
  const cartTxt = await cr.text();
  console.log('CART READ:', cr.status, cartTxt.slice(0, 700));
  // Keep the cartId — an add needs it.
  try { const j = JSON.parse(cartTxt);
        console.log('cartId candidates:', JSON.stringify(j).match(/"cartId":"[^"]+"/g)?.slice(0,3)); } catch {}

  // ── 3. SEARCH. Does it work in-page, where plain curl tarpitted? ──────────
  const base = location.origin;
  const sQs = new URLSearchParams({
    pageurl: base, url: base, 'request-id': String(Date.now()), pagename: 'search',
    rows: '5', start: '0', 'search-type': 'keyword', storeid: storeId,
    q: 'tortillas', dvid: 'GhXAoLXN-ss-search', channel: 'pickup',
    uuid: ui.UUID ?? '', featured: 'false', banner: ui.banner ?? '', includeOffer: 'true' });
  const t0 = performance.now();
  try {
    const sr = await fetch(`/abs/pub/xapi/search/products?${sQs}`, {
      credentials: 'include',
      headers: { 'ocp-apim-subscription-key': SEARCH_KEY, accept: 'application/json' } });
    const st = await sr.text();
    console.log(`SEARCH: ${sr.status} in ${Math.round(performance.now()-t0)}ms`, st.slice(0, 500));
    try { console.log('product count:',
      JSON.parse(st)?.primaryProducts?.response?.docs?.length); } catch {}
  } catch (e) {
    console.error(`SEARCH threw after ${Math.round(performance.now()-t0)}ms —`,
                  'if this hung ~30s the tarpit is not client-shaped:', e);
  }
})();
```

**How to read it — the table is the deliverable:**

| Outcome | Meaning |
|---|---|
| `hasToken: true` with a long token, and real `customerId`/`shopStoreId` | **The core premise is confirmed.** The session is readable in-page; no Okta flow needed, ever. This closes the ticket's second acceptance criterion for *reads*. |
| `TOKEN READINESS` differs between the immediate read and the 3s read | **Gap 5 confirmed.** The rail needs a hydration wait, not a single read. Record how long it took. |
| `TOKEN READINESS` identical, both `hasToken: true` | Inconclusive, **not** a refutation — you are on a settled tab. Hard-reload and re-run as the first action to actually test this. |
| `window.AB.userInfo missing` | You are on `/erums/cart` or another sub-app rather than the storefront. Go to the banner homepage and retry. Not a negative result. Note the cart page *does* carry the token globals, but not the config blobs. |
| **CART READ `200` + JSON containing your hand-added item** | **The read half works** — auth and session confirmed against a real account. **This is not "the rail works"**, which is what the merged version claimed here: a read is not a write, and gap 1 is not closed until probe 3's write succeeds. |
| CART READ `401` "Not Authorized" | The token was rejected or absent. Check `tokenExpiration`; reload to refresh and retry. |
| CART READ `403` | Token present but not accepted for this operation — the same status a *bogus* bearer produced from curl. Suspect an extra required header or a token audience mismatch. Capture the real request from the Network tab and diff the headers. |
| CART READ `400` naming a param | **Success for our purposes** — we reached the service and only the arguments are wrong. Fix from the message and re-run. |
| SEARCH `200` with a non-zero product count | **The tarpit was client-shaped, not a block.** Search works in-page. This is the expected result and the rail's search half is settled. |
| SEARCH hangs in-page too | The tarpit is real and server-side. **Fall back to `/abs/pub/xapi/search/autosuggest`**, which is measured working anonymously, or keep DOM scraping for search and use the network rail only for cart. Materially narrows the rail — file it. |
| SEARCH `401`/`403` | Search needs auth after all, contradicting the bundle. Add `authorization: Bearer` and re-run. |
| Anything with `x-iinfo` and an Imperva HTML body | Imperva challenged you. Reload the page and retry; if it recurs under repetition that is the load finding, and it is important. |

### Probe 3 — capture a real add, then perform one. Needs a human, two clicks.

The merged version framed this as "the `/items` POST body is the **only** part of
the contract still unknown". It is not — see gap 1. The body is the smaller half;
the larger half is that **nothing has observed an authenticated write being
accepted at all**. This probe has been changed to settle both in one pass.

**Step A — capture. Use "Copy as fetch", not a hand-transcribed body.**

1. On a logged-in banner tab, open DevTools → **Network**, filter `cartservice`.
2. Click **Add** on any product in the normal UI.
3. Right-click the `POST …/api/v2/cart/items` request → **Copy** → **Copy as
   fetch** (or **Copy as cURL**).
4. Paste that verbatim into **MEAL-137**.

Why the change: the merged version asked for "the JSON body and the full header
list", which is a transcription task, and transcription silently drops exactly the
things gap 1 turns on — **query-parameter order**, the **full cookie set**, and any
header a reader assumes is boilerplate (`x-swy-client-id`, `slotsRequired`, a CSRF
header, a `sec-*` header). "Copy as fetch" captures all of it mechanically and
settles gap 1's header/cookie questions in the same pass as the body. It costs the
same one right-click.

**Step B — the smallest reversible write.** Do this, because without it the
document still has not observed an authenticated write succeeding:

1. Empty the cart, or note exactly what is in it.
2. Take the captured `fetch(...)` from step A, change **one** thing — the product
   id — and run it in the console on the same tab.
3. Check the result: the response status, *and* whether the item appears in the
   cart UI on reload.
4. **Remove it through the site's own UI**, not through the API. One add, then a
   normal manual removal: fully reversible, no `DELETE` call, nothing left behind.

Report the status *and* the response body. A `200`/`201` with the item visible in
the UI closes gap 1 and is the first evidence in this whole investigation of the
platform *accepting* anything from us. A `403` is the interesting failure: it is the
same status a bogus bearer produces, and per the gate-chain correction it will not
tell you why on its own — diff your call against the step-A capture, header by
header and param by param, and the difference is the answer.

With that in hand the contract is complete and the rail is implementable — except
for gap 4 (**MEAL-115**), which no console probe can settle.

---

## Reproducing what is in this document

Everything above is reproducible in about ten minutes with no account:

```bash
# 1. Endpoint map, straight out of any banner's HTML — no bundle needed.
curl -s https://www.safeway.com/ | grep -oE "SWY\.CONFIGSERVICE\.init\w+\('" | sort -u

# 2. The gate chain: each answers in <250ms, so nothing is challenging us at these
#    volumes. NOTE these are all REFUSALS — see the two gate-chain corrections.
C=https://www.safeway.com/abs/pub/erums/cartservice/api/v2/cart
curl -si "$C/items" | head -1                                              # 401 APIM: no sub key
curl -si -H 'Ocp-Apim-Subscription-Key: c645e9387c654aa8ae253045f648bfac' \
     "$C/items" | tail -1                                                  # 400 osms-cartservice
curl -si -X POST -H 'Ocp-Apim-Subscription-Key: c645e9387c654aa8ae253045f648bfac' \
     -H 'authorization: Bearer notarealtoken' -H 'content-type: application/json' \
     -d '{}' "$C/items?serviceType=pickup&storeId=3132&zipCode=94611" | head -1   # 403

# 2b. Why the 400 above is NOT route confirmation, and the 403 is NOT token
#     validation. Run these alongside 2 — that is the whole correction.
K='Ocp-Apim-Subscription-Key: c645e9387c654aa8ae253045f648bfac'
curl -si -H "$K" "$C/xyzzy-not-a-route" | tail -1        # same 400, on a made-up path
curl -si -X POST -H "$K" -H 'authorization: Bearer notarealtoken' \
     -H 'content-type: application/json' -d '{}' \
     "$C/xyzzy-not-a-route?serviceType=pickup&storeId=3132" | head -1     # also 403
curl -si -X POST -H "$K" -H 'authorization: Basic Zm9vOmJhcg==' \
     -H 'content-type: application/json' -d '{}' \
     "$C/items?serviceType=pickup&storeId=3132" | head -1                 # 500 OSMS-CART-0000
# And the one genuine live confirmation — that the APIM prefix is real:
curl -si -H "$K" \
  https://www.safeway.com/abs/pub/erums/cartservice/api/v2/basket/items | head -1  # 404 APIM

# 3. A search endpoint that works anonymously, from a plain client.
curl -s -H 'ocp-apim-subscription-key: e914eec9448c4d5eb672debf5011cf8f' \
  'https://www.safeway.com/abs/pub/xapi/search/autosuggest?q=milk&storeid=3132' | head -c 300

# 4. The tarpit, and that it is an operation-prefix match nothing client-side moves.
S=https://www.safeway.com/abs/pub/xapi/search
for p in products productsX xproducts PRODUCTS nonsense-xyz; do
  printf '%-14s ' "$p"
  curl -s -o /dev/null --max-time 15 \
    -w 'http=%{http_code} start=%{time_starttransfer} total=%{time_total}\n' \
    "$S/$p?q=milk&storeid=3132"
done   # products/productsX hang with starttransfer 0; the rest 404 in <250ms
```

The config extractor used for the cross-banner diff is ~15 lines of Python: match
`SWY\.CONFIGSERVICE\.(\w+)\('`, scan forward to the unescaped closing quote,
`json.loads` the `unicode_escape`-decoded string. It works unchanged on the
committed fixtures and on live pages, which is how fixture-vs-live drift was checked.
**Compare the parsed values, not the raw strings** — AEM's key order is
nondeterministic, so a byte diff of whole blobs produces false positives. That is
the same distinction as the value-identical / byte-identical note above.

No page was patched or instrumented at any point. No account was used, no login was
attempted, and no bearer was minted — per the MEAL-15 scope constraints. **That
constraint is also this document's ceiling**: an anonymous investigation can only
observe refusals, and every conclusion here about what the platform will *accept*
is inference. Probe 3 step B is the smallest experiment that changes that, and it
is the one thing still worth a human's two minutes.
