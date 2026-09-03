// Which product the user actually chose, per store (MEAL-19).
//
// The app's only memory of a choice used to be `searchTerm` — the DISPLAY name
// of the product ("Kroger Whole Milk, 1 gal"). Every later cart run re-derived
// the product from that string by relevance search, so a decision made once was
// re-made by the store's search ranking every time, and "the same product"
// meant "a description that scores 100 against the one we wrote down".
//
// `storeProducts` records the identifier the STORE gave us instead. Three
// properties matter and each is load-bearing:
//
//   • It is keyed per store, never a bare `upc` field. `searchTerm` is one
//     global string and a meal's store can be changed at any time
//     (MealDetailSheet's editor writes `storeId`), so an HEB-chosen name
//     already reaches Kroger's search today. That is merely wasteful — the
//     ladder recovers. A store identifier leaking the same way would be
//     silently WRONG: it would add a real product nobody picked.
//
//   • The key is the RAIL, not the banner. One Kroger UPC is valid at every
//     Kroger-family banner — the same API, the same catalogue — so a user who
//     moves a meal from Kroger to Ralphs keeps their choices. Availability
//     still varies per location, and that is checked at lookup time, not here.
//
//   • An ingredient with no chosen product carries NO key. These objects are
//     PATCHed back whole with no migration, so a row that has never been chosen
//     has to serialise byte-for-byte the way it did before this field existed —
//     the same rule `prep` follows in normalizeIngredients.

import { isKrogerBrand } from '../constants/stores';
import { ALBERTSONS_FAMILY_IDS } from './webview-scripts/albertsons';

/** A product the user picked, as the store identifies it. `name` is kept beside
 *  the id for display and for debugging a stale id — it is never searched. */
export interface StoreProduct {
  upc: string;
  name: string;
  /**
   * The store's SKU, where the store addresses a cart line by one.
   *
   * H-E-B does: its add mutation takes a sku id, and its rail refuses to build a
   * write without one. Albertsons does not -- it addresses by product id and its
   * search returns no sku at all. So this is optional in the same way the whole
   * entry is: absent means the store never had one, not that it was lost.
   *
   * Kroger's entries predate it and carry none, which is correct -- Kroger
   * writes by UPC.
   */
  sku?: string;
  /**
   * The product's real BARCODE, where the store gives us one.
   *
   * Not to be confused with `upc` above, which is misnamed: it holds the
   * STORE's own product id. This is the number on the packet, and it is here
   * because of Wegmans.
   *
   * MEASURED 2026-09-02: the same Daisy sour cream is `626485` at store 50 and
   * `608294` at store 140. Every other store here has one id per product across
   * its whole estate, which is what lets Kroger's banners and the Albertsons
   * family share a key. Wegmans does not, so a saved id is only valid at the
   * store it was chosen at -- and a user who changes store would silently
   * resolve to the wrong product or to nothing.
   *
   * The barcode does not move. Stephen's call, 2026-09-03: save it too, and
   * re-resolve against the new store's catalogue rather than making the user
   * choose everything again.
   */
  barcode?: string;
}

/**
 * The key a store's chosen products are filed under.
 *
 * Kroger-family banners share one rail and one product catalogue, so they share
 * one key. Every other store gets its own id, which is what a WebView store
 * would use if it ever gained a stable product identifier — nothing writes one
 * today.
 */
export function storeProductKey(storeId: string | null | undefined): string {
  if (!storeId) return '';
  if (isKrogerBrand(storeId)) return 'kroger';
  // The Albertsons family is fifteen banners on one platform and one product
  // catalogue, exactly like Kroger's — a product id from albertsons.com is the
  // same product at safeway.com and vons.com. Folding them means a meal moved
  // between banners keeps its choices; leaving them apart silently threw the
  // choice away and searched the name again.
  //
  // Availability still varies by location, and that is checked when the product
  // is looked up or written, not here. Same rule the rail's own config key
  // follows (railConfigKey).
  if ((ALBERTSONS_FAMILY_IDS as readonly string[]).includes(storeId)) return 'albertsons';
  return storeId;
}

/** The product chosen for this store on this ingredient, or null. Tolerates the
 *  whole field being absent, which is the normal case. */
export function getStoreProduct(ing: any, storeId: string | null | undefined): StoreProduct | null {
  const key = storeProductKey(storeId);
  if (!key) return null;
  const entry = ing?.storeProducts?.[key];
  if (!entry || typeof entry.upc !== 'string' || !entry.upc.trim()) return null;
  return {
    upc: entry.upc,
    name: typeof entry.name === 'string' ? entry.name : '',
    ...(typeof entry.sku === 'string' && entry.sku ? { sku: entry.sku } : {}),
    ...(typeof entry.barcode === 'string' && entry.barcode ? { barcode: entry.barcode } : {}),
  };
}

/**
 * A copy of `ing` with this store's chosen product recorded. Pure.
 *
 * Other stores' entries are preserved: a meal moved to HEB and back should not
 * have forgotten its Kroger choice. Called only where the user explicitly
 * picked a product, so no row gains the key by merely being read.
 */
export function withStoreProduct<T extends Record<string, any>>(
  ing: T,
  storeId: string | null | undefined,
  product: StoreProduct,
): T {
  const key = storeProductKey(storeId);
  if (!key || !product.upc) return ing;
  return {
    ...ing,
    storeProducts: {
      ...(ing.storeProducts ?? {}),
      // The sku key is written only when there is one, so a store that has none
      // serialises exactly as it did before this field existed.
      [key]: {
        upc: product.upc,
        name: product.name,
        ...(product.sku ? { sku: product.sku } : {}),
        // Written only when there is one, so a store that has no barcode
        // serialises exactly as it did before this field existed -- the same
        // rule `sku` and `prep` follow.
        ...(product.barcode ? { barcode: product.barcode } : {}),
      },
    },
  };
}

/**
 * A copy of `ing` with every remembered store product dropped.
 *
 * Called wherever `searchTerm` is cleared — renaming a row, or removing its
 * chosen product. A remembered identifier that outlived the choice it came from
 * is worse than no identifier at all: `searchTerm` going null makes the row
 * unchosen and the next run searches for it afresh, but a surviving id would
 * still resolve, and would add the OLD product without asking. That is the
 * over/under-add the cart's governing principles exist to prevent, arriving
 * through an edit screen. Same rule, and the same reason, as
 * `PRODUCT_BOUND_FIELDS` in IngredientEditor.
 *
 * Deletes the key rather than writing an empty map, so a row that never had one
 * still serialises the way it always did.
 */
export function withoutStoreProducts<T extends Record<string, any>>(ing: T): T {
  if (!ing || !('storeProducts' in ing)) return ing;
  const { storeProducts: _dropped, ...rest } = ing;
  return rest as T;
}
