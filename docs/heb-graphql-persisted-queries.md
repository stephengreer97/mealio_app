# MEAL-12 — Does H-E-B accept full GraphQL queries, or only persisted hashes?

**Date:** 2026-08-05
**Status:** Answered. Live-verified against production `www.heb.com`.
**Question:** H-E-B's storefront sends Apollo Automatic Persisted Queries (APQ).
If the gateway *only* accepts registered hashes, any network rail we build breaks
every time H-E-B redeploys and the hashes rotate. Does it, or does it also accept
a full `query` string?

**Answer: H-E-B accepts full `query` strings. There is no safelisting.**
Persisted-hash rotation is **not** a fragility we inherit — we simply never send a
hash.

**But the headline is not the binding constraint.** The gateway is wide open; the
thing standing in front of it is **Imperva ABP**, and that is unchanged by this
result. See "The constraint that actually binds" below before sequencing MEAL-13/14.

---

## The endpoint and the current request shape

- **Endpoint:** `https://www.heb.com/graphql` (POST)
- Discovered from `__NEXT_DATA__.runtimeConfig.graphqlUrl = "/graphql"`, present in
  12 of the 14 committed fixtures under `tests/fixtures/heb/` — the two exceptions
  are trimmed fixtures carrying no `__NEXT_DATA__` at all — and confirmed live.
- The storefront is a Next.js app, `appName: "WebPlatform-Solar (Production)"`,
  using Apollo Client (`window.__APOLLO_STATE__` is present).

**Nothing in our codebase talks to this endpoint.** The H-E-B rail
(`src/lib/webview-scripts/heb.ts`) is 100% DOM automation inside a WebView —
selectors, clicks, and polling. `extensions.persistedQuery` appears nowhere in our
source. This spike is about a rail we *might* build, not one we have.

A real request the site itself issues, captured at CDP level (no page tampering):

```json
{"operationName":"ShopNavigation",
 "variables":{"storeId":269,"shoppingContext":"EXPLORE_MY_STORE"},
 "extensions":{"persistedQuery":{"version":1,
   "sha256Hash":"53197129989f3555e560f3d11a85ebff9a2abe9d9cf6f7f10a8c93feda9503b2"}}}
```

Note there is **no `query` field** — classic APQ. Request headers that accompany it:

```
content-type: application/json
accept: */*
apollographql-client-name: WebPlatform-Solar (Production)
apollographql-client-version: 4140159d359cc34a908f45149fd18fecd594aeec
```

Plus the usual browser headers and, critically, the origin's cookies (Imperva
`visid_incap_*` / `incap_ses_*` and the ABP `reese84` token).

---

## What was measured

All probes were issued **from the page context of a real Chromium instance on
`https://www.heb.com`**, same-origin `fetch` with `credentials: 'include'`.
**No credentials were used and no account was logged in** — every operation below
is anonymous. Raw responses, verbatim:

### Control — known-good persisted hash (proves the transport works)

Request: the `ShopNavigation` body shown above, hash only.

```
200  {"data":{"shopNavigation":[{"id":"CATEGORY:490020","destinationUrl":"/category/shop/fruit-vegetables/2863/490020",
     "displayName":"Fruit & vegetables","subItems":[{"destinationUrl":"...","displayName":"Fruit",
     "__typename":"NavigationItemV2"}, ...
```

### Test 1 — full query string, no `extensions` at all

Request: `{"query":"{__typename}"}`

```
200  {"data":{"__typename":"Query"}}
```

**Accepted.** No `PersistedQueryNotSupported`, no safelist rejection.

### Test 2 — hash + query together (the APQ registration flow)

Request: `{"query":"{__typename}","extensions":{"persistedQuery":{"version":1,"sha256Hash":"<sha256 of the query>"}}}`

```
200  {"data":{"__typename":"Query"}}
```

**Accepted**, and executed.

### Test 3 — unknown hash alone (what a stale/rotated hash looks like)

Request: same hash as Test 2, no `query`.

```
200  {"data":null,"errors":[{"message":"PersistedQueryNotFound",
     "extensions":{"code":"PERSISTED_QUERY_NOT_FOUND"}}]}
```

Standard APQ behaviour. Worth noting: this ran *after* Test 2 registered that exact
hash and still reported `PersistedQueryNotFound`, so **APQ registration is not
durable** across requests (multi-node gateway with no shared APQ cache, most
likely). Irrelevant to us — it only means the register-then-use-hash flow is a dead
end, and we don't need it.

