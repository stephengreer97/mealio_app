// Which network rail, if any, a store has.
//
// The cart engine drives one shape: ask who is signed in, search every term from
// one page, then write the chosen products. Each store answers that in its own
// protocol — H-E-B in GraphQL, Albertsons in REST behind Azure API Management —
// and the engine should not know which. This is the only place that mapping
// lives, so adding the next store is one entry here rather than another branch
// threaded through the sheet.
import {
  buildWalmartSessionScript,
  buildWalmartCartReadScript,
  buildWalmartNetworkSearchBatchScript,
  buildWalmartNetworkAddBatchScript,
} from './walmart-network';
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
import {
  buildAldiCartReadScript,
  buildAldiNetworkAddBatchScript,
  buildAldiNetworkSearchBatchScript,
  buildAldiSessionScript,
} from './aldi-network';
import {
  buildWegmansCartReadScript,
  buildWegmansNetworkAddBatchScript,
  buildWegmansNetworkSearchBatchScript,
  buildWegmansSessionScript,
} from './wegmans-network';
import { ALBERTSONS_FAMILY_IDS } from './albertsons';
import { isInstacartStore } from './instacart';

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
  /**
   * `opts.knownLines` is the cart the sheet has ALREADY read, as
   * { itemId: qty }.
   *
   * The write needs a baseline because qty is absolute -- it SETS the line -- so
   * every quantity is held + wanted. The script read the cart itself to get one,
   * which is correct and self-contained and, on a normal run, the second read of
   * the same cart about a second after the sheet's own. Handing it the one we
   * have takes a round trip off the critical path; omitting it keeps the script
   * standalone, which is what the fixture tests exercise.
   */
  addBatch(items: NetworkAddItem[], opts?: {
    concurrency?: number;
    knownLines?: Record<string, number> | null;
    /**
     * Whether this store's write SETS a line or ADDS to it. Null means unknown,
     * and a rail that does not know refuses any item the cart already holds.
     * Passed through so the semantics can be measured with the rail's OWN
     * script — measuring a reimplementation proves nothing about what ships.
     */
    absoluteQty?: boolean | null;
  }): string | null;
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
   * Is this session answer one the run can actually WORK on?
   *
   * Not the same question as "is the user signed in". A store may answer the
   * login question long before it can answer the search-and-write question, and
   * Albertsons does exactly that on purpose: it posts the moment /userinfo comes
   * back -- so no budget of ours can make the sheet think a signed-in user is
   * signed out -- and only then resolves the API keys and proves the token by
   * reading the cart. The first answer carries `hasSearchKey: false`.
   *
   * MEASURED 2026-09-02 on a 31-item run. The engine took the first answer and
   * went straight to writing: `wrote 0 of 29`, twenty-seven "nothing found for
   * N chosen products", and a full basket handed back to the user. It had been
   * hidden because the sheet's own prewarm happened to consume the early answer
   * first; once the selection screen started answering the searches, the prewarm
   * stopped running and the run met the early answer head-on.
   *
   * The login gate is deliberately NOT behind this -- that is what the early
   * answer exists for. This gates only the work that needs keys.
   *
   * H-E-B posts once and answers true to whatever it posts.
   */
  sessionUsable(msg: { early?: boolean; storeId?: string | null }): boolean;

  /**
   * Does a run need a STORE from the session before it can start?
   *
   * True for every rail whose catalogue is per store — H-E-B, the Albertsons
   * family, ALDI's shop, Wegmans' store number — because a search filtered to
   * the wrong one returns products the user cannot buy. Walmart has no such
   * thing on this path: its search is national and its cart is the account's,
   * and demanding one handed every Walmart run straight to the user with
   * 'session_no_store'.
   *
   * Undefined means true, so this only has to be said where it is false.
   */
  needsStoreId?: boolean;
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
    /**
     * The before/after cart read.
     *
     * Shared at ten seconds, this was the last engine-wide budget and it was
     * Albertsons' undoing: the read itself measured 6.6s, the probe expired
     * first, the answer arrived eight seconds later and was discarded -- and the
     * done screen then diffed a 176-line cart against nothing and warned about
     * 170 items "Mealio did not intend to add".
     */
    cartProbeMs: number;
    /**
     * ONE search request, and the FIRST one separately.
     *
     * A flat 15s here was killing requests this store had not finished. Measured
     * 2026-09-02 with a healthy document -- the heartbeat showing a 1.002s gap
     * for a 1s interval, so nothing was frozen -- the first request into a fresh
     * page ran the entire 15s budget and was aborted, while later ones answered
     * in 0.3s. That is a real cold start, not a stall, and aborting it turns a
     * slow answer into no answer.
     */
    searchRequestMs: number;
    searchFirstRequestMs: number;
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
  // One session answer, and it is complete when it lands.
  sessionUsable: () => true,
  needsPreference: (c) => (c.preferences ?? []).some((p) => !!p.preferenceId),
  // MEASURED on the device 2026-09-02: eleven terms, all prewarmed, tap to done
  // in 6.9s; a search batch answers in about a second. Generous against that and
  // still a fraction of what Albertsons needs.
  budgets: {
    sessionMs: 15_000,
    searchMs: (terms) => Math.min(20_000 + terms * 2_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
    // Measured at well under a second on this store.
    cartProbeMs: 12_000,
    searchRequestMs: 15_000,
    searchFirstRequestMs: 15_000,
  },
};

