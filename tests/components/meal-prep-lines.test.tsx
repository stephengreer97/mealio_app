// MEAL-102 — the measurement line reads the way the recipe wrote it.
//
// "1 onion, finely diced". The preparation trails the line, plain (not italic:
// the ticket's `*finely diced*` marked WHICH part is the prep, not how to style
// it — that question is Stephen's and is on his checklist), and a row with none
// reads exactly the string it read before the field existed.
//
// The meal sheet and the draft review queue are asserted together because they
// are the two screens a preparation is actually FOR: the sheet is where a cook
// reads the meal, and the queue is where a creator sees what we extracted from
// their own recipe — the screen the loss was reported from.

import { render } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  const icon = (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name);
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
  meals: { update: jest.fn(), delete: jest.fn(), share: jest.fn() },
  images: { upload: jest.fn() },
}));

import MealDetailSheet from '../../src/components/MealDetailSheet';

const mealWith = (ingredients: any[]) => ({
  id: 'm1',
  name: 'Chili',
  storeId: 'heb',
  store_id: 'heb',
  ingredients,
  tags: [],
  photoUrl: null,
});

function view(ingredients: any[]) {
  return render(
    <MealDetailSheet visible meal={mealWith(ingredients) as any} onClose={() => {}} />,
  );
}

describe('the meal sheet trails the preparation after the line', () => {
  it('prints it after the name and the amount', () => {
    const { getByText } = view([
      { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', searchTerm: null, prep: 'finely diced' },
    ]);
    expect(getByText('Onion, 1, finely diced')).toBeTruthy();
  });

  it('prints the line unchanged for a row with no preparation', () => {
    // The additive guarantee, on screen: this is character for character what
    // the sheet printed before MEAL-102.
    const { getByText } = view([
      { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', searchTerm: null },
    ]);
    expect(getByText('Onion, 1')).toBeTruthy();
  });

  it('prints a preparation on a line that has no amount at all', () => {
    // "salt to taste" arrives as a countable 1 and deliberately prints no
    // number. A preparation must not drag one back in.
    const { getByText } = view([
      { ingredientName: 'Salt', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: null, prep: 'to taste' },
    ]);
    expect(getByText('Salt, to taste')).toBeTruthy();
  });

  it('prints a preparation beside a measured unit', () => {
    const { getByText } = view([
      { ingredientName: 'Chickpeas', qty: 1, productQty: 1, unit: 'cans', measure: '1', searchTerm: null, prep: 'drained and rinsed' },
    ]);
    expect(getByText('Chickpeas, 1 can, drained and rinsed')).toBeTruthy();
  });

  it('renders a preparation containing commas as one phrase', () => {
    const { getByText } = view([
      { ingredientName: 'Chickpeas', qty: 1, productQty: 1, unit: 'cans', measure: '1', searchTerm: null, prep: 'drained, rinsed and patted dry' },
    ]);
    expect(getByText('Chickpeas, 1 can, drained, rinsed and patted dry')).toBeTruthy();
  });

  it('renders markup as literal text', () => {
    const { getByText } = view([
      { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', searchTerm: null, prep: '<b>finely</b> diced' },
    ]);
    expect(getByText('Onion, 1, <b>finely</b> diced')).toBeTruthy();
  });

  it('keeps the preparation out of the Products list, which shows search terms', () => {
    // That list prints `ingredientName` and `searchTerm` — the two strings the
    // cart's add gate compares. Nothing there may carry a preparation.
    const { queryAllByText } = view([
      { ingredientName: 'Onion', qty: 1, productQty: 1, unit: 'qty', measure: '1', searchTerm: 'H-E-B Yellow Onion', prep: 'finely diced' },
    ]);
    expect(queryAllByText(/H-E-B Yellow Onion, finely diced/)).toHaveLength(0);
    expect(queryAllByText(/diced onion/i)).toHaveLength(0);
  });
});
