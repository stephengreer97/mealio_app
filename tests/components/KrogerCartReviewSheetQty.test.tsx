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

import KrogerCartReviewSheet, {
  consolidateIngredients,
  ConsolidatedIngredient,
} from '../../src/components/KrogerCartReviewSheet';
import { isZeroedOut } from '../../src/lib/cart-reconcile';

const ingredient = (overrides: Record<string, unknown> = {}) => ({
  ingredientName: 'Sour Cream',
  searchTerm: 'sour cream',
  productQty: 1,
  qty: 1,
  unit: 'qty',
  measure: null,
  ...overrides,
});

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [ingredient()],
} as any;

const renderIngredients = (ingredients: any[]) =>
  render(
    <KrogerCartReviewSheet
      visible
      meals={[{ ...meal, ingredients }]}
      locationId="loc1"
      storeId="kroger"
      storeName="Kroger"
      onClose={() => {}}
    />,
  );

const renderSheet = () => renderIngredients(meal.ingredients);

/** Does this element's style (array or object) carry a strikethrough? */
const isStruckThrough = (el: any) => {
  const flat = [el.props.style].flat(Infinity).filter(Boolean);
  return flat.some((s: any) => s && s.textDecorationLine === 'line-through');
};

/** The number the stepper is showing for row `i`, as text. */
const qtyOf = (el: any) => [el.props.children].flat(Infinity).join('');

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

  it('preserves the NUMBER across an uncheck/recheck — 3 units come back as 3', () => {
    // At qty 1 "preserved" and "clobbered to 1" look identical, so the case
    // above cannot tell them apart. The restore path (updateQty(i, 1)) is for
    // ZEROED rows only; a row that still holds 3 units must come back at 3.
    const { getByTestId, queryByTestId } = renderIngredients([ingredient({ productQty: 3, qty: 3 })]);
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('3');

    fireEvent.press(getByTestId('qty-checkbox-0'));
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('3'); // not touched on the way out

    fireEvent.press(getByTestId('qty-checkbox-0'));
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('3'); // and not on the way back in
  });

  it('recovers from doubly-excluded — "Uncheck all" on an already-zeroed row', () => {
    // The only route into unchecked AND zeroed at once: the steppers are dead
    // while the box is off, so qty can only reach 0 with the box still on, and
    // the box can only go off afterwards via the header. One tap must clear
    // BOTH exclusions or the row is stranded.
    const { getByText, getByTestId, queryByTestId } = renderSheet();
    fireEvent.press(getByText('−'));
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('0');

    fireEvent.press(getByText('Uncheck all'));
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('0');

    // Both steppers are disabled here — no way up except the checkbox.
    fireEvent.press(getByText('+'));
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('0');

    fireEvent.press(getByTestId('qty-checkbox-0'));
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('1');
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('CHARACTERISES the header/row disagreement after Check all on a zeroed row', () => {
    // Not a requirement — a known, deliberate wart recorded so it cannot change
    // unnoticed. `allChecked` derives from the box flags while rows render
    // INCLUSION, so a zeroed row leaves the header claiming everything is
    // selected while that row still reads unchecked and struck. Recoverable
    // with the + or a checkbox tap.
    //
    // Left alone on purpose: making the header read inclusion also means
    // changing what "Check all" DOES (it would have to restore zeroed rows to
    // 1), which rewrites the toggle transitions rather than relabelling them.
    const { getAllByText, getByText, queryByTestId } = renderIngredients([
      ingredient(),
      ingredient({ ingredientName: 'Tortillas', searchTerm: 'tortillas' }),
    ]);
    fireEvent.press(getAllByText('−')[0]); // row 0 → qty 0
    fireEvent.press(getByText('Uncheck all'));
    fireEvent.press(getByText('Check all'));

    expect(getByText('Uncheck all')).toBeTruthy(); // header: "everything is on"
    expect(queryByTestId('qty-checked-0')).toBeNull(); // row 0: still off
    expect(queryByTestId('qty-checked-1')).toBeTruthy();
  });
});

// MEAL-65 invariant: Kroger's qty item carries NO weight fields.
//
// tests/unit/qtyStepExclusion.test.ts checks the Kroger equivalence over qty
// ONLY, which is sound exactly as long as this holds. isZeroedOut's
// sold-by-weight exception keys off `purchaseWeight`, and
// QtyExcludableFields.purchaseWeight is OPTIONAL — so a Kroger item that grew a
// weight field would compile, would silently change what lands in the cart (a
// qty-0 row would start surviving), and would break no test. These pin it.
describe('Kroger qty item shape — no weight fields (MEAL-65 invariant)', () => {
  // Compile-time half. Any key containing "eight" — purchaseWeight, weightStep,
  // averageWeightPerUnit — fails `npx tsc --noEmit` here.
  type Assert<T extends true> = T;
  type WeightKeys = Extract<keyof ConsolidatedIngredient, `${string}eight${string}`>;
  type _NoWeightKeysOnKrogerItem = Assert<[WeightKeys] extends [never] ? true : false>;

  const deliMeal = {
    id: 'm1',
    name: 'Deli Run',
    ingredients: [
      // The source ingredient DOES carry weight fields — a saved HEB/Deli row
      // can. Kroger's builder must not carry them through.
      {
        ingredientName: 'Deli Turkey',
        searchTerm: 'deli turkey',
        productQty: 2,
        unit: 'lb',
        measure: '1',
        purchaseWeight: 1.5,
        weightStep: 0.25,
      },
    ],
  } as any;

  it('builds no item with a weight key, even from an ingredient that has one', () => {
    const built = consolidateIngredients([deliMeal]);
    expect(built).toHaveLength(1);
    expect(Object.keys(built[0]).filter((k) => /weight/i.test(k))).toEqual([]);
  });

  it('so isZeroedOut collapses to the pre-MEAL-65 `productQty > 0` filter here', () => {
    // Every input pair where the old and new expressions disagree requires
    // purchaseWeight != null. On an item Kroger actually builds there is no
    // such field, so the two cannot come apart — and if one is ever added and
    // populated, this fails at qty 0.
    const [item] = consolidateIngredients([deliMeal]);
    for (const productQty of [0, 1, 2, 99]) {
      const row = { ...item, productQty };
      expect(!isZeroedOut(row)).toBe(row.productQty > 0);
    }
  });
});
