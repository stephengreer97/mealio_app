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

export interface StoreConfigEntry {
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
  stores: {
    heb: {
      enabled: true,
      storeUrl: 'https://www.heb.com',
      loginUrl: 'https://www.heb.com/my-account/login',
      cartUrl: 'https://www.heb.com/cart',
      searchUrlTemplate: 'https://www.heb.com/search?q={term}',
      selectors: {
        // Product title inside a search-result card. Appeared in three separate
        // copies of the HEB scripts before this table existed.
        title: '[data-qe-id="productTitle"]',
      },
    },
    walmart: {
      enabled: true,
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
    aldi: {
      enabled: true,
      // ALDI's anti-bot trips on both the synthetic cache-buster query and the
      // concurrent worker burst, so it runs serial with a clean URL.
      forceSerialSearch: true,
      cacheBustNav: false,
      spaSearch: true,
      workerCount: 3,
      selectors: {
        atc: 'button[aria-label^="Add 1 "]',
        inc: 'button[aria-label^="Increment quantity"], button[aria-label^="Increase quantity"]',
        qtyBubble: 'button[aria-label^="Quantity:"]',
        cardLink: 'a[href*="/store/aldi/products/"]',
        menu: '[role="dialog"][aria-label="Main Menu"]',
        hamburger: '[data-testid="hamburger-coachmark-button"], button[aria-label="Main Menu"]',
      },
    },
    wegmans: {
      enabled: true,
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
    // storefront platform and therefore one selector set. Per-banner URLs are
    // derived from the storeId by the adapter; only selectors live here.
    albertsons: {
      enabled: true,
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
