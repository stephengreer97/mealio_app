// Which network rail, if any, a store has.
//
// The cart engine drives one shape: ask who is signed in, search every term from
// one page, then write the chosen products. Each store answers that in its own
// protocol — H-E-B in GraphQL, Albertsons in REST behind Azure API Management —
// and the engine should not know which. This is the only place that mapping
// lives, so adding the next store is one entry here rather than another branch
// threaded through the sheet.
import {
  buildHebCartReadScript,
  buildHebNetworkAddBatchScript,
  buildHebNetworkSearchBatchScript,
  buildHebSessionScript,
} from './heb-network-search';
import {
  buildAlbertsonsCartReadScript,
  buildAlbertsonsNetworkAddBatchScript,
  buildAlbertsonsNetworkSearchBatchScript,
  buildAlbertsonsSessionScript,
} from './albertsons-network';
import { ALBERTSONS_FAMILY_IDS } from './albertsons';

/** What the session probe has to establish before a run can start. */
export interface NetworkSession {
  storeId: string;
  shoppingContext: string;
}

export interface NetworkAddItem {
  idx: number;
  productId: string;
  skuId?: string | null;
  quantity: number;
  name: string;
  isWeightItem?: boolean;
  purchasePreferenceId?: string | null;
  maxOrderQuantity?: number | null;
}

export interface NetworkRail {
  /** The message type this store's session probe posts back. */
  sessionMessageType: string;
  sessionScript(): string;
  searchBatch(terms: string[], sess: NetworkSession): string | null;
  /**
   * Read the cart and post a CART_COUNT identical to the cart PAGE's.
   *
   * A rail store must never load a page to learn what is in its own cart. The
   * page probe it replaces measured 2.0s flat on every run -- more than
   * searching eighteen items -- and it is what put the wrong breakdown on the
   * done screen when the navigation landed somewhere that was not the cart.
   */
  cartRead(): string;
  addBatch(items: NetworkAddItem[], opts?: { concurrency?: number }): string | null;
  /**
   * Can this store WRITE the candidate the matcher picked?
   *
   * The stores address a cart line differently, and the difference is not a
   * detail the shared matcher should carry. H-E-B needs a sku; Albertsons needs
   * only the product id, and its search never returns a sku at all.
   *
   * MEASURED 2026-09-02: the matcher required BOTH, so every Albertsons run
   * ended 'nothing matched exactly' -- with six terms answered, thirty
   * candidates for one of them, and the right product sitting in the list. The
   * rail could never have added anything, whatever the search did. H-E-B's own
   * addBatch already filtered on sku and said in its comment that the filter was
   * "the store's constraint, not a shared rule"; this is that sentence made
   * true.
   */
  writable(candidate: { productId?: string | null; skuId?: string | null }): boolean;
  /**
   * Does this candidate need the user to choose a variant before it can be
   * written?
   *
   * H-E-B products carry a purchasePreferenceList -- "sliced or shaved?" -- and
   * writing one without a choice makes the store apply its own default, adding a
   * variant nobody asked for. Albertsons has no such concept and answers false
   * whatever the data looks like.
   *
   * The engine used to read `candidate.preferences?.some(p => p.preferenceId)`
   * itself. That is H-E-B's data model in shared code: inert for Albertsons
   * today, and exactly the shape of assumption that made the sku rule break it.
   */
  needsPreference(candidate: { preferences?: Array<{ preferenceId?: string | null }> | null }): boolean;
  /**
   * HOW LONG TO WAIT, PER STORE, MEASURED PER STORE.
   *
   * These were constants in the engine, each tuned on whichever store was in
   * front of me and applied to both. Albertsons needs a generous search window
   * because its first request into a fresh document has been measured at 40-70s
   * while later ones take 0.3s; H-E-B answers in about a second and was made to
   * wait the same 45 plus 8 per term before it could give up. A budget is a
   * store fact, so each store states its own.
   *
   * Every one is a CEILING, not a target: how long the run waits before deciding
   * the store has stopped answering.
   */
  budgets: {
    /** Session probe: injected, to answered. */
    sessionMs: number;
    /** One search batch, given the number of terms in it. */
    searchMs(terms: number): number;
    /** A search batch re-issued after the page moved under it. */
    searchResumeMs: number;
    /** One write batch, given the number of items in it. */
    addMs(items: number): number;
  };
}

