// MEAL-117. Everything we have committed that a store can rotate under us.
//
// Once a rail depends on identifiers lifted from a store's own bundle -- a
// persisted-query hash, an Algolia key, a query document, an API path -- a
// rename or a rotation breaks us SILENTLY. The run fails per-user, in the
// field, and nothing upstream knows why.
//
// This file is the inventory. Two things are built on it:
//
//   1. A test that scans the rails for identifier-shaped constants and fails if
//      one is not registered here. That is what stops the inventory going stale
//      the first time someone adds a hash in a hurry.
//   2. A live probe (scripts/check-schema-drift.mjs) that asks each store
//      whether the identifier is still accepted, WITHOUT being signed in --
//      "401 Not Authenticated" is a perfectly good yes.
//
// WHY THE BLAST RADIUS IS NOT ONE STORE. The Instacart hashes below are shared
// by every registered tenant -- ten of them as of 2026-09-07 -- because that
// sharing is what makes a new banner a config entry. One rotation at Instacart
// therefore breaks ten banners at once, which is the strongest argument this
// ticket has.

export type DriftProbe =
  /** POST the persisted hash and see whether the operation is still allow-listed. */
  | { kind: 'persisted_query'; origin: string; operationName: string; sha256: string }
  /** Ask Algolia whether the app id + search key still authenticate. */
  | { kind: 'algolia'; host: string; appId: string; apiKey: string; index: string }
  /** Send the document and see whether the server still recognises the operation. */
  | { kind: 'graphql_document'; origin: string; operationName: string }
  /** A path that must not 404. Weaker evidence, and labelled as such. */
  | { kind: 'path'; origin: string; path: string };

export interface DriftEntry {
  /** The rail that would break. */
  rail: string;
  /** Where the identifier is committed, so a failure points at a file. */
  source: string;
  /** What it is, in words, for whoever reads the alert at 3am. */
  what: string;
  /**
   * How many STORES break if this rotates. The Instacart hashes are shared, so
   * this is the number that should decide what gets fixed first.
   */
  breaks: number;
  probe: DriftProbe;
}

const IC = 'https://www.aldi.us';

/**
 * The Instacart operation hashes, shared by every tenant in INSTACART_TENANTS.
 *
 * Probed against ALDI because a persisted query is allow-listed by the
 * PLATFORM, not the banner -- measured 2026-09-07 by posting ActiveCarts' hash
 * to all ten origins and getting 401 from every one of them. Probing one is
 * therefore probing all ten, and probing ten would be ten times the traffic for
 * the same answer.
 */
const INSTACART_OPS: Array<[string, string]> = [
  ['ActiveCarts', '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d'],
  ['Search', '6d77b6fd5b62f6d88999f5a022af16fafcb00de911da6b942990f61a478ed8c1'],
  ['AsyncItemSearch', '19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e'],
  ['CartItems', '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c'],
  ['CurrentUser', '7bdaa54dc2bc33ff8bb66af35da45efc94b2d1eb21ac53841cc214cdd6cc852a'],
  // THE ADD. Registered because the inventory's own guard caught it missing on
  // its first run -- which is the whole argument for having the guard: the
  // operation that WRITES TO THE CART was the one nobody remembered.
  ['UpdateCartItemsMutation', 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7'],
];

export const DRIFT_INVENTORY: DriftEntry[] = [
  ...INSTACART_OPS.map(([operationName, sha256]): DriftEntry => ({
    rail: 'instacart',
    source: 'src/lib/webview-scripts/aldi-network.ts (ALDI_SEED_OPS)',
    what: `persisted query ${operationName}`,
    breaks: 10,
    probe: { kind: 'persisted_query', origin: IC, operationName, sha256 },
  })),
  {
    rail: 'wegmans',
    source: 'src/lib/webview-scripts/wegmans-network.ts',
    what: 'Algolia app id + search key + index',
    breaks: 1,
    probe: {
      kind: 'algolia',
      host: 'https://qgppr19v8v-dsn.algolia.net',
      appId: 'QGPPR19V8V',
      apiKey: '9a10b1401634e9a6e55161c3a60c200d',
      index: 'products',
    },
  },
  {
    rail: 'heb',
    source: 'src/lib/webview-scripts/heb-network-search.ts (SEARCH_QUERY)',
    what: 'GraphQL document productSearchPageV2',
    breaks: 1,
    probe: { kind: 'graphql_document', origin: 'https://www.heb.com', operationName: 'productSearchPageV2' },
  },
  {
    rail: 'albertsons',
    source: 'src/lib/webview-scripts/albertsons-network.ts',
    what: 'search API path',
    breaks: 15,
    probe: { kind: 'path', origin: 'https://www.albertsons.com', path: '/abs/pub/xapi/pgmsearch/v1/search/products' },
  },
];

/**
 * The Walmart hashes are registered here rather than in the list above because
 * they are probed differently: Walmart answers an unknown persisted query with
 * a 200 and an error body rather than a distinguishable status, so the probe
 * has to read the body. Kept separate so the generic prober stays honest about
 * what it can and cannot conclude.
 */
export const WALMART_OPS_SOURCE = 'src/lib/webview-scripts/walmart-network.ts (OPS)';

/** Every rail that has something rotatable committed. */
export function railsAtRisk(): string[] {
  return [...new Set(DRIFT_INVENTORY.map((e) => e.rail))].sort();
}

/** Ordered by how much breaks, because that is what decides the morning. */
export function byBlastRadius(): DriftEntry[] {
  return [...DRIFT_INVENTORY].sort((a, b) => b.breaks - a.breaks);
}
