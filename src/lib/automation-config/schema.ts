// Shape + bundled defaults for the remote automation config.
//
// WHY THIS EXISTS
// Every selector, URL, and timeout the WebView cart engine uses to drive a
// storefront used to be baked into the app binary. When Albertsons renamed a
// button, every user stayed broken until a new build cleared App Store review.
// This module makes those values DATA: the app ships the table below as its
// fallback, fetches a partial override tree from mealio.co at launch, and merges
// one over the other. A store redesign becomes a config push, not a release.
//
// TWO RULES THAT MAKE THIS SAFE TO PUSH WITHOUT GATING ON APP VERSION
//   1. The remote payload is PARTIAL. It carries only the keys that differ from
//      what's here, so an empty {} is valid and means "the bundled table is fine".
//   2. Unknown keys are IGNORED, and every known key is type-checked and clamped
//      (see merge.ts). A malformed push degrades to the bundled default for that
//      one field — it can never brick the engine.
//
// The values here must stay in sync with what the store scripts actually do. They
// are the source of truth: the scripts interpolate FROM this table (see
// selectorsFor() in the webview-scripts modules), so editing a selector here
// changes the injected JS, and a remote override changes it without a release.

/** Per-store CSS selectors, interpolated into that store's injected scripts. */
export type StoreSelectors = Record<string, string>;

/**
 * The storefront PLATFORM a store runs on.
 *
 * Several banners can be the same software wearing different branding: every
 * Instacart Storefront tenant (ALDI today) renders the same components, and all
 * 15 Albertsons brands are one storefront behind 15 domains. Before this existed,
 * that fact lived only in prose — each banner carried its own copy of a selector
 * table, so a platform-wide markup change meant editing N tables and the copies
 * drifted. Naming the platform lets one selector table serve every banner on it
 * (see `AutomationConfig.platforms` and selectorsFor()).
 *
 * 'standalone' is the honest label for a store that shares its storefront with
 * nobody — HEB, Walmart, Wegmans, Amazon Fresh. It deliberately has no platform
 * selector table; saying it out loud is what stops a reader assuming the absence
 * of a `platform` field means "not yet classified".
 *
 * 'kroger' is declared but has no table, and never will need one: the Kroger
 * family runs on Kroger's public API, not on DOM automation, so there are no
 * selectors to name and nothing here for a redesign to break. It is declared so
 * a Kroger store's `platform` field can say what it actually is rather than
 * being mislabelled 'standalone'.
 */
export type PlatformId = 'instacart' | 'albertsons' | 'kroger' | 'standalone';

/** Runtime mirror of PlatformId, for validating a value that arrived as JSON.
 *  A remote `platform` outside this list is REFUSED — see mergeStore(). */
export const PLATFORM_IDS: readonly PlatformId[] = [
  'instacart',
  'albertsons',
  'kroger',
  'standalone',
];

export function isPlatformId(v: unknown): v is PlatformId {
  return typeof v === 'string' && (PLATFORM_IDS as readonly string[]).includes(v);
}

/**
 * Shared configuration for every store on one platform.
 *
 * Only selectors live here, on purpose. URLs, kill switches and worker knobs stay
 * per-store: those are the things that genuinely differ between two banners of the
 * same software, and a kill switch that took down 15 brands at once would be a
 * worse tool than one that takes down the banner that broke.
 */
export interface PlatformConfigEntry {
  selectors?: StoreSelectors;
}

