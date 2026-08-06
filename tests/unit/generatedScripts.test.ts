import * as vm from 'vm';
import { getStoreScripts } from '../../src/lib/webview-scripts/index';
import {
  loadAutomationConfig,
  __resetAutomationConfigForTests,
} from '../../src/lib/automation-config';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';

// Two guarantees about the remote-config plumbing, checked for every store:
//
//   1. Every injectable script still PARSES. Selectors are interpolated into
//      template literals, so a botched interpolation produces a syntax error that
//      silently kills the whole injected script — the WebView reports nothing back
//      and the run just times out. Cheap to catch here, expensive on a device.
//
//   2. A remote override actually REACHES the script. It is easy to add a selector
//      to BUNDLED_AUTOMATION_CONFIG, forget to interpolate it, and then ship config
//      pushes that appear to succeed and change nothing. This fails in that case,
//      naming the store and the specific unreached key.

/** Every store id the registry can build scripts for, with its config key and —
 *  since MEAL-21 — the platform table it inherits selectors from. */
const STORES: Array<{ id: string; configKey: string; platformKey?: string }> = [
  { id: 'heb', configKey: 'heb' },
  { id: 'walmart', configKey: 'walmart' },
  { id: 'aldi', configKey: 'aldi', platformKey: 'instacart' },
  { id: 'amazon', configKey: 'amazon' },
  { id: 'wegmans', configKey: 'wegmans' },
  { id: 'albertsons', configKey: 'albertsons', platformKey: 'albertsons' },
  // A second Albertsons banner, to prove the family shares one config entry.
  { id: 'safeway', configKey: 'albertsons', platformKey: 'albertsons' },
];

/**
 * The selector keys a store resolves, split by the LEVEL each is published at.
 *
 * Both levels have to be exercised. When the shared selectors moved from
 * `stores.aldi` / `stores.albertsons` into their platform tables, a store-only
 * version of this helper would have found zero keys for exactly the two stores
 * this change touched, and the suites below would have skipped them silently —
 * losing the coverage while still reporting green.
 */
function selectorKeysFor(configKey: string, platformKey?: string) {
  return {
    storeKeys: Object.keys(BUNDLED_AUTOMATION_CONFIG.stores[configKey]?.selectors ?? {}),
    platformKeys: platformKey
      ? Object.keys(BUNDLED_AUTOMATION_CONFIG.platforms[platformKey]?.selectors ?? {})
      : [],
  };
}

/** A config push setting every given key to `${prefix}<key>`, at the right level. */
function overridePush(
  configKey: string,
  platformKey: string | undefined,
  storeKeys: string[],
  platformKeys: string[],
  prefix: string,
) {
  const mark = (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, `${prefix}${k}`]));
  const config: Record<string, unknown> = {
    stores: { [configKey]: { selectors: mark(storeKeys) } },
  };
  if (platformKey && platformKeys.length > 0) {
    config.platforms = { [platformKey]: { selectors: mark(platformKeys) } };
  }
  return config;
}

/** All scripts a store can produce, keyed by name for readable failures. */
function allScriptsFor(id: string): Record<string, string> {
  const s = getStoreScripts(id);
  if (!s) throw new Error(`no scripts for ${id}`);
  const out: Record<string, string> = {
    checkLogin: s.checkLoginScript,
    extract: s.extractProductsScript,
    addToCart: s.buildAddToCartScript('Test Product 12 oz', null, 2, null),
    search: s.buildSearchScript('chicken breast'),
    searchAndAdd: s.buildSearchAndAddScript('chicken breast', 2, null),
  };
  if (s.buildWorkerScript) out.worker = s.buildWorkerScript(0);
  return out;
}

beforeEach(() => __resetAutomationConfigForTests());
afterAll(() => __resetAutomationConfigForTests());

describe('generated store scripts parse as valid JS', () => {
  for (const { id } of STORES) {
    it(id, () => {
      for (const [name, src] of Object.entries(allScriptsFor(id))) {
        expect(typeof src).toBe('string');
        expect(src.length).toBeGreaterThan(0);
        try {
          new vm.Script(src);
        } catch (e) {
          throw new Error(`${id}/${name} syntax error: ${(e as Error).message}`);
        }
      }
    });
  }
});

describe('scripts still parse after a remote selector override', () => {
  for (const { id, configKey, platformKey } of STORES) {
    it(id, async () => {
      const { storeKeys, platformKeys } = selectorKeysFor(configKey, platformKey);
      if (storeKeys.length === 0 && platformKeys.length === 0) return;
      // A plausible replacement selector: no quotes, so it survives validation.
      await loadAutomationConfig(async () => ({
        version: 99,
        config: overridePush(configKey, platformKey, storeKeys, platformKeys, '.remote-'),
      }));
      for (const [name, src] of Object.entries(allScriptsFor(id))) {
        try {
          new vm.Script(src);
        } catch (e) {
          throw new Error(`${id}/${name} broke under overridden selectors: ${(e as Error).message}`);
        }
      }
    });
  }
});

