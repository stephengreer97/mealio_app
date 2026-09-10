// Switching feeds fast must not leave you on the old one.
//
// Stephen, 2026-09-09: "if I click following then back to trending very quick,
// it will show the following filter, and not switch back to trending."
//
// Tapping a segment starts a request and cancels nothing. Tap twice quickly and
// two are in flight; whichever RESOLVES last wins the list, and the network does
// not promise that is the one you asked for last. The header is state so it
// always said Trending; the list was whatever landed.
//
// The test therefore does the only thing that reproduces it: it holds both
// responses open and resolves them OUT OF ORDER, the older one last. A test that
// awaited each fetch in turn would pass against the bug.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
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

// The card renders the meal's name: this file is about WHICH meals are on
// screen, so the card has to say which one it is.
jest.mock('../../src/components/MealCard', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return (props: any) => RealReact.createElement(RealText, null, props?.meal?.name ?? '');
});
jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/CreatorProfileSheet', () => () => null);
jest.mock('../../src/components/FollowingListSheet', () => () => null);
jest.mock('../../src/components/StoreSelectorSheet', () => () => null);
jest.mock('../../src/components/FilterSheet', () => ({
  __esModule: true,
  default: () => null,
  EMPTY_FILTERS: { tags: [], difficulty: [], sort: 'trending', authors: [], ingredients: [], excludeIngredients: [] },
}));

jest.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', tier: 'paid' }, refreshUser: jest.fn() }),
}));

jest.mock('../../src/lib/api', () => ({
  presetMeals: { list: jest.fn(), facets: jest.fn(async () => ({ tags: [], authors: [] })) },
  creators: { featured: jest.fn(async () => []), following: jest.fn(async () => []) },
  meals: { list: jest.fn(async () => []) },
}));

import DiscoverScreen from '../../src/screens/discover/DiscoverScreen';
import { presetMeals } from '../../src/lib/api';

const list = presetMeals.list as jest.Mock;

/** A response held open until the test decides it lands. */
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const meal = (name: string) => ({
  id: name, name, tags: [], difficulty: 1, ingredients: [], author: 'A', creatorName: 'A',
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('switching feeds while a fetch is in flight', () => {
  it('shows the feed you ended on, not the one that answered last', async () => {
    const trendingFirst = deferred();
    const following = deferred();
    const trendingAgain = deferred();

    // Call 1 is the mount (Trending), 2 is Following, 3 is Trending again.
    list
      .mockReturnValueOnce(trendingFirst.promise)
      .mockReturnValueOnce(following.promise)
      .mockReturnValueOnce(trendingAgain.promise);

    const view = render(<DiscoverScreen />);
    await act(async () => {
      trendingFirst.resolve({ meals: [meal('Chicken Piccata')], hasMore: false, matched: 1 });
    });
    await waitFor(() => expect(view.getByText('Chicken Piccata')).toBeTruthy());

    // Following, then straight back to Trending, with nothing resolved between.
    await act(async () => { fireEvent.press(view.getByText('Following')); });
    await act(async () => { fireEvent.press(view.getByText('Trending')); });
    expect(list).toHaveBeenCalledTimes(3);

    // Trending answers first, Following after it: the out-of-order landing that
    // the phone actually produces when the first request is the slow one.
    await act(async () => {
      trendingAgain.resolve({ meals: [meal('Lamb Biryani')], hasMore: false, matched: 1 });
    });
    await act(async () => {
      following.resolve({ meals: [meal('A Followed Creator Meal')], hasMore: false, matched: 1 });
    });

    await waitFor(() => expect(view.getByText('Lamb Biryani')).toBeTruthy());
    expect(view.queryByText('A Followed Creator Meal')).toBeNull();
  });

  it('does not leave the spinner up when the stale answer lands last', async () => {
    const first = deferred();
    const following = deferred();
    const back = deferred();
    list
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(following.promise)
      .mockReturnValueOnce(back.promise);

    const view = render(<DiscoverScreen />);
    await act(async () => { first.resolve({ meals: [meal('Chicken Piccata')], hasMore: false, matched: 1 }); });
    await act(async () => { fireEvent.press(view.getByText('Following')); });
    await act(async () => { fireEvent.press(view.getByText('Trending')); });

    await act(async () => { back.resolve({ meals: [meal('Lamb Biryani')], hasMore: true, matched: 1 }); });
    await act(async () => { following.resolve({ meals: [], hasMore: false, matched: 0 }); });

    // The newest request clears the loading flags in its own finally; the stale
    // one must not clear them a second time NOR set hasMore back to false, which
    // would silently end pagination on a feed that has more pages.
    await waitFor(() => expect(view.getByText('Lamb Biryani')).toBeTruthy());
    expect(view.queryByText('No meals found')).toBeNull();
  });
});
