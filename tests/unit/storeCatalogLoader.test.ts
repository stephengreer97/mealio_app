import {
  loadStoreCatalog,
  getStores,
  getCatalogVersion,
  subscribeStores,
  __resetStoreCatalogForTests,
  CatalogCache,
} from '../../src/lib/store-catalog';
import {
  BUNDLED_STORES,
  WEBVIEW_STORE_IDS,
  isSupportedStore,
} from '../../src/constants/stores';

// The loader's rules, all inherited from src/lib/automation-config for the same
// reasons stated there:
//   1. The bundled list is live at module load. Nothing waits on the network, so
//      a cold start with no signal opens the picker instantly.
//   2. "Keep what you have" — an empty or absent response is not an instruction
//      to revert, and a version may not go backwards.
//   3. Failure is a non-event. Nothing here throws or rejects.
//
// And the one rule that is new to MEAL-23: the catalog can name a store this
// build has no code for, and such a store is FILTERED OUT of what getStores()
// returns — it behaves exactly as it does today, which is as not existing.

const fakeCache = (initial: { version: number; raw: unknown } | null = null) => {
  const state = { value: initial };
  const cache: CatalogCache = {
    read: jest.fn(async () => state.value),
    write: jest.fn(async (version: number, raw: unknown) => { state.value = { version, raw }; }),
  };
  return { cache, state };
};

const ids = () => getStores().map((s) => s.id);
const byId = (id: string) => getStores().find((s) => s.id === id);

beforeEach(() => __resetStoreCatalogForTests());
afterAll(() => __resetStoreCatalogForTests());

describe('before anything is fetched', () => {
  it('serves the bundled list at version 0', () => {
    expect(getCatalogVersion()).toBe(0);
    expect(getStores()).toEqual(BUNDLED_STORES);
  });

  it('every bundled store is one this build can actually drive', () => {
    // The property that makes shipping MEAL-23 a no-op for today's users: the
    // capability filter removes nothing from the list that already ships. It is
    // also what lets MyMealsScreen index stores[0] without a guard.
    for (const store of BUNDLED_STORES) {
      expect([store.id, isSupportedStore(store.id)]).toEqual([store.id, true]);
    }
    expect(getStores().length).toBe(BUNDLED_STORES.length);
    expect(getStores().length).toBeGreaterThan(0);
  });

  it('returns the same array identity on repeated reads', () => {
    // Not an optimisation: useStores() feeds this to useSyncExternalStore, which
    // compares snapshots by identity and would re-render forever otherwise.
    expect(getStores()).toBe(getStores());
  });
});