const HEB_RAIL: NetworkRail = {
  sessionMessageType: 'HEB_SESSION',
  sessionScript: buildHebSessionScript,
  searchBatch: (terms, sess) => buildHebNetworkSearchBatchScript(terms, sess),
  cartRead: () => buildHebCartReadScript(),
  addBatch: (items, opts) =>
    buildHebNetworkAddBatchScript(
      // H-E-B addresses a cart line by sku, so an item without one is not
      // writable there; the filter is the store's constraint, not a shared rule.
      items.filter((i) => !!i.skuId).map((i) => ({ ...i, skuId: String(i.skuId) })),
      opts,
    ),
  writable: (c) => !!c.productId && !!c.skuId,
  needsPreference: (c) => (c.preferences ?? []).some((p) => !!p.preferenceId),
  // MEASURED on the device 2026-09-02: eleven terms, all prewarmed, tap to done
  // in 6.9s; a search batch answers in about a second. Generous against that and
  // still a fraction of what Albertsons needs.
  budgets: {
    sessionMs: 15_000,
    searchMs: (terms) => Math.min(20_000 + terms * 2_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
  },
};

const ALBERTSONS_RAIL: NetworkRail = {
  sessionMessageType: 'ALB_SESSION',
  sessionScript: buildAlbertsonsSessionScript,
  searchBatch: (terms, sess) =>
    buildAlbertsonsNetworkSearchBatchScript(terms, { storeId: sess.storeId }),
  cartRead: () => buildAlbertsonsCartReadScript(),
  addBatch: (items, opts) => buildAlbertsonsNetworkAddBatchScript(items, opts),
  // The cart is addressed by product id; the search returns no sku, and none is
  // needed to write.
  writable: (c) => !!c.productId,
  // No preference concept on this platform. Answering false rather than leaving
  // the engine to infer it from an empty array is the whole point of asking.
  needsPreference: () => false,
  // MEASURED 2026-09-02. The first request into a fresh document has been seen
  // at 40-70s while later ones take 0.3s, so the search ceiling covers a slow
  // start PLUS the terms. A flat 40s once expired on the same tick the first
  // result arrived and threw away six good answers.
  budgets: {
    sessionMs: 25_000,
    searchMs: (terms) => Math.min(45_000 + terms * 8_000, 180_000),
    searchResumeMs: 40_000,
    // Writes are serial here -- the store loses concurrent ones -- so this
    // scales with the batch rather than sitting flat.
    addMs: (items) => Math.min(45_000 + items * 4_000, 180_000),
  },
};

/**
 * The rail for a store, or null when it has none and the page path is the only
 * way in. Null is the normal answer for most of the catalogue.
 */
/**
 * The automation-config key a store's rail settings live under.
 *
 * The Albertsons family is FIFTEEN banners sharing one platform, and its config
 * — selectors, kill switch, and the networkSearch/networkAdd flags — is stored
 * once under 'albertsons'. albertsons.ts has always resolved it that way
 * (`storeConfig(SELECTOR_KEY)`); the cart engine did not, so it read
 * `stores['safeway']`, found nothing, and decided Safeway had no rail. Every
 * banner except the one literally named 'albertsons' fell through to the page
 * path, and after the DOM removal would fall through to assisted.
 *
 * Exported so the answer lives in one place rather than being re-derived by
 * whoever needs it next.
 */
export function railConfigKey(storeId: string | null | undefined): string {
  if (!storeId) return '';
  if ((ALBERTSONS_FAMILY_IDS as readonly string[]).includes(storeId)) return 'albertsons';
  return storeId;
}

export function getNetworkRail(storeId: string | null | undefined): NetworkRail | null {
  if (!storeId) return null;
  if (storeId === 'heb') return HEB_RAIL;
  if ((ALBERTSONS_FAMILY_IDS as readonly string[]).includes(storeId)) return ALBERTSONS_RAIL;
  return null;
}

/** Every session message type a rail can post, for the engine's dispatcher. */
export const NETWORK_SESSION_MESSAGE_TYPES: readonly string[] = [
  HEB_RAIL.sessionMessageType,
  ALBERTSONS_RAIL.sessionMessageType,
];
