# Rail recon — running code inside a live store session

The hard part of building a network rail is not writing it. It is finding out
what the store's own site does, while signed in, without guessing.

This directory holds the way in. It was built on 2026-09-02 to research Wegmans,
Walmart, Amazon Fresh and ALDI, and it works for any store the app can open.

## Why not just use a browser on this machine

Because the session is on the PHONE. Stephen signs in through the app's WebView,
and a desktop Chrome — even the persistent profile under `tests/.chrome-profile/`
— is a different browser with different cookies. It is also, for Walmart, a
different *reputation*: a headless Chromium from this box gets served
`walmart.com/blocked` within two page loads, where the phone's WebView is
served normally.

## The way in

A dev build enables WebView debugging, so the app's WebViews are reachable over
adb:

```bash
PID=$(adb shell pidof co.mealio.app | tr -d '\r')
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
curl -s http://localhost:9333/json          # lists page targets
```

**A page target only exists while a WebView is mounted.** The reliable way to
get one is to open the cart sheet for a RAIL store (H-E-B, Albertsons) and stop
on the quantity screen: the sheet keeps its WebView mounted there, parked on
`robots.txt`. A store with no rail mounts nothing until the run starts.

One target is enough for every store. The app sets `sharedCookiesEnabled`, so
navigating that WebView to `wegmans.com` lands in the Wegmans session, and so on.

## The two tools

```bash
# Run an expression inside the WebView. First arg is a URL to navigate to
# first, or "-" to stay put.
npx tsx tools/rail-recon/probe.ts https://www.wegmans.com/robots.txt my-probe.js

# Watch what the store's own site calls, signed in, while it loads pages.
npx tsx tools/rail-recon/watch.ts wegmans "https://www.wegmans.com/shop/search?search=milk"
```

`watch.ts` writes `/tmp/claude-1000/rail-research/<label>-live.json` with method,
URL, status, GraphQL operation name, request headers (cookies and bearer tokens
redacted) and a peek at the body.

## Verifying a rail you have built

```bash
npx tsx tools/rail-recon/verify-rail.ts aldi
npx tsx tools/rail-recon/verify-rail.ts wegmans
```

Runs the rail's OWN scripts — the ones the app ships — against the real store and
prints what came back: the session answer, a search with its candidates and
timing, and the cart read. Not a stub and not a reimplementation, so if it says
the search works, the app's search works.

It does not run the add. That writes to a real basket.

## Rules that are not optional

- **Read only.** Discovering the write endpoint is one thing; putting groceries
  in somebody's basket is another. Nothing in here writes to a cart, and no
  future probe should without the account owner saying so out loud, awake.
- **Never print a token.** Print its length, its expiry, its shape. The Wegmans
  research below names the localStorage key that holds a bearer token and
  deliberately never contains one.
- **Probing has a cost.** Walmart's virtual waiting room started answering `429`
  to every API call on the session after about forty automated requests,
  including from a real page. It recovers, but treat Walmart as a store where
  you get a limited number of questions and should plan them before you start.
