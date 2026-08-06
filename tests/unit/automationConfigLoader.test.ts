import {
  loadAutomationConfig,
  getAutomationConfig,
  getConfigVersion,
  selectorsFor,
  rawSelectorsFor,
  searchUrlFor,
  storeConfig,
  isStoreEnabled,
  __resetAutomationConfigForTests,
  ConfigCache,
} from '../../src/lib/automation-config';
import { BUNDLED_AUTOMATION_CONFIG } from '../../src/lib/automation-config/schema';

// Covers the loader's two non-obvious rules:
//   1. "Keep what you have" — an empty or absent remote payload is NOT an
//      instruction to revert to bundled defaults. The server has a brief window
//      with no active row while a publish swaps rows, and a client that reverted
//      during it would undo a shipped fix for one run.
//   2. selectorsFor returns JS STRING LITERALS, because its output is interpolated
//      into scripts injected into a store's page.

const fakeCache = (initial: { version: number; raw: unknown } | null = null) => {
  const state = { value: initial };
  const cache: ConfigCache = {
    read: jest.fn(async () => state.value),
    write: jest.fn(async (version: number, raw: unknown) => { state.value = { version, raw }; }),
  };
  return { cache, state };
};

beforeEach(() => __resetAutomationConfigForTests());
afterAll(() => __resetAutomationConfigForTests());

describe('initial state', () => {
  it('serves bundled defaults at version 0 before any load', () => {
    expect(getConfigVersion()).toBe(0);
    expect(getAutomationConfig()).toEqual(BUNDLED_AUTOMATION_CONFIG);
  });
});

describe('loadAutomationConfig', () => {
  it('applies a remote config and records its version', async () => {
    const { cache } = fakeCache();
    await loadAutomationConfig(async () => ({ version: 5, config: { timeouts: { addMs: 22_000 } } }), cache);
    expect(getConfigVersion()).toBe(5);
    expect(getAutomationConfig().timeouts.addMs).toBe(22_000);
  });

  it('persists the RAW override tree, not the merged result', async () => {
    // A future build with different bundled defaults must re-merge against its
    // own baseline rather than inherit this build's.
    const { cache, state } = fakeCache();
    const raw = { timeouts: { addMs: 22_000 } };
    await loadAutomationConfig(async () => ({ version: 5, config: raw }), cache);
    expect(cache.write).toHaveBeenCalledWith(5, raw);
    expect(state.value!.raw).toEqual(raw);
  });

  it('hydrates from cache first, then lets the server win', async () => {
    const { cache } = fakeCache({ version: 4, raw: { timeouts: { addMs: 11_000 } } });
    await loadAutomationConfig(async () => ({ version: 6, config: { timeouts: { addMs: 33_000 } } }), cache);
    expect(getConfigVersion()).toBe(6);
    expect(getAutomationConfig().timeouts.addMs).toBe(33_000);
  });

  it('keeps the cached config when the fetch fails', async () => {
    // The real failure this insures against: mealio.co is down but the stores are
    // up, so automation would otherwise work — reverting selectors would break it.
    const { cache } = fakeCache({ version: 4, raw: { timeouts: { addMs: 11_000 } } });
    await loadAutomationConfig(async () => null, cache);
    expect(getConfigVersion()).toBe(4);
    expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
  });

  it('keeps the cached config when the fetch throws', async () => {
    const { cache } = fakeCache({ version: 4, raw: { timeouts: { addMs: 11_000 } } });
    await expect(
      loadAutomationConfig(async () => { throw new Error('offline'); }, cache),
    ).resolves.toBeUndefined();
    expect(getConfigVersion()).toBe(4);
  });

  it('survives a cache read that throws', async () => {
    const cache: ConfigCache = {
      read: jest.fn(async () => { throw new Error('keychain locked'); }),
      write: jest.fn(async () => {}),
    };
    await loadAutomationConfig(async () => ({ version: 2, config: { timeouts: { addMs: 20_000 } } }), cache);
    expect(getConfigVersion()).toBe(2);
  });

  it('works with no cache at all (memory-only)', async () => {
    await loadAutomationConfig(async () => ({ version: 3, config: { timeouts: { addMs: 19_000 } } }));
    expect(getConfigVersion()).toBe(3);
  });

  describe('the "keep what you have" rule', () => {
    it('does not revert to bundled on an EMPTY remote config', async () => {
      const { cache } = fakeCache({ version: 4, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 9, config: {} }), cache);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
      expect(getConfigVersion()).toBe(4);
    });

    it('does not revert on a null remote config', async () => {
      const { cache } = fakeCache({ version: 4, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 9, config: null }), cache);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
    });

    it('refuses to go BACKWARDS in version', async () => {
      // Happens when a rollback is in flight or a CDN serves a stale body.
      const { cache } = fakeCache({ version: 9, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 7, config: { timeouts: { addMs: 33_000 } } }), cache);
      expect(getConfigVersion()).toBe(9);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
    });

    it('does not persist a payload it declined to apply', async () => {
      const { cache } = fakeCache({ version: 9, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 7, config: { timeouts: { addMs: 33_000 } } }), cache);
      expect(cache.write).not.toHaveBeenCalled();
    });

    it('re-applies the same version idempotently', async () => {
      const { cache } = fakeCache({ version: 5, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 5, config: { timeouts: { addMs: 11_000 } } }), cache);
      expect(getConfigVersion()).toBe(5);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
    });
  });
});

