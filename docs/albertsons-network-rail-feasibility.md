# MEAL-15 — Can we drive the Albertsons family from an in-page network rail?

**Date:** 2026-08-06 (corrected 2026-08-06 after cold review; **corrected again
2026-08-11 after probe 3 was actually run**)
**Status:** **Gap 1 is closed. An authenticated write was accepted — `200`.**
Everything in the 2026-08-06 version of this document was anonymous and every
measurement in it was a *refusal*; probe 3 has now been run on a signed-in
`www.safeway.com` session and the platform accepted an add-to-cart. The rail is
**estimable**. It is not unblocked, on two counts: gap 4 (sustained load,
**MEAL-115**) is untouched by that measurement and still gates it on its own, and
**gap 6 — what `qty` means on a repeat add — is unmeasured (MEAL-194).** Gap 6
does not decide whether the rail can be built; it decides whether the rail may
retry or add the same item twice without silently producing a wrong cart.
**Timebox:** 1 day (spike — findings, not shipped code).

> ### Corrected 2026-08-11 — probe 3 was run, and it overturns the contract
>
> Read this before anything below it. Stephen captured a real add with
> Copy-as-fetch on a signed-in `www.safeway.com` session, changed **only the
> product id**, re-ran it from the console, and got **`200 OK`** with the item in
> the cart after a reload (**MEAL-137**). That is the first time in this
> investigation that the platform has accepted anything from us, and it replaces
> guesses with a measurement in seven places:
>
> | | What changed |
> |---|---|
> | **The add-path headers** | **Wrong.** `buildHeadersWithToken` — "the load-bearing piece" — is **not** the builder `/items` uses. `slotsRequired` and `x-swy-client-id` are **not sent at all** on a real add. |
> | **The add-path query params** | **Wrong.** `generateCommonParams` always sets `expressChk=true`; the real add sends **no `expressChk`, no `tax`, no `sellerId`, and no `cartId`**. `serviceType` is `Dug`, not the `pickup` the anonymous probes used. |
> | **The `/items` body** | **Recovered.** It is no longer "do not invent it" — it is measured, below. |
> | **Gap 1** | **Closed**, with named residue — cookie necessity, `preferenceList`, the response *body* shape, and **`qty` on a repeat add**, which is the one that can produce a wrong cart rather than a visible failure (gap 6). |
> | **The 403 wall** | **Neither model is confirmed — and the 2026-08-06 one is no longer safe to quote.** A real signed-in session gets `400` from the same endpoint family that gave every bogus bearer a `403`, so the gate is not branching on the bare *presence* of a `Bearer`. But the session changed the cookies, the origin and the token all at once, so which of them the gate read is unresolved. One `credentials: 'omit'` replay would settle it. |
> | **Gap 5** | **Sharpened, not closed.** Hydration timing is still unmeasured, but the captured JWT gives a hard number: **45-minute lifetime**, silently refreshed off `offline_access`, **not store- or banner-bound**, no write scope. |
> | **Gap 3 (the search tarpit)** | **Narrowed.** Product search does **not** hang in-page — it answered `400` promptly from a signed-in tab where plain `curl` never gets a byte. But no client has yet seen a search `200`, so the rail's search half is still unproven. |
> | **Rail shape** | **New constraint.** The SPA does not observe an API add — the cart badge did not move until reload. Any post-add check that reads the DOM returns a **false negative**. |
>
> Two things this did **not** do: it did not touch gap 4, and it did not license
> "the bearer alone is sufficient" — both the capture and the replay ran
> `credentials: 'include'` from the origin, so cookies rode along either way.
>
> ### Corrected after cold review (2026-08-06)
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

1. **The endpoints are identified, and the add path is now confirmed by a server
   response.**
   Search: `GET /abs/pub/xapi/search/products`. Cart: `/abs/pub/erums/cartservice/api/v2/cart`.
   Both are relative paths on whichever banner domain the page is already on.
   **Confidence: high for `POST /items` — a real session got `200` from it.**
   The base *prefix* is corroborated three ways over: the page's own config blob,
   the Angular bundle's call-construction code, and a live APIM 404 for a sibling
   prefix (`/basket/items`) that a wrong prefix would not produce.

   *Upgraded 2026-08-11.* The 2026-08-06 text split this — "high that the bundle
   says this; moderate that the server agrees" — because `/items` rested on the
   bundle alone and no server response had ever agreed with it. One now has: the
   accepted add went to `POST …/api/v2/cart/items` and returned `200`. **That
   covers the add operation only.** Read-cart (`POST /cart/customer/{id}`) and
   remove (`DELETE /items`) are still bundle-only and still unconfirmed — the one
   read we attempted returned `400`, from a probe with a known bug.

   *Corrected 2026-08-06: the original text claimed this was "validated against
   production". It was not, then. See "The gate chain" — the 400 that was read as
   route confirmation is a generic binder error that any unmatched path produces,
   and it is not what upgraded this answer; the `200` is.*

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
   no credential handling.** The ticket's second acceptance criterion is now
   satisfied **in practice for the write**, and **one inference short of it for
   the token source** (**MEAL-137**, 2026-08-11): an in-page `fetch` performed a
   real add and got `200`, but it replayed a bearer *captured from the site's own
   request*, not one read from the global at call time. The call that did read the
   global reached the same service's application layer (`400`, where every bogus
   bearer got `403`), so the global holds a credential the origin treats as real —
   which is strong, and is not the byte comparison that would finish the argument.
   **One logged line on the next run closes it**; see "On that bearer" below.
   Nothing else in the rail's shape depends on the answer, but "no Okta flow,
   ever" does.

   *The 2026-08-06 version said "in principle only. No probe has confirmed it in
   practice", correcting a merged claim that described a probe nobody had run.
   The probe has now been run.* What is left is operational, not existential: the
   token is hydrated asynchronously and lives **45 minutes** (gap 5), and the
   page's own cart state does not observe our write, so the rail must confirm from
   the response rather than the DOM.

5. **The ~15-banner payoff argument survives.** The shared config lists **31
   banner hosts** — but 31 hosts is not 31 banners of payoff, and the original
   "stronger than the ticket claims" is withdrawn. Net new consumer brands over
   our `DOMAIN_MAP` is **4**, and realising them is a product decision, not a rail
   dividend. See "Does the payoff argument hold?".

**One thing the ticket gets wrong — and this document then over-corrected.** The
ticket describes the auth flow as `albertsons.okta.com/api/v1/authn` →
sessionToken → bearer. The live config says the IdP is **`ciam.albertsons.com`**
(`initOktaConfig.issuer`), so the 2026-08-06 text said the ticket's hostname was
stale. **The real token does not support that.** The accepted write's bearer
carries `iss: https://albertsons.okta.com/oauth2/ausp6soxrIyPrm8rS2p6` — the
hostname the ticket named and this document called stale. So "`albertsons.okta.com`
is stale" is **withdrawn**; the likeliest reading is that `ciam.albertsons.com` is
a custom domain over the same Okta org, but that is a guess and neither hostname
has been probed. An `iss` claim is an identifier, not a reachable endpoint. Either
way it is out of scope; we never mint a token. Noted only so nobody plans against
the wrong one — and nobody should plan against *either* without probing it first.

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

The three operations the ticket asks for. **The add is measured; the other two are
still bundle-only** — live probing cannot distinguish a real sub-path from a
made-up one (see "The gate chain"), so do not treat the anonymous probe transcript
as corroborating them.