export interface StoreConfigEntry {
  /**
   * Platform this store runs on, which is where it inherits selectors from when
   * it has none of its own.
   *
   * Usually redundant with what the adapter already knows — instacart.ts passes
   * 'instacart' to selectorsFor() directly — and that is deliberate: an adapter
   * declaring its own platform means a newly registered banner inherits platform
   * selectors WITHOUT needing an entry in this table at all. The field exists so a
   * config push can classify a store the running build has no adapter for, which
   * is how a banner gets pre-staged ahead of the release that adds it.
   *
   * A value this build does not recognise is refused by the merge, and even if one
   * reached us it would resolve to "no platform table" — never to "no selectors".
   */
  platform?: PlatformId;
  /** Kill switch. False makes getStoreScripts return null, so the store's
   *  automation is disabled without shipping a build — the escape hatch when a
   *  storefront changes so much that our scripts do harm rather than nothing. */
  enabled?: boolean;
  storeUrl?: string;
  loginUrl?: string;
  cartUrl?: string;
  /** Direct search-results URL. `{term}` is replaced with the encoded term. */
  searchUrlTemplate?: string;
  /** Concurrent worker WebViews for this store's parallel pool. */
  workerCount?: number;
  /** Stagger (ms) between initial worker dispatches. */
  workerStaggerMs?: number;
  /** Force the sequential path even when parallel scripts exist. */
  forceSerialSearch?: boolean;
  /** Append a ?_t=<ts> cache-buster on navigation. */
  cacheBustNav?: boolean;
  /** SPA storefront whose search changes the URL via pushState. */
  spaSearch?: boolean;
  /**
   * Read search results out of the page's embedded `__NEXT_DATA__` JSON instead
   * of scraping product cards out of the DOM (HEB only today — see MEAL-13).
   *
   * Default FALSE everywhere: the DOM extractor is the path that has shipped and
   * is known good, so a build behaves identically until someone publishes an
   * override. The JSON path always degrades back to the DOM extractor at runtime
   * when the payload is missing, unparseable, or belongs to a previous search,
   * so flipping this on can lose speed but not correctness.
   */
  nextDataSearch?: boolean;
  /**
   * Confirm each add against the store's own CART QUERY instead of the shared
   * header cart badge (HEB only today — see MEAL-14 and
   * webview-scripts/heb-cart-query).
   *
   * Default FALSE everywhere. The response shape the rail reads is verified from
   * committed cart captures, but the query document has never been executed
   * against a logged-in H-E-B session (MEAL-12's open gap 1), and neither has
   * Imperva ABP's tolerance for a rail issuing a cart read per add. Until both
   * are checked on a real device this stays off, and a build behaves exactly as
   * it does today.
   *
   * Turning it on cannot lose correctness: every way the cart read can fail —
   * blocked, non-200, GraphQL error, unexpected shape, timeout — resolves to
   * "we could not read the cart" and falls back to the badge rail, never to
   * "the item is missing".
   */
  cartSkuConfirm?: boolean;
  /**
   * Add to the cart by ASKING the store, instead of clicking its Add button
   * (MEAL-200). Measured working on a real cart: 333 ms, first attempt.
   *
   * Ships OFF. Turning it on can only affect items it is confident about — it
   * needs a product id AND a sku, and it declines outright for anything sold by
   * weight or carrying a purchase preference (see below). Everything else, and
   * every failure, goes to the click path unchanged.
   *
   * WHY WEIGHT AND PREFERENCE ITEMS ARE EXCLUDED, and it is not squeamishness:
   * their over-adds could not be walked back in testing.
   *
   * Removal is the SAME mutation with a zero — the storefront's own cart hook
   * does `onRemove = () => eo(0, 'REMOVE')`, and an earlier version of this
   * comment claimed no remove operation existed at all, which was wrong and
   * would have sent the next reader looking for something that is right there.
   *
   * What was actually measured is narrower and still disqualifying: on a
   * weight-priced line `quantity: 0` came back an error arm, and `weight: 0` was
   * ACCEPTED and left the line in the cart anyway. Whatever the storefront does
   * differently, we have no repeatable way to undo a weight add — so an over-add
   * on one is permanent for us, and the cart rules do not allow shipping a path
   * whose mistakes cannot be reversed. Count lines set back to 0 cleanly, and
   * that was measured too.
   *
   * REQUIRES cartSkuConfirm. The write reuses the cart rail's transport and
   * baseline, so with cartSkuConfirm off this flag is a silent no-op — push both
   * or neither.
   *
   * Flip it with a config push:
   *   {"stores":{"heb":{"networkAdd":true}}}
   */
  networkAdd?: boolean;
  /**
   * Search by asking the store, instead of loading a results page (MEAL-202).
   *
   * Measured 282 ms against ~1,800 ms to load and read a page, and it needs no
   * page at all — every term is answered from wherever the WebView already sits,
   * which also removes the worker WebViews and roughly 187 MB of the memory peak.
   *
   * The speed is the smaller half. Three request parameters retire classes of
   * extraction bug rather than fixing them: `excludeSponsoredContent` means
   * sponsored tiles are never asked for and so cannot be mistaken for results,
   * `includeOutOfStock` replaces reading stock off button text, and `pageSize`
   * states the result count instead of accepting however many tiles rendered.
   *
   * REQUIRES cartSkuConfirm, which is what supplies the shared transport. The
   * store and shopping context are read from the session on every run — nothing
   * is pinned to one store.
   *
   * Falls back to loading a page PER TERM. One term hitting the wall does not
   * take the rest of the run with it.
   *
   * Flip it with a config push:
   *   {"stores":{"heb":{"networkSearch":true}}}
   */
  networkSearch?: boolean;
  /**
   * Where the cart-confirmation rail POSTs its query — a same-origin path, not a
   * URL. `network-confirmation-findings.md` asks for cart endpoints to live in
   * remote config because they drift the way selectors do, and a hardcoded path
   * would need an app release to change even though `cartSkuConfirm`, the flag
   * that turns the rail on, is remote.
   *
   * Only a plain same-origin path is accepted. An absolute URL, a
   * protocol-relative `//host`, quotes or whitespace are refused and the bundled
   * default stands, because this string is interpolated into an injected script
   * and the safe failure is "query the endpoint we shipped with".
   */
  cartEndpoint?: string;
  selectors?: StoreSelectors;
}

