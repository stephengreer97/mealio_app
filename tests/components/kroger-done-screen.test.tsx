// THE ENDING SCREEN, THE SAME AS THE OTHER STORES, MINUS THE HALF THAT CANNOT EXIST.
//
// Stephen, 2026-09-12: "Kroger not showing same ending cart snapshot screen
// like other stores."
//
// The WebView stores render their cart twice over: green rows with a + for what
// this run added, grey rows for what was already there, and a total. Every bit
// of that comes from reading the cart before and after.
//
// Kroger's API has no cart read. The whole surface is status, connect,
// disconnect, locations, set-location, add-to-cart, search-products -- the
// public Cart API is write-only. So the grey half and the total are ABSENT
// here, and this file's job is to hold that line: absent, not zeroed, not
// guessed, and not quietly reintroduced by someone matching the other screen
// more closely than the data allows.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});
jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (props: any) => RealReact.createElement(RealText, { testID: `icon-${props.name}` }, props.name) };
});
jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('../../src/components/CartRunAnimation', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { __esModule: true, default: () => RealReact.createElement(RealText, null, 'bag') };
});

const mockSearch = jest.fn();
const mockAdd = jest.fn();
jest.mock('../../src/lib/api', () => ({
  kroger: {
    searchProducts: (...a: unknown[]) => mockSearch(...a),
    addToCartDirect: (...a: unknown[]) => mockAdd(...a),
  },
  meals: { update: jest.fn(async () => ({})) },
}));

import KrogerCartReviewSheet from '../../src/components/KrogerCartReviewSheet';

const ing = (name: string) => ({
  ingredientName: name, searchTerm: name.toLowerCase(), productQty: 1, qty: 1,
  unit: 'qty', measure: null,
});
const meal = {
  id: 'm1', name: 'Tacos',
  ingredients: [ing('Sour Cream'), ing('Tortillas'), ing('Limes')],
} as any;

const found = (term: string, upc: string, description: string) => ({
  term, exact: true, upc, description, quantity: 1, suggestions: [],
});

const open = () => render(
  <KrogerCartReviewSheet
    visible meals={[meal]} locationId="loc1" storeId="kroger"
    storeName="Kroger" onClose={() => {}}
  />,
);

beforeEach(() => { mockSearch.mockReset(); mockAdd.mockReset(); });

/** Run to the done screen with `n` of the three ingredients matching. */
async function runWith(n: number) {
  const all = [
    found('sour cream', 'u1', 'Daisy Sour Cream, 16 oz'),
    found('tortillas', 'u2', 'Mission Flour Tortillas, 10 ct'),
    found('limes', 'u3', 'Limes, each'),
  ];
  mockSearch.mockResolvedValue({ results: all.slice(0, n) });
  mockAdd.mockResolvedValue({});
  const view = open();
  await act(async () => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  // Waited on the FOOTER, not on any headline. Both the title ("N items added
  // to your Kroger cart!") and the section heading contain that phrase, so a
  // text match on it finds two elements and throws -- which is the matcher
  // being ambiguous, not the screen being wrong.
  await waitFor(() => expect(view.queryByText('Done')).toBeTruthy());
  return view;
}

describe('the Kroger done screen', () => {
  it('names each item it added, with a quantity and the green +', async () => {
    const view = await runWith(3);
    expect(view.getAllByTestId('cart-row-added')).toHaveLength(3);
    expect(view.queryByText('Daisy Sour Cream, 16 oz')).toBeTruthy();
    expect(view.queryByText('Mission Flour Tortillas, 10 ct')).toBeTruthy();
    // The quantity per row, the way the other stores show it.
    expect(view.getAllByText('x1').length).toBeGreaterThanOrEqual(3);
    // The + icon marks an added row on every store. Its absence here would make
    // this list read as "your cart", which is the claim we cannot make.
    expect(view.getAllByTestId('icon-add').length).toBeGreaterThanOrEqual(3);
  });

  it('heads the section with what the rows ARE, not with the cart', async () => {
    // "Your Kroger cart" is what the WebView stores say, because for them it IS
    // the cart -- they read it. These rows are what this run added and nothing
    // else, so the heading says that instead.
    const view = await runWith(3);
    // Exact strings: the title says "3 items added to your Kroger cart!" and a
    // loose match would pass on that alone, without the heading existing at all.
    expect(view.queryByText('Added to your Kroger cart')).toBeTruthy();
    expect(view.queryByText('Your Kroger cart')).toBeNull();
  });

  it('says how many were added and NEVER how many are in the cart', async () => {
    // THE LINE THIS FILE EXISTS TO HOLD. The other stores show
    // "N added · M in cart". M comes from reading the cart, which this API
    // cannot do, so it must not appear in any form.
    const view = await runWith(3);
    expect(view.queryByText('3 added')).toBeTruthy();
    expect(view.queryByText(/in cart/i)).toBeNull();
  });

  it('shows no grey already-in-your-cart section at all', async () => {
    // Absent, not zeroed. "0 already in your cart" is a claim about a cart
    // nothing here has read.
    const view = await runWith(3);
    expect(view.queryByTestId('cart-row-existing')).toBeNull();
    expect(view.queryByText(/already in your cart/i)).toBeNull();
  });

  it('counts what did not make it, including rows the store never matched', async () => {
    // Two of three matched. The third was asked for and is not in the cart,
    // which is the fact the user needs whether it was skipped or unmatched.
    const view = await runWith(2);
    expect(view.queryByTestId('done-failed-count')).toBeTruthy();
    expect(view.queryByText(/1 item could not be added/i)).toBeTruthy();
  });

  it('says nothing about failures when everything landed', async () => {
    const view = await runWith(3);
    expect(view.queryByTestId('done-failed-count')).toBeNull();
  });
});
