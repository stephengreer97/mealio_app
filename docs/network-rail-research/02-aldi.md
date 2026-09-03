# ALDI — and every other Instacart Storefront tenant

ALDI runs on **Instacart Storefront**, which the app already knows
(`src/lib/webview-scripts/instacart.ts`, `INSTACART_TENANTS`). Everything in
this file is about the PLATFORM, so a rail built here serves any tenant that
registry gains — that is the same reasoning `railConfigKey` uses for the
Albertsons family.

## Transport — MEASURED

```
POST https://www.aldi.us/graphql
content-type: application/json
x-client-identifier: mobile_web
```

Cookie-authenticated on the `aldi.us` origin. **No Authorization header** — the
session is the cookie jar, which is exactly what the app's WebView already holds.

Headers the site sends, MEASURED:

| Header | Observed | Needed? |
|---|---|---|
| `x-client-identifier` | `mobile_web` | send it; it selects the client contract |
| `x-client-user-id` | a numeric id | **a login signal** — see below |
| `x-page-view-id` | a uuid | analytics; a fresh uuid is fine |

## The constraint that shapes everything — MEASURED

**Instacart accepts allow-listed persisted queries only.** Sending a query with
its text is refused:

```
POST /graphql  {"operationName":"Ping","query":"query Ping { __typename }"}
→ 400  {"errors":[{"message":"PersistedQueryNotSupported",
                   "extensions":{"code":"PERSISTED_QUERY_NOT_SUPPORTED"}}]}
```

Schema introspection: same refusal.

A known hash, by contrast, works — MEASURED, **262ms**, cookies only:

```json
{"operationName":"VisitShop",
 "variables":{"shopId":"8583","postalCode":"<the user's postcode>","addressId":null},
 "extensions":{"persistedQuery":{"version":1,
   "sha256Hash":"d2845e5f0022f6d080bf14cd78dbcce9be2a277f12c468e7c43ff0d99a78e77a"}}}
→ 200 {"data":{"visitShop":{"id":"49d9a020","__typename":"RetailersVisitShopResponse"}}}
```

### What that means for the implementation

The rail cannot invent a query. It must know the sha256 of each operation it
wants, and those change when Instacart deploys. This is the same class of
problem as the Albertsons APIM key, and it takes the same answer:

1. **Harvest at runtime** from the storefront's own JavaScript.
2. **Cache in localStorage** with an age limit — Albertsons uses
   `__mealio_alb_keys_v1` with a 12-hour cap.
3. **Forget the cache on a `PERSISTED_QUERY_NOT_FOUND`** and harvest again,
   exactly as `__albForgetKeys()` is called when every cart key 401s.

Harvesting needs the storefront page loaded once (its chunks are what carry the
map), so an Instacart rail pays one real page load per cache refresh. That is
still twelve hours of runs for one page load.

**UNVERIFIED and important:** I did not find the operation→hash map. My harvest
scanned 59 scripts / 4.9MB from the WALMART bundle and found nothing; the same
scan has not been run against ALDI. See `05-open-questions.md` for the exact
next step.

## Login detection — INFERRED, with a strong candidate

`x-client-user-id` carried a numeric id (`20068840574409728`) on the signed-in
session. If that header is absent or a guest id when signed out, it is a
**zero-network login check** as good as Wegmans'.

The site's own bootstrap is `VisitShop`, which returns a shop id — that call is
already proven to work and takes 262ms, so a rail could use it as the "verified"
half even if the header proves unreliable.

**Do not use the DOM.** `instacart.ts` currently decides login from the words
"sign in"/"log in" appearing in the header (`DEFAULT_SIGNED_OUT_WORDS`). That is
the exact inference this project has been burned by three times.

## Search — INFERRED

The search page is `/store/aldi/s?k=<term>` and renders client-side; the results
arrive over the same `/graphql` endpoint. The operation name was not captured
because the headless navigation did not trigger the query. The likely names on
this platform are `SearchResults`, `SearchResultsPlacements` or `ItemsSearch`.

## Cart read and write — INFERRED

Not captured. Instacart's cart is per-retailer and per-shop, so expect the
`shopId` (`8583` here) in the variables of every cart operation.

**Bulk add — leaning yes.** Instacart's own UI adds one item at a time, but its
Connect API (the same platform Wegmans fulfils on) takes line-item arrays. Do
not assume; the harvest will name the operations and their argument types.

## Quiet page

`https://www.aldi.us/robots.txt` — untested. The tenant config already sets
`cacheBustNav: false` because ALDI's anti-bot 403s on a synthetic `?_t=`
query — **carry that rule into the rail**: do not cache-bust ALDI navigations.

## The prize

If this works it is not one store. `INSTACART_TENANTS` is the registry, and the
same rail would light up every banner added to it — and Wegmans fulfils on the
same platform, so the two may share more than expected.