export interface TimeoutConfig {
  addMs: number;
  searchMs: number;
  customSearchMs: number;
  loginCheckMs: number;
  cartProbeMs: number;
  cartProbeResultMs: number;
  cartRowsMs: number;
  parallelWorkerMs: number;
  /** Consecutive timeouts before the run is declared WAF-blocked. */
  consecutiveTimeoutBlock: number;
}

/**
 * Remote levers over automation behaviour.
 *
 * EMPTY since 2026-09-01. Every flag it held — parallelAdd, presearchAdd,
 * parallelAddWorkers, addCommitJitterMs — was a lever over the DOM worker
 * pools: whether to add concurrently, how many pages to hold open, how much to
 * jitter the burst. The pools are gone, so the levers control nothing and a
 * flag that controls nothing is worse than no flag: it reads like a safety
 * switch someone can pull in an incident.
 *
 * The shape stays so a future lever has somewhere to live.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FlagConfig {}

export interface TelemetryConfig {
  enabled: boolean;
  /** 0..1 share of runs that report steps. Lets us dial cost without a release. */
  sampleRate: number;
  /** Steps buffered before an upload is triggered. */
  batchSize: number;
  /** Max ms a buffered step waits before being flushed. */
  flushIntervalMs: number;
}

export interface AutomationConfig {
  timeouts: TimeoutConfig;
  flags: FlagConfig;
  telemetry: TelemetryConfig;
  /**
   * Selector tables shared by every store on a platform. Keyed by PlatformId, but
   * typed as an open record so a partially-populated table ('kroger' and
   * 'standalone' have none) is legal and a lookup of an id this build does not
   * know still type-checks to `undefined` rather than being a compile error.
   */
  platforms: Record<string, PlatformConfigEntry>;
  stores: Record<string, StoreConfigEntry>;
}

// ── Bundled defaults ────────────────────────────────────────────────────────
// These are the values that shipped before remote config existed, moved here
// verbatim so turning config on changes NO behavior until someone publishes an
// override. That property is what makes this safe to land in one commit.

