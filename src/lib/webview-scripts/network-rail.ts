// Which network rail, if any, a store has.
//
// The cart engine drives one shape: ask who is signed in, search every term from
// one page, then write the chosen products. Each store answers that in its own
// protocol — H-E-B in GraphQL, Albertsons in REST behind Azure API Management —
// and the engine should not know which. This is the only place that mapping
// lives, so adding the next store is one entry here rather than another branch
// threaded through the sheet.
import {
  buildHebNetworkAddBatchScript,
  buildHebNetworkSearchBatchScript,
  buildHebSessionScript,
} from './heb-network-search';
import {
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
  addBatch(items: NetworkAddItem[], opts?: { concurrency?: number }): string | null;
}

const HEB_RAIL: NetworkRail = {
  sessionMessageType: 'HEB_SESSION',
  sessionScript: buildHebSessionScript,
  searchBatch: (terms, sess) => buildHebNetworkSearchBatchScript(terms, sess),
  addBatch: (items, opts) =>
    buildHebNetworkAddBatchScript(
      // H-E-B addresses a cart line by sku, so an item without one is not
      // writable there; the filter is the store's constraint, not a shared rule.
      items.filter((i) => !!i.skuId).map((i) => ({ ...i, skuId: String(i.skuId) })),
      opts,
    ),
};

const ALBERTSONS_RAIL: NetworkRail = {
  sessionMessageType: 'ALB_SESSION',
  sessionScript: buildAlbertsonsSessionScript,
  searchBatch: (terms, sess) =>
    buildAlbertsonsNetworkSearchBatchScript(terms, { storeId: sess.storeId }),
  addBatch: (items, opts) => buildAlbertsonsNetworkAddBatchScript(items, opts),
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
