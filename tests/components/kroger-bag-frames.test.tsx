// THE BAG MEANS THE SAME THING ON KROGER AS IT DOES EVERYWHERE ELSE.
//
// Stephen, 2026-09-11: "add the frame sequence to the Kroger stores."
//
// The animation's own rule is the constraint: "The frame IS the progress...
// nothing here is decorative timing pretending to be a measurement." That is
// easy to honour on the WebView stores, whose rails answer one request per term
// and one per write. This path is an API client -- one search call and one add
// call for the whole basket -- so there is no per-item progress to be had, and
// the only honest options are to move on the milestones that ARE real or to
// manufacture some.
//
// This file pins the first. The bag is empty while nothing has completed, half
// when every ingredient has been looked up, and full when every item has been
// written -- and it does NOT fill on a write that failed, which is the case
// where a prettier animation would be lying to the user's face.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

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

/** The animation, stubbed to report the one prop this file is about. */
const seen: Array<number | null> = [];
jest.mock('../../src/components/CartRunAnimation', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    __esModule: true,
    default: (props: { progress: number | null; label?: string | null }) => {
      seen.push(props.progress);
      return RealReact.createElement(RealText, { testID: 'bag' }, props.label ?? '');
    },
  };
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

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
    { ingredientName: 'Tortillas', searchTerm: 'tortillas', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
} as any;

const found = (term: string, upc: string) => ({
  term, exact: true, upc, description: `${term} 1 ct`, quantity: 1, suggestions: [],
});

const open = () => render(
  <KrogerCartReviewSheet
    visible
    meals={[meal]}
    locationId="loc1"
    storeId="kroger"
    storeName="Kroger"
    onClose={() => {}}
  />,
);

beforeEach(() => {
  seen.length = 0;
  mockSearch.mockReset();
  mockAdd.mockReset();
});

/** The last progress the bag was handed. */
const latest = () => seen[seen.length - 1];

describe('the bag on the Kroger path', () => {
  it('is empty while the search is still out', async () => {
    // Indeterminate, not zero-of-two. Nothing has completed, and the run has no
    // way to know how far through one server call it is.
    let release: (v: unknown) => void = () => {};
    mockSearch.mockReturnValue(new Promise((r) => { release = r; }));
    const { getByText, getByTestId } = open();
    await act(async () => { fireEvent.press(getByText(/add ingredients to/i)); });
    expect(getByTestId('bag')).toBeTruthy();
    expect(latest()).toBeNull();
    await act(async () => { release({ results: [] }); });
  });

  it('fills to half when every ingredient has been looked up', async () => {
    mockSearch.mockResolvedValue({ results: [found('sour cream', 'u1'), found('tortillas', 'u2')] });
    mockAdd.mockReturnValue(new Promise(() => {}));
    const { getByText } = open();
    await act(async () => { fireEvent.press(getByText(/add ingredients to/i)); });
    await waitFor(() => expect(latest()).toBe(0.5));
  });

  it('holds at half for the whole write, and the last step lands with the done screen', async () => {
    // WHAT THE USER ACTUALLY SEES, which is not what I first assumed. The write
    // is ONE call: it completes at the same instant the run ends, so the bag is
    // handed 1 and the done screen replaces it in the same commit. The animation
    // is mounted for `searching` and `adding` only -- exactly as it is on the
    // WebView stores -- so the full frame belongs to a screen that is already
    // gone.
    //
    // That is the API shape and not a fudge: the honest thing to show while a
    // single opaque write is in flight is the half that IS finished. Pretending
    // otherwise would need a fake counter, which is the one thing the animation
    // forbids.
    mockSearch.mockResolvedValue({ results: [found('sour cream', 'u1'), found('tortillas', 'u2')] });
    // Held open so the write's screen actually commits. Resolved immediately,
    // React batches search-done straight through to done and the bag never
    // renders at all -- which is itself true of a fast Kroger run and is why
    // this case holds the write rather than asserting on a race.
    let finish: (v: unknown) => void = () => {};
    mockAdd.mockReturnValue(new Promise((r) => { finish = r; }));
    const { getByText, queryByTestId } = open();
    await act(async () => { fireEvent.press(getByText(/add ingredients to/i)); });
    // Half for every frame the bag is on screen during the write, and never
    // more than that while it is still out.
    await waitFor(() => expect(queryByTestId('bag')).toBeTruthy());
    expect(latest()).toBe(0.5);
    await act(async () => { finish({}); });
    // And the full frame belongs to a screen that has already been replaced.
    expect(queryByTestId('bag')).toBeNull();
  });

  it('DOES NOT fill on a write that failed', async () => {
    // The case a prettier animation gets wrong. A full bag over the words "we
    // could not add these" is the animation contradicting the screen, and the
    // user believes the picture.
    mockSearch.mockResolvedValue({ results: [found('sour cream', 'u1'), found('tortillas', 'u2')] });
    mockAdd.mockRejectedValue(new Error('cart service unavailable'));
    const { getByText } = open();
    await act(async () => { fireEvent.press(getByText(/add ingredients to/i)); });
    await waitFor(() => expect(getByText(/could not|failed|unavailable/i)).toBeTruthy());
    expect(seen.filter((p) => p === 1)).toHaveLength(0);
  });

  it('counts a term that needs review as looked up, not as a miss', async () => {
    // The milestone is "have they all been looked up". A term that came back
    // needing review WAS looked up; it is the review screen's turn next.
    //
    // EVERY result needs review here, deliberately. Scoring only the exact
    // matches would leave this run's bag at zero through a write it had already
    // searched for -- and with a mixed run the two rules agree often enough to
    // hide it.
    mockSearch.mockResolvedValue({
      results: [
        { term: 'sour cream', exact: false, upc: null, description: null, quantity: 1,
          suggestions: [{ upc: 'u8', description: 'Daisy Sour Cream' }] },
        { term: 'tortillas', exact: false, upc: null, description: null, quantity: 1,
          suggestions: [{ upc: 'u9', description: 'Corn Tortillas' }] },
      ],
    });
    mockAdd.mockReturnValue(new Promise(() => {}));
    const { getByText, queryByTestId } = open();
    await act(async () => { fireEvent.press(getByText(/add ingredients to/i)); });
    // The review screen, not the bag: the user has work to do and the animation
    // is deliberately not on screen for it.
    await waitFor(() => expect(queryByTestId('bag')).toBeNull());
    seen.length = 0;
    // Take both cards as they came back, which lands on the write.
    await act(async () => { fireEvent.press(getByText(/review .*ingredient|continue|next/i)); });
    for (let i = 0; i < 2; i += 1) {
      const btn = getByText(/add to cart only/i);
      await act(async () => { fireEvent.press(btn); });
    }
    await waitFor(() => expect(queryByTestId('bag')).toBeTruthy());
    expect(latest()).toBe(0.5);
  });

  it('never runs backwards', async () => {
    mockSearch.mockResolvedValue({ results: [found('sour cream', 'u1'), found('tortillas', 'u2')] });
    mockAdd.mockResolvedValue({});
    const { getByText, queryByTestId } = open();
    await act(async () => { fireEvent.press(getByText(/add ingredients to/i)); });
    await waitFor(() => expect(queryByTestId('bag')).toBeNull());
    const numeric = seen.filter((p): p is number => typeof p === 'number');
    for (let i = 1; i < numeric.length; i += 1) {
      expect(numeric[i]).toBeGreaterThanOrEqual(numeric[i - 1]);
    }
  });
});