export const BUNDLED_AUTOMATION_CONFIG: AutomationConfig = {
  timeouts: {
    addMs: 10_000,
    searchMs: 15_000,
    customSearchMs: 15_000,
    loginCheckMs: 20_000,
    cartProbeMs: 10_000,
    cartProbeResultMs: 14_000,
    cartRowsMs: 8_000,
    parallelWorkerMs: 20_000,
    consecutiveTimeoutBlock: 2,
  },
  flags: {},
  telemetry: {
    enabled: true,
    sampleRate: 1,
    batchSize: 25,
    flushIntervalMs: 10_000,
  },
  // ── Platform selector tables ──────────────────────────────────────────────
  // One table per storefront platform, inherited by every store that declares
  // that platform. A markup change on the platform is ONE push that reaches every
  // banner on it; a banner that diverges overrides the single key it needs at
  // `stores.<id>.selectors` (store beats platform — see selectorsFor()).
  //
  // Only selectors that are the same for every banner belong here. Anything woven
  // from a banner's own identity — ALDI's `cardLink`, which embeds the /store/
  // slug — cannot: this table is static JSON with no knowledge of which tenant is
  // reading it. Those stay per-store, or as a call-site fallback computed from the
  // tenant (see selFallbacks() in webview-scripts/instacart.ts).
  platforms: {
    // Instacart white-labels one storefront to many grocery banners. Every
    // selector here was read off ALDI, the only tenant that has ever run against
    // the real site, so treat them as the platform's likely shape rather than its
    // confirmed one until a second banner has captured fixtures (see MEAL-20).
    instacart: {
      selectors: {
        atc: 'button[aria-label^="Add 1 "]',
        inc: 'button[aria-label^="Increment quantity"], button[aria-label^="Increase quantity"]',
        qtyBubble: 'button[aria-label^="Quantity:"]',
        menu: '[role="dialog"][aria-label="Main Menu"]',
        hamburger: '[data-testid="hamburger-coachmark-button"], button[aria-label="Main Menu"]',
      },
    },
    // The Albertsons family (Safeway, Vons, Jewel-Osco, …) is one storefront behind
    // 15 domains. It always shared one selector set — by convention, via a
    // hardcoded 'albertsons' selector key in the adapter. Now it shares one by
    // STRUCTURE, so the sharing survives someone giving a banner its own entry.
    albertsons: {
      selectors: {
        atc: 'button[aria-label^="Add 1 unit of"]',
        bubble: 'button[data-qa="qty-stppr-bbl"]',
        increment: 'button[data-qa="prdctincrmntr"]',
        searchOpen: 'button[aria-label="search"]',
        // Login detection is heuristic across several header variants rather than
        // the documented span[data-qa="hdr-accnt-nm"].
        profileBtn: 'button[aria-label*="account" i], button[aria-label*="profile" i], a[aria-label*="account" i]',
        headerEls: 'header button, header a, nav button, nav a, [role="banner"] button, [role="banner"] a',
        card: 'li, article, [class*="ProductCard"], [class*="product-card"], [data-qa*="product"]',
      },
    },
    // 'kroger' and 'standalone' intentionally have no table. See PlatformId.
  },
  stores: {
    heb: {
      enabled: true,
      platform: 'standalone',
      storeUrl: 'https://www.heb.com',
      loginUrl: 'https://www.heb.com/my-account/login',
      cartUrl: 'https://www.heb.com/cart',
      searchUrlTemplate: 'https://www.heb.com/search?q={term}',
      // HEB's search route is an SPA re-render: landing on /search?q=<term> fires
      // onLoadEnd a SECOND time for the SAME url a beat after the first, while the
      // injected search+add script is still running. Without this flag the engine
      // treats that second same-URL load as a script-killing reload and re-injects,
      // spawning a duplicate SEARCH_AND_ADD_RESULT that over-advances searchIdxRef
      // and skips an item (see WebViewCartSheet onLoadEnd `reinjectInflight`). In
      // the sequential reconcile top-up this skipped past the last retry item into
      // 'done', firing the after-cart snapshot while the search page was still up —
      // so the snapshot counted the search results page and reported 0 items.
      spaSearch: true,
      // MEAL-13: HEB embeds the real search result set as JSON in
      // <script id="__NEXT_DATA__"> under the SearchGridV2 visual component,
      // where the sponsored/pairing carousels simply are not present. Reading it
      // is both cleaner and faster than __hebFindCards(), but HEB can change that
      // payload as easily as the markup, so the DOM extractor stays in the binary
      // as the fallback and this ships OFF. Flip it with a config push:
      //   {"stores":{"heb":{"nextDataSearch":true}}}
      nextDataSearch: false,
      // MEAL-14: confirm an add by asking H-E-B's cart what is in it, rather than
      // watching the header badge tick. Ships OFF for the reasons on
      // StoreConfigEntry.cartSkuConfirm — chiefly that the cart query has never
      // been run against a logged-in session. Flip it with a config push:
      //   {"stores":{"heb":{"cartSkuConfirm":true}}}
      cartSkuConfirm: false,
      // Same-origin path the cart query is POSTed to. Bundled rather than
      // hardcoded so a path change is a config push instead of an app release —
      // see StoreConfigEntry.cartEndpoint for what an override may look like.
      cartEndpoint: '/graphql',
      selectors: {
        // Product title inside a search-result card. Appeared in three separate
        // copies of the HEB scripts before this table existed.
        title: '[data-qe-id="productTitle"]',
      },
    },
    walmart: {
      enabled: true,
      platform: 'standalone',
      storeUrl: 'https://www.walmart.com/grocery',
      loginUrl: 'https://www.walmart.com/account/login',
      cartUrl: 'https://www.walmart.com/cart',
      searchUrlTemplate: 'https://www.walmart.com/search?q={term}',
      selectors: {
        card: '[data-automation-id="product"], [data-item-id]',
        title: '[data-automation-id="product-title"], [data-automation-id="name"]',
        addBtn: '[data-automation-id="add-to-cart"], button[aria-label*="Add to cart"]',
        incBtn: '[data-testid="quantity-stepper-inc-button"]',
      },
    },
    // ALDI runs on Instacart Storefront, driven by the shared adapter in
    // webview-scripts/instacart.ts. Its shared selectors now live in
    // platforms.instacart above; what stays here is what is ALDI's alone — the
    // anti-bot knobs, the kill switch, and the one selector that embeds its slug.
    //
    // Each Instacart banner still gets its OWN entry here, because they are
    // separate retailers: each is kill-switched and tuned alone, and each can
    // override any inherited selector by naming it under `selectors` below.
    aldi: {
      enabled: true,
      platform: 'instacart',
      // ALDI's anti-bot trips on both the synthetic cache-buster query and the
      // concurrent worker burst, so it runs serial with a clean URL.
      forceSerialSearch: true,
      cacheBustNav: false,
      spaSearch: true,
      workerCount: 3,
      // ── The Instacart rail ────────────────────────────────────────────────
      //
      // SEARCH ON, ADD ON. The add was off until its quantity semantics were
      // measured; they now are.
      //
      // Search and the cart read were MEASURED end to end against a live
      // session (docs/network-rail-research/02-aldi.md): every operation, its
      // arguments and its timing. The add was mapped the same way, but one
      // question about it has no answer yet — whether a write SETS a cart line
      // or ADDS to it. The script refuses any item the cart already holds
      // rather than guess, so turning it on would still be safe; it is off
      // because a half-answered add is not worth shipping when the search half
      // is the part that makes a run slow.
      //
      // MEASURED 2026-09-03 and the add is now ON. Stephen added one item by
      // hand and authorised a single write: the cart held 1, we wrote quantity 2
      // and read back 2, then restored it to 1. The line is SET, absoluteQty is
      // true in the rail, and held + wanted is the correct thing to write.
      //
      // OFF DOES NOT MEAN ASSISTED. A run where everything still needs choosing
      // never writes to a cart, so it takes the rail on this store's search
      // alone and ends at the Choose Products screen — measured on device at
      // 5.7s for six ingredients, all six answered. Until 2026-09-03 one flag
      // stood for both halves and this store got neither.
      networkSearch: true,
      networkAdd: true,
      selectors: {
        // Per-banner by nature: the /store/{slug}/ path is ALDI's, so this one
        // cannot be shared with the platform the way atc/inc/menu are.
        cardLink: 'a[href*="/store/aldi/products/"]',
      },
    },
    wegmans: {
      enabled: true,
      // ── The Wegmans rail ─────────────────────────────────────────────────
      //
      // SEARCH ON, ADD OFF, and for a different reason than ALDI's.
      //
      // Search here needs NO SESSION AT ALL. It is Algolia with a search-only
      // key that ships in the site's own request URLs -- MEASURED at 13ms with
      // a storeNumber filter, from a plain curl with no cookies and no token.
      // So it works for a signed-out user, it cannot be broken by an expired
      // token, and it is the fastest search of any store here.
      //
      // The cart is the other half and it needs a bearer. MSAL keeps that
      // ENCRYPTED ({id, nonce, data}, with a msal.cache.encryption cookie), and
      // the commerce API refuses the cookie session -- a no-cors request comes
      // back opaque, so it is answered and we are not allowed to read it. The
      // rail therefore has a token PROVIDER with fallbacks, and its
      // sessionUsable refuses to start a run until a token has actually been
      // used for something.
      //
      // The add is off because its ENDPOINT was never called: capturing it
      // meant adding to a real basket. To finish it, run the cart read with one
      // item added by hand, then watch the site add one more
      // (tools/rail-recon/watch.ts) -- that request is the answer, including
      // whether the body holds one item or a list.
      networkSearch: true,
      networkAdd: false,
      platform: 'standalone',
      forceSerialSearch: true,
      selectors: {
        tile: 'div.component--product-tile',
        name: 'h3[data-testid="-baseHeading"]',
        addBtn: 'button.default-add-button',
        incBtn: 'button.add-button',
        searchInput: 'input[type="search"], input[placeholder*="earch" i]',
      },
    },
    amazon: {
      enabled: true,
      platform: 'standalone',
      selectors: {
        // Amazon Fresh renders two distinct card layouts; both are matched.
        cardA: '[data-csa-c-item-type="asin"]',
        nameA: '.a-truncate-full.a-offscreen',
        atcWrapperA: '.qs-atc-plus',
        addBtnA: 'button[aria-label^="Add to Cart,"]',
        stepperA: '[id^="qs-widget-stepper-"]',
        qtyDisplayA: '.qs-widget-dropdown-flex-wrapper button[aria-label^="Current quantity"]',
        incBtnA: '.qs-widget-increment-button-flex-wrapper input[aria-label^="Add "]',
        cardB: '[data-component-type="s-search-result"]',
        nameB: 'h2',
        atcContainerB: 'span[data-action="fresh-add-to-cart"]',
        stepperB: 'fieldset[data-a-component="stepper"]',
        qtyDisplayB: 'span[data-a-selector="value"]',
        incBtnB: 'button[data-action="a-stepper-increment"]',
        atcBtnBMobile: 'button[aria-label="Add to cart"]',
        incBtnBMobile: 'span[data-action="qs-widget-increment-decl"]',
      },
    },
    // The Albertsons family (Safeway, Vons, Jewel-Osco, …) all share one
    // storefront platform and therefore one selector set — which now lives in
    // platforms.albertsons above. Per-banner URLs are derived from the storeId by
    // the adapter, and all 15 brands read this ONE entry (the adapter passes the
    // fixed key 'albertsons'), so `enabled: false` here still stops the family.
    albertsons: {
      enabled: true,
      platform: 'albertsons',
      // MEAL-204. The network rail is ON in the bundled default rather than
      // waiting on a config push, because the flags gate a path that cannot be
      // exercised at all until it is switched on, and a rail nobody can run is a
      // rail nobody can find the bugs in.
      //
      // It stays a REMOTE-OVERRIDABLE flag, so switching it off is a config push
      // rather than a release — which matters more here than for H-E-B, because
      // MEAL-207 has this store's search operation degrading under load and the
      // first honest response to that is to stop using it.
      networkSearch: true,
      networkAdd: true,
    },
  },
};