### Test 4 — a real data operation as a full query string (the decisive one)

`{__typename}` proves the parser accepts a query; it does not prove arbitrary field
selection is allowed. So the real `ShopNavigation` document was extracted from the
JS bundle and POSTed as text with **no `extensions.persistedQuery`**:

```graphql
query ShopNavigation($storeId: Int!, $shoppingContext: ShoppingContext!) {
    shopNavigation: shopNavigationV2(storeId: $storeId, shoppingContext: $shoppingContext) {
      id
      destinationUrl
      displayName
      subItems {
        destinationUrl
        displayName
      }
    }
  }
```

```
200  (14267 bytes)
{"data":{"shopNavigation":[{"id":"CATEGORY:490020","destinationUrl":"/category/shop/fruit-vegetables/2863/490020",
 "displayName":"Fruit & vegetables","subItems":[{"destinationUrl":"...","displayName":"Fruit"}, ...
```

**Real data, from a full query string, no hash anywhere.**

The strongest evidence in this whole document is a detail in that response: it
contains **no `__typename` fields**, whereas the hash-driven control response does.
Apollo Client injects `__typename` into its own documents; our hand-extracted text
does not have it. The server therefore parsed and executed **our** document — it did
not pattern-match us onto a cached persisted operation.

### Test 5 — introspection

```
200  {"errors":[{"message":"introspection has been disabled",
     "extensions":{"code":"INTROSPECTION_DISABLED"}}]}
```

**Disabled.** So MEAL-16 (discovery) still has work to do — but far less than
feared; see below.

### Test 6 — GET with `?query=`

```
400  {"errors":[{"message":"This operation has been blocked as a potential Cross-Site
     Request Forgery (CSRF). Please either specify a 'content-type' header (with a
     mime-type that is not one of application/x-www-form-urlencoded, multipart/form-data,
     text/plain) or provide one of the following headers: x-a...
```

Apollo Server's standard CSRF prevention. Not a restriction on us: POST with
`content-type: application/json` satisfies it, which is what we'd send anyway.

---

## Discovery is much cheaper than assumed

Introspection is off, but **the full GraphQL query documents ship in the client JS
bundle as plain text**. Scanning the 60 largest scripts on the homepage found
readable documents, e.g.:

```graphql
query AddOnsCart($orderId: String!) {
    addOnsCart(orderId: $orderId) {
      maxAddOnItems
      cart {
        id
        currentTime
        containsBestAvailableItem
        bestAvailableDisclaimer
        ageVerificationR...
```

`ShopNavigation` and the APQ link machinery both live in `_app-<hash>.js`, but the
documents are spread across chunks — `AddOnsCart`, for one, is in `1419-<hash>.js`,
so any extraction job has to walk every `script[src]` rather than just the app
bundle. So the
schema-discovery job for MEAL-16 is **"extract query documents from a JS bundle"**,
not "reverse-engineer a schema blind". That is a static, offline, repeatable job
against a file we can download — no live session needed at all.

This is also *why* full queries work: H-E-B uses **stock Apollo APQ**, where the
client holds the real document and falls back to sending it whenever the server
answers `PersistedQueryNotFound`.

It is tempting to go further and argue this is *structurally* safe — that a safelist
would break H-E-B's own storefront on every deploy until the cache warmed, so they
can never enable one. **The evidence here does not support that**, and Test 3 is why.
A hash registered by Test 2 was not found afterwards, while `ShopNavigation`'s hash
is recognised. Read one way that is a multi-node gateway with no shared APQ cache,
and the full-query fallback is load-bearing. Read the other way it is a **build-time
persisted-query manifest with no runtime registration** — in which case their own
client never needs the fallback and safelisting could be switched on tomorrow at no
cost to them. These measurements cannot tell the two apart.

Treat full-query acceptance as **true today**, not as guaranteed. The practical
consequence is in the rail design: keep sending hashes possible, so a swap back is a
config change rather than a rewrite.

---

## The constraint that actually binds: Imperva ABP

**Do not read this document as "the network rail is unblocked".** The GraphQL layer
imposes no safelisting, but it is not what was stopping us.

Measured, from this machine, with plain `curl` and no browser:

```
$ curl -i -X POST 'https://www.heb.com/graphql' \
    -H 'content-type: application/json' --data '{"query":"{__typename}"}'

HTTP/2 401
x-iinfo: 4-16188247-0 NNNN RT(...) q(0 -1 -1 1) r(1 -1) B15(14,0,0) U6
set-cookie: visid_incap_2302070=...; Domain=.heb.com
{
    "incidentId" : "1318000700134302733-80225616898953604",
    "hostName" : "www.heb.com",
    "errorCode" : "15",
    "description" : "This page could not load. It looks like an ad blocker, antivirus
                     software, VPN, or firewall may be causing an issue. ..."
}
```

That is an **Imperva/Incapsula block**, not a GraphQL error. The request never
reached the gateway. A plain `GET https://www.heb.com/` from the same client returns
the 10 KB **"Pardon Our Interruption"** ABP interstitial rather than the 2.1 MB real
homepage.

Every successful probe in this document worked **only** because it ran inside a real
browser that had executed the ABP challenge and held a valid `reese84` token, issuing
a same-origin request from the page itself.

The practical consequence: a H-E-B network rail cannot be a plain HTTP client in
React Native. It must issue its requests **from inside a WebView that has already
passed ABP** — i.e. the same WebView we drive today, but calling `fetch('/graphql')`
from page context instead of clicking DOM nodes. This is a real and attractive
option (far fewer moving parts than selector automation), but note it collides with
an existing finding: `docs/network-confirmation-findings.md` concluded we must **not**
patch `fetch`/`XMLHttpRequest` in production because Imperva detects it. Calling
`fetch` is not patching `fetch`, so that conclusion does not forbid this — but the
adjacency deserves care, and the tamper-detection analysis there applies to anything
that goes further.

---

## What remains unknown

Being precise, because downstream sequencing depends on it:

1. **Authenticated operations were never tested.** Everything above is anonymous.
   Whether cart mutations (`addToCart` and friends) accept full query strings is
   **not established**. It is very likely — safelisting is a gateway-level policy,
   not a per-operation one, and the gateway plainly has no safelist — but "likely"
   is not "measured". This is the one gap that needs a logged-in session.
2. **Mutations specifically** may carry extra requirements (a CSRF token, an
   order/cart id, store-context headers) independent of the persisted-query question.
3. **Durability.** One measurement, one day. H-E-B could enable safelisting later,
   and — see the Test 3 discussion above — nothing measured here rules that out.
4. **Rate limiting / ABP behaviour under sustained programmatic load** is untested,
   and this is the largest unknown on the list rather than the smallest. A handful
   of anonymous probes is not a rail doing 30 authenticated adds; ABP profiles
   behaviour, not just tokens. It is also the failure mode that would surface late
   and expensively, so measure it before MEAL-13/14 commit to a rail shape — at
   least as early as the authenticated probe in gap 1.

### Closing gap 1 — ready-to-run, needs a human

Requires a logged-in H-E-B session, which is why it is not done here. Log in to
`heb.com` in a normal browser, put an item in the cart, then paste this into DevTools
console **on a heb.com tab** (must be same-origin so the ABP token and cookies ride
along):

```js
// Confirm an AUTHENTICATED operation also accepts a full query string.
// 1. Find a real authenticated document in the bundle.
//    Search EVERY chunk, not just _app-*.js: `ShopNavigation` happens to live
//    there, but `AddOnsCart` is in 1419-<hash>.js. Searching one chunk gives
//    indexOf === -1, and the brace scan below then slices an empty string and
//    posts `query: ""` — a silent failure that reads as a syntax error from
//    the server rather than as "the extraction did not find anything".
const OP = 'query AddOnsCart';                        // or any authed op you prefer
let js = '', i = -1;
for (const s of document.querySelectorAll('script[src]')) {
  const text = await (await fetch(s.src)).text();
  const at = text.indexOf(OP);
  if (at >= 0) { js = text; i = at; console.log('found in', s.src); break; }
}
if (i < 0) throw new Error(`${OP} not found in any chunk — pick another authed operation.`);
let d = 0, started = false, end = i;
for (let j = i; j < js.length; j++) {
  const c = js[j];
  if (c === '{') { d++; started = true; }
  else if (c === '}') { d--; if (started && d === 0) { end = j + 1; break; } }
}
const q = js.slice(i, end).replace(/\\n/g, '\n').replace(/\\"/g, '"');
if (!q.trim().startsWith('query')) throw new Error('Extraction failed — do not send this.');
console.log(q);                                       // eyeball the document + its variables

// 2. Send it as a FULL QUERY with no persistedQuery extension:
const r = await fetch('/graphql', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json',
             'apollographql-client-name': 'WebPlatform-Solar (Production)' },
  body: JSON.stringify({ operationName: 'AddOnsCart',
                         variables: { orderId: '<your real orderId>' },
                         query: q }),
});
console.log(r.status, (await r.text()).slice(0, 600));
```