| Operation | Call | Basis |
|---|---|---|
| **Add / update item** | `POST {cartAPI}/items` — see the measured contract below | **Measured. `200` from a real session, 2026-08-11.** |
| **Read cart** | `POST {cartAPI}/customer/{customerId}?type=mini&storeId=…&zipCode=…&cartCategoryList=…&expressChk=true` with body `{}` (a POST that semantically reads) | Bundle only. One attempt returned `400`, from a probe with a known bug. |
| **Remove item** | `DELETE {cartAPI}/items` with a body | Bundle only. Never attempted — deliberately: the probe undid its add through the site UI. |

#### The measured add contract

Captured with Copy-as-fetch from a real add on a signed-in `www.safeway.com`
session, then replayed with **only the product id changed**. The replay returned
**`200 OK`** (`Response { ok: true, status: 200, type: "basic" }`) and the item was
in the cart after a reload.

```http
POST /abs/pub/erums/cartservice/api/v2/cart/items
     ?storeId=654&serviceType=Dug&zipCode=94611&cartCategoryList=1P,3P_MARKETPLACE,1P_Wine

authorization: Bearer <the session's shop token — see the note below>
ocp-apim-subscription-key: c645e9387c654aa8ae253045f648bfac
content-type: application/json
ocp-apim-trace: true
sort-order: date

{"preferenceList":[{"cartCategory":"1P_WINE"}],
 "cartItemsList":[{"itemId":"<product id>","qty":1}],
 "cartCategory":"abs"}
```

Sent from the origin with `credentials: 'include'`, `mode: 'cors'`. The remaining
request headers in the capture split two ways: `priority`, the `sec-ch-ua*` /
`sec-fetch-*` set are **browser-controlled** — a `fetch` cannot set them, so a rail
gets them for free and identical to the site's own. `accept` and `accept-language`
are **ours to set** (neither is a forbidden header name) and the capture's values
are the Angular client's, worth copying if a mismatch ever turns out to matter.
`referrer` is a third case: `RequestInit.referrer` can set it, but the default is
the calling page's URL — so an in-page rail gets a sensible one automatically only
if it runs on a page whose URL resembles the site's own. In our WebView it does;
worth a glance if a call is ever refused for no other visible reason.

Read that against what this document previously asserted:

| The bundle said | The real add |
|---|---|
| `slotsRequired: true` + `x-swy-client-id: web-portal` were "the load-bearing piece" | **Neither header is sent at all.** `buildHeadersWithToken` is not the builder `/items` uses. |
| `generateCommonParams` always appends `expressChk=true` | **No `expressChk`.** No `tax`, no `sellerId`. |
| `cartId` set conditionally — a possible ownership binding | **No `cartId` anywhere**, query or body. Nothing in the request names a cart, so the add must bind to the account through the session context — the bearer, and possibly the cookies that rode along with it. |
| `serviceType=pickup` (what the anonymous curl probes guessed) | `serviceType=Dug` |
| Param order unknown | `storeId, serviceType, zipCode, cartCategoryList` |
| Body unknown — "do not invent it" | Above, verbatim. |

**On that bearer — say exactly what was and was not measured.** The token in the
accepted request came from the site's own add, captured with Copy-as-fetch; step B
changed only the product id, so it re-sent the *captured* value. **Nobody compared
it byte-for-byte with `window.AB.userInfo.SWY_SHOP_TOKEN`.** That the two are the
same value is the bundle's claim (`getSWY_SHOP_TOKEN()` returns exactly that
global, and the site's own chat widget labels it `okta_token`), and it now has
independent support — probe 2 read the global and used it to reach the
*application layer* (`400`, the status a real credential gets) where every bogus
bearer got `403`. So the global demonstrably holds a token the origin treats as
real. It is still an inference rather than an equality, and the whole "no Okta
flow, ever" conclusion rests on it, so it is worth the one line it costs to
settle: on the next run, log
`capturedBearer === window.AB.userInfo.SWY_SHOP_TOKEN`.

Two headers nobody predicted rode along: **`ocp-apim-trace: true`** and
**`sort-order: date`**. Both look like a generic interceptor rather than anything
add-specific, but they were in the accepted request, so a rail that reproduces the
capture should keep them until something shows they are inert.

**What this does not establish: that the bearer alone is sufficient.** Both the
capture and the replay ran `credentials: 'include'` from the origin, so cookies
went along either way, and neither was run without them. In a same-origin WebView
that costs us nothing — so it does not block the rail — but it is not measured and
is not written here as if it were. Likewise `preferenceList`: it may be required,
or it may be page state echoed along. Untested.

Note also what a *rail* still cannot see: the response **body**. The probe reported
`Response { ok: true, status: 200 }` without consuming it (`bodyUsed: false`), so
the status is known and the payload shape is not. That decides what a rail parses
back to confirm an add, and it is cheap to recover on the next authenticated run.

**And one thing the contract does not say at all: what `qty` means on a repeat.**
The bundle calls this operation "add / **update** item". Sending `qty: 1` twice for
the same `itemId` may leave one in the cart or two, and nothing here measured it —
the probe added one item, once. Everything else in the residue produces a failed
call; this one produces a **wrong cart**. Tracked as **MEAL-194**; see gap 1's
residue.

#### What the bundle says, kept for the record

The two builders below are what the 2026-08-06 version of this document treated as
the contract. **The add path does not use either of them.** They are retained
because they presumably still describe *some* cart call — the read and the delete
are unmeasured, and these are the only description of them we have.

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

And the headers, verbatim. The 2026-08-06 text called this "the load-bearing
piece"; the capture shows it is **not on the add path at all**:

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

**The `/items` request body is no longer unknown.** It is assembled from a product
object at click time rather than written literally in the bundle, so it was not
recoverable by reading — the 2026-08-06 text said "Probe 3 recovers it from a real
add. **Do not invent it.**" Probe 3 was run, and it did. The body is in the
measured contract above; nobody needs to invent it now.

*And the wider point that note carried still holds where it has not been measured.
The merged version called the body "the one part of the contract that is not
established"; it was not the only one, only the one we knew we were missing.
Of the rest — the two headers the bundle named (`slotsRequired`,
`x-swy-client-id`), a CSRF token, an owned `cartId`, a write-scoped token — the
capture settles all four: **none of those four is needed.** That is not "no header
is needed": `ocp-apim-subscription-key` is measured as required (its absence gets
a `401` from APIM), and `ocp-apim-trace` / `sort-order` were in the accepted
request and are unclassified. **Cookies it does not settle at all.** See "What
remains unknown", gap 1.*

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

**Confirmed populated, 2026-08-11 — and one entry of that list is wrong.** The
list was read off the bundle's accessors, not off a live object. Probe 2 ran on a
signed-in settled tab and, though it was defective in other ways, its request URLs
are evidence about the object it read them from:

| Field | Status |
|---|---|
| `SWY_SHOP_TOKEN` | **Populated.** The probe returns early on a falsy token and it did not — it reached the cart call. This is the first direct observation of the global being non-empty. |
| `customerId` | **Populated** — it appears in the cart-read path, and matches the token's `gid` claim. |
| `UUID` | **Populated** — it reached the search query, and it matches the token's `uuid` claim exactly. |
| `banner` | **Populated** — `banner=safeway` in the search query. Note this is the *storefront's* banner; the token's `ban` claim said `albertsons`. They disagree, and the storefront one is the one that was in a working page. |
| `shopZipcode` | **Absent or empty.** The probe sent `zipCode=`, which is what broke its **cart** leg. (Not its search leg — search sends no zip under any name, so that 400 has a different cause, most likely `storeid` or the unverified `channel` value.) |
| `shopStoreId` | **Unknown.** The probe falls back to `ui.storeId`, and `storeid` sits in the part of the query string Chrome elided from the middle of the pasted URL — unlike `uuid` and `banner`, which survived at the end. So a value reached the query and which field supplied it cannot be told apart. |
| everything else | **Unknown.** The `userInfo KEYS` dump was not captured. |

