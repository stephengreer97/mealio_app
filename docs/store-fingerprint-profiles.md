# Store fingerprint profiles

**What trips each store's bot defences, what we do about it, and how strongly each
of those claims is actually known.**

MEAL-32. Written 2026-08-08 against `origin/main` (`03da52f`).

---

## Why this file exists

Several things in the WebView cart engine look like sloppiness until you know the
history. A 400 ms stagger before dispatching workers. A store that runs its
searches one at a time when it has perfectly good parallel worker scripts sitting
in the binary. A navigation helper that goes out of its way *not* to append a
cache-busting query. An `injectedJavaScriptBeforeContentLoaded` prop that is
deliberately `undefined` on iOS.

Every one of those is load-bearing, and the feedback loop for breaking one is
slow, indirect and lands on users rather than on CI: a store starts serving 403s
or a challenge wall, days later, to people who are not you. "Cleaning up" any of
them is how that happens.

This document is the record. **Read it before changing worker counts, stagger,
jitter, navigation shape, or anything injected before content.**

### Its one rule

Anti-bot work rots into folklore faster than any other kind, because the evidence
is a thing that stopped happening. So every claim below carries how it is known,
and claims of different strength are never blended into a sentence. If you add to
this file, grade what you add.

| Grade | Meaning |
| --- | --- |
| **Measured** | Someone ran it against the live store and recorded the outcome. The variable was isolated. |
| **Observed** | A block was seen in the field, a change was made, the block stopped. The variable was **not** isolated — something else changed at the same time, or only one direction was tried. |
| **Inferred** | A conclusion drawn from a measurement of something adjacent. Reasonable; never tested on its own. |
| **Asserted** | Stated in a comment or commit message with no recoverable evidence behind it. Folklore until measured. Not necessarily wrong — but do not spend anything on it. |

Grades are about the *evidence*, not the *confidence*. An Inferred claim can be
one you would bet on. The grade tells you what happens if you act on it and it
turns out to be false.

---

## Part 1 — the posture that is the same everywhere

These are properties of the engine, not of any store. Changing one changes every
store at once, which is exactly why they are collected here first.

### 1.1 User agent — one UA, every store, on purpose

`getStoreWebViewUA()` (`src/lib/webview-user-agent.ts`) returns **the same string
for every store.** There is no per-store UA and there is not going to be one.

- **iOS** — `buildIosUA(Platform.Version)`. Real Mobile Safari, real live OS
  version, trimmed to `major.minor` because real Safari never reports a patch
  digit. *(Measured, for the shape: `webview-user-agent-build.ts` documents Safari's
  actual format. Inferred, that a patch digit specifically gets us flagged.)*
- **Android** — `buildAndroidUA(major)`. Chrome's post-UA-reduction frozen string:
  `Android 10; K` on every device, whatever the hardware. Only the Chrome major
  is dynamic, detected at runtime by `WebViewVersionProbe` from the system
  WebView. *(Measured — Chrome's UA reduction is documented protocol behaviour,
  and the reduced string is verifiable against any real Chrome.)*

**The Android constraint that is easy to break.** The native WebView broadcasts
its *real* Chromium major in the `Sec-CH-UA` header on every request no matter
what `userAgent` string we set. If our UA advertises a different major than the
device's actual WebView, UA and client hints disagree — a spoofing signal with no
upside. That is the entire reason `ANDROID_CHROME_MAJOR` (138) is a *fallback*
and not the value. *(Measured — Sec-CH-UA is emitted by the platform and was
observed disagreeing before the probe was added; see `e835dae`, `160dc8e`.)*

iOS WKWebView sends no client hints, so it has no second channel to disagree
with. *(Measured.)*

**Do not add a per-store UA.** Beyond it being a new fingerprint surface to keep
consistent, MEAL-33 is a settled decision against impersonating a retailer's own
first-party client. Asserting an identity that is not ours invites a targeted
response instead of generic anti-bot handling.

### 1.2 Injection timing — the most important rule in this file

| Platform | `injectedJavaScriptBeforeContentLoaded` |
| --- | --- |
| **iOS** | **`undefined`. Nothing. Ever.** |
| **Android** | `WEBVIEW_FINGERPRINT_SHIM` only |

Set at `WebViewCartSheet.tsx:246`, `SilentLoginProbe.tsx:72`,
`FingerprintProbe.tsx:191` — three sites, all identical, all
`Platform.OS === 'android' ? … : undefined`.

