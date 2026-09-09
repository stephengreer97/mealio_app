// Who you follow, on the tab made of their meals.
//
// The followed list lived on the Account screen only, which is a tab and two
// scrolls away from the feed it explains. Stephen, 2026-09-09: "easier way to
// see who you're following on discover tab instead of having followers in
// account page."
//
// What these hold: the strip appears on Following and NOT on the other feeds
// (where it would be a second row of round faces under the featured one), it
// opens the creator it names by fetching them rather than passing the three
// fields the list carries, and the empty case says how to fill it instead of
// "No meals found", which is true but useless when you follow nobody.

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

jest.mock('../../src/components/MealCard', () => () => null);
jest.mock('../../src/components/MealDetailSheet', () => () => null);
jest.mock('../../src/components/CreatorProfileSheet', () => () => null);
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
  presetMeals: {
    list: jest.fn(async () => ({ meals: [], hasMore: false, matched: 0 })),
    facets: jest.fn(async () => ({ tags: [], authors: [] })),
  },
  creators: {
    featured: jest.fn(async () => [{ id: 'feat1', displayName: 'Featured Cook', photoUrl: null }]),
    following: jest.fn(async () => [{ id: 'c1', displayName: 'Sarah Lane', photoUrl: null }]),
    getById: jest.fn(async () => ({
      creator: { id: 'c1', displayName: 'Sarah Lane', photoUrl: null, followers: 12 },
      meals: [],
    })),
  },
  meals: { list: jest.fn(async () => []) },
}));

import DiscoverScreen from '../../src/screens/discover/DiscoverScreen';
import { creators } from '../../src/lib/api';

const following = creators.following as jest.Mock;
const getById = creators.getById as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  following.mockResolvedValue([{ id: 'c1', displayName: 'Sarah Lane', photoUrl: null }]);
  (creators.featured as jest.Mock).mockResolvedValue([
    { id: 'feat1', displayName: 'Featured Cook', photoUrl: null },
  ]);
  getById.mockResolvedValue({
    creator: { id: 'c1', displayName: 'Sarah Lane', photoUrl: null, followers: 12 },
    meals: [],
  });
});

/** Renders Discover and switches to the Following feed. */
async function openFollowing() {
  const view = render(<DiscoverScreen />);
  await waitFor(() => expect(view.getByText('Featured Creators')).toBeTruthy());
  await act(async () => { fireEvent.press(view.getByText('Following')); });
  return view;
}

describe('the Following feed', () => {
  it('shows the creators you follow', async () => {
    const view = await openFollowing();
    await waitFor(() => expect(view.getByText('Creators You Follow')).toBeTruthy());
    expect(view.getByTestId('following-creator-c1')).toBeTruthy();
    expect(view.getByText('Sarah Lane')).toBeTruthy();
  });

  it('stands in for the featured strip rather than stacking under it', async () => {
    const view = await openFollowing();
    await waitFor(() => expect(view.getByText('Creators You Follow')).toBeTruthy());
    expect(view.queryByText('Featured Creators')).toBeNull();
  });

  it('opens a followed creator by fetching them, not from the list row', async () => {
    // The row carries a name and a photo. The profile shows a bio and a
    // follower count, so opening on the row would show a creator with no bio
    // and no followers.
    const view = await openFollowing();
    await waitFor(() => expect(view.getByTestId('following-creator-c1')).toBeTruthy());
    await act(async () => { fireEvent.press(view.getByTestId('following-creator-c1')); });
    expect(getById).toHaveBeenCalledWith('c1');
  });

  it('says how to fill the feed when you follow nobody', async () => {
    following.mockResolvedValue([]);
    const view = await openFollowing();
    await waitFor(() => expect(view.getByText(/not following anyone yet/)).toBeTruthy());
    expect(view.queryByText('No meals found')).toBeNull();
    expect(view.queryByText('Creators You Follow')).toBeNull();
  });

  it('re-reads the list on every entry, because following changes in the app', async () => {
    const view = await openFollowing();
    await waitFor(() => expect(following).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.press(view.getByText('Trending')); });
    await act(async () => { fireEvent.press(view.getByText('Following')); });
    await waitFor(() => expect(following).toHaveBeenCalledTimes(2));
  });
});

describe('the other feeds', () => {
  it('do not show the followed strip', async () => {
    const view = render(<DiscoverScreen />);
    await waitFor(() => expect(view.getByText('Featured Creators')).toBeTruthy());
    expect(view.queryByText('Creators You Follow')).toBeNull();
    expect(view.queryByTestId('following-creator-c1')).toBeNull();
  });
});
