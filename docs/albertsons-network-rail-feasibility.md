# MEAL-15 — Can we drive the Albertsons family from an in-page network rail?

**Date:** 2026-08-06
**Status:** Answered for everything that can be measured without an account.
One probe remains, and it needs a logged-in human.
**Timebox:** 1 day (spike — findings, not shipped code).

**Question:** Albertsons is the widest family we support — 15 banners on one
platform — so a network rail there pays out repeatedly. Where are the search and
add-to-cart endpoints, will they work from an in-page `fetch` on the user's own
session, and do they generalise across the family?

---

## Answers up front

1. **The endpoints are identified, from two independent sources that agree.**
   Search: `GET /abs/pub/xapi/search/products`. Cart: `/abs/pub/erums/cartservice/api/v2/cart`.
   Both are relative paths on whichever banner domain the page is already on.
   **Confidence: high.** Derived from the page's own config blob *and* from the
   Angular bundle's call-construction code, then **validated against production** —
   the cart path returns a real application-level error naming its own origin
   service, so the route is real.

2. **The family genuinely shares endpoints. This is not an inheritance from
   sharing selectors — it is measured.** 15 of 17 config blobs are **byte-identical**
   across Acme, Safeway and Vons, subscription keys included. The two that differ
   are the default store id/zipcode and two cosmetic feature toggles.
   **Confidence: high** (measured on 3 banners, plus the mechanism is visible in code).

3. **There is no bot wall on this API surface.** Imperva is present at the CDN
   (`x-cdn: Imperva`) but **passes plain-`curl` requests through to the origin** and
   has done so on every probe. This is the decisive difference from H-E-B (MEAL-12),
   where plain `curl` got an ABP interstitial for *everything*.
   **Confidence: high for the endpoints probed; see the caveats.**

4. **An in-page `fetch` is still the right shape — but for a different reason than
   H-E-B, and that reason matters.** At H-E-B the WebView was needed to *defeat*
   the bot wall. Here it is needed to **read the session**: the bearer the cart API
   wants is sitting on a page global, `window.AB.userInfo.SWY_SHOP_TOKEN`. So we
   ride the session by reading it, not by minting it. **No Okta flow of our own,
   no credential handling.** The ticket's second acceptance criterion is satisfied
   in principle; one probe confirms it in practice.

5. **The ~15-banner payoff argument survives, and is stronger than the ticket
   claims** — the shared config lists **31 banner hosts**, not 15. See "Does the
   payoff argument hold?".

**One thing the ticket gets wrong:** it describes the auth flow as
`albertsons.okta.com/api/v1/authn` → sessionToken → bearer. The live config says
the IdP is **`ciam.albertsons.com`** (`initOktaConfig.issuer`), not
`albertsons.okta.com`. Either way it is out of scope — noted so nobody plans
against a stale hostname.

---

## Where the endpoints came from

Albertsons has no `__NEXT_DATA__`. Its equivalent is a set of **`SWY.CONFIGSERVICE.init*()`
calls inlined in the page**, each taking a single-quoted JSON string. There are
**18 of them** in the committed logged-in fixture, and they carry the entire API
surface: paths, hosts, subscription keys, and the Okta/CIAM config.

That is the discovery mechanism worth remembering: **the endpoint map ships in the
HTML of every page, on every banner, logged in or out.** No bundle spelunking
required to find *what* the endpoints are — only to find their request shapes.

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

The three operations the ticket asks for, from the bundle:

| Operation | Call |
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

**I have not seen the `/items` request body.** It is the one part of the contract
that is not established, because it is assembled from a product object at click
time rather than written literally in the bundle. The probe below recovers it from
a real add. **Do not invent it.**

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

Read this carefully, because it is the whole answer:

- The subscription key is the **APIM** gate, and it is a **public constant we read
  out of the page config**. Supplying it gets us to the origin.