Everything else the engine injects — search scripts, add scripts, cart counters,
login checks — runs **after** load, via `injectJavaScript()` or from `onLoadEnd`.
That is a materially different thing: it runs after the storefront's own sensor
has already fingerprinted the page.

The production Android shim is deliberately about four lines of real work. It
sets `navigator.webdriver` to false and stops. Device identity is handled
natively (§1.3), not in JS, because native metadata is real WebView configuration
rather than JS tampering and cannot be caught by a sensor probing for patched
functions. *(Inferred, but strongly: the reasoning is sound and the alternative
was tried and failed — see §1.4.)*

There is a second, much larger dev-only layer in the same file (WebGL renderer,
`navigator.platform`, core count, client-hint model). It is gated behind
`__DEV__` **and** a runtime emulator-renderer check, so a debug build on a real
device is a complete no-op. It exists because the x86_64 emulator's truth is
wrong, not because real devices need spoofing. *(Measured — the emulator gate is
a live WebGL renderer string test.)*

### 1.3 Android client hints come from native, and must not be re-derived in JS

`patches/react-native-webview+13.15.0.patch` rewrites `Sec-CH-UA` brands to real
Chrome and fills high-entropy `model` / `platformVersion` from `android.os.Build`.
Applied by `patch-package` on postinstall; it needs a native build, so it is
**absent in Expo Go**.

**The trap:** because Chrome's reduced UA carries no device identity at all
(`Android 10; K`), a JS layer that derives `model`/`platformVersion` *from the UA*
would now inject those frozen placeholders over the correct native values. The
shim's header comment says this explicitly. MEAL-44's description still describes
an older shim that normalized empty `model`/`platformVersion` to `Pixel 9` /
`16.0.0`; **the code has moved past that ticket** and the ticket is the stale one.

### 1.4 The removed app-banner suppressor — the one real block we caused

This is the most important entry in the file, and the most commonly
mis-remembered. Commit `5103bf8` (2026-07-13) deleted
`src/lib/webview-appbanner-suppressor.ts`. What it did:

- a broad `MutationObserver` sweeping for app-install overlays, and
- a `localStorage` pre-seed of Walmart's `appBannerHistory` frequency cap,

both injected **before content**, on **both platforms**.

**What is known:** Walmart/PerimeterX blocks were seen while it was live, and
removing it stopped them. *(Observed.)*

**What is not known, and is routinely stated as if it were:** *which part* did it.
The change removed the DOM sweep, the storage write, **and** all iOS
before-content injection, in one commit. Three variables, one result.

The comment now at `WebViewCartSheet.tsx:242-245` reads:

> *an injected before-content script is itself a signal to aggressive bot defenses
> (e.g. Walmart/PerimeterX)*

That sentence is **Inferred**, and it is the strongest of the three readings. The
commit message itself makes the narrower and better-supported claim:

> *DOM and storage tampering before the page's own sensor loads is exactly the
> signal these defenses score*

So, graded honestly:

| Claim | Grade |
| --- | --- |
| Something in the suppressor tripped Walmart/PerimeterX | **Observed** |
| Pre-content DOM/`localStorage` tampering is what did it | **Inferred** — the commit's own reading, and the most likely one |
| Pre-content injection *per se* is a signal on iOS | **Inferred**, confounded — never isolated. Android still injects before content and is not known to be blocked for it. |

**This distinction is load-bearing**, because MEAL-46 wants the suppressor back
and asks precisely this question: is the generic overlay remover safe if the
`localStorage` pre-seed is dropped? Today's code cannot answer it. Anyone
reviving that work must isolate the variable — one change at a time, measured
against `waf_block` share per store (§4) — and must not treat the current comment
as having settled it.

Meanwhile the conservative reading is the one in force, and **that is correct
under uncertainty**: the cost of keeping iOS clean is one cosmetic nag banner, and
the cost of being wrong is a blocked store.

### 1.5 Concurrency and cadence defaults