So the shape of the object is confirmed and its exact field names are not. **A rail
should read `SWY_SHOP_TOKEN`, `customerId`, `UUID` and `banner` from
`AB.userInfo`, and get store context from somewhere else** — pending the KEYS dump.
Fallback if the globals disappoint: the token's own claims carry `gid`, `ban`,
`str` and `zip` — but see the store-binding note below before trusting `str`/`zip`
for store context, because on the accepted write all three were wrong.

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

### What the real token turned out to say

**Added 2026-08-11.** The `SESSION` and `TOKEN READINESS` lines did not survive
probe 2, so hydration *timing* is still unmeasured. But the bearer from the
accepted write decodes, and its claims answer operational questions the bundle
could not. Decoded locally from the capture; the token itself is not recorded
here or anywhere in this repo, and it carries enough PII (email, phone, loyalty
number, household id) that it should not be.

| Claim | Value | Why it matters to a rail |
|---|---|---|
| `iat` → `exp` | 15:54:23Z → 16:39:23Z — **45 minutes** | A rail that reads the token once and holds it will break mid-run. Re-read the global on every call. |
| `auth_time` | **28.9 days** before `iat` | The user last typed a password 29 days before this token was minted, and `offline_access` is in `scp` — so the *likeliest* reading is that the page refreshes silently and expiry is a refresh problem rather than a re-login one. **This is an inference from one static token, not a measurement**: nobody watched a refresh happen, and nobody knows the refresh token's own lifetime or what the page does when it finally expires. Do not build an unbounded wait on it. |
| `scp` | `used_credentials, offline_access, email, openid, profile` | **No write scope.** Reads and writes use the same token, so a working read really would have predicted a working write here — but that was not knowable in advance, which is why gap 1 existed. |
| `aud` | `Albertsons` | One audience across the family. |
| `iss` | `https://albertsons.okta.com/oauth2/…` | See the IdP note in "Answers up front" — this is why "`albertsons.okta.com` is stale" is withdrawn. |
| `ban` / `str` / `zip` | `albertsons` / `177` / `83713` | **The token is not store- or banner-bound.** The accepted write ran against `storeId=654`, `zipCode=94611`, on `safeway.com`, with none of those three claims matching. Store context is per-request. That is good news for the family sweep — one session, any banner's store — and it means `str`/`zip` are **not** a usable source of store context. |

The design consequence, restated because it is the one that will bite: **re-read
`window.AB.userInfo.SWY_SHOP_TOKEN` before every call, and treat a stale or absent
read as an expected state to wait on rather than an error to surface — but wait
with a bound.** A signed-out session and a still-hydrating one look identical from
the global, and the 29-day `auth_time` says only that this *particular* session had
not needed a re-login; it does not promise the next one will not. An unbounded wait
turns "you need to sign in again" into a hang, which is the failure mode
`albertsons.ts` already documents for the login check. Bound it, then fall back to
the signed-out path.

### The SPA does not observe an API add

**Added 2026-08-11, and it is a trap worth naming loudly.** After the accepted
write, *the cart badge did not move until the page was reloaded.* The write landed
server-side — the item was there after the reload — but the SPA's local cart state
never saw it.

So **any post-add verification that reads the DOM will produce a false negative.**
A rail must confirm from the response, or force a reload before reading the page.
This is the same shape of mistake as MEAL-28, which shipped to two of six stores
with every number in its report correct; here it would have been very easy to
build a rail that "verified" every successful add as a failure and retried it —
which on a cart is not a harmless retry.

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

> **⚠️ Disconfirmed 2026-08-11 — read the subsection immediately below before
> using this paragraph.** A real token gets a `400` where a bogus one gets `403`,
> which a presence-only filter cannot do. The origin validates. The reasoning here
> was sound on the evidence it had; the evidence was one-sided.

**Withdrawn: "the bearer is the only remaining gate."** It is *a* gate. Whether it
is the last one is unmeasured — see gap 1. The rail may still need `slotsRequired`,
`x-swy-client-id`, cookies, a CSRF token, an owned `cartId`, or a token with the
right audience for writes, and this transcript would look identical in every one
of those worlds.

So: the rail is not blocked by bot defence at these volumes, and the app tier does
see our requests. It is *plausibly* gated by ordinary OAuth on a token that lives
in the page — but that is a hypothesis about acceptance drawn entirely from
refusals, and refusals do not license it.

#### Measured 2026-08-11 — and the model above is *wrong*

The inference above — "a filter branching on the **presence** of a Bearer, not one
verifying signature, expiry or audience" — was drawn from byte-identical 403s, and
a real session refutes it. Read the last two rows against the first two:

| Credential | Same endpoint family | Measured from |
|---|---|---|
| **no** `Authorization` header at all | `401 "Not Authorized"` | anonymous `curl`, 2026-08-06 |
| bogus, or JWT-shaped-but-unsigned | `403`, byte-identical bodies | anonymous `curl`, 2026-08-06 |
| **a real `SWY_SHOP_TOKEN`** | **`400 Bad Request`** — past the filter, into the application layer | **in-page, signed in, 2026-08-11** |
| a real token **plus a correct request** | **`200`** | **in-page, signed in, 2026-08-11** |

Only the bottom two rows are new. The top two are the 2026-08-06 transcript,
repeated here because the comparison is the whole point.

**The 2026-08-06 model is not confirmed by this, and it is not cleanly refuted
either. Say what the table can and cannot carry.**

*What it refutes:* the strong reading of "presence-only filter" — that the gate
looks *only* for the string `Bearer ` and branches on that alone. Under that
reading a real token is exactly as present as a bogus one and would get the same
`403`. It does not.

*What it cannot establish:* that the **token** is what the gate read. Rows 1–2 are
anonymous `curl` from off-origin; rows 3–4 are an in-page `fetch` with
`credentials: 'include'`. **Four things changed at once** — the token, the cookie
jar, `Origin`/`Referer`, and same-origin-ness. A gate that short-circuits on a
valid session cookie and never parses the bearer produces this identical table.