describe('every bundled selector is actually interpolated into a script', () => {
  for (const { id, configKey, platformKey } of STORES) {
    const { storeKeys, platformKeys } = selectorKeysFor(configKey, platformKey);
    if (storeKeys.length === 0 && platformKeys.length === 0) continue;

    it(`${id} (${storeKeys.length} store + ${platformKeys.length} platform selectors)`, async () => {
      await loadAutomationConfig(async () => ({
        version: 99,
        config: overridePush(configKey, platformKey, storeKeys, platformKeys, '.remote-marker-'),
      }));

      const combined = Object.values(allScriptsFor(id)).join('\n');
      const unreached = [...storeKeys, ...platformKeys]
        .filter((k) => !combined.includes(`.remote-marker-${k}`));

      // A key in the config that no script reads is dead weight at best and a
      // false promise at worst: an operator would push it expecting a fix. For a
      // PLATFORM key this also proves the inheritance is wired: the push names
      // only the platform, so a marker reaching the script means the store
      // resolved it without an entry of its own.
      expect(unreached).toEqual([]);
    });
  }
});

describe('remote overrides replace the bundled selector, not sit alongside it', () => {
  // Selectors reach the script as JS string literals, so a selector containing
  // double quotes appears backslash-escaped. Compare against that escaped form,
  // not the raw value, or this asserts something that was never in the output.
  const escaped = (raw: string) => JSON.stringify(raw).slice(1, -1);

  it('a STORE-level push fully swaps the inherited platform selector', async () => {
    const bundled = escaped(BUNDLED_AUTOMATION_CONFIG.platforms.albertsons.selectors!.atc);
    expect(Object.values(allScriptsFor('albertsons')).join('\n')).toContain(bundled);

    await loadAutomationConfig(async () => ({
      version: 99, config: { stores: { albertsons: { selectors: { atc: '.brand-new-atc' } } } },
    }));

    const after = Object.values(allScriptsFor('albertsons')).join('\n');
    expect(after).toContain('.brand-new-atc');
    // The old literal must be GONE. A script still carrying both would keep
    // matching the stale element and the "fix" would appear not to work.
    expect(after).not.toContain(bundled);
  });

  it('a PLATFORM-level push fully swaps it too, for every banner', async () => {
    const bundled = escaped(BUNDLED_AUTOMATION_CONFIG.platforms.albertsons.selectors!.atc);
    await loadAutomationConfig(async () => ({
      version: 99, config: { platforms: { albertsons: { selectors: { atc: '.platform-atc' } } } },
    }));
    for (const banner of ['albertsons', 'safeway', 'vons']) {
      const after = Object.values(allScriptsFor(banner)).join('\n');
      expect(after).toContain('.platform-atc');
      expect(after).not.toContain(bundled);
    }
  });

  it('an Instacart platform push reaches ALDI', async () => {
    const bundled = escaped(BUNDLED_AUTOMATION_CONFIG.platforms.instacart.selectors!.atc);
    expect(Object.values(allScriptsFor('aldi')).join('\n')).toContain(bundled);

    await loadAutomationConfig(async () => ({
      version: 99, config: { platforms: { instacart: { selectors: { atc: '.instacart-atc' } } } },
    }));
    const after = Object.values(allScriptsFor('aldi')).join('\n');
    expect(after).toContain('.instacart-atc');
    expect(after).not.toContain(bundled);
  });

  it('a platform push does NOT reach a store on a different platform', async () => {
    // The inheritance blast radius stops at the platform boundary.
    const hebBundled = escaped(BUNDLED_AUTOMATION_CONFIG.stores.heb.selectors!.title);
    await loadAutomationConfig(async () => ({
      version: 99, config: { platforms: { instacart: { selectors: { title: '.leaked' } } } },
    }));
    const heb = Object.values(allScriptsFor('heb')).join('\n');
    expect(heb).toContain(hebBundled);
    expect(heb).not.toContain('.leaked');
  });
});

describe('remote kill switch', () => {
  it('disables a store without touching the others', async () => {
    await loadAutomationConfig(async () => ({
      version: 99, config: { stores: { aldi: { enabled: false } } },
    }));
    expect(getStoreScripts('aldi')).toBeNull();
    expect(getStoreScripts('heb')).not.toBeNull();
  });

  it('disables every Albertsons banner from the one shared entry', async () => {
    await loadAutomationConfig(async () => ({
      version: 99, config: { stores: { albertsons: { enabled: false } } },
    }));
    for (const banner of ['albertsons', 'safeway', 'vons', 'jewel_osco']) {
      expect(getStoreScripts(banner)).toBeNull();
    }
  });
});

describe('remote URL overrides', () => {
  it('replaces a cart URL and search URL template', async () => {
    await loadAutomationConfig(async () => ({
      version: 99,
      config: {
        stores: {
          walmart: {
            cartUrl: 'https://www.walmart.com/basket',
            searchUrlTemplate: 'https://www.walmart.com/browse?query={term}',
          },
        },
      },
    }));
    const s = getStoreScripts('walmart')!;
    expect(s.cartUrl).toBe('https://www.walmart.com/basket');
    expect(s.getSearchUrl!('chicken breast'))
      .toBe('https://www.walmart.com/browse?query=chicken%20breast');
  });

  it('keeps the bundled URL when no override is published', () => {
    expect(getStoreScripts('walmart')!.cartUrl).toBe('https://www.walmart.com/cart');
  });
});
