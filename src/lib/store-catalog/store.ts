// Persistence for the last-known-good remote store catalog.
//
// Same shape and the same constraint as automation-config/store.ts:
// expo-secure-store is the only storage this app already depends on, and on
// Android it warns (and can fail) above ~2048 bytes per value, so the payload is
// split across numbered chunk keys. Adding AsyncStorage or expo-file-system
// would mean a new native module and therefore a new EAS build.
//
// Why persist at all? Because the alternative is that a user who added a meal at
// a newly published store, then opened the app on a plane, finds that store gone
// from the picker. The catalog is the answer to "what can I pick", and that
// question must be answerable offline.

// Imported by StoreCatalogLoader and passed to loadStoreCatalog as its
// CatalogCache. Deliberately NOT imported by store-catalog/index.ts — see the
// note there.
import * as SecureStore from 'expo-secure-store';
import type { CatalogCache } from './index';

const VERSION_KEY = 'mealio.storeCatalog.version';
const CHUNK_COUNT_KEY = 'mealio.storeCatalog.chunks';
const CHUNK_KEY = (i: number) => `mealio.storeCatalog.c${i}`;

// Comfortably under SecureStore's Android warning threshold.
const CHUNK_SIZE = 1_800;
// 12 chunks ≈ 21KB. At ~55 bytes an entry that is room for several hundred
// stores, well past the 200 the merge accepts, so the cap that bites is always
// the merge's — a catalog is refused for being implausible, never for being
// awkward to store.
const MAX_CHUNKS = 12;

export interface PersistedCatalog {
  version: number;
  /** The raw remote payload, exactly as fetched (pre-merge). */
  raw: unknown;
}

function chunk(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE));
  return out;
}

/** Best-effort read of the cached catalog. Returns null when absent or corrupt. */
export async function readCachedCatalog(): Promise<PersistedCatalog | null> {
  try {
    const [versionRaw, countRaw] = await Promise.all([
      SecureStore.getItemAsync(VERSION_KEY),
      SecureStore.getItemAsync(CHUNK_COUNT_KEY),
    ]);
    const version = versionRaw ? parseInt(versionRaw, 10) : NaN;
    const count = countRaw ? parseInt(countRaw, 10) : NaN;
    if (!Number.isFinite(version) || !Number.isFinite(count) || count <= 0 || count > MAX_CHUNKS) {
      return null;
    }

    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(CHUNK_KEY(i))),
    );
    // A missing chunk means a partial write (app killed mid-save). Treat the
    // whole cache as absent rather than parsing a truncated JSON prefix.
    if (parts.some((p) => p == null)) return null;

    return { version, raw: JSON.parse(parts.join('')) };
  } catch {
    return null;
  }
}

/** Best-effort write. Silently no-ops on failure — this is a cache, not state. */
export async function writeCachedCatalog(version: number, raw: unknown): Promise<void> {
  try {
    const serialized = JSON.stringify(raw ?? []);
    const parts = chunk(serialized);
    if (parts.length > MAX_CHUNKS) {
      console.warn(`[store-catalog] ${serialized.length}B exceeds cache capacity — not persisted`);
      return;
    }

    // Write chunks first, then the count, then the version. A crash mid-sequence
    // leaves a stale-but-consistent cache (old count still points at chunks that
    // exist) rather than a version claiming data that was never written.
    await Promise.all(parts.map((p, i) => SecureStore.setItemAsync(CHUNK_KEY(i), p)));
    await SecureStore.setItemAsync(CHUNK_COUNT_KEY, String(parts.length));
    await SecureStore.setItemAsync(VERSION_KEY, String(version));

    // Clear any chunks left over from a previously larger catalog, so a later
    // read can't splice stale trailing bytes onto a shorter payload.
    for (let i = parts.length; i < MAX_CHUNKS; i++) {
      await SecureStore.deleteItemAsync(CHUNK_KEY(i)).catch(() => {});
    }
  } catch {
    /* cache write is best-effort */
  }
}

/** The CatalogCache implementation to hand loadStoreCatalog in production. */
export const secureStoreCatalogCache: CatalogCache = {
  read: readCachedCatalog,
  write: writeCachedCatalog,
};

/** Drop the cache. Used by the dev reset path. */
export async function clearCachedCatalog(): Promise<void> {
  try {
    await Promise.all([
      SecureStore.deleteItemAsync(VERSION_KEY),
      SecureStore.deleteItemAsync(CHUNK_COUNT_KEY),
      ...Array.from({ length: MAX_CHUNKS }, (_, i) => SecureStore.deleteItemAsync(CHUNK_KEY(i))),
    ]);
  } catch {
    /* best-effort */
  }
}
