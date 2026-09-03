# What is still unknown, and exactly how to answer it

Each of these is a gap I could not close without either writing to a real cart
or spending requests the store was no longer willing to serve. They are ordered
by how much they block an implementation.

## 1. Wegmans: the cart write shape — BLOCKS the add path

**Question:** what does `POST /commerce/cart/carts/{id}/items` take, and does it
accept an array?

**Probe** (needs Stephen awake; one cheap item added by hand first):

```bash
# Open the cart sheet on a rail store, stop on the qty screen, then:
PID=$(adb shell pidof co.mealio.app | tr -d '\r')
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
npx tsx tools/rail-recon/watch.ts wegmans-cart "https://www.wegmans.com/cart"
```

Then add ONE item through the Wegmans UI on the phone while the watcher runs.
The request it makes IS the answer — method, path, body, and whether the body
holds one item or a list.

## 2. ALDI/Instacart: where the operation→hash map lives — BLOCKS everything

**Question:** the storefront must ship the map somewhere. Where?

**Probe:** the harvest script in this research run scanned Walmart, not ALDI.
Run it against ALDI's storefront:

```js
// tools/rail-recon/probe.ts https://www.aldi.us/store/aldi/storefront harvest.js
// Scan every loaded .js for  "<OperationName>":"<64 hex>"  and for sha256Hash:"…"
```

If that finds nothing, the map is fetched at runtime — in which case
`tools/rail-recon/watch.ts` with a match on `.js` will name the file.

## 3. ALDI: the search and add operation names

Unlocked by (2). Until then, unknown. The search page renders client-side, so
driving an actual search on the phone with `watch.ts` running would also answer
it — the headless navigation did not trigger the query.

## 4. Walmart: whether the quiet page helps or hurts — DESIGN-CHANGING

**Question:** for H-E-B and Albertsons, `robots.txt` buys 12–18 seconds. For a
store with a page-sensor anti-bot, running with NO sensor history may look more
like a bot, not less.

**Probe:** the same GraphQL call from `robots.txt` and from a real page, timed,
several minutes apart so the waiting room is not the variable. Wait for the 429s
to clear first — probing while throttled measures the throttle.

## 5. Walmart: the login endpoint

`GET /orchestra/api/ccm/v3/bootstrap` was 429 when tried. Retry it when the
session is clean and look for a customer identity in the body.

## 6. ~~Wegmans: the store filter~~ — ANSWERED

`filters: "storeNumber:140"` takes 32,223 hits down to 282 in 13ms. See
`01-wegmans.md`. It also turned up something that changes the data model: the
product id is **per store** (`626485` at store 50, `608294` at store 140 for the
same product), so a saved Wegmans product cannot be reused across stores the way
a Kroger or Albertsons one can. That needs a decision before the add path is
built.

## 7. Wegmans: what happens when the MSAL token expires

**Question:** MSAL renews silently, but only when the site's own code runs. A
rail on `robots.txt` runs none of it. Does an expired token mean "sign in
again", or can the rail refresh it itself using the refresh token in
localStorage?

This decides whether Wegmans needs a login screen every hour or once. **It is the
biggest single risk in the whole Wegmans design** and there is no cheap probe —
it needs a token observed across its own expiry.

## 8. All four: is bulk add real?

Every "leaning yes" in these files is an inference from endpoint shape. The
H-E-B lesson is that a batched call can still execute serially server-side —
34 items took 8.2 seconds in one request. **Measure the wall clock, not the
request count**, whenever any of these is built.