const ALBERTSONS_RAIL: NetworkRail = {
  sessionMessageType: 'ALB_SESSION',
  sessionScript: buildAlbertsonsSessionScript,
  searchBatch: (terms, sess) =>
    buildAlbertsonsNetworkSearchBatchScript(terms, {
      storeId: sess.storeId,
      requestMs: ALBERTSONS_RAIL.budgets.searchRequestMs,
      firstRequestMs: ALBERTSONS_RAIL.budgets.searchFirstRequestMs,
    }),
  cartRead: () => buildAlbertsonsCartReadScript(),
  addBatch: (items, opts) => buildAlbertsonsNetworkAddBatchScript(items, opts),
  // The cart is addressed by product id; the search returns no sku, and none is
  // needed to write.
  writable: (c) => !!c.productId,
  // TWO ANSWERS, and the first one cannot search or write. `early` is posted
  // straight off /userinfo, before __albEnsureKeys has run; the refined one
  // follows about 1.3s later with the keys resolved and the token proved
  // against a real cart read.
  //
  // An early answer with NO store is let through, because nothing more is
  // coming -- the script returns after it -- and the run should fail fast on
  // session_no_store rather than sit out its whole 25s deadline.
  sessionUsable: (msg) => !msg.early || !msg.storeId,
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
    // The read has been measured at 6.6s on a cold document and 0.5s on a warm
    // one. Ten seconds expired between the two, which is the worst place for a
    // deadline to sit.
    cartProbeMs: 30_000,
    searchRequestMs: 15_000,
    // The cold one gets room. Measured 2026-09-02 with the heartbeat showing a
    // 1.002s gap for a 1s interval -- so the document was provably NOT frozen --
    // the first request ran the whole 15s budget and was aborted, while every
    // one after it answered in 0.3s. Aborting a slow answer makes it no answer.
    searchFirstRequestMs: 40_000,
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

/**
 * Instacart Storefront, which ALDI runs on.
 *
 * Registered against the PLATFORM rather than the banner: INSTACART_TENANTS is
 * the registry, so a tenant added there gets this rail without another entry
 * here. That is the same reasoning railConfigKey uses for the fifteen
 * Albertsons banners.
 */
const INSTACART_RAIL: NetworkRail = {
  sessionMessageType: 'ALDI_SESSION',
  sessionScript: () => buildAldiSessionScript(),
  searchBatch: (terms, sess) =>
    buildAldiNetworkSearchBatchScript(terms, {
      shopId: sess.storeId,
      requestMs: INSTACART_RAIL.budgets.searchRequestMs,
    }),
  cartRead: () => buildAldiCartReadScript(),
  addBatch: (items, opts) =>
    buildAldiNetworkAddBatchScript(
      items.map((i) => ({ idx: i.idx, productId: i.productId, quantity: i.quantity, name: i.name })),
      {
        knownLines: opts?.knownLines ?? null,
        // MEASURED against the real store, 2026-09-03, on one authorised write.
        // The cart held 1 of items_23898-46580608; we wrote quantity 2 and read
        // it back as 2, not 3, then restored it to 1. The write SETS the line.
        //
        // The storefront's own bundle says the same thing independently: its
        // updateCartItems computes `finalQuantity: u` from the value you send
        // and derives the delta (u - d) only for analytics, and its bulk-add
        // path computes held + wanted ITSELF before sending. There is no
        // quantityDelta anywhere in it. The mutation variable is named
        // newQuantity.
        //
        // So held + wanted, which is what this script already writes, is right —
        // and the refusal of an item the cart already holds can lift.
        absoluteQty: true,
      },
    ),
  // The cart is addressed by the item id the search returns
  // (items_23898-18647633). There is no sku on this platform at all.
  writable: (c) => !!c.productId,
  // One session answer. ActiveCarts takes no arguments and returns everything
  // the run needs, so there is no early/refined split to wait out.
  sessionUsable: () => true,
  // No preference concept on this platform.
  needsPreference: () => false,
  // MEASURED 2026-09-02 against a live session: ActiveCarts 176ms, CartItems
  // 306ms, AsyncItemSearch 556ms for one term. Generous against that, and the
  // search budget carries the extra hydration call every batch makes.
  budgets: {
    sessionMs: 20_000,
    searchMs: (terms) => Math.min(20_000 + terms * 3_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 1_500, 90_000),
    cartProbeMs: 20_000,
    searchRequestMs: 15_000,
    // No cold-start problem observed; the first call was as quick as the rest.
    searchFirstRequestMs: 15_000,
  },
};

/**
 * Wegmans. The only store here whose SEARCH needs no session at all.
 *
 * Algolia answers in 13ms with a public search key, so a Wegmans search works
 * signed-out and cannot be broken by an expired token. The cart half needs a
 * bearer that MSAL keeps encrypted, which is why sessionUsable below is the
 * strictest of the three rails.
 */
const WEGMANS_RAIL: NetworkRail = {
  sessionMessageType: 'WEGMANS_SESSION',
  sessionScript: buildWegmansSessionScript,
  searchBatch: (terms, sess) =>
    buildWegmansNetworkSearchBatchScript(terms, {
      storeNumber: sess.storeId,
      requestMs: WEGMANS_RAIL.budgets.searchRequestMs,
    }),
  cartRead: () => buildWegmansCartReadScript(),
  addBatch: (items, opts) =>
    buildWegmansNetworkAddBatchScript(
      items.map((i) => ({
        idx: i.idx, productId: i.productId, skuId: i.skuId ?? null,
        quantity: i.quantity, name: i.name,
      })),
      {
        knownLines: opts?.knownLines ?? null,
        // Passed THROUGH, so the semantics can be measured with the rail's own
        // script rather than a reimplementation of it. Still null in the app
        // until the measurement says otherwise.
        absoluteQty: opts?.absoluteQty ?? null,
      },
    ),
  // The cart is addressed by productId, and the search returns skuId as the
  // same value. Nothing needs both, so requiring both would break this store
  // the way it broke Albertsons.
  writable: (c) => !!c.productId,
  /**
   * TWO ANSWERS, and the second is the one the run waits for.
   *
   * `early` settles the login gate the instant the localStorage read is done --
   * no budget of ours may make a signed-in user wait to be told they are signed
   * in. But a run needs the cart, the cart needs a bearer, and the bearer is in
   * an encrypted MSAL cache. `cartCapable` is the probe having actually used
   * one, so it is what lets the run start.
   *
   * Exactly the shape Albertsons taught us, for a different reason.
   */
  sessionUsable: (msg) => !(msg as { early?: boolean }).early,
  // No preference concept on this store.
  needsPreference: () => false,
  // MEASURED 2026-09-02: Algolia 13ms filtered, 26ms not. Nothing here shows the
  // Albertsons cold-start, so the budgets are the tighter H-E-B shape.
  budgets: {
    sessionMs: 15_000,
    searchMs: (terms) => Math.min(10_000 + terms * 1_500, 45_000),
    searchResumeMs: 15_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
    cartProbeMs: 15_000,
    searchRequestMs: 12_000,
    searchFirstRequestMs: 12_000,
  },
};

/**
 * Walmart.
 *
 * The odd one out in exactly one way: its SEARCH is a GET of a server-rendered
 * page whose whole result set is in a __NEXT_DATA__ script tag, rather than an
 * API call. One request, one JSON.parse, no rendering and no selectors — the
 * same properties the other three have, reached differently.
 *
 * Its cart is Walmart's own persisted-query scheme, with the operation name and
 * hash in the URL path. The headers are the gate: too few and the answer is 418
 * Access Denied.
 */
export const WALMART_RAIL: NetworkRail = {
  sessionMessageType: 'WMT_SESSION',
  sessionScript: buildWalmartSessionScript,
  searchBatch: (terms) => buildWalmartNetworkSearchBatchScript(terms),
  cartRead: () => buildWalmartCartReadScript(),
  addBatch: (items, opts) =>
    buildWalmartNetworkAddBatchScript(
      items.map((i) => ({ idx: i.idx, productId: i.productId, skuId: i.skuId ?? null,
                          quantity: i.quantity, name: i.name })),
      {
        // UNMEASURED: whether updateItems SETS a line or ADDS to it. ALDI and
        // Wegmans both surprised me on this question, and Wegmans turned out to
        // do BOTH depending on a line id — so it is null until a device says
        // otherwise, and null means the script sends held + wanted, which is
        // right for a SET and is checked against the cart afterwards either way.
        absoluteQty: opts?.absoluteQty ?? null,
      },
    ),
  // The OFFER is the identifier. usItemId rides along for display and is sent
  // empty on the write, which is measured rather than assumed.
  writable: (c) => !!c.productId,
  // One answer, from localStorage. Nothing to wait out.
  sessionUsable: () => true,
  // No store to resolve: national search, account cart.
  needsStoreId: false,
  needsPreference: () => false,
  // MEASURED: cart read ~700-800ms, search ~1.5-3s for a 500KB document. The
  // search is the slow half here because it is a whole page.
  budgets: {
    sessionMs: 10_000,
    searchMs: (terms) => Math.min(15_000 + terms * 4_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
    cartProbeMs: 20_000,
    searchRequestMs: 20_000,
    searchFirstRequestMs: 25_000,
  },
};

export function getNetworkRail(storeId: string | null | undefined): NetworkRail | null {
  if (!storeId) return null;
  if (storeId === 'heb') return HEB_RAIL;
  if ((ALBERTSONS_FAMILY_IDS as readonly string[]).includes(storeId)) return ALBERTSONS_RAIL;
  if (isInstacartStore(storeId)) return INSTACART_RAIL;
  if (storeId === 'wegmans') return WEGMANS_RAIL;
  if (storeId === 'walmart') return WALMART_RAIL;
  return null;
}

/** Every session message type a rail can post, for the engine's dispatcher. */
export const NETWORK_SESSION_MESSAGE_TYPES: readonly string[] = [
  HEB_RAIL.sessionMessageType,
  ALBERTSONS_RAIL.sessionMessageType,
  INSTACART_RAIL.sessionMessageType,
  WEGMANS_RAIL.sessionMessageType,
  WALMART_RAIL.sessionMessageType,
];
