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
//
// Every rejection is reported in `warnings` so a bad push is visible in the
// telemetry funnel instead of silently degrading to defaults.

import {
  AutomationConfig,
  BUNDLED_AUTOMATION_CONFIG,
  NUMERIC_BOUNDS,
  StoreConfigEntry,
  StoreSelectors,
} from './schema';

export interface MergeResult {
  config: AutomationConfig;
  warnings: string[];
}

const MAX_SELECTOR_LENGTH = 500;
const MAX_URL_LENGTH = 500;
const MAX_STORES = 40;
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

function isValidSelector(v: unknown): v is string {
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

function mergeSelectors(
  storeId: string,
  target: StoreSelectors,
  remote: unknown,
  warnings: string[],
): void {
  if (!isPlainObject(remote)) {
    warnings.push(`stores.${storeId}.selectors: expected an object — ignored`);
    return;
  }
  const entries = Object.entries(remote);
  if (entries.length > MAX_SELECTORS_PER_STORE) {
    warnings.push(`stores.${storeId}.selectors: ${entries.length} entries exceeds ${MAX_SELECTORS_PER_STORE} — ignored`);
    return;
  }
  for (const [key, value] of entries) {
    // A NEW selector key is allowed — that's how we ship a selector for a page
    // element the current build doesn't reference yet, ready for the next release.
    if (!isValidSelector(value)) {
      warnings.push(`stores.${storeId}.selectors.${key}: unsafe or empty selector — ignored`);
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
      case 'spaSearch': {
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
      case 'selectors': {
        target.selectors = target.selectors ?? {};
        mergeSelectors(storeId, target.selectors, value, warnings);
        break;
      }
      default:
        warnings.push(`${path}: unknown key — ignored`);
    }
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
    if (!['timeouts', 'flags', 'telemetry', 'stores'].includes(key)) {
      warnings.push(`${key}: unknown top-level section — ignored`);
    }
  }

  mergeScalarSection('timeouts', config.timeouts, remote.timeouts, warnings);
  mergeScalarSection('flags', config.flags, remote.flags, warnings);
  mergeScalarSection('telemetry', config.telemetry, remote.telemetry, warnings);

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
