import { NativeRail } from './types';
import { NativeRunDriver } from './run';
import { HEB_NATIVE, HEB_NATIVE_RUN } from './heb';
import { INSTACART_NATIVE, instacartNativeRun } from './instacart';
import { isInstacartStore } from '../webview-scripts/instacart';
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


/**
 * EVERY ORIGIN A STORE SESSION LIVES ON, for the tools that operate on jars
 * rather than on stores.
 *
 * The bot-cookie sweep needs origins and must not import a store module to get
 * them; this file already holds every rail and every rail already states its
 * own origin, so the list is derived rather than typed out. A store added above
 * is swept without anyone remembering to add it here.
 */
export function nativeRailOrigins(): string[] {
  const seen = new Set<string>();
  for (const r of Object.values(NATIVE_RAILS)) seen.add(r.origin);
  for (const b of ALBERTSONS_FAMILY_IDS) {
    const r = nativeRailFor(b);
    if (r) seen.add(r.origin);
  }
  return [...seen];
}

/**
 * storeId -> the driver that can RUN it over plain HTTP.
 *
 * A second map rather than a field on NativeRail, because the two answer
 * different questions and a store can legitimately do one and not the other.
 * nativeRailFor says "can this store be ASKED over HTTP" -- login, one search,
 * one read -- and every store in the table above can. This says "can a whole RUN
 * go over HTTP", which additionally needs the write, the batching and the
 * verification, and which store-capabilities.ts gates on separately for exactly
 * that reason.
 *
 * WALMART IS DELIBERATELY ABSENT, and not by omission. Stephen, 2026-09-11:
 * "Walmart is off the table for now" -- walmart.io is the intended path there,
 * and a native run driver for it would be built on the assumption he has already
 * ruled out. It keeps the WebView path it has always had.
 */
let override: ((storeId: string | null | undefined) => NativeRunDriver | null) | null = null;

export function nativeRunFor(storeId: string | null | undefined): NativeRunDriver | null {
  if (override) return override(storeId);
  if (!storeId) return null;
  if (storeId === 'heb') return HEB_NATIVE_RUN;
  // A DRIVER PER BANNER, built here because this is the only file allowed to
  // know which banners there are.
  if (isInstacartStore(storeId)) return instacartNativeRun(storeId);
  return null;
}


/**
 * THE TRANSPORT SEAM, for suites that are about one side of the bridge.
 *
 * Follows __setLoginCheckerForTests next door, and exists for the same reason:
 * the engine's decisions -- one batch per session answer, stop rather than wait,
 * reuse what the prewarm answered -- are transport-INDEPENDENT, and the suites
 * that pin them observe the transport because that is the only thing observable
 * from outside. A suite that pins the page path says so here; a suite that pins
 * the native path installs a driver here. Neither is a suite silently testing
 * whichever path the capability table happened to select that week.
 */
export function __setNativeRunForTests(
  fn: (storeId: string | null | undefined) => NativeRunDriver | null,
): void {
  override = fn;
}

export function __resetNativeRunForTests(): void {
  override = null;
}
