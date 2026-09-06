// THE DISCOVER FILTERS ARE THE SERVER'S JOB NOW.
//
// The bug: every filter ran on the phone, over the meals already loaded, 20 at
// a time. So "vegetarian" meant "vegetarian among the ones we happen to be
// holding", and scrolling revealed more matches. Only `tags` was ever sent.
//
// Two halves have to hold, and only together do they mean the bug is fixed:
//
//   1. The filters go UP, asserted on the request in
//      tests/unit/preset-meal-list-params.test.ts.
//   2. The screen does NOT filter what comes back, which is this file. A screen
//      that still filtered locally would look correct on a small catalogue and
//      hide matches again the moment the server returned a page it disagreed
//      with.
//
// The second is the one worth a screen test, because it is invisible: a
// re-applied local filter agrees with the server almost always, and is wrong
// exactly when the two definitions have drifted.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

/** In-memory SecureStore. Deliberately shared: it is the "device". */
const mockStore = new Map<string, string>();
let mockGetFails = false;

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => {
    if (mockGetFails) throw new Error('keychain unavailable');
    return mockStore.get(k) ?? null;
  }),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, null, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const RealReact = jest.requireActual('react');
    RealReact.useEffect(() => cb(), []);
  },
  useNavigation: () => ({ getParent: () => null, navigate: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));

// Renders the name, unlike the null stub the other Discover suites use: this
// file is specifically about WHICH meals reach the list, so the card has to say
// which one it is.
jest.mock('../../src/components/MealCard', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return (props: any) => RealReact.createElement(RealText, null, props?.meal?.name ?? '');
});
jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/CreatorProfileSheet', () => () => null);
jest.mock('../../src/components/StoreSelectorSheet', () => () => null);
/**
 * A FilterSheet that can actually apply a filter.
 *
 * The other Discover suites stub this to null, which is fine when the filters
 * are scenery. Here they are the subject: with an empty filter set a screen
 * that still filtered locally would be indistinguishable from one that does
 * not, because a no-op filter drops nothing. The button is how a filter gets
 * SET, which is the only way to tell the two apart.
 */
jest.mock('../../src/components/FilterSheet', () => {
  const RealReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  const EMPTY = { tags: [], difficulty: [], sort: 'trending', authors: [], ingredients: [], excludeIngredients: [] };
  return {
    __esModule: true,
    default: ({ onApply }: any) =>
      RealReact.createElement(
        Text,
        { testID: 'apply-veg-filter', onPress: () => onApply({ ...EMPTY, tags: ['vegetarian'] }) },
        'apply',
      ),
    EMPTY_FILTERS: EMPTY,
  };
});

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', tier: 'paid' }, refreshUser: jest.fn() }),
}));
jest.mock('../../src/lib/api', () => ({
  presetMeals: {
    list: jest.fn(async () => ({ meals: [], hasMore: false, matched: 0 })),
    // The filter sheet's suggestions come from the server now, so a mock
    // without this makes DiscoverScreen throw on mount.
    facets: jest.fn(async () => ({ tags: [], authors: [] })),
  },
  creators: { featured: jest.fn(async () => []) },
  meals: { list: jest.fn(async () => []) },
}));


import DiscoverScreen from '../../src/screens/discover/DiscoverScreen';
import { presetMeals } from '../../src/lib/api';

const list = presetMeals.list as jest.Mock;

beforeEach(() => {
  mockStore.clear();
  mockGetFails = false;
  jest.clearAllMocks();
  list.mockResolvedValue({ meals: [], hasMore: false, matched: 0 });
});

/** The params of the most recent list() call. */
const lastParams = () => list.mock.calls[list.mock.calls.length - 1][0];

describe('what the screen asks the server for', () => {
  it('sends every filter, not only tags', async () => {
    render(<DiscoverScreen />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    const p = lastParams();
    // Present as keys even when empty, so a future filter cannot be forgotten
    // silently: the shape is the checklist.
    expect(p).toHaveProperty('tags');
    expect(p).toHaveProperty('difficulty');
    expect(p).toHaveProperty('authors');
    expect(p).toHaveProperty('ingredients');
    expect(p).toHaveProperty('excludeIngredients');
    expect(p).toHaveProperty('q');
  });
});

describe('applying a filter', () => {
  it('sends it to the server and refetches', async () => {
    const view = render(<DiscoverScreen />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    const before = list.mock.calls.length;

    await act(async () => { fireEvent.press(view.getByTestId('apply-veg-filter')); });

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
    expect(lastParams().tags).toEqual(['vegetarian']);
    // From offset 0. Keeping the old offset would page through a set that no
    // longer exists and show a hole where the first matches should be.
    expect(lastParams().offset).toBe(0);
  });

  it('does NOT filter the server answer again', async () => {
    // THE MUTANT THIS KILLS: re-applying the tag rule on the phone. The server
    // is the authority on what matched, and it can match for reasons the client
    // cannot see -- a tag synonym, a rule that shipped server-side first. So
    // this returns a meal the LOCAL rule would reject while a "vegetarian"
    // filter is active. It has to survive, because the server sent it.
    list.mockResolvedValue({
      meals: [{
        id: 'm1', name: 'Lentil dal', tags: ['plant-based'], difficulty: 1,
        ingredients: [{ ingredientName: 'Lentils' }], author: 'Priya', creatorName: 'Priya',
      }],
      hasMore: false,
      matched: 1,
    });
    const view = render(<DiscoverScreen />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => { fireEvent.press(view.getByTestId('apply-veg-filter')); });
    await waitFor(() => expect(lastParams().tags).toEqual(['vegetarian']));

    await waitFor(() => expect(view.queryByText(/Lentil dal/i)).toBeTruthy());
  });
});