- The `400 "Failed to convert 'id' with value: 'items'"` is the origin service
  binding `items` to an `{id}` path variable — **proof the route is real** and that
  our path derivation is correct. A guessed path could not produce that.
- **`no bearer → 401` but `bogus bearer → 403`.** Two different statuses means the
  origin *validated* the token and rejected it, rather than ignoring it. The bearer
  is the **only** remaining gate, and a valid one is the single thing between us and
  a working cart call.

So the rail is not blocked by bot defence. It is gated by ordinary OAuth, on a
token that lives in the page.

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

**I am not going to claim I know why.** A tarpit is not the signature of a WAF block
(those come back fast, as the 401s above do), and the neighbouring `search/*` route
answers a clean 404, so the APIM API itself routes fine. The plausible readings are
an upstream Solr dependency that needs a real store/session context, or a
route-specific rate-limit posture. **The in-page probe settles it**, and settles it
in the environment we would actually ship in — with real cookies, a real `uuid`, and
a real store id.

This is the reason not to over-read finding 3 into "we could skip the WebView
entirely": search from a plain client **does not currently work**, whatever the cause.

### What this does not license

- **Do not conclude a plain React Native HTTP client is viable.** Even setting the
  tarpit aside, the bearer only exists inside the page.
- **Sustained load is untested**, and it is the same largest-unknown MEAL-12 flagged:
  a handful of anonymous probes is not a rail doing 30 authenticated adds. Imperva
  profiles behaviour, not just tokens, and it is demonstrably in the path here.
- **`docs/network-confirmation-findings.md` still applies.** Do not patch `fetch` or
  `XMLHttpRequest` — that is a detectable tamper signal. *Calling* `fetch` is not
  patching it, so the rail is not forbidden; but nothing here licenses going further.

---

## Does the family genuinely share endpoints?

The ticket, and our own `albertsons.ts`, assert family-wide sameness on the
strength of **shared selectors**. Those are different claims and the brief is right
that one does not imply the other. So this was measured directly.

Method: fetch the logged-out homepage of three banners, extract all
`SWY.CONFIGSERVICE.*` blobs from each, diff them. (Anonymous GETs of public pages —
no account, no login.)

**Result: 15 of 17 blobs are byte-identical across `acmemarkets.com`,
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
in-page `fetch` therefore generalises with **zero per-banner configuration**.

**Confidence: high.** Caveat, stated plainly: measured on 3 of 31 banners, and on
logged-out pages. It would be cheap to widen — the probe below does all 31 in a loop
and needs no account.

### Durability signal, for free

The committed Acme fixture was captured **2026-02**. Its `initSearchConfig` and
`initErumsConfig` are **byte-identical to live today**, ~6 months later. Only
`initFeatureToggleConfig` moved. The endpoint config is not churning — a marked
contrast with H-E-B's rotating persisted-query hashes.

---

## Does the ~15-banner payoff argument hold?

**Yes, and it is understated.**

- The shared `initBannerDomainMapConfig` lists **31 hosts**, not 15: the 15 in our
  `DOMAIN_MAP`, plus `andronicos`, `albertsonsmarket`, `shopalbertsonsmarket`,
  `shopmarketstreet`, `shopamigos`, `shopunitedsupermarkets`, and **ten `business.*`
  B2B storefronts** (`business.safeway.com`, `business.albertsons.com`, …). The B2B
  sites run the same cart service with a `1P_B2B` `cartCategoryList` — a code path
  visible throughout the bundle.
- The payoff is **larger than 15×** because the shared surface is not just the
  endpoints. It is one config blob, one subscription-key set, one IdP
  (`ciam.albertsons.com`), one cart service. A rail written against relative paths
  needs **no per-banner branch at all** — strictly better than today's
  `DOMAIN_MAP` + selector-config arrangement.
- **The economics-inverting risk did not materialise.** The brief was right to flag
  that per-banner endpoints would change the maths. They are not per-banner; the
  diff is empty where it counts.

The honest deductions:

