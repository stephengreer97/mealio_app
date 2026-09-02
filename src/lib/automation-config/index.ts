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

import {
  AutomationConfig,
  BUNDLED_AUTOMATION_CONFIG,
  PlatformId,
  StoreSelectors,
} from './schema';
import { mergeAutomationConfig, isValidSelector } from './merge';

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
  //
  // `version <= 0` is refused for the same reason and not as a special case. A
  // version is an ordering, and 0 (or a negative) carries no position in it —
  // "no instruction", exactly as the header above says. The earlier form was
  // `version > 0 && version < currentVersion`, which EXEMPTED 0 from the
  // ordering check instead of refusing it: a served v0 overwrote a cached v9,
  // reset currentVersion to 0, and got persisted, leaving the client with no
  // rollback protection at all until the next positive version — on the config
  // that carries the store selectors and the kill switches. Found in MEAL-23's
  // copy of this clause and fixed in both; the two must stay identical.
  if (raw == null || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) return false;
  if (version <= 0 || version < currentVersion) return false;

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
 * The platform a store inherits selectors from, or undefined for none.
 *
 * `declared` is what the calling adapter knows about itself — instacart.ts passes
 * 'instacart' because that is what the module IS. Config wins when it names a
 * platform, matching how every other field in this subsystem works (`cfg.storeUrl
 * ?? t.origin`), and the `declared` value covers the case that makes the feature
 * worth having: a banner registered in an adapter but not in the config table at
 * all still inherits its platform's selectors, so adding one needs no config entry.
 *
 * A re-platforming push is bounded rather than dangerous: adapters keep their full
 * compiled-in fallback set, so the worst a wrong platform does is drop the store
 * back to the selectors that shipped in the binary.
 */
function platformFor(storeId: string, declared?: PlatformId): PlatformId | undefined {
  return current.stores[storeId]?.platform ?? declared;
}

/**
 * The platform's shared selector table, or {} when there is none.
 *
 * Returns {} — never undefined, never throws — for a platform this build does not
 * have a table for. That covers 'standalone' and 'kroger' (no table by design) and
 * the older-app-meets-newer-config case where the id itself is unrecognised. The
 * store's own selectors and the call-site fallbacks are unaffected, so a store can
 * lose its INHERITANCE without ever losing its selectors.
 */
function platformSelectors(storeId: string, declared?: PlatformId): StoreSelectors {
  const platform = platformFor(storeId, declared);
  if (!platform) return {};
  return current.platforms[platform]?.selectors ?? {};
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
 * PRECEDENCE, least to most specific — most specific wins:
 *
 *     call-site `fallbacks`  <  platforms.<platform>.selectors  <  stores.<id>.selectors
 *
 * so a platform push fixes every banner on the platform in one go, while a banner
 * that has diverged pins the one key it needs and is untouched by that push. Each
 * of the two config layers is itself already remote-over-bundled, merged in
 * merge.ts. `fallbacks` supplies the literal a store script used before it was
 * moved into config, so an unknown key yields working JS instead of `undefined`.
 *
 * `platform` is the adapter's own declaration; see platformFor().
 */
export function selectorsFor(
  storeId: string,
  fallbacks: StoreSelectors = {},
  platform?: PlatformId,
): Record<string, string> {
  const configured = current.stores[storeId]?.selectors ?? {};
  const merged: StoreSelectors = {
    ...fallbacks,
    ...platformSelectors(storeId, platform),
    ...configured,
  };
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

/**
 * Selectors as RAW strings — no surrounding quotes, no escaping.
 *
 * For the handful of sites that embed a selector INSIDE a JS literal the script
 * already owns:
 *
 *     document.querySelector('${raw.searchTrigger}')   // not ${sel.searchTrigger}
 *
 * Those sites exist because moving an already-shipped selector into config must
 * not change the BYTES of the script that ships (selectorsFor's JSON.stringify
 * emits `"a[href=\"x\"]"`, which is different text from the `'a[href="x"]'` the
 * script had inline). See tests/unit/webview-scripts/aldiGeneratedScripts.test.ts.
 *
 * The escaping that selectorsFor provides is replaced here by re-validation: a
 * CONFIGURED value that could break out of a single-quoted literal (quote,
 * backslash, backtick, newline, `${`) is dropped and the compile-time fallback
 * stands, so the worst a bad or hostile push can do is fail to take effect.
 * `fallbacks` is developer-authored and used verbatim — that is the only way a
 * default containing a double quote can survive to the page.
 *
 * Same precedence as selectorsFor (fallbacks < platform < store), with the same
 * re-validation applied at BOTH config layers. Note the consequence for a bundled
 * PLATFORM selector containing a double quote, which most of them do: it is
 * re-validated like any configured value, dropped, and the identical call-site
 * fallback stands. That is exactly what already happened to the bundled STORE
 * selectors this table was extracted from, which is why moving them here does not
 * change a byte of what ships.
 *
 * Prefer selectorsFor() for any NEW interpolation site. This one is for keeping
 * faith with scripts that are already in users' hands.
 */
export function rawSelectorsFor(
  storeId: string,
  fallbacks: StoreSelectors = {},
  platform?: PlatformId,
): Record<string, string> {
  const configured = current.stores[storeId]?.selectors ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fallbacks)) {
    if (typeof value === 'string') out[key] = value;
  }
  for (const [key, value] of Object.entries(platformSelectors(storeId, platform))) {
    if (isValidSelector(value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(configured)) {
    if (isValidSelector(value)) out[key] = value;
  }
  // Mirror selectorsFor: an undeclared key yields an empty selector rather than
  // the string "undefined" spliced into the page.
  return new Proxy(out, {
    get: (target, prop: string) => (prop in target ? target[prop] : ''),
  });
}

/**
 * Cart-page URL for a store, honoring a remote `cartUrl` override (MEAL-156).
 *
 * `fallback` is the bundled table's answer. Callers decide whether an override
 * is even eligible: cart-count.ts only consults this for stores that already
 * ship a cart URL, so config repoints an existing probe rather than promoting a
 * store onto a navigation path its script was never written for. See the note on
 * getCartPageUrl.
 *
 * The override is already constrained to a safe absolute https URL by merge.ts
 * (`isValidUrl`, https-only so an override cannot downgrade a store to
 * cleartext); anything else is dropped with a warning before it reaches `current`.
 * So this function does not re-validate — it resolves.
 *
 * Callers must not cache the result across a run: the point of the lever is that
 * it changes without a build, and `getCartPagePath` derives the page-identity
 * guard from this same value so the two can never disagree.
 */
export function cartUrlFor(storeId: string, fallback: string | null): string | null {
  return current.stores[storeId]?.cartUrl ?? fallback;
}

/** Search-results URL for a term, honoring a remote searchUrlTemplate override. */
export function searchUrlFor(storeId: string, term: string, fallback: string): string {
  const template = current.stores[storeId]?.searchUrlTemplate;
  if (!template) return fallback;
  return template.replace('{term}', encodeURIComponent(term));
}

/**
 * Merge an override tree over the bundled defaults. Test/dev only.
 *
 * The same path a server push takes, minus the fetch -- it goes through `apply`,
 * so a value this rejects is one the real merge would reject too. A test that
 * mocks getAutomationConfig instead is asserting against its own answer.
 */
export function __applyAutomationConfigForTests(raw: unknown): void {
  apply(currentVersion + 1, raw, 'server');
}

/** Reset to bundled defaults. Test/dev only. */
export function __resetAutomationConfigForTests(): void {
  current = BUNDLED_AUTOMATION_CONFIG;
  currentVersion = 0;
  loadPromise = null;
}