**How to read the result:**

Read the **body**, not the status code. A validation error comes back as HTTP 400 and
is still a *success* for this question: the gateway could only have produced it by
parsing our query text.

| Response | Meaning |
|---|---|
| `200` + a `data` object | Confirmed — authed ops accept full queries. Gap closed; hashes are irrelevant to us everywhere. |
| `400` + an error naming a *field or variable* (`Cannot query field "…"`, unknown `orderId`) | **Also success.** The gateway parsed and executed our text; only the arguments were wrong. Fix the variables and re-run if you want a clean 200. |
| `PersistedQueryNotSupported` / "query not allowed" / "not in safelist" | Safelisting is enforced *for authenticated operations only*. Surprising, but decisive — MEAL-16 becomes mandatory. |
| `PersistedQueryNotFound` | You left an `extensions.persistedQuery` block in the body. Remove it — this probe must send text only. |
| A **syntax error**, or an error about an empty query | The extraction failed, not the gateway. The guards above should have thrown first; check what `console.log(q)` printed. Nothing has been learned either way. |
| `401` with `x-iinfo` / `incidentId` | Imperva blocked you. You are not on a heb.com tab, or the ABP token is stale — reload the page and retry. |
| `401` with `x-iinfo` / `incidentId` | Imperva blocked it, no GraphQL involved. Not an answer — retry from a properly-loaded heb.com tab. |

The same read applies if a mutation is used instead; substitute a real cart mutation
document and expect to have to supply a valid cart/order id.

---

## Decision implications

### MEAL-13 / MEAL-14 (the network rail)

- **Hash rotation is off the risk register, today.** No hash tracking, no re-scraping
  hashes each deploy, no "hashes went stale again" maintenance class. Send the query
  text. This removes the single most-cited fragility of the network rail, exactly as
  the ticket hoped — but build the rail so that sending a hash instead is a config
  change rather than a rewrite. See the durability caveat above.
- **Query text still drifts**, just far more slowly and far more visibly. Fields get
  renamed on a schema change, not on every redeploy, and a broken field produces a
  named GraphQL error instead of an opaque 404 — much better diagnostics than a
  selector that silently matches nothing.
- **The rail must live inside the ABP-cleared WebView.** Budget for this in the
  design; it is the main architectural constraint and it is *not* removed by this
  finding. A pure-RN HTTP client is not viable.
- **Sequence gap 1 before committing to the rail's shape.** It is a 10-minute manual
  check and it is the only thing between "very likely" and "known".
- Keep the DOM rail. Even in the best case this is an optimisation with a fallback,
  not a replacement — the same conclusion `network-confirmation-findings.md` reached
  about confirmation signals.

### MEAL-16 (discovery)

- **Substantially cheaper than scoped, but still needed.** Introspection is disabled,
  so there is no schema dump — but full query documents are sitting in plain text in
  the JS bundle, so discovery is an offline text-extraction job against a downloadable
  file, not blind reverse-engineering.
- **It is no longer on the critical path.** It was scoped as the fallback for "both
  rejected → gateway enforces safelisting". That branch did not happen. MEAL-16 can be
  re-scoped from "discover the schema because we must" to "harvest the operations we
  want, once", and it needs no live session.
- Worth a small guard regardless: a periodic check that the documents we depend on
  still parse against the live gateway would catch schema drift early, and costs one
  cheap query per operation.

---

## Reproducing

Everything here is reproducible in a browser in about five minutes. Load
`https://www.heb.com` in a real Chromium (Playwright MCP was used), let the page
finish so Imperva's challenge clears, then run the probes from the page context via
`fetch('/graphql', …)` with `credentials: 'include'`. The site's own request shapes
were read at CDP level via Playwright's network capture, so nothing on the page was
patched or instrumented — no tamper surface, per the constraints in
`docs/network-confirmation-findings.md`.
