// Kroger's chooser, on an ingredient the store does not stock.
//
// Three things were wrong with that screen and all three were Kroger-only —
// WebViewCartSheet had already been fixed and this one had not, which is the
// shape of bug that survives review: two screens, one behaviour, and the one you
// are not looking at is the wrong one.
//
//   * NO SKIP. Every other store's chooser has one. The only ways off an
//     ingredient here were to pick a product that does not exist or to close the
//     sheet and lose the choices already made.
//   * NO HIGHLIGHT. "No products found" was a grey section heading, so the way
//     forward — the search box directly under it — was not what the eye went to.
//   * THE QUANTITY STEPPER STAYED, glowing, asking how many of nothing to add.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockSearchProducts = jest.fn();
const mockUpdateMeal = jest.fn(async () => ({ id: 'm1' }));

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

const ing = (name: string) => ({
  ingredientName: name, searchTerm: null, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const suggestion = (description: string, price: number | null = 2.79) => ({
  upc: '0001111041700', description, size: '16 oz', price, stockLevel: 'HIGH',
});

/** `results` is one entry per ingredient, in order. */
const renderChooser = (ingredients: unknown[], results: unknown[]) => {
  mockSearchProducts.mockResolvedValue({ results });
  return render(
    <ProductChooserSheet
      visible
      meal={{ id: 'm1', name: 'Tacos', ingredients, storeId: 'kroger' } as never}
      locationId="loc1"
      storeName="Kroger"
      storeColor="#0E51A1"
      onClose={() => {}}
      onMealUpdated={() => {}}
    />,
  );
};

beforeEach(() => {
  mockSearchProducts.mockReset();
  mockUpdateMeal.mockClear();
});

describe('Kroger chooser with no results', () => {
  const empty = [{ term: 'Saffron', quantity: 1, upc: null, description: null, exact: false, suggestions: [] }];

  it('offers a way past the ingredient', async () => {
    const view = renderChooser([ing('Saffron')], empty);
    await waitFor(() => expect(view.queryByText('No products found')).toBeTruthy());
    expect(view.queryByTestId('chooser-skip')).toBeTruthy();
  });

  it('highlights that nothing was found, and points at the search box', async () => {
    const view = renderChooser([ing('Saffron')], empty);
    await waitFor(() => expect(view.queryByText('No products found')).toBeTruthy());
    expect(view.queryByText(/type a different product name below/i)).toBeTruthy();
  });

  it('hides the quantity stepper', async () => {
    const view = renderChooser([ing('Saffron')], empty);
    await waitFor(() => expect(view.queryByText('No products found')).toBeTruthy());
    expect(view.queryByTestId('chooser-qty-glow')).toBeNull();
    expect(view.queryByText('Qty for this meal')).toBeNull();
  });

  it('lays the buttons out the way every other store does', async () => {
    // Stephen, 2026-09-09: "the skip back and next/choose qty button layout in
    // Kroger view should be the same as other stores." So: Back and the primary
    // share a row, and Skip is a full-width line under them — not a third button
    // squeezed into the row, and not promoted into the primary slot.
    const view = renderChooser([ing('Saffron')], empty);
    await waitFor(() => expect(view.queryByText('No products found')).toBeTruthy());
    expect(view.queryByText('← Back')).toBeTruthy();
    expect(view.queryByText('Skip this ingredient')).toBeTruthy();
    // With nothing found there is no quantity to choose, so the primary is not
    // asking for one.
    expect(view.queryByText('Choose Quantity')).toBeNull();
  });

  it('glows the search row, because it is the only way forward', async () => {
    // Borrowed from WebViewCartSheet: the field is the one control that can move
    // the run on, and it is the one that looks least like a control — placeholder
    // text under an empty list.
    const view = renderChooser([ing('Saffron')], empty);
    await waitFor(() => expect(view.queryByText('No products found')).toBeTruthy());
    expect(view.queryByTestId('chooser-search-glow')).toBeTruthy();
  });

  it('saves nothing for a skipped ingredient', async () => {
    const view = renderChooser([ing('Saffron')], empty);
    await waitFor(() => expect(view.queryByTestId('chooser-skip')).toBeTruthy());
    fireEvent.press(view.getByTestId('chooser-skip'));
    // The run still ends — a skip is a decision, not an abandonment — and the
    // ingredient simply has no entry, so the next cart run searches it by name.
    await waitFor(() => expect(mockUpdateMeal).toHaveBeenCalled());
  });
});

describe('Kroger chooser with results', () => {
  const found = [{
    term: 'Sour Cream', quantity: 1, upc: null, description: null, exact: false,
    suggestions: [suggestion('Kroger Sour Cream, 16 oz')],
  }];

  it('still shows the stepper and keeps Skip beside Next', async () => {
    const view = renderChooser([ing('Sour Cream')], found);
    await waitFor(() => expect(view.queryByText('Qty for this meal')).toBeTruthy());
    expect(view.queryByTestId('chooser-qty-glow')).toBeTruthy();
    expect(view.queryByTestId('chooser-skip')).toBeTruthy();
    expect(view.queryByText('Choose Quantity')).toBeTruthy();
    // ...and no glow: there is something to pick, so the search row is not the
    // thing to point at.
    expect(view.queryByTestId('chooser-search-glow')).toBeNull();
  });
});
