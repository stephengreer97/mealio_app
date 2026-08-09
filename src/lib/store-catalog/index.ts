// Runtime accessor for the store catalog — which stores the app offers.
//
// Lifecycle, deliberately identical to src/lib/automation-config:
//   1. Module load — the bundled list is live immediately. Nothing ever waits on
//      the network to read the catalog, so a slow fetch cannot delay a cold start
//      or a cart run. There is no loading state anywhere and nothing gates on it.
//   2. loadStoreCatalog() (called once, after sign-in) hydrates from the
//      SecureStore cache, then fetches the published version from mealio.co.
//   3. Any later read picks up whichever is newest. Reads are SYNCHRONOUS because
//      they happen in render — there is nowhere to await.
//
// The "keep what you have" rule is inherited too: a fetch returning version 0 or
// an empty list is treated as "no instruction", NOT as "revert to bundled". The
// server briefly has no published rows while a publish swaps them, and a client
// that reverted during that window would drop a store a user was mid-flow in.
//
// WHAT IS NOT HERE: capability. isKrogerBrand / isWebViewStore stay bundled in
// constants/stores.ts, because they assert that this binary contains code for a
// store and no server response can make that true. This module can add a store's
// NAME to the app; only a release can add its automation. See isSupportedStore.

import {
  BUNDLED_STORES,
  Store,
  isSupportedStore,
} from '../../constants/stores';
import { mergeStoreCatalog } from './merge';

export type { Store } from '../../constants/stores';
export { mergeStoreCatalog, FALLBACK_STORE_COLOR } from './merge';

// NOTE: this module must NOT import ./store. constants/stores.ts is read by the
// pure node test project (selectorHealth, url-builders), so anything reachable
// from here lands in that project's dependency graph — and ./store pulls in
// expo-secure-store, which it cannot transform. Persistence is therefore
// INJECTED (see the CatalogCache parameter of loadStoreCatalog) rather than
// imported, exactly as automation-config does it. React is kept out for the same
// reason; the hook lives in ./useStores.

/** Persistence for the last-known-good remote catalog. See ./store. */
export interface CatalogCache {
  read: () => Promise<{ version: number; raw: unknown } | null>;
  write: (version: number, raw: unknown) => Promise<void>;
}

let merged: Store[] = BUNDLED_STORES;
let currentVersion = 0;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

// The filtered view, computed once per catalog change. Memoising is not an
// optimisation: useSyncExternalStore compares snapshots by identity and would
// re-render forever if getStores() returned a fresh array each call.
let supported: Store[] | null = null;

/**
 * The stores this app offers, right now. Never empty, never null — the bundled
 * list until a remote catalog lands.
 *
 * A store the catalog names that this build has no code for is FILTERED OUT: it
 * behaves exactly as it does today, which is as though it does not exist. That
 * is the only option that invents nothing — no badge, no "update your app"
 * prompt, no half-working picker row that dead-ends at getStoreScripts() ===
 * null. Since every store in the bundled list is supported, this filter is a
 * no-op for every store that exists as of MEAL-23, so shipping the mechanism
 * changes nothing a user can see until a genuinely new row is published.
 *
 * Reversing that decision is deleting the `.filter(...)` below. It is one call
 * site on purpose — Stephen wants to revisit it, and it should not have grown
 * roots by then.
 */
export function getStores(): Store[] {
  if (supported === null) supported = merged.filter((s) => isSupportedStore(s.id));
  return supported;
}

/** Active catalog version, or 0 when running on the bundled list. */
export function getCatalogVersion(): number {
  return currentVersion;
}

/**
 * Subscribe to catalog changes. Returns an unsubscribe.
 *
 * Exists so a screen already on-screen when the catalog lands repaints, rather
 * than waiting for the next unrelated state change to happen to pick it up. See
 * ./useStores.
 */
export function subscribeStores(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function apply(version: number, raw: unknown, source: string): boolean {
  // Empty/absent carries no instruction — see the "keep what you have" rule.
  // Note this is belt and braces: the merge is additive, so an empty list would
  // produce exactly the bundled catalog anyway. Refusing it here is what stops
  // it OVERWRITING a good cached catalog with nothing.
  if (raw == null) return false;
  const list = Array.isArray(raw) ? raw : (raw as { stores?: unknown }).stores;
  if (!Array.isArray(list) || list.length === 0) return false;
  // Refuse to go backwards: a cached v9 beats a fetched v7, which happens when a
  // rollback is in flight or a CDN serves a stale body.
  //
  // `version <= 0` is refused for the same reason and not as a special case. A
  // version is an ordering, and 0 (or a negative) carries no position in it —
  // "no instruction", exactly as the header says. The earlier form was
  // `version > 0 && version < currentVersion`, which EXEMPTED 0 from the
  // ordering check instead of refusing it: a served v0 overwrote a cached v9,
  // reset currentVersion to 0, and got persisted, leaving the client with no
  // rollback protection at all until the next positive version.
  if (version <= 0 || version < currentVersion) return false;

  const { stores, warnings } = mergeStoreCatalog(raw);
  merged = stores;
  supported = null;
  currentVersion = version;

  if (warnings.length > 0) {
    // Loud on purpose: every warning is a published catalog row this build
    // refused. Silence would mean a store that was "added" and never appeared.
    console.warn(`[store-catalog] v${version} from ${source} — ${warnings.length} problem(s):`);
    for (const w of warnings.slice(0, 20)) console.warn(`[store-catalog]   ${w}`);
  } else {
    console.log(`[store-catalog] applied v${version} from ${source} — ${getStores().length} store(s)`);
  }

  for (const listener of listeners) {
    try { listener(); } catch { /* a bad subscriber must not stop the others */ }
  }
  return true;
}

/**
 * Hydrate from cache, then refresh from the server. Safe to call more than once —
 * concurrent calls share one in-flight load. Never throws and never rejects: on
 * any failure the app keeps whatever catalog it already has.
 *
 * @param fetchRemote injected so tests (and the offline path) don't need the
 *        network; production passes the api.ts implementation.
 * @param cache optional persistence (see CatalogCache). Omit to run memory-only.
 */
export function loadStoreCatalog(
  fetchRemote: () => Promise<{ version: number; stores: unknown } | null>,
  cache?: CatalogCache,
): Promise<void> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const cached = await cache?.read();
      if (cached) apply(cached.version, cached.raw, 'cache');
    } catch { /* cache is best-effort */ }

    try {
      const remote = await fetchRemote();
      if (remote && typeof remote.version === 'number') {
        // Persist the RAW payload, not the merged result: a future build with a
        // different bundled list — or with automation for a store this one has
        // to filter out — must re-merge against its own baseline rather than
        // inherit this build's.
        if (apply(remote.version, remote.stores, 'server')) {
          await cache?.write(remote.version, remote.stores);
        }
      }
    } catch {
      // Server unreachable or 401. Cache or bundled list remains in force, which
      // is exactly the intended degradation.
    }
  })().finally(() => { loadPromise = null; });

  return loadPromise;
}

/** Reset to the bundled list. Test/dev only. */
export function __resetStoreCatalogForTests(): void {
  merged = BUNDLED_STORES;
  supported = null;
  currentVersion = 0;
  loadPromise = null;
  listeners.clear();
}