| Knob | Value | Where |
| --- | --- | --- |
| Search-pool workers | 3 (was 5) | `WebViewCartSheet.tsx:706`, per-store overridable |
| Initial dispatch stagger | 400 ms + up to 400 ms jitter per worker | `:707`, `useParallelSearchPool.ts:333` |
| Add-pool workers | per-store `workerCount`, else `flags.parallelAddWorkers` (3) | `:712` |
| Add-pool stagger | store stagger, else 500 ms | `:747` |
| Pre-search commit jitter | 500 ms + up to 500 ms | `:801` |
| Pre-search cold slot | +1 concurrent surface beyond `workerCount` | `:827` |
| Silent login pre-warm | strictly one store at a time | `LoginPrewarmContext.tsx` |

The stagger is `i * base + random(0, base)` — deliberately not a fixed metronome,
so the initial burst is neither simultaneous nor evenly spaced. *(Asserted, as an
anti-bot measure. The mechanism is real and the intent is documented; no store is
known to have been measured with and without it.)*

Global defaults were dropped from 5 to 3 "for anti-bot reasons". *(Asserted.)*
The only *measured* fact about 5 workers is a different failure mode entirely:
**5 concurrent add WebViews crashed the iOS WKWebView content process** on
Albertsons — memory, not bot defence. *(Measured, commit `80b3314`.)* Note that
commit set Albertsons to **4**; today it is **3**. The drop from 4 to 3 has no
recorded reason.

### 1.6 How a block is detected, and what gets recorded

Five independent detectors, all funnelling into one place:

| Detector | Where | Fires on |
| --- | --- | --- |
| HTTP status | `handleHttpBlock`, `:2280` | 403 / 429 / 503 on a **top-level page** URL on the store domain (`isLikelyPageUrl` filters subresources and `/api/`) |
| URL marker | `onLoadEnd`, `:2054` | `/blocked(\?\|$)` — Walmart's press-and-hold wall |
| No progress | `consecutiveTimeoutsRef`, `:1760`/`:1856` | `timeouts.consecutiveTimeoutBlock` (2) consecutive search/add timeouts |
| Empty state | `:2304` | Amazon Fresh `fresh-no-store` (mapped to `auth_required`, not `waf_block` — it means no delivery address, not a wall) |
| Cart query | `heb-cart-query.ts:354` | HEB 401/403, an `incidentId` body, or the ABP interstitial. **Behind `cartSkuConfirm`, which ships OFF** |

All of them route through `surfaceBlocker()` (`:2257`), which tears down the run,
shows the live page to the user, and records exactly one row:
`step: 'blocked'`, `outcome: 'blocked'`, `code: blockFailureCode(reason)` — which
is `waf_block` for everything except `fresh-no-store`.

Per-item worker blocks are separate: a worker reporting `reason: 'blocked'` emits
its own `blocked` row via `recordPoolAddOutcome` (`automation-telemetry.ts:679`).

---

## Part 2 — per-store profiles

Config values below are the **bundled defaults** in
`src/lib/automation-config/schema.ts`. Every one is remote-overridable; a live
device may be running something else.

### H-E-B — Imperva Advanced Bot Protection

| | |
| --- | --- |
| Defence | Imperva ABP (`reese84` token) |
| Platform | `standalone` |
| Workers | unset → 3, stagger 400 ms |
| Serial? | No — parallel search **and** parallel add |
| Cache-bust | default **on** (`?_t=<ts>`) |
| Navigation | `spaSearch: true` |
| Extras | `nextDataSearch: false`, `cartSkuConfirm: false` |

**The one hard measurement we have.** H-E-B **Access-Denies the Android
emulator**, and does so at the *JS challenge* stage — meaning TLS and headers
passed and the remaining tells are emulator-specific (canvas/audio/font
rendering, debuggable WebView). Confirmed **not** the IP: an iPhone works from
the same IP. Confirmed **not** parallel adds: it fails on a single item, before
login. *(Measured, MEAL-43.)*

The correct conclusion is narrow and often over-read: **the emulator is invalid
for WAF testing.** It is not evidence that H-E-B blocks real devices. That is
what MEAL-44 exists to settle and it has not run.

`spaSearch: true` is not an anti-bot setting. H-E-B's `/search?q=` route fires
`onLoadEnd` twice for the same URL while the injected script is still running;
without the flag the engine re-injects and duplicates the add run. *(Measured —
the failure was traced end to end, see the comment at `schema.ts:280`.)*

**Two off-by-default flags that would change the network profile if turned on:**

- `nextDataSearch` — read results from `__NEXT_DATA__` instead of the DOM. Same
  requests, different parsing. Low fingerprint risk.