describe('selectorsFor', () => {
  it('returns JS string LITERALS, quotes included', async () => {
    // The caller writes `var X = ${s.atc};` — the quoting must come from here so
    // no interpolation site can forget it.
    const s = selectorsFor('albertsons', { atc: 'button[aria-label^="Add 1 unit of"]' });
    expect(s.atc).toBe('"button[aria-label^=\\"Add 1 unit of\\"]"');
    // ...and it must parse back to the original selector.
    expect(JSON.parse(s.atc)).toBe('button[aria-label^="Add 1 unit of"]');
  });

  it('prefers a remote override over the compiled-in fallback', async () => {
    await loadAutomationConfig(async () => ({
      version: 2, config: { stores: { albertsons: { selectors: { atc: '.new-add-btn' } } } },
    }));
    const s = selectorsFor('albertsons', { atc: 'button[aria-label^="Add 1 unit of"]' });
    expect(JSON.parse(s.atc)).toBe('.new-add-btn');
  });

  it('resolves in the order remote > bundled schema > call-site fallback', async () => {
    // There are two fallback layers and the precedence matters. BUNDLED_AUTOMATION_
    // CONFIG in schema.ts is the source of truth for every selector the app knows
    // about; the SEL_FALLBACKS a store module passes here only cover keys the
    // schema does not declare. So a schema-declared key beats the call-site value
    // even when the remote config leaves it alone.
    await loadAutomationConfig(async () => ({
      version: 2, config: { stores: { albertsons: { selectors: { atc: '.new-add-btn' } } } },
    }));
    const s = selectorsFor('albertsons', { atc: '.ignored', bubble: '.also-ignored', novel: '.mine' });
    expect(JSON.parse(s.atc)).toBe('.new-add-btn');                              // remote wins
    // `bubble` is schema-declared on the PLATFORM table that stores.albertsons
    // inherits (MEAL-21), and still beats the call-site fallback.
    expect(JSON.parse(s.bubble))
      .toBe(BUNDLED_AUTOMATION_CONFIG.platforms.albertsons.selectors!.bubble);   // schema wins
    expect(JSON.parse(s.novel)).toBe('.mine');                                   // only here
  });

  it('yields an empty-string literal for an undeclared key rather than "undefined"', () => {
    // A missing key must still produce PARSEABLE JS. A selector matching nothing
    // degrades to "found no candidates" (a funnel 'empty'), not a syntax error
    // that silently kills the whole injected script.
    const s = selectorsFor('albertsons', {});
    expect(s.somethingNobodyDeclared).toBe('""');
    expect(JSON.parse(s.somethingNobodyDeclared)).toBe('');
  });

  it('escapes a selector containing a quote so the literal stays valid', () => {
    const s = selectorsFor('nostore', { x: 'a[b="c"]' });
    expect(() => JSON.parse(s.x)).not.toThrow();
    expect(JSON.parse(s.x)).toBe('a[b="c"]');
  });
});

