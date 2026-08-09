// MEAL-23's acceptance criterion, asserted where the user would see it.
//
// The unit tests pin what getStores() returns. This one renders the actual
// picker, because "a new store appears in the app with no release" is a claim
// about a list on a screen, and because it is the only place useStores() — and
// therefore useSyncExternalStore — runs in the real Expo runtime. A snapshot
// whose identity changed on every read would loop forever here and nowhere else.
//
// The other half is the line this ticket draws: a catalog row for a store whose
// automation is not in this binary must not produce a picker row. Same as not
// existing, which is exactly what it is today.
//
// NOTE the picker is a FlatList, so only its first window is rendered. The
// assertions therefore use either an alphabetically early bundled store or the
// "Recent" section, which is pinned to the top — seeding recents is also the
// sharpest version of the negative test, since it is the one path that could
// otherwise slip an unsupported store past the filter.

import { render, waitFor, act } from '@testing-library/react-native';

const mockKeychain = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockKeychain.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockKeychain.delete(k); }),
}));

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../../src/lib/api', () => ({
  presetMeals: { save: jest.fn() },
  meals: { create: jest.fn() },
}));

import StoreSelectorSheet from '../../src/components/StoreSelectorSheet';
import { loadStoreCatalog, __resetStoreCatalogForTests } from '../../src/lib/store-catalog';
import { WEBVIEW_STORE_IDS } from '../../src/constants/stores';

const PUBLIX = { id: 'publix', name: 'Publix', color: '#008542' };
/** First store alphabetically, so it is always inside the FlatList's window. */
const FIRST_BUNDLED = 'Acme Markets';

const meal: any = { id: 'p1', name: 'Tacos', ingredients: [], photoUrl: null };

function renderPicker() {
  return render(<StoreSelectorSheet visible meal={meal} onClose={() => {}} />);
}

/** Pin a store to the top of the list, where it is always rendered. */
function seedRecent(id: string) {
  mockKeychain.set('recentStores', JSON.stringify([id]));
}

beforeEach(() => {
  mockKeychain.clear();
  __resetStoreCatalogForTests();
});
afterAll(() => __resetStoreCatalogForTests());

describe('the store picker', () => {
  it('opens on the bundled list with no network at all', async () => {
    // Nothing has been fetched and nothing is awaited — this is the cold-start,
    // aeroplane-mode case, and it must be a fully working picker.
    const r = renderPicker();
    await waitFor(() => expect(r.getByText(FIRST_BUNDLED)).toBeTruthy());
    expect(r.getByText('ALDI')).toBeTruthy();
    expect(r.queryByText('Publix')).toBeNull();
  });

  describe('when the catalog names a store this build can drive', () => {
    // Adding an id to WEBVIEW_STORE_IDS is exactly what the release that ships
    // an adapter does. Doing it here reproduces the real sequence: the code
    // lands in one release, and the store is switched on later by a database
    // row — with no second release.
    beforeEach(() => { WEBVIEW_STORE_IDS.add(PUBLIX.id); });
    afterEach(() => { WEBVIEW_STORE_IDS.delete(PUBLIX.id); });

    it('shows it', async () => {
      seedRecent(PUBLIX.id);
      await loadStoreCatalog(async () => ({ version: 3, stores: [PUBLIX] }));
      const r = renderPicker();
      await waitFor(() => expect(r.getByText('Publix')).toBeTruthy());
      expect(r.getByText(FIRST_BUNDLED)).toBeTruthy();   // and keeps the bundled ones
    });

    it('shows it even when it arrives while the picker is already open', async () => {
      // What subscribeStores/useStores buys: no waiting for an unrelated state
      // change to happen to repaint the list.
      seedRecent(PUBLIX.id);
      const r = renderPicker();
      await waitFor(() => expect(r.getByText(FIRST_BUNDLED)).toBeTruthy());
      expect(r.queryByText('Publix')).toBeNull();

      await act(async () => {
        await loadStoreCatalog(async () => ({ version: 3, stores: [PUBLIX] }));
      });
      await waitFor(() => expect(r.getByText('Publix')).toBeTruthy());
    });
  });

  it('does NOT show a store whose automation is not in this build', async () => {
    seedRecent(PUBLIX.id);
    await loadStoreCatalog(async () => ({ version: 3, stores: [PUBLIX] }));
    const r = renderPicker();
    await waitFor(() => expect(r.getByText(FIRST_BUNDLED)).toBeTruthy());
    expect(r.queryByText('Publix')).toBeNull();
  });

  it('keeps the bundled list when the payload is malformed', async () => {
    await loadStoreCatalog(async () => ({ version: 3, stores: 'not a list' }));
    const r = renderPicker();
    await waitFor(() => expect(r.getByText(FIRST_BUNDLED)).toBeTruthy());
    expect(r.getByText('ALDI')).toBeTruthy();
  });
});
