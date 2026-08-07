// MEAL-119 — the review card for a count item whose cart line came back
// sold-by-weight (the stepper-weight H-E-B deli shape: weightStep, no
// purchaseWeight, so the ×3 is a unit count).
//
// Stephen's ruling is what this file guards: "double adding is worst case
// scenario, but user getting nothing is also not acceptable." Both machine
// answers are rejected, so the run stops and asks — and the two rejected
// outcomes must not be reachable from the card unless the user picks them:
//
//   • nothing may be confirmed silently: accepting the cart line is a press;
//   • nothing may be re-added automatically, and never the full quantity by
//     default — the top-up is inert until the user raises the stepper.
//
// The card itself is only reachable through the parallel-add reconcile (worker
// pool → cart probe → CART_COUNT phase 'reconcile'), which no component test can
// drive, so the two pieces the decision lives in are rendered directly. The
// routing that puts an item here at all is pinned in tests/unit (see
// splitTopUpsForReview) — between them, every step of the path is covered.

import { fireEvent, render } from '@testing-library/react-native';

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, _ref: any) =>
    RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props }),
  );
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }),
  };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name) };
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

import {
  InCartByWeightActions,
  InCartByWeightNote,
  inCartByWeightReview,
} from '../../src/components/WebViewCartSheet';

/** The deli item as the sheet holds it: count-ordered, no purchaseWeight. */
const DELI_ITEM = {
  ingredientName: 'Chicken breast',
  searchTerm: 'chicken breast',
  unit: 'qty',
  measure: null,
  weightStep: 0.25,
  purchaseWeight: null,
  mealIngredients: [{ mealId: 'm1', mealName: 'Tacos', qty: 3 }],
};

const CART_LINE = 'H-E-B Boneless Chicken Breast';

describe('inCartByWeightReview — the card is built from the CART ROW, so it can render at all', () => {
  it('synthesizes a candidate from the cart line the worker could not give us', () => {
    // The reason an earlier attempt declined to route this: the card renders from
    // the worker's `candidates`, and H-E-B's success message carries none (see
    // heb.ts). Routed with those, the card would show no product and no way to
    // act — a silent non-delivery in place of the double purchase. The cart row's
    // own name is the one truthful thing available, so it becomes the candidate.
    const card = inCartByWeightReview(DELI_ITEM, CART_LINE);
    expect(card.candidates).toHaveLength(1);
    expect(card.candidates[0].productName).toBe(CART_LINE);
    expect(card.candidates[0].outOfStock).toBe(false);
    expect(card.reason).toBe('in_cart_by_weight');
    // Review-unmatched flow, not choose-product: this item HAS a chosen product.
    expect(card.isChoose).toBe(false);
    // Identified by the search term the run used, and carrying what each meal
    // asked for so the card can show it.
    expect(card.term).toBe('chicken breast');
    expect(card.mealIngredients).toEqual(DELI_ITEM.mealIngredients);
  });

  it('does NOT mark the synthesized candidate as a weight item', () => {
    // The item's intent is a unit count. Marking the candidate weight would turn
    // the card's stepper into a poundage picker and persist a purchaseWeight
    // nobody chose — which is exactly the intent-vs-row confusion MEAL-119 is
    // about, re-introduced on the screen that exists to resolve it.
    expect(inCartByWeightReview(DELI_ITEM, CART_LINE).candidates[0].isWeightItem).toBe(false);
  });

  it('falls back to the ingredient name when the item has no search term', () => {
    const card = inCartByWeightReview({ ...DELI_ITEM, searchTerm: null }, CART_LINE);
    expect(card.term).toBe('Chicken breast');
  });
});

describe('InCartByWeightNote — what the card says happened', () => {
  it('names the cart line, that it is priced by weight, and that nothing more was added', () => {
    const { getByTestId, getByText } = render(<InCartByWeightNote cartName={CART_LINE} />);
    expect(getByTestId('in-cart-by-weight-note')).toBeTruthy();
    expect(getByText(/already in your cart, priced by weight/i)).toBeTruthy();
    expect(getByText(new RegExp(CART_LINE))).toBeTruthy();
    // The clause that earns the question. Without it, "already in your cart"
    // reads as done and the buttons look like noise.
    expect(getByText(/cannot tell whether the amount there covers/i)).toBeTruthy();
    expect(getByText(/did not add any more/i)).toBeTruthy();
  });

  it('still renders a usable note when the cart line has no name', () => {
    const { getByText } = render(<InCartByWeightNote cartName={null} />);
    expect(getByText(/already has this item/i)).toBeTruthy();
    expect(getByText(/did not add any more/i)).toBeTruthy();
  });
});

describe('InCartByWeightActions — neither rejected outcome is reachable without a choice', () => {
  const renderActions = (addQty: number, opts: { withBack?: boolean } = {}) => {
    const onKeep = jest.fn();
    const onAddMore = jest.fn();
    const onSkip = jest.fn();
    const onBack = jest.fn();
    const utils = render(
      <InCartByWeightActions
        addQty={addQty}
        storeColor="#e21a2c"
        onKeep={onKeep}
        onAddMore={onAddMore}
        onSkip={onSkip}
        onBack={opts.withBack ? onBack : undefined}
      />,
    );
    return { ...utils, onKeep, onAddMore, onSkip, onBack };
  };

  it('offers three answers: keep the cart line, add more deliberately, or skip', () => {
    const { getByTestId } = renderActions(0);
    expect(getByTestId('keep-cart-weight-line')).toBeTruthy();
    expect(getByTestId('add-more-anyway')).toBeTruthy();
    // Skip must stay available on every review card, this one included.
    expect(getByTestId('in-cart-by-weight-skip')).toBeTruthy();
  });

  it('cannot add anything at qty 0 — the automatic full re-add has no path here', () => {
    // The rejected outcome, stated as a test: at rest the card adds NOTHING. The
    // old behavior re-added `shortfall` (the full ×3) with no press at all.
    const { getByTestId, onAddMore } = renderActions(0);
    const btn = getByTestId('add-more-anyway');
    expect(btn.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(btn);
    expect(onAddMore).not.toHaveBeenCalled();
  });

  it('says how much it will add once the user has chosen a number', () => {
    const { getByTestId, getByText, onAddMore } = renderActions(3);
    expect(getByText('Add 3 more to my cart')).toBeTruthy();
    fireEvent.press(getByTestId('add-more-anyway'));
    expect(onAddMore).toHaveBeenCalledTimes(1);
  });

  it('confirms the cart line only on a press — nothing is accepted silently', () => {
    const { getByTestId, onKeep, onAddMore } = renderActions(0);
    expect(onKeep).not.toHaveBeenCalled();
    fireEvent.press(getByTestId('keep-cart-weight-line'));
    expect(onKeep).toHaveBeenCalledTimes(1);
    // Accepting adds nothing — that is the entire point of the card.
    expect(onAddMore).not.toHaveBeenCalled();
  });

  it('skips without adding or confirming', () => {
    const { getByTestId, onSkip, onKeep, onAddMore } = renderActions(2);
    fireEvent.press(getByTestId('in-cart-by-weight-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
    expect(onAddMore).not.toHaveBeenCalled();
  });

  it('offers Back only when there is an earlier item to go back to', () => {
    expect(renderActions(0).queryByTestId('in-cart-by-weight-back')).toBeNull();
    const withBack = renderActions(0, { withBack: true });
    fireEvent.press(withBack.getByTestId('in-cart-by-weight-back'));
    expect(withBack.onBack).toHaveBeenCalledTimes(1);
  });
});
