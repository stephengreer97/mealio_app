// Persistence for the last-known-good remote automation config.
//
// expo-secure-store is the only storage this app already depends on, and on
// Android it warns (and can fail) above ~2048 bytes per value. Adding
// AsyncStorage or expo-file-system would mean a new native module and therefore a
// new EAS build, so instead the payload is split across numbered chunk keys.
//
// Why persist at all, when no network means no automation anyway? Because the
// failure we're actually insuring against is "mealio.co is down but the stores are
// up". In that case the device has connectivity, automation would otherwise run
// fine, and reverting to bundled selectors would undo a fix we already shipped.

// Imported by App.tsx and passed to loadAutomationConfig as its ConfigCache.
// Deliberately NOT imported by automation-config/index.ts — see the note there.
import * as SecureStore from 'expo-secure-store';
import type { ConfigCache } from './index';

const VERSION_KEY = 'mealio.automationConfig.version';
const CHUNK_COUNT_KEY = 'mealio.automationConfig.chunks';
const CHUNK_KEY = (i: number) => `mealio.automationConfig.c${i}`;

// Comfortably under SecureStore's Android warning threshold.
const CHUNK_SIZE = 1_800;
// 8 chunks ≈ 14KB. Past that we keep the config in memory for this session but
// skip persisting rather than writing dozens of keys — a config that large is
// itself a signal something is wrong.
const MAX_CHUNKS = 8;

export interface PersistedConfig {
  version: number;
  /** The raw remote override tree, exactly as fetched (pre-merge). */
  raw: unknown;
}

function chunk(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE));
  return out;
}

/** Best-effort read of the cached config. Returns null when absent or corrupt. */
export async function readCachedConfig(): Promise<PersistedConfig | null> {
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
export async function writeCachedConfig(version: number, raw: unknown): Promise<void> {
  try {
    const serialized = JSON.stringify(raw ?? {});
    const parts = chunk(serialized);
    if (parts.length > MAX_CHUNKS) {
      console.warn(`[automation-config] ${serialized.length}B exceeds cache capacity — not persisted`);
      return;
    }

    // Write chunks first, then the count, then the version. A crash mid-sequence
    // leaves a stale-but-consistent cache (old count still points at chunks that
    // exist) rather than a version claiming data that was never written.
    await Promise.all(parts.map((p, i) => SecureStore.setItemAsync(CHUNK_KEY(i), p)));
    await SecureStore.setItemAsync(CHUNK_COUNT_KEY, String(parts.length));
    await SecureStore.setItemAsync(VERSION_KEY, String(version));

    // Clear any chunks left over from a previously larger config, so a later read
    // can't splice stale trailing bytes onto a shorter payload.
    for (let i = parts.length; i < MAX_CHUNKS; i++) {
      await SecureStore.deleteItemAsync(CHUNK_KEY(i)).catch(() => {});
    }
  } catch {
    /* cache write is best-effort */
  }
}

/** The ConfigCache implementation to hand loadAutomationConfig in production. */
export const secureStoreConfigCache: ConfigCache = {
  read: readCachedConfig,
  write: writeCachedConfig,
};

/** Drop the cache. Used by the dev reset path. */
export async function clearCachedConfig(): Promise<void> {
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