describe('a published catalog', () => {
  it('relabels a store without a release', async () => {
    const { cache } = fakeCache();
    await loadStoreCatalog(async () => ({ version: 5, stores: [{ id: 'heb', name: 'H-E-B Plus!', color: '#dd0031' }] }), cache);
    expect(getCatalogVersion()).toBe(5);
    expect(byId('heb')!.name).toBe('H-E-B Plus!');
  });

  it('persists the RAW payload, not the merged result', async () => {
    // A future build with a different bundled list — or with automation for a
    // store this one has to filter out — must re-merge against its own baseline.
    const { cache, state } = fakeCache();
    const raw = [{ id: 'heb', name: 'H-E-B Plus!', color: '#dd0031' }];
    await loadStoreCatalog(async () => ({ version: 5, stores: raw }), cache);
    expect(cache.write).toHaveBeenCalledWith(5, raw);
    expect(state.value!.raw).toEqual(raw);
  });

  it('hydrates from cache first, then lets the server win', async () => {
    const { cache } = fakeCache({ version: 4, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => ({ version: 6, stores: [{ id: 'heb', name: 'Fresh', color: '#dd0031' }] }), cache);
    expect(getCatalogVersion()).toBe(6);
    expect(byId('heb')!.name).toBe('Fresh');
  });

  it('notifies subscribers so an on-screen picker repaints', async () => {
    const listener = jest.fn();
    subscribeStores(listener);
    await loadStoreCatalog(async () => ({ version: 2, stores: [{ id: 'heb', name: 'H-E-B Plus!', color: '#dd0031' }] }));
    expect(listener).toHaveBeenCalled();
    // ...and the snapshot identity changed, or the repaint would be a no-op.
    expect(getStores()).not.toEqual(BUNDLED_STORES);
  });
});

describe('the network is never allowed to matter', () => {
  it('keeps the bundled list when the fetch returns nothing', async () => {
    await loadStoreCatalog(async () => null);
    expect(getStores()).toEqual(BUNDLED_STORES);
    expect(getCatalogVersion()).toBe(0);
  });

  it('keeps the bundled list when the fetch throws — and does not reject', async () => {
    await expect(loadStoreCatalog(async () => { throw new Error('offline'); })).resolves.toBeUndefined();
    expect(getStores()).toEqual(BUNDLED_STORES);
  });

  it('keeps the CACHED catalog when the fetch fails', async () => {
    // The real failure this insures against: a user boots on a plane having
    // saved a meal at a store that was published after their app was installed.
    const { cache } = fakeCache({ version: 4, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => { throw new Error('offline'); }, cache);
    expect(getCatalogVersion()).toBe(4);
    expect(byId('heb')!.name).toBe('Cached');
  });

  it('survives a cache read that throws', async () => {
    const cache: CatalogCache = {
      read: jest.fn(async () => { throw new Error('keychain locked'); }),
      write: jest.fn(async () => {}),
    };
    await loadStoreCatalog(async () => ({ version: 2, stores: [{ id: 'heb', name: 'Fresh', color: '#dd0031' }] }), cache);
    expect(getCatalogVersion()).toBe(2);
  });

  it('works with no cache at all (memory-only)', async () => {
    await loadStoreCatalog(async () => ({ version: 3, stores: [{ id: 'heb', name: 'Fresh', color: '#dd0031' }] }));
    expect(getCatalogVersion()).toBe(3);
  });
});

describe('the "keep what you have" rule', () => {
  it('does not revert to bundled on an EMPTY list', async () => {
    const { cache } = fakeCache({ version: 4, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => ({ version: 9, stores: [] }), cache);
    expect(byId('heb')!.name).toBe('Cached');
    expect(getCatalogVersion()).toBe(4);
  });

  it('does not revert on a null payload', async () => {
    const { cache } = fakeCache({ version: 4, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => ({ version: 9, stores: null }), cache);
    expect(byId('heb')!.name).toBe('Cached');
  });

  it('refuses to go BACKWARDS in version', async () => {
    // Happens when a rollback is in flight or a CDN serves a stale body.
    const { cache } = fakeCache({ version: 9, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => ({ version: 7, stores: [{ id: 'heb', name: 'Stale', color: '#dd0031' }] }), cache);
    expect(getCatalogVersion()).toBe(9);
    expect(byId('heb')!.name).toBe('Cached');
  });

  it('does not persist a payload it declined to apply', async () => {
    const { cache } = fakeCache({ version: 9, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => ({ version: 7, stores: [{ id: 'heb', name: 'Stale', color: '#dd0031' }] }), cache);
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('re-applies the same version idempotently', async () => {
    const { cache } = fakeCache({ version: 5, raw: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] });
    await loadStoreCatalog(async () => ({ version: 5, stores: [{ id: 'heb', name: 'Cached', color: '#dd0031' }] }), cache);
    expect(getCatalogVersion()).toBe(5);
    expect(byId('heb')!.name).toBe('Cached');
  });
});

describe('a malformed payload', () => {
  it('leaves the bundled list intact', async () => {
    for (const junk of [{ nope: true }, 'stores', 42]) {
      __resetStoreCatalogForTests();
      await loadStoreCatalog(async () => ({ version: 3, stores: junk }));
      expect(getStores()).toEqual(BUNDLED_STORES);
      // Nothing applied, so the version stays at 0 and the next good push
      // (whatever its number) is not blocked by this one.
      expect(getCatalogVersion()).toBe(0);
    }
  });

  it('lets the good rows of a partly-bad payload through', async () => {
    await loadStoreCatalog(async () => ({
      version: 3,
      stores: [null, { id: 'heb', name: 'H-E-B Plus!', color: '#dd0031' }, { name: 'no id' }],
    }));
    expect(byId('heb')!.name).toBe('H-E-B Plus!');
    expect(ids()).toHaveLength(BUNDLED_STORES.length);
  });
});

// ── The capability line ──────────────────────────────────────────────────────
//
// Until MEAL-23, every catalog entry sat in exactly one capability set and
// neither set had an orphan. This is the first code that can break that, on
// purpose: the server can name a store whose automation scripts are not in this
// binary. There is no existing case to observe, so both sides are pinned here.
describe('a store this build has no code for', () => {
  const NO_CODE = { id: 'publix', name: 'Publix', color: '#008542' };

  it('does not reach the picker', async () => {
    await loadStoreCatalog(async () => ({ version: 3, stores: [NO_CODE] }));
    expect(byId('publix')).toBeUndefined();
    expect(ids()).toEqual(BUNDLED_STORES.map((s) => s.id));
  });

  it('is invisible rather than half-present — nothing to badge or explain', async () => {
    // The decided behaviour: same as not existing, which is exactly what it is
    // today. A picker row that dead-ends at getStoreScripts() === null would be
    // strictly worse, and per MEAL-31 hands the worker pools undefined builders.
    await loadStoreCatalog(async () => ({ version: 3, stores: [NO_CODE] }));
    expect(getStores().every((s) => isSupportedStore(s.id))).toBe(true);
  });

  it('still applies the rest of the same push', async () => {
    // One unsupported row must not cost the supported ones beside it.
    await loadStoreCatalog(async () => ({
      version: 3,
      stores: [NO_CODE, { id: 'heb', name: 'H-E-B Plus!', color: '#dd0031' }],
    }));
    expect(byId('publix')).toBeUndefined();
    expect(byId('heb')!.name).toBe('H-E-B Plus!');
  });
});

describe('a store this build DOES have code for', () => {
  // Every capable store is already bundled in this build, so there is no id that
  // exercises "new AND supported" as it ships. Adding one to WEBVIEW_STORE_IDS
  // is precisely what the release that adds an adapter does, so doing it here
  // reproduces the real acceptance path: the code lands in one release, and the
  // store is switched on later by a database row, with no second release.
  const NEW_STORE = { id: 'publix', name: 'Publix', color: '#008542' };

  beforeEach(() => { WEBVIEW_STORE_IDS.add(NEW_STORE.id); });
  afterEach(() => { WEBVIEW_STORE_IDS.delete(NEW_STORE.id); });

  it('appears with no release once the catalog names it', async () => {
    await loadStoreCatalog(async () => ({ version: 3, stores: [NEW_STORE] }));
    expect(byId('publix')).toEqual(NEW_STORE);
    expect(ids()).toHaveLength(BUNDLED_STORES.length + 1);
  });

  it('survives a restart offline, from the cache', async () => {
    const { cache, state } = fakeCache();
    await loadStoreCatalog(async () => ({ version: 3, stores: [NEW_STORE] }), cache);
    expect(byId('publix')).toBeDefined();

    // Cold start, no network: only the cache answers.
    __resetStoreCatalogForTests();
    expect(byId('publix')).toBeUndefined();
    await loadStoreCatalog(async () => { throw new Error('offline'); }, {
      read: async () => state.value,
      write: cache.write,
    });
    expect(byId('publix')).toEqual(NEW_STORE);
  });

  it('arrives with the neutral colour rather than not at all when the colour is bad', async () => {
    await loadStoreCatalog(async () => ({ version: 3, stores: [{ ...NEW_STORE, color: 'green' }] }));
    expect(byId('publix')!.name).toBe('Publix');
  });
});