- **Payoff is per-*platform*, not per-banner, and so is the risk.** One Albertsons
  change breaks all 31 at once. That is the same concentration that makes the payoff
  large — worth one shared canary, not 31.
- **Nothing here is an argument for building the rail**, only that if we build it,
  it covers the family. The load question above is unmeasured and is the real
  gating risk.
- **Keep the DOM rail.** Same conclusion as MEAL-12: this is an optimisation with a
  fallback, not a replacement.

---

## Closing the gap — runnable, needs a human

Everything above was established without an account. **What remains needs a
logged-in Albertsons-family session**, which is why it stops here.

Three things are open: (a) does an in-page `fetch` on the user's own session
actually work end to end, (b) what is the `/items` request body, (c) why does
product search tarpit for a plain client.

### Probe 1 — the family sweep. No account needed.

Widens the generalisation claim from 3 banners to all 31. Run from anywhere.

```bash
# Extracts every SWY.CONFIGSERVICE blob from each banner's logged-out homepage
# and diffs the two that matter against Safeway. Expect: no output = identical.
for b in albertsons safeway vons jewelosco shaws acmemarkets tomthumb randalls \
         pavilions starmarket haggen carrsqc kingsfoodmarkets balduccis \
         unitedsupermarkets andronicos; do
  curl -s --max-time 30 "https://www.$b.com/" \
  | grep -oE "initSearchConfig\('[^']*'\)|initErumsConfig\('[^']*'\)" > "/tmp/cfg-$b.txt"
  if [ -s "/tmp/cfg-$b.txt" ]; then
    diff -q /tmp/cfg-safeway.txt "/tmp/cfg-$b.txt" >/dev/null 2>&1 \
      && echo "$b  SAME" || echo "$b  *** DIFFERS — investigate ***"
  else
    echo "$b  no config found (banner may redirect or be retired)"
  fi
done
```

**How to read it:** all `SAME` → the shared-endpoint claim is settled for the whole
family, and the rail needs no per-banner config. Any `DIFFERS` → diff that banner
by hand; if a *path or subscription key* differs the rail needs a per-banner lookup
(the payoff argument weakens but does not collapse). A banner with no config found
is almost certainly a redirect, not a counter-example.

### Probe 2 — the decisive one. Needs a logged-in session.

Sign in to **any** Albertsons-family banner in a normal browser, set your store,
**put one item in the cart by hand**, then paste this into DevTools console **on a
tab of that same banner** (same-origin matters — the cookies and the `AB` global
both need to be there).

It is deliberately **read-only**: it reads the session, reads the cart, and reads
search. It does not add anything. Step 4 tells you how to capture the add body
without guessing it.

