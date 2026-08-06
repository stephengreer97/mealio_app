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
 * 'kroger' is declared but has no table: the Kroger family runs through the web
 * extension, not this app's WebView engine. It is here so a config push can
 * pre-stage one before the adapter ships.
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

export interface FlagConfig {
  parallelAdd: boolean;
  presearchAdd: boolean;
  backgroundCart: boolean;
  parallelAddWorkers: number;
  addCommitJitterMs: number;
}

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
  flags: {
    parallelAdd: true,
    presearchAdd: true,
    backgroundCart: true,
    parallelAddWorkers: 3,
    addCommitJitterMs: 500,
  },
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
      selectors: {
        // Per-banner by nature: the /store/{slug}/ path is ALDI's, so this one
        // cannot be shared with the platform the way atc/inc/menu are.
        cardLink: 'a[href*="/store/aldi/products/"]',
      },
    },
    wegmans: {
      enabled: true,
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
  'flags.parallelAddWorkers': { min: 1, max: 10 },
  'flags.addCommitJitterMs': { min: 0, max: 10_000 },
  'telemetry.sampleRate': { min: 0, max: 1 },
  'telemetry.batchSize': { min: 1, max: 200 },
  'telemetry.flushIntervalMs': { min: 1_000, max: 300_000 },
  'stores.*.workerCount': { min: 1, max: 10 },
  'stores.*.workerStaggerMs': { min: 0, max: 10_000 },
};