// Numeric guard rails. A remote push outside these ranges is REJECTED (the
// bundled default is kept) rather than clamped silently into a value nobody
// chose — a 100ms search timeout would fail every run, and a 10-minute one would
// hang the UI, so both are bugs worth refusing.
export const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  'timeouts.addMs': { min: 1_000, max: 120_000 },
  'timeouts.searchMs': { min: 1_000, max: 120_000 },
  'timeouts.customSearchMs': { min: 1_000, max: 120_000 },
  'timeouts.loginCheckMs': { min: 1_000, max: 120_000 },
  'timeouts.cartProbeMs': { min: 1_000, max: 120_000 },
  'timeouts.cartProbeResultMs': { min: 1_000, max: 120_000 },
  'timeouts.cartRowsMs': { min: 1_000, max: 120_000 },
  'timeouts.parallelWorkerMs': { min: 1_000, max: 120_000 },
  'timeouts.consecutiveTimeoutBlock': { min: 1, max: 20 },
  'telemetry.sampleRate': { min: 0, max: 1 },
  'telemetry.batchSize': { min: 1, max: 200 },
  'telemetry.flushIntervalMs': { min: 1_000, max: 300_000 },
  'stores.*.workerCount': { min: 1, max: 10 },
  'stores.*.workerStaggerMs': { min: 0, max: 10_000 },
};
