// MEAL-19 — the Kroger cart remembers WHICH product, not just what it is called.
//
// Nine green unit tests for a feature no user can reach is the failure mode this
// file exists to prevent: `storeProducts` is only worth anything if the sheet
// actually sends the stored identifier when a run starts, and actually records
// one when the user presses "Add & Update Meal Ingredient". Both halves are
// driven here through the real screens, not through the helpers.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockSearchProducts = jest.fn();
const mockAddToCartDirect = jest.fn(async (...args: any[]) => ({}));
const mockUpdateMeal = jest.fn(async (...args: any[]) => ({ id: 'm1' }));

jest.mock('../../src/lib/api', () => ({
  kroger: {
    searchProducts: (...args: any[]) => mockSearchProducts(...args),
    addToCartDirect: (...args: any[]) => mockAddToCartDirect(...args),
  },
  meals: { update: (...args: any[]) => mockUpdateMeal(...args) },
}));

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name) };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import KrogerCartReviewSheet from '../../src/components/KrogerCartReviewSheet';
import ProductChooserSheet from '../../src/components/ProductChooserSheet';

const CHOSEN = { upc: '0001111041700', name: 'Kroger Sour Cream, 16 oz' };

const ingredient = (overrides: Record<string, unknown> = {}) => ({
  ingredientName: 'Sour Cream',
  searchTerm: 'Kroger Sour Cream, 16 oz',
  productQty: 1,
  qty: 1,
  unit: 'qty',
  measure: null,
  ...overrides,
});

const renderSheet = (ingredients: any[], storeId = 'kroger') =>
  render(
    <KrogerCartReviewSheet
      visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients } as any]}
      locationId="loc1"
      storeId={storeId}
      storeName="Kroger"
      onClose={() => {}}
    />,
  );

/** The ingredient rows the sheet asked the server to search for. */
const searchedIngredients = () => mockSearchProducts.mock.calls[0][0];

beforeEach(() => {
  mockSearchProducts.mockReset();
  mockAddToCartDirect.mockClear();
  mockUpdateMeal.mockClear();
  mockSearchProducts.mockResolvedValue({ results: [] });
});

describe('starting a run sends the product the user already chose', () => {
  it('sends the stored UPC alongside the display name', async () => {
    const { getByText } = renderSheet([ingredient({ storeProducts: { kroger: CHOSEN } })]);

    fireEvent.press(getByText(/add ingredients to/i));

    await waitFor(() => expect(mockSearchProducts).toHaveBeenCalled());
    expect(searchedIngredients()[0]).toMatchObject({
      productName: 'Sour Cream',
      searchTerm: 'Kroger Sour Cream, 16 oz',
      upc: CHOSEN.upc,
    });
  });

  it('sends the same UPC on any Kroger-family banner', async () => {
    // One catalogue across the family, so a meal moved to Ralphs keeps the
    // choice rather than starting over on a text search.
    const { getByText } = renderSheet([ingredient({ storeProducts: { kroger: CHOSEN } })], 'ralphs');

    fireEvent.press(getByText(/add ingredients to/i));

    await waitFor(() => expect(mockSearchProducts).toHaveBeenCalled());
    expect(searchedIngredients()[0].upc).toBe(CHOSEN.upc);
  });

  it('sends no UPC from another store’s choice', async () => {
    // The leak this guards: `searchTerm` is global and already crosses stores,
    // where the text ladder recovers. An identifier crossing would add a real
    // product nobody picked.
    const { getByText } = renderSheet([ingredient({ storeProducts: { heb: { upc: 'heb-1', name: 'H-E-B Sour Cream' } } })]);

    fireEvent.press(getByText(/add ingredients to/i));

    await waitFor(() => expect(mockSearchProducts).toHaveBeenCalled());
    expect(searchedIngredients()[0].upc).toBeNull();
  });

  it('sends no UPC for a row nobody has chosen for', async () => {
    const { getByText } = renderSheet([ingredient()]);

    fireEvent.press(getByText(/add ingredients to/i));

    await waitFor(() => expect(mockSearchProducts).toHaveBeenCalled());
    expect(searchedIngredients()[0].upc).toBeNull();
  });
});

describe('choosing a product records which one it was', () => {
  const SUBSTITUTE = { upc: '0007373100000', description: 'Daisy Sour Cream', size: '16 oz', price: 2.99 };

  const walkToReview = async () => {
    mockSearchProducts.mockResolvedValue({
      results: [{
        term: 'Sour Cream',
        quantity: 1,
        upc: null,
        description: null,
        exact: false,
        reason: 'low_confidence',
        suggestions: [SUBSTITUTE],
      }],
    });
    const screen = renderSheet([ingredient()]);
    fireEvent.press(screen.getByText(/add ingredients to/i));
    await waitFor(() => expect(screen.getByText(/Review 1 Ingredient/)).toBeTruthy());
    fireEvent.press(screen.getByText(/Review 1 Ingredient/));
    return screen;
  };

  it('saves the UPC and the display name together on "Add & Update"', async () => {
    const screen = await walkToReview();

    fireEvent.press(screen.getByText('Add & Update Meal Ingredient'));

    await waitFor(() => expect(mockUpdateMeal).toHaveBeenCalled());
    const [mealId, patch] = mockUpdateMeal.mock.calls[0] as any[];
    expect(mealId).toBe('m1');
    expect(patch.ingredients[0]).toMatchObject({
      searchTerm: 'Daisy Sour Cream',
      storeProducts: { kroger: { upc: SUBSTITUTE.upc, name: 'Daisy Sour Cream' } },
    });
  });

  it('writes nothing onto a meal when the user only adds to the cart', async () => {
    // "Add to Cart Only" is the user declining to change the meal. It must not
    // quietly rewrite saved data on the way past.
    const screen = await walkToReview();

    fireEvent.press(screen.getByText('Add to Cart Only'));

    await waitFor(() => expect(mockAddToCartDirect).toHaveBeenCalled());
    expect(mockUpdateMeal).not.toHaveBeenCalled();
  });
});

describe('the meal editor’s product chooser records it too', () => {
  // Two screens write a Kroger choice. A feature that reaches one of them is a
  // feature that works until the user takes the other route.
  const SUGGESTION = { upc: '0002200000000', description: 'Kroger Sour Cream', size: '16 oz', price: 1.99 };

  it('saves the UPC beside the display name', async () => {
    mockSearchProducts.mockResolvedValue({ results: [{ suggestions: [SUGGESTION] }] });
    const screen = render(
      <ProductChooserSheet
        visible
        meal={{ id: 'm1', name: 'Tacos', storeId: 'kroger', ingredients: [ingredient({ searchTerm: null })] } as any}
        locationId="loc1"
        storeName="Kroger"
        storeColor="#003087"
        onClose={() => {}}
        onMealUpdated={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('Kroger Sour Cream, 16 oz')).toBeTruthy());
    fireEvent.press(screen.getByText('+'));           // a quantity is required before saving
    fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(mockUpdateMeal).toHaveBeenCalled());
    const [, patch] = mockUpdateMeal.mock.calls[0] as any[];
    expect(patch.ingredients[0]).toMatchObject({
      searchTerm: 'Kroger Sour Cream, 16 oz',
      storeProducts: { kroger: { upc: SUGGESTION.upc, name: 'Kroger Sour Cream, 16 oz' } },
    });
  });
});
