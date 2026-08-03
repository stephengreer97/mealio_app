// Runtime accessor for the automation config.
//
// Lifecycle:
//   1. Module load — the bundled defaults are live immediately. Nothing ever waits
//      on the network to read config, so a slow fetch can't delay a cart run.
//   2. loadAutomationConfig() (called once at app start) hydrates from the
//      SecureStore cache, then fetches the active version from mealio.co.
//   3. Any later read picks up whichever is newest. Reads are SYNCHRONOUS because
//      the store scripts interpolate selectors while building an injectable
//      string, deep inside render — there is nowhere to await.
//
// The "keep what you have" rule: a fetch that returns version 0 or an empty
// override tree is treated as "no instruction", NOT as "revert to bundled". The
// server briefly has no active row while a publish/rollback swaps rows, and a
// client that reverted during that window would undo a shipped fix for one run.

import { AutomationConfig, BUNDLED_AUTOMATION_CONFIG, StoreSelectors } from './schema';
import { mergeAutomationConfig } from './merge';

export * from './schema';
export { mergeAutomationConfig } from './merge';

// NOTE: this module must NOT import ./store. Every store-script module imports
// this file to read selectors, so anything imported here lands in the dependency
// graph of the pure node test project — and ./store pulls in expo-secure-store,
// which that project can't transform. Persistence is therefore INJECTED (see the
// ConfigCache parameter of loadAutomationConfig) rather than imported. App.tsx
// wires the real implementation; tests pass a fake or nothing at all.

/** Persistence for the last-known-good remote config. See ./store. */
export interface ConfigCache {
  read: () => Promise<{ version: number; raw: unknown } | null>;
  write: (version: number, raw: unknown) => Promise<void>;
}

let current: AutomationConfig = BUNDLED_AUTOMATION_CONFIG;
let currentVersion = 0;
let loadPromise: Promise<void> | null = null;

/** The live config. Never null — bundled defaults until a remote load lands. */
export function getAutomationConfig(): AutomationConfig {
  return current;
}

/** Active remote config version, or 0 when running on bundled defaults. Reported
 *  with every telemetry row so a regression is attributable to a config push. */
export function getConfigVersion(): number {
  return currentVersion;
}

function apply(version: number, raw: unknown, source: string): boolean {
  // Empty/absent overrides carry no instruction — see the "keep what you have"
  // rule above. Also refuse to go backwards: a cached v9 beats a fetched v7,
  // which happens when a rollback is in flight or a CDN serves a stale body.
  if (raw == null || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) return false;
  if (version > 0 && version < currentVersion) return false;

  const { config, warnings } = mergeAutomationConfig(raw);
  current = config;
  currentVersion = version;

  if (warnings.length > 0) {
    // Loud on purpose: every warning is a field of a published config that this
    // build refused. Silence here would mean a "pushed" fix that never applied.
    console.warn(`[automation-config] v${version} from ${source} — ${warnings.length} field(s) rejected:`);
    for (const w of warnings.slice(0, 20)) console.warn(`[automation-config]   ${w}`);
  } else {
    console.log(`[automation-config] applied v${version} from ${source}`);
  }
  return true;
}

/**
 * Hydrate from cache, then refresh from the server. Safe to call more than once —
 * concurrent calls share one in-flight load. Never throws and never rejects: on
 * any failure the app keeps whatever config it already has.
 *
 * @param fetchRemote injected so tests (and the offline path) don't need the
 *        network; production passes the api.ts implementation.
 * @param cache optional persistence (see ConfigCache). Omit to run memory-only.
 */
export function loadAutomationConfig(
  fetchRemote: () => Promise<{ version: number; config: unknown } | null>,
  cache?: ConfigCache,
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
        // Persist the RAW override tree, not the merged result: a future build
        // with different bundled defaults must re-merge against its own baseline,
        // not inherit this build's.
        if (apply(remote.version, remote.config, 'server')) {
          await cache?.write(remote.version, remote.config);
        }
      }
    } catch {
      // Server unreachable or 401. Cache or bundled defaults remain in force,
      // which is exactly the intended degradation.
    }
  })().finally(() => { loadPromise = null; });

  return loadPromise;
}

/** Per-store config, or an empty entry for a store with no overrides. */
export function storeConfig(storeId: string) {
  return current.stores[storeId] ?? {};
}

/** True unless a remote push has explicitly disabled this store's automation. */
export function isStoreEnabled(storeId: string): boolean {
  return current.stores[storeId]?.enabled !== false;
}

/**
 * Selectors for a store, ready to interpolate into an injected script.
 *
 * Values are returned as JS string LITERALS (quotes included) via
 * JSON.stringify, so a template does:
 *
 *     var ATC_SEL = ${sel.atc};        // not '${sel.atc}'
 *
 * merge.ts already rejects selectors containing quotes or backslashes; this is the
 * second, independent defense. Doing the escaping here rather than at each of the
 * ~40 interpolation sites means a new site can't forget it.
 *
 * `fallbacks` supplies the literal a store script used before it was moved into
 * config, so an unknown key yields working JS instead of `undefined`.
 */
export function selectorsFor(
  storeId: string,
  fallbacks: StoreSelectors = {},
): Record<string, string> {
  const configured = current.stores[storeId]?.selectors ?? {};
  const merged: StoreSelectors = { ...fallbacks, ...configured };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) out[key] = JSON.stringify(value);
  // A key the caller never declared a fallback for and config never set would be
  // `undefined` in the template. Return an empty-string literal so the script
  // still parses; a selector matching nothing degrades to "found no candidates",
  // which the funnel records as `candidates: empty` rather than a syntax error.
  return new Proxy(out, {
    get: (target, prop: string) => (prop in target ? target[prop] : '""'),
  });
}

/** Search-results URL for a term, honoring a remote searchUrlTemplate override. */
export function searchUrlFor(storeId: string, term: string, fallback: string): string {
  const template = current.stores[storeId]?.searchUrlTemplate;
  if (!template) return fallback;
  return template.replace('{term}', encodeURIComponent(term));
}

/** Reset to bundled defaults. Test/dev only. */
export function __resetAutomationConfigForTests(): void {
  current = BUNDLED_AUTOMATION_CONFIG;
  currentVersion = 0;
  loadPromise = null;
}
