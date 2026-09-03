# Amazon Fresh

**The recommendation is: do not build a rail for this one yet.** It is the only
store of the four where the honest answer is that the network route may not
exist, and saying so is more useful than a hopeful design.

## What was found — MEASURED

Signed in, on `/s?k=sour+cream&i=amazonfresh`, the page made **16 API calls in
total** and none of them was a product API. What there is:

```
GET /cart/add-to-cart/get-cart-items          ← a cart read
GET /cart/add-to-cart/patc-template
GET /nav/ajax/mobileAccountMenu               ← the account menu, rendered
GET /nav/ajax/hMenuFirstLayer
GET /portal-migration/hz/glow/get-rendered-toaster
GET /hz/profilepicker
GET /shoppingaids/fetchshoppingaids
POST /cross_border_interstitial_sp/render
```

All carry `x-requested-with`. All are cookie-authenticated.

The giveaway is in the names: `get-rendered-toaster`, `patc-template`,
`mobileAccountMenu`. **These return HTML fragments, not data.** Amazon's storefront
is server-rendered; its "API" is a set of endpoints that hand back pieces of
page. A rail built on them is not a network rail — it is DOM automation with
extra steps, and DOM automation is exactly what we are ripping out.

## Login detection — the one usable piece

`GET /nav/ajax/mobileAccountMenu` is cheap and its content differs between
signed-in and signed-out. That is still a **server** answer rather than a DOM
inference, so it is a real improvement on what `amazon-fresh.ts` does today.

But it returns markup, so reading it means matching on rendered text — the same
class of inference that has burned this project three times. Prefer a cookie or
a JSON endpoint if either can be found.

## Search — nothing found

No JSON search endpoint appeared. Amazon's search results are in the HTML of
`/s`. Extracting them means parsing that HTML, which is the thing being removed.

## Cart read — possible

`GET /cart/add-to-cart/get-cart-items` is the closest thing to a real endpoint
here and is worth one probe to see whether it returns JSON or a fragment. If it
is JSON, Amazon Fresh could at least get a **cart check** — the before/after
snapshot — without loading the cart page, which is a real win on its own even
with no search or add.

## Add to cart — the known shape

Amazon's classic add is a form POST to `/gp/add-to-cart/json` or
`/cart/add-to-cart/add`, with `ASIN`, `quantity` and an anti-CSRF token that is
minted into the page. **The token is the blocker**: it is issued to a rendered
page, so obtaining it means loading a real page, which is the cost the rail
exists to avoid.

## Recommendation

1. **Keep Amazon Fresh on the assisted path** — Mealio searches, the user adds.
   That is what it does today and it is honest: no claim is made about what
   landed.
2. **Consider one narrow rail feature: the cart check.** If
   `get-cart-items` returns JSON, the done screen could verify a run without a
   page load. That is worth an hour and nothing else here is.
3. **Revisit if Amazon Fresh moves to a JSON storefront.** Their newer surfaces
   do use GraphQL; this one does not yet.
