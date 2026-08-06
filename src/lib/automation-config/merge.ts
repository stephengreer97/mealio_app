// Pure validation + deep merge of a remote override tree over the bundled config.
//
// This is the trust boundary. The input arrives over the network as untyped JSON
// and its values end up (a) driving timers and (b) INTERPOLATED INTO JAVASCRIPT
// that we inject into a store's page. So this module's job is not "merge two
// objects" — it is "decide which remote values are safe to believe".
//
// Design rules:
//   • Unknown keys are dropped, never merged. A newer server can publish fields
//     this build doesn't know about without corrupting the config it does know.
//   • A value of the wrong TYPE is rejected, keeping the bundled default. One bad
//     field never takes the rest of the tree down with it.
//   • A number outside NUMERIC_BOUNDS is rejected rather than clamped: a 100ms
//     search timeout fails every run and a 10-minute one hangs the UI, so both
//     are bugs, and silently substituting a value nobody chose hides the bug.
//   • Selector strings are rejected if they contain characters that could break
//     out of the JS string literal they get interpolated into. The interpolation
//     site ALSO JSON.stringify()s them (see selectorsFor) — two independent
//     defenses, because a config push is a remote code path into the WebView.
//   • PLATFORM-level values (the `platforms` section, inherited by every store on
//     a platform) go through the exact same validation as store-level ones. They
//     reach more stores, which is a reason to gate them identically, not loosely.
//     A `platform` a store names but this build doesn't know is refused, which
//     leaves the store on its bundled platform rather than stripped of selectors.
//
// Every rejection is reported in `warnings` so a bad push is visible in the
// telemetry funnel instead of silently degrading to defaults.

import {
  AutomationConfig,
  BUNDLED_AUTOMATION_CONFIG,
  NUMERIC_BOUNDS,
  PLATFORM_IDS,
  PlatformConfigEntry,
  StoreConfigEntry,
  StoreSelectors,
  isPlatformId,
} from './schema';

export interface MergeResult {
  config: AutomationConfig;
  warnings: string[];
}

const MAX_SELECTOR_LENGTH = 500;
const MAX_URL_LENGTH = 500;
const MAX_STORES = 40;
// Room for the known platforms plus headroom for ones a newer server knows about.
const MAX_PLATFORMS = 12;
const MAX_SELECTORS_PER_STORE = 60;

// Characters that would terminate or escape the JS string literal a selector is
// interpolated into, plus anything that could start a new tag or comment.
const UNSAFE_SELECTOR = /['"\\`\r\n\u2028\u2029<>]|\$\{/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** True when the string is a safe absolute https URL. */
function isValidUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL_LENGTH) return false;
  // https only: an http override would downgrade a store to cleartext, and a
  // javascript:/data: URL in a WebView src is straightforwardly an exploit.
  if (!/^https:\/\//i.test(v)) return false;
  return !UNSAFE_SELECTOR.test(v);
}

/** True when a selector is safe to interpolate into an injected script.
 *  Exported so the RAW interpolation path (rawSelectorsFor) can re-apply the
 *  same rule at read time instead of relying on JSON.stringify. */
export function isValidSelector(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= MAX_SELECTOR_LENGTH &&
    !UNSAFE_SELECTOR.test(v)
  );
}

