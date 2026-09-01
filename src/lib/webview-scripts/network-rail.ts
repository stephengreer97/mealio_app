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
   * A rail store must never need a page load to know what is in the cart. Before
   * this existed the sheet navigated to the cart URL for its before, reconcile
   * and after snapshots — thirteen cart-page loads in one measured run — and the
   * two readers named the same product differently, which the done screen then
   * diffed by name.
   */
  cartRead(): string;
  addBatch(items: NetworkAddItem[], opts?: { concurrency?: number }): string | null;
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
};

const ALBERTSONS_RAIL: NetworkRail = {
  sessionMessageType: 'ALB_SESSION',
  sessionScript: buildAlbertsonsSessionScript,
  searchBatch: (terms, sess) =>
    buildAlbertsonsNetworkSearchBatchScript(terms, { storeId: sess.storeId }),
  cartRead: () => buildAlbertsonsCartReadScript(),
  addBatch: (items, opts) => buildAlbertsonsNetworkAddBatchScript(items, opts),
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
