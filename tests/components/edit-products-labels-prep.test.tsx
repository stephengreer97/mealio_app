// TWO ROWS CALLED "ONION" ARE NOT THE SAME ROW (MEAL-102).
//
// The Products lists in MealDetailSheet label each row with the ingredient
// name, and that label's entire job is saying WHICH row you are looking at. A
// meal with "onion, finely diced" and "onion, sliced" drew two rows both
// reading "Onion", and in the editable list those two rows each have their own
// search-term input. Picking the wrong one is silent.
//
// The preparation is the only thing that tells them apart, so it belongs on the
// label. Asserted on both lists: the editable one and the read-only one beside
// it, because a label that means one thing in one list and another thing in the
// list below it is the drift this change exists to remove.
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (p: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...p }) };
});
jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (p: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, p.name);
  return { Feather: icon, Ionicons: icon };
});
jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
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
  meals: { update: jest.fn(async () => ({})), delete: jest.fn(), share: jest.fn() },
  images: { upload: jest.fn() },
}));

import MealDetailSheet from '../../src/components/MealDetailSheet';

/** Two onions that differ only by preparation, which is the whole point. */
const TWO_ONIONS = [
  { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: 'Yellow Onion', prep: 'finely diced' },
  { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: 'Sweet Onion', prep: 'sliced' },
];

const mealWith = (ingredients: unknown[]) => ({
  id: 'm1', name: 'Tacos', storeId: 'heb', store_id: 'heb',
  ingredients, tags: [], photoUrl: null,
});

function open(ingredients: unknown[], edit: boolean) {
  const r = render(
    <MealDetailSheet
      visible
      mode="edit"
      meal={mealWith(ingredients) as never}
      onClose={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  if (edit) fireEvent.press(r.getByText('Edit'));
  // Both Products lists start collapsed.
  // THE TWO LISTS DEFAULT DIFFERENTLY, and getting this backwards is how the
  // first version of this file failed against correct code: the editable list
  // starts EXPANDED (`useState(true)`) and the read-only one starts collapsed,
  // so pressing the toggle in edit mode COLLAPSED the rows this file is about
  // and every assertion looked at an empty section. The chevron was the tell.
  if (!edit) fireEvent.press(r.getByTestId('products-toggle'));
  return r;
}

describe('the editable Products list', () => {
  it('tells two same-named rows apart by their preparation', () => {
    const view = open(TWO_ONIONS, true);
    expect(view.queryAllByText('Onion, finely diced').length).toBeGreaterThan(0);
    expect(view.queryAllByText('Onion, sliced').length).toBeGreaterThan(0);
  });

  it('says just the name when there is no preparation', () => {
    // Most rows have none, and a trailing comma on every one of them would be
    // a worse bug than the one this fixes.
    const view = open([{ ingredientName: 'Tortillas', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: 'Corn Tortillas' }], true);
    expect(view.queryAllByText('Tortillas').length).toBeGreaterThan(0);
  });
});

describe('the read-only Products list', () => {
  it('names its rows the same way the editable list does', () => {
    // COUNTED, not merely found. Both lists are mounted at once here, so
    // `length > 0` would be satisfied by the editable one alone and this test
    // would pass with the read-only label still bare -- which is exactly what
    // it did on the first run, and the mutant that strips prep from this label
    // survived it.
    //
    // Two matches means both lists agree. One means they have drifted apart,
    // which is the whole thing being prevented.
    const view = open(TWO_ONIONS, false);
    expect(view.queryAllByText('Onion, finely diced')).toHaveLength(2);
    expect(view.queryAllByText('Onion, sliced')).toHaveLength(2);
  });
});