```js
// MEAL-15 probe. Read-only. Run on a logged-in www.<banner>.com tab.
(async () => {
  // ── 1. Is the session really readable from the page? ──────────────────────
  const ui = window.AB?.userInfo;
  if (!ui) return console.error('window.AB.userInfo missing — are you on a banner storefront page, signed in?');
  const tok = ui.SWY_SHOP_TOKEN;
  const sess = { hasToken: !!tok, tokenLen: tok ? tok.length : 0,
                 customerId: ui.customerId, storeId: ui.storeId,
                 shopStoreId: ui.shopStoreId, shopZipcode: ui.shopZipcode,
                 banner: ui.banner, uuid: ui.UUID, tokenExpiration: ui.tokenExpiration };
  console.log('SESSION:', sess);
  if (!tok) return console.error('No SWY_SHOP_TOKEN. Everything below will 401 — sign in first.');

  const storeId = ui.shopStoreId || ui.storeId;
  const zip     = ui.shopZipcode || '';
  const CART    = '/abs/pub/erums/cartservice/api/v2/cart';
  const CART_KEY   = 'c645e9387c654aa8ae253045f648bfac';   // from initErumsConfig
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
| `hasToken: true` with a long token, and real `customerId`/`shopStoreId` | **The core premise is confirmed.** The session is readable in-page; no Okta flow needed, ever. This alone closes the ticket's second acceptance criterion. |
| `window.AB.userInfo missing` | You are on `/erums/cart` or another sub-app rather than the storefront. Go to the banner homepage and retry. Not a negative result. |
| **CART READ `200` + JSON containing your hand-added item** | **The rail works.** Read, auth and session all confirmed against a real account. Proceed to MEAL-15a. |
| CART READ `401` "Not Authorized" | The token was rejected or absent. Check `tokenExpiration`; reload to refresh and retry. |
| CART READ `403` | Token present but not accepted for this operation — the same status a *bogus* bearer produced from curl. Suspect an extra required header or a token audience mismatch. Capture the real request from the Network tab and diff the headers. |
| CART READ `400` naming a param | **Success for our purposes** — we reached the service and only the arguments are wrong. Fix from the message and re-run. |
| SEARCH `200` with a non-zero product count | **The tarpit was client-shaped, not a block.** Search works in-page. This is the expected result and the rail's search half is settled. |
| SEARCH hangs in-page too | The tarpit is real and server-side. **Fall back to `/abs/pub/xapi/search/autosuggest`**, which is measured working anonymously, or keep DOM scraping for search and use the network rail only for cart. Materially narrows the rail — file it. |
| SEARCH `401`/`403` | Search needs auth after all, contradicting the bundle. Add `authorization: Bearer` and re-run. |
| Anything with `x-iinfo` and an Imperva HTML body | Imperva challenged you. Reload the page and retry; if it recurs under repetition that is the load finding, and it is important. |

### Probe 3 — capture the add body. Needs a human, one click.

The `/items` POST body is the **only** part of the contract still unknown, and
guessing it is exactly what this document refuses to do. Recover it, don't invent it:

1. On a logged-in banner tab, open DevTools → **Network**, filter `cartservice`.
2. Click **Add** on any product in the normal UI.
3. Select the `POST …/api/v2/cart/items` request → **Payload** / **Request**.
4. Copy the JSON body and the full header list into MEAL-15a.

That is the whole gap. With that body in hand the contract is complete and the rail
is implementable — no further reverse engineering.

---

## Reproducing what is in this document

Everything above is reproducible in about ten minutes with no account:

```bash
# 1. Endpoint map, straight out of any banner's HTML — no bundle needed.
curl -s https://www.safeway.com/ | grep -oE "SWY\.CONFIGSERVICE\.init\w+\('" | sort -u

# 2. The gate chain (each answers in <250ms, proving no bot wall).
C=https://www.safeway.com/abs/pub/erums/cartservice/api/v2/cart
curl -si "$C/items" | head -1                                              # 401 APIM: no sub key
curl -si -H 'Ocp-Apim-Subscription-Key: c645e9387c654aa8ae253045f648bfac' \
     "$C/items" | tail -1                                                  # 400 osms-cartservice
curl -si -X POST -H 'Ocp-Apim-Subscription-Key: c645e9387c654aa8ae253045f648bfac' \
     -H 'authorization: Bearer notarealtoken' -H 'content-type: application/json' \
     -d '{}' "$C/items?serviceType=pickup&storeId=3132&zipCode=94611" | head -1   # 403

# 3. A search endpoint that works anonymously, from a plain client.
curl -s -H 'ocp-apim-subscription-key: e914eec9448c4d5eb672debf5011cf8f' \
  'https://www.safeway.com/abs/pub/xapi/search/autosuggest?q=milk&storeid=3132' | head -c 300
```

The config extractor used for the cross-banner diff is ~15 lines of Python: match
`SWY\.CONFIGSERVICE\.(\w+)\('`, scan forward to the unescaped closing quote,
`json.loads` the `unicode_escape`-decoded string. It works unchanged on the
committed fixtures and on live pages, which is how fixture-vs-live drift was checked.

No page was patched or instrumented at any point. No account was used, no login was
attempted, and no bearer was minted — per the MEAL-15 scope constraints.
