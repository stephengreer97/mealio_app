// MEAL-164, at the level that actually ships.
//
// `ingredient-editor-preserves-fields.test.tsx` drives `IngredientEditor` alone.
// That proves the component, and says nothing about whether the feature reaches
// it — which is the exact gap that let the original defect live: the editor is
// not used alone anywhere. `MealDetailSheet` renders it AND a "Products" section
// against the same `ingredients` state, and both write.
//
// So this file drives the real screen and reads what `PUT /api/meals/[id]`
// receives. Three scenarios, measured against `origin/main` by a cold review:
//
//   rename a row, save                        main: all three fields deleted
//   step the weight, rename a row, save       main: all three deleted
//   clear the product, rename a row, save     main: all three deleted AND the
//                                             cleared searchTerm resurrected
//
// The third is the one worth having a test for. Resurrecting a product the user
// just cleared is not a lost setting — `WebViewCartSheet` auto-adds a row that
// has a `searchTerm` without prompting, so it is a silent add of a product the
// user removed, at a weight they did not confirm. That is both governing
// principles at once.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    Feather: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
    Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
  };
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
  meals: {
    update: jest.fn(async (_id: string, body: any) => ({ id: 'm1', ...body })),
    delete: jest.fn(),
    share: jest.fn(),
  },
  images: { upload: jest.fn() },
}));

import MealDetailSheet from '../../src/components/MealDetailSheet';
import { meals as mealsApi } from '../../src/lib/api';
import type { Ingredient } from '../../src/types';

const update = mealsApi.update as unknown as jest.Mock;

/** A sold-by-weight row a shopper has chosen a product and a weight for. */
const deliTurkey = (): Ingredient => ({
  ingredientName: 'Turkey Breast',
  qty: 1,
  unit: 'lb',
  measure: '1',
  searchTerm: 'H-E-B Deli Oven Roasted Turkey Breast',
  productQty: 1,
  purchaseWeight: 1.5,
  weightStep: 0.25,
  dropdown: { type: 'preference', selectedText: 'Thin sliced', selectedValue: 'thin' },
  // The store's own identifier for the chosen product (MEAL-19).
  storeProducts: { kroger: { upc: '0001111041700', name: 'Kroger Oven Roasted Turkey Breast' } },
});

const salt = (): Ingredient => ({
  ingredientName: 'Salt',
  qty: 1,
  unit: 'qty',
  measure: null,
  searchTerm: null,
  productQty: 1,
});

const meal = (ingredients: Ingredient[]) => ({
  id: 'm1',
  name: 'Sandwiches',
  storeId: 'heb',
  store_id: 'heb',
  ingredients,
  tags: [],
  photoUrl: null,
});

function openEditor(ingredients: Ingredient[]) {
  const r = render(
    <MealDetailSheet
      visible
      mode="edit"
      meal={meal(ingredients) as never}
      onClose={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  fireEvent.press(r.getByText('Edit'));
  return r;
}

/** What `PUT /api/meals/[id]` was handed. */
async function savedIngredients(r: ReturnType<typeof openEditor>): Promise<Ingredient[]> {
  fireEvent.press(r.getByText('Save Changes'));
  await waitFor(() => expect(update).toHaveBeenCalled());
  return update.mock.calls[update.mock.calls.length - 1][1].ingredients as Ingredient[];
}

beforeEach(() => update.mockClear());

describe('the meal edit screen keeps what the shopper chose', () => {
  it('keeps a chosen weight when an unrelated row is renamed', async () => {
    const r = openEditor([salt(), deliTurkey()]);
    fireEvent.changeText(r.getAllByPlaceholderText('Ingredient name')[0], 'Sea salt');

    const saved = await savedIngredients(r);
    expect(saved[0].ingredientName).toBe('Sea salt');
    expect(saved[1].purchaseWeight).toBe(1.5);
    expect(saved[1].weightStep).toBe(0.25);
    expect(saved[1].dropdown).toBeTruthy();
  });

  it('does not resurrect a product cleared in the Products section', async () => {
    // The scenario `origin/main` failed worst. The X button in Products clears
    // the chosen product; the editor then rewrites the whole array on the next
    // keystroke. Before the fix, that put the product AND its weight back.
    const r = openEditor([salt(), deliTurkey()]);

    // Products lists every row that has a NAME (not every row with a chosen
    // product), so both rows are there and there is one clear button each, in
    // the order the ingredients were given. The turkey is second.
    //
    // Pressing the wrong one is not a silent failure: it would clear salt's
    // already-null product and leave the turkey's set, which the assertion below
    // catches.
    const clears = r.getAllByText('x');
    expect(clears).toHaveLength(2);
    fireEvent.press(clears[1]);
    fireEvent.changeText(r.getAllByPlaceholderText('Ingredient name')[0], 'Sea salt');

    const saved = await savedIngredients(r);
    const turkey = saved.find((i) => i.ingredientName === 'Turkey Breast')!;
    expect(turkey.searchTerm).toBeNull();
    expect('purchaseWeight' in turkey).toBe(false);
    expect('weightStep' in turkey).toBe(false);
    expect('dropdown' in turkey).toBe(false);
    expect('storeProducts' in turkey).toBe(false);
  });

  it('clears the store’s product id on the X alone, with no keystroke after it', async () => {
    // The case the editor's rebuild cannot cover, because it never runs: press
    // X and save. `fromFormIng` is what drops the product-bound fields, and it
    // only runs on a keystroke, so the X has to clear this itself.
    //
    // It matters more here than for the other three. A left-behind weight
    // biases the next add; a left-behind identifier RESOLVES, so the product
    // the shopper just removed goes into the cart on the next run without
    // anybody choosing it (MEAL-19).
    const r = openEditor([salt(), deliTurkey()]);

    fireEvent.press(r.getAllByText('x')[1]);

    const saved = await savedIngredients(r);
    const turkey = saved.find((i) => i.ingredientName === 'Turkey Breast')!;
    expect(turkey.searchTerm).toBeNull();
    expect('storeProducts' in turkey).toBe(false);
  });
});
