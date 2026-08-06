// MEAL-65 on the Kroger qty step: qty 0 unchecks the box and strikes the name.
//
// The row was already excluded from the run at qty 0 — these pin the FEEDBACK
// that was missing, plus the two ways back to included (the + and re-checking
// the box), which the fix has to keep reachable: if the checkbox reads unchecked
// at qty 0, both it and the + must still do something.

import { fireEvent, render } from '@testing-library/react-native';

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
  return {
    Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
  };
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

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
} as any;

const renderSheet = () =>
  render(
    <KrogerCartReviewSheet
      visible
      meals={[meal]}
      locationId="loc1"
      storeId="kroger"
      storeName="Kroger"
      onClose={() => {}}
    />,
  );

/** Does this element's style (array or object) carry a strikethrough? */
const isStruckThrough = (el: any) => {
  const flat = [el.props.style].flat(Infinity).filter(Boolean);
  return flat.some((s: any) => s && s.textDecorationLine === 'line-through');
};

describe('KrogerCartReviewSheet — qty 0 feedback (MEAL-65)', () => {
  it('shows a checked, un-struck row at qty 1', () => {
    const { getByText, queryByTestId } = renderSheet();
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('unchecks the box and strikes the name once qty hits 0', () => {
    const { getByText, queryByTestId } = renderSheet();
    fireEvent.press(getByText('−'));
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(isStruckThrough(getByText('sour cream'))).toBe(true);
  });

  it('disables the run CTA at qty 0 — the row really is excluded', () => {
    const { getByText } = renderSheet();
    fireEvent.press(getByText('−'));
    // activeCount === 0 → the CTA is disabled. Pressing it must not leave the
    // qty step (a disabled Touchable never fires).
    fireEvent.press(getByText(/add ingredients to/i));
    expect(getByText(/add ingredients to/i)).toBeTruthy();
  });

  it('restores qty 1 and re-checks when the + is pressed from 0', () => {
    const { getByText, queryByTestId } = renderSheet();
    fireEvent.press(getByText('−'));
    fireEvent.press(getByText('+'));
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('restores qty 1 when the checkbox is tapped from 0 — not a dead tap', () => {
    const { getByText, getByTestId, queryByTestId } = renderSheet();
    fireEvent.press(getByText('−'));
    fireEvent.press(getByTestId('qty-checkbox-0'));
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('keeps the quantity when the box is unchecked at qty ≥ 1', () => {
    const { getByText, getByTestId, queryByTestId } = renderSheet();
    fireEvent.press(getByTestId('qty-checkbox-0'));
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(isStruckThrough(getByText('sour cream'))).toBe(true);
    // Re-check: the qty it had is still there, not reset to 1 by the restore path.
    fireEvent.press(getByTestId('qty-checkbox-0'));
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
  });
});