// ── MEAL-21: selector inheritance ────────────────────────────────────────────
//
// The precedence chain, least to most specific:
//
//     call-site fallbacks  <  platforms.<platform>.selectors  <  stores.<id>.selectors
//
// The risk this feature introduces is a config push breaking a store it does not
// name: before it, a bad ALDI selector broke ALDI, and now a bad platform selector
// could break every Instacart banner. So every level is pinned here, in BOTH
// directions (platform set / store unset, and store set / platform unset), and so
// is the guarantee that no combination can leave a store with NO selectors.
describe('selector inheritance (platform layer)', () => {
  // A store id no adapter owns, so nothing but these tests can influence it.
  const STORE = 'testbanner';

  it('inherits a platform selector when the store has none of its own', async () => {
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { atc: '.platform-atc' } } },
        stores: { [STORE]: { platform: 'instacart' } },
      },
    }));
    expect(JSON.parse(selectorsFor(STORE, { atc: '.fallback-atc' }).atc)).toBe('.platform-atc');
  });

  it('a store-level selector beats the platform one', async () => {
    // The per-banner escape hatch: one banner diverges, names the key, and is
    // unaffected by platform pushes for it.
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { atc: '.platform-atc' } } },
        stores: { [STORE]: { platform: 'instacart', selectors: { atc: '.store-atc' } } },
      },
    }));
    expect(JSON.parse(selectorsFor(STORE, { atc: '.fallback-atc' }).atc)).toBe('.store-atc');
  });

  it('platform value present, store value ABSENT for that key', async () => {
    // Keys resolve independently: overriding `atc` at store level must not drag
    // the rest of the store's selectors off the platform table.
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { atc: '.platform-atc', inc: '.platform-inc' } } },
        stores: { [STORE]: { platform: 'instacart', selectors: { atc: '.store-atc' } } },
      },
    }));
    const s = selectorsFor(STORE, {});
    expect(JSON.parse(s.atc)).toBe('.store-atc');
    expect(JSON.parse(s.inc)).toBe('.platform-inc');
  });

  it('store value present, platform table SILENT for that key', async () => {
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { inc: '.platform-inc' } } },
        stores: { [STORE]: { platform: 'instacart', selectors: { atc: '.store-atc' } } },
      },
    }));
    expect(JSON.parse(selectorsFor(STORE, { atc: '.fallback-atc' }).atc)).toBe('.store-atc');
  });

  it('falls through to the call-site fallback when BOTH tables are silent', async () => {
    // The bundled fallbacks must stay reachable. This is the property that makes
    // every other failure mode survivable.
    await loadAutomationConfig(async () => ({
      version: 2,
      config: { stores: { [STORE]: { platform: 'instacart' } } },
    }));
    expect(JSON.parse(selectorsFor(STORE, { onlyHere: '.compiled-in' }).onlyHere))
      .toBe('.compiled-in');
  });

  it('a platform push reaches a banner that has no store entry at all', async () => {
    // The adapter declares its own platform, so a newly registered tenant inherits
    // without anyone adding it to the config table.
    await loadAutomationConfig(async () => ({
      version: 2, config: { platforms: { instacart: { selectors: { atc: '.pushed' } } } },
    }));
    expect(JSON.parse(selectorsFor('brandnewbanner', { atc: '.fallback' }, 'instacart').atc))
      .toBe('.pushed');
  });

  it('one push reaches EVERY banner on the platform', async () => {
    // Acceptance criterion: a platform-level fix lands everywhere in one config
    // push. ALDI has a bundled entry; the other two do not.
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { qtyBubble: '.one-push' } } },
        stores: { publix: { platform: 'instacart' } },
      },
    }));
    for (const banner of ['aldi', 'publix']) {
      expect(JSON.parse(selectorsFor(banner, {}).qtyBubble)).toBe('.one-push');
    }
    // ...and the one declared only by its adapter, with no config entry.
    expect(JSON.parse(selectorsFor('sprouts', {}, 'instacart').qtyBubble)).toBe('.one-push');
  });

  it('does NOT leak across platforms', async () => {
    // The other half of "a push must not break a store it does not name": an
    // Instacart push must be invisible to the Albertsons family.
    await loadAutomationConfig(async () => ({
      version: 2, config: { platforms: { instacart: { selectors: { atc: '.instacart-only' } } } },
    }));
    expect(JSON.parse(selectorsFor('albertsons', {}, 'albertsons').atc))
      .toBe(BUNDLED_AUTOMATION_CONFIG.platforms.albertsons.selectors!.atc);
  });

  describe('a platform this build does not recognise', () => {
    it('keeps the store its own selectors and fallbacks (config-declared)', async () => {
      // An older app meeting a newer config. merge.ts refuses the unknown id, so
      // the store keeps its BUNDLED platform — losing inheritance is never losing
      // selectors.
      await loadAutomationConfig(async () => ({
        version: 2,
        config: { stores: { [STORE]: { platform: 'shipt', selectors: { atc: '.store-atc' } } } },
      }));
      const s = selectorsFor(STORE, { inc: '.fallback-inc' });
      expect(JSON.parse(s.atc)).toBe('.store-atc');
      expect(JSON.parse(s.inc)).toBe('.fallback-inc');
    });

    it('cannot push a known store off its bundled platform', async () => {
      await loadAutomationConfig(async () => ({
        version: 2, config: { stores: { aldi: { platform: 'shipt' } } },
      }));
      // ALDI still resolves the Instacart table it was bundled with.
      expect(JSON.parse(selectorsFor('aldi', {}).atc))
        .toBe(BUNDLED_AUTOMATION_CONFIG.platforms.instacart.selectors!.atc);
    });

    it('resolves safely for a RECOGNISED platform that has no table', async () => {
      // 'standalone' and 'kroger' ship with no selector table. The read path must
      // return {} rather than throw or wipe the other layers.
      for (const platform of ['standalone', 'kroger'] as const) {
        __resetAutomationConfigForTests();
        await loadAutomationConfig(async () => ({
          version: 2,
          config: { stores: { [STORE]: { platform, selectors: { atc: '.store-atc' } } } },
        }));
        const s = selectorsFor(STORE, { inc: '.fallback-inc' });
        expect(JSON.parse(s.atc)).toBe('.store-atc');
        expect(JSON.parse(s.inc)).toBe('.fallback-inc');
      }
    });

    it('an undeclared key is still an empty-string literal, not "undefined"', async () => {
      await loadAutomationConfig(async () => ({
        version: 2, config: { stores: { [STORE]: { platform: 'instacart' } } },
      }));
      expect(selectorsFor(STORE, {}).nobodyDeclaredThis).toBe('""');
    });
  });

  describe('config-declared platform vs the adapter\'s declaration', () => {
    it('config wins, matching every other override in this subsystem', async () => {
      await loadAutomationConfig(async () => ({
        version: 2,
        config: {
          platforms: { albertsons: { selectors: { marker: '.albertsons-table' } } },
          stores: { [STORE]: { platform: 'albertsons' } },
        },
      }));
      // The call site says 'instacart'; the config says 'albertsons'.
      expect(JSON.parse(selectorsFor(STORE, {}, 'instacart').marker)).toBe('.albertsons-table');
    });

    it('the adapter declaration is used when config names no platform', async () => {
      await loadAutomationConfig(async () => ({
        version: 2,
        config: {
          platforms: { instacart: { selectors: { marker: '.instacart-table' } } },
          stores: { [STORE]: { enabled: true } },
        },
      }));
      expect(JSON.parse(selectorsFor(STORE, {}, 'instacart').marker)).toBe('.instacart-table');
    });
  });
});

