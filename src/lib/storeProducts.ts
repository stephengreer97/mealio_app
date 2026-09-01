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

/** A product the user picked, as the store identifies it. `name` is kept beside
 *  the id for display and for debugging a stale id — it is never searched. */
export interface StoreProduct {
  upc: string;
  name: string;
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
  return isKrogerBrand(storeId) ? 'kroger' : storeId;
}

/** The product chosen for this store on this ingredient, or null. Tolerates the
 *  whole field being absent, which is the normal case. */
export function getStoreProduct(ing: any, storeId: string | null | undefined): StoreProduct | null {
  const key = storeProductKey(storeId);
  if (!key) return null;
  const entry = ing?.storeProducts?.[key];
  if (!entry || typeof entry.upc !== 'string' || !entry.upc.trim()) return null;
  return { upc: entry.upc, name: typeof entry.name === 'string' ? entry.name : '' };
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
    storeProducts: { ...(ing.storeProducts ?? {}), [key]: { upc: product.upc, name: product.name } },
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