/** Numeric field: finite, and inside the declared bound for its path. */
function takeNumber(path: string, value: unknown, warnings: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${path}: expected a finite number, got ${typeof value}`);
    return undefined;
  }
  const bounds = NUMERIC_BOUNDS[path] ?? NUMERIC_BOUNDS[path.replace(/\.[^.]+\./, '.*.')];
  if (bounds && (value < bounds.min || value > bounds.max)) {
    warnings.push(`${path}: ${value} outside [${bounds.min}, ${bounds.max}] — keeping default`);
    return undefined;
  }
  return value;
}

function takeBoolean(path: string, value: unknown, warnings: string[]): boolean | undefined {
  if (typeof value !== 'boolean') {
    warnings.push(`${path}: expected a boolean, got ${typeof value}`);
    return undefined;
  }
  return value;
}

/**
 * Merge a flat record of known numeric/boolean keys. Mutates `target`.
 *
 * `target` is typed as `object` rather than an index-signature record so the
 * precise config interfaces (TimeoutConfig, FlagConfig, …) can be passed without
 * loosening them — those types are deliberately closed, which is what makes
 * "unknown key" detection below meaningful.
 */
function mergeScalarSection(
  section: string,
  target: object,
  remote: unknown,
  warnings: string[],
): void {
  const bag = target as Record<string, unknown>;
  if (remote === undefined) return;
  if (!isPlainObject(remote)) {
    warnings.push(`${section}: expected an object — ignored`);
    return;
  }
  for (const [key, value] of Object.entries(remote)) {
    const path = `${section}.${key}`;
    if (!(key in bag)) {
      warnings.push(`${path}: unknown key — ignored`);
      continue;
    }
    // The bundled default's type IS the schema — a remote value must match it.
    const current = bag[key];
    if (typeof current === 'number') {
      const n = takeNumber(path, value, warnings);
      if (n !== undefined) bag[key] = n;
    } else if (typeof current === 'boolean') {
      const b = takeBoolean(path, value, warnings);
      if (b !== undefined) bag[key] = b;
    } else {
      warnings.push(`${path}: unsupported field type — ignored`);
    }
  }
}

/**
 * Validate and merge a selector table. Mutates `target`.
 *
 * `path` is the full config path of the table ('stores.heb.selectors',
 * 'platforms.instacart.selectors') and appears in every warning. Store-level and
 * PLATFORM-level tables deliberately go through this one function: a platform
 * value is interpolated into the same injected scripts as a store value, and it
 * reaches more stores, so it gets the identical gate — wider blast radius is a
 * reason to validate the same way, never a reason to relax.
 */
function mergeSelectors(
  path: string,
  target: StoreSelectors,
  remote: unknown,
  warnings: string[],
): void {
  if (!isPlainObject(remote)) {
    warnings.push(`${path}: expected an object — ignored`);
    return;
  }
  const entries = Object.entries(remote);
  if (entries.length > MAX_SELECTORS_PER_STORE) {
    warnings.push(`${path}: ${entries.length} entries exceeds ${MAX_SELECTORS_PER_STORE} — ignored`);
    return;
  }
  for (const [key, value] of entries) {
    // A NEW selector key is allowed — that's how we ship a selector for a page
    // element the current build doesn't reference yet, ready for the next release.
    if (!isValidSelector(value)) {
      warnings.push(`${path}.${key}: unsafe or empty selector — ignored`);
      continue;
    }
    target[key] = value as string;
  }
}

function mergeStore(
  storeId: string,
  target: StoreConfigEntry,
  remote: Record<string, unknown>,
  warnings: string[],
): void {
  for (const [key, value] of Object.entries(remote)) {
    const path = `stores.${storeId}.${key}`;
    switch (key) {
      case 'enabled':
      case 'forceSerialSearch':
      case 'cacheBustNav':
      case 'spaSearch':
      case 'nextDataSearch':
      case 'cartSkuConfirm': {
        const b = takeBoolean(path, value, warnings);
        if (b !== undefined) target[key] = b;
        break;
      }
      case 'workerCount':
      case 'workerStaggerMs': {
        const n = takeNumber(path, value, warnings);
        if (n !== undefined) target[key] = Math.trunc(n);
        break;
      }
      case 'storeUrl':
      case 'loginUrl':
      case 'cartUrl': {
        if (isValidUrl(value)) target[key] = value;
        else warnings.push(`${path}: not a safe https URL — ignored`);
        break;
      }
      case 'searchUrlTemplate': {
        // Must contain the {term} placeholder, or every search would load the
        // same page and the run would silently add the wrong products.
        if (isValidUrl(value) && (value as string).includes('{term}')) {
          target.searchUrlTemplate = value as string;
        } else {
          warnings.push(`${path}: must be a safe https URL containing {term} — ignored`);
        }
        break;
      }
      case 'platform': {
        // Refused unless this build knows the platform, and that refusal is the
        // safe direction: the store keeps whatever platform it was BUNDLED with,
        // so an old app meeting a config that re-platforms a store onto something
        // newer keeps resolving the selectors it already had. Accepting the
        // unknown string would be almost as safe (it would resolve to no platform
        // table) but it would silently discard a working inheritance link.
        if (isPlatformId(value)) target.platform = value;
        else {
          warnings.push(
            `${path}: not a known platform (${PLATFORM_IDS.join('|')}) — ignored`,
          );
        }
        break;
      }
      case 'selectors': {
        target.selectors = target.selectors ?? {};
        mergeSelectors(`stores.${storeId}.selectors`, target.selectors, value, warnings);
        break;
      }
      default:
        warnings.push(`${path}: unknown key — ignored`);
    }
  }
}

function mergePlatform(
  platformId: string,
  target: PlatformConfigEntry,
  remote: Record<string, unknown>,
  warnings: string[],
): void {
  for (const [key, value] of Object.entries(remote)) {
    const path = `platforms.${platformId}.${key}`;
    if (key === 'selectors') {
      target.selectors = target.selectors ?? {};
      mergeSelectors(`platforms.${platformId}.selectors`, target.selectors, value, warnings);
    } else {
      // Only selectors are shared platform-wide. A URL or kill switch here would
      // be a push that takes out every banner on the platform at once, which is
      // the one thing this feature must not make possible — see PlatformConfigEntry.
      warnings.push(`${path}: unknown key — ignored`);
    }
  }
}

/**
 * Merge the `platforms` section: selector tables inherited by every store on a
 * platform.
 *
 * Unlike `stores`, an UNKNOWN key is refused rather than accepted as a new entry.
 * The asymmetry is deliberate. A store id is an open namespace (constants/stores.ts
 * grows without this file's permission), and accepting an unknown one lets us
 * pre-stage config for a banner before its adapter ships. A platform id is a
 * closed set, and a table for a platform this build cannot name is unreachable
 * anyway: the only way to attach a store to it is `stores.<id>.platform`, which
 * refuses the same unknown value. So it would be dead weight that merely looked
 * like it had been applied.
 */
function mergePlatforms(remote: unknown, config: AutomationConfig, warnings: string[]): void {
  if (!isPlainObject(remote)) {
    warnings.push('platforms: expected an object — ignored');
    return;
  }
  const entries = Object.entries(remote);
  // Bail on an oversized section rather than emitting a warning per junk key, the
  // same way `stores` is guarded by MAX_STORES. Only known ids are accepted below,
  // so a payload larger than this is malformed or hostile either way.
  if (entries.length > MAX_PLATFORMS) {
    warnings.push(`platforms: ${entries.length} entries exceeds ${MAX_PLATFORMS} — ignored`);
    return;
  }
  for (const [platformId, entry] of entries) {
    if (!isPlatformId(platformId)) {
      warnings.push(
        `platforms.${platformId}: not a known platform (${PLATFORM_IDS.join('|')}) — ignored`,
      );
      continue;
    }
    if (!isPlainObject(entry)) {
      warnings.push(`platforms.${platformId}: expected an object — ignored`);
      continue;
    }
    // A platform with no bundled table is still configurable — that is how
    // 'kroger' gets selectors before its adapter exists.
    config.platforms[platformId] = config.platforms[platformId] ?? {};
    mergePlatform(platformId, config.platforms[platformId], entry, warnings);
  }
}

/**
 * Merge a remote partial config over the bundled defaults.
 *
 * Always returns a usable config: on any input problem the offending field falls
 * back to its bundled value and the reason lands in `warnings`. Never throws, and
 * never mutates BUNDLED_AUTOMATION_CONFIG.
 */
export function mergeAutomationConfig(
  remote: unknown,
  base: AutomationConfig = BUNDLED_AUTOMATION_CONFIG,
): MergeResult {
  const warnings: string[] = [];
  const config = deepClone(base);

  if (remote === undefined || remote === null) return { config, warnings };
  if (!isPlainObject(remote)) {
    warnings.push('config: expected an object — using bundled defaults');
    return { config, warnings };
  }

  for (const key of Object.keys(remote)) {
    if (!['timeouts', 'flags', 'telemetry', 'platforms', 'stores'].includes(key)) {
      warnings.push(`${key}: unknown top-level section — ignored`);
    }
  }

  mergeScalarSection('timeouts', config.timeouts, remote.timeouts, warnings);
  mergeScalarSection('flags', config.flags, remote.flags, warnings);
  mergeScalarSection('telemetry', config.telemetry, remote.telemetry, warnings);

  if (remote.platforms !== undefined) mergePlatforms(remote.platforms, config, warnings);

  if (remote.stores !== undefined) {
    if (!isPlainObject(remote.stores)) {
      warnings.push('stores: expected an object — ignored');
    } else {
      const storeIds = Object.keys(remote.stores);
      if (storeIds.length > MAX_STORES) {
        warnings.push(`stores: ${storeIds.length} entries exceeds ${MAX_STORES} — ignored`);
      } else {
        for (const storeId of storeIds) {
          const entry = remote.stores[storeId];
          if (!isPlainObject(entry)) {
            warnings.push(`stores.${storeId}: expected an object — ignored`);
            continue;
          }
          // A store the bundle doesn't know is accepted as a new entry. It has no
          // scripts, so it can't run — but it lets us pre-stage config (or push
          // `enabled: false`) ahead of the release that adds the adapter.
          config.stores[storeId] = config.stores[storeId] ?? {};
          mergeStore(storeId, config.stores[storeId], entry, warnings);
        }
      }
    }
  }

  return { config, warnings };
}
