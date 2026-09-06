// "Tacos calls for onion, finely diced" — the preparation belongs on the line
// that asks you to choose a product (MEAL-102).
//
// WebViewCartSheet has rendered this exact sentence WITH the preparation since
// MEAL-102. ProductChooserSheet renders the same sentence and dropped it, which
// is the shape of bug that survives review: two screens, one string, and the
// one you are not looking at is the wrong one.
//
// It matters most precisely here. Choosing between a whole onion and a bag of
// diced onion is a different decision depending on what the recipe asked for,
// and this screen is where that choice is made.

import { render, waitFor } from '@testing-library/react-native';

const mockSearchProducts = jest.fn();
const mockUpdateMeal = jest.fn(async () => ({}));

jest.mock('../../src/lib/api', () => ({
  kroger: {
    searchProducts: (...args: any[]) => mockSearchProducts(...args),
    addToCartDirect: jest.fn(async () => ({})),
  },
  meals: { update: (..._args: any[]) => mockUpdateMeal() },
}));

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (p: any) => RealReact.createElement(RealText, null, p.name) };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import ProductChooserSheet from '../../src/components/ProductChooserSheet';

const CHOSEN = { upc: '0001111041700', name: 'Kroger Sour Cream, 16 oz' };




const ing = (over: Record<string, unknown> = {}) => ({
  ingredientName: 'Onion',
  searchTerm: null,
  productQty: 1,
  qty: 1,
  unit: 'qty',
  measure: null,
  ...over,
});

const renderChooser = (ingredients: unknown[]) =>
  render(
    <ProductChooserSheet
      visible
      meal={{ id: 'm1', name: 'Tacos', ingredients } as never}
      locationId="loc1"
      storeName="Kroger"
      storeColor="#dd0031"
      onClose={() => {}}
      onMealUpdated={() => {}}
    />,
  );

beforeEach(() => {
  mockSearchProducts.mockReset();
  mockSearchProducts.mockResolvedValue({ results: [] });
});

describe('the line that says what the recipe asked for', () => {
  it('carries the preparation', async () => {
    const view = renderChooser([ing({ prep: 'finely diced' })]);
    await waitFor(() => expect(view.queryByText(/finely diced/i)).toBeTruthy());
  });

  it('reads as one phrase, not two fields', async () => {
    // `withPrep` joins with a comma, the same way the cart sheet and every
    // share page do. Rendering "Onion finely diced" would be a second format
    // for the same value.
    const view = renderChooser([ing({ prep: 'finely diced' })]);
    await waitFor(() => expect(view.queryByText('Onion, finely diced')).toBeTruthy());
  });

  it('says nothing extra when there is no preparation', async () => {
    // Most rows have none. A trailing comma on every one of them would be a
    // worse bug than the one this fixes.
    const view = renderChooser([ing()]);
    await waitFor(() => expect(view.queryByText('Onion')).toBeTruthy());
  });

  it('keeps the preparation OUT of what is searched for', async () => {
    // Display only. "onion, finely diced" is not a product any store sells, and
    // sending it would turn a working search into no results.
    renderChooser([ing({ prep: 'finely diced' })]);
    await waitFor(() => expect(mockSearchProducts).toHaveBeenCalled());
    const sent = mockSearchProducts.mock.calls[0][0];
    expect(JSON.stringify(sent)).not.toMatch(/finely diced/i);
  });
});
