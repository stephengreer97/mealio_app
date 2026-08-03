# Confirming an add-to-cart from network activity instead of the DOM

**Date:** 2026-07-29
**Question:** Can we confirm an add landed by observing the store's own network
calls, rather than inspecting the DOM (per-card quantity, header badge)?
**Answer:** Partly — and the split runs along a line that matters. The *read-only*
technique is safe and worth shipping. The *full-fidelity* technique requires
tampering that Imperva will detect, and should not ship.

All claims below were measured, not reasoned about. Method: Playwright driving a
synthetic storefront that POSTs to a cart endpoint the way a real SPA does, run
against **Chromium** (the Android WebView engine) and **WebKit** (the iOS
WKWebView engine), with instrumentation injected before page scripts — the exact
position of `injectedJavaScriptBeforeContentLoaded`.

---

## The three candidate techniques

### A. Monkey-patch `window.fetch` and `XMLHttpRequest` — DO NOT SHIP

Functionally this is everything we'd want. Measured, it captured for each cart
call: URL, method, HTTP status, **request body** (so the SKU and quantity), and
**response body** (so the store's own reported cart total). That is per-item,
positive, first-party confirmation — strictly better than any DOM signal.

It is also detectable, and we confirmed the detection works on **both engines**:

| Probe | Result |
|---|---|
| `String(window.fetch)` with `toString` masking | `function fetch() { [native code] }` — looks clean |
| `Object.getOwnPropertyNames(window.fetch)` | `length,name,**prototype**` — a native function has **no** `prototype` |
| Pristine `toString` borrowed from a fresh iframe, applied to `window.fetch` | **`function fetch(a, b) { return realFetch.apply(this, arguments); }`** |
| Same trick applied to `Function.prototype.toString` | **reveals our masking wrapper's full source** |

The third row is the fatal one. A sensor creates an `<iframe>`, reaches into
`iframe.contentWindow.Function.prototype.toString` — a realm our patch never
touched — and calls it on the main window's `fetch`. Our source code comes back
verbatim. We cannot pre-patch every realm, because the sensor can mint a fresh one
at any moment.

The fourth row is worse than the thing it was hiding. Masking `toString` doesn't
read as "this app instruments network calls"; it reads as "this client actively
lies about its own internals," which is the single loudest bot signal there is.

Two notes on details:
- `delete wrappedFetch.prototype` does not remove the `prototype` tell — a
  function's `prototype` is non-configurable. An arrow function or a `Proxy` avoids
  that specific tell, but neither survives the iframe attack.
- This matters *specifically* for us. We have just spent days establishing that
  H-E-B runs Imperva ABP and that the emulator's distrusted `reese84` token is
  what produces 403s. Shipping `fetch` patching hands that same sensor a
  definitive tamper signal on **real user devices**, not just the emulator. The
  production fingerprint shim was deliberately shrunk to a single
  `navigator.webdriver` line for exactly this reason; this would undo that.

### B. `PerformanceObserver` on `resource` entries — SHIP THIS

A read-only, standards-track browser API. It patches nothing, replaces nothing,
and is what every RUM vendor uses, so it carries no tamper surface at all. A
sensor cannot distinguish us from Datadog.

Measured, per cart request, on **Chromium (Android)**:

| Scenario | `responseStatus` | `transferSize` | Entry appears |
|---|---|---|---|
| same-origin 200 | `200` | 302 | yes |
| same-origin 403 (the WAF shape) | `403` | 307 | yes |
| same-origin 500 | `500` | 304 | yes |
| cross-origin, no CORS | `0` | 0 | yes (URL visible) |
| connection refused | `0` | 0 | yes |

On Android this is real confirmation. We can positively assert "the cart POST
returned 200," and distinguish a WAF 403 from a server 500 from a dead
connection — which the DOM cannot tell us at all.

Measured on **WebKit (iOS)**, the same scenarios:

| Field | Result |
|---|---|
| `responseStatus` | **not implemented** — the property is absent |
| `transferSize` / `encodedBodySize` / `responseStart` | `0`, even same-origin |
| URL, `initiatorType`, `duration` | present and correct |
| connection-refused request | **no entry recorded at all** |

So on iOS this is **attempt detection, not confirmation**. We learn that a cart
request fired and how long it took, never whether it succeeded.

Limitations that apply to both engines:
- **No request body**, so no SKU. We learn *a* cart mutation happened, not *which
  product*. Correlating it to an item still depends on us having just clicked that
  item's button.
- **Cross-origin cart endpoints are opaque** (status 0, sizes 0). Several
  storefronts post to an `api.*` host. Per store, we'd have to check.
- `responseStatus === 0` is ambiguous between "opaque cross-origin" and "request
  failed." Resolvable by comparing the entry's origin to the page's.

### C. Native interception — not viable cross-platform

- **Android:** `WebViewClient.shouldInterceptRequest` sees every subresource
  request including XHR, but exposes **no request body** and no response unless we
  perform the fetch ourselves — which means taking over cookie and session
  handling for the store's own API call. Unacceptable risk for a read.
- **iOS:** WKWebView has no public API for observing XHR. `WKURLSchemeHandler`
  only handles custom schemes, not `https`.
- `onShouldStartLoadWithRequest` in react-native-webview only fires for main-frame
  navigations, not XHR, so it never sees a cart POST.

iOS is the platform that currently works. A confirmation strategy that only exists
on Android isn't a strategy.

---

## What this means for the confirm signal

The honest framing: **network observation improves speed and diagnosis, not
ground truth.** The only true ground truth is reading the cart itself, which the
reconcile pass already does. Network entries tell us what the page *attempted*;
the cart tells us what the store *recorded*.

Where it genuinely helps is a distinction the DOM cannot draw. Today a failed add
looks the same whether:

1. our click hit nothing (bad selector — the button moved),
2. the click fired a cart request that the store rejected (403/500 — WAF or stock),
3. the request succeeded but the DOM didn't reflect it in our timeout window.

These have completely different fixes — push a selector config, back off the
concurrency, raise a timeout — and today all three land in the funnel as
`confirm: timeout`. With resource-timing entries they separate cleanly, and on
Android they separate *with the HTTP status attached*.

That maps directly onto the funnel already built: `add_click` becomes evidence-
backed rather than "we called injectJavaScript," and `confirm` gains a `detail`
distinguishing rejected-by-store from no-request-at-all.

## Recommendation

1. **Ship technique B as a diagnostic layer, not a replacement.** Add a
   `PerformanceObserver` to the injected add scripts that records cart-endpoint
   entries, and attach them to the `add_click` / `confirm` telemetry `detail`.
   Keep the existing DOM confirmation as the decision-maker.
2. **Put the cart-endpoint URL patterns in the remote automation config**
   (`stores.<id>.cartEndpointPattern`). They will drift exactly like selectors do,
   and the config plumbing already exists — this is a natural fit.
3. **Promote it to a confirm signal on Android only, per store, and only after the
   funnel shows it agrees with the cart reconcile.** We now have the measurement
   apparatus to check that claim instead of assuming it. Do not promote it on iOS;
   `responseStatus` isn't there.
4. **Do not patch `fetch` or `XMLHttpRequest` in production, and do not mask
   `Function.prototype.toString` in production.** If we ever want the full
   request/response fidelity for debugging, gate it behind `__DEV__` and the
   emulator check, exactly like the existing dev-only fingerprint layer.

## Reproducing

The three probe scripts were run from the app root with the repo's existing
Playwright dependency. They are not committed — they test browser behavior, not
our code, so they'd be dead weight in CI. To re-derive: inject instrumentation via
`page.addInitScript`, serve a page that POSTs to a routed cart endpoint, and read
back `PerformanceObserver` entries plus the iframe-`toString` probe.
