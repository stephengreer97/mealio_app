/**
 * Manual mock for the `react-native-purchases` node module.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `react-native-purchases/dist/purchases.js` requires `./browser/nativeModule`,
 * which requires `@revenuecat/purchases-js-hybrid-mappings` — shipped as ESM.
 * jest-expo's `transformIgnorePatterns` does not cover that package, so any test
 * whose import graph reaches the real module dies with "Jest encountered an
 * unexpected token", pointing into node_modules and naming nothing the test
 * author wrote. `src/context/AuthContext` imports `src/lib/purchases`, which
 * imports this module, so that is most of the component tree.
 *
 * ── HOW IT APPLIES ─────────────────────────────────────────────────────────
 * This is a manual mock for a NODE module sitting in a root `__mocks__/`
 * directory, so Jest uses it AUTOMATICALLY, in every test file, with no
 * `jest.mock('react-native-purchases')` call anywhere. That is the point: the
 * previous defence was twelve test files each remembering to write the mock
 * themselves, and forgetting did not fail a test — it failed the whole suite
 * before one ran.
 *
 * It is also the risk, so: **a test that genuinely wants the real module has to
 * opt out with `jest.unmock('react-native-purchases')`** — and will then have to
 * solve the ESM transform problem this file exists to avoid. Nothing needs that
 * today.
 *
 * ── WHAT IS FAKED, AND WHAT IS NOT ─────────────────────────────────────────
 * Only the default export (the `Purchases` native-bridge class) is fabricated —
 * it is the part that cannot work off-device anyway. Every NAMED export is the
 * genuine article, re-exported from `@revenuecat/purchases-typescript-internal`
 * (plain CommonJS, and the same module the real package re-exports them from),
 * so `LOG_LEVEL.DEBUG`, `PACKAGE_TYPE`, `PURCHASES_ERROR_CODE` and friends carry
 * their real values rather than invented ones.
 *
 * The fake behaves like a device with no store and no entitlements: no
 * offerings, no active entitlement, no management URL. Combined with the real
 * `src/lib/purchases` — which bails out of `initPurchases()` when no RevenueCat
 * API key is in the environment, as is the case under test — every helper in
 * that module returns its "not available" answer. A test that wants a purchase
 * to succeed should keep its own `jest.mock('../../src/lib/purchases', …)` and
 * say so explicitly; this default is here to stop suites from failing to LOAD,
 * not to simulate a storefront.
 */

// The real package's named exports are `export *`s from this package's
// subpaths, so its export set is a superset of theirs. Requiring it here is
// safe: it is self-contained CommonJS and pulls in none of the ESM chain above.
const internal = jest.requireActual('@revenuecat/purchases-typescript-internal');

/** A CustomerInfo for someone who has never bought anything. */
function emptyCustomerInfo() {
  return {
    entitlements: { all: {}, active: {}, verification: 'NOT_REQUESTED' },
    activeSubscriptions: [],
    allPurchasedProductIdentifiers: [],
    nonSubscriptionTransactions: [],
    subscriptionsByProductIdentifier: {},
    allExpirationDates: {},
    allPurchaseDates: {},
    latestExpirationDate: null,
    originalPurchaseDate: null,
    originalApplicationVersion: null,
    originalAppUserId: 'mock-app-user-id',
    firstSeen: '1970-01-01T00:00:00.000Z',
    requestDate: '1970-01-01T00:00:00.000Z',
    managementURL: null,
  };
}

/** An Offerings with nothing for sale. */
function emptyOfferings() {
  return { all: {}, current: null };
}

const Purchases = {
  // Configuration
  configure: jest.fn(),
  isConfigured: jest.fn(async () => false),
  setLogLevel: jest.fn(),
  setLogHandler: jest.fn(),

  // Identity
  logIn: jest.fn(async () => ({ customerInfo: emptyCustomerInfo(), created: false })),
  logOut: jest.fn(async () => emptyCustomerInfo()),
  getAppUserID: jest.fn(async () => 'mock-app-user-id'),

  // Catalogue
  getOfferings: jest.fn(async () => emptyOfferings()),
  getProducts: jest.fn(async () => []),

  // Buying
  purchasePackage: jest.fn(async () => ({
    customerInfo: emptyCustomerInfo(),
    productIdentifier: 'mock-product',
  })),
  purchaseStoreProduct: jest.fn(async () => ({
    customerInfo: emptyCustomerInfo(),
    productIdentifier: 'mock-product',
  })),
  restorePurchases: jest.fn(async () => emptyCustomerInfo()),
  syncPurchases: jest.fn(async () => emptyCustomerInfo()),
  canMakePayments: jest.fn(async () => false),

  // Entitlement state
  getCustomerInfo: jest.fn(async () => emptyCustomerInfo()),
  addCustomerInfoUpdateListener: jest.fn(),
  removeCustomerInfoUpdateListener: jest.fn(),

  // Store-side subscription management (iOS-only on the real SDK)
  showManageSubscriptions: jest.fn(async () => {}),
};

module.exports = {
  __esModule: true,
  ...internal,
  default: Purchases,
  Purchases,
  // Exposed so a test that wants to hand back a bought entitlement can build a
  // CustomerInfo of the right shape instead of inventing a partial one.
  __emptyCustomerInfo: emptyCustomerInfo,
  __emptyOfferings: emptyOfferings,
};
