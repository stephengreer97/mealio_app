// Finding your store in the picker (MEAL-229).
//
// Forty stores in one alphabetical list: reaching Wegmans took 18 scrolls, and
// the first five rows are Acme, Baker's, Balducci's, Carrs and City Market,
// which is nobody's store. The list was sorted correctly and shaped wrong.
//
// The matcher itself is covered in tests/unit/store-search.test.ts. What these
// hold is the part only the screen can be wrong about: that typing filters the
// rows, that the browse shape (Recent / All Stores) gets out of the way while
// searching, that clearing brings it back, and that no result says so instead of
// showing an empty sheet.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

// A note on which store each case asserts: FlatList renders a window, not the
// whole list, so a name far down the alphabet can be absent because it has not
// been rendered yet rather than because the filter dropped it. Every assertion
// below is on a row that falls inside the first window in BOTH states, which is
// what makes the absences mean something.

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => JSON.stringify(['wegmans'])),
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

jest.mock('../../src/lib/api', () => ({
  presetMeals: { save: jest.fn(async () => {}) },
  meals: { create: jest.fn(async () => ({ id: 'm1' })) },
}));

// The real catalogue, so the cases are the real names.
jest.mock('../../src/lib/store-catalog/useStores', () => ({
  useStores: () => jest.requireActual('../../src/constants/stores').BUNDLED_STORES,
}));

import StoreSelectorSheet from '../../src/components/StoreSelectorSheet';

const meal = { id: 'p1', name: 'Garlic butter shrimp', ingredients: [] } as never;

function open() {
  return render(<StoreSelectorSheet visible meal={meal} onClose={jest.fn()} />);
}

describe('the store picker search box', () => {
  it('filters the list as you type', async () => {
    const view = open();
    await waitFor(() => expect(view.getByText('Acme Markets')).toBeTruthy());

    fireEvent.changeText(view.getByTestId('store-search'), 'wegmans');

    await waitFor(() => expect(view.queryByText('Acme Markets')).toBeNull());
    expect(view.getByText('Wegmans')).toBeTruthy();
  });

  it('finds a banner by the chain that owns it', async () => {
    const view = open();
    await waitFor(() => expect(view.getByText('Acme Markets')).toBeTruthy());

    fireEvent.changeText(view.getByTestId('store-search'), 'kroger');

    // Baker's is a Kroger banner and its name says nothing about Kroger, so it
    // can only be here through the family alias. Acme is an Albertsons banner
    // and was the first row a moment ago, so its absence is the filter working.
    await waitFor(() => expect(view.getByText("Baker's")).toBeTruthy());
    expect(view.getByText('Kroger')).toBeTruthy();
    expect(view.queryByText('Acme Markets')).toBeNull();
  });

  it('drops the Recent and All Stores headings while searching', async () => {
    // Two headings over four results read as two lists when the user is looking
    // at one answer.
    const view = open();
    await waitFor(() => expect(view.getByText('Recent')).toBeTruthy());

    fireEvent.changeText(view.getByTestId('store-search'), 'kroger');

    await waitFor(() => expect(view.queryByText('Recent')).toBeNull());
    expect(view.queryByText('All Stores')).toBeNull();
  });

  it('says so when nothing matches, rather than showing an empty sheet', async () => {
    const view = open();
    fireEvent.changeText(view.getByTestId('store-search'), 'zzzz');
    await waitFor(() => expect(view.getByTestId('store-search-empty')).toBeTruthy());
  });

  it('brings the whole list back when the search is cleared', async () => {
    const view = open();
    await waitFor(() => expect(view.getByText('Acme Markets')).toBeTruthy());

    fireEvent.changeText(view.getByTestId('store-search'), 'wegmans');
    await waitFor(() => expect(view.queryByText('Acme Markets')).toBeNull());

    fireEvent.press(view.getByTestId('store-search-clear'));

    await waitFor(() => expect(view.getByText('Acme Markets')).toBeTruthy());
    expect(view.getByText('Recent')).toBeTruthy();
  });

  it('offers no clear button until there is something to clear', () => {
    const view = open();
    expect(view.queryByTestId('store-search-clear')).toBeNull();
  });

  it('still lets a filtered store be selected', async () => {
    // The row has to stay tappable through the keyboard being up, which is what
    // keyboardShouldPersistTaps is for: a first tap that only dismisses the
    // keyboard reads as the picker ignoring you.
    const view = open();
    fireEvent.changeText(view.getByTestId('store-search'), 'ralphs');
    await waitFor(() => expect(view.getByText('Ralphs')).toBeTruthy());
    fireEvent.press(view.getByText('Ralphs'));
    await waitFor(() => expect(view.getByText('✓')).toBeTruthy());
  });
});