That is precisely the inference this document refuses two sections down for the
search tarpit ("cookies, an `Origin`/`Referer`, a session, and a same-origin path
all changed at once between the hanging `curl` and the answering `fetch`"). It is
the same confound and it gets the same treatment here. An earlier 2026-08-11 draft
of this section made the inference anyway and asserted "the origin validates";
that is withdrawn.

**What is established, and it is enough to budget the rail:** a real signed-in
session, calling from the page, reaches the application tier and gets a `200` for
a correct request. *Why* the anonymous probes never did — bearer, cookies, origin,
or some conjunction — is unresolved and does not change the rail's shape, because
a WebView on the user's own session supplies all of them together.

**The one-word experiment that would resolve it** is now cheap and worth doing on
the next authenticated run: replay the captured add with `credentials: 'omit'`. It
also settles the cookie-necessity residue in gap 1, in the same run as the `qty`
test. If it still `200`s, the bearer is doing the work and "the origin validates"
can be written down as measured.

The narrow observation the 2026-08-06 reasoning was built on survives untouched:
garbage and a well-formed-but-unsigned JWT are indistinguishable in the response.
That fits a validating gate (both invalid, one refusal) and a cookie-short-circuit
gate (neither had a cookie) equally well. The missing `WWW-Authenticate` remains
non-compliant with RFC 6750 and remains unexplained.

What is **not** confirmed is that nothing else is required. Four of the specific
extra gates gap 1 named turned out to be absent (`slotsRequired`,
`x-swy-client-id`, CSRF, `cartId`), and the token needs no write scope — but
`ocp-apim-subscription-key` is measured as **required** — its absence is the APIM
`401` in the anonymous transcript at the top of this section (`"Access denied due
to missing subscription key"`), which is a different refusal from the
missing-bearer `401` in the table just above — `ocp-apim-trace` and `sort-order`
rode along unclassified,
and cookies are untested. "The bearer is the only remaining gate" stays withdrawn.

*The `400` came from probe 2, which was **defective**: it derived `storeId` /
`zipCode` from `ui.shopStoreId` / `ui.shopZipcode`, sent an empty `zipCode`, and
sent no `serviceType` at all. Those 400s are the probe's bug, not origin
behaviour, and they say nothing about whether `POST /cart/customer/{id}` is a real
route. Their only value is the status-*class* signal in the table above.*

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

**Partly answered 2026-08-11 — it does not tarpit in-page.** Probe 2's search leg
ran from a signed-in `www.safeway.com` tab and returned **`400 Bad Request`**,
promptly. Not a hang. Same operation (`/abs/pub/xapi/search/products`) that never
returns a byte to plain `curl`.

Be precise about what that buys, because it is less than it looks:

- **It rules out "the operation is dead upstream."** Something answered, from the
  environment we would ship in.
- **It does not show search works in-page.** A `400` is a refusal, and probe 2's
  search params were built from the same non-existent `userInfo` fields that broke
  its cart leg, so a `400` is roughly what a defective request should get. We have
  never seen a product-search `200` with a non-zero doc count from any client.
- **It does not distinguish the two branches** — cookies, an `Origin`/`Referer`, a
  session, and a same-origin path all changed at once between the hanging `curl`
  and the answering `fetch`. Which of them the edge cares about is unmeasured.

Gap 3 therefore narrows to: *get a search `200` from anywhere.* That is not a
one-line fix, because **we do not know which param the search leg got wrong** —
its 400 cannot be blamed on the empty `zipCode` that broke the cart leg, since
search sends no zip at all. The leading candidates are `storeid` (built from the
same suspect `userInfo` fields) and `channel`, whose accepted values nothing has
verified — `pickup` is a guess, and the cart path's analogous param turned out to
want `Dug`. **They are not the only ones**, and if a run 400s on every `channel`
the next suspects are the two places the probe knowingly differs from the bundle:
`request-id` is `Date.now()` where the bundle calls `_getUTCTimeStampRandom()`, and
`pageurl`/`url` go through `URLSearchParams` percent-encoding where the bundle
concatenates them raw. Neither is obviously load-bearing; both are free to align. Probe 2 below now **tries both `channel` values** and warns loudly if
`storeid` is undefined, so one run distinguishes them; it also no longer aborts
the search leg when the *cart* leg's store context is missing, which is how the
2026-08-11 run could have come back with gap 3 unmeasured a second time. Until one
of these yields a `200`, the rail's **search** half is unproven even though its
**cart** half is measured.

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
as more settled than the evidence supports.

**Updated 2026-08-11: gaps 1 and 2 are closed, 3 and 5 are narrower, and gap 4 is
exactly where it was.** Gap 4 could still sink the rail on its own, and it is now
the *only* one that could. What is left of gaps 1, 3 and 5 shapes the rail rather
than vetoes it.

1. ~~**No authenticated call has been observed succeeding.**~~ **CLOSED
   2026-08-11 — MEAL-137.** A real session performed a real add and got `200`,
   with the item present after a reload. Every measurement in the 2026-08-06
   document was a *refusal* — 401, 403, 400, 404, a hang — and per the gate-chain
   correction, a refusal tells us nothing about acceptance; this is the first
   acceptance. MEAL-12 declared the same gap for H-E-B
   (`docs/heb-graphql-persisted-queries.md:267-268`: "Mutations specifically may
   carry extra requirements (a CSRF token, an order/cart id, store-context
   headers)"), and here every one of those turned out to be unnecessary:
   - `slotsRequired` and `x-swy-client-id` — **not required. Not even sent.**
   - **CSRF** — no header, no body field. None exists on this path.
   - **`cartId` ownership binding** — no `cartId` is sent at all, so nothing in
     the request names a cart; the binding comes from the session context
     (bearer, possibly cookies — see the residue below). (The `t && !e.seller`
     conditional in `generateCommonParams` is still unexplained, but it is not on
     the add path.)
   - **Write scope** — none. `scp` is the same for reads and writes.

   **Residue. One piece of it blocks, the rest do not:**
   - **`qty` semantics on a repeat add — absolute or additive? BLOCKING for any
     rail that can send the same `itemId` twice.** The endpoint is `POST /items`
     and the bundle calls it "add / **update** item", so `qty: 1` sent twice may
     leave 1 or 2 in the cart. **Nothing measured this**: the probe added one item
     once. Every other unknown on this page produces a failed call you can see;
     this one produces a *wrong cart* you cannot — and a retry after an ambiguous
     response, or two meals sharing an ingredient, lands on it immediately. Both
     possible answers break a cart governing principle (never over-add, never
     under-add) if the rail assumes the other. It is cheap to settle — add the
     same id twice, read the cart — and it must be settled before a rail retries
     anything, which is why it is called out here rather than left as a detail of
     the contract. Tracked with gap 6 below.
   - **Cookies.** Both the capture and the replay ran `credentials: 'include'`
     from the origin, so cookie *necessity* is untested. Free in a same-origin
     WebView; still not established — and **cheap to settle**: replay the same
     capture with `credentials: 'omit'`. It is worth doing not for the rail, which
     has cookies either way, but because it is the only thing that separates "the
     origin validates our bearer" from "the origin trusts our session cookie" in
     the gate chain above.
   - **`preferenceList`** — required, or page state echoed along? Untested.
   - **The response body.** The `200` was reported without consuming the body, so
     what a rail parses back to confirm an add is still unknown. Cheapest thing to
     collect on the next authenticated run — and note it interacts with the `qty`
     question above: if the response echoes the resulting quantity, one run
     answers both.

2. ~~**The `/items` request body.**~~ **CLOSED 2026-08-11.** Recovered by probe 3
   with Copy-as-fetch; it is in "The measured add contract" above. Nobody needs to
   invent it.

3. **Whether product search actually works, and why it tarpits from a plain
   client.** Narrowed 2026-08-11: it does **not** tarpit in-page — it returned
   `400` promptly from a signed-in tab — but that was a defective request and no
   client has yet seen a product-search `200`. So the cause of the plain-client
   hang is still open (upstream dependency vs edge posture, the second branch
   partially contradicting Answer 3), and the rail's **search half is unproven**
   while its cart half is measured. Fix probe 2's params and re-run.

4. **Rate limiting / Imperva behaviour under sustained programmatic load is
   untested, and this is the largest unknown on the list rather than the
   smallest.** A handful of anonymous probes is not a rail doing 30 authenticated
   adds; Imperva profiles behaviour, not just tokens, and it is demonstrably in the
   path here (`x-cdn: Imperva`, `x-iinfo` on every response). It is also the failure
   mode that would surface late and expensively — after a rail is built, in
   production, on real users' carts. Measure it no later than the authenticated
   probe in gap 1. Tracked as **MEAL-115**.

   **Untouched by the 2026-08-11 measurement, and now the only gap that can sink
   the rail outright** (gap 6 does not sink it — it constrains what the rail is
   allowed to do until answered). One accepted add is not sustained load; if
   anything, closing gap 1
   raises this one's urgency, because it removes the reason not to build and
   therefore brings forward the day we find out. Nothing below the "Closing the
   gap" heading measures it — it needs its own volume test.

   *This is deliberately worded to match MEAL-12's gap 4
   (`docs/heb-graphql-persisted-queries.md:271-276`). Same risk, same platform
   posture, same priority — and the merged version of this document gave it a
   bullet where MEAL-12 gave it a number.*

5. **Token readiness — and now, token lifetime.**
   `window.AB.userInfo.SWY_SHOP_TOKEN` is populated asynchronously, so "the token
   is in the page" is true of a settled tab and not necessarily true at the moment
   a rail wants to read it. **Hydration timing is still unmeasured** — probe 2's
   `TOKEN READINESS` line was not captured.

   *Sharpened 2026-08-11:* the captured JWT lives **45 minutes** — measured, from
   `iat` and `exp` — so expiry mid-run is not hypothetical for a long cart.
   Whether the page then refreshes silently is **inferred, not measured**:
   `offline_access` is in `scp` and `auth_time` was 29 days before `iat`, which
   together make a silent refresh the likeliest reading, but nobody watched one
   happen. Re-reading the global before every call handles the expiry and the
   hydration case alike — **with a bound**, because a session that genuinely needs
   a re-login is indistinguishable from a slow one, and an unbounded wait turns
   that into a hang. See "What the real token turned out to say". Operational
   rather than existential — it shapes the rail, it does not veto it.

6. **What `qty` means on a repeat add. Added 2026-08-11, and it is a correctness
   prerequisite rather than a feasibility one.** `POST /items` is "add / **update**
   item"; sending `qty: 1` twice for one `itemId` may leave 1 or 2 in the cart, and
   nothing has measured which. Unlike everything else here, both answers *work* —
   they just produce different carts, and a rail that assumes the wrong one
   silently over- or under-adds. That is the failure the cart governing principles
   exist to prevent, and it is invisible in a `200`.

   **This does not gate whether the rail is buildable; it gates whether the rail
   may retry, or add the same item from two meals, before it is answered.** Two
   minutes on the next authenticated session settles it: add the same id twice,
   read the cart. Cheaper than any of the alternatives, including finding out from
   a user.

   ✅ **Ticketed 2026-08-14 as MEAL-194** (p1 spike, 1 day), alongside gaps 1 and
   4 (**MEAL-137**, **MEAL-115**). It was unticketed for three days, which is
   exactly how a correctness prerequisite ends its life as a paragraph nobody
   re-reads. Whoever picks up the Albertsons rail: settle MEAL-194 before you
   write the add path, not after. The same class of bug is already live on HEB
   (**MEAL-185**), so the wrong guess here is not hypothetical.

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
  it covers the family. *Updated 2026-08-11:* gap 1 (**MEAL-137**) is closed, so
  **gap 4 (sustained load, MEAL-115) is now the sole *feasibility* risk** — gap 6
  (`qty` on a repeat) is a correctness prerequisite, not a feasibility one — and this
  section's own claim is untouched by that, because the family sweep is still
  unrun and the accepted write happened on exactly one banner.
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

Everything in the 2026-08-06 document was established without an account, and all
of it was a refusal. **Probe 3 has since been run and it closed gaps 1 and 2** —
see "The measured add contract". What is left still needs a logged-in
Albertsons-family session.

Still open, mapped to "What remains unknown": (3) whether product search returns
anything — probe 2's search leg needs its params fixed and re-run; (5) when the
token is actually readable after a load; (6) what `qty` means on a repeat add,
which does not sink the rail but must be answered before it retries anything.

Plus three things that are not numbered gaps and would otherwise fall off the
list — all of them one line each on the next authenticated session:

- **The add's response body.** The `200` was logged without consuming it.
- **`capturedBearer === window.AB.userInfo.SWY_SHOP_TOKEN`.** The one comparison
  that turns "no Okta flow, ever" from inference into measurement.
- **The read and remove operations.** `POST /cart/customer/{id}` and
  `DELETE /items` are still bundle-only; only the *add* was confirmed. Probe 2's
  cart leg attempts the read; nothing attempts the remove, on purpose.

- **Whether cookies are required.** *Corrected: an earlier draft called this
  "not testable without deliberately breaking a working request". That is wrong,
  and it was the excuse for leaving it open.* Replay the captured add with
  `credentials: 'omit'` — one word, fully reversible, and it rides along with the
  `qty` test on the same session. A `200` means the bearer is doing the work and
  settles the gate-chain question above too; a `403` means cookies are load-bearing
  and the rail must stay same-origin, which it already is.

`preferenceList` is the one that genuinely waits for a reason: dropping it is also
a one-word test, but unlike the others a wrong answer there silently changes what
lands in the cart rather than failing visibly.

Gap 4, sustained load, is **MEAL-115**, is not closed by any probe below, and
after 2026-08-11 is the only remaining gap that can sink the rail outright — it
needs its own volume test.

**Probe status:** probe 1 — not run. Probe 2 — run 2026-08-11, **defective**, see
its own note. Probe 3 — **run 2026-08-11, succeeded.**

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

> **Run 2026-08-11 — and it was defective. Fixed below; re-run before quoting it.**
>
> Both request legs returned `400`. **The cart leg's 400 is this probe's bug
> rather than origin behaviour**: it built store context from `ui.shopStoreId` /
> `ui.shopZipcode`, which do not appear to exist on a real `userInfo` — it sent an
> empty `zipCode` and no `serviceType` at all. **The search leg's 400 is not
> explained by that**, since search sends neither param; its cause is still open
> (see the tarpit section — `storeid`, `channel`, or an omitted `uuid`/`banner`).
> The version below takes store context from the values the accepted add actually
> used, falls back through several field names, and **refuses to send store
> context it could not resolve** — skipping a leg with an instruction beats
> quietly producing another uninterpretable 400.
>
> Two results from that run survive the bug, because they are status-*class*
> signals rather than payloads: a real bearer reaches the app tier (`400`, not the
> `403` every bogus bearer got — see the gate chain), and product search **answers
> in-page instead of tarpitting** (see the tarpit section). The `SESSION` and
> `TOKEN READINESS` lines were not captured, so gap 5 is still open, and the
> `userInfo KEYS` dump was not captured either — which is the single most useful
> line to bring back next time, since it is what would have caught this bug.

```js
// MEAL-15 probe. Read-only. Run on a logged-in www.<banner>.com tab.
(async () => {
  // ── 1. Is the session really readable from the page, and WHEN? ────────────
  // POLL, do not read once. On the hard-reload run this probe asks for, AB.userInfo
  // is often not there yet — and aborting on that would kill the run in exactly the
  // state gap 5 exists to measure, which is the mistake the token read below was
  // already fixed for. How long it takes to appear IS the measurement.
  const tStart = performance.now();
  let ui = window.AB?.userInfo, waitedMs = 0;
  while (!ui && waitedMs < 10000) {
    await new Promise(r => setTimeout(r, 100));
    waitedMs = Math.round(performance.now() - tStart);
    ui = window.AB?.userInfo;
  }
  if (!ui) return console.error('window.AB.userInfo never appeared in 10s — are you on a banner ' +
                                'storefront page (not /erums/cart), signed in? If you ARE, that is ' +
                                'itself the finding: report it.');
  console.log(`AB.userInfo READY after ${waitedMs}ms` +
              (waitedMs ? ' — it was NOT there on first read. Report this number: it is gap 5.' : ' (present immediately)'));

  // Everything on the object, not just the fields we expected. Cheap, and the
  // fastest way to spot something the rail needs that this doc never named.
  // Object.keys alone would miss the case that matters most here: the bundle
  // describes AB.userInfo entirely through accessors (getShopStoreId(),
  // getBanner(), getUUID()), so the fields may be prototype getters or
  // non-enumerable — invisible to Object.keys, and invisible is exactly how the
  // 2026-08-11 run concluded shopZipcode "does not exist". Walk the chain.
  const allKeys = (o) => { const out = new Set(); 
    for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p))
      for (const k of Object.getOwnPropertyNames(p)) out.add(k);
    return [...out].sort(); };
  console.log('userInfo KEYS (own, enumerable):', Object.keys(ui).sort().join(', '));
  console.log('userInfo KEYS (incl. prototype + non-enumerable):', allKeys(ui).join(', '));
  // If those two lines differ, the difference IS the answer to "what are the real
  // field names" — report both.

  const snap = () => { const t = window.AB?.userInfo?.SWY_SHOP_TOKEN;
                       return { hasToken: !!t, len: t ? t.length : 0 }; };
  const t_immediate = snap();

  const tok_immediate = ui.SWY_SHOP_TOKEN;
  const sess = { hasToken: !!tok_immediate, tokenLen: tok_immediate ? tok_immediate.length : 0,
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

  // RE-READ after the wait, and use THAT below. Reading once up top and gating on
  // it down here would abort the whole probe in exactly the run this document
  // asks for — the hard-reload one, where an absent-then-present token is the
  // finding rather than a failure. Which is also the rail's rule: re-read, never
  // cache. Note `ui` is captured, so re-read through window in case the object
  // itself was replaced rather than filled in.
  const ui2 = window.AB?.userInfo ?? ui;
  const tok = ui2.SWY_SHOP_TOKEN;
  // Do NOT return here. The CART leg needs the token; SEARCH sends no bearer at
  // all and is the leg gap 3 turns on. Aborting everything on a missing token is
  // the third version of the same mistake this probe has now made twice.
  if (!tok) console.error('No SWY_SHOP_TOKEN, even 3s after load — the CART leg below will be ' +
                          'skipped. Sign in, or wait longer and re-run. (Search still runs: it ' +
                          'sends no bearer.)');
  if (tok && !tok_immediate) console.warn('GAP 5 CONFIRMED: the token was ABSENT on the first read and ' +
                                          'present 3s later. A rail must wait for hydration. Report this line.');

  // STORE CONTEXT. The 2026-08-11 run read ui.shopStoreId / ui.shopZipcode, which
  // appear to be absent or empty on a real userInfo — it sent zipCode= and its
  // cart leg 400'd uninterpretably. Try several names for each.
  //   `||`, not `??`: an empty string is not a usable value for any of these, and
  //   the whole point is to fall through to the next candidate rather than to
  //   carry '' forward the way the run that broke did.
  //   TWO chains, because the bundle uses two different accessors and this probe's
  //   own rule is one evidence source per leg:
  //     cart   — generateCommonParams: `primaryStoreId ? primaryStoreId : storeId`.
  //              It never mentions shopStoreId.
  //     search — getShopStoreId(), i.e. shopStoreId.
  //   They are probably the same value; if they are not, feeding the search
  //   accessor to the cart call is exactly the mixing that produces a 400 nobody
  //   can attribute. Log both and let the difference be visible.
  // HARD-CODE HERE if the log below shows undefined — that is the intended fix,
  // and reporting the KEYS line alongside what you hard-coded is the finding.
  const cartStoreId   = ui2.primaryStoreId || ui2.storeId || ui2.preferredStoreId;
  const searchStoreId = ui2.shopStoreId || ui2.storeId || ui2.preferredStoreId;
  const storeId = cartStoreId;   // name kept for the cart leg below
  if (cartStoreId !== searchStoreId)
    console.warn('STORE ID: cart and search accessors DISAGREE —',
                 { cart: cartStoreId, search: searchStoreId },
                 '— report this; it decides which one a rail reads.');
  const zip     = ui2.shopZipcode || ui2.zipCode || ui2.zipcode || ui2.postalCode;
  const svc     = ui2.serviceType || 'Dug';   // fallback value from the measured add; 'pickup' was the old guess
  console.log('STORE CONTEXT:', { storeId, zip, serviceType: svc,
                                  svcFromPage: !!ui2.serviceType });
  // Each leg is gated on what IT needs, not on the union: the cart read needs a
  // zip and search does not, and aborting the whole probe over a missing zip is
  // how a run comes back with gap 3 still unmeasured.

  const CART    = '/abs/pub/erums/cartservice/api/v2/cart';
  const CART_KEY   = 'c645e9387c654aa8ae253045f648bfac';   // from initErumsConfig
  // NOTE: the prefix above is corroborated (config blob, bundle, and a live APIM
  // 404 for the sibling /basket/items). The sub-paths this probe calls are NOT —
  // they come from the bundle alone, and anonymous probing cannot tell `/items`
  // from `/items-typo`. A 404 here is therefore a real result worth reporting,
  // not a mistake in the probe.
  const SEARCH_KEY = 'e914eec9448c4d5eb672debf5011cf8f';   // from initSearchConfig

  // ── 2. CART READ. POST, but semantically a read — adds nothing. ───────────
  // ONE evidence source per leg — do NOT mix them. This is the READ path, and
  // the only description of it is the bundle, so this sends what the bundle says:
  // buildHeadersWithToken's slotsRequired + x-swy-client-id, and expressChk.
  // The 2026-08-11 measurement showed all three are absent from the ADD path, but
  // the add is a different endpoint and nothing measured the read. A hybrid of
  // the two produces another 400 nobody can attribute, which is exactly the trap
  // the run below fell into.
  // If this 400s or 403s: re-send with the measured add-path header set instead
  // (drop slotsRequired + x-swy-client-id and expressChk, add ocp-apim-trace:
  // true and sort-order: date). That pair of runs is the experiment — either one
  // alone is not.
  // serviceType is new here and is NOT borrowed from the add: generateCommonParams
  // sets it for every cart call, and the 2026-08-11 run simply omitted it. Only the
  // FALLBACK VALUE ('Dug') comes from the add measurement, and only when the page
  // does not supply one — watch svcFromPage above.
  // customerId is in the PATH, so a missing one silently requests
  // /cart/customer/undefined — the same uninterpretable-refusal trap as an empty
  // query param, and harder to spot. Guarded with the rest. (It was populated on
  // 2026-08-11; the field name is still only observed once.)
  const custId = ui2.customerId || ui2.customerID || ui2.guid;
  if (!tok || !storeId || !zip || !custId) {
    console.error('CART READ skipped — unresolved:',
                  [!tok && 'SWY_SHOP_TOKEN', !storeId && 'storeId', !zip && 'zipCode',
                   !custId && 'customerId'].filter(Boolean).join(', '),
                  '— a 400 from here would tell us nothing. Hard-code above and ' +
                  're-run. (Search below still runs.)');
  } else {
  const cartQs = new URLSearchParams({
    type: 'mini', storeId, serviceType: svc, zipCode: zip,
    cartCategoryList: '1P,3P_MARKETPLACE,1P_Wine', expressChk: 'true' });
  const cr = await fetch(`${CART}/customer/${custId}?${cartQs}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Ocp-Apim-Subscription-Key': CART_KEY,
               'authorization': 'Bearer ' + tok,
               'slotsRequired': 'true',
               'x-swy-client-id': 'web-portal',
               'Content-Type': 'application/json' },
    body: '{}' });
  const cartTxt = await cr.text();
  console.log('CART READ:', cr.status, cartTxt.slice(0, 700));
  // Keep the cartId — not because an add needs it (the measured add sends none),
  // but because its presence or absence is the last unexplained bit of
  // generateCommonParams.
  try { const j = JSON.parse(cartTxt);
        console.log('cartId candidates:', JSON.stringify(j).match(/"cartId":"[^"]+"/g)?.slice(0,3)); } catch {}
  }

  // ── 3. SEARCH. Does it work in-page, where plain curl tarpitted? ──────────
  // Runs even if the CART leg was skipped: search sends no zip, so a missing zip
  // must not cost us gap 3 a second time. It does need storeid — the 2026-08-11
  // search 400 cannot be blamed on the empty zipCode that broke the cart leg,
  // because search never sends one, so `storeid` and `channel` are the two live
  // suspects. This loop varies `channel`, the cheaper one to rule out.
  const base = location.origin;
  if (!searchStoreId) {
    console.error('SEARCH skipped — storeid unresolved, and a 400 without it is ' +
                  'exactly as uninterpretable as the 2026-08-11 one. Hard-code ' +
                  'storeId above and re-run: this is the leg gap 3 turns on.');
  } else {
  // `channel` is the bundle's `fulfillmentType`, a different param from the cart's
  // `serviceType`, and NOTHING has verified its accepted values. 'pickup' is the
  // original guess; 'Dug' is what the cart path turned out to want; ui2.serviceType
  // is whatever the page itself thinks. Try all three, deduped.
  // uuid and banner: OMIT rather than send empty. `uuid=` is the same trap as the
  // `zipCode=` that made the 2026-08-11 cart 400 unreadable — an empty value is a
  // value, and its refusal gets misattributed to whichever param we happened to
  // be varying. Both were populated on 2026-08-11, so a miss is itself news.
  const uuid       = ui2.UUID || '';
  const banner = ui2.banner || '';
  // NO hostname fallback. `location.hostname.split('.')[1]` looks right for
  // www.safeway.com and is wrong wherever the host and the banner token differ
  // (shopunitedsupermarkets, carrsqc, kingsfoodmarkets…), and a WRONG banner is
  // worse than an absent one: it produces a 400 we would misattribute to storeid
  // or channel. Same rule as uuid — omit, and say so.
  console.log('SEARCH inputs:', { storeid: searchStoreId, uuid: uuid || '(omitted)',
                                  banner: banner || '(omitted)' });
  if (!uuid || !banner) console.warn('SEARCH: omitting', !uuid ? 'uuid' : '', !banner ? 'banner' : '',
    '— absent from userInfo. If this 400s, that omission is a suspect alongside ' +
    'storeid and channel. Read the real value off a search request in the Network tab.');
  for (const channel of [...new Set(['pickup', 'Dug', svc])]) {
    const sQs = new URLSearchParams({
      pageurl: base, url: base, 'request-id': String(Date.now()), pagename: 'search',
      rows: '5', start: '0', 'search-type': 'keyword', storeid: searchStoreId,
      q: 'tortillas', dvid: 'GhXAoLXN-ss-search', channel,
      featured: 'false', includeOffer: 'true',
      ...(uuid   ? { uuid }   : {}),
      ...(banner ? { banner } : {}) });
    const t0 = performance.now();
    try {
      const sr = await fetch(`/abs/pub/xapi/search/products?${sQs}`, {
        credentials: 'include',
        headers: { 'ocp-apim-subscription-key': SEARCH_KEY, accept: 'application/json' } });
      const st = await sr.text();
      console.log(`SEARCH [channel=${channel}]: ${sr.status} in ${Math.round(performance.now()-t0)}ms`,
                  st.slice(0, 500));
      try { console.log('product count:',
        JSON.parse(st)?.primaryProducts?.response?.docs?.length); } catch {}
    } catch (e) {
      console.error(`SEARCH [channel=${channel}] threw after ${Math.round(performance.now()-t0)}ms —`,
                    'if this hung ~30s the tarpit is not client-shaped:', e);
    }
  }
  }
})();
```

**How to read it — the table is the deliverable:**

| Outcome | Meaning |
|---|---|
| `hasToken: true` with a long token, and a real `customerId` | **The core premise is confirmed** — and was, on 2026-08-11. The session is readable in-page; no Okta flow needed, ever. Note `shopStoreId` is **not** part of this signal: it may well come back `undefined`, which is a finding about the field name and not a failure. The `STORE CONTEXT` line is where to look for that. |
| `TOKEN READINESS` differs between the immediate read and the 3s read | **Gap 5 confirmed.** The rail needs a hydration wait, not a single read. Record how long it took. |
| `STORE CONTEXT` shows `undefined` and a leg logs "skipped" | **A result, not a failed run** — and the most useful one available, because it means the field names in this document are wrong and the `KEYS` dump has the right ones. Each leg skips independently: a missing zip costs you the cart read only, a missing `storeId` costs you both. Read the values off the `KEYS` line or off a real cart request in the Network tab, hard-code them, re-run. Report the KEYS line **and** what you hard-coded. |
| `GAP 5 CONFIRMED` in the log | The token was absent on the first read and present 3s later — **the finding this probe exists for**, and only visible on a hard-reload run. The probe continues rather than aborting, so the rest of the run is still valid. Report the line verbatim. |
| `TOKEN READINESS` identical, both `hasToken: true`, **and** `AB.userInfo READY (present immediately)` | Inconclusive, **not** a refutation — you were on a settled tab. Hard-reload and re-run as the first action to actually test this. |
| `TOKEN READINESS` identical but `AB.userInfo READY after <n>ms` | **Not inconclusive — that `n` is the hydration window**, and the probe spent it waiting for the object before it ever read the token. Report `n`; a rail needs to survive it. |
| `window.AB.userInfo never appeared in 10s` | You are on `/erums/cart` or another sub-app rather than the storefront. Go to the banner homepage and retry. Not a negative result. Note the cart page *does* carry the token globals, but not the config blobs — so if you were on the storefront and still saw this, it *is* a result: report it. |
| **CART READ `200` + JSON containing your hand-added item** | **The read half works** — this is what the 2026-08-11 run failed to get, from its own bug. Note it is *not* what closes gap 1: a read is not a write. Gap 1 was closed by probe 3. |
| CART READ `401` "Not Authorized" | The token was rejected or absent. Check `tokenExpiration`; reload to refresh and retry. Given the 45-minute lifetime, a token that worked ten minutes ago can be the cause. |
| CART READ `403` | **More diagnostic than it was.** A real in-page session is measured to get *past* the 403 — to a `400` — so a `403` from a signed-in tab means your credential context is not what the site's own calls carry. Most likely the token (check you read `SWY_SHOP_TOKEN` and not a stale variable), but cookies and origin are not ruled out as the thing the gate reads. |
| CART READ `400` naming a param | We reached the service and only the arguments are wrong. **Do not report this as a result until you have fixed it and re-run** — the 2026-08-11 run stopped here and its 400s carry no information about the endpoint. |
| SEARCH `200` with a non-zero product count | **The tarpit was client-shaped, not a block.** Search works in-page and the rail's search half is settled. **Nobody has seen this yet** — it is the main thing this probe is still for. |
| SEARCH `400` on **every** `channel` value | `channel` is *less likely* — not ruled out, since all the values tried are guesses from a domain nothing has enumerated. Move to the other suspects: `storeid` (check the `STORE CONTEXT` line and hard-code a real one), and any param the warning above says was omitted. |
| SEARCH `400` on some `channel` values and `200` on another | **Gap 3 closed and the param named.** Record which value won; the cart path's analogue turned out to be `Dug` where everyone assumed `pickup`, which is exactly why the probe now sweeps them. |
| `SEARCH skipped` | `storeid` could not be resolved. Not a result about the endpoint — hard-code a store id above and re-run, because this is the leg gap 3 turns on. |
| SEARCH hangs in-page too | Did not happen on 2026-08-11, so this is now unlikely — but if it recurs the tarpit is real and server-side. **Fall back to `/abs/pub/xapi/search/autosuggest`**, which is measured working anonymously, or keep DOM scraping for search and use the network rail only for cart. Materially narrows the rail — file it. |
| SEARCH `401`/`403` | Search needs auth after all, contradicting the bundle. Add `authorization: Bearer` and re-run. |
| Anything with `x-iinfo` and an Imperva HTML body | Imperva challenged you. Reload the page and retry; if it recurs under repetition that is the load finding, and it is important. |

### Probe 3 — capture a real add, then perform one. ✅ RUN 2026-08-11.

**This one was run and it worked.** Kept in full because it is the procedure that
produced the measured contract, because it is the template for doing the same on
the next banner, and because one of its steps is not optional (step B's undo).

> **Result, 2026-08-11, `www.safeway.com`.** Step A captured the add. Step B
> replayed it with only the product id changed and got **`200 OK`**; the item was
> in the cart after a reload, and *only* after a reload — the badge did not move
> on its own. Step B is what closed gap 1. The contract it produced is in "The
> measured add contract"; the JWT it produced is in "What the real token turned
> out to say". **What it did not collect: the response body** (the `Response` was
> logged without being consumed) and the `SESSION` / `TOKEN READINESS` / `KEYS`
> lines from probe 2. Those are the shopping list for the next run.

The merged version framed this as "the `/items` POST body is the **only** part of
the contract still unknown". It was not — see gap 1. The body was the smaller
half; the larger half was that **nothing had observed an authenticated write being
accepted at all**. This probe was changed to settle both in one pass, and did.

**Step A — capture. Use "Copy as fetch", not a hand-transcribed body.**

1. On a logged-in banner tab, open DevTools → **Network**, filter `cartservice`.
2. Click **Add** on any product in the normal UI.
3. Right-click the `POST …/api/v2/cart/items` request → **Copy** → **Copy as
   fetch**. **Not "Copy as cURL", and not "Copy as fetch (with cookies)"** — those
   embed the session cookie jar, and a session cookie in a tracker comment is a
   worse leak than the bearer below, because it does not expire in 45 minutes.
   (The 2026-08-11 capture used plain "Copy as fetch" and contained **no `cookie`
   header at all** — verified against the paste. Chrome relies on
   `credentials: 'include'` instead, which is also why cookie *necessity* is still
   untested: we have never seen the cookie set, only its effects.)
4. **Replace the `authorization` value with `Bearer <redacted>` before pasting it
   anywhere.** Learned the hard way on 2026-08-11: the capture carries a live
   bearer *and*, in its claims, the account's email, phone, loyalty card number
   and household id. The token expires in 45 minutes; the PII does not, and the
   tracker has no comment-edit API. Nothing downstream needs the token value —
   this document was written from the *claims*, decoded locally.
5. Paste the redacted capture into **MEAL-137**.

Why "Copy as fetch": the merged version asked for "the JSON body and the full
header list", which is a transcription task, and transcription silently drops
exactly the things gap 1 turned on — **query-parameter order** and any header a
reader assumes is boilerplate. That is not hypothetical: the two headers this
document had never heard of (`ocp-apim-trace`, `sort-order`) and the two it had
wrongly called load-bearing (`slotsRequired`, `x-swy-client-id`) are precisely
what a hand transcription would have got wrong in both directions. It costs the
same one right-click.

*Corrected 2026-08-11: an earlier draft of this step claimed Copy-as-fetch also
captures "the full cookie set". It does not — see the parenthesis above. That was
the argument for preferring it over transcription, and it was the one part of the
argument that was false.*

**Step B — the smallest reversible write.** This is the step that closed gap 1;
without it the document had only observed refusals:

1. Empty the cart, or note exactly what is in it.
2. Take the captured `fetch(...)` from step A, change **one** thing — the product
   id — and run it in the console on the same tab.
3. Record the response status **and the body**. The capture pastes as a bare
   `fetch(...)` that binds nothing, which is how the 2026-08-11 run ended up with
   a status and no payload. Put a variable in front of it and read it:
   `const r = await fetch(...same capture...); console.log(r.status, await r.text());`
   A bare `Response` object in the console shows the status but leaves
   `bodyUsed: false`, which is how the 2026-08-11 run answered the ticket's
   question while leaving a rail without the payload it has to parse. Then check
   the cart UI **on reload**; do not trust the badge, which is measured not to
   update.
4. **Remove it through the site's own UI**, not through the API. One add, then a
   normal manual removal: fully reversible, no `DELETE` call, nothing left behind.

How to read it: a `200`/`201` with the item visible after reload closes gap 1 for
that banner — that is what happened. A `403` would have been the interesting
failure: it is the same status a bogus bearer produces, and per the gate-chain
correction it does not say why on its own — diff the call against the step-A
capture, header by header and param by param, and the difference is the answer.

**Repeat it per banner before assuming the family generalises.** It has been run on
`safeway.com` only. The config blobs are byte-identical across the family and the
token is not banner-bound, so the expectation is that it just works — but that is
an expectation, and this document has already been wrong once about what a real
add sends.

With the contract in hand the rail is implementable — except for gap 4
(**MEAL-115**), which no console probe can settle, and except for `qty`
semantics, which one more two-minute run of this same probe would settle: **add
the same `itemId` twice and read the cart.** Do that before a rail retries
anything.

---

## Reproducing what is in this document

The anonymous half is reproducible in about ten minutes with no account. **The
part that matters most — the accepted add — is not in here**, because it needs a
signed-in session; see probe 3. Note that every `serviceType=pickup` below is what
the anonymous probes *guessed*; the real add sends `serviceType=Dug`. It makes no
difference to these commands, which never get far enough to care, and it is left
as-run so the transcript matches what was measured.

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

No page was patched or instrumented at any point. Through 2026-08-06 no account was
used, no login was attempted, and no bearer was minted — per the MEAL-15 scope
constraints. **That constraint was also this document's ceiling**: an anonymous
investigation can only observe refusals, and every conclusion drawn then about what
the platform would *accept* was inference.

**On 2026-08-11 that ceiling was lifted, deliberately and minimally.** Probe 3 ran
on the author's own signed-in account, on his own cart: one add through the site's
own UI to capture the shape, one replayed add differing only in product id, then a
manual removal through the UI. No bearer was minted then either — the token was
read from the page, as the rail would. No `DELETE` was called, nothing was left in
the cart, and no other account was touched. That is the entire authenticated
footprint behind every "measured" claim above, and it is the experiment worth
repeating on the next banner rather than re-deriving.