describe('rawSelectorsFor (platform layer, no escaping)', () => {
  const STORE = 'testbanner';

  it('applies the same precedence as selectorsFor', async () => {
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { a: '.platform-a', b: '.platform-b' } } },
        stores: { [STORE]: { platform: 'instacart', selectors: { b: '.store-b' } } },
      },
    }));
    const r = rawSelectorsFor(STORE, { a: '.fallback-a', b: '.fallback-b', c: '.fallback-c' });
    expect(r.a).toBe('.platform-a');   // platform beats fallback
    expect(r.b).toBe('.store-b');      // store beats platform
    expect(r.c).toBe('.fallback-c');   // fallback survives
    // RAW means no surrounding quotes — this is spliced into a literal the script
    // already owns.
    expect(r.a.startsWith('"')).toBe(false);
  });

  it('re-validates a PLATFORM value, dropping one that could break out', async () => {
    // rawSelectorsFor replaces escaping with re-validation. A platform value gets
    // the same treatment as a store value, and the developer-authored fallback —
    // which may legitimately contain double quotes — stands when it is dropped.
    await loadAutomationConfig(async () => ({
      version: 2,
      config: {
        platforms: { instacart: { selectors: { menu: "x') || alert(1) || ('" } } },
        stores: { [STORE]: { platform: 'instacart' } },
      },
    }));
    expect(rawSelectorsFor(STORE, { menu: '[role="dialog"]' })).toHaveProperty('menu', '[role="dialog"]');
  });

  it('drops a bundled platform selector containing a double quote, keeping the fallback', () => {
    // Why ALDI's emitted scripts did not change when its selectors moved to the
    // platform table: most bundled values contain double quotes, so they were
    // already being dropped here and supplied verbatim by the identical fallback.
    const bundledMenu = BUNDLED_AUTOMATION_CONFIG.platforms.instacart.selectors!.menu;
    expect(bundledMenu).toContain('"');
    expect(rawSelectorsFor('aldi', { menu: bundledMenu }, 'instacart').menu).toBe(bundledMenu);
  });

  it('yields an empty string for an undeclared key', async () => {
    await loadAutomationConfig(async () => ({
      version: 2, config: { stores: { [STORE]: { platform: 'instacart' } } },
    }));
    expect(rawSelectorsFor(STORE, {}).nobodyDeclaredThis).toBe('');
  });
});

