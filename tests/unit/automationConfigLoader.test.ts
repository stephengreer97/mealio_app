import {
  loadAutomationConfig,
  getAutomationConfig,
  getConfigVersion,
  selectorsFor,
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
    expect(JSON.parse(s.atc)).toBe('.new-add-btn');                            // remote wins
    expect(JSON.parse(s.bubble))
      .toBe(BUNDLED_AUTOMATION_CONFIG.stores.albertsons.selectors!.bubble);    // schema wins
    expect(JSON.parse(s.novel)).toBe('.mine');                                 // only here
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
