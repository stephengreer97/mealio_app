// A SECOND TAP MUST NOT ADD A SECOND TIME.
//
// The Kroger cart write is additive. handleStartSearch and the final review
// decision had no re-entry guard, so two taps landing before React re-rendered
// (a double tap, or a tap on a slow phone) ran the search twice or sent the
// cart write twice, and the user got two of everything. Each case below fires
// both taps inside ONE act, which is what "before the re-render" means here.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

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

const ingredient = (name: string) => ({
  ingredientName: name, searchTerm: null, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const renderSheet = (ingredients: any[], visible = true) => (
  <KrogerCartReviewSheet
    visible={visible}
    meals={[{ id: 'm1', name: 'Tacos', ingredients } as any]}
    locationId="loc1"
    storeId="kroger"
    storeName="Kroger"
    onClose={() => {}}
  />
);

const SUGG = { upc: '0007373100000', description: 'Daisy Sour Cream', size: '16 oz', price: 2.99 };
const needsReview = (term: string) => ({
  term, quantity: 1, upc: null, description: null, exact: false, reason: 'low_confidence', suggestions: [SUGG],
});

const doubleTap = (el: any) => act(() => { fireEvent.press(el); fireEvent.press(el); });

beforeEach(() => {
  mockSearchProducts.mockReset();
  mockAddToCartDirect.mockClear();
  mockUpdateMeal.mockClear();
});

it('searches once for a double tap on the start button', async () => {
  mockSearchProducts.mockImplementation(() => new Promise(() => {}));
  const screen = render(renderSheet([ingredient('Sour Cream')]));

  doubleTap(screen.getByText(/add ingredients to/i));

  await waitFor(() => expect(mockSearchProducts).toHaveBeenCalled());
  expect(mockSearchProducts).toHaveBeenCalledTimes(1);
});

it('writes the cart once when every match is exact and the start is double tapped', async () => {
  mockSearchProducts.mockResolvedValue({
    results: [{ term: 'Sour Cream', quantity: 1, upc: '0001', description: 'Sour Cream', exact: true, suggestions: [] }],
  });
  const screen = render(renderSheet([ingredient('Sour Cream')]));

  doubleTap(screen.getByText(/add ingredients to/i));

  await waitFor(() => expect(mockAddToCartDirect).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(mockAddToCartDirect).toHaveBeenCalledTimes(1);
});

async function walkToReview(terms: string[]) {
  mockSearchProducts.mockResolvedValue({ results: terms.map(needsReview) });
  const screen = render(renderSheet(terms.map(ingredient)));
  fireEvent.press(screen.getByText(/add ingredients to/i));
  const label = new RegExp(`Review ${terms.length} Ingredient`);
  await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
  fireEvent.press(screen.getByText(label));
  return screen;
}

it('writes the cart once for a double tap on the last review decision', async () => {
  const screen = await walkToReview(['Sour Cream']);

  doubleTap(screen.getByText('Add to Cart Only'));

  await waitFor(() => expect(mockAddToCartDirect).toHaveBeenCalled());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(mockAddToCartDirect).toHaveBeenCalledTimes(1);
});

it('decides once for a double tap on "Add & Update"', async () => {
  const screen = await walkToReview(['Sour Cream', 'Salsa']);

  doubleTap(screen.getByText('Add & Update Meal Ingredient'));

  await waitFor(() => expect(mockUpdateMeal).toHaveBeenCalled());
  expect(mockUpdateMeal).toHaveBeenCalledTimes(1);
});

it('still decides every item when the taps are separate', async () => {
  // The guard is per item: moving on (or Back) releases it.
  const screen = await walkToReview(['Sour Cream', 'Salsa']);

  fireEvent.press(screen.getByText('Add to Cart Only'));
  await waitFor(() => expect(screen.getByText('← Back')).toBeTruthy());
  fireEvent.press(screen.getByText('Add to Cart Only'));

  await waitFor(() => expect(mockAddToCartDirect).toHaveBeenCalledTimes(1));
  expect((mockAddToCartDirect.mock.calls[0] as any[])[0]).toHaveLength(2);
});

it('runs again when the sheet is opened for a new run', async () => {
  mockSearchProducts.mockResolvedValue({
    results: [{ term: 'Sour Cream', quantity: 1, upc: '0001', description: 'Sour Cream', exact: true, suggestions: [] }],
  });
  const screen = render(renderSheet([ingredient('Sour Cream')]));
  fireEvent.press(screen.getByText(/add ingredients to/i));
  await waitFor(() => expect(mockAddToCartDirect).toHaveBeenCalledTimes(1));

  screen.rerender(renderSheet([ingredient('Sour Cream')], false));
  screen.rerender(renderSheet([ingredient('Sour Cream')], true));
  await waitFor(() => expect(screen.getByText(/add ingredients to/i)).toBeTruthy());
  fireEvent.press(screen.getByText(/add ingredients to/i));

  await waitFor(() => expect(mockAddToCartDirect).toHaveBeenCalledTimes(2));
});