describe('searchUrlFor', () => {
  it('uses the fallback when no template is configured', () => {
    expect(searchUrlFor('nostore', 'chicken', 'https://x.test/s?q=chicken'))
      .toBe('https://x.test/s?q=chicken');
  });

  it('substitutes {term}, URL-encoded', async () => {
    await loadAutomationConfig(async () => ({
      version: 2,
      config: { stores: { heb: { searchUrlTemplate: 'https://www.heb.com/find?query={term}' } } },
    }));
    expect(searchUrlFor('heb', 'chicken breast & rice', 'https://fallback.test'))
      .toBe('https://www.heb.com/find?query=chicken%20breast%20%26%20rice');
  });
});

describe('isStoreEnabled', () => {
  it('defaults to enabled for an unknown store', () => {
    expect(isStoreEnabled('nostore')).toBe(true);
  });

  it('honors an explicit remote kill switch', async () => {
    await loadAutomationConfig(async () => ({
      version: 2, config: { stores: { aldi: { enabled: false } } },
    }));
    expect(isStoreEnabled('aldi')).toBe(false);
    expect(isStoreEnabled('heb')).toBe(true);
  });
});

describe('storeConfig', () => {
  it('returns an empty object for an unknown store instead of undefined', () => {
    expect(storeConfig('nope')).toEqual({});
  });

  it('exposes remote worker knobs', async () => {
    await loadAutomationConfig(async () => ({
      version: 2, config: { stores: { heb: { workerCount: 5, workerStaggerMs: 250 } } },
    }));
    expect(storeConfig('heb').workerCount).toBe(5);
    expect(storeConfig('heb').workerStaggerMs).toBe(250);
  });
});
