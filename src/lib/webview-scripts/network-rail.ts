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
};

/**
 * The rail for a store, or null when it has none and the page path is the only
 * way in. Null is the normal answer for most of the catalogue.
 */
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
