// The tag chips under the search box.
//
// A row of 15 taggable ways to start browsing, multi-select, ANY-OF. The
// any-of part is not a preference: a meal carries at most MAX_MEAL_TAGS tags,
// so an all-of row would ask for two of a meal's three on the second tap and
// for something impossible on the third. It is also what `?tags=` has always
// meant on the server, which is why these write into the same `filters.tags`
// the filter sheet does instead of holding a selection of their own.
//
// What the tests hold: the tags go UP (one request, both tags), the row does
// not offer a tag the catalogue has no meals for, and the chips and the filter
// sheet cannot disagree about what is selected.

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
jest.mock('../../src/components/FollowingListSheet', () => () => null);
jest.mock('../../src/components/StoreSelectorSheet', () => () => null);

// A filter sheet that can apply a tag, so "the chips and the sheet share one
// selection" is testable from the sheet's side too.
jest.mock('../../src/components/FilterSheet', () => {
  const RealReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  const EMPTY = { tags: [], difficulty: [], sort: 'trending', authors: [], ingredients: [], excludeIngredients: [] };
  return {
    __esModule: true,
    default: ({ onApply }: any) =>
      RealReact.createElement(
        Text,
        { testID: 'apply-dessert-in-sheet', onPress: () => onApply({ ...EMPTY, tags: ['Dessert'] }) },
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
    facets: jest.fn(async () => ({ tags: [], authors: [] })),
  },
  creators: { featured: jest.fn(async () => []), following: jest.fn(async () => []) },
  meals: { list: jest.fn(async () => []) },
}));

import DiscoverScreen from '../../src/screens/discover/DiscoverScreen';
import { presetMeals } from '../../src/lib/api';
import { POPULAR_TAGS, DISCOVER_TAG_CHIPS } from '../../src/constants/tags';

const list = presetMeals.list as jest.Mock;
const facets = presetMeals.facets as jest.Mock;

/** The tags of the most recent list() call. */
const lastTags = () => list.mock.calls[list.mock.calls.length - 1][0].tags;

beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue({ meals: [], hasMore: false, matched: 0 });
  facets.mockResolvedValue({ tags: [], authors: [] });
});

async function open() {
  const view = render(<DiscoverScreen />);
  await waitFor(() => expect(view.getByTestId('tag-chip-row')).toBeTruthy());
  return view;
}

describe('which tags get a chip', () => {
  it('shows fifteen while the catalogue is unknown, in the curated order', async () => {
    const view = await open();
    for (const tag of POPULAR_TAGS.slice(0, DISCOVER_TAG_CHIPS)) {
      expect(view.getByTestId(`tag-chip-${tag}`)).toBeTruthy();
    }
    // The sixteenth candidate is not on screen, so the row has a bound.
    expect(view.queryByTestId(`tag-chip-${POPULAR_TAGS[DISCOVER_TAG_CHIPS]}`)).toBeNull();
  });

  it('drops a tag no meal carries, rather than offering an empty search', async () => {
    facets.mockResolvedValue({ tags: ['Dinner', 'Dessert'], authors: [] });
    const view = await open();
    await waitFor(() => expect(view.getByTestId('tag-chip-Dinner')).toBeTruthy());
    expect(view.getByTestId('tag-chip-Dessert')).toBeTruthy();
    expect(view.queryByTestId('tag-chip-Vegan')).toBeNull();
  });

  it('matches the catalogue case-insensitively, because tags are free text on the way in', async () => {
    facets.mockResolvedValue({ tags: ['dinner'], authors: [] });
    const view = await open();
    await waitFor(() => expect(view.getByTestId('tag-chip-Dinner')).toBeTruthy());
  });
});

describe('tapping chips', () => {
  it('sends the tag to the server', async () => {
    const view = await open();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Dinner')); });
    await waitFor(() => expect(lastTags()).toEqual(['Dinner']));
  });

  it('sends both when two are chosen: one request, any-of', async () => {
    const view = await open();
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Dinner')); });
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Breakfast')); });
    await waitFor(() => expect(lastTags()).toEqual(['Dinner', 'Breakfast']));
  });

  it('unselects on a second tap', async () => {
    const view = await open();
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Dinner')); });
    await waitFor(() => expect(lastTags()).toEqual(['Dinner']));
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Dinner')); });
    await waitFor(() => expect(lastTags()).toEqual([]));
  });

  it('reads as selected to a screen reader', async () => {
    const view = await open();
    expect(view.getByTestId('tag-chip-Dinner').props.accessibilityState.selected).toBe(false);
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Dinner')); });
    await waitFor(() =>
      expect(view.getByTestId('tag-chip-Dinner').props.accessibilityState.selected).toBe(true));
  });

  it('refetches from the first page, not from where the old set was scrolled to', async () => {
    const view = await open();
    await act(async () => { fireEvent.press(view.getByTestId('tag-chip-Dinner')); });
    await waitFor(() => expect(lastTags()).toEqual(['Dinner']));
    expect(list.mock.calls[list.mock.calls.length - 1][0].offset).toBe(0);
  });
});

describe('one selection, two places to make it', () => {
  it('shows a tag chosen in the filter sheet as a chosen chip', async () => {
    const view = await open();
    await act(async () => { fireEvent.press(view.getByTestId('apply-dessert-in-sheet')); });
    await waitFor(() =>
      expect(view.getByTestId('tag-chip-Dessert').props.accessibilityState.selected).toBe(true));
  });
});