- `cartSkuConfirm` — **issues a GraphQL cart read per add.** This is the one that
  matters. ABP profiles *behaviour* — cadence, ordering, volume — not just
  tokens, and its tolerance for a rail issuing a cart read per add **has never
  been tested** (MEAL-115, on hold; MEAL-12's largest open unknown). Eight
  anonymous probes is not thirty authenticated adds. Do not flip this without
  MEAL-115.

### Walmart — PerimeterX. The most sensitive store we drive.

| | |
| --- | --- |
| Defence | PerimeterX |
| Platform | `standalone` |
| Workers | unset → 3, stagger 400 ms |
| Serial? | No |
| Cache-bust | default **on** |
| Navigation | `spaSearch: true` |
| Wall | `/blocked?url=<original>` — solvable press-and-hold |

The only store with a **solvable** wall, and the engine handles it as a resume
rather than a failure: `onLoadEnd` sees `/blocked`, saves the current search
index, shows the WebView so the user can press and hold, and resumes at the saved
index once the URL leaves `/blocked`. *(Measured — the redirect shape is pinned
in code and the resume path is written around it.)*

**HTTP blocks deliberately do not auto-resume.** A 403 has no marker and nothing
to solve; re-navigating just re-blocks, which produced a tight 403 loop. The user
taps "Try again". *(Observed — the loop was seen, `36b4a46`.)*

Walmart is where the app-banner suppressor got us blocked (§1.4) — *the* data
point behind "Walmart/PerimeterX is the most sensitive". *(Observed.)* Note the
honest caveat: it is the store where we are known to have **provoked** a block. It
may be the most sensitive, or it may be the one we poked hardest.

`spaSearch: true`, again for the duplicate-add race, not for bot defence. The
comment is explicit that it must stay true — flipping it reintroduces a
double-add where the next item's navigation race-cancels the cart POST and the
item reverts to 0. *(Measured.)*

> **Live risk — see MEAL-152.** `https://www.walmart.com/cart` 302s to the
> homepage, discarding the path, and returns a confident `count: 0`. That is a
> correctness bug rather than a fingerprint one, but it lives on the same
> navigation path and anyone retuning Walmart navigation will meet it.

### ALDI (Instacart Storefront) — the clearest measurements in the file

| | |
| --- | --- |
| Platform | `instacart` (shared adapter, `instacart.ts`) |
| Workers | 3 configured, **not used** |
| Serial? | **Yes** — `forceSerialSearch: true` |
| Cache-bust | **off** — `cacheBustNav: false` |
| Navigation | `spaSearch: true`, side-panel cart (no cart page) |

Two independent triggers, and ALDI is the only store where the concurrency
trigger was isolated:

1. **Concurrency itself.** ALDI's anti-bot 403s concurrent worker requests.
   Confirmed **2026-06-17** that 5 parallel workers *still* 403 with the
   cache-buster already removed — so the two are separate causes, not one.
   *(Measured. This is the strongest evidence in this document: one variable
   changed, the other held.)*
2. **The `?_t=` cache-buster query.** The anti-bot 403s the synthetic query; it
   lands directly on the blocked storefront request. *(Observed, `36b4a46`.)*

`workerCount: 3` and `workerStaggerMs: 400` are retained but dead — the store runs
serial. They are there so a config push can re-enable the parallel path if ALDI's
posture ever changes, without a release. **They are not evidence that 3 workers
are safe on ALDI; 5 are known unsafe and 3 have never been tried.**

`navTo` handles the opt-out by navigating to the clean URL and calling `reload()`
when it is already the current source. ALDI's cart is an in-page side panel, so
it never touches the cache-busting cart-page navigation path (§3.1) — which is
why the inconsistency described there does not bite here.

### Wegmans — serial, and the reasoning is thinner than ALDI's

| | |
| --- | --- |
| Platform | `standalone` (MSAL / SSO bootstrap) |
| Workers | 2 configured, **not used** |
| Serial? | **Yes** |
| Cache-bust | **off** |
| Navigation | no `spaSearch` — relies on SSO/MSAL inflight re-injection |

**Measured:** the Wegmans WAF 403s concurrent worker searches, and **even 2
staggered workers were still blocked**. That is a real measurement and a
meaningfully different one from ALDI's — it says the floor is 1, not merely
"lower than 5". *(Measured, `36b4a46`.)*

**Not measured:** the cache-buster. The commit says *"Also drop the `?_t=`
cache-buster on main-webview navs"* — "also", in the same breath as ALDI's fix.
Read plainly, this was applied **prophylactically by analogy to ALDI**, not
because a Wegmans request was seen failing on `?_t=`. **Grade: Inferred.**

That matters, because Wegmans is the store where §3.1's inconsistency actually
lands: it opted out of the cache-buster, and its cart-page navigations still send
one.

### Albertsons family (15 banners, one storefront)

| | |
| --- | --- |
| Platform | `albertsons` — one shared config entry and one selector table for all 15 |
| Workers | **3**, stagger 400 ms |
| Serial? | No |
| Cache-bust | default **on** |
| Cart | `/erums/cart` — a separate Angular app from `/shop` |

All 15 banners (Safeway, Vons, Jewel-Osco, Acme, Shaw's, Randalls, Pavilions,
Haggen, Carrs, Kings, Balducci's…) read the single `albertsons` config entry, so
`enabled: false` stops the whole family at once. Deliberate — see the comment at
`schema.ts:385`.

**The worker count here is a memory limit that got explained as an anti-bot
limit, and the two have been conflated ever since.** What was measured: 5
concurrent add WebViews **crashed the iOS WKWebView content process** (shared
memory budget). *(Measured, `80b3314`.)* No Albertsons WAF block has ever been
recorded. The current comment says 3 "is proven safe and matches the low global
default for anti-bot reasons" — *proven safe* is **Asserted**; what is proven is
only that 5 crashes.

Also note the undocumented drift: `80b3314` set it to **4**; today it is **3**.

### Amazon Fresh

| | |
| --- | --- |
| Platform | `standalone` |
| Workers | unset → 3, stagger 400 ms |
| Serial? | No |
| Cache-bust | default **on** |
| Cart | click-path (cart icon), not a URL |

No bot-defence measurement of any kind. Amazon **passed** on the Android emulator
where H-E-B failed. *(Measured, MEAL-43.)*

Its one special case is not a block at all: the Fresh empty state means no store
or delivery address is selected. It reuses the challenge UI to surface the
storefront, but maps to `auth_required`, deliberately, so it never pollutes the
`waf_block` rate. *(Measured — the mapping is explicit at
`automation-telemetry.ts:240`.)*

### Kroger family

Not driven by this app. The Kroger banners (Kroger, Fred Meyer, King Soopers,
Ralphs, QFC, Dillons, Smith's, Fry's, Harris Teeter, Mariano's…) run through the
Kroger Brands web extension. The `'kroger'` `PlatformId` is declared with no
selector table so a config push can pre-stage one before an adapter ships.

The extension shares MEAL-4's failure-code vocabulary and writes into the same
table, so its `waf_block` rows land in the same funnel. **Codes are append-only
and shared** — renaming one splits a metric's history across two systems.

### mockstore

Dev/test only, local server, `MOCK_STORE_ENABLED`-gated. No bot defence, no
cart-page identity guard, deliberately excluded from the guarded registry.

---

## Part 3 — inconsistencies found by this audit

Nothing here was changed. Each is either a live risk or a decision that is not
mine to make. See "Live risks" at the end.

### 3.1 `cacheBustNav` is honoured at one navigation site out of five

`navTo()` (`WebViewCartSheet.tsx:1163`) is the documented, opt-out-respecting
navigator. **Four other sites append `?_t=<ts>` unconditionally:**

| Site | Purpose |
| --- | --- |
| `WebViewCartSheet.tsx:823` | pre-search cold-slot dispatch |
| `WebViewCartSheet.tsx:1067` | cart-page probe (before/after snapshot) |
| `WebViewCartSheet.tsx:2004` | cart before-probe |
| `SilentLoginProbe.tsx:125` | pre-warm cart pre-capture |

**Who is exposed:** a store with `cacheBustNav: false` **and** a cart-page URL.
Today that is exactly **Wegmans** (`https://www.wegmans.com/cart`). ALDI is safe
by accident — its cart is an in-page side panel, so it takes the inline branch.
The two pre-search sites are unreachable for both, since both stores set
`forceSerialSearch`, which disables the parallel and pre-search paths entirely.

So: **the pre-warm probe and the cart snapshot send Wegmans a `?_t=` query on a
store that has opted out of them.** Whether that costs anything depends on the
Wegmans opt-out being real, which is exactly the Inferred claim above.

**Not fixed here, on purpose.** Making these honour `cacheBustNav` would change
what requests Wegmans actually receives, which the MEAL-32 brief rules out
without a measurement. It is also not obviously a fix in the wanted direction:
the argument for the cart probe's cache-buster is that a stale cached cart page
produces a wrong baseline, and MEAL-152 shows what wrong cart baselines cost.

### 3.2 Four remote-config keys are declared, validated, and never read

`FlagConfig` declares five keys. **The engine reads one.**

| Key | Bundled | Read by the engine? |
| --- | --- | --- |
| `flags.parallelAddWorkers` | 3 | **Yes** — `WebViewCartSheet.tsx:712` |
| `flags.addCommitJitterMs` | 500 | No — `:801` used the `features.ts` constant |
| `flags.parallelAdd` | true | No — `:1915` used the `features.ts` constant |
| `flags.presearchAdd` | true | No — `:1597` used the `features.ts` constant |
| `flags.backgroundCart` | true | No |

They merge, they type-check, they are bounds-checked, `automationConfigMerge.test.ts`
asserts that malformed values are refused — and then nothing consumes them. A
config push setting `flags.parallelAdd: false` did nothing at all.

The first three are fixed in this change (Part 5). `flags.backgroundCart` is left
alone: it selects the mount site for the cart engine, not a request pattern, and
belongs to whoever owns `CartJobContext`.

### 3.3 The add-pool stagger silently overrides an explicit zero

`WebViewCartSheet.tsx:747`: `dispatchStaggerMs: PARALLEL_WORKER_STAGGER_MS || 500`.

`||`, not `??`. A store configuring `workerStaggerMs: 0` — the documented way to
say "dispatch all at once", and a legal value under `NUMERIC_BOUNDS`
(`min: 0`) — gets **500 ms** on the add pool anyway.

Harmless today: no store sets 0. But it is a config knob that lies about one of
its legal values, and 0 is the value someone would reach for while
A/B-ing whether the stagger does anything. Left alone because changing it is a
behaviour change for any store that ever sets 0.

### 3.4 The pre-search cold slot is concurrency that `workerCount` cannot see

`coldWorkerCount: FEATURE_PRESEARCH_ADD ? 1 : 0` (`:827`) adds one more
concurrent add surface — the main WebView — beyond `workerCount`. Setting
`stores.X.workerCount: 1` to calm a store down still leaves **two** concurrent
surfaces.

Deliberately **not** made configurable. `forceSerialSearch` already gives a
per-store kill for the whole parallel path, and `flags.presearchAdd` (now wired)
gives a global one; a third dial for the residual +1 is a knob nobody turns.
Recorded here so the arithmetic is not surprising to the next reader.

---

## Part 4 — can we actually correlate any of this against block rates?

The ticket asks for the audit to be checked against observed per-store
`waf_block` rates. **The plumbing is complete end to end. I could not read the
numbers from here, and that limitation is worth stating precisely.**

### The pipeline exists

1. `POST /api/usage/automation` `{phase:'start', storeId}` returns a `runId`,
   binding run → store (`api.ts:688`).
2. `AutomationTelemetry` batches `StepRecord`s to
   `POST /api/usage/automation/steps`, keyed by `runId`, deduped on
   `(runId, seq)` (`api.ts:742`).
3. Server-side, `mealio_central/lib/automation-funnel.ts` aggregates rows that
   carry `store_id` directly, and computes `blocked: { steps, runs, rate }` plus
   a headline `blockedRate` per store.

So the answer to "is the per-store `waf_block` rate computable today?" is
**yes** — MEAL-2 built it, MEAL-6's own note confirms the rates are computable.
This ticket does not need to build anything.

### Four things about that number, before anyone trusts it

- **It is runs, not rows.** A walled-off run emits one blocked row per item, so
  blocked-steps-over-runs is a ratio of two different units — it rendered
  "WAF blocked 500.0%" before it was fixed. `blockedRate` is blocked **runs** over
  observed runs.
- **A blocked item is counted twice in `failureCodes`.** `recordPoolAddOutcome`
  emits a `blocked` row *and* a `confirm` row for the same item, both coded
  `waf_block`, and `run_summary` carries no `itemIndex`. Counting **items** rather
  than rows means counting distinct `itemIndex` on the blocked rows.
- **Uncoded rows are not zero.** Every row written before MEAL-4 shipped has a
  null code and cannot be backfilled (steps upsert with `ignoreDuplicates`). They
  land in `UNCODED`. Any per-store rate computed over a window spanning that
  boundary understates blocks.
- **Some stores' funnels used to read artificially clean.** MEAL-122: the
  parallel and pre-search pools emitted no per-item rows at all, on the four
  busiest stores. That is fixed on `main` (`recordPoolAddOutcome` now emits
  `blocked` rows), but it means **historical** `waf_block` shares for HEB,
  Walmart, Amazon Fresh and Albertsons are biased low, and
  `coverage.partialInstrumentation` exists to say so.

### What I could not do

Reading the actual rates needs the admin funnel endpoint in `mealio_central` with
production credentials. From this worktree I have neither, and per the standing
rule I will not go around the API to the database. **So every claim in Part 2 is
graded on code, commits and tickets — not on telemetry.**

**This is the honest gap in MEAL-32's third acceptance criterion ("correlated
against block rates rather than folklore"), and it is not closable from the app
repo.** Closing it means someone with dashboard access reading `blockedRate` per
store over a defined window and writing the numbers into Part 2. That is a
half-hour of work for someone with a login, and it should be booked against
MEAL-2/MEAL-6, not here.

Once those numbers exist, the highest-value checks are:

1. **Does Walmart's `blockedRate` actually exceed the others'?** The "most
   sensitive store" claim rests on one provoked incident (§1.4).
2. **Is Albertsons' rate non-zero at all?** If it is zero, `workerCount: 3` is
   confirmed as purely a memory limit and its comment should stop invoking
   anti-bot.
3. **Do H-E-B's real-device blocks exist?** Everything we know about H-E-B comes
   from an emulator that is known to be invalid for this test.

---

## Part 5 — what changed in this ticket

**No automation behaviour changed.** Every default below is the value that was
already hardcoded, so with no config published the engine does exactly what it
did before.

Three dead config keys wired to their call sites (§3.2):

| Key | Call site | Effect of a push |
| --- | --- | --- |
| `flags.addCommitJitterMs` | `:801` pre-search commit jitter | Spread the commit burst without a release |
| `flags.parallelAdd` | `:1915` parallel-add path gate | Globally fall back to sequential adds |
| `flags.presearchAdd` | `:1597` pre-search parking gate | Globally disable parked-page adds |

They are read through `cfgFlagsRef`, matching the file's existing idiom for
values consumed inside `[]`-dependency callbacks, so a stale closure cannot
capture an old value.

`parallelAdd` and `presearchAdd` had to be wired **together**. `beginSearchFlow`
tests the pre-search path *before* the parallel-add path, so wiring
`parallelAdd` alone would have produced a switch that reads as "stop doing
concurrent adds" and does not: parked workers would still fire their concurrent
commit.

Deliberately **not** touched: `flags.backgroundCart` (§3.2), the `|| 500` stagger
fallback (§3.3), the cold-slot count (§3.4), the cache-bust call sites (§3.1),
and every user agent, injected script and stagger value in the engine.

---

## Live risks and open decisions

Ranked. None acted on.

1. **MEAL-46 will re-introduce the one thing we know caused a block**, on the
   strength of a comment that overstates what was measured. It must isolate the
   variable (§1.4) — generic overlay remover and `localStorage` pre-seed tested
   separately, `blockedRate` compared before and after, one store at a time.
2. **`stores.heb.cartSkuConfirm` is one config push from an untested request
   cadence against Imperva ABP** (a cart read per add). The flag's own comment
   says so; MEAL-115 is on hold precisely for this. It should not be flipped in
   production before MEAL-115 runs.
3. **Wegmans receives cache-buster queries it is configured to have opted out of**
   (§3.1), on the cart-probe and pre-warm paths. Whether that is worth fixing
   depends on whether the Wegmans opt-out was ever more than an analogy to ALDI —
   which nobody knows.
4. **Everything we believe about H-E-B comes from an invalid instrument.**
   MEAL-44 (real device, production build) is the only thing that converts it
   into knowledge, and it has not run.
5. **Two stagger/concurrency values have no recorded reason** — the global 5→3 and
   Albertsons' 4→3. Both are conservative, so neither is urgent; both are places
   where a future "cleanup" would find no argument to push back against.
