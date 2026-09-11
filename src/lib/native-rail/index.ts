import { NativeRail } from './types';
import { HEB_NATIVE } from './heb';
import { INSTACART_NATIVE } from './instacart';
import { ALBERTSONS_NATIVE, useAlbertsonsBanner } from './albertsons';
import { WEGMANS_NATIVE } from './wegmans';
import { ALBERTSONS_FAMILY_IDS } from '../webview-scripts/albertsons';

/**
 * storeId -> the rail that can answer it over plain HTTP.
 *
 * THE THIRD REGISTRY, and it exists for the same reason the other two do.
 * lib/webview-scripts/index.ts maps a store to its scripts and
 * lib/webview-scripts/network-rail.ts maps it to its injected rail; this maps it
 * to its native one. Knowing every store is the whole job of a registry, which
 * is why storeBoundaries.test.ts exempts them and only them.
 *
 * Without this file the mapping lived in lib/native-login.ts, which made a
 * SHARED module import three store modules and broke the boundary rule Stephen
 * set on 2026-09-04: "I don't want changes in one stores code to ever ever ever
 * cause a bug in another store." The rule was right and the shortcut was mine.
 */
const NATIVE_RAILS: Record<string, NativeRail> = {
  heb: HEB_NATIVE,
  aldi: INSTACART_NATIVE,
  wegmans: WEGMANS_NATIVE,
};

/**
 * The Albertsons banners, which a registry may name and shared code may not.
 *
 * Re-exported rather than imported from the store module by every caller: one
 * file reaching into albertsons.ts is a registry doing its job, and five files
 * doing it is the reach the rule exists to prevent.
 */
export const ALBERTSONS_BANNERS: readonly string[] = ALBERTSONS_FAMILY_IDS;

/**
 * The native rail for this store, or null when it has none.
 *
 * The Albertsons family shares ONE rail object pointed at a banner, because
 * fifteen brands run one storefront behind one gateway. Pointing it is a
 * side effect, so the caller must not hold a rail across stores -- and does not:
 * every caller asks again per run.
 */
export function nativeRailFor(storeId: string | null | undefined): NativeRail | null {
  if (!storeId) return null;
  if (NATIVE_RAILS[storeId]) return NATIVE_RAILS[storeId];
  if (ALBERTSONS_FAMILY_IDS.includes(storeId)) {
    return useAlbertsonsBanner(storeId) ? ALBERTSONS_NATIVE : null;
  }
  return null;
}
