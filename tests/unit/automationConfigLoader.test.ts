import {
  loadAutomationConfig,
  getAutomationConfig,
  getConfigVersion,
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

    it('refuses a served version 0 rather than exempting it from the ordering', async () => {
      // Found in MEAL-23's copy of this clause and fixed in both files, which
      // must stay identical. The guard was `version > 0 && version < currentVersion`,
      // which EXEMPTED 0 from the ordering rather than refusing it: a served v0
      // overwrote a cached v9, reset the version to 0, and got persisted —
      // leaving no rollback protection until the next positive version, on the
      // config that carries the store selectors and the kill switches.
      const { cache } = fakeCache({ version: 9, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 0, config: { timeouts: { addMs: 33_000 } } }), cache);
      expect(getConfigVersion()).toBe(9);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
      expect(cache.write).not.toHaveBeenCalled();
    });

    it('refuses a negative version too', async () => {
      const { cache } = fakeCache({ version: 9, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: -1, config: { timeouts: { addMs: 33_000 } } }), cache);
      expect(getConfigVersion()).toBe(9);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
    });

    it('a version 0 does not apply even from a cold start', async () => {
      await loadAutomationConfig(async () => ({ version: 0, config: { timeouts: { addMs: 33_000 } } }));
      expect(getConfigVersion()).toBe(0);
      expect(getAutomationConfig()).toEqual(BUNDLED_AUTOMATION_CONFIG);
    });

    it('re-applies the same version idempotently', async () => {
      const { cache } = fakeCache({ version: 5, raw: { timeouts: { addMs: 11_000 } } });
      await loadAutomationConfig(async () => ({ version: 5, config: { timeouts: { addMs: 11_000 } } }), cache);
      expect(getConfigVersion()).toBe(5);
      expect(getAutomationConfig().timeouts.addMs).toBe(11_000);
      // The line this asserts is `version < currentVersion`. Without this, mutating
    // it to `<=` — refusing the server's copy of a version already applied from
    // cache — passes, because the cached apply already installed identical content
    // and nothing above notices which of the two put it there. Asserting the write
    // happened is what distinguishes "re-applied" from "silently declined".
    expect(cache.write).toHaveBeenCalled();
  });
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
